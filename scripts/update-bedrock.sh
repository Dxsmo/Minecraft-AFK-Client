#!/usr/bin/env bash
# Compatibility entrypoint: Java and Bedrock ship in the same backend image.
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$task_root/scripts/update.sh" "$@"
