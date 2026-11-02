#!/bin/sh
# Canonical deploy for the SPIM capsule site.
#
# Deploys exactly what is committed (HEAD) and nothing else. The working
# directory is never uploaded, so an untracked prototype cannot take
# production's place. The preflight gate must pass first.
set -eu

cd "$(dirname "$0")"
ROOT=$(pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

git archive HEAD | tar -x -C "$OUT"

# Repository files are not site files. wrangler.toml must never be served:
# every file in the deploy tree is public.
rm -rf "$OUT/tools" "$OUT/.gitignore" "$OUT/README.md" "$OUT/deploy.sh" "$OUT/wrangler.toml"

node "$ROOT/tools/preflight.js" "$OUT"

npx --yes wrangler pages deploy "$OUT" --project-name=spim-site --commit-dirty=true
