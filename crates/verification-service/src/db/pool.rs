use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::Duration;

pub type DbPool = PgPool;

/// Create a database connection pool
pub async fn create_pool(database_url: &str) -> Result<DbPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(20)
        .min_connections(5)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await
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
