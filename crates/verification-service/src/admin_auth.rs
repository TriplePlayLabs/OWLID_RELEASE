//! Admin authentication and API key management.
//!
//! Provides username/password login with JWT tokens,
//! and CRUD operations for API keys.

use crate::db::ApiKeyRepository;
use axum::{
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/// JWT secret — in production, load from env/secrets manager
fn jwt_secret() -> String {
    std::env::var("ADMIN_JWT_SECRET").unwrap_or_else(|_| "owlid-admin-jwt-secret-change-me".to_string())
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String, // username
    exp: usize,  // expiry (epoch seconds)
    iat: usize,  // issued at
}

fn create_token(username: &str) -> Result<String, AdminError> {
    let now = Utc::now();
    let exp = (now + Duration::hours(24)).timestamp() as usize;
    let claims = Claims {
        sub: username.to_string(),
        exp,
        iat: now.timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(jwt_secret().as_bytes()),
    )
    .map_err(|e| AdminError::Internal(format!("JWT creation failed: {}", e)))
}

fn validate_token(token: &str) -> Result<Claims, AdminError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret().as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| AdminError::Unauthorized("Invalid or expired token".to_string()))
}

// ---------------------------------------------------------------------------
// JWT Middleware
// ---------------------------------------------------------------------------

/// Middleware that requires a valid JWT Bearer token.
/// Applied to all /admin/* routes except /admin/login.
pub async fn require_jwt(headers: HeaderMap, request: Request, next: Next) -> Result<Response, AdminError> {
    let auth_header = headers
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or(AdminError::Unauthorized("Missing Authorization header".to_string()))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(AdminError::Unauthorized("Invalid Authorization format (use Bearer)".to_string()))?;

    validate_token(token)?;
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
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CreateApiKeyRequest {
    name: String,
    #[serde(default)]
    description: Option<String>,
    permissions: Vec<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CreateApiKeyResponse {
    /// The raw API key — shown ONCE, never stored again
    key: String,
    name: String,
    permissions: Vec<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInfo {
    id: String,
    name: String,
    description: Option<String>,
    permissions: serde_json::Value,
    is_active: bool,
    created_at: String,
    last_used_at: Option<String>,
    created_by: Option<String>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Admin login — validate username/password, return JWT
#[utoipa::path(
    post,
    path = "/admin/login",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Login successful", body = LoginResponse),
        (status = 401, description = "Invalid credentials"),
    ),
    tag = "admin"
)]
pub async fn login(
    State(state): State<crate::state::AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AdminError> {
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

    // Create JWT
    let token = create_token(&user.1)?;

    Ok(Json(LoginResponse {
        token,
        username: user.1,
        expires_in: 86400, // 24 hours
    }))
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
    let keys = sqlx::query_as::<_, (Uuid, String, Option<String>, serde_json::Value, bool, chrono::DateTime<Utc>, Option<chrono::DateTime<Utc>>, Option<String>)>(
        "SELECT id, name, description, permissions, is_active, created_at, last_used_at, created_by FROM api_keys ORDER BY created_at DESC",
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?;

    let infos: Vec<ApiKeyInfo> = keys
        .into_iter()
        .map(|k| ApiKeyInfo {
            id: k.0.to_string(),
            name: k.1,
            description: k.2,
            permissions: k.3,
            is_active: k.4,
            created_at: k.5.to_rfc3339(),
            last_used_at: k.6.map(|t| t.to_rfc3339()),
            created_by: k.7,
        })
        .collect();

    Ok(Json(infos))
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
    // Generate a random 32-byte key
    use rand::RngCore;
    let mut key_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key_bytes);
    let raw_key = hex::encode(key_bytes);

    // Hash it
    let key_hash = ApiKeyRepository::hash_key(&raw_key);
    let permissions_json = serde_json::to_value(&req.permissions)
        .map_err(|e| AdminError::Internal(e.to_string()))?;

    sqlx::query(
        "INSERT INTO api_keys (key_hash, name, description, permissions, created_by) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&key_hash)
    .bind(&req.name)
    .bind(&req.description)
    .bind(&permissions_json)
    .bind(Some("admin-dashboard"))
    .execute(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?;

    Ok(Json(CreateApiKeyResponse {
        key: raw_key,
        name: req.name,
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
