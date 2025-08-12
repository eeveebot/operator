// docker-bake.hcl
target "docker-metadata-action" {}

target "build" {
  inherits = ["docker-metadata-action"]
  context = "./src/"
  dockerfile = "Dockerfile"
  platforms = [
    "linux/amd64",
    "linux/arm64",
  ]
}
