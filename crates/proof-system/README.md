# owl-proof-system

Document, credential, and token logic for OwlID. Sits on top of `owl-crypto`. Provides the verifiable-credential primitives that the verification + issuer services and the SDK both consume.

## Public surface

| Symbol                                                      | Purpose                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `Document`                                                  | Unsigned attribute container, validates required keys         |
| `ProofDocument`                                             | Signed Merkle-rooted credential (output of `Document::issue`) |
| `Token`, `TokenPayload`, `PreparedToken`                    | Selective-disclosure proof tokens                             |
| `ProofRequest`, `PredicateRequest`, `PredicateOp`           | Verifier's request shape                                      |
| `OwnerSignature` (`Standard` \| `WebAuthn` \| `Ring`)       | Multi-mode owner signing                                      |
| `RevocationRegistry`, `RevocationEntry`, `RevocationStatus` | In-memory revocation index                                    |
| `RevocationChecker` (trait)                                 | Pluggable revocation source for `Token::verify`               |
| `CredentialSchema`, `AttributeType`                         | JSON-Schema-style credential validation                       |
| `generate_predicate_proof`, `verify_zk_proof`               | Bridge to `owl-zk-circuits` for predicate proving             |

## Lifecycle

```rust
use owl_crypto::KeyPair;
use owl_proof_system::{Document, Token, ProofRequest, PredicateOp, PredicateRequest};
use owl_proof_system::revocation::RevocationRegistry;
use serde_json::json;
use std::collections::BTreeMap;

let issuer = KeyPair::generate();
let owner  = KeyPair::generate();

// Build + issue
let mut attrs = BTreeMap::new();
attrs.insert("issuerKey".into(), json!(issuer.public_key().to_hex()));
attrs.insert("ownerKey".into(),  json!(owner.public_key().to_hex()));
attrs.insert("name".into(),      json!("Alice"));
attrs.insert("dateOfBirth".into(), json!("1990-05-15"));

let doc = Document::new(attrs)?;
let mut credential = doc.issue(&issuer);

// Build a proof request (verifier-side)
let request = ProofRequest {
    disclose: vec!["name".into()],
    predicates: vec![PredicateRequest {
        attribute: "dateOfBirth".into(),
        op: PredicateOp::GreaterOrEqual,
        value: json!("18"),
    }],
    trusted_issuers: vec![issuer.public_key().to_hex()],
    challenge: "uuid-from-verifier".into(),
};

// Generate (holder-side, in 1 phase for raw Ed25519 owner)
let token = Token::generate(&mut credential, &request, &owner, /* ttl_secs */ 300)?;

// Verify (verifier-side)
let registry = RevocationRegistry::new();
let disclosed = token.verify(&[issuer.public_key()], &request.challenge, &registry)?;
```

For WebAuthn-backed signing, use the `prepare` / `finalize_webauthn` two-phase flow so the secure-enclave private key never leaves the device.

## Compact encoding

Tokens serialize through a `JSON → CBOR → zstd → Base45 → "OID1:" prefix` pipeline (`compact.rs`). Typical compact size is 500–1500 bytes, fits a QR code.

```rust
let compact = token.to_compact()?;            // "OID1:KAGZ…"
let restored = Token::from_compact(&compact)?;
```

## Predicate proofs

Predicates produce ZK proofs via `owl-zk-circuits` (Groth16 over BLS12-381):

| Predicate           | Circuit       | Proves                                   |
| ------------------- | ------------- | ---------------------------------------- |
| `GreaterOrEqual`    | `age_range`   | numeric attribute ≥ threshold            |
| `InSet`             | `nationality` | attribute ∈ public set (Pedersen Merkle) |
| KYC level (planned) | `kyc_status`  | KYC level ≥ threshold                    |

Calls `generate_predicate_proof` during token build; `verify_zk_proof` runs during `Token::verify`. Both use cached proving / verifying keys (single setup per circuit).

## Revocation

`RevocationRegistry` is an in-memory keyset of revoked credential root-hashes. Production deployments back this with a database via the `RevocationChecker` trait — both the verification service and the Midnight sidecar implement it.

## Tests

```bash
cargo test -p owl-proof-system
```
