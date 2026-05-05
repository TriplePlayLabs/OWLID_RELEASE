# OwlID Verification Service

Customer-facing HTTP API for verifying OwlID tokens, managing trusted issuers, and tracking credential revocations. Default port: **8000**.

- **Live OpenAPI / Swagger UI**: `http://localhost:8000/swagger-ui/`
- **Raw OpenAPI JSON**: `http://localhost:8000/api-docs/openapi.json`
- **Source**: `crates/verification-service/`

The OpenAPI spec is the source of truth. The TypeScript clients in `packages/verifier-client/` and `packages/admin-client/` are generated from it via `just generate-api-client`.

---

## Authentication

Two schemes coexist:

| Scheme           | Header                            | Used by                                                     |
| ---------------- | --------------------------------- | ----------------------------------------------------------- |
| API key          | `Authorization: Bearer <api-key>` | `/verify`, `/trusted-issuers`, `/revocations/*`, `/metrics` |
| Admin JWT cookie | `Cookie: owlid_admin_token=<jwt>` | `/admin/me`, `/admin/api-keys`, `/admin/api-keys/{id}`      |
| Admin JWT bearer | `Authorization: Bearer <jwt>`     | Same as cookie — alternative for non-browser clients        |

API keys are issued from the admin dashboard or seeded via SQL (see `RUNBOOK.md`). Each key carries a permission set: `verify`, `manage_issuers`, `manage_revocations`, `gdpr`, `admin`.

GDPR routes additionally require the `gdpr` permission. Trusted issuer mutation, revocation mutation, and metrics require `admin`.

---

## Routes

### Public — no auth

| Method | Path                    | Tag        | Description                                      |
| ------ | ----------------------- | ---------- | ------------------------------------------------ |
| GET    | `/health`               | monitoring | Liveness probe                                   |
| GET    | `/prometheus`           | —          | Prometheus scrape endpoint                       |
| POST   | `/admin/login`          | admin-auth | Operator login (returns JWT cookie)              |
| POST   | `/admin/logout`         | admin-auth | Clear JWT cookie                                 |
| GET    | `/ws/presentation/{id}` | —          | WebSocket — holder/verifier presentation channel |
| GET    | `/ws/revocations`       | —          | WebSocket — live revocation events               |

### Verification (API key, no extra permission)

| Method | Path                     | Tag          | Description                                    |
| ------ | ------------------------ | ------------ | ---------------------------------------------- |
| GET    | `/verify/challenge`      | verification | Mint a single-use server challenge             |
| POST   | `/verify`                | verification | Verify a token against a challenge             |
| POST   | `/presentation/sessions` | presentation | Open an ISO 18013-5 style presentation session |
| GET    | `/trusted-issuers`       | issuers      | List active trusted issuers                    |
| POST   | `/revocations/check`     | revocations  | Check if a credential is revoked               |
| GET    | `/revocations/list`      | revocations  | Paginated revoked credential dump              |

### Admin (API key + `admin` permission)

| Method | Path                      | Tag               |
| ------ | ------------------------- | ----------------- |
| POST   | `/trusted-issuers`        | admin-issuers     |
| POST   | `/revocations/revoke`     | admin-revocations |
| POST   | `/revocations/suspend`    | admin-revocations |
| POST   | `/revocations/reactivate` | admin-revocations |
| GET    | `/metrics`                | metrics           |

### GDPR (API key + `gdpr` permission)

| Method | Path                                     | Tag  |
| ------ | ---------------------------------------- | ---- |
| DELETE | `/admin/gdpr-erasure/{owner_public_key}` | gdpr |

### Admin dashboard (JWT)

| Method | Path                   | Tag        |
| ------ | ---------------------- | ---------- |
| GET    | `/admin/me`            | admin-auth |
| GET    | `/admin/api-keys`      | admin      |
| POST   | `/admin/api-keys`      | admin      |
| DELETE | `/admin/api-keys/{id}` | admin      |

---

## Common flows

### 1. Verify a token

```bash
# 1. Holder builds a token using @owlid/sdk locally with the verifier's challenge.
# 2. Verifier service POSTs the token + challenge here:

curl -X POST http://localhost:8000/verify \
  -H "Authorization: Bearer owlid_sk_test_dev0000000000000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "OID1:...",
    "challenge": "the-challenge-the-verifier-issued"
  }'
```

Response:

```json
{
  "valid": true,
  "subjects": { "firstName": "Alice", "isOver18": true },
  "error": null
}
```

If `valid` is false, `error` carries the failure reason (untrusted issuer, expired, revoked, challenge mismatch, etc.).

### 2. Generate a server challenge

Stateless verifiers can mint their own UUID challenge. For replay protection backed by the service:

```bash
curl http://localhost:8000/verify/challenge \
  -H "Authorization: Bearer <api-key>"
# { "challenge": "0a4f…", "expiresIn": 300 }
```

The challenge is single-use and consumed atomically on `/verify`.

### 3. ISO 18013-5 presentation session (QR / WebSocket)

```bash
# 1. Verifier opens an empty session
curl -X POST http://localhost:8000/presentation/sessions \
  -H "Authorization: Bearer <api-key>"
# {
#   "sessionId": "...",
#   "wsUrl":     "/ws/presentation/<sessionId>",
#   "nonce":     "...",
#   "expiresIn": 300
# }
```

The verifier renders a QR encoding `wsUrl + role=holder + nonce` (see `SessionEngagement` in `packages/sdk/src/presentation.ts`).

```mermaid
sequenceDiagram
    autonumber
    participant V as Verifier
    participant S as Verification service
    participant H as Holder app

    V->>S: POST /presentation/sessions
    S-->>V: { sessionId, wsUrl, nonce }
    V->>H: render QR with sessionId + nonce
    V->>S: WS ?role=verifier
    H->>S: WS ?role=holder
    V->>H: presentation_request
    H-->>V: presentation_response { token }
    V->>S: POST /verify (consumes nonce)
    S-->>V: { valid, subjects }
```

Proof request, predicates, and the final token are negotiated over the WebSocket. The verifier sends a `presentation_request` message; the holder responds with a `presentation_response` carrying a token bound to the session `nonce`. The server consumes the nonce atomically — replays fail.

### 4. Revoke a credential

```bash
curl -X POST http://localhost:8000/revocations/revoke \
  -H "Authorization: Bearer <admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{ "credential_id": "<uuid>", "issuer_public_key": "<hex>", "reason": "Compromised" }'
```

> Most verification-service request bodies are `snake_case` on the wire. The admin-auth endpoints (`/admin/login`, `/admin/me`, `/admin/api-keys`) return `camelCase`. The generated TS client normalizes both — only matters if you call the API by hand.

Live verifiers receive a push event over `ws://localhost:8000/ws/revocations`.

### 5. GDPR erasure

```bash
curl -X DELETE http://localhost:8000/admin/gdpr-erasure/<owner_public_key_hex> \
  -H "Authorization: Bearer <gdpr-api-key>"
```

Response is a signed receipt; the actual erasure also writes an `audit_events` row.

---

## Configuration

| Variable                    | Default                                                          | Notes                                |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `VERIFICATION_DATABASE_URL` | `postgres://owl:owl_dev@postgres-verification:5432/verification` | Required                             |
| `SERVER_HOST`               | `0.0.0.0`                                                        |                                      |
| `SERVER_PORT`               | `8000`                                                           |                                      |
| `RUST_LOG`                  | `info`                                                           | Tracing filter                       |
| `ADMIN_JWT_SECRET`          | (required, no default in prod)                                   | HS256 secret for admin JWTs          |
| `CORS_ALLOWED_ORIGINS`      | dev defaults (`localhost:5000/5001/4000`)                        | Comma-separated list                 |
| `RATE_LIMIT_ENABLED`        | `true`                                                           |                                      |
| `RATE_LIMIT_MAX_REQUESTS`   | `100`                                                            | Per identifier per window            |
| `RATE_LIMIT_WINDOW_MINUTES` | `1`                                                              |                                      |
| `MIDNIGHT_ENABLED`          | `true`                                                           | If true the service consults sidecar |
| `MIDNIGHT_SIDECAR_URL`      | `http://midnight-sidecar:3000`                                   | Bridge to chain                      |
| `MIDNIGHT_SIDECAR_API_KEY`  | (required if `MIDNIGHT_ENABLED=true`)                            | Shared secret with sidecar           |
| `ENCRYPTION_KEY`            | (optional)                                                       | 32-byte hex, AES-GCM at rest         |
| `TLS_ENABLED`               | `false`                                                          | Prefer terminating TLS upstream      |

Full env reference: see `.env.example` at the repo root.

---

## Background tasks

The service spawns a 60-second tick that:

- Cleans expired single-use challenges from the DB.
- Cleans expired presentation sessions.

Long-running cleanup of audit logs (`delete_expired_records()`) is **not** started inside the service — schedule it via pg_cron or an external job.

---

## Observability

- `GET /prometheus` — open metrics (no auth, suitable for Prometheus scrape)
- `GET /metrics` — JSON aggregated metrics (admin)
- `GET /health` — liveness probe
- All responses carry a `x-correlation-id` header. Logs are tagged with the same id.

Key metrics:

| Metric                                | Type      |
| ------------------------------------- | --------- |
| `http_requests_total`                 | Counter   |
| `token_verification_duration_seconds` | Histogram |
| `tokens_verified_total{result}`       | Counter   |
| `credentials_revoked_total`           | Counter   |

---

## Generated TypeScript clients

```ts
import { configure } from '@owlid/sdk'
import {
  getVerificationApi,
  getRevocationsApi,
  getIssuersApi,
  getPresentationApi,
  getMonitoringApi,
} from '@owlid/sdk/verifier'

configure({ verificationUrl: 'https://verify.example.com', apiKey: '...' })

// Verify a token
const result = await getVerificationApi().verifyToken({
  verifyRequest: { token, challenge },
})

// Open an empty presentation session
const session = await getPresentationApi().createSession()
// → { sessionId, wsUrl, nonce, expiresIn }
```

The admin client (`@owlid/admin-client`) is operator-only and not exported from the public SDK.

---

## Local development

```bash
just dev-backend      # runs verification + issuer + sidecar
just dev              # all of the above + holder app
cargo run -p owl-verification-service  # service only
```

Tests:

```bash
cargo test -p owl-verification-service
```

Regenerate clients after changing routes or schemas:

```bash
just generate-api-client
```

If you add a route, annotate it with `#[utoipa::path]`, register it in the `paths(...)` block of `ApiDoc`, and tag it with the right `tag = "..."` so the generator routes it to the correct package. Tag → package mapping lives in the `generate-api-client` recipe in `justfile`.
