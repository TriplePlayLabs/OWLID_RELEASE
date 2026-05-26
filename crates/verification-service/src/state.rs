#![allow(dead_code)] // intentional API surface / serde fields
use crate::db::{
    ApiKeyRepository, AttestationRepository, AuditRepository, ChallengeRepository,
    CredentialRepository, DbPool, IssuerRepository, RevocationRepository,
    VerificationLogRepository,
};
use crate::did::DidResolver;
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

    /// Chain-attested predicate keys (mirrored via sidecar SSE)
    pub attestations: Arc<AttestationRepository>,

    /// Verification log repository
    pub verification_logs: Arc<VerificationLogRepository>,

    /// Audit repository
    pub audit: Arc<AuditRepository>,

    /// Challenge replay protection repository
    pub challenges: Arc<ChallengeRepository>,

    /// WebSocket revocation broadcaster
    pub broadcaster: Arc<RevocationBroadcaster>,

    /// Prometheus metrics handle
    pub metrics_handle: metrics_exporter_prometheus::PrometheusHandle,

    /// Presentation session store (in-memory, 5 min TTL)
    pub presentations: Arc<PresentationSessionStore>,

    /// Midnight sidecar client. Required — the service refuses to start
    /// without a reachable sidecar.
    pub midnight: Arc<MidnightSidecar>,

    /// Pluggable DID resolver registry — `did:web` (Midnight-anchored),
    /// `did:key`, `did:jwk`, plus a stub for future `did:midnight`.
    pub did_resolver: Arc<DidResolver>,

    /// Allowlist of WebAuthn `clientDataJSON.origin` values that are
    /// accepted on owner-signature verification. Empty = origin check
    /// disabled (dev/test only); production must populate via
    /// `WEBAUTHN_EXPECTED_ORIGINS`.
    pub webauthn_expected_origins: Vec<String>,

    /// Externally-reachable URL of this verifier. Used to build the
    /// OpenID4VP `request_uri` + `response_uri` external wallets
    /// fetch. Defaults to `http://<host>:<port>`.
    pub verification_public_url: String,

    /// Midnight network id the sidecar runs against. Echoed verbatim
    /// to clients via `GET /midnight/info` so the SDK can call
    /// midnight-js `setNetworkId()` before any contract operation.
    pub midnight_network_id: String,
}

impl AppState {
    /// Create new application state with database connection
    pub async fn new(
        db_pool: DbPool,
        broadcaster: Arc<RevocationBroadcaster>,
        metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
        midnight: Arc<MidnightSidecar>,
        webauthn_expected_origins: Vec<String>,
        verification_public_url: String,
        midnight_network_id: String,
    ) -> Self {
        let api_keys = Arc::new(ApiKeyRepository::new(db_pool.clone()));
        let issuers = Arc::new(IssuerRepository::new(db_pool.clone()));
        // Optional AES-GCM at-rest encryption for credential data.
        let credentials = match std::env::var("ENCRYPTION_KEY") {
            Ok(hex_key) => match owl_crypto::key_from_hex(&hex_key) {
                Ok(key) => {
                    tracing::info!("Encryption at rest enabled for credential data");
                    Arc::new(CredentialRepository::with_encryption(db_pool.clone(), key))
                }
                Err(e) => {
                    tracing::warn!("Invalid ENCRYPTION_KEY ({}), storing plaintext", e);
                    Arc::new(CredentialRepository::new(db_pool.clone()))
                }
            },
            Err(_) => Arc::new(CredentialRepository::new(db_pool.clone())),
        };
        let revocations = Arc::new(RevocationRepository::new(db_pool.clone()));
        let attestations = Arc::new(AttestationRepository::new(db_pool.clone()));
        let verification_logs = Arc::new(VerificationLogRepository::new(db_pool.clone()));
        let audit = Arc::new(AuditRepository::new(db_pool.clone()));
        let challenges = Arc::new(ChallengeRepository::new(db_pool.clone()));

        // Initialize revocation cache from database
        if let Err(e) = revocations.initialize_cache().await {
            tracing::warn!("Failed to initialize revocation cache: {}", e);
        }
        // Prime attestation cache (sidecar SSE also replays a snapshot)
        if let Err(e) = attestations.initialize_cache().await {
            tracing::warn!("Failed to initialize attestation cache: {}", e);
        }

        Self {
            db_pool,
            api_keys,
            issuers,
            credentials,
            revocations,
            attestations,
            verification_logs,
            audit,
            challenges,
            presentations: Arc::new(PresentationSessionStore::new()),
            broadcaster,
            metrics_handle,
            midnight,
            did_resolver: Arc::new(DidResolver::with_defaults()),
            webauthn_expected_origins,
            verification_public_url,
            midnight_network_id,
        }
    }
}
