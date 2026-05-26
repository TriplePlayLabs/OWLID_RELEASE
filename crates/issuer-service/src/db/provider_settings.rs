//! Per-provider operator overrides. The registry treats absence as
//! "enabled" — only providers that have been explicitly toggled appear
//! here. The repository is a thin sqlx wrapper; no caching, since the
//! registry keeps the disabled set in memory and re-reads only at boot
//! or when an admin flips a provider.

use sqlx::PgPool;

#[derive(Clone)]
pub struct ProviderSettingsRepository {
    pool: PgPool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProviderSetting {
    pub provider_id: String,
    pub enabled: bool,
}

impl ProviderSettingsRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Return every override row. Used at boot to seed the registry's
    /// disabled set.
    pub async fn list(&self) -> Result<Vec<ProviderSetting>, sqlx::Error> {
        sqlx::query_as::<_, ProviderSetting>("SELECT provider_id, enabled FROM provider_settings")
            .fetch_all(&self.pool)
            .await
    }

    /// Upsert an override. `updated_by` is the principal who set it
    /// (admin username) for audit.
    pub async fn set(
        &self,
        provider_id: &str,
        enabled: bool,
        updated_by: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO provider_settings (provider_id, enabled, updated_at, updated_by)
             VALUES ($1, $2, NOW(), $3)
             ON CONFLICT (provider_id) DO UPDATE
                SET enabled = EXCLUDED.enabled,
                    updated_at = NOW(),
                    updated_by = EXCLUDED.updated_by",
        )
        .bind(provider_id)
        .bind(enabled)
        .bind(updated_by)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
