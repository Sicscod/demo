// Points the Telegram bot's webhook at the deployed worker and sets its command menu.
// Usage: TELEGRAM_TOKEN=... node scripts/telegram-setup.mjs https://cukz-bot.<you>.workers.dev
import { createHash } from 'node:crypto';

const [url] = process.argv.slice(2);
const token = process.env.TELEGRAM_TOKEN;
const secret = createHash('sha256').update(token).digest('hex').slice(0, 32); // same as webhookSecret() in the worker

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

await call('setWebhook', { url: `${url}/tg`, secret_token: secret, allowed_updates: ['message'] });
await call('setMyCommands', { commands: [
  { command: 'today', description: "Today's classes" },
  { command: 'tomorrow', description: "Tomorrow's classes" },
  { command: 'week', description: 'This week' },
  { command: 'nextweek', description: 'Next week' },
  { command: 'date', description: 'Classes on a date, e.g. /date 15.10' },
  { command: 'remind', description: 'Reminders before class on/off' },
  { command: 'id', description: 'Change student number' },
] });
const me = await call('getMe', {});
console.log(`Bot @${me.username} is live at ${url}`);
