#!/usr/bin/env bash
# Refresh the cached CSV and regenerate validated JSON.
# Usage: ./update-data.sh [output-directory]
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/build-data.mjs" --refresh "$@"
