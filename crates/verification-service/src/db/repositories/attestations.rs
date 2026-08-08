//! Chain-attested predicate keys, mirrored from the sidecar /events
//! SSE stream. `/verify` checks membership here instead of verifying a
//! ZK proof inline — the Midnight node already verified the proof in
//! consensus when the attest tx was processed. Postgres is the durable
//! mirror; the in-memory set is the hot-path lookup.

#![allow(dead_code)] // intentional API surface / serde fields
use crate::db::{DbPool, Result};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct AttestationCache {
    keys: Arc<RwLock<HashSet<String>>>,
}

impl AttestationCache {
    pub fn new() -> Self {
        Self {
            keys: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub async fn add(&self, key: String) {
        self.keys.write().await.insert(key);
    }

    /// Drop every cached key. Used when the authoritative on-chain
    /// snapshot is about to be replayed, so a chain reset / contract
    /// redeploy can't leave dead-chain keys reporting `attested`.
    pub async fn clear(&self) {
        self.keys.write().await.clear();
    }

    /// Hot-path membership. Fail-closed: if the lock is contended we
    /// report "not attested" so a presentation is rejected rather than
    /// wrongly accepted.
    pub fn is_attested(&self, key: &str) -> bool {
        self.keys
            .try_read()
            .map(|s| s.contains(key))
            .unwrap_or(false)
    }
}

impl Default for AttestationCache {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AttestationRepository {
    pool: DbPool,
    cache: AttestationCache,
}

impl AttestationRepository {
    pub fn new(pool: DbPool) -> Self {
        Self {
            pool,
            cache: AttestationCache::new(),
        }
    }

    pub fn cache(&self) -> &AttestationCache {
        &self.cache
    }

    /// Load all attestation keys from Postgres into the cache on boot
    /// (sidecar SSE replays a snapshot too, but this primes a cold
    /// start before the stream connects).
    pub async fn initialize_cache(&self) -> Result<()> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT attest_key FROM attested_predicates")
            .fetch_all(&self.pool)
            .await?;
        for (k,) in rows {
            self.cache.add(k).await;
        }
        Ok(())
    }

    /// Upsert one attestation key (idempotent — Set semantics on chain).
    pub async fn record(&self, attest_key: String) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO attested_predicates (attest_key)
            VALUES ($1)
            ON CONFLICT (attest_key) DO NOTHING
            "#,
        )
        .bind(&attest_key)
        .execute(&self.pool)
        .await?;
        self.cache.add(attest_key).await;
        Ok(())
    }

    pub fn is_attested(&self, attest_key: &str) -> bool {
        self.cache.is_attested(attest_key)
    }

    /// Replace the persisted mirror with the chain's current attestation
    /// set: truncate the table + clear the cache. Called when a fresh
    /// sidecar SSE stream connects (it replays an authoritative on-chain
    /// snapshot right after), so a chain reset / contract redeploy does
    /// not leave stale dead-chain keys reporting `attested = true`. Safe
    /// because a momentary miss falls through to the authoritative
    /// on-chain read-through in `/predicates/attested` and `/verify`.
    pub async fn reset(&self) -> Result<()> {
        sqlx::query("TRUNCATE attested_predicates")
            .execute(&self.pool)
            .await?;
        self.cache.clear().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The in-memory half of `AttestationRepository::reset()` (the DB half
    // is a `TRUNCATE`). A chain reset / contract redeploy must not leave
    // stale dead-chain keys reporting `attested = true`.
    #[tokio::test]
    async fn clear_drops_all_cached_keys() {
        let cache = AttestationCache::new();
        cache.add("aa".repeat(32)).await;
        cache.add("bb".repeat(32)).await;
        assert!(cache.is_attested(&"aa".repeat(32)));
        assert!(cache.is_attested(&"bb".repeat(32)));

        cache.clear().await;

        assert!(!cache.is_attested(&"aa".repeat(32)));
        assert!(!cache.is_attested(&"bb".repeat(32)));
    }

    #[test]
    fn is_attested_is_false_for_an_absent_key() {
        let cache = AttestationCache::new();
        assert!(!cache.is_attested("never-added"));
    }
}
