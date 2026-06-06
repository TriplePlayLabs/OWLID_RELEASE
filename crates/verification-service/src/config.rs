//! Central configuration for the verification service.
//!
//! Every environment variable consumed by the service is declared here.
//! `Config::from_env()` is called once at startup; it logs the resolved
//! values (redacting secrets) and fails fast on invalid required vars.
//!
//! Other modules read env vars only via accessor methods on `Config`.
//! Adding a new env var?
//!   1. Add a field below.
//!   2. Read it in `from_env()`.
//!   3. Add it to the `Display` impl so it shows up in startup logs.
//!   4. Document the default in `.env.example`.
//!
//! This way one file is the source of truth for "what does this service
//! configure from the environment".
use std::fmt;

/// Default verification service bind host.
pub const DEFAULT_HOST: &str = "0.0.0.0";
/// Default verification service port.
pub const DEFAULT_PORT: u16 = 8000;
/// Default Midnight sidecar URL (docker-internal).
pub const DEFAULT_MIDNIGHT_SIDECAR_URL: &str = "http://midnight-sidecar:3000";
/// Default Midnight sidecar timeout in seconds.
pub const DEFAULT_MIDNIGHT_SIDECAR_TIMEOUT: u64 = 30;
/// Default rate limit window in minutes.
pub const DEFAULT_RATE_LIMIT_WINDOW_MINUTES: i64 = 1;
/// Default rate limit max requests per window.
pub const DEFAULT_RATE_LIMIT_MAX_REQUESTS: i32 = 100;

/// Known-bad placeholder values from `.env.example` / older `.env.prod`. Boot
/// is refused when `APP_ENV=production` and any required secret matches.
pub const KNOWN_DEFAULT_SECRETS: &[&str] = &[
    "owlid-admin-jwt-secret-change-me",
    "change-this-to-a-random-secret-in-production",
    "dev_key_12345678901234567890123456789012",
];

/// Minimum acceptable length for symmetric secrets (HMAC keys, API keys).
/// 32 chars covers a 16-byte hex-encoded value at the low end.
pub const MIN_SECRET_LENGTH: usize = 32;

#[derive(Debug, Clone)]
pub struct Config {
    /// `postgres://owl:...@postgres-verification:5432/verification`. Required.
    pub database_url: String,
    /// HTTP bind host. Defaults to `0.0.0.0`.
    pub host: String,
    /// HTTP bind port. Defaults to `8000`.
    pub port: u16,

    /// Sidecar URL. Defaults to `http://midnight-sidecar:3000`.
    pub midnight_sidecar_url: String,
    /// Shared secret for sidecar `X-API-Key`. Optional but recommended.
    pub midnight_sidecar_api_key: Option<String>,
    /// Per-request timeout to sidecar in seconds.
    pub midnight_sidecar_timeout_secs: u64,
    /// Midnight network id the sidecar binds to (`undeployed` for local
    /// devnet, `preprod`/`mainnet` elsewhere). Surfaced verbatim via
    /// `GET /midnight/info` so the SDK can call midnight-js
    /// `setNetworkId()` before any contract operation.
    pub midnight_network_id: String,

    /// HMAC signing key for admin JWTs. **Must** override the default in prod.
    pub admin_jwt_secret: String,
    /// AES-GCM encryption key for at-rest credential data. Hex-encoded 32 bytes.
    pub encryption_key: Option<String>,

    /// Rate-limit middleware enabled. Defaults to `true`.
    pub rate_limit_enabled: bool,
    /// Rate-limit window in minutes.
    pub rate_limit_window_minutes: i64,
    /// Rate-limit max requests per window.
    pub rate_limit_max_requests: i32,

    /// TLS enabled. Defaults to `false`. When true, `tls_cert_path` and
    /// `tls_key_path` are required.
    pub tls_enabled: bool,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
    pub tls_ca_cert_path: Option<String>,

    /// Deployment environment marker. `production` enables fail-fast on
    /// known-default secrets and weak rotation choices.
    pub app_env: String,
    /// Comma-separated allowlist of frontend origins (full scheme+host).
    /// Used to build the `CorsLayer` in place of the permissive default.
    /// Empty = falls back to a localhost dev allowlist.
    pub cors_allowed_origins: Vec<String>,
    /// Comma-separated allowlist of expected WebAuthn origins, checked by
    /// the verifier on every relying-party assertion. Empty = origin is not
    /// checked server-side (relies on browser enforcement only).
    pub webauthn_expected_origins: Vec<String>,
    /// Externally-reachable HTTPS URL of this verifier — used to build
    /// the OpenID4VP 1.0 §5/§8 `request_uri` + `response_uri` that
    /// external wallets fetch. Defaults to `http://<host>:<port>`.
    pub verification_public_url: String,
}

#[derive(Debug)]
pub struct ConfigError(pub Vec<String>);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "verification-service config errors:")?;
        for e in &self.0 {
            writeln!(f, "  - {e}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

fn env_optional(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn env_or(key: &str, default: &str) -> String {
    env_optional(key).unwrap_or_else(|| default.to_string())
}

fn env_bool(key: &str, default: bool) -> bool {
    env_optional(key)
        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    env_optional(key)
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut errors = Vec::new();

        let database_url =
            env_optional("VERIFICATION_DATABASE_URL").or_else(|| env_optional("DATABASE_URL"));
        if database_url.is_none() {
            errors.push("VERIFICATION_DATABASE_URL or DATABASE_URL must be set".into());
        }

        let host = env_or("SERVER_HOST", DEFAULT_HOST);
        let port = match env_optional("SERVER_PORT") {
            Some(p) => p.parse::<u16>().unwrap_or_else(|_| {
                errors.push(format!("SERVER_PORT must be 1..65535 (got {p})"));
                DEFAULT_PORT
            }),
            None => DEFAULT_PORT,
        };

        let midnight_sidecar_url = env_or("MIDNIGHT_SIDECAR_URL", DEFAULT_MIDNIGHT_SIDECAR_URL);
        let midnight_sidecar_api_key = env_optional("MIDNIGHT_SIDECAR_API_KEY");
        let midnight_sidecar_timeout_secs =
            env_parse("MIDNIGHT_SIDECAR_TIMEOUT", DEFAULT_MIDNIGHT_SIDECAR_TIMEOUT);
        let midnight_network_id = env_or("MIDNIGHT_NETWORK_ID", "undeployed");

        if midnight_sidecar_api_key.is_none() {
            tracing::warn!("MIDNIGHT_SIDECAR_API_KEY is unset — sidecar requests will be rejected");
        }
        if let Some(ref k) = midnight_sidecar_api_key {
            if KNOWN_DEFAULT_SECRETS.contains(&k.as_str()) {
                let msg = "MIDNIGHT_SIDECAR_API_KEY is a known-default placeholder";
                if std::env::var("APP_ENV").map(|v| v.to_lowercase()) == Ok("production".into()) {
                    errors.push(msg.into());
                } else {
                    tracing::warn!("{msg}");
                }
            }
        }

        let app_env = env_or("APP_ENV", "development").to_lowercase();
        let is_prod = app_env == "production";

        let admin_jwt_secret = env_or("ADMIN_JWT_SECRET", "owlid-admin-jwt-secret-change-me");
        if KNOWN_DEFAULT_SECRETS.contains(&admin_jwt_secret.as_str()) {
            let msg = "ADMIN_JWT_SECRET is set to a known-default placeholder \
                      — generate one with `openssl rand -hex 32`";
            if is_prod {
                errors.push(msg.into());
            } else {
                tracing::warn!("{msg}");
            }
        } else if admin_jwt_secret.len() < MIN_SECRET_LENGTH {
            let msg = format!(
                "ADMIN_JWT_SECRET is too short ({} < {})",
                admin_jwt_secret.len(),
                MIN_SECRET_LENGTH
            );
            if is_prod {
                errors.push(msg);
            } else {
                tracing::warn!("{msg}");
            }
        }

        let encryption_key = env_optional("ENCRYPTION_KEY");

        let rate_limit_enabled = env_bool("RATE_LIMIT_ENABLED", true);
        let rate_limit_window_minutes = env_parse(
            "RATE_LIMIT_WINDOW_MINUTES",
            DEFAULT_RATE_LIMIT_WINDOW_MINUTES,
        );
        let rate_limit_max_requests =
            env_parse("RATE_LIMIT_MAX_REQUESTS", DEFAULT_RATE_LIMIT_MAX_REQUESTS);

        let tls_enabled = env_bool("TLS_ENABLED", false);
        let tls_cert_path = env_optional("TLS_CERT_PATH");
        let tls_key_path = env_optional("TLS_KEY_PATH");
        let tls_ca_cert_path = env_optional("TLS_CA_CERT_PATH");

        if tls_enabled && (tls_cert_path.is_none() || tls_key_path.is_none()) {
            errors.push("TLS_ENABLED=true requires both TLS_CERT_PATH and TLS_KEY_PATH".into());
        }

        let cors_allowed_origins = parse_csv("CORS_ALLOWED_ORIGINS");
        if is_prod && cors_allowed_origins.is_empty() {
            errors.push(
                "APP_ENV=production requires CORS_ALLOWED_ORIGINS (comma-separated full URLs)"
                    .into(),
            );
        }

        let webauthn_expected_origins = parse_csv("WEBAUTHN_EXPECTED_ORIGINS");
        if is_prod && webauthn_expected_origins.is_empty() {
            tracing::warn!(
                "WEBAUTHN_EXPECTED_ORIGINS is unset — server-side origin check on WebAuthn assertions is disabled"
            );
        }

        let verification_public_url =
            env_or("VERIFICATION_PUBLIC_URL", &format!("http://{host}:{port}"));

        if !errors.is_empty() {
            return Err(ConfigError(errors));
        }

        Ok(Config {
            database_url: database_url.unwrap(),
            host,
            port,
            midnight_sidecar_url,
            midnight_sidecar_api_key,
            midnight_sidecar_timeout_secs,
            midnight_network_id,
            admin_jwt_secret,
            encryption_key,
            rate_limit_enabled,
            rate_limit_window_minutes,
            rate_limit_max_requests,
            tls_enabled,
            tls_cert_path,
            tls_key_path,
            tls_ca_cert_path,
            app_env,
            cors_allowed_origins,
            webauthn_expected_origins,
            verification_public_url,
        })
    }
}

fn parse_csv(key: &str) -> Vec<String> {
    env_optional(key)
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "verification-service config:")?;
        writeln!(f, "  bind:                {}:{}", self.host, self.port)?;
        writeln!(
            f,
            "  database:            {}",
            redact_db_url(&self.database_url)
        )?;
        writeln!(f, "  midnight sidecar:    {}", self.midnight_sidecar_url)?;
        writeln!(
            f,
            "  midnight api key:    {}",
            mask(self.midnight_sidecar_api_key.as_deref())
        )?;
        writeln!(
            f,
            "  midnight timeout:    {}s",
            self.midnight_sidecar_timeout_secs
        )?;
        writeln!(
            f,
            "  admin jwt secret:    {}",
            mask(Some(&self.admin_jwt_secret))
        )?;
        writeln!(
            f,
            "  encryption key:      {}",
            mask(self.encryption_key.as_deref())
        )?;
        writeln!(
            f,
            "  rate limit:          enabled={} window={}m max={}",
            self.rate_limit_enabled, self.rate_limit_window_minutes, self.rate_limit_max_requests
        )?;
        if self.tls_enabled {
            writeln!(
                f,
                "  tls:                 cert={} key={} ca={}",
                self.tls_cert_path.as_deref().unwrap_or("-"),
                self.tls_key_path.as_deref().unwrap_or("-"),
                self.tls_ca_cert_path.as_deref().unwrap_or("-")
            )?;
        }
        writeln!(f, "  app env:             {}", self.app_env)?;
        writeln!(
            f,
            "  cors origins:        {}",
            if self.cors_allowed_origins.is_empty() {
                "<dev localhost defaults>".into()
            } else {
                self.cors_allowed_origins.join(", ")
            }
        )?;
        writeln!(
            f,
            "  webauthn origins:    {}",
            if self.webauthn_expected_origins.is_empty() {
                "<unset>".into()
            } else {
                self.webauthn_expected_origins.join(", ")
            }
        )?;
        Ok(())
    }
}

fn mask(s: Option<&str>) -> String {
    match s {
        Some(v) if v.len() > 8 => format!("{}…(len={})", &v[..4], v.len()),
        Some(_) => "•••".into(),
        None => "<unset>".into(),
    }
}

fn redact_db_url(url: &str) -> String {
    // Replace password between : and @ in postgres://user:pass@host
    if let Some(scheme_end) = url.find("://") {
        let after = &url[scheme_end + 3..];
        if let Some(at) = after.find('@') {
            let auth = &after[..at];
            if let Some(colon) = auth.find(':') {
                let user = &auth[..colon];
                return format!("{}://{}:•••@{}", &url[..scheme_end], user, &after[at + 1..]);
            }
        }
    }
    url.to_string()
}
