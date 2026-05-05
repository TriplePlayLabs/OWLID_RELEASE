use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use crate::db::{ApiKeyRepository, models::ApiKey};
use std::sync::Arc;

/// Authentication middleware that validates API keys
pub struct AuthMiddleware;

/// Extension to store the authenticated API key in request extensions
#[derive(Clone)]
pub struct AuthenticatedKey {
    pub api_key: ApiKey,
}

impl AuthMiddleware {
    /// Middleware function that validates API keys
    pub async fn validate(
        State(repo): State<Arc<ApiKeyRepository>>,
        headers: HeaderMap,
        mut request: Request,
        next: Next,
    ) -> Result<Response, AuthError> {
        // Extract API key from header
        let api_key_value = headers
            .get("X-API-Key")
            .and_then(|h| h.to_str().ok())
            .ok_or(AuthError::MissingApiKey)?;

        // Validate API key
        let api_key = repo
            .find_by_key(api_key_value)
            .await
            .map_err(|_| AuthError::InvalidApiKey)?;

        // Check if key is valid
        if !api_key.is_valid() {
            return Err(AuthError::InvalidApiKey);
        }

        // Update last used timestamp (fire and forget)
        let repo_clone = Arc::clone(&repo);
        let key_id = api_key.id;
        tokio::spawn(async move {
            let _ = repo_clone.update_last_used(key_id).await;
        });

        // Store authenticated key in request extensions
        request.extensions_mut().insert(AuthenticatedKey {
            api_key: api_key.clone(),
        });

        Ok(next.run(request).await)
    }

    /// Middleware that also checks for specific permission
    pub async fn validate_with_permission(
        State(repo): State<Arc<ApiKeyRepository>>,
        headers: HeaderMap,
        mut request: Request,
        next: Next,
        required_permission: &'static str,
    ) -> Result<Response, AuthError> {
        // Extract and validate API key
        let api_key_value = headers
            .get("X-API-Key")
            .and_then(|h| h.to_str().ok())
            .ok_or(AuthError::MissingApiKey)?;

        let api_key = repo
            .find_by_key(api_key_value)
            .await
            .map_err(|_| AuthError::InvalidApiKey)?;

        if !api_key.is_valid() {
            return Err(AuthError::InvalidApiKey);
        }

        // Check permission
        if !api_key.has_permission(required_permission) {
            return Err(AuthError::InsufficientPermissions(
                required_permission.to_string(),
            ));
        }

        // Update last used timestamp
        let repo_clone = Arc::clone(&repo);
        let key_id = api_key.id;
        tokio::spawn(async move {
            let _ = repo_clone.update_last_used(key_id).await;
        });

        // Store in extensions
        request.extensions_mut().insert(AuthenticatedKey {
            api_key: api_key.clone(),
        });

        Ok(next.run(request).await)
    }
}

/// Helper to create a permission-checking middleware
pub fn require_permission(permission: &'static str) -> impl Fn(
    State<Arc<ApiKeyRepository>>,
    HeaderMap,
    Request,
    Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response, AuthError>> + Send>>
       + Clone {
    move |state, headers, request, next| {
        Box::pin(async move {
            AuthMiddleware::validate_with_permission(state, headers, request, next, permission)
                .await
        })
    }
}

#[derive(Debug)]
pub enum AuthError {
    MissingApiKey,
    InvalidApiKey,
    InsufficientPermissions(String),
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AuthError::MissingApiKey => (
                StatusCode::UNAUTHORIZED,
                "Missing X-API-Key header".to_string(),
            ),
            AuthError::InvalidApiKey => (
                StatusCode::UNAUTHORIZED,
                "Invalid or expired API key".to_string(),
            ),
            AuthError::InsufficientPermissions(perm) => (
                StatusCode::FORBIDDEN,
                format!("Insufficient permissions: {} required", perm),
            ),
        };

        let body = serde_json::json!({
            "error": message,
        });

        (status, axum::Json(body)).into_response()
    }
}
