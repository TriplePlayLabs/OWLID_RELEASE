//! Persistent per-service secrets that must stay stable across restarts and
//! must NOT be tied to the issuer signing key. The recovery subject index is
//! HMAC-keyed from here so rotating the signing key never orphans the backups
//! that earlier boots indexed under the old key.

use sqlx::PgPool;

#[derive(Clone)]
pub struct ServiceSecretsRepository {
    pool: PgPool,
}

impl ServiceSecretsRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Return the secret for `name`, generating and persisting one on first
    /// use. Concurrent boots converge on a single row: the `ON CONFLICT`
    /// no-op update returns whichever value won the insert race.
    pub async fn get_or_create(
        &self,
        name: &str,
        generate: impl FnOnce() -> String,
    ) -> Result<String, sqlx::Error> {
        if let Some((existing,)) =
            sqlx::query_as::<_, (String,)>("SELECT secret_hex FROM service_secrets WHERE name = $1")
                .bind(name)
                .fetch_optional(&self.pool)
                .await?
        {
            return Ok(existing);
        }

        let generated = generate();
        let (secret,): (String,) = sqlx::query_as(
            "INSERT INTO service_secrets (name, secret_hex)
             VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET name = service_secrets.name
             RETURNING secret_hex",
        )
        .bind(name)
        .bind(&generated)
        .fetch_one(&self.pool)
        .await?;
        Ok(secret)
    }
}
