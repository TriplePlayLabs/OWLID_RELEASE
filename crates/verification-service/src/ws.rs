//! T-018: WebSocket push for real-time revocation notifications
//!
//! Provides a WebSocket endpoint that broadcasts revocation events to connected clients.
//! Clients can optionally filter by issuer public key.

use crate::state::AppState;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
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
    /// Root hash of the affected credential
    pub root_hash: String,
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
