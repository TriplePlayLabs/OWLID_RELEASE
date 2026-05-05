//! T-021: Property-based tests for owl-crypto

use owl_crypto::{hash_attribute, hash_attribute_salted, generate_salt};
use owl_crypto::{KeyPair, MerkleTree, SignatureAlgorithm};
use proptest::prelude::*;
use serde_json::json;
use std::collections::BTreeMap;

// ============================================================================
// Hash consistency properties
// ============================================================================

proptest! {
    /// Same input always produces same hash output
    #[test]
    fn hash_is_deterministic(key in "[a-zA-Z0-9_]{1,64}", value in ".*") {
        let json_val = json!(value);
        let h1 = hash_attribute(&key, &json_val);
        let h2 = hash_attribute(&key, &json_val);
        prop_assert_eq!(h1, h2);
    }

    /// Different keys produce different hashes (with high probability)
    #[test]
    fn different_keys_different_hashes(
        key1 in "[a-z]{1,32}",
        key2 in "[A-Z]{1,32}",
        value in ".*"
    ) {
        prop_assume!(key1 != key2.to_lowercase());
        let json_val = json!(value);
        let h1 = hash_attribute(&key1, &json_val);
        let h2 = hash_attribute(&key2, &json_val);
        prop_assert_ne!(h1, h2);
    }

    /// Salted hash with same salt is deterministic
    #[test]
    fn salted_hash_deterministic(key in "[a-zA-Z0-9_]{1,64}", value in ".*") {
        let salt = generate_salt();
        let json_val = json!(value);
        let h1 = hash_attribute_salted(&key, &json_val, &salt);
        let h2 = hash_attribute_salted(&key, &json_val, &salt);
        prop_assert_eq!(h1, h2);
    }

    /// Different salts produce different hashes
    #[test]
    fn different_salts_different_hashes(key in "[a-zA-Z0-9_]{1,32}", value in ".*") {
        let salt1 = generate_salt();
        let salt2 = generate_salt();
        let json_val = json!(value);
        let h1 = hash_attribute_salted(&key, &json_val, &salt1);
        let h2 = hash_attribute_salted(&key, &json_val, &salt2);
        // Different salts should (almost certainly) produce different hashes
        prop_assert_ne!(h1, h2);
    }
}

// ============================================================================
// Signature round-trip properties
// ============================================================================

proptest! {
    /// Any message signed with Ed25519 roundtrips through sign/verify
    #[test]
    fn ed25519_sign_verify_roundtrip(msg in proptest::collection::vec(any::<u8>(), 0..1024)) {
        let kp = KeyPair::generate();
        let sig = kp.sign(&msg);
        prop_assert!(kp.public_key().verify(&msg, &sig).is_ok());
    }

    /// Signature fails with wrong message
    #[test]
    fn ed25519_wrong_message_fails(
        msg1 in proptest::collection::vec(any::<u8>(), 1..512),
        msg2 in proptest::collection::vec(any::<u8>(), 1..512),
    ) {
        prop_assume!(msg1 != msg2);
        let kp = KeyPair::generate();
        let sig = kp.sign(&msg1);
        prop_assert!(kp.public_key().verify(&msg2, &sig).is_err());
    }

    /// Signature fails with wrong key
    #[test]
    fn ed25519_wrong_key_fails(msg in proptest::collection::vec(any::<u8>(), 0..512)) {
        let kp1 = KeyPair::generate();
        let kp2 = KeyPair::generate();
        let sig = kp1.sign(&msg);
        prop_assert!(kp2.public_key().verify(&msg, &sig).is_err());
    }

    /// P-256 sign/verify roundtrip
    #[test]
    fn p256_sign_verify_roundtrip(msg in proptest::collection::vec(any::<u8>(), 1..1024)) {
        let kp = KeyPair::generate_with_algorithm(SignatureAlgorithm::EcdsaP256);
        let sig = kp.sign(&msg);
        prop_assert!(kp.public_key().verify(&msg, &sig).is_ok());
    }
}

// ============================================================================
// Merkle tree properties
// ============================================================================

proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// Any BTreeMap produces a valid tree with verifiable proofs
    #[test]
    fn merkle_tree_any_attributes(
        extra_keys in proptest::collection::vec("[a-z]{1,16}", 1..10),
        extra_values in proptest::collection::vec(".*", 1..10),
    ) {
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("issuer_pub_key"));
        attrs.insert("ownerKey".to_string(), json!("owner_pub_key"));

        for (k, v) in extra_keys.iter().zip(extra_values.iter()) {
            attrs.insert(k.clone(), json!(v));
        }

        let tree = MerkleTree::from_attributes(&attrs);
        let root = tree.root_hash();

        // Root hash should be non-empty
        prop_assert!(!root.is_empty());

        // Generate proof for all keys
        let keys: Vec<String> = attrs.keys().cloned().collect();
        let proof = tree.generate_proof(&keys).unwrap();

        // Proof should verify against original attributes
        prop_assert!(proof.verify(&attrs));
    }

    /// Merkle tree root hash is deterministic for same input
    #[test]
    fn merkle_tree_deterministic(
        keys in proptest::collection::vec("[a-z]{1,8}", 2..8),
        values in proptest::collection::vec("[a-z]{1,16}", 2..8),
    ) {
        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("ik"));
        attrs.insert("ownerKey".to_string(), json!("ok"));
        for (k, v) in keys.iter().zip(values.iter()) {
            attrs.insert(k.clone(), json!(v));
        }

        let tree1 = MerkleTree::from_attributes(&attrs);
        let tree2 = MerkleTree::from_attributes(&attrs);
        prop_assert_eq!(tree1.root_hash(), tree2.root_hash());
    }

    /// Modifying any attribute invalidates the proof
    #[test]
    fn merkle_tree_tamper_detection(
        value1 in "[a-z]{1,16}",
        value2 in "[A-Z]{1,16}",
    ) {
        prop_assume!(value1 != value2.to_lowercase());

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!("ik"));
        attrs.insert("ownerKey".to_string(), json!("ok"));
        attrs.insert("attr".to_string(), json!(value1));

        let tree = MerkleTree::from_attributes(&attrs);
        let keys = vec!["issuerKey".to_string(), "ownerKey".to_string(), "attr".to_string()];
        let proof = tree.generate_proof(&keys).unwrap();

        // Original should verify
        prop_assert!(proof.verify(&attrs));

        // Tampered should fail
        let mut tampered = attrs.clone();
        tampered.insert("attr".to_string(), json!(value2));
        prop_assert!(!proof.verify(&tampered));
    }
}
