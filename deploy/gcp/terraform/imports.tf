# Existing resources created out-of-band before Terraform was introduced.
# These imports run on first `terraform apply` so TF claims them instead of
# trying to create duplicates. Once state is populated they are no-ops.
#
# Comment out individual blocks if you don't have that resource.

# Artifact Registry repo — keep so we don't lose already-pushed images.
import {
  to = google_artifact_registry_repository.owlid
  id = "projects/owlid-491411/locations/europe-west1/repositories/owlid"
}

# DNS zone created by `gcloud domains registrations register`.
import {
  to = google_dns_managed_zone.owlid_app
  id = "projects/owlid-491411/managedZones/owlid-app"
}
