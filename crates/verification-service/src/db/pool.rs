use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub type DbPool = PgPool;

/// Create a database connection pool and bring the schema up to date.
///
/// `sqlx::migrate!()` embeds `crates/verification-service/migrations/*.sql`
/// into the binary at compile time, so the runtime container needs no
/// `.sql` files. On startup every pending migration (tracked in
/// `_sqlx_migrations`) is applied in version order — the single
/// migration mechanism for local, preview, and production Cloud SQL.
pub async fn create_pool(database_url: &str) -> Result<DbPool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .min_connections(5)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await?;

    tracing::info!("Startup: applying database migrations...");
    sqlx::migrate!().run(&pool).await?;
    tracing::info!("Startup: database schema up to date");

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires database connection
    async fn test_pool_creation() {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:password@localhost/owl_identity".to_string());

        let pool = create_pool(&database_url).await;
        assert!(pool.is_ok());
    }
}
