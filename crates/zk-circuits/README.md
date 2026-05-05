# owl-zk-circuits

Zero-knowledge predicate circuits for OwlID. Groth16 proving system over the BLS12-381 curve via `arkworks`.

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

The circuits are normally driven from `owl-proof-system::zk` rather than directly. If you need to call them at the circuit level:

```rust
use owl_zk_circuits::age_range;

// One-time setup is cached; subsequent calls reuse the keys.
let proof = age_range::prove(/* witness */ 1990, /* threshold */ 2008)?;
let ok = age_range::verify(&proof, /* threshold */ 2008)?;
```

See `crates/proof-system/src/zk.rs` for the production wrapper that routes proof requests to the right circuit and packages the proof bytes into a `Token`.

## Tests

```bash
cargo test -p owl-zk-circuits
```

The first run is slow (key generation). Subsequent runs reuse the cached keys.
