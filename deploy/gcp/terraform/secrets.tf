resource "random_password" "admin_jwt" {
  length  = 96
  special = false
}

resource "random_password" "encryption" {
  length  = 64
  special = false
}

resource "random_password" "issuer_pk" {
  length  = 64
  special = false
}

resource "random_password" "api_key_dev" {
  length  = 48
  special = false
}

resource "random_password" "sidecar_api_key" {
  length  = 64
  special = false
}

locals {
  app_secrets = {
    "admin-jwt-secret"         = random_password.admin_jwt.result
    "encryption-key"           = random_password.encryption.result
    "issuer-private-key"       = random_password.issuer_pk.result
    "api-key-dev"              = "owlid_sk_test_${random_password.api_key_dev.result}"
    "midnight-sidecar-api-key" = random_password.sidecar_api_key.result
    "midnight-wallet-seed"     = "0000000000000000000000000000000000000000000000000000000000000001"
  }

  db_url_secrets = {
    "verification-db-url" = "postgres://owl:${random_password.db.result}@/verification?host=/cloudsql/${local.sql_connection}"
    "issuer-db-url"       = "postgres://owl:${random_password.db.result}@/issuer?host=/cloudsql/${local.sql_connection}"
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
