#!/usr/bin/env bash
# Submit all Cloud Build jobs.
#
# Sequence:
#   1. native-sdk-builder + verification + issuer + sidecar — parallel
#      (frontends depend on native-sdk-builder; backends don't)
#   2. app + admin + verifier — parallel, after native-sdk-builder is published
#
# Override IMAGE_TAG via .env.gcp to stamp git sha or version.

source "$(dirname "$0")/_lib.sh"

cd "$REPO_ROOT"

TAG="${IMAGE_TAG:-latest}"

submit_async() {
  local svc="$1"
  echo "  -> $svc"
  gcp builds submit \
    --region="$REGION" \
    --config="$GCP_DIR/cloudbuild/${svc}.yaml" \
    --substitutions="_IMAGE_TAG=${TAG},_REGION=${REGION},_REPO=${ARTIFACT_REPO}" \
    --async >/dev/null
}

submit_sync() {
  local svc="$1"
  echo "  -> $svc (foreground)"
  gcp builds submit \
    --region="$REGION" \
    --config="$GCP_DIR/cloudbuild/${svc}.yaml" \
    --substitutions="_IMAGE_TAG=${TAG},_REGION=${REGION},_REPO=${ARTIFACT_REPO}"
}

log "Phase 1: native-sdk-builder + backends (parallel async submit)"
PIDS=()
submit_async native-sdk-builder & PIDS+=($!)
for svc in verification issuer sidecar; do
  submit_async "$svc" & PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid"; done

log "Phase 2: waiting for native-sdk-builder to finish (frontends depend on it)"
NATIVE_SDK_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/native-sdk-builder:${TAG}"
echo "  watching for $NATIVE_SDK_IMAGE"
until gcp artifacts docker images describe "$NATIVE_SDK_IMAGE" >/dev/null 2>&1; do
  # Poll Cloud Build for the most recent native-sdk-builder build status
  STATUS=$(gcp builds list --region="$REGION" --filter="images:native-sdk-builder" --format="value(status)" --limit=1 2>/dev/null || echo "")
  case "$STATUS" in
    SUCCESS) break ;;
    FAILURE|CANCELLED|TIMEOUT) fail "native-sdk-builder build $STATUS — check console" ;;
  esac
  printf '.'
  sleep 15
done
echo
echo "  native-sdk-builder ready"

log "Phase 3: frontend builds (parallel async submit)"
PIDS=()
for svc in app admin verifier; do
  submit_async "$svc" & PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid"; done

log "All builds submitted. Watch progress:"
echo "  gcloud builds list --region=$REGION --project=$PROJECT_ID --ongoing"
echo "Or in console:"
echo "  https://console.cloud.google.com/cloud-build/builds?project=$PROJECT_ID&region=$REGION"
