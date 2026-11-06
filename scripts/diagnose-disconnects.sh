#!/usr/bin/env bash
# Read-only snapshot. Honors COMPOSE_FILE/COMPOSE_PROJECT_NAME for other stacks.
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
task_since="${1:-2h}"
task_until="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
task_container="$(docker compose ps -a -q soulfire)"
if [[ -z "$task_container" ]]; then
  echo "Kein SoulFire-Container im gewählten Compose-Projekt gefunden." >&2
  exit 1
fi
printf 'Zeitpunkt (UTC): %s\nZeitraum: %s bis %s\n' "$task_until" "$task_since" "$task_until"
if [[ -r /proc/uptime ]]; then
  printf '\nHost-Startzeitpunkt:\n'
  uptime -s || true
fi
printf '\nSoulFire-Prozess und Containerlimits:\n'
docker inspect "$task_container" --format 'State={{json .State}} RestartCount={{.RestartCount}} MemoryLimit={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} RestartPolicy={{.HostConfig.RestartPolicy.Name}}'
printf '\nAktueller Speicher/CPU der Container:\n'
docker compose ps -a
docker stats --no-stream --format '{{.Name}} Memory={{.MemUsage}} CPU={{.CPUPerc}} PIDs={{.PIDs}}' || true
printf '\nSoulFire cgroup-Speicher (nur aktueller Containerlauf):\n'
docker exec "$task_container" sh -c '
  for metric in /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.failcnt /sys/fs/cgroup/memory/memory.limit_in_bytes; do
    if [ -r "$metric" ]; then printf "%s: " "$metric"; cat "$metric"; fi
  done
' || true
printf '\nDocker-Ereignisse für SoulFire (soweit vom Daemon vorgehalten):\n'
docker events --since "$task_since" --until "$task_until" --filter "container=$task_container" \
  --filter event=oom --filter event=die --filter event=start --filter event=stop \
  --filter event=kill --filter event=restart --filter event=destroy \
  --filter event=pause --filter event=unpause --filter event=health_status \
  --format '{{.Time}} {{.Action}} exitCode={{index .Actor.Attributes "exitCode"}} signal={{index .Actor.Attributes "signal"}}' || true
printf '\nSoulFire-Logs (maximal 500 Zeilen; vor Weitergabe Anmeldecodes entfernen):\n'
docker logs --timestamps --since "$task_since" --until "$task_until" --tail 500 "$task_container" 2>&1 || true
printf '\nHinweis: OOMKilled=false schließt einen früheren OOM-Kill nicht aus.\n'
printf 'Bei Host-Neustart vorherigen Boot prüfen: journalctl --list-boots; journalctl -b -1 -n 120 --no-pager; journalctl -b -1 -k --no-pager\n'
