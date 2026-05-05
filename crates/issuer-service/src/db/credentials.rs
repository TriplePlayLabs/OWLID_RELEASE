use crate::db::{DatabaseError, DbPool, Result};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use sqlx::types::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct IssuedCredential {
    pub id: Uuid,
    pub root_hash: String,
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
}

impl CredentialRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Store a newly issued credential
    pub async fn store(
        &self,
        root_hash: String,
        issuer_public_key: String,
        owner_public_key: String,
        credential_data: JsonValue,
        expires_at: Option<DateTime<Utc>>,
        metadata: JsonValue,
    ) -> Result<IssuedCredential> {
        let record = sqlx::query_as::<_, IssuedCredential>(
            r#"
            INSERT INTO issued_credentials
            (root_hash, issuer_public_key, owner_public_key, credential_data, expires_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
        )
        .bind(&root_hash)
        .bind(&issuer_public_key)
        .bind(&owner_public_key)
        .bind(&credential_data)
        .bind(expires_at)
        .bind(&metadata)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(db_err) if db_err.is_unique_violation() => {
                DatabaseError::Duplicate(format!(
                    "Credential with root_hash {} already exists",
                    root_hash
                ))
            }
            _ => DatabaseError::from(e),
        })?;

        Ok(record)
    }

    /// Get a credential by root hash
    pub async fn get_by_root_hash(&self, root_hash: &str) -> Result<Option<IssuedCredential>> {
        let record = sqlx::query_as::<_, IssuedCredential>(
            r#"
            SELECT * FROM issued_credentials
            WHERE root_hash = $1
            "#,
        )
        .bind(root_hash)
        .fetch_optional(&self.pool)
        .await?;

        Ok(record)
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

        Ok(records)
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

        Ok(records)
    }

    /// Deactivate a credential
    pub async fn deactivate(&self, root_hash: &str) -> Result<()> {
        let result = sqlx::query(
            r#"
            UPDATE issued_credentials
            SET is_active = false
            WHERE root_hash = $1
            "#,
        )
        .bind(root_hash)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DatabaseError::NotFound(format!(
                "Credential with root_hash {} not found",
                root_hash
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
