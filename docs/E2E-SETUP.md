# OwlID End-to-End Setup Guide

Complete instructions for running the full OwlID stack with a local Midnight blockchain.

## Prerequisites

- Docker & Docker Compose
- Rust toolchain (for backend services)
- Bun (for TypeScript packages)
- `just` command runner
- ~8 GB free disk space (for Docker images + SRS parameters)

## Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │         Midnight Network (Docker)            │
                         │                                              │
                         │  midnight-node:9944     (blockchain + RPC)   │
                         │  midnight-indexer:8088   (GraphQL API)       │
                         │  midnight-proof-server:6300 (ZK proving)     │
                         └──────────────┬───────────────────────────────┘
                                        │
                         ┌──────────────┴───────────────────────────────┐
                         │    Midnight Sidecar :3000 (Bun/Hono)         │
                         │    - Headless wallet (balanceTx/submitTx)    │
                         │    - REST API for contract operations        │
                         │    - API key authentication                  │
                         └──────────────┬───────────────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
   ┌──────────┴──────────┐  ┌──────────┴──────────┐  ┌──────────┴──────────┐
   │ Verification :8000  │  │   Issuer :8001      │  │   Frontend :5000    │
   │ (Rust/Axum)         │  │   (Rust/Axum)       │  │   (Vite/React)      │
   │ + PostgreSQL :5432  │  │   + PostgreSQL :5433│  │                     │
   └─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

## Quick Start (5 minutes)

```bash
# 1. Install dependencies
just setup

# 2. Start Midnight network
just midnight-up

# 3. Wait for all services to be healthy (~30 seconds)
just midnight-status

# 4. Deploy contracts
just deploy-contracts

# 5. Start the full E2E stack
just dev-e2e
```

## Step-by-Step Guide

### Step 1: Start the Midnight Network

```bash
just midnight-up
```

This starts three Docker containers:

| Service                 | Image                                    | Port | Purpose                             |
| ----------------------- | ---------------------------------------- | ---- | ----------------------------------- |
| `midnight-node`         | `midnightntwrk/midnight-node:0.22.3`     | 9944 | Blockchain node (standalone devnet) |
| `midnight-indexer`      | `midnightntwrk/indexer-standalone:4.0.1` | 8088 | GraphQL API for chain state         |
| `midnight-proof-server` | `midnightntwrk/proof-server:8.0.3`       | 6300 | ZK-SNARK proof generation           |

The node runs with `CFG_PRESET=dev` which creates a standalone devnet with pre-funded genesis accounts. No external Cardano connection is needed.

Wait for all services to be healthy:

```bash
# Check health (repeat until all show OK)
just midnight-status

# Or watch the logs
just midnight-logs
```

### Step 2: Deploy Contracts

```bash
just deploy-contracts
```

This deploys the three OwlID Compact contracts:

1. **Issuer Registry** - Tracks trusted credential issuers
2. **Revocation Registry** - Manages credential revocation/suspension
3. **Identity Registry** - Stores identity commitments (hashes only, private data stays off-chain)

The deployment script uses the **devnet genesis wallet** (seed `0...01`) which has pre-minted tokens for local development. Contract addresses are saved to `.env.contracts`.

### Step 3: Start the Full Stack

```bash
just dev-e2e
```

This starts everything:

- Midnight network (if not already running)
- PostgreSQL databases (verification + issuer)
- Midnight sidecar (port 3000) with headless wallet
- Verification service (port 8000)
- Issuer service (port 8001)
- Frontend app (port 5000)

The sidecar automatically loads contract addresses from `.env.contracts` if available.

### Step 4: Verify the Setup

```bash
# Check all services
just test-api

# Check sidecar health
curl http://localhost:3000/health | jq .

# Check Midnight network
just midnight-status
```

## Testing the E2E Flow

### Manual Flow

1. **Open the app** at http://localhost:5000
2. **Start identity verification** - creates a session with the issuer service
3. **Complete verification** - using a test provider (form-based for dev)
4. **Receive credential** - the issuer service issues a signed credential and anchors it on-chain
5. **Verify credential** - submit to the verification service, which checks:
   - JWT signature validity
   - Merkle proof integrity
   - On-chain issuer trust status (via sidecar)
   - On-chain revocation status (via sidecar)

### API Testing

```bash
# Get issuer info
curl -s http://localhost:8001/issuer-info | jq .

# Register issuer on-chain (via sidecar)
just register-issuer

# Check issuer trust status
KEYHASH=$(curl -s http://localhost:8001/issuer-info | jq -r '.publicKeyHash')
curl -s http://localhost:3000/api/issuers/$KEYHASH/trusted \
  -H "X-API-Key: dev_key_12345678901234567890123456789012" | jq .

# Health check with contract connection status
curl -s http://localhost:3000/health | jq .
```

## Configuration Reference

### Environment Variables

#### Midnight Network

| Variable                    | Default                                 | Description                            |
| --------------------------- | --------------------------------------- | -------------------------------------- |
| `MIDNIGHT_WALLET_SEED`      | `0...01` (devnet genesis)               | HD wallet seed for transaction signing |
| `MIDNIGHT_NODE_WS_URL`      | `ws://localhost:9944`                   | Node WebSocket for wallet relay        |
| `MIDNIGHT_INDEXER_URI`      | `http://localhost:8088/api/v3/graphql`  | Indexer GraphQL endpoint               |
| `MIDNIGHT_INDEXER_WS_URI`   | `ws://localhost:8088/api/v3/graphql/ws` | Indexer WebSocket endpoint             |
| `MIDNIGHT_PROOF_SERVER_URI` | `http://localhost:6300`                 | Proof server endpoint                  |
| `MIDNIGHT_NETWORK_ID`       | `undeployed`                            | Network ID (`undeployed`, `preprod`)   |

#### Contract Addresses (written by `deploy-contracts`)

| Variable                               | Description                          |
| -------------------------------------- | ------------------------------------ |
| `MIDNIGHT_ISSUER_REGISTRY_ADDRESS`     | Deployed issuer registry address     |
| `MIDNIGHT_REVOCATION_REGISTRY_ADDRESS` | Deployed revocation registry address |
| `MIDNIGHT_IDENTITY_REGISTRY_ADDRESS`   | Deployed identity registry address   |

#### Sidecar

| Variable                    | Default    | Description                        |
| --------------------------- | ---------- | ---------------------------------- |
| `MIDNIGHT_SIDECAR_PORT`     | `3000`     | Sidecar HTTP port                  |
| `MIDNIGHT_SIDECAR_API_KEY`  | (required) | API key for service auth           |
| `MIDNIGHT_OWNER_SECRET_KEY` | (optional) | Secret key for identity operations |

#### OwlID Services

| Variable               | Default                 | Description                 |
| ---------------------- | ----------------------- | --------------------------- |
| `MIDNIGHT_SIDECAR_URL` | `http://localhost:3000` | Sidecar endpoint (required) |

## Just Commands Reference

| Command                 | Description                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `just midnight-up`      | Start Midnight network containers                                                               |
| `just midnight-down`    | Stop Midnight network                                                                           |
| `just midnight-reset`   | Stop + remove all chain data                                                                    |
| `just midnight-status`  | Check health of all Midnight services                                                           |
| `just midnight-logs`    | Tail Midnight container logs                                                                    |
| `just deploy-contracts` | Deploy the OwlID Compact contracts to Midnight (3 registries + 7 predicates)                    |
| `just dev-e2e`          | Start full stack (Midnight + DBs + sidecar + services + app)                                    |
| `just dev-full`         | Start the backends + all frontends with the sidecar (no Midnight devnet)                        |
| `just dev`              | Start the services + app (the services need a reachable sidecar — see `dev-backend`/`dev-full`) |

## Troubleshooting

### Docker images fail to pull

The Midnight Docker images are public but large. Ensure Docker has enough disk space:

```bash
docker system df
docker system prune  # if needed
```

### Proof server is slow on first request

The proof server downloads SRS parameters (~500 MB) on the first proof request. This is normal and cached for subsequent requests.

### Indexer health check fails

The indexer takes longer to start than the node. Wait up to 60 seconds:

```bash
docker compose -f docker-compose.midnight.yml logs -f midnight-indexer
```

### Contract deployment fails

Check that all three Midnight services are healthy:

```bash
just midnight-status
```

If the proof server is down, deployments will fail because they require ZK proofs.

### Sidecar shows "stub balanceTx/submitTx"

Set `MIDNIGHT_WALLET_SEED` to enable real wallet transactions:

```bash
export MIDNIGHT_WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
```

### Reset everything

```bash
just midnight-reset  # reset chain data
just db-reset        # reset OwlID databases
rm .env.contracts    # remove contract addresses
```

Then start fresh from Step 1.
