use crate::db::{models::Revocation, DatabaseError, DbPool, Result};
use chrono::Utc;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;

/// In-memory cache for revocation status (for sync checking)
pub struct RevocationCache {
    revoked_hashes: Arc<RwLock<HashSet<String>>>,
}

impl RevocationCache {
    pub fn new() -> Self {
        Self {
            revoked_hashes: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub async fn add(&self, hash: String) {
        let mut hashes = self.revoked_hashes.write().await;
        hashes.insert(hash);
    }

    pub async fn remove(&self, hash: &str) {
        let mut hashes = self.revoked_hashes.write().await;
        hashes.remove(hash);
    }

    pub fn is_revoked(&self, hash: &str) -> bool {
        // Try to get read lock without blocking
        if let Ok(hashes) = self.revoked_hashes.try_read() {
            hashes.contains(hash)
        } else {
            // If we can't get the lock, assume not revoked (fail open)
            // In production you'd log this
            false
        }
    }
}

impl Default for RevocationCache {
    fn default() -> Self {
        Self::new()
    }
}

pub struct RevocationRepository {
    pool: DbPool,
    cache: RevocationCache,
}

impl RevocationRepository {
    pub fn new(pool: DbPool) -> Self {
        Self {
            pool,
            cache: RevocationCache::new(),
        }
    }

    /// Initialize the cache by loading all revoked/suspended credentials from the database
    pub async fn initialize_cache(&self) -> Result<()> {
        let revocations = sqlx::query_as::<_, Revocation>(
            r#"
            SELECT * FROM revocations
            WHERE status IN ('revoked', 'suspended')
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        for revocation in revocations {
            self.cache.add(revocation.credential_id).await;
        }

        Ok(())
    }

    /// Get the cache for sync revocation checking
    pub fn cache(&self) -> &RevocationCache {
        &self.cache
    }

    /// Revoke a credential
    pub async fn revoke(
        &self,
        credential_id: String,
        issuer_public_key: String,
        reason: Option<String>,
        expires_at: Option<chrono::DateTime<Utc>>,
    ) -> Result<Revocation> {
        let revocation = sqlx::query_as::<_, Revocation>(
            r#"
            INSERT INTO revocations (credential_id, issuer_public_key, status, reason, revoked_at, expires_at)
            VALUES ($1, $2, 'revoked', $3, NOW(), $4)
            ON CONFLICT (credential_id)
            DO UPDATE SET
                status = 'revoked',
                reason = EXCLUDED.reason,
                revoked_at = NOW(),
                updated_at = NOW()
            RETURNING *
            "#,
        )
        .bind(&credential_id)
        .bind(&issuer_public_key)
        .bind(&reason)
        .bind(&expires_at)
        .fetch_one(&self.pool)
        .await?;

        // Update cache
        self.cache.add(credential_id).await;

        Ok(revocation)
    }

    /// Suspend a credential
    pub async fn suspend(
        &self,
        credential_id: String,
        issuer_public_key: String,
        reason: Option<String>,
    ) -> Result<Revocation> {
        let revocation = sqlx::query_as::<_, Revocation>(
            r#"
            INSERT INTO revocations (credential_id, issuer_public_key, status, reason, suspended_at)
            VALUES ($1, $2, 'suspended', $3, NOW())
            ON CONFLICT (credential_id)
            DO UPDATE SET
                status = 'suspended',
                reason = EXCLUDED.reason,
                suspended_at = NOW(),
                updated_at = NOW()
            RETURNING *
            "#,
        )
        .bind(&credential_id)
        .bind(&issuer_public_key)
        .bind(&reason)
        .fetch_one(&self.pool)
        .await?;

        // Update cache
        self.cache.add(credential_id).await;

        Ok(revocation)
    }

    /// Reactivate a credential
    pub async fn reactivate(&self, credential_id: &str) -> Result<Revocation> {
        let revocation = sqlx::query_as::<_, Revocation>(
            r#"
            UPDATE revocations
            SET status = 'active',
                reactivated_at = NOW(),
                updated_at = NOW()
            WHERE credential_id = $1
            RETURNING *
            "#,
        )
        .bind(credential_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            DatabaseError::NotFound(format!("Credential not found: {}", credential_id))
        })?;

        // Update cache
        self.cache.remove(credential_id).await;

        Ok(revocation)
    }

    /// Check revocation status
    pub async fn check_status(&self, credential_id: &str) -> Result<Option<String>> {
        let status: Option<(String,)> = sqlx::query_as(
            r#"
            SELECT status FROM revocations
            WHERE credential_id = $1
            "#,
        )
        .bind(credential_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(status.map(|s| s.0))
    }

    /// Get revocation details
    pub async fn get(&self, credential_id: &str) -> Result<Revocation> {
        let revocation = sqlx::query_as::<_, Revocation>(
            r#"
            SELECT * FROM revocations
            WHERE credential_id = $1
            "#,
        )
        .bind(credential_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            DatabaseError::NotFound(format!("Credential not found: {}", credential_id))
        })?;

        Ok(revocation)
    }

    /// List all revocations
    pub async fn list(&self, status_filter: Option<String>) -> Result<Vec<Revocation>> {
        let revocations = if let Some(status) = status_filter {
            sqlx::query_as::<_, Revocation>(
                r#"
                SELECT * FROM revocations
                WHERE status = $1
                ORDER BY updated_at DESC
                "#,
            )
            .bind(status)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query_as::<_, Revocation>(
                r#"
                SELECT * FROM revocations
                ORDER BY updated_at DESC
                "#,
            )
            .fetch_all(&self.pool)
            .await?
        };

        Ok(revocations)
    }

    /// List revocations by issuer
    pub async fn list_by_issuer(&self, issuer_public_key: &str) -> Result<Vec<Revocation>> {
        let revocations = sqlx::query_as::<_, Revocation>(
            r#"
            SELECT * FROM revocations
            WHERE issuer_public_key = $1
            ORDER BY updated_at DESC
            "#,
        )
        .bind(issuer_public_key)
        .fetch_all(&self.pool)
        .await?;

        Ok(revocations)
    }

    /// Clean up expired revocations (GDPR compliance)
    pub async fn cleanup_expired(&self) -> Result<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM revocations
            WHERE expires_at IS NOT NULL AND expires_at < NOW()
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected())
    }
}

// Implement RevocationChecker trait for the cache
impl owl_proof_system::revocation::RevocationChecker for RevocationCache {
    fn is_revoked(&self, root_hash: &str) -> bool {
        self.is_revoked(root_hash)
    }
}
