//! Credential Bridge - Converts verified identity claims to ProofDocuments
//!
//! This module bridges the gap between Identity Provider claims and
//! the OwlID proof system. It converts verified claims into attributes
//! that can be issued as credentials.
//!
//! The bridge now issues credentials directly without HTTP calls,
//! eliminating the need for a separate issuer service.

use crate::db::CredentialRepository;
use crate::error::Result;
use crate::issuance::issue_credential_direct;
use crate::models::VerifiedIdentityClaims;
use owl_crypto::SignatureAlgorithm;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Normalize any nationality format to ISO 3166-1 alpha-2 code.
///
/// Accepts:
/// - Full names: "Dutch", "German", "Swedish", "French", ...
/// - ISO alpha-3: "NLD", "DEU", "SWE", "FRA", ...
/// - ISO alpha-2 (pass-through): "NL", "DE", "SE", "FR", ...
///
/// The ZK nationality circuit and frontend both use alpha-2 codes,
/// but identity providers return different formats (Didit uses alpha-3,
/// mock providers use full names). This normalizer bridges all of them.
fn normalize_nationality_to_alpha2(input: &str) -> String {
    let upper = input.trim().to_uppercase();

    // If already alpha-2, pass through
    if upper.len() == 2 {
        return upper;
    }

    // Alpha-3 to alpha-2 mapping (EU + common countries)
    let alpha2 = match upper.as_str() {
        // EU member states
        "AUT" => "AT",
        "BEL" => "BE",
        "BGR" => "BG",
        "HRV" => "HR",
        "CYP" => "CY",
        "CZE" => "CZ",
        "DNK" => "DK",
        "EST" => "EE",
        "FIN" => "FI",
        "FRA" => "FR",
        "DEU" => "DE",
        "GRC" => "GR",
        "HUN" => "HU",
        "IRL" => "IE",
        "ITA" => "IT",
        "LVA" => "LV",
        "LTU" => "LT",
        "LUX" => "LU",
        "MLT" => "MT",
        "NLD" => "NL",
        "POL" => "PL",
        "PRT" => "PT",
        "ROU" => "RO",
        "SVK" => "SK",
        "SVN" => "SI",
        "ESP" => "ES",
        "SWE" => "SE",
        // Non-EU common
        "GBR" => "GB",
        "USA" => "US",
        "CAN" => "CA",
        "AUS" => "AU",
        "CHE" => "CH",
        "NOR" => "NO",
        "ISL" => "IS",
        "JPN" => "JP",
        "BRA" => "BR",
        "TUR" => "TR",
        _ => "",
    };
    if !alpha2.is_empty() {
        return alpha2.to_string();
    }

    // Full name to alpha-2 (case-insensitive)
    let lower = input.trim().to_lowercase();
    let alpha2 = match lower.as_str() {
        // EU member states
        "austrian" | "austria" => "AT",
        "belgian" | "belgium" => "BE",
        "bulgarian" | "bulgaria" => "BG",
        "croatian" | "croatia" => "HR",
        "cypriot" | "cyprus" => "CY",
        "czech" | "czechia" | "czech republic" => "CZ",
        "danish" | "denmark" => "DK",
        "estonian" | "estonia" => "EE",
        "finnish" | "finland" => "FI",
        "french" | "france" => "FR",
        "german" | "germany" => "DE",
        "greek" | "greece" => "GR",
        "hungarian" | "hungary" => "HU",
        "irish" | "ireland" => "IE",
        "italian" | "italy" => "IT",
        "latvian" | "latvia" => "LV",
        "lithuanian" | "lithuania" => "LT",
        "luxembourgish" | "luxembourg" => "LU",
        "maltese" | "malta" => "MT",
        "dutch" | "netherlands" | "the netherlands" => "NL",
        "polish" | "poland" => "PL",
        "portuguese" | "portugal" => "PT",
        "romanian" | "romania" => "RO",
        "slovak" | "slovakia" => "SK",
        "slovenian" | "slovenia" => "SI",
        "spanish" | "spain" => "ES",
        "swedish" | "sweden" => "SE",
        // Non-EU common
        "british" | "united kingdom" | "uk" => "GB",
        "american" | "united states" | "usa" => "US",
        "canadian" | "canada" => "CA",
        "australian" | "australia" => "AU",
        "swiss" | "switzerland" => "CH",
        "norwegian" | "norway" => "NO",
        "icelandic" | "iceland" => "IS",
        "japanese" | "japan" => "JP",
        "brazilian" | "brazil" => "BR",
        "turkish" | "turkey" | "turkiye" => "TR",
        _ => "",
    };
    if !alpha2.is_empty() {
        return alpha2.to_string();
    }

    // Fallback: return as-is (unknown format)
    input.to_string()
}

/// Configuration for credential bridging
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    /// Include raw identity fields (name, DOB, etc.)
    pub include_raw_fields: bool,
    /// Include derived boolean proofs (isOver18, etc.)
    pub include_derived_proofs: bool,
    /// Include verification metadata
    pub include_metadata: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            include_raw_fields: true,
            include_derived_proofs: true,
            include_metadata: true,
        }
    }
}

/// Response from credential issuance (for API compatibility)
#[derive(Debug, Serialize, Deserialize)]
pub struct IssueResponse {
    pub success: bool,
    pub credential: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Bridge between IdP claims and OwlID credentials
pub struct CredentialBridge {
    config: BridgeConfig,
    credential_repo: Option<CredentialRepository>,
}

impl CredentialBridge {
    /// Create a new credential bridge with default config
    pub fn new() -> Self {
        Self::with_config(BridgeConfig::default())
    }

    /// Create with custom config
    pub fn with_config(config: BridgeConfig) -> Self {
        Self {
            config,
            credential_repo: None,
        }
    }

    /// Set credential repository for storage
    pub fn with_credential_repo(mut self, repo: CredentialRepository) -> Self {
        self.credential_repo = Some(repo);
        self
    }

    /// The credential store (for the Token Status List projection).
    pub fn credential_repo(&self) -> Option<&CredentialRepository> {
        self.credential_repo.as_ref()
    }

    /// Convert IdP claims to the issuer-signed SD-JWT VC claim set.
    ///
    /// This is the key function that determines what goes into a credential.
    /// The claim set drives the SD-JWT VC `_sd` array, so the holder can
    /// later prove individual claims without revealing others.
    pub fn claims_to_attributes(
        &self,
        claims: &VerifiedIdentityClaims,
    ) -> BTreeMap<String, serde_json::Value> {
        let mut attrs = BTreeMap::new();

        // Sentinel DOB the OIDC-only normalizers emit when the provider
        // can't vouch for a real date of birth (Google et al). Treat it
        // as "absent" so the SD-JWT VC doesn't ship a lie.
        let sentinel_dob = chrono::NaiveDate::from_ymd_opt(1900, 1, 1).unwrap();
        let has_real_dob = claims.date_of_birth != sentinel_dob;

        if self.config.include_raw_fields {
            // Core identity — only emit when the provider actually
            // attested to it. Empty strings + sentinel DOB are the
            // signal "I don't know this", not a fact about the holder.
            if !claims.first_name.is_empty() {
                attrs.insert("firstName".into(), serde_json::json!(claims.first_name));
            }
            if !claims.last_name.is_empty() {
                attrs.insert("lastName".into(), serde_json::json!(claims.last_name));
            }
            if has_real_dob {
                attrs.insert(
                    "dateOfBirth".into(),
                    serde_json::json!(claims.date_of_birth.to_string()),
                );
            }
            if !claims.place_of_birth.is_empty() {
                attrs.insert(
                    "placeOfBirth".into(),
                    serde_json::json!(claims.place_of_birth),
                );
            }
            if !claims.nationality.is_empty() {
                attrs.insert(
                    "nationality".into(),
                    serde_json::json!(normalize_nationality_to_alpha2(&claims.nationality)),
                );
            }

            if let Some(ref gender) = claims.gender {
                attrs.insert("gender".into(), serde_json::json!(gender));
            }

            // National ID — OIDC normalizers stash the provider `sub`
            // here for lack of a better slot, but it's an account
            // subject, not a government ID. Only emit as `nationalId`
            // when there's a real document context (passport / doc
            // number / issuing country present).
            let looks_like_document_session = claims.passport_number.is_some()
                || claims.document_number.is_some()
                || claims.issuing_country.is_some();
            if !claims.national_id.is_empty() && looks_like_document_session {
                attrs.insert("nationalId".into(), serde_json::json!(claims.national_id));
            } else if !claims.national_id.is_empty() {
                // OIDC sub — separate slot so verifiers don't conflate
                // an account identifier with a government ID.
                attrs.insert("sub".into(), serde_json::json!(claims.national_id));
            }

            if let Some(ref passport) = claims.passport_number {
                attrs.insert("passportNumber".into(), serde_json::json!(passport));
            }

            if let Some(ref drivers_license) = claims.drivers_license {
                attrs.insert("driversLicense".into(), serde_json::json!(drivers_license));
            }

            if let Some(ref tax_id) = claims.tax_id {
                attrs.insert("taxId".into(), serde_json::json!(tax_id));
            }

            // Document information (from document-based verification)
            if let Some(ref doc_type) = claims.document_type {
                attrs.insert("documentType".into(), serde_json::json!(doc_type));
            }
            if let Some(ref doc_number) = claims.document_number {
                attrs.insert("documentNumber".into(), serde_json::json!(doc_number));
            }
            if let Some(ref issuing_country) = claims.issuing_country {
                attrs.insert("issuingCountry".into(), serde_json::json!(issuing_country));
            }
            if let Some(ref expiry) = claims.document_expiry {
                attrs.insert(
                    "documentExpiry".into(),
                    serde_json::json!(expiry.to_string()),
                );
            }
            if let Some(ref issue_date) = claims.document_issue_date {
                attrs.insert(
                    "documentIssueDate".into(),
                    serde_json::json!(issue_date.to_string()),
                );
            }
            // NOTE: portrait_image is explicitly NOT included in the issued
            // SD-JWT VC for privacy reasons. It's only returned in API
            // responses for local storage.

            // Address — only emit when the provider actually returned
            // an address. OIDC providers blank these out and we don't
            // want empty-string disclosures.
            if !claims.street_address.is_empty() {
                attrs.insert(
                    "streetAddress".into(),
                    serde_json::json!(claims.street_address),
                );
            }
            if !claims.city.is_empty() {
                attrs.insert("city".into(), serde_json::json!(claims.city));
            }
            if !claims.postal_code.is_empty() {
                attrs.insert("postalCode".into(), serde_json::json!(claims.postal_code));
            }
            if !claims.country.is_empty() {
                attrs.insert("country".into(), serde_json::json!(claims.country));
            }

            // Account-level identifiers (OIDC providers — Google et al).
            if let Some(ref email) = claims.email {
                attrs.insert("email".into(), serde_json::json!(email));
            }
            if let Some(ref name) = claims.name {
                attrs.insert("name".into(), serde_json::json!(name));
            }
            if let Some(ref picture) = claims.picture {
                attrs.insert("picture".into(), serde_json::json!(picture));
            }
            if let Some(ref locale) = claims.locale {
                attrs.insert("locale".into(), serde_json::json!(locale));
            }
            if let Some(ref hd) = claims.hosted_domain {
                attrs.insert("hostedDomain".into(), serde_json::json!(hd));
            }
        }

        if self.config.include_derived_proofs {
            // Age + EU + residency claims are derived from real source
            // data. If the provider didn't give us a real DOB / country
            // (OIDC-account providers), the "no" booleans are sentinel
            // garbage, not facts. Skip them so the SD-JWT VC doesn't
            // assert false predicates.
            if has_real_dob {
                attrs.insert("isOver18".into(), serde_json::json!(claims.is_over_18));
                attrs.insert("isOver21".into(), serde_json::json!(claims.is_over_21));
                attrs.insert("isOver65".into(), serde_json::json!(claims.is_over_65));
            }
            if !claims.nationality.is_empty() {
                attrs.insert(
                    "isEuCitizen".into(),
                    serde_json::json!(claims.is_eu_citizen),
                );
            }
            if !claims.country.is_empty() {
                attrs.insert("isResident".into(), serde_json::json!(claims.is_resident));
            }
            // `residentCountry` drives the new `attestResidencyIn` flow:
            // the issuer stamps the holder's actual country of residence
            // so the wallet can later prove it `∈ verifier-supplied set`.
            // Only present when the provider returned a geo-verified
            // address (otherwise the residency attestation is skipped).
            if let Some(ref country) = claims.resident_country {
                if !country.is_empty() {
                    attrs.insert("residentCountry".into(), serde_json::json!(country));
                }
            }
            // Provider-attested `email_verified` flag — drives the
            // Midnight `attestEmailVerified` predicate. Only present
            // when the source provider vouches for it (Google OIDC).
            if let Some(verified) = claims.email_verified {
                attrs.insert("emailVerified".into(), serde_json::json!(verified));
            }
        }

        if self.config.include_metadata {
            // Verification metadata (proves when/how verified)
            attrs.insert(
                "verificationLevel".into(),
                serde_json::json!(claims.verification_level.as_str()),
            );
            attrs.insert(
                "verifiedAt".into(),
                serde_json::json!(claims.verified_at.to_rfc3339()),
            );
            attrs.insert("verifiedBy".into(), serde_json::json!(claims.provider_id));
            attrs.insert(
                "verificationMethod".into(),
                serde_json::json!(claims.verification_method),
            );
        }

        attrs
    }

    /// Issue a credential directly (no HTTP call).
    ///
    /// Builds standard claims from the verified identity and returns the
    /// signed **SD-JWT VC** (the only credential representation).
    pub async fn issue_credential(
        &self,
        claims: &VerifiedIdentityClaims,
        issuer_private_key: &str,
        owner_public_key: &str,
        key_algorithm: SignatureAlgorithm,
        issuer_public_url: &str,
        personhood: bool,
    ) -> Result<String> {
        let attributes = self.claims_to_attributes(claims);

        issue_credential_direct(
            issuer_private_key,
            owner_public_key,
            key_algorithm,
            attributes,
            self.credential_repo.as_ref(),
            issuer_public_url,
            personhood,
        )
        .await
    }

    /// Convert claims to a flat map (for debugging/display)
    pub fn claims_to_map(claims: &VerifiedIdentityClaims) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();

        map.insert("firstName".to_string(), claims.first_name.clone());
        map.insert("lastName".to_string(), claims.last_name.clone());
        map.insert("dateOfBirth".to_string(), claims.date_of_birth.to_string());
        map.insert(
            "nationality".to_string(),
            normalize_nationality_to_alpha2(&claims.nationality),
        );
        map.insert("isOver18".to_string(), claims.is_over_18.to_string());
        map.insert("isOver21".to_string(), claims.is_over_21.to_string());
        map.insert("isEuCitizen".to_string(), claims.is_eu_citizen.to_string());
        map.insert(
            "verificationLevel".to_string(),
            claims.verification_level.as_str().to_string(),
        );

        map
    }
}

impl Default for CredentialBridge {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Unique-personhood secret derivation
// ---------------------------------------------------------------------------

/// Derive the holder-only `personhoodSecret` for a verified identity.
///
/// Returns `Some(secret)` for document-verified / government-eID
/// identities (a stable document or eID identifier is present), and
/// `None` for identities with no such handle (plain OIDC accounts —
/// Google et al — which therefore get no `unique_personhood` predicate).
///
/// The secret is `HKDF(salt = SHA-256(issuer key), ikm = identity_hash)`
/// — deterministic per real human and not holder-influenceable. Two
/// wallets for the same human derive the *same* secret, so the Midnight
/// `attestUniquePersonhood` nullifier blocks the second from claiming
/// any campaign the first already claimed. That on-chain nullifier is
/// the sybil boundary; no issuer-side dedup table exists or is needed.
pub fn derive_personhood(
    claims: &VerifiedIdentityClaims,
    issuer_private_key: &str,
) -> Option<[u8; 32]> {
    let (identifier, namespace) = personhood_identity(claims)?;
    let identity_hash = personhood_identity_hash(&namespace, &identifier);
    Some(derive_personhood_secret(issuer_private_key, &identity_hash))
}

/// `(identifier, namespace)` for the verified identity's stable
/// document/eID handle, or `None` when the provider cannot anchor a
/// real human. The namespace keeps document numbers from colliding
/// across issuing countries / document types.
fn personhood_identity(claims: &VerifiedIdentityClaims) -> Option<(String, String)> {
    // Document-scan providers (Didit, Onfido, Jumio, Stripe) — the
    // scanned document number is the strongest handle available.
    if let Some(doc) = claims.document_number.as_deref().map(str::trim) {
        if !doc.is_empty() {
            let country = claims
                .issuing_country
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("??");
            let dtype = claims
                .document_type
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("doc");
            return Some((doc.to_string(), format!("doc:{country}:{dtype}")));
        }
    }
    // Government eID providers (DigiD, BankID, eIDAS) — `national_id`
    // is a government identifier (BSN, personal number, person
    // identifier), document-grade for this purpose. Plain OIDC accounts
    // stash an account `sub` in `national_id` instead and are excluded.
    if let Some(class) = gov_eid_class(&claims.provider_id) {
        let nid = claims.national_id.trim();
        if !nid.is_empty() {
            return Some((nid.to_string(), format!("eid:{class}")));
        }
    }
    None
}

/// Government-eID provider class, or `None` for document-scan KYC and
/// plain OIDC providers.
fn gov_eid_class(provider_id: &str) -> Option<&'static str> {
    let p = provider_id.to_ascii_lowercase();
    if p.contains("digid") {
        Some("digid")
    } else if p.contains("bankid") {
        Some("bankid")
    } else if p.contains("eidas") {
        Some("eidas")
    } else {
        None
    }
}

/// `SHA-256("owlid:personhood:identity\0" || namespace || "\0" || identifier)`.
fn personhood_identity_hash(namespace: &str, identifier: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"owlid:personhood:identity\0");
    h.update(namespace.as_bytes());
    h.update(b"\0");
    h.update(identifier.as_bytes());
    h.finalize().into()
}

/// HKDF-SHA-256 personhood secret. Salt = `SHA-256(issuer key hex)` so a
/// verifier cannot recompute the secret even from the public identity;
/// IKM = `identity_hash` ⇒ deterministic per real human.
fn derive_personhood_secret(issuer_private_key_hex: &str, identity_hash: &[u8; 32]) -> [u8; 32] {
    use hkdf::Hkdf;
    use sha2::{Digest, Sha256};
    let salt: [u8; 32] = Sha256::digest(issuer_private_key_hex.as_bytes()).into();
    let hk = Hkdf::<Sha256>::new(Some(&salt), identity_hash);
    let mut okm = [0u8; 32];
    hk.expand(b"owlid:personhood:secret", &mut okm)
        .expect("HKDF expand of 32 bytes never fails");
    okm
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::VerificationLevel;
    use chrono::{NaiveDate, Utc};

    fn sample_claims() -> VerifiedIdentityClaims {
        VerifiedIdentityClaims {
            first_name: "Jan".to_string(),
            last_name: "de Vries".to_string(),
            date_of_birth: NaiveDate::from_ymd_opt(1985, 3, 15).unwrap(),
            place_of_birth: "Amsterdam".to_string(),
            nationality: "Dutch".to_string(),
            gender: Some("Male".to_string()),
            national_id: "123456789".to_string(),
            passport_number: Some("AB1234567".to_string()),
            drivers_license: None,
            tax_id: None,
            document_type: None,
            document_number: None,
            issuing_country: None,
            document_expiry: None,
            document_issue_date: None,
            portrait_image: None,
            street_address: "Kerkstraat 1".to_string(),
            city: "Amsterdam".to_string(),
            postal_code: "1012 AB".to_string(),
            country: "Netherlands".to_string(),
            is_over_18: true,
            is_over_21: true,
            is_over_65: false,
            is_eu_citizen: true,
            is_resident: true,
            resident_country: Some("NL".to_string()),
            verified_at: Utc::now(),
            verification_level: VerificationLevel::Substantial,
            provider_id: "mock-digid".to_string(),
            name: None,
            picture: None,
            locale: None,
            hosted_domain: None,
            verification_method: "simulated".to_string(),
            email: None,
            email_verified: None,
        }
    }

    #[test]
    fn test_claims_to_attributes() {
        let bridge = CredentialBridge::new();
        let claims = sample_claims();

        let attrs = bridge.claims_to_attributes(&claims);

        // Check raw fields
        assert_eq!(attrs.get("firstName").unwrap(), &serde_json::json!("Jan"));
        assert_eq!(
            attrs.get("lastName").unwrap(),
            &serde_json::json!("de Vries")
        );

        // Check derived proofs
        assert_eq!(attrs.get("isOver18").unwrap(), &serde_json::json!(true));
        assert_eq!(attrs.get("isOver21").unwrap(), &serde_json::json!(true));
        assert_eq!(attrs.get("isOver65").unwrap(), &serde_json::json!(false));
        assert_eq!(attrs.get("isEuCitizen").unwrap(), &serde_json::json!(true));

        // Check metadata
        assert_eq!(
            attrs.get("verificationLevel").unwrap(),
            &serde_json::json!("substantial")
        );
        assert_eq!(
            attrs.get("verifiedBy").unwrap(),
            &serde_json::json!("mock-digid")
        );
    }

    #[test]
    fn test_claims_to_attributes_minimal() {
        let bridge = CredentialBridge::with_config(BridgeConfig {
            include_raw_fields: false,
            include_derived_proofs: true,
            include_metadata: false,
        });
        let claims = sample_claims();

        let attrs = bridge.claims_to_attributes(&claims);

        // Should only have derived proofs
        assert!(!attrs.contains_key("firstName"));
        assert!(!attrs.contains_key("verificationLevel"));
        assert!(attrs.contains_key("isOver18"));
        assert!(attrs.contains_key("isEuCitizen"));
    }

    #[test]
    fn test_claims_to_map() {
        let claims = sample_claims();
        let map = CredentialBridge::claims_to_map(&claims);

        assert_eq!(map.get("firstName").unwrap(), "Jan");
        assert_eq!(map.get("isOver18").unwrap(), "true");
        assert_eq!(map.get("nationality").unwrap(), "NL"); // normalized from "Dutch"
    }

    #[test]
    fn test_nationality_normalization() {
        // Full names -> alpha-2
        assert_eq!(normalize_nationality_to_alpha2("Dutch"), "NL");
        assert_eq!(normalize_nationality_to_alpha2("Swedish"), "SE");
        assert_eq!(normalize_nationality_to_alpha2("German"), "DE");
        assert_eq!(normalize_nationality_to_alpha2("French"), "FR");
        assert_eq!(normalize_nationality_to_alpha2("British"), "GB");

        // Alpha-3 -> alpha-2
        assert_eq!(normalize_nationality_to_alpha2("NLD"), "NL");
        assert_eq!(normalize_nationality_to_alpha2("SWE"), "SE");
        assert_eq!(normalize_nationality_to_alpha2("DEU"), "DE");
        assert_eq!(normalize_nationality_to_alpha2("FRA"), "FR");
        assert_eq!(normalize_nationality_to_alpha2("GBR"), "GB");

        // Alpha-2 pass-through
        assert_eq!(normalize_nationality_to_alpha2("NL"), "NL");
        assert_eq!(normalize_nationality_to_alpha2("SE"), "SE");
        assert_eq!(normalize_nationality_to_alpha2("DE"), "DE");

        // Case insensitive
        assert_eq!(normalize_nationality_to_alpha2("dutch"), "NL");
        assert_eq!(normalize_nationality_to_alpha2("nld"), "NL");
        assert_eq!(normalize_nationality_to_alpha2("DUTCH"), "NL");

        // Country names
        assert_eq!(normalize_nationality_to_alpha2("Netherlands"), "NL");
        assert_eq!(normalize_nationality_to_alpha2("Germany"), "DE");

        // Unknown falls through
        assert_eq!(normalize_nationality_to_alpha2("Martian"), "Martian");
    }

    #[tokio::test]
    async fn test_issue_credential() {
        let bridge = CredentialBridge::new();
        let claims = sample_claims();

        // Generate test keypairs (Ed25519)
        let issuer_keypair = owl_crypto::KeyPair::generate();
        let owner_keypair = owl_crypto::KeyPair::generate();

        let issuer_private_key = hex::encode(issuer_keypair.to_bytes());
        let owner_public_key = owner_keypair.public_key().to_hex();

        let result = bridge
            .issue_credential(
                &claims,
                &issuer_private_key,
                &owner_public_key,
                SignatureAlgorithm::Ed25519,
                "https://issuer.example",
                false,
            )
            .await;

        assert!(result.is_ok());
        let sd_jwt_vc = result.unwrap();
        owl_proof_system::sd_jwt::verify(
            &sd_jwt_vc,
            &issuer_keypair.public_key(),
            &owl_proof_system::sd_jwt::VerifyParams::default(),
        )
        .expect("issued SD-JWT VC must verify");
    }
}
