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
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT attest_key FROM attested_predicates")
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
}
