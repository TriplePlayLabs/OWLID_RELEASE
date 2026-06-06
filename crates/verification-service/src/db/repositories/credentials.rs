//! Credential repository with optional AES-GCM encryption at rest.

#![allow(dead_code)] // intentional API surface / serde fields
use crate::db::{DatabaseError, DbPool, Result};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::types::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct IssuedCredential {
    pub id: Uuid,
    pub credential_id: String,
    pub issuer_public_key: String,
    pub owner_public_key: String,
    pub credential_data: JsonValue,
    pub issued_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub is_active: bool,
    pub metadata: JsonValue,
}

#[derive(Clone)]
pub struct CredentialRepository {
    pool: DbPool,
    /// Optional AES-256-GCM key for encrypting credential_data at rest
    encryption_key: Option<[u8; 32]>,
}

impl CredentialRepository {
    pub fn new(pool: DbPool) -> Self {
        Self {
            pool,
            encryption_key: None,
        }
    }

    /// Create a repository with encryption at rest enabled
    pub fn with_encryption(pool: DbPool, key: [u8; 32]) -> Self {
        Self {
            pool,
            encryption_key: Some(key),
        }
    }

    /// Encrypt credential data if encryption key is configured.
    /// Returns an envelope JSON: {"encrypted": true, "ciphertext": "...", "nonce": "..."}
    fn encrypt_data(&self, data: &JsonValue) -> Result<JsonValue> {
        match self.encryption_key {
            Some(ref key) => {
                let plaintext = serde_json::to_string(data).map_err(|e| {
                    DatabaseError::InvalidData(format!("JSON serialization failed: {}", e))
                })?;
                let (ciphertext, nonce) = owl_crypto::encrypt(plaintext.as_bytes(), key)
                    .map_err(|e| DatabaseError::InvalidData(format!("Encryption failed: {}", e)))?;
                Ok(serde_json::json!({
                    "encrypted": true,
                    "ciphertext": ciphertext,
                    "nonce": nonce
                }))
            }
            None => Ok(data.clone()),
        }
    }

    /// Decrypt credential data if it's an encrypted envelope.
    /// Passes through plaintext data as-is (backward compatible).
    fn decrypt_data(&self, data: &JsonValue) -> Result<JsonValue> {
        // Check if this is an encrypted envelope
        if data.get("encrypted") == Some(&serde_json::json!(true)) {
            let key = self.encryption_key.as_ref().ok_or_else(|| {
                DatabaseError::InvalidData(
                    "Credential data is encrypted but no ENCRYPTION_KEY configured".to_string(),
                )
            })?;

            let ciphertext = data["ciphertext"]
                .as_str()
                .ok_or_else(|| DatabaseError::InvalidData("Missing ciphertext".to_string()))?;
            let nonce = data["nonce"]
                .as_str()
                .ok_or_else(|| DatabaseError::InvalidData("Missing nonce".to_string()))?;

            let plaintext = owl_crypto::decrypt(ciphertext, nonce, key)
                .map_err(|e| DatabaseError::InvalidData(format!("Decryption failed: {}", e)))?;

            let json: JsonValue = serde_json::from_slice(&plaintext).map_err(|e| {
                DatabaseError::InvalidData(format!("JSON parse after decrypt failed: {}", e))
            })?;

            Ok(json)
        } else {
            // Plaintext data, pass through
            Ok(data.clone())
        }
    }

    /// Decrypt credential data within an IssuedCredential record
    fn decrypt_record(&self, mut record: IssuedCredential) -> Result<IssuedCredential> {
        record.credential_data = self.decrypt_data(&record.credential_data)?;
        Ok(record)
    }

    /// Store a newly issued credential
    pub async fn store(
        &self,
        credential_id: String,
        issuer_public_key: String,
        owner_public_key: String,
        credential_data: JsonValue,
        expires_at: Option<DateTime<Utc>>,
        metadata: JsonValue,
    ) -> Result<IssuedCredential> {
        let stored_data = self.encrypt_data(&credential_data)?;

        let record = sqlx::query_as::<_, IssuedCredential>(
            r#"
            INSERT INTO issued_credentials
            (credential_id, issuer_public_key, owner_public_key, credential_data, expires_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
        )
        .bind(&credential_id)
        .bind(&issuer_public_key)
        .bind(&owner_public_key)
        .bind(&stored_data)
        .bind(expires_at)
        .bind(&metadata)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db_err) if db_err.is_unique_violation() => {
                DatabaseError::Duplicate(format!(
                    "Credential with credential_id {} already exists",
                    credential_id
                ))
            }
            _ => DatabaseError::from(e),
        })?;

        // Return with decrypted data for the caller
        self.decrypt_record(record)
    }

    /// Get a credential by root hash
    pub async fn get_by_credential_id(
        &self,
        credential_id: &str,
    ) -> Result<Option<IssuedCredential>> {
        let record = sqlx::query_as::<_, IssuedCredential>(
            r#"
            SELECT * FROM issued_credentials
            WHERE credential_id = $1
            "#,
        )
        .bind(credential_id)
        .fetch_optional(&self.pool)
        .await?;

        match record {
            Some(r) => Ok(Some(self.decrypt_record(r)?)),
            None => Ok(None),
        }
    }

    /// List all credentials issued by a specific issuer
    pub async fn list_by_issuer(
        &self,
        issuer_public_key: &str,
        active_only: bool,
    ) -> Result<Vec<IssuedCredential>> {
        let query = if active_only {
            r#"
            SELECT * FROM issued_credentials
            WHERE issuer_public_key = $1 AND is_active = true
            ORDER BY issued_at DESC
            "#
        } else {
            r#"
            SELECT * FROM issued_credentials
            WHERE issuer_public_key = $1
            ORDER BY issued_at DESC
            "#
        };

        let records = sqlx::query_as::<_, IssuedCredential>(query)
            .bind(issuer_public_key)
            .fetch_all(&self.pool)
            .await?;

        records
            .into_iter()
            .map(|r| self.decrypt_record(r))
            .collect()
    }

    /// List all credentials owned by a specific owner
    pub async fn list_by_owner(
        &self,
        owner_public_key: &str,
        active_only: bool,
    ) -> Result<Vec<IssuedCredential>> {
        let query = if active_only {
            r#"
            SELECT * FROM issued_credentials
            WHERE owner_public_key = $1 AND is_active = true
            ORDER BY issued_at DESC
            "#
        } else {
            r#"
            SELECT * FROM issued_credentials
            WHERE owner_public_key = $1
            ORDER BY issued_at DESC
            "#
        };

        let records = sqlx::query_as::<_, IssuedCredential>(query)
            .bind(owner_public_key)
            .fetch_all(&self.pool)
            .await?;

        records
            .into_iter()
            .map(|r| self.decrypt_record(r))
            .collect()
    }

    /// Deactivate a credential
    pub async fn deactivate(&self, credential_id: &str) -> Result<()> {
        let result = sqlx::query(
            r#"
            UPDATE issued_credentials
            SET is_active = false
            WHERE credential_id = $1
            "#,
        )
        .bind(credential_id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DatabaseError::NotFound(format!(
                "Credential with credential_id {} not found",
                credential_id
            )));
        }

        Ok(())
    }

    /// Get count of credentials issued by a specific issuer
    pub async fn count_by_issuer(&self, issuer_public_key: &str) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*) FROM issued_credentials
            WHERE issuer_public_key = $1 AND is_active = true
            "#,
        )
        .bind(issuer_public_key)
        .fetch_one(&self.pool)
        .await?;

        Ok(row.0)
    }
}
