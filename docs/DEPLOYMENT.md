# OwlID Deployment Guide

This guide covers running the full OwlID stack — Rust backend services, Midnight
sidecar, devnet blockchain, frontends — locally and in production.

For a step-by-step walkthrough of an end-to-end developer setup, see
[`E2E-SETUP.md`](./E2E-SETUP.md). For day-to-day ops (revoking creds, rotating
keys, troubleshooting), see [`RUNBOOK.md`](./RUNBOOK.md).

---

## Stack Overview

| Service              | Port | Container                   | Purpose                                 |
| -------------------- | ---- | --------------------------- | --------------------------------------- |
| App (Vite/React)     | 5000 | owlid-app                   | End-user frontend                       |
| Verifier app         | 5001 | owlid-verifier              | Verifier-side frontend                  |
| Admin dashboard      | 4000 | owlid-admin                 | Operator UI                             |
| Verification service | 8000 | owlid-verification          | Token verification, revocation, GDPR    |
| Issuer service       | 8001 | owlid-issuer                | Credential issuance + KYC orchestration |
| Midnight sidecar     | 3000 | owlid-midnight-sidecar      | Bun bridge to Midnight chain (Hono API) |
| Postgres (verify)    | 5432 | owlid-postgres-verification | Verification DB                         |
| Postgres (issuer)    | 5433 | owlid-postgres-issuer       | Issuer DB                               |
| Midnight node        | 9944 | owlid-midnight-node         | Substrate devnet (`CFG_PRESET=dev`)     |
| Midnight indexer     | 8088 | owlid-midnight-indexer      | GraphQL chain indexer                   |
| Proof server         | 6300 | owlid-proof-server          | ZK SNARK proving (sidecar + opt-in)     |
| Proof server proxy   | 6301 | owlid-proof-server-proxy    | Browser CORS front (opt-in profile)     |
| Prometheus           | 9090 | owlid-prometheus            | Metrics scraper                         |
| Grafana              | 3001 | owlid-grafana               | Dashboards                              |

Midnight image versions track
[`midnightntwrk/midnight-local-dev`](https://github.com/midnightntwrk/midnight-local-dev/blob/main/standalone.yml):
`midnight-node:0.22.3`, `indexer-standalone:4.0.1`, `proof-server:8.0.3`.

---

## Prerequisites

- Rust 1.75+
- Bun
- Docker + Docker Compose
- `just`
- `compact` toolchain (set default to upstream `0.31.0` via `compact update 0.31.0`)
- ~8 GB free disk for Docker images + ZK SRS

Install once:

```bash
just setup
```

---

## Local Development

Three compose files cover the local topology:

- `docker-compose.yml` — Postgres + (optionally) verification + issuer for ad-hoc dev.
- `docker-compose.midnight.yml` — devnet only (node + indexer + proof server).
- `docker-compose.prod.yml` — full stack incl. monitoring + Cloudflare Tunnel.

### Backend + Frontend (no chain)

```bash
just dev
```

### Full E2E with local Midnight

```bash
just dev-e2e
```

Boots:

- `docker-compose.midnight.yml` (node, indexer, proof server)
- `docker-compose.yml` Postgres containers
- Sidecar (`bun run dev` in `packages/midnight-sidecar`)
- Verification + Issuer Rust services (`cargo run -p ...`)
- App (`bun run --filter @owlid/app dev`)

Health check after ~30s:

```bash
just midnight-status
curl http://localhost:3000/health   # sidecar
curl http://localhost:8000/health   # verification
curl http://localhost:8001/health   # issuer
```

### Devnet only

```bash
just midnight-up        # start node + indexer + proof server
just midnight-status    # verify
just midnight-down      # stop
just midnight-reset     # stop + wipe chain volume
```

### Compile contracts

```bash
just compact            # full ZK key gen (slow)
just compact-fast       # skip ZK keys (fast iteration)
just compact-clean      # rm managed/
```

### Deploy contracts to running devnet

```bash
just deploy-contracts
```

Writes addresses into `.env` — the three registries
(`MIDNIGHT_ISSUER_REGISTRY_ADDRESS`, `MIDNIGHT_REVOCATION_REGISTRY_ADDRESS`,
`MIDNIGHT_IDENTITY_REGISTRY_ADDRESS`) plus one per predicate kind
(`MIDNIGHT_PREDICATE_{AGE,KYC,RESIDENCY,EMAIL,NATIONALITY,AGE_RANGE,PERSONHOOD}_ADDRESS`)
and `MIDNIGHT_OWNER_SECRET_KEY`.

Deploys ten Compact contracts, all via `MIDNIGHT_PROOF_SERVER_URI`
(the docker proof server). Holder predicate proving defaults to in-process
(zkir-v2 WASM) and needs no proof server; holders can opt into a hosted
proof server from the app's `/settings` page (see "Holder Proving Backend"
below). Midnight is a hard runtime requirement — both verification-service
and issuer-service exit 1 on startup if the sidecar is unreachable. See the
Midnight section of [`ARCHITECTURE.md`](./ARCHITECTURE.md) and
[`MIDNIGHT.md`](./MIDNIGHT.md).

### Holder Proving Backend (WASM vs hosted proof server)

The holder app picks one of two providers at runtime:

- **WASM (default)** — `@midnight-ntwrk/zkir-v2` runs the prover inside the
  browser tab. The private witness never crosses the device boundary. Slower
  on low-end devices because the proving keys load into WASM memory once
  per session.
- **Hosted proof server** — the SDK forwards the unproven preimage to a
  remote `midnightntwrk/proof-server` instance via
  `@midnight-ntwrk/midnight-js-http-client-proof-provider`. The witness is
  already consumed by `createUnprovenCallTx` before this point, so only the
  preimage and the resulting proof cross the network.

Holders toggle this from `/settings` → Proving. The operator sets
`OWLID_PROOF_SERVER_URL` (Cloud Run) / `VITE_PROOF_SERVER_URL` (Vite build)
to suggest a default endpoint; the input box is pre-populated with it.

For browser CORS the production proof server runs behind a tiny Caddy
proxy (`Dockerfile.proof-server` + `docker/proof-server/Caddyfile`) that
echoes `Access-Control-Allow-Origin` only for `*.owlid.app`, `*.sashoush.dev`,
and `localhost`. Local dev can bring it up with:

```bash
docker compose -f docker-compose.midnight.yml --profile proof-proxy up
# Proxy: http://localhost:6301  →  proof-server:6300
```

---

## Production Stack

Single compose file with everything (DBs, backends, frontends, monitoring,
Cloudflare Tunnel):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up --build -d
```

Required env vars in `.env.prod` (see `.env.prod` template in repo root):

| Variable                                                       | Notes                                         |
| -------------------------------------------------------------- | --------------------------------------------- |
| `DB_PASSWORD`                                                  | Postgres password (change from default)       |
| `MIDNIGHT_SIDECAR_API_KEY`                                     | Shared secret between sidecar + Rust services |
| `ADMIN_JWT_SECRET`                                             | Admin auth signing key                        |
| `MIDNIGHT_WALLET_SEED`                                         | 32-byte hex; devnet genesis is `0...01`       |
| `MIDNIGHT_ISSUER_REGISTRY_ADDRESS`                             | Set after `just deploy-contracts`             |
| `MIDNIGHT_REVOCATION_REGISTRY_ADDRESS`                         | Set after `just deploy-contracts`             |
| `MIDNIGHT_IDENTITY_REGISTRY_ADDRESS`                           | Set after `just deploy-contracts`             |
| `MIDNIGHT_OWNER_SECRET_KEY`                                    | Identity registry owner witness               |
| `VITE_ISSUER_URL` / `VITE_VERIFICATION_URL` / `APP_URL`        | Public-facing URLs baked at build time        |
| `DIDIT_API_KEY` / `DIDIT_WORKFLOW_ID` / `DIDIT_WEBHOOK_SECRET` | Optional KYC provider                         |
| `GRAFANA_PASSWORD`                                             | Grafana admin password                        |

Rebuild a single service:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up --build -d verification-service
```

### Cloudflare Tunnel

`docker-compose.prod.yml` mounts `~/.cloudflared` into the `cloudflared`
container and runs `tunnel run owlid` against
`/etc/cloudflared/config-docker.yml`. Provide your tunnel credentials and
config under `~/.cloudflared/`. Removing the `cloudflared` service is harmless
if you front the stack with another reverse proxy.

### Bringing the stack down

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod down
```

Add `-v` to wipe Postgres + proof server SRS + Grafana volumes (irreversible).

---

## Environment Variables

### Verification service

| Variable                      | Default                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `VERIFICATION_DATABASE_URL`   | `postgres://owl:owl_dev@postgres-verification:5432/verification` |
| `SERVER_HOST` / `SERVER_PORT` | `0.0.0.0` / `8000`                                               |
| `MIDNIGHT_SIDECAR_URL`        | `http://midnight-sidecar:3000` (required)                        |
| `MIDNIGHT_SIDECAR_API_KEY`    | shared with sidecar                                              |
| `ADMIN_JWT_SECRET`            | random per environment                                           |
| `RATE_LIMIT_*`                | rate limit config                                                |

### Issuer service

| Variable                      | Default                                              |
| ----------------------------- | ---------------------------------------------------- |
| `ISSUER_DATABASE_URL`         | `postgres://owl:owl_dev@postgres-issuer:5432/issuer` |
| `ISSUER_HOST` / `ISSUER_PORT` | `0.0.0.0` / `8001`                                   |
| `APP_URL`                     | public app URL for callbacks                         |
| `DIDIT_*`                     | optional KYC provider config                         |

### Sidecar

| Variable                      | Default                                                |
| ----------------------------- | ------------------------------------------------------ |
| `MIDNIGHT_SIDECAR_PORT`       | `3000`                                                 |
| `MIDNIGHT_SIDECAR_API_KEY`    | required                                               |
| `MIDNIGHT_NODE_WS_URL`        | `ws://midnight-node:9944`                              |
| `MIDNIGHT_INDEXER_URI`        | `http://midnight-indexer:8088/api/v3/graphql`          |
| `MIDNIGHT_INDEXER_WS_URI`     | `ws://midnight-indexer:8088/api/v3/graphql/ws`         |
| `MIDNIGHT_PROOF_SERVER_URI`   | `http://proof-server:6300`                             |
| `MIDNIGHT_NETWORK_ID`         | `undeployed` (local) / `preprod` (testnet) / `mainnet` |
| `MIDNIGHT_WALLET_SEED`        | 32-byte hex HD seed                                    |
| `MIDNIGHT_*_REGISTRY_ADDRESS` | populated by `just deploy-contracts`                   |
| `MIDNIGHT_OWNER_SECRET_KEY`   | identity registry owner witness                        |

---

## Monitoring

### Prometheus endpoint

Exposed by both Rust services:

```bash
# Requires an API key with the `admin` permission — the endpoint exposes a
# per-route operational profile, so it is not public.
curl -H "Authorization: Bearer $OWLID_ADMIN_KEY" http://localhost:8000/prometheus
curl http://localhost:8001/prometheus
```

### Which monitoring stack applies

Two exist. They are not alternatives to choose between at runtime — each
belongs to a different deployment target:

| Deployment                         | Stack                               | Status                       |
| ---------------------------------- | ----------------------------------- | ---------------------------- |
| **GCP Cloud Run** (`*.owlid.app`)  | **Cloud Monitoring** — the live one | production                   |
| docker-compose (self-host / local) | Prometheus + Grafana                | optional, no live deployment |

**GCP runs neither Prometheus nor Grafana.** Do not look for them there.

### Cloud Monitoring (production)

Defined as code in `deploy/gcp/terraform/monitoring.tf`. Apply with `-target`
on the `google_monitoring_*` / `google_logging_metric` resources — never a bare
`terraform apply` (see RUNBOOK §0 #7).

| Surface            | Where                                                        |
| ------------------ | ------------------------------------------------------------ |
| Dashboard          | Console → Monitoring → Dashboards → **"OwlID — production"** |
| Alert policies (7) | Console → Monitoring → Alerting                              |
| Uptime checks (3)  | Console → Monitoring → Uptime checks                         |
| Logs               | Console → Logging → Logs Explorer                            |

Dashboard panels, ordered by the question asked during an incident:

1. **Is it up?** — `/health` uptime per service; 5xx by service
2. **What is the load?** — request rate; p95 latency
3. **Is the chain healthy?** — chain-connect failures, issuer registration
   failures, container start failures (each backed by the alert policy of the
   same name, so dashboard and pager agree on what "broken" means)
4. **Data layer** — container instances; Cloud SQL CPU

Uptime checks poll `api` / `issuer` / `sidecar` `/health` every 60 s and depend
on each service returning **non-2xx when it is not usable**. A health endpoint
that answers 200 while degraded silently defeats every policy — that is exactly
how a four-day outage went unnoticed.

Alerts go to the addresses in `alert_emails` (`terraform.tfvars`).

Logs reach Cloud Logging automatically (`_Default` bucket, 30-day retention;
`_Required` 400). The sidecar emits structured JSON (`jsonPayload.event`); the
Rust services emit text, so the log-based metrics match on substrings and will
break if a log line is reworded.

### Prometheus + Grafana (self-hosted only)

Configs under `monitoring/`, wired into `docker-compose.prod.yml`. Kept for
anyone self-hosting the stack; **no live deployment uses it**. It is not part
of the GCP deploy path and does not need to be running.

(The Temps deploy target this once served — `deploy/owlid/`,
`deploy/owlid-infra/`, `prometheus-temps.yml` — has been removed. GCP is the
only deployment.)

`/prometheus` requires an API key with the `admin` permission — it exposes a
per-route operational profile. Scrape configs authenticate with
`authorization: { type: Bearer, credentials_file: ... }`.

### Health endpoints

| Service       | URL                           | Auth |
| ------------- | ----------------------------- | ---- |
| Sidecar       | `:3000/health`                | none |
| Verification  | `:8000/health`                | none |
| Issuer        | `:8001/health`                | none |
| Midnight node | `:9944/health`                | none |
| Indexer       | `:8088/api/v3/graphql` (POST) | none |
| Proof server  | `:6300/version`               | none |
| Proof proxy   | `:6301/version` (via Caddy)   | none |

---

## Performance Targets

Single-instance, dev hardware:

| Operation              | Target latency |
| ---------------------- | -------------- |
| Token verification     | < 20 ms        |
| Local proof generation | < 50 ms        |
| Throughput (verify)    | 1000+ req/s    |

Production: scale verification + issuer horizontally behind a load balancer.
Sidecar is single-instance (holds wallet state + private state DB); shard by
network if needed.

---

## Security Checklist

1. TLS terminated at the tunnel/proxy layer; never expose Rust services raw.
2. Rotate `MIDNIGHT_SIDECAR_API_KEY`, `ADMIN_JWT_SECRET`, `DB_PASSWORD` per env.
3. Treat `MIDNIGHT_WALLET_SEED` and `MIDNIGHT_OWNER_SECRET_KEY` as secrets
   (use a secrets manager — no plaintext in `.env.prod` for prod).
4. Restrict access to admin endpoints (`/admin/*`) via API keys with `admin`
   permission only.
5. Verify Cloudflare access policies if exposing the admin dashboard publicly.
6. Apply `delete_expired_records()` and `cleanup_rate_limits()` on a schedule
   (pg_cron or external job) — see `RUNBOOK.md`.

---

## Troubleshooting

See [`RUNBOOK.md`](./RUNBOOK.md#10-troubleshooting). Common pitfalls:

- **Sidecar shows `connected: false`** — wait ~1 minute for wallet sync, then
  recheck `/health`. If still false, verify node + indexer + proof server are
  all healthy.
- **Indexer crashes on start** — `APP__INFRA__SECRET` must be a 64-char hex
  string. The default in `midnight.env.example` is correct for dev.
- **Compact compile fails with language version mismatch** — ensure
  `compact list` shows `→ 0.31.0` as default. Set with `compact update 0.31.0`.
- **Bun `Cannot find package 'effect'`** — `bunfig.toml` must contain
  `[install] linker = "hoisted"`. Reinstall with `rm -rf node_modules bun.lock && bun install`.
