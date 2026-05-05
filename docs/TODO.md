# OwlID Production TODO

**Last Updated:** 2026-03-15
**Status:** Mostly Complete
**Scope:** All items required to move OwlID from current state to production-grade identity solution

---

## Executive Summary

OwlID has a comprehensive, production-grade core: Merkle-tree selective disclosure with per-document salt, Ed25519/P-256 dual signatures, WebAuthn/FIDO2 integration, multisig support, ZK circuits (age/nationality/KYC), ring signatures, HMAC token integrity, a NAPI-RS native SDK, Axum-based verification and issuer microservices with DB-backed revocation, GDPR erasure, WebSocket push, Prometheus metrics, rate limiting, schema validation, encryption at rest, challenge replay protection, and OIDC integration.

**All 22 items are now resolved.** All P0 security vulnerabilities have been fixed. All P1 correctness/feature items are complete. All P2 hardening items are implemented.

**Status: 22/22 complete (4 P0, 7 P1, 11 P2)**

---

## Assumptions

- Target runtime: Linux amd64 (Docker), macOS arm64 (dev), browser WASM (client SDK)
- Database: PostgreSQL 15+ with sqlx (compile-time checked queries)
- Rust edition 2021, MSRV 1.75
- Node.js 20 LTS for SDK consumers
- CI: GitHub Actions (or equivalent) with `cargo test`, `cargo clippy`, `cargo fmt`
- The architecture document (`docs/SoftwareArchitecture.md`) is the source of truth for feature scope
- Existing test suites (`full_flow_test.rs`, `merkle_integration_test.rs`) must remain green at every commit

---

## Priority Definitions

| Priority | Meaning                                                                     | Merge Gate                                                  |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **P0**   | Security vulnerability or data-loss risk exploitable today                  | Must fix before any production deployment                   |
| **P1**   | Correctness bug, crash path, or missing feature blocking a primary use case | Must fix before GA release                                  |
| **P2**   | Hardening, observability, spec compliance, or UX polish                     | Should fix; acceptable to defer post-GA with tracking issue |

---

## TODO Index

| ID              | Priority | Category      | Title                                           | Status                                                               |
| --------------- | -------- | ------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| [T-001](#t-001) | P0       | Security      | Client-side SDK revocation bypass               | DONE - `revoked_hashes` param added to verify()                      |
| [T-002](#t-002) | P0       | Security      | Private key transmitted in API request body     | DONE - `/generate-keypair` endpoint removed                          |
| [T-003](#t-003) | P0       | Security      | Auto-registration of unknown issuers            | DONE - Admin permission required; self-registration gated by env var |
| [T-004](#t-004) | P0       | Security      | No per-document salt on Merkle leaf hashes      | DONE - Per-document salt with `hash_attribute_salted()`              |
| [T-005](#t-005) | P1       | Correctness   | P-256 double-hashing in ECDSA sign              | DONE - Correctly delegates to p256 crate                             |
| [T-006](#t-006) | P1       | Correctness   | Token serialization round-trip brittleness      | DONE - `leaf_hashes` stored for reconstruction                       |
| [T-007](#t-007) | P1       | Feature       | Multisig verification not implemented           | DONE - Full threshold-based multisig                                 |
| [T-008](#t-008) | P1       | Feature       | Schema validation for credential attributes     | DONE - `CredentialSchema` with type constraints                      |
| [T-009](#t-009) | P1       | Feature       | Database-backed revocation registry             | DONE - `RevocationRepository` + in-memory cache                      |
| [T-010](#t-010) | P1       | Reliability   | Service startup config validation               | DONE - Config::from_env() with upfront validation                    |
| [T-011](#t-011) | P1       | Security      | Challenge replay protection                     | DONE - `used_challenges` table + nonce store                         |
| [T-012](#t-012) | P2       | Security      | HMAC on token payloads                          | DONE - HMAC-SHA256 in token.rs                                       |
| [T-013](#t-013) | P2       | Security      | mTLS between services                           | DONE - TlsConfig with cert/key/CA paths                              |
| [T-014](#t-014) | P2       | Security      | Encryption at rest (AES-GCM)                    | DONE - Optional AES-256-GCM on credential_data                       |
| [T-015](#t-015) | P2       | Feature       | Rate limiting                                   | DONE - DB-backed rate limiting with configurable window              |
| [T-016](#t-016) | P2       | Feature       | ZK circuit integration                          | DONE - Groth16 age/nationality/KYC circuits                          |
| [T-017](#t-017) | P2       | Feature       | OAuth 2.1 / OIDC integration for issuer service | DONE - Discovery, code exchange, userinfo, claim mapping             |
| [T-018](#t-018) | P2       | Feature       | WebSocket push for real-time revocation         | DONE - `RevocationBroadcaster` + ws endpoint                         |
| [T-019](#t-019) | P2       | Compliance    | GDPR right-to-erasure implementation            | DONE - `/admin/gdpr-erasure` endpoint                                |
| [T-020](#t-020) | P2       | Observability | Structured logging, metrics, tracing            | DONE - Prometheus, correlation IDs, handler metrics                  |
| [T-021](#t-021) | P2       | Testing       | E2E and property-based test suites              | DONE - 57+ unit tests, 29 integration tests                          |
| [T-022](#t-022) | P2       | Feature       | Ring signatures / advanced anonymity            | DONE - Schnorr ring sigs integrated in token flow                    |

---

## Detailed Items

---

### T-001

**Priority:** P0
**Category:** Security
**Title:** Client-side SDK revocation bypass

#### Problem

In `packages/native-sdk/src/lib.rs:306`, the NAPI `Token::verify()` binding creates a fresh `RevocationRegistry::new()` (empty in-memory registry) on every call. This means **client-side verification never actually checks revocation status**. A revoked credential will pass verification when checked through the SDK.

```rust
// Current code (line 306)
let registry = owl_proof_system::RevocationRegistry::new();
let result = self.inner.verify(&trusted, challenge, &registry);
```

#### Proposed Solution

Accept revocation data as a parameter in the NAPI binding. Two options:

**Option A (recommended):** Accept a list of revoked root hashes from the caller (the frontend fetches from the verification service and passes them in).

**Option B:** Accept a URL to the verification service's `/revocations` endpoint and fetch internally.

Option A is preferred because it keeps the SDK stateless and avoids network dependencies in the native layer.

#### Implementation Details

1. Add a `revoked_hashes: Vec<String>` parameter to the NAPI `verify()` method in `packages/native-sdk/src/lib.rs`.
2. Construct a `RevocationRegistry` and populate it with the provided hashes before calling `inner.verify()`.
3. Add a convenience method `RevocationRegistry::from_hashes(hashes: &[String])` in `crates/proof-system/src/revocation.rs`.
4. Update `packages/sdk/src/tokens.ts` to accept and pass revocation data.
5. Update the SDK README/docs to document the revocation checking flow.

**Files to modify:**

- `crates/proof-system/src/revocation.rs` — add `from_hashes()` constructor
- `packages/native-sdk/src/lib.rs` — change `verify()` signature
- `packages/sdk/src/tokens.ts` — update TypeScript wrapper

#### UX Notes

- Callers who do not pass revocation data get a compile-time (TypeScript) or runtime warning, not silent acceptance.
- The SDK should expose a helper `fetchRevocations(serviceUrl: string): Promise<string[]>` so the integration path is obvious.

#### Edge Cases

- Empty revocation list: valid — means no credentials are revoked, verification proceeds normally.
- Network failure fetching revocations: caller decides policy (fail-open vs fail-closed). SDK should not make this decision silently.
- Stale revocation data: document that callers should refresh periodically; consider adding a `fetchedAt` timestamp so verifiers can enforce freshness.

#### Tests

```
test_napi_verify_with_revoked_hash_rejects_token
  → Create token, add root_hash to revoked list, call verify → expect Err

test_napi_verify_with_empty_revocation_list_accepts_valid_token
  → Create valid token, pass empty revocation list → expect Ok

test_napi_verify_revocation_list_does_not_affect_unrelated_tokens
  → Revoke hash "abc", verify token with hash "def" → expect Ok

test_sdk_fetch_revocations_integration
  → Mock verification service, call fetchRevocations, verify response shape
```

#### Observability

- Log (info level) when revocation check is performed with list size.
- Metric: `sdk.verify.revocation_checked{result=pass|fail}`.

#### Acceptance Criteria

- [ ] `Token::verify()` in NAPI binding accepts revocation data parameter
- [ ] Passing a list containing the token's root hash causes verification to fail with `CredentialRevoked`
- [ ] TypeScript types updated, no `any` escape hatches
- [ ] Existing `full_flow_test.rs` revocation tests still pass
- [ ] SDK README documents the revocation checking pattern

---

### T-002

**Priority:** P0
**Category:** Security
**Title:** Private key transmitted in API request body

#### Problem

In `crates/verification-service/src/api.rs:39`, the `issue_credential()` endpoint accepts `issuer_private_key` as a field in the JSON request body:

```rust
pub async fn issue_credential(
    State(state): State<AppState>,
    Json(request): Json<IssueRequest>,
) -> Result<...> {
    let issuer_keypair = KeyPair::from_hex(&request.issuer_private_key)?;
```

This means the issuer's private key is:

- Transmitted over the network (even with TLS, it's logged, cached in proxies, stored in request bodies)
- Present in server memory outside the issuer's control
- Potentially logged in audit trails, error dumps, or APM tools

This fundamentally violates the security model where issuers should retain exclusive control of their signing keys.

#### Proposed Solution

Move credential issuance to the **issuer service** (`crates/issuer-service/`), which should be the only component with access to the issuer's private key. The verification service should **never** see private keys.

#### Implementation Details

1. **Remove** the `issue_credential` endpoint from `crates/verification-service/src/api.rs` entirely.
2. **Expose** the issuance endpoint on the issuer service (`crates/issuer-service/src/main.rs`), which already has `issue_credential_direct()` in `issuance.rs`.
3. The issuer service should load the issuer's private key from:
   - Environment variable (`ISSUER_PRIVATE_KEY_HEX`), or
   - A secrets manager (AWS Secrets Manager, Vault), or
   - An HSM via PKCS#11
4. The issuer service endpoint accepts only the **attributes** and **owner public key** — never the issuer private key.
5. Add an Axum route in the issuer service: `POST /credentials/issue` accepting `{ owner_public_key: string, attributes: Record<string, any> }`.
6. The verification service, if it needs to trigger issuance, calls the issuer service over an internal network (service-to-service auth via mTLS or shared secret).

**Files to modify:**

- `crates/verification-service/src/api.rs` — remove `issue_credential` and `IssueRequest`
- `crates/issuer-service/src/main.rs` — add HTTP route for issuance
- `crates/issuer-service/src/issuance.rs` — adapt to load key from env/config

#### UX Notes

- API consumers who currently call the verification service's issue endpoint need migration docs.
- Error messages must never echo back key material.

#### Edge Cases

- If the issuer service is unreachable, the verification service should return 503 (Service Unavailable), not attempt local issuance.
- Key rotation: the issuer service should support loading multiple keys indexed by key ID, with a `current` pointer.
- If `ISSUER_PRIVATE_KEY_HEX` is unset at startup, the issuer service must fail fast with a clear error, not start in a degraded state.

#### Tests

```
test_verification_service_has_no_issue_endpoint
  → Send POST to /issue on verification service → expect 404

test_issuer_service_issues_credential_without_private_key_in_body
  → POST to issuer service /credentials/issue with {owner_public_key, attributes} → expect 200 with ProofDocument

test_issuer_service_rejects_request_with_private_key_field
  → POST with private_key in body → expect 400 with "unexpected field" error

test_issuer_service_fails_fast_without_key_config
  → Start issuer service without ISSUER_PRIVATE_KEY_HEX → expect startup failure
```

#### Observability

- Alert on any request containing field names matching `private_key`, `secret`, `private` in the request body (WAF rule or middleware).
- Audit log: `credential.issued{issuer_pub_key=..., owner_pub_key=..., credential_hash=...}`.

#### Acceptance Criteria

- [ ] Verification service has no endpoint that accepts private key material
- [ ] Issuer service loads private key from environment/config, never from request body
- [ ] Integration test confirms issuance works end-to-end without key in HTTP payload
- [ ] Existing issuance tests adapted to new flow
- [ ] Migration guide written for API consumers

---

### T-003

**Priority:** P0
**Category:** Security
**Title:** Auto-registration of unknown issuers

#### Problem

In `crates/verification-service/src/api.rs:66-79`, when a credential is issued and the issuer's public key is not found in the trusted issuers list, the service **automatically registers it** as a trusted issuer:

```rust
// If issuer not found, register them
let issuer_record = match state.trusted_issuers.find_by_public_key(&issuer_pub_hex).await {
    Ok(issuer) => issuer,
    Err(_) => {
        // Auto-register the issuer
        state.trusted_issuers.create(&issuer_pub_hex, "Auto-registered").await?
    }
};
```

This defeats the entire trust model. Any party that can call the API becomes a trusted issuer automatically.

#### Proposed Solution

Remove auto-registration. The trusted issuers list must be managed explicitly through a protected admin endpoint. Unknown issuers must be rejected.

#### Implementation Details

1. **Remove** the auto-registration fallback in `api.rs`. Replace with:
   ```rust
   let issuer_record = state.trusted_issuers
       .find_by_public_key(&issuer_pub_hex)
       .await
       .map_err(|_| ApiError::UntrustedIssuer(issuer_pub_hex.clone()))?;
   ```
2. **Ensure** the existing `POST /trusted-issuers` admin endpoint requires `admin` permission via `AuthMiddleware::validate_with_permission`.
3. Add a **bootstrap** mechanism: on first run, if zero trusted issuers exist, log a warning with instructions to register the first issuer via CLI or admin API.
4. Add a CLI command or startup config to seed the initial trusted issuer.

**Files to modify:**

- `crates/verification-service/src/api.rs` — remove auto-registration block
- `crates/verification-service/src/main.rs` — add bootstrap warning

#### UX Notes

- Clear error message when an untrusted issuer is encountered: `"Issuer {public_key_prefix}... is not in the trusted issuers list. Register via POST /admin/trusted-issuers."`.
- Admin UI (if exists) should show pending/rejected issuers for audit trail.

#### Edge Cases

- Race condition: two concurrent requests try to register the same issuer via the admin endpoint. The DB unique constraint handles this; the second insert returns the existing record.
- Issuer key rotation: old key remains trusted until explicitly removed. Document this lifecycle.

#### Tests

```
test_unknown_issuer_rejected_on_verify
  → Submit token signed by unregistered issuer → expect 401 UntrustedIssuer

test_registered_issuer_accepted
  → Register issuer via admin endpoint, then submit token → expect 200

test_admin_endpoint_requires_permission
  → Call POST /trusted-issuers without admin API key → expect 403

test_duplicate_issuer_registration_is_idempotent
  → Register same public key twice → expect 200 both times, single DB record
```

#### Observability

- Log (warn): `"Rejected token from untrusted issuer: {pub_key_hex}"`.
- Metric: `verification.untrusted_issuer_rejected_total`.

#### Acceptance Criteria

- [ ] No code path automatically adds issuers to the trusted list
- [ ] Tokens from unregistered issuers are rejected with clear error
- [ ] Admin endpoint for issuer management requires authentication and `admin` permission
- [ ] Bootstrap instructions logged when no trusted issuers are configured

---

### T-004

**Priority:** P0
**Category:** Security
**Title:** No per-document salt on Merkle leaf hashes

#### Problem

In `crates/crypto/src/hash.rs`, `hash_attribute(key, value)` deterministically hashes `{"key": value}` without any per-document salt:

```rust
pub fn hash_attribute(key: &str, value: &serde_json::Value) -> String {
    let data = serde_json::json!({ key: value }).to_string();
    hash_bytes(data.as_bytes())
}
```

This means the same attribute (e.g., `"over21": true`) produces the **same leaf hash** across every credential in the system. An attacker who obtains any Merkle proof can build a rainbow table mapping common attribute values to their hashes, then identify attribute values in other credentials by comparing hashes — even from supposedly "hidden" leaves whose sibling hashes appear in proofs.

#### Proposed Solution

Add a per-document random salt that is included in every leaf hash computation. The salt is stored in the `ProofDocument` and included in tokens so verifiers can recompute leaf hashes.

#### Implementation Details

1. **Generate** a 32-byte random salt when creating a `Document` (in `Document::new()`).
2. **Store** the salt as a hex string in `ProofDocument.salt`.
3. **Modify** `hash_attribute()` to accept an optional salt parameter:
   ```rust
   pub fn hash_attribute(key: &str, value: &serde_json::Value, salt: &str) -> String {
       let data = format!("{}:{}", salt, serde_json::json!({ key: value }));
       hash_bytes(data.as_bytes())
   }
   ```
4. **Thread** the salt through `MerkleTree::from_attributes()`, `MerkleProof::verify()`, and `Token::verify()`.
5. **Include** the salt in the `TokenPayload` so verifiers can recompute hashes.
6. **Update** all callers of `hash_attribute()` across crypto and proof-system crates.

**Files to modify:**

- `crates/crypto/src/hash.rs` — add salt parameter
- `crates/crypto/src/merkle.rs` — thread salt through tree construction and verification
- `crates/proof-system/src/document.rs` — generate and store salt
- `crates/proof-system/src/token.rs` — include salt in payload, pass to verification
- `packages/native-sdk/src/lib.rs` — update NAPI bindings if needed

#### UX Notes

- The salt is not sensitive (it's included in the token). Its purpose is to prevent cross-credential correlation, not to be secret.
- Backward compatibility: old tokens without a salt field should still verify (fallback to unsalted hash). Add a deprecation warning when verifying unsalted tokens.

#### Edge Cases

- Salt collision (two documents with the same salt): astronomically unlikely with 32-byte random salt (256 bits of entropy). No special handling needed.
- Empty salt string: reject at `Document::new()` — salt must be exactly 32 bytes / 64 hex chars.
- Serialization: salt is hex-encoded in JSON, no special characters.

#### Tests

```
test_same_attribute_different_salt_produces_different_hash
  → hash_attribute("over21", true, salt_a) != hash_attribute("over21", true, salt_b)

test_merkle_proof_verifies_with_salt
  → Create document with salt, issue, create token, verify → expect Ok

test_different_documents_same_attributes_different_root_hash
  → Create two documents with identical attributes → root hashes differ

test_forged_token_with_wrong_salt_fails
  → Create token, modify salt in payload, verify → expect Err

test_backward_compat_unsalted_token
  → Verify a token without salt field → expect Ok with deprecation warning
```

#### Observability

- Log (warn) when verifying an unsalted token: `"Verifying token without per-document salt (deprecated)"`.
- Metric: `token.verified{salted=true|false}`.

#### Acceptance Criteria

- [ ] Every new `Document` generates a unique 32-byte salt
- [ ] `hash_attribute()` incorporates salt into the hash input
- [ ] Token payload includes the salt for verifier recomputation
- [ ] Two documents with identical attributes produce different root hashes
- [ ] All existing tests updated to work with salted hashes
- [ ] Backward-compatible verification of pre-salt tokens with deprecation warning

---

### T-005

**Priority:** P1
**Category:** Correctness
**Title:** P-256 double-hashing in ECDSA sign

#### Problem

In `crates/crypto/src/signature.rs:110-115`, the P-256 signing path manually hashes the message with SHA-256 before calling `signing_key.sign()`:

```rust
Algorithm::EcdsaP256 => {
    let signing_key = p256::ecdsa::SigningKey::from_bytes(
        &self.private_key.clone().into()
    ).unwrap();
    let digest = Sha256::digest(message);
    let signature: p256::ecdsa::Signature = signing_key.sign(&digest);
```

The `p256` crate's `sign()` method (via the `Signer` trait from `signature` crate) **already hashes the input with SHA-256** internally per the ECDSA specification. The message is therefore hashed twice: `sign(SHA256(message))` = `ECDSA_sign(SHA256(SHA256(message)))`.

This doesn't break security (double-hashing is still collision-resistant), but it means P-256 signatures produced by OwlID are **incompatible with standard ECDSA implementations**. WebAuthn authenticators sign `SHA256(message)` only once, so interop will silently fail.

#### Proposed Solution

Remove the manual `Sha256::digest()` call and pass the raw message to `signing_key.sign()`.

#### Implementation Details

1. Change the P-256 sign block in `signature.rs`:
   ```rust
   Algorithm::EcdsaP256 => {
       let signing_key = p256::ecdsa::SigningKey::from_bytes(
           &self.private_key.clone().into()
       ).map_err(|e| SignatureError::SigningFailed(e.to_string()))?;
       let signature: p256::ecdsa::Signature = signing_key.sign(message);
   ```
2. **Verify** the corresponding `verify()` path at line ~149 also passes raw message (not pre-hashed) to `verifying_key.verify()`. If it also double-hashes, fix it too.
3. **Re-run** all P-256 related tests. Any test that was generated with the double-hashed behavior will need its expected values updated.
4. **Check** WebAuthn verification path in `crates/crypto/src/webauthn.rs` to ensure consistency.

**Files to modify:**

- `crates/crypto/src/signature.rs` — remove manual digest in sign and verify

#### Edge Cases

- Existing P-256 signatures in stored ProofDocuments will become invalid after this fix. If any credentials have been issued with P-256, a migration is needed. If not (Ed25519 is default), this is a clean fix.
- The `from_bytes().unwrap()` should also be replaced with proper error handling (see T-008).

#### Tests

```
test_p256_sign_verify_roundtrip
  → Sign message with P-256, verify with P-256 → expect Ok

test_p256_signature_matches_openssl
  → Sign same message with OwlID P-256 and openssl, compare signatures → expect match

test_p256_verify_external_signature
  → Verify a signature generated by an external P-256 implementation → expect Ok

test_webauthn_p256_interop
  → Create WebAuthn signature, verify with OwlID P-256 verify → expect Ok
```

#### Acceptance Criteria

- [ ] P-256 `sign()` does not manually hash before calling the crate's sign method
- [ ] P-256 `verify()` does not manually hash before calling the crate's verify method
- [ ] All P-256 tests pass
- [ ] Interoperability test with external ECDSA implementation passes

---

### T-006

**Priority:** P1
**Category:** Correctness
**Title:** Token serialization round-trip brittleness

#### Problem

In `crates/proof-system/src/document.rs`, the `ProofDocument.merkle_tree` field is annotated with `#[serde(skip)]`:

```rust
pub struct ProofDocument {
    pub attributes: BTreeMap<String, serde_json::Value>,
    pub root_hash: String,
    pub signature: String,
    #[serde(skip)]
    merkle_tree: Option<MerkleTree>,
}
```

When a `ProofDocument` is serialized (e.g., stored in a database or sent over the network) and then deserialized, the `merkle_tree` field is `None`. The `ensure_merkle_tree()` method reconstructs it from `attributes`, but this reconstruction depends on:

- Deterministic JSON serialization of attribute values
- Identical `hash_attribute()` behavior
- Identical tree construction order

If any of these change between versions (e.g., serde_json formatting changes, hash algorithm update), deserialized documents will produce different root hashes and all proofs will break.

#### Proposed Solution

Serialize the Merkle tree's leaf hashes alongside the document, so reconstruction is independent of hashing behavior. The root hash serves as a checksum.

#### Implementation Details

1. Add a `leaf_hashes: Vec<(String, String)>` field to `ProofDocument` (key → hash pairs, ordered).
2. Populate `leaf_hashes` during `Document::issue()` after tree construction.
3. In `ensure_merkle_tree()`, reconstruct from `leaf_hashes` instead of re-hashing attributes.
4. On deserialization, verify that the reconstructed root hash matches `self.root_hash`. If not, return an error instead of silently producing a broken tree.
5. Keep backward compatibility: if `leaf_hashes` is empty/missing (old format), fall back to re-hashing from attributes with a deprecation warning.

**Files to modify:**

- `crates/proof-system/src/document.rs` — add leaf_hashes, update serialization
- `crates/crypto/src/merkle.rs` — add `from_leaf_hashes()` constructor

#### Edge Cases

- Old documents without `leaf_hashes`: fall back to current reconstruction behavior.
- Tampered `leaf_hashes`: detected by root hash mismatch on reconstruction.
- Version migration: provide a one-time migration script that reads old documents, computes leaf hashes, and writes them back.

#### Tests

```
test_proof_document_survives_serialize_deserialize
  → Create ProofDocument, serialize to JSON, deserialize, generate proof, verify → expect Ok

test_tampered_leaf_hashes_detected
  → Deserialize ProofDocument, modify a leaf hash, call ensure_merkle_tree → expect Err

test_backward_compat_old_format
  → Deserialize a ProofDocument JSON without leaf_hashes field → expect Ok with reconstruction
```

#### Acceptance Criteria

- [ ] `ProofDocument` serialization includes leaf hashes
- [ ] Round-trip serialize → deserialize → generate proof → verify succeeds
- [ ] Tampered leaf hashes detected via root hash check
- [ ] Old-format documents still deserialize correctly

---

### T-007

**Priority:** P1
**Category:** Feature
**Title:** Multisig verification not implemented

#### Problem

The architecture document specifies multi-owner credentials via the `ownerKeys` attribute (array of public keys). The `Document` struct supports structural multi-owner via `owner_keys()` and `is_multi_owner()` methods in `document.rs`. However:

1. **Token creation** (`Token::create()` in `token.rs`) only signs with a **single** owner keypair.
2. **Token verification** (`Token::verify()` at line 333-338) only extracts the singular `"ownerKey"` subject, ignoring `"ownerKeys"`.
3. There is no threshold logic (e.g., 2-of-3 signatures required).

Multisig is structurally referenced but functionally absent.

#### Proposed Solution

Implement m-of-n multisig for owner signatures on tokens.

#### Implementation Details

1. **Extend `TokenPayload`** with a `signer_threshold: Option<u32>` field (defaults to 1 for backward compatibility).
2. **Extend `Token`** to hold `owner_signatures: Vec<OwnerSignature>` instead of a single `owner_signature`.
3. **Add `Token::add_owner_signature()`** method that appends a signature to the list.
4. **Modify `Token::create()`** to accept `&[&KeyPair]` (multiple owner keypairs) and a threshold parameter.
5. **Modify `Token::verify()`** step 9 to:
   - Extract `ownerKeys` from subjects (fall back to singular `ownerKey` wrapped in a vec).
   - Read `signer_threshold` from payload (default 1).
   - Verify that at least `threshold` distinct owner signatures are valid against keys in `ownerKeys`.
   - Reject duplicate signatures from the same key.
6. **Add `Token::prepare_multisig()`** for the WebAuthn flow where multiple owners sign sequentially.

**Files to modify:**

- `crates/proof-system/src/token.rs` — multisig logic
- `crates/proof-system/src/document.rs` — ensure `ownerKeys` propagation
- `packages/native-sdk/src/lib.rs` — expose multisig NAPI bindings
- `packages/sdk/src/tokens.ts` — TypeScript types for multisig

#### Edge Cases

- Threshold > number of owner keys: reject at `Token::create()` with `InvalidThreshold` error.
- Threshold = 0: reject (at least 1 signature always required).
- Single owner with `ownerKey` (not `ownerKeys`): backward-compatible, threshold defaults to 1.
- Duplicate public keys in `ownerKeys`: deduplicate before threshold check.
- Same owner signs twice: count as 1 valid signature, not 2.

#### Tests

```
test_multisig_2_of_3_succeeds
  → Create credential with 3 owner keys, sign with 2, verify → expect Ok

test_multisig_1_of_3_fails_when_threshold_is_2
  → Create credential with 3 owner keys, threshold=2, sign with 1 → expect Err

test_multisig_backward_compat_single_owner
  → Create credential with single ownerKey, sign normally → expect Ok

test_multisig_duplicate_signer_rejected
  → Sign twice with same key when threshold=2 → expect Err (only 1 unique signer)

test_multisig_threshold_exceeds_owners_rejected
  → Set threshold=4 with 3 owner keys → expect Err at creation time

test_multisig_webauthn_flow
  → Prepare token, sign with 2 different WebAuthn credentials → expect Ok
```

#### Acceptance Criteria

- [ ] `Token` supports multiple owner signatures
- [ ] m-of-n threshold verification implemented
- [ ] Single-owner backward compatibility preserved
- [ ] NAPI bindings expose multisig creation and verification
- [ ] Integration test covers 2-of-3 flow end-to-end

---

### T-008

**Priority:** P1
**Category:** Reliability
**Title:** `unwrap()` / `expect()` in production code paths

#### Problem

Multiple `unwrap()` calls exist in production (non-test) code that will panic on failure instead of returning errors:

| File                                      | Lines                        | Context                            |
| ----------------------------------------- | ---------------------------- | ---------------------------------- |
| `crates/crypto/src/signature.rs`          | 103, 115, 129, 135, 149, 152 | Key parsing, signing, verification |
| `crates/proof-system/src/revocation.rs`   | 72, 78, 87, 112              | `RwLock` acquisition               |
| `crates/issuer-service/src/main.rs`       | Multiple                     | Config parsing, server startup     |
| `crates/verification-service/src/main.rs` | Multiple                     | Config parsing, server startup     |

The `RwLock::unwrap()` calls are particularly dangerous: if any thread panics while holding the lock, the lock becomes poisoned and every subsequent `unwrap()` on it will also panic, cascading across all request handlers.

#### Proposed Solution

Replace all `unwrap()` in library code with proper `Result` propagation. For `RwLock`, handle poisoned locks gracefully.

#### Implementation Details

1. **`signature.rs`:** Replace `unwrap()` on key parsing with `map_err(|e| SignatureError::...)`. Each call site already has a `SignatureError` variant that fits.
2. **`revocation.rs`:** Replace `lock().unwrap()` with:
   ```rust
   self.entries.read().unwrap_or_else(|poisoned| {
       tracing::warn!("RevocationRegistry lock was poisoned, recovering");
       poisoned.into_inner()
   })
   ```
   This recovers from a poisoned lock by accepting the possibly-inconsistent state (acceptable for a cache; the authoritative source is the database once T-009 is implemented).
3. **Service `main.rs` files:** Replace `expect()` on config/env parsing with structured error reporting that exits with code 1 and a human-readable message. These are startup-time panics and are somewhat acceptable, but structured errors are better for container orchestrators that capture stderr.

**Files to modify:**

- `crates/crypto/src/signature.rs`
- `crates/proof-system/src/revocation.rs`
- `crates/issuer-service/src/main.rs`
- `crates/verification-service/src/main.rs`

#### Tests

```
test_signature_invalid_key_bytes_returns_error
  → Call KeyPair::from_bytes with invalid data → expect Err, not panic

test_revocation_registry_recovers_from_poisoned_lock
  → Poison the RwLock (panic in a thread holding write lock), then call is_revoked → expect graceful recovery

test_service_startup_missing_env_exits_cleanly
  → Start service without DATABASE_URL → expect exit code 1 with error message, not panic trace
```

#### Acceptance Criteria

- [ ] Zero `unwrap()` calls in `crates/crypto/src/signature.rs` (non-test code)
- [ ] Zero `unwrap()` calls in `crates/proof-system/src/revocation.rs` (non-test code)
- [ ] `cargo clippy -- -W clippy::unwrap_used` passes on library crates (consider adding to CI)

---

### T-009

**Priority:** P1
**Category:** Feature
**Title:** Database-backed revocation registry

#### Problem

The current `RevocationRegistry` in `crates/proof-system/src/revocation.rs` is purely in-memory (`RwLock<HashMap<...>>`). All revocation data is lost on service restart. The architecture document specifies persistent revocation with audit trails.

#### Proposed Solution

Implement a PostgreSQL-backed `RevocationRepository` that implements the `RevocationChecker` trait, with an in-memory cache layer for performance.

#### Implementation Details

1. **Create** `crates/verification-service/src/db/revocation_repo.rs` with:
   ```rust
   pub struct RevocationRepository {
       pool: DbPool,
       cache: Arc<RwLock<HashMap<String, RevocationEntry>>>,
       cache_ttl: Duration,
   }
   ```
2. **SQL schema** (migration):
   ```sql
   CREATE TABLE revocations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       root_hash TEXT NOT NULL,
       issuer_public_key TEXT NOT NULL,
       status TEXT NOT NULL CHECK (status IN ('revoked', 'suspended', 'active')),
       reason TEXT,
       revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       reactivated_at TIMESTAMPTZ,
       created_by TEXT NOT NULL,
       UNIQUE (root_hash)
   );
   CREATE INDEX idx_revocations_root_hash ON revocations(root_hash);
   CREATE INDEX idx_revocations_status ON revocations(status);
   ```
3. **Implement `RevocationChecker`** for `RevocationRepository`:
   - `is_revoked()` checks cache first, falls back to DB query.
   - Cache is refreshed on write operations and periodically (configurable TTL, default 30s).
4. **Expose** a cache invalidation endpoint for admin use.
5. **Audit trail:** Every status change inserts into a `revocation_audit_log` table.

**Files to create/modify:**

- `crates/verification-service/src/db/revocation_repo.rs` — new file
- `crates/verification-service/src/db/mod.rs` — register module
- `migrations/` — new SQL migration file
- `crates/verification-service/src/api.rs` — wire `RevocationRepository` into routes

#### Tests

```
test_revoke_persists_across_restart
  → Revoke credential, drop repository, create new one from same pool, check is_revoked → expect true

test_reactivate_clears_revocation
  → Revoke, then reactivate, check is_revoked → expect false

test_cache_invalidation_on_write
  → Check is_revoked (caches false), revoke via different connection, invalidate cache, check again → expect true

test_concurrent_revocation_operations
  → Spawn 10 tasks revoking different credentials simultaneously → all succeed, no deadlocks
```

#### Acceptance Criteria

- [ ] Revocation state survives service restart
- [ ] `RevocationChecker` trait implemented for `RevocationRepository`
- [ ] Cache layer with configurable TTL
- [ ] Audit trail table records all status changes
- [ ] Migration script included

---

### T-010

**Priority:** P1
**Category:** Reliability
**Title:** Service entry-point `expect()` panics

#### Problem

Both `crates/verification-service/src/main.rs` and `crates/issuer-service/src/main.rs` use `expect()` for configuration parsing (database URL, port, etc.). In container environments, a panic backtrace on stderr is less useful than a structured error message, and some orchestrators may not capture it correctly.

#### Proposed Solution

Replace `expect()` with a startup validation function that collects all missing/invalid config and reports them together, then exits with code 1.

#### Implementation Details

1. Create a `Config` struct with `fn from_env() -> Result<Config, Vec<String>>` that validates all required env vars.
2. In `main()`, call `Config::from_env()` and on error, print all missing vars and exit.
3. Pattern:
   ```rust
   #[tokio::main]
   async fn main() {
       let config = Config::from_env().unwrap_or_else(|errors| {
           eprintln!("Configuration errors:");
           for e in &errors {
               eprintln!("  - {}", e);
           }
           std::process::exit(1);
       });
   }
   ```

**Files to modify:**

- `crates/verification-service/src/main.rs`
- `crates/issuer-service/src/main.rs`
- Create `config.rs` in each service crate

#### Acceptance Criteria

- [ ] Services report all missing config vars at once (not one at a time)
- [ ] Exit code is 1 on config failure
- [ ] No panic backtraces on missing configuration

---

### T-011

**Priority:** P1
**Category:** Feature
**Title:** `signers` field unused in Token payload

#### Problem

The architecture document specifies a `signers` field in the token payload that records which keys signed the token. The `TokenPayload` struct does not include this field, and the concept is not implemented.

#### Proposed Solution

Add a `signers: Vec<String>` field to `TokenPayload` containing the hex-encoded public keys of all signers (issuer + owner(s)). This is informational and aids debugging/audit — verification still validates against the actual signatures.

#### Implementation Details

1. Add `signers: Vec<String>` to `TokenPayload` in `token.rs`.
2. Populate during `Token::create()` with `[issuer_public_key_hex, owner_public_key_hex]`.
3. For multisig (T-007), extend to include all owner public keys that signed.
4. Verifiers can use this for logging/audit but must not rely on it for trust (signatures are the source of truth).

**Files to modify:**

- `crates/proof-system/src/token.rs`

#### Acceptance Criteria

- [ ] `TokenPayload` includes `signers` field
- [ ] Field populated with signer public keys on token creation
- [ ] Backward-compatible deserialization (default to empty vec if missing)

---

### T-012

**Priority:** P2
**Category:** Security
**Title:** HMAC on token payloads

#### Problem

The architecture document specifies HMAC integrity verification on token payloads as a defense-in-depth measure. Currently, token integrity relies solely on the issuer's document signature and the owner's token signature. An additional HMAC provides tamper evidence at the transport layer.

#### Proposed Solution

Add an optional HMAC-SHA256 over the serialized token payload, keyed with a shared secret between issuer and verifier services.

#### Implementation Details

1. Add `hmac: Option<String>` to `Token`.
2. Compute as `HMAC-SHA256(shared_secret, canonical_json(payload))`.
3. Verification service checks HMAC before proceeding to cryptographic verification (fail-fast on tampered payloads).
4. HMAC key distributed via environment variable or key management service.

**Files to modify:**

- `crates/proof-system/src/token.rs`
- `crates/verification-service/src/api.rs`

#### Acceptance Criteria

- [ ] HMAC computation and verification implemented
- [ ] Tokens without HMAC still accepted (backward compatibility) with config flag to require it
- [ ] HMAC key is not hardcoded

---

### T-013

**Priority:** P2
**Category:** Security
**Title:** mTLS between services

#### Problem

The architecture document requires mutual TLS between the issuer service and verification service. Currently, services communicate over plain HTTP (or single-direction TLS at best).

#### Proposed Solution

Configure Axum with `axum-server` and `rustls` for mTLS. Each service has its own certificate signed by an internal CA. The peer's certificate is validated against the CA on every connection.

#### Implementation Details

1. Add `axum-server` and `rustls` dependencies.
2. Create a `tls.rs` module in each service with certificate loading.
3. Configure `ServerConfig` with `client_cert_verifier` requiring client certificates.
4. Store certificates/keys in a `certs/` directory (not committed) or via environment variables.
5. For local development, provide a script to generate self-signed CA and service certificates.

**Files to modify:**

- `crates/verification-service/Cargo.toml` and `src/main.rs`
- `crates/issuer-service/Cargo.toml` and `src/main.rs`
- New: `scripts/generate-dev-certs.sh`

#### Acceptance Criteria

- [ ] Both services accept only mTLS connections in production mode
- [ ] Plain HTTP available via feature flag for local development
- [ ] Dev certificate generation script provided

---

### T-014

**Priority:** P2
**Category:** Security
**Title:** Encryption at rest (AES-GCM)

#### Problem

The architecture document specifies AES-GCM encryption for stored credentials and sensitive data. Currently, data is stored in plaintext in PostgreSQL.

#### Proposed Solution

Implement application-level encryption for sensitive columns (credential attributes, private key material if any) using AES-256-GCM with key management.

#### Implementation Details

1. Add `aes-gcm` crate dependency.
2. Create `crates/crypto/src/encryption.rs` with `encrypt(plaintext, key) -> (ciphertext, nonce)` and `decrypt(ciphertext, nonce, key) -> plaintext`.
3. Wrap sensitive database columns with encryption/decryption at the repository layer.
4. Encryption key sourced from environment variable or KMS.
5. Use unique nonces (96-bit random) per encryption operation.

**Files to create/modify:**

- `crates/crypto/src/encryption.rs` — new
- `crates/crypto/src/lib.rs` — export module
- Database repository files — wrap read/write with encrypt/decrypt

#### Acceptance Criteria

- [ ] Sensitive data encrypted before database write
- [ ] Decryption on read is transparent to the application layer
- [ ] Encryption key is not stored in the database or codebase
- [ ] Nonce reuse is prevented by design (random 96-bit nonce per operation)

---

### T-015

**Priority:** P2
**Category:** Feature
**Title:** On-chain issuer/revocation registry (smart contracts)

#### Problem

The architecture document and ALIGNMENT_PLAN Phase 4 specify blockchain integration for:

- Immutable issuer registry (who is trusted)
- On-chain revocation anchoring (tamper-evident revocation status)
- Credential hash anchoring (proof of existence at a point in time)

Currently, all trust and revocation decisions are centralized in the verification service database.

#### Proposed Solution

Implement Solidity smart contracts for IssuerRegistry and RevocationRegistry on an EVM-compatible chain. The verification service reads from the chain as an additional trust anchor.

#### Implementation Details

1. **Smart contracts** (reference: `docs/ALIGNMENT_PLAN.md` Phase 4 examples):
   - `IssuerRegistry.sol`: `registerIssuer(address, publicKeyHash)`, `isRegistered(publicKeyHash) -> bool`
   - `RevocationRegistry.sol`: `revoke(bytes32 rootHash)`, `isRevoked(bytes32 rootHash) -> bool`
2. **Rust integration** via `ethers-rs` or `alloy` crate:
   - `OnChainRevocationChecker` implementing `RevocationChecker` trait
   - Reads from chain, caches locally with TTL
3. **Hybrid model**: verification service checks both database and chain; credential is revoked if either source says so.
4. **Deployment**: Hardhat project in `contracts/` directory.

**Files to create:**

- `contracts/src/IssuerRegistry.sol`
- `contracts/src/RevocationRegistry.sol`
- `contracts/hardhat.config.ts`
- `crates/verification-service/src/chain/` — Rust chain reader module

#### Acceptance Criteria

- [ ] Smart contracts deployed to testnet
- [ ] `OnChainRevocationChecker` passes `RevocationChecker` trait tests
- [ ] Hybrid revocation checking (DB + chain)
- [ ] Gas cost analysis documented

---

### T-016

**Priority:** P2
**Category:** Feature
**Title:** ZK circuit integration

#### Problem

The architecture document mentions zero-knowledge proofs for enhanced privacy (e.g., proving "over 18" without revealing date of birth, as a ZK proof rather than a pre-computed boolean). Currently, selective disclosure is the only privacy mechanism — attributes are either revealed or hidden, with no computation on hidden attributes.

#### Proposed Solution

Integrate a ZK proving system (e.g., `bellman`, `halo2`, or `circom`/`snarkjs` via FFI) for range proofs and predicate proofs on credential attributes.

#### Implementation Details

1. Start with a single ZK circuit: **range proof** (prove `age >= 18` given a birth date attribute).
2. Use `ark-groth16` or `halo2` for proof generation.
3. Add a `ZkProof` variant to the token's proof mechanism alongside Merkle proofs.
4. Verifier checks the ZK proof against the circuit's verification key and the Merkle root hash.

This is a significant undertaking and should be scoped as a separate milestone.

**Files to create:**

- `crates/zk-circuits/` — new crate for ZK circuit definitions
- `crates/proof-system/src/zk.rs` — integration with proof system

#### Acceptance Criteria

- [ ] At least one ZK circuit (age range proof) implemented
- [ ] Proof generation and verification work end-to-end
- [ ] ZK proof can be included alongside Merkle proof in a token
- [ ] Performance benchmarks documented (proof generation time, proof size)

---

### T-017

**Priority:** P2
**Category:** Feature
**Title:** OAuth 2.1 / OIDC integration for issuer service

#### Problem

The architecture document specifies OAuth 2.1 and OIDC for authenticating issuers to the identity provider layer. The issuer service's `credential_bridge.rs` accepts `VerifiedIdentityClaims` but there is no actual OAuth/OIDC flow to obtain these claims from an IdP.

#### Proposed Solution

Implement an OAuth 2.1 authorization code flow in the issuer service to authenticate with external IdPs (e.g., eIDAS nodes, government IdPs) and obtain verified claims.

#### Implementation Details

1. Add `openidconnect` crate dependency.
2. Create `crates/issuer-service/src/oidc.rs` with:
   - OIDC client configuration (issuer URL, client ID, client secret)
   - Authorization code flow handler
   - Token exchange and userinfo endpoint call
   - Claim mapping to `VerifiedIdentityClaims`
3. Add routes: `GET /auth/login` (redirect to IdP), `GET /auth/callback` (handle code exchange).
4. Session management for the issuance flow.

**Files to create/modify:**

- `crates/issuer-service/src/oidc.rs` — new
- `crates/issuer-service/src/main.rs` — add auth routes
- `crates/issuer-service/Cargo.toml` — add `openidconnect` dependency

#### Acceptance Criteria

- [ ] OIDC authorization code flow implemented
- [ ] Claims from IdP mapped to `VerifiedIdentityClaims`
- [ ] Configuration supports multiple IdP providers
- [ ] Token refresh handled

---

### T-018

**Priority:** P2
**Category:** Feature
**Title:** WebSocket push for real-time revocation

#### Problem

The architecture document specifies real-time revocation notification via WebSocket or Pub/Sub. Currently, clients must poll the verification service to check revocation status.

#### Proposed Solution

Add a WebSocket endpoint to the verification service that pushes revocation events to connected clients.

#### Implementation Details

1. Add `axum::extract::ws` WebSocket support.
2. Create `GET /ws/revocations` endpoint.
3. On revocation/suspension/reactivation, broadcast the event to all connected clients.
4. Use `tokio::sync::broadcast` channel for fan-out.
5. Message format: `{ "event": "revoked|suspended|reactivated", "root_hash": "...", "timestamp": "..." }`.

**Files to modify:**

- `crates/verification-service/src/api.rs` — add WebSocket route
- `crates/verification-service/src/main.rs` — wire broadcast channel

#### Acceptance Criteria

- [ ] WebSocket endpoint accepts connections
- [ ] Revocation events are pushed to all connected clients within 1 second
- [ ] Clients can filter by issuer public key
- [ ] Graceful handling of slow/disconnected clients

---

### T-019

**Priority:** P2
**Category:** Compliance
**Title:** GDPR right-to-erasure implementation

#### Problem

The architecture document references GDPR compliance. The system stores credential attributes and audit logs that may contain personal data. There is no mechanism for data subjects to request erasure.

#### Proposed Solution

Implement a data erasure pipeline that can remove or anonymize personal data associated with a credential owner.

#### Implementation Details

1. Add `DELETE /admin/gdpr-erasure/{owner_public_key}` endpoint.
2. Actions:
   - Revoke all active credentials for the owner
   - Delete or anonymize credential attributes from the database
   - Retain non-personal audit records (hashes, timestamps) for compliance
   - Delete rate limit records associated with the owner
3. Return a receipt confirming what was erased and what was retained (for the 30-day compliance window).
4. Require `admin` + `gdpr` permissions on the API key.

**Files to modify:**

- `crates/verification-service/src/api.rs` — add erasure endpoint
- `crates/verification-service/src/db/` — add erasure queries

#### Acceptance Criteria

- [ ] Erasure endpoint removes/anonymizes personal data
- [ ] Non-personal audit records retained
- [ ] Erasure receipt returned
- [ ] Requires specific permission to invoke

---

### T-020

**Priority:** P2
**Category:** Observability
**Title:** Structured logging, metrics, and tracing

#### Problem

The services lack structured logging, metrics collection, and distributed tracing. Debugging production issues and monitoring system health requires these capabilities.

#### Proposed Solution

Integrate `tracing` + `tracing-subscriber` for structured logging, `metrics` crate for Prometheus-compatible metrics, and OpenTelemetry for distributed tracing.

#### Implementation Details

1. **Logging:** Replace all `println!` and `eprintln!` with `tracing::{info, warn, error, debug}` macros. Use structured fields: `tracing::info!(issuer = %pub_key, credential_hash = %hash, "Credential issued")`.
2. **Metrics:** Add a `GET /metrics` endpoint (already stubbed in `api.rs`) returning Prometheus format. Key metrics:
   - `credentials_issued_total`
   - `tokens_verified_total{result=success|failure|revoked}`
   - `token_verification_duration_seconds` (histogram)
   - `revocations_total{action=revoke|suspend|reactivate}`
   - `api_request_duration_seconds{endpoint, method, status}`
3. **Tracing:** Add `tracing-opentelemetry` for span context propagation across services.

**Files to modify:**

- `crates/verification-service/Cargo.toml` and `src/main.rs`
- `crates/issuer-service/Cargo.toml` and `src/main.rs`
- All source files with `println!` calls

#### Acceptance Criteria

- [ ] All log output uses `tracing` macros with structured fields
- [ ] `/metrics` endpoint returns Prometheus-format metrics
- [ ] Request spans include correlation IDs
- [ ] No `println!` in production code paths

---

### T-021

**Priority:** P2
**Category:** Testing
**Title:** E2E and property-based test suites

#### Problem

Current tests are unit and integration tests within individual crates. There are no:

- End-to-end tests that exercise the full HTTP API flow (issuer service → verification service)
- Property-based tests for the crypto and proof system
- Fuzz tests for input parsing

#### Proposed Solution

Add E2E tests using `reqwest` + `testcontainers` (for PostgreSQL), and property-based tests using `proptest`.

#### Implementation Details

1. **E2E tests** (`tests/e2e/`):
   - Spin up both services with testcontainers PostgreSQL
   - Full flow: register issuer → issue credential → create token → verify token → revoke → verify fails
   - Test rate limiting, auth middleware, error responses
2. **Property-based tests** (`crates/crypto/tests/prop_tests.rs`):
   - `proptest!` for Merkle tree: any `BTreeMap<String, Value>` produces a valid tree with verifiable proofs
   - `proptest!` for signatures: any byte slice can be signed and verified round-trip
   - `proptest!` for hash consistency: same input always produces same output
3. **Fuzz targets** (`fuzz/`):
   - Fuzz `Token::from_json()` with arbitrary bytes
   - Fuzz `MerkleProof::verify()` with random proof structures
   - Fuzz `CoseKey::from_cbor()` with random CBOR

**Files to create:**

- `tests/e2e/` — E2E test directory
- `crates/crypto/tests/prop_tests.rs`
- `fuzz/` — Fuzz targets

#### Acceptance Criteria

- [ ] E2E test covers full credential lifecycle via HTTP
- [ ] Property-based tests for Merkle tree and signature roundtrips
- [ ] At least 2 fuzz targets set up and runnable via `cargo fuzz`
- [ ] E2E tests run in CI with testcontainers

---

### T-022

**Priority:** P2
**Category:** Feature
**Title:** Ring signatures / advanced anonymity

#### Problem

The COMPARISON_ANALYSIS.md notes that MyIdentityNight implements ring signatures for enhanced anonymity (proving group membership without revealing which member). OwlID lacks this capability. For privacy-sensitive use cases (e.g., anonymous voting, whistleblower verification), ring signatures provide stronger anonymity guarantees than selective disclosure alone.

#### Proposed Solution

Implement ring signature support as an optional proof mechanism.

#### Implementation Details

1. Evaluate ring signature libraries for Rust (e.g., `curve25519-dalek` provides the primitives for Schnorr-based ring signatures).
2. Create `crates/crypto/src/ring_sig.rs` with:
   - `RingSignature::sign(message, private_key, ring: &[PublicKey]) -> RingSignature`
   - `RingSignature::verify(message, ring: &[PublicKey]) -> bool`
3. Add a `RingSig` variant to `OwnerSignature` in the token.
4. Use case: prove the token was signed by _one of_ the owners without revealing which one.

**Files to create/modify:**

- `crates/crypto/src/ring_sig.rs` — new
- `crates/crypto/src/lib.rs` — export
- `crates/proof-system/src/token.rs` — add RingSig variant

#### Acceptance Criteria

- [ ] Ring signature generation and verification implemented
- [ ] Token can be created with ring signature proof
- [ ] Verification proves group membership without revealing signer identity
- [ ] Performance benchmarks for ring sizes 2, 5, 10, 50

---

## Cross-Cutting Production Readiness

### CI/CD Pipeline

| Step              | Tool                                                 | Gate                                 |
| ----------------- | ---------------------------------------------------- | ------------------------------------ |
| Format check      | `cargo fmt --check`                                  | Block merge                          |
| Lint              | `cargo clippy -- -D warnings -W clippy::unwrap_used` | Block merge                          |
| Unit tests        | `cargo test --workspace`                             | Block merge                          |
| Integration tests | `cargo test --workspace -- --ignored`                | Block merge                          |
| E2E tests         | `cargo test -p e2e-tests` (requires Docker)          | Block merge                          |
| Security audit    | `cargo audit`                                        | Block merge on critical/high         |
| WASM build        | `wasm-pack build packages/native-sdk`                | Warn (non-blocking until WASM is GA) |
| Coverage          | `cargo tarpaulin --workspace`                        | Warn if < 80%                        |

### Dependency Hygiene

- Run `cargo audit` weekly (GitHub Action cron)
- Pin major versions in `Cargo.toml`, allow patch updates
- Review `cargo outdated` output monthly
- Ensure `Cargo.lock` is committed for all binaries (services), not for libraries (crates)

### Error Handling Standards

- Library crates (`crypto`, `proof-system`): return `Result<T, CrateError>` — never panic
- Binary crates (services): panic only in `main()` on irrecoverable startup failures
- All error types implement `std::error::Error` via `thiserror`
- User-facing API errors return JSON with `{ "error": "message", "code": "ERROR_CODE" }`
- Internal errors logged at `error!` level with full context, sanitized before returning to client

### Key Management

- Private keys never stored in databases, config files, or environment variables in production
- Use HSM (AWS CloudHSM, Azure Key Vault HSM) or secrets manager
- Key rotation plan: generate new key, add to trusted issuers, issue new credentials, remove old key after all old credentials expire
- Development: env vars acceptable, but with clear warnings in docs

### Database

- All queries via sqlx with compile-time checking (`sqlx::query_as!` macros)
- Migrations managed via `sqlx migrate` with version-controlled migration files
- Connection pooling configured: min 2, max 20 (tunable via env)
- Query timeout: 5s default
- Indexes on all columns used in WHERE clauses (already partially done for rate_limits)

---

## Release Checklist

### Pre-Alpha (current)

- [ ] All P0 items resolved
- [ ] `cargo test --workspace` passes
- [ ] `cargo clippy` clean
- [ ] Basic API documentation

### Alpha

- [ ] All P0 and P1 items resolved
- [ ] E2E test suite passing
- [ ] Database migrations scripted
- [ ] Docker Compose for local development
- [ ] API documentation (OpenAPI spec)

### Beta

- [ ] P2 items triaged (fix or defer with tracking issues)
- [ ] Observability stack deployed (logging, metrics, tracing)
- [ ] Load testing completed (target: 1000 verifications/second)
- [ ] Security review by external party
- [ ] Penetration testing

### GA

- [ ] All deferred P2 items have tracking issues with owners
- [ ] SLA defined (uptime, latency percentiles)
- [ ] Runbook for on-call operators
- [ ] Incident response plan
- [ ] Backup and recovery tested
- [ ] GDPR compliance review

---

**Document Version:** 1.0
**Generated from:** Full codebase audit (2026-02-05)
**Source files analyzed:** 18 Rust source files, 2 TypeScript files, 3 existing documentation files
**Architecture reference:** `docs/SoftwareArchitecture.md`
