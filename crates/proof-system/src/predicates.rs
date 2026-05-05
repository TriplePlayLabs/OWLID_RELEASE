//! Predicate registry — the canonical bridge between credential predicates
//! and the underlying ZK circuits.
//!
//! Every predicate the system can prove is enumerated here with a stable
//! string id (e.g. `"age:>=18"`, `"nationality:eu"`). The registry
//! tells `generate_predicate_proof` which circuit and parameters to use, and
//! lets the verifier recompute the canonical public input for `verify_zk_proof_pinned`
//! — closing the gap where a holder could ship an arbitrary set and have the
//! verifier rubber-stamp it.

use crate::token::PredicateOp;
use owl_zk_circuits::ZkProofType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredicateParams {
    /// Numeric threshold for range circuits (age / KYC).
    Threshold(u64),
    /// Name of a dataset registered in `owl_zk_circuits::data` for set-membership.
    SetName(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct Predicate {
    pub id: &'static str,
    pub circuit: ZkProofType,
    pub attribute: &'static str,
    pub op: PredicateOp,
    pub params: PredicateParams,
    pub label: &'static str,
}

static REGISTRY: &[Predicate] = &[
    Predicate {
        id: "age:>=18",
        circuit: ZkProofType::AgeRange,
        attribute: "dateOfBirth",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(18),
        label: "Age 18 or older",
    },
    Predicate {
        id: "age:>=21",
        circuit: ZkProofType::AgeRange,
        attribute: "dateOfBirth",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(21),
        label: "Age 21 or older",
    },
    Predicate {
        id: "age:>=65",
        circuit: ZkProofType::AgeRange,
        attribute: "dateOfBirth",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(65),
        label: "Age 65 or older",
    },
    Predicate {
        id: "nationality:eu",
        circuit: ZkProofType::Nationality,
        attribute: "nationality",
        op: PredicateOp::InSet,
        params: PredicateParams::SetName("eu"),
        label: "EU citizenship",
    },
    Predicate {
        id: "kyc:>=basic",
        circuit: ZkProofType::KycStatus,
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(1),
        label: "KYC level: basic or higher",
    },
    Predicate {
        id: "kyc:>=substantial",
        circuit: ZkProofType::KycStatus,
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(2),
        label: "KYC level: substantial or higher",
    },
    Predicate {
        id: "kyc:>=high",
        circuit: ZkProofType::KycStatus,
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(3),
        label: "KYC level: high",
    },
    Predicate {
        id: "residency:verified",
        circuit: ZkProofType::KycStatus,
        attribute: "isResident",
        op: PredicateOp::GreaterOrEqual,
        params: PredicateParams::Threshold(1),
        label: "Verified resident",
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
        .filter(|p| attrs.iter().any(|a| *a == p.attribute))
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
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_registry_hits_and_misses() {
        assert!(lookup("age:>=18").is_some());
        assert!(lookup("age:>=99").is_none());
    }

    #[test]
    fn for_attributes_filters_by_credential_shape() {
        let preds = for_attributes(&["dateOfBirth", "nationality"]);
        assert!(preds.iter().any(|p| p.id == "age:>=18"));
        assert!(preds.iter().any(|p| p.id == "nationality:eu"));
        assert!(preds.iter().all(|p| p.attribute != "verificationLevel"));
    }

    #[test]
    fn canonical_public_input_for_age_threshold() {
        let pred = lookup("age:>=18").unwrap();
        let hex = canonical_public_input_hex(pred).unwrap();
        assert_eq!(hex, owl_zk_circuits::data::canonical_threshold_input_hex(18));
    }

    #[test]
    fn canonical_public_input_for_set_membership() {
        let pred = lookup("nationality:eu").unwrap();
        let hex = canonical_public_input_hex(pred).unwrap();
        let expected = owl_zk_circuits::data::canonical_set_root_hex("eu").unwrap();
        assert_eq!(hex, expected);
    }
}
