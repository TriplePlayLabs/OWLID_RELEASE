//! SD-JWT VC (`application/dc+sd-jwt`) — RFC 9901 selective disclosure +
//! draft-ietf-oauth-sd-jwt-vc-16, EdDSA (Ed25519) issuer/holder keys.
//!
//! Standard, self-contained: maps a flat claim set to an issuer-signed JWT
//! with `_sd` digests + per-Disclosure salts, and a Key Binding JWT. The
//! OwlID-specific bridge (Merkle document → claims, `ownerKey` → `cnf`,
//! `issuerKey` → `iss` DID) lives in the issuer-service, not here.

use crate::error::ProofSystemError;
use base64::prelude::*;
use owl_crypto::{KeyPair, PublicKey, Signature, SignatureAlgorithm, generate_salt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MEDIA_TYPE: &str = "application/dc+sd-jwt";
const JWT_TYP: &str = "dc+sd-jwt";
const JWT_TYP_LEGACY: &str = "vc+sd-jwt";
const KB_TYP: &str = "kb+jwt";
const SD_ALG: &str = "sha-256";
const ALG: &str = "EdDSA";
const ES256: &str = "ES256";

fn err(msg: impl Into<String>) -> ProofSystemError {
    ProofSystemError::InvalidProof(msg.into())
}

fn b64(data: &[u8]) -> String {
    BASE64_URL_SAFE_NO_PAD.encode(data)
}

fn unb64(s: &str) -> Result<Vec<u8>, ProofSystemError> {
    BASE64_URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| err(format!("base64url: {e}")))
}

/// IETF Token Status List reference (`status.status_list`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusRef {
    pub idx: u64,
    pub uri: String,
}

fn ed25519_only(alg: SignatureAlgorithm, what: &str) -> Result<(), ProofSystemError> {
    match alg {
        SignatureAlgorithm::Ed25519 => Ok(()),
        _ => Err(err(format!("{what} must be Ed25519 (alg EdDSA)"))),
    }
}

/// `cnf` JWK for the holder key. Ed25519 → OKP (EdDSA), P-256 → EC
/// (ES256). Issuer JWS signing stays EdDSA-only (`jws_sign`); the holder
/// KB-JWT is verified for either alg (`jws_verify_with`), so a standard
/// ES256 (e.g. non-extractable WebCrypto P-256) holder key interoperates.
fn public_key_jwk(pk: &PublicKey) -> Result<Value, ProofSystemError> {
    match pk.algorithm() {
        SignatureAlgorithm::Ed25519 => {
            Ok(json!({ "kty": "OKP", "crv": "Ed25519", "x": b64(&pk.to_bytes()) }))
        }
        SignatureAlgorithm::EcdsaP256 => {
            // to_bytes() = SEC1 uncompressed: 0x04 ‖ X(32) ‖ Y(32).
            let p = pk.to_bytes();
            if p.len() != 65 || p[0] != 0x04 {
                return Err(err("P-256 key not SEC1 uncompressed"));
            }
            Ok(json!({
                "kty": "EC", "crv": "P-256",
                "x": b64(&p[1..33]), "y": b64(&p[33..65]),
            }))
        }
    }
}

fn jwk_to_pubkey(jwk: &Value) -> Result<PublicKey, ProofSystemError> {
    match (
        jwk.get("kty").and_then(Value::as_str),
        jwk.get("crv").and_then(Value::as_str),
    ) {
        (Some("OKP"), Some("Ed25519")) => {
            let x = jwk
                .get("x")
                .and_then(Value::as_str)
                .ok_or_else(|| err("cnf jwk missing x"))?;
            PublicKey::from_bytes(&unb64(x)?).map_err(Into::into)
        }
        (Some("EC"), Some("P-256")) => {
            let x = jwk
                .get("x")
                .and_then(Value::as_str)
                .ok_or_else(|| err("cnf jwk missing x"))?;
            let y = jwk
                .get("y")
                .and_then(Value::as_str)
                .ok_or_else(|| err("cnf jwk missing y"))?;
            let mut sec1 = vec![0x04u8];
            sec1.extend_from_slice(&unb64(x)?);
            sec1.extend_from_slice(&unb64(y)?);
            PublicKey::from_bytes_with_algorithm(&sec1, SignatureAlgorithm::EcdsaP256)
                .map_err(Into::into)
        }
        _ => Err(err("cnf jwk must be OKP/Ed25519 or EC/P-256")),
    }
}

fn jws_sign(header: &Value, payload: &Value, kp: &KeyPair) -> Result<String, ProofSystemError> {
    ed25519_only(kp.algorithm(), "issuer/holder key")?;
    let signing_input = format!(
        "{}.{}",
        b64(&serde_json::to_vec(header)?),
        b64(&serde_json::to_vec(payload)?)
    );
    let sig = kp.sign(signing_input.as_bytes());
    Ok(format!("{signing_input}.{}", b64(sig.bytes())))
}

/// JOSE `alg` for a key type. The issuer is always EdDSA (Ed25519); a
/// holder `cnf` key may be Ed25519 (EdDSA) or P-256 (ES256) — a
/// non-extractable WebCrypto P-256 key produces a spec-conformant
/// ES256 KB-JWT (raw R‖S, 64 bytes — exactly what owl_crypto verifies).
fn jose_alg(alg: SignatureAlgorithm) -> &'static str {
    match alg {
        SignatureAlgorithm::Ed25519 => ALG,
        SignatureAlgorithm::EcdsaP256 => ES256,
    }
}

fn jws_verify(token: &str, pk: &PublicKey) -> Result<(Value, Value), ProofSystemError> {
    ed25519_only(pk.algorithm(), "verification key")?;
    jws_verify_with(token, pk)
}

/// Verify a JWS with `pk`, dispatching on the key's algorithm and
/// requiring the protected-header `alg` to match (EdDSA↔Ed25519,
/// ES256↔P-256). Used for the holder KB-JWT so a standard ES256 holder
/// key interoperates; the issuer JWS stays EdDSA-only via [`jws_verify`].
fn jws_verify_with(token: &str, pk: &PublicKey) -> Result<(Value, Value), ProofSystemError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(err("JWS must have 3 parts"));
    }
    let header: Value = serde_json::from_slice(&unb64(parts[0])?)?;
    let want_alg = jose_alg(pk.algorithm());
    if header.get("alg").and_then(Value::as_str) != Some(want_alg) {
        return Err(err(format!("JWS alg must be {want_alg} for this key")));
    }
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let sig = Signature::from_parts(pk.algorithm(), unb64(parts[2])?);
    pk.verify(signing_input.as_bytes(), &sig)?;
    let payload: Value = serde_json::from_slice(&unb64(parts[1])?)?;
    Ok((header, payload))
}

fn encode_disclosure(salt: &str, name: &str, value: &Value) -> String {
    let arr = Value::Array(vec![
        Value::String(salt.to_string()),
        Value::String(name.to_string()),
        value.clone(),
    ]);
    b64(serde_json::to_string(&arr)
        .expect("array serializes")
        .as_bytes())
}

/// `base64url(sha-256(ASCII(disclosure)))` — digest is over the encoded string.
fn digest(disclosure_b64: &str) -> String {
    b64(&Sha256::digest(disclosure_b64.as_bytes()))
}

pub struct IssueParams<'a> {
    pub issuer: &'a KeyPair,
    pub iss: String,
    pub vct: String,
    pub holder: &'a PublicKey,
    pub iat: Option<i64>,
    pub exp: Option<i64>,
    pub status: Option<StatusRef>,
}

/// Parsed SD-JWT VC: the issuer JWT plus the available Disclosures.
#[derive(Debug, Clone)]
pub struct SdJwtVc {
    jwt: String,
    /// `(claim name, disclosure b64)`, claim order independent of `_sd` order.
    disclosures: Vec<(String, String)>,
}

pub struct KbParams<'a> {
    pub holder: &'a KeyPair,
    pub aud: String,
    pub nonce: String,
    pub iat: i64,
}

#[derive(Debug, Clone)]
pub struct Verified {
    pub iss: String,
    pub vct: String,
    pub claims: BTreeMap<String, Value>,
    pub cnf_jwk: Value,
    pub status: Option<StatusRef>,
    pub key_bound: bool,
    /// Issuer-signed `owl_root` (hex) — the predicate-binding commitment.
    pub owl_root: Option<String>,
}

#[derive(Debug, Default)]
pub struct VerifyParams {
    pub require_kb: bool,
    pub aud: Option<String>,
    pub nonce: Option<String>,
}

impl SdJwtVc {
    /// Issue a credential: every entry of `claims` becomes a selectively
    /// disclosable Disclosure (fresh per-claim salt); the issuer JWS commits
    /// to the digest set.
    pub fn issue(
        claims: &BTreeMap<String, Value>,
        p: &IssueParams,
    ) -> Result<Self, ProofSystemError> {
        // Build each disclosure from an explicit salt so the same salt feeds
        // both the SD-JWT digest and the `owl_root` claim commitment.
        let entries: Vec<(String, String, Value)> = claims
            .iter()
            .map(|(k, v)| (k.clone(), generate_salt(), v.clone()))
            .collect();
        let disclosures: Vec<(String, String)> = entries
            .iter()
            .map(|(name, salt, value)| (name.clone(), encode_disclosure(salt, name, value)))
            .collect();

        // _sd order MUST NOT depend on claim order (RFC 9901 §4.2.4.1).
        let mut sd: Vec<String> = disclosures.iter().map(|(_, d)| digest(d)).collect();
        sd.sort();

        // owl_root binds predicate witnesses to this issuer-signed credential.
        // Hex, like `root_hash`/cred id.
        let owl_root = crate::attestation::owl_root_for_claims(&entries);

        let mut payload = json!({
            "iss": p.iss,
            "vct": p.vct,
            "cnf": { "jwk": public_key_jwk(p.holder)? },
            "_sd": sd,
            "_sd_alg": SD_ALG,
            "owl_root": hex::encode(owl_root),
        });
        let obj = payload.as_object_mut().expect("payload is object");
        if let Some(iat) = p.iat {
            obj.insert("iat".into(), json!(iat));
        }
        if let Some(exp) = p.exp {
            obj.insert("exp".into(), json!(exp));
        }
        if let Some(s) = &p.status {
            obj.insert(
                "status".into(),
                json!({ "status_list": { "idx": s.idx, "uri": s.uri } }),
            );
        }

        let header = json!({ "typ": JWT_TYP, "alg": ALG });
        let jwt = jws_sign(&header, &payload, p.issuer)?;
        Ok(Self { jwt, disclosures })
    }

    /// Issuance form: `JWT~D1~…~Dn~` (all Disclosures, no Key Binding).
    pub fn serialize(&self) -> String {
        let mut s = self.jwt.clone();
        s.push('~');
        for (_, d) in &self.disclosures {
            s.push_str(d);
            s.push('~');
        }
        s
    }

    /// Parse an SD-JWT (issuance or presentation form). Returns the handle and
    /// the Key Binding JWT if one was appended.
    pub fn parse(s: &str) -> Result<(Self, Option<String>), ProofSystemError> {
        let parts: Vec<&str> = s.split('~').collect();
        if parts.len() < 2 {
            return Err(err("not an SD-JWT (no ~)"));
        }
        let jwt = parts[0].to_string();
        let last = parts[parts.len() - 1];
        // Issuance form ends with `~` (last element empty); presentation form
        // ends with the KB-JWT (last element non-empty).
        let kb = if last.is_empty() {
            None
        } else {
            Some(last.to_string())
        };
        let mut disclosures = Vec::new();
        for d in &parts[1..parts.len() - 1] {
            if d.is_empty() {
                continue;
            }
            let arr: Value = serde_json::from_slice(&unb64(d)?)?;
            let name = arr
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| err("disclosure missing claim name"))?;
            disclosures.push((name.to_string(), (*d).to_string()));
        }
        Ok((Self { jwt, disclosures }, kb))
    }

    /// Re-emit disclosing only `disclose`, optionally appending a KB-JWT
    /// bound (via `sd_hash`) to exactly the presented Disclosures.
    pub fn present(
        &self,
        disclose: &[&str],
        kb: Option<KbParams>,
    ) -> Result<String, ProofSystemError> {
        let mut s = self.jwt.clone();
        s.push('~');
        for name in disclose {
            let (_, d) = self
                .disclosures
                .iter()
                .find(|(n, _)| n == name)
                .ok_or_else(|| err(format!("no disclosure for '{name}'")))?;
            s.push_str(d);
            s.push('~');
        }
        let Some(kb) = kb else { return Ok(s) };

        let sd_hash = b64(&Sha256::digest(s.as_bytes()));
        let header = json!({ "typ": KB_TYP, "alg": ALG });
        let payload = json!({
            "iat": kb.iat,
            "aud": kb.aud,
            "nonce": kb.nonce,
            "sd_hash": sd_hash,
        });
        s.push_str(&jws_sign(&header, &payload, kb.holder)?);
        Ok(s)
    }
}

/// Stable credential identifier = `base64url(sha-256(issuer JWT))`. Same
/// value for the issuance form and any presentation of it (KB-JWT and the
/// disclosure subset do not change the issuer JWT). Used as the revocation /
/// status / on-chain anchor handle.
pub fn credential_id(sd_jwt: &str) -> String {
    let jwt = sd_jwt.split('~').next().unwrap_or(sd_jwt);
    b64(&Sha256::digest(jwt.as_bytes()))
}

/// The credential id as a 32-byte hex string — the on-chain `Bytes<32>`
/// handle the Midnight registries expect. [`credential_id`] is
/// `base64url(sha-256(...))`; the Compact contracts take the raw 32-byte
/// digest, conventionally passed as hex. Accepts an already-hex 32-byte
/// id unchanged (idempotent at the sidecar boundary).
pub fn credential_id_hex(cid: &str) -> Result<String, ProofSystemError> {
    if cid.len() == 64 && cid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(cid.to_ascii_lowercase());
    }
    let bytes = unb64(cid)?;
    if bytes.len() != 32 {
        return Err(err(format!(
            "credential id must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    Ok(hex::encode(bytes))
}

/// Read the issuer-signed `owl_root` (hex) from the SD-JWT WITHOUT re-verifying.
/// The caller has already verified the presentation; this just extracts the
/// predicate-binding anchor for the attestation-key lookup. `None` for a
/// credential issued before owl_root.
pub fn owl_root_hex(sd_jwt: &str) -> Option<String> {
    let jwt = sd_jwt.split('~').next()?;
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload: Value = serde_json::from_slice(&unb64(parts[1]).ok()?).ok()?;
    payload
        .get("owl_root")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Read `iss` from the issuer JWT WITHOUT verifying the signature. A verifier
/// must read `iss` to resolve which issuer key / trust anchor to verify with;
/// the signature is then checked by [`verify`] using that key.
pub fn peek_iss(sd_jwt: &str) -> Result<String, ProofSystemError> {
    let jwt = sd_jwt
        .split('~')
        .next()
        .ok_or_else(|| err("empty SD-JWT"))?;
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 {
        return Err(err("issuer JWT must have 3 parts"));
    }
    let payload: Value = serde_json::from_slice(&unb64(parts[1])?)?;
    payload
        .get("iss")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| err("iss missing"))
}

/// Verify an SD-JWT VC presentation: issuer JWS, every Disclosure's digest is
/// in `_sd`, and (if present/required) the KB-JWT signature + `aud`/`nonce` +
/// `sd_hash` over exactly the presented Disclosures.
pub fn verify(
    presentation: &str,
    issuer: &PublicKey,
    vp: &VerifyParams,
) -> Result<Verified, ProofSystemError> {
    let (sd, kb) = SdJwtVc::parse(presentation)?;

    let (header, payload) = jws_verify(&sd.jwt, issuer)?;
    match header.get("typ").and_then(Value::as_str) {
        Some(JWT_TYP) | Some(JWT_TYP_LEGACY) => {}
        _ => return Err(err("issuer JWT typ must be dc+sd-jwt")),
    }
    if payload.get("_sd_alg").and_then(Value::as_str) != Some(SD_ALG) {
        return Err(err("_sd_alg must be sha-256"));
    }
    let sd_set: std::collections::HashSet<&str> = payload
        .get("_sd")
        .and_then(Value::as_array)
        .ok_or_else(|| err("_sd missing"))?
        .iter()
        .filter_map(Value::as_str)
        .collect();

    let mut claims = BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    for (_, d) in &sd.disclosures {
        let dig = digest(d);
        if !sd_set.contains(dig.as_str()) {
            return Err(err("disclosure digest not in _sd"));
        }
        if !seen.insert(dig) {
            return Err(err("duplicate disclosure"));
        }
        let arr: Value = serde_json::from_slice(&unb64(d)?)?;
        let name = arr
            .get(1)
            .and_then(Value::as_str)
            .ok_or_else(|| err("disclosure missing name"))?;
        let value = arr
            .get(2)
            .cloned()
            .ok_or_else(|| err("disclosure missing value"))?;
        claims.insert(name.to_string(), value);
    }

    let iss = payload
        .get("iss")
        .and_then(Value::as_str)
        .ok_or_else(|| err("iss missing"))?
        .to_string();
    let vct = payload
        .get("vct")
        .and_then(Value::as_str)
        .ok_or_else(|| err("vct missing"))?
        .to_string();
    let cnf_jwk = payload
        .pointer("/cnf/jwk")
        .cloned()
        .ok_or_else(|| err("cnf.jwk missing"))?;
    let status = payload.pointer("/status/status_list").and_then(|s| {
        Some(StatusRef {
            idx: s.get("idx")?.as_u64()?,
            uri: s.get("uri")?.as_str()?.to_string(),
        })
    });

    let mut key_bound = false;
    if let Some(kb) = kb {
        let holder = jwk_to_pubkey(&cnf_jwk)?;
        let (kbh, kbp) = jws_verify_with(&kb, &holder)?;
        if kbh.get("typ").and_then(Value::as_str) != Some(KB_TYP) {
            return Err(err("KB-JWT typ must be kb+jwt"));
        }
        if let Some(want) = &vp.aud {
            if kbp.get("aud").and_then(Value::as_str) != Some(want.as_str()) {
                return Err(err("KB-JWT aud mismatch"));
            }
        }
        if let Some(want) = &vp.nonce {
            if kbp.get("nonce").and_then(Value::as_str) != Some(want.as_str()) {
                return Err(err("KB-JWT nonce mismatch"));
            }
        }
        // sd_hash binds the holder signature to exactly the presented prefix
        // (`JWT~D…~`), i.e. everything before the appended KB-JWT.
        let prefix = &presentation[..presentation.len() - kb.len()];
        let want_hash = b64(&Sha256::digest(prefix.as_bytes()));
        if kbp.get("sd_hash").and_then(Value::as_str) != Some(want_hash.as_str()) {
            return Err(err("KB-JWT sd_hash mismatch"));
        }
        key_bound = true;
    } else if vp.require_kb {
        return Err(err("Key Binding required but absent"));
    }

    let owl_root = payload
        .get("owl_root")
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(Verified {
        iss,
        vct,
        claims,
        cnf_jwk,
        status,
        key_bound,
        owl_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn issue_embeds_owl_root_for_predicate_claims() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut claims = BTreeMap::new();
        claims.insert("kycLevel".into(), json!(3));
        claims.insert("dateOfBirth".into(), json!("2006-06-24"));
        claims.insert("given_name".into(), json!("Ada")); // non-predicate, not bound
        let vc = SdJwtVc::issue(
            &claims,
            &IssueParams {
                issuer: &issuer,
                iss: "did:web:issuer.owlid.example".into(),
                vct: "https://owlid.example/credentials/identity".into(),
                holder: &holder.public_key(),
                iat: None,
                exp: None,
                status: None,
            },
        )
        .unwrap();
        let v = verify(&vc.serialize(), &issuer.public_key(), &VerifyParams::default()).unwrap();
        let root = v.owl_root.expect("owl_root present");
        assert_eq!(hex::decode(&root).unwrap().len(), 32, "owl_root is 32 bytes");
        // bound to predicate claims, not the all-zero tree
        assert_ne!(root, hex::encode([0u8; 32]));
    }

    fn sample() -> (KeyPair, KeyPair, SdJwtVc) {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut claims = BTreeMap::new();
        claims.insert("given_name".into(), json!("Ada"));
        claims.insert("family_name".into(), json!("Lovelace"));
        claims.insert("birthdate".into(), json!("1815-12-10"));
        let vc = SdJwtVc::issue(
            &claims,
            &IssueParams {
                issuer: &issuer,
                iss: "did:web:issuer.owlid.example".into(),
                vct: "https://owlid.example/credentials/identity".into(),
                holder: &holder.public_key(),
                iat: Some(1_700_000_000),
                exp: Some(1_800_000_000),
                status: Some(StatusRef {
                    idx: 42,
                    uri: "https://issuer.owlid.example/status/1".into(),
                }),
            },
        )
        .unwrap();
        (issuer, holder, vc)
    }

    #[test]
    fn issuance_roundtrip_no_kb() {
        let (issuer, _h, vc) = sample();
        let v = verify(
            &vc.serialize(),
            &issuer.public_key(),
            &VerifyParams::default(),
        )
        .unwrap();
        assert_eq!(v.iss, "did:web:issuer.owlid.example");
        assert_eq!(v.claims["given_name"], json!("Ada"));
        assert_eq!(v.status.unwrap().idx, 42);
        assert!(!v.key_bound);
    }

    #[test]
    fn selective_disclosure_with_kb() {
        let (issuer, holder, vc) = sample();
        let (parsed, _) = SdJwtVc::parse(&vc.serialize()).unwrap();
        let pres = parsed
            .present(
                &["given_name"],
                Some(KbParams {
                    holder: &holder,
                    aud: "https://verifier.example".into(),
                    nonce: "n-123".into(),
                    iat: 1_700_000_100,
                }),
            )
            .unwrap();
        let v = verify(
            &pres,
            &issuer.public_key(),
            &VerifyParams {
                require_kb: true,
                aud: Some("https://verifier.example".into()),
                nonce: Some("n-123".into()),
            },
        )
        .unwrap();
        assert_eq!(v.claims.len(), 1);
        assert_eq!(v.claims["given_name"], json!("Ada"));
        assert!(!v.claims.contains_key("family_name"));
        assert!(v.key_bound);
    }

    #[test]
    fn tampered_disclosure_rejected() {
        let (issuer, _h, vc) = sample();
        let mut s = vc.serialize();
        // Flip a char inside the first disclosure.
        let i = s.find('~').unwrap() + 1;
        let b = unsafe { s.as_bytes_mut() };
        b[i] = if b[i] == b'A' { b'B' } else { b'A' };
        assert!(verify(&s, &issuer.public_key(), &VerifyParams::default()).is_err());
    }

    #[test]
    fn wrong_issuer_rejected() {
        let (_issuer, _h, vc) = sample();
        let attacker = KeyPair::generate();
        assert!(
            verify(
                &vc.serialize(),
                &attacker.public_key(),
                &VerifyParams::default()
            )
            .is_err()
        );
    }

    #[test]
    fn kb_required_but_absent_rejected() {
        let (issuer, _h, vc) = sample();
        let r = verify(
            &vc.serialize(),
            &issuer.public_key(),
            &VerifyParams {
                require_kb: true,
                ..Default::default()
            },
        );
        assert!(r.is_err());
    }

    #[test]
    fn credential_id_stable_and_iss_peekable() {
        let (_i, holder, vc) = sample();
        let issued = vc.serialize();
        let pres = vc.present(&["given_name"], None).unwrap();
        // Same issuer JWT ⇒ same id across issuance and any presentation.
        assert_eq!(credential_id(&issued), credential_id(&pres));
        assert_eq!(peek_iss(&issued).unwrap(), "did:web:issuer.owlid.example");
        // peek does not require the issuer key (no signature check).
        let _ = holder;
    }

    #[test]
    fn p256_holder_cnf_roundtrip() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let mut claims = BTreeMap::new();
        claims.insert("age_over_18".into(), json!(true));
        let vc = SdJwtVc::issue(
            &claims,
            &IssueParams {
                issuer: &issuer,
                iss: "urn:owlid:issuer:test".into(),
                vct: "https://owlid.dev/credentials/identity".into(),
                holder: &holder.public_key(),
                iat: None,
                exp: None,
                status: None,
            },
        )
        .unwrap();
        let v = verify(
            &vc.serialize(),
            &issuer.public_key(),
            &VerifyParams::default(),
        )
        .unwrap();
        assert_eq!(v.cnf_jwk["kty"], json!("EC"));
        assert_eq!(v.cnf_jwk["crv"], json!("P-256"));
        // cnf jwk must round-trip back to the holder's P-256 key.
        assert_eq!(jwk_to_pubkey(&v.cnf_jwk).unwrap(), holder.public_key());
        assert_eq!(v.claims["age_over_18"], json!(true));
    }

    #[test]
    fn kb_nonce_mismatch_rejected() {
        let (issuer, holder, vc) = sample();
        let pres = vc
            .present(
                &["given_name"],
                Some(KbParams {
                    holder: &holder,
                    aud: "a".into(),
                    nonce: "real".into(),
                    iat: 1,
                }),
            )
            .unwrap();
        let r = verify(
            &pres,
            &issuer.public_key(),
            &VerifyParams {
                require_kb: true,
                nonce: Some("expected".into()),
                ..Default::default()
            },
        );
        assert!(r.is_err());
    }

    /// A standard ES256 KB-JWT (what a non-extractable WebCrypto P-256
    /// holder key produces) must verify. `present()` signs EdDSA-only
    /// (the wallet path), so build the ES256 KB-JWT here as a browser
    /// holder would: raw R‖S over `header.payload`, `alg: ES256`.
    fn p256_kb_presentation(
        issuer: &KeyPair,
        holder: &KeyPair,
        alg: &str,
        nonce: &str,
        aud: &str,
    ) -> String {
        let mut claims = BTreeMap::new();
        claims.insert("given_name".into(), json!("Jan"));
        let vc = SdJwtVc::issue(
            &claims,
            &IssueParams {
                issuer,
                iss: "did:web:issuer.owlid.example".into(),
                vct: "https://owlid.dev/credentials/identity".into(),
                holder: &holder.public_key(),
                iat: None,
                exp: None,
                status: None,
            },
        )
        .unwrap();
        let prefix = vc.present(&["given_name"], None).unwrap();
        let sd_hash = b64(&Sha256::digest(prefix.as_bytes()));
        let h = b64(&serde_json::to_vec(&json!({ "typ": KB_TYP, "alg": alg })).unwrap());
        let p = b64(&serde_json::to_vec(
            &json!({ "iat": 1, "aud": aud, "nonce": nonce, "sd_hash": sd_hash }),
        )
        .unwrap());
        let signing_input = format!("{h}.{p}");
        let sig = holder.sign(signing_input.as_bytes());
        format!("{prefix}{signing_input}.{}", b64(sig.bytes()))
    }

    #[test]
    fn es256_kb_jwt_from_p256_holder_verifies() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let pres = p256_kb_presentation(&issuer, &holder, ES256, "n0nce", "verifier");
        let v = verify(
            &pres,
            &issuer.public_key(),
            &VerifyParams {
                require_kb: true,
                aud: Some("verifier".into()),
                nonce: Some("n0nce".into()),
            },
        )
        .unwrap();
        assert!(v.key_bound);
        assert_eq!(v.claims["given_name"], json!("Jan"));
        assert_eq!(v.cnf_jwk["crv"], json!("P-256"));
    }

    #[test]
    fn p256_holder_kb_jwt_with_wrong_alg_is_rejected() {
        // P-256 holder but the KB-JWT header lies `alg: EdDSA`.
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let pres = p256_kb_presentation(&issuer, &holder, ALG, "n0nce", "verifier");
        assert!(
            verify(
                &pres,
                &issuer.public_key(),
                &VerifyParams {
                    require_kb: true,
                    aud: Some("verifier".into()),
                    nonce: Some("n0nce".into()),
                },
            )
            .is_err()
        );
    }

    // -------- credential_id_hex --------

    #[test]
    fn credential_id_hex_accepts_64char_hex_idempotent() {
        let hex = "a".repeat(64);
        assert_eq!(credential_id_hex(&hex).unwrap(), hex);
    }

    #[test]
    fn credential_id_hex_uppercase_hex_normalized_to_lower() {
        let hex_u = "ABCDEF1234567890".repeat(4); // 64 hex chars
        assert_eq!(hex_u.len(), 64);
        let out = credential_id_hex(&hex_u).unwrap();
        assert_eq!(out, hex_u.to_lowercase());
    }

    #[test]
    fn credential_id_hex_from_base64url_no_pad_roundtrips() {
        let bytes: [u8; 32] = [7u8; 32];
        let b64 = b64(&bytes);
        let hex = credential_id_hex(&b64).unwrap();
        assert_eq!(hex, hex::encode(bytes));
    }

    #[test]
    fn credential_id_hex_real_sd_jwt_matches_sha256() {
        let (issuer, _holder, vc) = sample();
        let s = vc.serialize();
        let cid = credential_id(&s);
        let cid_hex = credential_id_hex(&cid).unwrap();
        let jwt = s.split('~').next().unwrap();
        assert_eq!(cid_hex, hex::encode(Sha256::digest(jwt.as_bytes())));
        let _ = issuer;
    }

    #[test]
    fn credential_id_hex_wrong_length_rejected() {
        // 31 random bytes → base64url 42 chars → not 64-hex either → decodes to 31 bytes.
        let bytes: [u8; 31] = [1u8; 31];
        let b64 = b64(&bytes);
        assert!(credential_id_hex(&b64).is_err());
    }

    #[test]
    fn credential_id_hex_non_base64_garbage_rejected() {
        assert!(credential_id_hex("!!!not base64@@@").is_err());
    }

    // -------- malformed presentation parsing --------

    #[test]
    fn parse_rejects_no_tilde() {
        assert!(SdJwtVc::parse("eyJhbGciOiJFZERTQSJ9.e30.AAAA").is_err());
    }

    #[test]
    fn verify_rejects_three_part_jwt_outside_sd_jwt_envelope() {
        let (issuer, _h, _vc) = sample();
        // Bare JWT, no `~` — not an SD-JWT (would need `JWT~` at minimum).
        let r = verify(
            "eyJhbGciOiJFZERTQSJ9.e30.AAAA",
            &issuer.public_key(),
            &VerifyParams::default(),
        );
        assert!(r.is_err());
    }

    #[test]
    fn verify_rejects_bad_issuer_jws_segment_count() {
        let (issuer, _h, vc) = sample();
        let mut s = vc.serialize();
        // Corrupt issuer JWT by stripping its signature → 2 parts instead of 3.
        let first = s.split('~').next().unwrap().to_string();
        let stripped = first.rsplit_once('.').unwrap().0.to_string();
        s = s.replacen(&first, &stripped, 1);
        assert!(verify(&s, &issuer.public_key(), &VerifyParams::default()).is_err());
    }

    // -------- KB-JWT edge cases --------

    /// Tamper the presentation prefix *after* the KB-JWT's `sd_hash` is
    /// signed: the holder's binding no longer matches → reject.
    #[test]
    fn kb_sd_hash_tamper_rejected() {
        let (issuer, holder, vc) = sample();
        let pres = vc
            .present(
                &["given_name"],
                Some(KbParams {
                    holder: &holder,
                    aud: "a".into(),
                    nonce: "n".into(),
                    iat: 1,
                }),
            )
            .unwrap();
        // Mutate one disclosure character (keeps SD-JWT shape, breaks sd_hash).
        let idx = pres.find('~').unwrap() + 1;
        let mut bytes: Vec<u8> = pres.into_bytes();
        bytes[idx] = if bytes[idx] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        let r = verify(
            &tampered,
            &issuer.public_key(),
            &VerifyParams {
                require_kb: true,
                nonce: Some("n".into()),
                ..Default::default()
            },
        );
        assert!(r.is_err());
    }

    #[test]
    fn kb_jwt_wrong_typ_rejected() {
        let issuer = KeyPair::generate();
        let holder = KeyPair::generate();
        let mut claims = BTreeMap::new();
        claims.insert("given_name".into(), json!("X"));
        let vc = SdJwtVc::issue(
            &claims,
            &IssueParams {
                issuer: &issuer,
                iss: "did:web:t".into(),
                vct: "v".into(),
                holder: &holder.public_key(),
                iat: None,
                exp: None,
                status: None,
            },
        )
        .unwrap();
        let prefix = vc.present(&["given_name"], None).unwrap();
        let sd_hash = b64(&Sha256::digest(prefix.as_bytes()));
        // Wrong `typ` ("jwt" instead of "kb+jwt").
        let h = b64(&serde_json::to_vec(&json!({ "typ": "jwt", "alg": ALG })).unwrap());
        let p = b64(&serde_json::to_vec(
            &json!({ "iat": 1, "aud": "a", "nonce": "n", "sd_hash": sd_hash }),
        )
        .unwrap());
        let si = format!("{h}.{p}");
        let sig = holder.sign(si.as_bytes());
        let bad = format!("{prefix}{si}.{}", b64(sig.bytes()));
        assert!(
            verify(
                &bad,
                &issuer.public_key(),
                &VerifyParams {
                    require_kb: true,
                    nonce: Some("n".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }

    // -------- payload integrity --------

    /// `_sd_alg` MUST be `sha-256` (RFC 9901). A document missing it (or
    /// declaring another digest) must be rejected at verify.
    #[test]
    fn missing_sd_alg_rejected() {
        let (issuer, holder, _vc) = sample();
        // Build an issuer JWT by hand without `_sd_alg`.
        let header = json!({ "typ": JWT_TYP, "alg": ALG });
        let payload = json!({
            "iss": "did:web:t",
            "vct": "v",
            "cnf": { "jwk": public_key_jwk(&holder.public_key()).unwrap() },
            "_sd": []
        });
        let jwt = jws_sign(&header, &payload, &issuer).unwrap();
        let s = format!("{jwt}~");
        assert!(verify(&s, &issuer.public_key(), &VerifyParams::default()).is_err());
    }
}
