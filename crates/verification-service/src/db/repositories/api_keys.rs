#![allow(dead_code)] // intentional API surface / serde fields
use crate::db::{DatabaseError, DbPool, Result, models::ApiKey};
use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub struct ApiKeyRepository {
    pool: DbPool,
}

impl ApiKeyRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Hash an API key using SHA256
    pub fn hash_key(key: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Create a new API key with full metadata.
    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        &self,
        key: &str,
        name: String,
        description: Option<String>,
        permissions: Vec<String>,
        expires_at: Option<chrono::DateTime<Utc>>,
        created_by: Option<String>,
        key_type: &str,
        environment: &str,
        key_preview: &str,
    ) -> Result<ApiKey> {
        let key_hash = Self::hash_key(key);
        let permissions_json = serde_json::to_value(permissions)
            .map_err(|e| DatabaseError::InvalidData(e.to_string()))?;

        let api_key = sqlx::query_as::<_, ApiKey>(
            r#"
            INSERT INTO api_keys
                (key_hash, name, description, permissions, expires_at, created_by,
                 key_type, environment, key_preview)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
            "#,
        )
        .bind(&key_hash)
        .bind(&name)
        .bind(&description)
        .bind(&permissions_json)
        .bind(&expires_at)
        .bind(&created_by)
        .bind(key_type)
        .bind(environment)
        .bind(key_preview)
        .fetch_one(&self.pool)
        .await?;

        Ok(api_key)
    }

    /// Find API key by the actual key value (for authentication)
    pub async fn find_by_key(&self, key: &str) -> Result<ApiKey> {
        let key_hash = Self::hash_key(key);

        let api_key = sqlx::query_as::<_, ApiKey>(
            r#"
            SELECT * FROM api_keys
            WHERE key_hash = $1 AND is_active = true
            "#,
        )
        .bind(&key_hash)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| DatabaseError::NotFound("API key not found".to_string()))?;

        // Check if expired
        if let Some(expires_at) = api_key.expires_at {
            if expires_at < Utc::now() {
                return Err(DatabaseError::Unauthorized("API key expired".to_string()));
            }
        }

        Ok(api_key)
    }

    /// Update last used timestamp
    pub async fn update_last_used(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE api_keys
            SET last_used_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    /// List all API keys
    pub async fn list(&self, include_inactive: bool) -> Result<Vec<ApiKey>> {
        let query = if include_inactive {
            "SELECT * FROM api_keys ORDER BY created_at DESC"
        } else {
            "SELECT * FROM api_keys WHERE is_active = true ORDER BY created_at DESC"
        };

        let keys = sqlx::query_as::<_, ApiKey>(query)
            .fetch_all(&self.pool)
            .await?;

        Ok(keys)
    }

    /// Deactivate an API key
    pub async fn deactivate(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query(
            r#"
            UPDATE api_keys
            SET is_active = false
            WHERE id = $1
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DatabaseError::NotFound("API key not found".to_string()));
        }

        Ok(())
    }

    /// Delete an API key
    pub async fn delete(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query(
            r#"
            DELETE FROM api_keys
            WHERE id = $1
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DatabaseError::NotFound("API key not found".to_string()));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_hashing() {
        let key = "test_key_123";
        let hash1 = ApiKeyRepository::hash_key(key);
        let hash2 = ApiKeyRepository::hash_key(key);

        assert_eq!(hash1, hash2);
        assert_ne!(hash1, key);
        assert_eq!(hash1.len(), 64); // SHA256 produces 64 hex characters
    }
}
