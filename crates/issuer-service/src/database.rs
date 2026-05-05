//! Database layer for the Identity Provider
//!
//! This module provides persistent storage for verification sessions
//! and verified claims. Each IdP service has its own database.

use crate::error::{IdpError, Result};
use crate::models::{FlowState, SessionStatus, VerificationSession, VerifiedIdentityClaims};
use crate::provider::ProviderFlowType;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

/// In-memory database for the IdP
///
/// In a production system, this would be SQLite or PostgreSQL.
/// For the PoC, we use an in-memory store for simplicity.
#[derive(Debug, Clone)]
pub struct IdpDatabase {
    sessions: Arc<RwLock<HashMap<Uuid, VerificationSession>>>,
    claims: Arc<RwLock<HashMap<Uuid, VerifiedIdentityClaims>>>,
}

impl Default for IdpDatabase {
    fn default() -> Self {
        Self::new()
    }
}

impl IdpDatabase {
    /// Create a new in-memory database
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            claims: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create a new verification session with specific flow type
    pub async fn create_session_with_flow(
        &self,
        provider_id: &str,
        flow_type: ProviderFlowType,
    ) -> Result<VerificationSession> {
        let session = VerificationSession::new(provider_id, flow_type);
        let mut sessions = self.sessions.write().await;
        sessions.insert(session.id, session.clone());
        Ok(session)
    }

    /// Create a new verification session (legacy - defaults to FormBased)
    pub async fn create_session(&self, provider_id: &str) -> Result<VerificationSession> {
        self.create_session_with_flow(provider_id, ProviderFlowType::FormBased)
            .await
    }

    /// Get a session by ID
    pub async fn get_session(&self, id: Uuid) -> Result<Option<VerificationSession>> {
        let sessions = self.sessions.read().await;
        Ok(sessions.get(&id).cloned())
    }

    /// Update session status
    pub async fn update_session_status(&self, id: Uuid, status: SessionStatus) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        session.status = status;
        if status == SessionStatus::Verified {
            session.verified_at = Some(Utc::now());
            session.flow_state = FlowState::Completed;
        }
        Ok(())
    }

    /// Update session flow state
    pub async fn update_flow_state(&self, id: Uuid, flow_state: FlowState) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        session.flow_state = flow_state;
        Ok(())
    }

    /// Update session with full changes
    pub async fn update_session(&self, id: Uuid, update_fn: impl FnOnce(&mut VerificationSession)) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        update_fn(session);
        Ok(())
    }

    /// Mark session as verified with claims
    pub async fn mark_session_verified(
        &self,
        id: Uuid,
        raw_claims: Option<serde_json::Value>,
    ) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        session.status = SessionStatus::Verified;
        session.verified_at = Some(Utc::now());
        session.flow_state = FlowState::Completed;
        session.raw_claims = raw_claims;
        Ok(())
    }

    /// Mark session as failed
    pub async fn mark_session_failed(&self, id: Uuid, reason: String) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        session.status = SessionStatus::Failed;
        session.flow_state = FlowState::Failed { reason };
        Ok(())
    }

    /// Mark session as credential issued
    pub async fn mark_credential_issued(&self, id: Uuid) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        session.credential_issued = true;
        Ok(())
    }

    /// Atomically claim the issuance slot for a session.
    ///
    /// Returns `Ok(())` only when the session is `Verified` and its
    /// `credential_issued` flag flipped from `false` to `true` inside the
    /// same write lock. Returns `Err(InvalidSessionState)` for any other
    /// state, which the handler must treat as a refusal to sign — without
    /// this, two concurrent `POST /sessions/{id}/issue` requests both pass
    /// the gate and `Document::issue` mints distinct salts → distinct
    /// `root_hash` values, so the unique constraint never collapses the
    /// duplicate.
    pub async fn try_claim_issuance(&self, id: Uuid) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        if session.status != SessionStatus::Verified {
            return Err(IdpError::InvalidSessionState {
                expected: "verified".to_string(),
                actual: format!("{:?}", session.status),
            });
        }
        if session.credential_issued {
            return Err(IdpError::InvalidSessionState {
                expected: "credential_issued=false".to_string(),
                actual: "credential_issued=true".to_string(),
            });
        }
        session.credential_issued = true;
        Ok(())
    }

    /// Get sessions by flow type (for polling tasks)
    pub async fn get_sessions_by_flow_type(&self, flow_type: ProviderFlowType) -> Vec<VerificationSession> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .filter(|s| s.flow_type == flow_type && s.status == SessionStatus::Pending)
            .cloned()
            .collect()
    }

    /// Get sessions in polling state
    pub async fn get_polling_sessions(&self) -> Vec<VerificationSession> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .filter(|s| {
                s.flow_type == ProviderFlowType::QrPolling
                    && matches!(s.flow_state, FlowState::Polling { .. })
                    && s.status == SessionStatus::Pending
            })
            .cloned()
            .collect()
    }

    /// Update polling state for a session
    pub async fn update_polling_state(&self, id: Uuid, order_ref: &str) -> Result<()> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| IdpError::SessionNotFound(id.to_string()))?;

        match &session.flow_state {
            FlowState::Polling { poll_count, .. } => {
                session.flow_state = FlowState::Polling {
                    order_ref: order_ref.to_string(),
                    poll_count: poll_count + 1,
                    last_poll: Utc::now(),
                };
            }
            FlowState::PollingPending => {
                session.flow_state = FlowState::Polling {
                    order_ref: order_ref.to_string(),
                    poll_count: 1,
                    last_poll: Utc::now(),
                };
            }
            _ => {
                return Err(IdpError::InvalidSessionState {
                    expected: "polling".to_string(),
                    actual: format!("{:?}", session.flow_state),
                });
            }
        }
        Ok(())
    }

    /// Find session by relay state (for SAML callbacks)
    pub async fn find_session_by_relay_state(&self, relay_state: &str) -> Option<VerificationSession> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .find(|s| {
                matches!(&s.flow_state, FlowState::SamlPending { relay_state: rs } if rs == relay_state)
            })
            .cloned()
    }

    /// Find session by external ID (for webhooks)
    pub async fn find_session_by_external_id(&self, external_id: &str) -> Option<VerificationSession> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .find(|s| {
                matches!(
                    &s.flow_state,
                    FlowState::WebhookPending { external_session_id: Some(id) } if id == external_id
                ) || matches!(
                    &s.flow_state,
                    FlowState::WebhookWaiting { external_session_id } if external_session_id == external_id
                )
            })
            .cloned()
    }

    /// Store verified claims for a session
    pub async fn store_claims(&self, session_id: Uuid, claims: &VerifiedIdentityClaims) -> Result<()> {
        let mut claims_store = self.claims.write().await;
        claims_store.insert(session_id, claims.clone());
        Ok(())
    }

    /// Get verified claims for a session
    pub async fn get_claims(&self, session_id: Uuid) -> Result<Option<VerifiedIdentityClaims>> {
        let claims = self.claims.read().await;
        Ok(claims.get(&session_id).cloned())
    }

    /// List all sessions (for debugging)
    pub async fn list_sessions(&self) -> Vec<VerificationSession> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    /// Clean up expired sessions
    pub async fn cleanup_expired(&self) -> usize {
        let now = Utc::now();
        let mut sessions = self.sessions.write().await;
        let mut claims = self.claims.write().await;

        let expired_ids: Vec<Uuid> = sessions
            .iter()
            .filter(|(_, s)| s.expires_at < now)
            .map(|(id, _)| *id)
            .collect();

        let count = expired_ids.len();

        for id in expired_ids {
            sessions.remove(&id);
            claims.remove(&id);
        }

        count
    }
}

/// SQLite database implementation (for future use)
#[cfg(feature = "sqlite")]
pub mod sqlite {
    use super::*;
    use sqlx::SqlitePool;

    pub struct SqliteIdpDatabase {
        pool: SqlitePool,
    }

    impl SqliteIdpDatabase {
        pub async fn new(database_url: &str) -> Result<Self, sqlx::Error> {
            let pool = SqlitePool::connect(database_url).await?;

            // Run migrations
            sqlx::query(
                r#"
                CREATE TABLE IF NOT EXISTS verification_sessions (
                    id TEXT PRIMARY KEY,
                    provider_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS verified_claims (
                    session_id TEXT PRIMARY KEY REFERENCES verification_sessions(id),
                    claims_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_status ON verification_sessions(status);
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON verification_sessions(expires_at);
                "#,
            )
            .execute(&pool)
            .await?;

            Ok(Self { pool })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::VerificationLevel;
    use chrono::NaiveDate;

    #[tokio::test]
    async fn test_session_lifecycle() {
        let db = IdpDatabase::new();

        // Create session
        let session = db.create_session("mock-digid").await.unwrap();
        assert_eq!(session.status, SessionStatus::Pending);

        // Get session
        let retrieved = db.get_session(session.id).await.unwrap().unwrap();
        assert_eq!(retrieved.id, session.id);

        // Update status
        db.update_session_status(session.id, SessionStatus::Verified)
            .await
            .unwrap();

        let updated = db.get_session(session.id).await.unwrap().unwrap();
        assert_eq!(updated.status, SessionStatus::Verified);
    }

    #[tokio::test]
    async fn test_claims_storage() {
        let db = IdpDatabase::new();

        let session = db.create_session("mock-digid").await.unwrap();

        let claims = VerifiedIdentityClaims {
            first_name: "Jan".to_string(),
            last_name: "de Vries".to_string(),
            date_of_birth: NaiveDate::from_ymd_opt(1985, 3, 15).unwrap(),
            place_of_birth: "Amsterdam".to_string(),
            nationality: "Dutch".to_string(),
            gender: None,
            national_id: "123456789".to_string(),
            passport_number: None,
            drivers_license: None,
            tax_id: None,
            document_type: None,
            document_number: None,
            issuing_country: None,
            document_expiry: None,
            document_issue_date: None,
            portrait_image: None,
            street_address: "Kerkstraat 1".to_string(),
            city: "Amsterdam".to_string(),
            postal_code: "1012 AB".to_string(),
            country: "Netherlands".to_string(),
            is_over_18: true,
            is_over_21: true,
            is_over_65: false,
            is_eu_citizen: true,
            is_resident: true,
            verified_at: Utc::now(),
            verification_level: VerificationLevel::Substantial,
            provider_id: "mock-digid".to_string(),
            verification_method: "simulated".to_string(),
        };

        db.store_claims(session.id, &claims).await.unwrap();

        let retrieved = db.get_claims(session.id).await.unwrap().unwrap();
        assert_eq!(retrieved.first_name, "Jan");
        assert_eq!(retrieved.nationality, "Dutch");
    }
}
