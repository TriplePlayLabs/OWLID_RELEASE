//! Persistent issuer keypair storage. Boot resolves the active key
//! through this repository so subsequent restarts find the same row
//! and reuse the same keypair — credentials issued before the restart
//! stay verifiable against the verification-service's
//! `trusted_issuers` registry.

use sqlx::PgPool;

#[derive(Clone)]
pub struct IssuerKeysRepository {
    pool: PgPool,
}

#[derive(Debug, Clone)]
pub struct IssuerKey {
    pub public_key_hex: String,
    pub private_key_hex: String,
}

impl IssuerKeysRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Return the most recently created active key, or `None` if the
    /// table is empty / has no active rows.
    pub async fn get_active(&self) -> Result<Option<IssuerKey>, sqlx::Error> {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT public_key_hex, private_key_hex
             FROM issuer_keys
             WHERE is_active = TRUE
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(pk, sk)| IssuerKey {
            public_key_hex: pk,
            private_key_hex: sk,
        }))
    }

    /// Insert a new keypair as the active one.
    pub async fn insert(&self, key: &IssuerKey) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO issuer_keys (public_key_hex, private_key_hex, is_active)
             VALUES ($1, $2, TRUE)
             ON CONFLICT (public_key_hex) DO NOTHING",
        )
        .bind(&key.public_key_hex)
        .bind(&key.private_key_hex)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
