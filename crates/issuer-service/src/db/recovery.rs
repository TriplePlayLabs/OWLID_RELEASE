use crate::db::{DbPool, Result};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::types::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CredentialRecoveryBackup {
    pub id: Uuid,
    pub provider_id: String,
    pub subject_hash: String,
    pub credential_id: String,
    pub ciphertext: String,
    pub encryption_version: String,
    pub key_label: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub restored_at: Option<DateTime<Utc>>,
    pub metadata: JsonValue,
}

#[derive(Clone)]
pub struct CredentialRecoveryRepository {
    pool: DbPool,
}

impl CredentialRecoveryRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upsert(
        &self,
        provider_id: &str,
        subject_hash: &str,
        credential_id: &str,
        ciphertext: &str,
        encryption_version: &str,
        key_label: &str,
        metadata: JsonValue,
    ) -> Result<CredentialRecoveryBackup> {
        let record = sqlx::query_as::<_, CredentialRecoveryBackup>(
            r#"
            INSERT INTO credential_recovery_backups
              (provider_id, subject_hash, credential_id, ciphertext, encryption_version, key_label, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (provider_id, subject_hash, credential_id)
            DO UPDATE SET
              ciphertext = EXCLUDED.ciphertext,
              encryption_version = EXCLUDED.encryption_version,
              key_label = EXCLUDED.key_label,
              metadata = EXCLUDED.metadata,
              updated_at = NOW()
            RETURNING *
            "#,
        )
        .bind(provider_id)
        .bind(subject_hash)
        .bind(credential_id)
        .bind(ciphertext)
        .bind(encryption_version)
        .bind(key_label)
        .bind(metadata)
        .fetch_one(&self.pool)
        .await?;

        Ok(record)
    }

    pub async fn list_for_subject(
        &self,
        provider_id: &str,
        subject_hash: &str,
    ) -> Result<Vec<CredentialRecoveryBackup>> {
        let records = sqlx::query_as::<_, CredentialRecoveryBackup>(
            r#"
            SELECT * FROM credential_recovery_backups
            WHERE provider_id = $1 AND subject_hash = $2
            ORDER BY updated_at DESC
            "#,
        )
        .bind(provider_id)
        .bind(subject_hash)
        .fetch_all(&self.pool)
        .await?;

        Ok(records)
    }

    pub async fn mark_restored(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE credential_recovery_backups
            SET restored_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
