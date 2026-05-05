#!/usr/bin/env bash
# Prepare the Terraform GCS backend bucket, then run `terraform init`.
# Idempotent. Run before `terraform apply` for the first time.

source "$(dirname "$0")/_lib.sh"

command -v terraform >/dev/null || fail "terraform not installed (https://developer.hashicorp.com/terraform/install)"

BUCKET="${PROJECT_ID}-tfstate"

log "Ensuring GCS bucket gs://$BUCKET exists for Terraform state"
if gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "  exists"
else
  gcloud storage buckets create "gs://$BUCKET" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access
  gcloud storage buckets update "gs://$BUCKET" --versioning --project="$PROJECT_ID"
fi

log "terraform init"
( cd "$GCP_DIR/terraform" && terraform init -upgrade )

log "Done. Next:"
echo "  cp deploy/gcp/terraform/terraform.tfvars.example deploy/gcp/terraform/terraform.tfvars"
echo "  cd deploy/gcp/terraform"
echo "  terraform plan  -var=use_placeholder_images=true   # first apply uses hello-world image"
echo "  terraform apply -var=use_placeholder_images=true"
echo ""
echo "  Then build images:    just gcp-build"
echo "  Apply real images:    cd deploy/gcp/terraform && terraform apply"
