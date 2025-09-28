provider "google" {
  project         = var.project_id
  region          = var.region
  billing_project = var.project_id
}

provider "google-beta" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

