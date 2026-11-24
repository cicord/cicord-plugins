#!/usr/bin/env bash
# Checks index.yaml without the signing key (pull requests cannot carry a valid signature):
#   - it can be signed: `cicord registry sign` refuses what a runtime would ignore or must
#     never see (names, https repos, paths), here with a throwaway key on a copy;
#   - every entry of this repository points to an existing plugin directory whose
#     plugin.yaml has the entry's name;
#   - every plugins/<name>/ directory is listed (a new plugin is listed when released).
# Unpublished plugins are reported, not failed, with --allow-unlisted (pull requests).
set -euo pipefail
cd "$(dirname "$0")/.."
allow_unlisted=false
[[ "${1:-}" == "--allow-unlisted" ]] && allow_unlisted=true
registry_url="https://github.com/cicord/cicord-plugins"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp index.yaml "$tmp/index.yaml"
cicord registry keygen --out "$tmp/throwaway.key" >/dev/null
cicord registry sign "$tmp" --key "$tmp/throwaway.key" --registry-url "$registry_url" >/dev/null

status=0
listed=" "
# `path:` lines of index.yaml, with the entry they belong to (two-space indented keys).
while read -r name path; do
  listed+="$name "
  if [[ ! -f "$path/plugin.yaml" ]]; then
    echo "✗ $name: $path/plugin.yaml does not exist" >&2
    status=1
  elif ! grep -Eq "^  name: ${name}\$" "$path/plugin.yaml"; then
    echo "✗ $name: $path/plugin.yaml is not the plugin $name (metadata.name)" >&2
    status=1
  fi
done < <(awk '/^  [a-z0-9][a-z0-9-]*:$/ { name = substr($1, 1, length($1) - 1) }
              /^    path: / { print name, $2 }' index.yaml)

for dir in plugins/*/; do
  name="$(basename "$dir")"
  if [[ "$listed" != *" $name "* ]]; then
    if $allow_unlisted; then
      echo "• $name is not in index.yaml yet (listed when a maintainer releases it)"
    else
      echo "✗ $name is not in index.yaml" >&2
      status=1
    fi
  fi
done
[[ $status -eq 0 ]] && echo "✓ index.yaml"
exit $status
