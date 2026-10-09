# Cardiff University Kazakhstan timetable bot

Free Telegram bot: send your 8-digit student number once, then use /today, /tomorrow, /week, /nextweek.
Sends a reminder 30 minutes before each class.

- **Bot**: Cloudflare Worker (`src/worker.js`), Telegram webhook, cron every 5 minutes for reminders.
- **Data**: Cloudflare D1 (`schema.sql`). The timetable comes from the university's `Student_Timetables.html`.
- **Deploy**: `TELEGRAM_TOKEN=... ./scripts/deploy.sh` after `npx wrangler login` (or let the workflow do it).
- **Updates**: `.github/workflows/cukz-bot.yml` deploys on push and runs `scripts/ingest.mjs` hourly.
  The admin either sends the `.html` file to the bot, or signs in once with `/login` (Microsoft device code)
  and sets `/source <SharePoint link>`, after which the file is downloaded daily.

## Setup

Repository secrets: `TELEGRAM_TOKEN` (from @BotFather), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`
(template "Edit Cloudflare Workers" plus Account / D1 / Edit). Push to `main` or run the workflow manually.
In Telegram, the first person to send `/claim` becomes the admin.

## Tests

```
npm ci && npm test
```
