resource "google_billing_budget" "dev" {
  billing_account = var.billing_account
  display_name    = "owlid-dev-${var.budget_amount_eur}eur"

  budget_filter {
    projects = ["projects/${local.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = "EUR"
      units         = var.budget_amount_eur
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  depends_on = [google_project_service.enabled]
}
