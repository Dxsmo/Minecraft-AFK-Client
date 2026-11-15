#!/usr/bin/env bash
# Build both edition engines and the website before replacing any running container.
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
recreate=""
case "$*" in
  "") ;;
  --recreate) recreate="yes" ;;
  *) echo "Usage: bash scripts/update.sh [--recreate]" >&2; exit 2 ;;
esac
# --recreate restarts the backend and all isolated account processes.
# Named volumes, Microsoft logins and settings remain mounted as before.
# One image build at a time by default: keep RAM available for accounts on the
# Pi while reusing Docker's existing layers/download caches. Override on larger
# hosts with COMPOSE_PARALLEL_LIMIT=2 (or another Compose-supported limit).
COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}" docker compose build backend web
docker compose up -d --no-build --remove-orphans --wait --wait-timeout 1200 ${recreate:+--force-recreate} backend web
docker compose ps
