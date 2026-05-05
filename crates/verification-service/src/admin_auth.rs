//! Admin authentication and API key management.
//!
//! Sessions are issued as `HttpOnly; Secure; SameSite=Strict` cookies
//! (`owlid_admin_token`). The same JWT is also returned in the response
//! body for non-browser callers that prefer `Authorization: Bearer`.

use crate::api_key::{self, Environment, KeyType};
use crate::db::ApiKeyRepository;
use axum::{
    extract::{Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const ADMIN_COOKIE_NAME: &str = "owlid_admin_token";

const ADMIN_TOKEN_TTL_SECS: i64 = 86400;

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

fn jwt_secret() -> String {
    std::env::var("ADMIN_JWT_SECRET").unwrap_or_else(|_| "owlid-admin-jwt-secret-change-me".to_string())
}

fn jwt_validation() -> Validation {
    // HS256 pinned to prevent algorithm-confusion attacks.
    Validation::new(Algorithm::HS256)
}

/// JWT payload for an admin browser session.
///
/// `permissions` carries the explicit capability list the operator was
/// granted at login. The auth middleware checks this list when gating
/// permission-protected routes (`admin`, `gdpr`, ...). Putting the
/// permissions inside the signed token avoids a DB lookup on every
/// request and makes the token self-contained — but it also means a
/// permission revocation does not take effect until the token expires
/// (24h max). Acceptable for an interactive admin dashboard.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    /// Username (subject).
    pub sub: String,
    /// Effective permissions for this session.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Expiry, epoch seconds.
    pub exp: usize,
    /// Issued at, epoch seconds.
    pub iat: usize,
}

fn create_token(username: &str, permissions: &[String]) -> Result<String, AdminError> {
    let now = Utc::now();
    let exp = (now + Duration::seconds(ADMIN_TOKEN_TTL_SECS)).timestamp() as usize;
    let claims = Claims {
        sub: username.to_string(),
        permissions: permissions.to_vec(),
        exp,
        iat: now.timestamp() as usize,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(jwt_secret().as_bytes()),
    )
    .map_err(|e| AdminError::Internal(format!("JWT creation failed: {}", e)))
}

pub fn validate_token(token: &str) -> Result<Claims, AdminError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret().as_bytes()),
        &jwt_validation(),
    )
    .map(|data| data.claims)
    .map_err(|_| AdminError::Unauthorized("Invalid or expired token".to_string()))
}

/// Permissions granted to the built-in admin operator. Until the
/// `admin_users` schema carries a per-user permission set, every admin
/// account gets the full operator surface (admin + gdpr).
fn default_admin_permissions() -> Vec<String> {
    vec!["admin".to_string(), "gdpr".to_string(), "verify".to_string()]
}

/// Domain attribute for the admin session cookie. The admin SPA may live
/// at one origin and call admin-aware sister services at another (e.g.
/// verification on `:8000`, issuer on `:8001`); a host-only cookie would
/// not reach the second service, so we set an explicit Domain so the
/// browser sends it to both.
///
/// Resolution order:
///   1. `ADMIN_COOKIE_DOMAIN` env if set — operator-controlled apex
///      (e.g. `example.com` so `api.example.com` + `issuer.example.com`
///      both receive it).
///   2. In dev (`APP_ENV != production`), default to `localhost` so
///      services on different ports of localhost share the cookie.
///   3. Otherwise, no Domain attribute (host-only cookie).
fn admin_cookie_domain_attr() -> String {
    if let Ok(d) = std::env::var("ADMIN_COOKIE_DOMAIN") {
        let d = d.trim();
        if !d.is_empty() {
            return format!("; Domain={}", d);
        }
    }
    let is_prod = std::env::var("APP_ENV")
        .map(|v| v.to_lowercase() == "production")
        .unwrap_or(false);
    if !is_prod {
        return "; Domain=localhost".to_string();
    }
    String::new()
}

fn build_login_cookie(token: &str) -> HeaderValue {
    let domain = admin_cookie_domain_attr();
    let value = format!(
        "{ADMIN_COOKIE_NAME}={token}; HttpOnly; Secure; SameSite=Strict; Path=/{domain}; Max-Age={ADMIN_TOKEN_TTL_SECS}",
    );
    HeaderValue::from_str(&value).expect("cookie header is ASCII")
}

/// Clear cookies. We emit TWO Set-Cookie headers — one with the current
/// Domain attribute, one host-only — so the browser drops both variants
/// even when an older host-only cookie lingers from a deploy before the
/// `Domain=` attribute was introduced. Without this, logout could appear
/// successful while a stale cookie kept the next `/admin/me` returning
/// 200 and bouncing the operator back into the dashboard.
fn build_clear_cookies() -> Vec<HeaderValue> {
    let domain = admin_cookie_domain_attr();
    let mut out = Vec::with_capacity(2);
    out.push(
        HeaderValue::from_str(&format!(
            "{ADMIN_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/{domain}; Max-Age=0",
        ))
        .expect("cookie header is ASCII"),
    );
    if !domain.is_empty() {
        out.push(
            HeaderValue::from_str(&format!(
                "{ADMIN_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
            ))
            .expect("cookie header is ASCII"),
        );
    }
    out
}

pub fn read_token_from_cookies(headers: &HeaderMap) -> Option<String> {
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
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok())?;
    auth.strip_prefix("Bearer ").map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// JWT Middleware
// ---------------------------------------------------------------------------

/// Applied to every /admin/* route except /admin/login and /admin/logout.
///
/// Inserts a `Principal::AdminSession` into request extensions so handlers
/// under this layer can pick up the resolved identity through
/// `Extension<Principal>` — same contract the unified `AuthMiddleware`
/// uses for the API-key and cookie-fallback paths.
pub async fn require_jwt(
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Result<Response, AdminError> {
    let token = extract_admin_token(&headers)
        .ok_or_else(|| AdminError::Unauthorized("Missing admin session".to_string()))?;
    let claims = validate_token(&token)?;
    request
        .extensions_mut()
        .insert(crate::middleware::auth::Principal::AdminSession {
            username: claims.sub,
            permissions: claims.permissions,
        });
    Ok(next.run(request).await)
}

// ---------------------------------------------------------------------------
// Request/Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    token: String,
    username: String,
    expires_in: u64,
    /// `true` when the operator just authenticated with the built-in
    /// default password (`admin`/`admin`). The admin SPA must intercept
    /// this and force the user through `POST /admin/password` before
    /// surfacing the dashboard. Backend already issued a session cookie
    /// so the change-password call can carry it; the SPA still gates
    /// every other route until rotation completes.
    pub must_change_default_password: bool,
}

/// Plaintext default password used to seed the first admin row in
/// migration 004. We compare against this on every login to decide
/// whether the operator must rotate credentials before continuing. Once
/// rotated, bcrypt::verify against the row no longer matches this string
/// and the prompt goes away.
const DEFAULT_ADMIN_PASSWORD: &str = "admin";

/// Minimum length we accept for a non-default admin password. Conscious
/// floor — short enough that no operator is locked out on first
/// rotation, long enough that "admin", "12345678" etc. are not viable.
const MIN_ADMIN_PASSWORD_LEN: usize = 12;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyRequest {
    name: String,
    #[serde(default)]
    description: Option<String>,
    permissions: Vec<String>,
    #[serde(default = "default_key_type")]
    key_type: KeyType,
    #[serde(default = "default_environment")]
    environment: Environment,
}

fn default_key_type() -> KeyType {
    KeyType::Sk
}

fn default_environment() -> Environment {
    Environment::Live
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateApiKeyResponse {
    /// Raw API key — returned ONCE, never readable again.
    key: String,
    /// Human-safe key fingerprint (`owlid_sk_live_…AbCd`) for later display.
    key_preview: String,
    key_type: KeyType,
    environment: Environment,
    name: String,
    permissions: Vec<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInfo {
    id: String,
    name: String,
    description: Option<String>,
    permissions: Vec<String>,
    is_active: bool,
    created_at: String,
    last_used_at: Option<String>,
    created_by: Option<String>,
    key_type: KeyType,
    environment: Environment,
    key_preview: Option<String>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Admin login.
#[utoipa::path(
    post,
    path = "/admin/login",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Login successful", body = LoginResponse),
        (status = 401, description = "Invalid credentials"),
    ),
    tag = "admin-auth"
)]
pub async fn login(
    State(state): State<crate::state::AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Response, AdminError> {
    // Look up user
    let user = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, username, password_hash FROM admin_users WHERE username = $1 AND is_active = true",
    )
    .bind(&req.username)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?
    .ok_or(AdminError::Unauthorized("Invalid credentials".to_string()))?;

    // Verify password
    let valid = bcrypt::verify(&req.password, &user.2)
        .map_err(|e| AdminError::Internal(format!("Bcrypt error: {}", e)))?;

    if !valid {
        return Err(AdminError::Unauthorized("Invalid credentials".to_string()));
    }

    // Update last_login_at
    let _ = sqlx::query("UPDATE admin_users SET last_login_at = NOW() WHERE id = $1")
        .bind(user.0)
        .execute(&state.db_pool)
        .await;

    let permissions = default_admin_permissions();
    let token = create_token(&user.1, &permissions)?;
    // The default-password check fires after we've already verified the
    // login succeeded, so it's a one-bcrypt-call cost on the happy path.
    // We compare against the stored hash a second time with the literal
    // "admin" plaintext — same hash matching means the row still carries
    // the migration's bootstrap value.
    let must_change_default_password = bcrypt::verify(DEFAULT_ADMIN_PASSWORD, &user.2)
        .unwrap_or(false);
    let body = LoginResponse {
        token: token.clone(),
        username: user.1,
        expires_in: ADMIN_TOKEN_TTL_SECS as u64,
        must_change_default_password,
    };

    let mut response = (StatusCode::OK, Json(body)).into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, build_login_cookie(&token));
    Ok(response)
}

/// Body for `POST /admin/password`.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    /// Current password (verified server-side before applying the new
    /// one — guards against a hijacked-session change).
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordResponse {
    pub username: String,
}

/// Change the authenticated admin's password.
///
/// The new password must:
///   - differ from the current password,
///   - differ from the built-in default (`admin`),
///   - be at least `MIN_ADMIN_PASSWORD_LEN` characters.
///
/// Authentication: this endpoint is gated by the `require_jwt` middleware
/// already applied to `/admin/*`, so the operator must already hold a
/// valid session cookie. The new bcrypt hash is written under the same
/// `admin_users` row keyed by username.
#[utoipa::path(
    post,
    path = "/admin/password",
    request_body = ChangePasswordRequest,
    responses(
        (status = 200, description = "Password changed", body = ChangePasswordResponse),
        (status = 400, description = "New password is too weak or unchanged"),
        (status = 401, description = "Unauthorized or current password incorrect"),
    ),
    security(("bearer" = [])),
    tag = "admin-auth"
)]
pub async fn change_password(
    State(state): State<crate::state::AppState>,
    headers: HeaderMap,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<ChangePasswordResponse>, AdminError> {
    // Resolve the caller from the cookie so an admin can only change
    // *their own* password — never another user's. require_jwt has
    // already validated the JWT, but it doesn't carry the row id.
    let token = extract_admin_token(&headers)
        .ok_or_else(|| AdminError::Unauthorized("Not authenticated".into()))?;
    let claims = validate_token(&token)?;
    let username = claims.sub;

    let user = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, username, password_hash FROM admin_users WHERE username = $1 AND is_active = true",
    )
    .bind(&username)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?
    .ok_or(AdminError::Unauthorized("Account not found".into()))?;

    let current_ok = bcrypt::verify(&req.current_password, &user.2)
        .map_err(|e| AdminError::Internal(format!("Bcrypt error: {}", e)))?;
    if !current_ok {
        return Err(AdminError::Unauthorized("Current password is incorrect".into()));
    }

    if req.new_password == req.current_password {
        return Err(AdminError::BadRequest(
            "New password must differ from current password".into(),
        ));
    }
    if req.new_password == DEFAULT_ADMIN_PASSWORD {
        return Err(AdminError::BadRequest(
            "New password may not be the built-in default".into(),
        ));
    }
    if req.new_password.len() < MIN_ADMIN_PASSWORD_LEN {
        return Err(AdminError::BadRequest(format!(
            "New password must be at least {} characters",
            MIN_ADMIN_PASSWORD_LEN
        )));
    }

    let new_hash = bcrypt::hash(&req.new_password, bcrypt::DEFAULT_COST)
        .map_err(|e| AdminError::Internal(format!("Bcrypt error: {}", e)))?;
    sqlx::query("UPDATE admin_users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(user.0)
        .execute(&state.db_pool)
        .await
        .map_err(|e| AdminError::Internal(e.to_string()))?;

    Ok(Json(ChangePasswordResponse { username: user.1 }))
}

/// Admin logout.
#[utoipa::path(
    post,
    path = "/admin/logout",
    responses(
        (status = 204, description = "Logged out"),
    ),
    tag = "admin-auth"
)]
pub async fn logout() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    for c in build_clear_cookies() {
        headers.append(header::SET_COOKIE, c);
    }
    response
}

/// Current admin user (from cookie or Bearer token).
#[utoipa::path(
    get,
    path = "/admin/me",
    responses(
        (status = 200, description = "Current admin user", body = MeResponse),
        (status = 401, description = "Not authenticated"),
    ),
    security(("bearer" = [])),
    tag = "admin-auth"
)]
pub async fn me(headers: HeaderMap) -> Result<Json<MeResponse>, AdminError> {
    let token = extract_admin_token(&headers)
        .ok_or_else(|| AdminError::Unauthorized("Not authenticated".into()))?;
    let claims = validate_token(&token)?;
    Ok(Json(MeResponse {
        username: claims.sub,
    }))
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub username: String,
}

/// List all API keys
#[utoipa::path(
    get,
    path = "/admin/api-keys",
    responses(
        (status = 200, description = "List of API keys", body = Vec<ApiKeyInfo>),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn list_api_keys(
    State(state): State<crate::state::AppState>,
) -> Result<Json<Vec<ApiKeyInfo>>, AdminError> {
    let keys = sqlx::query_as::<_, crate::db::models::ApiKey>(
        "SELECT * FROM api_keys ORDER BY created_at DESC",
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?;

    let infos: Vec<ApiKeyInfo> = keys.into_iter().map(api_key_info_from_row).collect();
    Ok(Json(infos))
}

fn api_key_info_from_row(k: crate::db::models::ApiKey) -> ApiKeyInfo {
    ApiKeyInfo {
        id: k.id.to_string(),
        name: k.name,
        description: k.description,
        permissions: serde_json::from_value(k.permissions).unwrap_or_default(),
        is_active: k.is_active,
        created_at: k.created_at.to_rfc3339(),
        last_used_at: k.last_used_at.map(|t| t.to_rfc3339()),
        created_by: k.created_by,
        key_type: parse_key_type(&k.key_type),
        environment: parse_environment(&k.environment),
        key_preview: k.key_preview,
    }
}

fn parse_key_type(s: &str) -> KeyType {
    match s {
        "pk" => KeyType::Pk,
        _ => KeyType::Sk,
    }
}

fn parse_environment(s: &str) -> Environment {
    match s {
        "test" => Environment::Test,
        _ => Environment::Live,
    }
}

/// Create a new API key
#[utoipa::path(
    post,
    path = "/admin/api-keys",
    request_body = CreateApiKeyRequest,
    responses(
        (status = 200, description = "API key created", body = CreateApiKeyResponse),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn create_api_key(
    State(state): State<crate::state::AppState>,
    Json(req): Json<CreateApiKeyRequest>,
) -> Result<Json<CreateApiKeyResponse>, AdminError> {
    // Publishable keys are intended for browsers. Their only legitimate
    // permission is `verify`; refuse anything broader so an operator
    // cannot accidentally mint a browser-facing admin token.
    if req.key_type == KeyType::Pk
        && !req.permissions.iter().all(|p| p == "verify")
    {
        return Err(AdminError::BadRequest(
            "Publishable keys (pk_*) may only carry the `verify` permission".into(),
        ));
    }
    if req.permissions.is_empty() {
        return Err(AdminError::BadRequest(
            "At least one permission must be selected".into(),
        ));
    }

    let generated = api_key::generate(req.key_type, req.environment);

    let row = state
        .api_keys
        .create(
            &generated.raw,
            req.name.clone(),
            req.description.clone(),
            req.permissions.clone(),
            None,
            Some("admin-dashboard".into()),
            generated.key_type.as_str(),
            generated.environment.as_str(),
            &generated.preview,
        )
        .await
        .map_err(|e| AdminError::Internal(e.to_string()))?;

    Ok(Json(CreateApiKeyResponse {
        key: generated.raw,
        key_preview: generated.preview,
        key_type: generated.key_type,
        environment: generated.environment,
        name: row.name,
        permissions: req.permissions,
    }))
}

/// Deactivate an API key
#[utoipa::path(
    delete,
    path = "/admin/api-keys/{id}",
    params(
        ("id" = String, Path, description = "API key UUID"),
    ),
    responses(
        (status = 200, description = "Key deactivated"),
        (status = 401, description = "Unauthorized"),
        (status = 404, description = "Key not found"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn deactivate_api_key(
    State(state): State<crate::state::AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AdminError> {
    let uuid = Uuid::parse_str(&id)
        .map_err(|_| AdminError::BadRequest("Invalid UUID".to_string()))?;

    let result = sqlx::query("UPDATE api_keys SET is_active = false WHERE id = $1")
        .bind(uuid)
        .execute(&state.db_pool)
        .await
        .map_err(|e| AdminError::Internal(e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err(AdminError::NotFound("API key not found".to_string()));
    }

    Ok(Json(serde_json::json!({"success": true, "message": "API key deactivated"})))
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum AdminError {
    Unauthorized(String),
    BadRequest(String),
    NotFound(String),
    Internal(String),
}

impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AdminError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg),
            AdminError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AdminError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AdminError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        let body = serde_json::json!({"error": message});
        (status, Json(body)).into_response()
    }
}
