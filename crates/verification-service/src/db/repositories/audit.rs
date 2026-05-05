use crate::db::{models::AuditEvent, DbPool, Result};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

pub struct AuditRepository {
    pool: DbPool,
}

impl AuditRepository {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Hash action details for GDPR compliance
    fn hash_action(action_details: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(action_details.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Log an audit event
    pub async fn log_event(
        &self,
        event_type: String,
        entity_type: String,
        entity_id: String,
        actor: Option<String>,
        action_details: &str,
        metadata: serde_json::Value,
    ) -> Result<AuditEvent> {
        let action_hash = Self::hash_action(action_details);

        let event = sqlx::query_as::<_, AuditEvent>(
            r#"
            INSERT INTO audit_events
                (event_type, entity_type, entity_id, actor, action_hash, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            "#,
        )
        .bind(&event_type)
        .bind(&entity_type)
        .bind(&entity_id)
        .bind(&actor)
        .bind(&action_hash)
        .bind(&metadata)
        .fetch_one(&self.pool)
        .await?;

        tracing::info!(
            event_type = %event_type,
            entity_type = %entity_type,
            entity_id = %entity_id,
            actor = ?actor,
            "Audit event logged"
        );

        Ok(event)
    }

    /// Get audit events for an entity
    pub async fn get_for_entity(
        &self,
        entity_type: &str,
        entity_id: &str,
        limit: i64,
    ) -> Result<Vec<AuditEvent>> {
        let events = sqlx::query_as::<_, AuditEvent>(
            r#"
            SELECT * FROM audit_events
            WHERE entity_type = $1 AND entity_id = $2
            ORDER BY occurred_at DESC
            LIMIT $3
            "#,
        )
        .bind(entity_type)
        .bind(entity_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(events)
    }

    /// Get recent audit events
    pub async fn get_recent(&self, limit: i64) -> Result<Vec<AuditEvent>> {
        let events = sqlx::query_as::<_, AuditEvent>(
            r#"
            SELECT * FROM audit_events
            ORDER BY occurred_at DESC
            LIMIT $1
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(events)
    }

    /// Get events by type
    pub async fn get_by_type(&self, event_type: &str, limit: i64) -> Result<Vec<AuditEvent>> {
        let events = sqlx::query_as::<_, AuditEvent>(
            r#"
            SELECT * FROM audit_events
            WHERE event_type = $1
            ORDER BY occurred_at DESC
            LIMIT $2
            "#,
        )
        .bind(event_type)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(events)
    }

    /// Get events in a time range
    pub async fn get_range(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<AuditEvent>> {
        let events = sqlx::query_as::<_, AuditEvent>(
            r#"
            SELECT * FROM audit_events
            WHERE occurred_at BETWEEN $1 AND $2
            ORDER BY occurred_at DESC
            "#,
        )
        .bind(start)
        .bind(end)
        .fetch_all(&self.pool)
        .await?;

        Ok(events)
    }
}
