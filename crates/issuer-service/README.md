# OwlID Issuer Service

Issuance pipeline: orchestrates identity verification through pluggable providers (DigiD/BankID mocks, Didit KYC, OIDC) and signs Merkle-rooted credentials with the issuer's Ed25519 key. Default port: **8001**.

- **Live OpenAPI / Swagger UI**: `http://localhost:8001/swagger-ui/`
- **Raw OpenAPI JSON**: `http://localhost:8001/api-docs/openapi.json`
- **Source**: `crates/issuer-service/`

The OpenAPI spec is the source of truth. The TypeScript clients in `packages/issuer-client/` and (for callbacks) `packages/admin-client/` are generated from it via `just generate-api-client`.

---

## Authentication

**All routes are public.** The service trusts the upstream identity provider for authentication and the holder app for session ownership. Production deployments should sit behind a reverse proxy that enforces TLS and (for the admin/operator surface) network ACLs.

---

## Routes

| Method | Path                                    | Tag         | Description                                   |
| ------ | --------------------------------------- | ----------- | --------------------------------------------- |
| GET    | `/health`                               | info        | Liveness probe                                |
| GET    | `/issuer-info`                          | info        | Returns issuer name + Ed25519 public key      |
| GET    | `/providers`                            | providers   | List configured identity providers            |
| POST   | `/sessions`                             | sessions    | Open a verification session                   |
| GET    | `/sessions/{id}`                        | sessions    | Read session state                            |
| POST   | `/sessions/{id}/submit`                 | sessions    | Submit identity (form-based providers)        |
| GET    | `/sessions/{id}/claims`                 | sessions    | Read verified identity claims                 |
| POST   | `/sessions/{id}/issue`                  | credentials | Sign and return an SD-JWT VC credential       |
| POST   | `/credential`                           | credentials | OpenID4VCI single / Batch credential endpoint |
| POST   | `/token`                                | credentials | OpenID4VCI pre-authorized code → access token |
| GET    | `/.well-known/openid-credential-issuer` | info        | OpenID4VCI issuer metadata                    |
| GET    | `/.well-known/did.json`                 | info        | did:web document (CORS-public)                |
| GET    | `/status/{id}`                          | status      | IETF Token Status List (`statuslist+jwt`)     |
| POST   | `/sessions/{id}/auto-verify`            | sessions    | Mock provider shortcut                        |
| POST   | `/sessions/{id}/complete`               | sessions    | Mark session complete (provider-driven)       |
| POST   | `/callbacks/saml`                       | callbacks   | SAML assertion callback                       |
| POST   | `/callbacks/webhook/{provider}`         | callbacks   | Provider webhook (Didit, etc.)                |
| GET    | `/auth/login/{provider}`                | oidc        | OIDC authorize redirect                       |
| GET    | `/auth/callback/{provider}`             | oidc        | OIDC token exchange + claim materialisation   |
| GET    | `/auth/providers`                       | oidc        | List configured OIDC providers                |
| GET    | `/polling/{session_id}`                 | polling     | Status polling for QR / webhook flows         |

---

## Lifecycle of a credential

```mermaid
sequenceDiagram
    autonumber
    participant App as Holder app
    participant Svc as Issuer service
    participant IdP as Identity provider

    App->>Svc: POST /sessions { providerId }
    Svc-->>App: { sessionId, flowType, startData }
    loop Until claims ready
        App->>Svc: GET /sessions/{id}
        Svc-->>App: status (pending / verified)
    end
    Note over Svc,IdP: Provider drives auth (form, OIDC, SAML, or webhook)
    Svc->>IdP: verify
    IdP-->>Svc: claims
    App->>Svc: POST /sessions/{id}/issue { ownerPublicKey, keyAlgorithm }
    Svc->>Svc: sign SD-JWT VC<br/>(JWT + per-claim disclosures + cnf + status)
    Svc-->>App: { sdJwtVc, issuer (did:web), credentialId }
```

### Flow types

| Flow type      | Provider examples       | Surface                                        |
| -------------- | ----------------------- | ---------------------------------------------- |
| `FormBased`    | mock-digid, mock-bankid | `POST /sessions/{id}/submit`                   |
| `OidcRedirect` | Generic OIDC providers  | `/auth/login/{p}` → IdP → `/auth/callback/{p}` |
| `SamlRedirect` | DigiD (real), eIDAS     | IdP → `POST /callbacks/saml`                   |
| `WebhookAsync` | Didit, Onfido           | redirect → IdP → `POST /callbacks/webhook/{p}` |
| `QrPolling`    | BankID                  | QR code → `GET /polling/{session_id}`          |

### Issuance

Once claims are verified, `POST /sessions/{id}/issue` normalizes the claims into SD-JWT VC standard names (`given_name`, `family_name`, `birthdate`, `nationalities`, derived `age_over_NN`, `kyc_level`), signs an SD-JWT VC with `ISSUER_PRIVATE_KEY` (EdDSA), and returns `{ sdJwtVc, issuer, credentialId }`. The holder stores it locally; the service does not retain unhashed claim values past the session TTL.

```bash
curl -X POST http://localhost:8001/sessions/<id>/issue \
  -H "Content-Type: application/json" \
  -d '{
    "ownerPublicKey": "04abc...",
    "keyAlgorithm": "p256"
  }'
```

`keyAlgorithm` accepts `p256` (ES256 holder confirmation key) or `ed25519` (EdDSA holder confirmation key, default for wallet keys). Owner public keys are hex-encoded SEC1 (P-256) or 32-byte raw (Ed25519).

For OpenID4VCI use `POST /credential` instead — same shape, with optional `batchSize: 1..=64` for Batch Credential issuance (multiple one-time-use credentials, each with a distinct `credential_id`, for multi-show unlinkability).

---

## Identity providers

### Mock providers (always on)

- `mock-digid` — simulated Dutch DigiD form flow
- `mock-bankid` — simulated Swedish BankID flow

Use these for local development. They auto-verify a fixed set of claims when the form is submitted (or via `POST /sessions/{id}/auto-verify`).

### Didit (KYC)

Enabled when `DIDIT_API_KEY` and `DIDIT_WORKFLOW_ID` are set. Webhook signature verification requires `DIDIT_WEBHOOK_SECRET`.

```bash
DIDIT_API_KEY=...
DIDIT_WORKFLOW_ID=...
DIDIT_WEBHOOK_SECRET=...
DIDIT_BASE_URL=https://verification.didit.me     # default
```

### OIDC providers

Comma-separated prefixes in `OIDC_PROVIDERS`. For each prefix `FOO`:

```bash
OIDC_PROVIDERS=foo,bar
FOO_ISSUER_URL=https://idp.example.com
FOO_CLIENT_ID=...
FOO_CLIENT_SECRET=...
FOO_REDIRECT_URI=${APP_URL}/auth/callback/foo    # optional
FOO_SCOPES=openid,profile,email                  # optional
```

---

## Configuration

| Variable                             | Default                                              | Notes                                                     |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| `ISSUER_DATABASE_URL`                | `postgres://owl:owl_dev@postgres-issuer:5432/issuer` | Required                                                  |
| `ISSUER_HOST`                        | `0.0.0.0`                                            |                                                           |
| `ISSUER_PORT`                        | `8001`                                               |                                                           |
| `ISSUER_PRIVATE_KEY`                 | (required for issuance)                              | 32-byte hex Ed25519 private key                           |
| `VERIFICATION_SERVICE_URL`           | `http://localhost:8000`                              | Verification service URL for trusted-issuer registration  |
| `VERIFICATION_ADMIN_API_KEY`         | `API_KEY_DEV` if set                                 | Admin/service key used to register this issuer as trusted |
| `APP_URL`                            | `http://localhost:5000`                              | Used as base for OIDC + webhook callback redirects        |
| `RUST_LOG`                           | `info`                                               |                                                           |
| `MIDNIGHT_SIDECAR_URL`               | `http://midnight-sidecar:3000`                       | Sidecar URL (required; service exits 1 if unreachable)    |
| `MIDNIGHT_SIDECAR_API_KEY`           | (required)                                           | Shared secret with sidecar                                |
| `MIDNIGHT_SIDECAR_TIMEOUT`           | `120`                                                | Per-request timeout in seconds                            |
| `MIDNIGHT_AUTO_REGISTER_ISSUER`      | `false`                                              | Push issuer to on-chain registry on startup               |
| `DIDIT_*`                            | (optional)                                           | See above                                                 |
| `OIDC_PROVIDERS` + per-provider vars | (optional)                                           | See above                                                 |

Full env reference: see `.env.example` at the repo root.

---

## Generated TypeScript client

```ts
import { configure } from '@owlid/sdk'
import {
  getInfoApi,
  getProvidersApi,
  getSessionsApi,
  getCredentialsApi,
  getOidcApi,
  getPollingApi,
} from '@owlid/sdk/issuer'

configure({ issuerUrl: 'https://issuer.example.com' })

const info = await getInfoApi().getIssuerInfo()
const providers = await getProvidersApi().listProviders()
const session = await getSessionsApi().createSession({
  createSessionRequest: { providerId: 'mock-digid' },
})
```

The `CallbacksApi` (SAML / webhook receivers) lives in `@owlid/admin-client` since callers are not customer apps.

---

## CORS

Default `CorsLayer::permissive()`. Production should restrict allowed origins via the `CORS_ALLOWED_ORIGINS` env var (comma-separated) once the issuer service exposes any sensitive route.

---

## Local development

```bash
just dev-backend         # issuer + verification + sidecar
cargo run -p owl-issuer-service
```

Tests:

```bash
cargo test -p owl-issuer-service
```

Regenerate clients after route or schema changes:

```bash
just generate-api-client
```

If you add a route, annotate it with `#[utoipa::path]`, register it in the `paths(...)` block of `ApiDoc`, and tag it. Customer-facing tags (`info`, `providers`, `sessions`, `credentials`, `oidc`, `polling`) generate into `@owlid/issuer-client`. Operator tags (`callbacks`) generate into `@owlid/admin-client`. Mapping lives in the `generate-api-client` recipe in `justfile`.
