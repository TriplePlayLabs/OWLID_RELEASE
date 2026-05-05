locals {
  required_apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "billingbudgets.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "domains.googleapis.com",
    "dns.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each                   = toset(local.required_apis)
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}
