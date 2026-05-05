resource "google_service_account" "runtime" {
  account_id   = var.runtime_sa_id
  display_name = "OwlID Cloud Run runtime"
  depends_on   = [google_project_service.enabled]
}

locals {
  runtime_sa_roles = [
    "roles/secretmanager.secretAccessor",
    "roles/cloudsql.client",
  ]
  cloudbuild_sa_roles = [
    "roles/storage.objectViewer",
    "roles/storage.objectAdmin",
    "roles/artifactregistry.writer",
    "roles/logging.logWriter",
    "roles/cloudbuild.builds.builder",
  ]
  cloudbuild_sa_email = "${local.project_number}-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_member" "runtime" {
  for_each = toset(local.runtime_sa_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "cloudbuild" {
  for_each = toset(local.cloudbuild_sa_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${local.cloudbuild_sa_email}"
}
