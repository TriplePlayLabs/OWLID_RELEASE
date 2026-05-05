use thiserror::Error;

#[derive(Error, Debug)]
pub enum ProofSystemError {
    #[error("Signature error: {0}")]
    SignatureError(#[from] owl_crypto::signature::SignatureError),

    #[error("Missing required attribute: {0}")]
    MissingAttribute(String),

    #[error("Invalid proof: {0}")]
    InvalidProof(String),

    /// Holder's credential value does not satisfy the requested predicate.
    /// `attribute` is the credential field name (already known to the
    /// verifier — they asked about it). NEVER carry the witness value or any
    /// derivative; this error crosses FFI and may be relayed to the verifier.
    #[error("predicate not satisfied")]
    PredicateNotSatisfied {
        attribute: String,
        predicate_id: Option<String>,
    },

    #[error("Token expired")]
    TokenExpired,

    #[error("Token not yet active")]
    TokenNotActive,

    #[error("Challenge mismatch")]
    ChallengeMismatch,

    #[error("Untrusted issuer: {0}")]
    UntrustedIssuer(String),

    #[error("Credential revoked: {0}")]
    CredentialRevoked(String),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("WebAuthn error: {0}")]
    WebAuthnError(#[from] owl_crypto::WebAuthnError),

    #[error("Schema validation error: {0}")]
    SchemaValidation(String),
}
