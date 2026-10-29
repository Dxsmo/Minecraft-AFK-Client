#!/usr/bin/env bash
# Consistent backup of website data AND Microsoft/SoulFire account caches.
# Stops only the currently running account services briefly, then resumes them.
set -euo pipefail
umask 077
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
task_destination="${1:-$task_root/backups/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$task_destination"
task_resume=()
for task_service in soulfire backend; do
  if [[ -n "$(docker compose ps --status running -q "$task_service")" ]]; then task_resume+=("$task_service"); fi
done
resume_services() { if [[ ${#task_resume[@]} -gt 0 ]]; then docker compose start "${task_resume[@]}" >/dev/null; fi; }
trap resume_services EXIT
if [[ ${#task_resume[@]} -gt 0 ]]; then docker compose stop "${task_resume[@]}"; fi
# The backend's read-only SoulFire mount also works before the first migration:
# a newly created, empty SoulFire volume is still a valid backup.
docker compose run --rm --no-deps -T --entrypoint tar backend -C /app/data -czf - . > "$task_destination/backend-data.tar.gz.tmp"
gzip -t "$task_destination/backend-data.tar.gz.tmp"
mv "$task_destination/backend-data.tar.gz.tmp" "$task_destination/backend-data.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar backend -C /soulfire-data -czf - . > "$task_destination/soulfire-data.tar.gz.tmp"
gzip -t "$task_destination/soulfire-data.tar.gz.tmp"
mv "$task_destination/soulfire-data.tar.gz.tmp" "$task_destination/soulfire-data.tar.gz"
printf 'Vollständige Sicherung: %s\n' "$task_destination"
