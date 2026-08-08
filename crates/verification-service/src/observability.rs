//! Prometheus metrics and request correlation IDs.

#![allow(dead_code)] // intentional API surface / serde fields
use axum::{extract::Request, http::HeaderValue, middleware::Next, response::Response};
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
    // The ROUTE PATTERN, never the raw URI. Labelling by `uri().path()` mints a
    // new time series per distinct path, so internet scanners probing `/.env`,
    // `/.git/config`, `/wp-json/...` grow the registry without bound — a memory
    // leak any anonymous client can drive. `MatchedPath` is the registered
    // pattern (`/sessions/{id}`), so cardinality is capped by the route table.
    // Unrouted requests (404s, the scanner traffic) collapse into one series.
    let path = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "<unmatched>".to_string());

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
    histogram!("http_request_duration_seconds", "method" => method, "path" => path)
        .record(duration.as_secs_f64());

    response
}

/// Initialize the Prometheus metrics recorder
/// Returns the handle for rendering metrics
pub fn init_metrics() -> metrics_exporter_prometheus::PrometheusHandle {
    // Emit histograms (`_bucket` series), not the default summaries. Summaries
    // expose pre-computed `quantile=` labels that cannot be re-aggregated
    // across instances, so `histogram_quantile()` over them yields nothing —
    // which is why the shipped Grafana latency panels rendered empty.
    // Buckets are seconds, sized for HTTP handlers that mostly finish in
    // milliseconds but tail into the multi-second Midnight transaction path.
    const LATENCY_BUCKETS: &[f64] = &[
        0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0,
    ];
    metrics_exporter_prometheus::PrometheusBuilder::new()
        .set_buckets(LATENCY_BUCKETS)
        .expect("latency buckets must be non-empty")
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
