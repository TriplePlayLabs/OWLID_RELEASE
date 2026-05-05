//! Integration tests for the unified proof system
//!
//! Tests that ProofRequest + Token::generate() / Token::prepare()
//! correctly orchestrate ZK proofs, Merkle selective disclosure, and
//! various signing methods (Ed25519, ring sig, WebAuthn-like).

use owl_crypto::KeyPair;
use owl_proof_system::{
    Document, PredicateOp, PredicateRequest, ProofRequest, Token,
    RevocationRegistry,
};
use serde_json::json;
use std::collections::BTreeMap;

/// Helper: create and issue a credential with common identity attributes
fn issue_credential(
    issuer: &KeyPair,
    owner: &KeyPair,
    extra_attrs: BTreeMap<String, serde_json::Value>,
) -> owl_proof_system::ProofDocument {
    let mut attrs = BTreeMap::new();
    attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    for (k, v) in extra_attrs {
        attrs.insert(k, v);
    }
    let doc = Document::new(attrs).unwrap();
    doc.issue(issuer)
}

// =========================================================================
// Test 1: Age predicate — prove age >= 18 from dateOfBirth
// =========================================================================
#[test]
fn test_age_predicate() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("dateOfBirth".to_string(), json!("1999-01-15"));
    extra.insert("firstName".to_string(), json!("Alice"));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "age-test-challenge".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    // Verify succeeds
    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "age-test-challenge", &registry, &[]).is_ok());

    // firstName is disclosed
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));

    // dateOfBirth is NOT disclosed (it's committed, not in subjects)
    assert!(token.subjects().get("dateOfBirth").is_none());

    // committed_attributes contains dateOfBirth
    assert!(token.payload().committed_attributes.contains_key("dateOfBirth"));

    // ZK proofs are present
    assert!(!token.zk_proofs().is_empty());
}

// =========================================================================
// Test 2: Fake age fails — swapped attribute_leaf_hash breaks binding
// =========================================================================
#[test]
fn test_fake_age_binding_fails() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    // Credential 1: young person
    let mut extra1 = BTreeMap::new();
    extra1.insert("dateOfBirth".to_string(), json!("1999-01-15"));
    let mut proof_doc1 = issue_credential(&issuer, &owner, extra1);

    // Credential 2: different person
    let owner2 = KeyPair::generate();
    let mut extra2 = BTreeMap::new();
    extra2.insert("dateOfBirth".to_string(), json!("2010-06-01"));
    let mut proof_doc2 = issue_credential(&issuer, &owner2, extra2);

    // Generate a valid token for credential 1
    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "binding-test".to_string(),
    };

    let token = Token::generate(&mut proof_doc1, &request, &owner, 3600).unwrap();

    // Tamper: replace committed_attributes leaf hash with one from credential 2
    let tampered_leaf_hash = proof_doc2.leaf_hash_hex("dateOfBirth").unwrap();

    // Deserialize, tamper, reserialize
    let mut token_json: serde_json::Value = serde_json::to_value(&token).unwrap();
    token_json["payload"]["committed_attributes"]["dateOfBirth"] =
        json!(tampered_leaf_hash);

    // The Merkle proof verification should fail because the tampered leaf hash
    // doesn't match the actual leaf in the Merkle proof
    let tampered_token: Token = serde_json::from_value(token_json).unwrap();
    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    let result = tampered_token.verify(&trusted, "binding-test", &registry, &[]);
    assert!(result.is_err(), "Tampered binding should fail verification");
}

// =========================================================================
// Test 3: Nationality predicate — InSet
// =========================================================================
#[test]
fn test_nationality_predicate() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("nationality".to_string(), json!("NL"));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "nationality".to_string(),
            op: PredicateOp::InSet,
            value: json!("eu"),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "nat-test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "nat-test", &registry, &[]).is_ok());

    // nationality should NOT be in subjects (committed only)
    assert!(token.subjects().get("nationality").is_none());
}

// =========================================================================
// Test 4: KYC predicate — verificationLevel >= 2
// =========================================================================
#[test]
fn test_kyc_predicate() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("verificationLevel".to_string(), json!("substantial"));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "verificationLevel".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(2),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "kyc-test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "kyc-test", &registry, &[]).is_ok());
}

// =========================================================================
// Test 5: Mixed disclosure + predicates
// =========================================================================
#[test]
fn test_mixed_disclosure_and_predicates() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("firstName".to_string(), json!("Bob"));
    extra.insert("lastName".to_string(), json!("Smith"));
    extra.insert("dateOfBirth".to_string(), json!("1995-03-20"));
    extra.insert("nationality".to_string(), json!("DE"));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![
            PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            },
        ],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "mixed-test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "mixed-test", &registry, &[]).is_ok());

    // firstName visible
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Bob")));
    // dateOfBirth hidden but proven
    assert!(token.subjects().get("dateOfBirth").is_none());
    // ZK proof attached
    assert!(!token.zk_proofs().is_empty());
}

// =========================================================================
// Test 6: isResident predicate — boolean mapped to KYC circuit
// =========================================================================
#[test]
fn test_is_resident_predicate() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("isResident".to_string(), json!(true));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "isResident".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(1),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "resident-test".to_string(),
    };

    let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "resident-test", &registry, &[]).is_ok());

    // isResident should NOT be in subjects (committed only)
    assert!(token.subjects().get("isResident").is_none());
    assert!(token.payload().committed_attributes.contains_key("isResident"));
    assert!(!token.zk_proofs().is_empty());
}

// =========================================================================
// Test 7: Combined predicate + ring signature
// =========================================================================
#[test]
fn test_predicate_with_ring_sig() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();
    let decoy1 = KeyPair::generate();
    let decoy2 = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("dateOfBirth".to_string(), json!("1990-07-04"));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "ring-pred-test".to_string(),
    };

    let prepared = Token::prepare(&mut proof_doc, &request, 3600).unwrap();

    // Build ring — convert Vec<u8> to [u8; 32]
    let to_32 = |v: Vec<u8>| -> [u8; 32] { v.try_into().unwrap() };
    let ring: Vec<[u8; 32]> = vec![
        to_32(owner.public_key().to_bytes()),
        to_32(decoy1.public_key().to_bytes()),
        to_32(decoy2.public_key().to_bytes()),
    ];

    let owner_bytes = owner.to_bytes();
    let private_key: [u8; 32] = owner_bytes[..32].try_into().unwrap();
    let token = Token::finalize_ring_sig(prepared, &private_key, &ring).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "ring-pred-test", &registry, &[]).is_ok());
}

// =========================================================================
// Test 8: Predicate + standard Ed25519 via prepare + finalize_standard
// =========================================================================
#[test]
fn test_predicate_with_prepare_finalize_standard() {
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut extra = BTreeMap::new();
    extra.insert("dateOfBirth".to_string(), json!("2000-12-25"));
    extra.insert("firstName".to_string(), json!("Eve"));
    let mut proof_doc = issue_credential(&issuer, &owner, extra);

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: "prepare-test".to_string(),
    };

    let prepared = Token::prepare(&mut proof_doc, &request, 3600).unwrap();
    let token = Token::finalize_standard(prepared, &owner).unwrap();

    let registry = RevocationRegistry::new();
    let trusted = vec![issuer.public_key()];
    assert!(token.verify(&trusted, "prepare-test", &registry, &[]).is_ok());
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Eve")));
}
