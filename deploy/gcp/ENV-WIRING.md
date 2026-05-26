# Service URL + env wiring — OwlID GCP deploy

Where every URL and env var comes from. What references what. How to change them.

## Cloud Run URLs are predictable

GCP exposes **two URL formats per service**, both resolve to the same Cloud Run revision:

| Format                                   | Pattern                                              | Example                                                  |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Project-number v2                        | `https://<service>-<projectnumber>.<region>.run.app` | `https://verification-922474514728.europe-west1.run.app` |
| Project-region hash (legacy / canonical) | `https://<service>-<hash>-<region-short>.a.run.app`  | `https://verification-jlctpv2qvq-ew.a.run.app`           |

The hash + region-short suffix is stable for a given `(project, region)` and discovered after the first `terraform apply` via `gcloud run services describe <svc> --format='value(status.url)'`. Override via `terraform.tfvars`:

```hcl
run_url_hash = "jlctpv2qvq"   # for owlid-491411 + europe-west1
```

`local.run_url` in `terraform/locals.tf` builds the hash form. Either format works for browser/server access. After domain mapping is live, swap to the `*.owlid.app` URLs and ignore both `.run.app` formats.

Why predictability matters: `app` references `verification` URL via `OWLID_VERIFICATION_URL`, `issuer` references `app` URL via `APP_URL` — a circular dependency in TF state if we resolved via `google_cloud_run_v2_service.X.uri`. Predictable URLs break the cycle.

## Service env-var matrix

### `verification` (Rust, port 8000)

| Env var                     | Source                                               | Notes                                                                     |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `SERVER_HOST`               | TF static `0.0.0.0`                                  | bind any                                                                  |
| `SERVER_PORT`               | TF static `8000`                                     | matches `--port` on Cloud Run                                             |
| `RUST_LOG`                  | TF static `info`                                     |                                                                           |
| `APP_ENV`                   | TF `var.app_env`                                     | `development` / `production` — gates strict CORS + cookie + secret checks |
| `CORS_ALLOWED_ORIGINS`      | TF `local.cors_origins` (auto from frontend URLs)    | required when `APP_ENV=production`                                        |
| `ADMIN_COOKIE_DOMAIN`       | TF `var.admin_cookie_domain` (only set if non-empty) | apex domain for admin auth cookie; leave empty on `.run.app`              |
| `RATE_LIMIT_ENABLED`        | TF static `true`                                     |                                                                           |
| `RATE_LIMIT_MAX_REQUESTS`   | TF static `100`                                      | per-id, per-window                                                        |
| `RATE_LIMIT_WINDOW_MINUTES` | TF static `1`                                        |                                                                           |
| `TLS_ENABLED`               | TF static `false`                                    | TLS terminated by Cloud Run                                               |
| `MIDNIGHT_SIDECAR_URL`      | TF `local.run_url["sidecar"]`                        | sidecar Cloud Run URL (required; service exits 1 if unreachable)          |
| `MIDNIGHT_SIDECAR_TIMEOUT`  | TF `var.midnight_sidecar_timeout_ms`                 | request timeout to sidecar                                                |
| `VERIFICATION_DATABASE_URL` | secret `verification-db-url`                         | full Postgres DSN; falls back to `DATABASE_URL` if unset                  |
| `ENCRYPTION_KEY`            | secret `encryption-key`                              | 32-byte AES-GCM hex                                                       |
| `ADMIN_JWT_SECRET`          | secret `admin-jwt-secret`                            | HS256 signing key                                                         |
| `API_KEY_DEV`               | secret `api-key-dev`                                 | seed API key, dev-only                                                    |
| `MIDNIGHT_SIDECAR_API_KEY`  | secret `midnight-sidecar-api-key`                    | shared with sidecar + issuer                                              |

Optional / not yet wired:

- `TLS_CERT_PATH`, `TLS_KEY_PATH`, `TLS_CA_CERT_PATH` — only relevant if `TLS_ENABLED=true`. Cloud Run terminates TLS upstream so leave unset.

### `issuer` (Rust, port 8001)

| Env var                         | Source                                 | Notes                                                              |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `ISSUER_HOST`                   | TF static `0.0.0.0`                    |                                                                    |
| `ISSUER_PORT`                   | TF static `8001`                       |                                                                    |
| `RUST_LOG`                      | TF static `info`                       |                                                                    |
| `APP_ENV`                       | TF `var.app_env`                       | same semantics as verification                                     |
| `CORS_ALLOWED_ORIGINS`          | TF `local.cors_origins`                |                                                                    |
| `RATE_LIMIT_ENABLED`            | TF static `true`                       |                                                                    |
| `RATE_LIMIT_MAX_REQUESTS`       | TF static `100`                        |                                                                    |
| `RATE_LIMIT_WINDOW_SECONDS`     | TF static `60`                         | issuer uses `_SECONDS` (verification uses `_MINUTES` — historical) |
| `MIDNIGHT_SIDECAR_URL`          | TF `local.run_url["sidecar"]`          | required; service exits 1 if unreachable                           |
| `MIDNIGHT_SIDECAR_TIMEOUT`      | TF `var.midnight_sidecar_timeout_ms`   |                                                                    |
| `MIDNIGHT_AUTO_REGISTER_ISSUER` | TF `var.midnight_auto_register_issuer` | bool — set true after issuer key is finalised                      |
| `APP_URL`                       | TF `local.run_url["app"]`              | OAuth redirect base                                                |
| `VERIFICATION_SERVICE_URL`      | TF `local.run_url["verification"]`     | issuer auto-registers its public key here                          |
| `ISSUER_DATABASE_URL`           | secret `issuer-db-url`                 |                                                                    |
| `ISSUER_PRIVATE_KEY`            | secret `issuer-private-key`            | Ed25519 signing key                                                |
| `VERIFICATION_ADMIN_API_KEY`    | secret `api-key-dev`                   | server-side only; registers issuer as trusted                      |
| `MIDNIGHT_SIDECAR_API_KEY`      | secret `midnight-sidecar-api-key`      |                                                                    |

Optional / not yet wired (services tolerate unset):

- `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_BASE_URL`, `DIDIT_WEBHOOK_SECRET` — KYC provider integration. Add as secrets in `terraform/secrets.tf` and wire env refs in `run.tf` once Didit is provisioned.
- `OIDC_PROVIDERS` — comma-separated OIDC provider prefixes. For each prefix `FOO`: `FOO_ISSUER_URL`, `FOO_CLIENT_ID`, `FOO_CLIENT_SECRET`, `FOO_REDIRECT_URI` (optional), `FOO_SCOPES` (optional).
- `IDP_ISSUER_PRIVATE_KEY` — alternate path read in some code; redundant with `ISSUER_PRIVATE_KEY` for normal operation.

### `sidecar` (Bun + Hono, port 3000)

| Env var                     | Source                            | Notes                                                        |
| --------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `MIDNIGHT_SIDECAR_PORT`     | TF static `3000`                  |                                                              |
| `MIDNIGHT_NETWORK_ID`       | TF static `undeployed`            | flip to `preprod` or `mainnet` for testnet/mainnet           |
| `MIDNIGHT_NODE_WS_URL`      | TF static placeholder             | replace with real Midnight node WS URL                       |
| `MIDNIGHT_INDEXER_URI`      | TF static placeholder             |                                                              |
| `MIDNIGHT_INDEXER_WS_URI`   | TF static placeholder             |                                                              |
| `MIDNIGHT_PROOF_SERVER_URI` | TF static placeholder             | replace with hosted proof server URL                         |
| `MIDNIGHT_SIDECAR_API_KEY`  | secret `midnight-sidecar-api-key` |                                                              |
| `MIDNIGHT_WALLET_SEED`      | secret `midnight-wallet-seed`     | dev genesis seed by default — replace before testnet/mainnet |

### `app`, `admin` (TanStack Start Nitro SSR via Node) and `verifier` (static SPA via nginx)

Frontends do **not** read env vars at process level. `docker/runtime-config.sh` runs at container start, reads `OWLID_*` env vars, and writes `/config.js` (or `<root>/config.js` for SSR) with `window.__OWLID_CONFIG__ = { ... }`. The SDK reads from there at runtime.

**Why?** One image, many envs. Rotate API keys without rebuilding the bundle.

| Service    | Runtime                         | Container port | Why                                                                         |
| ---------- | ------------------------------- | -------------- | --------------------------------------------------------------------------- |
| `app`      | Node LTS + TanStack Start Nitro | 3000           | TanStack Start renders index.html server-side; static-only deploy 404s root |
| `admin`    | Node LTS + TanStack Start Nitro | 3000           | same                                                                        |
| `verifier` | nginx (static)                  | 80             | pure Vite + React SPA, no SSR runtime needed                                |

`runtime-config.sh` writes to `${OWLID_CONFIG_PATH:-/usr/share/nginx/html/config.js}`. SSR images set `OWLID_CONFIG_PATH=/app/.output/public/config.js` so Nitro serves it as a static file alongside other public assets.

| Service    | Env var                  | Source                                        |
| ---------- | ------------------------ | --------------------------------------------- |
| `app`      | `OWLID_VERIFICATION_URL` | TF `local.run_url["verification"]`            |
| `app`      | `OWLID_ISSUER_URL`       | TF `local.run_url["issuer"]`                  |
| `admin`    | `OWLID_VERIFICATION_URL` | TF `local.run_url["verification"]`            |
| `admin`    | `OWLID_ISSUER_URL`       | TF `local.run_url["issuer"]`                  |
| `verifier` | `OWLID_VERIFICATION_URL` | TF `local.run_url["verification"]`            |
| `verifier` | `OWLID_API_KEY`          | secret `verifier-api-key` (`owlid_pk_*` only) |

The verifier app is the only frontend that needs an API key because it calls the verification service directly from the browser. That key must be publishable (`owlid_pk_*`) and limited to the verifier surface. Never wire an `owlid_sk_*` key into any frontend runtime config; `docker/runtime-config.sh` refuses to write one.

## `APP_ENV` — what it changes

Set in `terraform.tfvars` as `app_env = "development" | "production"`.

| Behaviour                  | `development`                    | `production`                                                 |
| -------------------------- | -------------------------------- | ------------------------------------------------------------ |
| CORS                       | permissive (allow any origin)    | strict — must match `CORS_ALLOWED_ORIGINS` exactly           |
| Admin cookie `Secure` flag | optional                         | enforced                                                     |
| Admin cookie `SameSite`    | `Lax`                            | `Strict`                                                     |
| Default secret values      | accepted (dev placeholders OK)   | rejected — service refuses to start with placeholder secrets |
| Required env               | `CORS_ALLOWED_ORIGINS` ignorable | `CORS_ALLOWED_ORIGINS` required                              |
| Logging level              | unchanged (`RUST_LOG` rules)     | unchanged                                                    |

Default in this dev sandbox: `development`. The `.run.app` URLs are on Mozilla's Public Suffix List, so HTTP cookies cannot span subdomains under `.run.app`. Until the custom domain is wired, leave `APP_ENV=development`.

## `ADMIN_COOKIE_DOMAIN` — apex for cross-subdomain cookies

Set in `terraform.tfvars` as `admin_cookie_domain = "owlid.app"` (no leading dot).

| Setup                                | Cookie domain     | Effect                                                                          |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------- |
| `admin_cookie_domain = ""` (default) | unset → host-only | Cookie valid only on the verification host                                      |
| `admin_cookie_domain = "owlid.app"`  | `owlid.app`       | Cookie valid on `*.owlid.app` (api/admin/app/verifier subdomains share session) |

**Public Suffix List trap:** `*.run.app` is on the PSL, so even if you set `admin_cookie_domain = "run.app"`, browsers reject it — cookies are forced host-only on `.run.app`. The variable only becomes useful once you have a real domain.

## Where to change a URL

### Switch a service URL (e.g. dev → custom domain)

1. Edit `deploy/gcp/terraform/locals.tf` → `local.run_url[service]`. Change to e.g. `"https://api.owlid.app"`.
2. Add the new origins to `extra_cors_origins` in `terraform.tfvars`.
3. Set `admin_cookie_domain = "owlid.app"` and `app_env = "production"` in `terraform.tfvars`.
4. `just gcp-apply` — TF rolls every consumer service.

Do not hand-update one service via gcloud — TF will revert on next apply.

### Add a new env var to a service

1. Plain value: edit the `dynamic "env"` block for that service in `terraform/run.tf`.
2. Secret value:
   - Add the resource in `terraform/secrets.tf`
   - Add an `env { name = "FOO"; value_source.secret_key_ref { ... } }` block in the service
3. `just gcp-apply`

### Change a secret value

See [SECRETS.md](SECRETS.md). Don't change them in TF — values are sticky via `lifecycle.ignore_changes`. Use `gcloud secrets versions add` then `gcloud run services update` to roll the consumers.

## Service-to-service authentication

| Edge                                      | Authn                                                           |
| ----------------------------------------- | --------------------------------------------------------------- |
| Browser → app/admin/verifier              | none (public SPAs)                                              |
| Browser → verification (admin)            | `Authorization: Bearer <jwt>` from admin login                  |
| Browser → verification (presentation API) | `X-API-Key: $API_KEY_DEV` (verifier app)                        |
| issuer → sidecar                          | `X-API-Key: $MIDNIGHT_SIDECAR_API_KEY`                          |
| verification → sidecar                    | `X-API-Key: $MIDNIGHT_SIDECAR_API_KEY`                          |
| Cloud Run → Postgres                      | Cloud SQL Auth Proxy unix socket via `--add-cloudsql-instances` |

All Cloud Run services have `roles/run.invoker` granted to `allUsers` for now (public). Tighten later by:

- Internal services (sidecar): grant `roles/run.invoker` only to runtime SA, set ingress to `INGRESS_TRAFFIC_INTERNAL_AND_CLOUD_LOAD_BALANCING`
- API services: keep public, rely on application-level API keys / JWTs

## Database connection

Cloud Run uses a **unix socket** to talk to Cloud SQL. The DSN looks like:

```
postgres://owl:PW@/dbname?host=/cloudsql/owlid-491411:europe-west1:owlid-pg
```

`/cloudsql/...` is the path the Cloud SQL Auth Proxy mounts inside the container (provisioned by `volumes.cloud_sql_instance` + `volume_mounts` in the Cloud Run service). No port, no IP, no direct internet exposure.

For migrations from your laptop, the proxy isn't available — `scripts/migrate.sh` allowlists your public IP, runs `sqlx migrate run` over the public IP with `sslmode=require`, then revokes the allowlist.

## dev → production transition checklist

When `owlid.app` registration is `ACTIVE` and you're ready to go production:

1. Uncomment `google_cloud_run_domain_mapping` + `google_dns_record_set` blocks in `terraform/dns.tf`.
2. Edit `terraform.tfvars`:
   ```hcl
   app_env             = "production"
   admin_cookie_domain = "owlid.app"
   extra_cors_origins  = [
     "https://wallet.owlid.app",
     "https://admin.owlid.app",
     "https://verifier.owlid.app",
   ]
   ```
3. Edit `terraform/locals.tf` `run_url` to use the user-facing URLs:
   ```hcl
   run_url = {
     verification = "https://api.owlid.app"
     issuer       = "https://issuer.owlid.app"
     sidecar      = "https://sidecar.owlid.app"
     app          = "https://wallet.owlid.app"
     admin        = "https://admin.owlid.app"
     verifier     = "https://verifier.owlid.app"
   }
   ```
4. Rotate seed secrets that ship with predictable defaults:
   - `admin-jwt-secret`, `encryption-key`, `issuer-private-key`, `api-key-dev`, `midnight-sidecar-api-key`, `db-password` (see [SECRETS.md](SECRETS.md) playbooks).
5. Change the default admin password (`admin` / `admin`) before exposing publicly:
   - login → admin UI → change password, OR
   - direct `UPDATE admin_users SET password_hash = '...' WHERE username = 'admin'`.
6. `just gcp-apply` — TF creates domain mappings, requests certs, rolls all services with new env values.
7. Wait 5–30 min for cert provisioning.
8. Smoke-test (see [RUNBOOK.md §4](RUNBOOK.md#4-verification-smoke-tests)).

## Optional integrations not yet wired

| Integration         | Env vars                                                                                               | How to wire                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Didit KYC           | `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_BASE_URL`, `DIDIT_WEBHOOK_SECRET`                         | Add 4 secrets in `terraform/secrets.tf::app_secrets`, wire env refs in `terraform/run.tf::issuer`. Default `DIDIT_BASE_URL` = `https://verification.didit.me`.                        |
| OIDC provider       | `OIDC_PROVIDERS` (CSV) + per-provider `<NAME>_*` quartet                                               | Add as plain env vars in `terraform/run.tf::issuer` (or as secrets if client secret needs hiding).                                                                                    |
| Real Midnight chain | `MIDNIGHT_NODE_WS_URL`, `MIDNIGHT_INDEXER_URI`, `MIDNIGHT_INDEXER_WS_URI`, `MIDNIGHT_PROOF_SERVER_URI` | Edit `terraform/run.tf::sidecar` env block, replace placeholders with real URLs. Verification + issuer fail-fast if the sidecar is unreachable, so make sure the sidecar rolls first. |
