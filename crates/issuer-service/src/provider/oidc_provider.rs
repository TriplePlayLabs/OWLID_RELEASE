//! Generic OIDC `DigitalIdentityProvider` adapter.
//!
//! Wraps an `OidcProviderConfig` (loaded from env in `oidc.rs`) so the
//! standard `/sessions` issuance flow can drive any configured OpenID
//! Connect identity provider — Google, Microsoft, Apple, or any other
//! that ships an OpenID Connect discovery document.
//!
//! Flow at runtime:
//!   1. holder app → `POST /sessions { providerId }` → this provider's
//!      `start_verification` mints a `state` + `nonce` + PKCE
//!      verifier, stores them in the shared `OidcStateStore` keyed by
//!      `state` (along with the session UUID), and returns a
//!      `Redirect` to the authorization endpoint.
//!   2. user authenticates with the provider, browser returns to
//!      `/auth/callback/{providerId}?code=…&state=…`.
//!   3. handler resolves the pending entry by `state`, routes the
//!      `(session_id, code, state)` tuple through
//!      `handle_oidc_callback`, which exchanges the code for tokens,
//!      verifies the `id_token` against the provider JWKS, fetches
//!      `/userinfo` for any claim missing from the id_token, and
//!      emits typed `RawProviderClaims::Google` (or similar).

use crate::error::{IdpError, Result};
use crate::models::{ProviderDescriptor, VerificationLevel};
use crate::normalizer::{GoogleOidcClaims, RawProviderClaims};
use crate::oidc::{
    OidcProviderConfig, build_auth_url, discover, exchange_code, fetch_userinfo, verify_id_token,
};
use crate::oidc_state::{OidcStateStore, StoredOidcState};
use crate::provider::traits::{DigitalIdentityProvider, ProviderFlowType, VerificationStart};
use async_trait::async_trait;
use uuid::Uuid;

pub struct OidcProvider {
    config: OidcProviderConfig,
    /// Human-readable label shown in the consent picker.
    display_name: String,
    /// Country/region tag for the provider directory.
    country: String,
    /// Assurance level claimed by the provider's flow. Google +
    /// generic OIDC = Low (email-only signal).
    level: VerificationLevel,
    /// Shared store, populated at `start_verification` time + consumed
    /// at `handle_oidc_callback` time.
    state_store: OidcStateStore,
}

impl OidcProvider {
    pub fn new(
        config: OidcProviderConfig,
        display_name: impl Into<String>,
        country: impl Into<String>,
        level: VerificationLevel,
        state_store: OidcStateStore,
    ) -> Self {
        Self {
            config,
            display_name: display_name.into(),
            country: country.into(),
            level,
            state_store,
        }
    }
}

#[async_trait]
impl DigitalIdentityProvider for OidcProvider {
    fn provider_id(&self) -> &str {
        &self.config.provider_id
    }

    fn provider_type(&self) -> ProviderFlowType {
        ProviderFlowType::OidcRedirect
    }

    fn info(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.config.provider_id.clone(),
            name: self.display_name.clone(),
            description: format!(
                "OpenID Connect provider ({})",
                self.config.issuer_url.trim_end_matches('/'),
            ),
            verification_levels: vec![self.level],
            country: self.country.clone(),
        }
    }

    fn verification_level(&self) -> VerificationLevel {
        self.level
    }

    async fn start_verification(&self, session_id: Uuid) -> Result<VerificationStart> {
        let discovery = discover(&self.config.issuer_url)
            .await
            .map_err(|e| IdpError::Internal(format!("OIDC discovery failed: {}", e)))?;

        let state = Uuid::new_v4().to_string();
        let nonce = Uuid::new_v4().to_string();
        let code_verifier = Uuid::new_v4().to_string();
        let code_challenge = pkce_challenge_s256(&code_verifier);

        self.state_store
            .insert(StoredOidcState {
                state: state.clone(),
                code_verifier,
                nonce: nonce.clone(),
                provider_id: self.config.provider_id.clone(),
                created_at: std::time::Instant::now(),
                session_id: Some(session_id),
            })
            .await;

        let url = build_auth_url(
            &self.config,
            &discovery.authorization_endpoint,
            &state,
            &nonce,
            &code_challenge,
        );

        Ok(VerificationStart::Redirect {
            url,
            relay_state: Some(state),
        })
    }

    async fn handle_oidc_callback(
        &self,
        session_id: Uuid,
        code: &str,
        state: &str,
    ) -> Result<RawProviderClaims> {
        let pending = self.state_store.take(state).await.ok_or_else(|| {
            IdpError::Internal(
                "OIDC state not found or expired — possible CSRF or replay".to_string(),
            )
        })?;

        if pending.provider_id != self.config.provider_id {
            return Err(IdpError::Internal(
                "OIDC state provider mismatch (CSRF)".to_string(),
            ));
        }
        if pending.session_id != Some(session_id) {
            return Err(IdpError::Internal(
                "OIDC state session mismatch (CSRF)".to_string(),
            ));
        }

        let discovery = discover(&self.config.issuer_url)
            .await
            .map_err(|e| IdpError::Internal(format!("OIDC discovery failed: {}", e)))?;

        let token_response = exchange_code(
            &self.config,
            &discovery.token_endpoint,
            code,
            &pending.code_verifier,
        )
        .await
        .map_err(|e| IdpError::Internal(format!("OIDC token exchange failed: {}", e)))?;

        let id_token = token_response.id_token.as_deref().ok_or_else(|| {
            IdpError::Internal("OIDC provider did not return an id_token".to_string())
        })?;

        let id_claims = verify_id_token(&self.config, &discovery, id_token, &pending.nonce)
            .await
            .map_err(|e| IdpError::Internal(format!("OIDC id_token verify failed: {}", e)))?;

        // Cross-check with /userinfo for claims that may not appear in
        // the id_token (Google: `picture`, `locale`, `hd` sometimes).
        let userinfo = if let Some(userinfo_endpoint) = discovery.userinfo_endpoint.as_deref() {
            fetch_userinfo(userinfo_endpoint, &token_response.access_token)
                .await
                .ok()
        } else {
            None
        };
        let mut claims = GoogleOidcClaims {
            sub: id_claims.sub,
            email: id_claims.email,
            email_verified: id_claims.email_verified.unwrap_or(false),
            given_name: id_claims.given_name,
            family_name: id_claims.family_name,
            name: id_claims.name,
            picture: id_claims.picture,
            locale: id_claims.locale,
            hd: id_claims.hd,
        };
        if let Some(map) = userinfo {
            if claims.email.is_none() {
                claims.email = map.get("email").and_then(|v| v.as_str()).map(String::from);
            }
            if claims.given_name.is_none() {
                claims.given_name = map
                    .get("given_name")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            if claims.family_name.is_none() {
                claims.family_name = map
                    .get("family_name")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            if claims.name.is_none() {
                claims.name = map.get("name").and_then(|v| v.as_str()).map(String::from);
            }
            if claims.picture.is_none() {
                claims.picture = map
                    .get("picture")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            if claims.locale.is_none() {
                claims.locale = map.get("locale").and_then(|v| v.as_str()).map(String::from);
            }
            if claims.hd.is_none() {
                claims.hd = map.get("hd").and_then(|v| v.as_str()).map(String::from);
            }
        }

        Ok(RawProviderClaims::Google(claims))
    }
}

/// PKCE S256 challenge: `base64url(SHA-256(verifier))` per RFC 7636.
fn pkce_challenge_s256(verifier: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}
