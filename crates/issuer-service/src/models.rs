//! Data models for the Mock Identity Provider
//!
//! These models represent what a real government eID system (like DigiD)
//! or bank identity provider would provide.

use crate::provider::ProviderFlowType;
use chrono::{DateTime, NaiveDate, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 32-byte URL-safe random token used as a per-session bearer.
fn random_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Verification session - tracks user through IdP flow
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationSession {
    pub id: Uuid,
    /// Provider identifier (e.g., "mock-digid", "mock-bankid")
    pub provider_id: String,
    /// The type of verification flow
    pub flow_type: ProviderFlowType,
    pub status: SessionStatus,
    /// Flow-specific state data
    pub flow_state: FlowState,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// When verification completed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<DateTime<Utc>>,
    /// Raw claims from provider (before normalization)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_claims: Option<serde_json::Value>,
    /// Whether a credential has been issued for this session
    #[serde(default)]
    pub credential_issued: bool,
    /// Per-session bearer token. Issued at session create time and required
    /// on every session-scoped request. Skipped from serialization so it is
    /// only ever returned in the original create response.
    #[serde(skip_serializing, default)]
    pub session_token: String,
}

impl VerificationSession {
    /// Create a new verification session
    pub fn new(provider_id: impl Into<String>, flow_type: ProviderFlowType) -> Self {
        let now = Utc::now();
        let flow_state = match flow_type {
            ProviderFlowType::SamlRedirect => FlowState::SamlPending {
                relay_state: Uuid::new_v4().to_string(),
            },
            ProviderFlowType::QrPolling => FlowState::PollingPending,
            ProviderFlowType::WebhookAsync => FlowState::WebhookPending {
                external_session_id: None,
            },
            ProviderFlowType::FormBased => FlowState::FormPending,
            ProviderFlowType::OidcRedirect => FlowState::OidcPending {
                state: Uuid::new_v4().to_string(),
            },
        };

        Self {
            id: Uuid::new_v4(),
            provider_id: provider_id.into(),
            flow_type,
            status: SessionStatus::Pending,
            flow_state,
            created_at: now,
            expires_at: now + chrono::Duration::minutes(30),
            verified_at: None,
            raw_claims: None,
            credential_issued: false,
            session_token: random_session_token(),
        }
    }

    /// Create a legacy-style session (for backwards compatibility)
    pub fn new_legacy(provider_id: impl Into<String>) -> Self {
        Self::new(provider_id, ProviderFlowType::FormBased)
    }

    /// Check if the session has expired
    pub fn is_expired(&self) -> bool {
        Utc::now() > self.expires_at
    }

    /// Update the flow state
    pub fn set_flow_state(&mut self, state: FlowState) {
        self.flow_state = state;
    }

    /// Mark session as verified
    pub fn mark_verified(&mut self) {
        self.status = SessionStatus::Verified;
        self.verified_at = Some(Utc::now());
        self.flow_state = FlowState::Completed;
    }

    /// Mark session as failed
    pub fn mark_failed(&mut self, reason: String) {
        self.status = SessionStatus::Failed;
        self.flow_state = FlowState::Failed { reason };
    }
}

/// Flow-specific state for verification sessions
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FlowState {
    /// SAML redirect: waiting for assertion callback
    #[serde(rename_all = "camelCase")]
    SamlPending {
        /// Relay state to include in SAML request
        relay_state: String,
    },

    /// SAML redirect: received callback, processing
    #[serde(rename_all = "camelCase")]
    SamlProcessing { relay_state: String },

    /// Polling: initial state, waiting for order to be created
    PollingPending,

    /// Polling: order created, waiting for user to complete
    #[serde(rename_all = "camelCase")]
    Polling {
        /// Reference for polling the status
        order_ref: String,
        /// Number of times we've polled
        poll_count: u32,
        /// Last poll timestamp
        last_poll: DateTime<Utc>,
    },

    /// Webhook: waiting for external session to be created
    #[serde(rename_all = "camelCase")]
    WebhookPending {
        /// External session/applicant ID (set after redirect)
        external_session_id: Option<String>,
    },

    /// Webhook: user redirected, waiting for callback
    #[serde(rename_all = "camelCase")]
    WebhookWaiting { external_session_id: String },

    /// OIDC redirect: waiting for authorization-code callback. The
    /// `state` value is the CSRF parameter the provider echoes back.
    #[serde(rename_all = "camelCase")]
    OidcPending { state: String },

    /// OIDC redirect: callback received, exchanging code + verifying
    /// the ID token against the provider JWKS.
    #[serde(rename_all = "camelCase")]
    OidcProcessing { state: String },

    /// Form: waiting for user to submit form
    FormPending,

    /// Form: processing submission
    FormProcessing,

    /// Verification completed successfully
    Completed,

    /// Verification failed
    #[serde(rename_all = "camelCase")]
    Failed { reason: String },
}

/// Session status in the verification flow
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Waiting for identity submission
    Pending,
    /// Processing verification
    Verifying,
    /// Successfully verified
    Verified,
    /// Verification failed
    Failed,
    /// Session timed out
    Expired,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Verifying => "verifying",
            Self::Verified => "verified",
            Self::Failed => "failed",
            Self::Expired => "expired",
        }
    }
}

/// Verified identity claims from the IdP
///
/// This represents what a real IdP like DigiD or BankID would return
/// after verifying a user's identity against government databases.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedIdentityClaims {
    // === Core Identity ===
    pub first_name: String,
    pub last_name: String,
    pub date_of_birth: NaiveDate,
    pub place_of_birth: String,
    pub nationality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,

    // === Government IDs ===
    /// National ID number (BSN, SSN, etc.)
    pub national_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passport_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drivers_license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tax_id: Option<String>,

    // === Document Information ===
    /// Type of document used for verification (Passport, ID Card, Driver's License)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_type: Option<String>,
    /// Document number (generic - may be passport, ID, or driver's license)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_number: Option<String>,
    /// Country that issued the document (ISO 3166-1 alpha-2)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuing_country: Option<String>,
    /// Document expiration date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_expiry: Option<NaiveDate>,
    /// Document issue date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_issue_date: Option<NaiveDate>,

    // === Biometric Data (NOT included in credential) ===
    /// Portrait image from document/selfie (base64)
    /// Returned in API response but excluded from the issued SD-JWT VC for privacy
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portrait_image: Option<String>,

    // === Address ===
    pub street_address: String,
    pub city: String,
    pub postal_code: String,
    pub country: String,

    // === Account-level identifiers (OIDC providers) ===
    /// Email address. Present for OIDC providers (Google, etc.) that
    /// expose it; absent for document-only providers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// Provider-attested `email_verified` flag — drives the
    /// `email:verified` predicate via Midnight `attestEmailVerified`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
    /// Display name (Google `name`, Apple full name). Set by OIDC
    /// providers that expose the user's display name separately from
    /// first/last.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Profile picture URL. Google `picture` claim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    /// BCP-47 locale tag. Google `locale` claim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    /// Workspace hosted-domain (Google Workspace `hd`). Distinguishes
    /// consumer accounts from corporate-SSO accounts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hosted_domain: Option<String>,

    // === Derived Attributes (pre-computed by IdP) ===
    /// Boolean proofs derived from the raw data - the key privacy feature
    pub is_over_18: bool,
    pub is_over_21: bool,
    pub is_over_65: bool,
    pub is_eu_citizen: bool,
    pub is_resident: bool,
    /// ISO 3166-1 alpha-2 residence country, set iff the provider
    /// returned a geo-verified address. Drives the per-country residency
    /// attestation (`attestResidencyIn`). `None` ⇒ no residency stamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resident_country: Option<String>,

    // === Verification Metadata ===
    pub verified_at: DateTime<Utc>,
    pub verification_level: VerificationLevel,
    pub provider_id: String,
    /// Method used for verification (e.g., "document_scan", "bank_login", "in_person")
    pub verification_method: String,
}

/// Verification assurance levels per eIDAS regulation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VerificationLevel {
    /// Self-asserted, email verified only
    Low,
    /// Document verified remotely
    Substantial,
    /// In-person or strong multi-factor verification
    High,
}

impl VerificationLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Substantial => "substantial",
            Self::High => "high",
        }
    }
}

/// Form submitted by user during identity verification
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IdentitySubmissionForm {
    pub first_name: String,
    pub last_name: String,
    pub date_of_birth: NaiveDate,
    pub place_of_birth: String,
    pub nationality: String,
    pub national_id: String,
    pub street_address: String,
    pub city: String,
    pub postal_code: String,
    pub country: String,

    // Optional fields
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passport_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drivers_license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tax_id: Option<String>,
}

/// Static, intrinsic facts about an identity provider, returned by the
/// provider's trait impl. Composed with runtime fields (flow type,
/// verification level, enabled flag) at registry-list time into the
/// public `ProviderInfo` type exposed over OpenAPI.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub verification_levels: Vec<VerificationLevel>,
    pub country: String,
}

/// EU countries for citizenship checks
/// Includes ISO 3166-1 alpha-2, alpha-3 codes, country names, and demonyms
pub const EU_COUNTRIES: &[&str] = &[
    // ISO 3166-1 alpha-2 codes
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
    // ISO 3166-1 alpha-3 codes
    "AUT",
    "BEL",
    "BGR",
    "HRV",
    "CYP",
    "CZE",
    "DNK",
    "EST",
    "FIN",
    "FRA",
    "DEU",
    "GRC",
    "HUN",
    "IRL",
    "ITA",
    "LVA",
    "LTU",
    "LUX",
    "MLT",
    "NLD",
    "POL",
    "PRT",
    "ROU",
    "SVK",
    "SVN",
    "ESP",
    "SWE",
    // Country names
    "Austria",
    "Belgium",
    "Bulgaria",
    "Croatia",
    "Cyprus",
    "Czech Republic",
    "Denmark",
    "Estonia",
    "Finland",
    "France",
    "Germany",
    "Greece",
    "Hungary",
    "Ireland",
    "Italy",
    "Latvia",
    "Lithuania",
    "Luxembourg",
    "Malta",
    "Netherlands",
    "Poland",
    "Portugal",
    "Romania",
    "Slovakia",
    "Slovenia",
    "Spain",
    "Sweden",
    // Demonyms
    "Dutch",
    "German",
    "French",
    "Italian",
    "Spanish",
    "Belgian",
    "Austrian",
    "Polish",
    "Swedish",
    "Danish",
    "Finnish",
    "Greek",
    "Portuguese",
    "Irish",
    "Czech",
    "Hungarian",
    "Romanian",
    "Bulgarian",
    "Croatian",
    "Slovak",
    "Slovenian",
    "Estonian",
    "Latvian",
    "Lithuanian",
    "Cypriot",
    "Maltese",
    "Luxembourgish",
];

/// Helper function to check if someone is over a certain age
pub fn is_over_age(date_of_birth: NaiveDate, min_age: u32) -> bool {
    let today = Utc::now().date_naive();
    let age = today.years_since(date_of_birth).unwrap_or(0);
    age >= min_age
}

/// Helper function to check EU citizenship
pub fn is_eu_citizen(nationality: &str) -> bool {
    EU_COUNTRIES
        .iter()
        .any(|&c| c.eq_ignore_ascii_case(nationality))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_over_age() {
        let today = Utc::now().date_naive();
        let dob_30_years_ago = today - chrono::Duration::days(30 * 365 + 8); // ~30 years

        assert!(is_over_age(dob_30_years_ago, 18));
        assert!(is_over_age(dob_30_years_ago, 21));
        assert!(!is_over_age(dob_30_years_ago, 35));
    }

    #[test]
    fn test_is_eu_citizen() {
        assert!(is_eu_citizen("Dutch"));
        assert!(is_eu_citizen("dutch")); // case insensitive
        assert!(is_eu_citizen("Netherlands"));
        assert!(is_eu_citizen("Germany"));
        assert!(!is_eu_citizen("American"));
        assert!(!is_eu_citizen("Canadian"));
    }

    #[test]
    fn test_session_creation() {
        use crate::provider::ProviderFlowType;
        let session = VerificationSession::new("mock-digid", ProviderFlowType::FormBased);
        assert_eq!(session.status, SessionStatus::Pending);
        assert!(!session.is_expired());
    }
}
