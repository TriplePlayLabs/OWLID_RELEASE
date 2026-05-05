pub mod compact;
pub mod document;
pub mod error;
pub mod predicates;
pub mod revocation;
pub mod schema;
pub mod token;
pub mod zk;

pub use document::{Document, ProofDocument};
pub use error::ProofSystemError;
pub use revocation::{RevocationEntry, RevocationRegistry, RevocationStatus};
pub use schema::{AttributeType, CredentialSchema};
pub use token::{OwnerSignature, PredicateOp, PredicateRequest, PreparedToken, ProofRequest, Token, TokenPayload};
pub use predicates::{Predicate, PredicateParams};
pub use zk::{
    evaluate_predicate, generate_predicate_proof, resolve_proof_predicate, verify_zk_proof,
    verify_zk_proof_pinned,
};
