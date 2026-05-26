//! Provider abstraction layer for Digital Identity Providers
//!
//! This module defines the trait and types for integrating with various
//! digital identity providers (DigiD, BankID, Onfido, etc.) through a
//! unified interface.
//!
//! ## Provider Flow Types
//!
//! Different identity providers use different verification flows:
//!
//! - **SamlRedirect**: Government eID (DigiD, eIDAS) - redirect + SAML assertion
//! - **QrPolling**: Bank eID (BankID) - QR code + polling
//! - **WebhookAsync**: KYC providers (Onfido, Jumio, Didit) - redirect + webhook
//! - **FormBased**: Mock/test providers - direct form submission
//! - **OidcRedirect**: OpenID Connect providers (Google, Microsoft, Apple) - redirect + callback

mod didit;
mod oidc_provider;
mod registry;
mod traits;

pub use didit::{DiditConfig, DiditProvider};
pub use oidc_provider::OidcProvider;
pub use registry::ProviderRegistry;
pub use traits::*;
