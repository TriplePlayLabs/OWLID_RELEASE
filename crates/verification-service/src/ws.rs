//! WebSocket endpoint that broadcasts revocation events to clients.
//! Clients can optionally filter by issuer public key.

#![allow(dead_code)] // intentional API surface / serde fields
use crate::state::AppState;
use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

/// Revocation event broadcast to WebSocket clients
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevocationEvent {
    /// Type of event: "revoked", "suspended", "reactivated"
    pub event: String,
    /// SD-JWT VC credential_id of the affected credential
    pub credential_id: String,
    /// Issuer public key (hex)
    pub issuer_public_key: String,
    /// Unix timestamp
    pub timestamp: i64,
    /// Optional reason
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Shared state for WebSocket revocation broadcasting
#[derive(Clone)]
pub struct RevocationBroadcaster {
    sender: broadcast::Sender<RevocationEvent>,
}

impl RevocationBroadcaster {
    /// Create a new broadcaster with the specified channel capacity
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        RevocationBroadcaster { sender }
    }

    /// Broadcast a revocation event to all connected clients
    pub fn broadcast(&self, event: RevocationEvent) {
        // Ignore send errors (no receivers connected)
        let _ = self.sender.send(event);
    }

    /// Subscribe to revocation events
    pub fn subscribe(&self) -> broadcast::Receiver<RevocationEvent> {
        self.sender.subscribe()
    }
}

/// Query parameters for filtering WebSocket events
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    /// Optional issuer public key to filter events
    #[serde(default)]
    pub issuer: Option<String>,
}

/// WebSocket endpoint handler for revocation events
pub async fn ws_revocations(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    let broadcaster = Arc::clone(&state.broadcaster);
    ws.on_upgrade(move |socket| handle_ws(socket, broadcaster, query.issuer))
}

/// Handle an individual WebSocket connection
async fn handle_ws(
    mut socket: WebSocket,
    broadcaster: Arc<RevocationBroadcaster>,
    filter_issuer: Option<String>,
) {
    let mut rx = broadcaster.subscribe();

    loop {
        tokio::select! {
            // Forward broadcast events to the client
            result = rx.recv() => {
                match result {
                    Ok(event) => {
                        // Apply issuer filter if specified
                        if let Some(ref filter) = filter_issuer {
                            if &event.issuer_public_key != filter {
                                continue;
                            }
                        }

                        match serde_json::to_string(&event) {
                            Ok(json) => {
                                if socket.send(Message::Text(json.into())).await.is_err() {
                                    break; // Client disconnected
                                }
                            }
                            Err(_) => continue,
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Client fell behind, send a warning
                        let warning = serde_json::json!({
                            "warning": format!("Missed {} events", n)
                        });
                        let _ = socket.send(Message::Text(warning.to_string().into())).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // Handle client messages (ping/pong, close)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    _ => {} // Ignore other messages
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// System event stream — every audit-logged action, live.
// ---------------------------------------------------------------------------

/// One system event pushed to `/ws/events` subscribers. Mirrors the
/// `AuditEventInfo` shape returned by `GET /admin/audit-events` so the
/// admin dashboard renders the live feed and the polled trail the same way.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEvent {
    id: String,
    event_type: String,
    entity_type: String,
    entity_id: String,
    actor: Option<String>,
    occurred_at: String,
}

/// WebSocket endpoint streaming every audit event as it is logged.
pub async fn ws_events(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let rx = state.audit.subscribe();
    ws.on_upgrade(move |socket| handle_events_ws(socket, rx))
}

async fn handle_events_ws(
    mut socket: WebSocket,
    mut rx: broadcast::Receiver<crate::db::models::AuditEvent>,
) {
    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(ev) => {
                        let dto = SystemEvent {
                            id: ev.id.to_string(),
                            event_type: ev.event_type,
                            entity_type: ev.entity_type,
                            entity_id: ev.entity_id,
                            actor: ev.actor,
                            occurred_at: ev.occurred_at.to_rfc3339(),
                        };
                        match serde_json::to_string(&dto) {
                            Ok(json) => {
                                if socket.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => continue,
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        let warning = serde_json::json!({
                            "warning": format!("Missed {} events", n)
                        });
                        let _ = socket.send(Message::Text(warning.to_string().into())).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    _ => {}
                }
            }
        }
    }
}
