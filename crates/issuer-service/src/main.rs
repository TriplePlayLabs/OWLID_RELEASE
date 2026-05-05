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

mod midnight;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};

/// T-010: Service startup config validation
struct IssuerConfig {
    host: String,
    port: u16,
}

impl IssuerConfig {
    fn from_env() -> Result<Self, Vec<String>> {
        let mut errors = Vec::new();

        let host = std::env::var("ISSUER_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

        let port = std::env::var("ISSUER_PORT")
            .unwrap_or_else(|_| "8001".to_string())
            .parse::<u16>();

        let port = match port {
            Ok(p) => p,
            Err(_) => {
                errors.push("ISSUER_PORT must be a valid port number".to_string());
                8001
            }
        };

        if !errors.is_empty() {
            return Err(errors);
        }

        Ok(IssuerConfig { host, port })
    }
}
use owl_issuer_service::{
    db::{create_pool, CredentialRepository},
    BridgeConfig, CredentialBridge, DiditConfig, DiditProvider, FlowState, FormConfig, FormField,
    FormFieldType, IdpDatabase, IdentitySubmissionForm, MockBankIdProvider, MockDigiDProvider,
    MockProviderFactory, ProviderFlowType, ProviderInfo, ProviderInfoExtended, ProviderRegistry,
    SessionStatus, VerificationLevel, VerificationStart, VerifiedIdentityClaims, WebhookPayload,
};
use serde::{Deserialize, Serialize};
use utoipa::OpenApi;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
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
        generate_keypair,
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
        ProviderInfoExtended,
        ProviderInfo,
        CallbackResponse,
        PollResponse,
        KeyPairResponse,
    )),
    tags(
        (name = "info", description = "Service information"),
        (name = "providers", description = "Identity providers"),
        (name = "sessions", description = "Verification sessions"),
        (name = "credentials", description = "Credential issuance"),
        (name = "oidc", description = "OpenID Connect"),
        (name = "callbacks", description = "Provider callbacks"),
        (name = "internal", description = "Internal polling"),
        (name = "utilities", description = "Utility endpoints"),
    )
)]
struct ApiDoc;

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

    // T-010: Validate all config upfront
    let issuer_config = IssuerConfig::from_env().unwrap_or_else(|errors| {
        for err in &errors {
            tracing::error!("Configuration error: {}", err);
        }
        std::process::exit(1);
    });

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

    // Try to connect to PostgreSQL for credential storage (optional)
    // Prefer service-specific URL, fallback to shared DATABASE_URL
    let credential_bridge = match std::env::var("ISSUER_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
    {
        Ok(database_url) => {
            info!("Connecting to database for credential storage...");
            match create_pool(&database_url).await {
                Ok(pool) => {
                    info!("Database connection established");
                    CredentialBridge::with_config(BridgeConfig {
                        include_raw_fields: true,
                        include_derived_proofs: true,
                        include_metadata: true,
                    }).with_credential_repo(CredentialRepository::new(pool))
                }
                Err(e) => {
                    tracing::warn!("Failed to connect to database: {}. Credential storage disabled.", e);
                    CredentialBridge::with_config(BridgeConfig {
                        include_raw_fields: true,
                        include_derived_proofs: true,
                        include_metadata: true,
                    })
                }
            }
        }
        Err(_) => {
            info!("ISSUER_DATABASE_URL not set. Credential storage disabled.");
            CredentialBridge::with_config(BridgeConfig {
                include_raw_fields: true,
                include_derived_proofs: true,
                include_metadata: true,
            })
        }
    };

    let credential_bridge = Arc::new(credential_bridge);

    // For PoC, generate an issuer key on startup if not provided.
    // In production, this would be securely stored and managed.
    let issuer_private_key = std::env::var("ISSUER_PRIVATE_KEY")
        .or_else(|_| std::env::var("IDP_ISSUER_PRIVATE_KEY"))
        .unwrap_or_else(|_| {
            let keypair = owl_crypto::KeyPair::generate();
            let private_key = hex::encode(keypair.to_bytes());
            info!("Generated new issuer keypair. Public key: {}", keypair.public_key().to_hex());
            private_key
        });

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

    let state = AppState {
        db,
        factory,
        registry,
        credential_bridge,
        issuer_private_key,
        midnight: midnight_client.clone(),
    };

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

    // Build CORS layer
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // T-017: Load OIDC providers
    let oidc_providers = owl_issuer_service::oidc::load_oidc_providers();
    if oidc_providers.is_empty() {
        info!("No OIDC providers configured");
    } else {
        info!("Loaded {} OIDC provider(s)", oidc_providers.len());
    }

    // Build router
    let app = Router::new()
        // OpenAPI spec + Swagger UI
        .merge(utoipa_swagger_ui::SwaggerUi::new("/swagger-ui").url("/openapi.json", ApiDoc::openapi()))
        // Health and info
        .route("/health", get(health))
        .route("/issuer-info", get(get_issuer_info))
        .route("/providers", get(list_providers))
        // Session management
        .route("/sessions", post(create_session))
        .route("/sessions/{id}", get(get_session))
        .route("/sessions/{id}/submit", post(submit_identity))
        .route("/sessions/{id}/claims", get(get_claims))
        .route("/sessions/{id}/issue", post(issue_credential))
        // Auto-verify with sample data (for testing mock providers)
        .route("/sessions/{id}/auto-verify", post(auto_verify))
        // Complete verification (for webhook_async providers like Didit)
        .route("/sessions/{id}/complete", post(complete_verification))
        // Provider callbacks
        .route("/callbacks/saml", post(handle_saml_callback))
        .route("/callbacks/webhook/{provider}", post(handle_webhook))
        // T-017: OIDC auth routes
        .route("/auth/login/{provider}", get(oidc_login))
        .route("/auth/callback/{provider}", get(oidc_callback))
        .route("/auth/providers", get(list_oidc_providers))
        // Polling status (internal, called by background task)
        .route("/internal/poll/{session_id}", get(poll_session))
        // Utilities
        .route("/keypair", post(generate_keypair))
        .layer(cors)
        .with_state(state);

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
#[utoipa::path(get, path = "/providers", tag = "providers", responses((status = 200, description = "List of available identity providers", body = Vec<serde_json::Value>)))]
async fn list_providers(State(state): State<AppState>) -> Json<Vec<ProviderInfoExtended>> {
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
    // Get session and verify it's verified
    let session = state
        .db
        .get_session(id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Session not found: {}", id)))?;

    if session.status != SessionStatus::Verified {
        return Err(ApiError::BadRequest(format!(
            "Session not verified (status: {:?})",
            session.status
        )));
    }

    // Get claims
    let claims = state
        .db
        .get_claims(id)
        .await?
        .ok_or_else(|| ApiError::Internal("Claims not found".to_string()))?;

    // Use server's configured issuer key
    let issuer_key = state.issuer_private_key.clone();

    // Issue credential directly via bridge (no HTTP call)
    let proof_document = state
        .credential_bridge
        .issue_credential(
            &claims,
            &issuer_key,
            &request.owner_public_key,
            request.key_algorithm.to_signature_algorithm(),
        )
        .await?;

    // Serialize to JSON for response
    let credential = serde_json::to_value(&proof_document)
        .map_err(|e| ApiError::Internal(format!("Serialization error: {}", e)))?;

    // Mark credential as issued
    state.db.mark_credential_issued(id).await?;

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

/// Poll session status (for QR polling flows)
#[utoipa::path(
    get,
    path = "/internal/poll/{session_id}",
    params(
        ("session_id" = Uuid, Path, description = "Session ID"),
    ),
    responses(
        (status = 200, description = "Poll status", body = serde_json::Value),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Session not found"),
    ),
    tag = "internal"
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
// Utilities
// ============================================================================

/// Generate a new keypair (for testing)
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct KeyPairResponse {
    public_key: String,
    private_key: String,
}

#[utoipa::path(
    post,
    path = "/keypair",
    responses(
        (status = 200, description = "Generated keypair", body = serde_json::Value),
    ),
    tag = "utilities"
)]
async fn generate_keypair() -> Json<KeyPairResponse> {
    use owl_crypto::KeyPair;

    let kp = KeyPair::generate();
    Json(KeyPairResponse {
        public_key: kp.public_key().to_hex(),
        private_key: hex::encode(kp.to_bytes()),
    })
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
    Path(provider_id): Path<String>,
) -> Result<Json<OidcLoginResponse>, ApiError> {
    let providers = owl_issuer_service::oidc::load_oidc_providers();
    let config = providers
        .into_iter()
        .find(|p| p.provider_id == provider_id)
        .ok_or_else(|| ApiError::NotFound(format!("OIDC provider not found: {}", provider_id)))?;

    // Generate PKCE challenge
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

    // Generate state and nonce
    let state = Uuid::new_v4().to_string();
    let nonce = Uuid::new_v4().to_string();

    // Discover authorization endpoint
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        config.issuer_url.trim_end_matches('/')
    );

    // Build the auth URL (we return it to the client to redirect)
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
    /// PKCE code verifier (passed from client that initiated the flow)
    code_verifier: Option<String>,
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
        ("code_verifier" = Option<String>, Query, description = "PKCE code verifier"),
    ),
    responses(
        (status = 200, description = "OIDC callback processed", body = OidcCallbackResponse),
        (status = 400, description = "Bad request"),
        (status = 404, description = "Provider not found"),
    ),
    tag = "oidc"
)]
async fn oidc_callback(
    Path(provider_id): Path<String>,
    Query(query): Query<OidcCallbackQuery>,
) -> Result<Json<OidcCallbackResponse>, ApiError> {
    // Check for errors from the provider
    if let Some(error) = query.error {
        let desc = query.error_description.unwrap_or_default();
        return Err(ApiError::BadRequest(format!(
            "OIDC error from {}: {} - {}",
            provider_id, error, desc
        )));
    }

    let code = query.code.ok_or_else(|| {
        ApiError::BadRequest("Missing authorization code".to_string())
    })?;

    // Find the provider config
    let providers = owl_issuer_service::oidc::load_oidc_providers();
    let config = providers
        .into_iter()
        .find(|p| p.provider_id == provider_id)
        .ok_or_else(|| ApiError::NotFound(format!("OIDC provider not found: {}", provider_id)))?;

    // Discover endpoints
    let discovery = owl_issuer_service::oidc::discover(&config.issuer_url)
        .await
        .map_err(|e| ApiError::BadRequest(format!("OIDC discovery failed: {}", e)))?;

    // Exchange authorization code for tokens
    // Note: In production, the code_verifier should be retrieved from server-side session
    // storage keyed by the state parameter. For now we accept it from the query.
    let code_verifier = query.code_verifier.unwrap_or_default();
    let token_response = owl_issuer_service::oidc::exchange_code(
        &config,
        &discovery.token_endpoint,
        &code,
        &code_verifier,
    )
    .await
    .map_err(|e| ApiError::BadRequest(format!("Token exchange failed: {}", e)))?;

    // Fetch user claims from userinfo endpoint if available
    let claims = if let Some(ref userinfo_endpoint) = discovery.userinfo_endpoint {
        owl_issuer_service::oidc::fetch_userinfo(userinfo_endpoint, &token_response.access_token)
            .await
            .unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };

    // Map provider claims to OwlID claims
    let mapped_claims = owl_issuer_service::oidc::map_claims(&claims, &config.claim_mappings);

    Ok(Json(OidcCallbackResponse {
        provider_id,
        claims: mapped_claims,
        has_id_token: token_response.id_token.is_some(),
        message: "Authentication successful. Claims extracted from provider.".to_string(),
    }))
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
