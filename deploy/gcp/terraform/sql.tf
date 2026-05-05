resource "random_password" "db" {
  length  = 48
  special = false
}

# Persist the generated DB password as a secret. Real password is set on the
# instance below; subsequent applies do not rotate it (the resource is created-once).
resource "google_secret_manager_secret" "db_password" {
  secret_id = "db-password"

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
  lifecycle {
    ignore_changes = [secret_data] # do not rotate on every apply
  }
}

resource "google_sql_database_instance" "owlid" {
  name             = var.sql_instance_name
  database_version = var.sql_version
  region           = var.region

  settings {
    tier              = var.sql_tier
    edition           = var.sql_edition
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_HDD"
    disk_autoresize   = false

    backup_configuration {
      enabled = false
    }

    ip_configuration {
      ipv4_enabled = true
      # No authorized networks. migrate.sh allowlists ad-hoc.
    }
  }

  deletion_protection = false
  root_password       = random_password.db.result

  depends_on = [google_project_service.enabled]
}

resource "google_sql_user" "owl" {
  name     = "owl"
  instance = google_sql_database_instance.owlid.name
  password = random_password.db.result
}

resource "google_sql_database" "verification" {
  name     = "verification"
  instance = google_sql_database_instance.owlid.name
}

resource "google_sql_database" "issuer" {
  name     = "issuer"
  instance = google_sql_database_instance.owlid.name
}
