//! Compact binary token format for QR codes (OID1).
//!
//! Encoding pipeline: Token → CBOR (optimized) → zstd(dict) → Base45 → "OID1:" prefix
//! Decoding pipeline: Strip "OID1:" → Base45 decode → zstd(dict) decompress → CBOR decode → Token
//!
//! OID = OwlID. Optimizations:
//!   - Attribute keys use integer dictionary indices instead of strings
//!   - root_hash not duplicated inside merkle_proof (reuse field 1)
//!   - signers omitted (derived from subjects issuerKey/ownerKey on decode)
//!   - version omitted (implicit in OID prefix)
//!   - signer_threshold omitted when default (1)
//!   - ttl omitted when default (3600)
//!   - challenge stored as raw bytes when parseable as hex/UUID
//!   - ZK attr_leaf_hash stored as index into committed_attributes
//!   - zstd compression with embedded trained dictionary

use crate::error::ProofSystemError;
use crate::token::{OwnerSignature, Token, TokenPayload};
use ciborium::Value as CborValue;
use owl_crypto::{MerkleProof, ProofLeaf, Signature, SignatureAlgorithm, SiblingHash};
use std::collections::BTreeMap;
use std::io::Write;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPACT_PREFIX: &str = "OID1:";

/// Embedded zstd dictionary trained on a corpus of OID tokens.
/// Regenerate with: cargo test --package owl-proof-system --test gen_dict -- --nocapture
const ZSTD_DICT: &[u8] = include_bytes!("zstd_dict.bin");
const DEFAULT_TTL: i64 = 3600;
const DEFAULT_THRESHOLD: u32 = 1;

/// Well-known attribute names → integer index.
/// Order is fixed and append-only (new attributes get the next index).
const ATTR_DICT: &[&str] = &[
    "issuerKey",           // 0
    "ownerKey",            // 1
    "givenName",           // 2
    "familyName",          // 3
    "dateOfBirth",         // 4
    "nationality",         // 5
    "documentNumber",      // 6
    "expiryDate",          // 7
    "issuingAuthority",    // 8
    "address",             // 9
    "verificationLevel",   // 10
    "kycProvider",         // 11
    "name",                // 12
    "email",               // 13
    "phone",               // 14
    "isResident",          // 15
    "ownerKeys",           // 16
];

fn attr_to_index(name: &str) -> Option<usize> {
    ATTR_DICT.iter().position(|&n| n == name)
}

fn index_to_attr(idx: i64) -> Option<&'static str> {
    ATTR_DICT.get(idx as usize).copied()
}

/// Encode an attribute key: integer if in dictionary, text otherwise.
fn encode_attr_key(name: &str) -> CborValue {
    match attr_to_index(name) {
        Some(i) => int_val(i as i64),
        None => CborValue::Text(name.to_string()),
    }
}

/// Decode an attribute key from integer index or text.
fn decode_attr_key(v: &CborValue) -> Result<String, ProofSystemError> {
    match v {
        CborValue::Integer(i) => {
            let n: i128 = (*i).into();
            index_to_attr(n as i64)
                .map(|s| s.to_string())
                .ok_or_else(|| ProofSystemError::InvalidProof(format!("Unknown attr index: {}", n)))
        }
        CborValue::Text(s) => Ok(s.clone()),
        _ => Err(ProofSystemError::InvalidProof("Attr key must be int or text".into())),
    }
}

// ---------------------------------------------------------------------------
// CBOR helpers
// ---------------------------------------------------------------------------

fn int_key(k: i64) -> CborValue {
    CborValue::Integer(k.into())
}

fn int_val(v: i64) -> CborValue {
    CborValue::Integer(v.into())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

impl Token {
    /// Encode this token to compact binary format for QR codes.
    ///
    /// Pipeline: Token → CBOR → zstd(dict) → Base45 → "OID1:"
    pub fn to_compact(&self) -> Result<String, ProofSystemError> {
        let cbor = token_to_cbor(self)?;
        let mut cbor_bytes = Vec::new();
        ciborium::into_writer(&cbor, &mut cbor_bytes)
            .map_err(|e| ProofSystemError::InvalidProof(format!("CBOR encode: {}", e)))?;

        let compressed = zstd_compress(&cbor_bytes)?;

        // Use whichever is smaller: compressed or raw CBOR
        let payload = if compressed.len() < cbor_bytes.len() {
            &compressed
        } else {
            &cbor_bytes
        };

        // First byte signals compression: 0x01 = zstd, 0x00 = raw CBOR
        let mut framed = Vec::with_capacity(1 + payload.len());
        if compressed.len() < cbor_bytes.len() {
            framed.push(0x01);
            framed.extend_from_slice(&compressed);
        } else {
            framed.push(0x00);
            framed.extend_from_slice(&cbor_bytes);
        }

        let b45 = base45::encode(&framed);
        Ok(format!("{}{}", COMPACT_PREFIX, b45))
    }

    /// Decode a compact binary token.
    ///
    /// Pipeline: Strip "OID1:" → Base45 → decompress if needed → CBOR → Token
    pub fn from_compact(s: &str) -> Result<Self, ProofSystemError> {
        let payload_str = s
            .strip_prefix(COMPACT_PREFIX)
            .ok_or_else(|| ProofSystemError::InvalidProof("Missing OID1: prefix".into()))?;

        let framed = base45::decode(payload_str)
            .map_err(|e| ProofSystemError::InvalidProof(format!("Base45 decode: {}", e)))?;

        if framed.is_empty() {
            return Err(ProofSystemError::InvalidProof("Empty payload".into()));
        }

        let cbor_bytes = match framed[0] {
            0x01 => zstd_decompress(&framed[1..])?,
            0x00 => framed[1..].to_vec(),
            _ => {
                return Err(ProofSystemError::InvalidProof(format!(
                    "Unknown compression flag: 0x{:02x}",
                    framed[0]
                )));
            }
        };

        let cbor: CborValue = ciborium::from_reader(&cbor_bytes[..])
            .map_err(|e| ProofSystemError::InvalidProof(format!("CBOR decode: {}", e)))?;

        cbor_to_token(&cbor)
    }
}

// ---------------------------------------------------------------------------
// zstd compression with embedded dictionary
// ---------------------------------------------------------------------------

fn zstd_compress(data: &[u8]) -> Result<Vec<u8>, ProofSystemError> {
    let mut buf = Vec::new();
    let mut enc = zstd::Encoder::with_dictionary(&mut buf, 3, ZSTD_DICT)
        .map_err(|e| ProofSystemError::InvalidProof(format!("zstd init: {}", e)))?;
    enc.write_all(data)
        .map_err(|e| ProofSystemError::InvalidProof(format!("zstd write: {}", e)))?;
    enc.finish()
        .map_err(|e| ProofSystemError::InvalidProof(format!("zstd finish: {}", e)))?;
    Ok(buf)
}

fn zstd_decompress(data: &[u8]) -> Result<Vec<u8>, ProofSystemError> {
    use std::io::Read;
    let mut dec = zstd::Decoder::with_dictionary(std::io::Cursor::new(data), ZSTD_DICT)
        .map_err(|e| ProofSystemError::InvalidProof(format!("zstd init: {}", e)))?;
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| ProofSystemError::InvalidProof(format!("zstd decompress: {}", e)))?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Encode — NID2 layout
// ---------------------------------------------------------------------------
//
// CBOR map with integer keys:
//   0: challenge (bstr if valid hex, text otherwise)
//   1: root_hash (bstr 32)
//   2: issuer_signature [algo_int, sig_bstr]
//   3: merkle_proof (WITHOUT root_hash — uses field 1)
//   4: subjects (keys are int indices or text)
//   5: activation_time (int, epoch seconds)
//   6: salt (bstr, optional)
//   7: zk_proofs (array, optional)
//   8: committed_attributes (map, optional — keys are int indices)
//   9: owner_signature (array, optional)
//  10: hmac (bstr, optional)
//  11: ttl (int, optional — omitted when 3600)
//  12: signer_threshold (int, optional — omitted when 1)
//
// Omitted vs NID1: version (implicit), signers (derived from subjects)

fn token_to_cbor(token: &Token) -> Result<CborValue, ProofSystemError> {
    let p = token.payload();
    let mut entries = Vec::<(CborValue, CborValue)>::new();

    // 0: challenge — store as raw bytes if all hex, otherwise text
    entries.push((int_key(0), encode_challenge(&p.challenge)));

    // 1: root_hash
    entries.push((int_key(1), CborValue::Bytes(hex_to_bytes(&p.root_hash)?)));

    // 2: issuer_signature
    entries.push((int_key(2), encode_signature(&p.signature)));

    // 3: merkle_proof (omit root_hash — decoder gets it from field 1)
    if let Some(mp) = &p.proof_of_inclusion {
        entries.push((int_key(3), encode_merkle_proof(mp)));
    }

    // 4: subjects (attribute keys as int indices)
    entries.push((int_key(4), encode_subjects(&p.subjects)));

    // 5: activation_time
    entries.push((int_key(5), int_val(p.activation_time)));

    // 6: salt
    if let Some(s) = &p.salt {
        entries.push((
            int_key(6),
            CborValue::Bytes(hex::decode(s).unwrap_or_else(|_| s.as_bytes().to_vec())),
        ));
    }

    // 7: zk_proofs (with attr_leaf_hash as index into committed_attributes)
    if !p.zk_proofs.is_empty() {
        let zk: Vec<CborValue> = p
            .zk_proofs
            .iter()
            .map(|v| encode_zk_proof(v, &p.committed_attributes))
            .collect::<Result<_, _>>()?;
        entries.push((int_key(7), CborValue::Array(zk)));
    }

    // 8: committed_attributes (keys as int indices)
    if !p.committed_attributes.is_empty() {
        let ca: Vec<(CborValue, CborValue)> = p
            .committed_attributes
            .iter()
            .map(|(k, v)| {
                (
                    encode_attr_key(k),
                    CborValue::Bytes(hex::decode(v).unwrap_or_default()),
                )
            })
            .collect();
        entries.push((int_key(8), CborValue::Map(ca)));
    }

    // 9: owner_signature
    let owner_sig = token.owner_signatures().first().or(token.owner_signature());
    if let Some(sig) = owner_sig {
        entries.push((int_key(9), encode_owner_sig(sig)));
    }

    // 10: hmac
    if let Some(h) = token.hmac() {
        entries.push((
            int_key(10),
            CborValue::Bytes(hex::decode(h).unwrap_or_default()),
        ));
    }

    // 11: ttl — omit when default
    if p.ttl != DEFAULT_TTL {
        entries.push((int_key(11), int_val(p.ttl)));
    }

    // 12: signer_threshold — omit when default
    if p.signer_threshold != DEFAULT_THRESHOLD {
        entries.push((int_key(12), int_val(p.signer_threshold as i64)));
    }

    Ok(CborValue::Map(entries))
}

/// Encode challenge: strip dashes from UUID-like strings and store as raw bytes
/// if the result is valid hex. Otherwise store as text.
fn encode_challenge(challenge: &str) -> CborValue {
    let stripped = challenge.replace('-', "");
    if stripped.len() >= 8 && stripped.len() % 2 == 0 && stripped.bytes().all(|b| b.is_ascii_hexdigit()) {
        // Store as raw bytes with a 1-byte flag prefix:
        //   0x00 = raw hex bytes (challenge had no dashes or was pure hex)
        //   0x01 = UUID-like (had dashes, restore on decode)
        let has_dashes = challenge.contains('-');
        let mut tagged = vec![if has_dashes { 0x01 } else { 0x00 }];
        tagged.extend_from_slice(&hex::decode(&stripped).unwrap());
        CborValue::Bytes(tagged)
    } else {
        CborValue::Text(challenge.to_string())
    }
}

fn encode_signature(sig: &Signature) -> CborValue {
    CborValue::Array(vec![
        int_val(algo_to_int(sig.algorithm())),
        CborValue::Bytes(sig.bytes().to_vec()),
    ])
}

/// Encode merkle proof WITHOUT root_hash (saved ~34 bytes).
fn encode_merkle_proof(mp: &MerkleProof) -> CborValue {
    // Leaves: [attr_key_int_or_text, hash_bstr, position_int]
    let leaves: Vec<CborValue> = mp
        .proof_leaves()
        .iter()
        .map(|l| {
            CborValue::Array(vec![
                encode_attr_key(l.key()),
                CborValue::Bytes(l.hash().to_vec()),
                int_val(l.position() as i64),
            ])
        })
        .collect();

    // Compact sibling encoding (unchanged)
    let mut hash_concat = Vec::with_capacity(mp.sibling_hashes().len() * 32);
    let mut meta_packed = Vec::with_capacity(mp.sibling_hashes().len());
    for s in mp.sibling_hashes() {
        hash_concat.extend_from_slice(s.hash());
        meta_packed.push(((s.level() as u8) << 4) | (s.position() as u8 & 0x0F));
    }

    // Only leaves + siblings — no root_hash (field 0 removed)
    CborValue::Map(vec![
        (int_key(0), CborValue::Array(leaves)),
        (
            int_key(1),
            CborValue::Array(vec![
                CborValue::Bytes(hash_concat),
                CborValue::Bytes(meta_packed),
            ]),
        ),
    ])
}

fn encode_subjects(subjects: &BTreeMap<String, serde_json::Value>) -> CborValue {
    let entries: Vec<(CborValue, CborValue)> = subjects
        .iter()
        .map(|(k, v)| (encode_attr_key(k), json_value_to_cbor_smart(v)))
        .collect();
    CborValue::Map(entries)
}

fn encode_zk_proof(
    zk_value: &serde_json::Value,
    committed: &BTreeMap<String, String>,
) -> Result<CborValue, ProofSystemError> {
    let proof = crate::zk::zk_proof_from_value(zk_value)
        .map_err(|e| ProofSystemError::InvalidProof(format!("ZK proof encode: {}", e)))?;

    let proof_type_int: i64 = match proof.proof_type {
        owl_zk_circuits::ZkProofType::AgeRange => 0,
        owl_zk_circuits::ZkProofType::Nationality => 1,
        owl_zk_circuits::ZkProofType::KycStatus => 2,
    };

    let mut entries = Vec::<(CborValue, CborValue)>::new();

    // 0: proof_type
    entries.push((int_key(0), int_val(proof_type_int)));

    // 1: proof_bytes
    entries.push((int_key(1), CborValue::Bytes(hex_to_bytes(&proof.proof_bytes)?)));

    // 2: public_inputs
    let inputs: Vec<CborValue> = proof
        .public_inputs
        .iter()
        .map(|h| Ok(CborValue::Bytes(hex_to_bytes(h)?)))
        .collect::<Result<_, ProofSystemError>>()?;
    entries.push((int_key(2), CborValue::Array(inputs)));

    // 3: bound_attribute — as int index or text
    entries.push((
        int_key(3),
        match &proof.bound_attribute {
            Some(a) => encode_attr_key(a),
            None => CborValue::Null,
        },
    ));

    // 4: attr_leaf_hash — store as index into committed_attributes if possible
    entries.push((
        int_key(4),
        match &proof.attribute_leaf_hash {
            Some(h) => {
                // Try to find this hash in committed_attributes by value
                let committed_keys: Vec<&String> = committed.keys().collect();
                let idx = committed.values().position(|v| v == h);
                match idx {
                    Some(i) => int_val(i as i64), // index reference — saves ~33 bytes
                    None => CborValue::Bytes(hex_to_bytes(h)?), // fallback
                }
            }
            None => CborValue::Null,
        },
    ));

    Ok(CborValue::Map(entries))
}

fn encode_owner_sig(sig: &OwnerSignature) -> CborValue {
    match sig {
        OwnerSignature::Standard { signature } => CborValue::Array(vec![
            int_val(0),
            int_val(algo_to_int(signature.algorithm())),
            CborValue::Bytes(signature.bytes().to_vec()),
        ]),
        OwnerSignature::WebAuthn {
            authenticator_data,
            client_data_json,
            signature,
            credential_public_key,
        } => CborValue::Array(vec![
            int_val(1),
            CborValue::Bytes(decode_base64_or_raw(authenticator_data)),
            CborValue::Bytes(decode_base64_or_raw(client_data_json)),
            CborValue::Bytes(decode_base64_or_raw(signature)),
            CborValue::Bytes(decode_base64_or_raw(credential_public_key)),
        ]),
        OwnerSignature::RingSig {
            challenges,
            responses,
            key_image,
            ring,
        } => {
            let c: Vec<CborValue> = challenges
                .iter()
                .map(|h| CborValue::Bytes(hex::decode(h).unwrap_or_default()))
                .collect();
            let r: Vec<CborValue> = responses
                .iter()
                .map(|h| CborValue::Bytes(hex::decode(h).unwrap_or_default()))
                .collect();
            let rk: Vec<CborValue> = ring
                .iter()
                .map(|h| CborValue::Bytes(hex::decode(h).unwrap_or_default()))
                .collect();
            CborValue::Array(vec![
                int_val(2),
                CborValue::Array(c),
                CborValue::Array(r),
                CborValue::Bytes(hex::decode(key_image).unwrap_or_default()),
                CborValue::Array(rk),
            ])
        }
    }
}

// ---------------------------------------------------------------------------
// Decode — NID2 layout
// ---------------------------------------------------------------------------

fn cbor_to_token(cbor: &CborValue) -> Result<Token, ProofSystemError> {
    let map = cbor_as_map(cbor)?;

    // 0: challenge
    let challenge = decode_challenge(cbor_map_get(map, 0)?)?;

    // 1: root_hash
    let root_hash_bytes = cbor_map_bytes(map, 1)?;
    let root_hash = hex::encode(&root_hash_bytes);

    // 2: issuer_signature
    let signature = decode_signature(cbor_map_get(map, 2)?)?;

    // 3: merkle_proof — inject root_hash from field 1
    let proof_of_inclusion = match cbor_map_try_get(map, 3) {
        Some(v) if !v.is_null() => Some(decode_merkle_proof(v, &root_hash_bytes)?),
        _ => None,
    };

    // 4: subjects
    let subjects = decode_subjects(cbor_map_get(map, 4)?)?;

    // 5: activation_time
    let activation_time = cbor_as_i64(cbor_map_get(map, 5)?)?;

    // 6: salt
    let salt = match cbor_map_try_get(map, 6) {
        Some(v) if !v.is_null() => Some(hex::encode(cbor_as_bytes(v)?)),
        _ => None,
    };

    // 8: committed_attributes (decode before zk_proofs since they reference it)
    let committed_attributes = match cbor_map_try_get(map, 8) {
        Some(v) => {
            let m = cbor_as_map(v)?;
            let mut result = BTreeMap::new();
            for (k, v) in m {
                result.insert(decode_attr_key(k)?, hex::encode(cbor_as_bytes(v)?));
            }
            result
        }
        None => BTreeMap::new(),
    };

    // 7: zk_proofs
    let zk_proofs = match cbor_map_try_get(map, 7) {
        Some(v) => {
            let arr = cbor_as_array(v)?;
            arr.iter()
                .map(|v| decode_zk_proof(v, &committed_attributes))
                .collect::<Result<_, _>>()?
        }
        None => vec![],
    };

    // 9: owner_signature
    let owner_signature = match cbor_map_try_get(map, 9) {
        Some(v) if !v.is_null() => Some(decode_owner_sig(v)?),
        _ => None,
    };
    let owner_signatures = owner_signature.iter().cloned().collect();

    // 10: hmac
    let hmac = match cbor_map_try_get(map, 10) {
        Some(v) if !v.is_null() => Some(hex::encode(cbor_as_bytes(v)?)),
        _ => None,
    };

    // 11: ttl — default 3600
    let ttl = match cbor_map_try_get(map, 11) {
        Some(v) => cbor_as_i64(v)?,
        None => DEFAULT_TTL,
    };

    // 12: signer_threshold — default 1
    let signer_threshold = match cbor_map_try_get(map, 12) {
        Some(v) => cbor_as_u32(v)?,
        None => DEFAULT_THRESHOLD,
    };

    // Derive signers from subjects (issuerKey + ownerKey / ownerKeys)
    let signers = derive_signers(&subjects);

    let payload = TokenPayload {
        challenge,
        root_hash,
        signature,
        proof_of_inclusion,
        subjects,
        ttl,
        activation_time,
        data: None,
        salt,
        signers,
        signer_threshold,
        zk_proofs,
        committed_attributes,
    };

    Ok(Token::from_parts(payload, owner_signature, owner_signatures, hmac))
}

/// Derive signers list from subjects' issuerKey and ownerKey/ownerKeys.
fn derive_signers(subjects: &BTreeMap<String, serde_json::Value>) -> Vec<String> {
    let mut signers = Vec::new();

    // issuerKey
    if let Some(serde_json::Value::String(ik)) = subjects.get("issuerKey") {
        signers.push(ik.clone());
    }

    // ownerKey (single) or ownerKeys (array)
    if let Some(serde_json::Value::String(ok)) = subjects.get("ownerKey") {
        signers.push(ok.clone());
    } else if let Some(serde_json::Value::Array(oks)) = subjects.get("ownerKeys") {
        for ok in oks {
            if let serde_json::Value::String(s) = ok {
                signers.push(s.clone());
            }
        }
    }

    signers
}

fn decode_challenge(v: &CborValue) -> Result<String, ProofSystemError> {
    match v {
        CborValue::Text(s) => Ok(s.clone()),
        CborValue::Bytes(b) if !b.is_empty() => {
            let flag = b[0];
            let hex_str = hex::encode(&b[1..]);
            match flag {
                0x01 => {
                    // UUID-like: restore dashes (8-4-4-4-12 pattern if 32 hex chars)
                    if hex_str.len() == 32 {
                        Ok(format!(
                            "{}-{}-{}-{}-{}",
                            &hex_str[0..8],
                            &hex_str[8..12],
                            &hex_str[12..16],
                            &hex_str[16..20],
                            &hex_str[20..32]
                        ))
                    } else {
                        // Non-standard length with dashes — prefix was "ch-" etc.
                        // Just return hex with the dashes we know were there
                        Ok(hex_str)
                    }
                }
                0x00 => Ok(hex_str),
                _ => Err(ProofSystemError::InvalidProof(format!(
                    "Unknown challenge flag: {}",
                    flag
                ))),
            }
        }
        _ => Err(ProofSystemError::InvalidProof(
            "Challenge must be text or bytes".into(),
        )),
    }
}

fn decode_signature(v: &CborValue) -> Result<Signature, ProofSystemError> {
    let arr = cbor_as_array(v)?;
    if arr.len() != 2 {
        return Err(ProofSystemError::InvalidProof(
            "Signature must be [algo, bytes]".into(),
        ));
    }
    let algo = int_to_algo(cbor_as_i64(&arr[0])?)?;
    let bytes = cbor_as_bytes(&arr[1])?;
    Ok(Signature::from_parts(algo, bytes))
}

/// Decode merkle proof — root_hash injected from parent field 1.
fn decode_merkle_proof(
    v: &CborValue,
    root_hash_bytes: &[u8],
) -> Result<MerkleProof, ProofSystemError> {
    let map = cbor_as_map(v)?;

    let root_hash: [u8; 32] = root_hash_bytes
        .try_into()
        .map_err(|_| ProofSystemError::InvalidProof("root_hash must be 32 bytes".into()))?;

    // 0: leaves
    let leaves_arr = cbor_as_array(cbor_map_get(map, 0)?)?;
    let mut proof_leaves = Vec::new();
    for leaf in leaves_arr {
        let la = cbor_as_array(leaf)?;
        if la.len() != 3 {
            return Err(ProofSystemError::InvalidProof(
                "leaf must be [key, hash, pos]".into(),
            ));
        }
        let key = decode_attr_key(&la[0])?;
        let hash_bytes = cbor_as_bytes(&la[1])?;
        let hash: [u8; 32] = hash_bytes
            .try_into()
            .map_err(|_| ProofSystemError::InvalidProof("leaf hash must be 32 bytes".into()))?;
        let position = cbor_as_i64(&la[2])? as usize;
        proof_leaves.push(ProofLeaf::new(key, hash, position));
    }

    // 1: siblings
    let siblings_val = cbor_as_array(cbor_map_get(map, 1)?)?;
    let mut sibling_hashes = Vec::new();
    if siblings_val.len() == 2 {
        let hash_concat = cbor_as_bytes(&siblings_val[0])?;
        let meta_packed = cbor_as_bytes(&siblings_val[1])?;
        if hash_concat.len() != meta_packed.len() * 32 {
            return Err(ProofSystemError::InvalidProof(
                "sibling hash/meta length mismatch".into(),
            ));
        }
        for (i, &meta) in meta_packed.iter().enumerate() {
            let level = (meta >> 4) as usize;
            let position = (meta & 0x0F) as usize;
            let hash: [u8; 32] = hash_concat[i * 32..(i + 1) * 32]
                .try_into()
                .map_err(|_| {
                    ProofSystemError::InvalidProof("sibling hash must be 32 bytes".into())
                })?;
            sibling_hashes.push(SiblingHash::new(level, position, hash));
        }
    }

    Ok(MerkleProof::from_parts(root_hash, proof_leaves, sibling_hashes))
}

fn decode_subjects(
    v: &CborValue,
) -> Result<BTreeMap<String, serde_json::Value>, ProofSystemError> {
    let map = cbor_as_map(v)?;
    let mut result = BTreeMap::new();
    for (k, v) in map {
        result.insert(decode_attr_key(k)?, cbor_to_json_smart(v));
    }
    Ok(result)
}

fn decode_zk_proof(
    v: &CborValue,
    committed: &BTreeMap<String, String>,
) -> Result<serde_json::Value, ProofSystemError> {
    let map = cbor_as_map(v)?;

    let proof_type_int = cbor_as_i64(cbor_map_get(map, 0)?)?;
    let proof_type = match proof_type_int {
        0 => "AgeRange",
        1 => "Nationality",
        2 => "KycStatus",
        _ => {
            return Err(ProofSystemError::InvalidProof(format!(
                "Unknown ZK proof type: {}",
                proof_type_int
            )))
        }
    };

    let proof_bytes = hex::encode(cbor_map_bytes(map, 1)?);

    let public_inputs_arr = cbor_as_array(cbor_map_get(map, 2)?)?;
    let public_inputs: Vec<String> = public_inputs_arr
        .iter()
        .map(|v| Ok(hex::encode(cbor_as_bytes(v)?)))
        .collect::<Result<_, ProofSystemError>>()?;

    // 3: bound_attribute — int index or text
    let bound_attribute = {
        let v = cbor_map_get(map, 3)?;
        if v.is_null() {
            None
        } else {
            Some(decode_attr_key(v)?)
        }
    };

    // 4: attr_leaf_hash — int index into committed_attributes or raw bytes
    let attribute_leaf_hash = {
        let v = cbor_map_get(map, 4)?;
        if v.is_null() {
            None
        } else {
            match v {
                CborValue::Integer(i) => {
                    let idx: i128 = (*i).into();
                    let hash = committed
                        .values()
                        .nth(idx as usize)
                        .ok_or_else(|| {
                            ProofSystemError::InvalidProof(format!(
                                "ZK leaf hash index {} out of range",
                                idx
                            ))
                        })?;
                    Some(hash.clone())
                }
                CborValue::Bytes(b) => Some(hex::encode(b)),
                _ => {
                    return Err(ProofSystemError::InvalidProof(
                        "attr_leaf_hash must be int or bytes".into(),
                    ))
                }
            }
        }
    };

    let mut obj = serde_json::Map::new();
    obj.insert(
        "proof_type".into(),
        serde_json::Value::String(proof_type.into()),
    );
    obj.insert(
        "proof_bytes".into(),
        serde_json::Value::String(proof_bytes),
    );
    obj.insert(
        "public_inputs".into(),
        serde_json::Value::Array(
            public_inputs
                .into_iter()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    if let Some(ba) = bound_attribute {
        obj.insert("bound_attribute".into(), serde_json::Value::String(ba));
    }
    if let Some(alh) = attribute_leaf_hash {
        obj.insert(
            "attribute_leaf_hash".into(),
            serde_json::Value::String(alh),
        );
    }

    Ok(serde_json::Value::Object(obj))
}

fn decode_owner_sig(v: &CborValue) -> Result<OwnerSignature, ProofSystemError> {
    let arr = cbor_as_array(v)?;
    if arr.is_empty() {
        return Err(ProofSystemError::InvalidProof(
            "Empty owner signature".into(),
        ));
    }
    let tag = cbor_as_i64(&arr[0])?;

    match tag {
        0 => {
            if arr.len() != 3 {
                return Err(ProofSystemError::InvalidProof(
                    "Standard sig needs [0, algo, bytes]".into(),
                ));
            }
            let algo = int_to_algo(cbor_as_i64(&arr[1])?)?;
            let bytes = cbor_as_bytes(&arr[2])?;
            Ok(OwnerSignature::Standard {
                signature: Signature::from_parts(algo, bytes),
            })
        }
        1 => {
            if arr.len() != 5 {
                return Err(ProofSystemError::InvalidProof(
                    "WebAuthn sig needs 5 elements".into(),
                ));
            }
            Ok(OwnerSignature::WebAuthn {
                authenticator_data: encode_base64(&cbor_as_bytes(&arr[1])?),
                client_data_json: encode_base64(&cbor_as_bytes(&arr[2])?),
                signature: encode_base64(&cbor_as_bytes(&arr[3])?),
                credential_public_key: encode_base64(&cbor_as_bytes(&arr[4])?),
            })
        }
        2 => {
            if arr.len() != 5 {
                return Err(ProofSystemError::InvalidProof(
                    "RingSig needs 5 elements".into(),
                ));
            }
            let challenges = cbor_as_array(&arr[1])?
                .iter()
                .map(|v| Ok(hex::encode(cbor_as_bytes(v)?)))
                .collect::<Result<Vec<_>, ProofSystemError>>()?;
            let responses = cbor_as_array(&arr[2])?
                .iter()
                .map(|v| Ok(hex::encode(cbor_as_bytes(v)?)))
                .collect::<Result<Vec<_>, ProofSystemError>>()?;
            let key_image = hex::encode(cbor_as_bytes(&arr[3])?);
            let ring = cbor_as_array(&arr[4])?
                .iter()
                .map(|v| Ok(hex::encode(cbor_as_bytes(v)?)))
                .collect::<Result<Vec<_>, ProofSystemError>>()?;
            Ok(OwnerSignature::RingSig {
                challenges,
                responses,
                key_image,
                ring,
            })
        }
        _ => Err(ProofSystemError::InvalidProof(format!(
            "Unknown owner sig tag: {}",
            tag
        ))),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn algo_to_int(algo: SignatureAlgorithm) -> i64 {
    match algo {
        SignatureAlgorithm::Ed25519 => 0,
        SignatureAlgorithm::EcdsaP256 => 1,
    }
}

fn int_to_algo(v: i64) -> Result<SignatureAlgorithm, ProofSystemError> {
    match v {
        0 => Ok(SignatureAlgorithm::Ed25519),
        1 => Ok(SignatureAlgorithm::EcdsaP256),
        _ => Err(ProofSystemError::InvalidProof(format!(
            "Unknown sig algorithm: {}",
            v
        ))),
    }
}

fn hex_to_bytes(hex_str: &str) -> Result<Vec<u8>, ProofSystemError> {
    hex::decode(hex_str)
        .map_err(|e| ProofSystemError::InvalidProof(format!("Invalid hex: {}", e)))
}

fn decode_base64_or_raw(s: &str) -> Vec<u8> {
    use base64::prelude::*;
    BASE64_STANDARD
        .decode(s)
        .unwrap_or_else(|_| s.as_bytes().to_vec())
}

fn encode_base64(bytes: &[u8]) -> String {
    use base64::prelude::*;
    BASE64_STANDARD.encode(bytes)
}

/// Encode a JSON value to CBOR, converting hex strings to raw bytes.
fn json_value_to_cbor_smart(v: &serde_json::Value) -> CborValue {
    match v {
        serde_json::Value::String(s) if is_hex_bytes(s) => {
            let mut tagged = vec![b'H'];
            tagged.extend_from_slice(&hex::decode(s).unwrap());
            CborValue::Bytes(tagged)
        }
        _ => json_to_cbor(v),
    }
}

fn is_hex_bytes(s: &str) -> bool {
    s.len() >= 32 && s.len() % 2 == 0 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Decode CBOR to JSON, handling the 'H' tagged bytes → hex string conversion.
fn cbor_to_json_smart(v: &CborValue) -> serde_json::Value {
    match v {
        CborValue::Bytes(b) if b.first() == Some(&b'H') => {
            serde_json::Value::String(hex::encode(&b[1..]))
        }
        _ => cbor_to_json(v),
    }
}

fn json_to_cbor(v: &serde_json::Value) -> CborValue {
    match v {
        serde_json::Value::Null => CborValue::Null,
        serde_json::Value::Bool(b) => CborValue::Bool(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                CborValue::Integer(i.into())
            } else if let Some(f) = n.as_f64() {
                CborValue::Float(f)
            } else {
                CborValue::Null
            }
        }
        serde_json::Value::String(s) => CborValue::Text(s.clone()),
        serde_json::Value::Array(arr) => {
            CborValue::Array(arr.iter().map(json_to_cbor).collect())
        }
        serde_json::Value::Object(obj) => {
            let entries: Vec<(CborValue, CborValue)> = obj
                .iter()
                .map(|(k, v)| (CborValue::Text(k.clone()), json_to_cbor(v)))
                .collect();
            CborValue::Map(entries)
        }
    }
}

fn cbor_to_json(v: &CborValue) -> serde_json::Value {
    match v {
        CborValue::Null => serde_json::Value::Null,
        CborValue::Bool(b) => serde_json::Value::Bool(*b),
        CborValue::Integer(i) => {
            let n: i128 = (*i).into();
            serde_json::Value::Number(serde_json::Number::from(n as i64))
        }
        CborValue::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        CborValue::Text(s) => serde_json::Value::String(s.clone()),
        CborValue::Bytes(b) => serde_json::Value::String(hex::encode(b)),
        CborValue::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(cbor_to_json).collect())
        }
        CborValue::Map(entries) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in entries {
                let key = match k {
                    CborValue::Text(s) => s.clone(),
                    CborValue::Integer(i) => {
                        let n: i128 = (*i).into();
                        n.to_string()
                    }
                    _ => continue,
                };
                obj.insert(key, cbor_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        _ => serde_json::Value::Null,
    }
}

// ---------------------------------------------------------------------------
// CBOR accessor helpers
// ---------------------------------------------------------------------------

fn cbor_as_map(v: &CborValue) -> Result<&Vec<(CborValue, CborValue)>, ProofSystemError> {
    match v {
        CborValue::Map(m) => Ok(m),
        _ => Err(ProofSystemError::InvalidProof("Expected CBOR map".into())),
    }
}

fn cbor_as_array(v: &CborValue) -> Result<&Vec<CborValue>, ProofSystemError> {
    match v {
        CborValue::Array(a) => Ok(a),
        _ => Err(ProofSystemError::InvalidProof(
            "Expected CBOR array".into(),
        )),
    }
}

fn cbor_as_bytes(v: &CborValue) -> Result<Vec<u8>, ProofSystemError> {
    match v {
        CborValue::Bytes(b) => Ok(b.clone()),
        _ => Err(ProofSystemError::InvalidProof(
            "Expected CBOR bytes".into(),
        )),
    }
}

fn cbor_as_text(v: &CborValue) -> Result<String, ProofSystemError> {
    match v {
        CborValue::Text(s) => Ok(s.clone()),
        _ => Err(ProofSystemError::InvalidProof("Expected CBOR text".into())),
    }
}

fn cbor_as_i64(v: &CborValue) -> Result<i64, ProofSystemError> {
    match v {
        CborValue::Integer(i) => {
            let n: i128 = (*i).into();
            Ok(n as i64)
        }
        _ => Err(ProofSystemError::InvalidProof(
            "Expected CBOR integer".into(),
        )),
    }
}

fn cbor_as_u32(v: &CborValue) -> Result<u32, ProofSystemError> {
    cbor_as_i64(v).map(|n| n as u32)
}

fn cbor_map_get<'a>(
    map: &'a [(CborValue, CborValue)],
    key: i64,
) -> Result<&'a CborValue, ProofSystemError> {
    let target = CborValue::Integer(key.into());
    for (k, v) in map {
        if k == &target {
            return Ok(v);
        }
    }
    Err(ProofSystemError::InvalidProof(format!(
        "Missing CBOR key {}",
        key
    )))
}

fn cbor_map_try_get<'a>(
    map: &'a [(CborValue, CborValue)],
    key: i64,
) -> Option<&'a CborValue> {
    let target = CborValue::Integer(key.into());
    for (k, v) in map {
        if k == &target {
            return Some(v);
        }
    }
    None
}

fn cbor_map_bytes(
    map: &[(CborValue, CborValue)],
    key: i64,
) -> Result<Vec<u8>, ProofSystemError> {
    cbor_as_bytes(cbor_map_get(map, key)?)
}
