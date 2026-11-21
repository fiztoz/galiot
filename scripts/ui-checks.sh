#!/usr/bin/env bash
# Serve only synthetic browser checks. No S3 proxy or real vault; loopback only.
set -euo pipefail
cd "$(dirname "$0")/.."
out=$(mktemp -d "${TMPDIR:-/tmp}/galiot-ui-checks.XXXXXX")
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -r -- "$out"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
bun scripts/copy-pdfjs-assets.ts
bun ./node_modules/vite/bin/vite.js build --config tests/ui/vite.config.ts --outDir "$out/dist"
printf '\nOpen http://127.0.0.1:5187/tests/ui/checks.html and choose Run local fixture checks. Ctrl-C stops it.\n'
node ./node_modules/vite/bin/vite.js preview --config tests/ui/vite.config.ts --outDir "$out/dist" &
pid=$!
wait "$pid"
