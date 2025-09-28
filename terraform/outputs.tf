output "firebase_project" {
  value = module.firebase.project_id
}

output "firestore_db" {
  value = module.firestore.database_id
}

output "auth_config" {
  value = module.auth.signin_methods
}
