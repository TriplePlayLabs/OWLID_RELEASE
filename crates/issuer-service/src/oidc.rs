//! T-017: OAuth 2.1 / OpenID Connect Integration
//!
//! Provides OIDC client configuration and authorization code flow handling.
//! Supports multiple Identity Providers via configuration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// OIDC provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcProviderConfig {
    /// Provider identifier (e.g., "google", "microsoft")
    pub provider_id: String,
    /// OIDC issuer URL (e.g., "https://accounts.google.com")
    pub issuer_url: String,
    /// Client ID registered with the IdP
    pub client_id: String,
    /// Client secret (should be stored securely)
    pub client_secret: String,
    /// Redirect URI for authorization code callback
    pub redirect_uri: String,
    /// Requested scopes
    pub scopes: Vec<String>,
    /// Claim mappings: IdP claim name -> OwlID claim name
    pub claim_mappings: HashMap<String, String>,
}

impl OidcProviderConfig {
    /// Load OIDC provider configs from environment variables
    ///
    /// Uses the pattern:
    /// - `OIDC_{PROVIDER}_ISSUER_URL`
    /// - `OIDC_{PROVIDER}_CLIENT_ID`
    /// - `OIDC_{PROVIDER}_CLIENT_SECRET`
    /// - `OIDC_{PROVIDER}_REDIRECT_URI`
    /// - `OIDC_{PROVIDER}_SCOPES` (comma-separated)
    pub fn from_env(provider_id: &str) -> Option<Self> {
        let prefix = format!("OIDC_{}", provider_id.to_uppercase());

        let issuer_url = std::env::var(format!("{}_ISSUER_URL", prefix)).ok()?;
        let client_id = std::env::var(format!("{}_CLIENT_ID", prefix)).ok()?;
        let client_secret = std::env::var(format!("{}_CLIENT_SECRET", prefix)).ok()?;
        let redirect_uri = std::env::var(format!("{}_REDIRECT_URI", prefix))
            .unwrap_or_else(|_| format!("http://localhost:8001/auth/callback/{}", provider_id));
        let scopes = std::env::var(format!("{}_SCOPES", prefix))
            .unwrap_or_else(|_| "openid,profile,email".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        // Default claim mappings
        let mut claim_mappings = HashMap::new();
        claim_mappings.insert("given_name".to_string(), "firstName".to_string());
        claim_mappings.insert("family_name".to_string(), "lastName".to_string());
        claim_mappings.insert("email".to_string(), "email".to_string());
        claim_mappings.insert("email_verified".to_string(), "emailVerified".to_string());

        Some(OidcProviderConfig {
            provider_id: provider_id.to_string(),
            issuer_url,
            client_id,
            client_secret,
            redirect_uri,
            scopes,
            claim_mappings,
        })
    }
}

/// OIDC discovery document (subset of fields we use)
#[derive(Debug, Deserialize)]
pub struct OidcDiscovery {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub userinfo_endpoint: Option<String>,
    pub jwks_uri: String,
    pub issuer: String,
}

/// Token response from the OIDC provider
#[derive(Debug, Deserialize)]
pub struct OidcTokenResponse {
    pub access_token: String,
    pub token_type: String,
    pub id_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<u64>,
    pub scope: Option<String>,
}

/// OIDC authentication state (stored in session)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcAuthState {
    /// CSRF protection state parameter
    pub state: String,
    /// PKCE code verifier
    pub code_verifier: String,
    /// Nonce for ID token validation
    pub nonce: String,
    /// Provider ID
    pub provider_id: String,
}

/// Load all configured OIDC providers from environment
pub fn load_oidc_providers() -> Vec<OidcProviderConfig> {
    let mut providers = Vec::new();

    // Check for known providers
    let known_providers = ["google", "microsoft", "apple", "github"];

    for provider_id in &known_providers {
        if let Some(config) = OidcProviderConfig::from_env(provider_id) {
            tracing::info!("Loaded OIDC provider: {}", provider_id);
            providers.push(config);
        }
    }

    // Check for custom providers via OIDC_PROVIDERS env var
    if let Ok(custom_providers) = std::env::var("OIDC_PROVIDERS") {
        for provider_id in custom_providers.split(',') {
            let provider_id = provider_id.trim();
            if !known_providers.contains(&provider_id) {
                if let Some(config) = OidcProviderConfig::from_env(provider_id) {
                    tracing::info!("Loaded custom OIDC provider: {}", provider_id);
                    providers.push(config);
                }
            }
        }
    }

    providers
}

/// Build the authorization URL for a provider
pub fn build_auth_url(
    config: &OidcProviderConfig,
    authorization_endpoint: &str,
    state: &str,
    nonce: &str,
    code_challenge: &str,
) -> String {
    let scopes = config.scopes.join(" ");
    format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&nonce={}&code_challenge={}&code_challenge_method=S256",
        authorization_endpoint,
        urlencoding::encode(&config.client_id),
        urlencoding::encode(&config.redirect_uri),
        urlencoding::encode(&scopes),
        urlencoding::encode(state),
        urlencoding::encode(nonce),
        urlencoding::encode(code_challenge),
    )
}

/// Error type for OIDC operations
#[derive(Debug, thiserror::Error)]
pub enum OidcError {
    #[error("HTTP request failed: {0}")]
    HttpError(String),
    #[error("Invalid response: {0}")]
    InvalidResponse(String),
    #[error("Provider not found: {0}")]
    ProviderNotFound(String),
    #[error("State mismatch (possible CSRF)")]
    StateMismatch,
}

impl From<reqwest::Error> for OidcError {
    fn from(e: reqwest::Error) -> Self {
        OidcError::HttpError(e.to_string())
    }
}

/// Fetch the OIDC discovery document from the provider
pub async fn discover(issuer_url: &str) -> Result<OidcDiscovery, OidcError> {
    let url = format!(
        "{}/.well-known/openid-configuration",
        issuer_url.trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await?
        .json::<OidcDiscovery>()
        .await
        .map_err(|e| OidcError::InvalidResponse(format!("Failed to parse discovery: {}", e)))?;
    Ok(resp)
}

/// Exchange an authorization code for tokens using the PKCE flow
pub async fn exchange_code(
    config: &OidcProviderConfig,
    token_endpoint: &str,
    code: &str,
    code_verifier: &str,
) -> Result<OidcTokenResponse, OidcError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &config.redirect_uri),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OidcError::InvalidResponse(format!(
            "Token exchange failed ({}): {}",
            status, body
        )));
    }

    resp.json::<OidcTokenResponse>()
        .await
        .map_err(|e| OidcError::InvalidResponse(format!("Failed to parse token response: {}", e)))
}

/// Fetch user claims from the userinfo endpoint
pub async fn fetch_userinfo(
    userinfo_endpoint: &str,
    access_token: &str,
) -> Result<HashMap<String, serde_json::Value>, OidcError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(userinfo_endpoint)
        .bearer_auth(access_token)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OidcError::InvalidResponse(format!(
            "Userinfo request failed ({}): {}",
            status, body
        )));
    }

    resp.json::<HashMap<String, serde_json::Value>>()
        .await
        .map_err(|e| OidcError::InvalidResponse(format!("Failed to parse userinfo: {}", e)))
}

/// Map provider claims to OwlID claims using the configured mappings
pub fn map_claims(
    raw_claims: &HashMap<String, serde_json::Value>,
    mappings: &HashMap<String, String>,
) -> HashMap<String, serde_json::Value> {
    let mut mapped = HashMap::new();
    for (provider_key, owlid_key) in mappings {
        if let Some(value) = raw_claims.get(provider_key) {
            mapped.insert(owlid_key.clone(), value.clone());
        }
    }
    // Also include sub (subject) which is always present
    if let Some(sub) = raw_claims.get("sub") {
        mapped.insert("sub".to_string(), sub.clone());
    }
    mapped
}

/// URL-encode a string (minimal implementation)
mod urlencoding {
    pub fn encode(s: &str) -> String {
        let mut result = String::new();
        for byte in s.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    result.push(byte as char);
                }
                _ => {
                    result.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        result
    }
}
