//! SSE consumer for the Midnight sidecar's /events stream.
//!
//! Spawns a background tokio task that holds an SSE connection open to
//! the sidecar. Each frame is a JSON line emitted by
//! `packages/midnight-sidecar/src/events.ts`. We mirror them into the
//! local repositories so /verify can answer revocation/trust questions
//! out of Postgres + the in-memory cache without a sidecar round-trip.
//!
//! On connect the sidecar replays a snapshot of every currently-known
//! entry; that primes the cache after a service restart. The tail then
//! delivers live updates. On disconnect we sleep and reconnect.
//!
//! Failures are logged and the loop survives — local cache remains
//! authoritative until the stream resumes.
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::Value as JsonValue;

use crate::state::AppState;

const RECONNECT_DELAY: Duration = Duration::from_secs(5);
const TOPICS: &str = "revocation,issuer,attestation";

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    // The sidecar wire uses `rootHash` because that's the Compact
    // contract's internal name for the 32-byte slot. The slot value we
    // pass is the SD-JWT VC credential_id.
    Revocation {
        #[serde(rename = "rootHash")]
        credential_id: String,
        status: String,
        #[serde(rename = "issuerKeyHash")]
        issuer_key_hash: String,
        reason: Option<String>,
    },
    Issuer {
        #[serde(rename = "publicKey")]
        public_key: String,
        status: String,
        name: String,
    },
    Attestation {
        #[serde(rename = "attestKey")]
        attest_key: String,
    },
    // Identity registry events are not mirrored locally — they're
    // consumed by holder/wallet flows, not the verifier service. We
    // still deserialize the variant so unknown payloads don't break
    // the SSE consumer.
    Identity(IgnoredAny),
}

pub fn spawn(state: Arc<AppState>) {
    let midnight = state.midnight.clone();
    let url = midnight.base_url().to_string();
    let api_key = std::env::var("MIDNIGHT_SIDECAR_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        tracing::warn!(
            "MIDNIGHT_SIDECAR_API_KEY unset — cannot subscribe to sidecar /events; \
             revocations will only update via the legacy push API"
        );
        return;
    }

    tokio::spawn(async move {
        loop {
            match consume(&state, &url, &api_key).await {
                Ok(()) => tracing::warn!("sidecar SSE stream ended; reconnecting"),
                Err(e) => tracing::warn!("sidecar SSE error: {e}; reconnecting"),
            }
            tokio::time::sleep(RECONNECT_DELAY).await;
        }
    });
}

async fn consume(
    state: &Arc<AppState>,
    base_url: &str,
    api_key: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "{}/events?topics={}",
        base_url.trim_end_matches('/'),
        TOPICS
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(api_key)
        .header("Accept", "text/event-stream")
        .send()
        .await?
        .error_for_status()?;

    tracing::info!("Subscribed to sidecar SSE: {}", url);

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk?;
        buf.push_str(std::str::from_utf8(&bytes)?);
        while let Some(idx) = buf.find("\n\n") {
            let frame: String = buf.drain(..idx + 2).collect();
            if let Some(data) = parse_sse_data(&frame) {
                match serde_json::from_str::<Event>(&data) {
                    Ok(event) => handle(state, event).await,
                    Err(e) => tracing::debug!("ignoring non-event SSE frame: {e}"),
                }
            }
        }
    }
    Ok(())
}

fn parse_sse_data(frame: &str) -> Option<String> {
    let mut data = String::new();
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    if data.is_empty() { None } else { Some(data) }
}

async fn handle(state: &Arc<AppState>, event: Event) {
    match event {
        Event::Revocation {
            credential_id,
            status,
            issuer_key_hash,
            reason,
        } => match status.as_str() {
            "REVOKED" => match state
                .revocations
                .revoke(credential_id.clone(), issuer_key_hash, reason, None)
                .await
            {
                Ok(_) => tracing::info!("[sse] revoked {}", credential_id),
                Err(e) => tracing::warn!("[sse] revoke {} failed: {}", credential_id, e),
            },
            "SUSPENDED" => match state
                .revocations
                .suspend(credential_id.clone(), issuer_key_hash, reason)
                .await
            {
                Ok(_) => tracing::info!("[sse] suspended {}", credential_id),
                Err(e) => tracing::warn!("[sse] suspend {} failed: {}", credential_id, e),
            },
            "ACTIVE" => {
                // reactivate is a no-op when the row doesn't exist
                if let Err(e) = state.revocations.reactivate(&credential_id).await {
                    tracing::debug!("[sse] reactivate {} skipped: {}", credential_id, e);
                }
            }
            other => tracing::warn!("[sse] unknown revocation status: {other}"),
        },
        Event::Issuer {
            public_key,
            status,
            name,
        } => match status.as_str() {
            "ACTIVE" => match state
                .issuers
                .add(public_key.clone(), name, None, None, None, JsonValue::Null)
                .await
            {
                Ok(_) => tracing::info!("[sse] issuer active {}", public_key),
                Err(e) => tracing::warn!("[sse] issuer upsert {} failed: {}", public_key, e),
            },
            "DEACTIVATED" | "INACTIVE" => {
                match state.issuers.get_by_public_key(&public_key).await {
                    Ok(issuer) => {
                        if let Err(e) = state.issuers.update_status(issuer.id, false).await {
                            tracing::warn!("[sse] issuer deactivate {} failed: {}", public_key, e);
                        }
                    }
                    Err(_) => {
                        tracing::debug!("[sse] deactivate event for unknown issuer {}", public_key);
                    }
                }
            }
            other => tracing::warn!("[sse] unknown issuer status: {other}"),
        },
        Event::Identity(_) => {
            // Identity registry events are not mirrored locally — they're
            // consumed by holder/wallet flows, not the verifier service.
        }
        Event::Attestation { attest_key } => {
            match state.attestations.record(attest_key.clone()).await {
                Ok(()) => tracing::info!("[sse] attested {}", attest_key),
                Err(e) => tracing::warn!("[sse] attest {} failed: {}", attest_key, e),
            }
        }
    }
}
