# OwlID

**Privacy-Preserving Identity Verification and Credential System**

A production-ready identity system featuring selective disclosure, cryptographic verification, WebAuthn/passkeys, and real identity provider integrations. Built with Rust (backend) and TypeScript (SDK + frontend).

---

## Features

| Feature                  | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| **Selective Disclosure** | Share only chosen attributes using Merkle tree proofs                |
| **WebAuthn / Passkeys**  | Hardware-backed P-256 signatures (Face ID, Touch ID, Windows Hello)  |
| **Offline Verification** | Verify tokens without contacting the issuer                          |
| **Identity Providers**   | Mock providers included; architecture supports DigiD, BankID, Onfido |
| **Revocation System**    | Revoke, suspend, and reactivate credentials                          |
| **Cross-Platform SDK**   | Native bindings for 14 platforms + WASM for browsers                 |
| **GDPR Compliant**       | Hashed PII storage, audit trails, automatic data expiry              |

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend App  │────▶│ Issuer Service  │────▶│  Verification   │
│   (port 5000)   │     │   (port 8001)   │     │    Service      │
└────────┬────────┘     └────────┬────────┘     │   (port 8000)   │
         │                       │              └────────┬────────┘
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   SDK + WASM    │     │   Issuer DB     │     │ Verification DB │
│  (native-sdk)   │     │  (port 5433)    │     │   (port 5432)   │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Services:**

- **Verification Service** (8000): Token verification, trusted issuers registry, revocation management
- **Issuer Service** (8001): Identity verification via IdPs, credential issuance

---

## How Selective Disclosure Works

```
                         ┌──────────────────────┐
                         │     Root Hash        │  ← Signed by issuer
                         └──────────┬───────────┘
                    ┌───────────────┴───────────────┐
              ┌─────┴─────┐                   ┌─────┴─────┐
              │   Hash    │                   │   Hash    │
              └─────┬─────┘                   └─────┬─────┘
           ┌───────┴───────┐               ┌───────┴───────┐
      ┌────┴────┐     ┌────┴────┐     ┌────┴────┐     ┌────┴────┐
      │firstName│     │lastName │     │ isOver18│     │nationalId│
      │  "Jan"  │     │"de Vries"│    │  true   │     │"1234..." │
      └─────────┘     └─────────┘     └─────────┘     └─────────┘
           ↓               ↓               ↓               ↓
       DISCLOSED       DISCLOSED       DISCLOSED        HIDDEN
```

When creating a token, the holder chooses which attributes to reveal. Hidden attributes are replaced with their hashes. The verifier can cryptographically prove the disclosed attributes belong to the signed root.

---

## Project Structure

```
owlid/
├── crates/                         # Rust workspace
│   ├── crypto/                     # Cryptographic primitives
│   │   ├── signature.rs            # Ed25519 signing/verification
│   │   ├── hash.rs                 # SHA-256, BLAKE3 hashing
│   │   ├── merkle.rs               # Merkle tree implementation
│   │   └── webauthn.rs             # WebAuthn/passkey support
│   ├── proof-system/               # Documents, tokens, Merkle proofs
│   │   ├── document.rs             # ProofDocument structure
│   │   ├── token.rs                # Token with selective disclosure
│   │   └── revocation.rs           # Revocation management
│   ├── verification-service/       # Verification REST API
│   │   ├── src/api.rs              # HTTP endpoints
│   │   ├── src/db/                 # Database repositories
│   │   └── migrations/             # PostgreSQL schema
│   └── issuer-service/             # Issuer REST API
│       ├── src/provider/           # Identity provider integrations
│       ├── src/db/                 # Database layer
│       └── migrations/             # PostgreSQL schema
├── packages/                       # TypeScript/JavaScript
│   ├── app/                        # Web UI (TanStack Start + React)
│   ├── sdk/                        # TypeScript SDK
│   │   ├── src/webauthn.ts         # WebAuthn helpers
│   │   ├── src/tokens.ts           # Token handling
│   │   └── src/storage.ts          # Credential storage
│   ├── native-sdk/                 # Rust/WASM native bindings
│   │   ├── src/lib.rs              # NAPI-RS bindings
│   │   └── npm/                    # Platform-specific packages
│   └── kitchen-sink/               # Component showcase & testing
├── docker-compose.yml              # PostgreSQL databases
├── justfile                        # Task automation
└── Cargo.toml                      # Rust workspace config
```

---

## Quick Start

### Prerequisites

- **Rust** 1.75+ ([rustup.rs](https://rustup.rs/))
- **Bun** ([bun.sh](https://bun.sh/))
- **Docker** ([docker.com](https://docs.docker.com/get-docker/))
- **Just** ([github.com/casey/just](https://github.com/casey/just))

### Installation

```bash
git clone <repo-url>
cd owlid

# Install dependencies
just setup
```

### Running

```bash
# Start everything WITHOUT Midnight (databases + backend + frontend)
just dev

# Start everything WITH Midnight (devnet + sidecar + DBs + backend + frontend)
just dev-e2e
```

`just dev` starts:

- **Frontend**: http://localhost:5000
- **Verification Service**: http://localhost:8000
- **Issuer Service**: http://localhost:8001

`just dev-e2e` additionally starts:

- **Midnight node**: ws://localhost:9944
- **Indexer GraphQL**: http://localhost:8088/api/v3/graphql
- **Proof server**: http://localhost:6300
- **Sidecar**: http://localhost:3000 (Midnight bridge for Rust services)

Image versions (mirroring [`midnightntwrk/midnight-local-dev`](https://github.com/midnightntwrk/midnight-local-dev/blob/main/standalone.yml)):
`midnight-node:0.22.3`, `indexer-standalone:4.0.1`, `proof-server:8.0.3`.

To run only the Midnight stack: `just midnight-up` (then `just midnight-status` to verify).

---

## API Reference

### Verification Service (`:8000`)

**Public endpoints:**

| Endpoint            | Method | Description              |
| ------------------- | ------ | ------------------------ |
| `/health`           | GET    | Health check             |
| `/generate-keypair` | GET    | Generate Ed25519 keypair |

**Protected endpoints** (require `X-API-Key` header):

| Endpoint                  | Method | Description              |
| ------------------------- | ------ | ------------------------ |
| `/verify`                 | POST   | Verify a token           |
| `/metrics`                | GET    | Verification metrics     |
| `/trusted-issuers`        | GET    | List trusted issuers     |
| `/trusted-issuers`        | POST   | Add trusted issuer       |
| `/revocations/revoke`     | POST   | Revoke credential        |
| `/revocations/suspend`    | POST   | Suspend credential       |
| `/revocations/reactivate` | POST   | Reactivate credential    |
| `/revocations/check`      | POST   | Check revocation status  |
| `/revocations/list`       | GET    | List revoked credentials |

**Example: Verify a token**

```bash
curl -X POST http://localhost:8000/verify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev_key_12345678901234567890123456789012" \
  -d '{
    "token": { ... },
    "challenge": "random-challenge-string"
  }'
```

### Issuer Service (`:8001`)

**Public endpoints:**

| Endpoint       | Method | Description             |
| -------------- | ------ | ----------------------- |
| `/health`      | GET    | Health check            |
| `/issuer-info` | GET    | Get issuer public key   |
| `/providers`   | GET    | List identity providers |
| `/keypair`     | POST   | Generate keypair        |

**Session endpoints:**

| Endpoint                     | Method | Description                  |
| ---------------------------- | ------ | ---------------------------- |
| `/sessions`                  | POST   | Create verification session  |
| `/sessions/{id}`             | GET    | Get session status           |
| `/sessions/{id}/submit`      | POST   | Submit identity (form-based) |
| `/sessions/{id}/claims`      | GET    | Get verified claims          |
| `/sessions/{id}/issue`       | POST   | Issue credential             |
| `/sessions/{id}/auto-verify` | POST   | Auto-verify with sample data |

**Callback endpoints:**

| Endpoint                        | Method | Description                    |
| ------------------------------- | ------ | ------------------------------ |
| `/callbacks/saml`               | POST   | SAML assertion callback        |
| `/callbacks/webhook/{provider}` | POST   | Webhook from external provider |

**Example: Create session and issue credential**

```bash
# 1. Create verification session
curl -X POST http://localhost:8001/sessions \
  -H "Content-Type: application/json" \
  -d '{"providerId": "mock-digid"}'

# 2. Auto-verify with sample data (for testing)
curl -X POST http://localhost:8001/sessions/{session_id}/auto-verify

# 3. Issue credential
curl -X POST http://localhost:8001/sessions/{session_id}/issue \
  -H "Content-Type: application/json" \
  -d '{"ownerPublicKey": "04abc123..."}'
```

---

## Identity Providers

Currently, OwlID includes **mock providers** for development and testing. The architecture supports real identity providers through defined flow types.

### Available Providers

| Provider        | Type      | Description                   |
| --------------- | --------- | ----------------------------- |
| **mock-digid**  | FormBased | Simulates Dutch DigiD flow    |
| **mock-bankid** | FormBased | Simulates Swedish BankID flow |

### Supported Flow Types (for future integrations)

| Flow Type        | Example Use Case | Description                                               |
| ---------------- | ---------------- | --------------------------------------------------------- |
| **SamlRedirect** | DigiD, eIDAS     | Redirect → IdP authentication → SAML assertion callback   |
| **QrPolling**    | BankID           | QR code displayed → user scans → service polls for result |
| **WebhookAsync** | Onfido, Jumio    | Redirect to KYC → verification → webhook callback         |
| **FormBased**    | Mock providers   | Direct form submission (testing only)                     |

---

## SDK Usage

### Installation

```bash
# TypeScript SDK
bun add @owlid/sdk

# Native SDK (auto-selects platform)
bun add @owlid/native-sdk
```

### WebAuthn Registration

```typescript
import { registerCredential, coseKeyToP256Hex } from '@owlid/sdk'

// Register a new passkey
const credential = await registerCredential({
  rpName: 'OwlID',
  rpId: 'localhost',
  userName: 'user@example.com',
  userVerification: 'required',
})

// Convert COSE key to P-256 hex for credential issuance
const ownerPublicKey = coseKeyToP256Hex(credential.publicKey)
```

### Token Creation (Two-Phase)

```typescript
import { prepareTokenForWebAuthn, finalizeTokenWithWebAuthn, signChallenge } from '@owlid/sdk'
import * as sdk from '@owlid/native-sdk'

// Phase 1: Prepare token
const { preparedTokenJson, webauthnChallenge } = prepareTokenForWebAuthn(
  sdk,
  credentialJson,
  ['firstName', 'lastName', 'isOver18'], // Disclosed attributes
  verifierChallenge,
  3600, // TTL in seconds
)

// Phase 2: Sign with WebAuthn (triggers biometric prompt)
const signature = await signChallenge(credentialId, webauthnChallenge)

// Phase 3: Finalize token
const { tokenJson } = finalizeTokenWithWebAuthn(
  sdk,
  preparedTokenJson,
  signature,
  credentialPublicKey,
)
```

### Storage API

```typescript
import { CredentialStorageManager, browserStorageAdapter } from '@owlid/sdk'

// Create storage manager (uses localStorage by default)
const storage = new CredentialStorageManager(browserStorageAdapter)

// Save WebAuthn credential
await storage.saveWebAuthnCredential({
  credentialId: credential.credentialId,
  publicKey: credential.publicKey,
  counter: 0,
  transports: ['internal'],
})

// Check for stored credential
if (await storage.hasStoredCredential()) {
  const data = await storage.loadCredentialData()
}
```

### Platform Support (Native SDK)

| Platform | Architecture                       |
| -------- | ---------------------------------- |
| Windows  | x64, arm64, i686                   |
| macOS    | x64 (Intel), arm64 (Apple Silicon) |
| Linux    | x64, arm64, armv7, musl variants   |
| Android  | arm64, arm                         |
| FreeBSD  | x64                                |
| WASM     | wasm32-wasi                        |

---

## WebAuthn / Passkeys

OwlID uses WebAuthn for hardware-backed credential signing. The private key never leaves the secure enclave.

### Features

| Feature                     | Implementation                       |
| --------------------------- | ------------------------------------ |
| **Algorithm**               | ECDSA P-256 (secp256r1) with SHA-256 |
| **Platform authenticators** | Face ID, Touch ID, Windows Hello     |
| **Security keys**           | USB, NFC, Bluetooth (FIDO2)          |
| **Replay protection**       | Signature counter validation         |
| **Challenge binding**       | Challenge hashed with token payload  |

### Flow

```
┌──────────┐    ┌──────────────┐    ┌─────────────────┐
│  Browser │───▶│   WebAuthn   │───▶│ Secure Enclave  │
│          │    │     API      │    │ (Face ID, etc.) │
└──────────┘    └──────────────┘    └─────────────────┘
     │                 │                     │
     │ 1. Challenge    │                     │
     │ ─────────────▶  │                     │
     │                 │ 2. Biometric prompt │
     │                 │ ──────────────────▶ │
     │                 │                     │
     │                 │ 3. P-256 signature  │
     │ 4. Signature    │ ◀────────────────── │
     │ ◀──────────────                       │
```

### Database Schema

**webauthn_credentials** (server-side storage):

- `credential_id`: Base64-encoded credential ID
- `public_key`: Base64-encoded COSE public key
- `counter`: Signature counter for replay protection
- `transports`: Supported transports (usb, nfc, ble, internal)

**webauthn_challenges** (short-lived):

- `challenge`: Base64-encoded challenge
- `operation`: 'register' or 'authenticate'
- `expires_at`: Auto-expires after 5 minutes

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
# Verification Service
VERIFICATION_DATABASE_URL=postgres://owl:owl_dev@localhost:5432/verification
SERVER_HOST=0.0.0.0
SERVER_PORT=8000

# Issuer Service
ISSUER_DATABASE_URL=postgres://owl:owl_dev@localhost:5433/issuer
ISSUER_HOST=0.0.0.0
ISSUER_PORT=8001

# Frontend
VITE_ISSUER_URL=http://localhost:8001
VITE_VERIFICATION_URL=http://localhost:8000

# Dev API Key
API_KEY_DEV=dev_key_12345678901234567890123456789012

# Logging
RUST_LOG=info,owl_verification_service=debug,owl_issuer_service=debug
```

---

## Database Commands

```bash
just db-start         # Start PostgreSQL containers
just db-stop          # Stop databases
just db-reset         # Reset databases (wipes data)
just db-tables        # Show tables in both DBs
just db-verification  # PostgreSQL CLI for verification DB
just db-issuer        # PostgreSQL CLI for issuer DB
```

### Schema Overview

**Verification Service** (`localhost:5432`):

- `api_keys` - API authentication (hashed keys)
- `trusted_issuers` - Registry of trusted credential issuers
- `revocations` - Credential revocation status
- `verification_logs` - Audit trail (hashed data, 90-day expiry)
- `verification_metrics` - Aggregated metrics
- `audit_events` - Compliance audit trail

**Issuer Service** (`localhost:5433`):

- `issued_credentials` - Credential registry
- `owl_users` - User registry (hashed PII)
- `webauthn_credentials` - Passkey storage
- `webauthn_challenges` - Short-lived challenges
- `auth_sessions` - User sessions

---

## How It Works

### 1. Identity Verification

```
User ──▶ Issuer Service ──▶ Identity Provider (mock-digid, mock-bankid)
                │
                ▼
         Verified Claims
```

### 2. Credential Issuance

```
Verified Claims ──▶ Merkle Tree ──▶ Signed ProofDocument
                           │
     ┌─────────────────────┼─────────────────────┐
     │                     │                     │
  firstName            lastName              isOver18
   "Jan"              "de Vries"               true
```

### 3. Token Creation

```
ProofDocument + Selected Attributes ──▶ Token
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                firstName: "Jan"     lastName: "de Vries"   isOver18: true
                                     nationalId: [hash]
```

### 4. Verification

```
Token + Challenge ──▶ Verification Service
                           │
                           ├── Check issuer signature
                           ├── Verify Merkle proofs
                           ├── Check challenge binding
                           ├── Check revocation status
                           │
                           ▼
                      Valid / Invalid
```

---

## Security Features

| Feature                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| **Ed25519 signatures**  | Issuer signs credential root hash                  |
| **P-256 WebAuthn**      | Owner signs tokens with hardware-backed key        |
| **SHA-256 hashing**     | Merkle tree and challenge binding                  |
| **Merkle proofs**       | Selective disclosure without revealing hidden data |
| **Counter validation**  | Replay protection for WebAuthn signatures          |
| **Challenge binding**   | Tokens bound to verifier-provided challenge        |
| **Revocation registry** | Real-time credential status checking               |
| **GDPR compliance**     | Hashed PII, audit trails, automatic expiry         |
| **Rate limiting**       | API abuse prevention                               |
| **API key auth**        | Protected endpoints require authentication         |

---

## Development

### Commands

```bash
just dev             # Start all services
just dev-backend     # Backend only
just dev-app         # Frontend only
just build           # Build everything
just test            # Run all tests
just fmt             # Format code
just lint            # Run linters
just check           # Format + lint + test
```

### Building Native SDK

```bash
just build-sdk
```

This builds:

1. Native bindings for current platform
2. WASM build for browsers
3. TypeScript SDK

### Running Tests

```bash
just test-rust       # Rust tests only
just test-ts         # TypeScript tests only
just test            # All tests
```

---

## Contributing

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/my-feature`
3. **Make** changes and ensure tests pass
4. **Run** `just check` (format + lint + test)
5. **Commit** with conventional commits: `feat:`, `fix:`, `docs:`, etc.
6. **Open** a pull request

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

---
