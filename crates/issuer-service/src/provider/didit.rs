//! Didit KYC Identity Provider
//!
//! Didit is a decentralized identity verification provider that uses
//! document verification and liveness detection to verify user identity.
//!
//! ## Flow (WebhookAsync)
//!
//! 1. Create session: POST to Didit API creates verification session
//! 2. Redirect user: User is redirected to Didit's hosted verification UI
//! 3. Verification: User uploads documents, completes liveness check
//! 4. Webhook/Poll: Didit sends webhook OR frontend polls for results
//! 5. Claims: Provider returns verified identity claims
//!
//! ## API Documentation
//!
//! - Create Session: POST {base_url}/v3/session/
//! - Get Decision: GET {base_url}/v3/session/{session_id}/decision/

use crate::error::{IdpError, PendingDetails, Result, VerificationWarning};
use crate::models::{ProviderDescriptor, VerificationLevel};
use crate::normalizer::RawProviderClaims;
use crate::provider::{
    DigitalIdentityProvider, ProviderFlowType, VerificationStart, WebhookPayload,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Configuration for Didit provider
#[derive(Debug, Clone)]
pub struct DiditConfig {
    /// API key for authentication
    pub api_key: String,
    /// Workflow ID for the verification flow
    pub workflow_id: String,
    /// Base URL for Didit API
    pub base_url: String,
    /// Optional webhook secret for signature verification
    pub webhook_secret: Option<String>,
    /// App URL for callback redirects
    pub app_url: String,
}

impl DiditConfig {
    /// Create configuration from environment variables
    ///
    /// Required:
    /// - DIDIT_API_KEY
    /// - DIDIT_WORKFLOW_ID
    /// - APP_URL
    ///
    /// Optional:
    /// - DIDIT_BASE_URL (default: https://verification.didit.me)
    /// - DIDIT_WEBHOOK_SECRET
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("DIDIT_API_KEY")
            .map_err(|_| IdpError::Configuration("DIDIT_API_KEY not set".to_string()))?;

        let workflow_id = std::env::var("DIDIT_WORKFLOW_ID")
            .map_err(|_| IdpError::Configuration("DIDIT_WORKFLOW_ID not set".to_string()))?;

        let app_url = std::env::var("APP_URL")
            .map_err(|_| IdpError::Configuration("APP_URL not set".to_string()))?;

        let base_url = std::env::var("DIDIT_BASE_URL")
            .unwrap_or_else(|_| "https://verification.didit.me".to_string());

        let webhook_secret = std::env::var("DIDIT_WEBHOOK_SECRET").ok();

        Ok(Self {
            api_key,
            workflow_id,
            base_url,
            webhook_secret,
            app_url,
        })
    }
}

/// Didit KYC Provider
///
/// Implements the DigitalIdentityProvider trait for Didit verification.
/// Uses WebhookAsync flow type.
pub struct DiditProvider {
    config: DiditConfig,
    http_client: reqwest::Client,
}

impl DiditProvider {
    /// Create a new Didit provider with the given configuration
    pub fn new(config: DiditConfig) -> Self {
        Self {
            config,
            http_client: reqwest::Client::new(),
        }
    }

    /// Create session with Didit API
    async fn create_didit_session(&self, session_id: Uuid) -> Result<DiditSessionResponse> {
        let callback_url = format!(
            "{}/callback?session={}",
            self.config.app_url, session_id
        );

        let request_body = DiditCreateSessionRequest {
            workflow_id: self.config.workflow_id.clone(),
            callback: Some(callback_url),
        };

        debug!("Creating Didit session for internal session {}", session_id);

        let response = self
            .http_client
            .post(format!("{}/v3/session/", self.config.base_url))
            .header("x-api-key", &self.config.api_key)
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await
            .map_err(|e| IdpError::Network(format!("Failed to create Didit session: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(IdpError::VerificationFailed(format!(
                "Didit API error ({}): {}",
                status, body
            )));
        }

        let didit_response: DiditSessionResponse = response
            .json()
            .await
            .map_err(|e| IdpError::Serialization(format!("Failed to parse Didit response: {}", e)))?;

        info!(
            "Created Didit session {} for internal session {}",
            didit_response.session_id, session_id
        );

        Ok(didit_response)
    }

    /// Get session decision from Didit API
    async fn get_session_decision(
        &self,
        didit_session_id: &str,
    ) -> Result<DiditDecisionResponse> {
        debug!("Fetching Didit decision for session {}", didit_session_id);

        let response = self
            .http_client
            .get(format!(
                "{}/v3/session/{}/decision/",
                self.config.base_url, didit_session_id
            ))
            .header("x-api-key", &self.config.api_key)
            .send()
            .await
            .map_err(|e| IdpError::Network(format!("Failed to get Didit decision: {}", e)))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(IdpError::VerificationFailed(format!(
                "Didit decision API error ({}): {}",
                status, body
            )));
        }

        let response_text = response
            .text()
            .await
            .map_err(|e| IdpError::Network(format!("Failed to read Didit response: {}", e)))?;

        debug!("Didit decision response: {}", response_text);

        let decision: DiditDecisionResponse = serde_json::from_str(&response_text)
            .map_err(|e| IdpError::Serialization(format!("Failed to parse Didit decision: {} - Response: {}", e, response_text)))?;

        let has_id_data = decision.id_verification.is_some()
            || decision.id_verifications.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
        debug!("Didit decision status: {}, id_verification present: {}", decision.status, has_id_data);

        Ok(decision)
    }

    /// Verify webhook signature (if webhook secret is configured)
    fn verify_webhook_signature(&self, payload: &WebhookPayload) -> Result<()> {
        let Some(ref secret) = self.config.webhook_secret else {
            // No secret configured, skip verification
            return Ok(());
        };

        // Didit uses x-signature header for HMAC-SHA256 signature
        let signature = payload
            .headers
            .get("x-signature")
            .or_else(|| payload.headers.get("X-Signature"))
            .ok_or_else(|| IdpError::VerificationFailed("Missing webhook signature".to_string()))?;

        // Compute expected signature
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        let payload_bytes = serde_json::to_vec(&payload.body)
            .map_err(|e| IdpError::Serialization(e.to_string()))?;

        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .map_err(|e| IdpError::Internal(format!("HMAC error: {}", e)))?;
        mac.update(&payload_bytes);

        let expected = hex::encode(mac.finalize().into_bytes());

        if signature != &expected {
            warn!("Webhook signature mismatch");
            return Err(IdpError::VerificationFailed(
                "Invalid webhook signature".to_string(),
            ));
        }

        Ok(())
    }

    /// Parse verification data from Didit decision response
    /// Handles both `id_verification` (singular) and `id_verifications` (array) responses
    /// Fetches portrait image URL and converts to base64 for local storage
    async fn parse_verification_data(
        &self,
        decision: &DiditDecisionResponse,
    ) -> Result<crate::normalizer::DiditVerificationData> {
        // Try id_verifications array first (current API), then id_verification (older API)
        let id_verification = decision
            .id_verifications
            .as_ref()
            .and_then(|arr| arr.first())
            .or(decision.id_verification.as_ref())
            .ok_or_else(|| {
                IdpError::VerificationFailed("No ID verification data in decision".to_string())
            })?;

        // Fetch portrait image and convert to base64 if URL is provided
        let portrait_base64 = if let Some(ref url) = id_verification.portrait_image {
            match self.fetch_portrait_as_base64(url).await {
                Ok(base64) => Some(base64),
                Err(e) => {
                    warn!("Failed to fetch portrait image: {}", e);
                    None
                }
            }
        } else {
            None
        };

        Ok(crate::normalizer::DiditVerificationData {
            first_name: id_verification.first_name.clone().unwrap_or_default(),
            last_name: id_verification.last_name.clone().unwrap_or_default(),
            full_name: id_verification.full_name.clone(),
            date_of_birth: id_verification.date_of_birth.clone().unwrap_or_default(),
            nationality: id_verification.nationality.clone().unwrap_or_default(),
            document_type: id_verification.document_type.clone().unwrap_or_default(),
            document_number: id_verification.document_number.clone().unwrap_or_default(),
            issuing_state: id_verification.issuing_state.clone().unwrap_or_default(),
            gender: id_verification.gender.clone(),
            expiration_date: id_verification.expiration_date.clone(),
            date_of_issue: id_verification.date_of_issue.clone(),
            portrait_image: portrait_base64,
        })
    }

    /// Fetch portrait image from URL and convert to base64 data URI
    async fn fetch_portrait_as_base64(&self, url: &str) -> Result<String> {
        use base64::{engine::general_purpose::STANDARD, Engine};

        debug!("Fetching portrait image from URL");

        let response = self
            .http_client
            .get(url)
            .send()
            .await
            .map_err(|e| IdpError::Network(format!("Failed to fetch portrait image: {}", e)))?;

        if !response.status().is_success() {
            return Err(IdpError::Network(format!(
                "Failed to fetch portrait image: HTTP {}",
                response.status()
            )));
        }

        // Determine content type from response headers
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();

        // Extract just the mime type (e.g., "image/jpeg" from "image/jpeg; charset=utf-8")
        let mime_type = content_type.split(';').next().unwrap_or("image/jpeg").trim();

        let bytes = response
            .bytes()
            .await
            .map_err(|e| IdpError::Network(format!("Failed to read portrait image bytes: {}", e)))?;

        let base64_data = STANDARD.encode(&bytes);

        debug!("Portrait image fetched: {} bytes, type: {}", bytes.len(), mime_type);

        Ok(format!("data:{};base64,{}", mime_type, base64_data))
    }
}

#[async_trait]
impl DigitalIdentityProvider for DiditProvider {
    fn provider_id(&self) -> &str {
        "didit"
    }

    fn provider_type(&self) -> ProviderFlowType {
        ProviderFlowType::WebhookAsync
    }

    fn info(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: "didit".to_string(),
            name: "Didit KYC".to_string(),
            description: "Decentralized identity verification with document and liveness checks"
                .to_string(),
            verification_levels: vec![VerificationLevel::High],
            country: "Global".to_string(),
        }
    }

    fn verification_level(&self) -> VerificationLevel {
        VerificationLevel::High
    }

    async fn start_verification(&self, session_id: Uuid) -> Result<VerificationStart> {
        let didit_session = self.create_didit_session(session_id).await?;

        Ok(VerificationStart::HostedUi {
            url: didit_session.url,
            external_session_id: didit_session.session_id,
        })
    }

    async fn handle_webhook(&self, payload: &WebhookPayload) -> Result<RawProviderClaims> {
        // Verify webhook signature if configured
        self.verify_webhook_signature(payload)?;

        // Parse the webhook body to get session ID
        let webhook_data: DiditWebhookPayload = serde_json::from_value(payload.body.clone())
            .map_err(|e| IdpError::Serialization(format!("Invalid webhook payload: {}", e)))?;

        info!(
            "Processing Didit webhook for session {}, status: {}",
            webhook_data.session_id, webhook_data.status
        );

        // Check if verification was approved
        if webhook_data.decision.as_deref() != Some("Approved") {
            let reason = webhook_data
                .decision
                .unwrap_or_else(|| "Unknown".to_string());
            return Err(IdpError::VerificationFailed(format!(
                "Didit verification not approved: {}",
                reason
            )));
        }

        // Fetch full decision data
        let decision = self.get_session_decision(&webhook_data.session_id).await?;

        // Parse verification data
        let verification_data = self.parse_verification_data(&decision).await?;

        Ok(RawProviderClaims::Didit(verification_data))
    }

    async fn get_verification_result(&self, external_session_id: &str) -> Result<RawProviderClaims> {
        debug!(
            "Fetching verification result for Didit session {}",
            external_session_id
        );

        // Fetch decision from Didit API
        let decision = self.get_session_decision(external_session_id).await?;

        // Check if ID verification part is approved (may differ from overall session status)
        let id_verification_status = decision
            .id_verifications
            .as_ref()
            .and_then(|arr| arr.first())
            .and_then(|v| v.status.as_deref());

        // Check face match status - may be approved even when session is "In Review"
        let face_match_approved = decision
            .face_matches
            .as_ref()
            .and_then(|arr| arr.first())
            .map(|fm| fm.status.as_deref() == Some("Approved"))
            .unwrap_or(false);

        let face_match_score = decision
            .face_matches
            .as_ref()
            .and_then(|arr| arr.first())
            .and_then(|fm| fm.score);

        debug!(
            "Didit session {} - id_verification_status: {:?}, face_match_approved: {}, face_match_score: {:?}",
            external_session_id, id_verification_status, face_match_approved, face_match_score
        );

        // If ID verification is explicitly approved, extract claims
        if id_verification_status == Some("Approved") {
            info!(
                "Didit session {} ID verification approved, extracting claims",
                external_session_id
            );
            let verification_data = self.parse_verification_data(&decision).await?;
            return Ok(RawProviderClaims::Didit(verification_data));
        }

        // Check if face match is approved with high confidence, even if session is "In Review"
        // This handles cases where Didit flags for manual review but the verification is valid
        // Face match approved + score > 90% + data present = accept
        let has_id_data = decision.id_verification.is_some()
            || decision.id_verifications.as_ref().map(|v| !v.is_empty()).unwrap_or(false);

        if face_match_approved && face_match_score.map(|s| s >= 90.0).unwrap_or(false) && has_id_data {
            info!(
                "Didit session {} face match approved with score {:?}, extracting claims despite '{}' status",
                external_session_id, face_match_score, decision.status
            );
            let verification_data = self.parse_verification_data(&decision).await?;
            return Ok(RawProviderClaims::Didit(verification_data));
        }

        // Check overall session status
        match decision.status.as_str() {
            "Approved" => {
                if !has_id_data {
                    debug!(
                        "Didit session {} approved but no verification data yet",
                        external_session_id
                    );
                    return Err(IdpError::VerificationPending(
                        "Verification approved, waiting for data".to_string(),
                    ));
                }
                info!(
                    "Didit session {} approved, extracting claims",
                    external_session_id
                );
                let verification_data = self.parse_verification_data(&decision).await?;
                Ok(RawProviderClaims::Didit(verification_data))
            }
            "Declined" | "Rejected" => {
                let reason = decision.decision.unwrap_or_else(|| "Verification rejected".to_string());
                Err(IdpError::VerificationFailed(format!(
                    "Didit verification declined: {}",
                    reason
                )))
            }
            "In Review" | "Pending" | "Processing" => {
                debug!(
                    "Didit session {} still pending (status: {})",
                    external_session_id, decision.status
                );

                // Extract warnings from id_verifications to inform the user
                let warnings = decision
                    .id_verifications
                    .as_ref()
                    .and_then(|arr| arr.first())
                    .and_then(|v| v.warnings.as_ref())
                    .map(|warns| {
                        warns
                            .iter()
                            .map(|w| VerificationWarning {
                                code: w.risk.clone().unwrap_or_else(|| "UNKNOWN".to_string()),
                                short_description: w
                                    .short_description
                                    .clone()
                                    .unwrap_or_else(|| "Review required".to_string()),
                                long_description: w.long_description.clone(),
                                risk: w.risk.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                Err(IdpError::VerificationPendingWithDetails(PendingDetails {
                    message: format!("Verification requires review (status: {})", decision.status),
                    provider_status: decision.status.clone(),
                    warnings,
                    retry_after_secs: 5, // Will be used for exponential backoff
                }))
            }
            _ => {
                warn!(
                    "Unknown Didit status: {} for session {}",
                    decision.status, external_session_id
                );
                Err(IdpError::VerificationPending(format!(
                    "Unknown status: {}",
                    decision.status
                )))
            }
        }
    }
}

// ============================================================================
// Didit API Types
// ============================================================================

/// Request body for creating a Didit session
#[derive(Debug, Serialize)]
struct DiditCreateSessionRequest {
    workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    callback: Option<String>,
}

/// Response from Didit session creation
#[derive(Debug, Deserialize)]
struct DiditSessionResponse {
    session_id: String,
    url: String,
    #[allow(dead_code)]
    status: String,
}

/// Webhook payload from Didit
#[derive(Debug, Deserialize)]
struct DiditWebhookPayload {
    session_id: String,
    status: String,
    decision: Option<String>,
}

/// Response from Didit decision endpoint
#[derive(Debug, Deserialize)]
struct DiditDecisionResponse {
    #[allow(dead_code)]
    status: String,
    #[allow(dead_code)]
    decision: Option<String>,
    /// Single id_verification object (older API version)
    id_verification: Option<DiditIdVerification>,
    /// Array of id_verifications (current API version)
    id_verifications: Option<Vec<DiditIdVerification>>,
    /// Face match results
    face_matches: Option<Vec<DiditFaceMatch>>,
}

/// Face match result from Didit
#[derive(Debug, Deserialize)]
struct DiditFaceMatch {
    status: Option<String>,
    score: Option<f64>,
}

/// Warning from Didit verification
#[derive(Debug, Deserialize)]
struct DiditWarning {
    #[allow(dead_code)]
    feature: Option<String>,
    risk: Option<String>,
    short_description: Option<String>,
    long_description: Option<String>,
}

/// ID verification data from Didit
#[derive(Debug, Deserialize)]
struct DiditIdVerification {
    /// Status of this specific verification (Approved, In Review, Declined)
    status: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    full_name: Option<String>,
    date_of_birth: Option<String>,
    nationality: Option<String>,
    document_type: Option<String>,
    document_number: Option<String>,
    issuing_state: Option<String>,
    gender: Option<String>,
    expiration_date: Option<String>,
    date_of_issue: Option<String>,
    portrait_image: Option<String>,
    /// Warnings from ID verification
    warnings: Option<Vec<DiditWarning>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> DiditConfig {
        DiditConfig {
            api_key: "test-api-key".to_string(),
            workflow_id: "test-workflow".to_string(),
            base_url: "https://test.didit.me".to_string(),
            webhook_secret: None,
            app_url: "https://app.example.com".to_string(),
        }
    }

    #[test]
    fn test_provider_info() {
        let provider = DiditProvider::new(test_config());

        assert_eq!(provider.provider_id(), "didit");
        assert_eq!(provider.provider_type(), ProviderFlowType::WebhookAsync);
        assert_eq!(provider.verification_level(), VerificationLevel::High);

        let info = provider.info();
        assert_eq!(info.id, "didit");
        assert_eq!(info.country, "Global");
    }

    #[test]
    fn test_config_from_env() {
        // This test requires env vars, so it will fail without them
        // In real tests, you'd use temp_env or similar
        let result = DiditConfig::from_env();
        // Just verify it returns an error when env vars aren't set
        assert!(result.is_err());
    }
}
