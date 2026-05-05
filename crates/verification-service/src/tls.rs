//! T-013: mTLS configuration for inter-service communication
//!
//! Provides TLS server configuration with optional mutual TLS (client cert verification).
//! Enabled via `--features tls` or `TLS_ENABLED=true` env var.
//!
//! Environment variables:
//! - `TLS_CERT_PATH` - Path to server certificate PEM file
//! - `TLS_KEY_PATH` - Path to server private key PEM file
//! - `TLS_CA_CERT_PATH` - Path to CA certificate PEM for client verification (mTLS)
//! - `TLS_ENABLED` - Set to "true" to enable TLS

use std::path::Path;

/// TLS configuration for the service
#[derive(Debug, Clone)]
pub struct TlsConfig {
    /// Path to server certificate PEM
    pub cert_path: String,
    /// Path to server private key PEM
    pub key_path: String,
    /// Path to CA certificate PEM for client cert verification (optional, enables mTLS)
    pub ca_cert_path: Option<String>,
}

impl TlsConfig {
    /// Load TLS config from environment variables
    /// Returns None if TLS is not enabled
    pub fn from_env() -> Option<Self> {
        let enabled = std::env::var("TLS_ENABLED")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        if !enabled {
            return None;
        }

        let cert_path = std::env::var("TLS_CERT_PATH").ok()?;
        let key_path = std::env::var("TLS_KEY_PATH").ok()?;
        let ca_cert_path = std::env::var("TLS_CA_CERT_PATH").ok();

        // Validate paths exist
        if !Path::new(&cert_path).exists() {
            tracing::error!("TLS certificate not found: {}", cert_path);
            return None;
        }
        if !Path::new(&key_path).exists() {
            tracing::error!("TLS private key not found: {}", key_path);
            return None;
        }
        if let Some(ref ca_path) = ca_cert_path {
            if !Path::new(ca_path).exists() {
                tracing::error!("TLS CA certificate not found: {}", ca_path);
                return None;
            }
        }

        Some(TlsConfig {
            cert_path,
            key_path,
            ca_cert_path,
        })
    }

    /// Whether mutual TLS (client cert verification) is enabled
    pub fn is_mtls(&self) -> bool {
        self.ca_cert_path.is_some()
    }
}
