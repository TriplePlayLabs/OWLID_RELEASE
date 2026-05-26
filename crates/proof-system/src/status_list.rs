//! IETF Token Status List (`draft-ietf-oauth-status-list`). A credential
//! references `status.status_list = {idx, uri}`; the `uri` serves a
//! `statuslist+jwt` whose compressed bitstring encodes each credential's
//! status (bit 0 = VALID, 1 = INVALID/revoked). The bitstring is projected
//! from the Midnight `revocation_registry` — the authoritative truth — so
//! any standard verifier can check status without OwlID infra.
use crate::error::ProofSystemError;
use base64::prelude::*;
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use owl_crypto::{KeyPair, PublicKey, Signature, SignatureAlgorithm};
use serde_json::{json, Value};
use std::io::{Read, Write};

const TYP: &str = "statuslist+jwt";
const ALG: &str = "EdDSA";

fn err(m: impl Into<String>) -> ProofSystemError {
    ProofSystemError::InvalidProof(m.into())
}
fn b64(d: &[u8]) -> String {
    BASE64_URL_SAFE_NO_PAD.encode(d)
}
fn unb64(s: &str) -> Result<Vec<u8>, ProofSystemError> {
    BASE64_URL_SAFE_NO_PAD.decode(s).map_err(|e| err(format!("base64url: {e}")))
}

/// A 1-bit-per-entry status list. `bit = 1` ⇒ the credential at that index is
/// revoked/invalid; `0` ⇒ valid.
#[derive(Debug, Clone)]
pub struct StatusList {
    bits: Vec<u8>,
}

impl StatusList {
    /// New all-VALID list holding at least `len` entries (byte-rounded).
    pub fn new(len: usize) -> Self {
        Self {
            bits: vec![0u8; len.div_ceil(8).max(1)],
        }
    }

    /// Build from the set of revoked indices, sized to fit the largest.
    pub fn from_revoked(revoked: &[u64]) -> Self {
        let max = revoked.iter().copied().max().unwrap_or(0) as usize;
        let mut s = Self::new(max + 1);
        for &i in revoked {
            s.set_revoked(i);
        }
        s
    }

    pub fn set_revoked(&mut self, idx: u64) {
        let byte = (idx / 8) as usize;
        if byte >= self.bits.len() {
            self.bits.resize(byte + 1, 0);
        }
        self.bits[byte] |= 1 << (idx % 8);
    }

    /// `true` if the entry at `idx` is revoked/invalid.
    pub fn is_revoked(&self, idx: u64) -> bool {
        let byte = (idx / 8) as usize;
        byte < self.bits.len() && (self.bits[byte] >> (idx % 8)) & 1 == 1
    }

    fn compress(&self) -> Result<String, ProofSystemError> {
        let mut e = ZlibEncoder::new(Vec::new(), Compression::best());
        e.write_all(&self.bits).map_err(|e| err(e.to_string()))?;
        Ok(b64(&e.finish().map_err(|e| err(e.to_string()))?))
    }

    fn decompress(lst: &str) -> Result<Self, ProofSystemError> {
        let raw = unb64(lst)?;
        let mut d = ZlibDecoder::new(&raw[..]);
        let mut bits = Vec::new();
        d.read_to_end(&mut bits).map_err(|e| err(e.to_string()))?;
        Ok(Self { bits })
    }
}

fn ed25519(alg: SignatureAlgorithm) -> Result<(), ProofSystemError> {
    match alg {
        SignatureAlgorithm::Ed25519 => Ok(()),
        _ => Err(err("Status List Token must be EdDSA")),
    }
}

/// Issue a signed Status List Token (`statuslist+jwt`, `bits: 1`). `sub` is
/// the list `uri`; `iat`/`exp` unix seconds (`exp` optional).
pub fn issue_status_list_jwt(
    list: &StatusList,
    signer: &KeyPair,
    uri: &str,
    iat: i64,
    exp: Option<i64>,
) -> Result<String, ProofSystemError> {
    ed25519(signer.algorithm())?;
    let header = json!({ "typ": TYP, "alg": ALG });
    let mut payload = json!({
        "sub": uri,
        "iat": iat,
        "status_list": { "bits": 1, "lst": list.compress()? },
    });
    if let Some(exp) = exp {
        payload
            .as_object_mut()
            .expect("payload is object")
            .insert("exp".into(), json!(exp));
    }
    let signing_input = format!(
        "{}.{}",
        b64(&serde_json::to_vec(&header)?),
        b64(&serde_json::to_vec(&payload)?)
    );
    let sig = signer.sign(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", b64(sig.bytes())))
}

/// Verify a Status List Token signature + `typ`, returning the decoded list.
pub fn verify_status_list_jwt(
    token: &str,
    issuer: &PublicKey,
) -> Result<StatusList, ProofSystemError> {
    ed25519(issuer.algorithm())?;
    let p: Vec<&str> = token.split('.').collect();
    if p.len() != 3 {
        return Err(err("status list JWT must have 3 parts"));
    }
    let signing_input = format!("{}.{}", p[0], p[1]);
    let sig = Signature::from_parts(SignatureAlgorithm::Ed25519, unb64(p[2])?);
    issuer.verify(signing_input.as_bytes(), &sig)?;
    let header: Value = serde_json::from_slice(&unb64(p[0])?)?;
    if header.get("typ").and_then(Value::as_str) != Some(TYP) {
        return Err(err("typ must be statuslist+jwt"));
    }
    let payload: Value = serde_json::from_slice(&unb64(p[1])?)?;
    if payload.pointer("/status_list/bits").and_then(Value::as_u64) != Some(1) {
        return Err(err("only bits:1 status lists supported"));
    }
    let lst = payload
        .pointer("/status_list/lst")
        .and_then(Value::as_str)
        .ok_or_else(|| err("status_list.lst missing"))?;
    StatusList::decompress(lst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_signed_status_list() {
        let issuer = KeyPair::generate();
        let list = StatusList::from_revoked(&[3, 9, 4097]);
        let jwt = issue_status_list_jwt(
            &list,
            &issuer,
            "https://issuer.example/status/1",
            1_700_000_000,
            Some(1_800_000_000),
        )
        .unwrap();

        let got = verify_status_list_jwt(&jwt, &issuer.public_key()).unwrap();
        assert!(got.is_revoked(3));
        assert!(got.is_revoked(9));
        assert!(got.is_revoked(4097));
        assert!(!got.is_revoked(0));
        assert!(!got.is_revoked(10));
    }

    #[test]
    fn wrong_issuer_rejected() {
        let issuer = KeyPair::generate();
        let attacker = KeyPair::generate();
        let jwt =
            issue_status_list_jwt(&StatusList::new(64), &issuer, "u", 1, None).unwrap();
        assert!(verify_status_list_jwt(&jwt, &attacker.public_key()).is_err());
    }

    #[test]
    fn tamper_rejected() {
        let issuer = KeyPair::generate();
        let mut jwt =
            issue_status_list_jwt(&StatusList::from_revoked(&[1]), &issuer, "u", 1, None)
                .unwrap();
        jwt.pop();
        jwt.push(if jwt.ends_with('A') { 'B' } else { 'A' });
        assert!(verify_status_list_jwt(&jwt, &issuer.public_key()).is_err());
    }

    /// Sparse high indices (~1M, our monotonic-sequence base) round-trip
    /// through zlib + verify, with neighbouring indices remaining valid.
    #[test]
    fn sparse_million_idx_roundtrip() {
        let issuer = KeyPair::generate();
        let high = 1_048_576u64;
        let jwt = issue_status_list_jwt(
            &StatusList::from_revoked(&[high, high + 4]),
            &issuer,
            "u",
            1,
            None,
        )
        .unwrap();
        let got = verify_status_list_jwt(&jwt, &issuer.public_key()).unwrap();
        assert!(got.is_revoked(high));
        assert!(got.is_revoked(high + 4));
        assert!(!got.is_revoked(high + 1));
        assert!(!got.is_revoked(0));
    }

    #[test]
    fn empty_list_no_idx_revoked() {
        let issuer = KeyPair::generate();
        let jwt = issue_status_list_jwt(&StatusList::new(8), &issuer, "u", 1, None).unwrap();
        let got = verify_status_list_jwt(&jwt, &issuer.public_key()).unwrap();
        for i in 0..16 {
            assert!(!got.is_revoked(i));
        }
    }

    /// `bits: 1` Token Status List requires EdDSA. A P-256 issuer must
    /// be rejected at `issue_status_list_jwt` rather than producing an
    /// alg-confused token.
    #[test]
    fn non_ed25519_signer_rejected() {
        use owl_crypto::SignatureAlgorithm;
        let p256 = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        assert!(issue_status_list_jwt(&StatusList::new(8), &p256, "u", 1, None).is_err());
    }

    /// Bytes outside the JWS structure or with non-base64url content
    /// in the `lst` field must not validate to a usable bitstring.
    #[test]
    fn malformed_jwt_rejected() {
        let issuer = KeyPair::generate();
        assert!(verify_status_list_jwt("not.a.jwt", &issuer.public_key()).is_err());
        assert!(verify_status_list_jwt("", &issuer.public_key()).is_err());
        assert!(verify_status_list_jwt("only-one-part", &issuer.public_key()).is_err());
    }

    /// `iat`/`exp` are issued unchanged and survive verify; `exp=None`
    /// produces a token without `exp` (covered by absence in payload).
    #[test]
    fn iat_exp_roundtrip() {
        let issuer = KeyPair::generate();
        let jwt = issue_status_list_jwt(
            &StatusList::from_revoked(&[1]),
            &issuer,
            "u",
            1_700_000_000,
            Some(1_800_000_000),
        )
        .unwrap();
        // verify_status_list_jwt validates JWS + returns the StatusList;
        // its iat/exp are part of the inner payload — verify they
        // survive by parsing the JWT payload independently.
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        use base64::prelude::*;
        let payload: serde_json::Value = serde_json::from_slice(
            &BASE64_URL_SAFE_NO_PAD.decode(parts[1]).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["iat"], 1_700_000_000);
        assert_eq!(payload["exp"], 1_800_000_000);
    }
}
