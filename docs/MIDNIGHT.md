# The Midnight Stack

Maintainer reference for OwlID's Midnight integration — the network, the
sidecar, on-chain state sync, contract deployment, and witness-on-device
predicate proving. For the contracts themselves see `COMPACT_CONTRACTS.md`;
for the system picture see `ARCHITECTURE.md`.

## Midnight is the required core

OwlID does not have a Midnight on/off switch. Issuer trust, revocation,
identity anchoring, and predicate attestation are all computed or anchored on
Midnight. The verification and issuer services probe the sidecar at startup
and **exit** if it is unreachable — there is no in-memory-only or degraded
mode. Standards-shaped formats (SD-JWT VC, Token Status List, did:web) are
projections of on-chain state, not a separate source of truth.

> Historical note: earlier revisions made Midnight optional behind a feature
> flag. That code is gone. Do not reintroduce an "is Midnight enabled" branch.

---

## 1. The Midnight network

Three processes, run locally as `docker-compose.midnight.yml`:

| Process      | Image                                    | Port | Role                                       |
| ------------ | ---------------------------------------- | ---- | ------------------------------------------ |
| Node         | `midnightntwrk/midnight-node:0.22.3`     | 9944 | Consensus + RPC (`ws://`), `/health`.      |
| Indexer      | `midnightntwrk/indexer-standalone:4.0.1` | 8088 | GraphQL `/api/v3/graphql` (HTTP + WS sub). |
| Proof server | `midnightntwrk/proof-server:8.0.3`       | 6300 | Transaction proof generation, `/version`.  |

`just midnight-up` / `midnight-down` / `midnight-reset` (`-v`, wipes chain
data) / `midnight-status` / `midnight-logs`.

Two network targets, selected by the active `.env` symlink (`just env local`
or `just env preview`):

- **local devnet** — `CFG_PRESET=dev`, `NETWORK_ID=undeployed`. The genesis
  seed has pre-minted NIGHT. Chain data is ephemeral (no volumes); a reset
  means redeploying contracts.
- **preview testnet** — `rpc.preview.midnight.network` etc. Uses a real wallet
  mnemonic; secrets come from GCP Secret Manager (`just env-from-gcloud`).

---

## 2. The midnight-sidecar service

`packages/midnight-sidecar` — **Bun + Hono, port 3000**. It is the **only
chain-aware process** in OwlID. The Rust services and the apps never import a
Midnight SDK; they speak REST + SSE to the sidecar. The sidecar is
**internal-only** — never expose it publicly.

It wraps the Midnight JS stack: `@midnight-ntwrk/midnight-js-*` v4.0.4,
`ledger-v8`, `compact-js` / `compact-runtime`, `zkir-v2` (the in-process WASM
prover), and the `wallet-sdk-*` family (for balancing + submitting
transactions).

**Source layout**

| File                 | Role                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `index.ts`           | Hono app, route mounting, API-key middleware.                    |
| `config.ts`          | Env-driven config — network endpoints, contract addresses.       |
| `client.ts`          | Midnight providers (node, indexer, proof server, private state). |
| `wallet.ts`          | Sidecar wallet — balances + submits chain transactions.          |
| `deploy.ts`          | Contract deployment (`bun run deploy`).                          |
| `compile-all.ts`     | Compiles every Compact contract.                                 |
| `events.ts`          | Diffs `contractStateObservable`, emits typed SSE events.         |
| `midnight.ts`        | Contract-call orchestration.                                     |
| `inprocess-proof.ts` | In-process zkir-v2 prover (backend-side balancing / fallback).   |
| `witnesses.ts`       | Witness providers for sidecar-side contract calls.               |
| `routes/*.ts`        | `issuer`, `revocation`, `identity`, `predicates`, `events`.      |

**Routes** (all `/api/*` and `/events` require `Authorization: Bearer
<MIDNIGHT_SIDECAR_API_KEY>`; `/health` is open):

- `/api/issuers/*` — `issuer_registry` operations.
- `/api/revocations/*` — `revocation_registry` operations.
- `/api/identities/*` — `identity_registry` operations.
- `/api/predicates/{kind}/*` — predicate `snapshot` (off-chain state for
  on-device proving) and `relay` (submit a holder's proven transaction).
- `/events` — SSE state stream (see §3).

---

## 3. State sync — SSE

The verify hot path must never touch the chain. The sidecar streams chain
state to the verification service, which mirrors it into Postgres + an
in-memory cache.

```
sidecar contractStateObservable diff
   └─ events.ts emits typed event
        └─ GET /events?topics=revocation,issuer,attestation,identity  (SSE)
             └─ verification-service sidecar_events.rs
                  └─ Postgres tables + RwLock caches
```

- `crates/verification-service/src/sidecar_events.rs` opens the SSE stream
  with `Accept: text/event-stream` on startup, in a background task.
- The sidecar **replays a full snapshot on connect** (cold-cache prime after a
  service restart), then tails live diffs.
- Auto-reconnect with backoff on disconnect.
- Topics: `revocation` (credential status), `issuer` (trust anchors),
  `attestation` (predicate attestation keys), `identity` (did:webs anchors).

The issuer service talks to the sidecar over plain REST only (register issuer
key, anchor did:web) — fire-and-forget with retry.

---

## 4. Contracts & deployment

Ten Compact contracts — 3 registries + 7 predicate contracts — fully
documented in `COMPACT_CONTRACTS.md`.

**Compile:** `just compact` (with ZK key generation, slow) or
`just compact-fast` (skip keygen). Requires the Compact compiler.

**Deploy:** `just deploy-contracts` → `cd packages/midnight-sidecar && bun run
deploy`. It deploys to whichever network the active `.env` points at and
writes the resulting contract addresses back into `.env`. After a local
`midnight-reset` the chain is empty — redeploy.

Deployed contract addresses are configuration, not secrets: in `.env` for
local, and Terraform variables (`deploy/gcp/terraform/terraform.tfvars`) for
the cloud. `just push-secrets-to-gcloud` prints the tfvars lines after a
deploy.

Each predicate kind is its own contract at its own address — Midnight's
per-extrinsic block-weight cap will not carry all seven in one contract.

---

## 5. Witness-on-device predicate proving

A predicate (`age ≥ 18`, `kyc ≥ 2`, `nationality ∈ EU`, residency, email,
age range, unique personhood) is proven in zero knowledge **on the holder's
device**. The holder never reveals the underlying attribute, and the verifier
never runs a ZK verifier or waits on the chain.

```
ATTEST  (one-time per credential + predicate + params, asynchronous)

  holder device  (packages/sdk/src/midnight/)
    1. routing.ts   — map the DCQL claim to a predicate kind + params
    2. orchestrator — check /predicates/attested; skip if already on-chain
    3. snapshot.ts  — fetch off-chain contract state from
                      verification-service GET /predicates/{kind}/snapshot
    4. witnesses.ts — derive the witness from the credential attribute
                      (dateOfBirth → ageValue, etc.) and bind it into the
                      compiled Compact contract
    5. prover.ts    — run the in-process zkir-v2 WASM prover →
                      proven, witness-stripped transaction
    6. relay        — POST the proven tx to verification-service
                      /predicates/{kind}/relay
                          └─ sidecar balances + submits
                          └─ Midnight node verifies the ZK proof IN CONSENSUS
                          └─ predicate contract inserts the attestation key
                          └─ SSE → verification-service mirror

VERIFY  (per presentation, hot path, no chain access)

  for each DCQL claim that routes to a predicate:
    key = persistentHash([tag, credential_id_hex, param])   ← recomputed
    require key ∈ SSE-mirrored attestation set
```

**Key properties**

- The witness — actual age, KYC level, nationality, personhood secret — is
  consumed inside the circuit on the device and never leaves it.
- Proving is **in-process WASM** everywhere — `zkir-v2` on the holder device,
  the wallet-SDK / `inprocess-proof.ts` prover for backend-side balancing.
  **No standalone proof server is in the predicate path.**
- Attestation is **one-time** per `(credential, predicate, params)` and
  reused across unlimited presentations — chain latency is paid once, off the
  verifier hot path.
- The attestation key recipe is parity-tested between Compact
  (`persistentHash`) and Rust (`crates/proof-system/src/attestation.rs`). The
  verifier recomputes the key from the issuer-signed credential id, so a
  holder cannot replay another credential's attestation.

**ZK artifacts** — the holder's WASM build ships without the multi-MB keys and
fetches them on first use:

- `GET /predicate-zk[/{file}]` (verification-service) — per-kind
  `<circuit>.{bzkir,prover,verifier}` artifacts, immutable-cached.
- `GET /midnight/params/{k}` — the universal BLS SRS.
- The SDK caches both: in-memory → IndexedDB → immutable HTTP.

First proof on a device costs ~10 s (SRS fetch + WASM init); attest
balance+submit+finalize is ~25–30 s on the local devnet. Both are off the
verifier hot path.

`OwlWallet.present` runs the attestation step transparently before signing
KB-JWTs, surfacing typed `AttestProgress` events ("Generating proof…",
"Submitting to Midnight…") so the wallet UI does not show a silent pause.
No Midnight/contract/circuit concept crosses the public SDK surface beyond
that progress event.

---

## 6. DUST, fees, funding

Chain writes (contract deploy, predicate relay, registry updates) cost fees.

- **Local devnet** — the `CFG_PRESET=dev` genesis seed has pre-minted NIGHT.
  `just fund-accounts` / `just fund-address <bech32>` top up addresses from
  `accounts.json`.
- **Testnet / preview** — the sidecar wallet (`MIDNIGHT_WALLET_MNEMONIC`) must
  hold NIGHT, and NIGHT UTXOs must be registered for DUST generation before
  transactions succeed.

On-chain anchors written by the issuer (issuer key, did:web hash) are
fire-and-forget and converge asynchronously. Revocation and predicate relay
are the load-bearing write paths and are confirmed end-to-end.

---

## 7. Configuration

Environment variables (the active `.env` symlink — `just env local|preview`):

| Variable                           | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `MIDNIGHT_NETWORK_ID`              | `undeployed` (local devnet) / `preview` / mainnet.   |
| `MIDNIGHT_NODE_WS_URL`             | Node RPC WebSocket.                                  |
| `MIDNIGHT_INDEXER_URI` / `_WS_URI` | Indexer GraphQL HTTP / WS.                           |
| `MIDNIGHT_PROOF_SERVER_URI`        | Proof server.                                        |
| `MIDNIGHT_SIDECAR_PORT`            | Sidecar port (default 3000).                         |
| `MIDNIGHT_SIDECAR_URL`             | Sidecar base URL the Rust services call.             |
| `MIDNIGHT_SIDECAR_API_KEY`         | Bearer key for `/api/*` and `/events`.               |
| `MIDNIGHT_SIDECAR_TIMEOUT`         | HTTP timeout — raise it; a write tx can exceed 30 s. |
| `MIDNIGHT_WALLET_MNEMONIC`         | Sidecar wallet seed (testnet/mainnet).               |
| `MIDNIGHT_*_REGISTRY_ADDRESS`      | Deployed contract addresses (written by `deploy`).   |

`setNetworkId(...)` must be called before any wallet operation; on the local
devnet it is `'undeployed'`.

---

## 8. Local bring-up & recovery

```
just env local                 # point .env at the devnet
just midnight-up                # node + indexer + proof server (~30s)
just midnight-status            # confirm all three healthy
just compact-fast               # compile contracts
just deploy-contracts           # deploy; writes addresses into .env
just fund-accounts              # top up devnet accounts (if needed)
just dev-e2e                    # full stack: Midnight + DBs + sidecar + services + app
```

After a host reboot or `midnight-reset` the chain is empty — repeat from
`midnight-up` and redeploy.

**Known devnet quirks**

- A long-lived sidecar can hold its private-state LevelDB so that
  witness-bearing writes fail with `Database failed to open`. Restart the
  sidecar to re-open it cleanly — not a code defect.
- A Midnight write transaction (proof gen + submit + confirm) routinely
  exceeds the 30 s default HTTP timeout — keep `MIDNIGHT_SIDECAR_TIMEOUT`
  raised.

See `E2E-SETUP.md` for the end-to-end test setup and `RUNBOOK.md` for
production operations.
