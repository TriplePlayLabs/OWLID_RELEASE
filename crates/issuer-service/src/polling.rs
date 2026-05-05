//! Background polling infrastructure for QR-based identity providers
//!
//! This module provides a background task that polls pending BankID-style
//! verification sessions and updates their status when complete.

use crate::database::IdpDatabase;
use crate::models::{FlowState, SessionStatus};
use crate::provider::{PollResult, ProviderRegistry};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time::interval;
use tracing::{debug, error, info, warn};

/// Configuration for the polling task
#[derive(Debug, Clone)]
pub struct PollingConfig {
    /// How often to check for sessions to poll (default: 1 second)
    pub check_interval: Duration,
    /// Minimum interval between polls for the same session (default: 2 seconds)
    pub poll_interval: Duration,
    /// Maximum number of polls before giving up (default: 90 = 3 minutes at 2s interval)
    pub max_poll_count: u32,
    /// Session timeout (default: 3 minutes)
    pub session_timeout: Duration,
}

impl Default for PollingConfig {
    fn default() -> Self {
        Self {
            check_interval: Duration::from_secs(1),
            poll_interval: Duration::from_secs(2),
            max_poll_count: 90,
            session_timeout: Duration::from_secs(180),
        }
    }
}

/// Background polling task for QR-based identity providers
pub struct PollingTask {
    db: Arc<IdpDatabase>,
    registry: Arc<RwLock<ProviderRegistry>>,
    config: PollingConfig,
}

impl PollingTask {
    /// Create a new polling task
    pub fn new(
        db: Arc<IdpDatabase>,
        registry: Arc<RwLock<ProviderRegistry>>,
        config: PollingConfig,
    ) -> Self {
        Self {
            db,
            registry,
            config,
        }
    }

    /// Create with default configuration
    pub fn with_defaults(
        db: Arc<IdpDatabase>,
        registry: Arc<RwLock<ProviderRegistry>>,
    ) -> Self {
        Self::new(db, registry, PollingConfig::default())
    }

    /// Start the background polling loop
    ///
    /// This runs forever, polling pending sessions at the configured interval.
    /// Call this in a separate tokio task.
    pub async fn run(&self) {
        info!("Starting polling task with {:?}", self.config);
        let mut ticker = interval(self.config.check_interval);

        loop {
            ticker.tick().await;
            if let Err(e) = self.poll_pending_sessions().await {
                error!("Error in polling task: {}", e);
            }
        }
    }

    /// Poll all pending sessions once
    pub async fn poll_pending_sessions(&self) -> Result<(), crate::error::IdpError> {
        let sessions = self.db.get_polling_sessions().await;

        if sessions.is_empty() {
            return Ok(());
        }

        debug!("Found {} sessions to poll", sessions.len());

        for session in sessions {
            // Check if we should poll this session
            let should_poll = match &session.flow_state {
                FlowState::Polling {
                    last_poll,
                    poll_count,
                    ..
                } => {
                    // Check poll count limit
                    if *poll_count >= self.config.max_poll_count {
                        warn!(
                            "Session {} exceeded max poll count ({})",
                            session.id, poll_count
                        );
                        self.db
                            .mark_session_failed(
                                session.id,
                                "Verification timed out".to_string(),
                            )
                            .await?;
                        continue;
                    }

                    // Check poll interval
                    let elapsed = chrono::Utc::now()
                        .signed_duration_since(*last_poll)
                        .to_std()
                        .unwrap_or(Duration::ZERO);
                    elapsed >= self.config.poll_interval
                }
                FlowState::PollingPending => true, // First poll
                _ => false,
            };

            if !should_poll {
                continue;
            }

            // Get the order_ref for polling
            let order_ref = match &session.flow_state {
                FlowState::Polling { order_ref, .. } => order_ref.clone(),
                FlowState::PollingPending => {
                    // Need to get order_ref from session creation
                    // For now, skip - this should be set during start_verification
                    debug!("Session {} in PollingPending state, skipping", session.id);
                    continue;
                }
                _ => continue,
            };

            // Get provider
            let registry = self.registry.read().await;
            let provider = match registry.get(&session.provider_id) {
                Some(p) => p,
                None => {
                    error!(
                        "Provider {} not found for session {}",
                        session.provider_id, session.id
                    );
                    continue;
                }
            };

            // Poll the provider
            debug!("Polling session {} with order_ref {}", session.id, order_ref);
            match provider.poll_status(session.id, &order_ref).await {
                Ok(PollResult::Complete(raw_claims)) => {
                    info!("Session {} verification complete", session.id);

                    // Normalize and store claims
                    let claims = raw_claims.normalize();
                    if let Err(e) = self.db.store_claims(session.id, &claims).await {
                        error!("Failed to store claims for session {}: {}", session.id, e);
                        continue;
                    }

                    // Mark session as verified
                    let raw_json = serde_json::to_value(&raw_claims).ok();
                    if let Err(e) = self
                        .db
                        .mark_session_verified(session.id, raw_json)
                        .await
                    {
                        error!(
                            "Failed to mark session {} as verified: {}",
                            session.id, e
                        );
                    }
                }
                Ok(PollResult::Pending { message, .. }) => {
                    debug!("Session {} still pending: {}", session.id, message);
                    // Update poll count
                    if let Err(e) = self.db.update_polling_state(session.id, &order_ref).await {
                        error!(
                            "Failed to update poll state for session {}: {}",
                            session.id, e
                        );
                    }
                }
                Ok(PollResult::UserInteracting { message }) => {
                    debug!("Session {} user interacting: {}", session.id, message);
                    // Update status to verifying
                    if let Err(e) = self
                        .db
                        .update_session_status(session.id, SessionStatus::Verifying)
                        .await
                    {
                        error!(
                            "Failed to update session {} status: {}",
                            session.id, e
                        );
                    }
                    if let Err(e) = self.db.update_polling_state(session.id, &order_ref).await {
                        error!(
                            "Failed to update poll state for session {}: {}",
                            session.id, e
                        );
                    }
                }
                Ok(PollResult::Failed { reason, .. }) => {
                    warn!("Session {} verification failed: {}", session.id, reason);
                    if let Err(e) = self.db.mark_session_failed(session.id, reason).await {
                        error!(
                            "Failed to mark session {} as failed: {}",
                            session.id, e
                        );
                    }
                }
                Ok(PollResult::Expired) => {
                    info!("Session {} expired", session.id);
                    if let Err(e) = self
                        .db
                        .update_session_status(session.id, SessionStatus::Expired)
                        .await
                    {
                        error!(
                            "Failed to mark session {} as expired: {}",
                            session.id, e
                        );
                    }
                }
                Err(e) => {
                    error!("Error polling session {}: {}", session.id, e);
                    // Don't fail the session on transient errors, just log and continue
                    if let Err(e) = self.db.update_polling_state(session.id, &order_ref).await {
                        error!(
                            "Failed to update poll state for session {}: {}",
                            session.id, e
                        );
                    }
                }
            }
        }

        Ok(())
    }
}

/// Spawn the polling task as a background tokio task
pub fn spawn_polling_task(
    db: Arc<IdpDatabase>,
    registry: Arc<RwLock<ProviderRegistry>>,
) -> tokio::task::JoinHandle<()> {
    let task = PollingTask::with_defaults(db, registry);
    tokio::spawn(async move {
        task.run().await;
    })
}

/// Spawn the polling task with custom configuration
pub fn spawn_polling_task_with_config(
    db: Arc<IdpDatabase>,
    registry: Arc<RwLock<ProviderRegistry>>,
    config: PollingConfig,
) -> tokio::task::JoinHandle<()> {
    let task = PollingTask::new(db, registry, config);
    tokio::spawn(async move {
        task.run().await;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderFlowType;

    #[tokio::test]
    async fn test_polling_config_defaults() {
        let config = PollingConfig::default();
        assert_eq!(config.check_interval, Duration::from_secs(1));
        assert_eq!(config.poll_interval, Duration::from_secs(2));
        assert_eq!(config.max_poll_count, 90);
        assert_eq!(config.session_timeout, Duration::from_secs(180));
    }

    #[tokio::test]
    async fn test_polling_task_creation() {
        let db = Arc::new(IdpDatabase::new());
        let registry = Arc::new(RwLock::new(ProviderRegistry::new()));

        let task = PollingTask::with_defaults(db.clone(), registry.clone());
        assert_eq!(task.config.poll_interval, Duration::from_secs(2));
    }

    #[tokio::test]
    async fn test_poll_no_sessions() {
        let db = Arc::new(IdpDatabase::new());
        let registry = Arc::new(RwLock::new(ProviderRegistry::new()));

        let task = PollingTask::with_defaults(db.clone(), registry.clone());

        // Should succeed with no sessions
        let result = task.poll_pending_sessions().await;
        assert!(result.is_ok());
    }
}
