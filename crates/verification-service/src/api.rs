use crate::db::DatabaseError;
use crate::dcql::{self, DcqlRequest};
use crate::observability;
use crate::state::AppState;
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use owl_crypto::PublicKey;
use owl_proof_system::sd_jwt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MidnightInfoResponse {
    /// Network id the sidecar is bound to (`undeployed` for local
    /// devnet, `preprod`/`mainnet` elsewhere). The SDK passes this
    /// verbatim to `@midnight-ntwrk/midnight-js-network-id`
    /// `setNetworkId()` before any contract operation.
    pub network_id: String,
}

/// Midnight runtime config the browser/holder needs to bootstrap the
/// in-process WASM prover + circuit-exec stack. Public — `networkId`
/// is a deployment fact, not a secret. The SDK fetches this once per
/// process and calls midnight-js `setNetworkId()` before the first
/// predicate prove; otherwise `createUnprovenCallTx` aborts with
/// "Network ID has not been configured".
#[utoipa::path(
    get,
    path = "/midnight/info",
    responses(
        (status = 200, description = "Midnight network info", body = MidnightInfoResponse),
    ),
    tag = "monitoring"
)]
pub async fn get_midnight_info(State(state): State<AppState>) -> Json<MidnightInfoResponse> {
    Json(MidnightInfoResponse {
        network_id: state.midnight_network_id.clone(),
    })
}

/// Upstream the Midnight wallet SDK reads the universal SRS from.
/// AWS S3 bucket — no CORS headers, so browsers cannot fetch directly;
/// we proxy via `/midnight/params/{k}` and stream the bytes with our
/// own CORS-friendly response.
const MIDNIGHT_SRS_BUCKET: &str =
    "https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com";

/// Proxy the size-keyed universal BLS SRS (`bls_midnight_2p{k}`) the
/// in-process zkir-v2 prover needs. Mirrors the upstream filename
/// pattern; bytes are content-addressed by `k` and immutable, so we
/// hand the browser a long `Cache-Control` and let it pin the blob.
/// Public — the SRS is public reference data.
#[utoipa::path(
    get,
    path = "/midnight/params/{k}",
    params(
        ("k" = u32, Path, description = "Power-of-two size class — wallet SDK calls with `k` in 12..18."),
    ),
    responses(
        (status = 200, description = "BLS12-381 universal SRS bytes (octet-stream)"),
        (status = 404, description = "Upstream returned no SRS for this k"),
        (status = 502, description = "Upstream fetch failed"),
    ),
    tag = "monitoring"
)]
pub async fn get_midnight_params(Path(k): Path<u32>) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

    let url = format!("{MIDNIGHT_SRS_BUCKET}/bls_midnight_2p{k}");
    let upstream = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("upstream fetch failed: {e}"),
            )
                .into_response();
        }
    };
    if !upstream.status().is_success() {
        let code = match upstream.status().as_u16() {
            404 => StatusCode::NOT_FOUND,
            _ => StatusCode::BAD_GATEWAY,
        };
        return (code, format!("upstream returned {}", upstream.status())).into_response();
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    let stream = upstream.bytes_stream();
    (StatusCode::OK, headers, Body::from_stream(stream)).into_response()
}

// Key generation happens client-side; credential issuance lives on
// the issuer service. Neither belongs in the verification service.

/// Response containing a server-generated challenge
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
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

/// Revoked credential ids. The issuer projects these into the IETF Token
/// Status List (`draft-ietf-oauth-status-list`). The authoritative truth is
/// the Midnight `revocation_registry`, mirrored here via SSE. Plain
/// well-known-style read endpoint (not in the typed client).
pub async fn status_revoked(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "revoked": state.revocations.cache().snapshot().await,
    }))
}

/// OpenID4VP `direct_post` response endpoint. Per OpenID4VP 1.0 §8.2
/// the body is `application/x-www-form-urlencoded`; for back-compat
/// with the OwlID holder app we also accept `application/json`.
///
/// Form-encoded fields:
///   `vp_token`               — JSON-encoded vp_token map
///   `state`                  — session nonce (binds the bundle)
///   `presentation_submission` — optional, JSON-encoded (PE-style echo)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Oid4vpResponse {
    // OID4VP 1.0 §8.1: vp_token values are always arrays of presentations.
    vp_token: HashMap<String, Vec<String>>,
    state: String,
    #[serde(default)]
    presentation_submission: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct Oid4vpResponseForm {
    vp_token: String,
    state: String,
    #[serde(default)]
    presentation_submission: Option<String>,
}

pub async fn openid4vp_response(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<VerifyDcqlResponse>, ApiError> {
    let content_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let req = if content_type.starts_with("application/x-www-form-urlencoded") {
        let raw: Oid4vpResponseForm = serde_urlencoded::from_bytes(&body)
            .map_err(|e| ApiError::InvalidInput(format!("form-encoded body: {e}")))?;
        // OID4VP 1.0 §8.1: vp_token values are always arrays.
        let vp_token: HashMap<String, Vec<String>> = serde_json::from_str(&raw.vp_token)
            .map_err(|e| ApiError::InvalidInput(format!("vp_token JSON: {e}")))?;
        let presentation_submission = raw
            .presentation_submission
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|e: serde_json::Error| {
                ApiError::InvalidInput(format!("presentation_submission JSON: {e}"))
            })?;
        Oid4vpResponse {
            vp_token,
            state: raw.state,
            presentation_submission,
        }
    } else {
        serde_json::from_slice::<Oid4vpResponse>(&body)
            .map_err(|e| ApiError::InvalidInput(format!("JSON body: {e}")))?
    };
    // presentation_submission is logged but not load-bearing —
    // DCQL constraints come from the session's stored query.
    let _ = req.presentation_submission;

    let query = match state.presentations.get_request_data(&req.state).await {
        Some(data) => data.dcql_query.unwrap_or_else(|| dcql::permissive_query(&req.vp_token)),
        None => dcql::permissive_query(&req.vp_token),
    };
    let audience = state
        .presentations
        .get_request_data(&req.state)
        .await
        .and_then(|d| d.audience);

    // OID4VP `client_id` for the per-verifier salt. Reuse the session's
    // audience (defaulted at session-create time to the response_uri
    // when absent); if no audience was stored either, the downstream
    // dcql::check_credential_query falls back to the request audience
    // and finally rejects nationality_in / resident_in claims.
    let verifier_id = audience.clone();

    verify_dcql(
        State(state),
        Json(VerifyDcqlRequest {
            vp_token: req.vp_token,
            challenge: req.state,
            audience,
            verifier_id,
            query,
        }),
    )
    .await
}

/// Per-credential verification outcome.
#[derive(Debug, Serialize, utoipa::ToSchema, Clone)]
pub struct VerifyResponse {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subjects: Option<serde_json::Value>,
}

/// DCQL verification request (OpenID4VP 1.0 §6 + §8.1).
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VerifyDcqlRequest {
    /// DCQL vp_token — keyed by the DCQL `credentials[].id` from
    /// `query`. Per OID4VP 1.0 §8.1, each value is ALWAYS an array of
    /// one or more SD-JWT VC presentations
    /// (`<issuer-JWT>~<disclosure>~…~<KB-JWT>`), even when the
    /// credential query did not set `multiple: true`.
    pub vp_token: HashMap<String, Vec<String>>,
    /// Server-generated nonce bound into every KB-JWT in the bundle.
    pub challenge: String,
    /// Expected KB-JWT `aud` — when set, applies to every entry.
    #[serde(default)]
    pub audience: Option<String>,
    /// OID4VP verifier `client_id` (typically the response_uri). Folded
    /// into the on-chain attestation key for nationality / residency
    /// predicates so two verifiers asking the same allowed-set produce
    /// distinct keys. Required when the DCQL `claims` contain a
    /// `nationality_in` / `resident_in` path; ignored otherwise.
    #[serde(default)]
    pub verifier_id: Option<String>,
    /// The DCQL query the wallet was solving. The verifier re-checks
    /// per-credential constraints (`format`, `meta.vct_values`, `claims`)
    /// and the `credential_sets` solver against the actual responses.
    pub query: DcqlRequest,
}

/// DCQL verification response.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VerifyDcqlResponse {
    /// `true` iff every claimed `vp_token` entry verified AND the DCQL
    /// query's `credential_sets` are satisfied.
    pub valid: bool,
    /// Per-credential verdict, keyed by DCQL credential id.
    pub per_credential: HashMap<String, VerifyResponse>,
    /// Merged disclosed claims, namespaced by DCQL credential id.
    pub subjects: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Standard (IETF `draft-ietf-oauth-status-list`) revocation check:
/// fetch the credential's Status List Token, verify its JWS under the
/// issuer key, and read the credential's bit. Errors propagate so the
/// caller can decide (here: non-blocking).
async fn status_list_revoked(
    uri: &str,
    issuer_pk: &PublicKey,
    idx: u64,
) -> Result<bool, String> {
    let jwt = reqwest::get(uri)
        .await
        .map_err(|e| format!("fetch {uri}: {e}"))?
        .text()
        .await
        .map_err(|e| format!("body {uri}: {e}"))?;
    let list = owl_proof_system::status_list::verify_status_list_jwt(&jwt, issuer_pk)
        .map_err(|e| format!("status list verify: {e}"))?;
    Ok(list.is_revoked(idx))
}

/// Per-credential outcome shared between the DCQL handler and the OID4VP
/// shim — carries the wire response, the verified `vct` (for the DCQL
/// `meta.vct_values` constraint check), and the computed
/// `credential_id` (used by the DCQL claim router to recompute the
/// Midnight attestation key against THIS credential, not the
/// verifier-chosen DCQL slot id).
struct PresentationOutcome {
    response: VerifyResponse,
    vct: Option<String>,
    credential_id: Option<String>,
}

/// Run the full SD-JWT VC verification chain for one presentation:
/// `iss` peek → did:web resolve → on-chain doc-hash anchor → trusted-
/// issuer set → SD-JWT issuer JWS + KB-JWT bound to `challenge` (and
/// `audience` when set) → revocation (cache + Midnight + Status List).
/// Returns an `Ok(VerifyResponse{ valid: false, error: .. })` for every
/// expected failure mode; `Err` is reserved for internal infrastructure
/// errors (DB, etc.). The caller is responsible for consuming the
/// one-shot nonce BEFORE calling — every entry in a DCQL `vp_token`
/// shares the same nonce.
async fn verify_one_presentation(
    state: &AppState,
    challenge: &str,
    audience: Option<&str>,
    presentation: &str,
) -> Result<PresentationOutcome, ApiError> {
    let verify_start = std::time::Instant::now();
    let fail = |e: String| PresentationOutcome {
        response: VerifyResponse {
            valid: false,
            error: Some(e),
            subjects: None,
        },
        vct: None,
        credential_id: None,
    };

    let iss = match sd_jwt::peek_iss(presentation) {
        Ok(v) => v,
        Err(e) => return Ok(fail(format!("Invalid SD-JWT VC: {e}"))),
    };
    let resolved = match state.did_resolver.resolve(&iss).await {
        Ok(r) => r,
        Err(e) => {
            observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
            return Ok(fail(format!("Issuer DID resolution failed: {e}")));
        }
    };
    // SD-JWT VC issuer JWS is EdDSA-only (`sd_jwt::jws_sign`); a DID
    // method that resolves to a non-Ed25519 key cannot back an OwlID
    // issuer. Holder `cnf` keys may be EC/P-256 — that's enforced
    // inside `sd_jwt::verify` via `jws_verify_with`.
    if resolved.key_alg != crate::did::KeyAlgorithm::Ed25519 {
        observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
        return Ok(fail(format!(
            "Issuer DID {iss} resolved to non-Ed25519 key — issuer JWS must be EdDSA"
        )));
    }
    let issuer_hex = resolved.key_hex.clone();
    if let Err(e) = crate::did::anchor_check(&state.midnight, &resolved).await {
        observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
        return Ok(fail(e));
    }
    // Trust check: PG mirror first (sub-ms). On miss, fall through to
    // the chain — Midnight is the source of truth, the PG row is just
    // the warm cache the SSE feed fills. Chain unreachable + cache
    // miss = fail closed.
    let issuers_list = state.issuers.list(false).await?;
    let mirror_trusts = issuers_list
        .iter()
        .any(|i| i.public_key.eq_ignore_ascii_case(&issuer_hex));
    if !mirror_trusts {
        match state.midnight.is_issuer_trusted(&issuer_hex).await {
            Ok(true) => {
                // Chain confirms — mirror was lagging the SSE feed. The
                // event will catch up; nothing to do here besides
                // continuing the verify path.
            }
            Ok(false) => {
                observability::record_token_verified(
                    false,
                    verify_start.elapsed().as_secs_f64(),
                );
                return Ok(fail(format!("Untrusted issuer: {iss}")));
            }
            Err(e) => {
                observability::record_token_verified(
                    false,
                    verify_start.elapsed().as_secs_f64(),
                );
                return Ok(fail(format!(
                    "Chain trust check failed for {iss}: {e}"
                )));
            }
        }
    }
    let issuer_pk = match PublicKey::from_hex(&issuer_hex) {
        Ok(k) => k,
        Err(e) => return Ok(fail(format!("Bad issuer key: {e}"))),
    };

    let verified = match sd_jwt::verify(
        presentation,
        &issuer_pk,
        &sd_jwt::VerifyParams {
            require_kb: true,
            aud: audience.map(|s| s.to_string()),
            nonce: Some(challenge.to_string()),
        },
    ) {
        Ok(v) => v,
        Err(e) => {
            let _ = state
                .verification_logs
                .log_verification(
                    presentation,
                    challenge,
                    Some(issuer_hex.to_string()),
                    "failed",
                    Some(e.to_string()),
                    None,
                    serde_json::json!({}),
                )
                .await;
            observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
            return Ok(fail(e.to_string()));
        }
    };

    let cred_id = sd_jwt::credential_id(presentation);
    if state.revocations.cache().is_revoked(&cred_id) {
        observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
        return Ok(fail("Credential revoked".to_string()));
    }
    {
        let midnight = &state.midnight;
        match midnight.is_credential_revoked(&cred_id).await {
            Ok(true) => {
                tracing::warn!("Chain says {} revoked; syncing DB", cred_id);
                let _ = state
                    .revocations
                    .revoke(
                        cred_id.clone(),
                        issuer_hex.to_string(),
                        Some("Synced from chain".to_string()),
                        None,
                    )
                    .await;
                observability::record_token_verified(false, verify_start.elapsed().as_secs_f64());
                return Ok(fail("Credential revoked on-chain".to_string()));
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("Chain revocation check failed (non-blocking): {}", e),
        }
    }
    if let Some(ref st) = verified.status {
        match status_list_revoked(&st.uri, &issuer_pk, st.idx).await {
            Ok(true) => {
                observability::record_token_verified(
                    false,
                    verify_start.elapsed().as_secs_f64(),
                );
                return Ok(fail("Credential revoked (status list)".to_string()));
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("Status list check failed (non-blocking): {}", e),
        }
    }

    let subjects = serde_json::to_value(&verified.claims)?;

    let _ = state
        .verification_logs
        .log_verification(
            presentation,
            challenge,
            Some(issuer_hex.to_string()),
            "success",
            None,
            None,
            serde_json::json!({ "vct": verified.vct }),
        )
        .await;
    observability::record_token_verified(true, verify_start.elapsed().as_secs_f64());

    Ok(PresentationOutcome {
        response: VerifyResponse {
            valid: true,
            error: None,
            subjects: Some(subjects),
        },
        vct: Some(verified.vct),
        credential_id: Some(cred_id),
    })
}

/// DCQL multi-credential verification (OpenID4VP 1.0 §6 + §8.1).
///
/// Consumes the one-shot nonce ONCE, then verifies every `vp_token`
/// entry independently with the same `challenge` and `audience`.
/// Per-credential DCQL constraints (`format`, `meta.vct_values`,
/// `claims[].path`/`values`) are enforced after the crypto chain
/// passes; `credential_sets` are solved over the set of valid ids.
#[utoipa::path(
    post,
    path = "/verify/dcql",
    request_body = VerifyDcqlRequest,
    responses(
        (status = 200, description = "DCQL verification result", body = VerifyDcqlResponse),
        (status = 400, description = "Invalid input"),
    ),
    tag = "verification"
)]
pub async fn verify_dcql(
    State(state): State<AppState>,
    Json(request): Json<VerifyDcqlRequest>,
) -> Result<Json<VerifyDcqlResponse>, ApiError> {
    let fail_all = |e: String,
                    vp_token: &HashMap<String, Vec<String>>|
     -> Json<VerifyDcqlResponse> {
        let per_credential = vp_token
            .keys()
            .map(|k| {
                (
                    k.clone(),
                    VerifyResponse {
                        valid: false,
                        error: Some(e.clone()),
                        subjects: None,
                    },
                )
            })
            .collect();
        Json(VerifyDcqlResponse {
            valid: false,
            per_credential,
            subjects: serde_json::json!({}),
            error: Some(e),
        })
    };

    let challenge = request.challenge.clone();
    let challenge_ok = match state.challenges.validate_server_challenge(&challenge).await {
        Ok(true) => true,
        Ok(false) => state.presentations.consume_nonce(&challenge).await,
        Err(e) => {
            tracing::warn!("Challenge validation error: {}", e);
            return Ok(fail_all(
                "Challenge validation failed".to_string(),
                &request.vp_token,
            ));
        }
    };
    if !challenge_ok {
        return Ok(fail_all(
            "Invalid or expired challenge. Use GET /verify/challenge or a presentation-session nonce.".to_string(),
            &request.vp_token,
        ));
    }

    let query_by_id: HashMap<String, &crate::dcql::DcqlCredentialQuery> = request
        .query
        .credentials
        .iter()
        .map(|q| (q.id.clone(), q))
        .collect();

    let mut per_credential: HashMap<String, VerifyResponse> = HashMap::new();
    let mut subjects = serde_json::Map::new();

    for (cred_id, presentations) in &request.vp_token {
        // OID4VP 1.0 §8.1: `vp_token` entries are always arrays.
        // OwlID's DCQL never sets `multiple: true`, so the expected
        // shape is exactly one presentation per entry.
        let presentation = match presentations.as_slice() {
            [p] => p,
            [] => {
                per_credential.insert(
                    cred_id.clone(),
                    VerifyResponse {
                        valid: false,
                        error: Some(format!(
                            "vp_token entry {} is empty (OID4VP §8.1 mandates ≥1 \
                             presentation per credential query)",
                            cred_id
                        )),
                        subjects: None,
                    },
                );
                continue;
            }
            _ => {
                per_credential.insert(
                    cred_id.clone(),
                    VerifyResponse {
                        valid: false,
                        error: Some(format!(
                            "vp_token entry {} has {} presentations but `multiple` was \
                             not set on the credential query",
                            cred_id,
                            presentations.len()
                        )),
                        subjects: None,
                    },
                );
                continue;
            }
        };
        let outcome = verify_one_presentation(
            &state,
            &challenge,
            request.audience.as_deref(),
            presentation,
        )
        .await?;

        let mut response = outcome.response;
        if response.valid {
            if let Some(q) = query_by_id.get(cred_id) {
                let vct = outcome.vct.as_deref().unwrap_or_default();
                let attest_cache = state.attestations.cache();
                // Midnight-only policy: every DCQL claim must resolve to
                // a per-kind Midnight predicate attestation (one Compact
                // contract per kind, single SSE-mirrored set). The
                // attestation key recipe takes the credential's stable
                // hash, NOT the verifier-chosen DCQL slot id — which is
                // an arbitrary string like "email_verified" and won't
                // hex-decode to the 32 bytes the recipe needs.
                let cred_id_for_key = outcome.credential_id.as_deref().unwrap_or_default();
                let cred_id_hex = owl_proof_system::sd_jwt::credential_id_hex(cred_id_for_key)
                    .unwrap_or_default();
                // Verifier identity for the per-verifier salt mixed into
                // nationality / residency setHash. Falls back to the
                // `audience` (which OID4VP defaults to the response_uri /
                // client_id) so the OID4VP shim path doesn't need to
                // duplicate the field on every call.
                let verifier_id = request
                    .verifier_id
                    .as_deref()
                    .or(request.audience.as_deref())
                    .unwrap_or("");
                if let Err(e) =
                    dcql::check_credential_query(q, vct, &cred_id_hex, verifier_id, |k| {
                        attest_cache.is_attested(k)
                    })
                {
                    response = VerifyResponse {
                        valid: false,
                        error: Some(e),
                        subjects: None,
                    };
                }
            }
        }
        if let Some(s) = &response.subjects {
            subjects.insert(cred_id.clone(), s.clone());
        }
        per_credential.insert(cred_id.clone(), response);
    }

    let satisfied: HashSet<String> = per_credential
        .iter()
        .filter_map(|(id, r)| if r.valid { Some(id.clone()) } else { None })
        .collect();
    let set_err = dcql::check_credential_sets(&request.query, &satisfied).err();
    let overall_valid = set_err.is_none() && per_credential.values().all(|r| r.valid);

    Ok(Json(VerifyDcqlResponse {
        valid: overall_valid,
        per_credential,
        subjects: serde_json::Value::Object(subjects),
        error: set_err,
    }))
}

/// Request to add a trusted issuer
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
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
    tag = "admin-issuers"
)]
pub async fn add_trusted_issuer(
    State(state): State<AppState>,
    Json(request): Json<AddTrustedIssuerRequest>,
) -> Result<Json<AddTrustedIssuerResponse>, ApiError> {
    // Validate public key format
    PublicKey::from_hex(&request.public_key)
        .map_err(|_| ApiError::InvalidInput("Invalid public key format".to_string()))?;

    // Midnight is the source of truth — register on-chain FIRST. The
    // Postgres row is just a fast cache for the verifier hot path; if
    // the chain write fails we refuse so the database never lists an
    // issuer the chain doesn't know about.
    //
    // `registerIssuer` asserts "Issuer already active" on a duplicate,
    // so we skip the write when the chain already trusts the key —
    // makes the call idempotent across every issuer-service reboot.
    match state.midnight.is_issuer_trusted(&request.public_key).await {
        Ok(true) => {
            tracing::info!(
                "Issuer {} already trusted on-chain — skipping register",
                request.public_key
            );
        }
        Ok(false) => {
            state
                .midnight
                .register_issuer(&request.public_key, &request.name)
                .await
                .map_err(|e| {
                    ApiError::Internal(format!("Chain register_issuer failed: {e}"))
                })?;
        }
        Err(e) => {
            return Err(ApiError::Internal(format!(
                "Chain issuer-trust check failed: {e}"
            )));
        }
    }

    // Mirror into the local cache. The SSE event from the chain will
    // re-confirm this row asynchronously; the upsert here just shortens
    // the lag for the immediate verify call after this request.
    state
        .issuers
        .add(
            request.public_key.clone(),
            request.name,
            request.description,
            request.issuer_url,
            Some("api".to_string()),
            serde_json::json!({}),
        )
        .await?;

    // Log audit event
    let _ = state
        .audit
        .log_event(
            "issuer_added".to_string(),
            "issuer".to_string(),
            request.public_key.clone(),
            Some("api".to_string()),
            &format!("Added issuer: {}", request.public_key),
            serde_json::json!({}),
        )
        .await;

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

    let info: Vec<TrustedIssuerInfo> = issuers
        .into_iter()
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
#[serde(rename_all = "camelCase")]
pub struct TrustedIssuerInfo {
    public_key: String,
    name: String,
    description: Option<String>,
    is_active: bool,
}

/// Request to revoke a credential
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
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
    tag = "admin-revocations"
)]
pub async fn revoke_credential(
    State(state): State<AppState>,
    Json(request): Json<RevokeCredentialRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Midnight is the source of truth — write to chain FIRST. If the
    // chain call fails the Postgres mirror stays untouched so we never
    // report a credential as revoked when the chain doesn't agree.
    state
        .midnight
        .revoke_credential(
            &request.credential_id,
            &request.issuer_public_key,
            request.reason.as_deref().unwrap_or_default(),
        )
        .await
        .map_err(|e| ApiError::Internal(format!("Chain revoke failed: {e}")))?;

    // Mirror to local cache so verify hot path picks it up immediately;
    // the SSE event from the chain re-confirms asynchronously.
    state
        .revocations
        .revoke(
            request.credential_id.clone(),
            request.issuer_public_key.clone(),
            request.reason.clone(),
            None,
        )
        .await?;

    // Log audit event
    let _ = state
        .audit
        .log_event(
            "credential_revoked".to_string(),
            "revocation".to_string(),
            request.credential_id.clone(),
            Some("api".to_string()),
            &format!("Revoked credential: {}", request.credential_id),
            serde_json::json!({"reason": request.reason}),
        )
        .await;

    observability::record_credential_revoked();

    state.broadcaster.broadcast(crate::ws::RevocationEvent {
        event: "revoked".to_string(),
        credential_id: request.credential_id.clone(),
        issuer_public_key: request.issuer_public_key.clone(),
        timestamp: chrono::Utc::now().timestamp(),
        reason: request.reason.clone(),
    });

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
    tag = "admin-revocations"
)]
pub async fn suspend_credential(
    State(state): State<AppState>,
    Json(request): Json<RevokeCredentialRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Chain first; DB mirror after a confirmed chain write.
    state
        .midnight
        .suspend_credential(
            &request.credential_id,
            &request.issuer_public_key,
            request.reason.as_deref().unwrap_or_default(),
        )
        .await
        .map_err(|e| ApiError::Internal(format!("Chain suspend failed: {e}")))?;

    state
        .revocations
        .suspend(
            request.credential_id.clone(),
            request.issuer_public_key.clone(),
            request.reason.clone(),
        )
        .await?;

    // Log audit event
    let _ = state
        .audit
        .log_event(
            "credential_suspended".to_string(),
            "revocation".to_string(),
            request.credential_id.clone(),
            Some("api".to_string()),
            &format!("Suspended credential: {}", request.credential_id),
            serde_json::json!({"reason": request.reason}),
        )
        .await;

    observability::record_credential_suspended();

    state.broadcaster.broadcast(crate::ws::RevocationEvent {
        event: "suspended".to_string(),
        credential_id: request.credential_id.clone(),
        issuer_public_key: request.issuer_public_key.clone(),
        timestamp: chrono::Utc::now().timestamp(),
        reason: request.reason.clone(),
    });

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Credential suspended successfully"
    })))
}

/// Reactivate a credential
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
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
    tag = "admin-revocations"
)]
pub async fn reactivate_credential(
    State(state): State<AppState>,
    Json(request): Json<ReactivateCredentialRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Read the issuer key from the local revocation row, then reactivate
    // on-chain BEFORE clearing the cache. Order matters: if the chain
    // call fails we leave the credential listed as suspended so the
    // verifier doesn't accept it again.
    let revocation = state.revocations.get(&request.credential_id).await?;

    state
        .midnight
        .reactivate_credential(&request.credential_id, &revocation.issuer_public_key)
        .await
        .map_err(|e| ApiError::Internal(format!("Chain reactivate failed: {e}")))?;

    state.revocations.reactivate(&request.credential_id).await?;

    // Log audit event
    let _ = state
        .audit
        .log_event(
            "credential_reactivated".to_string(),
            "revocation".to_string(),
            request.credential_id.clone(),
            Some("api".to_string()),
            &format!("Reactivated credential: {}", request.credential_id),
            serde_json::json!({}),
        )
        .await;

    observability::record_credential_reactivated();

    state.broadcaster.broadcast(crate::ws::RevocationEvent {
        event: "reactivated".to_string(),
        credential_id: request.credential_id.clone(),
        issuer_public_key: revocation.issuer_public_key.clone(),
        timestamp: chrono::Utc::now().timestamp(),
        reason: None,
    });

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Credential reactivated successfully"
    })))
}

/// Check revocation status
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckRevocationRequest {
    credential_id: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
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
    // PG mirror first (fast path, sub-ms). If the mirror says "not
    // revoked" we DOUBLE-CHECK the chain — the SSE feed could be
    // mid-replay and a credential might already be revoked on-chain
    // without the local row yet. Chain is the source of truth; PG is
    // just the warm cache.
    let cache_status = state
        .revocations
        .check_status(&request.credential_id)
        .await?;
    let status = match cache_status {
        Some(s) if s == "revoked" || s == "suspended" => s,
        _ => {
            match state.midnight.is_credential_revoked(&request.credential_id).await {
                Ok(true) => {
                    // Catch-up: sync the chain truth into the local cache so
                    // the verify hot path picks it up.
                    let _ = state
                        .revocations
                        .revoke(
                            request.credential_id.clone(),
                            String::new(),
                            Some("Synced from chain".to_string()),
                            None,
                        )
                        .await;
                    "revoked".to_string()
                }
                Ok(false) => "active".to_string(),
                Err(e) => {
                    // Chain unreachable — refuse to claim "active" with
                    // stale data; bubble up so caller knows the answer
                    // isn't authoritative.
                    return Err(ApiError::Internal(format!(
                        "Chain revocation check failed: {e}"
                    )));
                }
            }
        }
    };

    Ok(Json(CheckRevocationResponse {
        credential_id: request.credential_id,
        status,
    }))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckPredicateRequest {
    /// SD-JWT VC credential_id (hex, 32 bytes) — issuer-signed.
    pub credential_id: String,
    /// One of: `age` | `kyc` | `nationality` | `residency` | `age_range`
    /// | `email_verified` | `unique_personhood`.
    pub predicate: String,
    /// Required for `age`, `kyc` (`value >= threshold`).
    #[serde(default)]
    pub threshold: Option<u64>,
    /// Required for `age_range` (`age in [min_age, max_age]`).
    #[serde(default)]
    pub min_age: Option<u16>,
    /// Required for `age_range`.
    #[serde(default)]
    pub max_age: Option<u16>,
    /// Required for `unique_personhood` (hex, 32 bytes).
    #[serde(default)]
    pub epoch: Option<String>,
    /// Required for `unique_personhood` (hex, 32 bytes).
    #[serde(default)]
    pub app_id: Option<String>,
    /// Required for `nationality` and `residency` — the verifier-supplied
    /// ISO 3166-1 alpha-2 country set (≤64 codes) the attestation was
    /// minted against. The on-chain key binds to a hash of this exact
    /// set, so a "Dutch resident" attestation does not satisfy an
    /// "EU resident" check (and vice versa).
    #[serde(default)]
    pub countries: Option<Vec<String>>,
    /// Required for `nationality` and `residency` — the OID4VP verifier
    /// `client_id` (typically the response_uri). Folded into the setHash
    /// so two verifiers asking the same allowed-set produce distinct
    /// on-chain attestation keys (anti-cross-verifier correlation).
    #[serde(default)]
    pub verifier_id: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckPredicateResponse {
    pub predicate: String,
    /// Recomputed attestation key (hex) — bound to the credential_id.
    pub attest_key: String,
    /// True iff the key is in the SSE-mirrored on-chain attestation set.
    pub attested: bool,
}

/// Recompute the Midnight attestation key from the credential's
/// issuer-signed credential_id + requested predicate (binding it to
/// *this* credential), then check membership in the SSE-mirrored set.
/// No ZK proof verified inline — the Midnight node already verified it
/// in consensus when the attest tx was processed.
#[utoipa::path(
    post,
    path = "/predicates/attested",
    request_body = CheckPredicateRequest,
    responses(
        (status = 200, description = "Attestation membership", body = CheckPredicateResponse),
        (status = 400, description = "Invalid input"),
    ),
    tag = "predicates"
)]
pub async fn check_predicate_attested(
    State(state): State<AppState>,
    Json(req): Json<CheckPredicateRequest>,
) -> Result<Json<CheckPredicateResponse>, ApiError> {
    let cred_vec = hex::decode(req.credential_id.trim_start_matches("0x"))
        .map_err(|_| ApiError::InvalidInput("credential_id not hex".to_string()))?;
    let cred_id: [u8; 32] = cred_vec
        .as_slice()
        .try_into()
        .map_err(|_| ApiError::InvalidInput("credential_id must be 32 bytes".to_string()))?;

    use owl_proof_system::attestation;
    let decode_hex32 = |label: &str, hex: &str| -> Result<[u8; 32], ApiError> {
        let vec = hex::decode(hex.trim_start_matches("0x"))
            .map_err(|_| ApiError::InvalidInput(format!("{label} not hex")))?;
        vec.as_slice()
            .try_into()
            .map_err(|_| ApiError::InvalidInput(format!("{label} must be 32 bytes")))
    };
    let key = match req.predicate.as_str() {
        "age" => attestation::age_key(
            &cred_id,
            req.threshold
                .ok_or_else(|| ApiError::InvalidInput("threshold required for age".to_string()))?
                as u128,
        ),
        "kyc" => attestation::kyc_key(
            &cred_id,
            req.threshold
                .ok_or_else(|| ApiError::InvalidInput("threshold required for kyc".to_string()))?
                as u128,
        ),
        "nationality" => {
            let codes = req.countries.as_deref().ok_or_else(|| {
                ApiError::InvalidInput("countries required for nationality".to_string())
            })?;
            if codes.is_empty() || codes.len() > attestation::COUNTRY_SET_SLOTS {
                return Err(ApiError::InvalidInput(format!(
                    "countries must be 1..={} ISO-3166 alpha-2 codes",
                    attestation::COUNTRY_SET_SLOTS,
                )));
            }
            let verifier_id = req.verifier_id.as_deref().filter(|s| !s.is_empty()).ok_or_else(|| {
                ApiError::InvalidInput(
                    "verifierId required for nationality (per-verifier salt for setHash)"
                        .to_string(),
                )
            })?;
            let refs: Vec<&str> = codes.iter().map(String::as_str).collect();
            attestation::nationality_key(&cred_id, verifier_id, &refs)
        }
        "residency" => {
            let codes = req.countries.as_deref().ok_or_else(|| {
                ApiError::InvalidInput("countries required for residency".to_string())
            })?;
            if codes.is_empty() || codes.len() > attestation::COUNTRY_SET_SLOTS {
                return Err(ApiError::InvalidInput(format!(
                    "countries must be 1..={} ISO-3166 alpha-2 codes",
                    attestation::COUNTRY_SET_SLOTS,
                )));
            }
            let verifier_id = req.verifier_id.as_deref().filter(|s| !s.is_empty()).ok_or_else(|| {
                ApiError::InvalidInput(
                    "verifierId required for residency (per-verifier salt for setHash)"
                        .to_string(),
                )
            })?;
            let refs: Vec<&str> = codes.iter().map(String::as_str).collect();
            attestation::residency_key(&cred_id, verifier_id, &refs)
        }
        "age_range" => attestation::age_range_key(
            &cred_id,
            req.min_age.ok_or_else(|| {
                ApiError::InvalidInput("min_age required for age_range".to_string())
            })?,
            req.max_age.ok_or_else(|| {
                ApiError::InvalidInput("max_age required for age_range".to_string())
            })?,
        ),
        "email_verified" => attestation::email_verified_key(&cred_id),
        "unique_personhood" => {
            let epoch_hex = req.epoch.as_deref().ok_or_else(|| {
                ApiError::InvalidInput("epoch required for unique_personhood".to_string())
            })?;
            let app_id_hex = req.app_id.as_deref().ok_or_else(|| {
                ApiError::InvalidInput("app_id required for unique_personhood".to_string())
            })?;
            let epoch = decode_hex32("epoch", epoch_hex)?;
            let app_id = decode_hex32("app_id", app_id_hex)?;
            attestation::unique_personhood_key(&cred_id, &epoch, &app_id)
        }
        other => {
            return Err(ApiError::InvalidInput(format!(
                "unknown predicate: {other}"
            )));
        }
    };
    let key_hex = hex::encode(key);
    let attested = state.attestations.is_attested(&key_hex);

    Ok(Json(CheckPredicateResponse {
        predicate: req.predicate,
        attest_key: key_hex,
        attested,
    }))
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PredicateSnapshotResponse {
    /// Predicate-registry contract address (hex).
    pub address: String,
    /// `ZswapChainState.serialize()` hex.
    pub zswap_chain_state: String,
    /// `ContractState.serialize()` hex — carries the
    /// `approvedNationality` Merkle tree so nationality proves offline.
    pub contract_state: String,
    /// `LedgerParameters.serialize()` hex.
    pub ledger_parameters: String,
}

/// Sidecar predicate-kind segment validator. One Compact contract per
/// predicate under the per-extrinsic deploy-weight cap; the URL kind
/// must match a deployed contract.
fn validate_predicate_kind(kind: &str) -> Result<(), ApiError> {
    match kind {
        "age" | "kyc" | "residency" | "email" | "nationality" | "age_range" | "personhood" => {
            Ok(())
        }
        other => Err(ApiError::InvalidInput(format!(
            "unknown predicate kind '{other}'"
        ))),
    }
}

/// Read-only chain-state snapshot the holder device feeds to a
/// snapshot-backed provider for offline predicate circuit-exec. The
/// holder never queries the chain — this is the only state it gets.
/// One Compact contract per predicate kind; the `kind` path segment
/// selects which (`age|kyc|residency|email|nationality|age_range|
/// personhood`).
#[utoipa::path(
    get,
    path = "/predicates/{kind}/snapshot",
    params(
        ("kind" = String, Path, description = "Predicate kind segment (age|kyc|residency|email|nationality|age_range|personhood)"),
    ),
    responses(
        (status = 200, description = "Off-chain state snapshot", body = PredicateSnapshotResponse),
        (status = 400, description = "Sidecar unreachable or unknown kind"),
    ),
    tag = "predicates"
)]
pub async fn get_predicate_snapshot(
    State(state): State<AppState>,
    Path(kind): Path<String>,
) -> Result<Json<PredicateSnapshotResponse>, ApiError> {
    validate_predicate_kind(&kind)?;
    let sidecar = &state.midnight;
    let s = sidecar
        .predicate_snapshot(&kind)
        .await
        .map_err(|e| ApiError::InvalidInput(e.to_string()))?;
    Ok(Json(PredicateSnapshotResponse {
        address: s.address,
        zswap_chain_state: s.zswap_chain_state,
        contract_state: s.contract_state,
        ledger_parameters: s.ledger_parameters,
    }))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelayProofRequest {
    /// Holder-proven `UnboundTransaction`, serialized, hex. The witness
    /// is already gone (preimage → ZK proof) before it reaches here.
    pub proven_tx: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelayProofResponse {
    /// Chain transaction id.
    pub tx_id: String,
    /// Submission status — `submitted` for fire-and-forget relays, or
    /// a terminal finalization status (`SucceedEntirely` |
    /// `FailEntirely` | `FailFallible`) when the sidecar awaited the
    /// finalization itself. Holder polls
    /// `GET /predicates/tx/{txId}/status` to await finalization.
    pub status: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TxStatusResponse {
    pub tx_id: String,
    /// Latest known phase. One of: `queued | balancing | submitting |
    /// submitted | balance-failed | submit-failed | SucceedEntirely |
    /// FailEntirely | FailFallible`. The system uses SSE end-to-end for
    /// these updates — see `GET /predicates/tx/{tx_id}/events`.
    pub status: String,
}

/// Balance + submit a holder-proven predicate attestation against the
/// per-kind Compact contract. The Midnight node verifies the proof in
/// consensus and records the attestation; the existing SSE mirror
/// surfaces it to verifiers. The holder never touches the chain —
/// this endpoint is the only submit path.
#[utoipa::path(
    post,
    path = "/predicates/{kind}/relay",
    params(
        ("kind" = String, Path, description = "Predicate kind segment (age|kyc|residency|email|nationality|age_range|personhood)"),
    ),
    request_body = RelayProofRequest,
    responses(
        (status = 200, description = "Submitted + finalized", body = RelayProofResponse),
        (status = 400, description = "Invalid proof, unknown kind, or sidecar error"),
    ),
    tag = "predicates"
)]
pub async fn relay_predicate_proof(
    State(state): State<AppState>,
    Path(kind): Path<String>,
    Json(req): Json<RelayProofRequest>,
) -> Result<Json<RelayProofResponse>, ApiError> {
    validate_predicate_kind(&kind)?;
    let sidecar = &state.midnight;
    let r = sidecar
        .relay_proven_tx(&kind, &req.proven_tx)
        .await
        .map_err(|e| ApiError::InvalidInput(e.to_string()))?;
    Ok(Json(RelayProofResponse {
        tx_id: r.tx_id.unwrap_or_default(),
        status: r.status.unwrap_or_else(|| "unknown".to_string()),
    }))
}

/// SSE stream of phase transitions for a relay job (or raw chain tx).
/// Forwards the sidecar's upstream `GET /api/predicates/tx/{id}/events`
/// byte-for-byte to the holder so the in-process eventBus pushes reach
/// the browser as `text/event-stream` events. The whole system uses
/// exactly two notification transports end-to-end: WS for two-way
/// channels (presentation sockets) and SSE for server→client pushes.
/// No polling, no long-polling, no rapid-fire HTTP.
#[utoipa::path(
    get,
    path = "/predicates/tx/{tx_id}/events",
    params(
        ("tx_id" = String, Path, description = "Midnight tx id or relay job id (returned by /predicates/{kind}/relay)"),
    ),
    responses(
        (status = 200, description = "SSE stream — `event: status` lines with `{txId, status, error?}` JSON, terminated by a terminal status (`SucceedEntirely | FailEntirely | FailFallible | balance-failed | submit-failed`). Periodic `event: ping` lines keep the connection alive."),
        (status = 502, description = "Sidecar unreachable"),
    ),
    tag = "predicates"
)]
pub async fn stream_predicate_tx_events(
    State(state): State<AppState>,
    Path(tx_id): Path<String>,
) -> axum::response::Response {
    use axum::response::sse::{KeepAlive, Sse};
    let sidecar = &state.midnight;
    let upstream = match sidecar.open_tx_events_stream(&tx_id).await {
        Ok(u) => u,
        Err(e) => return ApiError::InvalidInput(e.to_string()).into_response(),
    };
    // Parse the upstream sidecar SSE byte stream into framed
    // `axum::response::sse::Event` values so axum emits properly
    // chunked, individually flushed SSE frames to the client. The
    // raw byte-pipe approach (`Body::from_stream`) was coalesced by
    // Cloud Run's HTTP/2 frontend, so the first sidecar event would
    // reach the browser and subsequent ones got buffered until the
    // server flushed on stream close — making the holder UI appear
    // stuck on the first phase even though the chain had finalized.
    let byte_stream = upstream.bytes_stream();
    let event_stream = parse_sse_byte_stream(byte_stream);
    // `KeepAlive::default()` writes an SSE comment line every 15 s if
    // no real event has been sent. Layered on top of the sidecar's
    // own 10 s `event: ping` so the holder's connection survives even
    // if the sidecar→verification leg has a transient stall.
    Sse::new(event_stream)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

/// Convert a stream of raw bytes carrying SSE frames (the wire shape
/// hono's `streamSSE` emits) into a stream of typed
/// `axum::response::sse::Event`. Buffers partial frames across chunk
/// boundaries; ignores keep-alive comments (the axum `KeepAlive`
/// layer handles those on this side).
fn parse_sse_byte_stream<S, B, E>(
    inner: S,
) -> impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>
where
    S: futures_util::Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Debug,
{
    use axum::response::sse::Event;
    use futures_util::StreamExt;
    let mut buf = String::new();
    inner.flat_map(move |chunk| {
        let mut events: Vec<Result<Event, std::convert::Infallible>> = Vec::new();
        match chunk {
            Ok(bytes) => match std::str::from_utf8(bytes.as_ref()) {
                Ok(s) => buf.push_str(s),
                Err(_) => return futures_util::stream::iter(events),
            },
            Err(_) => {
                // Upstream error — end the stream cleanly. The browser
                // reconnect logic will re-establish.
                return futures_util::stream::iter(events);
            }
        }
        // A complete SSE frame is terminated by a blank line ("\n\n").
        while let Some(idx) = buf.find("\n\n") {
            let raw = buf[..idx].to_string();
            buf.drain(..idx + 2);
            let mut name: Option<String> = None;
            let mut id: Option<String> = None;
            let mut data_lines: Vec<&str> = Vec::new();
            let mut comment_only = true;
            for line in raw.lines() {
                if line.starts_with(':') {
                    continue; // SSE comment — skip
                }
                comment_only = false;
                let (field, value) = match line.find(':') {
                    Some(i) => (&line[..i], line[i + 1..].trim_start_matches(' ')),
                    None => (line, ""),
                };
                match field {
                    "event" => name = Some(value.to_string()),
                    "id" => id = Some(value.to_string()),
                    "data" => data_lines.push(value),
                    _ => {}
                }
            }
            if comment_only {
                continue;
            }
            let mut event = Event::default();
            if let Some(n) = name {
                event = event.event(n);
            }
            if let Some(i) = id {
                event = event.id(i);
            }
            if !data_lines.is_empty() {
                event = event.data(data_lines.join("\n"));
            }
            events.push(Ok(event));
        }
        futures_util::stream::iter(events)
    })
}

/// One row of the revocation registry as exposed to admin clients.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevocationEntry {
    pub credential_id: String,
    pub status: String,
    pub reason: Option<String>,
    /// RFC 3339 timestamp; `None` for credentials that were suspended but
    /// never permanently revoked (kept for symmetry with the row shape).
    pub revoked_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// List revoked credentials
#[utoipa::path(
    get,
    path = "/revocations/list",
    responses(
        (status = 200, description = "List of revoked credentials", body = Vec<RevocationEntry>),
    ),
    tag = "revocations"
)]
pub async fn list_revoked(
    State(state): State<AppState>,
) -> Result<Json<Vec<RevocationEntry>>, ApiError> {
    let revocations = state.revocations.list(Some("revoked".to_string())).await?;
    let list: Vec<RevocationEntry> = revocations
        .into_iter()
        .map(|r| RevocationEntry {
            credential_id: r.credential_id,
            status: r.status,
            reason: r.reason,
            revoked_at: r.revoked_at,
        })
        .collect();
    Ok(Json(list))
}

/// Get metrics
/// Snapshot of the verification service's running metrics.
#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsResponse {
    pub total_verifications: i64,
    pub successful_verifications: i64,
    pub failed_verifications: i64,
    /// Successful / total, rounded to two decimal places.
    pub success_rate: f64,
}

#[utoipa::path(
    get,
    path = "/metrics",
    responses(
        (status = 200, description = "Service metrics", body = MetricsResponse),
    ),
    tag = "metrics"
)]
pub async fn get_metrics(State(state): State<AppState>) -> Result<Json<MetricsResponse>, ApiError> {
    let m = state.verification_logs.get_current_metrics().await?;
    Ok(Json(MetricsResponse {
        total_verifications: m.total_verifications,
        successful_verifications: m.successful_verifications,
        failed_verifications: m.failed_verifications,
        success_rate: m.success_rate(),
    }))
}

/// API Error type
#[derive(Debug)]
pub enum ApiError {
    Database(DatabaseError),
    Serialization(serde_json::Error),
    InvalidInput(String),
    /// Server-side failure that the caller can't fix — most commonly
    /// a Midnight chain write/read failure, which we propagate as 5xx
    /// so the caller knows their state wasn't committed.
    Internal(String),
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
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };

        let body = serde_json::json!({
            "error": message,
        });

        (status, Json(body)).into_response()
    }
}
