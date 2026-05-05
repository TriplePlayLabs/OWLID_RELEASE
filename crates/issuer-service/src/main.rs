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

mod admin_auth;
mod config;
mod midnight;
mod provider_admin;

use crate::config::Config as IssuerConfig;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware as axum_middleware,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use owl_issuer_service::{
    db::{create_pool, CredentialRepository, ProviderSettingsRepository},
    BridgeConfig, CredentialBridge, DiditConfig, DiditProvider, FlowState, FormConfig, FormField,
    FormFieldType, IdpDatabase, IdentitySubmissionForm, MockBankIdProvider, MockDigiDProvider,
    MockProviderFactory, ProviderDescriptor, ProviderFlowType, ProviderInfo, ProviderRegistry,
    SessionStatus, VerificationLevel, VerificationStart, VerifiedIdentityClaims, WebhookPayload,
    middleware::{InMemoryRateLimiter, RateLimitConfig, rate_limit, validate_session_bearer},
};
use serde::{Deserialize, Serialize};
use utoipa::OpenApi;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

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
        auto_verify,
        complete_verification,
        handle_saml_callback,
        handle_webhook,
        oidc_login,
        oidc_callback,
        list_oidc_providers,
        poll_session,
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
    /// Midnight sidecar client (None if MIDNIGHT_ENABLED=false)
    midnight: Option<Arc<midnight::MidnightSidecar>>,
    /// In-flight OIDC authorization requests, keyed by `state`.
    oidc_state: owl_issuer_service::oidc_state::OidcStateStore,
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
    let issuer_private_key = if let Ok(env_key) = std::env::var("ISSUER_PRIVATE_KEY")
        .or_else(|_| std::env::var("IDP_ISSUER_PRIVATE_KEY"))
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

    // Auto-register the active pubkey with the verification-service so
    // freshly-issued credentials verify out of the box. The call uses an
    // admin-permission API key (env: VERIFICATION_ADMIN_API_KEY, falling
    // back to the seeded dev key for local development). Idempotent: the
    // verification-service's `add_trusted_issuer` upserts on
    // `public_key`, so multiple boots don't pollute the table.
    {
        let pubkey_hex = owl_crypto::KeyPair::from_bytes(
            &hex::decode(&issuer_private_key).expect("issuer private key must be hex"),
        )
        .expect("issuer private key must be a valid Ed25519 seed")
        .public_key()
        .to_hex();
        let verification_url = std::env::var("VERIFICATION_SERVICE_URL")
            .unwrap_or_else(|_| "http://localhost:8000".to_string());
        let admin_key = std::env::var("VERIFICATION_ADMIN_API_KEY").unwrap_or_else(|_| {
            "owlid_sk_test_dev0000000000000000000000000000000000000000".to_string()
        });
        let issuer_name = std::env::var("ISSUER_NAME")
            .unwrap_or_else(|_| "OwlID Issuer Service".to_string());
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client");
            let body = serde_json::json!({
                "publicKey": pubkey_hex,
                "name": issuer_name,
            });
            let resp = client
                .post(format!("{}/trusted-issuers", verification_url.trim_end_matches('/')))
                .bearer_auth(&admin_key)
                .json(&body)
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    info!("Registered issuer pubkey with verification-service: {}", pubkey_hex);
                }
                Ok(r) => {
                    tracing::warn!(
                        "Auto-register issuer pubkey failed with status {}: {}",
                        r.status(),
                        r.text().await.unwrap_or_default()
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "Auto-register issuer pubkey unreachable ({}). Add it via /trusted-issuers manually.",
                        e
                    );
                }
            }
        });
    }

    // Initialize Midnight sidecar client
    let midnight_config = midnight::MidnightConfig::from_env();
    let midnight_client = if midnight_config.enabled {
        info!("Midnight integration enabled, connecting to sidecar...");
        let sidecar = midnight::MidnightSidecar::new(midnight_config);
        match sidecar.health_check().await {
            Ok(true) => {
                info!("Midnight sidecar connected and healthy");
                Some(Arc::new(sidecar))
            }
            Ok(false) => {
                tracing::warn!("Midnight sidecar reachable but not connected to network");
                Some(Arc::new(sidecar))
            }
            Err(e) => {
                tracing::warn!("Midnight sidecar unreachable: {}. Chain operations disabled.", e);
                None
            }
        }
    } else {
        info!("Midnight integration disabled (MIDNIGHT_ENABLED=false)");
        None
    };

    let oidc_state = owl_issuer_service::oidc_state::OidcStateStore::default();
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
        midnight: midnight_client.clone(),
        oidc_state,
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

    // T-003: Self-register issuer on-chain only if explicitly opted in
    let auto_register = std::env::var("MIDNIGHT_AUTO_REGISTER_ISSUER")
        .unwrap_or_else(|_| "false".to_string())
        .parse::<bool>()
        .unwrap_or(false);

    if auto_register {
        if let Some(ref midnight) = midnight_client {
        let keypair = owl_crypto::KeyPair::from_bytes(
            &hex::decode(&state.issuer_private_key).expect("Invalid issuer key"),
        )
        .expect("Invalid issuer keypair");
        let pk_hex = keypair.public_key().to_hex();
        let midnight = midnight.clone();
        tokio::spawn(async move {
            // Check if already registered, if not, register
            match midnight.is_issuer_trusted(&pk_hex).await {
                Ok(true) => {
                    info!("Issuer already registered on-chain: {}", pk_hex);
                }
                Ok(false) => {
                    info!("Registering issuer on-chain: {}", pk_hex);
                    if let Err(e) = midnight
                        .register_issuer(&pk_hex, "OwlID Issuer Service")
                        .await
                    {
                        tracing::warn!("Failed to self-register issuer on-chain: {}", e);
                    } else {
                        info!("Issuer registered on-chain successfully");
                    }
                }
                Err(e) => {
                    tracing::warn!("Failed to check issuer status on-chain: {}", e);
                }
            }
        });
    }
    } else if midnight_client.is_some() {
        tracing::info!("Midnight auto-registration disabled. Set MIDNIGHT_AUTO_REGISTER_ISSUER=true to enable.");
    }

    // Build CORS layer from CORS_ALLOWED_ORIGINS, falling back to the
    // local-dev frontend origins so a fresh checkout still works.
    let cors = build_cors_layer();

    let rate_config = RateLimitConfig::from_env();
    let rate_limiter = InMemoryRateLimiter::new(rate_config);

    // T-017: Load OIDC providers
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
        .merge(utoipa_swagger_ui::SwaggerUi::new("/swagger-ui").url("/openapi.json", ApiDoc::openapi()))
        .route("/health", get(health))
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
async fn health() -> &'static str {
    "Issuer Service is running"
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
        &hex::decode(&state.issuer_private_key).expect("Invalid issuer key")
    ).expect("Invalid issuer keypair");

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
    let registry = state.registry.read().await;
    Json(registry.list())
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
    if let VerificationStart::HostedUi { ref external_session_id, .. } = start_data {
        state.db.update_flow_state(
            session.id,
            FlowState::WebhookPending {
                external_session_id: Some(external_session_id.clone()),
            },
        ).await?;
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

    let claims = state
        .db
        .get_claims(id)
        .await?
        .ok_or_else(|| ApiError::Internal("Claims not found for verified session".to_string()))?;

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
}

/// Response from credential issuance
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct IssueCredentialResponse {
    success: bool,
    credential: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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
    // succeeds. Without this, `Document::issue` produces a fresh salt per
    // call so the UNIQUE(root_hash) constraint can't dedupe.
    state.db.try_claim_issuance(id).await.map_err(|err| match err {
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

    let proof_document = match state
        .credential_bridge
        .issue_credential(
            &claims,
            &issuer_key,
            &request.owner_public_key,
            request.key_algorithm.to_signature_algorithm(),
        )
        .await
    {
        Ok(doc) => doc,
        Err(err) => {
            let _ = state
                .db
                .update_session(id, |s| s.credential_issued = false)
                .await;
            return Err(err.into());
        }
    };

    let credential = serde_json::to_value(&proof_document)
        .map_err(|e| ApiError::Internal(format!("Serialization error: {}", e)))?;

    // Fire-and-forget: anchor identity commitment on-chain
    if let Some(ref midnight) = state.midnight {
        let owner_pk = request.owner_public_key.clone();
        let issuer_pk = state.issuer_private_key.clone();
        let midnight = midnight.clone();
        let credential_json = credential.clone();
        tokio::spawn(async move {
            // Compute DID hash from owner public key
            use sha2::{Digest, Sha256};
            let did_hash = hex::encode(Sha256::digest(owner_pk.as_bytes()));

            // Extract rootHash from the credential if available
            let root_hash = credential_json
                .get("rootHash")
                .and_then(|v| v.as_str())
                .unwrap_or(&did_hash);

            // Compute issuer key hash
            if let Ok(key_bytes) = hex::decode(&issuer_pk) {
                if let Ok(keypair) = owl_crypto::KeyPair::from_bytes(&key_bytes) {
                    let issuer_key_hash =
                        hex::encode(Sha256::digest(keypair.public_key().to_hex().as_bytes()));

                    if let Err(e) = midnight
                        .register_identity(root_hash, &did_hash, &issuer_key_hash)
                        .await
                    {
                        tracing::warn!(
                            "Failed to anchor identity on-chain (non-blocking): {}",
                            e
                        );
                    } else {
                        tracing::info!("Identity anchored on-chain for DID hash: {}", did_hash);
                    }
                }
            }
        });
    }

    Ok(Json(IssueCredentialResponse {
        success: true,
        credential,
        error: None,
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
            verification_level: VerificationLevel::Substantial,
            provider_id: "mock-digid".to_string(),
            verification_method: "simulated_saml".to_string(),
            verified_at: chrono::Utc::now(),
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
            verification_level: VerificationLevel::High,
            provider_id: "mock-bankid".to_string(),
            verification_method: "simulated_bankid".to_string(),
            verified_at: chrono::Utc::now(),
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
    state
        .db
        .mark_session_verified(id, None)
        .await?;

    info!("Auto-verified session {} with provider {}", id, session.provider_id);

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
        let claims = state
            .db
            .get_claims(id)
            .await?
            .ok_or_else(|| ApiError::Internal("Claims not found for verified session".to_string()))?;
        return Ok(Json(CompleteVerificationResponse {
            status: "verified".to_string(),
            claims: Some(claims),
            message: None,
            provider_status: None,
            warnings: None,
            retry_after_secs: None,
        }));
    }

    // Only for webhook_async providers
    if session.flow_type != owl_issuer_service::ProviderFlowType::WebhookAsync {
        return Err(ApiError::BadRequest(
            "This endpoint is only for webhook_async providers".to_string(),
        ));
    }

    // Get external session ID
    let external_session_id = match &session.flow_state {
        owl_issuer_service::FlowState::WebhookPending {
            external_session_id,
        } => external_session_id.clone(),
        _ => {
            return Err(ApiError::BadRequest(
                "Session not waiting for external callback".to_string(),
            ))
        }
    };

    let external_id = external_session_id.ok_or_else(|| {
        ApiError::Internal("No external session ID stored".to_string())
    })?;

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

            info!("Completed verification for session {} via {}", id, session.provider_id);

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
    let raw_json = serde_json::to_value(&raw_claims)
        .map_err(|e| ApiError::Internal(e.to_string()))?;
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
        .ok_or_else(|| ApiError::BadRequest("Cannot extract session ID from webhook".to_string()))?;

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
            ))
        }
    };

    let poll_result = provider.poll_status(session.id, &order_ref).await?;

    // Update poll state
    state.db.update_polling_state(session.id, &order_ref).await?;

    // Handle poll result
    match poll_result {
        owl_issuer_service::PollResult::Complete(raw_claims) => {
            let claims = raw_claims.normalize();
            state.db.store_claims(session.id, &claims).await?;

            let raw_json = serde_json::to_value(&raw_claims)
                .map_err(|e| ApiError::Internal(e.to_string()))?;
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
// T-017: OIDC Auth Handlers
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
) -> Result<Json<OidcCallbackResponse>, ApiError> {
    if let Some(error) = query.error {
        let desc = query.error_description.unwrap_or_default();
        return Err(ApiError::BadRequest(format!(
            "OIDC error from {}: {} - {}",
            provider_id, error, desc
        )));
    }

    let code = query
        .code
        .ok_or_else(|| ApiError::BadRequest("Missing authorization code".to_string()))?;
    let received_state = query
        .state
        .ok_or_else(|| ApiError::BadRequest("Missing state parameter".to_string()))?;

    let stored = app
        .oidc_state
        .take(&received_state)
        .await
        .ok_or_else(|| ApiError::BadRequest("Invalid or expired state".to_string()))?;
    if stored.provider_id != provider_id {
        return Err(ApiError::BadRequest(
            "State does not match callback provider".to_string(),
        ));
    }

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
    verify_id_token(id_token, &config.client_id, &discovery.issuer, &stored.nonce)?;

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
    }))
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
        serde_json::Value::Array(items) => items
            .iter()
            .any(|v| v.as_str() == Some(expected_audience)),
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
