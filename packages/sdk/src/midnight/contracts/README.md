# predicate-contracts (vendored, generated)

One subdirectory per predicate kind:

- `age/` — `attestAgeGte(rootHash, threshold)`
- `kyc/` — `attestKycGte(rootHash, threshold)`
- `residency/` — `attestResidency(rootHash)`
- `email/` — `attestEmailVerified(rootHash)`
- `nationality/` — `attestNationalityIn(rootHash)` (set-membership via `approvedNationality` HistoricMerkleTree)
- `age_range/` — `attestAgeRange(rootHash, minAge, maxAge)`
- `personhood/` — `attestUniquePersonhood(rootHash, epoch, appId)`

Each `index.js` / `index.d.ts` is the compactc-generated ABI/codec module
for the corresponding `predicate_<kind>.compact` contract. **Do not
hand-edit them** — they are byte-identical copies of the compiler output,
the same way the OpenAPI clients are generated artifacts.

The split is forced by Midnight's per-extrinsic block-weight cap: a single
bundled multi-predicate contract exceeds the devnet weight limit at deploy
time. Each kind ships independently and gets its own
`MIDNIGHT_PREDICATE_<KIND>_ADDRESS`.

- Source of truth: `packages/midnight-sidecar/managed/predicate_<kind>/contract/`
- Resync after a contract change: `bun run sync:predicate-contracts`

Only the small ABI modules are vendored. The multi-MB ZK artifacts
(`*.bzkir` / `*.prover` / `*.verifier`) are **not** bundled — the holder
fetches them lazily from the verification-service `/predicate-zk` endpoint
through the layered cache in `../predicate-assets.ts`.

Each module imports only `@midnight-ntwrk/compact-runtime` (already an SDK
dependency at the matching `0.16.0` version it `checkRuntimeVersion`s).
