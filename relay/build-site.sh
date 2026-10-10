#!/usr/bin/env bash
# Assembles the static Nova app into .site/ so it can be uploaded as the
# assets of the relay Worker (the app and its server-side routes then share
# one origin, which keeps every /api/* call same-origin).
#
#   bash relay/build-site.sh && (deploy with relay/deploy-app.json)
#
# The bundle is exactly the file list the GitHub Pages workflow publishes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="$ROOT/.site"
rm -rf "$OUT"
mkdir -p "$OUT/icons"

cp index.html app.js bgfx.js styles.css sw.js manifest.webmanifest "$OUT/"
cp icons/* "$OUT/icons/"

# The gate must never be shipped by accident, nor any key material.
if ls "$OUT" | grep -Ei 'key|secret|token|\.env'; then
  echo "Refusing to publish: secret-looking file in the bundle" >&2
  exit 1
fi

echo "bundle ready in .site/"
find "$OUT" -type f | sed "s#$ROOT/##" | sort
