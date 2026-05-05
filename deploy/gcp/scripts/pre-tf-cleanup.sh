#!/usr/bin/env bash
# One-shot: delete the manual resources created via gcloud before adopting
# Terraform. Keeps Artifact Registry repo (preserves images), DNS zone, and
# domain registration — those are imported via imports.tf.
#
# Safe to skip on a clean project. Re-runnable.

source "$(dirname "$0")/_lib.sh"

read -rp "DELETE manual SQL instance + secrets + runtime SA + budget on $PROJECT_ID? type 'yes' to confirm: " ans
[[ "$ans" == "yes" ]] || fail "aborted"

log "Deleting Cloud SQL instance $SQL_INSTANCE"
gcp sql instances delete "$SQL_INSTANCE" --quiet 2>/dev/null || echo "  not present"

log "Deleting secrets"
for s in db-password admin-jwt-secret encryption-key issuer-private-key api-key-dev verification-db-url issuer-db-url; do
  gcp secrets delete "$s" --quiet 2>/dev/null && echo "  deleted $s" || echo "  $s not present"
done

log "Deleting runtime SA"
gcp iam service-accounts delete "$RUNTIME_SA" --quiet 2>/dev/null || echo "  not present"

log "Deleting budget(s) matching owlid-*"
BUDGETS=$(gcloud billing budgets list \
  --billing-account="$BILLING_ACCOUNT" \
  --filter="displayName:owlid-*" \
  --format="value(name)" 2>/dev/null || true)
if [[ -n "$BUDGETS" ]]; then
  while IFS= read -r b; do
    [[ -n "$b" ]] && gcloud billing budgets delete "$b" \
      --billing-account="$BILLING_ACCOUNT" --quiet 2>/dev/null && echo "  deleted $b"
  done <<<"$BUDGETS"
else
  echo "  none"
fi

log "Cleanup done. Now run:"
echo "  just gcp-bootstrap   # GCS state bucket + terraform init"
echo "  just gcp-apply       # imports AR repo + DNS zone, creates everything else"
echo "  just gcp-migrate     # apply DB migrations"
