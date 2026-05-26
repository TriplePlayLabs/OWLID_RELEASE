//! `did:web` resolver — fetches `/.well-known/did.json` (or the path
//! form `/seg/seg/did.json`), enforces the normative Read-step
//! `id`-match (W3C-CCG `did-method-web`), extracts the issuer's
//! OKP Ed25519 verification method, caches the result.

use super::{canonical_doc_hash, DidMethodResolver, KeyAlgorithm, ResolvedDid};
use async_trait::async_trait;
use base64::prelude::*;
use serde_json::Value;
use sha2::Digest;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct CachedResolved {
    resolved: ResolvedDid,
    at: Instant,
}

pub struct DidWebResolver {
    cache: &'static RwLock<HashMap<String, CachedResolved>>,
}

impl DidWebResolver {
    pub fn new() -> Self {
        static C: OnceLock<RwLock<HashMap<String, CachedResolved>>> = OnceLock::new();
        Self {
            cache: C.get_or_init(|| RwLock::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl DidMethodResolver for DidWebResolver {
    fn method(&self) -> &'static str {
        "web"
    }

    async fn resolve(&self, did: &str) -> Result<ResolvedDid, String> {
        if let Some(c) = self.cache.read().await.get(did).cloned() {
            if c.at.elapsed() < TTL {
                return Ok(c.resolved);
            }
        }
        let url = did_web_to_url(did).ok_or_else(|| format!("not a did:web: {did}"))?;
        let doc: Value = reqwest::get(&url)
            .await
            .map_err(|e| format!("fetch {url}: {e}"))?
            .json()
            .await
            .map_err(|e| format!("json {url}: {e}"))?;
        // did:web Read step: the resolved document's `id` MUST equal
        // the requested DID (W3C-CCG normative).
        if doc.get("id").and_then(Value::as_str) != Some(did) {
            return Err(format!(
                "DID document id mismatch: requested {did}, got {:?}",
                doc.get("id")
            ));
        }
        let (key_hex, key_alg) = key_from_doc(&doc)
            .ok_or_else(|| "DID doc verificationMethod missing supported key".to_string())?;
        let doc_hash_hex = canonical_doc_hash(&doc)?;
        let resolved = ResolvedDid {
            did: did.to_string(),
            key_hex,
            key_alg,
            doc_hash_hex,
        };
        self.cache.write().await.insert(
            did.to_string(),
            CachedResolved {
                resolved: resolved.clone(),
                at: Instant::now(),
            },
        );
        Ok(resolved)
    }
}

/// `did:web:host%3Aport[:seg:seg]` → DID-document URL. `https`
/// except `localhost` / `127.0.0.1` (dev → `http`).
pub fn did_web_to_url(did: &str) -> Option<String> {
    let rest = did.strip_prefix("did:web:")?;
    let mut parts = rest.split(':');
    let authority = parts.next()?.replace("%3A", ":");
    let segs: Vec<&str> = parts.collect();
    let host = authority.split(':').next().unwrap_or(authority.as_str());
    let scheme = if host == "localhost" || host == "127.0.0.1" {
        "http"
    } else {
        "https"
    };
    Some(if segs.is_empty() {
        format!("{scheme}://{authority}/.well-known/did.json")
    } else {
        format!("{scheme}://{authority}/{}/did.json", segs.join("/"))
    })
}

/// Extract the first supported verification method (OKP/Ed25519 or
/// EC/P-256) from a DID document. Other key types fall through.
fn key_from_doc(doc: &Value) -> Option<(String, KeyAlgorithm)> {
    let jwk = doc.pointer("/verificationMethod/0/publicKeyJwk")?;
    let kty = jwk.get("kty")?.as_str()?;
    let crv = jwk.get("crv")?.as_str()?;
    match (kty, crv) {
        ("OKP", "Ed25519") => {
            let x = jwk.get("x")?.as_str()?;
            let bytes = BASE64_URL_SAFE_NO_PAD.decode(x).ok()?;
            Some((hex::encode(bytes), KeyAlgorithm::Ed25519))
        }
        ("EC", "P-256") => {
            let x = jwk.get("x")?.as_str()?;
            let y = jwk.get("y")?.as_str()?;
            let mut sec1 = vec![0x04u8];
            sec1.extend_from_slice(&BASE64_URL_SAFE_NO_PAD.decode(x).ok()?);
            sec1.extend_from_slice(&BASE64_URL_SAFE_NO_PAD.decode(y).ok()?);
            Some((hex::encode(sec1), KeyAlgorithm::EcdsaP256))
        }
        _ => None,
    }
}

/// On-chain `didHash` slot for a `did:web` identifier — keys the
/// Midnight `identity_registry` commitment that anchors the DID doc.
pub fn did_web_did_hash(did: &str) -> String {
    let mut h = sha2::Sha256::new();
    h.update(did.as_bytes());
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_mapping_localhost_is_http() {
        assert_eq!(
            did_web_to_url("did:web:localhost%3A8001").as_deref(),
            Some("http://localhost:8001/.well-known/did.json")
        );
        assert_eq!(
            did_web_to_url("did:web:127.0.0.1%3A8001").as_deref(),
            Some("http://127.0.0.1:8001/.well-known/did.json")
        );
    }

    #[test]
    fn url_mapping_public_host_is_https() {
        assert_eq!(
            did_web_to_url("did:web:issuer.example").as_deref(),
            Some("https://issuer.example/.well-known/did.json")
        );
    }

    #[test]
    fn url_mapping_path_form() {
        assert_eq!(
            did_web_to_url("did:web:example.com:issuer:a").as_deref(),
            Some("https://example.com/issuer/a/did.json")
        );
    }

    #[test]
    fn rejects_non_did_web() {
        assert!(did_web_to_url("did:key:z6Mk").is_none());
        assert!(did_web_to_url("https://issuer.example").is_none());
        assert!(did_web_to_url("").is_none());
    }

    #[test]
    fn key_from_doc_okp_ed25519() {
        let doc = serde_json::json!({
            "verificationMethod": [{
                "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "AAAA" }
            }]
        });
        let (hex, alg) = key_from_doc(&doc).unwrap();
        assert_eq!(alg, KeyAlgorithm::Ed25519);
        assert_eq!(hex, "000000");
    }

    #[test]
    fn key_from_doc_ec_p256() {
        let doc = serde_json::json!({
            "verificationMethod": [{
                "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "AAAA", "y": "AAAA" }
            }]
        });
        let (hex, alg) = key_from_doc(&doc).unwrap();
        assert_eq!(alg, KeyAlgorithm::EcdsaP256);
        // 0x04 prefix + 3B x + 3B y.
        assert!(hex.starts_with("04"));
    }

    #[test]
    fn key_from_doc_unknown_alg() {
        let doc = serde_json::json!({
            "verificationMethod": [{
                "publicKeyJwk": { "kty": "RSA", "n": "..." }
            }]
        });
        assert!(key_from_doc(&doc).is_none());
    }

    #[test]
    fn did_hash_localhost_vector() {
        assert_eq!(
            did_web_did_hash("did:web:localhost%3A8001"),
            "c0e10ffa02d31947ed7f280db573c832a37c1905121d383bbeaeb48ddb359e94"
        );
    }
}
