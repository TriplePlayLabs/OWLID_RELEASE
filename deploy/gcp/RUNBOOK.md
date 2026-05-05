# Deploy runbook — OwlID GCP

Step-by-step playbooks for every common deploy scenario. Keep this open during any production change.

Use this with:
- [README.md](README.md) — project overview, layout, prerequisites
- [SECRETS.md](SECRETS.md) — secret storage + rotation
- [ENV-WIRING.md](ENV-WIRING.md) — env-var sources + service dependencies

---

## Table of contents

1. [First-time setup](#1-first-time-setup)
2. [Daily change → deploy loop](#2-daily-change--deploy-loop)
3. [Scenarios](#3-scenarios)
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

The 80% case after first-time setup:

```sh
# 1. Make code changes locally. Run tests.
cargo test --workspace
bun run --filter '*' test

# 2. Build affected images (re-uploads source, runs Cloud Build).
just gcp-build

# 3. Apply Terraform — Cloud Run swaps to the new images.
just gcp-apply

# 4. Verify (see section 4).
just gcp-urls
```

**Image tagging:** by default everything is tagged `latest`. For traceable deploys:
```sh
TAG=$(git rev-parse --short HEAD)
IMAGE_TAG=$TAG just gcp-build
cd deploy/gcp/terraform && terraform apply -var=image_tag=$TAG
```

The Terraform variable `image_tag` is read from `terraform.tfvars` or `-var`. Set it once per release; Cloud Run updates with rolling traffic.

---

## 3. Scenarios

### 3.0 Native SDK / WASM rebuild

`packages/native-sdk` is a Rust → napi-rs library that produces:
- Linux `.node` binary (Node addon, used by SSR / tests)
- Browser `.wasm` (loaded by frontends via `vite-plugin-wasm`)
- JS bindings (`browser.js`, `index.mjs`, `npm/wasm32-wasi/owl-id.wasi-browser.js`)

`Dockerfile.native-sdk-builder` also runs **`just generate-zk-keys`**
(`cargo run -p owl-zk-circuits --bin keygen --no-default-features --release`)
before the napi build so the Groth16 proving keys at
`crates/zk-circuits/artifacts/*.bin` exist. The `prover-keys-embedded`
feature `include_bytes!`s them into the napi binary at compile time. The
artifacts are `.dockerignore`'d (host copies are untracked + might be
stale), so the image always regenerates them from deterministic dev
seeds.

These artifacts are **not in git** (`.gitignore` excludes `*.wasm`, `*.node`, etc.) so Cloud Build's source upload doesn't include them. Without a build step, frontends would ship empty stubs and crash on first WASM call.

**Solution:** dedicated `native-sdk-builder` Docker image. Mirrors `just build-sdk` exactly:

```
1. bunx napi build --platform --release                    # Linux .node
2. RUSTFLAGS='...' bunx napi build --target wasm32-wasip1-threads --release   # Browser WASM
3. bunx napi artifacts -o . --npm-dir npm                 # move into npm/<arch>/
4. wasm-opt ... -O2                                        # post-process for browser compat
5. bun run build (in packages/config + packages/sdk)       # TS dist/
```

Frontend Dockerfiles consume the result via `--from=native-sdk` stage:
```dockerfile
ARG NATIVE_SDK_IMAGE=europe-west1-docker.pkg.dev/owlid-491411/owlid/native-sdk-builder:latest
FROM ${NATIVE_SDK_IMAGE} AS native-sdk
...
COPY --from=native-sdk /native-sdk packages/native-sdk
COPY --from=native-sdk /sdk        packages/sdk
COPY --from=native-sdk /config     packages/config
```

#### When to rebuild native-sdk-builder

| Change | Rebuild needed? |
|--------|----------------|
| Rust source under `packages/native-sdk/src/` | yes |
| `Cargo.toml` deps that affect native-sdk | yes |
| `crates/proof-system`, `crates/zk-circuits`, `crates/crypto` (referenced by native-sdk) | yes |
| `packages/sdk` TS source | yes (TS SDK is built in this stage) |
| `packages/config` TS source | yes |
| Anything else (frontend code, services, etc.) | no — pull cached `:latest` |

#### Rebuild commands

Full: `just gcp-build` runs phase 1 (native-sdk + backends parallel) → phase 2 (waits for native-sdk) → phase 3 (frontends parallel). About 10–15 min cold.

Native-sdk only:
```sh
gcloud builds submit \
  --project=owlid-491411 --region=europe-west1 \
  --config=deploy/gcp/cloudbuild/native-sdk-builder.yaml \
  --substitutions=_IMAGE_TAG=latest,_REGION=europe-west1,_REPO=owlid
```

Then frontends (parallel):
```sh
for svc in app admin verifier; do
  gcloud builds submit \
    --project=owlid-491411 --region=europe-west1 \
    --config=deploy/gcp/cloudbuild/${svc}.yaml \
    --substitutions=_IMAGE_TAG=latest,_REGION=europe-west1,_REPO=owlid \
    --async
done
```

Pin to a SHA (recommended for prod) so frontends + backends + native-sdk move atomically:
```sh
TAG=$(git rev-parse --short HEAD)
IMAGE_TAG=$TAG just gcp-build
cd deploy/gcp/terraform && terraform apply -var=image_tag=$TAG
```

Otherwise `latest` floats and a frontend rebuild after a native-sdk change can race against the old native-sdk-builder image cache.

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

# 3. Roll Cloud Run
just gcp-apply
# (or just nudge that one service:)
gcloud run services update verification --region=europe-west1 --project=owlid-491411
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

When you wire real Midnight infra: edit `terraform/run.tf` `sidecar` env block, swap placeholder URLs (`MIDNIGHT_NODE_WS_URL`, `MIDNIGHT_INDEXER_URI`, etc.) for real endpoints, then `just gcp-apply`. Also flip `MIDNIGHT_ENABLED=true` on `verification` + `issuer` in the same file.

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
  app          = "https://app.owlid.app"
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

| Error | Cause | Fix |
|-------|-------|-----|
| `PERMISSION_DENIED: setIamPolicy` | gcloud user is `Editor` not `Owner` | Have an org admin grant `roles/owner` |
| `secretmanager.versions.access denied` | runtime SA missing `secretAccessor` | `terraform/iam.tf` should grant it; re-apply |
| `Cloud Build SA missing storage.objects.get` | newer projects use compute SA, not cloudbuild SA, by default | bindings in `terraform/iam.tf::google_project_iam_member.cloudbuild` |
| `Invalid Tier (db-f1-micro) for ENTERPRISE_PLUS` | Cloud SQL default edition rejects shared-core tier | `--edition=ENTERPRISE` (already set in TF) |
| `unrecognized arguments: --location` on `gcloud domains` subcommands | newer CLI dropped the flag for some subcommands | drop `--location` |
| `Workspace dependency "@owlid/X" not found` in Cloud Build | Dockerfile missing a `COPY packages/X/` for a workspace dep | add the COPY (see commits patching `Dockerfile.{app,admin,verifier}`) |
| `Can't resolve 'tw-animate-css'` | a frontend package missing the dep in its `package.json` | add to `devDependencies`, run `bun install` |
| `502 Bad Gateway` on Cloud Run after deploy | cold start | wait ~10s, retry |
| `error: build step ... step exited with non-zero status: 1` (Cloud Build) | check the build log via `gcloud builds log <id> --region=europe-west1 --project=owlid-491411` | inspect, fix root cause |

## 7. Cost + scaling knobs

| Knob | Where | Default | Effect |
|------|-------|---------|--------|
| Cloud Run `min_instance_count` | `terraform/run.tf` per service | `0` | `>= 1` removes cold-start, paid 24/7 |
| Cloud Run `max_instance_count` | same | `2` (backends) / `2` (frontends) / `1` (sidecar) | autoscale ceiling |
| Cloud Run CPU/memory | `containers.resources.limits` | `1` CPU / `512Mi` (`256Mi` frontends) | bump for memory-heavy work |
| Cloud SQL tier | `terraform/variables.tf::sql_tier` | `db-f1-micro` (~€8/mo) | `db-custom-1-3840` for prod (~€40/mo) |
| Cloud SQL backups | `terraform/sql.tf::backup_configuration.enabled` | `false` | `true` for prod |
| Cloud SQL HA | `terraform/sql.tf::availability_type` | `ZONAL` | `REGIONAL` for prod (~2x cost) |
| Budget cap | `terraform/budget.tf` | €300 | bump if you exceed during real load testing |

Idle cost (no traffic): ~€8–10/mo (Cloud SQL only — Cloud Run is free at min=0).

Loaded cost depends on traffic. For typical dev usage (<1k req/day across all services): well under €15/mo. For production at thousands of QPS, plan separately.
