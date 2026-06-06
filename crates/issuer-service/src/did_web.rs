//! Issuer `did:web` identity (DID Core 1.0). The issuer publishes its
//! Ed25519 signing key as a DID document at `/.well-known/did.json`; the
//! SD-JWT VC `iss` is this DID. Trust is still anchored on the Midnight
//! issuer_registry (the verifier requires the resolved key to be a trusted
//! issuer).

use base64::prelude::*;
use owl_crypto::PublicKey;
use serde_json::{Value, json};

/// `http(s)://host[:port][/path]` → `did:web:host[%3Aport][:path-segments]`
/// per the did:web method (port colon percent-encoded, path `/`→`:`).
pub fn did_web_id(public_url: &str) -> String {
    let no_scheme = public_url
        .strip_prefix("https://")
        .or_else(|| public_url.strip_prefix("http://"))
        .unwrap_or(public_url)
        .trim_end_matches('/');
    let (authority, path) = match no_scheme.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (no_scheme, None),
    };
    let mut id = format!("did:web:{}", authority.replace(':', "%3A"));
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        id.push(':');
        id.push_str(&p.replace('/', ":"));
    }
    id
}

/// DID document exposing the issuer Ed25519 key as an OKP JsonWebKey.
pub fn did_document(public_url: &str, issuer_pubkey: &PublicKey) -> Value {
    let did = did_web_id(public_url);
    let x = BASE64_URL_SAFE_NO_PAD.encode(issuer_pubkey.to_bytes());
    let vm_id = format!("{did}#0");
    json!({
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/jwk/v1"],
        "id": did,
        "verificationMethod": [{
            "id": vm_id,
            "type": "JsonWebKey",
            "controller": did,
            "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": x }
        }],
        "assertionMethod": [vm_id.clone()],
        "authentication": [vm_id]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use owl_crypto::KeyPair;

    #[test]
    fn did_web_id_forms() {
        assert_eq!(
            did_web_id("http://localhost:8001"),
            "did:web:localhost%3A8001"
        );
        assert_eq!(
            did_web_id("https://issuer.example/"),
            "did:web:issuer.example"
        );
        assert_eq!(
            did_web_id("https://example.com/issuer/a"),
            "did:web:example.com:issuer:a"
        );
    }

    #[test]
    fn did_document_has_okp_jwk() {
        let kp = KeyPair::generate();
        let doc = did_document("https://issuer.example", &kp.public_key());
        assert_eq!(doc["id"], "did:web:issuer.example");
        assert_eq!(
            doc["verificationMethod"][0]["publicKeyJwk"]["crv"],
            "Ed25519"
        );
        assert_eq!(doc["assertionMethod"][0], "did:web:issuer.example#0");
    }
}
