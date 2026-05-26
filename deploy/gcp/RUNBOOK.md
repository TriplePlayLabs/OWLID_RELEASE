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

### 3.0 Groth16 proving-key rebuild

`@owlid/sdk` is pure TypeScript — there is no native binary or browser WASM in the public SDK any more. The Groth16 proving keys live with the **issuer-side** ZK compute (`crates/zk-circuits/`) and are rebuilt by `just generate-zk-keys` (`cargo run -p owl-zk-circuits --bin keygen --no-default-features --release`).

The committed artifacts under `crates/zk-circuits/artifacts/*.bin` come from a deterministic dev seed. Production deploys must replace them with output from a Phase-2 MPC ceremony — see `crates/zk-circuits/CEREMONY.md`.

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

| Change                                                                                  | Rebuild needed?                     |
| --------------------------------------------------------------------------------------- | ----------------------------------- |
| Rust source under `packages/native-sdk/src/`                                            | yes                                 |
| `Cargo.toml` deps that affect native-sdk                                                | yes                                 |
| `crates/proof-system`, `crates/zk-circuits`, `crates/crypto` (referenced by native-sdk) | yes                                 |
| `packages/sdk` TS source                                                                | yes (TS SDK is built in this stage) |
| `packages/config` TS source                                                             | yes                                 |
| Anything else (frontend code, services, etc.)                                           | no — pull cached `:latest`          |

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
