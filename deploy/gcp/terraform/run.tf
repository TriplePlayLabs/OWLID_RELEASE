resource "google_cloud_run_v2_service" "verification" {
  name     = "verification"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.owlid.connection_name]
      }
    }

    containers {
      image = local.service_image["verification"]
      ports { container_port = 8000 }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      dynamic "env" {
        for_each = merge(
          {
            SERVER_HOST               = "0.0.0.0"
            SERVER_PORT               = "8000"
            RUST_LOG                  = "info"
            APP_ENV                   = var.app_env
            CORS_ALLOWED_ORIGINS      = local.cors_origins
            RATE_LIMIT_ENABLED        = "true"
            RATE_LIMIT_MAX_REQUESTS   = "100"
            RATE_LIMIT_WINDOW_MINUTES = "1"
            TLS_ENABLED               = "false"
            MIDNIGHT_ENABLED          = "false"
            MIDNIGHT_SIDECAR_URL      = local.run_url["sidecar"]
            MIDNIGHT_SIDECAR_TIMEOUT  = tostring(var.midnight_sidecar_timeout_ms)
          },
          var.admin_cookie_domain == "" ? {} : { ADMIN_COOKIE_DOMAIN = var.admin_cookie_domain },
        )
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "VERIFICATION_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_urls["verification-db-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["encryption-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ADMIN_JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["admin-jwt-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "API_KEY_DEV"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["api-key-dev"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MIDNIGHT_SIDECAR_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["midnight-sidecar-api-key"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_version.app,
    google_secret_manager_secret_version.db_urls,
    google_artifact_registry_repository.owlid,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "verification_invoker" {
  name     = google_cloud_run_v2_service.verification.name
  location = google_cloud_run_v2_service.verification.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "sidecar" {
  name     = "sidecar"
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = local.service_image["sidecar"]
      ports { container_port = 3000 }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }

      dynamic "env" {
        for_each = {
          MIDNIGHT_SIDECAR_PORT     = "3000"
          MIDNIGHT_NETWORK_ID       = "undeployed"
          MIDNIGHT_NODE_WS_URL      = "ws://placeholder:9944"
          MIDNIGHT_INDEXER_URI      = "http://placeholder:8088/api/v3/graphql"
          MIDNIGHT_INDEXER_WS_URI   = "ws://placeholder:8088/api/v3/graphql/ws"
          MIDNIGHT_PROOF_SERVER_URI = "http://placeholder:6300"
        }
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "MIDNIGHT_SIDECAR_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["midnight-sidecar-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MIDNIGHT_WALLET_SEED"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["midnight-wallet-seed"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_version.app,
    google_artifact_registry_repository.owlid,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "sidecar_invoker" {
  name     = google_cloud_run_v2_service.sidecar.name
  location = google_cloud_run_v2_service.sidecar.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "issuer" {
  name     = "issuer"
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.owlid.connection_name]
      }
    }
    containers {
      image = local.service_image["issuer"]
      ports { container_port = 8001 }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "env" {
        for_each = {
          ISSUER_HOST                   = "0.0.0.0"
          ISSUER_PORT                   = "8001"
          RUST_LOG                      = "info"
          APP_ENV                       = var.app_env
          CORS_ALLOWED_ORIGINS          = local.cors_origins
          RATE_LIMIT_ENABLED            = "true"
          RATE_LIMIT_MAX_REQUESTS       = "100"
          RATE_LIMIT_WINDOW_SECONDS     = "60"
          MIDNIGHT_ENABLED              = "false"
          MIDNIGHT_SIDECAR_URL          = local.run_url["sidecar"]
          MIDNIGHT_SIDECAR_TIMEOUT      = tostring(var.midnight_sidecar_timeout_ms)
          MIDNIGHT_AUTO_REGISTER_ISSUER = tostring(var.midnight_auto_register_issuer)
          APP_URL                       = local.run_url["app"]
        }
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "ISSUER_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_urls["issuer-db-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ISSUER_PRIVATE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["issuer-private-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MIDNIGHT_SIDECAR_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["midnight-sidecar-api-key"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_version.app,
    google_secret_manager_secret_version.db_urls,
    google_artifact_registry_repository.owlid,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "issuer_invoker" {
  name     = google_cloud_run_v2_service.issuer.name
  location = google_cloud_run_v2_service.issuer.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Frontends — nginx + runtime-config.sh injects /config.js from these env vars.
locals {
  frontend_envs = {
    app = {
      OWLID_VERIFICATION_URL = local.run_url["verification"]
      OWLID_ISSUER_URL       = local.run_url["issuer"]
    }
    admin = {
      OWLID_VERIFICATION_URL = local.run_url["verification"]
      OWLID_ISSUER_URL       = local.run_url["issuer"]
    }
    verifier = {
      OWLID_VERIFICATION_URL = local.run_url["verification"]
    }
  }
}

resource "google_cloud_run_v2_service" "frontend" {
  for_each = toset(["app", "admin", "verifier"])
  name     = each.key
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = local.service_image[each.key]
      # app + admin run TanStack Start Nitro under Bun on :3000;
      # verifier is a pure static SPA served by nginx on :80.
      ports {
        container_port = each.key == "verifier" ? 80 : 3000
      }
      resources {
        limits = {
          cpu    = "1"
          memory = each.key == "verifier" ? "256Mi" : "512Mi"
        }
      }

      dynamic "env" {
        for_each = local.frontend_envs[each.key]
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = each.key == "verifier" ? toset(["api"]) : toset([])
        content {
          name = "OWLID_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["api-key-dev"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_artifact_registry_repository.owlid,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "frontend_invoker" {
  for_each = google_cloud_run_v2_service.frontend
  name     = each.value.name
  location = each.value.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
