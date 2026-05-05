# @owlid/admin

Operator dashboard for OwlID — manage trusted issuers, mint API keys, monitor verifications, revoke credentials, run GDPR erasure.

Internal tool. Not published to npm. Built with TanStack Start + React 19 + `@owlid/ui` (shadcn primitives).

```bash
bun run dev:admin     # → http://localhost:4000
```

## Routes

| Route          | Purpose                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `/` (index)    | Dashboard — service health (verification + issuer) and aggregate metrics          |
| `/issuers`     | Trusted issuer registry — list, add, deactivate                                   |
| `/api-keys`    | API key CRUD — create prefixed keys (`owlid_{pk\|sk}_{live\|test}_…`), deactivate |
| `/revocations` | Revoke / suspend / reactivate credentials, check status                           |
| `/verify`      | Manual token verification form                                                    |
| `/sessions`    | Look up issuer sessions by id                                                     |
| `/providers`   | Read-only view of identity + OIDC providers                                       |
| `/logs`        | Live event stream (WebSocket revocation feed + health polling)                    |
| `/settings`    | Service endpoints, GDPR erasure tool                                              |

## Authentication

- Login via `POST /admin/login` on the verification service. Server sets `owlid_admin_token` HTTP-only cookie.
- The SPA never sees the JWT in JS. Bootstrap uses `useQuery(['admin','me'])` calling `getAdminAuthApi().me()` — that query's cache _is_ the auth state.
- Logout clears the cookie + invalidates all `['admin']` queries.

```ts
// Default dev creds (change for any non-localhost deployment)
username: admin
password: admin
```

Default seed lives in `crates/verification-service/migrations/004_admin_users.sql`.

## State management

- Every server-derived value lives in `useQuery` / `useMutation` (TanStack Query). No `useState + useEffect` for fetch, no `localStorage` for tokens.
- WebSocket lifecycle (`/logs`) is the only place using `useState + useEffect` — manages the subscription, not the data.
- Auth is a single `useQuery` whose cache state determines the routed view (`AuthGate` in `src/routes/__root.tsx`).

## Generated API client usage

`src/lib/api.ts` is a thin facade over the three generated clients:

```ts
// admin operations (verification + issuer admin surface)
import {
  getAdminApi,
  getAdminAuthApi,
  getAdminIssuersApi,
  getAdminRevocationsApi,
  getGdprApi,
  getMetricsApi,
} from '@owlid/admin-client'

// public surfaces, re-exported through the SDK
import {
  getIssuersApi,
  getMonitoringApi,
  getRevocationsApi,
  getVerificationApi,
} from '@owlid/sdk/verifier'
import { getInfoApi, getOidcApi, getProvidersApi, getSessionsApi } from '@owlid/sdk/issuer'
```

No hand-rolled HTTP. If a route is missing on the generated client, add the route + `#[utoipa::path]` annotation in the Rust service, restart, run `just generate-api-client`.

## Hooks

| Hook                 | Wraps                                                           |
| -------------------- | --------------------------------------------------------------- |
| `useAuth()`          | `me`, `login`, `logout` — cookie-backed                         |
| `useAdmin*()`        | API key CRUD                                                    |
| `useVerification*()` | Health, trusted issuers, revocations, manual verify             |
| `useIssuer*()`       | Issuer info, OIDC providers, identity providers, session lookup |

`use-mobile.ts` is a viewport hook (no API calls).

## Development

```bash
bun install
bun run dev:admin               # vite dev on :4000

# Backend dependencies (separate terminal)
just dev-backend                # verification + issuer + sidecar

# Type check
bun run --filter @owlid/admin check

# Tests
bun run --filter @owlid/admin test
```

The dev server allows `*.trycloudflare.com` and `*.sashoush.dev` for tunnel testing — see `vite.config.ts`. SSR is enabled via `@tanstack/react-start`; native SDK modules are excluded from the SSR bundle (browser-only).

## Building

```bash
bun run build:admin
```

Outputs to `.output/`. The production container is built from `Dockerfile.admin` at the repo root, which runs the build inside the workspace and serves the output via nginx (`docker/nginx-spa.conf`).

## Configuration

Public-facing URLs are baked at build time via Vite env:

- `VITE_VERIFICATION_URL` — verification service base URL
- `VITE_ISSUER_URL` — issuer service base URL

Runtime overrides via `window.__OWLID_CONFIG__` (set by `docker/runtime-config.sh` before nginx start). See [`packages/sdk/README.md#configuration-precedence`](../sdk/README.md#configuration-precedence) for the resolution order.

The admin client always sends `credentials: 'include'` so the `owlid_admin_token` cookie is attached on cross-origin XHR. The verification service's CORS layer must explicitly allow the admin origin (`CORS_ALLOWED_ORIGINS`) — wildcard origins are incompatible with credentialed requests.

## Adding a new admin route

1. Add the Rust handler with `#[utoipa::path(... tag = "admin-…")]` (admin tag → `@owlid/admin-client`).
2. Restart the verification service so `/api-docs/openapi.json` reflects the new route.
3. `just generate-api-client` — regenerates `apis/`, `models/`, `runtime.ts` for all three client packages.
4. Add a `useQuery` / `useMutation` hook under `src/hooks/` calling the generated method.
5. Add a route file under `src/routes/`. TanStack Router picks it up via filesystem routing.

Never hand-edit `packages/admin-client/src/{apis,models}/*` or `runtime.ts` — they are regenerated.
