resource "google_cloud_run_v2_service" "verification" {
  name     = "verification"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    # /predicates/job/{jobId}/events SSE streams the full relay
    # lifecycle PLUS the subsequent `watchForTxData` finalization
    # wait. Chain finality on preview can take several minutes per tx;
    # under a queued backlog the stream may sit longer than that. Use
    # the Cloud Run gen1 max (3600 s / 1 hr) so the chain has room to
    # finalize before GCP kills the request — the browser-side
    # `ERR_NETWORK_CHANGED` observed earlier was actually the 900 s
    # cap firing (httpRequest.latency: 901.0001s, status: 200 in
    # Cloud Logging).
    timeout = "3600s"

    scaling {
      min_instance_count = 1
      max_instance_count = 3
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
          cpu    = "4"
          memory = "4Gi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      # Generous startup budget — verification probes the sidecar and
      # mirrors on-chain state at boot; on-chain ops are slow.
      startup_probe {
        tcp_socket { port = 8000 }
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 60
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
            MIDNIGHT_SIDECAR_URL      = local.run_url["sidecar"]
            MIDNIGHT_SIDECAR_TIMEOUT  = tostring(var.midnight_sidecar_timeout_ms)
            # Served verbatim by GET /midnight/info; the holder SDK calls
            # midnight-js setNetworkId() with it before any predicate
            # prove. Must match the network the contracts are on.
            MIDNIGHT_NETWORK_ID = var.midnight_network_id
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
        name = "VERIFIER_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["verifier-api-key"].secret_id
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

  # Verification fail-fasts on startup if the sidecar is unreachable,
  # so the sidecar Cloud Run service must be applied first.
  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_version.app,
    google_secret_manager_secret_version.db_urls,
    google_artifact_registry_repository.owlid,
    google_cloud_run_v2_service.sidecar,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "verification_invoker" {
  count    = var.public_run_services ? 1 : 0
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
    # The sidecar holds a long-lived Midnight wallet + chain connection
    # + private-state DB. It must stay warm — wallet sync alone takes
    # minutes — so: always one instance, CPU always allocated (no
    # request-scoped throttling), single instance (single chain writer).
    # /api/predicates/job/{jobId}/events SSE streams the relay
    # lifecycle + chain finalization. Match the verification-service
    # timeout (3600 s, Cloud Run gen1 max) so the proxied path
    # doesn't hit the upstream cap before the chain confirms.
    timeout = "3600s"
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    containers {
      image = local.service_image["sidecar"]
      ports { container_port = 3000 }
      resources {
        limits            = { cpu = "4", memory = "4Gi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = {
          MIDNIGHT_SIDECAR_PORT                  = "3000"
          MIDNIGHT_NETWORK_ID                    = var.midnight_network_id
          MIDNIGHT_NODE_WS_URL                   = var.midnight_node_ws_url
          MIDNIGHT_INDEXER_URI                   = var.midnight_indexer_uri
          MIDNIGHT_INDEXER_WS_URI                = var.midnight_indexer_ws_uri
          # Wallet balance leg offloads its dust re-prove here (MIDNIGHT.md
          # §3.5). Point at OUR hosted proof-server (scaled: min1/max40,
          # concurrency 4) rather than Midnight's shared preview endpoint, so
          # the balance hot path runs on capacity we control. WASM fallback
          # covers an outage. Predictable run_url ⇒ no TF cycle.
          MIDNIGHT_PROOF_SERVER_URI              = local.run_url["proof-server"]
          MIDNIGHT_ISSUER_REGISTRY_ADDRESS       = var.midnight_issuer_registry_address
          MIDNIGHT_REVOCATION_REGISTRY_ADDRESS   = var.midnight_revocation_registry_address
          MIDNIGHT_IDENTITY_REGISTRY_ADDRESS     = var.midnight_identity_registry_address
          MIDNIGHT_PREDICATE_AGE_ADDRESS         = var.midnight_predicate_age_address
          MIDNIGHT_PREDICATE_KYC_ADDRESS         = var.midnight_predicate_kyc_address
          MIDNIGHT_PREDICATE_RESIDENCY_ADDRESS   = var.midnight_predicate_residency_address
          MIDNIGHT_PREDICATE_EMAIL_ADDRESS       = var.midnight_predicate_email_address
          MIDNIGHT_PREDICATE_NATIONALITY_ADDRESS = var.midnight_predicate_nationality_address
          MIDNIGHT_PREDICATE_AGE_RANGE_ADDRESS   = var.midnight_predicate_age_range_address
          MIDNIGHT_PREDICATE_PERSONHOOD_ADDRESS  = var.midnight_predicate_personhood_address
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
      # identity_registry witness key — generated by `bun run deploy`
      # (deploy.ts) and stored in the `midnight-owner-secret-key` secret.
      # The sidecar calls setOwnerSecretKey() with it BEFORE connect();
      # without it the identity_registry contract cannot be constructed
      # and the sidecar starts degraded. Secret is managed out of band
      # via gcloud — the runtime SA has project-wide secretAccessor.
      env {
        name = "MIDNIGHT_OWNER_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = "midnight-owner-secret-key"
            version = "latest"
          }
        }
      }
      # Wallet source switch: 'seed' (devnet hex) vs 'mnemonic' (preview/mainnet BIP39).
      # Sidecar `client.ts` prefers MIDNIGHT_WALLET_MNEMONIC when both are set,
      # but we expose only ONE on Cloud Run to avoid accidental fallback.
      env {
        name = var.wallet_source == "mnemonic" ? "MIDNIGHT_WALLET_MNEMONIC" : "MIDNIGHT_WALLET_SEED"
        value_source {
          secret_key_ref {
            secret = (
              var.wallet_source == "mnemonic"
              ? google_secret_manager_secret.midnight_wallet_mnemonic.secret_id
              : google_secret_manager_secret.app["midnight-wallet-seed"].secret_id
            )
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
  count    = var.public_run_services ? 1 : 0
  name     = google_cloud_run_v2_service.sidecar.name
  location = google_cloud_run_v2_service.sidecar.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ----------------------------------------------------------------------------
# Hosted Midnight proof server (opt-in for holders on low-power devices).
# ----------------------------------------------------------------------------
#
# Multi-container Cloud Run service:
#   - main container  : our Caddy CORS proxy (built from Dockerfile.proof-server).
#     Cloud Run dispatches traffic to whichever container declares the public
#     `ports`; the proxy listens on $PORT (8080) and forwards to localhost:6300.
#   - sidecar         : `midnightntwrk/proof-server:8.0.3` unchanged. Runs on
#     localhost:6300 inside the same pod and is reachable only via the proxy.
#
# Resources: proving is single-request CPU + memory heavy. Pin 4 vCPU + 8 GiB
# RAM, concurrency=2, and use startup CPU boost so the prover loads SRS into
# memory quickly on cold start. Scale to zero (min=0) because the workload is
# spiky — most holders never enable proof-server mode.
resource "google_cloud_run_v2_service" "proof_server" {
  name     = "proof-server"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = var.proof_server_min_instances
      max_instance_count = var.proof_server_max_instances
    }

    # Proving is CPU-bound. Concurrency matches the prover's 4 vCPU (one proof
    # per core); past that, scale out via max_instance_count rather than
    # oversubscribing a box. The proof server is on the critical path for both
    # the sidecar balance leg and the holder app, so set min_instances >= 1 in
    # tfvars for the deployed env to avoid cold-start SRS fetches.
    max_instance_request_concurrency = 4

    # Cloud Run multi-container: the proxy is the ingress (declares `ports`)
    # and the upstream prover is a private sidecar reached over localhost.
    containers {
      name  = "proxy"
      image = local.service_image["proof-server"]
      ports { container_port = 8080 }
      depends_on = ["prover"]

      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      # `PORT` is a reserved env on Cloud Run — the platform injects it
      # automatically based on `ports.container_port` (8080 here). Setting
      # it manually returns "reserved env names were provided: PORT".
      env {
        name  = "UPSTREAM_HOST"
        value = "localhost"
      }
      env {
        name  = "UPSTREAM_PORT"
        value = "6300"
      }
      # Operators override the Caddy CORS allowlist per deploy. Default
      # matches `*.owlid.app`, `*.sashoush.dev`, and localhost; extend
      # via `proof_server_cors_origin_regex` to add partner wallet hosts.
      env {
        name  = "CORS_ALLOWED_ORIGIN_REGEX"
        value = var.proof_server_cors_origin_regex
      }

      startup_probe {
        tcp_socket { port = 8080 }
        initial_delay_seconds = 5
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 60
      }
    }

    containers {
      name  = "prover"
      image = "midnightntwrk/proof-server:${var.midnight_proof_server_image_tag}"

      resources {
        # ZK proving is the bottleneck; tilt the budget heavily at the
        # prover container. Cloud Run gen2 supports up to 8 vCPU + 32 GiB.
        limits            = { cpu = "4", memory = "8Gi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name  = "RUST_LOG"
        value = "info"
      }
      env {
        name  = "RUST_BACKTRACE"
        value = "full"
      }
      # The upstream image already sets `ENV PORT=6300` in its Dockerfile;
      # we cannot override it from Terraform because `PORT` is reserved
      # on Cloud Run v2. The proxy's localhost:6300 forward matches that
      # default, so no env override is needed.

      startup_probe {
        tcp_socket { port = 6300 }
        initial_delay_seconds = 5
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 120
      }
    }

    # Cold start has to fetch the universal SRS on first prove. Give the
    # request enough budget to complete that fetch + a real prove call.
    timeout = "600s"
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_artifact_registry_repository.owlid,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "proof_server_invoker" {
  count    = var.public_run_services ? 1 : 0
  name     = google_cloud_run_v2_service.proof_server.name
  location = google_cloud_run_v2_service.proof_server.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "issuer" {
  name     = "issuer"
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 1
      max_instance_count = 3
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
        limits            = { cpu = "4", memory = "4Gi" }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      # Generous startup budget — the issuer self-registers on-chain
      # (Midnight tx, ~30-90s, retried) before it binds the port.
      startup_probe {
        tcp_socket { port = 8001 }
        initial_delay_seconds = 10
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 90
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      dynamic "env" {
        for_each = merge(
          {
            ISSUER_HOST                   = "0.0.0.0"
            ISSUER_PORT                   = "8001"
            RUST_LOG                      = "info"
            APP_ENV                       = var.app_env
            CORS_ALLOWED_ORIGINS          = local.cors_origins
            RATE_LIMIT_ENABLED            = "true"
            RATE_LIMIT_MAX_REQUESTS       = "100"
            RATE_LIMIT_WINDOW_SECONDS     = "60"
            MIDNIGHT_SIDECAR_URL          = local.run_url["sidecar"]
            MIDNIGHT_SIDECAR_TIMEOUT      = tostring(var.midnight_sidecar_timeout_ms)
            MIDNIGHT_AUTO_REGISTER_ISSUER = tostring(var.midnight_auto_register_issuer)
            APP_URL                       = local.run_url["app"]
            VERIFICATION_SERVICE_URL      = local.run_url["verification"]
            DIDIT_BASE_URL                = var.didit_base_url
            # Public-facing base URL of THIS issuer. Drives the `iss`
            # claim in every issued credential (`did:web:<host>`) AND
            # the Token Status List `uri`. The Rust default is
            # `http://localhost:8001`, which produces an `iss` no other
            # service can resolve — every prod verification then fails
            # with "Issuer DID resolution failed: fetch http://localhost
            # :8001/.well-known/did.json". This MUST be set to the
            # public URL the verifier reaches us on.
            ISSUER_PUBLIC_URL             = local.run_url["issuer"]
          },
          var.didit_workflow_id == "" ? {} : { DIDIT_WORKFLOW_ID = var.didit_workflow_id },
          var.oidc_google_client_id == "" ? {} : {
            OIDC_GOOGLE_CLIENT_ID    = var.oidc_google_client_id
            OIDC_GOOGLE_REDIRECT_URI = "${local.run_url["issuer"]}/auth/callback/google"
          },
        )
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
        name = "VERIFICATION_ADMIN_API_KEY"
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
      env {
        name = "DIDIT_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["didit-api-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DIDIT_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["didit-webhook-secret"].secret_id
            version = "latest"
          }
        }
      }
      # Google OIDC client secret — mounted only when oidc_google_client_id
      # is set. Populate the `oidc-google-client-secret` value via gcloud.
      dynamic "env" {
        for_each = var.oidc_google_client_id == "" ? toset([]) : toset(["google"])
        content {
          name = "OIDC_GOOGLE_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["oidc-google-client-secret"].secret_id
              version = "latest"
            }
          }
        }
      }
      # Issuer validates the admin JWT cookie issued by verification on
      # /admin/providers/* endpoints — needs the same signing secret.
      env {
        name = "ADMIN_JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.app["admin-jwt-secret"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  # Issuer fail-fasts on startup if the sidecar is unreachable, so the
  # sidecar Cloud Run service must be applied first.
  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_version.app,
    google_secret_manager_secret_version.db_urls,
    google_artifact_registry_repository.owlid,
    google_cloud_run_v2_service.sidecar,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "issuer_invoker" {
  count    = var.public_run_services ? 1 : 0
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
      # Operator-suggested proof-server URL the holder can opt into from the
      # /settings page. The default proving mode stays `wasm` (in-process).
      OWLID_PROOF_SERVER_URL = local.run_url["proof-server"]
    }
    admin = {
      OWLID_VERIFICATION_URL = local.run_url["verification"]
      OWLID_ISSUER_URL       = local.run_url["issuer"]
    }
    verifier = {
      OWLID_VERIFICATION_URL = local.run_url["verification"]
    }
    docs = {}
  }
}

resource "google_cloud_run_v2_service" "frontend" {
  for_each = toset(["app", "admin", "verifier", "docs"])
  name     = each.key
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    containers {
      image = local.service_image[each.key]
      # app + admin run TanStack Start Nitro under Node on :3000;
      # verifier + docs are pure static (nginx) on :80.
      ports {
        container_port = contains(["verifier", "docs"], each.key) ? 80 : 3000
      }
      resources {
        # app/admin run a TanStack Start Nitro Node server; verifier/docs
        # are static nginx and need less.
        limits = {
          cpu    = contains(["app", "admin"], each.key) ? "2" : "1"
          memory = contains(["app", "admin"], each.key) ? "2Gi" : "1Gi"
        }
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.frontend_envs[each.key]
        content {
          name  = env.key
          value = env.value
        }
      }

      # The wallet (`app`) and verifier SPA both hit the verification-
      # service for predicate-attestation membership lookups (under the
      # `verify` permission). Both ship `verifier-api-key` — a
      # publishable `owlid_pk_*` key safe to bake into a browser bundle.
      # `admin` runs the operator dashboard and uses the admin-session
      # cookie, not an API key.
      dynamic "env" {
        for_each = contains(["app", "verifier"], each.key) ? toset(["api"]) : toset([])
        content {
          name = "OWLID_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["verifier-api-key"].secret_id
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
  for_each = var.public_run_services ? google_cloud_run_v2_service.frontend : {}
  name     = each.value.name
  location = each.value.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
