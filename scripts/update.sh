#!/usr/bin/env bash
# Build the whole SoulFire stack before replacing any running container.
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
docker compose build soulfire backend web
docker compose up -d --no-build --wait --wait-timeout 1200 soulfire backend web
docker compose ps
