//! OwlID Issuer Service
//!
//! This service provides REST endpoints for identity verification and credential issuance.
//! It combines the functionality of the identity provider and issuer service into a single service.
//!
//! Runs on port 8001 (configurable via ISSUER_PORT)
//!
//! Supported provider types:
//! - Form-based (mock providers)
//! - SAML redirect (DigiD, eIDAS)
//! - QR code polling (BankID)
//! - Webhook async (Onfido, Jumio)

// Intentional `+`-connector prose in doc comments trips clippy's markdown
// list heuristic; the lint is cosmetic (rustdoc rendering only).
#![allow(clippy::doc_lazy_continuation)]

mod admin_auth;
mod config;
mod midnight;
mod provider_admin;

use owl_issuer_service::did_web;

use crate::config::Config as IssuerConfig;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware as axum_middleware,
    response::IntoResponse,
    routing::{get, post},
};
use owl_issuer_service::{
    BridgeConfig, CredentialBridge, DiditConfig, DiditProvider, FlowState, FormConfig, FormField,
    FormFieldType, IdentitySubmissionForm, IdpDatabase, MockBankIdProvider, MockDigiDProvider,
    MockProviderFactory, ProviderDescriptor, ProviderFlowType, ProviderInfo, ProviderRegistry,
    SessionStatus, VerificationLevel, VerificationStart, VerifiedIdentityClaims, WebhookPayload,
    db::{
        CredentialRecoveryRepository, CredentialRepository, ProviderSettingsRepository, create_pool,
    },
    middleware::{InMemoryRateLimiter, RateLimitConfig, rate_limit, validate_session_bearer},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use utoipa::OpenApi;
use uuid::Uuid;

/// Register the issuer's public key with the verification-service, which
/// writes it on-chain (`issuer_registry`) before mirroring it to Postgres.
///
/// The verification call drives a Midnight transaction (proof gen + submit
/// + confirm), so a single attempt can legitimately take ~30-90 s. The HTTP
/// client timeout is therefore generous (4 min) and the call is retried
/// with capped backoff so a transient blip during startup does not abort
/// the whole service.
/// Whether the startup on-chain registration has succeeded. Read by `/health`
/// so an unregistered issuer is visible instead of silently issuing
/// credentials that cannot verify.
static ISSUER_REGISTERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn register_trusted_issuer(
    verification_url: &str,
    admin_key: &str,
    pubkey_hex: &str,
    issuer_name: &str,
) -> anyhow::Result<()> {
    const ATTEMPTS: u32 = 5;
    // On-chain registration is slow — give each attempt room to finish.
    const PER_ATTEMPT_TIMEOUT_SECS: u64 = 240;
    // Capped backoff between attempts (transient failures fail fast).
    const BACKOFF_SECS: [u64; 4] = [3, 8, 15, 30];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PER_ATTEMPT_TIMEOUT_SECS))
        .build()?;
    let body = serde_json::json!({
        "publicKey": pubkey_hex,
        "name": issuer_name,
    });
    let url = format!("{}/trusted-issuers", verification_url.trim_end_matches('/'));

    info!(
        "Startup: registering issuer pubkey on-chain via {} \
         (Midnight tx — may take ~30-90s per attempt)",
        url
    );

    let mut last_error = None;
    for attempt in 1..=ATTEMPTS {
        info!("Startup: issuer on-chain registration attempt {attempt}/{ATTEMPTS}...");
        match client
            .post(&url)
            .bearer_auth(admin_key)
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                info!("Startup: ✓ issuer registered on-chain + verification cache ({pubkey_hex})");
                return Ok(());
            }
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                last_error = Some(anyhow::anyhow!(
                    "verification-service returned {status}: {text}"
                ));
            }
            Err(err) => {
                last_error = Some(err.into());
            }
        }

        if attempt < ATTEMPTS {
            let backoff = BACKOFF_SECS[(attempt as usize - 1).min(BACKOFF_SECS.len() - 1)];
            tracing::warn!(
                "Startup: issuer registration attempt {attempt}/{ATTEMPTS} failed: {} \
                 — retrying in {backoff}s",
                last_error
                    .as_ref()
                    .map(|e| e.to_string())
                    .unwrap_or_default(),
            );
            tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("issuer registration failed")))
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "OwlID Issuer Service",
        version = "1.0.0",
        description = "Identity verification and credential issuance"
    ),
    paths(
        health,
        get_issuer_info,
        list_providers,
        create_session,
        get_session,
        submit_identity,
        get_claims,
        issue_credential,
        list_recovery_backups,
        store_recovery_backup,
        auto_verify,
        complete_verification,
        handle_saml_callback,
        handle_webhook,
        oidc_login,
        oidc_callback,
        list_oidc_providers,
        poll_session,
        provider_admin::list_all_providers,
        provider_admin::enable_provider,
        provider_admin::disable_provider,
    ),
    components(schemas(
        IssuerInfoResponse,
        CreateSessionRequest,
        CreateSessionResponse,
        SessionResponse,
        IssueCredentialRequest,
        IssueCredentialResponse,
        RecoveryBackupRequest,
        RecoveryBackupResponse,
        RecoveryBackupsResponse,
        CompleteVerificationResponse,
        OidcLoginResponse,
        OidcCallbackQuery,
        OidcCallbackResponse,
        OidcProviderInfo,
        FlowState,
        SessionStatus,
        VerificationLevel,
        VerifiedIdentityClaims,
        IdentitySubmissionForm,
        ProviderFlowType,
        VerificationStart,
        FormConfig,
        FormField,
        FormFieldType,
        ProviderDescriptor,
        ProviderInfo,
        CallbackResponse,
        PollResponse,
        provider_admin::ProviderToggleResponse,
    )),
    tags(
        (name = "info", description = "Service information"),
        (name = "providers", description = "Identity providers"),
        (name = "sessions", description = "Verification sessions"),
        (name = "credentials", description = "Credential issuance"),
        (name = "oidc", description = "OpenID Connect"),
        (name = "callbacks", description = "Provider callbacks"),
        (name = "polling", description = "Session-status polling for QR / webhook providers"),
    )
)]
struct ApiDoc;

fn build_cors_layer() -> CorsLayer {
    let dev_default = [
        "http://localhost:5000",
        "http://localhost:5001",
        "http://localhost:4000",
        "http://127.0.0.1:5000",
        "http://127.0.0.1:5001",
        "http://127.0.0.1:4000",
    ];
    let configured: Vec<String> = std::env::var("CORS_ALLOWED_ORIGINS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let origins: Vec<HeaderValue> = if configured.is_empty() {
        dev_default.iter().filter_map(|o| o.parse().ok()).collect()
    } else {
        configured.iter().filter_map(|o| o.parse().ok()).collect()
    };

    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::HeaderName::from_static("x-correlation-id"),
        ])
        .allow_credentials(true)
}

/// Application state shared across handlers
#[derive(Clone)]
struct AppState {
    db: Arc<IdpDatabase>,
    factory: Arc<MockProviderFactory>,
    registry: Arc<RwLock<ProviderRegistry>>,
    credential_bridge: Arc<CredentialBridge>,
    /// Issuer private key for credential issuance
    issuer_private_key: String,
    /// Public base URL of this issuer (drives `did:web` + Status List uri).
    issuer_public_url: String,
    /// verification-service base URL (revoked-set source for the Status List).
    verification_service_url: String,
    /// Midnight sidecar client. Required.
    midnight: Arc<midnight::MidnightSidecar>,
    /// In-flight OIDC authorization requests, keyed by `state`.
    oidc_state: owl_issuer_service::oidc_state::OidcStateStore,
    /// Holder app base URL. OAuth/OIDC + webhook callbacks 302 here so the
    /// user lands on the same `/callback` success page across providers.
    app_url: String,
    /// Optional encrypted recovery backup repository. Disabled when Postgres
    /// is unavailable; credentials still issue normally.
    recovery_repo: Option<CredentialRecoveryRepository>,
    recovery_index_secret: Vec<u8>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "owl_issuer_service=debug,tower_http=debug,sqlx=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting OwlID Issuer Service...");

    // Validate every env var upfront, fail fast on missing required ones.
    let issuer_config = IssuerConfig::from_env().unwrap_or_else(|err| {
        for e in &err.0 {
            tracing::error!("config error: {}", e);
        }
        std::process::exit(1);
    });
    info!("\n{}", issuer_config);

    // Initialize in-memory IdP database (for sessions, claims)
    let db = Arc::new(IdpDatabase::new());
    let factory = Arc::new(MockProviderFactory::new(db.clone()));

    // Initialize provider registry with mock providers
    let mut registry = ProviderRegistry::new();
    registry.register(MockDigiDProvider::new(db.clone()));
    registry.register(MockBankIdProvider::new(db.clone()));

    // Register Didit provider if configured
    match DiditConfig::from_env() {
        Ok(config) => {
            registry.register(DiditProvider::new(config));
            info!("Registered Didit KYC provider");
        }
        Err(_) => {
            info!("Didit provider not configured (DIDIT_API_KEY/DIDIT_WORKFLOW_ID not set)");
        }
    }

    // Shared store for in-flight OIDC authorization requests. Used by
    // both the session-aware OidcProvider (writes state at session
    // create, reads it on callback) and the standalone /auth/login
    // path. Cleanup task spawned later when AppState owns the clone.
    let oidc_state = owl_issuer_service::oidc_state::OidcStateStore::default();

    // Register OIDC providers (Google, Microsoft, Apple, custom). Each
    // is exposed via the `/sessions { providerId }` flow exactly like
    // the mock + KYC providers; the authorization redirect comes back
    // through `/auth/callback/{providerId}` which then bridges into
    // the same `IdpDatabase` session this provider opened.
    for oidc_cfg in owl_issuer_service::oidc::load_oidc_providers() {
        let pid = oidc_cfg.provider_id.clone();
        let display = match pid.as_str() {
            "google" => "Google",
            "microsoft" => "Microsoft",
            "apple" => "Apple",
            _ => pid.as_str(),
        };
        registry.register(owl_issuer_service::provider::OidcProvider::new(
            oidc_cfg,
            display.to_string(),
            "Global".to_string(),
            owl_issuer_service::VerificationLevel::Low,
            oidc_state.clone(),
        ));
        info!("Registered OIDC provider: {}", pid);
    }

    let registry = Arc::new(RwLock::new(registry));

    // Collect provider list for logging (before moving registry into state)
    let provider_list = {
        let reg = registry.read().await;
        reg.provider_ids().join(", ")
    };

    // Try to connect to PostgreSQL for credential storage (optional). Prefer
    // service-specific URL, fallback to shared DATABASE_URL. The pool is
    // shared with the provider-settings repository below so admin toggle
    // endpoints can persist their state in the same database without
    // opening a second pool.
    let bridge_config = BridgeConfig {
        include_raw_fields: true,
        include_derived_proofs: true,
        include_metadata: true,
    };
    let (credential_bridge, db_pool) = match std::env::var("ISSUER_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
    {
        Ok(database_url) => {
            info!("Connecting to database for credential storage...");
            match create_pool(&database_url).await {
                Ok(pool) => {
                    info!("Database connection established");
                    let bridge = CredentialBridge::with_config(bridge_config.clone())
                        .with_credential_repo(CredentialRepository::new(pool.clone()));
                    (bridge, Some(pool))
                }
                Err(e) => {
                    tracing::warn!(
                        "Failed to connect to database: {}. Credential storage and provider toggles disabled.",
                        e
                    );
                    (CredentialBridge::with_config(bridge_config.clone()), None)
                }
            }
        }
        Err(_) => {
            info!("ISSUER_DATABASE_URL not set. Credential storage and provider toggles disabled.");
            (CredentialBridge::with_config(bridge_config.clone()), None)
        }
    };

    // Seed the registry's disabled-set from `provider_settings` so the last
    // operator decision survives restarts.
    if let Some(ref pool) = db_pool {
        let repo = ProviderSettingsRepository::new(pool.clone());
        match repo.list().await {
            Ok(rows) => {
                let disabled = rows
                    .into_iter()
                    .filter(|r| !r.enabled)
                    .map(|r| r.provider_id)
                    .collect::<Vec<_>>();
                if !disabled.is_empty() {
                    info!("Disabled providers from DB: {}", disabled.join(", "));
                }
                let reg = registry.read().await;
                reg.set_disabled(disabled);
            }
            Err(e) => {
                tracing::warn!("Failed to load provider_settings: {}", e);
            }
        }
    }

    let credential_bridge = Arc::new(credential_bridge);

    // Issuer signing key resolution. Order:
    //   1. ISSUER_PRIVATE_KEY env (operator-managed, prod path).
    //   2. Most recent active row in `issuer_keys` (persisted dev key).
    //   3. Generate a fresh keypair and persist it into the table.
    //
    // Without (2), every restart minted a new key and credentials issued
    // before the restart became "Untrusted issuer" against the
    // verification-service's `trusted_issuers` registry.
    let issuer_private_key = if let Ok(env_key) =
        std::env::var("ISSUER_PRIVATE_KEY").or_else(|_| std::env::var("IDP_ISSUER_PRIVATE_KEY"))
    {
        env_key
    } else if let Some(ref pool) = db_pool {
        let repo = owl_issuer_service::db::IssuerKeysRepository::new(pool.clone());
        match repo.get_active().await {
            Ok(Some(existing)) => {
                info!(
                    "Loaded persisted issuer keypair. Public key: {}",
                    existing.public_key_hex
                );
                existing.private_key_hex
            }
            Ok(None) => {
                let keypair = owl_crypto::KeyPair::generate();
                let private_key_hex = hex::encode(keypair.to_bytes());
                let public_key_hex = keypair.public_key().to_hex();
                info!(
                    "Generated new issuer keypair (none persisted). Public key: {}",
                    public_key_hex
                );
                if let Err(e) = repo
                    .insert(&owl_issuer_service::db::IssuerKey {
                        public_key_hex: public_key_hex.clone(),
                        private_key_hex: private_key_hex.clone(),
                    })
                    .await
                {
                    tracing::warn!(
                        "Failed to persist generated issuer keypair: {}. The next restart will mint another one.",
                        e
                    );
                }
                private_key_hex
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to read issuer_keys table ({}); falling back to ephemeral keypair.",
                    e
                );
                let keypair = owl_crypto::KeyPair::generate();
                info!(
                    "Generated ephemeral issuer keypair. Public key: {}",
                    keypair.public_key().to_hex()
                );
                hex::encode(keypair.to_bytes())
            }
        }
    } else {
        let keypair = owl_crypto::KeyPair::generate();
        info!(
            "Generated ephemeral issuer keypair (no DB available). Public key: {}",
            keypair.public_key().to_hex()
        );
        hex::encode(keypair.to_bytes())
    };
    // Recovery subject-index HMAC key. Deliberately decoupled from the issuer
    // signing key: subject hashes are stable for the life of THIS secret, so
    // tying it to the signing key would orphan every stored backup the moment
    // that key rotated. Resolution: operator env first, else a dedicated
    // persisted row (generated once). When no DB is available recovery itself
    // is disabled, so the empty fallback is never consulted.
    let recovery_index_secret: Vec<u8> = if let Ok(env_secret) =
        std::env::var("ISSUER_RECOVERY_INDEX_SECRET")
    {
        env_secret.into_bytes()
    } else if let Some(ref pool) = db_pool {
        let repo = owl_issuer_service::db::ServiceSecretsRepository::new(pool.clone());
        match repo
            .get_or_create("recovery_index_secret", || {
                hex::encode(owl_crypto::KeyPair::generate().to_bytes())
            })
            .await
        {
            Ok(secret) => secret.into_bytes(),
            Err(e) => {
                tracing::warn!(
                    "Failed to load persisted recovery index secret ({}); recovery lookups will not be stable across restarts.",
                    e
                );
                hex::encode(owl_crypto::KeyPair::generate().to_bytes()).into_bytes()
            }
        }
    } else {
        Vec::new()
    };

    // Register the active pubkey with the verification-service BEFORE
    // accepting issuance requests, so every freshly-issued credential
    // is recognised on its first verify. The verification-service's
    // `add_trusted_issuer` now writes to Midnight FIRST (chain is the
    // source of truth) and only then upserts its Postgres mirror — so
    // this single call covers both the on-chain registration and the
    // local cache. Without an admin-permission API key we cannot make
    // that call, so the boot fails rather than silently allowing the
    // issuer to mint credentials that verifiers will reject.
    //
    // Setting `ISSUER_SKIP_STARTUP_REGISTRATION=true` skips this step
    // — useful for one-shot dev workflows that just need the binary
    // bound to a port (e.g. `just generate-api-client` curling
    // `/openapi.json`) where the verification-service / Midnight
    // chain might not be reachable, or where re-registering an
    // ephemeral key in production is undesirable. The bound binary
    // will still refuse to issue credentials until a real
    // registration completes.
    let skip_registration = std::env::var("ISSUER_SKIP_STARTUP_REGISTRATION")
        .map(|v| matches!(v.as_str(), "true" | "1" | "yes"))
        .unwrap_or(false);
    if skip_registration {
        tracing::warn!(
            "ISSUER_SKIP_STARTUP_REGISTRATION=true — skipping issuer pubkey \
             registration. Issued credentials will NOT verify until a real \
             registration completes."
        );
    } else {
        let pubkey_hex = owl_crypto::KeyPair::from_bytes(
            &hex::decode(&issuer_private_key).expect("issuer private key must be hex"),
        )
        .expect("issuer private key must be a valid Ed25519 seed")
        .public_key()
        .to_hex();
        let issuer_name =
            std::env::var("ISSUER_NAME").unwrap_or_else(|_| "OwlID Issuer Service".to_string());
        let admin_key = issuer_config
            .verification_admin_api_key
            .as_deref()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "VERIFICATION_ADMIN_API_KEY (or API_KEY_DEV for local dev) is required so the \
                     issuer can register its pubkey on Midnight + the verification-service before \
                     issuing any credentials. Refusing to start. Set \
                     ISSUER_SKIP_STARTUP_REGISTRATION=true to bypass for spec-generation runs."
                )
            })?;
        // Registration needs the chain. When the chain is unavailable a
        // failure here used to abort startup, which Cloud Run turns into a
        // crash-loop that also takes down the routes needing no chain at all
        // — including `/.well-known/did.json`, which every verifier resolves
        // to check this issuer's DID. Retry in the background instead and let
        // the service serve; `/health` reports the unregistered state.
        let verification_url = issuer_config.verification_service_url.clone();
        let admin_key = admin_key.to_string();
        tokio::spawn(async move {
            let mut backoff_secs = 30u64;
            loop {
                match register_trusted_issuer(
                    &verification_url,
                    &admin_key,
                    &pubkey_hex,
                    &issuer_name,
                )
                .await
                {
                    Ok(()) => {
                        ISSUER_REGISTERED.store(true, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                    Err(e) => {
                        tracing::error!(
                            "Startup: issuer on-chain registration failed: {e} — retrying in \
                             {backoff_secs}s. Credentials issued before this succeeds will not \
                             verify."
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
                        backoff_secs = (backoff_secs * 2).min(600);
                    }
                }
            }
        });
    }

    // Midnight is required — refuse to start if the sidecar is
    // unreachable. `ISSUER_SKIP_SIDECAR_PROBE=true` (or the same
    // skip-registration flag) downgrades the probe to a warning so
    // spec-generation / dev workflows that don't actually exercise
    // the chain path can still bring up the HTTP surface.
    let skip_sidecar_probe = skip_registration
        || std::env::var("ISSUER_SKIP_SIDECAR_PROBE")
            .map(|v| matches!(v.as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);
    let midnight_client = {
        let sidecar = midnight::MidnightSidecar::new(midnight::MidnightConfig::from_env());
        info!("Probing Midnight sidecar at {}", sidecar.base_url());
        match sidecar.health_check().await {
            Ok(true) => info!("Midnight sidecar connected and healthy"),
            Ok(false) => tracing::warn!(
                "Midnight sidecar reachable but not yet connected to the network — proceeding"
            ),
            Err(e) => {
                if skip_sidecar_probe {
                    tracing::warn!(
                        "Midnight sidecar unreachable at {}: {} — skipping probe per \
                         ISSUER_SKIP_SIDECAR_PROBE / ISSUER_SKIP_STARTUP_REGISTRATION",
                        sidecar.base_url(),
                        e
                    );
                } else {
                    tracing::error!(
                        "Midnight sidecar unreachable at {}: {}",
                        sidecar.base_url(),
                        e
                    );
                    std::process::exit(1);
                }
            }
        }
        Arc::new(sidecar)
    };

    {
        let store = oidc_state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                let cleaned = store.cleanup().await;
                if cleaned > 0 {
                    tracing::debug!("Cleaned up {} expired OIDC state entries", cleaned);
                }
            }
        });
    }

    let state = AppState {
        db,
        factory,
        registry,
        credential_bridge,
        issuer_private_key,
        issuer_public_url: issuer_config.issuer_public_url.clone(),
        verification_service_url: issuer_config.verification_service_url.clone(),
        midnight: midnight_client.clone(),
        oidc_state,
        app_url: issuer_config.app_url.clone(),
        recovery_repo: db_pool
            .as_ref()
            .map(|pool| CredentialRecoveryRepository::new(pool.clone())),
        recovery_index_secret,
    };

    // Background cleanup of expired sessions + claims. Without this the
    // in-memory `Database` accumulates rows for every abandoned flow.
    {
        let db = state.db.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                let cleaned = db.cleanup_expired().await;
                if cleaned > 0 {
                    tracing::debug!("Cleaned up {} expired issuer sessions", cleaned);
                }
            }
        });
    }

    // On-chain issuer registration already happened above via
    // `register_trusted_issuer` → verification-service `add_trusted_issuer`,
    // which writes Midnight FIRST. No separate direct-to-sidecar
    // registration is needed (it would double-write the same key).

    // `did:webs`-style tamper-evidence: anchor sha-256(did_document) on
    // Midnight's `identity_registry` (commitment slot keyed by
    // sha-256(did_web_id)) so a verifier can detect a substituted DID
    // document. Fire-and-forget + idempotent (re-anchoring the same
    // commitment asserts "already exists" — non-fatal).
    {
        let public_url = state.issuer_public_url.clone();
        let key_hex = state.issuer_private_key.clone();
        let midnight = midnight_client.clone();
        tokio::spawn(async move {
            use sha2::{Digest, Sha256};
            let Ok(key_bytes) = hex::decode(&key_hex) else {
                tracing::warn!("did:web doc anchor skipped: bad issuer key hex");
                return;
            };
            let Ok(kp) = owl_crypto::KeyPair::from_bytes(&key_bytes) else {
                tracing::warn!("did:web doc anchor skipped: bad issuer keypair");
                return;
            };
            let did = did_web::did_web_id(&public_url);
            let doc = did_web::did_document(&public_url, &kp.public_key());
            let Ok(canonical) = serde_json::to_vec(&doc) else {
                tracing::warn!("did:web doc anchor skipped: canonicalize failed");
                return;
            };
            let did_hash = hex::encode(Sha256::digest(did.as_bytes()));
            let doc_hash = hex::encode(Sha256::digest(&canonical));
            let issuer_key_hash = hex::encode(Sha256::digest(kp.public_key().to_hex().as_bytes()));
            // Retry with backoff: the sidecar serializes witness-bearing
            // writes through a single private-state LevelDB, so the
            // anchor can lose to concurrent identity writes with
            // `Database failed to open`. Eventually-consistent retries
            // make the anchor land without blocking startup.
            let mut delay = std::time::Duration::from_secs(3);
            for attempt in 1..=8u32 {
                match midnight
                    .register_identity(&did_hash, &doc_hash, &issuer_key_hash)
                    .await
                {
                    Ok(_) => {
                        info!("did:web doc-hash anchored on-chain for {did}");
                        return;
                    }
                    Err(e) => {
                        let s = e.to_string();
                        if s.contains("already") {
                            // Anchored before — but possibly to an OLDER
                            // document (key reload, URL change, doc shape
                            // change). A stale anchor makes the verifier
                            // reject every credential with "doc-hash anchor
                            // mismatch", so compare and re-anchor via the
                            // owner-gated updateCommitment when they differ.
                            match midnight.get_identity_commitment(&did_hash).await {
                                Ok(Some(current)) if current.eq_ignore_ascii_case(&doc_hash) => {
                                    info!("did:web doc-hash already anchored on-chain for {did}");
                                    return;
                                }
                                _ => match midnight
                                    .update_identity(&did_hash, &doc_hash, &issuer_key_hash)
                                    .await
                                {
                                    Ok(_) => {
                                        info!(
                                            "did:web doc-hash re-anchored on-chain for {did} \
                                             (document changed since last anchor)"
                                        );
                                        return;
                                    }
                                    Err(e2) => {
                                        tracing::warn!(
                                            "did:web doc-hash re-anchor attempt {attempt}/8 \
                                             failed: {e2}; retrying in {:?}",
                                            delay
                                        );
                                    }
                                },
                            }
                        } else {
                            tracing::warn!(
                                "did:web doc-hash anchor attempt {attempt}/8 failed: {e}; \
                                 retrying in {:?}",
                                delay
                            );
                        }
                    }
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(std::time::Duration::from_secs(60));
            }
            tracing::warn!(
                "did:web doc-hash anchor gave up after 8 attempts; verifier check will be \
                 best-effort (graceful absence). Anchor will retry on next issuer restart."
            );
        });
    }

    // Build CORS layer from CORS_ALLOWED_ORIGINS, falling back to the
    // local-dev frontend origins so a fresh checkout still works.
    let cors = build_cors_layer();

    let rate_config = RateLimitConfig::from_env();
    let rate_limiter = InMemoryRateLimiter::new(rate_config);

    let oidc_providers = owl_issuer_service::oidc::load_oidc_providers();
    if oidc_providers.is_empty() {
        info!("No OIDC providers configured");
    } else {
        info!("Loaded {} OIDC provider(s)", oidc_providers.len());
    }

    // Routes that need a per-session bearer minted at /sessions create time.
    // These all carry the session UUID in the path; the middleware reads it
    // out and matches the supplied Authorization: Bearer header.
    let session_scoped = Router::new()
        .route("/sessions/{id}", get(get_session))
        .route("/sessions/{id}/submit", post(submit_identity))
        .route("/sessions/{id}/claims", get(get_claims))
        .route("/sessions/{id}/issue", post(issue_credential))
        .route(
            "/sessions/{id}/recovery-backups",
            get(list_recovery_backups),
        )
        .route(
            "/sessions/{id}/recovery-backups",
            post(store_recovery_backup),
        )
        .route("/sessions/{id}/auto-verify", post(auto_verify))
        .route("/sessions/{id}/complete", post(complete_verification))
        .route("/polling/{session_id}", get(poll_session))
        .layer(axum_middleware::from_fn_with_state(
            state.db.clone(),
            validate_session_bearer,
        ));

    // Operator-only routes. Gated by the verification-service-issued admin
    // session JWT (`owlid_admin_token` cookie or Authorization: Bearer).
    // Wired only when a DB pool is available, since persistence of the
    // toggle state lives in `provider_settings`.
    let admin_router = if let Some(ref pool) = db_pool {
        let admin_state = provider_admin::ProviderAdminState {
            registry: state.registry.clone(),
            db_pool: pool.clone(),
        };
        Some(
            Router::new()
                .route("/admin/providers", get(provider_admin::list_all_providers))
                .route(
                    "/admin/providers/{id}/enable",
                    post(provider_admin::enable_provider),
                )
                .route(
                    "/admin/providers/{id}/disable",
                    post(provider_admin::disable_provider),
                )
                .layer(axum_middleware::from_fn(admin_auth::require_admin))
                .with_state(admin_state),
        )
    } else {
        None
    };

    let mut app = Router::new()
        .merge(
            utoipa_swagger_ui::SwaggerUi::new("/swagger-ui")
                .url("/openapi.json", ApiDoc::openapi()),
        )
        .route("/health", get(health))
        .route("/.well-known/did.json", get(did_json))
        .route(
            "/.well-known/openid-credential-issuer",
            get(openid_credential_issuer_metadata),
        )
        .route("/token", post(oid4vci_token))
        .route("/credential", post(oid4vci_credential))
        .route("/status/{id}", get(status_list))
        .route("/issuer-info", get(get_issuer_info))
        .route("/providers", get(list_providers))
        .route("/sessions", post(create_session))
        .route("/callbacks/saml", post(handle_saml_callback))
        .route("/callbacks/webhook/{provider}", post(handle_webhook))
        .route("/auth/login/{provider}", get(oidc_login))
        .route("/auth/callback/{provider}", get(oidc_callback))
        .route("/auth/providers", get(list_oidc_providers))
        .merge(session_scoped)
        .with_state(state);

    if let Some(admin_router) = admin_router {
        app = app.merge(admin_router);
    }

    let app = app
        .layer(axum_middleware::from_fn_with_state(
            rate_limiter,
            rate_limit,
        ))
        .layer(cors);

    // Use validated config
    let addr = format!("{}:{}", issuer_config.host, issuer_config.port);

    info!("Issuer Service listening on http://{}", addr);
    info!("Available providers: {}", provider_list);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ============================================================================
// API Handlers
// ============================================================================

/// Health check endpoint
#[utoipa::path(get, path = "/health", tag = "info", responses((status = 200, description = "Service is running", body = String)))]
async fn health() -> impl axum::response::IntoResponse {
    let registered = ISSUER_REGISTERED.load(std::sync::atomic::Ordering::Relaxed);
    let skipped = std::env::var("ISSUER_SKIP_STARTUP_REGISTRATION")
        .map(|v| v == "true")
        .unwrap_or(false);
    let healthy = registered || skipped;
    let status = if healthy {
        StatusCode::OK
    } else {
        // Not registered on-chain means credentials issued now will not
        // verify. 503 so uptime checks and alerts see it.
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        axum::Json(serde_json::json!({
            "status": if healthy { "ok" } else { "degraded" },
            "issuerRegisteredOnChain": registered,
            "error": if healthy { serde_json::Value::Null }
                     else { serde_json::json!("issuer pubkey not yet registered on-chain") },
        })),
    )
}

/// `did:web` DID document for this issuer (DID Core 1.0). The SD-JWT VC
/// `iss` resolves here; the Ed25519 verification key is also a Midnight
/// trusted issuer (trust anchor). Not in the typed client — it is a
/// well-known resolution endpoint consumed by standard DID resolvers.
async fn did_json(
    State(state): State<AppState>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let key_bytes = hex::decode(&state.issuer_private_key)
        .map_err(|e| ApiError::Internal(format!("issuer key hex: {e}")))?;
    let kp = owl_crypto::KeyPair::from_bytes(&key_bytes)
        .map_err(|e| ApiError::Internal(format!("issuer key: {e}")))?;
    // Public DID document — the did:web spec recommends serving it with
    // `Access-Control-Allow-Origin: *` so browser-based / universal DID
    // resolvers can fetch it (the credentialed CORS layer would block
    // them; this endpoint carries no credentials and no secret).
    Ok((
        [(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        Json(did_web::did_document(
            &state.issuer_public_url,
            &kp.public_key(),
        )),
    ))
}

/// OpenID4VCI 1.0 Credential Issuer Metadata
/// (`/.well-known/openid-credential-issuer`). Advertises the SD-JWT VC
/// (`dc+sd-jwt`) credential this issuer mints + the credential endpoint, so
/// standard OID4VCI wallets can discover and request it.
async fn openid_credential_issuer_metadata(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let base = state.issuer_public_url.trim_end_matches('/');
    Json(serde_json::json!({
        "credential_issuer": base,
        "credential_endpoint": format!("{base}/credential"),
        "token_endpoint": format!("{base}/token"),
        "credential_configurations_supported": {
            "owlid_identity": {
                "format": "dc+sd-jwt",
                "vct": "https://owlid.dev/credentials/identity",
                "cryptographic_binding_methods_supported": ["jwk"],
                "credential_signing_alg_values_supported": ["EdDSA"],
                "proof_types_supported": { "jwt": { "proof_signing_alg_values_supported": ["EdDSA"] } }
            }
        }
    }))
}

/// OpenID4VCI 1.0 Token Endpoint — Pre-Authorized Code grant. The
/// pre-authorized code is a verified issuance session id; the returned
/// access token is that code (consumed by `/credential`).
async fn oid4vci_token(
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let code = req
        .get("pre-authorized_code")
        .or_else(|| req.get("pre_authorized_code"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadRequest("pre-authorized_code required".into()))?;
    Ok(Json(serde_json::json!({
        "access_token": code,
        "token_type": "bearer",
        "expires_in": 300
    })))
}

/// OpenID4VCI 1.0 Credential Endpoint. `Authorization: Bearer <session-id>`;
/// body binds the holder key (`ownerPublicKey`/`keyAlgorithm`). Returns the
/// standard SD-JWT VC. Delegates to the same issuance path as
/// `/sessions/{id}/issue`.
async fn oid4vci_credential(
    state: State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::BadRequest("missing Bearer access token".into()))?;
    let id = uuid::Uuid::parse_str(token.trim())
        .map_err(|_| ApiError::BadRequest("invalid access token".into()))?;
    let owner_public_key = body
        .get("ownerPublicKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadRequest("ownerPublicKey required".into()))?
        .to_string();
    let key_algorithm: KeyAlgorithm = body
        .get("keyAlgorithm")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_value(serde_json::json!(s)).ok())
        .unwrap_or_default();

    // OpenID4VCI Batch Credential issuance for unlinkability: an
    // optional `batchSize` mints N one-time-use SD-JWT VCs (distinct
    // `credential_id` each, same holder `cnf`).
    let batch_size = body
        .get("batchSize")
        .or_else(|| body.get("batch_size"))
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 64) as u32);

    let resp = issue_credential(
        state,
        axum::extract::Path(id),
        Json(IssueCredentialRequest {
            owner_public_key,
            key_algorithm,
            batch_size,
        }),
    )
    .await?;
    if !resp.0.success {
        return Err(ApiError::Internal(
            resp.0
                .error
                .clone()
                .unwrap_or_else(|| "issuance failed".into()),
        ));
    }
    // OID4VCI Credential Response: single → `credential`; batch →
    // `credentials` array. We return both so OID4VCI Batch-capable
    // clients and single-credential clients both work unchanged.
    Ok(Json(serde_json::json!({
        "credential": resp.0.credential,
        "credentials": resp.0.credentials,
    })))
}

/// IETF Token Status List (`draft-ietf-oauth-status-list`) for this issuer.
/// The bitstring is projected from the Midnight `revocation_registry`
/// (sourced from verification-service, which SSE-mirrors the chain), mapped
/// through each credential's persisted `statusIdx`, and signed with the
/// issuer key.
async fn status_list(
    State(state): State<AppState>,
) -> Result<impl axum::response::IntoResponse, ApiError> {
    let kp = owl_crypto::KeyPair::from_bytes(
        &hex::decode(&state.issuer_private_key)
            .map_err(|e| ApiError::Internal(format!("issuer key hex: {e}")))?,
    )
    .map_err(|e| ApiError::Internal(format!("issuer key: {e}")))?;

    let url = format!(
        "{}/status-revoked",
        state.verification_service_url.trim_end_matches('/')
    );
    let body: serde_json::Value = reqwest::get(&url)
        .await
        .map_err(|e| ApiError::Internal(format!("revoked-set source: {e}")))?
        .json()
        .await
        .map_err(|e| ApiError::Internal(format!("revoked-set json: {e}")))?;
    let revoked: Vec<String> = body
        .get("revoked")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let mut idxs: Vec<u64> = Vec::new();
    if let Some(repo) = state.credential_bridge.credential_repo() {
        for id in &revoked {
            if let Ok(Some(cred)) = repo.get_by_credential_id(id).await {
                if let Some(idx) = cred.metadata.get("statusIdx").and_then(|v| v.as_u64()) {
                    idxs.push(idx);
                }
            }
        }
    }

    let list = owl_proof_system::status_list::StatusList::from_revoked(&idxs);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let uri = format!("{}/status/1", state.issuer_public_url.trim_end_matches('/'));
    let jwt = owl_proof_system::status_list::issue_status_list_jwt(&list, &kp, &uri, now, None)
        .map_err(|e| ApiError::Internal(format!("status list: {e}")))?;

    Ok((
        [(
            axum::http::header::CONTENT_TYPE,
            "application/statuslist+jwt",
        )],
        jwt,
    ))
}

/// Issuer info response
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct IssuerInfoResponse {
    public_key: String,
    name: String,
}

/// Get issuer public key (for registering with verification service)
#[utoipa::path(get, path = "/issuer-info", tag = "info", responses((status = 200, description = "Issuer public key and name", body = IssuerInfoResponse)))]
async fn get_issuer_info(State(state): State<AppState>) -> Json<IssuerInfoResponse> {
    let keypair = owl_crypto::KeyPair::from_bytes(
        &hex::decode(&state.issuer_private_key).expect("Invalid issuer key"),
    )
    .expect("Invalid issuer keypair");

    Json(IssuerInfoResponse {
        public_key: keypair.public_key().to_hex(),
        name: "OwlID Issuer Service".to_string(),
    })
}

/// List available identity providers (with flow type info)
#[utoipa::path(
    get,
    path = "/providers",
    tag = "providers",
    responses(
        (status = 200, description = "List of available identity providers", body = Vec<ProviderInfo>)
    )
)]
async fn list_providers(State(state): State<AppState>) -> Json<Vec<ProviderInfo>> {
    // Public endpoint — only enabled providers are exposed to holders.
    // Operators see the full list (enabled + disabled) via /admin/providers.
    let registry = state.registry.read().await;
    Json(registry.list().into_iter().filter(|p| p.enabled).collect())
}

/// Request to create a verification session
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    provider_id: String,
}

/// Response when creating a session
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateSessionResponse {
    session_id: Uuid,
    provider_id: String,
    flow_type: ProviderFlowType,
    status: SessionStatus,
    expires_at: String,
    /// Per-session bearer token. Send as `Authorization: Bearer <token>`
    /// on every subsequent `/sessions/{id}/*` and `/polling/{id}` call.
    session_token: String,
    /// Flow-specific start data
    #[serde(flatten)]
    start_data: VerificationStart,
}

/// Create a new verification session
#[utoipa::path(post, path = "/sessions", tag = "sessions", request_body = CreateSessionRequest, responses((status = 200, description = "Session created", body = CreateSessionResponse)))]
async fn create_session(
    State(state): State<AppState>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, ApiError> {
    let registry = state.registry.read().await;

    let provider = registry.get(&request.provider_id).ok_or_else(|| {
        ApiError::NotFound(format!("Provider not found: {}", request.provider_id))
    })?;
    if !registry.is_enabled(&request.provider_id) {
        return Err(ApiError::BadRequest(format!(
            "Provider {} is currently disabled by the operator",
            request.provider_id
        )));
    }

    // Create session with flow type
    let flow_type = provider.provider_type();
    let session = state
        .db
        .create_session_with_flow(&request.provider_id, flow_type)
        .await?;

    // Start verification with provider (gets flow-specific data)
    let start_data = provider.start_verification(session.id).await?;

    // For HostedUi responses, store the external session ID in the flow state
    if let VerificationStart::HostedUi {
        ref external_session_id,
        ..
    } = start_data
    {
        state
            .db
            .update_flow_state(
                session.id,
                FlowState::WebhookPending {
                    external_session_id: Some(external_session_id.clone()),
                },
            )
            .await?;
    }

    Ok(Json(CreateSessionResponse {
        session_id: session.id,
        provider_id: session.provider_id,
        flow_type,
        status: session.status,
        expires_at: session.expires_at.to_rfc3339(),
        session_token: session.session_token,
        start_data,
    }))
}

/// Extended session response with flow state
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    id: Uuid,
    provider_id: String,
    flow_type: ProviderFlowType,
    status: SessionStatus,
    flow_state: FlowState,
    expires_at: String,
    is_expired: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified_at: Option<String>,
    credential_issued: bool,
}

/// Get session status
#[utoipa::path(get, path = "/sessions/{id}", tag = "sessions", params(("id" = Uuid, Path, description = "Session ID")), responses((status = 200, description = "Session details", body = SessionResponse)))]
async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<SessionResponse>, ApiError> {
    let session = state
        .db
        .get_session(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", id)))?;

    let is_expired = session.is_expired();
    Ok(Json(SessionResponse {
        id: session.id,
        provider_id: session.provider_id,
        flow_type: session.flow_type,
        status: session.status,
        flow_state: session.flow_state,
        expires_at: session.expires_at.to_rfc3339(),
        is_expired,
        verified_at: session.verified_at.map(|t| t.to_rfc3339()),
        credential_issued: session.credential_issued,
    }))
}

/// Submit identity data for verification (form-based providers)
#[utoipa::path(
    post,
    path = "/sessions/{id}/submit",
    params(
        ("id" = Uuid, Path, description = "Session ID"),
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Identity verified", body = serde_json::Value),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Session not found"),
    ),
    tag = "sessions"
)]
async fn submit_identity(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(form): Json<IdentitySubmissionForm>,
) -> Result<Json<VerifiedIdentityClaims>, ApiError> {
    // Get session to find provider
    let session = state
        .db
        .get_session(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", id)))?;

    // Check flow type
    if session.flow_type != ProviderFlowType::FormBased {
        return Err(ApiError::BadRequest(format!(
            "Session uses {:?} flow, not form-based submission",
            session.flow_type
        )));
    }

    let provider = state
        .factory
        .get_provider(&session.provider_id)
        .ok_or_else(|| {
            ApiError::Internal(format!("Provider not found: {}", session.provider_id))
        })?;

    let claims = provider.submit_identity(id, form).await?;
    Ok(Json(claims))
}

/// Get verified claims for a session
#[utoipa::path(
    get,
    path = "/sessions/{id}/claims",
    params(
        ("id" = Uuid, Path, description = "Session ID"),
    ),
    responses(
        (status = 200, description = "Verified claims", body = serde_json::Value),
        (status = 400, description = "Session not verified yet"),
        (status = 404, description = "Session not found"),
    ),
    tag = "sessions"
)]
async fn get_claims(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<VerifiedIdentityClaims>, ApiError> {
    let session = state
        .db
        .get_session(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", id)))?;

    if session.status != SessionStatus::Verified {
        return Err(ApiError::BadRequest(format!(
            "Session not verified yet (status: {:?})",
            session.status
        )));
    }

    let claims =
        state.db.get_claims(id).await?.ok_or_else(|| {
            ApiError::Internal("Claims not found for verified session".to_string())
        })?;

    Ok(Json(claims))
}

/// Key algorithm for owner public key
#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum KeyAlgorithm {
    /// P-256 / ECDSA (WebAuthn default)
    #[default]
    P256,
    /// Ed25519
    Ed25519,
}

impl KeyAlgorithm {
    fn to_signature_algorithm(self) -> owl_issuer_service::SignatureAlgorithm {
        match self {
            KeyAlgorithm::P256 => owl_issuer_service::SignatureAlgorithm::EcdsaP256,
            KeyAlgorithm::Ed25519 => owl_issuer_service::SignatureAlgorithm::Ed25519,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IdentityAnchorArgs {
    did_hash: String,
    commitment: String,
    issuer_key_hash: String,
}

fn credential_identity_anchor_args(
    owner_public_key: &str,
    credential_id: &str,
    issuer_private_key_hex: &str,
) -> Option<IdentityAnchorArgs> {
    use sha2::{Digest, Sha256};

    let key_bytes = hex::decode(issuer_private_key_hex).ok()?;
    let keypair = owl_crypto::KeyPair::from_bytes(&key_bytes).ok()?;
    let issuer_key_hash = hex::encode(Sha256::digest(keypair.public_key().to_hex().as_bytes()));

    Some(IdentityAnchorArgs {
        did_hash: hex::encode(Sha256::digest(owner_public_key.as_bytes())),
        commitment: credential_id.to_string(),
        issuer_key_hash,
    })
}

/// Request to issue a credential
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct IssueCredentialRequest {
    /// Owner's public key (hex)
    owner_public_key: String,
    /// Key algorithm: "p256" (WebAuthn default) or "ed25519"
    #[serde(default)]
    #[schema(value_type = String)]
    key_algorithm: KeyAlgorithm,
    /// OpenID4VCI batch issuance for unlinkability: mint this many
    /// one-time-use SD-JWT VCs (same holder `cnf`, distinct issuer JWT ⇒
    /// distinct `credential_id`, each independently revocable). The
    /// holder presents each to at most one verifier so presentations
    /// cannot be correlated. Default 1; clamped to 1..=64.
    #[serde(default)]
    batch_size: Option<u32>,
}

/// Response from credential issuance
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct IssueCredentialResponse {
    success: bool,
    /// The issued credential: a standard SD-JWT VC (`application/dc+sd-jwt`).
    /// For a batch this is the first element of `credentials`.
    credential: String,
    /// OpenID4VCI batch: all minted one-time-use SD-JWT VCs (length =
    /// effective batch size; `[credential]` when 1). Each has a distinct
    /// `credential_id` and is independently revocable.
    credentials: Vec<String>,
    /// Holder-only personhood secret (32-byte hex), HKDF-derived from
    /// the issuer's salt + the provider's stable subject identifier.
    /// Used as the private witness for `attestUniquePersonhood`.
    /// MUST be stored client-side wrapped by the passkey PRF and
    /// NEVER sent to a verifier — disclosing it breaks the
    /// per-(epoch, app) collision property.
    #[serde(skip_serializing_if = "Option::is_none")]
    personhood_secret_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct RecoveryBackupRequest {
    credential_id: String,
    ciphertext: String,
    encryption_version: String,
    key_label: String,
    #[serde(default)]
    metadata: serde_json::Value,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct RecoveryBackupResponse {
    id: String,
    credential_id: String,
    ciphertext: String,
    encryption_version: String,
    key_label: String,
    updated_at: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct RecoveryBackupsResponse {
    backups: Vec<RecoveryBackupResponse>,
}

fn recovery_subject_material(claims: &VerifiedIdentityClaims) -> Option<String> {
    let provider = claims.provider_id.to_lowercase();
    if matches!(provider.as_str(), "google" | "apple" | "microsoft")
        && !claims.national_id.is_empty()
    {
        return Some(format!("oidc:{provider}:{}", claims.national_id));
    }

    if let Some(document_number) = claims.document_number.as_ref().filter(|v| !v.is_empty()) {
        let country = claims.issuing_country.as_deref().unwrap_or("unknown");
        let doc_type = claims.document_type.as_deref().unwrap_or("unknown");
        return Some(format!(
            "doc:{provider}:{country}:{doc_type}:{document_number}"
        ));
    }

    if !claims.national_id.is_empty() {
        return Some(format!("eid:{provider}:{}", claims.national_id));
    }

    None
}

fn recovery_subject_hash(claims: &VerifiedIdentityClaims, secret: &[u8]) -> Option<String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let material = recovery_subject_material(claims)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(b"owlid:credential-recovery:v1\0");
    mac.update(material.as_bytes());
    Some(hex::encode(mac.finalize().into_bytes()))
}

fn to_recovery_response(
    backup: owl_issuer_service::db::CredentialRecoveryBackup,
) -> RecoveryBackupResponse {
    RecoveryBackupResponse {
        id: backup.id.to_string(),
        credential_id: backup.credential_id,
        ciphertext: backup.ciphertext,
        encryption_version: backup.encryption_version,
        key_label: backup.key_label,
        updated_at: backup.updated_at.to_rfc3339(),
    }
}

/// Issue a credential from verified claims
#[utoipa::path(post, path = "/sessions/{id}/issue", tag = "credentials", params(("id" = Uuid, Path, description = "Session ID")), request_body = IssueCredentialRequest, responses((status = 200, description = "Credential issued", body = IssueCredentialResponse)))]
async fn issue_credential(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(request): Json<IssueCredentialRequest>,
) -> Result<Json<IssueCredentialResponse>, ApiError> {
    // Atomically claim the issuance slot before signing. `try_claim_issuance`
    // verifies the session is `Verified` and flips `credential_issued`
    // false→true inside a single write lock; if two requests race, only one
    // succeeds. Without this, the issuer would produce a fresh credential per
    // call so the UNIQUE(credential_id) constraint can't dedupe.
    state
        .db
        .try_claim_issuance(id)
        .await
        .map_err(|err| match err {
            owl_issuer_service::IdpError::SessionNotFound(_) => {
                ApiError::NotFound(format!("Session not found: {}", id))
            }
            owl_issuer_service::IdpError::InvalidSessionState { actual, .. } => {
                ApiError::BadRequest(format!("Cannot issue credential: {}", actual))
            }
            other => ApiError::Internal(other.to_string()),
        })?;

    let claims = match state.db.get_claims(id).await? {
        Some(c) => c,
        None => {
            // Restore the slot so a corrected retry can still proceed.
            let _ = state
                .db
                .update_session(id, |s| s.credential_issued = false)
                .await;
            return Err(ApiError::Internal("Claims not found".to_string()));
        }
    };

    let issuer_key = state.issuer_private_key.clone();

    // Unique-personhood: derive the holder-only secret once per request.
    // `Some` only for document-verified / government-eID identities;
    // plain OIDC accounts (Google et al) get `None` and no personhood
    // predicate. The secret is deterministic per real human, so a second
    // wallet derives the identical secret and the Midnight nullifier
    // blocks it from claiming any campaign the first already did — the
    // sybil boundary is on-chain, no issuer-side dedup table exists.
    let personhood_secret = owl_issuer_service::derive_personhood(&claims, &issuer_key);

    // OpenID4VCI batch issuance for unlinkability: mint N one-time-use
    // SD-JWT VCs. Each `issue_credential` call uses fresh per-claim salts
    // and allocates its own status index ⇒ a distinct issuer JWT ⇒ a
    // distinct `credential_id`, independently revocable. Same holder
    // `cnf`. Presented at most once each, so two verifiers cannot
    // correlate them.
    let batch = request.batch_size.unwrap_or(1).clamp(1, 64) as usize;
    let mut credentials: Vec<String> = Vec::with_capacity(batch);
    for _ in 0..batch {
        match state
            .credential_bridge
            .issue_credential(
                &claims,
                &issuer_key,
                &request.owner_public_key,
                request.key_algorithm.to_signature_algorithm(),
                &state.issuer_public_url,
                personhood_secret.is_some(),
            )
            .await
        {
            Ok(vc) => credentials.push(vc),
            Err(err) => {
                if credentials.is_empty() {
                    let _ = state
                        .db
                        .update_session(id, |s| s.credential_issued = false)
                        .await;
                    return Err(err.into());
                }
                tracing::warn!(
                    "batch issuance stopped at {}/{}: {}",
                    credentials.len(),
                    batch,
                    err
                );
                break;
            }
        }
    }

    // Midnight stays the trust core: anchor EVERY batch credential
    // on-chain (each `credential_id` is an independent on-chain handle,
    // independently revocable via the revocation_registry).
    {
        for vc in &credentials {
            let owner_pk = request.owner_public_key.clone();
            let issuer_pk = state.issuer_private_key.clone();
            let midnight = state.midnight.clone();
            let cred_id = owl_proof_system::sd_jwt::credential_id_hex(
                &owl_issuer_service::sd_jwt_bridge::credential_id(vc),
            );
            tokio::spawn(async move {
                let Ok(cred_id) = cred_id else {
                    tracing::warn!("identity anchor skipped: bad credential id");
                    return;
                };
                let Some(anchor) = credential_identity_anchor_args(&owner_pk, &cred_id, &issuer_pk)
                else {
                    tracing::warn!("identity anchor skipped: bad issuer keypair");
                    return;
                };
                if let Err(e) = midnight
                    .register_identity(
                        &anchor.did_hash,
                        &anchor.commitment,
                        &anchor.issuer_key_hash,
                    )
                    .await
                {
                    tracing::warn!("Failed to anchor identity on-chain (non-blocking): {}", e);
                } else {
                    tracing::info!(
                        "Identity anchored on-chain for DID hash: {}",
                        anchor.did_hash
                    );
                }
            });
        }
    }

    let credential = credentials.first().cloned().unwrap_or_default();

    Ok(Json(IssueCredentialResponse {
        success: true,
        credential,
        credentials,
        personhood_secret_hex: personhood_secret.map(hex::encode),
        error: None,
    }))
}

#[utoipa::path(
    post,
    path = "/sessions/{id}/recovery-backups",
    tag = "credentials",
    params(("id" = Uuid, Path, description = "Verified session ID")),
    request_body = RecoveryBackupRequest,
    responses((status = 200, description = "Encrypted recovery backup stored", body = RecoveryBackupResponse))
)]
// Authorization is "proved a fresh provider verification of this identity"
// (session bearer + matching subject hash). The server cannot prove the caller
// owns the passkey that sealed a row, so an attacker who re-verifies the same
// identity AND knows a victim's credential_id could overwrite that row. The
// blast radius is bounded: the ciphertext is sealed under the victim's passkey
// PRF, so an attacker's overwrite is undecryptable on restore (it is skipped,
// not trusted) — at worst a recovery DoS for that one credential, never a leak.
async fn store_recovery_backup(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(request): Json<RecoveryBackupRequest>,
) -> Result<Json<RecoveryBackupResponse>, ApiError> {
    let repo = state.recovery_repo.as_ref().ok_or_else(|| {
        ApiError::BadRequest("Credential recovery storage is disabled".to_string())
    })?;
    let claims = state
        .db
        .get_claims(id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Session is not verified".to_string()))?;
    let subject_hash = recovery_subject_hash(&claims, &state.recovery_index_secret)
        .ok_or_else(|| ApiError::BadRequest("Verified identity is not recoverable".to_string()))?;

    if request.credential_id.trim().is_empty() || request.ciphertext.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "credentialId and ciphertext are required".to_string(),
        ));
    }

    let backup = repo
        .upsert(
            &claims.provider_id,
            &subject_hash,
            &request.credential_id,
            &request.ciphertext,
            &request.encryption_version,
            &request.key_label,
            request.metadata,
        )
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(to_recovery_response(backup)))
}

#[utoipa::path(
    get,
    path = "/sessions/{id}/recovery-backups",
    tag = "credentials",
    params(("id" = Uuid, Path, description = "Verified session ID")),
    responses((status = 200, description = "Encrypted recovery backups for this verified identity", body = RecoveryBackupsResponse))
)]
async fn list_recovery_backups(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<RecoveryBackupsResponse>, ApiError> {
    let repo = state.recovery_repo.as_ref().ok_or_else(|| {
        ApiError::BadRequest("Credential recovery storage is disabled".to_string())
    })?;
    let claims = state
        .db
        .get_claims(id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Session is not verified".to_string()))?;
    let subject_hash = recovery_subject_hash(&claims, &state.recovery_index_secret)
        .ok_or_else(|| ApiError::BadRequest("Verified identity is not recoverable".to_string()))?;
    let backups = repo
        .list_for_subject(&claims.provider_id, &subject_hash)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    Ok(Json(RecoveryBackupsResponse {
        backups: backups.into_iter().map(to_recovery_response).collect(),
    }))
}

// ============================================================================
// Auto-Verify (for testing mock providers)
// ============================================================================

/// Auto-verify with sample data - completes verification without user input
/// Useful for testing the flow with mock providers. In production, real providers
/// would complete via SAML callbacks, webhooks, or form submission.
#[utoipa::path(post, path = "/sessions/{id}/auto-verify", tag = "sessions", params(("id" = Uuid, Path, description = "Session ID")), responses((status = 200, description = "Session auto-verified with sample data", body = serde_json::Value)))]
async fn auto_verify(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<VerifiedIdentityClaims>, ApiError> {
    use chrono::NaiveDate;
    use owl_issuer_service::VerificationLevel;

    // Get session
    let session = state
        .db
        .get_session(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", id)))?;

    if session.is_expired() {
        return Err(ApiError::BadRequest("Session expired".to_string()));
    }

    // Generate sample data based on provider
    let claims = match session.provider_id.as_str() {
        "mock-digid" => VerifiedIdentityClaims {
            first_name: "Jan".to_string(),
            last_name: "de Vries".to_string(),
            date_of_birth: NaiveDate::from_ymd_opt(1985, 3, 15).unwrap(),
            place_of_birth: "Amsterdam".to_string(),
            nationality: "Dutch".to_string(),
            national_id: "123456789".to_string(),
            street_address: "Kerkstraat 42".to_string(),
            city: "Amsterdam".to_string(),
            postal_code: "1012 AB".to_string(),
            country: "Netherlands".to_string(),
            gender: None,
            passport_number: None,
            drivers_license: None,
            tax_id: None,
            document_type: None,
            document_number: None,
            issuing_country: None,
            document_expiry: None,
            document_issue_date: None,
            portrait_image: None,
            is_over_18: true,
            is_over_21: true,
            is_over_65: false,
            is_eu_citizen: true,
            is_resident: true,
            resident_country: Some("NL".to_string()),
            verification_level: VerificationLevel::Substantial,
            provider_id: "mock-digid".to_string(),
            name: None,
            picture: None,
            locale: None,
            hosted_domain: None,
            verification_method: "simulated_saml".to_string(),
            verified_at: chrono::Utc::now(),
            email: None,
            email_verified: None,
        },
        "mock-bankid" => VerifiedIdentityClaims {
            first_name: "Erik".to_string(),
            last_name: "Svensson".to_string(),
            date_of_birth: NaiveDate::from_ymd_opt(1990, 7, 22).unwrap(),
            place_of_birth: "Stockholm".to_string(),
            nationality: "Swedish".to_string(),
            national_id: "199007221234".to_string(),
            street_address: "Storgatan 15".to_string(),
            city: "Stockholm".to_string(),
            postal_code: "111 23".to_string(),
            country: "Sweden".to_string(),
            gender: None,
            passport_number: None,
            drivers_license: None,
            tax_id: None,
            document_type: None,
            document_number: None,
            issuing_country: None,
            document_expiry: None,
            document_issue_date: None,
            portrait_image: None,
            is_over_18: true,
            is_over_21: true,
            is_over_65: false,
            is_eu_citizen: true,
            is_resident: true,
            resident_country: Some("NL".to_string()),
            verification_level: VerificationLevel::High,
            provider_id: "mock-bankid".to_string(),
            name: None,
            picture: None,
            locale: None,
            hosted_domain: None,
            verification_method: "simulated_bankid".to_string(),
            verified_at: chrono::Utc::now(),
            email: None,
            email_verified: None,
        },
        _ => {
            return Err(ApiError::BadRequest(format!(
                "Unknown provider: {}",
                session.provider_id
            )));
        }
    };

    // Store claims
    state.db.store_claims(id, &claims).await?;

    // Mark session as verified
    state.db.mark_session_verified(id, None).await?;

    info!(
        "Auto-verified session {} with provider {}",
        id, session.provider_id
    );

    Ok(Json(claims))
}

// ============================================================================
// Complete Verification (for webhook_async providers like Didit)
// ============================================================================

/// Complete verification for webhook_async providers
/// Polls the external provider's decision endpoint and returns claims when ready
#[utoipa::path(
    post,
    path = "/sessions/{id}/complete",
    params(
        ("id" = Uuid, Path, description = "Session ID"),
    ),
    responses(
        (status = 200, description = "Verification status", body = CompleteVerificationResponse),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Session not found"),
    ),
    tag = "sessions"
)]
async fn complete_verification(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<CompleteVerificationResponse>, ApiError> {
    // Get session
    let session = state
        .db
        .get_session(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", id)))?;

    if session.is_expired() {
        return Err(ApiError::BadRequest("Session expired".to_string()));
    }

    // Check if already verified
    if session.status == owl_issuer_service::SessionStatus::Verified {
        let claims = state.db.get_claims(id).await?.ok_or_else(|| {
            ApiError::Internal("Claims not found for verified session".to_string())
        })?;
        return Ok(Json(CompleteVerificationResponse {
            status: "verified".to_string(),
            claims: Some(claims),
            message: None,
            provider_status: None,
            warnings: None,
            retry_after_secs: None,
        }));
    }

    // Webhook (Didit) + OIDC (Google/Microsoft/Apple) both rely on this
    // endpoint to learn that the out-of-band provider finished. For OIDC
    // the verified state is set by the /auth/callback/{provider} handler
    // and there is no provider-side polling to do — return pending until
    // that callback flips the session.
    use owl_issuer_service::ProviderFlowType;
    if !matches!(
        session.flow_type,
        ProviderFlowType::WebhookAsync | ProviderFlowType::OidcRedirect
    ) {
        return Err(ApiError::BadRequest(
            "This endpoint is only for webhook_async or oidc_redirect providers".to_string(),
        ));
    }

    if session.flow_type == ProviderFlowType::OidcRedirect {
        return Ok(Json(CompleteVerificationResponse {
            status: "pending".to_string(),
            claims: None,
            message: Some("Waiting for OIDC provider callback".to_string()),
            provider_status: None,
            warnings: None,
            retry_after_secs: Some(2),
        }));
    }

    // Get external session ID (webhook_async only path below)
    let external_session_id = match &session.flow_state {
        owl_issuer_service::FlowState::WebhookPending {
            external_session_id,
        } => external_session_id.clone(),
        _ => {
            return Err(ApiError::BadRequest(
                "Session not waiting for external callback".to_string(),
            ));
        }
    };

    let external_id = external_session_id
        .ok_or_else(|| ApiError::Internal("No external session ID stored".to_string()))?;

    // Get provider and fetch decision
    let registry = state.registry.read().await;
    let provider = registry.get(&session.provider_id).ok_or_else(|| {
        ApiError::Internal(format!("Provider not found: {}", session.provider_id))
    })?;

    // Try to get verification result from provider
    match provider.get_verification_result(&external_id).await {
        Ok(raw_claims) => {
            // Normalize claims
            let claims = raw_claims.normalize();

            // Store claims
            state.db.store_claims(id, &claims).await?;

            // Mark session as verified (raw_claims can be None since we stored normalized claims)
            state.db.mark_session_verified(id, None).await?;

            info!(
                "Completed verification for session {} via {}",
                id, session.provider_id
            );

            Ok(Json(CompleteVerificationResponse {
                status: "verified".to_string(),
                claims: Some(claims),
                message: None,
                provider_status: None,
                warnings: None,
                retry_after_secs: None,
            }))
        }
        Err(owl_issuer_service::IdpError::VerificationPending(msg)) => {
            Ok(Json(CompleteVerificationResponse {
                status: "pending".to_string(),
                claims: None,
                message: Some(msg),
                provider_status: None,
                warnings: None,
                retry_after_secs: Some(5),
            }))
        }
        Err(owl_issuer_service::IdpError::VerificationPendingWithDetails(details)) => {
            let warnings = if details.warnings.is_empty() {
                None
            } else {
                Some(
                    details
                        .warnings
                        .into_iter()
                        .map(|w| VerificationWarningResponse {
                            code: w.code,
                            short_description: w.short_description,
                            long_description: w.long_description,
                            risk: w.risk,
                        })
                        .collect(),
                )
            };

            Ok(Json(CompleteVerificationResponse {
                status: "pending".to_string(),
                claims: None,
                message: Some(details.message),
                provider_status: Some(details.provider_status),
                warnings,
                retry_after_secs: Some(details.retry_after_secs),
            }))
        }
        // Provider returned a terminal "declined / failed KYC" decision.
        // This is normal user-flow output, not a server error — emit it in
        // the same 200 envelope the poller already understands so the UI
        // can stop polling and surface the reason.
        Err(owl_issuer_service::IdpError::VerificationFailed(reason)) => {
            Ok(Json(CompleteVerificationResponse {
                status: "failed".to_string(),
                claims: None,
                message: Some(reason),
                provider_status: None,
                warnings: None,
                retry_after_secs: None,
            }))
        }
        Err(e) => Err(ApiError::from(e)),
    }
}

#[derive(Serialize, utoipa::ToSchema)]
struct CompleteVerificationResponse {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    claims: Option<VerifiedIdentityClaims>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// Provider-specific status (e.g., "In Review", "Pending")
    #[serde(skip_serializing_if = "Option::is_none", rename = "providerStatus")]
    provider_status: Option<String>,
    /// Warnings/reasons for manual review
    #[serde(skip_serializing_if = "Option::is_none")]
    warnings: Option<Vec<VerificationWarningResponse>>,
    /// Suggested retry delay in seconds (for exponential backoff)
    #[serde(skip_serializing_if = "Option::is_none", rename = "retryAfterSecs")]
    retry_after_secs: Option<u32>,
}

#[derive(Serialize, utoipa::ToSchema)]
struct VerificationWarningResponse {
    code: String,
    #[serde(rename = "shortDescription")]
    short_description: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "longDescription")]
    long_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk: Option<String>,
}

// ============================================================================
// Callback Handlers (for non-form flows)
// ============================================================================

/// SAML callback query parameters
#[derive(Debug, Deserialize)]
struct SamlCallbackQuery {
    #[serde(rename = "RelayState")]
    relay_state: Option<String>,
}

/// SAML callback request body (form-encoded)
#[derive(Debug, Deserialize)]
struct SamlCallbackBody {
    #[serde(rename = "SAMLResponse")]
    saml_response: String,
    #[serde(rename = "RelayState")]
    relay_state: Option<String>,
}

/// Handle SAML assertion callback from identity provider
#[utoipa::path(
    post,
    path = "/callbacks/saml",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "SAML callback processed", body = serde_json::Value),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Session not found"),
    ),
    tag = "callbacks"
)]
async fn handle_saml_callback(
    State(state): State<AppState>,
    Query(query): Query<SamlCallbackQuery>,
    Json(body): Json<SamlCallbackBody>,
) -> Result<Json<CallbackResponse>, ApiError> {
    let relay_state = body
        .relay_state
        .or(query.relay_state)
        .ok_or_else(|| ApiError::BadRequest("Missing RelayState".to_string()))?;

    // Find session by relay state
    let session = state
        .db
        .find_session_by_relay_state(&relay_state)
        .await
        .ok_or_else(|| ApiError::NotFound("Session not found for relay state".to_string()))?;

    // Get provider
    let registry = state.registry.read().await;
    let provider = registry.get(&session.provider_id).ok_or_else(|| {
        ApiError::Internal(format!("Provider not found: {}", session.provider_id))
    })?;

    // Process SAML assertion
    let raw_claims = provider
        .handle_saml_callback(session.id, &body.saml_response)
        .await?;

    // Normalize and store claims
    let claims = raw_claims.normalize();
    state.db.store_claims(session.id, &claims).await?;

    // Mark session as verified
    let raw_json =
        serde_json::to_value(&raw_claims).map_err(|e| ApiError::Internal(e.to_string()))?;
    state
        .db
        .mark_session_verified(session.id, Some(raw_json))
        .await?;

    Ok(Json(CallbackResponse {
        success: true,
        session_id: session.id,
        status: SessionStatus::Verified,
        redirect_url: Some(format!("/verify?session={}", session.id)),
    }))
}

/// Webhook request with provider-specific body
#[derive(Debug, Deserialize)]
struct WebhookBody {
    #[serde(flatten)]
    data: serde_json::Value,
}

/// Handle webhook from external provider (Onfido, Jumio, etc.)
#[utoipa::path(
    post,
    path = "/callbacks/webhook/{provider}",
    params(
        ("provider" = String, Path, description = "Provider ID"),
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Webhook processed", body = serde_json::Value),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Provider or session not found"),
    ),
    tag = "callbacks"
)]
async fn handle_webhook(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<WebhookBody>,
) -> Result<Json<CallbackResponse>, ApiError> {
    // Extract headers into HashMap
    let header_map: HashMap<String, String> = headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|vs| (k.as_str().to_string(), vs.to_string()))
        })
        .collect();

    // Create webhook payload
    let payload = WebhookPayload {
        body: body.data.clone(),
        headers: header_map,
        provider_id: provider_id.clone(),
    };

    // Get provider from registry
    let registry = state.registry.read().await;
    let provider = registry
        .get(&provider_id)
        .ok_or_else(|| ApiError::NotFound(format!("Provider not found: {}", provider_id)))?;

    // Process webhook
    let raw_claims = provider.handle_webhook(&payload).await?;

    // Extract session ID from webhook (provider-specific)
    // For now, try to find it in the webhook body
    let external_id = body
        .data
        .get("session_id")
        .or_else(|| body.data.get("applicant_id"))
        .or_else(|| body.data.get("verification_id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            ApiError::BadRequest("Cannot extract session ID from webhook".to_string())
        })?;

    let session = state
        .db
        .find_session_by_external_id(external_id)
        .await
        .ok_or_else(|| {
            ApiError::NotFound(format!(
                "Session not found for external ID: {}",
                external_id
            ))
        })?;

    // Normalize and store claims
    let claims = raw_claims.normalize();
    state.db.store_claims(session.id, &claims).await?;

    // Mark session as verified
    let raw_json =
        serde_json::to_value(&raw_claims).map_err(|e| ApiError::Internal(e.to_string()))?;
    state
        .db
        .mark_session_verified(session.id, Some(raw_json))
        .await?;

    info!(
        "Webhook processed for provider {} session {}",
        provider_id, session.id
    );

    Ok(Json(CallbackResponse {
        success: true,
        session_id: session.id,
        status: SessionStatus::Verified,
        redirect_url: None,
    }))
}

/// Response from callback handlers
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CallbackResponse {
    success: bool,
    session_id: Uuid,
    status: SessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    redirect_url: Option<String>,
}

/// Poll session status (for QR polling flows like BankID, Didit webhook).
#[utoipa::path(
    get,
    path = "/polling/{session_id}",
    params(
        ("session_id" = Uuid, Path, description = "Session ID"),
    ),
    responses(
        (status = 200, description = "Poll status", body = serde_json::Value),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Session not found"),
    ),
    tag = "polling"
)]
async fn poll_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
) -> Result<Json<PollResponse>, ApiError> {
    let session = state
        .db
        .get_session(session_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", session_id)))?;

    // Only poll QR-based sessions
    if session.flow_type != ProviderFlowType::QrPolling {
        return Err(ApiError::BadRequest(
            "Session does not use QR polling".to_string(),
        ));
    }

    // Get provider and poll
    let registry = state.registry.read().await;
    let provider = registry.get(&session.provider_id).ok_or_else(|| {
        ApiError::Internal(format!("Provider not found: {}", session.provider_id))
    })?;

    // Get order_ref from flow state
    let order_ref = match &session.flow_state {
        FlowState::Polling { order_ref, .. } => order_ref.clone(),
        _ => {
            return Err(ApiError::BadRequest(
                "Session not in polling state".to_string(),
            ));
        }
    };

    let poll_result = provider.poll_status(session.id, &order_ref).await?;

    // Update poll state
    state
        .db
        .update_polling_state(session.id, &order_ref)
        .await?;

    // Handle poll result
    match poll_result {
        owl_issuer_service::PollResult::Complete(raw_claims) => {
            let claims = raw_claims.normalize();
            state.db.store_claims(session.id, &claims).await?;

            let raw_json =
                serde_json::to_value(&raw_claims).map_err(|e| ApiError::Internal(e.to_string()))?;
            state
                .db
                .mark_session_verified(session.id, Some(raw_json))
                .await?;

            Ok(Json(PollResponse {
                status: SessionStatus::Verified,
                message: "Verification complete".to_string(),
                hint: None,
            }))
        }
        owl_issuer_service::PollResult::Pending { message, hint } => Ok(Json(PollResponse {
            status: SessionStatus::Pending,
            message,
            hint,
        })),
        owl_issuer_service::PollResult::UserInteracting { message } => Ok(Json(PollResponse {
            status: SessionStatus::Verifying,
            message,
            hint: None,
        })),
        owl_issuer_service::PollResult::Failed { reason, .. } => {
            state
                .db
                .mark_session_failed(session.id, reason.clone())
                .await?;
            Ok(Json(PollResponse {
                status: SessionStatus::Failed,
                message: reason,
                hint: None,
            }))
        }
        owl_issuer_service::PollResult::Expired => {
            state
                .db
                .update_session_status(session.id, SessionStatus::Expired)
                .await?;
            Ok(Json(PollResponse {
                status: SessionStatus::Expired,
                message: "Session expired".to_string(),
                hint: None,
            }))
        }
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct PollResponse {
    status: SessionStatus,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

// ============================================================================
// OIDC Auth Handlers
// ============================================================================

/// List available OIDC providers
#[utoipa::path(get, path = "/auth/providers", tag = "oidc", responses((status = 200, description = "List of available OIDC providers", body = Vec<OidcProviderInfo>)))]
async fn list_oidc_providers() -> Json<Vec<OidcProviderInfo>> {
    let providers = owl_issuer_service::oidc::load_oidc_providers();
    Json(
        providers
            .into_iter()
            .map(|p| OidcProviderInfo {
                provider_id: p.provider_id,
                issuer_url: p.issuer_url,
            })
            .collect(),
    )
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct OidcProviderInfo {
    provider_id: String,
    issuer_url: String,
}

/// OIDC login - redirects user to the provider's authorization endpoint
#[utoipa::path(
    get,
    path = "/auth/login/{provider}",
    params(
        ("provider" = String, Path, description = "OIDC provider ID"),
    ),
    responses(
        (status = 200, description = "OIDC login URL", body = OidcLoginResponse),
        (status = 404, description = "Provider not found"),
    ),
    tag = "oidc"
)]
async fn oidc_login(
    State(app): State<AppState>,
    Path(provider_id): Path<String>,
) -> Result<Json<OidcLoginResponse>, ApiError> {
    let providers = owl_issuer_service::oidc::load_oidc_providers();
    let config = providers
        .into_iter()
        .find(|p| p.provider_id == provider_id)
        .ok_or_else(|| ApiError::NotFound(format!("OIDC provider not found: {}", provider_id)))?;

    let code_verifier: String = (0..43)
        .map(|_| {
            let idx = rand::random::<u8>() % 62;
            match idx {
                0..=25 => (b'A' + idx) as char,
                26..=51 => (b'a' + idx - 26) as char,
                _ => (b'0' + idx - 52) as char,
            }
        })
        .collect();

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let code_challenge = base64_url_encode(&hasher.finalize());

    let state = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();

    app.oidc_state
        .insert(owl_issuer_service::oidc_state::StoredOidcState {
            state: state.clone(),
            code_verifier,
            nonce: nonce.clone(),
            provider_id: provider_id.clone(),
            created_at: std::time::Instant::now(),
            session_id: None,
        })
        .await;

    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        config.issuer_url.trim_end_matches('/')
    );

    let auth_url = owl_issuer_service::oidc::build_auth_url(
        &config,
        &format!("{}/authorize", config.issuer_url.trim_end_matches('/')),
        &state,
        &nonce,
        &code_challenge,
    );

    Ok(Json(OidcLoginResponse {
        auth_url,
        state,
        discovery_url,
    }))
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct OidcLoginResponse {
    auth_url: String,
    state: String,
    discovery_url: String,
}

/// OIDC callback query parameters
#[derive(Debug, Deserialize, utoipa::ToSchema)]
struct OidcCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// OIDC callback - handles the authorization code callback
/// Exchanges code for tokens, fetches userinfo, and maps claims.
#[utoipa::path(
    get,
    path = "/auth/callback/{provider}",
    params(
        ("provider" = String, Path, description = "OIDC provider ID"),
        ("code" = Option<String>, Query, description = "Authorization code"),
        ("state" = Option<String>, Query, description = "State parameter"),
        ("error" = Option<String>, Query, description = "Error code"),
        ("error_description" = Option<String>, Query, description = "Error description"),
    ),
    responses(
        (status = 200, description = "OIDC callback processed", body = OidcCallbackResponse),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Provider not found"),
    ),
    tag = "oidc"
)]
async fn oidc_callback(
    State(app): State<AppState>,
    Path(provider_id): Path<String>,
    Query(query): Query<OidcCallbackQuery>,
) -> Result<axum::response::Response, ApiError> {
    // Helper: HTTP 302 back to the app `/callback` so every provider
    // (Didit / OIDC / future) finishes on the same success/error page.
    let redirect_back = |session: Option<&uuid::Uuid>, err: Option<&str>| {
        use axum::response::Redirect;
        let base = app.app_url.trim_end_matches('/');
        let url = match (session, err) {
            (_, Some(e)) => format!("{}/callback?error={}", base, urlencode(e)),
            (Some(id), None) => format!("{}/callback?session={}", base, id),
            (None, None) => format!("{}/callback?error=missing_session", base),
        };
        Redirect::to(&url).into_response()
    };

    if let Some(error) = query.error.clone() {
        let desc = query.error_description.clone().unwrap_or_default();
        let msg = format!("{}: {}", error, desc);
        return Ok(redirect_back(None, Some(&msg)));
    }

    let code = match query.code {
        Some(c) => c,
        None => return Ok(redirect_back(None, Some("Missing authorization code"))),
    };
    let received_state = match query.state {
        Some(s) => s,
        None => return Ok(redirect_back(None, Some("Missing state parameter"))),
    };

    let preview = match app.oidc_state.peek(&received_state).await {
        Some(p) => p,
        None => return Ok(redirect_back(None, Some("Invalid or expired state"))),
    };
    if preview.provider_id != provider_id {
        return Ok(redirect_back(None, Some("State / provider mismatch")));
    }

    if let Some(session_id) = preview.session_id {
        let registry = app.registry.read().await;
        let provider = match registry.get(&provider_id) {
            Some(p) => p,
            None => {
                return Ok(redirect_back(
                    Some(&session_id),
                    Some("Provider not registered"),
                ));
            }
        };
        let raw_claims = match provider
            .handle_oidc_callback(session_id, &code, &received_state)
            .await
        {
            Ok(c) => c,
            Err(e) => {
                return Ok(redirect_back(
                    Some(&session_id),
                    Some(&format!("OIDC callback failed: {}", e)),
                ));
            }
        };

        let verified = raw_claims.normalize();
        if let Err(e) = app.db.store_claims(session_id, &verified).await {
            return Ok(redirect_back(
                Some(&session_id),
                Some(&format!("store_claims: {}", e)),
            ));
        }
        if let Err(e) = app.db.mark_session_verified(session_id, None).await {
            return Ok(redirect_back(
                Some(&session_id),
                Some(&format!("mark_session_verified: {}", e)),
            ));
        }

        return Ok(redirect_back(Some(&session_id), None));
    }

    // Standalone path: consume the entry + return JSON. Unchanged
    // legacy behaviour.
    let stored = app
        .oidc_state
        .take(&received_state)
        .await
        .ok_or_else(|| ApiError::BadRequest("Invalid or expired state".to_string()))?;

    let providers = owl_issuer_service::oidc::load_oidc_providers();
    let config = providers
        .into_iter()
        .find(|p| p.provider_id == provider_id)
        .ok_or_else(|| ApiError::NotFound(format!("OIDC provider not found: {}", provider_id)))?;

    let discovery = owl_issuer_service::oidc::discover(&config.issuer_url)
        .await
        .map_err(|e| ApiError::BadRequest(format!("OIDC discovery failed: {}", e)))?;

    let token_response = owl_issuer_service::oidc::exchange_code(
        &config,
        &discovery.token_endpoint,
        &code,
        &stored.code_verifier,
    )
    .await
    .map_err(|e| ApiError::BadRequest(format!("Token exchange failed: {}", e)))?;

    let id_token = token_response
        .id_token
        .as_ref()
        .ok_or_else(|| ApiError::BadRequest("Provider returned no id_token".to_string()))?;
    verify_id_token(
        id_token,
        &config.client_id,
        &discovery.issuer,
        &stored.nonce,
    )?;

    let claims = if let Some(ref userinfo_endpoint) = discovery.userinfo_endpoint {
        owl_issuer_service::oidc::fetch_userinfo(userinfo_endpoint, &token_response.access_token)
            .await
            .unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };

    let mapped_claims = owl_issuer_service::oidc::map_claims(&claims, &config.claim_mappings);

    Ok(Json(OidcCallbackResponse {
        provider_id,
        claims: mapped_claims,
        has_id_token: true,
        message: "Authentication successful. Claims extracted from provider.".to_string(),
    })
    .into_response())
}

/// Minimal RFC 3986 percent-encoding for the small set of characters we
/// stuff into a redirect URL.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[derive(Debug, Deserialize)]
struct IdTokenClaims {
    iss: String,
    aud: serde_json::Value,
    exp: i64,
    #[serde(default)]
    nbf: Option<i64>,
    #[serde(default)]
    nonce: Option<String>,
}

/// Decode the OIDC `id_token`, verify `iss`, `aud`, `exp`, optional `nbf`,
/// and the bound `nonce`. Signature verification is intentionally disabled
/// here — the `code` was redeemed over TLS at the discovered token endpoint,
/// so the token's authenticity is bound to that channel; the JWT body is
/// only re-checked for tampering between provider and us. JWKS-backed
/// signature validation is a follow-up.
fn verify_id_token(
    id_token: &str,
    expected_audience: &str,
    expected_issuer: &str,
    expected_nonce: &str,
) -> Result<(), ApiError> {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation};

    let mut validation = Validation::new(Algorithm::RS256);
    validation.insecure_disable_signature_validation();
    validation.validate_aud = false;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.required_spec_claims = std::collections::HashSet::new();
    validation.algorithms = vec![
        Algorithm::RS256,
        Algorithm::RS384,
        Algorithm::RS512,
        Algorithm::ES256,
        Algorithm::ES384,
        Algorithm::HS256,
    ];

    let key = DecodingKey::from_secret(&[]);
    let data = jsonwebtoken::decode::<IdTokenClaims>(id_token, &key, &validation)
        .map_err(|e| ApiError::BadRequest(format!("Invalid id_token: {}", e)))?;
    let claims = data.claims;

    if claims.iss != expected_issuer {
        return Err(ApiError::BadRequest(format!(
            "id_token issuer mismatch: expected {}, got {}",
            expected_issuer, claims.iss
        )));
    }

    let aud_ok = match &claims.aud {
        serde_json::Value::String(s) => s == expected_audience,
        serde_json::Value::Array(items) => {
            items.iter().any(|v| v.as_str() == Some(expected_audience))
        }
        _ => false,
    };
    if !aud_ok {
        return Err(ApiError::BadRequest(
            "id_token audience does not contain client_id".to_string(),
        ));
    }

    let now = chrono::Utc::now().timestamp();
    if claims.exp <= now {
        return Err(ApiError::BadRequest("id_token expired".to_string()));
    }
    if let Some(nbf) = claims.nbf
        && now < nbf
    {
        return Err(ApiError::BadRequest("id_token not yet valid".to_string()));
    }

    match claims.nonce.as_deref() {
        Some(n) if n == expected_nonce => Ok(()),
        Some(_) => Err(ApiError::BadRequest("id_token nonce mismatch".to_string())),
        None => Err(ApiError::BadRequest("id_token missing nonce".to_string())),
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct OidcCallbackResponse {
    provider_id: String,
    claims: std::collections::HashMap<String, serde_json::Value>,
    has_id_token: bool,
    message: String,
}

fn base64_url_encode(data: &[u8]) -> String {
    use base64::prelude::*;
    BASE64_STANDARD
        .encode(data)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

// ============================================================================
// Error Handling
// ============================================================================

#[derive(Debug)]
enum ApiError {
    NotFound(String),
    BadRequest(String),
    Internal(String),
    IdpError(owl_issuer_service::IdpError),
}

impl From<owl_issuer_service::IdpError> for ApiError {
    fn from(e: owl_issuer_service::IdpError) -> Self {
        match &e {
            owl_issuer_service::IdpError::SessionNotFound(id) => {
                ApiError::NotFound(format!("Session not found: {}", id))
            }
            owl_issuer_service::IdpError::SessionExpired => {
                ApiError::BadRequest("Session expired".to_string())
            }
            owl_issuer_service::IdpError::InvalidSessionState { expected, actual } => {
                ApiError::BadRequest(format!(
                    "Invalid session state: expected {}, got {}",
                    expected, actual
                ))
            }
            owl_issuer_service::IdpError::MissingField(f) => {
                ApiError::BadRequest(format!("Missing field: {}", f))
            }
            owl_issuer_service::IdpError::InvalidField { field, reason } => {
                ApiError::BadRequest(format!("Invalid {}: {}", field, reason))
            }
            _ => ApiError::IdpError(e),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
            ApiError::IdpError(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };

        let body = serde_json::json!({
            "error": message,
        });

        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        credential_identity_anchor_args, recovery_subject_hash, recovery_subject_material,
    };
    use chrono::{NaiveDate, Utc};
    use owl_issuer_service::{VerificationLevel, VerifiedIdentityClaims};
    use sha2::{Digest, Sha256};

    #[test]
    fn credential_identity_anchor_uses_holder_hash_as_did_and_credential_as_commitment() {
        let issuer = owl_crypto::KeyPair::generate();
        let issuer_private_key_hex = hex::encode(issuer.to_bytes());
        let owner_public_key = "holder-public-key-hex";
        let credential_id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let anchor = credential_identity_anchor_args(
            owner_public_key,
            credential_id,
            &issuer_private_key_hex,
        )
        .expect("valid issuer key");

        assert_eq!(
            anchor.did_hash,
            hex::encode(Sha256::digest(owner_public_key.as_bytes()))
        );
        assert_eq!(anchor.commitment, credential_id);
        assert_eq!(
            anchor.issuer_key_hash,
            hex::encode(Sha256::digest(issuer.public_key().to_hex().as_bytes()))
        );
    }

    fn base_claims(provider_id: &str) -> VerifiedIdentityClaims {
        VerifiedIdentityClaims {
            first_name: "Ada".to_string(),
            last_name: "Lovelace".to_string(),
            date_of_birth: NaiveDate::from_ymd_opt(1900, 1, 1).unwrap(),
            place_of_birth: String::new(),
            nationality: String::new(),
            gender: None,
            national_id: String::new(),
            passport_number: None,
            drivers_license: None,
            tax_id: None,
            document_type: None,
            document_number: None,
            issuing_country: None,
            document_expiry: None,
            document_issue_date: None,
            portrait_image: None,
            street_address: String::new(),
            city: String::new(),
            postal_code: String::new(),
            country: String::new(),
            email: None,
            email_verified: None,
            name: None,
            picture: None,
            locale: None,
            hosted_domain: None,
            is_over_18: false,
            is_over_21: false,
            is_over_65: false,
            is_eu_citizen: false,
            is_resident: false,
            resident_country: None,
            verified_at: Utc::now(),
            verification_level: VerificationLevel::Low,
            provider_id: provider_id.to_string(),
            verification_method: "oidc".to_string(),
        }
    }

    #[test]
    fn recovery_subject_uses_oidc_subject_not_email() {
        let mut claims = base_claims("google");
        claims.national_id = "google-sub-123".to_string();
        claims.email = Some("first@example.com".to_string());
        let first_hash = recovery_subject_hash(&claims, b"secret").expect("recoverable");

        claims.email = Some("renamed@example.com".to_string());
        assert_eq!(
            recovery_subject_material(&claims).as_deref(),
            Some("oidc:google:google-sub-123")
        );
        assert_eq!(
            first_hash,
            recovery_subject_hash(&claims, b"secret").expect("recoverable")
        );
    }

    #[test]
    fn recovery_subject_uses_document_identity_when_available() {
        let mut claims = base_claims("didit");
        claims.document_number = Some("AB1234567".to_string());
        claims.document_type = Some("passport".to_string());
        claims.issuing_country = Some("NL".to_string());

        assert_eq!(
            recovery_subject_material(&claims).as_deref(),
            Some("doc:didit:NL:passport:AB1234567")
        );
    }
}
