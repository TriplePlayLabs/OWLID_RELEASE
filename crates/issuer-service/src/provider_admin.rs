//! Operator endpoints to enable / disable identity providers at runtime.
//!
//! Persistence: `provider_settings` table (default behaviour for missing
//! rows is "enabled"). Each flip is also reflected in
//! `ProviderRegistry`'s in-memory disabled set so subsequent
//! `start_verification` requests see the new state without a restart.

use crate::admin_auth::AdminPrincipal;
use owl_issuer_service::{db::ProviderSettingsRepository, ProviderRegistry};
use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct ProviderAdminState {
    pub registry: Arc<RwLock<ProviderRegistry>>,
    pub db_pool: PgPool,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToggleResponse {
    pub provider_id: String,
    pub enabled: bool,
}

/// Enable a previously disabled provider.
#[utoipa::path(
    post,
    path = "/admin/providers/{id}/enable",
    operation_id = "enableProvider",
    params(("id" = String, Path, description = "Provider ID")),
    responses(
        (status = 200, description = "Provider enabled", body = ProviderToggleResponse),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Admin permission required"),
        (status = 404, description = "Unknown provider"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn enable_provider(
    State(state): State<ProviderAdminState>,
    Extension(principal): Extension<AdminPrincipal>,
    Path(id): Path<String>,
) -> Result<Json<ProviderToggleResponse>, ProviderAdminError> {
    set_enabled(&state, &id, true, &principal).await?;
    Ok(Json(ProviderToggleResponse {
        provider_id: id,
        enabled: true,
    }))
}

/// Disable a provider. Subsequent session-creation requests against it
/// fail closed.
#[utoipa::path(
    post,
    path = "/admin/providers/{id}/disable",
    operation_id = "disableProvider",
    params(("id" = String, Path, description = "Provider ID")),
    responses(
        (status = 200, description = "Provider disabled", body = ProviderToggleResponse),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Admin permission required"),
        (status = 404, description = "Unknown provider"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn disable_provider(
    State(state): State<ProviderAdminState>,
    Extension(principal): Extension<AdminPrincipal>,
    Path(id): Path<String>,
) -> Result<Json<ProviderToggleResponse>, ProviderAdminError> {
    set_enabled(&state, &id, false, &principal).await?;
    Ok(Json(ProviderToggleResponse {
        provider_id: id,
        enabled: false,
    }))
}

async fn set_enabled(
    state: &ProviderAdminState,
    provider_id: &str,
    enabled: bool,
    principal: &AdminPrincipal,
) -> Result<(), ProviderAdminError> {
    {
        let registry = state.registry.read().await;
        if !registry.contains(provider_id) {
            return Err(ProviderAdminError::NotFound);
        }
    }

    // Persist first so a crash mid-flip leaves the DB as the source of
    // truth; the in-memory flip below is then idempotent on next boot.
    let repo = ProviderSettingsRepository::new(state.db_pool.clone());
    repo.set(provider_id, enabled, Some(&principal.username))
        .await
        .map_err(|e| ProviderAdminError::Internal(e.to_string()))?;

    let registry = state.registry.read().await;
    registry.set_enabled(provider_id, enabled);
    Ok(())
}

#[derive(Debug)]
pub enum ProviderAdminError {
    NotFound,
    Internal(String),
}

impl IntoResponse for ProviderAdminError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            ProviderAdminError::NotFound => {
                (StatusCode::NOT_FOUND, "Unknown provider".to_string())
            }
            ProviderAdminError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}
