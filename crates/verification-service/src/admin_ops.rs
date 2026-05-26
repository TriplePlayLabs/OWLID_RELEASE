//! Operator-facing read/management endpoints for the admin dashboard:
//! the audit trail and admin-user accounts. Both are dashboard-local
//! concerns backed by Postgres — the chain remains the source of truth
//! for trust and revocation, this is the operator's own bookkeeping.

#![allow(dead_code)] // intentional API surface / serde fields

use crate::admin_auth::AdminError;
use crate::middleware::auth::Principal;
use axum::{
    Json,
    extract::{Extension, Path, Query, State},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MIN_ADMIN_PASSWORD_LEN: usize = 12;

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventInfo {
    id: String,
    event_type: String,
    entity_type: String,
    entity_id: String,
    actor: Option<String>,
    occurred_at: String,
    #[schema(value_type = Object)]
    metadata: serde_json::Value,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    /// Max rows to return. Clamped to [1, 500]; defaults to 100.
    limit: Option<i64>,
    /// Filter to a single entity type (`issuer`, `revocation`, `api_key`, …).
    entity_type: Option<String>,
    /// Filter to a single event type (`credential_revoked`, …).
    event_type: Option<String>,
}

/// List recent audit events, newest first.
#[utoipa::path(
    get,
    path = "/admin/audit-events",
    params(AuditQuery),
    responses(
        (status = 200, description = "Recent audit events", body = Vec<AuditEventInfo>),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn list_audit_events(
    State(state): State<crate::state::AppState>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<AuditEventInfo>>, AdminError> {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);

    let rows = sqlx::query_as::<_, crate::db::models::AuditEvent>(
        r#"
        SELECT * FROM audit_events
        WHERE ($1::text IS NULL OR entity_type = $1)
          AND ($2::text IS NULL OR event_type = $2)
        ORDER BY occurred_at DESC
        LIMIT $3
        "#,
    )
    .bind(q.entity_type.as_deref())
    .bind(q.event_type.as_deref())
    .bind(limit)
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?;

    let events = rows
        .into_iter()
        .map(|e| AuditEventInfo {
            id: e.id.to_string(),
            event_type: e.event_type,
            entity_type: e.entity_type,
            entity_id: e.entity_id,
            actor: e.actor,
            occurred_at: e.occurred_at.to_rfc3339(),
            metadata: e.metadata,
        })
        .collect();

    Ok(Json(events))
}

// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserInfo {
    id: String,
    username: String,
    is_active: bool,
    created_at: String,
    last_login_at: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateAdminUserRequest {
    username: String,
    password: String,
}

#[derive(sqlx::FromRow)]
struct AdminUserRow {
    id: Uuid,
    username: String,
    is_active: bool,
    created_at: chrono::DateTime<chrono::Utc>,
    last_login_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl From<AdminUserRow> for AdminUserInfo {
    fn from(r: AdminUserRow) -> Self {
        AdminUserInfo {
            id: r.id.to_string(),
            username: r.username,
            is_active: r.is_active,
            created_at: r.created_at.to_rfc3339(),
            last_login_at: r.last_login_at.map(|t| t.to_rfc3339()),
        }
    }
}

/// List admin dashboard accounts.
#[utoipa::path(
    get,
    path = "/admin/users",
    responses(
        (status = 200, description = "Admin users", body = Vec<AdminUserInfo>),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn list_admin_users(
    State(state): State<crate::state::AppState>,
) -> Result<Json<Vec<AdminUserInfo>>, AdminError> {
    let rows = sqlx::query_as::<_, AdminUserRow>(
        "SELECT id, username, is_active, created_at, last_login_at \
         FROM admin_users ORDER BY created_at ASC",
    )
    .fetch_all(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?;

    Ok(Json(rows.into_iter().map(AdminUserInfo::from).collect()))
}

/// Create a new admin dashboard account. The new account holds the same
/// full operator surface as every other admin until per-user permissions
/// land.
#[utoipa::path(
    post,
    path = "/admin/users",
    request_body = CreateAdminUserRequest,
    responses(
        (status = 200, description = "Admin user created", body = AdminUserInfo),
        (status = 400, description = "Invalid username or weak password"),
        (status = 401, description = "Unauthorized"),
        (status = 409, description = "Username already taken"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn create_admin_user(
    State(state): State<crate::state::AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<CreateAdminUserRequest>,
) -> Result<Json<AdminUserInfo>, AdminError> {
    let username = req.username.trim();
    if username.is_empty() || username.len() > 50 {
        return Err(AdminError::BadRequest(
            "Username must be 1–50 characters".into(),
        ));
    }
    if req.password.len() < MIN_ADMIN_PASSWORD_LEN {
        return Err(AdminError::BadRequest(format!(
            "Password must be at least {MIN_ADMIN_PASSWORD_LEN} characters"
        )));
    }

    let exists: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM admin_users WHERE username = $1")
            .bind(username)
            .fetch_optional(&state.db_pool)
            .await
            .map_err(|e| AdminError::Internal(e.to_string()))?;
    if exists.is_some() {
        return Err(AdminError::Conflict("Username already taken".into()));
    }

    let hash = bcrypt::hash(&req.password, bcrypt::DEFAULT_COST)
        .map_err(|e| AdminError::Internal(format!("Bcrypt error: {e}")))?;

    let row = sqlx::query_as::<_, AdminUserRow>(
        "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) \
         RETURNING id, username, is_active, created_at, last_login_at",
    )
    .bind(username)
    .bind(&hash)
    .fetch_one(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?;

    let _ = state
        .audit
        .log_event(
            "admin_user_created".to_string(),
            "admin_user".to_string(),
            row.id.to_string(),
            Some(actor_name(&principal)),
            &format!("Admin account created: {}", row.username),
            serde_json::json!({ "username": row.username }),
        )
        .await;

    Ok(Json(row.into()))
}

/// Best-effort display name for the calling operator.
fn actor_name(principal: &Principal) -> String {
    match principal {
        Principal::AdminSession { username, .. } => username.clone(),
        Principal::ApiKey(_) => "api".to_string(),
    }
}

/// Deactivate an admin account. Refuses to deactivate the caller's own
/// account or the last remaining active account, so the dashboard can
/// never be locked out.
#[utoipa::path(
    delete,
    path = "/admin/users/{id}",
    params(("id" = String, Path, description = "Admin user UUID")),
    responses(
        (status = 200, description = "Account deactivated"),
        (status = 400, description = "Cannot deactivate self or the last active account"),
        (status = 401, description = "Unauthorized"),
        (status = 404, description = "Account not found"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn deactivate_admin_user(
    State(state): State<crate::state::AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AdminError> {
    let uuid =
        Uuid::parse_str(&id).map_err(|_| AdminError::BadRequest("Invalid UUID".into()))?;

    let target = sqlx::query_as::<_, AdminUserRow>(
        "SELECT id, username, is_active, created_at, last_login_at \
         FROM admin_users WHERE id = $1",
    )
    .bind(uuid)
    .fetch_optional(&state.db_pool)
    .await
    .map_err(|e| AdminError::Internal(e.to_string()))?
    .ok_or_else(|| AdminError::NotFound("Account not found".into()))?;

    if let Principal::AdminSession { username, .. } = &principal {
        if *username == target.username {
            return Err(AdminError::BadRequest(
                "You cannot deactivate your own account".into(),
            ));
        }
    }

    let active_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM admin_users WHERE is_active = true")
            .fetch_one(&state.db_pool)
            .await
            .map_err(|e| AdminError::Internal(e.to_string()))?;
    if active_count.0 <= 1 {
        return Err(AdminError::BadRequest(
            "Cannot deactivate the last active admin account".into(),
        ));
    }

    let result = sqlx::query("UPDATE admin_users SET is_active = false WHERE id = $1")
        .bind(uuid)
        .execute(&state.db_pool)
        .await
        .map_err(|e| AdminError::Internal(e.to_string()))?;
    if result.rows_affected() == 0 {
        return Err(AdminError::NotFound("Account not found".into()));
    }

    let _ = state
        .audit
        .log_event(
            "admin_user_deactivated".to_string(),
            "admin_user".to_string(),
            target.id.to_string(),
            Some(actor_name(&principal)),
            &format!("Admin account deactivated: {}", target.username),
            serde_json::json!({ "username": target.username }),
        )
        .await;

    Ok(Json(serde_json::json!({"success": true})))
}
