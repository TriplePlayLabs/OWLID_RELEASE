//! T-021: Property-based tests for owl-proof-system

use owl_crypto::KeyPair;
use owl_proof_system::{Document, ProofRequest, RevocationRegistry, Token};
use proptest::prelude::*;
use serde_json::json;
use std::collections::BTreeMap;

// ============================================================================
// Token creation and verification properties
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// Any valid credential + selective disclosure roundtrips through generate/verify
    #[test]
    fn token_roundtrip(
        num_attrs in 1usize..5,
        ttl in 60i64..86400,
    ) {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        let mut extra_keys = Vec::new();
        for i in 0..num_attrs {
            let key = format!("attr{}", i);
            attrs.insert(key.clone(), json!(format!("value{}", i)));
            extra_keys.push(key);
        }

        let doc = Document::new(attrs.clone()).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        let challenge = "test_challenge";

        let request = ProofRequest {
            disclose: extra_keys.clone(),
            predicates: vec![],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: challenge.to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, ttl).unwrap();
        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];

        prop_assert!(token.verify(&trusted, challenge, &registry, &[]).is_ok());
    }

    /// Revoked credentials always fail verification
    #[test]
    fn revoked_always_fails(
        reason in "[a-zA-Z ]{0,64}",
    ) {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("data".to_string(), json!("test"));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);
        let root_hash = proof_doc.root_hash().to_string();

        let challenge = "challenge";
        let request = ProofRequest {
            disclose: vec!["data".to_string()],
            predicates: vec![],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: challenge.to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
        let registry = RevocationRegistry::new();

        // Verify works before revocation
        let trusted = vec![issuer.public_key()];
        prop_assert!(token.verify(&trusted, challenge, &registry, &[]).is_ok());

        // Revoke and verify fails
        registry.revoke(root_hash, issuer.public_key().to_hex(), Some(reason));
        prop_assert!(token.verify(&trusted, challenge, &registry, &[]).is_err());
    }

    /// Wrong challenge always fails
    #[test]
    fn wrong_challenge_fails(
        challenge1 in "[a-z]{8,16}",
        challenge2 in "[A-Z]{8,16}",
    ) {
        prop_assume!(challenge1 != challenge2.to_lowercase());

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
            challenge: challenge1.clone(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();
        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];

        // Correct challenge passes
        prop_assert!(token.verify(&trusted, &challenge1, &registry, &[]).is_ok());
        // Wrong challenge fails
        prop_assert!(token.verify(&trusted, &challenge2, &registry, &[]).is_err());
    }
}

// ============================================================================
// Document serialization properties
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// ProofDocument serializes and deserializes correctly
    #[test]
    fn document_serde_roundtrip(
        first_name in "[A-Z][a-z]{1,16}",
        last_name in "[A-Z][a-z]{1,16}",
        age in 0u32..150,
    ) {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("firstName".to_string(), json!(first_name));
        attrs.insert("lastName".to_string(), json!(last_name));
        attrs.insert("age".to_string(), json!(age));

        let doc = Document::new(attrs).unwrap();
        let proof_doc = doc.issue(&issuer);

        // Serialize and deserialize
        let json_str = serde_json::to_string(&proof_doc).unwrap();
        let deserialized: owl_proof_system::ProofDocument = serde_json::from_str(&json_str).unwrap();

        prop_assert_eq!(proof_doc.root_hash(), deserialized.root_hash());
    }

    /// Token serializes and deserializes correctly
    #[test]
    fn token_serde_roundtrip(
        value in "[a-z]{1,16}",
    ) {
        let issuer = KeyPair::generate();
        let owner = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
        attrs.insert("attr".to_string(), json!(value));

        let doc = Document::new(attrs).unwrap();
        let mut proof_doc = doc.issue(&issuer);

        let request = ProofRequest {
            disclose: vec!["attr".to_string()],
            predicates: vec![],
            trusted_issuers: vec![issuer.public_key().to_hex()],
            challenge: "challenge".to_string(),
        };

        let token = Token::generate(&mut proof_doc, &request, &owner, 3600).unwrap();

        // Serialize and deserialize
        let json_str = serde_json::to_string(&token).unwrap();
        let deserialized: Token = serde_json::from_str(&json_str).unwrap();

        // Verify the deserialized token
        let registry = RevocationRegistry::new();
        let trusted = vec![issuer.public_key()];
        prop_assert!(deserialized.verify(&trusted, "challenge", &registry, &[]).is_ok());
    }
}
