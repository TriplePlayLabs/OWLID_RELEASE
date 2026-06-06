//! Admin endpoint for the Midnight integration: read live status.
//!
//! Midnight is required (the service refuses to start without a reachable
//! sidecar), so there is no enable/disable toggle — only a health probe
//! the admin dashboard polls. Status is gathered live every call rather
//! than cached, since the sidecar can flap independently of this service.
//! Cost: one HTTP round-trip per `/admin/midnight/status` request.

use crate::state::AppState;
use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use std::time::Instant;

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MidnightStatus {
    /// Sidecar health probe outcome.
    pub sidecar: SidecarHealth,
    /// Sidecar base URL the service is pointed at.
    pub sidecar_url: String,
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
    /// Error message when `reachable` is false. Generic — no internal stack.
    pub error: Option<String>,
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
    let client = &state.midnight;
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
            error: Some(e.to_string()),
        },
    };
    Ok(Json(MidnightStatus {
        sidecar,
        sidecar_url: client.base_url().to_string(),
    }))
}

#[derive(Debug)]
pub enum MidnightAdminError {
    #[allow(dead_code)] // reserved error path; constructed once admin ops land
    Internal(String),
}

impl IntoResponse for MidnightAdminError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match self {
            MidnightAdminError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, Json(serde_json::json!({"error": msg}))).into_response()
    }
}
