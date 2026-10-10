# Cardiff University Kazakhstan timetable bot

Free Telegram bot: send your 8-digit student number once, then use /today, /tomorrow, /week, /nextweek.
Day and week come as pictures like the old bot's. Sends a reminder 30 minutes before each class.

- **Bot**: Cloudflare Worker (`src/worker.js`), Telegram webhook, cron every 5 minutes for reminders.
- **Data**: Cloudflare D1 (`schema.sql`). The timetable comes from the university's `Student_Timetables.html`,
  which embeds every student's timetable as JSON; `src/timetable.js` cuts it out and lets D1 parse it.
- **Updates**: the admin signs in once with `/login` (Microsoft device code). Every 3 hours the worker checks
  the file on SharePoint and reloads it when it changed. `/update` checks now; sending the `.html` file
  to the bot also works.
- **Pictures**: `render/` is a small Vercel function that draws the day and week images.
  The worker caches each picture's Telegram file_id, so the same picture is drawn once.

## Deploy

```
npx wrangler login
TELEGRAM_TOKEN=... ./scripts/deploy.sh
```

Optional secret `RENDER_KEY` (same value as the render function's `RENDER_KEY` env var).
In Telegram, the first person to send `/claim` becomes the admin.

## Tests

```
npm ci && npm test
```
