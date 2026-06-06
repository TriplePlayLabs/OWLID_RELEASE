variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "Default region for all regional resources"
  default     = "europe-west1"
}

variable "artifact_repo" {
  type    = string
  default = "owlid"
}

variable "sql_instance_name" {
  type    = string
  default = "owlid-pg"
}

variable "sql_tier" {
  type    = string
  default = "db-f1-micro"
}

variable "sql_edition" {
  type    = string
  default = "ENTERPRISE"
}

variable "sql_version" {
  type    = string
  default = "POSTGRES_16"
}

variable "runtime_sa_id" {
  type        = string
  default     = "owlid-run"
  description = "Account ID (left of @) for the Cloud Run runtime service account"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID, format XXXXXX-XXXXXX-XXXXXX"
}

variable "budget_amount_eur" {
  type    = number
  default = 300
}

variable "domain" {
  type    = string
  default = "owlid.app"
}

variable "dns_zone_name" {
  type        = string
  default     = "owlid-app"
  description = "Cloud DNS managed zone name (existing — pre-created via Cloud Domains)"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Image tag for all Cloud Run services. Use git sha for prod."
}

variable "run_url_hash" {
  type        = string
  default     = "jlctpv2qvq"
  description = "Project-region specific 10-char hash inserted into Cloud Run URLs (https://<service>-<hash>-<region>.a.run.app). Discovered after first apply via gcloud run services describe."
}

variable "public_run_services" {
  type        = bool
  default     = true
  description = "If true, grant roles/run.invoker to allUsers on every Cloud Run service. The org policy `iam.allowedPolicyMemberDomains` may block this — set to false (and override the org policy out-of-band) if it does."
}

variable "use_custom_domain_urls" {
  type        = bool
  default     = true
  description = "If true, services reference each other and CORS allowlists via https://*.owlid.app. Requires the domain mappings + certs to be live. Flip to false during initial provisioning or if certs aren't ready."
}

variable "placeholder_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = "Used on first apply before real images exist. Override per service if needed."
}

variable "use_placeholder_images" {
  type        = bool
  default     = false
  description = "When true, all Cloud Run services use placeholder_image. Flip to false after build-all.sh succeeds."
}

variable "app_env" {
  type        = string
  default     = "development"
  description = "APP_ENV passed to verification + issuer. 'production' enables strict CORS / secret-hardness / cookie-secure checks."
}

variable "admin_cookie_domain" {
  type        = string
  default     = ""
  description = "Apex domain for the admin auth cookie (e.g. 'owlid.app'). Leave empty until a custom domain is wired — Cloud Run's '*.run.app' is on the Public Suffix List so subdomain cookies can't span services there."
}

variable "extra_cors_origins" {
  type        = list(string)
  default     = []
  description = "Additional CORS origins to allow on top of the predictable Cloud Run frontend URLs."
}

variable "midnight_auto_register_issuer" {
  type    = bool
  default = false
}

variable "midnight_sidecar_timeout_ms" {
  type    = number
  default = 30000
}

# -- Midnight network configuration ----------------------------------
# Public on-chain config — contract addresses + endpoints are not
# secrets (they're observable on-chain). They are still parameterised
# so Cloud Run revisions don't need a rebuild to switch networks.

variable "midnight_network_id" {
  type        = string
  default     = "undeployed"
  description = "Midnight network: 'undeployed' (local devnet — placeholders), 'preview' (testnet), 'mainnet'."
  validation {
    condition     = contains(["undeployed", "devnet", "preview", "testnet", "mainnet"], var.midnight_network_id)
    error_message = "midnight_network_id must be one of: undeployed, devnet, preview, testnet, mainnet."
  }
}

variable "midnight_node_ws_url" {
  type        = string
  default     = "ws://placeholder:9944"
  description = "Midnight node WebSocket URL. Preview: wss://rpc.preview.midnight.network."
}

variable "midnight_indexer_uri" {
  type        = string
  default     = "http://placeholder:8088/api/v3/graphql"
  description = "Midnight indexer GraphQL URL. Preview: https://indexer.preview.midnight.network/api/v4/graphql."
}

variable "midnight_indexer_ws_uri" {
  type        = string
  default     = "ws://placeholder:8088/api/v3/graphql/ws"
  description = "Midnight indexer GraphQL WS URL. Preview: wss://indexer.preview.midnight.network/api/v4/graphql/ws."
}

variable "midnight_proof_server_uri" {
  type        = string
  default     = "http://placeholder:6300"
  description = "Proof server URL the sidecar uses for its own in-process proving. Defaults to a placeholder; in production point at the proofs.<domain> Cloud Run service or Midnight's hosted preview."
}

variable "midnight_proof_server_image_tag" {
  type        = string
  default     = "8.0.3"
  description = "Tag of midnightntwrk/proof-server pulled into the proof-server Cloud Run sidecar container. MUST match the preview/devnet's proof-server version — confirm at https://proof-server.preview.midnight.network/version before bumping."
}

variable "proof_server_min_instances" {
  type        = number
  default     = 0
  description = "Minimum Cloud Run instances for the hosted proof server. 0 lets it scale to zero (cheaper but ~30s cold start to fetch SRS); set to 1 for hot-warm production."
}

variable "proof_server_max_instances" {
  type        = number
  default     = 40
  description = "Maximum Cloud Run instances for the hosted proof server. ZK proving is CPU-bound and per-request concurrency is 4, so 40 instances ~= 160 concurrent proofs. Size by peak holder + sidecar QPS."
}

variable "proof_server_cors_origin_regex" {
  type        = string
  default     = "^https?://(localhost(:[0-9]+)?|.*\\.sashoush\\.dev|.*\\.owlid\\.app)$"
  description = "Caddy regex matched against the browser `Origin` header in the proof-server proxy. Must cover every wallet/SPA that needs to call the proof server cross-origin. Tight by default — over-broad regexes defeat CORS's purpose."
}

variable "midnight_issuer_registry_address" {
  type        = string
  default     = ""
  description = "issuer_registry contract address (hex). Populate after `bun run deploy`."
}

variable "midnight_revocation_registry_address" {
  type        = string
  default     = ""
  description = "revocation_registry contract address (hex). Populate after deploy."
}

variable "midnight_identity_registry_address" {
  type        = string
  default     = ""
  description = "identity_registry contract address (hex). Populate after deploy."
}

# One contract per predicate kind (Midnight per-extrinsic block-weight cap).
# All seven are deployed by `bun run deploy` alongside the three registries.
variable "midnight_predicate_age_address" {
  type        = string
  default     = ""
  description = "predicate_age contract address (hex). Populate after deploy."
}

variable "midnight_predicate_kyc_address" {
  type        = string
  default     = ""
  description = "predicate_kyc contract address (hex). Populate after deploy."
}

variable "midnight_predicate_residency_address" {
  type        = string
  default     = ""
  description = "predicate_residency contract address (hex). Populate after deploy."
}

variable "midnight_predicate_email_address" {
  type        = string
  default     = ""
  description = "predicate_email contract address (hex). Populate after deploy."
}

variable "midnight_predicate_nationality_address" {
  type        = string
  default     = ""
  description = "predicate_nationality contract address (hex). Populate after deploy."
}

variable "midnight_predicate_age_range_address" {
  type        = string
  default     = ""
  description = "predicate_age_range contract address (hex). Populate after deploy."
}

variable "midnight_predicate_personhood_address" {
  type        = string
  default     = ""
  description = "predicate_personhood contract address (hex). Populate after deploy."
}

variable "wallet_source" {
  type        = string
  default     = "seed"
  description = "Which wallet env var the sidecar reads: 'seed' (hex, devnet) or 'mnemonic' (BIP39, preview/mainnet). Real value lives in Secret Manager; TF only wires which one is exposed."
  validation {
    condition     = contains(["seed", "mnemonic"], var.wallet_source)
    error_message = "wallet_source must be 'seed' or 'mnemonic'."
  }
}

variable "oidc_google_client_id" {
  type        = string
  default     = ""
  description = "Google OAuth client ID for issuer-service OIDC sign-in. Empty disables the Google provider. The matching client secret is the `oidc-google-client-secret` Secret Manager secret (populate via gcloud). The OAuth client's authorized redirect URI must be https://issuer.<domain>/auth/callback/google."
}

variable "didit_workflow_id" {
  type        = string
  default     = ""
  description = "Didit workflow ID (non-secret). Empty means Didit provider stays disabled in issuer."
}

variable "didit_base_url" {
  type        = string
  default     = "https://verification.didit.me"
  description = "Didit API base URL. Default is the production Didit endpoint."
}
