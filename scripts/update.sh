#!/usr/bin/env bash
# Build the whole SoulFire stack before replacing any running container.
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
recreate=""
case "$*" in
  "") ;;
  --recreate) recreate="yes" ;;
  *) echo "Usage: bash scripts/update.sh [--recreate]" >&2; exit 2 ;;
esac
# --recreate also releases native renderer caches from an earlier runtime.
# Named volumes, Microsoft logins and settings remain mounted as before.
docker compose build soulfire backend web
docker compose up -d --no-build --wait --wait-timeout 1200 ${recreate:+--force-recreate} soulfire backend web
docker compose ps
