//! DB-backed rate-limiting middleware with configurable window and
//! max requests per identifier.

use crate::db::DbPool;
use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};

/// Rate limit configuration loaded from environment
#[derive(Clone)]
pub struct RateLimitConfig {
    pub enabled: bool,
    pub max_requests: i32,
    pub window_minutes: i64,
}

impl RateLimitConfig {
    pub fn from_env() -> Self {
        let enabled = std::env::var("RATE_LIMIT_ENABLED")
            .unwrap_or_else(|_| "true".to_string())
            .parse::<bool>()
            .unwrap_or(true);

        let max_requests = std::env::var("RATE_LIMIT_MAX_REQUESTS")
            .unwrap_or_else(|_| "100".to_string())
            .parse::<i32>()
            .unwrap_or(100);

        let window_minutes = std::env::var("RATE_LIMIT_WINDOW_MINUTES")
            .unwrap_or_else(|_| "1".to_string())
            .parse::<i64>()
            .unwrap_or(1);

        Self {
            enabled,
            max_requests,
            window_minutes,
        }
    }
}

/// Rate limiting state combining pool and config
#[derive(Clone)]
pub struct RateLimitState {
    pub pool: DbPool,
    pub config: RateLimitConfig,
}

/// Rate limiting middleware
pub struct RateLimitMiddleware;

impl RateLimitMiddleware {
    /// Check rate limit for an IP address
    pub async fn check_rate_limit(
        State(state): State<RateLimitState>,
        request: Request,
        next: Next,
    ) -> Result<Response, RateLimitError> {
        if !state.config.enabled {
            return Ok(next.run(request).await);
        }

        // Extract IP address from request
        let ip = Self::extract_ip(&request).unwrap_or_else(|| "unknown".to_string());

        // Extract endpoint path
        let endpoint = request.uri().path().to_string();

        let is_allowed = Self::check_limit(
            &state.pool,
            &ip,
            &endpoint,
            state.config.window_minutes,
            state.config.max_requests,
        )
        .await
        .map_err(|e| {
            tracing::warn!("Rate limit check failed: {}", e);
            RateLimitError::InternalError
        })?;

        if !is_allowed {
            return Err(RateLimitError::LimitExceeded);
        }

        Ok(next.run(request).await)
    }

    /// Extract IP address from request
    fn extract_ip(request: &Request) -> Option<String> {
        // Try to get from X-Forwarded-For header first (for proxies)
        if let Some(forwarded) = request.headers().get("X-Forwarded-For") {
            if let Ok(forwarded_str) = forwarded.to_str() {
                if let Some(ip) = forwarded_str.split(',').next() {
                    return Some(ip.trim().to_string());
                }
            }
        }

        // Try to get from X-Real-IP header
        if let Some(real_ip) = request.headers().get("X-Real-IP") {
            if let Ok(ip_str) = real_ip.to_str() {
                return Some(ip_str.to_string());
            }
        }

        None
    }

    /// Check if the request is within rate limits.
    /// Uses date_trunc to align window_start to minute boundaries so ON CONFLICT works.
    async fn check_limit(
        pool: &DbPool,
        identifier: &str,
        endpoint: &str,
        window_minutes: i64,
        max_requests: i32,
    ) -> Result<bool, sqlx::Error> {
        let count: (i32,) = sqlx::query_as(
            r#"
            INSERT INTO rate_limits (identifier, endpoint, request_count, window_start, window_end)
            VALUES ($1, $2, 1, date_trunc('minute', NOW()), date_trunc('minute', NOW()) + make_interval(mins => $3))
            ON CONFLICT (identifier, endpoint, window_start)
            DO UPDATE SET
                request_count = rate_limits.request_count + 1
            RETURNING request_count
            "#,
        )
        .bind(identifier)
        .bind(endpoint)
        .bind(window_minutes as i32)
        .fetch_one(pool)
        .await?;

        Ok(count.0 <= max_requests)
    }
}

#[derive(Debug)]
pub enum RateLimitError {
    LimitExceeded,
    InternalError,
}

impl IntoResponse for RateLimitError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            RateLimitError::LimitExceeded => (
                StatusCode::TOO_MANY_REQUESTS,
                "Rate limit exceeded. Please try again later.".to_string(),
            ),
            RateLimitError::InternalError => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error".to_string(),
            ),
        };

        let body = serde_json::json!({
            "error": message,
        });

        (status, axum::Json(body)).into_response()
    }
}
