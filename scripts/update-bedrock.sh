#!/usr/bin/env bash
# Update Bedrock and the website while keeping the installed Java executable.
# Use the normal Dockerfile when backend/rust-bot changes need to be deployed.
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"

task_container="$(docker compose ps -q backend)"
if [[ -z "$task_container" ]]; then
  echo "Kein laufendes Backend gefunden. Zuerst den normalen Docker-Build verwenden." >&2
  exit 1
fi
task_node_major="$(docker compose exec -T backend node -p 'process.versions.node.split(".")[0]')"
if [[ "$task_node_major" != "24" ]]; then
  echo "Dieser Schnellweg benötigt das bereits installierte Node-24-Backend. Zuerst normal aktualisieren." >&2
  exit 1
fi

task_image="$(docker inspect --format '{{.Image}}' "$task_container")"
task_tag="afk-java-reuse:$(date +%Y%m%d%H%M%S)-$$"
task_override="$(mktemp)"
cleanup() {
  rm -f "$task_override"
  docker image rm "$task_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker image tag "$task_image" "$task_tag"

cat > "$task_override" <<EOF
services:
  backend:
    build:
      dockerfile: Dockerfile.node-update
      args:
        BACKEND_BASE_IMAGE: "$task_tag"
EOF

echo "Aktualisiere Bedrock und Website; das installierte Java-Binary wird übernommen."
# Build first, so a build failure leaves the running containers in place.
docker compose -f "$task_root/docker-compose.yml" -f "$task_override" build backend web
docker compose up -d --no-build --wait backend web
docker compose ps
