//! `did:jwk` resolver — DIF `did:jwk` Method Specification.
//!
//! Identifier shape: `did:jwk:<base64url(JWK JSON)>`. The DID
//! document is synthesised by base64url-decoding the suffix into a
//! JWK and reflecting that JWK as the single verificationMethod.
//!
//! Supports OKP/Ed25519 and EC/P-256 — the only key types the OwlID
//! verify chain consumes.

use super::{DidMethodResolver, KeyAlgorithm, ResolvedDid, canonical_doc_hash};
use async_trait::async_trait;
use base64::prelude::*;
use serde_json::{Value, json};

pub struct DidJwkResolver;

#[async_trait]
impl DidMethodResolver for DidJwkResolver {
    fn method(&self) -> &'static str {
        "jwk"
    }

    async fn resolve(&self, did: &str) -> Result<ResolvedDid, String> {
        let suffix = did
            .strip_prefix("did:jwk:")
            .ok_or_else(|| format!("not a did:jwk: {did}"))?;
        let json_bytes = BASE64_URL_SAFE_NO_PAD
            .decode(suffix)
            .map_err(|e| format!("did:jwk base64url: {e}"))?;
        let jwk: Value =
            serde_json::from_slice(&json_bytes).map_err(|e| format!("did:jwk JSON: {e}"))?;
        let (key_hex, key_alg) = key_from_jwk(&jwk)?;
        let doc = synthesise_did_document(did, &jwk);
        let doc_hash_hex = canonical_doc_hash(&doc)?;
        Ok(ResolvedDid {
            did: did.to_string(),
            key_hex,
            key_alg,
            doc_hash_hex,
        })
    }
}

fn key_from_jwk(jwk: &Value) -> Result<(String, KeyAlgorithm), String> {
    let kty = jwk
        .get("kty")
        .and_then(Value::as_str)
        .ok_or_else(|| "JWK missing kty".to_string())?;
    let crv = jwk
        .get("crv")
        .and_then(Value::as_str)
        .ok_or_else(|| "JWK missing crv".to_string())?;
    match (kty, crv) {
        ("OKP", "Ed25519") => {
            let x = jwk
                .get("x")
                .and_then(Value::as_str)
                .ok_or_else(|| "OKP JWK missing x".to_string())?;
            let bytes = BASE64_URL_SAFE_NO_PAD
                .decode(x)
                .map_err(|e| format!("OKP x base64url: {e}"))?;
            Ok((hex::encode(bytes), KeyAlgorithm::Ed25519))
        }
        ("EC", "P-256") => {
            let x = jwk
                .get("x")
                .and_then(Value::as_str)
                .ok_or_else(|| "EC JWK missing x".to_string())?;
            let y = jwk
                .get("y")
                .and_then(Value::as_str)
                .ok_or_else(|| "EC JWK missing y".to_string())?;
            let mut sec1 = vec![0x04u8];
            sec1.extend_from_slice(
                &BASE64_URL_SAFE_NO_PAD
                    .decode(x)
                    .map_err(|e| format!("EC x base64url: {e}"))?,
            );
            sec1.extend_from_slice(
                &BASE64_URL_SAFE_NO_PAD
                    .decode(y)
                    .map_err(|e| format!("EC y base64url: {e}"))?,
            );
            Ok((hex::encode(sec1), KeyAlgorithm::EcdsaP256))
        }
        _ => Err(format!("did:jwk unsupported (kty={kty}, crv={crv})")),
    }
}

fn synthesise_did_document(did: &str, jwk: &Value) -> Value {
    json!({
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/jwk/v1"],
        "id": did,
        "verificationMethod": [{
            "id": format!("{did}#0"),
            "type": "JsonWebKey",
            "controller": did,
            "publicKeyJwk": jwk
        }],
        "assertionMethod": [format!("{did}#0")],
        "authentication": [format!("{did}#0")]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ed25519_round_trip() {
        let jwk = json!({
            "kty": "OKP",
            "crv": "Ed25519",
            "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
        });
        let suffix = BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_string(&jwk).unwrap().as_bytes());
        let did = format!("did:jwk:{suffix}");
        let resolved = DidJwkResolver.resolve(&did).await.unwrap();
        assert_eq!(resolved.key_alg, KeyAlgorithm::Ed25519);
        assert_eq!(resolved.key_hex.len(), 64);
    }

    #[tokio::test]
    async fn p256_round_trip() {
        let jwk = json!({
            "kty": "EC",
            "crv": "P-256",
            "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
            "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"
        });
        let suffix = BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_string(&jwk).unwrap().as_bytes());
        let did = format!("did:jwk:{suffix}");
        let resolved = DidJwkResolver.resolve(&did).await.unwrap();
        assert_eq!(resolved.key_alg, KeyAlgorithm::EcdsaP256);
        // 0x04 prefix + 32 + 32 = 65 bytes = 130 hex chars.
        assert_eq!(resolved.key_hex.len(), 130);
        assert!(resolved.key_hex.starts_with("04"));
    }

    #[tokio::test]
    async fn rejects_non_did_jwk() {
        let err = DidJwkResolver.resolve("did:web:x").await.unwrap_err();
        assert!(err.contains("not a did:jwk"));
    }

    #[tokio::test]
    async fn rejects_unsupported_kty() {
        let jwk = json!({ "kty": "RSA", "n": "..." });
        let suffix = BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_string(&jwk).unwrap().as_bytes());
        let did = format!("did:jwk:{suffix}");
        let err = DidJwkResolver.resolve(&did).await.unwrap_err();
        assert!(err.contains("unsupported") || err.contains("missing"));
    }

    #[tokio::test]
    async fn rejects_malformed_base64() {
        let did = "did:jwk:!!!not-base64-url!!!";
        let err = DidJwkResolver.resolve(did).await.unwrap_err();
        assert!(err.contains("base64url"));
    }
}
