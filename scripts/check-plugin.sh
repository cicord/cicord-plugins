#!/usr/bin/env bash
# Checks one plugin directory like the CI does: SDK types, generated config types, build,
# simulator smoke test, type checks and unit tests.
#
#   scripts/check-plugin.sh plugins/<name>
#
# Needs `cicord` on PATH (a build of github.com/cicord/cicord) and `pnpm install` done.
set -euo pipefail
dir="${1:?usage: scripts/check-plugin.sh plugins/<name>}"
dir="${dir%/}"
[[ -f "$dir/plugin.yaml" ]] || { echo "$dir: no plugin.yaml" >&2; exit 1; }

cicord plugin sdk-types "$dir"
cicord plugin typegen "$dir" --check
cicord plugin build "$dir"
config=()
if [[ -f "$dir/test/config.yaml" ]]; then
  config=(--config "$dir/test/config.yaml")
fi
cicord plugin test "$dir" "${config[@]}"
pnpm exec tsc -p "$dir"
if [[ -f "$dir/test/tsconfig.json" ]]; then
  pnpm exec tsc -p "$dir/test"
fi
if compgen -G "$dir/test/*.test.ts" >/dev/null; then
  pnpm exec vp test run "$dir/"
fi
echo "✓ $dir"
