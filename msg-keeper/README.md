# Personal "deleted messages" bot

Telegram Business bot that shows its owner messages people **deleted** or **edited** in private chats:
the original text, or the photo/video/voice/file again, with who sent it and when.

- **Only for the owner**: the first person to send `/start` becomes the owner. Business connections of
  anyone else are ignored, and other people who write to the bot get a one-line refusal.
- **Data**: Cloudflare D1 (`schema.sql`), only messages other people sent the owner. Kept 30 days, and
  removed as soon as a delete has been shown.
- **Not saved**: the owner's own messages, and view-once / disappearing media.

Needs Telegram Premium to connect: Settings → Telegram Business → Chatbots → the bot's @username.

## Deploy

1. @BotFather: `/newbot`, then `/mybots` → the bot → Bot Settings → **Business Mode** → on.
2. Put the token in `~/.msg-keeper.env` (`TELEGRAM_TOKEN='...'`, `chmod 600`).
3. `npm ci && npx wrangler login && ./scripts/deploy.sh`
4. Send the bot `/start`, then connect it in Telegram Business.

## Tests

```
npm ci && npm test
```
