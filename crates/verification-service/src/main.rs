// Intentional `+`-connector prose in doc comments trips clippy's markdown
// list heuristic; the lint is cosmetic (rustdoc rendering only).
#![allow(clippy::doc_lazy_continuation)]

mod admin_auth;
mod admin_ops;
mod api;
mod api_key;
mod config;
mod db;
mod dcql;
mod did;
mod gdpr;
mod middleware;
mod midnight;
mod midnight_admin;
mod observability;
mod openid4vp;
mod predicate_assets;
mod presentation;
mod registry;
mod sidecar_events;
mod state;
mod tls;
mod ws;
mod zk_assets;

use crate::{
    db::ApiKeyRepository,
    db::create_pool,
    middleware::{RateLimitConfig, RateLimitMiddleware, RateLimitState, require_permission},
    state::AppState,
    ws::RevocationBroadcaster,
};
use axum::http::{HeaderValue, Method, header};
use axum::{
    Router, middleware as axum_middleware,
    routing::{delete, get, post},
};
use std::{net::SocketAddr, sync::Arc};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use utoipa::OpenApi;

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
        description = "SD-JWT VC presentation verification, trusted issuer management, and credential revocation"
    ),
    paths(
        api::health,
        api::get_midnight_info,
        api::get_midnight_params,
        api::generate_challenge,
        api::verify_dcql,
        api::list_trusted_issuers,
        api::add_trusted_issuer,
        api::revoke_credential,
        api::revoke_own_credential,
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
        admin_ops::list_audit_events,
        admin_ops::list_admin_users,
        admin_ops::create_admin_user,
        admin_ops::deactivate_admin_user,
        presentation::create_session,
        registry::list_predicates,
        registry::list_circuit_data,
        registry::get_circuit_dataset,
        registry::list_proving_keys,
        registry::get_proving_key,
        registry::list_predicate_assets,
        registry::get_predicate_asset,
        midnight_admin::get_midnight_status,
        api::check_predicate_attested,
        api::get_predicate_snapshot,
        api::relay_predicate_proof,
        api::stream_predicate_job_events,
    ),
    components(schemas(
        api::ChallengeResponse,
        api::MidnightInfoResponse,
        api::VerifyDcqlRequest,
        api::VerifyDcqlResponse,
        api::VerifyResponse,
        dcql::DcqlRequest,
        dcql::DcqlCredentialQuery,
        dcql::DcqlMeta,
        dcql::DcqlClaimQuery,
        dcql::DcqlCredentialSet,
        dcql::OwlPredicate,
        api::AddTrustedIssuerRequest,
        api::AddTrustedIssuerResponse,
        api::TrustedIssuerInfo,
        api::RevokeCredentialRequest,
        api::RevokeOwnCredentialRequest,
        api::RevokeOwnCredentialResponse,
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
        admin_ops::AuditEventInfo,
        admin_ops::AdminUserInfo,
        admin_ops::CreateAdminUserRequest,
        presentation::CreatePresentationResponse,
        registry::PredicateInfo,
        registry::CircuitDatasetInfo,
        registry::CircuitDataset,
        midnight_admin::MidnightStatus,
        midnight_admin::SidecarHealth,
        api::CheckPredicateRequest,
        api::CheckPredicateResponse,
        api::PredicateSnapshotResponse,
        api::RelayProofRequest,
        api::RelayProofResponse,
        api::TxStatusResponse,
    )),
    tags(
        // Public — anyone with a valid API key may call.
        (name = "verification", description = "SD-JWT VC presentation verification (verifyToken, generateChallenge)"),
        (name = "presentation", description = "ISO 18013-5 style credential presentation sessions"),
        (name = "monitoring", description = "Public health probe"),
        (name = "issuers", description = "Trusted issuer directory (read-only listing)"),
        (name = "revocations", description = "Revocation lookups (check, list)"),
        (name = "registry", description = "Predicate + circuit-dataset registry (public reference data)"),
        (name = "predicates", description = "Holder-device predicate attestation: state snapshot, proof relay, attested-set check"),
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

fn api_key_preview(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 16 {
        return key.to_string();
    }
    let prefix: String = chars.iter().take(14).collect();
    let suffix: String = chars
        .iter()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{prefix}...{suffix}")
}

fn api_key_type_and_env(key: &str) -> (&'static str, &'static str) {
    let key_type = if key.starts_with("owlid_pk_") {
        "pk"
    } else {
        "sk"
    };
    let environment = if key.contains("_live_") {
        "live"
    } else {
        "test"
    };
    (key_type, environment)
}

async fn ensure_configured_api_key(
    repo: &ApiKeyRepository,
    env_name: &str,
    name: &str,
    description: &str,
    permissions: Vec<&str>,
) -> anyhow::Result<()> {
    let Ok(key) = std::env::var(env_name) else {
        return Ok(());
    };
    if key.trim().is_empty() {
        return Ok(());
    }

    if repo.find_by_key(&key).await.is_ok() {
        tracing::info!("Configured API key from {} is already active", env_name);
        return Ok(());
    }

    let (key_type, environment) = api_key_type_and_env(&key);
    let permission_strings = permissions.into_iter().map(str::to_string).collect();
    repo.create(
        &key,
        name.to_string(),
        Some(description.to_string()),
        permission_strings,
        None,
        Some("system".to_string()),
        key_type,
        environment,
        &api_key_preview(&key),
    )
    .await?;
    tracing::info!(
        "Bootstrapped configured {} API key from {} with {} permissions",
        environment,
        env_name,
        key_type
    );
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `--dump-openapi`: print the OpenAPI spec and exit. Generated purely
    // from the utoipa annotations, so the API client can be regenerated
    // offline (no DB / chain) — mirrors what `/openapi.json` serves live.
    if std::env::args().any(|a| a == "--dump-openapi") {
        println!("{}", ApiDoc::openapi().to_pretty_json()?);
        return Ok(());
    }

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

    let metrics_handle = observability::init_metrics();

    let broadcaster = Arc::new(RevocationBroadcaster::new(1024));

    // Initialize Midnight sidecar client.
    //
    // Midnight is required — the service refuses to start without a
    // reachable sidecar. There is no runtime enable/disable toggle.
    let midnight_client = {
        let sidecar = midnight::MidnightSidecar::new(midnight::MidnightConfig::from_env());
        tracing::info!("🌙 Probing Midnight sidecar at {}", sidecar.base_url());
        // `VERIFICATION_SKIP_SIDECAR_PROBE=true` downgrades a probe
        // failure from hard-exit to warning. Useful for one-shot dev
        // workflows that just need the HTTP surface up (e.g.
        // `just generate-api-client` curling `/openapi.json`) without
        // a live sidecar.
        let skip_sidecar_probe = std::env::var("VERIFICATION_SKIP_SIDECAR_PROBE")
            .map(|v| matches!(v.as_str(), "true" | "1" | "yes"))
            .unwrap_or(false);
        match sidecar.health_check().await {
            Ok(true) => tracing::info!("✅ Midnight sidecar connected and healthy"),
            Ok(false) => tracing::warn!(
                "⚠️ Midnight sidecar reachable but not yet connected to network — proceeding"
            ),
            Err(e) => {
                if skip_sidecar_probe {
                    tracing::warn!(
                        "⚠️ Midnight sidecar unreachable at {}: {} — skipping per \
                         VERIFICATION_SKIP_SIDECAR_PROBE",
                        sidecar.base_url(),
                        e
                    );
                } else {
                    tracing::error!(
                        "❌ Midnight sidecar unreachable at {}: {}",
                        sidecar.base_url(),
                        e
                    );
                    std::process::exit(1);
                }
            }
        }
        Arc::new(sidecar)
    };

    // Initialize application state
    tracing::info!("🔧 Initializing application state...");
    let state = AppState::new(
        db_pool,
        broadcaster,
        metrics_handle,
        midnight_client,
        config.webauthn_expected_origins.clone(),
        config.verification_public_url.clone(),
        config.midnight_network_id.clone(),
    )
    .await;
    tracing::info!("✅ Application state initialized");

    // Subscribe to the Midnight sidecar event stream so revocations and
    // issuer changes published on chain are mirrored into local
    // Postgres + the in-memory cache without per-request round-trips.
    sidecar_events::spawn(Arc::new(state.clone()));

    ensure_configured_api_key(
        &state.api_keys,
        "VERIFIER_API_KEY",
        "Verifier App Key",
        "Browser publishable key used by the hosted verifier app",
        vec!["verify"],
    )
    .await?;

    ensure_configured_api_key(
        &state.api_keys,
        "API_KEY_DEV",
        "Terraform Dev Key",
        "Operator/service key provisioned from deployment configuration",
        vec![
            "verify",
            "manage_issuers",
            "manage_revocations",
            "admin",
            "gdpr",
        ],
    )
    .await?;

    // Warn if no trusted issuers exist at startup — verification will
    // reject every credential until at least one is registered.
    {
        let issuers = state.issuers.list(false).await;
        match issuers {
            Ok(list) if list.is_empty() => {
                tracing::warn!(
                    "No trusted issuers configured. Register issuers via POST /trusted-issuers before issuing credentials."
                );
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

    // Admin routes (require API key with "admin" permission).
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
        .route(
            "/admin/gdpr-erasure/{owner_public_key}",
            delete(gdpr::gdpr_erasure),
        )
        .layer(axum_middleware::from_fn_with_state(
            Arc::clone(&api_key_repo),
            require_permission("gdpr"),
        ));

    let verification_routes = Router::new()
        .route("/verify/dcql", post(api::verify_dcql))
        .route("/verify/challenge", get(api::generate_challenge))
        .route("/openid4vp/response", post(api::openid4vp_response))
        .route(
            "/predicates/attested",
            post(api::check_predicate_attested),
        )
        .route(
            "/predicates/{kind}/snapshot",
            get(api::get_predicate_snapshot),
        )
        .route(
            "/predicates/{kind}/relay",
            post(api::relay_predicate_proof),
        )
        .route(
            "/predicates/job/{job_id}/events",
            get(api::stream_predicate_job_events),
        )
        // Read-only trust/revocation surface — every verifier needs
        // these to render its own "is this issuer trusted?" / "is this
        // credential revoked?" UI, so they sit under the same `verify`
        // permission as the verify endpoints rather than admin.
        .route("/trusted-issuers", get(api::list_trusted_issuers))
        .route("/revocations/check", post(api::check_revocation))
        .route("/revocations/list", get(api::list_revoked))
        // Holder self-revocation: not admin — authorized by a per-credential
        // proof-of-possession (KB-JWT) carried in the request body, so it
        // sits under `verify` with the rest of the holder/verifier surface.
        .route("/revocations/revoke-mine", post(api::revoke_own_credential))
        .layer(axum_middleware::from_fn_with_state(
            Arc::clone(&api_key_repo),
            require_permission("verify"),
        ));

    // Operator-only read routes. The list above moved out — these are
    // ops / observability surfaces a customer verifier never calls.
    let service_read_routes = Router::new()
        .route("/metrics", get(api::get_metrics))
        .layer(axum_middleware::from_fn_with_state(
            Arc::clone(&api_key_repo),
            require_permission("admin"),
        ));

    let authenticated_routes = Router::new()
        .merge(verification_routes)
        .merge(service_read_routes)
        .merge(admin_routes)
        .merge(gdpr_routes)
        .layer(axum_middleware::from_fn_with_state(
            rate_limit_state,
            RateLimitMiddleware::check_rate_limit,
        ));

    // Admin routes (JWT-protected, except /admin/login + /admin/logout).
    // /admin/midnight/* is grouped here because it speaks for the operator,
    // not for a service caller.
    let admin_routes = Router::new()
        .route("/admin/me", get(admin_auth::me))
        .route("/admin/password", post(admin_auth::change_password))
        .route("/admin/api-keys", get(admin_auth::list_api_keys))
        .route("/admin/api-keys", post(admin_auth::create_api_key))
        .route(
            "/admin/api-keys/{id}",
            delete(admin_auth::deactivate_api_key),
        )
        .route("/admin/audit-events", get(admin_ops::list_audit_events))
        .route("/admin/users", get(admin_ops::list_admin_users))
        .route("/admin/users", post(admin_ops::create_admin_user))
        .route(
            "/admin/users/{id}",
            delete(admin_ops::deactivate_admin_user),
        )
        .route(
            "/admin/midnight/status",
            get(midnight_admin::get_midnight_status),
        )
        .layer(axum_middleware::from_fn(admin_auth::require_jwt));

    // Build router with public and protected routes
    let app = Router::new()
        .route("/health", get(api::health))
        // Public Midnight network info — wallet bootstrap reads this
        // before any contract call so midnight-js `setNetworkId()` can
        // be set. Not secret.
        .route("/midnight/info", get(api::get_midnight_info))
        // CORS-friendly proxy of the universal BLS SRS the in-process
        // zkir-v2 prover needs. Upstream S3 bucket lacks CORS headers,
        // so the browser can't fetch directly. Public, immutably cached.
        .route("/midnight/params/{k}", get(api::get_midnight_params))
        // The IETF Token Status List the issuer publishes is public; the
        // revoked-id feed it is projected from is likewise not secret
        // (the signed statuslist+jwt already encodes the same state).
        // The issuer fetches this unauthenticated to build /status/{id}.
        .route("/status-revoked", get(api::status_revoked))
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
        // Per-kind predicate Compact artifacts (zkir/prover/verifier)
        // for every deployed kind, same role as /zk-keys for the
        // holder's WASM build.
        .route("/predicate-zk", get(registry::list_predicate_assets))
        .route("/predicate-zk/{filename}", get(registry::get_predicate_asset))
        .route("/admin/login", post(admin_auth::login))
        // Logout is intentionally public+idempotent: clearing a cookie
        // shouldn't itself require an authenticated session.
        .route("/admin/logout", post(admin_auth::logout))
        .merge(admin_routes)
        .merge(utoipa_swagger_ui::SwaggerUi::new("/swagger-ui").url("/openapi.json", ApiDoc::openapi()))
        .route("/ws/revocations", get(ws::ws_revocations))
        .route("/ws/events", get(ws::ws_events))
        // Presentation protocol (ISO 18013-5 style)
        .route("/presentation/sessions", post(presentation::create_session))
        .route("/ws/presentation/{session_id}", get(presentation::ws_presentation))
        // OpenID4VP 1.0 §5 Authorization Request — external wallets
        // fetch the Request Object here after scanning the
        // openid4vp://?request_uri=... deeplink.
        .route(
            "/openid4vp/request/{session_id}",
            get(openid4vp::get_authorization_request),
        )
        .route("/prometheus", get(observability::prometheus_metrics))
        .merge(authenticated_routes)
        .with_state(state)
        // Midnight Compact ZK artifacts for browser FetchZkConfigProvider (stateless)
        .nest("/zk", zk_assets::router())
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
