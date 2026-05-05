use owl_crypto::KeyPair;
use owl_proof_system::{Document, PredicateOp, PredicateRequest, ProofRequest, Token, RevocationRegistry};
use serde_json::json;
use std::collections::BTreeMap;

#[test]
fn test_complete_credential_flow_with_merkle_proofs() {
    println!("\n=== Complete Credential Flow Test ===");

    // Setup: Create issuer and credential owner
    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    println!("1. Created issuer and owner keypairs");

    // Step 1: Create a comprehensive credential document
    let mut attributes = BTreeMap::new();
    attributes.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attributes.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attributes.insert("credentialType".to_string(), json!("DriverLicense"));
    attributes.insert("firstName".to_string(), json!("John"));
    attributes.insert("lastName".to_string(), json!("Doe"));
    attributes.insert("dateOfBirth".to_string(), json!("1985-06-15"));
    attributes.insert("licenseNumber".to_string(), json!("DL98765432"));
    attributes.insert("expiryDate".to_string(), json!("2027-06-15"));
    attributes.insert("address".to_string(), json!("456 Oak Ave, Springfield"));

    let document = Document::new(attributes.clone()).expect("Failed to create document");
    println!("2. Created document with {} attributes", attributes.len());

    // Step 2: Issuer signs the document
    let mut proof_document = document.issue(&issuer);
    let root_hash = proof_document.root_hash().to_string();
    println!("3. Issuer signed document. Root hash: {}", root_hash);

    // Verify the document signature
    assert!(proof_document.verify(&issuer.public_key()).is_ok(),
        "Document signature verification failed");
    println!("4. Document signature verified");

    // Step 3: Verifier requests age proof + name disclosure
    let challenge = "random_challenge_abc123";
    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(21),
        }],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: challenge.to_string(),
    };
    println!("5. Verifier requests: disclose=[firstName], predicates=[age >= 21]");

    // Step 4: Owner creates a token with ZK proof
    let token = Token::generate(&mut proof_document, &request, &owner, 3600)
        .expect("Failed to generate token");
    println!("6. Token created with ZK proof");

    // Verify what's in the token
    let subjects = token.subjects();
    assert!(subjects.contains_key("issuerKey"), "Token missing issuerKey");
    assert!(subjects.contains_key("ownerKey"), "Token missing ownerKey");
    assert!(subjects.contains_key("firstName"), "Token missing firstName");
    assert!(!subjects.contains_key("licenseNumber"), "Token should not contain licenseNumber");
    assert!(!subjects.contains_key("address"), "Token should not contain address");
    assert!(!subjects.contains_key("dateOfBirth"), "dateOfBirth should not be disclosed");
    println!("7. Token contains only disclosed attributes (no sensitive data leaked)");

    // Step 5: Verifier validates the token
    let registry = RevocationRegistry::new();
    let trusted_issuers = vec![issuer.public_key()];

    let verify_result = token.verify(&trusted_issuers, challenge, &registry, &[]);
    assert!(verify_result.is_ok(), "Token verification failed: {:?}", verify_result.err());
    println!("8. Token verified successfully!");

    // Step 6: Verify with wrong challenge (should fail)
    let wrong_challenge = "wrong_challenge";
    let verify_result = token.verify(&trusted_issuers, wrong_challenge, &registry, &[]);
    assert!(verify_result.is_err(), "Token should fail with wrong challenge");
    println!("9. Wrong challenge correctly rejected");

    // Step 7: Verify with untrusted issuer (should fail)
    let fake_issuer = KeyPair::generate();
    let untrusted_issuers = vec![fake_issuer.public_key()];
    let verify_result = token.verify(&untrusted_issuers, challenge, &registry, &[]);
    assert!(verify_result.is_err(), "Token should fail with untrusted issuer");
    println!("10. Untrusted issuer correctly rejected");

    // Step 8: Test revocation
    registry.revoke(
        root_hash.clone(),
        issuer.public_key().to_hex(),
        Some("License suspended".to_string()),
    );
    let verify_result = token.verify(&trusted_issuers, challenge, &registry, &[]);
    assert!(verify_result.is_err(), "Token should fail when revoked");
    println!("11. Revoked credential correctly rejected");

    // Step 9: Reactivate and verify again
    registry.reactivate(
        root_hash,
        issuer.public_key().to_hex(),
    );
    let verify_result = token.verify(&trusted_issuers, challenge, &registry, &[]);
    assert!(verify_result.is_ok(), "Token should succeed after reactivation");
    println!("12. Reactivated credential verified successfully");

    println!("\n=== All tests passed! ===");
}

#[test]
fn test_attempt_to_forge_token_attributes() {
    println!("\n=== Token Forgery Resistance Test ===");

    let issuer = KeyPair::generate();
    let owner = KeyPair::generate();

    // Create a legitimate credential
    let mut attributes = BTreeMap::new();
    attributes.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
    attributes.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    attributes.insert("name".to_string(), json!("Minor"));

    let document = Document::new(attributes).expect("Failed to create document");
    let mut proof_document = document.issue(&issuer);

    // Create a token disclosing name
    let challenge = "challenge_xyz";
    let request = ProofRequest {
        disclose: vec!["name".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer.public_key().to_hex()],
        challenge: challenge.to_string(),
    };

    let token = Token::generate(&mut proof_document, &request, &owner, 3600)
        .expect("Failed to generate token");

    // Serialize and deserialize (simulating transmission)
    let token_json = serde_json::to_string(&token).expect("Failed to serialize");
    let mut token_value: serde_json::Value = serde_json::from_str(&token_json).expect("Failed to parse");

    println!("1. Created legitimate token");

    // Attempt: Try to change the name value in the payload
    println!("2. Attempting to forge name value...");
    if let Some(subjects) = token_value["payload"]["subjects"].as_object_mut() {
        subjects.insert("name".to_string(), json!("Admin"));
    }

    let forged_token: Result<Token, _> = serde_json::from_value(token_value);
    assert!(forged_token.is_ok(), "Token should deserialize");

    let forged_token = forged_token.unwrap();
    let registry = RevocationRegistry::new();
    let trusted_issuers = vec![issuer.public_key()];

    // This should fail because the Merkle proof won't match the forged value
    let result = forged_token.verify(&trusted_issuers, challenge, &registry, &[]);
    assert!(result.is_err(), "Forged attribute should be rejected");
    println!("3. Forged attribute correctly detected and rejected");

    // Verify original token still works
    let result = token.verify(&trusted_issuers, challenge, &registry, &[]);
    assert!(result.is_ok(), "Original token should still work");
    println!("4. Original token still verifies correctly");

    println!("\n=== Forgery resistance confirmed! ===");
}

#[test]
fn test_multiple_credentials_same_owner() {
    println!("\n=== Multiple Credentials Test ===");

    let issuer1 = KeyPair::generate(); // DMV
    let issuer2 = KeyPair::generate(); // University
    let owner = KeyPair::generate();

    // Credential 1: Driver's License
    let mut license_attrs = BTreeMap::new();
    license_attrs.insert("issuerKey".to_string(), json!(issuer1.public_key().to_hex()));
    license_attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    license_attrs.insert("type".to_string(), json!("DriversLicense"));
    license_attrs.insert("dateOfBirth".to_string(), json!("1990-01-01"));

    let license_doc = Document::new(license_attrs).unwrap();
    let mut license_proof = license_doc.issue(&issuer1);

    // Credential 2: Diploma
    let mut diploma_attrs = BTreeMap::new();
    diploma_attrs.insert("issuerKey".to_string(), json!(issuer2.public_key().to_hex()));
    diploma_attrs.insert("ownerKey".to_string(), json!(owner.public_key().to_hex()));
    diploma_attrs.insert("type".to_string(), json!("Diploma"));
    diploma_attrs.insert("degree".to_string(), json!("Bachelor of Science"));
    diploma_attrs.insert("graduated".to_string(), json!(true));

    let diploma_doc = Document::new(diploma_attrs).unwrap();
    let mut diploma_proof = diploma_doc.issue(&issuer2);

    println!("1. Created two different credentials for same owner");

    // Create tokens for each
    let challenge = "multi_cred_challenge";

    let license_request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(21),
        }],
        trusted_issuers: vec![issuer1.public_key().to_hex()],
        challenge: challenge.to_string(),
    };

    let diploma_request = ProofRequest {
        disclose: vec!["graduated".to_string(), "degree".to_string()],
        predicates: vec![],
        trusted_issuers: vec![issuer2.public_key().to_hex()],
        challenge: challenge.to_string(),
    };

    let license_token = Token::generate(&mut license_proof, &license_request, &owner, 3600).unwrap();
    let diploma_token = Token::generate(&mut diploma_proof, &diploma_request, &owner, 3600).unwrap();

    println!("2. Created tokens from both credentials");

    // Verify both tokens
    let registry = RevocationRegistry::new();
    let trusted1 = vec![issuer1.public_key()];
    let trusted2 = vec![issuer2.public_key()];

    assert!(license_token.verify(&trusted1, challenge, &registry, &[]).is_ok());
    assert!(diploma_token.verify(&trusted2, challenge, &registry, &[]).is_ok());
    println!("3. Both tokens verify correctly with their respective issuers");

    // License token should fail with university issuer
    assert!(license_token.verify(&trusted2, challenge, &registry, &[]).is_err());
    // Diploma token should fail with DMV issuer
    assert!(diploma_token.verify(&trusted1, challenge, &registry, &[]).is_err());
    println!("4. Cross-issuer verification correctly fails");

    // Both should work with combined trusted issuers list
    let all_trusted = vec![issuer1.public_key(), issuer2.public_key()];
    assert!(license_token.verify(&all_trusted, challenge, &registry, &[]).is_ok());
    assert!(diploma_token.verify(&all_trusted, challenge, &registry, &[]).is_ok());
    println!("5. Both tokens verify with combined trusted issuer list");

    println!("\n=== Multiple credentials test passed! ===");
}
