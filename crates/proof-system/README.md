# owl-proof-system

SD-JWT VC + IETF Token Status List + revocation + schema validation for OwlID. Sits on top of `owl-crypto`. Provides the verifiable-credential primitives that the verification + issuer services and the SDK both consume.

## Public surface

| Symbol                                                                                                 | Purpose                                                                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `sd_jwt::KeyPair`, `sd_jwt::PublicKey`                                                                 | Holder confirmation key (Ed25519 / P-256)                                        |
| `sd_jwt::SdJwtVc`                                                                                      | SD-JWT VC parse + present + KB-JWT signing                                       |
| `sd_jwt::verify_sd_jwt`                                                                                | Issuer-side or relying-party-side SD-JWT VC verification                         |
| `sd_jwt::credential_id_hex`                                                                            | Normalizes the credential id to the raw 32-byte hex form Compact registries want |
| `sd_jwt::peek_iss`                                                                                     | Cheap extraction of `iss` (did:web) without full verify                          |
| `status_list::StatusList`, `status_list::issue_status_list_jwt`, `status_list::verify_status_list_jwt` | IETF Token Status List (`statuslist+jwt`) build + verify                         |
| `predicates::PredicateOp`, `predicates::derive_available_predicates`, `predicates::canonical_*`        | Predicate id + canonical encoding                                                |
| `predicate_attestation::PredicateAttestation`                                                          | The attestation payload the verifier recomputes the on-chain key from            |
| `attestation`                                                                                          | Off-chain key recompute (`SHA-256(pad32(tag) ‖ rootHash ‖ paramLE32)`)           |
| `revocation::RevocationRegistry`, `RevocationChecker` (trait)                                          | In-memory revocation index + pluggable revocation source                         |
| `schema::CredentialSchema`, `AttributeType`                                                            | JSON-Schema-style credential validation                                          |

There is **no** `Document` / `ProofDocument` / `Token` / `TokenPayload` / `Compact` / inline-Groth16 ZK proof type in this crate any more. Those were the proprietary OID1 wire format; they have been deleted in favour of SD-JWT VC.

## Issuance + presentation

```rust
use owl_crypto::KeyPair as IssuerKey;
use owl_proof_system::sd_jwt::{KeyPair, SdJwtVc, build_sd_jwt_vc, verify_sd_jwt};
use serde_json::json;

let issuer = IssuerKey::generate();
let holder = KeyPair::generate_ed25519();

// Issuer signs an SD-JWT VC.
let sd_jwt_vc = build_sd_jwt_vc(
    &issuer,
    "did:web:issuer.example.com",
    &holder.public_key(),
    json!({
        "given_name":   "Alice",
        "family_name":  "Wonderland",
        "birthdate":    "1990-05-15",
        "age_over_18":  true,
        "nationalities": ["NL"],
    }),
    /* expires_in */ 3600,
)?;

// Holder builds a presentation that discloses only what the verifier asked
// for, plus a KB-JWT bound to the verifier's nonce + audience.
let credential   = SdJwtVc::parse(&sd_jwt_vc)?;
let presentation = credential.present(
    &["given_name", "age_over_18"],
    &holder,
    "https://verifier.example.com",
    "nonce-xyz",
)?;

// Verifier verifies the presentation.
let verified = verify_sd_jwt(
    &presentation,
    &[issuer.public_key()],
    "https://verifier.example.com",
    "nonce-xyz",
)?;
```

## IETF Token Status List

```rust
use owl_proof_system::status_list::{StatusList, issue_status_list_jwt, verify_status_list_jwt};

let mut list = StatusList::new(/* size_bits */ 1 << 20);
list.set_revoked(42, true);

// Issuer signs a statuslist+jwt JWS (EdDSA) for /status/{id}.
let jwt = issue_status_list_jwt(&issuer_keypair, "https://issuer.example.com/status/1", &list)?;

// Verifier downloads + verifies.
let restored = verify_status_list_jwt(&jwt, &issuer.public_key())?;
assert!(restored.is_revoked(42));
```

## Predicate attestations (issuer-side compute)

`PredicateAttestation { predicate, threshold, … }` is the input the verifier hashes (`attestation::*_key`) to recompute the on-chain attestation slot. Seven per-kind Midnight Compact contracts (`predicate_age`, `predicate_kyc`, `predicate_residency`, `predicate_email`, `predicate_nationality`, `predicate_age_range`, `predicate_personhood`) hold the attested set — one Compact contract per predicate kind, forced apart by Midnight's per-extrinsic block-weight cap. The verifier consults a single SSE-mirrored projection (the key recipe is shared across kinds) and surfaces a positive attestation to the holder as a standard SD-JWT VC claim (`age_over_NN`, `kyc_level`, `nationalities`, `email_verified`, …). The wire format the verifier reads is SD-JWT VC — there is no separate envelope.

## Revocation

`RevocationRegistry` is an in-memory keyset of revoked credential ids (raw 32-byte hex). Production deployments back this with the on-chain `revocation_registry` via the `RevocationChecker` trait — both the verification service (in-memory + Postgres + SSE-mirrored) and the Midnight sidecar implement it.

## Tests

```bash
cargo test -p owl-proof-system
```
