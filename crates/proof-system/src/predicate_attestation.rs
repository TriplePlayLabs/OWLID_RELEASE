//! `PredicateAttestation` — the Midnight on-chain attestation reference an
//! issuer asserts for a credential. Surfaced into the standard SD-JWT VC as
//! the optional `owl_attestation` claim; the verifier recomputes each key
//! from the credential and checks the SSE-mirrored on-chain set. Pure data,
//! no dependency on the (deleted) legacy token/Merkle format.

use serde::{Deserialize, Serialize};

/// A request to confirm a predicate via on-chain attestation.
///
/// `predicate` is the canonical key — `age` | `kyc` | `nationality` |
/// `residency` | `age_range` | `email_verified` |
/// `unique_personhood`. Optional params carry the variant-specific
/// public input the verifier needs to recompute the attestation key.
///
/// Only the params relevant to the variant are set; the rest serialize
/// out via `skip_serializing_if = Option::is_none`, so older payloads
/// (just `predicate` + `threshold`) deserialize unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PredicateAttestation {
    pub predicate: String,
    /// Numeric threshold for `age`, `kyc` (`value >= threshold`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<u64>,
    /// Lower bound for `age_range` (`age in [min_age, max_age]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_age: Option<u16>,
    /// Upper bound for `age_range`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_age: Option<u16>,
    /// Scope hash (`epoch`, hex-encoded 32 bytes) for `unique_personhood`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<String>,
    /// Application id (hex-encoded 32 bytes) for `unique_personhood`.
    /// Bound into the on-chain nullifier so two presentations against
    /// different apps cannot be correlated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    /// For `nationality` / `residency`: the holder's actual country
    /// (ISO 3166-1 alpha-2). The issuer stamps the credential with the
    /// real value the wallet later proves is `∈ verifier-supplied set`.
    /// `None` ⇒ no country known to the issuer (legacy / partial KYC).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
}
