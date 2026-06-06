//! Build a standard SD-JWT VC (`application/dc+sd-jwt`) from verified
//! identity attributes. This is THE credential the issuer emits — there is
//! no proprietary document/Merkle format anymore. Midnight stays the core
//! (it computes the asserted predicate claims + trust + status); SD-JWT VC
//! is the only credential representation.
//!
//! Attribute names map to standard OIDC / ISO-18013-5 claim names so any
//! off-the-shelf wallet/verifier understands them (`isOver18` →
//! `age_over_18`, `firstName` → `given_name`, …). Midnight on-chain
//! attestation refs ride along as the optional `owl_attestation` claim,
//! which standard verifiers ignore.

use crate::error::{IdpError, Result};
use owl_crypto::{KeyPair, PublicKey};
use owl_proof_system::PredicateAttestation;
use owl_proof_system::sd_jwt::{IssueParams, SdJwtVc, StatusRef};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

const VCT: &str = "https://owlid.dev/credentials/identity";

/// OwlID attribute name → standard claim name. Unmapped names pass through
/// unchanged so nothing is silently dropped. Key material is excluded.
fn standard_name(k: &str) -> &str {
    match k {
        "firstName" => "given_name",
        "lastName" => "family_name",
        "dateOfBirth" => "birthdate",
        "placeOfBirth" => "place_of_birth",
        "streetAddress" => "street_address",
        "postalCode" => "postal_code",
        "nationalId" => "national_id",
        "passportNumber" => "passport_number",
        "driversLicense" => "drivers_license",
        "taxId" => "tax_id",
        "documentType" => "document_type",
        "documentNumber" => "document_number",
        "issuingCountry" => "issuing_country",
        "documentExpiry" => "document_expiry",
        "documentIssueDate" => "document_issue_date",
        "verificationLevel" => "verification_level",
        "verifiedAt" => "verified_at",
        "verifiedBy" => "verified_by",
        "verificationMethod" => "verification_method",
        // Midnight predicate projection (issuer-asserted, selectively
        // disclosable — ISO 18013-5 `age_over_NN` pattern).
        "isOver18" => "age_over_18",
        "isOver21" => "age_over_21",
        "isOver65" => "age_over_65",
        "isEuCitizen" => "nationality_eu",
        "isResident" => "resident",
        "emailVerified" => "email_verified",
        other => other,
    }
}

/// Stable credential identifier (storage key + on-chain anchor handle).
/// Single source of truth in `owl_proof_system::sd_jwt`.
pub use owl_proof_system::sd_jwt::credential_id;

/// Build the SD-JWT VC for verified attributes. `attrs` must include
/// `issuerKey` and `ownerKey` (hex). Returns the issuance form
/// (`JWT~D1~…~Dn~`, every claim disclosable, no Key Binding).
pub fn claims_to_sd_jwt_vc(
    attrs: &BTreeMap<String, Value>,
    issuer_keypair: &KeyPair,
    predicate_attestations: &[PredicateAttestation],
    issuer_public_url: &str,
    status_idx: u64,
) -> Result<String> {
    let owner_hex = attrs
        .get("ownerKey")
        .and_then(Value::as_str)
        .ok_or_else(|| IdpError::CredentialIssuance("missing ownerKey".to_string()))?;
    let holder = PublicKey::from_hex(owner_hex)
        .map_err(|e| IdpError::CredentialIssuance(format!("bad ownerKey: {e}")))?;

    let mut claims: BTreeMap<String, Value> = BTreeMap::new();
    for (k, v) in attrs {
        if k == "issuerKey" || k == "ownerKey" {
            continue;
        }
        claims.insert(standard_name(k).to_string(), v.clone());
    }

    if !predicate_attestations.is_empty() {
        claims.insert(
            "owl_attestation".to_string(),
            serde_json::to_value(predicate_attestations)
                .map_err(|e| IdpError::CredentialIssuance(e.to_string()))?,
        );
    }

    let iat = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .ok();

    // iss: the issuer's standard did:web identifier (resolves to
    // /.well-known/did.json; the key is also a Midnight trusted issuer).
    let iss = crate::did_web::did_web_id(issuer_public_url);

    let vc = SdJwtVc::issue(
        &claims,
        &IssueParams {
            issuer: issuer_keypair,
            iss,
            vct: VCT.to_string(),
            holder: &holder,
            iat,
            exp: None,
            status: Some(StatusRef {
                idx: status_idx,
                uri: format!("{}/status/1", issuer_public_url.trim_end_matches('/')),
            }),
        },
    )
    .map_err(|e| IdpError::CredentialIssuance(format!("SD-JWT VC: {e}")))?;
    Ok(vc.serialize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use owl_proof_system::sd_jwt::{KbParams, SdJwtVc as Sd, VerifyParams, verify};
    use serde_json::json;

    /// Standard issue → present → verify E2E, in-process (no HTTP): the real
    /// bridge (attrs→claims, did:web `iss`, `status`), holder selective
    /// disclosure + EdDSA KB-JWT bound to the verifier nonce/aud, and
    /// `sd_jwt::verify`. Mirrors the OID4VCI-issue → OID4VP-present →
    /// verify-token cross-service flow without the transport.
    #[test]
    fn standard_issue_present_verify_e2e() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".into(), json!(holder.public_key().to_hex()));
        attrs.insert("firstName".into(), json!("Ada"));
        attrs.insert("lastName".into(), json!("Lovelace"));
        attrs.insert("isOver18".into(), json!(true));

        // Issuer mints the SD-JWT VC (OID4VCI /credential output).
        let vc = claims_to_sd_jwt_vc(&attrs, &issuer, &[], "https://issuer.example", 7).unwrap();

        // Holder presents only `age_over_18`, KB-bound to the verifier
        // nonce/aud (OID4VP vp_token).
        let (parsed, _) = Sd::parse(&vc).unwrap();
        let pres = parsed
            .present(
                &["age_over_18"],
                Some(KbParams {
                    holder: &holder,
                    aud: "https://verifier.example".into(),
                    nonce: "n-e2e".into(),
                    iat: 1_700_000_000,
                }),
            )
            .unwrap();

        // Verifier checks issuer JWS + disclosures + KB (verify-token path).
        let v = verify(
            &pres,
            &issuer.public_key(),
            &VerifyParams {
                require_kb: true,
                aud: Some("https://verifier.example".into()),
                nonce: Some("n-e2e".into()),
            },
        )
        .unwrap();
        assert_eq!(v.iss, "did:web:issuer.example");
        assert!(v.key_bound);
        assert_eq!(v.claims["age_over_18"], json!(true));
        assert!(!v.claims.contains_key("given_name")); // not disclosed
        let st = v.status.expect("status claim");
        assert_eq!(st.idx, 7);
        assert_eq!(st.uri, "https://issuer.example/status/1");
    }

    #[test]
    fn builds_standard_sd_jwt_vc_from_attrs() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".into(), json!(holder.public_key().to_hex()));
        attrs.insert("firstName".into(), json!("Ada"));
        attrs.insert("isOver18".into(), json!(true));

        let atts = vec![PredicateAttestation {
            predicate: "age".into(),
            threshold: Some(18),
            ..Default::default()
        }];
        let s = claims_to_sd_jwt_vc(&attrs, &issuer, &atts, "https://issuer.example", 42).unwrap();

        let v = verify(&s, &issuer.public_key(), &VerifyParams::default()).unwrap();
        assert_eq!(v.vct, VCT);
        assert_eq!(v.iss, "did:web:issuer.example");
        let st = v.status.expect("status claim present");
        assert_eq!(st.idx, 42);
        assert_eq!(st.uri, "https://issuer.example/status/1");
        assert_eq!(v.claims["given_name"], json!("Ada"));
        assert_eq!(v.claims["age_over_18"], json!(true));
        assert!(!v.claims.contains_key("firstName"));
        assert!(!v.claims.contains_key("issuerKey"));
        assert_eq!(v.claims["owl_attestation"][0]["predicate"], json!("age"));
        assert!(!credential_id(&s).is_empty());
    }

    #[test]
    fn standard_name_covers_every_documented_alias() {
        // Issuer attribute → standard claim mapping (ISO 18013-5 /
        // EUDI patterns + the Midnight predicate projection). Unmapped
        // names pass through unchanged.
        let cases = [
            ("firstName", "given_name"),
            ("lastName", "family_name"),
            ("dateOfBirth", "birthdate"),
            ("placeOfBirth", "place_of_birth"),
            ("streetAddress", "street_address"),
            ("postalCode", "postal_code"),
            ("nationalId", "national_id"),
            ("passportNumber", "passport_number"),
            ("driversLicense", "drivers_license"),
            ("taxId", "tax_id"),
            ("documentType", "document_type"),
            ("documentNumber", "document_number"),
            ("issuingCountry", "issuing_country"),
            ("documentExpiry", "document_expiry"),
            ("documentIssueDate", "document_issue_date"),
            ("verificationLevel", "verification_level"),
            ("verifiedAt", "verified_at"),
            ("verifiedBy", "verified_by"),
            ("verificationMethod", "verification_method"),
            ("isOver18", "age_over_18"),
            ("isOver21", "age_over_21"),
            ("isOver65", "age_over_65"),
            ("isEuCitizen", "nationality_eu"),
            ("isResident", "resident"),
            // Pass-through: an unknown attribute keeps its name so
            // nothing is silently dropped.
            ("custom_thing", "custom_thing"),
            ("nationality", "nationality"),
        ];
        for (k, expected) in cases {
            assert_eq!(standard_name(k), expected, "mapping for {k}");
        }
    }

    #[test]
    fn missing_owner_key_rejected() {
        let issuer = KeyPair::generate();
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
        // No ownerKey → bridge must refuse to mint (the holder cnf
        // cannot be derived).
        let r = claims_to_sd_jwt_vc(&attrs, &issuer, &[], "https://issuer.example", 1);
        assert!(r.is_err());
    }

    #[test]
    fn bad_owner_key_hex_rejected() {
        let issuer = KeyPair::generate();
        let mut attrs = BTreeMap::new();
        attrs.insert("ownerKey".into(), json!("not-hex"));
        let r = claims_to_sd_jwt_vc(&attrs, &issuer, &[], "https://issuer.example", 1);
        assert!(r.is_err());
    }

    /// No predicate attestations → `owl_attestation` claim must be
    /// absent (we never emit an empty/synthetic Midnight ref).
    #[test]
    fn no_predicate_attestations_no_owl_claim() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut attrs = BTreeMap::new();
        attrs.insert("ownerKey".into(), json!(holder.public_key().to_hex()));
        attrs.insert("isOver18".into(), json!(true));
        let s = claims_to_sd_jwt_vc(&attrs, &issuer, &[], "https://issuer.example", 1).unwrap();
        let v = verify(&s, &issuer.public_key(), &VerifyParams::default()).unwrap();
        assert!(!v.claims.contains_key("owl_attestation"));
        assert_eq!(v.claims["age_over_18"], json!(true));
    }

    /// `iss` follows the issuer's public URL (did:web encoding) — the
    /// host part of `ISSUER_PUBLIC_URL` becomes the DID authority.
    #[test]
    fn iss_uses_did_web_authority_from_public_url() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut attrs = BTreeMap::new();
        attrs.insert("ownerKey".into(), json!(holder.public_key().to_hex()));
        attrs.insert("isOver18".into(), json!(true));

        let s = claims_to_sd_jwt_vc(&attrs, &issuer, &[], "http://localhost:8001", 0).unwrap();
        let v = verify(&s, &issuer.public_key(), &VerifyParams::default()).unwrap();
        assert_eq!(v.iss, "did:web:localhost%3A8001");
    }
}
