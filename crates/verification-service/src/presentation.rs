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

#![allow(dead_code)] // intentional API surface / serde fields
use crate::state::AppState;
use axum::{
    Json,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{RwLock, mpsc};
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
    /// Last verifier→holder `request` message (full JSON text).
    /// Replayed to a holder that rejoins after a transport drop so a
    /// phone whose screen locked mid-flow resumes instead of failing.
    buffered_request: Option<String>,
    /// Last holder→verifier terminal message (`response` /
    /// `proof_failed` / `predicate_not_satisfied` / `consent_denied`).
    /// Replayed to a verifier that rejoins after the holder finished
    /// proving while the verifier was away.
    buffered_terminal: Option<String>,
    /// OpenID4VP §6 DCQL query — set by the verifier at session
    /// creation; surfaced on `GET /openid4vp/request/{id}` so external
    /// wallets fetching the Request Object can solve it.
    dcql_query: Option<crate::dcql::DcqlRequest>,
    /// Display name surfaced to the holder. Defaults to the verifier
    /// host if absent.
    verifier_name: Option<String>,
    /// Expected KB-JWT `aud` for every credential in the response.
    /// Defaults to `client_id` (the response_uri) when absent.
    audience: Option<String>,
}

/// Result of registering a socket for a role on `connect()`.
enum ConnectOutcome {
    /// Role slot was free; socket registered. `replay` is a buffered
    /// message to send to this socket right after registration.
    Connected {
        both_connected: bool,
        replay: Option<String>,
    },
    /// Role slot already holds a live socket — a genuine double-connect.
    AlreadyConnected,
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
    pub async fn create(
        &self,
        ttl_secs: u64,
        dcql_query: Option<crate::dcql::DcqlRequest>,
        verifier_name: Option<String>,
        audience: Option<String>,
    ) -> (String, String) {
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
            buffered_request: None,
            buffered_terminal: None,
            dcql_query,
            verifier_name,
            audience,
        };

        self.sessions.write().await.insert(id.clone(), session);
        (id, nonce)
    }

    /// Snapshot the OpenID4VP request data for the given session id.
    /// Returns `None` when the session is missing or expired.
    pub async fn get_request_data(&self, session_id: &str) -> Option<SessionRequestData> {
        let sessions = self.sessions.read().await;
        let s = sessions.get(session_id)?;
        if s.expires_at < Instant::now() {
            return None;
        }
        Some(SessionRequestData {
            nonce: s.nonce.clone(),
            dcql_query: s.dcql_query.clone(),
            verifier_name: s.verifier_name.clone(),
            audience: s.audience.clone(),
        })
    }

    /// Register a WebSocket connection for a role.
    ///
    /// `both_connected` is true once both roles hold a live socket.
    /// `replay` carries a buffered message destined for the joining
    /// role (the verifier's `request` for a rejoining holder, the
    /// holder's terminal message for a rejoining verifier) so a
    /// reconnect after a transport drop resumes the flow.
    async fn connect(
        &self,
        session_id: &str,
        role: &str,
        tx: mpsc::Sender<String>,
    ) -> Result<ConnectOutcome, PresentationError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or(PresentationError::NotFound)?;

        if session.expires_at < Instant::now() {
            return Err(PresentationError::Expired);
        }

        let replay: Option<String>;
        match role {
            "holder" => {
                if session.holder_tx.is_some() {
                    return Ok(ConnectOutcome::AlreadyConnected);
                }
                session.holder_tx = Some(tx);
                session.state = if session.verifier_tx.is_some() {
                    SessionState::BothConnected
                } else {
                    SessionState::HolderConnected
                };
                replay = session.buffered_request.clone();
            }
            "verifier" => {
                if session.verifier_tx.is_some() {
                    return Ok(ConnectOutcome::AlreadyConnected);
                }
                session.verifier_tx = Some(tx);
                session.state = if session.holder_tx.is_some() {
                    SessionState::BothConnected
                } else {
                    SessionState::VerifierConnected
                };
                replay = session.buffered_terminal.clone();
            }
            _ => return Err(PresentationError::BadRequest("Invalid role".into())),
        }

        Ok(ConnectOutcome::Connected {
            both_connected: session.state == SessionState::BothConnected,
            replay,
        })
    }

    /// Buffer a relayed message so a peer that reconnects later can be
    /// caught up. `request` from a verifier and a terminal message from
    /// a holder are the only resumable points in the protocol.
    async fn buffer_message(
        &self,
        session_id: &str,
        sender_role: &str,
        msg_type: &str,
        text: &str,
    ) {
        let mut sessions = self.sessions.write().await;
        let Some(session) = sessions.get_mut(session_id) else {
            return;
        };
        match (sender_role, msg_type) {
            ("verifier", "request") => session.buffered_request = Some(text.to_string()),
            ("holder", "response")
            | ("holder", "proof_failed")
            | ("holder", "predicate_not_satisfied")
            | ("holder", "consent_denied") => session.buffered_terminal = Some(text.to_string()),
            _ => {}
        }
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

    /// Consume a presentation-session nonce as a one-shot challenge.
    ///
    /// Used by `/verify` to accept tokens whose challenge was the nonce
    /// from a presentation session (instead of one minted by
    /// `GET /verify/challenge`). Returns true if a non-expired session
    /// with this nonce existed; the session is then removed so the same
    /// nonce can't be replayed.
    pub async fn consume_nonce(&self, nonce: &str) -> bool {
        let mut sessions = self.sessions.write().await;
        let now = Instant::now();
        let to_remove = sessions
            .iter()
            .find(|(_, s)| s.nonce == nonce && s.expires_at > now)
            .map(|(id, _)| id.clone());
        if let Some(id) = to_remove {
            sessions.remove(&id);
            true
        } else {
            false
        }
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
                "holder" => {
                    session.holder_tx = None;
                }
                "verifier" => {
                    session.verifier_tx = None;
                }
                _ => {}
            }
        }
    }
}

// ---------------------------------------------------------------------------
// REST: Create Session
// ---------------------------------------------------------------------------

/// Snapshot of OpenID4VP request data attached to a presentation
/// session — surfaced on `GET /openid4vp/request/{session_id}` for
/// external wallets that bootstrap via the OID4VP 1.0 §5 flow.
#[derive(Debug, Clone)]
pub struct SessionRequestData {
    pub nonce: String,
    pub dcql_query: Option<crate::dcql::DcqlRequest>,
    pub verifier_name: Option<String>,
    pub audience: Option<String>,
}

#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePresentationRequest {
    /// Optional OpenID4VP §6 DCQL query the holder should solve.
    /// Surfaced to external wallets via `GET /openid4vp/request/{id}`.
    /// OwlID's own holder app receives the same query over the
    /// presentation WebSocket; both paths converge on `/openid4vp/response`.
    #[serde(default)]
    pub dcql: Option<crate::dcql::DcqlRequest>,
    /// Display name shown on the holder's consent screen.
    #[serde(default)]
    pub verifier_name: Option<String>,
    /// Expected KB-JWT `aud` — defaults to the response_uri when absent.
    #[serde(default)]
    pub audience: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreatePresentationResponse {
    session_id: String,
    ws_url: String,
    nonce: String,
    expires_in: u64,
    /// Absolute URL of the OpenID4VP 1.0 §5 Request Object — external
    /// wallets `GET` this to learn `response_uri`, `dcql_query`, `nonce`.
    request_uri: String,
    /// `openid4vp://?request_uri=...` deeplink — a standard wallet
    /// scans this as a QR and follows the Request Object flow.
    openid4vp_uri: String,
    /// Absolute URL of the OpenID4VP `direct_post` response endpoint.
    response_uri: String,
}

#[utoipa::path(
    post,
    path = "/presentation/sessions",
    request_body = CreatePresentationRequest,
    responses(
        (status = 200, description = "Presentation session created", body = CreatePresentationResponse),
    ),
    tag = "presentation"
)]
pub async fn create_session(
    State(state): State<AppState>,
    body: Option<Json<CreatePresentationRequest>>,
) -> Json<CreatePresentationResponse> {
    // 30 minutes — generous on purpose: a presentation can span
    // several on-chain predicate attestations (each relay ~a minute)
    // plus mobile screen-off gaps the WS-recovery path rejoins across.
    let ttl = 1800;
    let req = body.map(|b| b.0).unwrap_or_default();
    let (session_id, nonce) = state
        .presentations
        .create(ttl, req.dcql, req.verifier_name, req.audience)
        .await;

    let base = state.verification_public_url.trim_end_matches('/');
    let request_uri = format!("{base}/openid4vp/request/{session_id}");
    let response_uri = format!("{base}/openid4vp/response");
    let openid4vp_uri = format!(
        "openid4vp://?request_uri={}",
        urlencoding_minimal(&request_uri)
    );
    let ws_url = format!("/ws/presentation/{}", session_id);

    Json(CreatePresentationResponse {
        session_id,
        ws_url,
        nonce,
        expires_in: ttl,
        request_uri,
        response_uri,
        openid4vp_uri,
    })
}

/// Minimal percent-encoding for `request_uri` values embedded in an
/// `openid4vp://` deeplink. Only encodes the chars OpenID4VP requires
/// (RFC 3986 reserved set within a query value) — `&`, `=`, `#`, ` `, `?`.
fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("%26"),
            '=' => out.push_str("%3D"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            ' ' => out.push_str("%20"),
            _ => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// WebSocket: Session Relay
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct WsSessionQuery {
    role: String,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
}

pub async fn ws_presentation(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<WsSessionQuery>,
) -> Result<impl IntoResponse, PresentationError> {
    let role = query.role.clone();
    if role != "holder" && role != "verifier" {
        return Err(PresentationError::BadRequest(
            "role must be 'holder' or 'verifier'".into(),
        ));
    }

    if role == "verifier" {
        let Some(api_key) = query.api_key.as_deref().filter(|k| !k.trim().is_empty()) else {
            return Err(PresentationError::Unauthorized);
        };
        let key = state
            .api_keys
            .find_by_key(api_key)
            .await
            .map_err(|_| PresentationError::Unauthorized)?;
        if !key.is_valid() || !key.has_permission("verify") {
            return Err(PresentationError::Unauthorized);
        }
        let api_keys = Arc::clone(&state.api_keys);
        let key_id = key.id;
        tokio::spawn(async move {
            let _ = api_keys.update_last_used(key_id).await;
        });
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
    let (both_connected, replay) = match store.connect(&session_id, &role, tx).await {
        Ok(ConnectOutcome::Connected {
            both_connected,
            replay,
        }) => (both_connected, replay),
        Ok(ConnectOutcome::AlreadyConnected) => {
            let err = serde_json::json!({"type": "error", "payload": {"code": "invalid_session", "message": "Role already connected"}});
            let _ = socket.send(Message::Text(err.to_string().into())).await;
            return;
        }
        Err(_) => {
            let err = serde_json::json!({"type": "error", "payload": {"code": "invalid_session", "message": "Session not found or expired"}});
            let _ = socket.send(Message::Text(err.to_string().into())).await;
            return;
        }
    };

    // If both sides are now connected, notify both. The payload
    // carries the session nonce so the verifier can drop it from the
    // QR (and the compact `OWLP1:` engagement doesn't need to ship it
    // at all). The nonce was already known to the holder from the
    // create-session REST response.
    if both_connected {
        let nonce = store.get_nonce(&session_id).await.unwrap_or_default();
        let ready = serde_json::json!({
            "type": "session_ready",
            "payload": { "nonce": nonce }
        })
        .to_string();
        // Send to peer
        if let Some(peer_tx) = store.get_peer_tx(&session_id, &role).await {
            let _ = peer_tx.send(ready.clone()).await;
        }
        // Send to self
        let _ = socket.send(Message::Text(ready.into())).await;
    }

    // Replay the buffered message destined for this role. On a rejoin
    // after a transport drop this catches the socket up — e.g. the
    // verifier gets the `response` the holder sent while it was away.
    if let Some(buffered) = replay {
        let _ = socket.send(Message::Text(buffered.into())).await;
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

                            // Validate message type for role.
                            //
                            // `predicate_not_satisfied` and `proof_failed`
                            // are normal terminal outcomes the holder can
                            // emit instead of `response`. Keeping `error`
                            // here covers transport-level failures only.
                            let valid = match role.as_str() {
                                "verifier" => msg_type == "request",
                                "holder" => {
                                    msg_type == "response"
                                        || msg_type == "consent_denied"
                                        || msg_type == "predicate_not_satisfied"
                                        || msg_type == "proof_failed"
                                        || msg_type == "error"
                                }
                                _ => false,
                            };

                            if valid {
                                // Buffer resumable messages so a peer
                                // that reconnects later is caught up.
                                store.buffer_message(&session_id, &role, msg_type, text.as_str()).await;
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

    // Notify the peer with a SOFT notice — the session survives until
    // `expires_at`, so the peer can keep waiting for a rejoin instead
    // of hard-failing. `disconnect()` frees this role slot for rejoin.
    if let Some(peer_tx) = store.get_peer_tx(&session_id, &role).await {
        let notice = serde_json::json!({"type": "peer_disconnected", "payload": null});
        let _ = peer_tx.send(notice.to_string()).await;
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
    Unauthorized,
    BadRequest(String),
}

impl IntoResponse for PresentationError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            PresentationError::NotFound => (StatusCode::NOT_FOUND, "Session not found"),
            PresentationError::Expired => (StatusCode::GONE, "Session expired"),
            PresentationError::Unauthorized => {
                (StatusCode::UNAUTHORIZED, "Invalid or expired API key")
            }
            PresentationError::BadRequest(ref m) => (StatusCode::BAD_REQUEST, m.as_str()),
        };
        let body = serde_json::json!({"error": msg});
        (status, Json(body)).into_response()
    }
}
