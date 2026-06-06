//! OAuth 2.1 / OpenID Connect client. Authorization-code flow,
//! configurable across multiple Identity Providers.

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

        // CLIENT_ID + CLIENT_SECRET are mandatory; issuer URL gets a
        // sensible default for well-known providers.
        let client_id = std::env::var(format!("{}_CLIENT_ID", prefix)).ok()?;
        let client_secret = std::env::var(format!("{}_CLIENT_SECRET", prefix)).ok()?;
        let issuer_url = std::env::var(format!("{}_ISSUER_URL", prefix))
            .ok()
            .or_else(|| default_issuer_url(provider_id))?;
        let redirect_uri = std::env::var(format!("{}_REDIRECT_URI", prefix))
            .unwrap_or_else(|_| format!("http://localhost:8001/auth/callback/{}", provider_id));
        let scopes = std::env::var(format!("{}_SCOPES", prefix))
            .unwrap_or_else(|_| "openid,profile,email".to_string())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        // Default claim mappings — pass standard OIDC names through
        // unchanged (SD-JWT VC uses the same names).
        let mut claim_mappings = HashMap::new();
        claim_mappings.insert("given_name".to_string(), "given_name".to_string());
        claim_mappings.insert("family_name".to_string(), "family_name".to_string());
        claim_mappings.insert("email".to_string(), "email".to_string());
        claim_mappings.insert("email_verified".to_string(), "email_verified".to_string());

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

/// Well-known issuer URL for a known provider id. Lets users supply
/// only `CLIENT_ID` + `CLIENT_SECRET` for the common cases.
fn default_issuer_url(provider_id: &str) -> Option<String> {
    Some(
        match provider_id {
            "google" => "https://accounts.google.com",
            "microsoft" => "https://login.microsoftonline.com/common/v2.0",
            "apple" => "https://appleid.apple.com",
            _ => return None,
        }
        .to_string(),
    )
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
    #[error("ID token verification failed: {0}")]
    IdTokenInvalid(String),
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

// =============================================================================
// JWKS-backed ID-token verification
// =============================================================================

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// A single JSON Web Key entry returned by an OIDC provider's `/jwks` URI.
#[derive(Debug, Clone, Deserialize)]
pub struct JwksKey {
    pub kty: String,
    pub kid: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Jwks {
    pub keys: Vec<JwksKey>,
}

/// Cached JWKS keyed by `jwks_uri`. Five-minute TTL — keeps refresh
/// cost low without missing a key rotation for long.
const JWKS_TTL: Duration = Duration::from_secs(5 * 60);

fn jwks_cache() -> &'static RwLock<HashMap<String, (Instant, Jwks)>> {
    static CACHE: OnceLock<RwLock<HashMap<String, (Instant, Jwks)>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Fetch + cache the JWKS document for an OIDC provider.
pub async fn fetch_jwks(jwks_uri: &str) -> Result<Jwks, OidcError> {
    {
        let cache = jwks_cache().read().await;
        if let Some((fetched, jwks)) = cache.get(jwks_uri) {
            if fetched.elapsed() < JWKS_TTL {
                return Ok(jwks.clone());
            }
        }
    }

    let jwks: Jwks = reqwest::Client::new()
        .get(jwks_uri)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| OidcError::HttpError(e.to_string()))?
        .json()
        .await
        .map_err(|e| OidcError::InvalidResponse(format!("Failed to parse JWKS: {}", e)))?;

    let mut cache = jwks_cache().write().await;
    cache.insert(jwks_uri.to_string(), (Instant::now(), jwks.clone()));
    Ok(jwks)
}

/// Strict subset of standard OIDC `id_token` claims. `iss` / `aud` / `exp`
/// are validated structurally by `jsonwebtoken`; the rest carry through
/// to the caller.
#[derive(Debug, Clone, Deserialize)]
pub struct IdTokenClaims {
    pub iss: String,
    pub sub: String,
    pub aud: serde_json::Value,
    pub exp: i64,
    #[serde(default)]
    pub nonce: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: Option<bool>,
    #[serde(default)]
    pub given_name: Option<String>,
    #[serde(default)]
    pub family_name: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub hd: Option<String>,
}

/// Verify an OIDC `id_token` against the provider's JWKS.
///
/// Checks: JWS signature against the kid-matched JWK, `iss` matches the
/// configured issuer (with the common `https://accounts.google.com`
/// trailing-slash variation tolerated), `aud` contains the client_id,
/// `exp` is in the future, and the `nonce` claim — if present in the
/// token — equals the one we minted at authorization time.
pub async fn verify_id_token(
    config: &OidcProviderConfig,
    discovery: &OidcDiscovery,
    id_token: &str,
    expected_nonce: &str,
) -> Result<IdTokenClaims, OidcError> {
    let jwks = fetch_jwks(&discovery.jwks_uri).await?;

    let header = decode_header(id_token)
        .map_err(|e| OidcError::IdTokenInvalid(format!("decode header: {}", e)))?;
    let kid = header
        .kid
        .ok_or_else(|| OidcError::IdTokenInvalid("id_token header missing kid".into()))?;

    let jwk = jwks
        .keys
        .iter()
        .find(|k| k.kid.as_deref() == Some(kid.as_str()))
        .ok_or_else(|| OidcError::IdTokenInvalid(format!("no JWKS entry for kid {}", kid)))?;

    if jwk.kty != "RSA" {
        return Err(OidcError::IdTokenInvalid(format!(
            "unsupported jwk kty {} (RSA expected)",
            jwk.kty
        )));
    }

    let n = jwk
        .n
        .as_deref()
        .ok_or_else(|| OidcError::IdTokenInvalid("jwk missing n".into()))?;
    let e = jwk
        .e
        .as_deref()
        .ok_or_else(|| OidcError::IdTokenInvalid("jwk missing e".into()))?;
    let key = DecodingKey::from_rsa_components(n, e)
        .map_err(|err| OidcError::IdTokenInvalid(format!("build decoding key: {}", err)))?;

    let alg = match jwk.alg.as_deref().or(Some("RS256")) {
        Some("RS256") => Algorithm::RS256,
        Some("RS384") => Algorithm::RS384,
        Some("RS512") => Algorithm::RS512,
        Some(other) => {
            return Err(OidcError::IdTokenInvalid(format!(
                "unsupported jwk alg {}",
                other
            )));
        }
        None => unreachable!(),
    };

    let mut validation = Validation::new(alg);
    validation.set_audience(&[&config.client_id]);
    // Some providers (Google) include + omit a trailing slash inconsistently.
    let trimmed = config.issuer_url.trim_end_matches('/').to_string();
    let with_slash = format!("{}/", trimmed);
    validation.set_issuer(&[trimmed.as_str(), with_slash.as_str()]);
    validation.validate_exp = true;
    validation.validate_nbf = false;

    let token_data = decode::<IdTokenClaims>(id_token, &key, &validation)
        .map_err(|e| OidcError::IdTokenInvalid(format!("verify: {}", e)))?;

    if let Some(nonce) = token_data.claims.nonce.as_deref() {
        if nonce != expected_nonce {
            return Err(OidcError::IdTokenInvalid("nonce mismatch".into()));
        }
    } else {
        return Err(OidcError::IdTokenInvalid(
            "id_token missing nonce; flow expected one".into(),
        ));
    }

    Ok(token_data.claims)
}
