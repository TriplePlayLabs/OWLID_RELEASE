# OwlID services

Quick reference for local development. Production / deployment details live in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Local development URLs

| Service                   | URL                               | Notes                            |
| ------------------------- | --------------------------------- | -------------------------------- |
| Identity App              | http://localhost:5000             | Holder-side wallet UI            |
| Verifier App              | http://localhost:5001             | Verifier demo                    |
| Admin Dashboard           | http://localhost:4000             | Operator console                 |
| Verification API          | http://localhost:8000             | Customer-facing verify API       |
| Issuer API                | http://localhost:8001             | Credential issuance API          |
| Midnight Sidecar          | http://localhost:3000             | Bridge for chain reads/writes    |
| Swagger UI (Verification) | http://localhost:8000/swagger-ui/ | Generated from utoipa            |
| Swagger UI (Issuer)       | http://localhost:8001/swagger-ui/ | Generated from utoipa            |
| Grafana                   | http://localhost:3001             | Metrics dashboards               |
| Prometheus                | http://localhost:9090             | Metrics scrape                   |
| Midnight Node             | http://localhost:9944             | Devnet RPC (only with `dev-e2e`) |
| Midnight Indexer          | http://localhost:8088             | GraphQL indexer                  |
| Proof Server              | http://localhost:6301             | ZK proof server                  |
| Postgres (verification)   | localhost:5432                    | DB `verification`                |
| Postgres (issuer)         | localhost:5433                    | DB `issuer`                      |

## Default development credentials

Loaded from [`.env.example`](.env.example) when you run `cp .env.example .env`. **Never reuse these in any environment that accepts real traffic.**

- Admin dashboard login: `admin` / `admin`
- Dev API key: `owlid_sk_test_dev0000000000000000000000000000000000000000`
- Postgres: `owl` / `owl_dev`

For production credential generation see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#production-secrets).

## Public deployments

The repository has no canonical public deployment. If you fronted a deployment with Cloudflare Tunnel, document the hostnames in your fork's deployment runbook — do not commit personal hostnames to this file.
