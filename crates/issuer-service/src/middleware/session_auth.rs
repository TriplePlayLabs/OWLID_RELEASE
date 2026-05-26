//! Per-session bearer-token middleware.
//!
//! Routes layered with this middleware require an `Authorization: Bearer
//! <token>` header where the token matches the `session_token` minted on
//! `POST /sessions`. The session id is parsed from the URI path: today the
//! middleware covers `/sessions/{id}/...` and `/polling/{id}`.

use crate::database::IdpDatabase;
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct SessionAuthenticated {
    pub session_id: Uuid,
}

pub async fn validate_session_bearer(
    State(db): State<Arc<IdpDatabase>>,
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Result<Response, SessionAuthError> {
    let session_id = extract_session_id(request.uri().path()).ok_or(SessionAuthError::BadPath)?;
    let token = extract_bearer(&headers).ok_or(SessionAuthError::MissingToken)?;

    let session = db
        .get_session(session_id)
        .await
        .map_err(|_| SessionAuthError::NotFound)?
        .ok_or(SessionAuthError::NotFound)?;

    if !constant_time_eq(token.as_bytes(), session.session_token.as_bytes()) {
        return Err(SessionAuthError::InvalidToken);
    }

    request
        .extensions_mut()
        .insert(SessionAuthenticated { session_id });
    Ok(next.run(request).await)
}

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// Pull the UUID directly after `sessions/` or `polling/` in the path.
fn extract_session_id(path: &str) -> Option<Uuid> {
    let mut segments = path.split('/').filter(|s| !s.is_empty());
    while let Some(seg) = segments.next() {
        if seg == "sessions" || seg == "polling" {
            return segments.next().and_then(|raw| Uuid::parse_str(raw).ok());
        }
    }
    None
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Debug)]
pub enum SessionAuthError {
    BadPath,
    MissingToken,
    InvalidToken,
    NotFound,
}

impl IntoResponse for SessionAuthError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            SessionAuthError::BadPath => (
                StatusCode::BAD_REQUEST,
                "Session id missing from path".to_string(),
            ),
            SessionAuthError::MissingToken => (
                StatusCode::UNAUTHORIZED,
                "Missing Authorization: Bearer header".to_string(),
            ),
            SessionAuthError::InvalidToken => (
                StatusCode::UNAUTHORIZED,
                "Session bearer token mismatch".to_string(),
            ),
            SessionAuthError::NotFound => (StatusCode::NOT_FOUND, "Session not found".to_string()),
        };
        (status, axum::Json(serde_json::json!({ "error": message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_session_id_from_sessions_path() {
        let id = Uuid::new_v4();
        let p = format!("/sessions/{}/issue", id);
        assert_eq!(extract_session_id(&p), Some(id));
    }

    #[test]
    fn extracts_session_id_from_polling_path() {
        let id = Uuid::new_v4();
        let p = format!("/polling/{}", id);
        assert_eq!(extract_session_id(&p), Some(id));
    }

    #[test]
    fn rejects_unrelated_path() {
        assert!(extract_session_id("/health").is_none());
        assert!(extract_session_id("/sessions/not-a-uuid").is_none());
    }
}
