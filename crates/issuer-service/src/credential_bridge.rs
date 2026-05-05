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
use owl_proof_system::document::ProofDocument;
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
        "AUT" => "AT", "BEL" => "BE", "BGR" => "BG", "HRV" => "HR",
        "CYP" => "CY", "CZE" => "CZ", "DNK" => "DK", "EST" => "EE",
        "FIN" => "FI", "FRA" => "FR", "DEU" => "DE", "GRC" => "GR",
        "HUN" => "HU", "IRL" => "IE", "ITA" => "IT", "LVA" => "LV",
        "LTU" => "LT", "LUX" => "LU", "MLT" => "MT", "NLD" => "NL",
        "POL" => "PL", "PRT" => "PT", "ROU" => "RO", "SVK" => "SK",
        "SVN" => "SI", "ESP" => "ES", "SWE" => "SE",
        // Non-EU common
        "GBR" => "GB", "USA" => "US", "CAN" => "CA", "AUS" => "AU",
        "CHE" => "CH", "NOR" => "NO", "ISL" => "IS", "JPN" => "JP",
        "BRA" => "BR", "TUR" => "TR",
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

    /// Convert IdP claims to document attributes for the Merkle tree
    ///
    /// This is the key function that determines what goes into a credential.
    /// The attribute structure enables selective disclosure - users can later
    /// prove individual attributes without revealing others.
    pub fn claims_to_attributes(
        &self,
        claims: &VerifiedIdentityClaims,
    ) -> BTreeMap<String, serde_json::Value> {
        let mut attrs = BTreeMap::new();

        if self.config.include_raw_fields {
            // Core identity (can be selectively disclosed)
            attrs.insert("firstName".into(), serde_json::json!(claims.first_name));
            attrs.insert("lastName".into(), serde_json::json!(claims.last_name));
            attrs.insert(
                "dateOfBirth".into(),
                serde_json::json!(claims.date_of_birth.to_string()),
            );
            attrs.insert(
                "placeOfBirth".into(),
                serde_json::json!(claims.place_of_birth),
            );
            attrs.insert(
                "nationality".into(),
                serde_json::json!(normalize_nationality_to_alpha2(&claims.nationality)),
            );

            if let Some(ref gender) = claims.gender {
                attrs.insert("gender".into(), serde_json::json!(gender));
            }

            // Government IDs (highly sensitive, rarely disclosed)
            attrs.insert("nationalId".into(), serde_json::json!(claims.national_id));

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
                attrs.insert("documentExpiry".into(), serde_json::json!(expiry.to_string()));
            }
            if let Some(ref issue_date) = claims.document_issue_date {
                attrs.insert("documentIssueDate".into(), serde_json::json!(issue_date.to_string()));
            }
            // NOTE: portrait_image is explicitly NOT included in the credential/Merkle tree
            // for privacy reasons. It's only returned in API responses for local storage.

            // Address
            attrs.insert(
                "streetAddress".into(),
                serde_json::json!(claims.street_address),
            );
            attrs.insert("city".into(), serde_json::json!(claims.city));
            attrs.insert("postalCode".into(), serde_json::json!(claims.postal_code));
            attrs.insert("country".into(), serde_json::json!(claims.country));
        }

        if self.config.include_derived_proofs {
            // Derived boolean proofs (the key privacy feature!)
            // These allow proving age without revealing date of birth
            attrs.insert("isOver18".into(), serde_json::json!(claims.is_over_18));
            attrs.insert("isOver21".into(), serde_json::json!(claims.is_over_21));
            attrs.insert("isOver65".into(), serde_json::json!(claims.is_over_65));
            attrs.insert("isEuCitizen".into(), serde_json::json!(claims.is_eu_citizen));
            attrs.insert("isResident".into(), serde_json::json!(claims.is_resident));
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

    /// Issue a credential directly (no HTTP call)
    ///
    /// This creates a ProofDocument from the verified claims using direct
    /// function calls instead of calling an external issuer service.
    pub async fn issue_credential(
        &self,
        claims: &VerifiedIdentityClaims,
        issuer_private_key: &str,
        owner_public_key: &str,
        key_algorithm: SignatureAlgorithm,
    ) -> Result<ProofDocument> {
        let attributes = self.claims_to_attributes(claims);

        issue_credential_direct(
            issuer_private_key,
            owner_public_key,
            key_algorithm,
            attributes,
            self.credential_repo.as_ref(),
        )
        .await
    }

    /// Convert claims to a flat map (for debugging/display)
    pub fn claims_to_map(claims: &VerifiedIdentityClaims) -> BTreeMap<String, String> {
        let mut map = BTreeMap::new();

        map.insert("firstName".to_string(), claims.first_name.clone());
        map.insert("lastName".to_string(), claims.last_name.clone());
        map.insert(
            "dateOfBirth".to_string(),
            claims.date_of_birth.to_string(),
        );
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
            verified_at: Utc::now(),
            verification_level: VerificationLevel::Substantial,
            provider_id: "mock-digid".to_string(),
            verification_method: "simulated".to_string(),
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
            )
            .await;

        assert!(result.is_ok());
        let proof_doc = result.unwrap();
        assert!(proof_doc.root_hash().len() > 0);
    }
}
