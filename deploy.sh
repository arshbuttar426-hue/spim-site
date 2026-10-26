#!/bin/sh
# Canonical deploy for the SPIM capsule site.
# Requires: npx wrangler login   (or CLOUDFLARE_API_TOKEN in env)
set -e
cd "$(dirname "$0")"
npx wrangler pages deploy . --project-name=spim-site --commit-dirty=true
