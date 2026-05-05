#!/usr/bin/env bash
# Apply sqlx migrations against the Cloud SQL instance.
# Temporarily allowlists the caller's public IP, runs migrations, revokes.
# Requires: sqlx-cli installed locally.

source "$(dirname "$0")/_lib.sh"

command -v sqlx >/dev/null || fail "sqlx-cli not installed. Run: cargo install sqlx-cli"

DB_PW=$(gcp secrets versions access latest --secret=db-password)
DB_HOST=$(gcp sql instances describe "$SQL_INSTANCE" --format="value(ipAddresses[0].ipAddress)")
MY_IP=$(curl -s https://api.ipify.org)
[[ -n "$MY_IP" ]] || fail "could not detect public IP"

log "Allowlisting $MY_IP/32 on $SQL_INSTANCE"
gcp sql instances patch "$SQL_INSTANCE" --authorized-networks="$MY_IP/32" --quiet >/dev/null

cleanup() {
  log "Revoking IP allowlist"
  gcp sql instances patch "$SQL_INSTANCE" --clear-authorized-networks --quiet >/dev/null || true
}
trap cleanup EXIT

log "verification migrations"
( cd "$REPO_ROOT/crates/verification-service" && \
  DATABASE_URL="postgres://owl:${DB_PW}@${DB_HOST}:5432/verification?sslmode=require" \
  sqlx migrate run )

log "issuer migrations"
( cd "$REPO_ROOT/crates/issuer-service" && \
  DATABASE_URL="postgres://owl:${DB_PW}@${DB_HOST}:5432/issuer?sslmode=require" \
  sqlx migrate run )

log "Migrations applied."
