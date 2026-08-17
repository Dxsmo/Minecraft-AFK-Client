#!/usr/bin/env bash
# Restores a SQLite database backup created by backup-db.sh.
# Usage: ./scripts/restore-db.sh <backup-file>
#
# IMPORTANT: This overwrites the current database. Stop the backend first.

set -euo pipefail

BACKUP_FILE="${1:?Usage: restore-db.sh <backup-file>}"
[ -f "$BACKUP_FILE" ] || { echo "Backup file not found: $BACKUP_FILE"; exit 1; }

if docker compose ps backend >/dev/null 2>&1 && [ -n "$(docker compose ps -q backend 2>/dev/null)" ]; then
  echo "Stopping backend container..."
  docker compose stop backend
  docker compose cp "$BACKUP_FILE" backend:/app/data/afk.db
  docker compose start backend
else
  echo "Restoring to local filesystem (make sure the backend process is stopped)..."
  cp "$BACKUP_FILE" backend/data/afk.db
fi

echo "Restore complete."
