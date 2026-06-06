# OwlID Developer Getting Started Guide

A practical guide to building with OwlID — standards-conformant SD-JWT VC issuance and verification (OpenID4VCI / OpenID4VP) on the Midnight blockchain, with WebAuthn/passkey-protected wallets.

---

## 1. Prerequisites

| Tool   | Version | Install                                                |
| ------ | ------- | ------------------------------------------------------ |
| Rust   | 1.75+   | [rustup.rs](https://rustup.rs)                         |
| Bun    | 1.0+    | [bun.sh](https://bun.sh)                               |
| Docker | 24+     | [docs.docker.com](https://docs.docker.com/get-docker/) |
| just   | any     | `cargo install just`                                   |

Verify your toolchain:

```bash
just check-tools
```

---

## 2. Quick Start

```bash
git clone <repo-url> && cd OwlID

# Install JS dependencies and fetch Rust crates.
just setup

# Start PostgreSQL containers.
just db-start

# Start all services (verification, issuer, frontend).
just dev
```

Once running you will see:

```
Starting OwlID...
  Verification: http://localhost:8000 (DB: localhost:5432)
  Issuer:       http://localhost:8001 (DB: localhost:5433)
  App:          http://localhost:5000
```

To include the Midnight blockchain sidecar:

```bash
just dev-full    # adds Sidecar at http://localhost:3000
```

For the full end-to-end stack with a local Midnight network:

```bash
just dev-e2e     # starts Midnight node, indexer, proof server, sidecar, then all OwlID services
```

> **Midnight is required.** Both verification-service and issuer-service exit 1 on startup if the sidecar's `/health` is unreachable. Roll the sidecar before the services.

---

## 3. Architecture overview

```
                  +-------------------+
                  |   App (Vite+React)|
                  |   localhost:5000  |
                  +--------+----------+
                           |
              +------------+------------+
              |                         |
  +-----------v-----------+  +----------v-----------+
  | Verification Service  |  |   Issuer Service     |
  | localhost:8000 (Rust) |  |   localhost:8001     |
  | - SD-JWT VC verify    |  |   - SD-JWT VC issue  |
  | - did:web resolve     |  |   - OpenID4VCI       |
  | - Status List check   |  |   - did:web doc      |
  | - OpenID4VP           |  |   - Status List feed |
  +-----------+-----------+  +----------+-----------+
              |                         |
  +-----------v-----------+  +----------v-----------+
  | PostgreSQL            |  | PostgreSQL            |
  | localhost:5432        |  | localhost:5433        |
  | verification DB       |  | issuer DB             |
  +-----------+-----------+  +----------+------------+
              |                         |
              +------------+------------+
                           |
              +------------v------------+
              | Midnight Sidecar        |
              | localhost:3000 (Bun)    |
              | - issuer_registry       |
              | - revocation_registry   |
              | - identity_registry     |
              +-------------------------+
```

**Verification service (8000)** — Validates SD-JWT VC presentations, resolves `did:web` issuers against the on-chain `issuer_registry`, verifies the holder's key-binding JWT, cross-checks revocation (cache + on-chain + `statuslist+jwt`).

**Issuer service (8001)** — Drives identity providers (DigiD/OIDC/Didit/webhook), normalizes claims to SD-JWT VC standard names, signs `application/dc+sd-jwt` credentials, exposes OpenID4VCI metadata + Batch endpoint, publishes `did:web` doc + IETF Token Status List.

**App (5000)** — React frontend with WebAuthn passkey support. Users register a passkey, generate a wallet-held holder key (PRF-wrapped by the passkey), receive SD-JWT VCs, and present them to verifiers.

**Midnight sidecar (3000)** — the only chain-aware process (Bun + Hono). Wraps all ten Compact contracts (`issuer_registry`, `revocation_registry`, `identity_registry`, and seven `predicate_*` contracts), relays holder-proven predicate transactions, and emits SSE state events into the verification service.

For the full architecture (including standards conformance) see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for the Midnight stack see [`MIDNIGHT.md`](./MIDNIGHT.md) and [`COMPACT_CONTRACTS.md`](./COMPACT_CONTRACTS.md).

---

## 4. SDK integration (TypeScript)

`@owlid/sdk` is pure TypeScript — `@noble/ed25519` + `@noble/hashes` under the hood. SD-JWT VC bytes match the Rust `owl_proof_system::sd_jwt` implementation.

### Holder — receive and store a credential

```typescript
import {
  OwlIssuer,
  KeyPair,
  SdJwtVc,
  storage,
  buildCardShape,
  sealHolderKey,
  registerCredential,
} from '@owlid/sdk'

const issuer = new OwlIssuer({
  apiKey: process.env.OWLID_API_KEY!,
  baseUrl: 'http://localhost:8001', // omit in production
})

// 1. Mint a passkey + a wallet-held holder key, PRF-wrap the 32-byte seed.
const passkey = await registerCredential({ rpName: 'OwlID', rpId: 'localhost', userName: 'alice' })
const holder = KeyPair.generate()
// `sealHolderKey` returns the opaque blob plus the passkey that supplied the
// PRF output (pass `null` as the id to let the browser show the picker).
const { blob: wrapped } = await sealHolderKey(passkey.credentialId, holder.toHex())

// 2. Open an issuance session and submit the verified claims.
const session = await issuer.startSession('mock-digid')
await issuer.submitClaims(session.id, {
  given_name: 'Alice',
  family_name: 'Wonderland',
  birthdate: '1990-05-15',
  nationalities: ['NL'],
})

// 3. Issue — returns { sdJwtVc } — then store it in the wallet.
const issued = await issuer.issue(session.id, {
  publicKey: holder.publicKeyHex(),
  algorithm: 'ed25519',
})
const parsed = SdJwtVc.parse(issued.sdJwtVc)
await storage.addCredential(
  {
    credentialId: parsed.credentialId(),
    sdJwtVc: issued.sdJwtVc,
    issuer: parsed.peekIssuer(),
    providerId: 'mock-digid',
    issuedAt: new Date().toISOString(),
    holderPublicKeyHex: holder.publicKeyHex(),
    verifiedClaims: { firstName: 'Alice' },
    cardShape: buildCardShape('mock-digid', { firstName: 'Alice' }),
  },
  wrapped,
)
```

### Holder — build a presentation

```typescript
import { presentSdJwtVc } from '@owlid/sdk'

// presentSdJwtVc(sdJwtVc, holderKeyHex, disclose, { aud, nonce }) — synchronous.
const presentation = presentSdJwtVc(
  storedCredential.sdJwtVc,
  holderKeyHex, // unlocked holder seed hex, from openHolderKey()
  ['given_name', 'age_over_18'],
  { aud: verifierOrigin, nonce: verifierNonce }, // bound into the KB-JWT
)
// presentation is the full SD-JWT VC presentation string
```

### Verifier — verify a presentation

```typescript
import { OwlVerifier } from '@owlid/sdk'

const verifier = new OwlVerifier({ apiKey: process.env.OWLID_API_KEY! })
const challenge = await verifier.mintChallenge()

// The verifier sends `challenge.challenge` to the holder; the holder
// builds a presentation that binds it into the KB-JWT.
const result = await verifier.verify(presentation, challenge.challenge)
if (result.valid) {
  console.log(result.subjects) // { given_name: 'Alice', age_over_18: true }
}
```

---

## 5. Rust API

Use the proof system directly from Rust for backend integrations or custom verification logic.

### Build and sign an SD-JWT VC

```rust
use owl_proof_system::sd_jwt::{KeyPair, build_sd_jwt_vc};
use owl_crypto::{KeyPair as IssuerKey};
use serde_json::json;

let issuer = IssuerKey::generate();
let holder = KeyPair::generate_ed25519();

let sd_jwt_vc = build_sd_jwt_vc(
    &issuer,
    "did:web:issuer.example.com",
    &holder.public_key(),
    json!({
        "given_name":    "Alice",
        "family_name":   "Wonderland",
        "birthdate":     "1990-05-15",
        "nationalities": ["NL"],
        "age_over_18":   true,
    }),
    /* expires_in */ 3600,
).unwrap();
```

### Build a presentation + KB-JWT and verify

```rust
use owl_proof_system::sd_jwt::{SdJwtVc, verify_sd_jwt};

let credential   = SdJwtVc::parse(&sd_jwt_vc).unwrap();
let presentation = credential
    .present(&["given_name", "age_over_18"], &holder, "https://verifier", "nonce-xyz")
    .unwrap();

let verified = verify_sd_jwt(
    &presentation,
    &[issuer.public_key()],
    "https://verifier",
    "nonce-xyz",
).unwrap();

assert_eq!(verified.claims["given_name"], "Alice");
assert_eq!(verified.claims["age_over_18"], true);
```

---

## 6. Predicates

Predicates surface as **plain SD-JWT VC claims**. The issuer evaluates the underlying ZK predicate (Midnight Compact circuit) at issuance time and emits the result as a claim the holder can selectively disclose.

| Predicate         | Disclosed claim                                  | Notes                                                         |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Age ≥ N           | `age_over_N: true`                               | Multiple `age_over_NN` claims may be issued in the same VC.   |
| Nationality ∈ set | `nationality: "NL"` (or `nationalities: ["NL"]`) | Issuer attests the holder is in the approved set via Compact. |
| KYC level ≥ N     | `kyc_level: N`                                   | Issuer attests after running the IdP flow.                    |

The holder discloses only what the verifier asks for — `age_over_18` without `birthdate`, `nationalities` without `given_name`, etc. The verifier sees the issuer-signed claim; the underlying value (the actual DOB, full country list) never leaves the issuer + the wallet.

Apps can discover available predicates at startup:

```
GET /predicates → [
  { "id": "age:>=18", "claim": "age_over_18", "label": "Age 18 or older" },
  { "id": "age:>=21", "claim": "age_over_21", "label": "Age 21 or older" },
  …
]
```

---

## 7. Verification service API

All endpoints require an `Authorization: Bearer <api-key>` header unless noted otherwise.

For the full route list see [`crates/verification-service/README.md`](../crates/verification-service/README.md) or `http://localhost:8000/swagger-ui/`.

### Public endpoints (no auth)

| Method | Path                  | Description                                  |
| ------ | --------------------- | -------------------------------------------- |
| GET    | `/health`             | Health check                                 |
| GET    | `/status-revoked`     | Plain set of revoked credential ids (mirror) |
| POST   | `/openid4vp/response` | OpenID4VP `direct_post` endpoint             |

### Authenticated endpoints

| Method | Path                     | Description                       |
| ------ | ------------------------ | --------------------------------- |
| POST   | `/verify`                | Verify an SD-JWT VC presentation  |
| GET    | `/metrics`               | Service metrics                   |
| GET    | `/trusted-issuers`       | List trusted issuer entries       |
| POST   | `/revocations/check`     | Check if a credential is revoked  |
| GET    | `/revocations/list`      | List all revoked credentials      |
| POST   | `/presentation/sessions` | Open a QR/WS presentation session |

### Admin endpoints (admin API key)

| Method | Path                                  | Description               |
| ------ | ------------------------------------- | ------------------------- |
| POST   | `/trusted-issuers`                    | Register a trusted issuer |
| POST   | `/revocations/revoke`                 | Revoke a credential       |
| POST   | `/revocations/suspend`                | Suspend a credential      |
| POST   | `/revocations/reactivate`             | Reactivate a credential   |
| DELETE | `/admin/gdpr-erasure/{credential_id}` | GDPR data erasure         |
| GET    | `/admin/midnight/status`              | Sidecar health probe      |

### Example — verify a presentation

```bash
curl -X POST http://localhost:8000/verify \
  -H "Authorization: Bearer owlid_sk_test_dev0000000000000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{
    "presentation": "<sd-jwt-vc>~<disclosure>~<disclosure>~<kb-jwt>",
    "challenge": "the-nonce-used-in-kb-jwt"
  }'
```

### Example — register a trusted issuer

```bash
KEY=$(curl -s http://localhost:8001/issuer-info | jq -r '.publicKey')

curl -X POST http://localhost:8000/trusted-issuers \
  -H "Authorization: Bearer owlid_sk_test_dev0000000000000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d "{\"public_key\": \"$KEY\", \"name\": \"OwlID Issuer\"}"
```

Or use the shortcut: `just register-issuer`.

### Issuer service API (port 8001)

Key endpoints for the credential issuance flow:

| Method | Path                                    | Description                               |
| ------ | --------------------------------------- | ----------------------------------------- |
| GET    | `/health`                               | Health check                              |
| GET    | `/.well-known/did.json`                 | did:web document (CORS-public)            |
| GET    | `/.well-known/openid-credential-issuer` | OpenID4VCI metadata                       |
| GET    | `/issuer-info`                          | Issuer public key + did:web id            |
| GET    | `/providers`                            | List identity verification providers      |
| POST   | `/sessions`                             | Start a verification session              |
| GET    | `/sessions/{id}`                        | Get session status                        |
| POST   | `/sessions/{id}/submit`                 | Submit identity data                      |
| GET    | `/sessions/{id}/claims`                 | Get verified claims                       |
| POST   | `/sessions/{id}/complete`               | Complete + issue SD-JWT VC                |
| POST   | `/credential`                           | OpenID4VCI single / Batch issuance        |
| POST   | `/token`                                | OpenID4VCI pre-authorized token           |
| GET    | `/status/{id}`                          | IETF Token Status List (`statuslist+jwt`) |

---

## 8. Configuration

### Verification service

| Variable                    | Default                 | Description                              |
| --------------------------- | ----------------------- | ---------------------------------------- |
| `VERIFICATION_DATABASE_URL` | (required)              | PostgreSQL connection string             |
| `SERVER_HOST`               | `0.0.0.0`               | Bind address                             |
| `SERVER_PORT`               | `8000`                  | Listen port                              |
| `RUST_LOG`                  | `info`                  | Log level filter                         |
| `MIDNIGHT_SIDECAR_URL`      | `http://localhost:3000` | Required; service exits 1 if unreachable |
| `MIDNIGHT_SIDECAR_API_KEY`  | (required)              | Shared secret with sidecar               |
| `ENCRYPTION_KEY`            | (optional)              | 32-byte AES-GCM hex, at-rest encryption  |
| `ADMIN_JWT_SECRET`          | (required, no default)  | HS256 secret for admin JWTs              |

### Issuer service

| Variable                        | Default                 | Description                               |
| ------------------------------- | ----------------------- | ----------------------------------------- |
| `ISSUER_DATABASE_URL`           | (required)              | PostgreSQL connection string              |
| `ISSUER_HOST`                   | `0.0.0.0`               | Bind address                              |
| `ISSUER_PORT`                   | `8001`                  | Listen port                               |
| `RUST_LOG`                      | `info`                  | Log level filter                          |
| `ISSUER_PUBLIC_URL`             | `http://localhost:8001` | Used as `did:web` base + status-list URL  |
| `ISSUER_PRIVATE_KEY`            | (required)              | 32-byte hex Ed25519 private key           |
| `MIDNIGHT_SIDECAR_URL`          | `http://localhost:3000` | Required; service exits 1 if unreachable  |
| `MIDNIGHT_SIDECAR_API_KEY`      | (required)              | Shared secret with sidecar                |
| `MIDNIGHT_AUTO_REGISTER_ISSUER` | `false`                 | If true, registers issuer key in registry |
| `DIDIT_API_KEY`                 | (optional)              | Didit KYC provider API key                |
| `DIDIT_WORKFLOW_ID`             | (optional)              | Didit verification workflow id            |

### Midnight sidecar

Configure via `.env` in the project root (loaded by `just` via `dotenv-load`). See `midnight.env.example` for placeholder values. Key variables include the Midnight node URL, indexer GraphQL endpoint, proof server URL, and wallet seed.

### Database defaults (docker-compose)

| Service               | Host:Port      | Database     | User | Password |
| --------------------- | -------------- | ------------ | ---- | -------- |
| postgres-verification | localhost:5432 | verification | owl  | owl_dev  |
| postgres-issuer       | localhost:5433 | issuer       | owl  | owl_dev  |

---

## 9. Running tests

```bash
just test          # rust + ts
just test-rust     # cargo test --workspace
just test-ts       # bun run test
just fmt           # format rust + ts
just lint          # clippy + oxlint
just check         # fmt + lint + test

# Live cross-service E2E (requires Midnight devnet + sidecar + services up).
cargo test -p owl-verification-service --test e2e_api -- --ignored --test-threads=1
```

---

## 10. Common tasks

```bash
just db-reset          # drop + recreate both postgres containers
just db-verification   # psql into verification DB
just db-issuer         # psql into issuer DB

just compact           # full Compact contract build (slow, runs ZK keygen)
just compact-fast      # skip ZK keygen
just compact-clean     # remove compiled artifacts

just midnight-up       # start local Midnight network
just midnight-status   # health-check the chain stack
just deploy-contracts  # deploy OwlID Compact contracts
just fund-accounts     # fund test accounts with NIGHT tokens

just generate-api-client  # regenerate verifier/issuer/admin clients from OpenAPI
just generate-zk-keys     # regenerate Groth16 PK/VK artifacts

just clean && just build
```
