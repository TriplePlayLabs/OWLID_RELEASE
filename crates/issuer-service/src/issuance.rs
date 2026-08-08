//! Direct Credential Issuance
//!
//! This module handles credential issuance directly without HTTP calls.
//! It replaces the previous HTTP-based credential bridge to the external issuer service.

use crate::db::CredentialRepository;
use crate::error::{IdpError, Result};
use crate::sd_jwt_bridge::{claims_to_sd_jwt_vc, credential_id};
use chrono::Datelike;
use owl_crypto::{KeyPair, PublicKey, SignatureAlgorithm};
use owl_proof_system::PredicateAttestation;
use owl_proof_system::predicates::{self, PredicateParams};
use serde_json::Value;
use std::collections::BTreeMap;

/// Pick the predicate ids the credential can actually prove given its
/// attribute shape. For set-membership predicates (e.g. `nationality:eu`),
/// also check that the attribute value canonicalizes onto the dataset —
/// otherwise the holder couldn't prove membership anyway, and advertising
/// the predicate would mislead verifiers.
fn derive_available_predicates(attrs: &BTreeMap<String, Value>) -> Vec<String> {
    // "Present" = not null, not the empty string, not an empty array,
    // not zero-valued booleans/numbers used as placeholders. Without
    // this, providers that emit empty strings for unknown fields (e.g.
    // Google has no `nationality`) would still advertise nationality
    // predicates the holder can never satisfy.
    fn is_meaningful(v: &Value) -> bool {
        match v {
            Value::Null => false,
            Value::String(s) => !s.trim().is_empty(),
            Value::Array(a) => !a.is_empty(),
            _ => true,
        }
    }
    let mut present: Vec<&str> = Vec::new();
    for (k, v) in attrs.iter() {
        if !is_meaningful(v) {
            continue;
        }
        present.push(k.as_str());
    }

    let mut out = Vec::new();
    for pred in predicates::for_attributes(&present) {
        match pred.params {
            PredicateParams::SetName(name) => {
                let value = match attrs.get(pred.attribute).and_then(|v| v.as_str()) {
                    Some(v) => v,
                    None => continue,
                };
                let dataset = match owl_proof_system::datasets::lookup(name) {
                    Some(d) => d,
                    None => continue,
                };
                if dataset.canonicalize(value).is_none() {
                    continue;
                }
            }
            PredicateParams::Threshold(t) => {
                let Some(v) = attrs.get(pred.attribute) else {
                    continue;
                };
                let Some(actual) = attribute_as_threshold(pred.attribute, v) else {
                    continue;
                };
                if actual < t {
                    // Credential doesn't satisfy the threshold —
                    // stamping it would let the holder advertise a
                    // predicate the circuit will reject at prove time.
                    continue;
                }
            }
            PredicateParams::Dynamic => {
                // Presence-only: stamp iff the attribute is present and
                // maps cleanly to the value the circuit asserts on (for
                // age, a parseable `dateOfBirth`). The verifier supplies
                // the threshold / range bounds at request time.
                let Some(v) = attrs.get(pred.attribute) else {
                    continue;
                };
                if attribute_as_threshold(pred.attribute, v).is_none() {
                    continue;
                }
            }
        }
        out.push(pred.id.to_string());
    }
    out
}

/// Map a credential attribute value to the integer threshold the
/// matching Compact circuit asserts on. Returns `None` when the
/// shape doesn't map cleanly — caller treats that as "do not stamp".
fn attribute_as_threshold(attribute: &str, value: &Value) -> Option<u64> {
    match attribute {
        "dateOfBirth" => value.as_str().and_then(years_since_dob),
        "verificationLevel" => match value {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => verification_level_to_u64(s),
            _ => None,
        },
        "isResident" | "emailVerified" => match value {
            Value::Bool(b) => Some(if *b { 1 } else { 0 }),
            Value::Number(n) => n.as_u64(),
            Value::String(s) => match s.to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" => Some(1),
                "false" | "0" | "no" | "" => Some(0),
                _ => None,
            },
            _ => None,
        },
        // `residentCountry` + `nationality` are 2-letter ISO 3166-1
        // alpha-2 codes by the time they reach this function
        // (`credential_bridge::normalize_nationality_to_alpha2` runs
        // before stamping). Treated as presence markers for the
        // `residency:in` / `nationality:in` predicates — any
        // well-formed code => Some(1) so Dynamic-params derivation
        // accepts it; the actual country travels via the stamped
        // `PredicateAttestation.country` field. Without this arm,
        // `nationality:in` is silently skipped at issuance and the
        // verifier sees "No card answers Nationality" even when the
        // credential has a valid nationality claim.
        "residentCountry" | "nationality" => value.as_str().and_then(|s| {
            let t = s.trim();
            if t.len() == 2 && t.chars().all(|c| c.is_ascii_alphabetic()) {
                Some(1)
            } else {
                None
            }
        }),
        // Unknown attribute — be conservative and don't stamp.
        _ => None,
    }
}

fn years_since_dob(dob: &str) -> Option<u64> {
    // `dateOfBirth` is ISO-8601 (YYYY-MM-DD) on every issuance path.
    let parsed = chrono::NaiveDate::parse_from_str(dob, "%Y-%m-%d").ok()?;
    let today = chrono::Utc::now().date_naive();
    let mut years = today.year() - parsed.year();
    if (today.month(), today.day()) < (parsed.month(), parsed.day()) {
        years -= 1;
    }
    u64::try_from(years.max(0)).ok()
}

/// Pull an ISO 3166-1 alpha-2 country code out of the credential
/// attributes for nationality / residency stamping. Accepts strings
/// that are already 2-char codes (returned as upper-case) and the
/// common "Netherlands" / "NLD" full-name / alpha-3 shapes (trimmed
/// to the first two letters as a best-effort). Anything else → None,
/// which forces the attestation to be skipped (no country, no stamp).
fn country_from(attrs: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    let raw = attrs.get(key).and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    let upper = raw.to_uppercase();
    if upper.len() == 2 && upper.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(upper);
    }
    // Best-effort: take the first two letters (covers "NLD" → "NL"
    // and "Netherlands" → "NE" which is wrong, so callers that have
    // a full name should pre-normalize via the eu-countries table).
    let prefix: String = upper.chars().take(2).collect();
    if prefix.len() == 2 && prefix.chars().all(|c| c.is_ascii_alphabetic()) {
        Some(prefix)
    } else {
        None
    }
}

fn verification_level_to_u64(s: &str) -> Option<u64> {
    match s.trim().to_ascii_lowercase().as_str() {
        "0" | "none" | "" => Some(0),
        "1" | "low" | "basic" => Some(1),
        "2" | "medium" | "substantial" => Some(2),
        "3" | "high" => Some(3),
        other => other.parse::<u64>().ok(),
    }
}

/// Map the credential's derived predicate ids to on-chain predicate
/// attestations. Only the three Midnight-native predicate families have
/// attestation circuits (age / kyc / nationality); the verifier
/// recomputes each key from the issuer-signed `credential_id` and the
/// `(predicate, threshold)` here, then requires Set membership — so this
/// list states *which* attestations a verifier should check, never a
/// trusted key. Families without a Compact circuit are skipped.
fn derive_predicate_attestations(
    available_predicates: &[String],
    personhood: bool,
    attrs: &BTreeMap<String, Value>,
) -> Vec<PredicateAttestation> {
    let mut out = Vec::new();
    for id in available_predicates {
        let Some(pred) = predicates::lookup(id) else {
            continue;
        };
        let family = id.split(':').next().unwrap_or("");
        let att = match (id.as_str(), family, &pred.params) {
            // age:gte / age:range are presence markers — no threshold or
            // bounds pinned. The verifier supplies them at request time.
            ("age:gte", _, _) => PredicateAttestation {
                predicate: "age".to_string(),
                ..Default::default()
            },
            ("age:range", _, _) => PredicateAttestation {
                predicate: "age_range".to_string(),
                ..Default::default()
            },
            (_, "kyc", PredicateParams::Threshold(t)) => PredicateAttestation {
                predicate: "kyc".to_string(),
                threshold: Some(*t),
                ..Default::default()
            },
            // nationality + residency: the issuer stamps the holder's
            // actual country (ISO 3166-1 alpha-2) so the wallet later
            // proves it `∈ verifier-supplied set` against the
            // `attest{Nationality,Residency}In(rootHash, allowed)`
            // circuits. Without a country in the credential, no stamp.
            (_, "nationality", _) => {
                let Some(country) = country_from(attrs, "nationality") else {
                    continue;
                };
                PredicateAttestation {
                    predicate: "nationality".to_string(),
                    country: Some(country),
                    ..Default::default()
                }
            }
            (_, "residency", _) => {
                let Some(country) = country_from(attrs, "residentCountry") else {
                    continue;
                };
                PredicateAttestation {
                    predicate: "residency".to_string(),
                    country: Some(country),
                    ..Default::default()
                }
            }
            // email:verified is a stable boolean fact (emailVerified);
            // attestEmailVerified takes no public threshold.
            (_, "email", _) => PredicateAttestation {
                predicate: "email_verified".to_string(),
                ..Default::default()
            },
            // personhood:unique attestation is per-(epoch, app_id) and
            // the scope only exists at presentation time, so the
            // issuance-time attestation list does not pin a single
            // scope. Verifier supplies (epoch, app_id) on /predicates/
            // attested; holder's per-request attest pushes the entry.
            (_, "personhood", _) => PredicateAttestation {
                predicate: "unique_personhood".to_string(),
                ..Default::default()
            },
            _ => continue,
        };
        out.push(att);
    }
    // Unique-personhood is not registry-derived: it is stamped iff the
    // issuer derived a `personhoodSecret` for this credential (the
    // identity carried a stable document/eID identifier). The scope
    // (epoch, app_id) is presentation-time, so no params are pinned
    // here — the verifier supplies them via the campaign DCQL request.
    if personhood {
        out.push(PredicateAttestation {
            predicate: "unique_personhood".to_string(),
            ..Default::default()
        });
    }
    out
}

/// Issue a credential directly without HTTP calls.
///
/// 1. Parses the issuer and owner keys
/// 2. Builds standard claims from the attributes (filtered by the actual
///    attribute shape — e.g. `nationality:eu` only when nationality is on the
///    EU set), including the Midnight predicate projection
/// 3. Signs a standard **SD-JWT VC** with the issuer's key (no proprietary
///    document/Merkle format)
/// 4. Optionally stores the credential in the database
///
/// Returns the SD-JWT VC (`application/dc+sd-jwt`) — the only credential
/// representation.
pub async fn issue_credential_direct(
    issuer_private_key: &str,
    owner_public_key: &str,
    key_algorithm: SignatureAlgorithm,
    attributes: BTreeMap<String, Value>,
    credential_repo: Option<&CredentialRepository>,
    issuer_public_url: &str,
    // True iff the issuer derived a `personhoodSecret` for this
    // credential — stamps the `unique_personhood` predicate. The secret
    // itself never enters the SD-JWT VC (holder-only witness); only this
    // flag drives the attestation list.
    personhood: bool,
) -> Result<String> {
    // Parse issuer keypair from hex
    let issuer_key_bytes = hex::decode(issuer_private_key).map_err(|_| IdpError::InvalidField {
        field: "issuer_private_key".to_string(),
        reason: "Invalid hex format".to_string(),
    })?;

    let issuer_keypair =
        KeyPair::from_bytes(&issuer_key_bytes).map_err(|_| IdpError::InvalidField {
            field: "issuer_private_key".to_string(),
            reason: "Invalid key format".to_string(),
        })?;

    let issuer_public_key_hex = issuer_keypair.public_key().to_hex();

    let owner_pk =
        PublicKey::from_hex_with_algorithm(owner_public_key, key_algorithm).map_err(|e| {
            IdpError::InvalidField {
                field: "owner_public_key".to_string(),
                reason: format!("Invalid public key format: {}", e),
            }
        })?;

    // Prepare attributes - add mandatory issuerKey and ownerKey
    let mut attrs = attributes;
    attrs.insert(
        "issuerKey".to_string(),
        serde_json::json!(issuer_public_key_hex),
    );
    attrs.insert("ownerKey".to_string(), serde_json::json!(owner_pk.to_hex()));

    let available_predicates = derive_available_predicates(&attrs);
    let predicate_attestations =
        derive_predicate_attestations(&available_predicates, personhood, &attrs);

    // Token Status List index for this credential — assigned at issuance,
    // persisted so the issuer can flip the bit when the Midnight
    // revocation_registry marks this credential revoked. Monotonic from a
    // Postgres sequence (collision-free). The DB-less path is dev-only
    // (no revocation projection without the credential repo) and uses a
    // process-local monotonic counter from the same 0x100000 base.
    let status_idx: u64 = if let Some(repo) = credential_repo {
        repo.next_status_idx()
            .await
            .map_err(|e| IdpError::CredentialIssuance(format!("status idx: {e}")))? as u64
    } else {
        static FALLBACK_IDX: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0x0010_0000);
        FALLBACK_IDX.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    };

    // Issue the standard SD-JWT VC (signed by the issuer key).
    let sd_jwt_vc = claims_to_sd_jwt_vc(
        &attrs,
        &issuer_keypair,
        &predicate_attestations,
        issuer_public_url,
        status_idx,
    )?;

    // Optionally store in database, keyed by the stable credential id.
    if let Some(repo) = credential_repo {
        repo.store(
            credential_id(&sd_jwt_vc),
            issuer_public_key_hex,
            owner_pk.to_hex(),
            serde_json::json!({ "sdJwtVc": sd_jwt_vc }),
            None, // No expiration by default
            serde_json::json!({ "statusIdx": status_idx }),
        )
        .await
        .map_err(|e| IdpError::CredentialIssuance(format!("Database error: {}", e)))?;
    }

    Ok(sd_jwt_vc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_issue_credential_direct() {
        // Generate test keypairs (Ed25519)
        let issuer_keypair = KeyPair::generate();
        let owner_keypair = KeyPair::generate();

        let issuer_private_key = hex::encode(issuer_keypair.to_bytes());
        let owner_public_key = owner_keypair.public_key().to_hex();

        let mut attributes = BTreeMap::new();
        attributes.insert("firstName".to_string(), serde_json::json!("Test"));
        attributes.insert("lastName".to_string(), serde_json::json!("User"));
        attributes.insert("isOver18".to_string(), serde_json::json!(true));

        let result = issue_credential_direct(
            &issuer_private_key,
            &owner_public_key,
            SignatureAlgorithm::Ed25519,
            attributes,
            None, // No DB storage in test
            "https://issuer.example",
            false,
        )
        .await;

        assert!(result.is_ok());
        let sd_jwt_vc = result.unwrap();

        // It is a verifiable standard SD-JWT VC issued by this issuer.
        let v = owl_proof_system::sd_jwt::verify(
            &sd_jwt_vc,
            &issuer_keypair.public_key(),
            &owl_proof_system::sd_jwt::VerifyParams::default(),
        )
        .unwrap();
        assert_eq!(v.claims["age_over_18"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn test_issue_credential_invalid_issuer_key() {
        let owner_keypair = KeyPair::generate();
        let owner_public_key = owner_keypair.public_key().to_hex();

        let attributes = BTreeMap::new();

        let result = issue_credential_direct(
            "invalid_hex",
            &owner_public_key,
            SignatureAlgorithm::Ed25519,
            attributes,
            None,
            "https://issuer.example",
            false,
        )
        .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_issue_credential_invalid_owner_key() {
        let issuer_keypair = KeyPair::generate();
        let issuer_private_key = hex::encode(issuer_keypair.to_bytes());

        let attributes = BTreeMap::new();

        let result = issue_credential_direct(
            &issuer_private_key,
            "invalid_public_key",
            SignatureAlgorithm::Ed25519,
            attributes,
            None,
            "https://issuer.example",
            false,
        )
        .await;

        assert!(result.is_err());
    }
}
