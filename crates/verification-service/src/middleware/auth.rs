//! Two-mode authentication: API key (Authorization: Bearer) for service-to-
//! service callers, and admin JWT cookie (`owlid_admin_token`) for the browser
//! admin SPA. Both resolve to a `Principal` carrying explicit permissions; the
//! permission gate is the same regardless of source.
//!
//! Security model:
//!   - API key principal: opaque secret presented in `Authorization: Bearer`.
//!     Permissions come from the API key row at lookup time, so revocation is
//!     immediate.
//!   - Admin session principal: signed JWT delivered as an `HttpOnly; Secure;
//!     SameSite=Strict` cookie set on `/admin/login`. Permissions are baked
//!     into the token at login (24h TTL); a permission revocation does not
//!     take effect until the token expires.
//!
//! Order of preference: try API key first, fall back to cookie. Service
//! callers usually do not set Cookie, and browsers usually do not set
//! Authorization, so collisions are rare. When both are present the API
//! key wins — explicit beats ambient.
#![allow(dead_code)] // intentional API surface / serde fields
use crate::admin_auth;
use crate::db::{ApiKeyRepository, models::ApiKey};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::Arc;

/// Authentication middleware that validates API keys or admin sessions.
pub struct AuthMiddleware;

fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    let token = auth.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// Resolved caller identity, attached to request extensions for downstream
/// handlers. Use `permissions()` / `has_permission()` to gate; do not branch
/// on the variant unless the handler genuinely needs the underlying API
/// key (e.g. for audit logging).
#[allow(clippy::large_enum_variant)]
#[derive(Clone)]
pub enum Principal {
    /// Service caller authenticated via `Authorization: Bearer <api_key>`.
    ApiKey(ApiKey),
    /// Admin operator authenticated via `owlid_admin_token` cookie.
    AdminSession {
        username: String,
        permissions: Vec<String>,
    },
}

impl Principal {
    pub fn has_permission(&self, permission: &str) -> bool {
        match self {
            Principal::ApiKey(k) => k.has_permission(permission),
            Principal::AdminSession { permissions, .. } => {
                permissions.iter().any(|p| p == permission)
            }
        }
    }
}

/// Legacy alias kept so existing extension lookups (`AuthenticatedKey`)
/// continue to compile. New code should read `Principal` instead.
#[derive(Clone)]
pub struct AuthenticatedKey {
    pub api_key: ApiKey,
}

async fn resolve_principal(
    repo: &Arc<ApiKeyRepository>,
    headers: &HeaderMap,
) -> Result<Principal, AuthError> {
    // Try API key first if present. A *valid* key wins immediately —
    // explicit beats ambient. A *present-but-invalid* key falls through
    // to the cookie path: this matters for browser SPAs that ship a
    // build-time `VITE_API_KEY` but also rely on the admin session
    // cookie for protected endpoints. Track whether a Bearer header was
    // attempted so we can return `InvalidApiKey` (more accurate) rather
    // than `MissingApiKey` when both auth modes fail.
    let mut bearer_attempted = false;
    if let Some(api_key_value) = extract_api_key(headers) {
        bearer_attempted = true;
        if let Ok(api_key) = repo.find_by_key(&api_key_value).await {
            if api_key.is_valid() {
                let repo_clone = Arc::clone(repo);
                let key_id = api_key.id;
                tokio::spawn(async move {
                    let _ = repo_clone.update_last_used(key_id).await;
                });
                return Ok(Principal::ApiKey(api_key));
            }
        }
        // intentional fall-through: try cookie before giving up.
    }

    if let Some(token) = admin_auth::read_token_from_cookies(headers) {
        let claims = admin_auth::validate_token(&token).map_err(|_| AuthError::InvalidApiKey)?;
        return Ok(Principal::AdminSession {
            username: claims.sub,
            permissions: claims.permissions,
        });
    }

    if bearer_attempted {
        Err(AuthError::InvalidApiKey)
    } else {
        Err(AuthError::MissingApiKey)
    }
}

impl AuthMiddleware {
    /// Validate either an API key or an admin session cookie. Either is
    /// accepted; downstream handlers see the resolved `Principal` in
    /// extensions.
    pub async fn validate(
        State(repo): State<Arc<ApiKeyRepository>>,
        headers: HeaderMap,
        mut request: Request,
        next: Next,
    ) -> Result<Response, AuthError> {
        let principal = resolve_principal(&repo, &headers).await?;
        if let Principal::ApiKey(ref k) = principal {
            request
                .extensions_mut()
                .insert(AuthenticatedKey { api_key: k.clone() });
        }
        request.extensions_mut().insert(principal);
        Ok(next.run(request).await)
    }

    /// Validate and require a specific permission on the resolved principal.
    pub async fn validate_with_permission(
        State(repo): State<Arc<ApiKeyRepository>>,
        headers: HeaderMap,
        mut request: Request,
        next: Next,
        required_permission: &'static str,
    ) -> Result<Response, AuthError> {
        let principal = resolve_principal(&repo, &headers).await?;
        if !principal.has_permission(required_permission) {
            return Err(AuthError::InsufficientPermissions(
                required_permission.to_string(),
            ));
        }
        if let Principal::ApiKey(ref k) = principal {
            request
                .extensions_mut()
                .insert(AuthenticatedKey { api_key: k.clone() });
        }
        request.extensions_mut().insert(principal);
        Ok(next.run(request).await)
    }
}

/// Helper to create a permission-checking middleware
#[allow(clippy::type_complexity)] // axum middleware return type is irreducible
pub fn require_permission(
    permission: &'static str,
) -> impl Fn(
    State<Arc<ApiKeyRepository>>,
    HeaderMap,
    Request,
    Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, AuthError>> + Send>>
+ Clone {
    move |state, headers, request, next| {
        Box::pin(async move {
            AuthMiddleware::validate_with_permission(state, headers, request, next, permission)
                .await
        })
    }
}

#[derive(Debug)]
pub enum AuthError {
    MissingApiKey,
    InvalidApiKey,
    InsufficientPermissions(String),
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AuthError::MissingApiKey => (
                StatusCode::UNAUTHORIZED,
                "Missing API key (Authorization: Bearer) or admin session cookie".to_string(),
            ),
            AuthError::InvalidApiKey => (
                StatusCode::UNAUTHORIZED,
                "Invalid or expired API key (or admin session)".to_string(),
            ),
            AuthError::InsufficientPermissions(perm) => (
                StatusCode::FORBIDDEN,
                format!("Insufficient permissions: {} required", perm),
            ),
        };

        let body = serde_json::json!({
            "error": message,
        });

        (status, axum::Json(body)).into_response()
    }
}
