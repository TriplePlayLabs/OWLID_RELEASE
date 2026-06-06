//! Midnight Sidecar HTTP client for the Issuer Service
//!
//! Provides transparent blockchain integration via the midnight-sidecar service.
//! All chain operations are fire-and-forget with warning logs — if the sidecar
//! is down, the service continues with DB-only.

#![allow(dead_code)] // intentional API surface / serde fields
use serde::Deserialize;

// ============================================================================
// Configuration
// ============================================================================

/// Midnight sidecar configuration, loaded from environment variables.
/// Midnight is required —
pub struct MidnightConfig {
    pub sidecar_url: String,
    pub api_key: Option<String>,
    pub timeout_secs: u64,
}

impl MidnightConfig {
    pub fn from_env() -> Self {
        Self {
            sidecar_url: std::env::var("MIDNIGHT_SIDECAR_URL")
                .unwrap_or_else(|_| "http://localhost:3000".to_string()),
            api_key: std::env::var("MIDNIGHT_SIDECAR_API_KEY").ok(),
            timeout_secs: std::env::var("MIDNIGHT_SIDECAR_TIMEOUT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
        }
    }
}

// ============================================================================
// Error type
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum MidnightError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Sidecar error: {0}")]
    Sidecar(String),
}

// ============================================================================
// Sidecar response types
// ============================================================================

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    #[serde(default)]
    success: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IssuerStatusResponse {
    #[serde(rename = "keyHash")]
    pub key_hash: String,
    pub trusted: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub connected: bool,
}

// ============================================================================
// Client
// ============================================================================

/// HTTP client for the Midnight sidecar service. Required at startup.
#[derive(Clone)]
pub struct MidnightSidecar {
    base_url: String,
    http: reqwest::Client,
}

impl MidnightSidecar {
    /// Create a new sidecar client from config.
    pub fn new(config: MidnightConfig) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(ref api_key) = config.api_key {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {api_key}"))
                    .expect("Invalid API key header value"),
            );
        }

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .default_headers(headers)
            .build()
            .expect("Failed to build HTTP client");

        Self {
            base_url: config.sidecar_url.trim_end_matches('/').to_string(),
            http,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Check sidecar health.
    pub async fn health_check(&self) -> Result<bool, MidnightError> {
        let resp: HealthResponse = self
            .http
            .get(format!("{}/health", self.base_url))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp.connected)
    }

    // ========================================================================
    // Issuer Registry
    // ========================================================================

    /// Check if an issuer is trusted on-chain.
    pub async fn is_issuer_trusted(&self, key_hash_hex: &str) -> Result<bool, MidnightError> {
        let resp: IssuerStatusResponse = self
            .http
            .get(format!(
                "{}/api/issuers/{}/trusted",
                self.base_url, key_hash_hex
            ))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(resp.trusted.unwrap_or(false))
    }

    /// Register an issuer on-chain.
    pub async fn register_issuer(
        &self,
        public_key_hex: &str,
        name: &str,
    ) -> Result<(), MidnightError> {
        let resp: SidecarResponse = self
            .http
            .post(format!("{}/api/issuers/register", self.base_url))
            .json(&serde_json::json!({
                "publicKey": public_key_hex,
                "name": name,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }

    // ========================================================================
    // Identity Registry
    // ========================================================================

    /// Register an identity commitment on-chain.
    pub async fn register_identity(
        &self,
        did_hash_hex: &str,
        commitment_hex: &str,
        issuer_key_hash_hex: &str,
    ) -> Result<(), MidnightError> {
        let resp: SidecarResponse = self
            .http
            .post(format!("{}/api/identities/register", self.base_url))
            .json(&serde_json::json!({
                "didHash": did_hash_hex,
                "commitment": commitment_hex,
                "issuerKeyHash": issuer_key_hash_hex,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }
}
