//! ZK proof types and serialization

use serde::{Deserialize, Serialize};

/// Types of ZK proofs supported
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ZkProofType {
    /// Prove age >= threshold
    AgeRange,
    /// Prove nationality is in allowed set
    Nationality,
    /// Prove KYC level >= threshold
    KycStatus,
}

/// A serialized ZK proof that can be included in tokens.
///
/// Verification keys are never stored in proofs — the verifier looks up
/// the correct key by `proof_type` via `get_pvk()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZkProof {
    /// Type of predicate this proof covers
    pub proof_type: ZkProofType,
    /// Serialized Groth16 proof bytes (hex-encoded)
    pub proof_bytes: String,
    /// Public inputs (hex-encoded field elements)
    pub public_inputs: Vec<String>,
    /// Credential attribute this proof covers (e.g., "dateOfBirth")
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bound_attribute: Option<String>,
    /// Leaf hash of the bound attribute in the credential's Merkle tree (hex).
    /// During verification, this is checked against the Merkle proof leaves.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub attribute_leaf_hash: Option<String>,
}
