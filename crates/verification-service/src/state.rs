use crate::db::{
    ApiKeyRepository, AuditRepository, ChallengeRepository, CredentialRepository, DbPool,
    IssuerRepository, RevocationRepository, VerificationLogRepository,
};
use crate::midnight::MidnightSidecar;
use crate::presentation::PresentationSessionStore;
use crate::ws::RevocationBroadcaster;
use std::sync::Arc;

/// Application state shared across handlers
#[derive(Clone)]
pub struct AppState {
    /// Database connection pool
    pub db_pool: DbPool,

    /// API Key repository
    pub api_keys: Arc<ApiKeyRepository>,

    /// Issuer repository
    pub issuers: Arc<IssuerRepository>,

    /// Credential repository
    pub credentials: Arc<CredentialRepository>,

    /// Revocation repository
    pub revocations: Arc<RevocationRepository>,

    /// Verification log repository
    pub verification_logs: Arc<VerificationLogRepository>,

    /// Audit repository
    pub audit: Arc<AuditRepository>,

    /// T-011: Challenge replay protection repository
    pub challenges: Arc<ChallengeRepository>,

    /// T-018: WebSocket revocation broadcaster
    pub broadcaster: Arc<RevocationBroadcaster>,

    /// T-020: Prometheus metrics handle
    pub metrics_handle: metrics_exporter_prometheus::PrometheusHandle,

    /// Presentation session store (in-memory, 5 min TTL)
    pub presentations: Arc<PresentationSessionStore>,

    /// Midnight sidecar client (None if MIDNIGHT_ENABLED=false)
    pub midnight: Option<Arc<MidnightSidecar>>,
}

impl AppState {
    /// Create new application state with database connection
    pub async fn new(
        db_pool: DbPool,
        broadcaster: Arc<RevocationBroadcaster>,
        metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
        midnight: Option<Arc<MidnightSidecar>>,
    ) -> Self {
        let api_keys = Arc::new(ApiKeyRepository::new(db_pool.clone()));
        let issuers = Arc::new(IssuerRepository::new(db_pool.clone()));
        // T-014: Initialize credential repository with optional encryption at rest
        let credentials = match std::env::var("ENCRYPTION_KEY") {
            Ok(hex_key) => {
                match owl_crypto::key_from_hex(&hex_key) {
                    Ok(key) => {
                        tracing::info!("Encryption at rest enabled for credential data");
                        Arc::new(CredentialRepository::with_encryption(db_pool.clone(), key))
                    }
                    Err(e) => {
                        tracing::warn!("Invalid ENCRYPTION_KEY ({}), storing plaintext", e);
                        Arc::new(CredentialRepository::new(db_pool.clone()))
                    }
                }
            }
            Err(_) => Arc::new(CredentialRepository::new(db_pool.clone())),
        };
        let revocations = Arc::new(RevocationRepository::new(db_pool.clone()));
        let verification_logs = Arc::new(VerificationLogRepository::new(db_pool.clone()));
        let audit = Arc::new(AuditRepository::new(db_pool.clone()));
        let challenges = Arc::new(ChallengeRepository::new(db_pool.clone()));

        // Initialize revocation cache from database
        if let Err(e) = revocations.initialize_cache().await {
            tracing::warn!("Failed to initialize revocation cache: {}", e);
        }

        Self {
            db_pool,
            api_keys,
            issuers,
            credentials,
            revocations,
            verification_logs,
            audit,
            challenges,
            presentations: Arc::new(PresentationSessionStore::new()),
            broadcaster,
            metrics_handle,
            midnight,
        }
    }
}
