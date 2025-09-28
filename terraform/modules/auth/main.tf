resource "google_identity_platform_config" "default" {
  provider = google-beta
  project  = var.project_id
  sign_in {
    allow_duplicate_emails = false
    email {
      enabled           = true
      password_required = true
    }
    phone_number { enabled = true }
    anonymous { enabled = false }
  }
  authorized_domains = [
    "localhost",
  ]
  lifecycle { prevent_destroy = true }
}

# resource "google_identity_platform_default_supported_idp_config" "google" {
#   enabled       = var.google_oauth_client_id != null && var.google_oauth_client_secret != null
#   idp_id        = "google.com"
#   client_id     = var.google_oauth_client_id
#   client_secret = var.google_oauth_client_secret
#   project       = var.project_id
# }

# resource "google_identity_platform_default_supported_idp_config" "apple" {
#   enabled       = var.apple_client_id != null && var.apple_client_secret != null
#   idp_id        = "apple.com"
#   client_id     = var.apple_client_id
#   client_secret = var.apple_client_secret
#   project       = var.project_id
# }

variable "project_id" { type = string }
# variable "google_oauth_client_id" {
#   type    = string
#   default = null
# }
# variable "google_oauth_client_secret" {
#   type    = string
#   default = null
# }
# variable "apple_client_id" {
#   type    = string
#   default = null
# }
# variable "apple_client_secret" {
#   type    = string
#   default = null
# }

output "signin_methods" {
  value = {
    email = true
    phone = true
    # google = google_identity_platform_default_supported_idp_config.google.enabled
    # apple  = google_identity_platform_default_supported_idp_config.apple.enabled
  }
}
