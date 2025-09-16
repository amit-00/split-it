resource "google_service_account" "tf_deployer" {
  account_id   = "tf-deployer"
  display_name = "Terraform Deployer"
}

