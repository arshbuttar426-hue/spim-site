#!/usr/bin/env bash
# Run the SEAM relay test against the real Functions in an ESM temp tree.
#
# The site has no package.json, so Node treats `.js` as CommonJS. Pages Functions
# are ESM. Copying the tree and declaring `"type": "module"` lets Node run the
# exact files that deploy, without changing the site's module layout.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/seam-api.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

cp -R "$root/functions" "$tmp/functions"
mkdir -p "$tmp/tools"
cp "$root/tools/seam-api-test.mjs" "$tmp/tools/"
printf '{"type":"module","private":true}\n' > "$tmp/package.json"

cd "$tmp"
node tools/seam-api-test.mjs
