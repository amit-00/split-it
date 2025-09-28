module "services" {
  source     = "./modules/services"
  project_id = var.project_id
}

module "firebase" {
  source     = "./modules/firebase"
  project_id = var.project_id
  depends_on = [module.services]
}

module "firestore" {
  source     = "./modules/firestore"
  project_id = var.project_id
  region     = var.region
  depends_on = [module.firebase]
}

module "auth" {
  source     = "./modules/auth"
  project_id = var.project_id

  # google_oauth_client_id     = var.google_oauth_client_id
  # google_oauth_client_secret = var.google_oauth_client_secret
  # apple_client_id            = var.apple_client_id
  # apple_client_secret        = var.apple_client_secret

  depends_on = [module.services, module.firebase]
}
