//! Presentation session management and WebSocket relay.
//!
//! Implements ISO 18013-5 style credential presentation:
//! 1. Holder creates a session (gets session ID + nonce)
//! 2. Holder shows QR with session info
//! 3. Verifier scans QR, connects to WS
//! 4. Verifier sends request (what they want to verify)
//! 5. Holder sees consent, approves with biometric
//! 6. Holder sends proof over WS
//! 7. Verifier receives proof and verifies

use crate::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Session Store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum SessionState {
    Created,
    HolderConnected,
    VerifierConnected,
    BothConnected,
    Complete,
}

struct Session {
    id: String,
    nonce: String,
    state: SessionState,
    created_at: Instant,
    expires_at: Instant,
    holder_tx: Option<mpsc::Sender<String>>,
    verifier_tx: Option<mpsc::Sender<String>>,
}

pub struct PresentationSessionStore {
    sessions: RwLock<HashMap<String, Session>>,
}

impl PresentationSessionStore {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Create a new presentation session. Returns (session_id, nonce).
    pub async fn create(&self, ttl_secs: u64) -> (String, String) {
        let id = Uuid::new_v4().to_string();
        let nonce = hex::encode(rand::random::<[u8; 16]>());
        let now = Instant::now();

        let session = Session {
            id: id.clone(),
            nonce: nonce.clone(),
            state: SessionState::Created,
            created_at: now,
            expires_at: now + Duration::from_secs(ttl_secs),
            holder_tx: None,
            verifier_tx: None,
        };

        self.sessions.write().await.insert(id.clone(), session);
        (id, nonce)
    }

    /// Register a WebSocket connection for a role. Returns false if role already taken.
    async fn connect(&self, session_id: &str, role: &str, tx: mpsc::Sender<String>) -> Result<bool, PresentationError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get_mut(session_id)
            .ok_or(PresentationError::NotFound)?;

        if session.expires_at < Instant::now() {
            return Err(PresentationError::Expired);
        }

        match role {
            "holder" => {
                if session.holder_tx.is_some() {
                    return Ok(false); // Already connected
                }
                session.holder_tx = Some(tx);
                session.state = if session.verifier_tx.is_some() {
                    SessionState::BothConnected
                } else {
                    SessionState::HolderConnected
                };
            }
            "verifier" => {
                if session.verifier_tx.is_some() {
                    return Ok(false);
                }
                session.verifier_tx = Some(tx);
                session.state = if session.holder_tx.is_some() {
                    SessionState::BothConnected
                } else {
                    SessionState::VerifierConnected
                };
            }
            _ => return Err(PresentationError::BadRequest("Invalid role".into())),
        }

        Ok(session.state == SessionState::BothConnected)
    }

    /// Get the sender for the opposite role
    async fn get_peer_tx(&self, session_id: &str, my_role: &str) -> Option<mpsc::Sender<String>> {
        let sessions = self.sessions.read().await;
        let session = sessions.get(session_id)?;
        match my_role {
            "holder" => session.verifier_tx.clone(),
            "verifier" => session.holder_tx.clone(),
            _ => None,
        }
    }

    /// Get the session nonce
    pub async fn get_nonce(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).map(|s| s.nonce.clone())
    }

    /// Remove expired sessions
    pub async fn cleanup(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        let before = sessions.len();
        let now = Instant::now();
        sessions.retain(|_, s| s.expires_at > now);
        before - sessions.len()
    }

    /// Disconnect a role from a session
    async fn disconnect(&self, session_id: &str, role: &str) {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            match role {
                "holder" => { session.holder_tx = None; }
                "verifier" => { session.verifier_tx = None; }
                _ => {}
            }
        }
    }
}

// ---------------------------------------------------------------------------
// REST: Create Session
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePresentationResponse {
    session_id: String,
    ws_url: String,
    nonce: String,
    expires_in: u64,
}

#[utoipa::path(
    post,
    path = "/presentation/sessions",
    responses(
        (status = 200, description = "Presentation session created", body = CreatePresentationResponse),
    ),
    tag = "presentation"
)]
pub async fn create_session(
    State(state): State<AppState>,
) -> Json<CreatePresentationResponse> {
    let ttl = 300; // 5 minutes
    let (session_id, nonce) = state.presentations.create(ttl).await;

    // Build WS URL relative to the service
    let ws_url = format!("/ws/presentation/{}", session_id);

    Json(CreatePresentationResponse {
        session_id,
        ws_url,
        nonce,
        expires_in: ttl,
    })
}

// ---------------------------------------------------------------------------
// WebSocket: Session Relay
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct WsSessionQuery {
    role: String,
}

pub async fn ws_presentation(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<WsSessionQuery>,
) -> Result<impl IntoResponse, PresentationError> {
    let role = query.role.clone();
    if role != "holder" && role != "verifier" {
        return Err(PresentationError::BadRequest("role must be 'holder' or 'verifier'".into()));
    }

    // Verify session exists
    if state.presentations.get_nonce(&session_id).await.is_none() {
        return Err(PresentationError::NotFound);
    }

    let presentations = Arc::clone(&state.presentations);
    let sid = session_id.clone();

    Ok(ws.on_upgrade(move |socket| handle_presentation_ws(socket, presentations, sid, role)))
}

async fn handle_presentation_ws(
    mut socket: WebSocket,
    store: Arc<PresentationSessionStore>,
    session_id: String,
    role: String,
) {
    // Create channel for receiving messages from the peer
    let (tx, mut rx) = mpsc::channel::<String>(32);

    // Register this connection
    let both_connected = match store.connect(&session_id, &role, tx).await {
        Ok(both) => both,
        Err(_) => {
            let err = serde_json::json!({"type": "error", "payload": {"code": "invalid_session", "message": "Session not found or expired"}});
            let _ = socket.send(Message::Text(err.to_string().into())).await;
            return;
        }
    };

    // If both sides are now connected, notify both
    if both_connected {
        let ready = serde_json::json!({"type": "session_ready", "payload": null}).to_string();
        // Send to peer
        if let Some(peer_tx) = store.get_peer_tx(&session_id, &role).await {
            let _ = peer_tx.send(ready.clone()).await;
        }
        // Send to self
        let _ = socket.send(Message::Text(ready.into())).await;
    }

    // Message relay loop
    loop {
        tokio::select! {
            // Messages from peer (via channel)
            Some(msg) = rx.recv() => {
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            // Messages from this client's WebSocket
            ws_msg = socket.recv() => {
                match ws_msg {
                    Some(Ok(Message::Text(text))) => {
                        // Validate and relay to peer
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                            let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

                            // Validate message type for role
                            let valid = match role.as_str() {
                                "verifier" => msg_type == "request",
                                "holder" => msg_type == "response" || msg_type == "consent_denied",
                                _ => false,
                            };

                            if valid {
                                if let Some(peer_tx) = store.get_peer_tx(&session_id, &role).await {
                                    let _ = peer_tx.send(text.to_string()).await;
                                }
                            } else {
                                let err = serde_json::json!({"type": "error", "payload": {"code": "invalid_message", "message": format!("Role '{}' cannot send '{}'", role, msg_type)}});
                                let _ = socket.send(Message::Text(err.to_string().into())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    // Notify peer of disconnection
    if let Some(peer_tx) = store.get_peer_tx(&session_id, &role).await {
        let err = serde_json::json!({"type": "error", "payload": {"code": "transport_error", "message": "Peer disconnected"}});
        let _ = peer_tx.send(err.to_string()).await;
    }

    store.disconnect(&session_id, &role).await;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum PresentationError {
    NotFound,
    Expired,
    BadRequest(String),
}

impl IntoResponse for PresentationError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PresentationError::NotFound => (StatusCode::NOT_FOUND, "Session not found"),
            PresentationError::Expired => (StatusCode::GONE, "Session expired"),
            PresentationError::BadRequest(ref m) => (StatusCode::BAD_REQUEST, m.as_str()),
        };
        let body = serde_json::json!({"error": msg});
        (status, Json(body)).into_response()
    }
}
