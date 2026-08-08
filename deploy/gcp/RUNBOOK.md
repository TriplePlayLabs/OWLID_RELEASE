# Deploy runbook — OwlID GCP

Step-by-step playbooks for every common deploy scenario. Keep this open during any production change.

Use this with:

- [README.md](README.md) — project overview, layout, prerequisites
- [SECRETS.md](SECRETS.md) — secret storage + rotation
- [ENV-WIRING.md](ENV-WIRING.md) — env-var sources + service dependencies

---

## Table of contents

0. [Deploy-safety gotchas (READ FIRST)](#0-deploy-safety-gotchas-read-first)
1. [First-time setup](#1-first-time-setup)
2. [Daily change → deploy loop](#2-daily-change--deploy-loop)
3. [Scenarios](#3-scenarios)
   - [3.0 Contract redeploy → preview testnet](#30-contract-redeploy--preview-testnet)
   - [3.0a Upgrade a contract WITHOUT changing its address](#30a-upgrade-a-contract-without-changing-its-address)
   - [3.0b Recover from a Midnight testnet reset](#30b-recover-from-a-midnight-testnet-reset)
   - [3.1 Rust service code change (verification / issuer)](#31-rust-service-code-change-verification--issuer)
   - [3.2 Frontend code change (app / admin / verifier)](#32-frontend-code-change-app--admin--verifier)
   - [3.3 Sidecar code change (midnight-sidecar)](#33-sidecar-code-change-midnight-sidecar)
   - [3.4 DB schema change (new migration)](#34-db-schema-change-new-migration)
   - [3.5 Add a new env var to a service](#35-add-a-new-env-var-to-a-service)
   - [3.6 Add a new secret](#36-add-a-new-secret)
   - [3.7 Add a new Cloud Run service](#37-add-a-new-cloud-run-service)
   - [3.8 Wire the custom domain](#38-wire-the-custom-domain)
4. [Verification (smoke tests)](#4-verification-smoke-tests)
5. [Rollback](#5-rollback)
6. [Common errors + fixes](#6-common-errors--fixes)
7. [Cost + scaling knobs](#7-cost--scaling-knobs)

---

## 0. Deploy-safety gotchas (READ FIRST)

The happy-path recipes below omit the failure modes that have actually broken
prod. Internalize these before any `gcp-build` / `gcp-apply`.

1. **Tag images with the git sha — `latest` is a silent no-op.** `build-all.sh`
   reads `IMAGE_TAG` from `deploy/gcp/.env.gcp` (default `latest`); `run.tf` pins
   `…/<svc>:<image_tag>`. Rebuilding `:latest` + `terraform apply` yields an
   identical spec → **no new revision rolls**. Every release: set
   `IMAGE_TAG=$(git rev-parse --short HEAD)` in `.env.gcp`, build, then
   `terraform apply -var=image_tag=<sha>`. A CLI `IMAGE_TAG=x just gcp-build` is
   clobbered (`_lib.sh` re-sources `.env.gcp`) — set it in the file.

2. **`gcp-build` is async — wait before `gcp-apply`.** `build-all.sh` submits all
   8 builds with `--async` then returns; they run ~10–15 min on Cloud Build (the
   Rust backends are the slow pole). Applying before they finish makes Cloud Run
   fail to pull the image. Gate the apply:

   ```sh
   gcloud builds list --project=owlid-491411 --region=europe-west1 \
     --filter='substitutions._IMAGE_TAG=<sha> AND (status=WORKING OR status=QUEUED)' \
     --format='value(id)'
   # wait until empty; then confirm none are FAILURE:
   gcloud builds list --project=owlid-491411 --region=europe-west1 \
     --filter='substitutions._IMAGE_TAG=<sha> AND NOT status=SUCCESS' --format='value(id,status)'
   ```

3. **Roll the sidecar FIRST, then the issuer.** Cloud Run storage is ephemeral, so
   a fresh sidecar revision re-syncs the Midnight preview wallet from scratch
   (`/health` `connected:false` until done). **Budget 15–20 min, not minutes** —
   a cold preview sync is slow and the preview RPC drops the subscription
   (`disconnected … 1000 Normal Closure`) and recovers repeatedly; this is
   normal, not a failure. Still roll the issuer only after `connected:true`: it
   registers on-chain via verification→sidecar at startup, and until that
   succeeds it serves `/health` as **503** with `issuerRegisteredOnChain:false`
   and any credential it issues will not verify. (It no longer `exit(1)`s on
   failure — it retries in the background so the chain-independent routes,
   notably `/.well-known/did.json`, keep serving.) Apply the sidecar alone, wait
   for `connected:true`, then apply the rest:

   ```sh
   cd deploy/gcp/terraform
   terraform apply -var=image_tag=<sha> -target='google_cloud_run_v2_service.sidecar' -auto-approve
   until curl -s https://sidecar-<hash>-ew.a.run.app/health | grep -q '"connected":true'; do sleep 10; done
   terraform apply -var=image_tag=<sha> \
     -target='google_cloud_run_v2_service.verification' \
     -target='google_cloud_run_v2_service.issuer' \
     -target='google_cloud_run_v2_service.proof_server' \
     -target='google_cloud_run_v2_service.frontend["app"]' \
     -target='google_cloud_run_v2_service.frontend["admin"]' \
     -target='google_cloud_run_v2_service.frontend["verifier"]' \
     -target='google_cloud_run_v2_service.frontend["docs"]' -auto-approve
   ```

   Old revisions keep serving until the new ones are Ready — no outage.

4. **Canary the holder app SSR — a broken SSR bundle is marked Ready but 500s
   every request.** `@owlid/app` is TanStack Start SSR; the runtime image ships
   only `.output` (no `node_modules`). `@midnight-ntwrk/zkir-v2` is browser-only
   WASM. If any SSR-reachable module statically imports `OwlWallet`/midnight (it
   transitively pulls `prover.ts → zkir-v2`), Nitro externalises zkir into the
   server bundle and prod 500s with `ERR_MODULE_NOT_FOUND` — yet Cloud Run marks
   the revision Ready (the port listens). Prod-only; dev e2e never catches it.
   Always verify after rolling the app:

   ```sh
   curl -s -o /dev/null -w '%{http_code}' https://app-<hash>-ew.a.run.app/   # must be 200
   ```

   For a risky app change, deploy `--no-traffic --tag=canary`, curl the tagged
   URL, then shift traffic. Keep `OwlWallet`/midnight out of statically-SSR'd
   trees; lazy-`await import('@midnight-ntwrk/zkir-v2')` in `prover.ts`.

5. **Verify the SSR CSS hash — FOUC only reproduces in Docker/CloudBuild.**
   TanStack Start runs separate client + SSR Vite passes; a `@import 'tailwindcss'`
   shorthand makes the SSR pass hash `styles.css` BEFORE Tailwind processes it →
   the server HTML links a `/assets/styles-<hash>.css` the client never emits →
   404 → unstyled flash until hydration. Fixed by `@import 'tailwindcss' source('./')`
   in each SSR app's `src/styles.css`. To verify a CSS-touching deploy: curl the
   app, extract the `styles-*.css` href, curl it — must be 200 (a stale hash 404s).

6. **`terraform apply` wants to replace the `proofs` domain mapping — `-target`
   around it.** Pre-existing drift:
   `google_cloud_run_domain_mapping.subdomain["proofs"]` wants a `cert_mode`
   replacement. For code deploys, `-target` only the 8
   `google_cloud_run_v2_service` resources (as in #3) so the apply never touches it.

7. **A bare `terraform apply` reverts running images to `:latest` and drops
   `min_instance_count`.** State carries `image_tag = latest` and no explicit
   scaling, while the live services run digest/sha-pinned images deployed via
   `gcloud run deploy`. `terraform plan` therefore shows all 8 services "will be
   updated in-place" and an unguarded apply rolls them **backwards**. Always pass
   `-var=image_tag=<sha>` and `-target` the specific resources (#3). Verify with
   `terraform plan | grep 'will be updated'` before applying anything.

8. **Monitoring lives in `monitoring.tf` and is applied separately.** Uptime
   checks + alert policies are additive; apply them with `-target` on the
   `google_monitoring_*` / `google_logging_metric` resources so the run cannot
   pick up the drift in #7. Alerts depend on each service returning **non-2xx**
   from `/health` when unusable — a health endpoint that answers 200 while
   degraded silently defeats every policy.

---

## 1. First-time setup

Once per machine + once per project.

```sh
# Prereqs (one-time, host)
gcloud auth login                           # browser flow
gcloud auth application-default login       # ADC for Terraform
gcloud config set project owlid-491411
cargo install sqlx-cli                      # for DB migrations
# terraform >= 1.6 must already be on PATH
```

```sh
# Project config (one-time, repo)
cp deploy/gcp/.env.gcp.example deploy/gcp/.env.gcp
cp deploy/gcp/terraform/terraform.tfvars.example deploy/gcp/terraform/terraform.tfvars
# Edit both if anything differs from defaults.
```

```sh
# Provision (one-time, project)
just gcp-bootstrap        # creates GCS state bucket + terraform init
```

If the project already has resources from earlier manual `gcloud` work:

```sh
just gcp-pre-tf-cleanup   # destructive: deletes manual SQL/secrets/SA/budget
```

Then proceed.

```sh
# First deploy with placeholder hello-world image (real images don't exist yet)
just gcp-apply-placeholder

# Apply DB migrations — allowlists your IP, runs sqlx, revokes
just gcp-migrate

# Build all 6 service images via Cloud Build (parallel, ~15 min cold)
just gcp-build

# Re-apply with real images
just gcp-apply

# See URLs
just gcp-urls
```

---

## 2. Daily change → deploy loop

The 80% case after first-time setup. **Read [§0](#0-deploy-safety-gotchas-read-first)
first** — the four steps below are the shape, but `gcp-build` is async (wait for
the builds), `latest` is a no-op (tag with the git sha), and a full `gcp-apply`
rolls the issuer into the sidecar wallet-resync (roll staged instead).

```sh
# 1. Make code changes locally. Run tests.
cargo test --workspace
bun run --filter '*' test

# 2. Tag with the git sha, build, WAIT for Cloud Build to finish (§0 #1, #2).
sed -i -E 's/^IMAGE_TAG=.*/IMAGE_TAG='"$(git rev-parse --short HEAD)"'/' deploy/gcp/.env.gcp
just gcp-build
# ...then poll `gcloud builds list` until all are SUCCESS (§0 #2).

# 3. Apply — staged, sidecar first (§0 #3). NOT a bare `just gcp-apply`.

# 4. Verify (§4) — incl. app SSR 200 + css 200 (§0 #4, #5).
just gcp-urls
```

The Terraform variable `image_tag` is read from `terraform.tfvars` or `-var`.
Set it once per release; Cloud Run updates with rolling traffic.

---

## 3. Scenarios

### 3.0 Contract redeploy → preview testnet

When the Compact contracts change (new circuit, new predicate, a security fix
that touches a circuit), redeploy all 10 to the Midnight **preview** testnet and
rewire the new addresses. The addresses change on every redeploy.

```sh
# 1. Deploy contracts to preview. NEEDS the preview wallet funded with NIGHT
#    (see 3.0b for funding). The deploy aborts early and prints the faucet URL
#    if the wallet is empty, rather than failing 10 times in a row.
cp .env.local /tmp/env.local.bak                 # see the symlink gotcha below
set -a; source .env.preview; set +a

# ONE admin key for the whole contract lifecycle: contract owner AND contract
# maintenance authority. MUST be set — without it each contract gets a random
# authority stored only in the local private-state LevelDB, and losing that
# directory makes the contracts permanently un-upgradable (see 3.0a).
export MIDNIGHT_OWNER_SECRET_KEY=$(gcloud secrets versions access latest \
  --secret=midnight-owner-secret-key --project=owlid-491411)

cd packages/midnight-sidecar && bun run deploy    # ~15–30 min (remote sync + 10 deploys)
cd ../..
```

**The deploy is idempotent by default.** Any contract whose configured address is
still live on chain is kept, not redeployed — so a re-run after a partial failure
only deploys what is actually missing, and the rest keep their addresses (and
their predicate attestation history).

| Env var                       | Default | Effect                                                                          |
| ----------------------------- | ------- | ------------------------------------------------------------------------------- |
| `REDEPLOY_ALL=true`           | off     | Force a fresh address for every contract. Needed after a Compact source change. |
| `CONTRACTS=predicate_age,...` | all     | Deploy only these rows from `DEPLOY_TABLE`.                                     |
| `DEPLOY_DUST_LANES`           | `8`     | Split NIGHT into K UTXOs → K parallel dust lanes.                               |
| `DEPLOY_MIN_DUST`             | `3e15`  | Wait for this much dust before submitting anything.                             |

A partial deploy is reported loudly and exits non-zero, naming every tfvars key
that still holds its PREVIOUS address. **Do not ship a partial deploy** — those
stale addresses may point at contracts that no longer exist, which the sidecar
surfaces as a chain-connect failure rather than anything mentioning "incomplete
deploy". Re-run until every contract succeeds.

`deploy.ts` writes the 10 new addresses to **two** places automatically:

- `deploy/gcp/terraform/terraform.tfvars` (the GCP source of truth —
  `var.midnight_*_address`, consumed by `run.tf`), and
- repo-root `.env` — which is a **symlink to `.env.local`** (your _local devnet_
  config). So the preview deploy overwrites your local devnet addresses + owner
  key. Back up `.env.local` first (above) and restore it after.

```sh
# 2. Nothing to push — step 1 supplied MIDNIGHT_OWNER_SECRET_KEY from Secret
#    Manager, so the deployed contracts already carry that key as owner AND
#    maintenance authority. The sidecar reads the same secret
#    (`midnight-owner-secret-key`, version=latest), managed OUT OF BAND — it is
#    NOT a terraform var.
#
#    ONLY if you deployed without the env var set (the deploy prints the
#    generated key once, and it exists nowhere else) push it immediately:
# printf %s <printed-key> \
#   | gcloud secrets versions add midnight-owner-secret-key --project=owlid-491411 --data-file=-

# 3. Restore local devnet config.
cp /tmp/env.local.bak .env.local
```

Then roll the services using the **§0 #3 staged roll** (sidecar first). On the
issuer roll, the issuer-service re-registers the trusted issuers on the **new**
`issuer_registry` at startup (same public keys → trust restored). Existing
pre-`owl_root` credentials still verify for basic presentation but cannot satisfy
predicate requests until re-issued (`owl_root` is signed in by new issuances only).

### 3.0a Upgrade a contract WITHOUT changing its address

A redeploy always mints a new address — `deployContract` derives it from the
deploy transaction. To change a circuit while keeping the address (and every
predicate attestation already recorded against it), use a **maintenance
transaction** instead.

Maintenance is authorised by the contract's **maintenance authority** signing
key, fixed at deploy time from `MIDNIGHT_OWNER_SECRET_KEY` — the same single
admin key that is also the contract owner:

```ts
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'

const deployed = await findDeployedContract(providers, { contractAddress, compiledContract })

// Swap one circuit's verifier key in place — the contract address is unchanged.
await deployed.circuitMaintenanceTx.attestAgeGte.insertVerifierKey(newVk)
await deployed.circuitMaintenanceTx.attestAgeGte.removeVerifierKey()

// Rotate the authority itself (e.g. to move it to a new secret).
await deployed.contractMaintenanceTx.replaceAuthority(newSigningKey)
```

**What maintenance can and cannot do.** It replaces _verifier keys_ and the
_authority_. It does not migrate ledger state. So:

- circuit logic changed, ledger layout identical → `insertVerifierKey`, address kept
- ledger layout changed (new/renamed/retyped ledger field) → full redeploy (§3.0)

**Losing the admin key is unrecoverable.** `midnight-owner-secret-key` in Secret
Manager is the only durable copy. Without it a contract can never be upgraded in
place again — only redeployed at a new address, which is a user-visible outage.
Never deploy with `MIDNIGHT_OWNER_SECRET_KEY` unset: the deploy will mint a
random key, print it once, and store the authority only in local LevelDB.

The same key is the contract owner, so rotating it means both re-pushing the
secret **and** running `replaceAuthority` on all 10 contracts.

### 3.0b Recover from a Midnight testnet reset

Public testnets get reset. A reset **wipes every deployed contract and zeroes the
wallet balance**, so all 10 addresses in `terraform.tfvars` become dangling and
the sidecar can no longer reach any contract. This has happened: preview was
relaunched on the 1.0.x network and prod was down for four days.

**Symptoms.** `sidecar/health` reports `connected: false`; every contract route
500s in ~0 ms; the issuer crash-loops because its startup registration fails;
`issuer.owlid.app` 500s on everything including `/.well-known/did.json`.

**Confirm it is a reset** — a `null` result means the contract is gone:

```sh
ADDR=$(grep '^midnight_issuer_registry_address' deploy/gcp/terraform/terraform.tfvars | cut -d'"' -f2)
curl -s -X POST https://indexer.preview.midnight.network/api/v4/graphql \
  -H 'content-type: application/json' \
  -d "{\"query\":\"query{contractAction(address:\\\"$ADDR\\\"){__typename}}\"}"

# And check what network the chain is actually on now:
curl -s -X POST https://rpc.preview.midnight.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}'
```

**Recovery.**

```sh
# 1. Re-fund the wallet. Its address is logged at deploy start, or:
cd packages/midnight-sidecar && bun run src/diag-wallet.ts     # prints unshieldedAddr
#    Faucet: https://faucet.preview.midnight.network  (browser, no API)

# 2. Redeploy all 10 (§3.0). The preflight splits NIGHT into dust lanes and
#    waits for a usable dust balance before submitting.
REDEPLOY_ALL=true bun run deploy

# 3. Push the new owner key (§3.0 step 2), then roll services (§0 #3).
```

If the chain's node version has moved a major release, also bump the Midnight
SDK pins (`@midnight-ntwrk/midnight-js-*`, `ledger-v8`, `compact-js`) and
recompile contracts with a matching `compact` toolchain before redeploying —
compare against `midnightntwrk/midnight-local-dev`'s `package.json` +
`standalone.yml`, which track the current network.

**Alerting.** `OwlID: Midnight chain client cannot connect` fires on this within
~5 min (see `deploy/gcp/terraform/monitoring.tf`). If it did not fire, the alert
policy or the notification channel is broken — fix that first.

### 3.1 Rust service code change (verification / issuer)

```sh
# 1. Edit files under crates/verification-service/ or crates/issuer-service/
cargo check -p owl-verification-service     # fast feedback
cargo test  -p owl-verification-service

# 2. Build only that image (skip the others)
gcloud builds submit \
  --project=owlid-491411 --region=europe-west1 \
  --config=deploy/gcp/cloudbuild/verification.yaml \
  --substitutions=_IMAGE_TAG=latest,_REGION=europe-west1,_REPO=owlid

# 3. Roll Cloud Run. For an isolated single-service change, nudge just that one:
gcloud run services update verification --region=europe-west1 --project=owlid-491411
# For a full multi-service deploy, use the §0 #3 staged roll (sidecar first) —
# a bare `just gcp-apply` rolls the issuer into the sidecar wallet-resync.
```

The Rust cold build takes ~8–12 min on `E2_HIGHCPU_8`. Cloud Build does not cache layers across submits unless you wire kaniko + remote cache. For now, accept the cold-build cost or batch changes.

### 3.2 Frontend code change (app / admin / verifier)

```sh
# 1. Edit files under packages/<name>/
bun run --filter @owlid/<name> check    # tsc

# 2. Build only that image
gcloud builds submit \
  --project=owlid-491411 --region=europe-west1 \
  --config=deploy/gcp/cloudbuild/<app|admin|verifier>.yaml \
  --substitutions=_IMAGE_TAG=latest,_REGION=europe-west1,_REPO=owlid

# 3. Roll
just gcp-apply
```

Frontend builds are fast (~1–3 min) because Bun's resolution is quick and the Vite output is small.

### 3.3 Sidecar code change (midnight-sidecar)

```sh
# 1. Edit packages/midnight-sidecar/src/...

# 2. Build
gcloud builds submit \
  --project=owlid-491411 --region=europe-west1 \
  --config=deploy/gcp/cloudbuild/sidecar.yaml \
  --substitutions=_IMAGE_TAG=latest,_REGION=europe-west1,_REPO=owlid

# 3. Roll
just gcp-apply
```

When you wire real Midnight infra: edit `terraform/run.tf` `sidecar` env block, swap placeholder URLs (`MIDNIGHT_NODE_WS_URL`, `MIDNIGHT_INDEXER_URI`, etc.) for real endpoints, then `just gcp-apply`. Midnight is always-on — verification and issuer fail-fast if the sidecar is unreachable, so the sidecar must be healthy before either service rolls.

### 3.4 DB schema change (new migration)

```sh
# 1. Add the new SQL file under crates/<service>-service/migrations/
cat > crates/verification-service/migrations/006_my_change.sql <<'EOF'
ALTER TABLE foo ADD COLUMN bar TEXT;
EOF

# 2. Apply against Cloud SQL — allowlists your IP, runs sqlx, revokes
just gcp-migrate

# 3. If the new schema requires service code changes, build + deploy too
gcloud builds submit ... # see 3.1
just gcp-apply
```

**Order matters** when the migration is non-backward-compatible (drop column, rename column):

1. Deploy app version that tolerates both old + new schema
2. Run migration
3. Deploy app version that only uses new schema

For dev sandbox you can usually do (2) → (3) and accept brief errors.

### 3.5 Add a new env var to a service

#### Plain value

Edit `deploy/gcp/terraform/run.tf`. Find the service's `dynamic "env"` block:

```hcl
dynamic "env" {
  for_each = {
    EXISTING_VAR = "..."
    NEW_VAR      = "value"     # <— add this line
  }
  content {
    name  = env.key
    value = env.value
  }
}
```

```sh
just gcp-apply
```

#### Value sourced from secret

1. Create the secret resource in `terraform/secrets.tf`. Use `random_password` if generated, or a static string for known values.
2. Add an `env { ... value_source.secret_key_ref { ... } }` block in the service in `run.tf`:

```hcl
env {
  name = "MY_SECRET"
  value_source {
    secret_key_ref {
      secret  = google_secret_manager_secret.app["my-secret"].secret_id
      version = "latest"
    }
  }
}
```

3. `just gcp-apply`

### 3.6 Add a new secret

For static / externally-supplied values (e.g. third-party API key):

1. Add to `terraform/secrets.tf`:

```hcl
locals {
  app_secrets = {
    # ...existing entries...
    "didit-api-key" = "PLACEHOLDER_REPLACE_AFTER_APPLY"
  }
}
```

2. `just gcp-apply` — TF creates the secret resource + version 1 with the placeholder.
3. Replace the value (won't drift because of `lifecycle.ignore_changes`):

```sh
printf '%s' "real-value-from-vendor" | \
  gcloud secrets versions add didit-api-key --data-file=- --project=owlid-491411
```

4. Wire it into the service (see 3.5).
5. `just gcp-apply` and `gcloud run services update <service>` to pick up `latest`.

For TF-generated random values:

```hcl
resource "random_password" "didit_webhook_secret" {
  length  = 64
  special = false
}
locals {
  app_secrets = {
    # ...
    "didit-webhook-secret" = random_password.didit_webhook_secret.result
  }
}
```

### 3.7 Add a new Cloud Run service

1. Write the Dockerfile (e.g. `Dockerfile.docs` for docs-site).
2. Write the cloudbuild config (`deploy/gcp/cloudbuild/docs.yaml`) — copy an existing one and swap the path.
3. Add the service to `deploy/gcp/scripts/build-all.sh` `SERVICES=(...)`.
4. Add the service URL to `local.run_url` in `terraform/locals.tf`.
5. Add a `google_cloud_run_v2_service` block in `terraform/run.tf` (copy an existing one).
6. Add a `google_cloud_run_v2_service_iam_member` for `allUsers` if it should be public.
7. Add an output in `terraform/outputs.tf`.
8. Build:

```sh
just gcp-build         # builds all (or submit only the new one)
just gcp-apply
```

### 3.8 Wire the custom domain

Once `gcloud domains registrations describe owlid.app --location=global` shows `state: ACTIVE`:

1. Uncomment the `google_cloud_run_domain_mapping` + `google_dns_record_set` blocks in `terraform/dns.tf`.
2. `just gcp-apply` — TF creates 6 mappings + 6 CNAME records, requests Google-managed certs.
3. Wait 5–30 min for DNS propagation + cert issuance.
4. Optionally swap `local.run_url` in `terraform/locals.tf` for the user-facing URLs:

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

5. `just gcp-apply` again — frontends reload `/config.js` with the domain URLs.

---

## 4. Verification (smoke tests)

After every deploy:

```sh
URL=$(cd deploy/gcp/terraform && terraform output -raw verification_url)
curl -sS "$URL/health" | jq

URL=$(cd deploy/gcp/terraform && terraform output -raw issuer_url)
curl -sS "$URL/health" | jq

# Frontend (just check it loads)
URL=$(cd deploy/gcp/terraform && terraform output -raw app_url)
curl -sS "$URL/" -o /dev/null -w '%{http_code}\n'

# Admin login (default user/pw is admin/admin from migration 004)
URL=$(cd deploy/gcp/terraform && terraform output -raw verification_url)
curl -sS "$URL/admin/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

Expected:

- `/health` returns `200` with JSON `{"status": "ok"}` (or similar)
- Frontend HTML 200 OK
- Admin login returns a JWT

If a service returns `502 Bad Gateway` for ~30s after deploy, that's the cold-start window. Wait then retry.

## 5. Rollback

```sh
# List recent revisions
gcloud run revisions list --service=verification --region=europe-west1 --project=owlid-491411

# Send 100% of traffic to a previous revision
gcloud run services update-traffic verification \
  --region=europe-west1 --project=owlid-491411 \
  --to-revisions=verification-00042-abc=100
```

For an image rebuild rollback — re-tag a known-good image as `latest`:

```sh
gcloud artifacts docker tags add \
  europe-west1-docker.pkg.dev/owlid-491411/owlid/verification@sha256:OLD_DIGEST \
  europe-west1-docker.pkg.dev/owlid-491411/owlid/verification:latest
just gcp-apply
```

For a TF state rollback — every `terraform apply` creates a new state generation in `gs://owlid-491411-tfstate/`. Use `gcloud storage` to list versions, copy back, then `terraform refresh`.

## 6. Common errors + fixes

The following are real failures hit during the initial deploy, with fixes verified in this repo.

| Error                                                                                                        | Cause                                                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED: setIamPolicy`                                                                            | gcloud user is `Editor` not `Owner`                                                                                                                                                                                | Have an org admin grant `roles/owner`                                                                                                                                                                                                                                                                                |
| `secretmanager.versions.access denied`                                                                       | runtime SA missing `secretAccessor`                                                                                                                                                                                | `terraform/iam.tf` should grant it; re-apply                                                                                                                                                                                                                                                                         |
| `Cloud Build SA missing storage.objects.get`                                                                 | newer projects use compute SA, not cloudbuild SA, by default                                                                                                                                                       | bindings in `terraform/iam.tf::google_project_iam_member.cloudbuild`                                                                                                                                                                                                                                                 |
| `Invalid Tier (db-f1-micro) for ENTERPRISE_PLUS`                                                             | Cloud SQL default edition rejects shared-core tier                                                                                                                                                                 | `--edition=ENTERPRISE` (already set in TF)                                                                                                                                                                                                                                                                           |
| `unrecognized arguments: --location` on `gcloud domains` subcommands                                         | newer CLI dropped the flag for some subcommands                                                                                                                                                                    | drop `--location`                                                                                                                                                                                                                                                                                                    |
| `Workspace dependency "@owlid/X" not found` in Cloud Build                                                   | Dockerfile missing a `COPY packages/X/` for a workspace dep                                                                                                                                                        | add the COPY (see commits patching `Dockerfile.{app,admin,verifier}`)                                                                                                                                                                                                                                                |
| `Can't resolve 'tw-animate-css'`                                                                             | a frontend package missing the dep in its `package.json`                                                                                                                                                           | add to `devDependencies`, run `bun install`                                                                                                                                                                                                                                                                          |
| `502 Bad Gateway` on Cloud Run after deploy                                                                  | cold start                                                                                                                                                                                                         | wait ~10s, retry                                                                                                                                                                                                                                                                                                     |
| `error: build step ... step exited with non-zero status: 1` (Cloud Build)                                    | check the build log via `gcloud builds log <id> --region=europe-west1 --project=owlid-491411`                                                                                                                      | inspect, fix root cause                                                                                                                                                                                                                                                                                              |
| `Error 400: One or more users named in the policy do not belong to a permitted customer` on Cloud Run IAM    | org policy `iam.allowedPolicyMemberDomains` rejects `allUsers`                                                                                                                                                     | Console: https://console.cloud.google.com/iam-admin/orgpolicies/iam-allowedPolicyMemberDomains?project=owlid-491411 → Manage Policy → Customize → Replace → Allow All. Then `terraform apply -var=public_run_services=true`                                                                                          |
| `Error 403: ... requires a quota project ... SERVICE_DISABLED` on `billingbudgets.googleapis.com`            | ADC has no quota project set; provider hits a default Google-managed billing project                                                                                                                               | `gcloud auth application-default set-quota-project owlid-491411` AND `provider "google" { user_project_override = true; billing_project = var.project_id }` (already set in `providers.tf`)                                                                                                                          |
| `error: error with configuration: empty host` (Rust services)                                                | `sqlx` rejects DSN with empty host between `@` and `/`                                                                                                                                                             | DSN must use a placeholder like `postgres://owl:PW@localhost/db?host=/cloudsql/...` (already fixed in `secrets.tf`)                                                                                                                                                                                                  |
| `issuer private key must be hex: InvalidHexCharacter`                                                        | `random_password` produces alphanumeric, not hex                                                                                                                                                                   | use `random_id { byte_length = 32 }` and reference `.hex` (already fixed in `secrets.tf` for encryption-key, issuer-private-key, sidecar-api-key)                                                                                                                                                                    |
| `Invalid value specified for memory. Total memory < 512 Mi is not supported with cpu always allocated`       | Cloud Run minimum is 512Mi when CPU is always-allocated                                                                                                                                                            | bump `containers.resources.limits.memory` to `"512Mi"` minimum                                                                                                                                                                                                                                                       |
| `Cannot find module '../managed/issuer_registry/contract/index.js'` (sidecar)                                | Compact compile output is `.gitignore`'d so Cloud Build doesn't ship it                                                                                                                                            | `.gcloudignore` overrides `.gitignore` exclusion for `packages/midnight-sidecar/managed/`. Run `bun run compact` locally to regenerate after contract changes                                                                                                                                                        |
| `Container failed to start and listen on the port defined provided by PORT` (Cloud Run health probe)         | Container crashed before binding (env mismatch, missing secret, bad migration, etc.)                                                                                                                               | `gcloud logging read 'resource.labels.service_name="<svc>" AND resource.labels.revision_name=~"<svc>-<NN>"' --limit=20 --format='value(textPayload)'` to see the actual panic                                                                                                                                        |
| `gcloud run services update <svc>` returns "No configuration change requested"                               | newer gcloud refuses no-op updates                                                                                                                                                                                 | force a new revision with `--update-labels="rolled-at=$(date +%s)"`                                                                                                                                                                                                                                                  |
| TLS handshake fails on `*.owlid.app`                                                                         | Google-managed cert still provisioning (5–30 min after CNAME validates)                                                                                                                                            | wait; check `gcloud beta run domain-mappings describe <subdomain.owlid.app> --region=europe-west1 --project=owlid-491411` for cert state                                                                                                                                                                             |
| `gcloud sql instances` `PENDING_CREATE` for >25 min                                                          | rare, sometimes Cloud SQL queues create ops                                                                                                                                                                        | `gcloud sql operations describe <op-id> --project=owlid-491411`; if CANCELLED retry; if stuck contact GCP support                                                                                                                                                                                                    |
| `gcloud auth application-default print-access-token` fails / 401                                             | ADC token expired (refresh token usually auto-renews; if not, manual re-auth)                                                                                                                                      | `gcloud auth application-default login`                                                                                                                                                                                                                                                                              |
| `[@owlid/config] issuerUrl fell back to http://localhost:8001` in browser console (TanStack Start app/admin) | Client-side hydration re-runs `head()` and re-renders the inline `<script>window.__OWLID_CONFIG__ = ...</script>`. `process.env.*` is empty in the browser shim → emits all-empty values → clobbers what SSR wrote | Gate the script with `import.meta.env.SSR` so it renders server-only. Already applied in `packages/{app,admin}/src/routes/__root.tsx`                                                                                                                                                                                |
| Verifier app says `Invalid or expired API key`, or `/config.js` exposes an `owlid_sk_*` value                | The public verifier SPA was wired to the service/admin `api-key-dev` secret instead of a browser-safe publishable key, or the publishable key was not bootstrapped into the verification DB                        | `verifier` Cloud Run must set `OWLID_API_KEY` from secret `verifier-api-key` (`owlid_pk_*`). `verification` Cloud Run must set `VERIFIER_API_KEY` from the same secret so startup inserts/keeps the DB row. Never put `api-key-dev` in frontend runtime config; `docker/runtime-config.sh` now refuses `owlid_sk_*`. |
| `Failed to resolve module specifier "@owlid/native-sdk"` (browser console)                                   | Stale build still bundles a reference to the removed `@owlid/native-sdk` package                                                                                                                                   | `@owlid/native-sdk` was deleted when OwlID moved to pure-TS SD-JWT VC. Drop any stale `vite-plugin-wasm` / `vite-plugin-top-level-await` plugins and `ssr.external` / `build.rollupOptions.external` entries that name native-sdk, then rebuild                                                                      |
| `gcloud organizations add-iam-policy-binding` permission denied at org level                                 | Project Owner alone can't grant org-level roles. Need a Workspace super-admin to bootstrap the first org-level role                                                                                                | Find the super-admin via https://admin.google.com → Admin roles → Super Admin. Have them grant `roles/orgpolicy.policyAdmin` (or `roles/resourcemanager.organizationAdmin`) at org level, then you can self-grant the rest                                                                                           |
| TLS handshake error / `unexpected eof while reading` on a fresh `*.owlid.app` subdomain                      | Domain mapping shows ✔ (control plane Ready) but Google's edge CDN still propagating the cert across PoPs. Some PoPs serve, others drop the connection. Typical 5–20 min after `Ready=True`                        | wait; retry from another network/region to find PoPs that already have the cert; verify control-plane state via `gcloud beta run domain-mappings list --region=europe-west1` (✔ = Ready, … = pending)                                                                                                                |
| `Error: Dead link found` (rspress build)                                                                     | A markdown link references a path outside the docs site root or to a non-existent doc                                                                                                                              | Fix the link — never disable `checkDeadLinks`. Convert to absolute URL if pointing at the GitHub repo, or remove the reference if it's a dev-only / internal-repo concept that shouldn't be in user-facing docs                                                                                                      |

### Frontend SSR config injection — the right pattern

TanStack Start runs `head()` BOTH server-side (for the SSR HTML) AND client-side (for hydration / route changes). If you put a runtime config inline-script in `head.scripts[].children`, it gets re-rendered on the client with empty values (the browser shim of `process.env` returns nothing). React diffs the `<head>`, sees the script changed, runs the new (empty) one, and clobbers `window.__OWLID_CONFIG__`.

**Don't** rely on a runtime-written `/config.js` file either — Nitro v2 only serves files in `.output/public/` that existed at build time. A `runtime-config.sh` writing into the running container's `.output/public/` does NOT register with Nitro's storage manifest and ends up routed to TanStack's catch-all 404.

**Do** gate the inline `<script>` on `import.meta.env.SSR`:

```ts
scripts: import.meta.env.SSR
  ? [
      {
        children: `window.__OWLID_CONFIG__ = ${JSON.stringify({
          verificationUrl: process.env.OWLID_VERIFICATION_URL || '',
          // ...
        })};`,
      },
    ]
  : [],
```

Server emits the script. Client returns an empty array → no script in vdom → react has nothing to re-emit. The SSR-set `window.__OWLID_CONFIG__` survives the whole session.

For a **pure-static SPA** (no SSR, like `verifier-app`), the simpler pattern works: nginx serves `/config.js` written at container start by `docker/runtime-config.sh`. No SSR re-render to fight with. Frontend config is public: only `owlid_pk_*` publishable keys are allowed there, and the script exits if `OWLID_API_KEY` / `VITE_API_KEY` starts with `owlid_sk_`.

### What to do when a deploy partially fails

1. **Check Cloud Run revision health first.** `gcloud run services list --region=europe-west1 --project=owlid-491411 --format='table(metadata.name,status.conditions[0].status,status.conditions[0].message)'` shows which service stalled.
2. **Read its logs.** `gcloud logging read 'resource.labels.service_name="<svc>"' --limit=20 --project=owlid-491411 --format='value(textPayload,jsonPayload.message)'`. 90 % of the time the message is the real cause (panic with line, missing env, hex parse error, etc.).
3. **Don't blame the platform.** GCP returns the actual root cause in error messages most of the time. Read them carefully.
4. **For TF errors**, the message includes the resource block + line. Fix the HCL or the upstream value, then `terraform apply -auto-approve` again. TF re-reads state on every run; partial success is fine.
5. **Force re-roll without TF**: `gcloud run services update <svc> --update-labels="rolled-at=$(date +%s)" --region=europe-west1 --project=owlid-491411` triggers a new revision, picks up `latest` secret versions.
6. **Validate before apply**: `cd deploy/gcp/terraform && terraform fmt && terraform validate` catches HCL errors before they hit GCP. Run after every edit.
7. **Don't `--no-verify` or skip hooks.** If a hook fails, fix the underlying issue (per repo CLAUDE.md rule).

## 7. Cost + scaling knobs

| Knob                           | Where                                            | Default                                          | Effect                                      |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------- |
| Cloud Run `min_instance_count` | `terraform/run.tf` per service                   | `0`                                              | `>= 1` removes cold-start, paid 24/7        |
| Cloud Run `max_instance_count` | same                                             | `2` (backends) / `2` (frontends) / `1` (sidecar) | autoscale ceiling                           |
| Cloud Run CPU/memory           | `containers.resources.limits`                    | `1` CPU / `512Mi` (`256Mi` frontends)            | bump for memory-heavy work                  |
| Cloud SQL tier                 | `terraform/variables.tf::sql_tier`               | `db-f1-micro` (~€8/mo)                           | `db-custom-1-3840` for prod (~€40/mo)       |
| Cloud SQL backups              | `terraform/sql.tf::backup_configuration.enabled` | `false`                                          | `true` for prod                             |
| Cloud SQL HA                   | `terraform/sql.tf::availability_type`            | `ZONAL`                                          | `REGIONAL` for prod (~2x cost)              |
| Budget cap                     | `terraform/budget.tf`                            | €300                                             | bump if you exceed during real load testing |

Idle cost (no traffic): ~€8–10/mo (Cloud SQL only — Cloud Run is free at min=0).

Loaded cost depends on traffic. For typical dev usage (<1k req/day across all services): well under €15/mo. For production at thousands of QPS, plan separately.

## 8. Logs + observability

Cloud Run auto-pipes container `stdout`/`stderr` to **Cloud Logging**. No agent, no setup. Default 30-day retention.

### Console

https://console.cloud.google.com/logs/query?project=owlid-491411 — filter by resource type, service, severity, free-text.

### gcloud cheatsheet

```sh
# Tail one service live
gcloud beta logging tail \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="verification"' \
  --project=owlid-491411

# Last 50 lines of one service
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="issuer"' \
  --limit=50 --project=owlid-491411 \
  --format='value(timestamp,textPayload,jsonPayload.message)'

# Errors only across all services in the last hour
gcloud logging read \
  'resource.type="cloud_run_revision" AND severity>=ERROR' \
  --limit=20 --freshness=1h --project=owlid-491411 \
  --format='value(resource.labels.service_name,textPayload,jsonPayload.message)'

# A specific revision (after a deploy)
gcloud logging read \
  'resource.labels.revision_name="verification-00004-f4g"' \
  --limit=30 --project=owlid-491411

# Cloud SQL slow queries / errors
gcloud logging read \
  'resource.type="cloudsql_database" AND resource.labels.database_id="owlid-491411:owlid-pg"' \
  --limit=20 --project=owlid-491411

# Cloud Build logs
gcloud builds log <build-id> --region=europe-west1 --project=owlid-491411
```

Severity ladder: `DEBUG < INFO < NOTICE < WARNING < ERROR < CRITICAL < ALERT < EMERGENCY`. `severity>=ERROR` filters all error+ rows.

### Useful aliases

```sh
alias owlid-logs='gcloud logging read "resource.type=\"cloud_run_revision\"" --limit=50 --project=owlid-491411 --freshness=1h --format="value(timestamp,resource.labels.service_name,textPayload,jsonPayload.message)"'
alias owlid-err='gcloud logging read "resource.type=\"cloud_run_revision\" AND severity>=ERROR" --limit=20 --project=owlid-491411 --freshness=1h --format="value(timestamp,resource.labels.service_name,textPayload,jsonPayload.message)"'
alias owlid-tail='gcloud beta logging tail "resource.type=\"cloud_run_revision\"" --project=owlid-491411'
```

### Structured (JSON) logs

Rust services use the `tracing` crate. Set `RUST_LOG_FORMAT=json` in `terraform/run.tf` env block to emit JSON, then `jsonPayload.fields.user_id="..."` and similar key filters work in Cloud Logging.

The Bun sidecar uses standard `console.log`/`console.error` — Cloud Run wraps them as text. For structured fields, log JSON strings; Cloud Logging will parse the `jsonPayload`.

### Long-term retention / export

Default 30 days. To extend or archive elsewhere:

```sh
# Dedicated bucket with 1-year retention (kept inside Cloud Logging)
gcloud logging buckets create owlid-logs-archive \
  --location=europe-west1 --retention-days=365 --project=owlid-491411

# Or sink to BigQuery for SQL analytics
gcloud logging sinks create owlid-bq-sink \
  bigquery.googleapis.com/projects/owlid-491411/datasets/owlid_logs \
  --log-filter='resource.type="cloud_run_revision"' \
  --project=owlid-491411

# Or sink to GCS (cheap cold storage)
gcloud logging sinks create owlid-gcs-sink \
  storage.googleapis.com/owlid-491411-log-archive \
  --log-filter='resource.type="cloud_run_revision"' \
  --project=owlid-491411
```

### Alerts on log patterns

Console route is easiest: **Monitoring → Alerting → Create policy → Log Match condition**.

Common dev policies worth setting:

| Alert                                         | Filter                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Any service emits `ERROR`+ for >5 events / 5m | `resource.type="cloud_run_revision" AND severity>=ERROR`                                                     |
| Container start failure                       | `resource.type="cloud_run_revision" AND textPayload:"Container called exit"`                                 |
| SQL connection refused                        | `textPayload:"connection refused" AND resource.labels.service_name=~"verification\|issuer"`                  |
| Budget threshold reached                      | `protoPayload.serviceName="billingbudgets.googleapis.com"` — or just trust the email from the budget itself. |

Channels: email is fastest to set up. Slack / PagerDuty integrations are first-class.

### Log-based metrics (tracking custom events)

If you want a chart of "credentials issued per hour":

```sh
gcloud logging metrics create credentials_issued \
  --description="Issuer credential issuance" \
  --log-filter='resource.labels.service_name="issuer" AND textPayload:"issued credential"' \
  --project=owlid-491411
```

Then graph in **Monitoring → Metrics Explorer → log-based**.

### Auditing access to secrets / IAM

Cloud Audit Logs are separate from app logs but in the same console. Filter:

```
logName="projects/owlid-491411/logs/cloudaudit.googleapis.com%2Fdata_access"
AND protoPayload.serviceName="secretmanager.googleapis.com"
```

Tracks every `secrets.versions.access` call, by which principal, on which secret. Useful when rotating to verify nobody else read the old version.

### What logs are NOT collected

- **Inside the database.** Cloud SQL writes its own slow-query / error log (querying it shown above), but row-level audit isn't on. Enable `cloudsql.enable_pgaudit` flag if needed.
- **Browser-side errors from the SPA.** Wire a frontend error reporter (Sentry, GCP Error Reporting client) — not done yet.
- **HTTP request logs.** Cloud Run captures _request metadata_ (method, path, status, duration, IP) under `resource.type="cloud_run_revision"` with `jsonPayload.requestMethod` etc — these come for free, no setup.
