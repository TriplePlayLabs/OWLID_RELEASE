//! In-memory store for in-flight OIDC authorization requests.
//!
//! Keeps `{state, code_verifier, nonce, provider_id}` server-side so the
//! callback can verify the request originated here, retrieve the PKCE
//! verifier without trusting the redirect URL, and validate the
//! `id_token` `nonce` claim. Entries expire after `DEFAULT_TTL`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

pub const DEFAULT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct StoredOidcState {
    pub state: String,
    pub code_verifier: String,
    pub nonce: String,
    pub provider_id: String,
    pub created_at: Instant,
    /// When the OIDC flow was started by the session-aware `/sessions`
    /// path, the session UUID — the callback uses this to update the
    /// matching `IdpDatabase` session with the verified claims and
    /// redirect the holder back. `None` for the standalone
    /// `/auth/login/{provider}` flow.
    pub session_id: Option<uuid::Uuid>,
}

impl StoredOidcState {
    fn is_expired(&self, ttl: Duration, now: Instant) -> bool {
        now.saturating_duration_since(self.created_at) > ttl
    }
}

#[derive(Clone)]
pub struct OidcStateStore {
    inner: Arc<RwLock<HashMap<String, StoredOidcState>>>,
    ttl: Duration,
}

impl OidcStateStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            ttl,
        }
    }

    pub async fn insert(&self, entry: StoredOidcState) {
        let mut guard = self.inner.write().await;
        guard.insert(entry.state.clone(), entry);
    }

    /// Read the entry for `state` without removing it. Returns `None`
    /// when the entry is missing or expired (expired rows are evicted
    /// as a side-effect). Use when you need to inspect the entry
    /// before deciding which code path consumes it.
    pub async fn peek(&self, state: &str) -> Option<StoredOidcState> {
        let now = Instant::now();
        let mut guard = self.inner.write().await;
        let expired = guard
            .get(state)
            .map(|e| e.is_expired(self.ttl, now))
            .unwrap_or(false);
        if expired {
            guard.remove(state);
            return None;
        }
        guard.get(state).cloned()
    }

    /// Pop the entry for `state`, removing it. Returns `None` when the entry
    /// is missing or expired (and the expired row is evicted as a side-effect).
    pub async fn take(&self, state: &str) -> Option<StoredOidcState> {
        let now = Instant::now();
        let mut guard = self.inner.write().await;
        let entry = guard.remove(state)?;
        if entry.is_expired(self.ttl, now) {
            return None;
        }
        Some(entry)
    }

    /// Remove every expired entry. Cheap to run on a timer.
    pub async fn cleanup(&self) -> usize {
        let now = Instant::now();
        let mut guard = self.inner.write().await;
        let before = guard.len();
        guard.retain(|_, v| !v.is_expired(self.ttl, now));
        before - guard.len()
    }
}

impl Default for OidcStateStore {
    fn default() -> Self {
        Self::new(DEFAULT_TTL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(state: &str) -> StoredOidcState {
        StoredOidcState {
            state: state.into(),
            code_verifier: "v".into(),
            nonce: "n".into(),
            provider_id: "p".into(),
            created_at: Instant::now(),
            session_id: None,
        }
    }

    #[tokio::test]
    async fn take_consumes_entry() {
        let store = OidcStateStore::new(Duration::from_secs(60));
        store.insert(entry("abc")).await;
        assert!(store.take("abc").await.is_some());
        assert!(store.take("abc").await.is_none());
    }

    #[tokio::test]
    async fn expired_take_returns_none() {
        let store = OidcStateStore::new(Duration::from_millis(1));
        store.insert(entry("abc")).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(store.take("abc").await.is_none());
    }
}
