use owl_crypto::{KeyPair, MerkleTree};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn test_full_merkle_proof_with_real_credential() {
    // Simulate a real credential with many attributes
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    let mut attributes = BTreeMap::new();
    attributes.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attributes.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attributes.insert("firstName".to_string(), json!("Alice"));
    attributes.insert("lastName".to_string(), json!("Smith"));
    attributes.insert("dateOfBirth".to_string(), json!("1990-01-15"));
    attributes.insert("nationality".to_string(), json!("US"));
    attributes.insert("over18".to_string(), json!(true));
    attributes.insert("over21".to_string(), json!(true));
    attributes.insert("licenseNumber".to_string(), json!("DL123456789"));
    attributes.insert("expiryDate".to_string(), json!("2025-12-31"));
    attributes.insert("address".to_string(), json!("123 Main St, City, State"));
    attributes.insert("eyeColor".to_string(), json!("brown"));

    // Build Merkle tree
    let tree = MerkleTree::from_attributes(&attributes);
    let root_hash = tree.root_hash();

    println!("Created tree with {} attributes", attributes.len());
    println!("Root hash: {}", hex::encode(root_hash));

    // Test 1: Selective disclosure - only reveal over18 and nationality
    println!("\n=== Test 1: Selective Disclosure (over18 + nationality) ===");
    let disclosed_keys = vec![
        "issuerKey".to_string(),
        "ownerKey".to_string(),
        "over18".to_string(),
        "nationality".to_string(),
    ];

    let proof = tree.generate_proof(&disclosed_keys).expect("Failed to generate proof");

    // Create disclosed attributes map
    let mut disclosed_attrs = BTreeMap::new();
    for key in &disclosed_keys {
        disclosed_attrs.insert(key.clone(), attributes[key].clone());
    }

    // Verify proof
    assert!(proof.verify(&disclosed_attrs), "Proof verification failed for selective disclosure");
    println!("✓ Selective disclosure proof verified successfully");

    // Test 2: Try to forge - change a value
    println!("\n=== Test 2: Forge Detection - Changed Value ===");
    let mut forged_attrs = disclosed_attrs.clone();
    forged_attrs.insert("over18".to_string(), json!(false)); // Change true to false

    assert!(!proof.verify(&forged_attrs), "Proof should fail with forged value");
    println!("✓ Forged value correctly rejected");

    // Test 3: Missing required attribute
    println!("\n=== Test 3: Missing Required Attribute ===");
    let mut missing_attrs = disclosed_attrs.clone();
    missing_attrs.remove("over18"); // Remove an attribute that's in the proof

    assert!(!proof.verify(&missing_attrs), "Proof should fail with missing attribute");
    println!("✓ Missing attribute correctly rejected");

    // Note: Adding extra attributes that aren't in the proof is allowed
    // The proof only verifies the attributes it discloses, not that those are ALL attributes

    // Test 4: Disclose many attributes
    println!("\n=== Test 4: Large Disclosure Set ===");
    let large_disclosure = vec![
        "issuerKey".to_string(),
        "ownerKey".to_string(),
        "firstName".to_string(),
        "lastName".to_string(),
        "nationality".to_string(),
        "over18".to_string(),
        "over21".to_string(),
        "licenseNumber".to_string(),
    ];

    let proof2 = tree.generate_proof(&large_disclosure).expect("Failed to generate large proof");

    let mut large_attrs = BTreeMap::new();
    for key in &large_disclosure {
        large_attrs.insert(key.clone(), attributes[key].clone());
    }

    assert!(proof2.verify(&large_attrs), "Large disclosure proof verification failed");
    println!("✓ Large disclosure proof verified successfully");

    // Test 5: Verify root hash consistency
    println!("\n=== Test 5: Root Hash Consistency ===");
    assert_eq!(proof.root_hash_hex(), hex::encode(root_hash), "Proof root hash mismatch");
    assert_eq!(proof2.root_hash_hex(), hex::encode(root_hash), "Proof2 root hash mismatch");
    println!("✓ Root hashes consistent across proofs");

    // Test 6: Empty disclosure should fail
    println!("\n=== Test 6: Empty Disclosure ===");
    let empty_proof = tree.generate_proof(&vec!["issuerKey".to_string(), "ownerKey".to_string()]);
    assert!(empty_proof.is_ok(), "Should allow minimal disclosure");

    let minimal_attrs = BTreeMap::from([
        ("issuerKey".to_string(), attributes["issuerKey"].clone()),
        ("ownerKey".to_string(), attributes["ownerKey"].clone()),
    ]);
    assert!(empty_proof.unwrap().verify(&minimal_attrs), "Minimal disclosure should verify");
    println!("✓ Minimal disclosure works");
}

#[test]
fn test_merkle_proof_with_complex_values() {
    println!("\n=== Testing Complex JSON Values ===");

    let mut attributes = BTreeMap::new();
    attributes.insert("issuerKey".to_string(), json!("issuer123"));
    attributes.insert("ownerKey".to_string(), json!("owner456"));
    attributes.insert("simpleString".to_string(), json!("hello"));
    attributes.insert("number".to_string(), json!(42));
    attributes.insert("decimal".to_string(), json!(3.14159));
    attributes.insert("boolean".to_string(), json!(true));
    attributes.insert("null".to_string(), json!(null));
    attributes.insert("array".to_string(), json!(["a", "b", "c"]));
    attributes.insert("object".to_string(), json!({"nested": "value", "count": 5}));

    let tree = MerkleTree::from_attributes(&attributes);

    // Disclose various types
    let keys = vec![
        "issuerKey".to_string(),
        "ownerKey".to_string(),
        "number".to_string(),
        "array".to_string(),
        "object".to_string(),
    ];

    let proof = tree.generate_proof(&keys).expect("Failed to generate proof");

    let mut disclosed = BTreeMap::new();
    for key in &keys {
        disclosed.insert(key.clone(), attributes[key].clone());
    }

    assert!(proof.verify(&disclosed), "Complex value proof verification failed");
    println!("✓ Complex JSON values verified successfully");

    // Test: Slightly different nested object should fail
    let mut forged = disclosed.clone();
    forged.insert("object".to_string(), json!({"nested": "different", "count": 5}));
    assert!(!proof.verify(&forged), "Should reject modified nested object");
    println!("✓ Modified nested object correctly rejected");
}

#[test]
fn test_merkle_proof_with_special_characters() {
    println!("\n=== Testing Special Characters ===");

    let mut attributes = BTreeMap::new();
    attributes.insert("issuerKey".to_string(), json!("issuer"));
    attributes.insert("ownerKey".to_string(), json!("owner"));
    attributes.insert("unicode".to_string(), json!("Hello 世界 🌍"));
    attributes.insert("quotes".to_string(), json!("He said \"hello\""));
    attributes.insert("newlines".to_string(), json!("Line1\nLine2\nLine3"));
    attributes.insert("special".to_string(), json!("!@#$%^&*()_+-=[]{}|;:',.<>?"));

    let tree = MerkleTree::from_attributes(&attributes);

    let keys = vec![
        "issuerKey".to_string(),
        "ownerKey".to_string(),
        "unicode".to_string(),
        "quotes".to_string(),
        "newlines".to_string(),
        "special".to_string(),
    ];

    let proof = tree.generate_proof(&keys).expect("Failed to generate proof");

    let mut disclosed = BTreeMap::new();
    for key in &keys {
        disclosed.insert(key.clone(), attributes[key].clone());
    }

    assert!(proof.verify(&disclosed), "Special characters proof failed");
    println!("✓ Special characters handled correctly");
}

#[test]
fn test_merkle_proof_determinism() {
    println!("\n=== Testing Determinism ===");

    let mut attributes = BTreeMap::new();
    attributes.insert("issuerKey".to_string(), json!("issuer"));
    attributes.insert("ownerKey".to_string(), json!("owner"));
    attributes.insert("attr1".to_string(), json!("value1"));
    attributes.insert("attr2".to_string(), json!("value2"));
    attributes.insert("attr3".to_string(), json!("value3"));

    // Build tree multiple times
    let tree1 = MerkleTree::from_attributes(&attributes);
    let tree2 = MerkleTree::from_attributes(&attributes);
    let tree3 = MerkleTree::from_attributes(&attributes);

    // All should have same root hash
    assert_eq!(tree1.root_hash(), tree2.root_hash(), "Trees should be deterministic");
    assert_eq!(tree2.root_hash(), tree3.root_hash(), "Trees should be deterministic");
    println!("✓ Tree construction is deterministic");

    // Generate proofs multiple times
    let keys = vec![
        "issuerKey".to_string(),
        "ownerKey".to_string(),
        "attr1".to_string(),
        "attr2".to_string(),
    ];

    let proof1 = tree1.generate_proof(&keys).unwrap();
    let proof2 = tree2.generate_proof(&keys).unwrap();
    let proof3 = tree3.generate_proof(&keys).unwrap();

    assert_eq!(proof1.root_hash_hex(), proof2.root_hash_hex(), "Proofs should be deterministic");
    assert_eq!(proof2.root_hash_hex(), proof3.root_hash_hex(), "Proofs should be deterministic");
    println!("✓ Proof generation is deterministic");
}

#[test]
fn test_merkle_proof_edge_cases() {
    println!("\n=== Testing Edge Cases ===");

    // Test: Tree with only required keys
    let mut minimal = BTreeMap::new();
    minimal.insert("issuerKey".to_string(), json!("issuer"));
    minimal.insert("ownerKey".to_string(), json!("owner"));

    let tree = MerkleTree::from_attributes(&minimal);
    let proof = tree.generate_proof(&vec!["issuerKey".to_string(), "ownerKey".to_string()])
        .expect("Failed to generate minimal proof");
    assert!(proof.verify(&minimal), "Minimal tree proof failed");
    println!("✓ Minimal tree (2 attributes) works");

    // Test: Tree with many attributes
    let mut large = BTreeMap::new();
    large.insert("issuerKey".to_string(), json!("issuer"));
    large.insert("ownerKey".to_string(), json!("owner"));
    for i in 0..100 {
        large.insert(format!("attr{}", i), json!(format!("value{}", i)));
    }

    let tree = MerkleTree::from_attributes(&large);
    let keys: Vec<String> = vec!["issuerKey".to_string(), "ownerKey".to_string(), "attr0".to_string(), "attr50".to_string(), "attr99".to_string()];
    let proof = tree.generate_proof(&keys).expect("Failed to generate large tree proof");

    let mut disclosed = BTreeMap::new();
    for key in &keys {
        disclosed.insert(key.clone(), large[key].clone());
    }

    assert!(proof.verify(&disclosed), "Large tree proof failed");
    println!("✓ Large tree (102 attributes) works");
}
