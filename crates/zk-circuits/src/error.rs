//! ZK circuit error types

use thiserror::Error;

#[derive(Error, Debug)]
pub enum ZkError {
    #[error("Proof generation failed: {0}")]
    ProofGenerationFailed(String),

    #[error("Proof verification failed: {0}")]
    VerificationFailed(String),

    #[error("Invalid circuit input: {0}")]
    InvalidInput(String),

    /// Witness does not satisfy the predicate.
    /// MUST NOT carry the witness value or any value derived from it — this
    /// error crosses the FFI/network boundary and would defeat zero-knowledge.
    #[error("predicate not satisfied")]
    PreconditionFailed,

    #[error("Setup failed: {0}")]
    SetupFailed(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),
}
