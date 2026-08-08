#!/usr/bin/env bash
# Submit all Cloud Build jobs.
#
# Sequence:
#   1. verification + issuer + sidecar — parallel
#   2. app + admin + verifier + docs — parallel
#
# Override IMAGE_TAG via .env.gcp to stamp git sha or version.

source "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

TAG="${IMAGE_TAG:-latest}"

# Only cloudbuild configs that declare a substitution may receive it, so
# per-service extras are opt-in. docs stamps the commit into /version.json so a
# live deployment can be checked against a git sha.
subs_for() {
  case "$1" in
  docs) echo ",_GIT_SHA=${TAG}" ;;
  *) echo "" ;;
  esac
}

submit_async() {
  local svc="$1"
  local EXTRA_SUBS
  EXTRA_SUBS="$(subs_for "$svc")"
  echo "  -> $svc"
  gcp builds submit \
    --region="$REGION" \
    --config="$GCP_DIR/cloudbuild/${svc}.yaml" \
    --substitutions="_IMAGE_TAG=${TAG},_REGION=${REGION},_REPO=${ARTIFACT_REPO}${EXTRA_SUBS:-}" \
    --async >/dev/null
}

submit_sync() {
  local svc="$1"
  local EXTRA_SUBS
  EXTRA_SUBS="$(subs_for "$svc")"
  echo "  -> $svc (foreground)"
  gcp builds submit \
    --region="$REGION" \
    --config="$GCP_DIR/cloudbuild/${svc}.yaml" \
    --substitutions="_IMAGE_TAG=${TAG},_REGION=${REGION},_REPO=${ARTIFACT_REPO}${EXTRA_SUBS:-}"
}

log "Phase 1: backend services (parallel async submit)"
PIDS=()
for svc in verification issuer sidecar proof-server; do
  submit_async "$svc" & PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid"; done

log "Phase 2: frontend builds (parallel async submit)"
PIDS=()
for svc in app admin verifier docs; do
  submit_async "$svc" & PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid"; done

log "All builds submitted. Watch progress:"
echo "  gcloud builds list --region=$REGION --project=$PROJECT_ID --ongoing"
echo "Or in console:"
echo "  https://console.cloud.google.com/cloud-build/builds?project=$PROJECT_ID&region=$REGION"
