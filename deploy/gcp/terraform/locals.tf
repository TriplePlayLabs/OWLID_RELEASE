data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number   = data.google_project.this.number
  image_prefix     = "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_repo}"
  sql_connection   = "${var.project_id}:${var.region}:${var.sql_instance_name}"
  runtime_sa_email = "${var.runtime_sa_id}@${var.project_id}.iam.gserviceaccount.com"

  # Cloud Run v2 URL pattern: https://<service>-<projectnum>.<region>.run.app
  run_url = {
    verification = "https://verification-${local.project_number}.${var.region}.run.app"
    issuer       = "https://issuer-${local.project_number}.${var.region}.run.app"
    sidecar      = "https://sidecar-${local.project_number}.${var.region}.run.app"
    app          = "https://app-${local.project_number}.${var.region}.run.app"
    admin        = "https://admin-${local.project_number}.${var.region}.run.app"
    verifier     = "https://verifier-${local.project_number}.${var.region}.run.app"
  }

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
