# owl-zk-circuits

Zero-knowledge predicate circuits for OwlID. Groth16 proving system over the BLS12-381 curve via `arkworks`.

These circuits are **issuer-side** compute (and historically holder-device attestation feeding the Midnight per-kind predicate contracts). The verifier reads results as standard SD-JWT VC claims (`age_over_NN`, `kyc_level`, `nationalities`) — it does not run a Groth16 verifier on the hot path.

## Circuits

| Module        | Predicate          | Use case                                                      |
| ------------- | ------------------ | ------------------------------------------------------------- |
| `age_range`   | `age >= threshold` | "is over 18", "is over 65" — without revealing date of birth  |
| `nationality` | `nationality ∈ S`  | "is EU citizen", "is in NATO" — without revealing the country |
| `kyc_status`  | `kyc_level >= n`   | "is KYC-verified to tier 2" — without revealing KYC details   |

`pedersen.rs` implements a JubJub Pedersen-hash Merkle tree used by `nationality` to keep the public input a single field element.

## Public surface

```rust
use owl_zk_circuits::{ZkProof, ZkProofType, ZkError};
```

Proving + verifying keys are derived once per circuit on first use, cached behind a `LazyLock`. This guarantees that a proof generated with `get_pk()` always verifies under `get_pvk()` — no setup mismatch.

## Usage

```rust
use owl_zk_circuits::age_range;

// One-time setup is cached; subsequent calls reuse the keys.
let proof = age_range::prove(/* witness */ 1990, /* threshold */ 2008)?;
let ok = age_range::verify(&proof, /* threshold */ 2008)?;
```

Predicate canonical encoding + the on-chain attestation key derivation live in `crates/proof-system/src/{predicates,attestation,predicate_attestation}.rs`. The verifier recomputes the attestation key from the credential's issuer-signed claims and checks set membership against the SSE-mirrored projection of the per-kind Midnight predicate contracts.

## Tests

```bash
cargo test -p owl-zk-circuits
```

The first run is slow (key generation). Subsequent runs reuse the cached keys.
