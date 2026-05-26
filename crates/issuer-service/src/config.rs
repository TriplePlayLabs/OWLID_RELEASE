//! Central configuration for the issuer service.
//!
//! Single source of truth for every env var the service reads. Other modules
//! should consult `Config` rather than calling `std::env::var` directly.
//! Adding a new env var?
//!   1. Add a field below.
//!   2. Read it in `from_env()`.
//!   3. Add it to the `Display` impl so it surfaces in startup logs.
//!   4. Document the default in `.env.example`.
use std::fmt;

pub const DEFAULT_HOST: &str = "0.0.0.0";
pub const DEFAULT_PORT: u16 = 8001;
pub const DEFAULT_MIDNIGHT_SIDECAR_URL: &str = "http://midnight-sidecar:3000";
pub const DEFAULT_MIDNIGHT_SIDECAR_TIMEOUT: u64 = 30;
pub const DEFAULT_APP_URL: &str = "http://localhost:5000";

#[derive(Debug, Clone)]
pub struct Config {
    /// `postgres://owl:...@postgres-issuer:5433/issuer`. Required.
    pub database_url: String,
    pub host: String,
    pub port: u16,

    /// Public-facing URL of the holder app, used as base for OAuth redirects
    /// and Didit callbacks.
    pub app_url: String,

    /// Public-facing base URL of THIS issuer service. Drives the issuer
    /// `did:web` identifier and the Token Status List `uri`.
    pub issuer_public_url: String,

    /// Hex-encoded Ed25519 private key the issuer signs credentials with.
    /// Required for credential issuance to function.
    pub issuer_private_key: Option<String>,

    /// Verification service URL used to register the issuer public key as trusted.
    pub verification_service_url: String,
    /// Admin/service API key for verification-service issuer registry writes.
    pub verification_admin_api_key: Option<String>,

    pub midnight_sidecar_url: String,
    pub midnight_sidecar_api_key: Option<String>,
    pub midnight_sidecar_timeout_secs: u64,

    /// Optional Didit KYC integration. Required only when used.
    pub didit_api_key: Option<String>,
    pub didit_workflow_id: Option<String>,
    pub didit_base_url: Option<String>,
    pub didit_webhook_secret: Option<String>,

    /// Comma-separated list of OIDC provider prefixes (each provider declares
    /// `<PREFIX>_ISSUER_URL`, `<PREFIX>_CLIENT_ID`, etc.).
    pub oidc_providers: Option<String>,
}

#[derive(Debug)]
pub struct ConfigError(pub Vec<String>);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "issuer-service config errors:")?;
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

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    env_optional(key)
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut errors = Vec::new();

        let database_url =
            env_optional("ISSUER_DATABASE_URL").or_else(|| env_optional("DATABASE_URL"));
        if database_url.is_none() {
            errors.push("ISSUER_DATABASE_URL or DATABASE_URL must be set".into());
        }

        let host = env_or("ISSUER_HOST", DEFAULT_HOST);
        let port = match env_optional("ISSUER_PORT") {
            Some(p) => p.parse::<u16>().unwrap_or_else(|_| {
                errors.push(format!("ISSUER_PORT must be 1..65535 (got {p})"));
                DEFAULT_PORT
            }),
            None => DEFAULT_PORT,
        };

        let app_url = env_or("APP_URL", DEFAULT_APP_URL);
        let issuer_public_url = env_or("ISSUER_PUBLIC_URL", "http://localhost:8001");

        let issuer_private_key =
            env_optional("ISSUER_PRIVATE_KEY").or_else(|| env_optional("IDP_ISSUER_PRIVATE_KEY"));
        let verification_service_url = env_or("VERIFICATION_SERVICE_URL", "http://localhost:8000");
        let verification_admin_api_key =
            env_optional("VERIFICATION_ADMIN_API_KEY").or_else(|| env_optional("API_KEY_DEV"));

        let midnight_sidecar_url = env_or("MIDNIGHT_SIDECAR_URL", DEFAULT_MIDNIGHT_SIDECAR_URL);
        let midnight_sidecar_api_key = env_optional("MIDNIGHT_SIDECAR_API_KEY");
        let midnight_sidecar_timeout_secs =
            env_parse("MIDNIGHT_SIDECAR_TIMEOUT", DEFAULT_MIDNIGHT_SIDECAR_TIMEOUT);

        if midnight_sidecar_api_key.is_none() {
            tracing::warn!(
                "MIDNIGHT_SIDECAR_API_KEY is unset — sidecar requests will be rejected"
            );
        }

        let didit_api_key = env_optional("DIDIT_API_KEY");
        let didit_workflow_id = env_optional("DIDIT_WORKFLOW_ID");
        let didit_base_url = env_optional("DIDIT_BASE_URL");
        let didit_webhook_secret = env_optional("DIDIT_WEBHOOK_SECRET");

        let oidc_providers = env_optional("OIDC_PROVIDERS");

        if !errors.is_empty() {
            return Err(ConfigError(errors));
        }

        Ok(Config {
            database_url: database_url.unwrap(),
            host,
            port,
            app_url,
            issuer_public_url,
            issuer_private_key,
            verification_service_url,
            verification_admin_api_key,
            midnight_sidecar_url,
            midnight_sidecar_api_key,
            midnight_sidecar_timeout_secs,
            didit_api_key,
            didit_workflow_id,
            didit_base_url,
            didit_webhook_secret,
            oidc_providers,
        })
    }
}

impl fmt::Display for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "issuer-service config:")?;
        writeln!(f, "  bind:                {}:{}", self.host, self.port)?;
        writeln!(
            f,
            "  database:            {}",
            redact_db_url(&self.database_url)
        )?;
        writeln!(f, "  app url:             {}", self.app_url)?;
        writeln!(
            f,
            "  issuer private key:  {}",
            mask(self.issuer_private_key.as_deref())
        )?;
        writeln!(
            f,
            "  verification url:    {}",
            self.verification_service_url
        )?;
        writeln!(
            f,
            "  verification admin:  {}",
            mask(self.verification_admin_api_key.as_deref())
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
            "  didit api key:       {}",
            mask(self.didit_api_key.as_deref())
        )?;
        writeln!(
            f,
            "  didit workflow:      {}",
            self.didit_workflow_id.as_deref().unwrap_or("<unset>")
        )?;
        writeln!(
            f,
            "  didit base url:      {}",
            self.didit_base_url.as_deref().unwrap_or("<unset>")
        )?;
        writeln!(
            f,
            "  didit webhook secret:{}",
            mask(self.didit_webhook_secret.as_deref())
        )?;
        writeln!(
            f,
            "  oidc providers:      {}",
            self.oidc_providers.as_deref().unwrap_or("<unset>")
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
