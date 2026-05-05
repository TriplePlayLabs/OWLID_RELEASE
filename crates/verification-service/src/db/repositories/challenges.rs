//! T-011: Challenge replay protection repository
//!
//! Stores hashed challenges to prevent the same challenge from being used twice.

use crate::db::{DbPool, Result};

pub struct ChallengeRepository {
    pool: DbPool,
}

impl ChallengeRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Attempt to mark a challenge as used. Returns true if the challenge was fresh
    /// (successfully inserted), false if it was already used (duplicate).
    pub async fn mark_used(&self, challenge_hash: &str, ttl_seconds: i64) -> Result<bool> {
        let result = sqlx::query(
            r#"
            INSERT INTO used_challenges (challenge_hash, used_at, expires_at)
            VALUES ($1, NOW(), NOW() + make_interval(secs => $2))
            ON CONFLICT (challenge_hash) DO NOTHING
            "#,
        )
        .bind(challenge_hash)
        .bind(ttl_seconds as i32)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Generate a server-side challenge and store it with TTL.
    /// Returns the challenge string (hex-encoded 8 random bytes = 16 hex chars).
    /// 8 bytes (2^64) is more than sufficient for single-use, 5-minute-expiry challenges.
    pub async fn generate_challenge(&self, ttl_seconds: i64) -> Result<String> {
        use rand::RngCore;
        let mut bytes = [0u8; 8];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let challenge = hex::encode(bytes);

        sqlx::query(
            r#"
            INSERT INTO pending_challenges (challenge, created_at, expires_at)
            VALUES ($1, NOW(), NOW() + make_interval(secs => $2))
            "#,
        )
        .bind(&challenge)
        .bind(ttl_seconds as f64)
        .execute(&self.pool)
        .await?;

        Ok(challenge)
    }

    /// Validate and consume a server-generated challenge.
    /// Returns true if the challenge was valid (existed, not expired, not yet used).
    pub async fn validate_server_challenge(&self, challenge: &str) -> Result<bool> {
        let result = sqlx::query(
            r#"
            UPDATE pending_challenges
            SET used = true
            WHERE challenge = $1 AND used = false AND expires_at > NOW()
            "#,
        )
        .bind(challenge)
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected() > 0)
    }

    /// Clean up expired pending challenges
    pub async fn cleanup_pending(&self) -> Result<u64> {
        let result = sqlx::query(
            "DELETE FROM pending_challenges WHERE expires_at < NOW()",
        )
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected())
    }

    /// Remove expired challenge entries
    pub async fn cleanup_expired(&self) -> Result<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM used_challenges
            WHERE expires_at < NOW()
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected())
    }
}
