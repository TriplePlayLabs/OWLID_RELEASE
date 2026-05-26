//! Midnight Sidecar HTTP client.
//!
//! Midnight is the trust + revocation + identity-anchor core (§0 of
//! ) — every issued credential is anchored on-chain
//! and verification consults the on-chain registries. The sidecar is
//! therefore required, not optional: the service refuses to start
//! without a reachable sidecar. Per-operation errors are still
//! non-fatal where the standards path has its own safety net (e.g.
//! revocation also lands in the Status List), but no code path
//! short-circuits "Midnight disabled".

#![allow(dead_code)] // intentional API surface / serde fields
use serde::{Deserialize, Serialize};

// ============================================================================
// Configuration
// ============================================================================

/// Midnight sidecar configuration, loaded from environment variables.
pub struct MidnightConfig {
    pub sidecar_url: String,
    pub api_key: Option<String>,
    pub timeout_secs: u64,
}

impl MidnightConfig {
    /// Load from environment variables. `MIDNIGHT_SIDECAR_URL` defaults
    /// to `http://localhost:3000`; `MIDNIGHT_SIDECAR_API_KEY` is
    /// optional; `MIDNIGHT_SIDECAR_TIMEOUT` defaults to 120 s.
    pub fn from_env() -> Self {
        Self {
            sidecar_url: std::env::var("MIDNIGHT_SIDECAR_URL")
                .unwrap_or_else(|_| "http://localhost:3000".to_string()),
            api_key: std::env::var("MIDNIGHT_SIDECAR_API_KEY").ok(),
            timeout_secs: std::env::var("MIDNIGHT_SIDECAR_TIMEOUT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
        }
    }
}

// ============================================================================
// Error type
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum MidnightError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Sidecar error: {0}")]
    Sidecar(String),
}

// ============================================================================
// Sidecar response types
// ============================================================================

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    #[serde(default)]
    success: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IssuerStatusResponse {
    #[serde(alias = "keyHash", alias = "publicKey")]
    pub key_hash: String,
    pub trusted: Option<bool>,
    pub status: Option<u8>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RevocationStatusResponse {
    /// Sidecar wire uses `rootHash` (Compact contract slot name); we
    /// carry the SD-JWT VC credential_id in that slot.
    #[serde(rename = "rootHash")]
    pub credential_id: String,
    pub revoked: Option<bool>,
    pub status: Option<u8>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CommitmentResponse {
    #[serde(rename = "didHash")]
    pub did_hash: String,
    pub commitment: Option<String>,
    pub status: Option<u8>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub connected: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PredicateSnapshotResponse {
    pub address: String,
    #[serde(rename = "zswapChainState")]
    pub zswap_chain_state: String,
    #[serde(rename = "contractState")]
    pub contract_state: String,
    #[serde(rename = "ledgerParameters")]
    pub ledger_parameters: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RelayResponse {
    #[serde(rename = "txId", default)]
    pub tx_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

// ============================================================================
// Client
// ============================================================================

/// HTTP client for the Midnight sidecar service. The sidecar is the
/// service's bridge to the on-chain registries (issuer / revocation /
/// identity); it is required at startup.
#[derive(Clone)]
pub struct MidnightSidecar {
    base_url: String,
    http: reqwest::Client,
}

impl MidnightSidecar {
    /// Create a new sidecar client from config.
    pub fn new(config: MidnightConfig) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(ref api_key) = config.api_key {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                reqwest::header::HeaderValue::from_str(&format!("Bearer {api_key}"))
                    .expect("Invalid API key header value"),
            );
        }

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(config.timeout_secs))
            .default_headers(headers)
            .build()
            .expect("Failed to build HTTP client");

        Self {
            base_url: config.sidecar_url.trim_end_matches('/').to_string(),
            http,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Check sidecar health. Returns Ok(true) if connected.
    pub async fn health_check(&self) -> Result<bool, MidnightError> {
        let resp: HealthResponse = self
            .http
            .get(format!("{}/health", self.base_url))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp.connected)
    }

    // ========================================================================
    // Issuer Registry
    // ========================================================================

    /// Check if an issuer is trusted on-chain.
    pub async fn is_issuer_trusted(&self, key_hash_hex: &str) -> Result<bool, MidnightError> {        let resp: IssuerStatusResponse = self
            .http
            .get(format!(
                "{}/api/issuers/{}/trusted",
                self.base_url, key_hash_hex
            ))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(resp.trusted.unwrap_or(false))
    }

    /// Register an issuer on-chain. Fire-and-forget.
    pub async fn register_issuer(
        &self,
        public_key_hex: &str,
        name: &str,
    ) -> Result<(), MidnightError> {        let resp: SidecarResponse = self
            .http
            .post(format!("{}/api/issuers/register", self.base_url))
            .json(&serde_json::json!({
                "publicKey": public_key_hex,
                "name": name,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }

    // ========================================================================
    // Revocation Registry
    // ========================================================================

    /// Check if a credential is revoked on-chain.
    pub async fn is_credential_revoked(&self, credential_id_hex: &str) -> Result<bool, MidnightError> {        let credential_id_hex = owl_proof_system::sd_jwt::credential_id_hex(credential_id_hex)
            .map_err(|e| MidnightError::Sidecar(format!("credential id: {e}")))?;
        let resp: RevocationStatusResponse = self
            .http
            .get(format!(
                "{}/api/revocations/{}/revoked",
                self.base_url, credential_id_hex
            ))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(resp.revoked.unwrap_or(false))
    }

    /// Revoke a credential on-chain.
    pub async fn revoke_credential(
        &self,
        credential_id_hex: &str,
        issuer_key_hash_hex: &str,
        reason: &str,
    ) -> Result<(), MidnightError> {        let credential_id_hex = owl_proof_system::sd_jwt::credential_id_hex(credential_id_hex)
            .map_err(|e| MidnightError::Sidecar(format!("credential id: {e}")))?;
        let resp: SidecarResponse = self
            .http
            .post(format!("{}/api/revocations/revoke", self.base_url))
            .json(&serde_json::json!({
                "rootHash": credential_id_hex,
                "issuerPublicKey": issuer_key_hash_hex,
                "reason": reason,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }

    /// Suspend a credential on-chain.
    pub async fn suspend_credential(
        &self,
        credential_id_hex: &str,
        issuer_key_hash_hex: &str,
        reason: &str,
    ) -> Result<(), MidnightError> {        let credential_id_hex = owl_proof_system::sd_jwt::credential_id_hex(credential_id_hex)
            .map_err(|e| MidnightError::Sidecar(format!("credential id: {e}")))?;
        let resp: SidecarResponse = self
            .http
            .post(format!("{}/api/revocations/suspend", self.base_url))
            .json(&serde_json::json!({
                "rootHash": credential_id_hex,
                "issuerPublicKey": issuer_key_hash_hex,
                "reason": reason,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }

    /// Reactivate a credential on-chain.
    pub async fn reactivate_credential(
        &self,
        credential_id_hex: &str,
        issuer_key_hash_hex: &str,
    ) -> Result<(), MidnightError> {        let credential_id_hex = owl_proof_system::sd_jwt::credential_id_hex(credential_id_hex)
            .map_err(|e| MidnightError::Sidecar(format!("credential id: {e}")))?;
        let resp: SidecarResponse = self
            .http
            .post(format!(
                "{}/api/revocations/{}/reactivate",
                self.base_url, credential_id_hex
            ))
            .json(&serde_json::json!({
                "issuerPublicKey": issuer_key_hash_hex,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }

    // ========================================================================
    // Identity Registry
    // ========================================================================

    /// Register an identity commitment on-chain.
    pub async fn register_identity(
        &self,
        did_hash_hex: &str,
        commitment_hex: &str,
        issuer_key_hash_hex: &str,
    ) -> Result<(), MidnightError> {        let resp: SidecarResponse = self
            .http
            .post(format!("{}/api/identities/register", self.base_url))
            .json(&serde_json::json!({
                "didHash": did_hash_hex,
                "commitment": commitment_hex,
                "issuerKeyHash": issuer_key_hash_hex,
            }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(err) = resp.error {
            return Err(MidnightError::Sidecar(err));
        }
        Ok(())
    }

    /// Get commitment from the identity registry.
    pub async fn get_commitment(
        &self,
        did_hash_hex: &str,
    ) -> Result<CommitmentResponse, MidnightError> {        let resp: CommitmentResponse = self
            .http
            .get(format!(
                "{}/api/identities/{}/commitment",
                self.base_url, did_hash_hex
            ))
            .send()
            .await?
            .json()
            .await?;
        if let Some(ref err) = resp.error {
            return Err(MidnightError::Sidecar(err.clone()));
        }
        Ok(resp)
    }

    /// Read-only chain-state snapshot for holder-device predicate
    /// proving (the holder never queries the chain itself). `kind` is
    /// the sidecar predicate-kind segment (`age|kyc|residency|email|
    /// nationality|age_range|personhood`) — one Compact contract per
    /// kind under the per-extrinsic deploy-weight cap.
    pub async fn predicate_snapshot(
        &self,
        kind: &str,
    ) -> Result<PredicateSnapshotResponse, MidnightError> {
        let resp: PredicateSnapshotResponse = self
            .http
            .get(format!("{}/api/predicates/{}/snapshot", self.base_url, kind))
            .send()
            .await?
            .json()
            .await?;
        if let Some(ref err) = resp.error {
            return Err(MidnightError::Sidecar(err.clone()));
        }
        Ok(resp)
    }

    /// Balance + submit a holder-proven (witness-stripped)
    /// UnboundTransaction against the per-kind predicate contract.
    /// The sidecar is the only chain-aware process. Fire-and-forget:
    /// returns as soon as the chain has accepted the tx into the
    /// mempool. Holder polls {@link poll_tx_status} for finalization.
    pub async fn relay_proven_tx(
        &self,
        kind: &str,
        proven_tx_hex: &str,
    ) -> Result<RelayResponse, MidnightError> {
        let resp: RelayResponse = self
            .http
            .post(format!("{}/api/predicates/{}/relay", self.base_url, kind))
            .json(&serde_json::json!({ "provenTx": proven_tx_hex }))
            .send()
            .await?
            .json()
            .await?;
        if let Some(ref err) = resp.error {
            return Err(MidnightError::Sidecar(err.clone()));
        }
        Ok(resp)
    }

    /// Open the upstream SSE stream of phase transitions for a relay
    /// job (or raw chain tx). The verification-service forwards the
    /// returned byte stream untouched to the holder so the system
    /// uses one notification transport end-to-end (SSE for
    /// server→client pushes; no polling at any layer).
    ///
    /// Disables the global reqwest timeout for this request since SSE
    /// streams are long-lived; the connection ends when the upstream
    /// emits the terminal status, when the holder aborts the
    /// EventSource, or when an underlying TCP-level idle teardown
    /// fires (the upstream emits `ping` events every 25 s to prevent
    /// proxies from idling out).
    pub async fn open_tx_events_stream(
        &self,
        tx_id: &str,
    ) -> Result<reqwest::Response, MidnightError> {
        let resp = self
            .http
            .get(format!(
                "{}/api/predicates/tx/{}/events",
                self.base_url, tx_id
            ))
            .timeout(std::time::Duration::from_secs(60 * 60))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(MidnightError::Sidecar(format!(
                "sidecar returned {} for events stream",
                resp.status()
            )));
        }
        Ok(resp)
    }
}
