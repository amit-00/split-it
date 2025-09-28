// variables.tf
variable "project_id" {
  description = "Existing GCP project ID"
  type        = string
}

variable "region" {
  description = "Default region (also used for Firestore location)"
  type        = string
  default     = "northamerica-northeast2"
}

// Identity providers (optional)
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
