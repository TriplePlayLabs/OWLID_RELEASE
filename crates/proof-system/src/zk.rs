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

/// Generate a nationality ZK proof (proves nationality is in allowed set)
pub fn prove_nationality(
    nationality: &str,
    allowed_countries: &[&str],
) -> Result<ZkProof, ZkError> {
    let pk = owl_zk_circuits::get_pk(&ZkProofType::Nationality);
    nationality::prove(pk, nationality, allowed_countries)
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

/// Serialize a ZkProof into a serde_json::Value for inclusion in TokenPayload
pub fn zk_proof_to_value(proof: &ZkProof) -> serde_json::Value {
    serde_json::to_value(proof).unwrap_or_default()
}

/// Deserialize a serde_json::Value back into a ZkProof
pub fn zk_proof_from_value(value: &serde_json::Value) -> Result<ZkProof, ZkError> {
    serde_json::from_value(value.clone())
        .map_err(|e| ZkError::SerializationError(e.to_string()))
}

/// Verify all ZK proofs in a list of JSON values
pub fn verify_all_zk_proofs(proofs: &[serde_json::Value]) -> Result<(), ZkError> {
    for (i, proof_value) in proofs.iter().enumerate() {
        let proof = zk_proof_from_value(proof_value)?;
        let valid = verify_zk_proof(&proof)?;
        if !valid {
            return Err(ZkError::VerificationFailed(format!(
                "ZK proof {} ({:?}) verification failed",
                i, proof.proof_type
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
    chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .map_err(|e| ProofSystemError::InvalidProof(format!("Invalid date format: {}", e)))
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
pub fn generate_predicate_proof(
    pred: &PredicateRequest,
    attr_value: &serde_json::Value,
    leaf_hash_hex: &str,
) -> Result<ZkProof, ProofSystemError> {
    let mut proof = match (&*pred.attribute, &pred.op) {
        ("dateOfBirth", PredicateOp::GreaterOrEqual) => {
            let threshold = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("age threshold must be a number".into()))?;
            let dob = parse_date_of_birth(attr_value)?;
            let age = compute_age(dob);
            prove_age_range(age, threshold)
                .map_err(|e| ProofSystemError::InvalidProof(format!("ZK age proof failed: {}", e)))?
        }
        ("nationality", PredicateOp::InSet) => {
            let nat = attr_value
                .as_str()
                .ok_or_else(|| ProofSystemError::InvalidProof("nationality must be a string".into()))?;
            let allowed = pred
                .value
                .as_array()
                .ok_or_else(|| ProofSystemError::InvalidProof("InSet value must be an array".into()))?
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>();
            prove_nationality(nat, &allowed)
                .map_err(|e| ProofSystemError::InvalidProof(format!("ZK nationality proof failed: {}", e)))?
        }
        ("verificationLevel", PredicateOp::GreaterOrEqual) => {
            let level = verification_level_to_u64(attr_value)?;
            let required = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("required level must be a number".into()))?;
            prove_kyc_status(level, required)
                .map_err(|e| ProofSystemError::InvalidProof(format!("ZK KYC proof failed: {}", e)))?
        }
        ("isResident", PredicateOp::GreaterOrEqual) => {
            let is_resident = attr_value.as_bool().unwrap_or(false);
            let value: u64 = if is_resident { 1 } else { 0 };
            let threshold = pred
                .value
                .as_u64()
                .ok_or_else(|| ProofSystemError::InvalidProof("isResident threshold must be a number".into()))?;
            prove_kyc_status(value, threshold)
                .map_err(|e| ProofSystemError::InvalidProof(format!("ZK isResident proof failed: {}", e)))?
        }
        (attr, op) => {
            return Err(ProofSystemError::InvalidProof(format!(
                "Unsupported predicate: attribute='{}', op={:?}",
                attr, op
            )));
        }
    };

    proof.bound_attribute = Some(pred.attribute.clone());
    proof.attribute_leaf_hash = Some(leaf_hash_hex.to_string());

    Ok(proof)
}
