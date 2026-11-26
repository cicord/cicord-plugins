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
smoke=(cicord plugin test "$dir")
if [[ -f "$dir/test/config.yaml" ]]; then
  smoke+=(--config "$dir/test/config.yaml")
fi
"${smoke[@]}"
pnpm exec tsc -p "$dir"
if [[ -f "$dir/test/tsconfig.json" ]]; then
  pnpm exec tsc -p "$dir/test"
fi
if compgen -G "$dir/test/*.test.ts" >/dev/null; then
  pnpm exec vp test run "$dir/"
fi
acceptance=()
for file in "$dir/test/runtime.mjs" "$dir"/test/*.sim.mjs "$dir"/test/*.test.mjs; do
  [[ ! -f "$file" ]] || acceptance+=("$file")
done
if (( ${#acceptance[@]} )); then
  node --test "${acceptance[@]}"
fi
if [[ -n "${CICORD_SOURCE:-}" && -f "$dir/test/persistence/run.mjs" ]]; then
  node "$dir/test/persistence/run.mjs"
fi
echo "✓ $dir"
