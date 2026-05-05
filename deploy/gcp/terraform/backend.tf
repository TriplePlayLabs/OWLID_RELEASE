terraform {
  backend "gcs" {
    bucket = "owlid-491411-tfstate"
    prefix = "owlid/dev"
  }
}
