//! End-to-end test for the unified proof system.
//!
//! Simulates a real-world scenario: a government issues an identity credential,
//! a user presents it to multiple verifiers (bar, employer, EU border), and each
//! verifier requests different proof combinations. Tests the full chain:
//!
//!   Issuer creates credential
//!     → Owner receives ProofDocument
//!       → Verifier sends ProofRequest
//!         → System auto-generates ZK proofs + Merkle disclosure
//!           → Token signed (Ed25519 / ring sig)
//!             → Verifier validates token (Merkle + ZK binding + signature)
//!               → Tampering / revocation correctly rejected

use owl_crypto::KeyPair;
use owl_proof_system::{
    Document, PredicateOp, PredicateRequest, ProofRequest,
    RevocationRegistry, Token,
};
use serde_json::json;
use std::collections::BTreeMap;

// ============================================================================
// Scenario setup: Dutch government issues identity credential to Alice
// ============================================================================

struct TestWorld {
    issuer: KeyPair,     // Government
    alice: KeyPair,      // Credential holder
    proof_doc: owl_proof_system::ProofDocument,
    registry: RevocationRegistry,
}

impl TestWorld {
    fn new() -> Self {
        let issuer = KeyPair::generate();
        let alice = KeyPair::generate();

        let mut attrs = BTreeMap::new();
        attrs.insert("issuerKey".to_string(), json!(issuer.public_key().to_hex()));
        attrs.insert("ownerKey".to_string(), json!(alice.public_key().to_hex()));
        attrs.insert("firstName".to_string(), json!("Alice"));
        attrs.insert("lastName".to_string(), json!("van der Berg"));
        attrs.insert("dateOfBirth".to_string(), json!("1999-03-15"));
        attrs.insert("nationality".to_string(), json!("NL"));
        attrs.insert("verificationLevel".to_string(), json!("substantial"));
        attrs.insert("documentNumber".to_string(), json!("NL-ID-98765"));
        attrs.insert("isOver18".to_string(), json!(true));
        attrs.insert("isEuCitizen".to_string(), json!(true));

        let doc = Document::new(attrs).unwrap();
        let proof_doc = doc.issue(&issuer);
        let registry = RevocationRegistry::new();

        TestWorld { issuer, alice, proof_doc, registry }
    }

    fn trusted(&self) -> Vec<owl_crypto::PublicKey> {
        vec![self.issuer.public_key()]
    }
}

// ============================================================================
// E2E Test 1: Bar bouncer — "prove you're over 18" (age predicate only)
// ============================================================================

#[test]
fn e2e_bar_age_check() {
    println!("\n=== E2E: Bar Age Check ===");
    let mut w = TestWorld::new();

    // Verifier sends proof request
    let request = ProofRequest {
        disclose: vec![],  // No personal info needed!
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "bar-challenge-001".to_string(),
    };

    // System automatically: extracts dateOfBirth → computes age → generates ZK proof
    //                        + builds Merkle proof with dateOfBirth committed (not disclosed)
    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 300).unwrap();

    println!("1. Token created");
    println!("   Disclosed attributes: {:?}", token.subjects().keys().collect::<Vec<_>>());
    println!("   Committed attributes: {:?}", token.payload().committed_attributes.keys().collect::<Vec<_>>());
    println!("   ZK proofs: {}", token.zk_proofs().len());

    // dateOfBirth is NOT visible to the bar
    assert!(token.subjects().get("dateOfBirth").is_none(), "dateOfBirth should NOT be disclosed");
    assert!(token.subjects().get("firstName").is_none(), "firstName should NOT be disclosed");
    assert!(token.subjects().get("documentNumber").is_none(), "documentNumber should NOT be disclosed");

    // dateOfBirth IS committed (leaf hash in Merkle proof)
    assert!(token.payload().committed_attributes.contains_key("dateOfBirth"),
        "dateOfBirth should be committed");

    // ZK proof is attached
    assert_eq!(token.zk_proofs().len(), 1, "Should have exactly 1 ZK proof");

    // Verify succeeds
    let result = token.verify(&w.trusted(), "bar-challenge-001", &w.registry);
    assert!(result.is_ok(), "Verification should succeed: {:?}", result.err());
    println!("2. ✓ Verification passed — bouncer confirms Alice is over 18");

    // Serialize round-trip (simulate network transfer)
    let json = serde_json::to_string(&token).unwrap();
    let deserialized: Token = serde_json::from_str(&json).unwrap();
    let result = deserialized.verify(&w.trusted(), "bar-challenge-001", &w.registry);
    assert!(result.is_ok(), "Deserialized token should verify: {:?}", result.err());
    println!("3. ✓ Serialization round-trip verified");

    println!("=== Bar Age Check PASSED ===\n");
}

// ============================================================================
// E2E Test 2: Employer — "show me your name and prove KYC level >= 2"
// ============================================================================

#[test]
fn e2e_employer_kyc_check() {
    println!("\n=== E2E: Employer KYC Check ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string(), "lastName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "verificationLevel".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(2), // "substantial" = 2
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "employer-challenge-002".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    println!("1. Token created");
    println!("   Disclosed: {:?}", token.subjects().keys().collect::<Vec<_>>());
    println!("   Committed: {:?}", token.payload().committed_attributes.keys().collect::<Vec<_>>());

    // Name is visible
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));
    assert_eq!(token.subjects().get("lastName"), Some(&json!("van der Berg")));

    // verificationLevel is committed, not disclosed
    assert!(token.subjects().get("verificationLevel").is_none());
    assert!(token.payload().committed_attributes.contains_key("verificationLevel"));

    // Other attributes are NOT present at all
    assert!(token.subjects().get("dateOfBirth").is_none());
    assert!(token.subjects().get("documentNumber").is_none());

    let result = token.verify(&w.trusted(), "employer-challenge-002", &w.registry);
    assert!(result.is_ok(), "Verification should succeed: {:?}", result.err());
    println!("2. ✓ Employer sees name + confirms KYC level sufficient");

    println!("=== Employer KYC Check PASSED ===\n");
}

// ============================================================================
// E2E Test 3: EU border — "prove you're EU citizen and show name"
// ============================================================================

#[test]
fn e2e_eu_border_nationality() {
    println!("\n=== E2E: EU Border Nationality Check ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string(), "lastName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "nationality".to_string(),
            op: PredicateOp::InSet,
            value: json!([
                "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
                "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
                "PL", "PT", "RO", "SK", "SI", "ES", "SE"
            ]),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "border-challenge-003".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 600).unwrap();

    println!("1. Token created");
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));
    assert!(token.subjects().get("nationality").is_none(), "nationality should be hidden");
    assert!(token.payload().committed_attributes.contains_key("nationality"));

    let result = token.verify(&w.trusted(), "border-challenge-003", &w.registry);
    assert!(result.is_ok(), "Verification should succeed: {:?}", result.err());
    println!("2. ✓ Border officer confirms EU nationality without seeing which country");

    println!("=== EU Border Nationality Check PASSED ===\n");
}

// ============================================================================
// E2E Test 4: Multiple predicates at once — age + nationality + KYC
// ============================================================================

#[test]
fn e2e_multi_predicate() {
    println!("\n=== E2E: Multiple Predicates ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![
            PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            },
            PredicateRequest {
                attribute: "nationality".to_string(),
                op: PredicateOp::InSet,
                value: json!(["NL", "DE", "FR", "BE"]),
            },
            PredicateRequest {
                attribute: "verificationLevel".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(1),
            },
        ],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "multi-pred-004".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    println!("1. Token created with 3 predicates");
    println!("   Disclosed: {:?}", token.subjects().keys().collect::<Vec<_>>());
    println!("   Committed: {:?}", token.payload().committed_attributes.keys().collect::<Vec<_>>());
    println!("   ZK proofs: {}", token.zk_proofs().len());

    assert_eq!(token.zk_proofs().len(), 3, "Should have 3 ZK proofs");
    assert_eq!(token.payload().committed_attributes.len(), 3);
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));

    let result = token.verify(&w.trusted(), "multi-pred-004", &w.registry);
    assert!(result.is_ok(), "Verification should succeed: {:?}", result.err());
    println!("2. ✓ All 3 predicates verified");

    println!("=== Multiple Predicates PASSED ===\n");
}

// ============================================================================
// E2E Test 5: Anonymous age proof with ring signature
// ============================================================================

#[test]
fn e2e_anonymous_ring_sig() {
    println!("\n=== E2E: Anonymous Ring Signature ===");
    let mut w = TestWorld::new();
    let decoy1 = KeyPair::generate();
    let decoy2 = KeyPair::generate();
    let decoy3 = KeyPair::generate();

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "ring-anon-005".to_string(),
    };

    // Phase 1: Prepare token (unified)
    let prepared = Token::prepare(&mut w.proof_doc, &request, 600).unwrap();
    println!("1. Token prepared (unified payload built)");
    println!("   Challenge for signing: {}...", &prepared.challenge()[..20]);

    // Phase 2: Finalize with ring signature
    let to_32 = |v: Vec<u8>| -> [u8; 32] { v.try_into().unwrap() };
    let ring: Vec<[u8; 32]> = vec![
        to_32(decoy1.public_key().to_bytes()),
        to_32(w.alice.public_key().to_bytes()),
        to_32(decoy2.public_key().to_bytes()),
        to_32(decoy3.public_key().to_bytes()),
    ];
    let private_key: [u8; 32] = w.alice.to_bytes()[..32].try_into().unwrap();

    let token = Token::finalize_ring_sig(prepared, &private_key, &ring).unwrap();
    println!("2. Token finalized with ring signature (ring size: {})", ring.len());

    // Verify
    let result = token.verify(&w.trusted(), "ring-anon-005", &w.registry);
    assert!(result.is_ok(), "Ring sig token should verify: {:?}", result.err());
    println!("3. ✓ Anonymous age proof verified — verifier doesn't know WHO signed");

    // Serialize round-trip
    let json = serde_json::to_string(&token).unwrap();
    let deserialized: Token = serde_json::from_str(&json).unwrap();
    assert!(deserialized.verify(&w.trusted(), "ring-anon-005", &w.registry).is_ok());
    println!("4. ✓ Serialization round-trip verified");

    println!("=== Anonymous Ring Signature PASSED ===\n");
}

// ============================================================================
// E2E Test 6: Predicate via prepare → finalize_standard (Ed25519)
// ============================================================================

#[test]
fn e2e_prepare_finalize_standard() {
    println!("\n=== E2E: Prepare + Finalize Standard ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "prep-std-006".to_string(),
    };

    let prepared = Token::prepare(&mut w.proof_doc, &request, 3600).unwrap();
    let token = Token::finalize_standard(prepared, &w.alice).unwrap();

    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));
    assert!(token.subjects().get("dateOfBirth").is_none());

    let result = token.verify(&w.trusted(), "prep-std-006", &w.registry);
    assert!(result.is_ok(), "Standard-finalized token should verify: {:?}", result.err());
    println!("1. ✓ prepare → finalize_standard works");

    println!("=== Prepare + Finalize Standard PASSED ===\n");
}

// ============================================================================
// E2E Test 7: Tampering detection — swap committed leaf hash
// ============================================================================

#[test]
fn e2e_tampering_committed_hash() {
    println!("\n=== E2E: Tampering Detection (Committed Hash) ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "tamper-007".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    // Tamper: replace the committed leaf hash with garbage
    let mut val: serde_json::Value = serde_json::to_value(&token).unwrap();
    val["payload"]["committed_attributes"]["dateOfBirth"] =
        json!("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    let tampered: Token = serde_json::from_value(val).unwrap();
    let result = tampered.verify(&w.trusted(), "tamper-007", &w.registry);
    assert!(result.is_err(), "Tampered committed hash should fail");
    println!("1. ✓ Modified committed leaf hash correctly rejected");

    println!("=== Tampering Detection PASSED ===\n");
}

// ============================================================================
// E2E Test 8: Tampering detection — swap ZK proof attribute_leaf_hash
// ============================================================================

#[test]
fn e2e_tampering_zk_binding() {
    println!("\n=== E2E: Tampering Detection (ZK Binding) ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec![],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "tamper-bind-008".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    // Tamper: change the attribute_leaf_hash in the ZK proof
    let mut val: serde_json::Value = serde_json::to_value(&token).unwrap();
    val["payload"]["zk_proofs"][0]["attribute_leaf_hash"] =
        json!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    let tampered: Token = serde_json::from_value(val).unwrap();
    let result = tampered.verify(&w.trusted(), "tamper-bind-008", &w.registry);
    assert!(result.is_err(), "Tampered ZK binding should fail");
    println!("1. ✓ Modified ZK proof binding correctly rejected");

    println!("=== Tampering Detection (ZK Binding) PASSED ===\n");
}

// ============================================================================
// E2E Test 9: Tampering detection — modify disclosed attribute
// ============================================================================

#[test]
fn e2e_tampering_disclosed_attribute() {
    println!("\n=== E2E: Tampering Detection (Disclosed Attribute) ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "tamper-disc-009".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    // Tamper: change disclosed firstName
    let mut val: serde_json::Value = serde_json::to_value(&token).unwrap();
    val["payload"]["subjects"]["firstName"] = json!("Bob");

    let tampered: Token = serde_json::from_value(val).unwrap();
    let result = tampered.verify(&w.trusted(), "tamper-disc-009", &w.registry);
    assert!(result.is_err(), "Tampered disclosed attribute should fail");
    println!("1. ✓ Modified disclosed attribute correctly rejected");

    println!("=== Tampering Detection (Disclosed Attribute) PASSED ===\n");
}

// ============================================================================
// E2E Test 10: Revocation — government revokes credential mid-session
// ============================================================================

#[test]
fn e2e_revocation_mid_session() {
    println!("\n=== E2E: Revocation Mid-Session ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "revoke-010".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    // Initially valid
    let result = token.verify(&w.trusted(), "revoke-010", &w.registry);
    assert!(result.is_ok(), "Should pass before revocation: {:?}", result.err());
    println!("1. ✓ Token valid before revocation");

    // Government revokes the credential
    let root_hash = w.proof_doc.root_hash().to_string();
    w.registry.revoke(
        root_hash.clone(),
        w.issuer.public_key().to_hex(),
        Some("Identity document reported stolen".to_string()),
    );
    println!("2. Government revoked credential");

    // Now verification fails
    let result = token.verify(&w.trusted(), "revoke-010", &w.registry);
    assert!(result.is_err(), "Should fail after revocation");
    println!("3. ✓ Token correctly rejected after revocation");

    // Government reactivates
    w.registry.reactivate(root_hash, w.issuer.public_key().to_hex());
    let result = token.verify(&w.trusted(), "revoke-010", &w.registry);
    assert!(result.is_ok(), "Should pass after reactivation: {:?}", result.err());
    println!("4. ✓ Token valid again after reactivation");

    println!("=== Revocation Mid-Session PASSED ===\n");
}

// ============================================================================
// E2E Test 11: Untrusted issuer rejected
// ============================================================================

#[test]
fn e2e_untrusted_issuer() {
    println!("\n=== E2E: Untrusted Issuer ===");
    let mut w = TestWorld::new();
    let fake_issuer = KeyPair::generate();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "untrusted-011".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    // Verify with fake issuer
    let result = token.verify(&[fake_issuer.public_key()], "untrusted-011", &w.registry);
    assert!(result.is_err(), "Should reject untrusted issuer");
    println!("1. ✓ Untrusted issuer correctly rejected");

    println!("=== Untrusted Issuer PASSED ===\n");
}

// ============================================================================
// E2E Test 12: Wrong challenge rejected
// ============================================================================

#[test]
fn e2e_wrong_challenge() {
    println!("\n=== E2E: Wrong Challenge ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "correct-challenge".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    let result = token.verify(&w.trusted(), "wrong-challenge", &w.registry);
    assert!(result.is_err(), "Should reject wrong challenge");
    println!("1. ✓ Wrong challenge correctly rejected (replay prevention works)");

    println!("=== Wrong Challenge PASSED ===\n");
}

// ============================================================================
// E2E Test 13: Disclosure-only ProofRequest (no predicates)
// ============================================================================

#[test]
fn e2e_disclosure_only_no_predicates() {
    println!("\n=== E2E: Disclosure Only (No Predicates) ===");
    let mut w = TestWorld::new();

    let request = ProofRequest {
        disclose: vec!["firstName".to_string(), "lastName".to_string(), "nationality".to_string()],
        predicates: vec![],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "disc-only-014".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));
    assert_eq!(token.subjects().get("lastName"), Some(&json!("van der Berg")));
    assert_eq!(token.subjects().get("nationality"), Some(&json!("NL")));
    assert!(token.subjects().get("documentNumber").is_none());
    assert!(token.payload().committed_attributes.is_empty());
    assert!(token.zk_proofs().is_empty());

    let result = token.verify(&w.trusted(), "disc-only-014", &w.registry);
    assert!(result.is_ok(), "Disclosure-only token should verify: {:?}", result.err());
    println!("1. ✓ Disclosure-only ProofRequest works (no ZK proofs needed)");

    println!("=== Disclosure Only PASSED ===\n");
}

// ============================================================================
// E2E Test 15: Predicate attribute ALSO disclosed (no double counting)
// ============================================================================

#[test]
fn e2e_predicate_attribute_also_disclosed() {
    println!("\n=== E2E: Predicate Attribute Also Disclosed ===");
    let mut w = TestWorld::new();

    // Verifier wants to SEE the dateOfBirth AND have a ZK proof that age >= 18
    let request = ProofRequest {
        disclose: vec!["dateOfBirth".to_string(), "firstName".to_string()],
        predicates: vec![PredicateRequest {
            attribute: "dateOfBirth".to_string(),
            op: PredicateOp::GreaterOrEqual,
            value: json!(18),
        }],
        trusted_issuers: vec![w.issuer.public_key().to_hex()],
        challenge: "both-015".to_string(),
    };

    let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();

    // dateOfBirth IS disclosed (because it's in disclose list)
    assert_eq!(token.subjects().get("dateOfBirth"), Some(&json!("1999-03-15")));
    assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));

    // dateOfBirth should NOT be in committed_attributes (it's already disclosed)
    assert!(!token.payload().committed_attributes.contains_key("dateOfBirth"),
        "dateOfBirth should not be committed since it's disclosed");

    // ZK proof is still present
    assert_eq!(token.zk_proofs().len(), 1);

    let result = token.verify(&w.trusted(), "both-015", &w.registry);
    assert!(result.is_ok(), "Should verify: {:?}", result.err());
    println!("1. ✓ Attribute both disclosed AND proven via ZK works correctly");

    println!("=== Predicate Attribute Also Disclosed PASSED ===\n");
}

// ============================================================================
// E2E Test 16: Full real-world scenario — multi-step verification
// ============================================================================

#[test]
fn e2e_full_real_world_scenario() {
    println!("\n=== E2E: Full Real-World Scenario ===");
    let mut w = TestWorld::new();

    println!("--- Government issues identity credential to Alice ---");
    println!("   Root hash: {}", w.proof_doc.root_hash());

    // Scenario 1: Alice goes to a bar
    println!("\n--- Scenario 1: Bar (anonymous age proof) ---");
    {
        let request = ProofRequest {
            disclose: vec![],
            predicates: vec![PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            }],
            trusted_issuers: vec![w.issuer.public_key().to_hex()],
            challenge: "bar-session-a1".to_string(),
        };

        let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 300).unwrap();
        assert!(token.verify(&w.trusted(), "bar-session-a1", &w.registry).is_ok());
        println!("   ✓ Alice proves age >= 18 without revealing anything else");
    }

    // Scenario 2: Alice opens a bank account
    println!("\n--- Scenario 2: Bank (KYC + name + nationality proof) ---");
    {
        let request = ProofRequest {
            disclose: vec!["firstName".to_string(), "lastName".to_string()],
            predicates: vec![
                PredicateRequest {
                    attribute: "verificationLevel".to_string(),
                    op: PredicateOp::GreaterOrEqual,
                    value: json!(2),
                },
                PredicateRequest {
                    attribute: "nationality".to_string(),
                    op: PredicateOp::InSet,
                    value: json!(["NL", "DE", "FR", "BE", "LU"]),
                },
            ],
            trusted_issuers: vec![w.issuer.public_key().to_hex()],
            challenge: "bank-session-b1".to_string(),
        };

        let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();
        assert_eq!(token.subjects().get("firstName"), Some(&json!("Alice")));
        assert!(token.subjects().get("nationality").is_none());
        assert!(token.verify(&w.trusted(), "bank-session-b1", &w.registry).is_ok());
        println!("   ✓ Bank sees name, confirms KYC >= 2, EU nationality — no DOB or doc# leaked");
    }

    // Scenario 3: Alice uses ring sig for anonymous forum
    println!("\n--- Scenario 3: Forum (anonymous ring sig + age proof) ---");
    {
        let decoy1 = KeyPair::generate();
        let decoy2 = KeyPair::generate();

        let request = ProofRequest {
            disclose: vec![],
            predicates: vec![PredicateRequest {
                attribute: "dateOfBirth".to_string(),
                op: PredicateOp::GreaterOrEqual,
                value: json!(18),
            }],
            trusted_issuers: vec![w.issuer.public_key().to_hex()],
            challenge: "forum-session-c1".to_string(),
        };

        let prepared = Token::prepare(&mut w.proof_doc, &request, 1800).unwrap();

        let to_32 = |v: Vec<u8>| -> [u8; 32] { v.try_into().unwrap() };
        let ring = vec![
            to_32(decoy1.public_key().to_bytes()),
            to_32(w.alice.public_key().to_bytes()),
            to_32(decoy2.public_key().to_bytes()),
        ];
        let pk: [u8; 32] = w.alice.to_bytes()[..32].try_into().unwrap();
        let token = Token::finalize_ring_sig(prepared, &pk, &ring).unwrap();

        assert!(token.subjects().get("firstName").is_none());
        assert!(token.verify(&w.trusted(), "forum-session-c1", &w.registry).is_ok());
        println!("   ✓ Forum knows Alice is 18+ and has a valid credential, but NOT who she is");
    }

    // Scenario 4: Government revokes Alice's credential
    println!("\n--- Scenario 4: Credential revoked ---");
    {
        let root_hash = w.proof_doc.root_hash().to_string();
        w.registry.revoke(
            root_hash.clone(),
            w.issuer.public_key().to_hex(),
            Some("Document reported stolen".to_string()),
        );

        let request = ProofRequest {
            disclose: vec!["firstName".to_string()],
            predicates: vec![],
            trusted_issuers: vec![w.issuer.public_key().to_hex()],
            challenge: "post-revoke-d1".to_string(),
        };

        let token = Token::generate(&mut w.proof_doc, &request, &w.alice, 3600).unwrap();
        let result = token.verify(&w.trusted(), "post-revoke-d1", &w.registry);
        assert!(result.is_err(), "Should fail after revocation");
        println!("   ✓ All new tokens rejected after revocation");

        // Reactivate
        w.registry.reactivate(root_hash, w.issuer.public_key().to_hex());
        let result = token.verify(&w.trusted(), "post-revoke-d1", &w.registry);
        assert!(result.is_ok());
        println!("   ✓ Tokens accepted again after reactivation");
    }

    println!("\n=== Full Real-World Scenario PASSED ===\n");
}
