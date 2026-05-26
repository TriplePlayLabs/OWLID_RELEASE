//! Lightweight in-memory IP-keyed rate limiter for issuer-service routes.
//!
//! Persisted rate-limit state lives in the verification-service Postgres
//! schema. Issuer-service's primary store is in-memory today, so rather
//! than introduce a new migration, we use a `RwLock<HashMap>` per process.
//! Replace this with a DB-backed limiter when the service moves to
//! multi-replica deployment.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct RateLimitConfig {
    pub enabled: bool,
    pub window: Duration,
    pub max_requests: u32,
}

impl RateLimitConfig {
    pub fn from_env() -> Self {
        let enabled = std::env::var("RATE_LIMIT_ENABLED")
            .ok()
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(true);
        let max_requests = std::env::var("RATE_LIMIT_MAX_REQUESTS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(60);
        let window_secs = std::env::var("RATE_LIMIT_WINDOW_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);
        Self {
            enabled,
            window: Duration::from_secs(window_secs),
            max_requests,
        }
    }
}

#[derive(Clone, Default)]
pub struct InMemoryRateLimiter {
    inner: Arc<RwLock<HashMap<String, Window>>>,
    config: RateLimitConfig,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            window: Duration::from_secs(60),
            max_requests: 60,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Window {
    started: Instant,
    count: u32,
}

impl InMemoryRateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            config,
        }
    }

    /// Returns `true` when the caller is still within the limit; `false`
    /// when the request should be rejected.
    pub async fn check(&self, key: &str) -> bool {
        if !self.config.enabled {
            return true;
        }
        let now = Instant::now();
        let mut guard = self.inner.write().await;
        let entry = guard.entry(key.to_string()).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.saturating_duration_since(entry.started) > self.config.window {
            entry.started = now;
            entry.count = 0;
        }
        entry.count = entry.count.saturating_add(1);
        entry.count <= self.config.max_requests
    }
}

pub async fn rate_limit(
    State(limiter): State<InMemoryRateLimiter>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, RateLimitError> {
    let key = client_key(&headers, &request).unwrap_or_else(|| "unknown".to_string());
    let path = request.uri().path().to_string();
    let composite = format!("{}|{}", key, path);
    if !limiter.check(&composite).await {
        return Err(RateLimitError::LimitExceeded);
    }
    Ok(next.run(request).await)
}

fn client_key(headers: &HeaderMap, request: &Request) -> Option<String> {
    if let Some(forwarded) = headers.get("x-forwarded-for")
        && let Ok(text) = forwarded.to_str()
        && let Some(first) = text.split(',').next()
    {
        let trimmed = first.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(real) = headers.get("x-real-ip")
        && let Ok(text) = real.to_str()
    {
        return Some(text.to_string());
    }
    request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().to_string())
}

#[derive(Debug)]
pub enum RateLimitError {
    LimitExceeded,
}

impl IntoResponse for RateLimitError {
    fn into_response(self) -> Response {
        (
            StatusCode::TOO_MANY_REQUESTS,
            axum::Json(serde_json::json!({ "error": "Rate limit exceeded" })),
        )
            .into_response()
    }
}
