use crate::db::{models::TrustedIssuer, DatabaseError, DbPool, Result};
use uuid::Uuid;

pub struct IssuerRepository {
    pool: DbPool,
}

impl IssuerRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Add a trusted issuer
    pub async fn add(
        &self,
        public_key: String,
        name: String,
        description: Option<String>,
        issuer_url: Option<String>,
        added_by: Option<String>,
        metadata: serde_json::Value,
    ) -> Result<TrustedIssuer> {
        let issuer = sqlx::query_as::<_, TrustedIssuer>(
            r#"
            INSERT INTO trusted_issuers (public_key, name, description, issuer_url, added_by, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
        )
        .bind(&public_key)
        .bind(&name)
        .bind(&description)
        .bind(&issuer_url)
        .bind(&added_by)
        .bind(&metadata)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| {
            if let sqlx::Error::Database(ref db_err) = e {
                if db_err.is_unique_violation() {
                    return DatabaseError::Duplicate(format!(
                        "Issuer with public key {} already exists",
                        public_key
                    ));
                }
            }
            DatabaseError::from(e)
        })?;

        Ok(issuer)
    }

    /// Get issuer by public key
    pub async fn get_by_public_key(&self, public_key: &str) -> Result<TrustedIssuer> {
        let issuer = sqlx::query_as::<_, TrustedIssuer>(
            r#"
            SELECT * FROM trusted_issuers
            WHERE public_key = $1
            "#,
        )
        .bind(public_key)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| DatabaseError::NotFound(format!("Issuer not found: {}", public_key)))?;

        Ok(issuer)
    }

    /// List all trusted issuers
    pub async fn list(&self, include_inactive: bool) -> Result<Vec<TrustedIssuer>> {
        let query = if include_inactive {
            "SELECT * FROM trusted_issuers ORDER BY added_at DESC"
        } else {
            "SELECT * FROM trusted_issuers WHERE is_active = true ORDER BY added_at DESC"
        };

        let issuers = sqlx::query_as::<_, TrustedIssuer>(query)
            .fetch_all(&self.pool)
            .await?;

        Ok(issuers)
    }

    /// Check if an issuer is trusted
    pub async fn is_trusted(&self, public_key: &str) -> Result<bool> {
        let count: (i64,) = sqlx::query_as(
            r#"
            SELECT COUNT(*) FROM trusted_issuers
            WHERE public_key = $1 AND is_active = true
            "#,
        )
        .bind(public_key)
        .fetch_one(&self.pool)
        .await?;

        Ok(count.0 > 0)
    }

    /// Update issuer status
    pub async fn update_status(&self, id: Uuid, is_active: bool) -> Result<TrustedIssuer> {
        let issuer = sqlx::query_as::<_, TrustedIssuer>(
            r#"
            UPDATE trusted_issuers
            SET is_active = $1
            WHERE id = $2
            RETURNING *
            "#,
        )
        .bind(is_active)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| DatabaseError::NotFound("Issuer not found".to_string()))?;

        Ok(issuer)
    }

    /// Delete an issuer
    pub async fn delete(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query(
            r#"
            DELETE FROM trusted_issuers
            WHERE id = $1
            "#,
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DatabaseError::NotFound("Issuer not found".to_string()));
        }

        Ok(())
    }
}
