// Intentional `+`-connector prose in doc comments trips clippy's markdown
// list heuristic; the lint is cosmetic (rustdoc rendering only).
#![allow(clippy::doc_lazy_continuation)]

pub mod attestation;
pub mod datasets;
pub mod error;
pub mod predicate_attestation;
pub mod predicate_routing;
pub mod predicates;
pub mod revocation;
pub mod schema;
pub mod sd_jwt;
pub mod status_list;

pub use error::ProofSystemError;
pub use predicate_attestation::PredicateAttestation;
pub use predicates::{Predicate, PredicateOp, PredicateParams};
pub use revocation::{RevocationEntry, RevocationRegistry, RevocationStatus};
pub use schema::{AttributeType, CredentialSchema};
