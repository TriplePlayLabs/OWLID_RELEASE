// Alerting for the OwlID production stack.
//
// Written after a Midnight preview testnet reset took issuer.owlid.app down
// for four days without anyone noticing. Each policy below corresponds to a
// signal that outage produced and nobody was watching:
//
//   uptime            issuer.owlid.app served 500 on every route
//   chain_degraded    the sidecar logged connect failures on a loop
//   issuer_unregistered  the issuer could not register its key on-chain
//   run_5xx           /trusted-issuers failed 4225 times
//   startup_failure   Cloud Run reported "instance could not start"
//
// The uptime checks depend on each service returning a non-2xx from /health
// when it is not actually usable. A health endpoint that answers 200 while
// degraded defeats every policy here.

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_emails)

  project      = var.project_id
  display_name = "OwlID alerts — ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.enabled]
}

locals {
  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  // Services whose /health must stay 2xx. The frontends are excluded: they are
  // static bundles whose failure modes the backend checks already cover.
  health_checked = {
    verification = "api.${var.domain}"
    issuer       = "issuer.${var.domain}"
    sidecar      = "sidecar.${var.domain}"
  }
}

// ---------------------------------------------------------------------------
// Uptime checks
// ---------------------------------------------------------------------------

resource "google_monitoring_uptime_check_config" "health" {
  for_each = local.health_checked

  project      = var.project_id
  display_name = "owlid-${each.key}-health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each = local.health_checked

  project      = var.project_id
  display_name = "OwlID ${each.key} is down"
  combiner     = "OR"
  severity     = "CRITICAL"

  documentation {
    content   = <<-EOT
      `${each.value}/health` is failing.

      Check in this order:
        1. `curl -s https://${each.value}/health` — the body names the reason.
        2. `curl -s https://sidecar.${var.domain}/health` — a degraded chain
           client fails the issuer and verification services downstream.
        3. Confirm the Midnight contracts still exist. A public testnet reset
           wipes them, and every `*_ADDRESS` in terraform.tfvars must then be
           repopulated after `just deploy-contracts`:
           `curl -s -X POST ${var.midnight_indexer_uri} -H 'content-type: application/json' \
              -d '{"query":"query{contractAction(address:\"<addr>\"){__typename}}"}'`
           A `null` result means the contract is gone.
        4. `gcloud run services logs read ${each.key} --region ${var.region}`
    EOT
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "${each.key} uptime check failing"
    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.check_id=\"${google_monitoring_uptime_check_config.health[each.key].uptime_check_id}\"",
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      // Two consecutive 60s failures from a majority of probe locations, so a
      // single flaky region does not page.
      duration = "120s"
      trigger {
        count = 1
      }
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }

  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "3600s"
  }
}

// ---------------------------------------------------------------------------
// Log-based signals
// ---------------------------------------------------------------------------
//
// These catch the failure BEFORE it becomes downtime — the sidecar retry loop
// logs on every failed attempt, so the alert fires while the service is still
// serving cached state.

resource "google_logging_metric" "chain_connect_failed" {
  project = var.project_id
  name    = "owlid/sidecar_chain_connect_failed"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="sidecar"
    jsonPayload.event="sidecar.client.connect_failed"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_logging_metric" "issuer_registration_failed" {
  project = var.project_id
  name    = "owlid/issuer_registration_failed"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="issuer"
    severity>=ERROR
    textPayload:"issuer on-chain registration failed"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.enabled]
}

resource "google_logging_metric" "container_start_failed" {
  project = var.project_id
  name    = "owlid/container_start_failed"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    textPayload:"The request failed because the instance could not start successfully"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.enabled]
}

locals {
  log_alerts = {
    chain_degraded = {
      metric  = google_logging_metric.chain_connect_failed.name
      title   = "Midnight chain client cannot connect"
      body    = "The sidecar failed to reach the Midnight chain. If the error names missing contracts, the testnet was reset — redeploy contracts and repopulate every `*_ADDRESS` in terraform.tfvars."
      seconds = "300s"
    }
    issuer_unregistered = {
      metric  = google_logging_metric.issuer_registration_failed.name
      title   = "Issuer cannot register its key on-chain"
      body    = "Credentials issued while this is failing will not verify. Usually downstream of the sidecar's chain connection."
      seconds = "600s"
    }
    startup_failure = {
      metric  = google_logging_metric.container_start_failed.name
      title   = "A Cloud Run container is failing to start"
      body    = "A service is crash-looping. `gcloud run services logs read <service> --region ${var.region}` shows the startup error."
      seconds = "300s"
    }
  }
}

resource "google_monitoring_alert_policy" "log_based" {
  for_each = local.log_alerts

  project      = var.project_id
  display_name = "OwlID: ${each.value.title}"
  combiner     = "OR"
  severity     = "ERROR"

  documentation {
    content   = each.value.body
    mime_type = "text/markdown"
  }

  conditions {
    display_name = each.value.title
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${each.value.metric}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = each.value.seconds
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }

  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "3600s"
  }
}

// ---------------------------------------------------------------------------
// Server errors
// ---------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "run_5xx" {
  project      = var.project_id
  display_name = "OwlID: sustained 5xx from a Cloud Run service"
  combiner     = "OR"
  severity     = "ERROR"

  documentation {
    content   = "A service is returning 5xx. Check `/health` on the affected service first — a degraded chain client surfaces here as 500s on `/trusted-issuers`."
    mime_type = "text/markdown"
  }

  conditions {
    display_name = "5xx responses over 5 minutes"
    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"run.googleapis.com/request_count\"",
        "resource.type=\"cloud_run_revision\"",
        "metric.label.response_code_class=\"5xx\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  notification_channels = local.notification_channels
  alert_strategy {
    auto_close = "3600s"
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
//
// The panels are ordered by the question an operator asks during an incident:
// is it up, what is failing, how slow, is the chain healthy, is the data layer
// healthy. Every log-based row corresponds to an alert policy above, so the
// dashboard and the pager never disagree about what "broken" means.

locals {
  run_filter = "resource.type=\"cloud_run_revision\""
}

resource "google_monitoring_dashboard" "owlid" {
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "OwlID — production"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width = 12, height = 1, xPos = 0, yPos = 0
          widget = {
            text = {
              content = "**Is it up?** A red uptime row means the service is failing `/health`. Chain-degraded rows below usually explain why."
              format  = "MARKDOWN"
            }
          }
        },
        {
          width = 6, height = 4, xPos = 0, yPos = 1
          widget = {
            title = "Service availability (/health uptime)"
            xyChart = {
              dataSets = [{
                plotType       = "LINE"
                legendTemplate = "$${resource.labels.host}"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_FRACTION_TRUE"
                      crossSeriesReducer = "REDUCE_MEAN"
                      groupByFields      = ["resource.label.host"]
                    }
                  }
                }
              }]
              yAxis = { label = "fraction passing", scale = "LINEAR" }
            }
          }
        },
        {
          width = 6, height = 4, xPos = 6, yPos = 1
          widget = {
            title = "5xx by service"
            xyChart = {
              dataSets = [{
                plotType       = "LINE"
                legendTemplate = "$${resource.labels.service_name}"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/request_count\" AND ${local.run_filter} AND metric.label.response_code_class=\"5xx\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_DELTA"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "5xx responses", scale = "LINEAR" }
            }
          }
        },
        {
          width = 6, height = 4, xPos = 0, yPos = 5
          widget = {
            title = "Request rate by service"
            xyChart = {
              dataSets = [{
                plotType       = "LINE"
                legendTemplate = "$${resource.labels.service_name}"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/request_count\" AND ${local.run_filter}"
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "req/s", scale = "LINEAR" }
            }
          }
        },
        {
          width = 6, height = 4, xPos = 6, yPos = 5
          widget = {
            title = "Request latency p95"
            xyChart = {
              dataSets = [{
                plotType       = "LINE"
                legendTemplate = "$${resource.labels.service_name}"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/request_latencies\" AND ${local.run_filter}"
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_95"
                      crossSeriesReducer = "REDUCE_MEAN"
                      groupByFields      = ["resource.label.service_name"]
                    }
                  }
                }
              }]
              yAxis = { label = "ms", scale = "LINEAR" }
            }
          }
        },
        {
          width = 12, height = 1, xPos = 0, yPos = 9
          widget = {
            text = {
              content = "**Chain health.** Any non-zero series here means the Midnight client cannot reach its contracts — check whether a testnet reset removed them (RUNBOOK §3.0b)."
              format  = "MARKDOWN"
            }
          }
        },
        {
          width = 4, height = 4, xPos = 0, yPos = 10
          widget = {
            title = "Chain connect failures (sidecar)"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.chain_connect_failed.name}\" AND ${local.run_filter}"
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_DELTA"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width = 4, height = 4, xPos = 4, yPos = 10
          widget = {
            title = "Issuer on-chain registration failures"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.issuer_registration_failed.name}\" AND ${local.run_filter}"
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_DELTA"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width = 4, height = 4, xPos = 8, yPos = 10
          widget = {
            title = "Container start failures (crash-loop)"
            xyChart = {
              dataSets = [{
                plotType = "STACKED_BAR"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.container_start_failed.name}\" AND ${local.run_filter}"
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_DELTA"
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width = 6, height = 4, xPos = 0, yPos = 14
          widget = {
            title = "Container instances by service"
            xyChart = {
              dataSets = [{
                plotType       = "LINE"
                legendTemplate = "$${resource.labels.service_name}"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"run.googleapis.com/container/instance_count\" AND ${local.run_filter}"
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_MEAN"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.service_name"]
                    }
                  }
                }
              }]
            }
          }
        },
        {
          width = 6, height = 4, xPos = 6, yPos = 14
          widget = {
            title = "Cloud SQL CPU"
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\""
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                  }
                }
              }]
              yAxis = { label = "utilization", scale = "LINEAR" }
            }
          }
        },
      ]
    }
  })

  depends_on = [google_project_service.enabled]
}
