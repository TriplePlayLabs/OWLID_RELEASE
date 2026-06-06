#![allow(dead_code)] // intentional API surface / serde fields
use crate::db::{
    DbPool, Result,
    models::{VerificationLog, VerificationMetrics},
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

pub struct VerificationLogRepository {
    pool: DbPool,
}

impl VerificationLogRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Hash sensitive data for GDPR compliance
    fn hash_data(data: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Log a verification attempt
    #[allow(clippy::too_many_arguments)]
    pub async fn log_verification(
        &self,
        proof_data: &str,
        challenge: &str,
        issuer_public_key: Option<String>,
        verification_result: &str,
        failure_reason: Option<String>,
        verifier_id: Option<String>,
        metadata: serde_json::Value,
    ) -> Result<VerificationLog> {
        let proof_hash = Self::hash_data(proof_data);
        let challenge_hash = Self::hash_data(challenge);

        let log = sqlx::query_as::<_, VerificationLog>(
            r#"
            INSERT INTO verification_logs
                (proof_hash, challenge_hash, issuer_public_key, verification_result,
                 failure_reason, verifier_id, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            "#,
        )
        .bind(&proof_hash)
        .bind(&challenge_hash)
        .bind(&issuer_public_key)
        .bind(verification_result)
        .bind(&failure_reason)
        .bind(&verifier_id)
        .bind(&metadata)
        .fetch_one(&self.pool)
        .await?;

        Ok(log)
    }

    /// Get recent verification logs
    pub async fn get_recent(&self, limit: i64) -> Result<Vec<VerificationLog>> {
        let logs = sqlx::query_as::<_, VerificationLog>(
            r#"
            SELECT * FROM verification_logs
            ORDER BY verified_at DESC
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(logs)
    }

    /// Get logs by verifier
    pub async fn get_by_verifier(
        &self,
        verifier_id: &str,
        limit: i64,
    ) -> Result<Vec<VerificationLog>> {
        let logs = sqlx::query_as::<_, VerificationLog>(
            r#"
            SELECT * FROM verification_logs
            WHERE verifier_id = $1
            ORDER BY verified_at DESC
            LIMIT $2
            "#,
        )
        .bind(verifier_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(logs)
    }

    /// Get current metrics
    pub async fn get_current_metrics(&self) -> Result<VerificationMetrics> {
        let metrics = sqlx::query_as::<_, VerificationMetrics>(
            r#"
            SELECT
                gen_random_uuid() as id,
                COALESCE(MIN(verified_at), NOW() - INTERVAL '24 hours') as period_start,
                COALESCE(MAX(verified_at), NOW()) as period_end,
                COUNT(*) as total_verifications,
                COUNT(*) FILTER (WHERE verification_result = 'success') as successful_verifications,
                COUNT(*) FILTER (WHERE verification_result = 'failed') as failed_verifications,
                COUNT(DISTINCT verifier_id) as unique_verifiers,
                NULL::numeric as avg_response_time_ms,
                NOW() as created_at
            FROM verification_logs
            WHERE verified_at > NOW() - INTERVAL '24 hours'
            "#,
        )
        .fetch_one(&self.pool)
        .await?;

        Ok(metrics)
    }

    /// Get metrics for a time period
    pub async fn get_metrics_for_period(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<VerificationMetrics> {
        let metrics = sqlx::query_as::<_, VerificationMetrics>(
            r#"
            SELECT
                gen_random_uuid() as id,
                $1 as period_start,
                $2 as period_end,
                COUNT(*) as total_verifications,
                COUNT(*) FILTER (WHERE verification_result = 'success') as successful_verifications,
                COUNT(*) FILTER (WHERE verification_result = 'failed') as failed_verifications,
                COUNT(DISTINCT verifier_id) as unique_verifiers,
                NULL::numeric as avg_response_time_ms,
                NOW() as created_at
            FROM verification_logs
            WHERE verified_at BETWEEN $1 AND $2
            "#,
        )
        .bind(start)
        .bind(end)
        .fetch_one(&self.pool)
        .await?;

        Ok(metrics)
    }

    /// Clean up expired logs (GDPR compliance)
    pub async fn cleanup_expired(&self) -> Result<u64> {
        let result = sqlx::query(
            r#"
            DELETE FROM verification_logs
            WHERE expires_at < NOW()
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(result.rows_affected())
    }
}
