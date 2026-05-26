data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number   = data.google_project.this.number
  image_prefix     = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}"
  sql_connection   = "${var.project_id}:${var.region}:${var.sql_instance_name}"
  runtime_sa_email = "${var.runtime_sa_id}@${var.project_id}.iam.gserviceaccount.com"

  # Cloud Run URL pattern is project-region specific. The hash + region-short
  # suffix is stable for a given (project, region) — discovered after the
  # first apply. Override `run_url_hash` in terraform.tfvars to match.
  # (Cloud Run v2 also exposes <service>-<projnum>.<region>.run.app for some
  # projects, but the hash form is universally available.)
  run_url_suffix = "${var.run_url_hash}-${local.region_short}.a.run.app"

  # Once domain mappings are live, services use their *.owlid.app URLs.
  # Toggle var.use_custom_domain_urls = false to revert to .run.app form
  # (e.g. before certs provision or for an internal-only deploy).
  run_url = var.use_custom_domain_urls ? {
    verification   = "https://api.${var.domain}"
    issuer         = "https://issuer.${var.domain}"
    sidecar        = "https://sidecar.${var.domain}"
    "proof-server" = "https://proofs.${var.domain}"
    app            = "https://wallet.${var.domain}"
    admin          = "https://admin.${var.domain}"
    verifier       = "https://verifier.${var.domain}"
    docs           = "https://docs.${var.domain}"
    } : {
    verification   = "https://verification-${local.run_url_suffix}"
    issuer         = "https://issuer-${local.run_url_suffix}"
    sidecar        = "https://sidecar-${local.run_url_suffix}"
    "proof-server" = "https://proof-server-${local.run_url_suffix}"
    app            = "https://app-${local.run_url_suffix}"
    admin          = "https://admin-${local.run_url_suffix}"
    verifier       = "https://verifier-${local.run_url_suffix}"
    docs           = "https://docs-${local.run_url_suffix}"
  }

  # Map full GCP region IDs to the 2-char suffix Cloud Run uses in URLs.
  region_short_map = {
    "europe-west1"    = "ew"
    "europe-west4"    = "ew4"
    "us-central1"     = "uc"
    "us-east1"        = "ue"
    "asia-east1"      = "ae"
    "asia-southeast1" = "as"
  }
  region_short = lookup(local.region_short_map, var.region, "ew")

  service_image = {
    for k, v in local.run_url : k => (
      var.use_placeholder_images ? var.placeholder_image : "${local.image_prefix}/${k}:${var.image_tag}"
    )
  }

  # CORS allowlist for the backend services. Always includes the predictable
  # frontend Cloud Run URLs; extra entries (e.g. custom-domain origins) come
  # from var.extra_cors_origins.
  cors_origins = join(",", concat(
    [
      local.run_url["app"],
      local.run_url["admin"],
      local.run_url["verifier"],
    ],
    var.extra_cors_origins,
  ))
}
