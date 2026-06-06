//! Predicate registry — the canonical bridge between credential predicates
//! and the underlying ZK circuits.
//!
//! Every predicate the system can prove is enumerated here with a stable
//! string id (e.g. `"age:gte"`, `"nationality:eu"`). The registry
//! tells `generate_predicate_proof` which circuit and parameters to use, and
//! lets the verifier recompute the canonical public input for `verify_zk_proof_pinned`
//! — closing the gap where a holder could ship an arbitrary set and have the
//! verifier rubber-stamp it.

use owl_zk_circuits::ZkProofType;
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
    /// Name of a dataset registered in `owl_zk_circuits::data` for set-membership.
    SetName(&'static str),
    /// No params pinned at registry time — the verifier supplies the
    /// value(s) at request time (e.g. the age threshold / range bounds).
    /// The predicate is presence-stamped; scope is presentation-time.
    Dynamic,
}

#[derive(Debug, Clone, Copy)]
pub struct Predicate {
    pub id: &'static str,
    pub circuit: ZkProofType,
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
        circuit: ZkProofType::AgeRange,
        attribute: "dateOfBirth",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Dynamic,
        label: "Over a minimum age",
    },
    Predicate {
        id: "age:range",
        route: "age_range",
        circuit: ZkProofType::AgeRange,
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
        circuit: ZkProofType::Nationality,
        attribute: "nationality",
        op: PredicateOp::InSet,
        params: PredicateParams::Dynamic,
        label: "Nationality is one you allow",
    },
    Predicate {
        id: "kyc:>=basic",
        route: "verification_level",
        circuit: ZkProofType::KycStatus,
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(1),
        label: "ID check: basic or higher",
    },
    Predicate {
        id: "kyc:>=substantial",
        route: "verification_level",
        circuit: ZkProofType::KycStatus,
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(2),
        label: "ID check: substantial or higher",
    },
    Predicate {
        id: "kyc:>=high",
        route: "verification_level",
        circuit: ZkProofType::KycStatus,
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
        circuit: ZkProofType::KycStatus,
        attribute: "residentCountry",
        op: PredicateOp::InSet,
        params: PredicateParams::Dynamic,
        label: "Lives in a country you allow",
    },
    Predicate {
        id: "email:verified",
        route: "email_verified",
        // Email-verified does not have an off-chain Groth16 circuit;
        // we reuse the KycStatus enum slot because the registry
        // requires a discriminant. Actual attestation is via the
        // Midnight `attestEmailVerified` Compact circuit. The
        // verifier consults the SSE-mirrored attestation set, no
        // Groth16 verify on the hot path.
        circuit: ZkProofType::KycStatus,
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
        circuit: ZkProofType::KycStatus,
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

/// Hex-encoded canonical public input the underlying circuit emits for this
/// predicate. Matches `ZkProof.public_inputs[0]`.
pub fn canonical_public_input_hex(pred: &Predicate) -> Option<String> {
    match (pred.circuit, pred.params) {
        (ZkProofType::AgeRange, PredicateParams::Threshold(t))
        | (ZkProofType::KycStatus, PredicateParams::Threshold(t)) => {
            Some(owl_zk_circuits::data::canonical_threshold_input_hex(t))
        }
        (ZkProofType::Nationality, PredicateParams::SetName(name)) => {
            owl_zk_circuits::data::canonical_set_root_hex(name)
        }
        // `Dynamic` predicates have no registry-pinned value — the
        // verifier supplies it at request time, so there is no single
        // canonical public input.
        (_, PredicateParams::Dynamic) => None,
        _ => None,
    }
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

    #[test]
    fn dynamic_predicate_has_no_canonical_input() {
        let pred = lookup("age:gte").unwrap();
        assert!(canonical_public_input_hex(pred).is_none());
    }
}
