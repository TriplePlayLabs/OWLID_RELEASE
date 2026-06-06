//! Pluggable DID resolver registry.
//!
//! Each DID method (`did:web`, `did:key`, `did:jwk`, eventual
//! `did:midnight`) implements [`DidMethodResolver`]. [`DidResolver`]
//! dispatches by the method prefix and exposes the unified
//! [`ResolvedDid`] shape consumed by the verifier's trust chain.
//!
//! The DIF `did-jwt-vc` library uses the same registry pattern; we
//! mirror it so OwlID can add native `did:midnight` support the
//! moment that spec lands without touching the verify hot path.

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

pub mod did_jwk;
pub mod did_key;
pub mod did_midnight;
pub mod did_web;

/// Public-key algorithm carried by a resolved DID document. Issuer
/// JWS signing remains EdDSA-only (`sd_jwt::verify`); holder `cnf`
/// keys may be either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAlgorithm {
    Ed25519,
    EcdsaP256,
}

/// Result of resolving a DID. `key_hex` is the raw public-key bytes
/// hex-encoded (32B Ed25519 or 65B SEC1 uncompressed P-256).
/// `doc_hash_hex` is `sha256(canonical_json(did_document))` — used
/// by the `did:webs` on-chain anchor check.
#[derive(Debug, Clone)]
pub struct ResolvedDid {
    pub did: String,
    pub key_hex: String,
    pub key_alg: KeyAlgorithm,
    pub doc_hash_hex: String,
}

#[async_trait]
pub trait DidMethodResolver: Send + Sync {
    /// The method id (e.g. `web`, `key`, `jwk`, `midnight`) — must
    /// match the literal between `did:` and `:` in the DID URL.
    fn method(&self) -> &'static str;
    async fn resolve(&self, did: &str) -> Result<ResolvedDid, String>;
}

/// Registry that dispatches a DID to its method-specific resolver.
pub struct DidResolver {
    resolvers: HashMap<&'static str, Arc<dyn DidMethodResolver>>,
}

impl DidResolver {
    pub fn new() -> Self {
        Self {
            resolvers: HashMap::new(),
        }
    }

    /// Build the default registry: `did:web` + `did:key` + `did:jwk`
    /// + `did:midnight` stub. Verification-service main wires this on
    /// startup.
    pub fn with_defaults() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(did_web::DidWebResolver::new()));
        r.register(Arc::new(did_key::DidKeyResolver));
        r.register(Arc::new(did_jwk::DidJwkResolver));
        r.register(Arc::new(did_midnight::DidMidnightResolver));
        r
    }

    pub fn register(&mut self, resolver: Arc<dyn DidMethodResolver>) {
        self.resolvers.insert(resolver.method(), resolver);
    }

    #[allow(dead_code)] // introspection helper; not yet wired into a route
    pub fn supported_methods(&self) -> Vec<&'static str> {
        let mut m: Vec<&'static str> = self.resolvers.keys().copied().collect();
        m.sort_unstable();
        m
    }

    pub async fn resolve(&self, did: &str) -> Result<ResolvedDid, String> {
        let method = parse_method(did).ok_or_else(|| format!("not a DID URL: {did}"))?;
        let resolver = self
            .resolvers
            .get(method)
            .ok_or_else(|| format!("unsupported DID method: did:{method}"))?;
        resolver.resolve(did).await
    }
}

impl Default for DidResolver {
    fn default() -> Self {
        Self::with_defaults()
    }
}

/// Parse `did:<method>:...` and return the method (without `did:`).
fn parse_method(did: &str) -> Option<&str> {
    let rest = did.strip_prefix("did:")?;
    rest.split(':').next().filter(|s| !s.is_empty())
}

/// `sha256(canonical_json(doc))` — the on-chain `did:webs` anchor
/// handle. Exposed because the verifier passes it to the Midnight
/// `identity_registry` commitment check.
pub fn canonical_doc_hash(doc: &serde_json::Value) -> Result<String, String> {
    let canonical = serde_json::to_vec(doc).map_err(|e| format!("canonicalize: {e}"))?;
    Ok(hex::encode(Sha256::digest(&canonical)))
}

/// `did:webs`-style tamper-evidence: only meaningful for `did:web`
/// (the document is fetched off the wire and therefore tamperable).
/// `did:key` / `did:jwk` are self-describing — no anchor needed; this
/// is a no-op. For an unanchored did:web we warn and accept (best
/// effort — the standards trust anchor `key ∈ issuer_registry`
/// already rejects key substitution; this is defence-in-depth).
pub async fn anchor_check(
    midnight: &crate::midnight::MidnightSidecar,
    resolved: &ResolvedDid,
) -> Result<(), String> {
    if !resolved.did.starts_with("did:web:") {
        return Ok(());
    }
    let did_hash = did_web::did_web_did_hash(&resolved.did);
    match midnight.get_commitment(&did_hash).await {
        Ok(resp) => match resp.commitment.as_deref() {
            Some(c) if c.eq_ignore_ascii_case(&resolved.doc_hash_hex) => Ok(()),
            Some(c) => Err(format!(
                "did:web doc-hash anchor mismatch: on-chain {c}, fetched {}",
                resolved.doc_hash_hex
            )),
            None => {
                tracing::warn!(
                    "did:web doc-hash anchor not yet on-chain for {} (best-effort)",
                    resolved.did
                );
                Ok(())
            }
        },
        Err(e) => {
            tracing::warn!("did:web anchor check failed (non-blocking): {e}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_method_handles_did_web_did_key_did_jwk() {
        assert_eq!(parse_method("did:web:issuer.example"), Some("web"));
        assert_eq!(parse_method("did:key:z6Mk..."), Some("key"));
        assert_eq!(parse_method("did:jwk:eyJ..."), Some("jwk"));
        assert_eq!(parse_method("did:midnight:abc"), Some("midnight"));
        assert_eq!(parse_method("did:"), None);
        assert_eq!(parse_method("https://issuer"), None);
        assert_eq!(parse_method(""), None);
    }

    #[tokio::test]
    async fn registry_dispatches_by_method() {
        let r = DidResolver::with_defaults();
        assert!(r.supported_methods().contains(&"web"));
        assert!(r.supported_methods().contains(&"key"));
        assert!(r.supported_methods().contains(&"jwk"));
        assert!(r.supported_methods().contains(&"midnight"));
    }

    #[tokio::test]
    async fn unsupported_method_errors() {
        let r = DidResolver::new();
        let err = r.resolve("did:web:x").await.unwrap_err();
        assert!(err.contains("unsupported"));
    }

    #[test]
    fn doc_hash_is_deterministic() {
        let doc = serde_json::json!({"id":"did:web:x","key":"abc"});
        let a = canonical_doc_hash(&doc).unwrap();
        let b = canonical_doc_hash(&doc).unwrap();
        assert_eq!(a, b);
    }
}
