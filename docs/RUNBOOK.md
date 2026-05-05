# OwlID Operations Runbook

## 1. Service Overview

| Service              | Port | Container                 | Description                          |
| -------------------- | ---- | ------------------------- | ------------------------------------ |
| Verification Service | 8000 | owl-verification          | Token verification, revocation, GDPR |
| Issuer Service       | 8001 | owl-issuer                | Credential issuance                  |
| PostgreSQL (verify)  | 5432 | owl-postgres-verification | Verification database                |
| PostgreSQL (issuer)  | 5433 | owl-postgres-issuer       | Issuer database                      |
| Midnight Sidecar     | 3000 | (local process)           | Bridge to Midnight blockchain        |
| Midnight Node        | 9944 | owlid-midnight-node       | Devnet consensus + RPC               |
| Midnight Indexer     | 8088 | owlid-midnight-indexer    | GraphQL API for chain state          |
| Proof Server         | 6300 | owlid-proof-server        | ZK proof generation                  |
| Frontend App         | 5000 | (local process)           | Vite + React UI                      |

Database tables (verification service):

- `api_keys` -- hashed API keys with JSON permissions
- `trusted_issuers` -- Ed25519 public keys of authorized issuers
- `revocations` -- credential revocation/suspension status
- `verification_logs` -- immutable audit trail (hashed proof data, 90-day TTL)
- `verification_metrics` -- aggregated dashboard data
- `audit_events` -- compliance audit trail
- `rate_limits` -- per-identifier request throttling

## 2. Deployment

### Docker Compose Setup

Start core services (databases + Rust services):

```bash
docker compose up -d                 # databases, verification, issuer
```

Start Midnight devnet (separate compose file):

```bash
docker compose -f docker-compose.midnight.yml up -d
```

Development shortcut with `just`:

```bash
just dev          # Backend + frontend (no Midnight)
just dev-full     # Backend + frontend + sidecar (with Midnight)
just dev-backend  # Backend only
just dev-sidecar  # Midnight sidecar only
```

### Environment Variables

**Verification Service:**

| Variable                    | Default / Example                                                |
| --------------------------- | ---------------------------------------------------------------- |
| `VERIFICATION_DATABASE_URL` | `postgres://owl:owl_dev@postgres-verification:5432/verification` |
| `SERVER_HOST`               | `0.0.0.0`                                                        |
| `SERVER_PORT`               | `8000`                                                           |
| `ENCRYPTION_KEY`            | 256-bit hex key for credential data encryption                   |
| `RUST_LOG`                  | `info,owl_verification_service=debug`                            |
| `RATE_LIMIT_REQUESTS`       | Max requests per window                                          |
| `RATE_LIMIT_WINDOW_SECS`    | Window duration in seconds                                       |

**Issuer Service:**

| Variable              | Default / Example                                    |
| --------------------- | ---------------------------------------------------- |
| `ISSUER_DATABASE_URL` | `postgres://owl:owl_dev@postgres-issuer:5432/issuer` |
| `ISSUER_HOST`         | `0.0.0.0`                                            |
| `ISSUER_PORT`         | `8001`                                               |

**Midnight Integration:**

| Variable                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `MIDNIGHT_ENABLED`          | Enable/disable Midnight integration               |
| `MIDNIGHT_NODE_URL`         | Node RPC endpoint (default `ws://localhost:9944`) |
| `MIDNIGHT_INDEXER_URL`      | Indexer GraphQL (default `http://localhost:8088`) |
| `MIDNIGHT_PROOF_SERVER_URL` | Proof server (default `http://localhost:6300`)    |

### Database Migrations

Migrations are applied automatically on first container start. PostgreSQL's
`docker-entrypoint-initdb.d` volume mount executes SQL files in alphabetical
order when the data volume is empty.

To re-run migrations from scratch, destroy the volume and recreate:

```bash
docker compose down -v
docker compose up -d postgres-verification postgres-issuer
```

### Health Checks

```bash
curl http://localhost:8000/health   # Verification service
curl http://localhost:8001/health   # Issuer service
pg_isready -h localhost -p 5432 -U owl -d verification
pg_isready -h localhost -p 5433 -U owl -d issuer
```

For Midnight infrastructure:

```bash
curl http://localhost:9944/health   # Node
curl http://localhost:6300/version  # Proof server
```

## 3. Adding a Trusted Issuer

Requires an API key with `admin` or `manage_issuers` permission.

**Add an issuer:**

```bash
curl -X POST http://localhost:8000/trusted-issuers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer owlid_sk_test_dev0000000000000000000000000000000000000000" \
  -d '{"public_key":"<hex-encoded-ed25519-pubkey>","name":"My Issuer","description":"Optional"}'
```

**List issuers:**

```bash
curl http://localhost:8000/trusted-issuers \
  -H "Authorization: Bearer owlid_sk_test_dev0000000000000000000000000000000000000000"
```

**Deactivate an issuer** (do not delete -- preserve audit trail):

```sql
UPDATE trusted_issuers SET is_active = false WHERE public_key = '<key>';
```

## 4. Managing API Keys

### Default Development Key

Seeded automatically from `002_seed.sql`:

- **Key:** `owlid_sk_test_dev0000000000000000000000000000000000000000`
- **Format:** `owlid_{pk|sk}_{live|test}_<base62>` — `pk` = publishable (browser-safe, `verify` only); `sk` = secret (any permission)
- **Permissions:** verify, manage_issuers, manage_revocations, admin
- **Warning:** Never use this key in production.

### Creating New Keys

Use the admin dashboard at `:4000` or the admin HTTP API. The service generates the prefixed key (`owlid_sk_live_…` etc.), stores its SHA-256 hash, and returns the full key once. Direct SQL inserts skip the prefix/preview logic and break the dashboard.

```bash
# Log in to the verification service as an admin user (sets owlid_admin_token cookie)
curl -X POST https://verify.example.com/admin/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{"username":"admin","password":"<admin-password>"}'

# Mint a new key
curl -X POST https://verify.example.com/admin/api-keys \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"name":"Prod Verifier","keyType":"sk","environment":"live","permissions":["verify"]}'
# Response includes the full key once. Copy it now — only the SHA-256 hash is stored server-side.
```

### Permission Model

| Permission           | Grants                                  |
| -------------------- | --------------------------------------- |
| `verify`             | Submit verification requests            |
| `manage_issuers`     | Add/deactivate trusted issuers          |
| `manage_revocations` | Revoke, suspend, reactivate credentials |
| `gdpr`               | GDPR erasure                            |
| `admin`              | Trusted-issuer + revocation mutation    |

Default admin login creds (dev only): `admin` / `admin` from the seeded `admin_users` row. **Change immediately for any non-localhost deployment.**

### Deactivating a Key

```sql
UPDATE api_keys SET is_active = false WHERE name = 'Old Key';
```

## 5. Revoking Credentials

All endpoints require an API key with `manage_revocations` or `admin` permission.

**Revoke:**

```bash
curl -X POST http://localhost:8000/revocations/revoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"credential_id":"<id>","issuer_public_key":"<key>","reason":"Compromised"}'
```

**Suspend (temporary):**

```bash
curl -X POST http://localhost:8000/revocations/suspend \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"credential_id":"<id>","issuer_public_key":"<key>","reason":"Under review"}'
```

**Reactivate:**

```bash
curl -X POST http://localhost:8000/revocations/reactivate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"credential_id":"<id>"}'
```

**Check status:**

```bash
curl -X POST http://localhost:8000/revocations/check \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"credential_id":"<id>"}'
```

**Real-time monitoring via WebSocket:**

```
ws://localhost:8000/ws/revocations
```

Publishes events when credentials are revoked, suspended, or reactivated.

## 6. GDPR Erasure

**Trigger erasure for a data subject:**

```bash
curl -X DELETE http://localhost:8000/admin/gdpr-erasure/<owner_public_key> \
  -H "Authorization: Bearer <admin-key>"
```

**What happens:**

- `verification_logs`: PII fields (ip_address, user_agent) are nullified; proof_hash and challenge_hash are retained for audit.
- `revocations`: Records tied to the owner are anonymized (reason cleared, metadata stripped).
- `audit_events`: Retained with hashed data only -- no PII is stored in this table by design.
- A new audit event of type `gdpr_erasure` is recorded.

**Automatic expiry:** The `delete_expired_records()` function removes verification logs after 90 days and expired revocations. Schedule it via pg_cron or call manually:

```sql
SELECT delete_expired_records();
```

## 7. Investigating Failed Verifications

### Query verification_logs

```sql
SELECT id, failure_reason, issuer_public_key, verified_at, ip_address
FROM verification_logs
WHERE verification_result = 'failed'
ORDER BY verified_at DESC
LIMIT 20;
```

### Common Failure Reasons

| failure_reason      | Likely cause                             | Fix                                            |
| ------------------- | ---------------------------------------- | ---------------------------------------------- |
| `UntrustedIssuer`   | Issuer public key not in trusted_issuers | Add issuer (see section 3)                     |
| `ChallengeMismatch` | Challenge expired or tampered            | Check clock sync; verify challenge freshness   |
| `CredentialRevoked` | Credential was revoked or suspended      | Check revocation status (see section 5)        |
| `TokenExpired`      | Verification token past its TTL          | Re-issue token; check client clock             |
| `InvalidProof`      | ZK proof did not verify                  | Check proof generation; verify circuit version |
| `RateLimited`       | Too many requests from this source       | Wait or adjust RATE*LIMIT*\* env vars          |

### Prometheus Metrics

```bash
curl -s http://localhost:8000/prometheus | grep tokens_verified_total
# tokens_verified_total{result="success"} 142
# tokens_verified_total{result="failure"} 3
```

## 8. Monitoring

### Prometheus Endpoint

```bash
curl http://localhost:8000/prometheus
```

### Key Metrics

| Metric                                | Type      | Description                        |
| ------------------------------------- | --------- | ---------------------------------- |
| `http_requests_total`                 | Counter   | Total HTTP requests by method/path |
| `token_verification_duration_seconds` | Histogram | Verification latency               |
| `tokens_verified_total`               | Counter   | Verifications by result            |
| `credentials_revoked_total`           | Counter   | Total revocations issued           |

### Correlation IDs

Every response includes an `x-correlation-id` header. Pass it when filing
bug reports or searching logs:

```bash
curl -v http://localhost:8000/health 2>&1 | grep x-correlation-id
```

Search service logs by correlation ID:

```bash
docker logs owl-verification 2>&1 | grep "<correlation-id>"
```

## 9. Key Rotation

### Issuer Key Rotation

1. Generate a new Ed25519 keypair for the issuer.
2. Add the new public key as a trusted issuer (section 3).
3. Configure the issuer to sign new credentials with the new key.
4. After all old credentials expire or are re-issued, deactivate the old key:
   ```sql
   UPDATE trusted_issuers SET is_active = false WHERE public_key = '<old_key>';
   ```

### API Key Rotation

1. Create a new API key (section 4).
2. Distribute the new key to consumers.
3. Deactivate the old key once all consumers have migrated:
   ```sql
   UPDATE api_keys SET is_active = false WHERE name = '<old_key_name>';
   ```

### Encryption Key Rotation

Changing `ENCRYPTION_KEY` requires re-encrypting all `credential_data` stored
in the database. This is a breaking change.

1. Schedule a maintenance window.
2. Stop the verification service.
3. Run a migration script to decrypt with the old key and re-encrypt with the new key.
4. Update the `ENCRYPTION_KEY` environment variable.
5. Restart the service.

## 10. Troubleshooting

### Service won't start

- Verify `DATABASE_URL` is reachable: `pg_isready -h <host> -p <port> -U owl`.
- Check that migrations ran: `\dt` in psql should show all tables.
- Look for port conflicts: `ss -tlnp | grep 8000`.
- Review logs: `docker logs owl-verification --tail 50`.

### 401 Unauthorized on all requests

- Confirm the API key is correct and active:
  ```sql
  SELECT name, is_active, expires_at FROM api_keys
  WHERE key_hash = encode(sha256('<your-key>'::bytea), 'hex');
  ```
- Check that `expires_at` has not passed.
- Verify the key has the required permission for the endpoint.

### Verification always fails

- Confirm the issuer's public key is in `trusted_issuers` and `is_active = true`.
- Check the challenge format matches what the client expects.
- Look at `failure_reason` in `verification_logs` for specifics.
- Ensure clocks are synchronized (challenges are time-sensitive).

### Midnight integration errors

- Confirm `MIDNIGHT_ENABLED` is set to `true`.
- Check sidecar health: `curl http://localhost:3000/health`.
- Verify Midnight node is running: `curl http://localhost:9944/health`.
- Check indexer: the healthcheck file at `/var/run/indexer-standalone/running` must exist.
- Review sidecar logs: `just dev-sidecar` output or container logs.
- If proof generation fails, check proof server: `curl http://localhost:6300/version`.

### Database issues

- Connection pool exhausted: restart the service; consider tuning pool size.
- Expired records accumulating: run `SELECT delete_expired_records();` or set up pg_cron.
- Rate limit table bloating: run `SELECT cleanup_rate_limits();`.
