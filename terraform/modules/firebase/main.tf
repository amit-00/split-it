// firebase.tf
resource "google_firebase_project" "this" {
  provider = google-beta
  project  = var.project_id
}

variable "project_id" { type = string }

output "project_id" {
  value = var.project_id
}
