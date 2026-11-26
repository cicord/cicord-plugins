#!/usr/bin/env bash
# Checks every plugin (scripts/check-plugin.sh), the disabled installations, the published
# migrations and mixed-version interop fixtures, and the index (scripts/check-index.sh).
#
#   scripts/check-all.sh [--allow-unlisted] [--core <cicord checkout>]
#
# The migration fixtures (plugins/*/test/persistence/run.mjs) and scripts/interop/run.mjs
# run `go test` inside a checkout of github.com/cicord/cicord, given by --core or by
# CICORD_SOURCE. Without either, a sibling ../cicord or ../codi checkout is used; with none,
# the script fails instead of silently skipping those fixtures.
# Set CICORD_TEST_POSTGRES_URL to run them on PostgreSQL as well as SQLite.
set -euo pipefail
cd "$(dirname "$0")/.."
usage() { echo "usage: $0 [--allow-unlisted] [--core <cicord checkout>]" >&2; exit 2; }
index_args=()
while (( $# )); do
  case "$1" in
    --allow-unlisted) index_args+=("$1"); shift ;;
    --core) [[ $# -ge 2 ]] || usage; CICORD_SOURCE="$2"; shift 2 ;;
    *) usage ;;
  esac
done
is_core() { [[ -f "$1/go.mod" ]] && grep -q '^module github.com/cicord/cicord$' "$1/go.mod"; }
if [[ -z "${CICORD_SOURCE:-}" ]]; then
  for candidate in ../cicord ../codi; do
    if is_core "$candidate"; then
      CICORD_SOURCE="$candidate"
      break
    fi
  done
fi
if [[ -z "${CICORD_SOURCE:-}" ]] || ! is_core "$CICORD_SOURCE"; then
  echo "check-all: set CICORD_SOURCE (or pass --core) to a github.com/cicord/cicord checkout;" >&2
  echo "check-all: the published-migration and interop fixtures run go test inside it" >&2
  exit 2
fi
CICORD_SOURCE="$(cd "$CICORD_SOURCE" && pwd)"
export CICORD_SOURCE
echo "• core checkout for the migration fixtures: $CICORD_SOURCE"

# CICORD_SOURCE makes check-plugin.sh run plugins/<name>/test/persistence/run.mjs.
for dir in plugins/*/; do
  bash scripts/check-plugin.sh "$dir"
done
node --test scripts/disabled-instances.test.mjs
node scripts/interop/run.mjs
bash scripts/check-index.sh ${index_args[@]+"${index_args[@]}"}
