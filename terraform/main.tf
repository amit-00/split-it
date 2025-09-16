variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "gh_owner" {
  type = string
}

variable "gh_repo" {
  type = string
}

variable "gh_ref" {
  type    = string
  default = "refs/heads/main"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_service_account" "tf-deployer" {
  account_id   = "tf-deployer"
  display_name = "Terraform Deployer"
}

resource "google_project_iam_member" "tf_roles" {
  for_each = toset([
    "roles/run.admin",
    "roles/cloudfunctions.admin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/storage.admin",
    "roles/logging.admin",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.tf_deployer.email}"
}

resource "google_service_account_iam_member" "allow_user_impersonation" {
  service_account_id = google_service_account.tf_deployer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "user:amitv05230@gmail.com"
}

resource "google_iam_workload_identity_pool" "gh_pool" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub OIDC Pool"
}

resource "google_iam_workload_identity_pool_provider" "gh_provider" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.gh_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC Provider"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "gha_impersonate_tf_deployer" {
  service_account_id = google_service_account.tf_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.gh_pool.name}/attribute.repository/${var.gh_owner}/${var.gh_repo}"

  condition {
    title       = "restrict_to_ref"
    description = "Only allow a specific branch or tag"
    expression  = "attribute.ref == \"${var.gh_ref}\""
  }
}

output "tf_service_account_email" {
  value = google_service_account.tf_deployer.email
}

output "workload_identity_provider_name" {
  value = google_iam_workload_identity_pool_provider.gh_provider.name
}
