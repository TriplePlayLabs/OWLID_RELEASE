//! Operator-tunable runtime settings. Tiny key/value store; one row per
//! setting, value is JSONB so a setting can be a bool, number, or small
//! object without schema churn.

use sqlx::PgPool;

#[derive(Clone)]
pub struct SystemSettingsRepository {
    pool: PgPool,
}

impl SystemSettingsRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Read a setting by key. Returns `Ok(None)` if the row is absent.
    pub async fn get(&self, key: &str) -> Result<Option<serde_json::Value>, sqlx::Error> {
        let row: Option<(serde_json::Value,)> =
            sqlx::query_as("SELECT value FROM system_settings WHERE key = $1")
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0))
    }

    /// Read a setting and decode it as a typed value, or fall back to
    /// `default` when the row is absent or the value cannot be decoded.
    pub async fn get_typed<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
        default: T,
    ) -> T {
        match self.get(key).await {
            Ok(Some(v)) => serde_json::from_value(v).unwrap_or(default),
            _ => default,
        }
    }

    /// Upsert a setting. `updated_by` is the principal who set it
    /// (admin username or service identifier) for audit.
    pub async fn set(
        &self,
        key: &str,
        value: serde_json::Value,
        updated_by: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO system_settings (key, value, updated_at, updated_by)
             VALUES ($1, $2, NOW(), $3)
             ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value,
                    updated_at = NOW(),
                    updated_by = EXCLUDED.updated_by",
        )
        .bind(key)
        .bind(value)
        .bind(updated_by)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// Setting keys, kept here so a typo in one call site doesn't silently
/// read a different setting.
pub mod keys {
    pub const MIDNIGHT_ENABLED: &str = "midnight_enabled";
}
