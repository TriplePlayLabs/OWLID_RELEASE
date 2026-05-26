# OwlID Development Commands

set shell := ["bash", "-cu"]
set dotenv-load

default:
    @just --list

# ============================================================================
# Development
# ============================================================================

# Start all services
dev:
    #!/usr/bin/env bash
    set -e
    just _cleanup
    just _ensure-sdk
    echo ""
    echo "Starting OwlID..."
    echo "  Verification: http://localhost:8000 (DB: localhost:5432)"
    echo "  Issuer:       http://localhost:8001 (DB: localhost:5433)"
    echo "  App:          http://localhost:5000"
    echo ""
    docker compose up -d postgres-verification postgres-issuer
    sleep 2
    trap 'kill 0' EXIT
    cargo run -p owl-verification-service 2>&1 | sed 's/^/[VERIFY] /' &
    cargo run -p owl-issuer-service 2>&1 | sed 's/^/[ISSUER] /' &
    sleep 3
    bun run --filter @owlid/app dev 2>&1 | sed 's/^/[APP] /' &
    wait

# Start backend only
dev-backend:
    #!/usr/bin/env bash
    set -e
    just _cleanup
    docker compose up -d postgres-verification postgres-issuer
    sleep 2
    trap 'kill 0' EXIT
    cargo run -p owl-verification-service 2>&1 | sed 's/^/[VERIFY] /' &
    cargo run -p owl-issuer-service 2>&1 | sed 's/^/[ISSUER] /' &
    wait

# Start app only
dev-app:
    bun run --filter @owlid/app dev

# Start verifier app only (port 5001)
dev-verifier:
    cd packages/verifier-app && bun run dev

# Start admin dashboard only (port 4000)
dev-admin:
    cd packages/admin && bun run dev

# Start midnight sidecar only
dev-sidecar:
    cd packages/midnight-sidecar && bun run dev

# Start all services with midnight integration
dev-full:
    #!/usr/bin/env bash
    set -e
    just _cleanup
    just _ensure-sdk
    echo ""
    echo "Starting OwlID (with Midnight integration)..."
    echo "  Verification: http://localhost:8000 (DB: localhost:5432)"
    echo "  Issuer:       http://localhost:8001 (DB: localhost:5433)"
    echo "  Sidecar:      http://localhost:3000 (Midnight bridge)"
    echo "  App:          http://localhost:5000"
    echo ""
    docker compose up -d postgres-verification postgres-issuer
    sleep 2
    trap 'kill 0' EXIT
    cd packages/midnight-sidecar && bun run dev 2>&1 | sed 's/^/[SIDECAR] /' &
    sleep 2
    cargo run -p owl-verification-service 2>&1 | sed 's/^/[VERIFY] /' &
    cargo run -p owl-issuer-service 2>&1 | sed 's/^/[ISSUER] /' &
    sleep 3
    bun run --filter @owlid/app dev 2>&1 | sed 's/^/[APP] /' &
    wait

# Boot the two Rust APIs in spec-only mode: skips on-chain issuer
# registration and the sidecar probe, so `/openapi.json` is reachable
# even when Midnight / verification-service / sidecar aren't. Use
# before `just generate-api-client` for a clean spec extract.
dev-spec-only:
    #!/usr/bin/env bash
    set -e
    just _cleanup
    docker compose up -d postgres-verification postgres-issuer
    sleep 2
    trap 'kill 0' EXIT
    VERIFICATION_SKIP_SIDECAR_PROBE=true \
      cargo run -p owl-verification-service 2>&1 | sed 's/^/[VERIFY] /' &
    ISSUER_SKIP_STARTUP_REGISTRATION=true \
      ISSUER_SKIP_SIDECAR_PROBE=true \
      cargo run -p owl-issuer-service 2>&1 | sed 's/^/[ISSUER] /' &
    wait

# ============================================================================
# OpenAPI Client Generation
# ============================================================================

# Regenerate the three API client packages directly from the OpenAPI specs.
#
# Strategy: filter the generator by tag per pass, so each client receives
# ONLY the API classes it owns. Admin classes can never leak into a public
# client because they are not generated for that package in the first place.
#
# Tag → client mapping (must stay in sync with utoipa `tag = "..."` attributes):
#   verifier-client:
#     verification spec: verification, presentation, monitoring, issuers,
#                        revocations  (all public read)
#   issuer-client:
#     issuer spec:       info, providers, sessions, credentials, oidc,
#                        polling
#   admin-client:
#     verification spec: metrics, admin-issuers, admin-revocations, gdpr,
#                        admin
#     issuer spec:       callbacks, admin (provider toggles)
#
# The hand-written wrappers (each package's `src/index.ts` and
# `src/**/apis/index.ts`) are preserved.
generate-api-client:
    #!/usr/bin/env bash
    set -euo pipefail
    SPECS=$(mktemp -d -p "$HOME")
    GEN_IMAGE="openapitools/openapi-generator-cli:v7.12.0"
    PROPS="--additional-properties=supportsES6=true,typescriptThreePlus=true,withInterfaces=true,importFileExtension=.js,stringEnums=true,enumPropertyNaming=original,useSingleRequestParameter=true,modelPropertyNaming=camelCase"
    # `apis=X:Y` selects which Api class basenames are generated (basename =
    # PascalCase of the OpenAPI tag). `models` and `supportingFiles` (sans
    # values) re-include the model files + runtime.ts that the apis filter
    # would otherwise prune.
    GLOBAL_BASE="modelDocs=false,apiDocs=false,modelTests=false,apiTests=false,models,supportingFiles"

    echo "Fetching OpenAPI specs..."
    curl -sf http://localhost:8000/openapi.json > "$SPECS/verification.json"
    curl -sf http://localhost:8001/openapi.json > "$SPECS/issuer.json"

    REPO="$(pwd)"
    OUT=$(mktemp -d -p "$HOME")

    # Helper: generate one tagged subset into a dest dir then copy the
    # selected api class files into the target package. $1=spec, $2=tags
    # (colon-separated for openapi-generator), $3=dest path under $OUT.
    gen_subset() {
        local spec=$1 tags=$2 dest=$3
        docker run --rm \
            -v "$SPECS:/specs:ro" \
            -v "$OUT:/out" \
            $GEN_IMAGE generate \
            -i "/specs/$spec" -g typescript-fetch -o "/out/$dest" \
            --global-property="$GLOBAL_BASE,apis=$tags" $PROPS > /dev/null
        docker run --rm -v "$OUT:/out" alpine sh -c "chown -R $(id -u):$(id -g) /out/$dest"
        local d="$OUT/$dest"
        rm -f "$d"/{package.json,tsconfig.json,tsconfig.esm.json,README.md,.npmignore,.gitignore,.openapi-generator-ignore}
        rm -rf "$d/.openapi-generator"
        if [ -d "$d/src" ]; then cp -r "$d/src/"* "$d/" && rm -rf "$d/src"; fi
    }

    # ---- verifier-client (verification spec, public read tags) -------------
    echo "Generating verifier-client..."
    gen_subset verification.json "Verification:Presentation:Monitoring:Issuers:Revocations:Registry:Predicates" verifier
    VC="$REPO/packages/verifier-client/src"
    cp "$OUT/verifier/runtime.ts" "$VC/runtime.ts"
    rm -rf "$VC/models" && cp -r "$OUT/verifier/models" "$VC/models"
    rm -f "$VC/apis"/*.ts
    cp "$OUT/verifier/apis"/*.ts "$VC/apis/"

    # ---- issuer-client (issuer spec, public tags) --------------------------
    echo "Generating issuer-client..."
    gen_subset issuer.json "Info:Providers:Sessions:Credentials:Oidc:Polling" issuer
    IC="$REPO/packages/issuer-client/src"
    cp "$OUT/issuer/runtime.ts" "$IC/runtime.ts"
    rm -rf "$IC/models" && cp -r "$OUT/issuer/models" "$IC/models"
    rm -f "$IC/apis"/*.ts
    cp "$OUT/issuer/apis"/*.ts "$IC/apis/"

    # ---- admin-client (operator-only — both specs) -------------------------
    echo "Generating admin-client (verification half)..."
    gen_subset verification.json "Metrics:AdminIssuers:AdminRevocations:Gdpr:Admin:AdminAuth" admin-verification
    AC="$REPO/packages/admin-client/src"
    mkdir -p "$AC/verification/apis"
    cp "$OUT/admin-verification/runtime.ts" "$AC/verification/runtime.ts"
    rm -rf "$AC/verification/models" && cp -r "$OUT/admin-verification/models" "$AC/verification/models"
    rm -f "$AC/verification/apis"/*.ts
    cp "$OUT/admin-verification/apis"/*.ts "$AC/verification/apis/"

    echo "Generating admin-client (issuer half)..."
    gen_subset issuer.json "Callbacks:Admin" admin-issuer
    mkdir -p "$AC/issuer/apis"
    cp "$OUT/admin-issuer/runtime.ts" "$AC/issuer/runtime.ts"
    rm -rf "$AC/issuer/models" && cp -r "$OUT/admin-issuer/models" "$AC/issuer/models"
    rm -f "$AC/issuer/apis"/*.ts
    cp "$OUT/admin-issuer/apis"/*.ts "$AC/issuer/apis/"

    rm -rf "$SPECS" "$OUT"
    echo "Done. Top-level src/index.ts wrappers preserved (only generator-managed apis/index.ts was overwritten)."
    echo "  packages/verifier-client/  - verifier customer API"
    echo "  packages/issuer-client/    - issuer customer API"
    echo "  packages/admin-client/     - operator-only API"
    echo "  Swagger UI:                http://localhost:8000/swagger-ui , http://localhost:8001/swagger-ui"

# Compact Contracts
# ============================================================================

# Compile Compact contracts (full — generates ZK keys)
compact:
    cd packages/midnight-sidecar && bun run compact

# Compile Compact contracts (fast — skip ZK key generation)
compact-fast:
    cd packages/midnight-sidecar && bun run compact:skip-zk

# Clean compiled contract artifacts
compact-clean:
    cd packages/midnight-sidecar && bun run compact:clean

# Resync per-kind Midnight artifacts from sidecar managed/ into both
# downstream consumers: verification-service predicate-assets/
# (`include_bytes!`-served at /predicate-zk) and packages/sdk
# midnight/contracts/ (vendored compactc ABI). Run after `just compact`.
sync-midnight-assets:
    bun run scripts/sync-midnight-assets.ts

# ============================================================================
# Build
# ============================================================================

build:
    cargo build --workspace --release
    bun run build

build-backend:
    cargo build --workspace --release

build-frontend:
    bun run build

# Regenerate Groth16 proving + verifying keys for the ZK circuits.
# Writes ark-serialize compressed bytes into
# crates/zk-circuits/artifacts/{age_range,kyc_status,nationality}.{pk,vk}.bin.
# Deterministic — running this on a clean checkout produces byte-identical
# output. Re-run after editing a circuit; commit the regenerated artifacts.
#
# SECURITY: dev/test only. Production deployment must replace these with
# the output of a Phase-2 MPC ceremony (see crates/zk-circuits/CEREMONY.md).
generate-zk-keys:
    #!/usr/bin/env bash
    set -e
    echo "Generating Groth16 keys (deterministic dev seeds)…"
    # --no-default-features so the lib does not include_bytes! the very
    # files we are about to write.
    cargo run -p owl-zk-circuits --bin keygen --no-default-features --release
    echo "Done. Commit crates/zk-circuits/artifacts/ to track changes."

build-sdk:
    #!/usr/bin/env bash
    set -e
    echo "Building native SDK..."
    cd packages/native-sdk
    if [ ! -d "npm" ]; then
        bunx napi create-npm-dirs
    fi
    # Clean old WASM files to prevent stale/corrupted artifacts
    rm -f *.wasm npm/wasm32-wasi/*.wasm 2>/dev/null || true
    bunx napi build --platform --release
    # Build WASM with disabled newer features for browser compatibility
    RUSTFLAGS='-C target-feature=-extended-const,-multivalue,-reference-types,-relaxed-simd,-tail-call,-wide-arithmetic' \
        bunx napi build --platform --target wasm32-wasip1-threads --release
    bunx napi artifacts -o . --npm-dir npm
    # Post-process WASM for browser compatibility (using local binaryen v125+)
    ../../node_modules/binaryen/bin/wasm-opt npm/wasm32-wasi/owl-id.wasm32-wasi.wasm \
        --enable-threads --enable-bulk-memory --enable-mutable-globals \
        --enable-sign-ext --enable-nontrapping-float-to-int \
        -O2 -o npm/wasm32-wasi/owl-id.wasm32-wasi.wasm
    cd ../..
    echo "Building TypeScript SDK..."
    cd packages/sdk && bun run build
    cd ..
    bun install

# ============================================================================
# Testing
# ============================================================================

test:
    cargo test --workspace
    bun run test

test-rust:
    cargo test --workspace

test-ts:
    bun run test

# ============================================================================
# Code Quality
# ============================================================================

fmt:
    cargo fmt --all
    bun run format

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    bun run lint

check: fmt lint test
    @echo "All checks passed"

# ============================================================================
# Database
# ============================================================================

# Start databases
db-start:
    docker compose up -d postgres-verification postgres-issuer

# Stop databases
db-stop:
    docker compose stop postgres-verification postgres-issuer

# Verification DB CLI
db-verification:
    docker compose exec postgres-verification psql -U owl -d verification

# Issuer DB CLI
db-issuer:
    docker compose exec postgres-issuer psql -U owl -d issuer

# Reset all databases
db-reset:
    docker compose down -v postgres-verification postgres-issuer
    docker compose up -d postgres-verification postgres-issuer
    @echo "Databases reset. Migrations run on container start."

# Show tables
db-tables:
    @echo "=== Verification DB ==="
    docker compose exec postgres-verification psql -U owl -d verification -c '\dt'
    @echo ""
    @echo "=== Issuer DB ==="
    docker compose exec postgres-issuer psql -U owl -d issuer -c '\dt'

# ============================================================================
# Docker
# ============================================================================

docker-up:
    docker compose up -d

docker-down:
    docker compose down

docker-logs SERVICE="":
    docker compose logs -f {{SERVICE}}

docker-rebuild:
    docker compose up -d --build

# ============================================================================
# Setup
# ============================================================================

setup:
    @echo "Installing dependencies..."
    cargo fetch
    bun install
    @echo ""
    @echo "Setup complete. Run 'just dev' to start."

check-tools:
    @echo "Rust:   $(rustc --version 2>/dev/null || echo 'NOT INSTALLED')"
    @echo "Cargo:  $(cargo --version 2>/dev/null || echo 'NOT INSTALLED')"
    @echo "Bun:    $(bun --version 2>/dev/null || echo 'NOT INSTALLED')"
    @echo "Docker: $(docker --version 2>/dev/null || echo 'NOT INSTALLED')"

# ============================================================================
# Utilities
# ============================================================================

clean:
    cargo clean
    rm -rf packages/*/dist packages/*/.output

info:
    @echo "OwlID - Privacy-preserving identity system"
    @echo ""
    @echo "Services:"
    @echo "  verification-service (8000) - Credential verification"
    @echo "  issuer-service (8001)       - Credential issuance"
    @echo ""
    @echo "Databases:"
    @echo "  postgres-verification (5432) - Verification data"
    @echo "  postgres-issuer (5433)       - Issuer data"

# ============================================================================
# Midnight Network
# ============================================================================

# Start Midnight network (node + indexer + proof-server)
midnight-up:
    docker compose -f docker-compose.midnight.yml up -d
    @echo ""
    @echo "Midnight network starting..."
    @echo "  Node:         http://localhost:9944 (health: /health)"
    @echo "  Indexer:      http://localhost:8088/api/v3/graphql"
    @echo "  Proof Server: http://localhost:6300 (version: /version)"
    @echo ""
    @echo "Wait ~30s for all services to be healthy, then run:"
    @echo "  just midnight-status"

# Stop Midnight network
midnight-down:
    docker compose -f docker-compose.midnight.yml down

# Stop Midnight network and remove volumes
midnight-reset:
    docker compose -f docker-compose.midnight.yml down -v
    @echo "Midnight network reset. All chain data removed."

# Check Midnight network health
midnight-status:
    #!/usr/bin/env bash
    echo "=== Midnight Network Status ==="
    echo -n "Node:         " && curl -sf http://localhost:9944/health && echo " OK" || echo "DOWN"
    echo -n "Indexer:      " && curl -sf http://localhost:8088/api/v3/graphql -X POST -H 'Content-Type: application/json' -d '{"query":"{ __typename }"}' > /dev/null && echo "OK" || echo "DOWN"
    echo -n "Proof Server: " && curl -sf http://localhost:6300/version && echo "" || echo "DOWN"

# View Midnight logs
midnight-logs SERVICE="":
    docker compose -f docker-compose.midnight.yml logs -f {{SERVICE}}

# Switch the active `.env` symlink. `local` = devnet (genesis seed),
# `preview` = Midnight preview testnet (uses MIDNIGHT_WALLET_MNEMONIC).
# Both files live in the repo root and are gitignored.
env NAME="local":
    #!/usr/bin/env bash
    set -euo pipefail
    target=".env.{{NAME}}"
    if [ ! -f "$target" ]; then
      echo "Missing $target — create it first (copy from .env.example)." >&2
      exit 1
    fi
    rm -f .env
    ln -s "$target" .env
    echo "Active env: $(readlink .env)"
    grep -E "^MIDNIGHT_NETWORK_ID=" .env || true

# Rebuild `.env.preview` from GCP Secret Manager so the mnemonic + API
# keys never need to be typed/pasted on disk. Network endpoints +
# contract addresses come from tfvars (public, committed). Secrets come
# from `gcloud secrets versions access`. Requires `gcloud auth login`
# + secretAccessor role on the secrets.
env-from-gcloud PROJECT="owlid-491411":
    #!/usr/bin/env bash
    set -euo pipefail
    project="{{PROJECT}}"
    fetch() {
      gcloud secrets versions access latest --secret="$1" --project="$project"
    }
    cat > .env.preview <<EOF
    # Generated by \`just env-from-gcloud\` — DO NOT COMMIT. Gitignored.
    MIDNIGHT_NETWORK_ID=preview
    MIDNIGHT_NODE_WS_URL=wss://rpc.preview.midnight.network
    MIDNIGHT_INDEXER_URI=https://indexer.preview.midnight.network/api/v4/graphql
    MIDNIGHT_INDEXER_WS_URI=wss://indexer.preview.midnight.network/api/v4/graphql/ws
    MIDNIGHT_PROOF_SERVER_URI=https://proof-server.preview.midnight.network
    MIDNIGHT_SIDECAR_API_KEY=$(fetch midnight-sidecar-api-key)
    MIDNIGHT_WALLET_MNEMONIC="$(fetch midnight-wallet-mnemonic)"
    MIDNIGHT_ISSUER_REGISTRY_ADDRESS=$(fetch midnight-issuer-registry-address 2>/dev/null || echo '')
    MIDNIGHT_REVOCATION_REGISTRY_ADDRESS=$(fetch midnight-revocation-registry-address 2>/dev/null || echo '')
    MIDNIGHT_IDENTITY_REGISTRY_ADDRESS=$(fetch midnight-identity-registry-address 2>/dev/null || echo '')
    MIDNIGHT_PREDICATE_REGISTRY_ADDRESS=$(fetch midnight-predicate-registry-address 2>/dev/null || echo '')
    EOF
    chmod 600 .env.preview
    echo ".env.preview built from GCP Secret Manager (project=$project)"

# Push local preview secrets/config INTO GCP Secret Manager. Run after
# `bun run deploy` writes fresh contract addresses to .env.preview.
# Mnemonic is pushed first IF the gcloud secret is still a placeholder
# (otherwise left alone — rotate manually via `gcloud secrets versions add`).
push-secrets-to-gcloud PROJECT="owlid-491411":
    #!/usr/bin/env bash
    set -euo pipefail
    project="{{PROJECT}}"
    if [ ! -f .env.preview ]; then
      echo "Missing .env.preview" >&2; exit 1
    fi
    source .env.preview
    push() {
      local name="$1" value="$2"
      if [ -z "$value" ]; then
        echo "skip $name (empty)"; return
      fi
      printf '%s' "$value" | gcloud secrets versions add "$name" \
        --data-file=- --project="$project" >/dev/null
      echo "pushed $name (len=${#value})"
    }
    # Mnemonic only pushed if current is the placeholder. Avoids surprise rotation.
    current=$(gcloud secrets versions access latest --secret=midnight-wallet-mnemonic \
              --project="$project" 2>/dev/null || true)
    if [ "$current" = "PLACEHOLDER_REPLACE_VIA_GCLOUD_NEVER_COMMIT" ] || [ -z "$current" ]; then
      push midnight-wallet-mnemonic "${MIDNIGHT_WALLET_MNEMONIC:-}"
    else
      echo "skip midnight-wallet-mnemonic (already set; rotate via gcloud manually)"
    fi
    # Contract addresses are PUBLIC, not secrets — but kept here so Cloud
    # Run revisions can read them via the same secret_key_ref pattern.
    # These are populated as TF variables (tfvars), not secrets.
    echo ""
    echo "Contract addresses are TF variables. Update terraform.tfvars:"
    echo "  midnight_issuer_registry_address     = \"$MIDNIGHT_ISSUER_REGISTRY_ADDRESS\""
    echo "  midnight_revocation_registry_address = \"$MIDNIGHT_REVOCATION_REGISTRY_ADDRESS\""
    echo "  midnight_identity_registry_address   = \"$MIDNIGHT_IDENTITY_REGISTRY_ADDRESS\""
    echo "  midnight_predicate_registry_address  = \"$MIDNIGHT_PREDICATE_REGISTRY_ADDRESS\""
    echo "Then run: cd deploy/gcp/terraform && terraform apply"

# Deploy OwlID contracts to whichever Midnight network the active `.env`
# points at (run `just env preview` or `just env local` first).
deploy-contracts:
    cd packages/midnight-sidecar && bun run deploy

# Fund accounts from accounts.json (requires Midnight network running)
fund-accounts CONFIG="accounts.json":
    cd packages/midnight-sidecar && bun run fund-accounts -- --config ../../{{CONFIG}}

# Fund a specific address with NIGHT tokens
fund-address ADDRESS:
    cd packages/midnight-sidecar && bun run fund-accounts -- --address {{ADDRESS}}

# Start full E2E stack (Midnight + DBs + Sidecar + Services + App)
dev-e2e:
    #!/usr/bin/env bash
    set -e
    just _cleanup
    just _ensure-sdk
    echo ""
    echo "Starting OwlID E2E (full Midnight integration)..."
    echo ""
    echo "  Midnight:"
    echo "    Node:         http://localhost:9944"
    echo "    Indexer:      http://localhost:8088"
    echo "    Proof Server: http://localhost:6300"
    echo ""
    echo "  OwlID:"
    echo "    Verification: http://localhost:8000 (DB: localhost:5432)"
    echo "    Issuer:       http://localhost:8001 (DB: localhost:5433)"
    echo "    Sidecar:      http://localhost:3000 (Midnight bridge)"
    echo "    App:          http://localhost:5000"
    echo ""

    # Start Midnight network
    docker compose -f docker-compose.midnight.yml up -d
    echo "Waiting for Midnight network..."
    for i in $(seq 1 60); do
        if curl -sf http://localhost:9944/health > /dev/null 2>&1 && \
           curl -sf http://localhost:6300/version > /dev/null 2>&1; then
            echo "Midnight network ready."
            break
        fi
        sleep 2
    done

    # Start OwlID databases
    docker compose up -d postgres-verification postgres-issuer
    sleep 2

    trap 'kill 0' EXIT

    # All env vars loaded from .env via dotenv-load
    bun run --cwd packages/midnight-sidecar dev 2>&1 | sed 's/^/[SIDECAR] /' &
    sleep 3
    cargo run -p owl-verification-service 2>&1 | sed 's/^/[VERIFY] /' &
    cargo run -p owl-issuer-service 2>&1 | sed 's/^/[ISSUER] /' &
    sleep 3
    bun run --filter @owlid/app dev 2>&1 | sed 's/^/[APP] /' &
    wait

# ============================================================================
# API Testing
# ============================================================================

test-api:
    #!/usr/bin/env bash
    echo "=== Health Checks ==="
    curl -s http://localhost:8000/health && echo " (verification)"
    curl -s http://localhost:8001/health && echo " (issuer)"
    echo ""
    echo "=== Providers ==="
    curl -s http://localhost:8001/providers | jq -r '.[].id'

issuer-info:
    curl -s http://localhost:8001/issuer-info | jq .

register-issuer:
    #!/usr/bin/env bash
    KEY=$(curl -s http://localhost:8001/issuer-info | jq -r '.publicKey')
    curl -s -X POST http://localhost:8000/issuers \
        -H "X-API-Key: dev_key_12345678901234567890123456789012" \
        -H "Content-Type: application/json" \
        -d "{\"public_key\": \"$KEY\", \"name\": \"OwlID Issuer\"}" | jq .

# ============================================================================
# Internal
# ============================================================================

_cleanup:
    #!/usr/bin/env bash
    # Use pgrep/kill instead of pkill to avoid killing the shell itself
    for proc in owl-verification-service owl-issuer-service; do
        pids=$(pgrep -f "$proc" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs -r kill 2>/dev/null || true
        fi
    done
    # Kill vite dev servers
    pids=$(pgrep -f "vite.*dev" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs -r kill 2>/dev/null || true
    fi
    sleep 1

_ensure-sdk:
    #!/usr/bin/env bash
    set -e
    cd packages/native-sdk

    # Check if WASM needs to be built (build:wasm includes wasm-opt)
    if [ ! -f "npm/wasm32-wasi/owl-id.wasm32-wasi.wasm" ]; then
        echo "Building native SDK WASM (this may take a few minutes)..."
        bun run build:wasm
    fi

    cd ../..

    # Build TypeScript SDK if needed
    if [ ! -d "packages/sdk/dist" ] || \
       [ "packages/sdk/src/index.ts" -nt "packages/sdk/dist/index.js" ]; then
        echo "Building TypeScript SDK..."
        cd packages/sdk && bun run build
    fi


# ============================================================================
# GCP deploy (deploy/gcp)
# ============================================================================

# One-time GCS state bucket + terraform init
gcp-bootstrap:
    ./deploy/gcp/scripts/tf-bootstrap.sh

# terraform plan inside deploy/gcp/terraform
gcp-plan:
    cd deploy/gcp/terraform && terraform plan

# terraform apply inside deploy/gcp/terraform
gcp-apply:
    cd deploy/gcp/terraform && terraform apply

# First apply with placeholder hello-world image (use before images are built)
gcp-apply-placeholder:
    cd deploy/gcp/terraform && terraform apply -var=use_placeholder_images=true

# Build all 5 service images via Cloud Build (parallel)
gcp-build:
    ./deploy/gcp/scripts/build-all.sh

# Apply DB migrations against Cloud SQL via temporary IP allowlist
gcp-migrate:
    ./deploy/gcp/scripts/migrate.sh

# Tear down all TF-managed resources (interactive confirm)
gcp-teardown:
    ./deploy/gcp/scripts/teardown.sh

# Show Cloud Run service URLs
gcp-urls:
    cd deploy/gcp/terraform && terraform output

# One-shot cleanup of manual gcloud-created resources before TF takes over
gcp-pre-tf-cleanup:
    ./deploy/gcp/scripts/pre-tf-cleanup.sh
