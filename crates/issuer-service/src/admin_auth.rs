//! Admin auth for the issuer service.
//!
//! The verification service mints the JWT (HS256, signed with the shared
//! `ADMIN_JWT_SECRET` env), drops it as an `HttpOnly; Secure;
//! SameSite=Strict` cookie called `owlid_admin_token` on the SPA host, and
//! the SPA sends it on every cross-origin call thanks to
//! `credentials: 'include'` in the generated client. This module mirrors
//! the verification side just enough to validate that cookie (or the same
//! token presented as `Authorization: Bearer`) before letting an admin
//! mutation through. We intentionally keep the surface narrow — the issuer
//! service does not mint sessions.

use axum::{
    extract::Request,
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

const ADMIN_COOKIE_NAME: &str = "owlid_admin_token";

fn jwt_secret() -> String {
    std::env::var("ADMIN_JWT_SECRET")
        .unwrap_or_else(|_| "owlid-admin-jwt-secret-change-me".to_string())
}

#[derive(Debug, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub exp: usize,
    pub iat: usize,
}

fn read_token_from_cookies(headers: &HeaderMap) -> Option<String> {
    let header = headers.get(header::COOKIE).and_then(|v| v.to_str().ok())?;
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair.strip_prefix(&format!("{}=", ADMIN_COOKIE_NAME)) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn extract_admin_token(headers: &HeaderMap) -> Option<String> {
    if let Some(t) = read_token_from_cookies(headers) {
        return Some(t);
    }
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    auth.strip_prefix("Bearer ").map(|s| s.to_string())
}

fn validate_token(token: &str) -> Option<Claims> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret().as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map(|d| d.claims)
    .ok()
}

/// Identity attached to admin requests after `require_admin` succeeds.
#[derive(Debug, Clone)]
pub struct AdminPrincipal {
    pub username: String,
    pub permissions: Vec<String>,
}

impl AdminPrincipal {
    pub fn has_permission(&self, perm: &str) -> bool {
        self.permissions.iter().any(|p| p == perm)
    }
}

/// Middleware that requires a valid admin session JWT carrying the
/// `admin` permission. Inserts an `AdminPrincipal` into request extensions
/// so handlers can read the operator's identity for audit.
pub async fn require_admin(
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Result<Response, AdminAuthError> {
    let token = extract_admin_token(&headers).ok_or(AdminAuthError::MissingSession)?;
    let claims = validate_token(&token).ok_or(AdminAuthError::InvalidSession)?;
    if !claims.permissions.iter().any(|p| p == "admin") {
        return Err(AdminAuthError::Forbidden);
    }
    request.extensions_mut().insert(AdminPrincipal {
        username: claims.sub,
        permissions: claims.permissions,
    });
    Ok(next.run(request).await)
}

#[derive(Debug)]
pub enum AdminAuthError {
    MissingSession,
    InvalidSession,
    Forbidden,
}

impl IntoResponse for AdminAuthError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            AdminAuthError::MissingSession => {
                (StatusCode::UNAUTHORIZED, "Missing admin session")
            }
            AdminAuthError::InvalidSession => {
                (StatusCode::UNAUTHORIZED, "Invalid or expired admin session")
            }
            AdminAuthError::Forbidden => {
                (StatusCode::FORBIDDEN, "Admin permission required")
            }
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}
