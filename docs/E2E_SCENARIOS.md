# OwlID End-to-End Scenarios

Reference scenarios demonstrating complete data flows through the OwlID system.
Each scenario shows the full lifecycle from credential issuance through verification.

---

## Scenario 1: Bar Age Check (Anonymous Proof)

**Goal:** Alice proves she is 18+ to enter a bar without revealing her name, birthday, or any personal data.

### Actors

- **Government (Issuer):** Netherlands DigiD mock provider
- **Alice (Owner):** Holds a credential on her phone
- **Bar Bouncer (Verifier):** Needs proof of age >= 18

### Step-by-Step Flow

**1. Credential Issuance**

Alice verifies her identity through the issuer service using mock DigiD.

```
POST http://localhost:8001/sessions
{"providerId": "mock-digid"}
-> {"sessionId": "abc-123", "providerId": "mock-digid", "flowType": "form_based"}

POST http://localhost:8001/sessions/abc-123/auto-verify
-> {"firstName": "Jan", "lastName": "de Vries", "dateOfBirth": "1985-03-15",
    "nationality": "Dutch", "isOver18": true, ...}

POST http://localhost:8001/sessions/abc-123/issue
{"ownerPublicKey": "<alice_ed25519_hex>", "keyAlgorithm": "ed25519"}
-> {"success": true, "credential": {"root_hash": "a1b2c3...", "attributes": {...}, "salt": "..."}}
```

Alice stores the `credential` (ProofDocument) in her wallet.

**2. Token Generation (Client-Side)**

The bar's terminal generates a random challenge and displays a QR code.
Alice's wallet builds a token proving age >= 18 with zero disclosure.

```rust
let request = ProofRequest {
    disclose: vec![],                    // No personal info disclosed
    predicates: vec![PredicateRequest {
        attribute: "dateOfBirth",
        op: PredicateOp::GreaterOrEqual,
        value: json!(18),                // Prove age >= 18
    }],
    trusted_issuers: vec![gov_pubkey],
    challenge: "bar-challenge-f8a2b1",
};

let token = Token::generate(&mut proof_doc, &request, &alice_key, 300)?;
let compact = token.to_compact()?;      // "NID1:..." (~1500 chars, fits QR)
```

**3. Token Verification**

The bar's terminal sends the compact token to the verification service.

```
POST http://localhost:8000/verify
X-API-Key: <bar_api_key>
{"token": "NID1:...", "challenge": "bar-challenge-f8a2b1"}

-> {"valid": true, "subjects": {"issuerKey": "...", "ownerKey": "...", "rootHash": "..."}}
```

**What the verifier sees:**

- `valid: true` (Alice is 18+)
- `issuerKey` (government's public key -- trusted)
- No name, no birthday, no nationality -- just the cryptographic proof

**What the verifier does NOT see:**

- Alice's name, date of birth, address, nationality
- Which specific age Alice is (only that it's >= 18)

### Privacy Properties

- ZK proof reveals nothing except "age >= 18"
- Per-document salt prevents linking this proof to other verifications
- Challenge prevents replay (one-time use)

---

## Scenario 2: Employer KYC Check (Selective Disclosure + Predicate)

**Goal:** Bob proves his name and that he has KYC level >= 2 to a potential employer.

### Actors

- **Government (Issuer):** BankID mock provider (Sweden)
- **Bob (Owner):** Job applicant
- **Employer (Verifier):** Needs name + KYC level proof

### Step-by-Step Flow

**1. Credential Issuance**

```
POST http://localhost:8001/sessions
{"providerId": "mock-bankid"}

POST http://localhost:8001/sessions/<id>/auto-verify
-> {"firstName": "Erik", "lastName": "Svensson", "nationality": "Swedish",
    "verificationLevel": "High", ...}

POST http://localhost:8001/sessions/<id>/issue
{"ownerPublicKey": "<bob_hex>", "keyAlgorithm": "ed25519"}
-> {"success": true, "credential": {...}}
```

**2. Token Generation**

```rust
let request = ProofRequest {
    disclose: vec![
        "firstName".to_string(),     // Employer sees the name
        "lastName".to_string(),
    ],
    predicates: vec![PredicateRequest {
        attribute: "verificationLevel",
        op: PredicateOp::GreaterOrEqual,
        value: json!(2),             // Prove KYC >= Standard
    }],
    trusted_issuers: vec![gov_pubkey],
    challenge: "employer-check-9c3d",
};

let token = Token::generate(&mut proof_doc, &request, &bob_key, 3600)?;
```

**3. Verification**

```
POST http://localhost:8000/verify
{"token": "NID1:...", "challenge": "employer-check-9c3d"}

-> {
     "valid": true,
     "subjects": {
       "firstName": "Erik",
       "lastName": "Svensson",
       "issuerKey": "...",
       "ownerKey": "..."
     }
   }
```

**What the employer sees:** Name + proof of KYC level >= 2.
**What the employer does NOT see:** Nationality, address, national ID, exact KYC level.

---

## Scenario 3: EU Border Crossing (Nationality Set Membership)

**Goal:** Alice proves she is an EU citizen to cross a border without revealing which country.

### Token Generation

```rust
let request = ProofRequest {
    disclose: vec!["firstName".to_string()],
    predicates: vec![PredicateRequest {
        attribute: "nationality",
        op: PredicateOp::InSet,
        value: json!([
            "Austrian", "Belgian", "Bulgarian", "Croatian", "Cypriot",
            "Czech", "Danish", "Dutch", "Estonian", "Finnish", "French",
            "German", "Greek", "Hungarian", "Irish", "Italian", "Latvian",
            "Lithuanian", "Luxembourgish", "Maltese", "Polish", "Portuguese",
            "Romanian", "Slovak", "Slovenian", "Spanish", "Swedish"
        ]),
    }],
    trusted_issuers: vec![gov_pubkey],
    challenge: "border-x9f2",
};
```

### Verification Result

```json
{
  "valid": true,
  "subjects": {
    "firstName": "Jan",
    "issuerKey": "...",
    "ownerKey": "..."
  }
}
```

The border agent knows Alice is an EU citizen but not which member state.
The nationality ZK proof uses a Pedersen Merkle tree with 27 leaves (one per EU country).

---

## Scenario 4: Anonymous Forum Registration (Ring Signature)

**Goal:** Alice registers on a forum proving she has a valid credential without revealing her identity.

### Token Generation

Alice signs with a ring signature. The verifier knows ONE of the ring members signed, but not which.

```rust
let prepared = Token::prepare(&mut proof_doc, &request, 3600)?;

let owner_private: [u8; 32] = alice.to_bytes()[..32].try_into().unwrap();
let ring: Vec<[u8; 32]> = vec![
    to_32(alice.public_key().to_bytes()),
    to_32(decoy1.public_key().to_bytes()),
    to_32(decoy2.public_key().to_bytes()),
    to_32(decoy3.public_key().to_bytes()),
];

let token = Token::finalize_ring_sig(prepared, &owner_private, &ring)?;
```

### Verification Result

```json
{
  "valid": true,
  "subjects": {
    "issuerKey": "...",
    "rootHash": "..."
  }
}
```

No owner key is revealed. The forum knows a valid credential holder signed, but cannot determine which of the 4 ring members it was. Combined with a ZK age predicate, Alice can prove she's 18+ anonymously.

---

## Scenario 5: Credential Revocation Mid-Session

**Goal:** Government revokes Alice's credential while she's using it; subsequent verifications fail.

### Flow

```
# 1. Alice verifies successfully
POST /verify {"token": "NID1:...", "challenge": "session-1"}
-> {"valid": true}

# 2. Government revokes the credential
POST /revocations/revoke
{"credential_id": "<root_hash>", "issuer_public_key": "<gov_key>", "reason": "Document expired"}
-> {"success": true}

# 3. Alice tries to verify again (new challenge)
POST /verify {"token": "NID1:...", "challenge": "session-2"}
-> {"valid": false, "error": "Credential revoked: <root_hash>"}

# 4. Government reactivates after review
POST /revocations/reactivate {"credential_id": "<root_hash>"}
-> {"success": true}

# 5. Alice can verify again
POST /verify {"token": "NID1:...", "challenge": "session-3"}
-> {"valid": true}
```

Revocation propagates immediately through the in-memory cache.
WebSocket subscribers receive real-time notifications at `ws://localhost:8000/ws/revocations`.

---

## Scenario 6: GDPR Right-to-Erasure

**Goal:** Alice requests deletion of all her data from the system.

### Flow

```
DELETE /admin/gdpr-erasure/<alice_public_key>
X-API-Key: <admin_key>

-> {
     "owner_public_key": "<alice_public_key>",
     "credentials_revoked": 2,
     "records_anonymized": 2,
     "erased_at": "2026-03-15T12:00:00Z",
     "receipt_id": "gdpr-abc-123"
   }
```

**What happens:**

1. All active credentials for Alice are revoked
2. Credential data in the database is replaced with `{"anonymized": true}`
3. Verification logs remain but with hashed identifiers only (no PII)
4. An audit event is recorded with the erasure receipt ID
5. The receipt ID serves as proof that erasure was performed

---

## Running These Scenarios

All scenarios are automated in the E2E test suite:

```bash
# Start services
just db-start
just dev-backend

# Run verification service E2E tests (47 tests)
VERIFICATION_SERVICE_URL=http://localhost:8000 \
cargo test -p owl-verification-service --test e2e_api -- --ignored --test-threads=1

# Run issuer service E2E tests (15 tests)
ISSUER_SERVICE_URL=http://localhost:8001 \
cargo test -p owl-issuer-service --test e2e_api -- --ignored --test-threads=1
```

Key test functions per scenario:

- Scenario 1: `test_verify_zk_age_predicate`
- Scenario 2: `test_t016_zk_kyc_predicate`, `test_verify_valid_token`
- Scenario 3: `test_t016_zk_nationality_predicate`
- Scenario 4: `test_t022_ring_signature_anonymity`
- Scenario 5: `test_revoked_token_fails_verification`, `test_suspend_and_reactivate_credential`
- Scenario 6: `test_t019_gdpr_erasure`
- Cross-service: `test_cross_service_issue_then_verify` (issuer service tests)
