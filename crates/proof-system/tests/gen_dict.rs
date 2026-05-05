//! One-shot dictionary generator. Run with:
//!   cargo test --package owl-proof-system --test gen_dict -- --nocapture
//!
//! Writes `crates/proof-system/src/zstd_dict.bin`

use owl_crypto::KeyPair;
use owl_proof_system::document::Document;
use owl_proof_system::{PredicateOp, PredicateRequest, ProofRequest, Token};
use serde_json::json;
use std::collections::BTreeMap;

fn cbor_bytes(token: &Token) -> Vec<u8> {
    let compact = token.to_compact().unwrap();
    let b45 = compact.strip_prefix("OID1:").unwrap();
    base45::decode(b45).unwrap()
}

fn make_simple() -> Token {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let mut a = BTreeMap::new();
    a.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
    a.insert("ownerKey".into(), json!(owner.public_key().to_hex()));
    a.insert("name".into(), json!("Jane Doe"));
    a.insert("dateOfBirth".into(), json!("1994-06-15"));
    let doc = Document::new(a).unwrap();
    let mut pd = doc.issue(&issuer);
    let req = ProofRequest {
        disclose: vec!["name".into()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "a1b2c3d4e5f6a7b8".into(),
    };
    Token::generate(&mut pd, &req, &owner, 3600).unwrap()
}

fn make_medium() -> Token {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let mut a = BTreeMap::new();
    a.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
    a.insert("ownerKey".into(), json!(owner.public_key().to_hex()));
    a.insert("givenName".into(), json!("Alexandra"));
    a.insert("familyName".into(), json!("Papadopoulos"));
    a.insert("dateOfBirth".into(), json!("1990-03-22"));
    a.insert("nationality".into(), json!("GR"));
    a.insert("documentNumber".into(), json!("AB1234567"));
    a.insert("expiryDate".into(), json!("2029-12-31"));
    let doc = Document::new(a).unwrap();
    let mut pd = doc.issue(&issuer);
    let req = ProofRequest {
        disclose: vec!["givenName".into(), "familyName".into(), "nationality".into()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".into(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "b2c3d4e5f6a7b8c9".into(),
    };
    Token::generate(&mut pd, &req, &owner, 7200).unwrap()
}

fn make_heavy() -> Token {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let mut a = BTreeMap::new();
    a.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
    a.insert("ownerKey".into(), json!(owner.public_key().to_hex()));
    a.insert("givenName".into(), json!("Konstantinos"));
    a.insert("familyName".into(), json!("Papadopoulos"));
    a.insert("dateOfBirth".into(), json!("1988-11-05"));
    a.insert("nationality".into(), json!("GR"));
    a.insert("documentNumber".into(), json!("XY9876543"));
    a.insert("expiryDate".into(), json!("2030-06-30"));
    a.insert("issuingAuthority".into(), json!("Hellenic Police"));
    a.insert("address".into(), json!("123 Ermou Street, Athens 10563"));
    a.insert("verificationLevel".into(), json!(3));
    a.insert("kycProvider".into(), json!("VeriffPrime"));
    let doc = Document::new(a).unwrap();
    let mut pd = doc.issue(&issuer);
    let req = ProofRequest {
        disclose: vec!["givenName".into(), "familyName".into(), "nationality".into(), "issuingAuthority".into()],
        predicates: vec![
            PredicateRequest { attribute: "dateOfBirth".into(), op: PredicateOp::GreaterOrEqual, value: json!(18) },
            PredicateRequest { attribute: "verificationLevel".into(), op: PredicateOp::GreaterOrEqual, value: json!(2) },
        ],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "c3d4e5f6a7b8c9d0".into(),
    };
    Token::generate(&mut pd, &req, &owner, 3600).unwrap()
}

#[test]
fn generate_zstd_dictionary() {
    let samples: Vec<Vec<u8>> = (0..60)
        .map(|i| match i % 3 {
            0 => cbor_bytes(&make_simple()),
            1 => cbor_bytes(&make_medium()),
            _ => cbor_bytes(&make_heavy()),
        })
        .collect();

    let refs: Vec<&[u8]> = samples.iter().map(|s| s.as_slice()).collect();
    let dict = zstd::dict::from_samples(&refs, 4096).expect("dict training failed");

    let out_path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/zstd_dict.bin");
    std::fs::write(out_path, &dict).unwrap();
    println!("Wrote {} bytes to {}", dict.len(), out_path);
}
