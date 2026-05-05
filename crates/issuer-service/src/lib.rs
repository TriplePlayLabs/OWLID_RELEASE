//! OwlID Issuer Service
//!
//! This crate provides identity verification and credential issuance for OwlID.
//! It includes mock identity providers for testing and abstractions for real
//! providers like DigiD (Netherlands), BankID (Sweden), Onfido, and more.
//!
//! ## What This Is
//!
//! The Issuer Service combines identity verification with credential issuance.
//! It connects to identity providers to verify user attributes and then issues
//! cryptographic credentials (ProofDocuments) that users can selectively disclose.
//!
//! ## Provider Flow Types
//!
//! Different providers use different verification flows:
//!
//! - **SamlRedirect**: Government eID (DigiD, eIDAS) - redirect + SAML assertion
//! - **QrPolling**: Bank eID (BankID) - QR code + polling
//! - **WebhookAsync**: KYC providers (Onfido, Jumio) - redirect + webhook
//! - **FormBased**: Mock/test providers - direct form submission
//!
//! ## Architecture
//!
//! ```text
//! User → Issuer Service (8001) → Verified Claims → ProofDocument → Verification (8000)
//! ```
//!
//! ## Usage
//!
//! ```rust,no_run
//! use owl_issuer_service::{IdpDatabase, ProviderRegistry};
//! use owl_issuer_service::mock_provider::MockDigiDProvider;
//! use std::sync::Arc;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! // Create database and registry
//! let db = Arc::new(IdpDatabase::new());
//! let mut registry = ProviderRegistry::new();
//!
//! // Register providers
//! registry.register(MockDigiDProvider::new(db.clone()));
//!
//! // Get a provider and start verification
//! let provider = registry.get("mock-digid").unwrap();
//! // let session = provider.start_verification(session_id).await?;
//! # Ok(())
//! # }
//! ```

pub mod credential_bridge;
pub mod database;
pub mod db;
pub mod error;
pub mod issuance;
pub mod mock_provider;
pub mod models;
pub mod normalizer;
pub mod oidc;
pub mod polling;
pub mod provider;
pub mod webhooks;

// Re-export main types
pub use credential_bridge::{BridgeConfig, CredentialBridge};
pub use issuance::issue_credential_direct;
pub use database::IdpDatabase;
pub use error::{IdpError, PendingDetails, Result, VerificationWarning};
pub use mock_provider::{MockBankIdProvider, MockDigiDProvider, MockProvider, MockProviderFactory};
pub use models::{is_eu_citizen, is_over_age};
pub use models::{
    FlowState, IdentitySubmissionForm, ProviderInfo, SessionStatus, VerificationLevel,
    VerificationSession, VerifiedIdentityClaims,
};
pub use normalizer::RawProviderClaims;
pub use provider::{
    DiditConfig, DiditProvider, DigitalIdentityProvider, FormConfig, FormField, FormFieldType,
    PollResult, ProviderFlowType, ProviderInfoExtended, ProviderRegistry, VerificationStart,
    WebhookPayload,
};
pub use normalizer::DiditVerificationData;
pub use owl_crypto::SignatureAlgorithm;
