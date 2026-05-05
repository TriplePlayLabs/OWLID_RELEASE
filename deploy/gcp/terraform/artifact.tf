resource "google_artifact_registry_repository" "owlid" {
  location      = var.region
  repository_id = var.artifact_repo
  description   = "OwlID images"
  format        = "DOCKER"
  depends_on    = [google_project_service.enabled]
}
