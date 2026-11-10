#!/usr/bin/env bash
# Deploys the worker and points the Telegram bot at it.
# Needs TELEGRAM_TOKEN, PUSHOVER_TOKEN, PUSHOVER_USER (or ~/.wake-bot.env) and a Cloudflare login (`npx wrangler login`).
set -euo pipefail
cd "$(dirname "$0")/.."
# Keys live in ~/.wake-bot.env (chmod 600, outside git):
#   TELEGRAM_TOKEN='...'   from @BotFather
#   PUSHOVER_TOKEN='...'   pushover.net → your application's API Token
#   PUSHOVER_USER='...'    pushover.net → Your User Key
if [ -f "$HOME/.wake-bot.env" ]; then set -a; . "$HOME/.wake-bot.env"; set +a; fi
: "${TELEGRAM_TOKEN:?Put TELEGRAM_TOKEN in ~/.wake-bot.env}"
: "${PUSHOVER_TOKEN:?Put PUSHOVER_TOKEN in ~/.wake-bot.env}"
: "${PUSHOVER_USER:?Put PUSHOVER_USER in ~/.wake-bot.env}"
if ! curl -fsS "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe" >/dev/null 2>&1; then
  echo "Telegram does not accept TELEGRAM_TOKEN. Copy it again from @BotFather. Nothing was deployed." >&2
  exit 1
fi
if ! curl -fsS https://api.pushover.net/1/users/validate.json --form-string "token=${PUSHOVER_TOKEN}" --form-string "user=${PUSHOVER_USER}" >/dev/null 2>&1; then
  echo "Pushover does not accept PUSHOVER_TOKEN / PUSHOVER_USER (or the app has no device yet). Nothing was deployed." >&2
  exit 1
fi
[ -d node_modules ] || npm install --silent
./scripts/ensure-kv.sh
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
echo "$out"
url=$(echo "$out" | grep -o 'https://[a-zA-Z0-9.-]*\.workers\.dev' | head -1 || true)
[ -n "$url" ] || { echo "No workers.dev URL in wrangler output." >&2; exit 1; }
for k in TELEGRAM_TOKEN PUSHOVER_TOKEN PUSHOVER_USER; do printf %s "${!k}" | npx wrangler secret put "$k" >/dev/null; done
node scripts/telegram-setup.mjs "$url"
