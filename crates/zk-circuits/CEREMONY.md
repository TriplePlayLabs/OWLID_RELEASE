# Trusted-Setup Ceremony Plan

The Groth16 proving + verifying keys committed under `artifacts/` come from
`src/bin/keygen.rs` running with **fixed deterministic seeds**. The toxic
waste from a fixed-seed setup is recoverable by anyone with the source —
i.e. anyone with read access to this repository. A holder of the toxic
waste can forge proofs that verify against the committed verifying keys.

**This is acceptable for development and CI only.** Before deploying
verification-service to a production environment that accepts proofs from
real users, replace the dev artifacts with the output of a multi-party
ceremony. This document is the playbook.

## Threat model

What the ceremony must guarantee: at least one honest contributor's
randomness was destroyed. Output is safe iff at least one participant
behaves honestly. A 1-of-N trust model.

What it does _not_ protect against:

- Bugs in the circuits themselves (independent audit needed)
- Bugs in arkworks' Groth16 implementation (track upstream advisories)
- Verifier-side compromise (separate operational concern)

## Two-phase Groth16 setup

Groth16 needs two ceremony phases:

1. **Phase 1 — Powers of Tau (universal)**  
   Produces a generic structured reference string usable by _any_ circuit
   up to a given constraint count. **Do not run this yourself.** Reuse a
   well-attended community ceremony:
   - **Hermez perpetual ceremony** — ongoing, ~256+ contributors over BN254.
     Snapshots: <https://github.com/iden3/snarkjs?tab=readme-ov-file#7-prepare-phase-2>.
   - **Aztec Ignition** — completed, ~176 contributors over BN254.
   - **Ethereum KZG ceremony** (PSE-coordinated) — for KZG-based schemes.

   Our circuits run over **BLS12-381** (matches Zcash Sapling). Phase-1
   options here are thinner — the most reused output is the **Filecoin
   Powers of Tau** for BLS12-381 (Zcash + Filecoin contributions). If
   migrating to BN254 is acceptable, the Hermez ceremony output is the
   cleanest path because it's 1) larger, 2) more contributors, 3) better
   tooled. Decide curve before scheduling participants.

2. **Phase 2 — circuit-specific**  
   Each of our three circuits (`age_range`, `kyc_status`, `nationality`)
   needs its own Phase-2 ceremony. Each contributor mixes their secret
   randomness into the circuit-specific keys derived from the Phase-1
   transcript.

## Tooling

Two viable paths:

### Path A — snarkjs (recommended for the first ceremony)

snarkjs is the most mature Phase-2 tooling. Works over BN254. Requires
porting circuits from arkworks → circom (mechanical translation, ~1 day
per circuit, can be done while keeping arkworks as the proving backend
via verifying-key-only export). Steps per circuit:

```bash
# Phase 1 — fetch Hermez Phase-1 transcript at appropriate power
snarkjs powersoftau new bn128 18 pot18_0000.ptau
# (skip if reusing Hermez — just download the latest .ptau)
snarkjs powersoftau verify ./hermez_final.ptau

# Compile circuit
circom age_range.circom --r1cs --wasm

# Phase 2 — initial setup (one machine, public)
snarkjs groth16 setup age_range.r1cs hermez_final.ptau age_range_0000.zkey

# Each contributor (offline machine, fresh OS install recommended)
snarkjs zkey contribute age_range_0000.zkey age_range_0001.zkey \
    --name="Alice" -v -e="<random entropy from secure source>"
# attest (PGP-signed transcript hash) and pass to next contributor

# After N contributions, finalize with a beacon
snarkjs zkey beacon age_range_N.zkey age_range_final.zkey \
    <drand_round_hash> 10 -n="Final Beacon"

# Export verifying key
snarkjs zkey export verificationkey age_range_final.zkey age_range_vk.json
```

The final `.zkey` and `vk.json` are the artifacts. Convert into the
ark-serialize compressed format this lib expects via a small adapter
(snarkjs JSON → ark-groth16 `ProvingKey` / `PreparedVerifyingKey`).

### Path B — arkworks-native MPC

Less mature. Crates: `ark-mpc-snark` (early, audit unclear),
`ark-poly-commit` ceremony helpers. Pros: no circuit translation. Cons:
fewer contributors comfortable with the toolchain → narrower 1-of-N
trust set → weaker security guarantee in practice.

If picking Path B: announce the procedure publicly first, run a dry-run
ceremony with internal contributors only, audit the transcripts, then
open to external contributors.

## Operational checklist

- [ ] Decide curve (BLS12-381 vs migrate to BN254). Document the choice.
- [ ] Pick tooling path (snarkjs preferred for ceremony breadth).
- [ ] Recruit ≥7 external contributors. Mix of organizations/jurisdictions.
- [ ] Publish ceremony procedure + circuit hashes ≥2 weeks before start.
- [ ] Each contributor: airgapped machine, fresh OS, destroys disk after.
- [ ] Each contribution: PGP-signed transcript hash posted publicly.
- [ ] Final beacon: latest drand round at a pre-announced time.
- [ ] Coordinator publishes final transcript + every intermediate `.zkey`.
- [ ] Independent verifiers re-run `snarkjs zkey verify` end-to-end.
- [ ] Replace `crates/zk-circuits/artifacts/*.bin` with the ceremony
      output, regenerate the proving-key bytes served at
      `/zk-keys/<circuit>.pk.bin`, ship a release.
- [ ] Tag the commit; pin the verifier service at this commit until the
      next ceremony.

## When to re-run

A ceremony output is bound to a specific circuit. Re-run when:

1. Any circuit definition changes (constraint additions, new public
   inputs, etc.).
2. A new circuit is added.
3. A contributor's compromise is later disclosed _and_ they were the
   only honest party (1-of-N broken).
4. A vulnerability in arkworks' Groth16 forces an upgrade that changes
   key serialization.

Bumping the curve or proving system (e.g. moving to Plonk-KZG) requires
a brand new ceremony but lets us reuse a single universal Powers-of-Tau
output across all future circuits.

## What does _not_ require a ceremony

- Verifying-key changes are derived from the proving-key ceremony — no
  separate ceremony.
- Set-membership dataset changes (e.g. updating the EU country list)
  are pinned by `availablePredicates` in the issuer signing input and
  the `data` module; no key change.
- Issuer/verifier key rotation — those are application-layer keys
  (Ed25519 / P-256), unrelated to the Groth16 setup.

## Audit log

Record every ceremony here:

| Date | Curve | Phase-1 source                     | Contributors      | Beacon | Commit  |
| ---- | ----- | ---------------------------------- | ----------------- | ------ | ------- |
| —    | —     | dev seed (`StdRng::seed_from_u64`) | 1 (deterministic) | —      | initial |

Replace the row above with real ceremony entries as they happen. Never
delete past rows.
