mod admin_auth;
mod api;
mod api_key;
mod config;
mod db;
mod gdpr;
mod midnight;
mod midnight_admin;
mod middleware;
mod observability;
mod presentation;
mod registry;
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
use axum::http::{header, HeaderValue, Method};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::Config;

fn build_cors_layer(config: &Config) -> CorsLayer {
    let dev_default = [
        "http://localhost:5000",
        "http://localhost:5001",
        "http://localhost:4000",
        "http://127.0.0.1:5000",
        "http://127.0.0.1:5001",
        "http://127.0.0.1:4000",
    ];
    let origins: Vec<HeaderValue> = if config.cors_allowed_origins.is_empty() {
        dev_default.iter().filter_map(|o| o.parse().ok()).collect()
    } else {
        config
            .cors_allowed_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect()
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
        admin_auth::logout,
        admin_auth::me,
        admin_auth::change_password,
        admin_auth::list_api_keys,
        admin_auth::create_api_key,
        admin_auth::deactivate_api_key,
        presentation::create_session,
        registry::list_predicates,
        registry::list_circuit_data,
        registry::get_circuit_dataset,
        registry::list_proving_keys,
        registry::get_proving_key,
        midnight_admin::get_midnight_status,
        midnight_admin::enable_midnight,
        midnight_admin::disable_midnight,
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
        api::MetricsResponse,
        api::RevocationEntry,
        gdpr::ErasureReceipt,
        admin_auth::LoginRequest,
        admin_auth::LoginResponse,
        admin_auth::MeResponse,
        admin_auth::ChangePasswordRequest,
        admin_auth::ChangePasswordResponse,
        admin_auth::CreateApiKeyRequest,
        admin_auth::CreateApiKeyResponse,
        admin_auth::ApiKeyInfo,
        presentation::CreatePresentationResponse,
        registry::PredicateInfo,
        registry::CircuitDatasetInfo,
        registry::CircuitDataset,
        midnight_admin::MidnightStatus,
        midnight_admin::SidecarHealth,
        midnight_admin::ToggleResponse,
    )),
    tags(
        // Public — anyone with a valid API key may call.
        (name = "verification", description = "Token verification (verifyToken, generateChallenge)"),
        (name = "presentation", description = "ISO 18013-5 style credential presentation sessions"),
        (name = "monitoring", description = "Public health probe"),
        (name = "issuers", description = "Trusted issuer directory (read-only listing)"),
        (name = "revocations", description = "Revocation lookups (check, list)"),
        (name = "registry", description = "Predicate + circuit-dataset registry (public reference data)"),
        // Operator/admin — require manage-* permission or JWT.
        (name = "metrics", description = "Detailed metrics (admin)"),
        (name = "admin-issuers", description = "Trusted issuer management (admin)"),
        (name = "admin-revocations", description = "Credential revocation management (admin)"),
        (name = "gdpr", description = "GDPR right-to-be-forgotten (admin)"),
        (name = "admin-auth", description = "Admin session lifecycle: login, logout, current-user"),
        (name = "admin", description = "Admin API key management (CRUD)"),
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

    // Validate every env var upfront, fail fast on missing required ones.
    let config = Config::from_env().unwrap_or_else(|err| {
        for e in &err.0 {
            tracing::error!("config error: {}", e);
        }
        std::process::exit(1);
    });
    tracing::info!("\n{}", config);

    let database_url = config.database_url.clone();

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

    // Initialize Midnight sidecar client.
    //
    // Always construct the client when MIDNIGHT_SIDECAR_URL is configured —
    // even if the runtime flag is off — so an admin can flip it on at
    // runtime without a service restart. The DB setting
    // `system_settings.midnight_enabled` (if present) takes precedence over
    // the env var, so the last operator decision survives restarts.
    let mut midnight_config = midnight::MidnightConfig::from_env();
    let env_enabled = midnight_config.enabled;
    let settings_repo = db::SystemSettingsRepository::new(db_pool.clone());
    let stored_enabled = settings_repo
        .get_typed::<Option<bool>>(db::repositories::system_settings::keys::MIDNIGHT_ENABLED, None)
        .await;
    if let Some(stored) = stored_enabled {
        midnight_config.enabled = stored;
        tracing::info!(
            "Midnight runtime flag from DB: {} (env was {})",
            stored,
            env_enabled
        );
    }
    let midnight_client = {
        let sidecar = midnight::MidnightSidecar::new(midnight_config);
        if sidecar.is_enabled() {
            tracing::info!("🌙 Midnight integration enabled, probing sidecar...");
            match sidecar.health_check().await {
                Ok(true) => tracing::info!("✅ Midnight sidecar connected and healthy"),
                Ok(false) => {
                    tracing::warn!("⚠️ Midnight sidecar reachable but not connected to network")
                }
                Err(e) => tracing::warn!(
                    "⚠️ Midnight sidecar unreachable: {}. Chain operations will fail-open until it recovers.",
                    e
                ),
            }
        } else {
            tracing::info!(
                "Midnight integration is disabled. Flip via POST /admin/midnight/enable when ready."
            );
        }
        Some(Arc::new(sidecar))
    };

    // Initialize application state
    tracing::info!("🔧 Initializing application state...");
    let state = AppState::new(
        db_pool,
        broadcaster,
        metrics_handle,
        midnight_client,
        config.webauthn_expected_origins.clone(),
    )
    .await;
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

    // Pre-deserialize the embedded Groth16 verifying keys so the first
    // /verify request doesn't pay the one-shot cost (~tens of ms per
    // circuit). Keys live behind LazyLocks in `owl_zk_circuits`; this
    // forces them.
    {
        let t0 = std::time::Instant::now();
        owl_zk_circuits::prewarm_verifying_keys();
        tracing::info!(
            "Pre-warmed Groth16 verifying keys in {:.2}ms",
            t0.elapsed().as_secs_f64() * 1000.0
        );
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
        .layer(axum_middleware::from_fn_with_state(
            Arc::clone(&api_key_repo),
            require_permission("admin"),
        ));

    // GDPR erasure is gated separately so support keys can be issued with
    // `gdpr` permission without granting the full admin surface (and vice
    // versa). The route still requires a valid API key via the outer
    // `authenticated_routes` layering.
    let gdpr_routes = Router::new()
        .route("/admin/gdpr-erasure/{owner_public_key}", delete(gdpr::gdpr_erasure))
        .layer(axum_middleware::from_fn_with_state(
            Arc::clone(&api_key_repo),
            require_permission("gdpr"),
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
        .merge(gdpr_routes)
        // T-015: Rate limiting (runs after auth)
        .layer(axum_middleware::from_fn_with_state(
            rate_limit_state,
            RateLimitMiddleware::check_rate_limit,
        ))
        .layer(axum_middleware::from_fn_with_state(
            api_key_repo,
            AuthMiddleware::validate,
        ));

    // Admin routes (JWT-protected, except /admin/login + /admin/logout).
    //
    // /admin/midnight/* is grouped here because it speaks for the operator,
    // not for a service caller. The unified AuthMiddleware (further down)
    // also routes admin-cookie-bearing browsers, but these endpoints
    // intentionally require the JWT path so an API key alone can't flip
    // the integration.
    let admin_routes = Router::new()
        .route("/admin/me", get(admin_auth::me))
        .route("/admin/password", post(admin_auth::change_password))
        .route("/admin/api-keys", get(admin_auth::list_api_keys))
        .route("/admin/api-keys", post(admin_auth::create_api_key))
        .route("/admin/api-keys/{id}", delete(admin_auth::deactivate_api_key))
        .route("/admin/midnight/status", get(midnight_admin::get_midnight_status))
        .route("/admin/midnight/enable", post(midnight_admin::enable_midnight))
        .route("/admin/midnight/disable", post(midnight_admin::disable_midnight))
        .layer(axum_middleware::from_fn(admin_auth::require_jwt));

    // Build router with public and protected routes
    let app = Router::new()
        .route("/health", get(api::health))
        // Public predicate + circuit-dataset registry. Verifier-side apps
        // build selectors from these without needing an API key.
        .route("/predicates", get(registry::list_predicates))
        .route("/circuit-data", get(registry::list_circuit_data))
        .route("/circuit-data/{name}", get(registry::get_circuit_dataset))
        // Groth16 proving keys served to wallets that ship a WASM build
        // without embedded PKs. `/zk-keys` lists circuit names; the path
        // segment must be `<circuit>.pk.bin`.
        .route("/zk-keys", get(registry::list_proving_keys))
        .route("/zk-keys/{filename}", get(registry::get_proving_key))
        .route("/admin/login", post(admin_auth::login))
        // Logout is intentionally public+idempotent: clearing a cookie
        // shouldn't itself require an authenticated session.
        .route("/admin/logout", post(admin_auth::logout))
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
        .layer(build_cors_layer(&config))
        .layer(TraceLayer::new_for_http());

    // Use validated config
    let addr = format!("{}:{}", config.host, config.port);
    let socket_addr: SocketAddr = addr.parse().expect("Invalid socket address");

    tracing::info!("🚀 Token Verification Service listening on {}", socket_addr);

    let listener = tokio::net::TcpListener::bind(socket_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
