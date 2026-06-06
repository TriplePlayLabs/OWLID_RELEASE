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

# Public-facing subdomain mappings. Each Cloud Run service gets a CNAME
# pointing at ghs.googlehosted.com plus a Cloud Run domain mapping that
# requests a Google-managed cert.

locals {
  subdomains = {
    api      = google_cloud_run_v2_service.verification.name
    issuer   = google_cloud_run_v2_service.issuer.name
    sidecar  = google_cloud_run_v2_service.sidecar.name
    proofs   = google_cloud_run_v2_service.proof_server.name
    wallet   = google_cloud_run_v2_service.frontend["app"].name
    admin    = google_cloud_run_v2_service.frontend["admin"].name
    verifier = google_cloud_run_v2_service.frontend["verifier"].name
    docs     = google_cloud_run_v2_service.frontend["docs"].name
  }
}

resource "google_cloud_run_domain_mapping" "subdomain" {
  for_each = local.subdomains
  location = var.region
  name     = "${each.key}.${var.domain}"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = each.value
  }

  # The google provider defaults spec.certificate_mode to AUTOMATIC, but
  # these mappings were created with it unset. Reconciling it force-replaces
  # a working, already-provisioned Google-managed cert (a brief TLS outage on
  # a live subdomain). The cert is already automatic in effect, so ignore the
  # attribute instead of churning it.
  lifecycle {
    ignore_changes = [spec[0].certificate_mode]
  }
}

resource "google_dns_record_set" "cname" {
  for_each     = local.subdomains
  managed_zone = google_dns_managed_zone.owlid_app.name
  name         = "${each.key}.${var.domain}."
  type         = "CNAME"
  ttl          = 300
  rrdatas      = ["ghs.googlehosted.com."]
}
