//! DCQL claim path → Midnight predicate attestation router.
//!
//! Wire stays standard DCQL (claim path + optional `values`). Server
//! and wallet both consult this table: paths listed here are proven by
//! per-kind Midnight predicate attestation set membership (no claim
//! value disclosed); paths NOT listed fall back to standard SD-JWT VC
//! selective disclosure.
//!
//! Order matters for `verification_level`: the requested DCQL `values`
//! pick which `kyc:>=N` rung to attest. Missing/empty values defaults
//! to the lowest rung.
//!
//! Mirror in TypeScript at `packages/sdk/src/predicate-routing.ts`.

use serde::{Deserialize, Serialize};

/// Predicate identity recoverable from a DCQL claim path + optional
/// matched value. The verifier feeds this into the
/// `attestation::*_key` recipe + checks the Midnight on-chain set.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoutedPredicate {
    AgeGte {
        threshold: u64,
    },
    /// Inclusive age range (`min_age <= age <= max_age`). Both bounds
    /// are carried in the DCQL claim `values` as one object
    /// `{ "min": <u64>, "max": <u64> }` and bind the on-chain key.
    AgeRange {
        min: u64,
        max: u64,
    },
    KycGte {
        threshold: u64,
    },
    /// Nationality ∈ verifier-supplied allowed set (ISO 3166-1 alpha-2,
    /// ≤64 codes — mirrors the Compact `Vector<64, Bytes<32>>` witness).
    /// The on-chain attestation key binds to a per-verifier hash of the
    /// canonical set (see `attestation::allowed_country_set_hash`); the
    /// set itself never appears in the on-chain transcript.
    NationalityIn {
        countries: Vec<String>,
    },
    /// Residency country ∈ verifier-supplied allowed set. Same shape as
    /// `NationalityIn` but for the holder's residence country.
    ResidencyIn {
        countries: Vec<String>,
    },
    EmailVerified,
    /// Sybil-resistant unique personhood. `epoch` + `app_id` are the
    /// verifier's presentation-time scope (32-byte hex each), carried
    /// in the DCQL claim `values` — they bind the on-chain nullifier so
    /// the same human cannot double-claim within one (campaign, round)
    /// yet stays uncorrelated across campaigns.
    UniquePersonhood {
        epoch: String,
        app_id: String,
    },
}

/// Best-effort routing for a single DCQL claim. Returns `None` when
/// the claim must fall back to SD-JWT VC selective disclosure.
///
/// `values` is the DCQL `values` array on the claim (used to pick the
/// rung for `verification_level`).
pub fn route_claim(path: &str, values: &[serde_json::Value]) -> Option<RoutedPredicate> {
    match path {
        "age_over" => pick_age_threshold(values),
        "age_range" => pick_age_range(values),
        "nationality_in" => {
            pick_country_set(values).map(|countries| RoutedPredicate::NationalityIn { countries })
        }
        "resident_in" => {
            pick_country_set(values).map(|countries| RoutedPredicate::ResidencyIn { countries })
        }
        // Legacy synonym kept for older verifier configs — translates to
        // the EU-27 country set.
        "nationality_eu" => Some(RoutedPredicate::NationalityIn {
            countries: EU_COUNTRY_CODES.iter().map(|s| s.to_string()).collect(),
        }),
        "email_verified" => Some(RoutedPredicate::EmailVerified),
        "verification_level" => Some(RoutedPredicate::KycGte {
            threshold: pick_kyc_threshold(values),
        }),
        "unique_person" => pick_personhood_scope(values),
        _ => None,
    }
}

/// The EU-27 country codes — preserved here so legacy `nationality_eu`
/// requests resolve to the same set the issuer stamps for EU-citizen
/// credentials. Order matches `crates/proof-system/src/eu.rs` if/when
/// that file is added; for now the constant lives here.
pub const EU_COUNTRY_CODES: &[&str] = &[
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];

/// Pick an array of ISO 3166-1 alpha-2 country codes from the DCQL
/// `values` array. Accepts three shapes — the verifier-app emits the
/// nested-array form, the others stay supported for older configs:
///   - `[["NL","BE"]]`              — nested array (verifier-app default)
///   - `["NL","BE"]`                — flat array
///   - `[{"countries":["NL","BE"]}]` — object with `countries` key
/// Empty / malformed = `None` (claim does not route). Caps at 64 codes
/// per the Compact witness vector size.
fn pick_country_set(values: &[serde_json::Value]) -> Option<Vec<String>> {
    if values.is_empty() {
        return None;
    }
    let first = values.first()?;
    // Form 1: nested array — the verifier-app's PredicateSelector
    // emits `claim.values = [input.countries]`, so the first slot is
    // the country array itself.
    if let Some(arr) = first.as_array() {
        return collect_country_codes(arr);
    }
    // Form 3: [{"countries": [...]}]
    if let Some(arr) = first.get("countries").and_then(serde_json::Value::as_array) {
        return collect_country_codes(arr);
    }
    // Form 2: flat ["NL", "BE", ...]
    collect_country_codes(values)
}

/// Hard cap on the verifier-supplied allowed-set, mirroring the Compact
/// `Vector<COUNTRY_SET_SLOTS, Bytes<32>>` witness. Kept as a fn (not a
/// `pub use`) to avoid re-exporting the constant from the routing API.
fn owl_proof_system_country_cap() -> usize {
    crate::attestation::COUNTRY_SET_SLOTS
}

fn collect_country_codes(arr: &[serde_json::Value]) -> Option<Vec<String>> {
    let codes: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(str::to_uppercase))
        .filter(|s| s.len() == 2 && s.chars().all(|c| c.is_ascii_alphabetic()))
        .collect();
    if codes.is_empty() || codes.len() > owl_proof_system_country_cap() {
        None
    } else {
        Some(codes)
    }
}

/// `unique_person` carries its `(epoch, app_id)` scope in the DCQL
/// `values` array as a single object `{ "epoch": <hex>, "app_id": <hex> }`.
/// Both are 32-byte hex; missing/malformed values mean the verifier did
/// not actually request a scoped personhood proof, so the claim does
/// not route (and falls through to the "no Midnight predicate" error).
fn pick_personhood_scope(values: &[serde_json::Value]) -> Option<RoutedPredicate> {
    let v = values.first()?;
    let epoch = v.get("epoch").and_then(serde_json::Value::as_str)?;
    let app_id = v.get("app_id").and_then(serde_json::Value::as_str)?;
    Some(RoutedPredicate::UniquePersonhood {
        epoch: epoch.to_string(),
        app_id: app_id.to_string(),
    })
}

/// `age_over` carries its threshold in the DCQL `values` array as a
/// single JSON number. The verifier supplies it at request time; a
/// missing/malformed value means no real age proof was requested, so
/// the claim does not route.
fn pick_age_threshold(values: &[serde_json::Value]) -> Option<RoutedPredicate> {
    let threshold = values.first()?.as_u64()?;
    Some(RoutedPredicate::AgeGte { threshold })
}

/// `age_range` carries its inclusive bounds in the DCQL `values` array
/// as a single object `{ "min": <u64>, "max": <u64> }`. The verifier
/// supplies them at request time; missing/malformed bounds mean the
/// verifier did not request a real range proof, so the claim does not
/// route.
fn pick_age_range(values: &[serde_json::Value]) -> Option<RoutedPredicate> {
    let v = values.first()?;
    let min = v.get("min").and_then(serde_json::Value::as_u64)?;
    let max = v.get("max").and_then(serde_json::Value::as_u64)?;
    Some(RoutedPredicate::AgeRange { min, max })
}

/// `verification_level` is one DCQL path that fans out into three
/// Midnight rungs (basic / substantial / high). Verifier signals which
/// via DCQL `values: [1|2|3]`. Default to the lowest rung when nothing
/// specified.
fn pick_kyc_threshold(values: &[serde_json::Value]) -> u64 {
    for v in values {
        if let Some(n) = v.as_u64() {
            return n;
        }
        if let Some(s) = v.as_str() {
            match s {
                "high" => return 3,
                "substantial" => return 2,
                "basic" => return 1,
                _ => {}
            }
        }
    }
    1
}
