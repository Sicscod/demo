// "Wake me" bot (Cloudflare Worker).
// She presses one button in Telegram when she can't sleep, and his iPhone rings loudly through
// silent mode via a Pushover emergency alert, repeating until he taps "Acknowledge".
// Only two people can use it: the owner (first /start) and the partner who opens his invite link.

const RETRY_SEC = 30; // Pushover repeats the alert this often (minimum 30)
const EXPIRE_SEC = 30 * 60; // and gives up after this long
const COOLDOWN_SEC = 60; // a second press within a minute doesn't start a second alarm

const BTN_WAKE = '🌙 Не спится';
const BTN_CANCEL = 'Уже не надо';

const PARTNER_KEYBOARD = { keyboard: [[{ text: BTN_WAKE }]], resize_keyboard: true, is_persistent: true };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const secret = await webhookSecret(env);
    if (req.method === 'POST' && url.pathname === '/tg') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return new Response('forbidden', { status: 403 });
      const update = await req.json();
      ctx.waitUntil(handleUpdate(update, env, url.origin).catch((e) => console.error('update failed', e.stack || e)));
      return new Response('ok');
    }
    // Pushover calls this when he acknowledges the alarm.
    if (req.method === 'POST' && url.pathname === '/ack') {
      if (url.searchParams.get('k') !== secret) return new Response('forbidden', { status: 403 });
      const form = await req.formData();
      ctx.waitUntil(onAcknowledged(env, String(form.get('receipt') || '')).catch((e) => console.error('ack failed', e.stack || e)));
      return new Response('ok');
    }
    return new Response('wake-bot is running');
  },

  // Every 5 minutes: tell her if he didn't wake up before the alarm expired.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpired(env));
  },
};

export async function webhookSecret(env) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_TOKEN));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ---------- state (KV) ----------

const getJson = async (env, key) => JSON.parse((await env.KV.get(key)) || 'null');
const putJson = (env, key, value) => env.KV.put(key, JSON.stringify(value));
const now = () => Math.floor(Date.now() / 1000);

// ---------- Telegram ----------

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(method, data.description);
  return data;
}

const send = (env, chat_id, text, extra = {}) => tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

async function handleUpdate(update, env, origin) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  const msg = update.message;
  if (!msg || msg.chat?.type !== 'private' || !msg.from) return;
  const id = msg.from.id;
  const text = (msg.text || '').trim();
  const owner = Number(await env.KV.get('owner')) || 0;
  const partner = Number(await env.KV.get('partner')) || 0;

  // The first person to write /start owns the bot.
  if (!owner) {
    if (!text.startsWith('/start')) return;
    await env.KV.put('owner', String(id));
    return sendInvite(env, id, true);
  }

  if (id === owner) return handleOwner(env, id, text, partner, origin);

  if (id === partner) {
    if (text === BTN_WAKE || text === '/wake') return wake(env, { owner, partner, origin, name: msg.from.first_name });
    if (text.startsWith('/start')) return welcomePartner(env, id);
    return send(env, id, `Если не спится и хочешь, чтобы он был рядом, нажми «${BTN_WAKE}» внизу.`, { reply_markup: PARTNER_KEYBOARD });
  }

  // Someone opening the invite link becomes the partner (once).
  const code = text.match(/^\/start\s+(\S+)/)?.[1];
  if (code && code === (await env.KV.get('invite'))) {
    await env.KV.put('partner', String(id));
    await env.KV.delete('invite');
    await welcomePartner(env, id);
    const who = [msg.from.first_name, msg.from.username && `@${msg.from.username}`].filter(Boolean).join(' ');
    return send(env, owner, `💛 ${esc(who)} подключилась. Теперь её кнопка будит тебя.`);
  }
  // Everyone else is ignored.
}

async function handleOwner(env, id, text, partner, origin) {
  if (text === '/test') {
    const r = await pushAlarm(env, origin, 'Проверка будильника', 'Так будет звучать, когда ей не спится. Нажми Acknowledge.');
    if (!r.ok) return send(env, id, `Pushover не принял запрос: ${esc(r.error)}. Проверь ключи в ~/.wake-bot.env.`);
    await putJson(env, 'alarm', { receipt: r.receipt, at: now(), test: true });
    return send(env, id, 'Отправил проверку. Телефон должен звонить, пока не нажмёшь Acknowledge.');
  }
  if (text === '/stop') {
    const alarm = await getJson(env, 'alarm');
    if (!alarm) return send(env, id, 'Будильник сейчас не звонит.');
    await cancelAlarm(env, alarm);
    return send(env, id, 'Выключил.');
  }
  if (text === '/invite') return sendInvite(env, id, false);
  if (text === '/status') {
    const p = partner ? 'подключена' : 'ещё не подключилась (/invite)';
    return send(env, id, `Она: ${p}.\nКоманды: /test проверить звонок, /stop выключить, /invite новая ссылка для неё.`);
  }
  return send(env, id, partner
    ? 'Всё работает. Когда ей не спится, она жмёт кнопку, и у тебя звонит Pushover.\n/test проверить звонок, /stop выключить, /invite новая ссылка.'
    : 'Она ещё не подключилась. /invite пришлёт ссылку для неё.');
}

async function sendInvite(env, id, first) {
  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.KV.put('invite', code);
  const me = await tg(env, 'getMe', {});
  const link = `https://t.me/${me.result?.username}?start=${code}`;
  const intro = first ? 'Ты владелец этого бота.\n\n' : 'Новая ссылка, старая больше не работает. Если она уже была подключена, ей нужно открыть новую.\n\n';
  if (!first) await env.KV.delete('partner');
  return send(env, id, `${intro}Отправь ей эту ссылку. Кто откроет её первым, тот и сможет тебя будить:\n${link}\n\nЗаодно проверь звонок: /test`, { disable_web_page_preview: true });
}

function welcomePartner(env, id) {
  return send(env, id,
    `Привет 💛\n\nЕсли ночью не спится и хочется, чтобы он был рядом, нажми «${BTN_WAKE}». ` +
    'У него громко зазвонит телефон, даже если он спит, и будет звонить, пока он не проснётся. ' +
    'Я напишу тебе, когда он проснётся.\n\nМожно нажимать в любое время, он сам этого хотел.',
    { reply_markup: PARTNER_KEYBOARD });
}

// ---------- alarm ----------

async function wake(env, { owner, partner, origin, name }) {
  const alarm = await getJson(env, 'alarm');
  if (alarm && !alarm.test && now() - alarm.at < COOLDOWN_SEC) {
    return send(env, partner, 'Уже бужу его, подожди немного 💛');
  }
  if (alarm) await cancelAlarm(env, alarm);
  const r = await pushAlarm(env, origin, `🌙 ${name || 'Она'} не может уснуть`, 'Ей не спится, и она хочет, чтобы ты был рядом. Напиши ей 💛');
  if (!r.ok) {
    await send(env, owner, `⚠️ Она нажала кнопку, но Pushover не сработал: ${esc(r.error)}`);
    return send(env, partner, 'Не получилось включить будильник 😔 Я написал ему в Telegram, но громко может не прозвенеть.');
  }
  await putJson(env, 'alarm', { receipt: r.receipt, at: now() });
  await send(env, owner, `🌙 ${esc(name || 'Она')} не может уснуть и хочет, чтобы ты был рядом.`);
  return send(env, partner, 'Бужу его 💛 Напишу, как только он проснётся.', {
    reply_markup: { inline_keyboard: [[{ text: BTN_CANCEL, callback_data: 'cancel' }]] },
  });
}

async function handleCallback(cq, env) {
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const partner = Number(await env.KV.get('partner')) || 0;
  if (cq.data !== 'cancel' || cq.from.id !== partner) return;
  const alarm = await getJson(env, 'alarm');
  if (!alarm || alarm.test) return send(env, partner, 'Будильник уже не звонит.');
  await cancelAlarm(env, alarm);
  const owner = Number(await env.KV.get('owner')) || 0;
  await send(env, owner, 'Она выключила будильник, уже не нужно.');
  return send(env, partner, 'Выключила. Спокойной ночи 🌙', { reply_markup: PARTNER_KEYBOARD });
}

async function onAcknowledged(env, receipt) {
  const alarm = await getJson(env, 'alarm');
  if (!alarm || alarm.receipt !== receipt) return;
  await env.KV.delete('alarm');
  const owner = Number(await env.KV.get('owner')) || 0;
  if (alarm.test) return send(env, owner, '✅ Проверка прошла, всё работает.');
  const partner = Number(await env.KV.get('partner')) || 0;
  await send(env, partner, 'Он проснулся 💛 Сейчас напишет.', { reply_markup: PARTNER_KEYBOARD });
  await send(env, owner, 'Она знает, что ты проснулся. Напиши ей 💛');
}

async function checkExpired(env) {
  const alarm = await getJson(env, 'alarm');
  if (!alarm || now() - alarm.at < EXPIRE_SEC) return;
  await env.KV.delete('alarm');
  if (alarm.test) return;
  const partner = Number(await env.KV.get('partner')) || 0;
  await send(env, partner, 'Будильник звонил 30 минут, но он, кажется, очень крепко спит 😔 Можно нажать ещё раз.', { reply_markup: PARTNER_KEYBOARD });
}

// ---------- Pushover ----------

async function pushAlarm(env, origin, title, message) {
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: env.PUSHOVER_TOKEN,
      user: env.PUSHOVER_USER,
      title,
      message,
      priority: 2, // emergency: repeats until acknowledged, rings as a Critical Alert on iOS
      retry: RETRY_SEC,
      expire: EXPIRE_SEC,
      sound: 'persistent',
      callback: `${origin}/ack?k=${await webhookSecret(env)}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.status !== 1 || !data.receipt) return { ok: false, error: (data.errors || [`HTTP ${res.status}`]).join(', ') };
  return { ok: true, receipt: data.receipt };
}

async function cancelAlarm(env, alarm) {
  await env.KV.delete('alarm');
  await fetch(`https://api.pushover.net/1/receipts/${alarm.receipt}/cancel.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: env.PUSHOVER_TOKEN }),
  }).catch((e) => console.error('cancel failed', e));
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
