//! Digital Identity Provider trait and associated types
//!
//! This module defines the core abstraction for identity verification providers.

use crate::error::Result;
use crate::models::{ProviderDescriptor, VerificationLevel};
use crate::normalizer::RawProviderClaims;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The type of verification flow used by an identity provider
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFlowType {
    /// Redirect → SAML assertion (DigiD, eIDAS)
    ///
    /// Flow: User redirected to provider → authenticates → SAML assertion returned
    SamlRedirect,

    /// QR code → polling (BankID)
    ///
    /// Flow: Show QR code → user scans with mobile app → poll for completion
    QrPolling,

    /// Redirect → webhook (Onfido, Jumio, Stripe Identity)
    ///
    /// Flow: Redirect to hosted UI → user uploads docs → webhook notification
    WebhookAsync,

    /// Form submission (Mock providers, testing)
    ///
    /// Flow: User submits form → immediate verification
    FormBased,

    /// Redirect → OIDC authorization-code callback (Google, Microsoft,
    /// generic OpenID Connect providers).
    ///
    /// Flow: User redirected to provider's `authorization_endpoint` →
    /// authenticates → provider redirects back to `/auth/callback/{provider}`
    /// with `?code=...&state=...`. Handler exchanges code for tokens,
    /// verifies the ID token against the provider's JWKS, returns claims.
    OidcRedirect,
}

impl ProviderFlowType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SamlRedirect => "saml_redirect",
            Self::QrPolling => "qr_polling",
            Self::WebhookAsync => "webhook_async",
            Self::FormBased => "form_based",
            Self::OidcRedirect => "oidc_redirect",
        }
    }
}

/// Result of starting a verification session
///
/// Different flow types return different data to the frontend
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum VerificationStart {
    /// Redirect user to this URL (SAML/OAuth providers)
    #[serde(rename_all = "camelCase")]
    Redirect {
        url: String,
        /// Optional: relay state to include in callback
        relay_state: Option<String>,
    },

    /// Show QR code, poll this order (BankID-style)
    #[serde(rename_all = "camelCase")]
    QrCode {
        /// Data to encode in QR code (user scans with mobile app)
        qr_data: String,
        /// Reference for polling the order status
        order_ref: String,
        /// URL for user's mobile app to open directly (optional)
        auto_start_url: Option<String>,
    },

    /// Redirect to hosted UI, wait for webhook (Onfido, Jumio)
    #[serde(rename_all = "camelCase")]
    HostedUi {
        url: String,
        /// External session/applicant ID from the provider
        external_session_id: String,
    },

    /// Show form to user (mock/test providers)
    #[serde(rename_all = "camelCase")]
    Form {
        /// Configuration for the form fields
        config: FormConfig,
    },
}

/// Configuration for form-based verification
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FormConfig {
    /// Fields to display in the form
    pub fields: Vec<FormField>,
    /// Provider-specific instructions
    pub instructions: Option<String>,
}

impl Default for FormConfig {
    fn default() -> Self {
        Self {
            fields: vec![
                FormField::new("firstName", "First Name", FormFieldType::Text, true),
                FormField::new("lastName", "Last Name", FormFieldType::Text, true),
                FormField::new("dateOfBirth", "Date of Birth", FormFieldType::Date, true),
                FormField::new("placeOfBirth", "Place of Birth", FormFieldType::Text, true),
                FormField::new("nationality", "Nationality", FormFieldType::Text, true),
                FormField::new("nationalId", "National ID", FormFieldType::Text, true),
                FormField::new("streetAddress", "Street Address", FormFieldType::Text, true),
                FormField::new("city", "City", FormFieldType::Text, true),
                FormField::new("postalCode", "Postal Code", FormFieldType::Text, true),
                FormField::new("country", "Country", FormFieldType::Text, true),
                FormField::new("gender", "Gender", FormFieldType::Text, false),
                FormField::new(
                    "passportNumber",
                    "Passport Number",
                    FormFieldType::Text,
                    false,
                ),
                FormField::new(
                    "driversLicense",
                    "Driver's License",
                    FormFieldType::Text,
                    false,
                ),
                FormField::new("taxId", "Tax ID", FormFieldType::Text, false),
            ],
            instructions: None,
        }
    }
}

/// A field in a verification form
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub name: String,
    pub label: String,
    pub field_type: FormFieldType,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_pattern: Option<String>,
}

impl FormField {
    pub fn new(name: &str, label: &str, field_type: FormFieldType, required: bool) -> Self {
        Self {
            name: name.to_string(),
            label: label.to_string(),
            field_type,
            required,
            placeholder: None,
            validation_pattern: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FormFieldType {
    Text,
    Date,
    Select,
    Number,
}

/// Result of polling a verification session
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PollResult {
    /// Verification is still pending
    Pending {
        /// Human-readable status message
        message: String,
        /// Hint text to show user (e.g., "Open your BankID app")
        hint: Option<String>,
    },

    /// User started but hasn't completed (e.g., app opened)
    UserInteracting { message: String },

    /// Verification completed successfully
    Complete(RawProviderClaims),

    /// Verification failed
    Failed {
        reason: String,
        /// Error code from provider (if available)
        error_code: Option<String>,
    },

    /// Session expired or cancelled
    Expired,
}

/// Webhook payload from external providers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookPayload {
    /// Raw JSON body from the webhook
    pub body: serde_json::Value,
    /// Headers that might contain signatures
    pub headers: std::collections::HashMap<String, String>,
    /// Provider identifier
    pub provider_id: String,
}

/// Core trait for digital identity providers
///
/// Implement this trait to add support for a new identity provider.
#[async_trait]
pub trait DigitalIdentityProvider: Send + Sync {
    /// Unique identifier for this provider (e.g., "digid", "bankid", "onfido")
    fn provider_id(&self) -> &str;

    /// The type of verification flow this provider uses
    fn provider_type(&self) -> ProviderFlowType;

    /// Provider metadata for listing/display
    fn info(&self) -> ProviderDescriptor;

    /// The assurance level of verification this provider offers
    fn verification_level(&self) -> VerificationLevel;

    /// Start a new verification session
    ///
    /// Returns flow-specific data for the frontend to handle
    async fn start_verification(&self, session_id: Uuid) -> Result<VerificationStart>;

    /// Handle SAML assertion callback (for SamlRedirect providers)
    ///
    /// # Arguments
    /// * `session_id` - The session ID from the relay state
    /// * `saml_response` - The base64-encoded SAML response
    async fn handle_saml_callback(
        &self,
        _session_id: Uuid,
        _saml_response: &str,
    ) -> Result<RawProviderClaims> {
        Err(crate::error::IdpError::Internal(
            "SAML callback not supported by this provider".to_string(),
        ))
    }

    /// Poll for verification status (for QrPolling providers)
    ///
    /// # Arguments
    /// * `session_id` - The session ID
    /// * `order_ref` - The order reference from VerificationStart::QrCode
    async fn poll_status(&self, _session_id: Uuid, _order_ref: &str) -> Result<PollResult> {
        Err(crate::error::IdpError::Internal(
            "Polling not supported by this provider".to_string(),
        ))
    }

    /// Handle webhook notification (for WebhookAsync providers)
    ///
    /// # Arguments
    /// * `payload` - The webhook payload including body and headers
    async fn handle_webhook(&self, _payload: &WebhookPayload) -> Result<RawProviderClaims> {
        Err(crate::error::IdpError::Internal(
            "Webhook not supported by this provider".to_string(),
        ))
    }

    /// Handle form submission (for FormBased providers)
    ///
    /// # Arguments
    /// * `session_id` - The session ID
    /// * `form_data` - The submitted form data as JSON
    async fn handle_form_submission(
        &self,
        _session_id: Uuid,
        _form_data: serde_json::Value,
    ) -> Result<RawProviderClaims> {
        Err(crate::error::IdpError::Internal(
            "Form submission not supported by this provider".to_string(),
        ))
    }

    /// Handle OIDC authorization-code callback (for OidcRedirect providers).
    ///
    /// # Arguments
    /// * `session_id` - The session ID resolved from the `state` parameter
    /// * `code`       - The authorization code returned by the provider
    /// * `state`      - The opaque `state` parameter (caller may have
    ///                  already verified it; passed through for providers
    ///                  that need it during token exchange)
    async fn handle_oidc_callback(
        &self,
        _session_id: Uuid,
        _code: &str,
        _state: &str,
    ) -> Result<RawProviderClaims> {
        Err(crate::error::IdpError::Internal(
            "OIDC callback not supported by this provider".to_string(),
        ))
    }

    /// Get verification result by polling the provider's decision endpoint
    /// (for WebhookAsync providers when webhook hasn't been processed yet)
    ///
    /// # Arguments
    /// * `external_session_id` - The provider's session/applicant ID
    ///
    /// # Returns
    /// * `Ok(RawProviderClaims)` - Verification complete, claims returned
    /// * `Err(IdpError::VerificationPending)` - Still pending, poll again later
    /// * `Err(IdpError::VerificationFailed)` - Verification rejected
    async fn get_verification_result(
        &self,
        _external_session_id: &str,
    ) -> Result<RawProviderClaims> {
        Err(crate::error::IdpError::Internal(
            "Polling verification result not supported by this provider".to_string(),
        ))
    }
}

/// Public provider record exposed over OpenAPI (`GET /providers`).
///
/// Combines the static `ProviderDescriptor` from the trait with runtime
/// state — flow type, verification level, and the operator-controlled
/// `enabled` flag (toggled via `POST /admin/providers/{id}/{enable,disable}`
/// and persisted in the `provider_settings` table).
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    #[serde(flatten)]
    pub descriptor: ProviderDescriptor,
    pub flow_type: ProviderFlowType,
    pub verification_level: VerificationLevel,
    /// `false` if the operator has disabled this provider; consumers must
    /// not start a new verification session against it.
    pub enabled: bool,
}

impl ProviderInfo {
    /// Build from a registered provider. `enabled` is supplied by the
    /// registry, which owns the runtime disabled-set.
    pub fn from_provider(provider: &dyn DigitalIdentityProvider, enabled: bool) -> Self {
        Self {
            descriptor: provider.info(),
            flow_type: provider.provider_type(),
            verification_level: provider.verification_level(),
            enabled,
        }
    }
}
