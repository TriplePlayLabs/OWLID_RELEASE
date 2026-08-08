//! Predicate registry — the canonical catalogue of credential predicates.
//!
//! Every predicate the system can prove is enumerated here with a stable string
//! id (e.g. `"age:gte"`, `"nationality:in"`). The issuer uses it to decide which
//! `predicate_attestations` to stamp on a credential; the verifier service
//! serves it over `/predicates` so a verifier can pick what to request. Actual
//! proving is the Midnight/Compact `attest*` circuits (see `attestation.rs`);
//! this module carries no circuit or proving-key coupling.

use serde::{Deserialize, Serialize};

/// Predicate comparison operator.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PredicateOp {
    /// e.g. age >= 18, kycLevel >= 2
    GreaterOrEqual,
    /// e.g. nationality in dataset "eu"
    InSet,
    /// e.g. min <= age <= max
    InRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredicateParams {
    /// Numeric threshold for range circuits (KYC).
    Threshold(u64),
    /// Name of a dataset registered in `crate::datasets` for set-membership.
    SetName(&'static str),
    /// No params pinned at registry time — the verifier supplies the
    /// value(s) at request time (e.g. the age threshold / range bounds).
    /// The predicate is presence-stamped; scope is presentation-time.
    Dynamic,
}

#[derive(Debug, Clone, Copy)]
pub struct Predicate {
    pub id: &'static str,
    pub attribute: &'static str,
    pub op: PredicateOp,
    pub params: PredicateParams,
    pub label: &'static str,
    /// DCQL claim-path route token the holder SDK (`routeClaim`) and
    /// the verifier (`predicate_routing::route_claim`) dispatch on.
    /// This — NOT `attribute` — is what a verifier puts on a DCQL
    /// claim path. Must be a token `route_claim` recognises.
    pub route: &'static str,
}

static REGISTRY: &[Predicate] = &[
    Predicate {
        id: "age:gte",
        route: "age_over",
        attribute: "dateOfBirth",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Dynamic,
        label: "Over a minimum age",
    },
    Predicate {
        id: "age:range",
        route: "age_range",
        attribute: "dateOfBirth",
        op: PredicateOp::InRange,
        params: PredicateParams::Dynamic,
        label: "Age in a set range",
    },
    Predicate {
        // Presence marker for the verifier-supplied-set nationality
        // attestation (`attestNationalityIn`). The actual allowed
        // country set is presentation-time (DCQL `nationality_in: [...]`);
        // this entry only asserts the credential carries a parseable
        // `nationality`, so the holder can prove it against any set the
        // verifier picks.
        id: "nationality:in",
        route: "nationality_in",
        attribute: "nationality",
        op: PredicateOp::InSet,
        params: PredicateParams::Dynamic,
        label: "Nationality is one you allow",
    },
    Predicate {
        id: "kyc:>=basic",
        route: "verification_level",
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(1),
        label: "ID check: basic or higher",
    },
    Predicate {
        id: "kyc:>=substantial",
        route: "verification_level",
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(2),
        label: "ID check: substantial or higher",
    },
    Predicate {
        id: "kyc:>=high",
        route: "verification_level",
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(3),
        label: "ID check: high",
    },
    Predicate {
        // Presence marker for the verifier-supplied-set residency
        // attestation (`attestResidencyIn`). The actual allowed country
        // set is presentation-time (DCQL `resident_in: ["NL",…]`); this
        // entry only asserts the credential carries a `residentCountry`
        // and so can be proven against any set the verifier picks.
        id: "residency:in",
        route: "resident_in",
        attribute: "residentCountry",
        op: PredicateOp::InSet,
        params: PredicateParams::Dynamic,
        label: "Lives in a country you allow",
    },
    Predicate {
        id: "email:verified",
        route: "email_verified",
        // Attested via the Midnight `attestEmailVerified` Compact circuit;
        // the verifier consults the SSE-mirrored attestation set.
        attribute: "emailVerified",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(1),
        label: "Email is verified",
    },
    Predicate {
        id: "personhood:unique",
        route: "unique_person",
        // Same rationale as `email:verified`: Midnight-only
        // attestation via `attestUniquePersonhood`. The witness
        // (`personhood_secret`) is the holder's, scope is
        // `(epoch, app_id)` set by the verifier at request time.
        attribute: "personhoodSecret",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(1),
        label: "Unique person (one claim per campaign)",
    },
];

pub fn lookup(id: &str) -> Option<&'static Predicate> {
    REGISTRY.iter().find(|p| p.id == id)
}

pub fn list_all() -> &'static [Predicate] {
    REGISTRY
}

/// Subset of the registry whose `attribute` is in `attrs`.
pub fn for_attributes(attrs: &[&str]) -> Vec<&'static Predicate> {
    REGISTRY
        .iter()
        .filter(|p| attrs.contains(&p.attribute))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_registry_hits_and_misses() {
        assert!(lookup("age:gte").is_some());
        assert!(lookup("age:>=99").is_none());
    }

    #[test]
    fn for_attributes_filters_by_credential_shape() {
        let preds = for_attributes(&["dateOfBirth", "nationality"]);
        assert!(preds.iter().any(|p| p.id == "age:gte"));
        assert!(preds.iter().any(|p| p.id == "nationality:in"));
        assert!(preds.iter().all(|p| p.attribute != "verificationLevel"));
    }
}
