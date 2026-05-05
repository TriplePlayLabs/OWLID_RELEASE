# OwlID Developer Getting Started Guide

A practical guide to building with OwlID, a privacy-preserving digital identity
system using Merkle-tree selective disclosure, zero-knowledge proofs, and
WebAuthn/passkey authentication.

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

Expected output:

```
Rust:   rustc 1.75.0 (or newer)
Cargo:  cargo 1.75.0
Bun:    1.x.x
Docker: Docker version 24.x.x
```

---

## 2. Quick Start

```bash
# Clone and enter the repo
git clone <repo-url> && cd OwlID

# Install JS dependencies and fetch Rust crates
just setup

# Start PostgreSQL containers
just db-start

# Start all services (verification, issuer, frontend)
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
just dev-e2e     # starts Midnight node, indexer, proof server, then all OwlID services
```

### Building the Native SDK

The first run of `just dev` builds the WASM module automatically. To rebuild
manually:

```bash
just build-sdk
```

This compiles the Rust cryptographic primitives to both native (NAPI-RS) and
WASM (wasm32-wasip1-threads) targets, then builds the TypeScript SDK wrapper.

---

## 3. Architecture Overview

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
  | - Token verification  |  |   - Identity         |
  | - Trusted issuers     |  |     verification     |
  | - Revocation registry |  |   - Credential       |
  +-----------+-----------+  |     issuance          |
              |              +----------+------------+
              |                         |
  +-----------v-----------+  +----------v-----------+
  | PostgreSQL            |  | PostgreSQL            |
  | localhost:5432        |  | localhost:5433        |
  | verification DB       |  | issuer DB             |
  +----------+------------+  +----------+------------+
              |                         |
              +------------+------------+
                           |
              +------------v------------+
              | Midnight Sidecar        |
              | localhost:3000 (Hono)   |
              | - On-chain anchoring    |
              | - Contract interaction  |
              +-------------------------+
```

**Verification Service (8000)** -- Validates proof tokens, manages trusted
issuer keys, and maintains the credential revocation registry. Stateless
verification logic backed by PostgreSQL for API keys and audit logs.

**Issuer Service (8001)** -- Orchestrates identity verification through
pluggable providers (DigiD/OIDC/Didit/webhooks), then issues signed credentials
as ProofDocuments. The owner stores these locally.

**App (5000)** -- React frontend with WebAuthn passkey support. Users register
credentials, request identity verification, store ProofDocuments, and generate
selective-disclosure tokens.

**Midnight Sidecar (3000)** -- TypeScript bridge to the Midnight blockchain.
Anchors issuer keys and revocation state on-chain via Compact smart contracts.

---

## 4. SDK Integration (TypeScript)

The `@owlid/sdk` package re-exports all cryptographic primitives from the
native Rust/WASM layer plus WebAuthn utilities. Install it as a workspace
dependency or import from the monorepo.

### Create Keypairs

```typescript
import { KeyPair } from '@owlid/sdk'

// Generate a new Ed25519 keypair
const issuerKp = KeyPair.generate()
const ownerKp = KeyPair.generate()

// Persist and restore
const hex = ownerKp.privateKeyHex()
const restored = KeyPair.fromHex(hex)

// Get the public key
const pubkey = ownerKp.publicKey()
console.log(pubkey.toHex()) // 64-char hex string
```

### Create and Issue a Credential

```typescript
import { Document } from '@owlid/sdk'

// Build a document with identity attributes
const doc = Document.fromJson(
  JSON.stringify({
    issuerKey: issuerKp.publicKey().toHex(),
    ownerKey: ownerKp.publicKey().toHex(),
    firstName: 'Alice',
    lastName: 'Wonderland',
    dateOfBirth: '1990-05-15',
    nationality: 'NL',
  }),
)

// Issue: signs the Merkle root with the issuer key
const proofDoc = doc.issue(issuerKp)

// Serialize for storage (e.g., IndexedDB)
const json = proofDoc.toJson()
```

### Generate a Selective-Disclosure Token

```typescript
import { ProofDocument, type ProofRequest } from '@owlid/sdk'

// Restore the credential
const proofDoc = ProofDocument.fromJson(json)

// Build a proof request from the verifier
const request: ProofRequest = {
  disclose: ['firstName', 'nationality'],
  predicates: [],
  trustedIssuers: [issuerKp.publicKey().toHex()],
  challenge: crypto.randomUUID(),
}

// Generate token (signs with Ed25519)
const token = proofDoc.generateProof(request, ownerKp, 3600)

// Compact encoding for QR codes (NID1:... prefix, ~500-1500 chars)
const compact = token.toCompact()
```

### Verify a Token

```typescript
import { Token, PublicKey } from '@owlid/sdk'

// Decode
const token = Token.fromCompact(compact)

// Verify: checks signature, expiry, issuer trust, revocation, Merkle proofs
const disclosedJson = token.verify(
  [issuerKp.publicKey()], // trusted issuers
  request.challenge, // must match
  [], // revoked root hashes (optional)
)

const disclosed = JSON.parse(disclosedJson)
console.log(disclosed.firstName) // 'Alice'
console.log(disclosed.nationality) // 'NL'
// dateOfBirth is NOT disclosed
```

### Two-Phase Signing with WebAuthn

For hardware-backed signatures (passkeys), use the prepare/finalize flow:

```typescript
import { Token, type WebAuthnSignatureData } from '@owlid/sdk'
import { base64urlToBuffer, bufferToBase64 } from '@owlid/sdk'

// Phase 1: prepare token payload (no signature yet)
const prepared = proofDoc.prepareToken(request, 3600)

// Phase 2: sign with WebAuthn
const assertion = await navigator.credentials.get({
  publicKey: {
    challenge: base64urlToBuffer(prepared.challenge()),
    allowCredentials: [{ id: credentialId, type: 'public-key' }],
  },
})

const token = Token.finalizeWebauthn(
  prepared,
  {
    authenticatorData: bufferToBase64(assertion.response.authenticatorData),
    clientDataJson: bufferToBase64(assertion.response.clientDataJSON),
    signature: bufferToBase64(assertion.response.signature),
  },
  credentialPublicKeyHex,
)
```

---

## 5. Rust API

Use the proof system directly from Rust for backend integrations or custom
verification logic.

### Issue a Credential

```rust
use owl_proof_system::{Document, Token, ProofRequest, PredicateOp};
use owl_crypto::KeyPair;
use serde_json::json;
use std::collections::BTreeMap;

let issuer = KeyPair::generate();
let owner  = KeyPair::generate();

let mut attrs = BTreeMap::new();
attrs.insert("issuerKey".into(),   json!(issuer.public_key().to_hex()));
attrs.insert("ownerKey".into(),    json!(owner.public_key().to_hex()));
attrs.insert("name".into(),        json!("Alice"));
attrs.insert("dateOfBirth".into(), json!("1990-05-15"));
attrs.insert("nationality".into(), json!("NL"));

// Create and issue
let doc = Document::new(attrs).unwrap();
let mut proof_doc = doc.issue(&issuer);

// Verify the issuer signature
proof_doc.verify(&issuer.public_key()).unwrap();
```

### Generate and Verify a Token

```rust
use owl_proof_system::revocation::RevocationRegistry;

let request = ProofRequest {
    disclose: vec!["name".into()],
    predicates: vec![],
    trusted_issuers: vec![issuer.public_key().to_hex()],
    challenge: "random-challenge-string".into(),
};

// Generate token (signs with owner's Ed25519 key)
let token = Token::generate(
    &mut proof_doc,
    &request,
    &owner,
    3600, // TTL in seconds
).unwrap();

// Verify
let registry = RevocationRegistry::new();
token.verify(
    &[issuer.public_key()],
    "random-challenge-string",
    &registry,
).unwrap();
```

### Compact Encoding

```rust
// Encode: JSON -> CBOR -> deflate -> Base45 -> "NID1:" prefix
let compact: String = token.to_compact().unwrap();

// Decode
let restored = Token::from_compact(&compact).unwrap();
```

---

## 6. ZK Predicates

Predicates prove facts about credential attributes without revealing the
underlying values. They are evaluated as zero-knowledge proofs inside the token.

### Age Verification (GreaterOrEqual)

```typescript
const request: ProofRequest = {
  disclose: ['firstName'],
  predicates: [
    {
      attribute: 'dateOfBirth',
      op: 'GreaterOrEqual',
      value: '18', // proves age >= 18
    },
  ],
  trustedIssuers: [issuerPk.toHex()],
  challenge: crypto.randomUUID(),
}
```

The verifier learns "this person is 18 or older" without seeing the actual date
of birth.

### Nationality Set Membership (InSet)

```typescript
const request: ProofRequest = {
  disclose: [],
  predicates: [
    {
      attribute: 'nationality',
      op: 'InSet',
      value: JSON.stringify(['NL', 'DE', 'FR', 'BE']),
    },
  ],
  trustedIssuers: [issuerPk.toHex()],
  challenge: crypto.randomUUID(),
}
```

The verifier learns "nationality is in the EU subset" without learning the
specific country.

### Combining Disclosure and Predicates

```typescript
const request: ProofRequest = {
  disclose: ['firstName'], // reveal name
  predicates: [
    { attribute: 'dateOfBirth', op: 'GreaterOrEqual', value: '21' },
    { attribute: 'nationality', op: 'InSet', value: JSON.stringify(['NL', 'DE']) },
  ],
  trustedIssuers: [issuerPk.toHex()],
  challenge: crypto.randomUUID(),
}
// Result: verifier sees firstName, knows age >= 21 and nationality in {NL, DE}
```

In Rust, predicates use the `PredicateRequest` struct:

```rust
use owl_proof_system::{PredicateRequest, PredicateOp};

let predicates = vec![
    PredicateRequest {
        attribute: "dateOfBirth".into(),
        op: PredicateOp::GreaterOrEqual,
        value: json!("18"),
    },
    PredicateRequest {
        attribute: "nationality".into(),
        op: PredicateOp::InSet,
        value: json!(["NL", "DE", "FR"]),
    },
];
```

---

## 7. Verification Service API

All endpoints require an `X-API-Key` header unless noted otherwise.

### Public Endpoints (no auth)

| Method | Path      | Description  |
| ------ | --------- | ------------ |
| GET    | `/health` | Health check |

### Authenticated Endpoints

| Method | Path                 | Description                      |
| ------ | -------------------- | -------------------------------- |
| POST   | `/verify`            | Verify a proof token             |
| GET    | `/metrics`           | Service metrics                  |
| GET    | `/trusted-issuers`   | List trusted issuer public keys  |
| POST   | `/revocations/check` | Check if a credential is revoked |
| GET    | `/revocations/list`  | List all revoked credentials     |

### Admin Endpoints (admin API key)

| Method | Path                                     | Description               |
| ------ | ---------------------------------------- | ------------------------- |
| POST   | `/trusted-issuers`                       | Register a trusted issuer |
| POST   | `/revocations/revoke`                    | Revoke a credential       |
| POST   | `/revocations/suspend`                   | Suspend a credential      |
| POST   | `/revocations/reactivate`                | Reactivate a credential   |
| DELETE | `/admin/gdpr-erasure/{owner_public_key}` | GDPR data erasure         |

### Example: Verify a Token

```bash
curl -X POST http://localhost:8000/verify \
  -H "X-API-Key: dev_key_12345678901234567890123456789012" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "NID1:...",
    "challenge": "the-challenge-used-during-generation",
    "trusted_issuers": ["<issuer-public-key-hex>"]
  }'
```

### Example: Register a Trusted Issuer

```bash
# Get the issuer's public key from the issuer service
KEY=$(curl -s http://localhost:8001/issuer-info | jq -r '.publicKey')

# Register it with the verification service
curl -X POST http://localhost:8000/trusted-issuers \
  -H "X-API-Key: dev_key_12345678901234567890123456789012" \
  -H "Content-Type: application/json" \
  -d "{\"public_key\": \"$KEY\", \"name\": \"OwlID Issuer\"}"
```

Or use the shortcut:

```bash
just register-issuer
```

### Issuer Service API (port 8001)

Key endpoints for the credential issuance flow:

| Method | Path                    | Description                          |
| ------ | ----------------------- | ------------------------------------ |
| GET    | `/health`               | Health check                         |
| GET    | `/issuer-info`          | Issuer public key and metadata       |
| GET    | `/providers`            | List identity verification providers |
| POST   | `/sessions`             | Start a verification session         |
| GET    | `/sessions/{id}`        | Get session status                   |
| POST   | `/sessions/{id}/submit` | Submit identity data                 |
| GET    | `/sessions/{id}/claims` | Get verified claims                  |
| POST   | `/sessions/{id}/issue`  | Issue a credential                   |
| POST   | `/keypair`              | Generate a new Ed25519 keypair       |

---

## 8. Configuration

### Verification Service

| Variable                    | Default                 | Description                     |
| --------------------------- | ----------------------- | ------------------------------- |
| `VERIFICATION_DATABASE_URL` | (required)              | PostgreSQL connection string    |
| `SERVER_HOST`               | `0.0.0.0`               | Bind address                    |
| `SERVER_PORT`               | `8000`                  | Listen port                     |
| `RUST_LOG`                  | `info`                  | Log level filter                |
| `MIDNIGHT_SIDECAR_URL`      | `http://localhost:3000` | Sidecar URL for on-chain checks |
| `MIDNIGHT_SIDECAR_API_KEY`  | (none)                  | Optional sidecar auth key       |

### Issuer Service

| Variable               | Default                 | Description                        |
| ---------------------- | ----------------------- | ---------------------------------- |
| `ISSUER_DATABASE_URL`  | (required)              | PostgreSQL connection string       |
| `ISSUER_HOST`          | `0.0.0.0`               | Bind address                       |
| `ISSUER_PORT`          | `8001`                  | Listen port                        |
| `RUST_LOG`             | `info`                  | Log level filter                   |
| `DIDIT_API_KEY`        | (none)                  | Didit provider API key             |
| `DIDIT_WORKFLOW_ID`    | (none)                  | Didit verification workflow ID     |
| `MIDNIGHT_SIDECAR_URL` | `http://localhost:3000` | Sidecar URL for on-chain anchoring |

### Midnight Sidecar

Configure via `.env` in the project root (loaded by `just` via `dotenv-load`).
See `midnight.env.example` for placeholder values. Key variables include the
Midnight node URL, indexer GraphQL endpoint, proof server URL, and wallet seed.

### Database Defaults (docker-compose)

| Service               | Host:Port      | Database     | User | Password |
| --------------------- | -------------- | ------------ | ---- | -------- |
| postgres-verification | localhost:5432 | verification | owl  | owl_dev  |
| postgres-issuer       | localhost:5433 | issuer       | owl  | owl_dev  |

---

## 9. Running Tests

### All Tests

```bash
just test
```

This runs both Rust and TypeScript test suites.

### Rust Only

```bash
just test-rust
# or directly:
cargo test --workspace
```

### TypeScript Only

```bash
just test-ts
# or directly:
bun run test
```

### Code Quality

```bash
just fmt      # format Rust + TS
just lint     # clippy + eslint
just check    # fmt + lint + test (all three)
```

### API Smoke Test

With services running (`just dev`):

```bash
just test-api
```

This hits the health endpoints and lists configured identity providers.

---

## 10. Common Tasks

### Reset Databases

```bash
just db-reset
```

Drops and recreates both PostgreSQL containers. Migrations run automatically on
startup.

### Access Database CLI

```bash
just db-verification   # psql into verification DB
just db-issuer         # psql into issuer DB
```

### Compile Compact Contracts

```bash
just compact           # full build (generates ZK keys, slow)
just compact-fast      # skip ZK key generation
just compact-clean     # remove compiled artifacts
```

### Deploy Contracts to Local Midnight

```bash
just midnight-up       # start local Midnight network
just midnight-status   # verify all services are healthy
just deploy-contracts  # deploy OwlID Compact contracts
just fund-accounts     # fund test accounts with NIGHT tokens
```

### Rebuild Everything

```bash
just clean && just build
```
