#!/usr/bin/env bash
# Deploys the worker and points the Telegram bot at it. Works in CI and on a laptop.
# Needs TELEGRAM_TOKEN, and a Cloudflare login (`npx wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TELEGRAM_TOKEN:?Set TELEGRAM_TOKEN}"
./scripts/ensure-d1.sh
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
echo "$out"
url=$(echo "$out" | grep -o 'https://[a-zA-Z0-9.-]*\.workers\.dev' | head -1 || true)
if [ -z "$url" ]; then
  echo "No workers.dev URL. Open Workers & Pages in the Cloudflare dashboard once to create your workers.dev subdomain, then rerun." >&2
  exit 1
fi
printf %s "$TELEGRAM_TOKEN" | npx wrangler secret put TELEGRAM_TOKEN >/dev/null
node scripts/telegram-setup.mjs "$url"
