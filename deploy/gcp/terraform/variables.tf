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
