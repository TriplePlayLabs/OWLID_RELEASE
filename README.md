# OwlID

**Privacy-preserving digital identity on Midnight** — standards-conformant verifiable credentials (SD-JWT VC + OpenID4VCI/OpenID4VP) anchored on the Midnight blockchain, with WebAuthn/passkey-protected wallets.

A holder proves facts about themselves (age, nationality, KYC level) to any verifier without revealing the underlying document. The issuer signs an SD-JWT VC; the holder selectively discloses claims plus a key-binding JWT bound to a fresh verifier nonce. Trust, revocation, and identity-anchor state live on Midnight; standards-shaped wire formats are its public projection.

---

## What's in the box

| Layer                    | Component                                 | Status    |
| ------------------------ | ----------------------------------------- | --------- |
| Cryptographic core       | `crates/crypto`, `crates/proof-system`    | stable    |
| Verification API (8000)  | `crates/verification-service`             | stable    |
| Issuer API (8001)        | `crates/issuer-service`                   | stable    |
| Midnight bridge (3000)   | `packages/midnight-sidecar`               | stable    |
| TypeScript SDK           | `packages/sdk`                            | stable    |
| Generated API clients    | `packages/{verifier,issuer,admin}-client` | generated |
| Holder app (5000)        | `packages/app`                            | stable    |
| Verifier demo app (5001) | `packages/verifier-app`                   | stable    |
| Admin dashboard (4000)   | `packages/admin`                          | stable    |
| Compact contracts        | `packages/midnight-sidecar/contracts`     | testnet   |

The "generated" packages (`@owlid/verifier-client`, `@owlid/issuer-client`, `@owlid/admin-client`) are produced by `just generate-api-client` from the live OpenAPI specs of the Rust services. Don't hand-edit the `apis/`, `models/`, or `runtime.ts` directories under those packages.

---

## How it works

The credential is an SD-JWT VC (`application/dc+sd-jwt`, RFC 9901 + draft-ietf-oauth-sd-jwt-vc):

```
<JWT issuer-signed header.payload.signature>~<disclosure>~<disclosure>~...~<KB-JWT>
```

- The **JWT** is signed by the issuer (EdDSA) and binds the holder's confirmation key (`cnf`).
- Each **disclosure** is a `[salt, name, value]` triple whose SHA-256 hash appears in the JWT's `_sd` array. The holder picks which to send.
- The **KB-JWT** is the holder's per-presentation key-binding JWT (EdDSA or ES256), signed over a fresh verifier nonce. The holder's key never leaves the device.

Trust + revocation + identity-anchor state — plus predicate attestations — are on Midnight, across **10 Compact contracts**: 3 registries (`issuer_registry`, `revocation_registry`, `identity_registry`) and 7 predicate contracts (`age`, `age_range`, `kyc`, `residency`, `email`, `nationality`, `personhood`). The verifier never queries the chain directly — the verification service mirrors contract state over SSE into Postgres + cache.

Predicates (`age ≥ 18`, `kyc ≥ 2`, `nationality ∈ EU`, …) are proven **on the holder's device** in zero knowledge; the Midnight node verifies the proof in consensus and records an attestation the verifier later checks against the mirror. Standards interop:

| Concern      | Wire format projected from Midnight                  |
| ------------ | ---------------------------------------------------- |
| Issuer trust | `did:web` + did:webs doc-hash anchor                 |
| Revocation   | IETF Token Status List (`statuslist+jwt`)            |
| Issuance     | OpenID4VCI (with Batch Credential for unlinkability) |
| Presentation | OpenID4VP `direct_post`                              |

For the full architecture see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the per-standard Midnight projection is in its §9, and the Midnight stack itself in [`docs/MIDNIGHT.md`](docs/MIDNIGHT.md).

---

## Quick start

### Prerequisites

| Tool   | Version | Install                         |
| ------ | ------- | ------------------------------- |
| Rust   | 1.75+   | https://rustup.rs               |
| Bun    | 1.0+    | https://bun.sh                  |
| Docker | 24+     | https://docs.docker.com/engine/ |
| just   | any     | `cargo install just`            |

```bash
just check-tools   # verify the toolchain
```

### Run

```bash
git clone <repo-url> && cd OwlID
cp .env.example .env
just setup         # bun install + cargo fetch
just dev           # backends + holder app
```

Live URLs:

| Service           | URL                               |
| ----------------- | --------------------------------- |
| Holder app        | http://localhost:5000             |
| Verifier demo     | http://localhost:5001             |
| Admin dashboard   | http://localhost:4000             |
| Verification API  | http://localhost:8000             |
| Issuer API        | http://localhost:8001             |
| Verification docs | http://localhost:8000/swagger-ui/ |
| Issuer docs       | http://localhost:8001/swagger-ui/ |

For a full local end-to-end run with Midnight devnet (node + indexer + proof server + sidecar):

```bash
just dev-e2e
```

Detailed setup, contract deploy, and Midnight versions in [`docs/E2E-SETUP.md`](docs/E2E-SETUP.md).

> **Midnight is required.** Both Rust services exit 1 at startup if the sidecar (`localhost:3000` by default) is unreachable. Roll the sidecar before the services.

---

## Customer integrations

### Verifier (server-side)

```bash
bun add @owlid/sdk
```

```typescript
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY })

// 1. Direct verification of an SD-JWT VC presentation.
const challenge = await verifier.mintChallenge()
const result = await verifier.verify(presentation, challenge.challenge)
if (result.valid) console.log(result.subjects)

// 2. OpenID4VP / QR + WebSocket presentation session.
const session = await verifier.createPresentationSession()
// session.qrPayload → render as QR; the holder app posts the
// presentation back over the negotiated channel.
```

### Issuer-side integration

```typescript
import { OwlIssuer } from '@owlid/sdk'

const issuer = new OwlIssuer({ baseUrl: 'https://issuer.example.com' })

const session = await issuer.createSession({ providerId: 'didit' })
// then redirect / poll / submit per the provider's flow

// After the holder completes the provider flow, the issuer service
// signs and returns the SD-JWT VC plus a OpenID4VCI offer.
```

### Holder (browser)

The browser SDK runs WebAuthn registration as the unlock/UV gate, generates a wallet-held Ed25519 (or P-256) confirmation key, parses received SD-JWT VCs, and produces presentations with a fresh KB-JWT per call. See [`packages/sdk/README.md`](packages/sdk/README.md) for the full surface.

---

## Documentation map

| Document                                                 | When to read                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md)     | Build, run, write your first presentation                          |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)           | Architecture, design rationale, data model, standards conformance  |
| [`docs/MIDNIGHT.md`](docs/MIDNIGHT.md)                   | Midnight stack, sidecar, state sync, witness-on-device proving     |
| [`docs/COMPACT_CONTRACTS.md`](docs/COMPACT_CONTRACTS.md) | Per-contract reference for all 10 Compact contracts                |
| [`docs/COMPACT.md`](docs/COMPACT.md)                     | Midnight Compact language reference                                |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)               | Production compose, env vars, Midnight versions                    |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md)                     | Operations: revoking, rotating keys, GDPR erasure, troubleshooting |
| [`docs/E2E-SETUP.md`](docs/E2E-SETUP.md)                 | Full local stack with Midnight devnet                              |
| [`SERVICES.md`](SERVICES.md)                             | Local-development URL cheatsheet                                   |
| [`deploy/gcp/README.md`](deploy/gcp/README.md)           | GCP deploy: Terraform infra, Cloud Build, Cloud Run                |
| [`deploy/gcp/RUNBOOK.md`](deploy/gcp/RUNBOOK.md)         | GCP deploy: step-by-step playbooks                                 |
| [`deploy/gcp/SECRETS.md`](deploy/gcp/SECRETS.md)         | GCP deploy: secret storage, rotation, audit                        |
| [`deploy/gcp/ENV-WIRING.md`](deploy/gcp/ENV-WIRING.md)   | GCP deploy: every env var, source, consumer                        |

API references:

- Verification HTTP API: see [`crates/verification-service/README.md`](crates/verification-service/README.md) or `http://localhost:8000/swagger-ui/`
- Issuer HTTP API: see [`crates/issuer-service/README.md`](crates/issuer-service/README.md) or `http://localhost:8001/swagger-ui/`
- TypeScript SDK: [`packages/sdk/README.md`](packages/sdk/README.md)
- Admin dashboard: [`packages/admin/README.md`](packages/admin/README.md)

---

## Development

```bash
just dev             # all services
just dev-backend     # rust services + sidecar
just dev-app         # holder app only
just build           # full build
just test            # rust + ts tests
just check           # fmt + lint + test
just generate-api-client  # regenerate verifier/issuer/admin clients from OpenAPI
```

**Predicate proving.** The predicate path is the **7 Compact contracts** under `packages/midnight-sidecar/contracts/`. Predicates are proven on the holder's device with the in-process `zkir-v2` WASM prover and verified by the Midnight node in consensus — see [`docs/MIDNIGHT.md`](docs/MIDNIGHT.md) §5. Each predicate binds its witness to the issuer-signed `owl_root`, so a fabricated value cannot be attested.

Always use `bun`, never `npm`. Format Rust with `just fmt`, lint with `just lint`. Pre-commit hooks (`husky` + `lint-staged`) run oxlint + prettier + taplo on staged files.

## Repository layout

```
.
├── crates/                       # Rust workspace
│   ├── crypto/                   # Ed25519, P-256, BLAKE3, SHA-256, WebAuthn
│   ├── proof-system/             # SD-JWT VC, Token Status List, attestation keys, predicate registry + datasets
│   ├── verification-service/     # Verifier HTTP API + admin
│   └── issuer-service/           # Issuance HTTP API (OpenID4VCI)
├── packages/
│   ├── sdk/                      # @owlid/sdk — holder + verifier + issuer, on-device proving
│   ├── verifier-client/          # generated OpenAPI client (verification)
│   ├── issuer-client/            # generated OpenAPI client (issuer)
│   ├── admin-client/             # generated OpenAPI client (admin, private)
│   ├── app/                      # holder app (Vite + React + TanStack)
│   ├── verifier-app/             # verifier demo
│   ├── admin/                    # admin dashboard (TanStack Start)
│   ├── ui/                       # shared React component library
│   ├── config/                   # shared runtime config
│   ├── docs-site/                # rspress customer + developer docs
│   └── midnight-sidecar/         # Bun + Hono bridge to Midnight (+ contracts/)
├── docs/                         # maintainer docs
├── docker-compose*.yml           # local + prod compose stacks
├── justfile                      # task runner
└── monitoring/                   # Prometheus + Grafana configs
```

## License

MIT — see [`LICENSE`](LICENSE).
