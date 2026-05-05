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

    #[error("Setup failed: {0}")]
    SetupFailed(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),
}
