#!/usr/bin/env bash
# Creates a timestamped backup of the SQLite database used by the backend.
# Usage: ./scripts/backup-db.sh [output-directory]
#
# Works both for a bare-metal/systemd install (DB at backend/data/afk.db)
# and for the Docker Compose setup (DB inside the backend_data volume).

set -euo pipefail

OUT_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

if docker compose ps backend >/dev/null 2>&1 && [ -n "$(docker compose ps -q backend 2>/dev/null)" ]; then
  echo "Backing up database from the running Docker container..."
  docker compose exec -T backend sh -c 'cat /app/data/afk.db' > "$OUT_DIR/afk-$TIMESTAMP.db"
else
  echo "Backing up database from local filesystem..."
  cp backend/data/afk.db "$OUT_DIR/afk-$TIMESTAMP.db"
fi

echo "Backup written to $OUT_DIR/afk-$TIMESTAMP.db"
