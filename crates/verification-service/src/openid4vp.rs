//! OpenID4VP 1.0 §5 Authorization Request endpoint.
//!
//! External wallets bootstrap via the standard `openid4vp://?request_uri=…`
//! deeplink: the wallet `GET`s the `request_uri`, learns the
//! `response_uri` + `dcql_query` + `nonce`, builds the vp_token, POSTs
//! it back. OwlID's own holder app receives the same DCQL query over
//! the presentation WebSocket; both paths converge on
//! `/openid4vp/response`.
//!
//! The Request Object is **unsigned** (allowed by OpenID4VP 1.0 §5.10
//! when `client_id_scheme = redirect_uri` — the Wallet treats the
//! response_uri as the verifier identity, no further trust anchor
//! required). Signing requires a verifier signing key; OwlID's
//! Midnight-only constraint deliberately avoids adding one.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct AuthorizationRequest {
    /// Equals `response_uri` when `client_id_scheme = redirect_uri`
    /// (OpenID4VP 1.0 §5.9.2).
    pub client_id: String,
    /// `redirect_uri` — verifier is identified by the response_uri it
    /// owns. No external trust anchor (X.509 / DID resolver / OIDF
    /// federation) required.
    pub client_id_scheme: &'static str,
    pub response_type: &'static str,
    pub response_mode: &'static str,
    /// Absolute URL the wallet POSTs the vp_token to.
    pub response_uri: String,
    /// One-shot nonce the wallet binds into every KB-JWT it signs.
    pub nonce: String,
    /// DCQL query the wallet solves (OpenID4VP 1.0 §6).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dcql_query: Option<crate::dcql::DcqlRequest>,
    /// Verifier metadata — display name surfaced to the holder.
    pub client_metadata: ClientMetadata,
    /// Issued at — Unix seconds.
    pub iat: i64,
    /// Expiry — Unix seconds.
    pub exp: i64,
}

#[derive(Debug, Serialize)]
pub struct ClientMetadata {
    /// Human-readable verifier name shown on the consent screen.
    pub client_name: String,
    /// VP formats the verifier accepts (OpenID4VP 1.0 §11.1). OwlID
    /// is SD-JWT VC only.
    pub vp_formats: serde_json::Value,
}

/// `GET /openid4vp/request/{session_id}` — return the OpenID4VP 1.0
/// §5 Authorization Request object as JSON. Returns 404 when the
/// session is expired or unknown.
pub async fn get_authorization_request(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<AuthorizationRequest>, Openid4vpError> {
    let data = state
        .presentations
        .get_request_data(&session_id)
        .await
        .ok_or(Openid4vpError::NotFound)?;

    let base = state.verification_public_url.trim_end_matches('/');
    let response_uri = format!("{base}/openid4vp/response");

    let now = chrono::Utc::now().timestamp();
    let req = AuthorizationRequest {
        client_id: response_uri.clone(),
        client_id_scheme: "redirect_uri",
        response_type: "vp_token",
        response_mode: "direct_post",
        response_uri,
        nonce: data.nonce,
        dcql_query: data.dcql_query,
        client_metadata: ClientMetadata {
            client_name: data
                .verifier_name
                .unwrap_or_else(|| "OwlID Verifier".to_string()),
            vp_formats: serde_json::json!({
                "dc+sd-jwt": {
                    "sd-jwt_alg_values": ["EdDSA"],
                    "kb-jwt_alg_values": ["EdDSA", "ES256"]
                }
            }),
        },
        iat: now,
        exp: now + 300, // Match presentation-session TTL.
    };
    Ok(Json(req))
}

#[derive(Debug)]
pub enum Openid4vpError {
    NotFound,
}

impl IntoResponse for Openid4vpError {
    fn into_response(self) -> Response {
        match self {
            Openid4vpError::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "session not found or expired"
                })),
            )
                .into_response(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Request Object's JSON shape is normative — wallets read it
    /// verbatim. Lock the field names + the `response_mode` value to
    /// catch any accidental rename in the future.
    #[test]
    fn request_object_serializes_with_spec_field_names() {
        let req = AuthorizationRequest {
            client_id: "https://verifier.example/openid4vp/response".into(),
            client_id_scheme: "redirect_uri",
            response_type: "vp_token",
            response_mode: "direct_post",
            response_uri: "https://verifier.example/openid4vp/response".into(),
            nonce: "0123456789abcdef".into(),
            dcql_query: None,
            client_metadata: ClientMetadata {
                client_name: "Acme Bar".into(),
                vp_formats: serde_json::json!({}),
            },
            iat: 1_700_000_000,
            exp: 1_700_000_300,
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["client_id_scheme"], "redirect_uri");
        assert_eq!(v["response_type"], "vp_token");
        assert_eq!(v["response_mode"], "direct_post");
        assert_eq!(
            v["response_uri"],
            "https://verifier.example/openid4vp/response"
        );
        assert_eq!(v["nonce"], "0123456789abcdef");
        assert!(v.get("dcql_query").is_none(), "absent when None");
        assert_eq!(v["client_metadata"]["client_name"], "Acme Bar");
        assert_eq!(v["iat"], 1_700_000_000);
        assert_eq!(v["exp"], 1_700_000_300);
    }
}
