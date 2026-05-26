//! Public registry endpoints — predicates and set-membership datasets.
//!
//! The verifier already pins every ZK proof against this registry server-side
//! (see `owl_proof_system::zk::verify_zk_proof_pinned`); exposing it over HTTP
//! lets verifier-side apps build their selector UI from the same source of
//! truth without round-tripping the issuer service.

use axum::{
    Json,
    extract::Path,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
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
    /// DCQL claim-path route token. This — not `attribute` — is what a
    /// verifier MUST put on the DCQL claim path: the holder SDK and the
    /// verifier route on it (`age_over_18`, `verification_level`, …).
    pub route: String,
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
            // `op` is always the registry's `PredicateOp` — never derived
            // from `params`. `value` is the wire value the holder drops
            // onto the DCQL claim; `Dynamic` predicates carry no
            // registry value (the verifier supplies it at request time).
            let op = match p.op {
                predicates::PredicateOp::GreaterOrEqual => "GreaterOrEqual",
                predicates::PredicateOp::InSet => "InSet",
                predicates::PredicateOp::InRange => "InRange",
            };
            let value_json = match p.params {
                PredicateParams::Threshold(t) => serde_json::json!(t),
                PredicateParams::SetName(name) => serde_json::json!(name),
                PredicateParams::Dynamic => serde_json::Value::Null,
            };
            PredicateInfo {
                id: p.id.to_string(),
                // `attribute` is the SD-JWT VC standard claim name —
                // display/metadata only. The DCQL claim PATH is `route`
                // (see below); routing never uses `attribute`.
                attribute: to_sd_jwt_claim(p.attribute).to_string(),
                label: p.label.to_string(),
                op: op.to_string(),
                value: value_json.to_string(),
                route: p.route.to_string(),
            }
        })
        .collect();
    Json(preds)
}

/// OwlID internal attribute → SD-JWT VC standard claim name. Mirror of
/// `owl_issuer_service::sd_jwt_bridge::standard_name` (cannot depend on
/// issuer-service from here). Keep both lists in sync when adding new
/// attributes.
fn to_sd_jwt_claim(attr: &str) -> &str {
    match attr {
        "firstName" => "given_name",
        "lastName" => "family_name",
        "dateOfBirth" => "birthdate",
        "placeOfBirth" => "place_of_birth",
        "streetAddress" => "street_address",
        "postalCode" => "postal_code",
        "nationalId" => "national_id",
        "passportNumber" => "passport_number",
        "driversLicense" => "drivers_license",
        "taxId" => "tax_id",
        "documentType" => "document_type",
        "documentNumber" => "document_number",
        "issuingCountry" => "issuing_country",
        "documentExpiry" => "document_expiry",
        "documentIssueDate" => "document_issue_date",
        "verificationLevel" => "verification_level",
        "verifiedAt" => "verified_at",
        "verifiedBy" => "verified_by",
        "verificationMethod" => "verification_method",
        "isOver18" => "age_over_18",
        "isOver21" => "age_over_21",
        "isOver65" => "age_over_65",
        "isEuCitizen" => "nationality_eu",
        "isResident" => "resident",
        "emailVerified" => "email_verified",
        other => other,
    }
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

/// Filenames of every per-kind predicate Compact artifact served by
/// `/predicate-zk/{filename}`. Same role as `/zk-keys` for Groth16: the
/// holder's WASM build leaves the multi-MB keys out and prefetches this
/// list. `<circuit>.<kind>`, `kind ∈ {bzkir, prover, verifier}`. One
/// Compact contract per predicate kind (devnet block-weight cap) — the
/// circuit names cover every deployed kind in one bucket.
#[utoipa::path(
    get,
    path = "/predicate-zk",
    tag = "registry",
    responses((status = 200, description = "Available predicate artifact filenames", body = Vec<String>))
)]
pub async fn list_predicate_assets() -> Json<Vec<String>> {
    Json(crate::predicate_assets::ALL.iter().map(|s| s.to_string()).collect())
}

/// Serve a raw per-kind predicate Compact artifact (zkir / prover /
/// verifier). Public — Compact ZK material is public; integrity, not
/// secrecy, is what matters. Immutable-cached: a contract change ships
/// a new artifact set behind a new build. Mirrors [`get_proving_key`].
#[utoipa::path(
    get,
    path = "/predicate-zk/{filename}",
    tag = "registry",
    params(("filename" = String, Path, description = "<circuit>.{bzkir|prover|verifier}")),
    responses(
        (status = 200, description = "Artifact bytes"),
        (status = 404, description = "Unknown artifact"),
    )
)]
pub async fn get_predicate_asset(Path(filename): Path<String>) -> Response {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(bytes) = crate::predicate_assets::lookup(&filename) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Stream in 1 MiB chunks. The set-membership prover artefacts are
    // ~37 MiB (Vector<64, Bytes<32>> SHA-256 + per-verifier fold)
    // which exceeds Cloud Run's 32 MiB single-response buffer limit
    // when sent as one Vec<u8>. Streaming responses are not capped the
    // same way; the proxy forwards chunks as soon as they land.
    const CHUNK: usize = 1 << 20;
    let total = bytes.len();
    let stream = futures_util::stream::iter(
        bytes
            .chunks(CHUNK)
            .map(|c| Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(c))),
    );
    let body = axum::body::Body::from_stream(stream);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::CONTENT_LENGTH, total)
        .body(body)
        .expect("static headers always produce a valid response")
}
