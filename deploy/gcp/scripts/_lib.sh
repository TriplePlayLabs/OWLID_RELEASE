#!/usr/bin/env bash
# Shared helpers for deploy/gcp scripts. Source this from each script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GCP_DIR="$REPO_ROOT/deploy/gcp"
ENV_FILE="$GCP_DIR/.env.gcp"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE missing. Copy from .env.gcp.example and fill in." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${PROJECT_ID:?PROJECT_ID required}"
: "${REGION:?REGION required}"
: "${ARTIFACT_REPO:?ARTIFACT_REPO required}"
: "${RUNTIME_SA:?RUNTIME_SA required}"
: "${SQL_INSTANCE:?SQL_INSTANCE required}"

IMAGE_PREFIX="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}"
SQL_CONNECTION="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

gcp() { gcloud --project="$PROJECT_ID" "$@"; }
