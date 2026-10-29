#!/usr/bin/env bash
# Compatibility entrypoint: Java and Bedrock now use the same SoulFire build.
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$task_root/scripts/update.sh" "$@"
