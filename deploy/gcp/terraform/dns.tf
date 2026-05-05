# Cloud DNS managed zone is created out-of-band by Cloud Domains during
# `gcloud domains registrations register`. Imported here so subsequent
# record-set changes are tracked.

resource "google_dns_managed_zone" "owlid_app" {
  name        = var.dns_zone_name
  dns_name    = "${var.domain}."
  description = "${var.domain} managed zone"
  visibility  = "public"
  depends_on  = [google_project_service.enabled]
}

# Domain mappings + DNS records get added once domain registration is ACTIVE.
# Stub locals for later — uncomment when ready.
#
# locals {
#   subdomains = {
#     api      = google_cloud_run_v2_service.verification.name
#     issuer   = google_cloud_run_v2_service.issuer.name
#     app      = google_cloud_run_v2_service.frontend["app"].name
#     admin    = google_cloud_run_v2_service.frontend["admin"].name
#     verifier = google_cloud_run_v2_service.frontend["verifier"].name
#   }
# }
#
# resource "google_cloud_run_domain_mapping" "subdomain" {
#   for_each = local.subdomains
#   location = var.region
#   name     = "${each.key}.${var.domain}"
#   metadata { namespace = var.project_id }
#   spec     { route_name = each.value }
# }
#
# resource "google_dns_record_set" "cname" {
#   for_each     = local.subdomains
#   managed_zone = google_dns_managed_zone.owlid_app.name
#   name         = "${each.key}.${var.domain}."
#   type         = "CNAME"
#   ttl          = 300
#   rrdatas      = ["ghs.googlehosted.com."]
# }
