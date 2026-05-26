# GCP deploy — OwlID dev sandbox

End-to-end deploy of the OwlID stack to a single GCP project on Cloud Run + Cloud SQL Postgres + Artifact Registry + Secret Manager. Infra is **Terraform**. Image builds (Cloud Build) and DB migrations are shell helpers.

## Reading order

| Doc                                | When to read                                        |
| ---------------------------------- | --------------------------------------------------- |
| [README.md](README.md) (this file) | one-page overview, layout, prerequisites            |
| [RUNBOOK.md](RUNBOOK.md)           | step-by-step playbooks for every deploy scenario    |
| [SECRETS.md](SECRETS.md)           | how secrets are stored, rotated, audited            |
| [ENV-WIRING.md](ENV-WIRING.md)     | every env var, who consumes it, where it comes from |

## Stack

| Component                                 | GCP service                                                        | Idle cost        | Notes                                                      |
| ----------------------------------------- | ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------- |
| `verification` (Rust, port 8000)          | Cloud Run v2                                                       | €0               | min=0, scales to zero                                      |
| `issuer` (Rust, port 8001)                | Cloud Run v2                                                       | €0               | min=0, scales to zero                                      |
| `sidecar` (Bun + Hono, port 3000)         | Cloud Run v2                                                       | €0               | min=0; placeholder Midnight endpoints                      |
| `app` / `admin` / `verifier` (static SPA) | Cloud Run v2 + nginx                                               | €0               | min=0, runtime config via `/config.js`                     |
| Postgres (`verification` + `issuer` DBs)  | Cloud SQL `db-f1-micro` ENTERPRISE                                 | ~€8/mo           | always-on                                                  |
| Container images                          | Artifact Registry `europe-west1-docker.pkg.dev/owlid-491411/owlid` | ~€0              | small layers                                               |
| Secrets (9)                               | Secret Manager                                                     | free <10k ops/mo | runtime SA reads                                           |
| Domain                                    | Cloud Domains + Cloud DNS                                          | $14/yr           | `owlid.app` registered, mapping commented out until ACTIVE |
| Midnight node / indexer / proof server    | not yet deployed                                                   | —                | wire later                                                 |

Total dev sandbox idle: ~€8–10/mo.

## Layout

```
deploy/gcp/
├── README.md                        # this file — entry point
├── RUNBOOK.md                       # deploy playbooks (read second)
├── SECRETS.md                       # secret management
├── ENV-WIRING.md                    # service env-var matrix
├── .env.gcp.example                 # PROJECT_ID, REGION, etc — sourced by shell scripts
├── cloudbuild/                      # one yaml per service image
│   ├── verification.yaml
│   ├── issuer.yaml
│   ├── sidecar.yaml
│   ├── app.yaml
│   ├── admin.yaml
│   └── verifier.yaml
├── terraform/                       # all infra resources
│   ├── backend.tf                   # GCS state bucket
│   ├── providers.tf
│   ├── variables.tf
│   ├── locals.tf                    # project number, image prefix, predictable Run URLs
│   ├── apis.tf                      # google_project_service x N
│   ├── iam.tf                       # runtime SA + bindings (runtime + Cloud Build default SA)
│   ├── artifact.tf                  # Artifact Registry repo
│   ├── sql.tf                       # SQL instance + DBs + user, db-password secret
│   ├── secrets.tf                   # 8 application secrets + 2 DB-URL secrets
│   ├── run.tf                       # 6 Cloud Run services with secret refs
│   ├── dns.tf                       # Cloud DNS zone (records for domain mapping commented out)
│   ├── budget.tf                    # billing budget
│   ├── outputs.tf                   # service URLs, SQL connection name
│   ├── imports.tf                   # `import` blocks for resources created out-of-band
│   └── terraform.tfvars.example
└── scripts/
    ├── _lib.sh                      # shared helpers, sources .env.gcp
    ├── tf-bootstrap.sh              # creates GCS state bucket + terraform init
    ├── pre-tf-cleanup.sh            # one-shot: delete manual gcloud-created resources before TF takes over
    ├── build-all.sh                 # submits all 6 Cloud Build jobs in parallel
    ├── migrate.sh                   # sqlx migrate against Cloud SQL via temp IP allowlist
    └── teardown.sh                  # `terraform destroy`
```

## Prerequisites

- `gcloud` CLI ≥ 565, logged in as **Owner** of the project (Editor is not enough)
- `gcloud auth application-default login` — for Terraform's GCS backend
- `terraform` ≥ 1.6
- `sqlx-cli` (`cargo install sqlx-cli`)
- `openssl`, `curl`, `bash` ≥ 4
- `docker` only needed for local image testing — Cloud Build does the actual builds

## Just-the-commands

For full step-by-step with explanations, see [RUNBOOK.md](RUNBOOK.md).

```sh
# First-time bootstrap (per project)
cp deploy/gcp/.env.gcp.example deploy/gcp/.env.gcp
cp deploy/gcp/terraform/terraform.tfvars.example deploy/gcp/terraform/terraform.tfvars
gcloud auth application-default login
just gcp-bootstrap
just gcp-apply-placeholder
just gcp-migrate
just gcp-build
just gcp-apply
just gcp-urls

# Iteration loop (every change)
just gcp-build
just gcp-apply

# Teardown
just gcp-teardown
```

## Justfile recipes

| Recipe                       | Calls                                              | Purpose                                              |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `just gcp-bootstrap`         | `scripts/tf-bootstrap.sh`                          | GCS state bucket + `terraform init`                  |
| `just gcp-pre-tf-cleanup`    | `scripts/pre-tf-cleanup.sh`                        | one-shot deletion of manual gcloud-created resources |
| `just gcp-plan`              | `terraform plan`                                   | preview changes                                      |
| `just gcp-apply`             | `terraform apply`                                  | apply changes (uses real images)                     |
| `just gcp-apply-placeholder` | `terraform apply -var=use_placeholder_images=true` | apply when real images don't exist yet               |
| `just gcp-build`             | `scripts/build-all.sh`                             | submit all 6 Cloud Build jobs in parallel            |
| `just gcp-migrate`           | `scripts/migrate.sh`                               | run sqlx migrations against Cloud SQL                |
| `just gcp-urls`              | `terraform output`                                 | print Cloud Run URLs                                 |
| `just gcp-teardown`          | `scripts/teardown.sh`                              | `terraform destroy` (interactive confirm)            |

## What Terraform owns vs. what it doesn't

**TF owns:** APIs enabled, Artifact Registry repo, runtime SA + IAM, Cloud SQL instance + DBs + user, secrets (resource shells + initial values), Cloud Run services, DNS managed zone, billing budget.

**TF does not own:**

- **Container images** in Artifact Registry — built by Cloud Build, referenced by tag from TF
- **DB migrations** — `sqlx-cli` runs separately, against the running SQL instance
- **Secret values after first creation** — `lifecycle.ignore_changes = [secret_data]` keeps them sticky, rotate via `gcloud secrets versions add`
- **Domain registration itself** — paid via `gcloud domains registrations register`, TF only manages the DNS zone records
- **Cloud Build builds, build history, GCS source archives** — ephemeral, deleted on a schedule

## Existing manual setup → Terraform migration

If the project already had resources from earlier `gcloud` work, run the cleanup before first apply:

```sh
just gcp-pre-tf-cleanup
```

Deletes Cloud SQL, secrets, runtime SA, budgets. Keeps:

- Artifact Registry repo + already-built images (TF imports it via `imports.tf`)
- DNS managed zone (TF imports)
- Domain registration (TF doesn't manage)
- API enables (TF marks as managed without recreate)

Then `just gcp-bootstrap && just gcp-apply` claims everything.

## Deploy state — what's actually running

Run `just gcp-urls` to see live URLs.

```sh
# All Cloud Run services + their current revision + image
gcloud run services list --region=europe-west1 --project=owlid-491411

# Latest image tags + digests in the registry
gcloud artifacts docker images list \
  europe-west1-docker.pkg.dev/owlid-491411/owlid \
  --include-tags --project=owlid-491411

# What's in the SQL instance
gcloud sql databases list --instance=owlid-pg --project=owlid-491411

# What secrets exist
gcloud secrets list --project=owlid-491411

# Recent build history
gcloud builds list --region=europe-west1 --project=owlid-491411 --limit=20
```

## Known gaps / TODO

- [ ] Midnight sidecar deployed but pointed at placeholder endpoints. Wire real Midnight node + indexer + proof server URLs in `terraform/run.tf::sidecar` env block.
- [ ] Proof server self-host not yet deployed.
- [ ] Domain mapping + DNS record blocks commented out in `dns.tf` — uncomment after domain `owlid.app` registration is `ACTIVE`.
- [ ] No CI trigger — builds + applies are manual. Cloud Build triggers on git push are easy to add later.
- [ ] DNSSEC disabled on `owlid-app` zone. Enable: `gcloud dns managed-zones update owlid-app --dnssec-state=on`.
- [ ] Frontends `min_instance_count = 0` — first request pays cold-start (~3–8s). Bump to 1 for prod.
- [ ] Single state file. Split into `infra` + `services` workspaces for multiple envs (dev/staging/prod) when needed.
- [ ] Default admin password is `admin` (from migration `004_admin_users.sql`). Rotate before exposing publicly.
- [ ] No `docs-site` deploy — workspace exists but no Dockerfile. Add when wanted.
