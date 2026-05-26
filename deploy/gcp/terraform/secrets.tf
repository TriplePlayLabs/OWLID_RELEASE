resource "random_password" "admin_jwt" {
  length  = 96
  special = false
}

# 32-byte AES-GCM encryption key, hex-encoded (64 hex chars).
resource "random_id" "encryption" {
  byte_length = 32
}

# Ed25519 private key for issuer credential signing — 32 bytes hex (64 chars).
resource "random_id" "issuer_pk" {
  byte_length = 32
}

resource "random_password" "api_key_dev" {
  length  = 48
  special = false
}

resource "random_password" "verifier_api_key" {
  length  = 48
  special = false
}

# 32-byte sidecar shared secret, hex-encoded.
resource "random_id" "sidecar_api_key" {
  byte_length = 32
}

locals {
  app_secrets = {
    "admin-jwt-secret"         = random_password.admin_jwt.result
    "encryption-key"           = random_id.encryption.hex
    "issuer-private-key"       = random_id.issuer_pk.hex
    "api-key-dev"              = "owlid_sk_test_${random_password.api_key_dev.result}"
    "verifier-api-key"         = "owlid_pk_test_${random_password.verifier_api_key.result}"
    "midnight-sidecar-api-key" = random_id.sidecar_api_key.hex
    "midnight-wallet-seed"     = "0000000000000000000000000000000000000000000000000000000000000001"
    # Didit KYC. TF creates the secret resource with a placeholder; populate
    # the real value via `gcloud secrets versions add didit-api-key --data-file=- ...`
    # then roll the issuer service. See SECRETS.md.
    "didit-api-key"        = "PLACEHOLDER_REPLACE_VIA_GCLOUD"
    "didit-webhook-secret" = "PLACEHOLDER_REPLACE_VIA_GCLOUD"
    # Google OAuth client secret for issuer-service OIDC sign-in. TF seeds a
    # placeholder; populate the real value (from the GCP OAuth client) via:
    #   printf '%s' "<client-secret>" | gcloud secrets versions add \
    #     oidc-google-client-secret --data-file=- --project=owlid-491411
    # then roll the issuer service.
    "oidc-google-client-secret" = "PLACEHOLDER_REPLACE_VIA_GCLOUD"
  }

  # sqlx rejects empty host in the DSN, so we use `localhost` as a placeholder
  # and route the actual connection over the Cloud SQL Auth Proxy unix socket
  # via the `host` query parameter (consumed by libpq).
  db_url_secrets = {
    "verification-db-url" = "postgres://owl:${random_password.db.result}@localhost/verification?host=/cloudsql/${local.sql_connection}"
    "issuer-db-url"       = "postgres://owl:${random_password.db.result}@localhost/issuer?host=/cloudsql/${local.sql_connection}"
  }
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.app_secrets
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "app" {
  for_each    = local.app_secrets
  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = each.value

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret" "db_urls" {
  for_each  = local.db_url_secrets
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "db_urls" {
  for_each    = local.db_url_secrets
  secret      = google_secret_manager_secret.db_urls[each.key].id
  secret_data = each.value
}

# Wallet mnemonic — separate resource (NOT in the `app_secrets` for_each
# map) so `run.tf`'s reference resolves cleanly even before the value is
# populated. TF seeds a placeholder; populate the real mnemonic via:
#
#   printf '%s' "word1 word2 ... word24" | \
#     gcloud secrets versions add midnight-wallet-mnemonic \
#       --data-file=- --project=owlid-491411
#
# Then redeploy the sidecar Cloud Run revision to pick up the new
# version. The mnemonic NEVER appears in TF state, repo files, or
# tfvars — only the placeholder seed value below is in TF state, and
# `ignore_changes` prevents `terraform apply` from clobbering the real
# value after the gcloud rotate.
resource "google_secret_manager_secret" "midnight_wallet_mnemonic" {
  secret_id = "midnight-wallet-mnemonic"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "midnight_wallet_mnemonic_seed" {
  secret      = google_secret_manager_secret.midnight_wallet_mnemonic.id
  secret_data = "PLACEHOLDER_REPLACE_VIA_GCLOUD_NEVER_COMMIT"

  lifecycle {
    ignore_changes = [secret_data]
  }
}
