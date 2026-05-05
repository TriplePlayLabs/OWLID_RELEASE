mod admin_auth;
mod api;
mod db;
mod gdpr;
mod midnight;
mod middleware;
mod observability;
mod presentation;
mod state;
mod tls;
mod ws;
mod zk_assets;

use crate::{
    db::create_pool,
    middleware::{AuthMiddleware, RateLimitConfig, RateLimitMiddleware, RateLimitState, require_permission},
    state::AppState,
    ws::RevocationBroadcaster,
};
use axum::{
    middleware as axum_middleware,
    routing::{delete, get, post},
    Json, Router,
};
use utoipa::OpenApi;
use std::{net::SocketAddr, sync::Arc};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// T-010: Service startup config validation
struct Config {
    database_url: String,
    host: String,
    port: u16,
}

impl Config {
    fn from_env() -> Result<Self, Vec<String>> {
        let mut errors = Vec::new();

        let database_url = std::env::var("VERIFICATION_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .ok();

        if database_url.is_none() {
            errors.push("VERIFICATION_DATABASE_URL or DATABASE_URL must be set".to_string());
        }

        let host = std::env::var("SERVER_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

        let port = std::env::var("SERVER_PORT")
            .unwrap_or_else(|_| "8000".to_string())
            .parse::<u16>();

        let port = match port {
            Ok(p) => p,
            Err(_) => {
                errors.push("SERVER_PORT must be a valid port number".to_string());
                8000
            }
        };

        if !errors.is_empty() {
            return Err(errors);
        }

        Ok(Config {
            database_url: database_url.unwrap(),
            host,
            port,
        })
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "OwlID Verification Service",
        version = "1.0.0",
        description = "Token verification, trusted issuer management, and credential revocation"
    ),
    paths(
        api::health,
        api::generate_challenge,
        api::verify_token,
        api::list_trusted_issuers,
        api::add_trusted_issuer,
        api::revoke_credential,
        api::suspend_credential,
        api::reactivate_credential,
        api::check_revocation,
        api::list_revoked,
        api::get_metrics,
        gdpr::gdpr_erasure,
        admin_auth::login,
        admin_auth::list_api_keys,
        admin_auth::create_api_key,
        admin_auth::deactivate_api_key,
        presentation::create_session,
    ),
    components(schemas(
        api::ChallengeResponse,
        api::VerifyRequest,
        api::VerifyResponse,
        api::AddTrustedIssuerRequest,
        api::AddTrustedIssuerResponse,
        api::TrustedIssuerInfo,
        api::RevokeCredentialRequest,
        api::ReactivateCredentialRequest,
        api::CheckRevocationRequest,
        api::CheckRevocationResponse,
        gdpr::ErasureReceipt,
        admin_auth::LoginRequest,
        admin_auth::LoginResponse,
        admin_auth::CreateApiKeyRequest,
        admin_auth::CreateApiKeyResponse,
        admin_auth::ApiKeyInfo,
        presentation::CreatePresentationResponse,
    )),
    tags(
        (name = "verification", description = "Token verification"),
        (name = "issuers", description = "Trusted issuer management"),
        (name = "revocations", description = "Credential revocation"),
        (name = "monitoring", description = "Service monitoring"),
        (name = "gdpr", description = "GDPR compliance"),
        (name = "admin", description = "Admin authentication and API key management"),
        (name = "presentation", description = "ISO 18013-5 style credential presentation"),
    )
)]
struct ApiDoc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load environment variables
    dotenvy::dotenv().ok();

    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "owl_verification_service=debug,tower_http=debug,sqlx=info".into()
            }),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("🌙 Starting OwlID Verification Service...");

    // T-010: Validate all config upfront
    let config = Config::from_env().unwrap_or_else(|errors| {
        for err in &errors {
            tracing::error!("Configuration error: {}", err);
        }
        std::process::exit(1);
    });

    let database_url = config.database_url;

    // Create database connection pool
    tracing::info!("📦 Connecting to database...");
    let db_pool = create_pool(&database_url).await?;
    tracing::info!("✅ Database connection established");

    // Test database connection
    sqlx::query("SELECT 1")
        .fetch_one(&db_pool)
        .await
        .expect("Failed to connect to database");
    tracing::info!("✅ Database connection verified");

    // T-020: Initialize Prometheus metrics recorder
    let metrics_handle = observability::init_metrics();

    // T-018: Initialize WebSocket revocation broadcaster
    let broadcaster = Arc::new(RevocationBroadcaster::new(1024));

    // Initialize Midnight sidecar client
    let midnight_config = midnight::MidnightConfig::from_env();
    let midnight_client = if midnight_config.enabled {
        tracing::info!("🌙 Midnight integration enabled, connecting to sidecar...");
        let sidecar = midnight::MidnightSidecar::new(midnight_config);
        match sidecar.health_check().await {
            Ok(true) => {
                tracing::info!("✅ Midnight sidecar connected and healthy");
                Some(Arc::new(sidecar))
            }
            Ok(false) => {
                tracing::warn!("⚠️ Midnight sidecar reachable but not connected to network");
                Some(Arc::new(sidecar))
            }
            Err(e) => {
                tracing::warn!("⚠️ Midnight sidecar unreachable: {}. Chain operations disabled.", e);
                None
            }
        }
    } else {
        tracing::info!("Midnight integration disabled (MIDNIGHT_ENABLED=false)");
        None
    };

    // Initialize application state
    tracing::info!("🔧 Initializing application state...");
    let state = AppState::new(db_pool, broadcaster, metrics_handle, midnight_client).await;
    tracing::info!("✅ Application state initialized");

    // T-003: Warn if no trusted issuers exist at startup
    {
        let issuers = state.issuers.list(false).await;
        match issuers {
            Ok(list) if list.is_empty() => {
                tracing::warn!("No trusted issuers configured. Register issuers via POST /trusted-issuers before issuing credentials.");
            }
            Ok(list) => {
                tracing::info!("Loaded {} trusted issuer(s)", list.len());
            }
            Err(e) => {
                tracing::warn!("Could not check trusted issuers: {}", e);
            }
        }
    }

    // Background cleanup tasks
    {
        let challenges = Arc::clone(&state.challenges);
        let presentations = Arc::clone(&state.presentations);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                // Clean expired challenges
                match challenges.cleanup_expired().await {
                    Ok(count) if count > 0 => {
                        tracing::debug!("Cleaned up {} expired challenge entries", count);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to clean up expired challenges: {}", e);
                    }
                    _ => {}
                }
                // Clean expired presentation sessions
                let cleaned = presentations.cleanup().await;
                if cleaned > 0 {
                    tracing::debug!("Cleaned up {} expired presentation sessions", cleaned);
                }
            }
        });
    }

    // T-015: Load rate limiting configuration
    let rate_limit_config = RateLimitConfig::from_env();
    if rate_limit_config.enabled {
        tracing::info!(
            "Rate limiting enabled: {} requests per {} minute(s)",
            rate_limit_config.max_requests,
            rate_limit_config.window_minutes
        );
    } else {
        tracing::info!("Rate limiting disabled (RATE_LIMIT_ENABLED=false)");
    }
    let rate_limit_state = RateLimitState {
        pool: state.db_pool.clone(),
        config: rate_limit_config,
    };

    // Create API key repository for auth middleware
    let api_key_repo = Arc::clone(&state.api_keys);

    // T-003: Build admin routes (require API key with "admin" permission)
    let admin_routes = Router::new()
        .route("/trusted-issuers", post(api::add_trusted_issuer))
        .route("/revocations/revoke", post(api::revoke_credential))
        .route("/revocations/suspend", post(api::suspend_credential))
        .route("/revocations/reactivate", post(api::reactivate_credential))
        .route("/admin/gdpr-erasure/{owner_public_key}", delete(gdpr::gdpr_erasure))
        .layer(axum_middleware::from_fn_with_state(
            Arc::clone(&api_key_repo),
            require_permission("admin"),
        ));

    // Build authenticated routes (require any valid API key)
    let authenticated_routes = Router::new()
        .route("/verify", post(api::verify_token))
        .route("/verify/challenge", get(api::generate_challenge))
        .route("/metrics", get(api::get_metrics))
        .route("/trusted-issuers", get(api::list_trusted_issuers))
        .route("/revocations/check", post(api::check_revocation))
        .route("/revocations/list", get(api::list_revoked))
        .merge(admin_routes)
        // T-015: Rate limiting (runs after auth)
        .layer(axum_middleware::from_fn_with_state(
            rate_limit_state,
            RateLimitMiddleware::check_rate_limit,
        ))
        .layer(axum_middleware::from_fn_with_state(
            api_key_repo,
            AuthMiddleware::validate,
        ));

    // Admin routes (JWT-protected, except login)
    let admin_routes = Router::new()
        .route("/admin/api-keys", get(admin_auth::list_api_keys))
        .route("/admin/api-keys", post(admin_auth::create_api_key))
        .route("/admin/api-keys/{id}", delete(admin_auth::deactivate_api_key))
        .layer(axum_middleware::from_fn(admin_auth::require_jwt));

    // Build router with public and protected routes
    let app = Router::new()
        .route("/health", get(api::health))
        .route("/admin/login", post(admin_auth::login))
        .merge(admin_routes)
        .merge(utoipa_swagger_ui::SwaggerUi::new("/swagger-ui").url("/openapi.json", ApiDoc::openapi()))
        // T-018: WebSocket endpoint for real-time revocation events
        .route("/ws/revocations", get(ws::ws_revocations))
        // Presentation protocol (ISO 18013-5 style)
        .route("/presentation/sessions", post(presentation::create_session))
        .route("/ws/presentation/{session_id}", get(presentation::ws_presentation))
        // T-020: Prometheus metrics endpoint
        .route("/prometheus", get(observability::prometheus_metrics))
        .merge(authenticated_routes)
        .with_state(state)
        // Midnight Compact ZK artifacts for browser FetchZkConfigProvider (stateless)
        .nest("/zk", zk_assets::router())
        // T-020: Correlation ID and request metrics middleware
        .layer(axum_middleware::from_fn(observability::correlation_and_metrics))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    // Use validated config
    let addr = format!("{}:{}", config.host, config.port);
    let socket_addr: SocketAddr = addr.parse().expect("Invalid socket address");

    tracing::info!("🚀 Token Verification Service listening on {}", socket_addr);

    let listener = tokio::net::TcpListener::bind(socket_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
