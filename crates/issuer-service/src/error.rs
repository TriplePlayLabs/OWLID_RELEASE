//! Error types for the Identity Provider crate

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Details about why verification is pending (e.g., manual review)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingDetails {
    /// Human-readable status message
    pub message: String,
    /// Current status from the provider (e.g., "In Review", "Pending")
    pub provider_status: String,
    /// List of warnings/reasons for manual review
    pub warnings: Vec<VerificationWarning>,
    /// Suggested retry delay in seconds (for exponential backoff)
    pub retry_after_secs: u32,
}

/// A warning from the verification provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationWarning {
    /// Warning category (e.g., "POSSIBLE_DUPLICATED_USER")
    pub code: String,
    /// Short description
    pub short_description: String,
    /// Detailed description
    pub long_description: Option<String>,
    /// Risk level (e.g., "LOW", "MEDIUM", "HIGH")
    pub risk: Option<String>,
}

/// Errors that can occur during identity provider operations
#[derive(Error, Debug)]
pub enum IdpError {
    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Session expired")]
    SessionExpired,

    #[error("Session already verified")]
    SessionAlreadyVerified,

    #[error("Session in invalid state: expected {expected}, got {actual}")]
    InvalidSessionState { expected: String, actual: String },

    #[error("Verification failed: {0}")]
    VerificationFailed(String),

    #[error("Missing required field: {0}")]
    MissingField(String),

    #[error("Invalid field value: {field} - {reason}")]
    InvalidField { field: String, reason: String },

    #[error("Provider not found: {0}")]
    ProviderNotFound(String),

    #[error("Credential issuance failed: {0}")]
    CredentialIssuance(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Verification pending: {0}")]
    VerificationPending(String),

    #[error("Verification pending review: {}", .0.message)]
    VerificationPendingWithDetails(PendingDetails),
}

impl From<serde_json::Error> for IdpError {
    fn from(e: serde_json::Error) -> Self {
        IdpError::Serialization(e.to_string())
    }
}

/// Result type for identity provider operations
pub type Result<T> = std::result::Result<T, IdpError>;
