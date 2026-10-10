#!/usr/bin/env bash
# Deploys the worker and points the Telegram bot at it. Works in CI and on a laptop.
# Needs TELEGRAM_TOKEN (or ~/.cukz-bot.env), and a Cloudflare login (`npx wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail
cd "$(dirname "$0")/.."
# The token can live in ~/.cukz-bot.env (TELEGRAM_TOKEN='...', chmod 600, outside git).
if [ -z "${TELEGRAM_TOKEN:-}" ] && [ -f "$HOME/.cukz-bot.env" ]; then set -a; . "$HOME/.cukz-bot.env"; set +a; fi
: "${TELEGRAM_TOKEN:?Set TELEGRAM_TOKEN or put it in ~/.cukz-bot.env}"
# Check the token before anything else: a wrong one saved as the worker secret takes the bot offline.
if ! curl -fsS "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe" >/dev/null 2>&1; then
  echo "Telegram does not accept this TELEGRAM_TOKEN. Copy the real token from @BotFather (/mybots → your bot → API Token). Nothing was deployed." >&2
  exit 1
fi
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
