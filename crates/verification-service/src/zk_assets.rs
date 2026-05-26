//! Static file serving for Midnight Compact ZK artifacts.
//!
//! Serves proving keys, verifying keys, and binary ZKIR files for each contract.
//! These are consumed by the browser's `FetchZkConfigProvider` to generate ZK proofs.
//!
//! Routes (no auth required — ZK artifacts are public cryptographic material):
//!   GET /zk/{contract}/keys/{circuit_id}.prover
//!   GET /zk/{contract}/keys/{circuit_id}.verifier
//!   GET /zk/{contract}/zkir/{circuit_id}.bzkir

use axum::{
    Router,
    extract::Path,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use std::path::PathBuf;

/// Root directory for ZK artifacts, set by build.rs at compile time.
const ZK_DIR: &str = env!("ZK_ARTIFACTS_DIR");

const ALLOWED_CONTRACTS: &[&str] = &[
    "issuer_registry",
    "revocation_registry",
    "identity_registry",
];

/// Build the ZK artifact serving router.
pub fn router() -> Router {
    Router::new()
        .route("/{contract}/keys/{filename}", get(serve_key))
        .route("/{contract}/zkir/{filename}", get(serve_zkir))
}

async fn serve_key(Path((contract, filename)): Path<(String, String)>) -> Response {
    serve_artifact(&contract, "keys", &filename).await
}

async fn serve_zkir(Path((contract, filename)): Path<(String, String)>) -> Response {
    serve_artifact(&contract, "zkir", &filename).await
}

async fn serve_artifact(contract: &str, subdir: &str, filename: &str) -> Response {
    // Validate contract name (prevent path traversal)
    if !ALLOWED_CONTRACTS.contains(&contract) {
        return StatusCode::NOT_FOUND.into_response();
    }

    // Validate filename (no path separators, must have expected extension)
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let valid_ext = match subdir {
        "keys" => filename.ends_with(".prover") || filename.ends_with(".verifier"),
        "zkir" => filename.ends_with(".bzkir"),
        _ => false,
    };
    if !valid_ext {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let path = PathBuf::from(ZK_DIR)
        .join(contract)
        .join(subdir)
        .join(filename);

    match tokio::fs::read(&path).await {
        Ok(data) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CACHE_CONTROL, "public, max-age=86400, immutable"),
            ],
            data,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
