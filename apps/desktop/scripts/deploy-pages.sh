#!/usr/bin/env bash
# deploy-pages.sh — Build and deploy the public reader to Cloudflare Pages
#
# Usage:
#   CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx ./scripts/deploy-pages.sh
#
# Reads .finhot-cache/ and deploys a self-contained HTML page to Cloudflare Pages.
# The page includes all cached feeds, entries, and AI enrichment data.

set -euo pipefail

: "${CF_API_TOKEN:?Set CF_API_TOKEN}"
: "${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID}"
PROJECT_NAME="${CF_PROJECT_NAME:-finhot}"
CACHE_DIR="$(cd "$(dirname "$0")/.." && pwd)/.finhot-cache"

if [ ! -f "$CACHE_DIR/manifest.json" ]; then
  echo "Error: No cache found at $CACHE_DIR/manifest.json"
  echo "Start the dev server and refresh feeds first."
  exit 1
fi

echo "==> Deploying $PROJECT_NAME to Cloudflare Pages..."
echo "    Cache dir: $CACHE_DIR"

# Trigger deploy via the Vite dev server API (must be running)
DEPLOY_RESULT=$(curl -s -X POST http://localhost:2233/api/public/deploy \
  -H "Content-Type: application/json" \
  -d "{\"cfApiToken\":\"$CF_API_TOKEN\",\"cfAccountId\":\"$CF_ACCOUNT_ID\"}")

if echo "$DEPLOY_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok')" 2>/dev/null; then
  URL=$(echo "$DEPLOY_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('url',''))")
  echo "==> Deploy successful!"
  echo "    Preview: $URL"
  echo "    Production: https://finhot.industry7view.com"
else
  echo "Error: Deploy failed"
  echo "$DEPLOY_RESULT"
  exit 1
fi
