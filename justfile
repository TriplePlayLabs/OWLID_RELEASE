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

# ============================================================================
# OpenAPI Client Generation
# ============================================================================

# Generate TypeScript API clients from running services (requires services on 8000/8001)
generate-api-client:
    #!/usr/bin/env bash
    set -e
    SPECS=$(mktemp -d -p "$HOME")
    SDK_GEN="$(pwd)/packages/sdk/src/generated"
    GEN_IMAGE="openapitools/openapi-generator-cli:v7.12.0"
    # Generator options (see: docker run --rm $GEN_IMAGE config-help -g typescript-fetch)
    #   supportsES6            - ES6+ output
    #   typescriptThreePlus    - TS 3+ features
    #   withInterfaces         - generate interfaces alongside classes
    #   importFileExtension=.js - NodeNext module resolution compatible
    #   stringEnums            - string enums instead of objects
    #   enumPropertyNaming=original - preserve Rust enum casing
    #   useSingleRequestParameter   - single object arg per method
    #   modelPropertyNaming=camelCase - match JSON conventions
    # Global properties:
    #   modelDocs=false,apiDocs=false - no markdown docs
    #   modelTests=false,apiTests=false - no test stubs
    GLOBAL="--global-property=modelDocs=false,apiDocs=false,modelTests=false,apiTests=false"
    PROPS="--additional-properties=supportsES6=true,typescriptThreePlus=true,withInterfaces=true,importFileExtension=.js,stringEnums=true,enumPropertyNaming=original,useSingleRequestParameter=true,modelPropertyNaming=camelCase"
    echo "Fetching OpenAPI specs..."
    curl -sf http://localhost:8000/openapi.json > "$SPECS/verification.json"
    curl -sf http://localhost:8001/openapi.json > "$SPECS/issuer.json"
    # Clean previous
    docker run --rm -v "$SDK_GEN:/out" alpine sh -c "rm -rf /out/verification /out/issuer" 2>/dev/null || rm -rf "$SDK_GEN/verification" "$SDK_GEN/issuer"
    mkdir -p "$SDK_GEN"
    echo "Generating verification client..."
    docker run --rm -v "$SPECS:/specs:ro" -v "$SDK_GEN:/out" $GEN_IMAGE generate \
        -i /specs/verification.json -g typescript-fetch -o /out/verification $GLOBAL $PROPS > /dev/null 2>&1
    echo "Generating issuer client..."
    docker run --rm -v "$SPECS:/specs:ro" -v "$SDK_GEN:/out" $GEN_IMAGE generate \
        -i /specs/issuer.json -g typescript-fetch -o /out/issuer $GLOBAL $PROPS > /dev/null 2>&1
    # Fix ownership, flatten src/, remove scaffolding
    docker run --rm -v "$SDK_GEN:/out" alpine sh -c "chown -R $(id -u):$(id -g) /out"
    for dir in "$SDK_GEN/verification" "$SDK_GEN/issuer"; do
        rm -f "$dir"/{package.json,tsconfig.json,tsconfig.esm.json,README.md,.npmignore,.gitignore,.openapi-generator-ignore}
        rm -rf "$dir/.openapi-generator"
        if [ -d "$dir/src" ]; then cp -r "$dir/src/"* "$dir/" && rm -rf "$dir/src"; fi
    done
    rm -rf "$SPECS"
    echo "Done."
    echo "  Clients:    packages/sdk/src/generated/{verification,issuer}/"
    echo "  Swagger UI: http://localhost:8000/swagger-ui"
    echo "              http://localhost:8001/swagger-ui"

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

# Deploy OwlID contracts to Midnight network
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
