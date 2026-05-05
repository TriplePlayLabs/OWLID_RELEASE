//! T-020: Observability stack
//!
//! Prometheus metrics and request correlation IDs.

use axum::{
    extract::Request,
    http::HeaderValue,
    middleware::Next,
    response::Response,
};
use metrics::{counter, histogram};
use std::time::Instant;
use uuid::Uuid;

/// Middleware that adds a correlation ID to each request and records metrics
pub async fn correlation_and_metrics(request: Request, next: Next) -> Response {
    let correlation_id = request
        .headers()
        .get("x-correlation-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let method = request.method().to_string();
    let path = request.uri().path().to_string();

    let start = Instant::now();
    let mut response = next.run(request).await;
    let duration = start.elapsed();

    // Add correlation ID to response
    if let Ok(val) = HeaderValue::from_str(&correlation_id) {
        response.headers_mut().insert("x-correlation-id", val);
    }

    // Record metrics
    let status = response.status().as_u16().to_string();
    counter!("http_requests_total", "method" => method.clone(), "path" => path.clone(), "status" => status).increment(1);
    histogram!("http_request_duration_seconds", "method" => method, "path" => path).record(duration.as_secs_f64());

    response
}

/// Initialize the Prometheus metrics recorder
/// Returns the handle for rendering metrics
pub fn init_metrics() -> metrics_exporter_prometheus::PrometheusHandle {
    let builder = metrics_exporter_prometheus::PrometheusBuilder::new();
    builder
        .install_recorder()
        .expect("Failed to install Prometheus recorder")
}

/// Render Prometheus metrics as text
pub async fn prometheus_metrics(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
) -> String {
    state.metrics_handle.render()
}

/// Record a credential issuance
pub fn record_credential_issued() {
    counter!("credentials_issued_total").increment(1);
}

/// Record a token verification
pub fn record_token_verified(success: bool, duration_secs: f64) {
    let status = if success { "success" } else { "failure" };
    counter!("tokens_verified_total", "result" => status).increment(1);
    histogram!("token_verification_duration_seconds").record(duration_secs);
}

/// Record a credential revocation
pub fn record_credential_revoked() {
    counter!("credentials_revoked_total").increment(1);
}

/// Record a credential suspension
pub fn record_credential_suspended() {
    counter!("credentials_suspended_total").increment(1);
}

/// Record a credential reactivation
pub fn record_credential_reactivated() {
    counter!("credentials_reactivated_total").increment(1);
}

/// Record a challenge replay rejection
pub fn record_challenge_replay() {
    counter!("challenge_replay_rejected_total").increment(1);
}
