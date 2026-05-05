//! Public registry endpoints — predicates and set-membership datasets.
//!
//! The verifier already pins every ZK proof against this registry server-side
//! (see `owl_proof_system::zk::verify_zk_proof_pinned`); exposing it over HTTP
//! lets verifier-side apps build their selector UI from the same source of
//! truth without round-tripping the issuer service.

use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use owl_proof_system::predicates::{self, PredicateParams};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct PredicateInfo {
    pub id: String,
    pub attribute: String,
    pub label: String,
    pub op: String,
    /// JSON-encoded wire value the holder drops onto `PredicateRequest.value`.
    /// `GreaterOrEqual` predicates carry a number (e.g. `"18"`); `InSet`
    /// predicates carry a registered dataset name (e.g. `"\"eu\""`).
    pub value: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CircuitDatasetInfo {
    pub name: String,
    pub version: u32,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CircuitDataset {
    pub name: String,
    pub version: u32,
    pub items: Vec<String>,
}

/// List every predicate the system can prove. Public, no auth required.
#[utoipa::path(
    get,
    path = "/predicates",
    tag = "registry",
    responses((status = 200, description = "Registered predicates", body = Vec<PredicateInfo>))
)]
pub async fn list_predicates() -> Json<Vec<PredicateInfo>> {
    let preds = predicates::list_all()
        .iter()
        .map(|p| {
            let (op, value_json) = match p.params {
                PredicateParams::Threshold(t) => ("GreaterOrEqual", serde_json::json!(t)),
                PredicateParams::SetName(name) => ("InSet", serde_json::json!(name)),
            };
            PredicateInfo {
                id: p.id.to_string(),
                attribute: p.attribute.to_string(),
                label: p.label.to_string(),
                op: op.to_string(),
                value: value_json.to_string(),
            }
        })
        .collect();
    Json(preds)
}

/// Summarise every registered set-membership dataset (name + version only).
#[utoipa::path(
    get,
    path = "/circuit-data",
    tag = "registry",
    responses((status = 200, description = "Registered circuit datasets", body = Vec<CircuitDatasetInfo>))
)]
pub async fn list_circuit_data() -> Json<Vec<CircuitDatasetInfo>> {
    let entries = owl_zk_circuits::data::list_datasets()
        .iter()
        .map(|d| CircuitDatasetInfo {
            name: d.name.to_string(),
            version: d.version,
        })
        .collect();
    Json(entries)
}

/// Return a single dataset's full leaf list. Public.
#[utoipa::path(
    get,
    path = "/circuit-data/{name}",
    tag = "registry",
    params(("name" = String, Path, description = "Dataset name")),
    responses(
        (status = 200, description = "Dataset contents", body = CircuitDataset),
        (status = 404, description = "Dataset not registered"),
    )
)]
pub async fn get_circuit_dataset(
    Path(name): Path<String>,
) -> Result<Json<CircuitDataset>, (StatusCode, Json<serde_json::Value>)> {
    match owl_zk_circuits::data::lookup(&name) {
        Some(d) => Ok(Json(CircuitDataset {
            name: d.name.to_string(),
            version: d.version,
            items: d.items.iter().map(|s| s.to_string()).collect(),
        })),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": format!("Dataset not found: {}", name) })),
        )),
    }
}

/// Names of every Groth16 circuit served by `/zk-keys/{circuit}.pk.bin`.
/// Wallets call this once to drive their prefetch list and avoid hard-coding
/// circuit identifiers that change with the artifact set.
#[utoipa::path(
    get,
    path = "/zk-keys",
    tag = "registry",
    responses((status = 200, description = "Available proving-key circuit names", body = Vec<String>))
)]
pub async fn list_proving_keys() -> Json<Vec<String>> {
    Json(
        owl_zk_circuits::prover_key_bytes::ALL
            .iter()
            .map(|s| s.to_string())
            .collect(),
    )
}

/// Serve the raw Groth16 proving key for a given circuit. Public — the keys
/// are public cryptographic material; integrity is what matters, not secrecy.
///
/// Path is `/zk-keys/{circuit}.pk.bin`. Cached aggressively (immutable):
/// when the circuit changes, the key changes and a new artifact is shipped
/// behind a new build hash; clients pick that up on next deploy.
#[utoipa::path(
    get,
    path = "/zk-keys/{filename}",
    tag = "registry",
    params(("filename" = String, Path, description = "<circuit>.pk.bin")),
    responses(
        (status = 200, description = "Proving-key bytes (ark-serialize compressed)"),
        (status = 404, description = "Unknown circuit"),
    )
)]
pub async fn get_proving_key(Path(filename): Path<String>) -> Response {
    // Strict shape check first — no path separators, must end .pk.bin.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(circuit) = filename.strip_suffix(".pk.bin") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(bytes) = owl_zk_circuits::prover_key_bytes::lookup(circuit) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response()
}
