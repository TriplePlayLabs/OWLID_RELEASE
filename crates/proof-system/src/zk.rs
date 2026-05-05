//! T-016: ZK proof integration for privacy-preserving token predicates
//!
//! Bridges the `owl-zk-circuits` crate with the token system, allowing
//! ZK proofs to be attached to tokens and verified during token validation.
//!
//! Verification always uses cached prepared verification keys (via `get_pvk`).
//! VK bytes are never read from the proof — the verifier looks up the circuit
//! by proof type.

use crate::error::ProofSystemError;
use crate::token::{PredicateOp, PredicateRequest};
use chrono::Datelike;
use owl_zk_circuits::{ZkError, ZkProof, ZkProofType};
use owl_zk_circuits::{age_range, kyc_status, nationality};
use serde_json;

/// Generate an age range ZK proof (proves age >= threshold without revealing age)
pub fn prove_age_range(age: u64, threshold: u64) -> Result<ZkProof, ZkError> {
    let pk = owl_zk_circuits::get_pk(&ZkProofType::AgeRange);
    age_range::prove(pk, age, threshold)
}

/// Generate a KYC status ZK proof (proves KYC level >= required without revealing level)
pub fn prove_kyc_status(level: u64, required_level: u64) -> Result<ZkProof, ZkError> {
    let pk = owl_zk_circuits::get_pk(&ZkProofType::KycStatus);
    kyc_status::prove(pk, level, required_level)
}

/// Generate a nationality ZK proof against a named, registered dataset.
pub fn prove_nationality(
    nationality: &str,
    set_name: &str,
) -> Result<ZkProof, ZkError> {
    let pk = owl_zk_circuits::get_pk(&ZkProofType::Nationality);
    nationality::prove(pk, nationality, set_name)
}

/// Verify a ZK proof using the cached prepared verification key.
pub fn verify_zk_proof(proof: &ZkProof) -> Result<bool, ZkError> {
    let pvk = owl_zk_circuits::get_pvk(&proof.proof_type);
    match proof.proof_type {
        ZkProofType::AgeRange => age_range::verify(pvk, proof),
        ZkProofType::Nationality => nationality::verify(pvk, proof),
        ZkProofType::KycStatus => kyc_status::verify(pvk, proof),
    }
}

/// Verify a ZK proof against a registry-pinned predicate.
///
/// The proof's first public input is recomputed from the predicate's params
/// (threshold for range circuits, canonical Merkle root for set circuits) and
/// must match before Groth16 verification runs. This closes the gap where a
/// holder could pick the public input themselves.
pub fn verify_zk_proof_pinned(
    pred: &crate::predicates::Predicate,
    zk_proof: &ZkProof,
) -> Result<bool, ProofSystemError> {
    if zk_proof.proof_type != pred.circuit {
        return Err(ProofSystemError::InvalidProof(format!(
            "Proof circuit {:?} does not match predicate '{}'",
            zk_proof.proof_type, pred.id
        )));
    }
    let canonical = crate::predicates::canonical_public_input_hex(pred).ok_or_else(|| {
        ProofSystemError::InvalidProof(format!(
            "Predicate '{}' has no canonical public input",
            pred.id
        ))
    })?;
    let actual = zk_proof.public_inputs.first().ok_or_else(|| {
        ProofSystemError::InvalidProof("ZK proof missing public input".into())
    })?;
    if actual != &canonical {
        return Err(ProofSystemError::InvalidProof(format!(
            "ZK proof public input does not match predicate '{}'",
            pred.id
        )));
    }
    verify_zk_proof(zk_proof).map_err(|e| ProofSystemError::InvalidProof(e.to_string()))
}

/// Resolve which registered predicate this proof claims to satisfy.
///
/// Matches on the bound attribute, circuit type, and the recomputed canonical
/// public input. Returns `None` if no registered predicate fits — the proof
/// is using a circuit input the registry doesn't recognize.
pub fn resolve_proof_predicate(
    zk_proof: &ZkProof,
) -> Option<&'static crate::predicates::Predicate> {
    let attr = zk_proof.bound_attribute.as_deref()?;
    let actual = zk_proof.public_inputs.first()?;
    crate::predicates::list_all().iter().find(|p| {
        p.circuit == zk_proof.proof_type
            && p.attribute == attr
            && crate::predicates::canonical_public_input_hex(p).as_deref() == Some(actual)
    })
}

/// Serialize a ZkProof into a serde_json::Value for inclusion in TokenPayload
pub fn zk_proof_to_value(proof: &ZkProof) -> serde_json::Value {
    serde_json::to_value(proof).unwrap_or_default()
}

/// Deserialize a serde_json::Value back into a ZkProof
pub fn zk_proof_from_value(value: &serde_json::Value) -> Result<ZkProof, ZkError> {
    serde_json::from_value(value.clone())
        .map_err(|e| ZkError::SerializationError(e.to_string()))
}

/// Verify all ZK proofs in a list of JSON values, pinning each one against
/// the predicate registry. Each proof must claim a registered predicate; the
/// public input must equal the canonical input the registry recomputes.
pub fn verify_all_zk_proofs(proofs: &[serde_json::Value]) -> Result<(), ProofSystemError> {
    for (i, proof_value) in proofs.iter().enumerate() {
        let proof = zk_proof_from_value(proof_value)
            .map_err(|e| ProofSystemError::InvalidProof(e.to_string()))?;
        let pred = resolve_proof_predicate(&proof).ok_or_else(|| {
            ProofSystemError::InvalidProof(format!(
                "ZK proof {} does not match any registered predicate",
                i
            ))
        })?;
        let valid = verify_zk_proof_pinned(pred, &proof)?;
        if !valid {
            return Err(ProofSystemError::InvalidProof(format!(
                "ZK proof {} for predicate '{}' verification failed",
                i, pred.id
            )));
        }
    }
    Ok(())
}

/// Parse an ISO date string (e.g., "1999-01-15") to a NaiveDate
fn parse_date_of_birth(value: &serde_json::Value) -> Result<chrono::NaiveDate, ProofSystemError> {
    let date_str = value
        .as_str()
        .ok_or_else(|| ProofSystemError::InvalidProof("dateOfBirth must be a string".into()))?;
    // chrono's parse error echoes the input string — strip it before crossing
    // any boundary, since the input is private credential data.
    chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .map_err(|_| ProofSystemError::InvalidProof("dateOfBirth must be ISO YYYY-MM-DD".into()))
}

/// Compute age in years from a date of birth
fn compute_age(dob: chrono::NaiveDate) -> u64 {
    let today = chrono::Utc::now().date_naive();
    let mut age = (today.year() - dob.year()) as u64;
    if (today.month(), today.day()) < (dob.month(), dob.day()) {
        age = age.saturating_sub(1);
    }
    age
}

/// Resolve the dataset name carried by an `InSet` predicate request.
///
/// The wire form is a registered dataset name (e.g. `"eu"`); the
/// holder no longer ships an explicit list, which would let them choose any
/// set after the fact.
fn predicate_set_name(value: &serde_json::Value) -> Result<&'static str, ProofSystemError> {
    let name = value.as_str().ok_or_else(|| {
        ProofSystemError::InvalidProof("InSet value must be a dataset name string".into())
    })?;
    owl_zk_circuits::data::lookup(name)
        .map(|d| d.name)
        .ok_or_else(|| {
            ProofSystemError::InvalidProof(format!("Unknown nationality dataset '{}'", name))
        })
}

/// Convert verification level string to numeric value
fn verification_level_to_u64(value: &serde_json::Value) -> Result<u64, ProofSystemError> {
    if let Some(n) = value.as_u64() {
        return Ok(n);
    }
    match value.as_str() {
        Some("low" | "unverified") => Ok(0),
        Some("basic") => Ok(1),
        Some("substantial" | "standard") => Ok(2),
        Some("high" | "enhanced") => Ok(3),
        _ => Err(ProofSystemError::InvalidProof(format!(
            "Unknown verificationLevel: {}",
            value
        ))),
    }
}

/// Given a predicate and the actual attribute value from the credential,
/// generate the appropriate ZK proof with binding metadata.
///
/// Privacy contract: the only error that may carry attribute-derived
/// information out of this function is `PredicateNotSatisfied { attribute }`,
/// which carries the field name (already known to the verifier) and nothing
/// else. All upstream `ZkError` variants are mapped accordingly — we never
/// stringify a leaky inner error message.
pub fn generate_predicate_proof(
    pred: &PredicateRequest,
    attr_value: &serde_json::Value,
    leaf_hash_hex: &str,
) -> Result<ZkProof, ProofSystemError> {
    let attr = pred.attribute.clone();
    let map_zk = |e: ZkError| -> ProofSystemError {
        match e {
            ZkError::PreconditionFailed => ProofSystemError::PredicateNotSatisfied {
                attribute: attr.clone(),
                predicate_id: None,
            },
            // Anything else is a real failure (proving system, serialization,
            // setup). Surface a generic message — no inner string crosses out.
            _ => ProofSystemError::InvalidProof("proof generation failed".into()),
        }
    };

    let mut proof = match (&*pred.attribute, &pred.op) {
        ("dateOfBirth", PredicateOp::GreaterOrEqual) => {
            let threshold = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("age threshold must be a number".into()))?;
            let dob = parse_date_of_birth(attr_value)?;
            let age = compute_age(dob);
            prove_age_range(age, threshold).map_err(map_zk)?
        }
        ("nationality", PredicateOp::InSet) => {
            let nat = attr_value
                .as_str()
                .ok_or_else(|| ProofSystemError::InvalidProof("nationality must be a string".into()))?;
            let set_name = predicate_set_name(&pred.value)?;
            prove_nationality(nat, set_name).map_err(map_zk)?
        }
        ("verificationLevel", PredicateOp::GreaterOrEqual) => {
            let level = verification_level_to_u64(attr_value)?;
            let required = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("required level must be a number".into()))?;
            prove_kyc_status(level, required).map_err(map_zk)?
        }
        ("isResident", PredicateOp::GreaterOrEqual) => {
            let is_resident = attr_value.as_bool().unwrap_or(false);
            let value: u64 = if is_resident { 1 } else { 0 };
            let threshold = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("isResident threshold must be a number".into()))?;
            prove_kyc_status(value, threshold).map_err(map_zk)?
        }
        (attr_name, op) => {
            return Err(ProofSystemError::InvalidProof(format!(
                "Unsupported predicate: attribute='{}', op={:?}",
                attr_name, op
            )));
        }
    };

    proof.bound_attribute = Some(pred.attribute.clone());
    proof.attribute_leaf_hash = Some(leaf_hash_hex.to_string());

    Ok(proof)
}

/// Evaluate whether the given credential value would satisfy the predicate,
/// without generating a proof. Used by holders to drive consent UI ("you do
/// not meet this requirement") before approving and producing a proof.
///
/// Returns `Ok(true)` if the predicate holds, `Ok(false)` if it does not, and
/// `Err(...)` only for malformed inputs (bad date format, unknown dataset,
/// unsupported predicate). This intentionally mirrors `generate_predicate_proof`
/// but never calls into the proving system.
pub fn evaluate_predicate(
    pred: &PredicateRequest,
    attr_value: &serde_json::Value,
) -> Result<bool, ProofSystemError> {
    match (&*pred.attribute, &pred.op) {
        ("dateOfBirth", PredicateOp::GreaterOrEqual) => {
            let threshold = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("age threshold must be a number".into()))?;
            let dob = parse_date_of_birth(attr_value)?;
            Ok(compute_age(dob) >= threshold)
        }
        ("nationality", PredicateOp::InSet) => {
            let nat = attr_value
                .as_str()
                .ok_or_else(|| ProofSystemError::InvalidProof("nationality must be a string".into()))?;
            let set_name = predicate_set_name(&pred.value)?;
            let dataset = owl_zk_circuits::data::lookup(set_name).ok_or_else(|| {
                ProofSystemError::InvalidProof(format!("Unknown nationality dataset '{}'", set_name))
            })?;
            Ok(dataset.canonicalize(nat).is_some())
        }
        ("verificationLevel", PredicateOp::GreaterOrEqual) => {
            let level = verification_level_to_u64(attr_value)?;
            let required = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("required level must be a number".into()))?;
            Ok(level >= required)
        }
        ("isResident", PredicateOp::GreaterOrEqual) => {
            let is_resident = attr_value.as_bool().unwrap_or(false);
            let value: u64 = if is_resident { 1 } else { 0 };
            let threshold = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("isResident threshold must be a number".into()))?;
            Ok(value >= threshold)
        }
        (attr_name, op) => Err(ProofSystemError::InvalidProof(format!(
            "Unsupported predicate: attribute='{}', op={:?}",
            attr_name, op
        ))),
    }
}
