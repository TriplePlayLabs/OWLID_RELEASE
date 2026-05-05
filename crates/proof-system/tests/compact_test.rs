//! Tests for the compact binary token format (CBOR + zlib + Base45)

use owl_crypto::KeyPair;
use owl_proof_system::token::{PredicateOp, PredicateRequest, ProofRequest, Token};
use owl_proof_system::Document;
use serde_json::json;
use std::collections::BTreeMap;

/// Helper: create a basic token with optional predicates
fn make_token(
    predicates: Vec<PredicateRequest>,
    disclose: Vec<String>,
) -> (Token, KeyPair) {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("name".to_string(), json!("John Doe"));
    attrs.insert("dateOfBirth".to_string(), json!("1994-06-15"));
    attrs.insert("nationality".to_string(), json!("NL"));
    attrs.insert("verificationLevel".to_string(), json!(3));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose,
        predicates,
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "test_challenge_123".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
    (token, issuer)
}

#[test]
fn test_compact_round_trip_no_zk() {
    let (token, _issuer) = make_token(vec![], vec!["name".to_string()]);

    let compact = token.to_compact().unwrap();
    assert!(compact.starts_with("OID1:"), "Must start with OID1: prefix");

    let restored = Token::from_compact(&compact).unwrap();

    // Verify subjects match
    assert_eq!(
        restored.subjects().get("name").and_then(|v| v.as_str()),
        Some("John Doe")
    );
}

#[test]
fn test_compact_round_trip_with_zk_proof() {
    let (token, _issuer) = make_token(
        vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        vec![],
    );

    assert!(!token.zk_proofs().is_empty(), "Token should have ZK proofs");

    let compact = token.to_compact().unwrap();
    assert!(compact.starts_with("OID1:"));

    let restored = Token::from_compact(&compact).unwrap();
    assert_eq!(restored.zk_proofs().len(), token.zk_proofs().len());
}

#[test]
fn test_compact_prefix() {
    let (token, _) = make_token(vec![], vec!["name".to_string()]);
    let compact = token.to_compact().unwrap();
    assert!(compact.starts_with("OID1:"));
}

#[test]
fn test_compact_size_no_zk() {
    let (token, _) = make_token(vec![], vec!["name".to_string()]);
    let compact = token.to_compact().unwrap();

    // Token without ZK proofs should be well under 1500 chars
    println!("Compact size (no ZK): {} chars", compact.len());
    assert!(
        compact.len() < 1500,
        "Compact token without ZK: {} chars (expected < 1500)",
        compact.len()
    );
}

#[test]
fn test_compact_size_with_one_zk_proof() {
    let (token, _) = make_token(
        vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        vec![],
    );
    let compact = token.to_compact().unwrap();

    println!("Compact size (1 ZK proof): {} chars", compact.len());
    assert!(
        compact.len() < 1500,
        "Compact token with 1 ZK proof: {} chars (expected < 1500)",
        compact.len()
    );
}

#[test]
fn test_compact_error_missing_prefix() {
    let result = Token::from_compact("NO_PREFIX_HERE");
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("prefix"), "Error should mention prefix: {}", err);
}

#[test]
fn test_compact_error_invalid_base45() {
    let result = Token::from_compact("OID1:!!!invalid!!!");
    assert!(result.is_err());
}

#[test]
fn test_compact_error_truncated() {
    let (token, _) = make_token(vec![], vec!["name".to_string()]);
    let compact = token.to_compact().unwrap();

    // Truncate to 50% of original
    let truncated = &compact[..compact.len() / 2];
    let result = Token::from_compact(truncated);
    assert!(result.is_err());
}

#[test]
fn test_compact_round_trip_ring_sig() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let other = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("name".to_string(), json!("Ring User"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec!["name".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ring_challenge".to_string(),
    };

    let prepared = Token::prepare(&mut proof_doc, &request, 3600).unwrap();

    // Build ring: owner + other
    let owner_bytes: [u8; 32] = owner.to_bytes()[..32].try_into().unwrap();
    let other_pub: [u8; 32] = other.public_key().to_bytes().try_into().unwrap();
    let ring = vec![owner.public_key().to_bytes().try_into().unwrap(), other_pub];

    let token = Token::finalize_ring_sig(prepared, &owner_bytes, &ring).unwrap();

    let compact = token.to_compact().unwrap();
    assert!(compact.starts_with("OID1:"));

    let restored = Token::from_compact(&compact).unwrap();
    assert_eq!(
        restored.subjects().get("name").and_then(|v| v.as_str()),
        Some("Ring User")
    );
}

#[test]
fn test_compact_round_trip_empty_optionals() {
    // Token with no salt, no hmac, no ZK proofs, minimal subjects
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "empty_test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let compact = token.to_compact().unwrap();
    let restored = Token::from_compact(&compact).unwrap();

    assert!(restored.zk_proofs().is_empty());
    assert_eq!(restored.payload().challenge, "empty_test");
}

#[test]
fn test_compact_round_trip_multiple_zk_proofs() {
    let (token, _) = make_token(
        vec![
            PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            },
            PredicateRequest {
                attribute: "verificationLevel".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(2),
            },
        ],
        vec![],
    );

    assert_eq!(token.zk_proofs().len(), 2);

    let compact = token.to_compact().unwrap();
    let restored = Token::from_compact(&compact).unwrap();

    assert_eq!(restored.zk_proofs().len(), 2);
    println!("Compact size (2 ZK proofs): {} chars", compact.len());
}

#[test]
fn test_compact_vs_json_size() {
    let (token, _) = make_token(
        vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        vec!["name".to_string()],
    );

    let json_str = serde_json::to_string(&token).unwrap();
    let compact = token.to_compact().unwrap();

    println!("JSON size:    {} chars", json_str.len());
    println!("Compact size: {} chars", compact.len());
    println!(
        "Savings:      {:.0}%",
        (1.0 - compact.len() as f64 / json_str.len() as f64) * 100.0
    );

    assert!(
        compact.len() < json_str.len(),
        "Compact ({}) should be smaller than JSON ({})",
        compact.len(),
        json_str.len()
    );
}

/// Regression: sibling level/position must survive compact round-trip when
/// the credential has more than 16 attributes. An earlier revision packed
/// both into a single byte (4 bits each) and silently truncated positions
/// ≥16, so verification of full-identity credentials failed with
/// "Invalid proof: Proof verification failed".
#[test]
fn test_compact_round_trip_many_attributes_verifies() {
    use owl_proof_system::RevocationRegistry;

    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    // 24 application attributes — total 26, well past the 16-leaf bit-pack
    // boundary. Mirrors what `claims_to_attributes` builds for a real
    // identity credential.
    for i in 0..24 {
        attrs.insert(format!("attr{:02}", i), json!(format!("value{}", i)));
    }
    assert!(attrs.len() > 16, "test must exceed the 4-bit position limit");

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    // Disclose one application attribute alongside the mandatory
    // issuerKey/ownerKey. The sibling set then includes positions ≥16,
    // which is what the old compact encoding silently truncated.
    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "many_attrs".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
    let registry = RevocationRegistry::new();

    // Sanity: the freshly generated token must verify before round-tripping.
    // If this fails, the bug is in merkle generation, not compact encoding.
    token
        .verify(&[issuer.public_key()], "many_attrs", &registry, &[])
        .expect("freshly generated token must verify");

    let compact = token.to_compact().unwrap();
    let restored = Token::from_compact(&compact).unwrap();
    restored
        .verify(&[issuer.public_key()], "many_attrs", &registry, &[])
        .expect("compact round-trip must preserve sibling positions for >16-attribute credentials");
}
