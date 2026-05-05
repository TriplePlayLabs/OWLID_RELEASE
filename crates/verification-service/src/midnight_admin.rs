//! Admin endpoints for the Midnight integration: read status, flip the
//! runtime-enabled flag, and persist the flip in `system_settings` so it
//! survives restarts.
//!
//! Status is gathered live (sidecar health probe) every call rather than
//! cached, since the sidecar can flap independently of the verification
//! service. The cost is a single HTTP round-trip per `/admin/midnight/status`
//! request — fine at the polling cadence of the admin dashboard.

use crate::db::SystemSettingsRepository;
use crate::db::repositories::system_settings::keys;
use crate::middleware::auth::Principal;
use crate::state::AppState;
use axum::{
    extract::{Extension, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MidnightStatus {
    /// Runtime flag: true if the sidecar gate is open.
    pub enabled: bool,
    /// Whether the service has a sidecar client at all (configured at boot).
    /// `false` means the service was started without a sidecar URL — the
    /// admin toggle is inert until the operator restarts with one.
    pub configured: bool,
    /// Sidecar health probe outcome.
    pub sidecar: SidecarHealth,
    /// Sidecar base URL the service is pointed at.
    pub sidecar_url: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidecarHealth {
    /// `true` if the sidecar responded; `false` if HTTP failed.
    pub reachable: bool,
    /// `true` if the sidecar reports it is connected to the chain.
    pub connected: Option<bool>,
    /// Round-trip latency of the health probe, in milliseconds.
    pub latency_ms: Option<u64>,
    /// Error message when reachable=false. Generic — no internal stack.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToggleResponse {
    pub enabled: bool,
}

/// Get current status of the Midnight integration.
#[utoipa::path(
    get,
    path = "/admin/midnight/status",
    operation_id = "getMidnightStatus",
    responses(
        (status = 200, description = "Midnight integration status", body = MidnightStatus),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn get_midnight_status(
    State(state): State<AppState>,
) -> Result<Json<MidnightStatus>, MidnightAdminError> {
    let (enabled, configured, sidecar_url, sidecar) = match &state.midnight {
        Some(client) => {
            let started = Instant::now();
            let probe = client.health_check().await;
            let latency_ms = started.elapsed().as_millis() as u64;
            let sidecar = match probe {
                Ok(connected) => SidecarHealth {
                    reachable: true,
                    connected: Some(connected),
                    latency_ms: Some(latency_ms),
                    error: None,
                },
                Err(e) => SidecarHealth {
                    reachable: false,
                    connected: None,
                    latency_ms: None,
                    // Sidecar errors are operator-facing and don't leak
                    // user data, but keep the shape consistent.
                    error: Some(e.to_string()),
                },
            };
            (
                client.is_enabled(),
                true,
                Some(client.base_url().to_string()),
                sidecar,
            )
        }
        None => (
            false,
            false,
            None,
            SidecarHealth {
                reachable: false,
                connected: None,
                latency_ms: None,
                error: Some("Midnight sidecar not configured at boot".to_string()),
            },
        ),
    };

    Ok(Json(MidnightStatus {
        enabled,
        configured,
        sidecar,
        sidecar_url,
    }))
}

/// Enable the Midnight integration.
#[utoipa::path(
    post,
    path = "/admin/midnight/enable",
    operation_id = "enableMidnight",
    responses(
        (status = 200, description = "Integration enabled", body = ToggleResponse),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
        (status = 503, description = "Sidecar not configured"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn enable_midnight(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ToggleResponse>, MidnightAdminError> {
    set_runtime(&state, true, &principal).await?;
    Ok(Json(ToggleResponse { enabled: true }))
}

/// Disable the Midnight integration.
#[utoipa::path(
    post,
    path = "/admin/midnight/disable",
    operation_id = "disableMidnight",
    responses(
        (status = 200, description = "Integration disabled", body = ToggleResponse),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
    ),
    security(("bearer" = [])),
    tag = "admin"
)]
pub async fn disable_midnight(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ToggleResponse>, MidnightAdminError> {
    set_runtime(&state, false, &principal).await?;
    Ok(Json(ToggleResponse { enabled: false }))
}

async fn set_runtime(
    state: &AppState,
    enabled: bool,
    principal: &Principal,
) -> Result<(), MidnightAdminError> {
    let client = state
        .midnight
        .as_ref()
        .ok_or(MidnightAdminError::NotConfigured)?;

    // Persist first so a crash mid-flip leaves the DB as the authoritative
    // intent. The in-memory flip on the next line is then idempotent.
    let updated_by = match principal {
        Principal::AdminSession { username, .. } => Some(username.clone()),
        Principal::ApiKey(k) => Some(format!("api_key:{}", k.id)),
    };
    let repo = SystemSettingsRepository::new(state.db_pool.clone());
    repo.set(
        keys::MIDNIGHT_ENABLED,
        serde_json::json!(enabled),
        updated_by.as_deref(),
    )
    .await
    .map_err(|e| MidnightAdminError::Internal(e.to_string()))?;

    client.set_enabled(enabled);

    Ok(())
}

#[derive(Debug)]
pub enum MidnightAdminError {
    NotConfigured,
    Internal(String),
}

impl IntoResponse for MidnightAdminError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            MidnightAdminError::NotConfigured => (
                StatusCode::SERVICE_UNAVAILABLE,
                "Midnight sidecar was not configured at service boot — set MIDNIGHT_SIDECAR_URL and restart"
                    .to_string(),
            ),
            MidnightAdminError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}
