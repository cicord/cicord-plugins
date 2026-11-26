#!/usr/bin/env bash
# Checks every plugin (scripts/check-plugin.sh) and the index (scripts/check-index.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -gt 1 || (${1:-} != "" && ${1:-} != "--allow-unlisted") ]]; then
  echo "usage: $0 [--allow-unlisted]" >&2
  exit 2
fi
for dir in plugins/*/; do
  bash scripts/check-plugin.sh "$dir"
done
node --test scripts/disabled-instances.test.mjs
bash scripts/check-index.sh "$@"
