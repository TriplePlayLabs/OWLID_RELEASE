#!/usr/bin/env bash
# Tear down OwlID infra. Two paths:
#   1. Terraform-managed resources -> `terraform destroy`
#   2. Anything that escaped TF (state bucket, domain registration, DNS zone) -> manual gcloud
#
# Will NOT delete:
#   - the project itself
#   - the domain registration (refundable only via console support)
#   - the DNS zone (TF imports it; destroy removes from state, not from cloud, by default)
#   - the GCS state bucket

source "$(dirname "$0")/_lib.sh"

read -rp "Run 'terraform destroy' against $PROJECT_ID? type 'yes' to confirm: " ans
[[ "$ans" == "yes" ]] || fail "aborted"

cd "$GCP_DIR/terraform"
terraform destroy

log "Done. State bucket gs://${PROJECT_ID}-tfstate kept (delete manually if needed)."
