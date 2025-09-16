variable "project_id" {
  type        = string
  description = "The ID of the project to deploy to"
}

variable "region" {
  type        = string
  description = "The region to deploy to"
}

variable "gh_owner" {
  type        = string
  description = "The owner of the GitHub repository"
}

variable "gh_repo" {
  type        = string
  description = "The name of the GitHub repository"
}

variable "gh_ref" {
  type        = string
  default     = "refs/heads/main"
  description = "The ref of the GitHub repository"
}
