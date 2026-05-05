//! Integration tests for ZK circuits and ring signatures in token flow

use owl_crypto::KeyPair;
use owl_proof_system::{
    Document, PredicateOp, PredicateRequest, ProofRequest, RevocationRegistry, Token,
};
use serde_json::json;
use std::collections::BTreeMap;

// ============================================================================
// ZK Proof Integration Tests
// ============================================================================

#[test]
fn test_token_with_zk_age_proof() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("dateOfBirth".to_string(), json!("1999-01-15"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "zk_test_challenge".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    let result = token.verify(&trusted, "zk_test_challenge", &registry);
    assert!(result.is_ok(), "Token with ZK proof should verify: {:?}", result.err());
    assert_eq!(token.zk_proofs().len(), 1);
}

#[test]
fn test_token_with_multiple_zk_proofs() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("dateOfBirth".to_string(), json!("1994-06-15"));
    attrs.insert("verificationLevel".to_string(), json!("substantial"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![
            PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            },
            PredicateRequest {
                attribute: "verificationLevel".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(1),
            },
        ],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "multi_zk_test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    let result = token.verify(&trusted, "multi_zk_test", &registry);
    assert!(result.is_ok(), "Token with multiple ZK proofs should verify: {:?}", result.err());
    assert_eq!(token.zk_proofs().len(), 2);
}

#[test]
fn test_token_without_zk_proofs_still_works() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("data".to_string(), json!("test"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec!["data".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "no_zk_test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "no_zk_test", &registry).is_ok());
    assert_eq!(token.zk_proofs().len(), 0);
}

// ============================================================================
// Ring Signature Integration Tests
// ============================================================================

#[test]
fn test_token_with_ring_signature() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let other1 = KeyPair::generate();
    let other2 = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("data".to_string(), json!("anonymous_test"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec!["data".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ring_sig_test".to_string(),
    };

    // Prepare the token
    let prepared = Token::prepare(&mut proof_doc, &request, 3600).unwrap();

    // Create ring of public keys (owner + 2 decoys)
    let owner_private: [u8; 32] = owner.to_bytes()[..32].try_into().unwrap();
    let owner_pub_bytes: [u8; 32] = owner
        .public_key()
        .to_bytes()
        .try_into()
        .unwrap();
    let other1_pub_bytes: [u8; 32] = other1
        .public_key()
        .to_bytes()
        .try_into()
        .unwrap();
    let other2_pub_bytes: [u8; 32] = other2
        .public_key()
        .to_bytes()
        .try_into()
        .unwrap();

    let ring = [owner_pub_bytes, other1_pub_bytes, other2_pub_bytes];

    let token = Token::finalize_ring_sig(prepared, &owner_private, &ring).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    let result = token.verify(&trusted, "ring_sig_test", &registry);
    assert!(result.is_ok(), "Ring signature token should verify: {:?}", result.err());
}

#[test]
fn test_ring_signature_token_serialization_roundtrip() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let other = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("attr".to_string(), json!("value"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec!["attr".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ring_serde_test".to_string(),
    };

    let prepared = Token::prepare(&mut proof_doc, &request, 3600).unwrap();

    let owner_private: [u8; 32] = owner.to_bytes()[..32].try_into().unwrap();
    let owner_pub: [u8; 32] = owner.public_key().to_bytes().try_into().unwrap();
    let other_pub: [u8; 32] = other.public_key().to_bytes().try_into().unwrap();
    let ring = [owner_pub, other_pub];

    let token = Token::finalize_ring_sig(prepared, &owner_private, &ring).unwrap();

    // Serialize and deserialize
    let json_str = serde_json::to_string(&token).unwrap();
    let deserialized: Token = serde_json::from_str(&json_str).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    let result = deserialized.verify(&trusted, "ring_serde_test", &registry);
    assert!(result.is_ok(), "Deserialized ring sig token should verify: {:?}", result.err());
}

// ============================================================================
// Combined ZK + Ring Signature Test
// ============================================================================

#[test]
fn test_token_with_ring_signature_and_zk_proof() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let other = KeyPair::generate();

    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attrs.insert("dateOfBirth".to_string(), json!("1999-01-15"));

    let doc = Document::new(attrs).unwrap();
    let mut proof_doc = doc.issue(&issuer);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "combined_test".to_string(),
    };

    // Prepare token with ZK proofs automatically generated
    let prepared = Token::prepare(&mut proof_doc, &request, 3600).unwrap();

    let owner_private: [u8; 32] = owner.to_bytes()[..32].try_into().unwrap();
    let owner_pub: [u8; 32] = owner.public_key().to_bytes().try_into().unwrap();
    let other_pub: [u8; 32] = other.public_key().to_bytes().try_into().unwrap();
    let ring = [owner_pub, other_pub];

    // Finalize with ring signature - ZK proofs are already in the payload
    let token = Token::finalize_ring_sig(prepared, &owner_private, &ring).unwrap();

    // Verify - both ring signature AND ZK proof should be checked
    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    let result = token.verify(&trusted, "combined_test", &registry);
    assert!(
        result.is_ok(),
        "Token with ring sig + ZK proof should verify: {:?}",
        result.err()
    );
}
