//! DCQL (Digital Credentials Query Language) — OpenID4VP 1.0 §6.
//!
//! Wire shape only — the verifier evaluates per-credential constraints
//! after each SD-JWT VC has been independently verified (issuer trust,
//! KB-JWT, revocation, status list).  This module is the typed surface +
//! the credential_sets solver; it does NOT verify cryptography.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DcqlRequest {
    pub credentials: Vec<DcqlCredentialQuery>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "credential_sets"
    )]
    pub credential_sets: Option<Vec<DcqlCredentialSet>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DcqlCredentialQuery {
    pub id: String,
    /// Credential format identifier. OwlID accepts `dc+sd-jwt` only.
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<DcqlMeta>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub claims: Vec<DcqlClaimQuery>,
    /// Defaults to true (OpenID4VP 1.0 §6.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_cryptographic_holder_binding: Option<bool>,
    /// May this query yield more than one credential. Default false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
    /// OwlID extension under OID4VP §6 "MUST ignore unknown properties":
    /// the per-credential predicate dispatch the wallet honours. When
    /// present, the wallet substitutes a Midnight on-chain attestation
    /// check for the §6.4.1 disclosure obligation, and `claims` is left
    /// empty so spec-strict wallets treat the query as "no claims
    /// requested". Spec-strict (non-OwlID) wallets ignore this field
    /// per §6's closing note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owl_predicate: Option<OwlPredicate>,
}

/// Discriminated union of every Midnight-native predicate the
/// verifier can ask for. Mirrors the TypeScript `OwlPredicate` type
/// in `@owlid/sdk/owl-dcql` — keep both sides in lockstep.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OwlPredicate {
    /// Holder's age is ≥ `threshold` years.
    AgeGte { threshold: u64 },
    /// Holder's age is in `[min, max]` inclusive.
    AgeRange { min: u32, max: u32 },
    /// Issuer's verification level is ≥ `threshold` (1/2/3).
    KycGte { threshold: u64 },
    /// Holder's nationality is in the verifier's alpha-2 set.
    NationalityIn { countries: Vec<String> },
    /// Holder's residence country is in the set.
    ResidencyIn { countries: Vec<String> },
    /// Issuer attested the holder's email is verified.
    EmailVerified,
    /// Holder is a unique human within `(epoch, app_id)` (each hex32).
    UniquePersonhood { epoch: String, app_id: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DcqlMeta {
    /// For `dc+sd-jwt`, allowed `vct` values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vct_values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DcqlClaimQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Claims path pointer (OpenID4VP 1.0 §7). String tokens only —
    /// integer indices and wildcards are not exercised by OwlID's
    /// flat SD-JWT VC claim set.
    pub path: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct DcqlCredentialSet {
    /// One row of `options` is sufficient to satisfy the set.  Each
    /// entry inside a row is a credential `id` that must be present.
    pub options: Vec<Vec<String>>,
    #[serde(default)]
    pub required: Option<bool>,
}

/// Evaluate a single credential query against the **Midnight on-chain
/// attestation set** — every claim path must route to a Compact
/// predicate (`predicate_routing`). The verifier never reads disclosed
/// claim values: ALL trust flows through Midnight. Claims that don't
/// map to a Midnight predicate are rejected.
///
/// `cred_id_hex` is the 64-char hex of the SD-JWT VC `credential_id`.
/// `verifier_id` is the OID4VP verifier `client_id` (typically the
/// response_uri) — folded into the `setHash` for nationality / residency
/// keys, so two verifiers asking the same allowed-set produce distinct
/// on-chain keys (anti-rainbow-table + anti-cross-verifier correlation).
/// Returns the derived on-chain attestation key (hex) plus the sidecar
/// predicate-kind segment. Membership is checked by the caller — first
/// against the SSE-mirrored set, then (on a miss) via an authoritative
/// live-ledger read-through — so the eventually-consistent mirror can't
/// produce a false "not attested" for an attestation that has already
/// landed on chain.
pub struct AttestKey {
    pub key_hex: String,
    /// Sidecar predicate-kind segment
    /// (`age|kyc|residency|email|nationality|age_range|personhood`).
    pub kind: &'static str,
}

fn owl_root_anchor(owl_root_hex: Option<&str>) -> Option<[u8; 32]> {
    let v = hex::decode(owl_root_hex?.trim_start_matches("0x")).ok()?;
    v.as_slice().try_into().ok()
}

fn owl_root_required(query_id: &str, predicate: &str) -> String {
    format!(
        "DCQL credential {query_id}: {predicate} is bound to an issuer-signed owl_root, which \
         this credential lacks (reissue it)"
    )
}

pub fn derive_attest_key(
    query: &DcqlCredentialQuery,
    vct: &str,
    cred_id_hex: &str,
    owl_root_hex: Option<&str>,
    verifier_id: &str,
) -> Result<AttestKey, String> {
    use owl_proof_system::attestation;

    if query.format != "dc+sd-jwt" {
        return Err(format!(
            "DCQL credential.format must be dc+sd-jwt (got {})",
            query.format
        ));
    }
    if let Some(meta) = &query.meta {
        if !meta.vct_values.is_empty() && !meta.vct_values.iter().any(|v| v == vct) {
            return Err(format!("credential vct {vct} not in DCQL meta.vct_values"));
        }
    }

    let cred_vec = hex::decode(cred_id_hex.trim_start_matches("0x"))
        .map_err(|_| "credential_id not hex".to_string())?;
    // Validated for shape; predicate keys now anchor on owl_root, not cred_id.
    let _cred_id: [u8; 32] = cred_vec
        .as_slice()
        .try_into()
        .map_err(|_| "credential_id must be 32 bytes".to_string())?;

    // Plaintext-disclosure claims (`claims[].path` walking into the
    // SD-JWT VC) are explicitly NOT honoured: OwlID's privacy model
    // requires every check to route to a Midnight predicate via the
    // `owl_predicate` extension. A query carrying a non-empty
    // `claims` is treated as a misconfigured / non-OwlID-aware
    // verifier and rejected so the privacy contract is never silently
    // violated.
    if !query.claims.is_empty() {
        return Err(format!(
            "DCQL credential {}: plaintext disclosure claims (`claims[].path`) are not \
             accepted by OwlID. Use the `owl_predicate` extension to dispatch every \
             check to a Midnight on-chain attestation.",
            query.id
        ));
    }

    let Some(predicate) = &query.owl_predicate else {
        return Err(format!(
            "DCQL credential {}: missing `owl_predicate` extension. OwlID does not \
             disclose plaintext claim values; every credential query MUST carry an \
             `owl_predicate` describing which Midnight on-chain attestation to check.",
            query.id
        ));
    };

    let (attest_key, kind) = match predicate {
        OwlPredicate::AgeGte { threshold } => {
            let anchor =
                owl_root_anchor(owl_root_hex).ok_or_else(|| owl_root_required(&query.id, "age"))?;
            (
                attestation::age_key(
                    &anchor,
                    *threshold as u128,
                    attestation::current_age_epoch(),
                ),
                "age",
            )
        }
        OwlPredicate::AgeRange { min, max } => {
            let anchor = owl_root_anchor(owl_root_hex)
                .ok_or_else(|| owl_root_required(&query.id, "age_range"))?;
            (
                attestation::age_range_key(
                    &anchor,
                    *min as u16,
                    *max as u16,
                    attestation::current_age_epoch(),
                ),
                "age_range",
            )
        }
        OwlPredicate::KycGte { threshold } => {
            // F-1: kyc is bound to the issuer-signed owl_root, so its key
            // anchors on owl_root (not the credential id). A credential without
            // owl_root cannot satisfy a kyc query under the bound contract.
            let anchor =
                owl_root_anchor(owl_root_hex).ok_or_else(|| owl_root_required(&query.id, "kyc"))?;
            (attestation::kyc_key(&anchor, *threshold as u128), "kyc")
        }
        OwlPredicate::NationalityIn { countries } => {
            if verifier_id.is_empty() {
                return Err(format!(
                    "DCQL credential {}: verifier_id required for nationality_in \
                     (per-verifier salt binding the on-chain attestation key)",
                    query.id
                ));
            }
            let anchor = owl_root_anchor(owl_root_hex)
                .ok_or_else(|| owl_root_required(&query.id, "nationality_in"))?;
            let refs: Vec<&str> = countries.iter().map(String::as_str).collect();
            (
                attestation::nationality_key(&anchor, verifier_id, &refs),
                "nationality",
            )
        }
        OwlPredicate::ResidencyIn { countries } => {
            if verifier_id.is_empty() {
                return Err(format!(
                    "DCQL credential {}: verifier_id required for residency_in \
                     (per-verifier salt binding the on-chain attestation key)",
                    query.id
                ));
            }
            let anchor = owl_root_anchor(owl_root_hex)
                .ok_or_else(|| owl_root_required(&query.id, "residency_in"))?;
            let refs: Vec<&str> = countries.iter().map(String::as_str).collect();
            (
                attestation::residency_key(&anchor, verifier_id, &refs),
                "residency",
            )
        }
        OwlPredicate::EmailVerified => {
            let anchor = owl_root_anchor(owl_root_hex)
                .ok_or_else(|| owl_root_required(&query.id, "email_verified"))?;
            (attestation::email_verified_key(&anchor), "email")
        }
        OwlPredicate::UniquePersonhood { epoch, app_id } => {
            // F-2: the campaign app_id stays meaningful but is bound under the
            // verifier's authenticated client_id, so a different verifier
            // choosing the same campaign cannot share the nullifier namespace
            // and no verifier can forge a foreign scope.
            if verifier_id.is_empty() {
                return Err(format!(
                    "DCQL credential {}: verifier_id required for unique_personhood \
                     (binds the campaign scope to the verifier identity)",
                    query.id
                ));
            }
            let anchor = owl_root_anchor(owl_root_hex)
                .ok_or_else(|| owl_root_required(&query.id, "unique_personhood"))?;
            let epoch_bytes = decode_hex32(epoch)
                .map_err(|e| format!("DCQL credential {}: epoch {}", query.id, e))?;
            let campaign = decode_hex32(app_id)
                .map_err(|e| format!("DCQL credential {}: app_id {}", query.id, e))?;
            let app_id_bytes = attestation::personhood_app_id(verifier_id, &campaign);
            (
                attestation::unique_personhood_key(&anchor, &epoch_bytes, &app_id_bytes),
                "personhood",
            )
        }
    };
    Ok(AttestKey {
        key_hex: hex::encode(attest_key),
        kind,
    })
}

/// Decode a 32-byte value from hex (tolerating a `0x` prefix).
fn decode_hex32(hex: &str) -> Result<[u8; 32], String> {
    let vec = hex::decode(hex.trim_start_matches("0x")).map_err(|_| "not hex".to_string())?;
    vec.as_slice()
        .try_into()
        .map_err(|_| "must be 32 bytes".to_string())
}

/// Confirm the set of satisfied DCQL ids meets every `credential_sets`
/// entry (default `required: true`).
pub fn check_credential_sets(
    request: &DcqlRequest,
    satisfied: &HashSet<String>,
) -> Result<(), String> {
    let Some(sets) = &request.credential_sets else {
        // Without credential_sets, all `credentials[]` are implicitly required.
        for cred in &request.credentials {
            if !satisfied.contains(&cred.id) {
                return Err(format!("DCQL credential {} not satisfied", cred.id));
            }
        }
        return Ok(());
    };
    for set in sets {
        let required = set.required.unwrap_or(true);
        let any_row_satisfied = set
            .options
            .iter()
            .any(|row| row.iter().all(|id| satisfied.contains(id)));
        if required && !any_row_satisfied {
            return Err(format!(
                "DCQL credential_set unsatisfied (options={:?})",
                set.options
            ));
        }
    }
    Ok(())
}

/// Default permissive query for OpenID4VP `direct_post` when the wire
/// carries no DCQL query (out-of-band agreement).  Every `vp_token`
/// entry must verify cryptographically; no claim-path constraints.
pub fn permissive_query(vp_token: &HashMap<String, Vec<String>>) -> DcqlRequest {
    DcqlRequest {
        credentials: vp_token
            .keys()
            .map(|id| DcqlCredentialQuery {
                id: id.clone(),
                format: "dc+sd-jwt".to_string(),
                meta: None,
                claims: Vec::new(),
                require_cryptographic_holder_binding: None,
                multiple: None,
                owl_predicate: None,
            })
            .collect(),
        credential_sets: None,
    }
}
