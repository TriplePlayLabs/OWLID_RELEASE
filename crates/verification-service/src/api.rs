use crate::db::DatabaseError;
use crate::observability;
use crate::state::AppState;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use owl_crypto::PublicKey;
use owl_proof_system::Token;
use serde::{Deserialize, Serialize};

/// Health check endpoint
#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 200, description = "Service is healthy", body = String),
    ),
    tag = "monitoring"
)]
pub async fn health() -> &'static str {
    "OK"
}

// T-002: /generate-keypair and credential issuance removed from verification service.
// Key generation should happen client-side. Use issuer-service for credential issuance.

/// Response containing a server-generated challenge
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ChallengeResponse {
    /// Server-generated challenge (hex, 16 chars). Valid for 5 minutes.
    challenge: String,
    /// Seconds until the challenge expires
    expires_in: u64,
}

/// Generate a server-side challenge for secure verification.
///
/// The verifier calls this first, displays/sends the challenge to the holder,
/// the holder creates a token bound to this challenge, then the verifier
/// sends the token + challenge to POST /verify.
///
/// This is the FIDO2/WebAuthn pattern: the server generates the challenge
/// so it can guarantee freshness.
#[utoipa::path(
    get,
    path = "/verify/challenge",
    responses(
        (status = 200, description = "Server-generated challenge", body = ChallengeResponse),
    ),
    tag = "verification"
)]
pub async fn generate_challenge(
    State(state): State<AppState>,
) -> Result<Json<ChallengeResponse>, ApiError> {
    let challenge = state.challenges.generate_challenge(300).await?; // 5 min TTL
    Ok(Json(ChallengeResponse {
        challenge,
        expires_in: 300,
    }))
}

/// Request to verify a compact token
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct VerifyRequest {
    /// Compact-encoded token (NID1:...)
    token: String,
    /// Server-generated challenge from GET /verify/challenge.
    /// The holder must create their token bound to this challenge.
    challenge: String,
}

/// Response from token verification
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct VerifyResponse {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subjects: Option<serde_json::Value>,
}

/// Verify a token
#[utoipa::path(
    post,
    path = "/verify",
    request_body = VerifyRequest,
    responses(
        (status = 200, description = "Verification result", body = VerifyResponse),
        (status = 400, description = "Invalid input"),
    ),
    tag = "verification"
)]
pub async fn verify_token(
    State(state): State<AppState>,
    Json(request): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, ApiError> {
    let verify_start = std::time::Instant::now();

    // Decode compact token
    let request_token = Token::from_compact(&request.token).map_err(|e| {
        ApiError::InvalidInput(format!("Invalid compact token: {}", e))
    })?;

    let challenge = &request.challenge;

    // Validate server-generated challenge: must exist, not expired, not already used
    match state.challenges.validate_server_challenge(challenge).await {
        Ok(true) => { /* valid server challenge */ }
        Ok(false) => {
            observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
            return Ok(Json(VerifyResponse {
                valid: false,
                error: Some("Invalid or expired challenge. Get a fresh one from GET /verify/challenge".to_string()),
                subjects: None,
            }));
        }
        Err(e) => {
            tracing::warn!("Challenge validation error: {}", e);
            return Ok(Json(VerifyResponse {
                valid: false,
                error: Some("Challenge validation failed".to_string()),
                subjects: None,
            }));
        }
    }

    // Get trusted issuers from database
    let issuers_list = state.issuers.list(false).await?;

    if issuers_list.is_empty() {
        // Log failure
        let _ = state.verification_logs.log_verification(
            &serde_json::to_string(&request_token)?,
            &challenge,
            None,
            "failed",
            Some("No trusted issuers configured".to_string()),
            None,
            serde_json::json!({}),
        ).await;

        return Ok(Json(VerifyResponse {
            valid: false,
            error: Some("No trusted issuers configured".to_string()),
            subjects: None,
        }));
    }

    // Convert to PublicKey objects
    let trusted_issuers: Vec<PublicKey> = issuers_list
        .iter()
        .filter_map(|i| PublicKey::from_hex(&i.public_key).ok())
        .collect();

    // Verify token (includes revocation checking via cache)
    match request_token.verify(&trusted_issuers, &challenge, state.revocations.cache()) {
        Ok(_) => {
            let subjects = serde_json::to_value(request_token.subjects())?;

            // Chain revocation check: if midnight is enabled, also verify on-chain
            if let Some(ref midnight) = state.midnight {
                if let Some(root_hash) = request_token.subjects()
                    .get("rootHash")
                    .and_then(|v| v.as_str())
                {
                    match midnight.is_credential_revoked(root_hash).await {
                        Ok(true) => {
                            tracing::warn!("Chain says credential {} is revoked but DB didn't catch it - syncing", root_hash);
                            // Sync DB: mark as revoked
                            let _ = state.revocations.revoke(
                                root_hash.to_string(),
                                "unknown".to_string(),
                                Some("Synced from chain".to_string()),
                                None,
                            ).await;

                            let _ = state.verification_logs.log_verification(
                                &serde_json::to_string(&request_token)?,
                                &challenge,
                                None,
                                "failed",
                                Some("Credential revoked on-chain".to_string()),
                                None,
                                serde_json::json!({}),
                            ).await;

                            observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());

                            return Ok(Json(VerifyResponse {
                                valid: false,
                                error: Some("Credential revoked on-chain".to_string()),
                                subjects: None,
                            }));
                        }
                        Ok(false) => { /* Chain confirms active, all good */ }
                        Err(e) => {
                            tracing::warn!("Chain revocation check failed (non-blocking): {}", e);
                        }
                    }
                }
            }

            // Extract issuer key from subjects for logging
            let issuer_key = request_token.subjects()
                .get("issuerKey")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            // Log success
            let _ = state.verification_logs.log_verification(
                &serde_json::to_string(&request_token)?,
                &challenge,
                issuer_key,
                "success",
                None,
                None,
                serde_json::json!({}),
            ).await;

            observability::record_token_verified(true, verify_start.elapsed().as_secs_f64());

            Ok(Json(VerifyResponse {
                valid: true,
                error: None,
                subjects: Some(subjects),
            }))
        }
        Err(e) => {
            // Log failure
            let _ = state.verification_logs.log_verification(
                &serde_json::to_string(&request_token)?,
                &challenge,
                None,
                "failed",
                Some(e.to_string()),
                None,
                serde_json::json!({}),
            ).await;

            observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());

            Ok(Json(VerifyResponse {
                valid: false,
                error: Some(e.to_string()),
                subjects: None,
            }))
        }
    }
}

/// Request to add a trusted issuer
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct AddTrustedIssuerRequest {
    public_key: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    issuer_url: Option<String>,
}

/// Response for adding a trusted issuer
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct AddTrustedIssuerResponse {
    success: bool,
    message: String,
}

/// Add a trusted issuer
#[utoipa::path(
    post,
    path = "/trusted-issuers",
    request_body = AddTrustedIssuerRequest,
    responses(
        (status = 200, description = "Issuer added", body = AddTrustedIssuerResponse),
        (status = 400, description = "Invalid input"),
    ),
    tag = "issuers"
)]
pub async fn add_trusted_issuer(
    State(state): State<AppState>,
    Json(request): Json<AddTrustedIssuerRequest>,
) -> Result<Json<AddTrustedIssuerResponse>, ApiError> {
    // Validate public key format
    PublicKey::from_hex(&request.public_key)
        .map_err(|_| ApiError::InvalidInput("Invalid public key format".to_string()))?;

    // Clone name before moving into DB call (needed for chain registration)
    let issuer_name = request.name.clone();

    // Add to database
    state.issuers.add(
        request.public_key.clone(),
        request.name,
        request.description,
        request.issuer_url,
        Some("api".to_string()),
        serde_json::json!({}),
    ).await?;

    // Fire-and-forget: register issuer on-chain
    if let Some(ref midnight) = state.midnight {
        let pk = request.public_key.clone();
        let name = issuer_name;
        let midnight = midnight.clone();
        tokio::spawn(async move {
            if let Err(e) = midnight.register_issuer(&pk, &name).await {
                tracing::warn!("Failed to register issuer on-chain (non-blocking): {}", e);
            } else {
                tracing::info!("Issuer {} registered on-chain", pk);
            }
        });
    }

    // Log audit event
    let _ = state.audit.log_event(
        "issuer_added".to_string(),
        "issuer".to_string(),
        request.public_key.clone(),
        Some("api".to_string()),
        &format!("Added issuer: {}", request.public_key),
        serde_json::json!({}),
    ).await;

    Ok(Json(AddTrustedIssuerResponse {
        success: true,
        message: "Trusted issuer added successfully".to_string(),
    }))
}

/// List trusted issuers
#[utoipa::path(
    get,
    path = "/trusted-issuers",
    responses(
        (status = 200, description = "List of trusted issuers", body = Vec<TrustedIssuerInfo>),
    ),
    tag = "issuers"
)]
pub async fn list_trusted_issuers(
    State(state): State<AppState>,
) -> Result<Json<Vec<TrustedIssuerInfo>>, ApiError> {
    let issuers = state.issuers.list(false).await?;

    let info: Vec<TrustedIssuerInfo> = issuers.into_iter()
        .map(|i| TrustedIssuerInfo {
            public_key: i.public_key,
            name: i.name,
            description: i.description,
            is_active: i.is_active,
        })
        .collect();

    Ok(Json(info))
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TrustedIssuerInfo {
    public_key: String,
    name: String,
    description: Option<String>,
    is_active: bool,
}

/// Request to revoke a credential
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct RevokeCredentialRequest {
    credential_id: String,
    issuer_public_key: String,
    #[serde(default)]
    reason: Option<String>,
}

/// Revoke a credential
#[utoipa::path(
    post,
    path = "/revocations/revoke",
    request_body = RevokeCredentialRequest,
    responses(
        (status = 200, description = "Credential revoked"),
        (status = 400, description = "Invalid input"),
    ),
    tag = "revocations"
)]
pub async fn revoke_credential(
    State(state): State<AppState>,
    Json(request): Json<RevokeCredentialRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.revocations.revoke(
        request.credential_id.clone(),
        request.issuer_public_key.clone(),
        request.reason.clone(),
        None, // No expiry by default
    ).await?;

    // Fire-and-forget: revoke on-chain
    if let Some(ref midnight) = state.midnight {
        let cred_id = request.credential_id.clone();
        let issuer_key = request.issuer_public_key.clone();
        let reason = request.reason.clone().unwrap_or_default();
        let midnight = midnight.clone();
        tokio::spawn(async move {
            if let Err(e) = midnight.revoke_credential(&cred_id, &issuer_key, &reason).await {
                tracing::warn!("Failed to revoke credential on-chain (non-blocking): {}", e);
            } else {
                tracing::info!("Credential {} revoked on-chain", cred_id);
            }
        });
    }

    // Log audit event
    let _ = state.audit.log_event(
        "credential_revoked".to_string(),
        "revocation".to_string(),
        request.credential_id.clone(),
        Some("api".to_string()),
        &format!("Revoked credential: {}", request.credential_id),
        serde_json::json!({"reason": request.reason}),
    ).await;

    observability::record_credential_revoked();

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Credential revoked successfully"
    })))
}

/// Suspend a credential
#[utoipa::path(
    post,
    path = "/revocations/suspend",
    request_body = RevokeCredentialRequest,
    responses(
        (status = 200, description = "Credential suspended"),
        (status = 400, description = "Invalid input"),
    ),
    tag = "revocations"
)]
pub async fn suspend_credential(
    State(state): State<AppState>,
    Json(request): Json<RevokeCredentialRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.revocations.suspend(
        request.credential_id.clone(),
        request.issuer_public_key.clone(),
        request.reason.clone(),
    ).await?;

    // Fire-and-forget: suspend on-chain
    if let Some(ref midnight) = state.midnight {
        let cred_id = request.credential_id.clone();
        let issuer_key = request.issuer_public_key.clone();
        let reason = request.reason.clone().unwrap_or_default();
        let midnight = midnight.clone();
        tokio::spawn(async move {
            if let Err(e) = midnight.suspend_credential(&cred_id, &issuer_key, &reason).await {
                tracing::warn!("Failed to suspend credential on-chain (non-blocking): {}", e);
            } else {
                tracing::info!("Credential {} suspended on-chain", cred_id);
            }
        });
    }

    // Log audit event
    let _ = state.audit.log_event(
        "credential_suspended".to_string(),
        "revocation".to_string(),
        request.credential_id.clone(),
        Some("api".to_string()),
        &format!("Suspended credential: {}", request.credential_id),
        serde_json::json!({"reason": request.reason}),
    ).await;

    observability::record_credential_suspended();

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Credential suspended successfully"
    })))
}

/// Reactivate a credential
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ReactivateCredentialRequest {
    credential_id: String,
}

#[utoipa::path(
    post,
    path = "/revocations/reactivate",
    request_body = ReactivateCredentialRequest,
    responses(
        (status = 200, description = "Credential reactivated"),
        (status = 400, description = "Invalid input"),
    ),
    tag = "revocations"
)]
pub async fn reactivate_credential(
    State(state): State<AppState>,
    Json(request): Json<ReactivateCredentialRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let revocation = state.revocations.reactivate(&request.credential_id).await?;

    // Fire-and-forget: reactivate on-chain using the issuer key from the DB record
    if let Some(ref midnight) = state.midnight {
        let cred_id = request.credential_id.clone();
        let issuer_key = revocation.issuer_public_key.clone();
        let midnight = midnight.clone();
        tokio::spawn(async move {
            if let Err(e) = midnight.reactivate_credential(&cred_id, &issuer_key).await {
                tracing::warn!("Failed to reactivate credential on-chain (non-blocking): {}", e);
            } else {
                tracing::info!("Credential {} reactivated on-chain", cred_id);
            }
        });
    }

    // Log audit event
    let _ = state.audit.log_event(
        "credential_reactivated".to_string(),
        "revocation".to_string(),
        request.credential_id.clone(),
        Some("api".to_string()),
        &format!("Reactivated credential: {}", request.credential_id),
        serde_json::json!({}),
    ).await;

    observability::record_credential_reactivated();

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Credential reactivated successfully"
    })))
}

/// Check revocation status
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CheckRevocationRequest {
    credential_id: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CheckRevocationResponse {
    credential_id: String,
    status: String,
}

#[utoipa::path(
    post,
    path = "/revocations/check",
    request_body = CheckRevocationRequest,
    responses(
        (status = 200, description = "Revocation status", body = CheckRevocationResponse),
        (status = 400, description = "Invalid input"),
    ),
    tag = "revocations"
)]
pub async fn check_revocation(
    State(state): State<AppState>,
    Json(request): Json<CheckRevocationRequest>,
) -> Result<Json<CheckRevocationResponse>, ApiError> {
    let status = state.revocations.check_status(&request.credential_id)
        .await?
        .unwrap_or_else(|| "active".to_string());

    Ok(Json(CheckRevocationResponse {
        credential_id: request.credential_id,
        status,
    }))
}

/// List revoked credentials
#[utoipa::path(
    get,
    path = "/revocations/list",
    responses(
        (status = 200, description = "List of revoked credentials"),
    ),
    tag = "revocations"
)]
pub async fn list_revoked(
    State(state): State<AppState>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let revocations = state.revocations.list(Some("revoked".to_string())).await?;

    let list: Vec<serde_json::Value> = revocations.into_iter()
        .map(|r| serde_json::json!({
            "credential_id": r.credential_id,
            "status": r.status,
            "revoked_at": r.revoked_at,
            "reason": r.reason,
        }))
        .collect();

    Ok(Json(list))
}

/// Get metrics
#[utoipa::path(
    get,
    path = "/metrics",
    responses(
        (status = 200, description = "Service metrics"),
    ),
    tag = "monitoring"
)]
pub async fn get_metrics(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let metrics = state.verification_logs.get_current_metrics().await?;

    Ok(Json(serde_json::json!({
        "total_verifications": metrics.total_verifications,
        "successful_verifications": metrics.successful_verifications,
        "failed_verifications": metrics.failed_verifications,
        "success_rate": metrics.success_rate(),
    })))
}

/// API Error type
#[derive(Debug)]
pub enum ApiError {
    Database(DatabaseError),
    Serialization(serde_json::Error),
    InvalidInput(String),
}

impl From<DatabaseError> for ApiError {
    fn from(e: DatabaseError) -> Self {
        ApiError::Database(e)
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::Serialization(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::Database(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Serialization(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::InvalidInput(msg) => (StatusCode::BAD_REQUEST, msg),
        };

        let body = serde_json::json!({
            "error": message,
        });

        (status, Json(body)).into_response()
    }
}
