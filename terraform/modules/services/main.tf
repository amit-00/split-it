resource "google_project_service" "apis" {
  for_each = toset([
    // Firebase project & rules
    "firebase.googleapis.com",
    "firebaserules.googleapis.com",

    // Firestore
    "firestore.googleapis.com",

    // Firebase Auth (Identity Platform)
    "identitytoolkit.googleapis.com",
  ])
  service = each.value
}

variable "project_id" { type = string }
