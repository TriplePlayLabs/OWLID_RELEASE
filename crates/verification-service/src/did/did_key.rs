//! `did:key` resolver — W3C CCG `did-method-key` 1.x.
//!
//! Identifier shape: `did:key:<multibase>`. The multibase value
//! starts with `z` (base58btc) and decodes to `<multicodec>||<raw key
//! bytes>`. Supported codecs:
//!   * `0xed01` — Ed25519 public key (32 bytes)
//!   * `0x1200` — secp256r1 / P-256 compressed public key (33 bytes)
//!
//! The DID document is **synthesised** from the identifier — there is
//! no network fetch. `doc_hash_hex` is deterministic over the
//! canonical synthesised document so the rest of the verify chain
//! (anchor check, etc.) works uniformly.

use super::{DidMethodResolver, KeyAlgorithm, ResolvedDid, canonical_doc_hash};
use async_trait::async_trait;
use base64::Engine as _;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::json;

// Multicodec table values (unsigned-varint decoded form):
//   ed25519-pub = 0xED   (varint bytes 0xED 0x01)
//   p256-pub    = 0x1200 (varint bytes 0x80 0x24)
const MULTICODEC_ED25519_PUB: u16 = 0xed;
const MULTICODEC_P256_PUB: u16 = 0x1200;

pub struct DidKeyResolver;

#[async_trait]
impl DidMethodResolver for DidKeyResolver {
    fn method(&self) -> &'static str {
        "key"
    }

    async fn resolve(&self, did: &str) -> Result<ResolvedDid, String> {
        let mb = did
            .strip_prefix("did:key:")
            .ok_or_else(|| format!("not a did:key: {did}"))?;
        let (codec, raw) = decode_multibase_multicodec(mb)?;
        let (key_hex, key_alg) = match codec {
            MULTICODEC_ED25519_PUB => {
                if raw.len() != 32 {
                    return Err(format!(
                        "did:key Ed25519 expected 32 bytes, got {}",
                        raw.len()
                    ));
                }
                (hex::encode(&raw), KeyAlgorithm::Ed25519)
            }
            MULTICODEC_P256_PUB => {
                if raw.len() != 33 {
                    return Err(format!(
                        "did:key P-256 expected 33 compressed bytes, got {}",
                        raw.len()
                    ));
                }
                let pk = p256::PublicKey::from_sec1_bytes(&raw)
                    .map_err(|e| format!("did:key P-256 decode: {e}"))?;
                let uncompressed = pk.to_encoded_point(false);
                (
                    hex::encode(uncompressed.as_bytes()),
                    KeyAlgorithm::EcdsaP256,
                )
            }
            other => {
                return Err(format!(
                    "did:key multicodec 0x{other:x} not supported (Ed25519=0xed, P-256=0x1200)"
                ));
            }
        };
        let doc = synthesise_did_document(did, &key_hex, key_alg)?;
        let doc_hash_hex = canonical_doc_hash(&doc)?;
        Ok(ResolvedDid {
            did: did.to_string(),
            key_hex,
            key_alg,
            doc_hash_hex,
        })
    }
}

/// Decode `<multibase>` into `(multicodec_varint_u16, raw_bytes)`.
/// Only `z` (base58btc) is implemented — the only encoding used by
/// `did:key` in practice.
fn decode_multibase_multicodec(mb: &str) -> Result<(u16, Vec<u8>), String> {
    let mut chars = mb.chars();
    match chars.next() {
        Some('z') => {}
        Some(c) => return Err(format!("did:key multibase prefix must be 'z', got '{c}'")),
        None => return Err("empty did:key suffix".to_string()),
    }
    let payload = &mb[1..];
    let bytes = bs58::decode(payload)
        .into_vec()
        .map_err(|e| format!("did:key base58btc decode: {e}"))?;
    if bytes.len() < 2 {
        return Err("did:key payload too short for multicodec prefix".to_string());
    }
    let (codec, raw) = parse_multicodec_varint(&bytes)?;
    Ok((codec, raw.to_vec()))
}

/// Multicodec uses unsigned varints. The two codecs we accept fit in
/// 2 bytes (0xed01 = Ed25519, 0x8024 = P-256 in some early profiles,
/// 0x1200 = the v1 codec table value). Read up to 3 bytes of varint.
fn parse_multicodec_varint(bytes: &[u8]) -> Result<(u16, &[u8]), String> {
    let mut value: u32 = 0;
    let mut shift = 0;
    let mut idx = 0;
    loop {
        if idx >= bytes.len() {
            return Err("multicodec varint truncated".to_string());
        }
        let b = bytes[idx];
        idx += 1;
        value |= ((b & 0x7f) as u32) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift > 21 {
            return Err("multicodec varint too long".to_string());
        }
    }
    if value > u16::MAX as u32 {
        return Err(format!("multicodec {value:#x} out of u16 range"));
    }
    Ok((value as u16, &bytes[idx..]))
}

/// Build the DID document for a `did:key` per the method spec
/// (verification method type `JsonWebKey` with the JWK form of the
/// key, plus assertionMethod / authentication referring to `#0`).
fn synthesise_did_document(
    did: &str,
    key_hex: &str,
    alg: KeyAlgorithm,
) -> Result<serde_json::Value, String> {
    let bytes = hex::decode(key_hex).map_err(|e| format!("synthesise_did_document hex: {e}"))?;
    let jwk = match alg {
        KeyAlgorithm::Ed25519 => json!({
            "kty": "OKP",
            "crv": "Ed25519",
            "x": base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(&bytes),
        }),
        KeyAlgorithm::EcdsaP256 => {
            if bytes.len() != 65 || bytes[0] != 0x04 {
                return Err("did:key P-256 must be uncompressed SEC1".to_string());
            }
            json!({
                "kty": "EC",
                "crv": "P-256",
                "x": base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(&bytes[1..33]),
                "y": base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(&bytes[33..65]),
            })
        }
    };
    Ok(json!({
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
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode raw 32-byte Ed25519 public key as `did:key:z<...>`.
    fn encode_ed25519_did_key(raw: &[u8; 32]) -> String {
        let mut bytes = vec![0xed, 0x01];
        bytes.extend_from_slice(raw);
        format!("did:key:z{}", bs58::encode(bytes).into_string())
    }

    #[tokio::test]
    async fn ed25519_round_trip() {
        let raw = [0x11u8; 32];
        let did = encode_ed25519_did_key(&raw);
        let resolved = DidKeyResolver.resolve(&did).await.unwrap();
        assert_eq!(resolved.key_alg, KeyAlgorithm::Ed25519);
        assert_eq!(resolved.key_hex, hex::encode(raw));
        assert_eq!(resolved.did, did);
        assert!(!resolved.doc_hash_hex.is_empty());
    }

    #[tokio::test]
    async fn ed25519_w3c_ccg_vector() {
        // Vector from W3C CCG did-method-key tutorial.
        // Public key: deba23... (32B). The DID below is the canonical
        // base58btc("\xed\x01" || raw) form.
        let raw_hex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let raw: [u8; 32] = hex::decode(raw_hex).unwrap().try_into().unwrap();
        let did = encode_ed25519_did_key(&raw);
        let resolved = DidKeyResolver.resolve(&did).await.unwrap();
        assert_eq!(resolved.key_alg, KeyAlgorithm::Ed25519);
        assert_eq!(resolved.key_hex, raw_hex);
    }

    #[tokio::test]
    async fn rejects_short_payload() {
        // 'z' + valid base58btc but only 1 byte — too short for multicodec.
        let did = format!("did:key:z{}", bs58::encode([0x00u8]).into_string());
        let err = DidKeyResolver.resolve(&did).await.unwrap_err();
        assert!(
            err.contains("too short") || err.contains("varint"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_unknown_multicodec() {
        // 0xff 0xff 0x00 — varint 0x3fff — not Ed25519 (0xed01) nor P-256 (0x1200).
        let payload = vec![0xff, 0xff, 0x00];
        let did = format!("did:key:z{}", bs58::encode(payload).into_string());
        let err = DidKeyResolver.resolve(&did).await.unwrap_err();
        assert!(err.contains("not supported"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_non_base58btc_multibase() {
        // Base16 multibase prefix 'f' — unsupported by this resolver.
        let did = "did:key:fed01abcd";
        let err = DidKeyResolver.resolve(did).await.unwrap_err();
        assert!(err.contains("multibase prefix"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_non_did_key() {
        let err = DidKeyResolver.resolve("did:web:x").await.unwrap_err();
        assert!(err.contains("not a did:key"));
    }
}
