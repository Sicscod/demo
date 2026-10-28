// Points the Telegram bot's webhook at the deployed worker and sets its command menu.
// Usage: TELEGRAM_TOKEN=... node scripts/telegram-setup.mjs https://msg-keeper.<you>.workers.dev
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

await call('setWebhook', {
  url: `${url}/tg`,
  secret_token: secret,
  allowed_updates: ['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'],
});
await call('setMyCommands', { commands: [
  { command: 'start', description: 'Как подключить' },
  { command: 'stats', description: 'Сколько сообщений сохранено' },
] });
const me = await call('getMe', {});
if (!me.can_connect_to_business) console.log('Turn on Business Mode: @BotFather → /mybots → your bot → Bot Settings → Business Mode.');
console.log(`Bot @${me.username} is live at ${url}`);
