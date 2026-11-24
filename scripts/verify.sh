#!/usr/bin/env bash
# Verifies index.yaml.sig with the official public keys of keys/official.pub (one base64
# key per line) for the official registry URL.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -s keys/official.pub ]]; then
  echo "✗ keys/official.pub is missing: add the official public key (see keys/README.md)" >&2
  exit 1
fi
args=()
while read -r key; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  args+=(--public-key "$key")
done < keys/official.pub
cicord registry verify . "${args[@]}" --registry-url https://github.com/cicord/cicord-plugins
