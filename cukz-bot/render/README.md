# cukz-bot render

Small Vercel Node.js function that draws the timetable PNGs for the cukz-bot
Telegram bot (one day, or one week with a column per day). The Cloudflare
Worker POSTs the timetable as JSON and sends the returned PNG to Telegram.

Built with `@vercel/og` (satori + resvg) and the DejaVu Sans fonts in `fonts/`.
`lib/card.js` builds the layout (and wraps the text itself, so the image
height always fits the content); `api/render.js` is the HTTP handler.

## API

`POST /api/render`, `Content-Type: application/json`:

```json
{
  "kind": "week",
  "title": "Week of 12 Oct 2026",
  "days": [
    { "label": "MON", "closed": null,
      "sessions": [ { "start": "09:00", "end": "09:50", "code": "EL0016",
                      "title": "Academic Skills", "type": "Seminar",
                      "rooms": "Room 8.3/C [70]", "staff": "A. Teacher", "grp": "Group 02" } ] },
    { "label": "TUE", "closed": "Republic Day", "sessions": [] }
  ]
}
```

- `kind: "day"`: exactly one entry in `days` (its label is not shown); 1050 px wide.
- `kind: "week"`: 1 to 7 entries, one column each; 2000 px wide for five columns,
  wider for six or seven.
- At most 30 sessions per day, 300 characters per text field. Empty fields are
  left out. A day with no sessions shows "No classes"; a day with `closed` set
  shows a "University closed" card.
- Response: `200 image/png`. Errors are JSON `{ "error": "..." }`:
  `400` bad body, `401` wrong `x-render-key`, `405` not POST, `500` render failure.

## Deploy

```sh
cd cukz-bot/render && npx vercel deploy --prod
```

Optional env var `RENDER_KEY` (set it in the Vercel project): when set, requests
must send the same value in the `x-render-key` header.

## Preview

```sh
npm install
npm run preview              # writes sample PNGs to ./preview
node scripts/preview.mjs /tmp/out
```

`@vercel/og` is pinned to 1.0.1: 1.0.2 and 1.0.3 crash on import in plain
Node ESM (their bundled harfbuzz calls `require("fs")`).

DejaVu fonts: free license (Bitstream Vera derivative), https://dejavu-fonts.github.io/
