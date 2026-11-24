#!/usr/bin/env bash
# Checks every plugin (scripts/check-plugin.sh) and the index (scripts/check-index.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
for dir in plugins/*/; do
  bash scripts/check-plugin.sh "$dir"
done
bash scripts/check-index.sh
