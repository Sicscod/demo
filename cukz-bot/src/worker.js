// Cardiff University Kazakhstan timetable bot (Cloudflare Worker).
// Telegram webhook + 5-minute cron for class reminders and Microsoft sign-in polling.
// The timetable itself is loaded into D1 by scripts/ingest.mjs (GitHub Actions).

import {
  astanaNow, addDays, mondayOf, addMinutes, formatDay, formatWeek, formatReminder, isStudentId, esc,
} from './lib.js';

// Microsoft sign-in (device code flow) for automatic timetable downloads.
const MS_TENANT = 'bdb74b30-9568-4856-bdbf-06759778fcbc'; // cf.ac.uk
const MS_CLIENT = 'd3590ed6-52b3-4102-aeff-aad2292ab01c'; // Microsoft Office public client
const MS_SCOPE = 'https://graph.microsoft.com/.default offline_access';
const REMIND_MIN = 30;

const KEYBOARD = {
  keyboard: [[{ text: 'Today' }, { text: 'Tomorrow' }], [{ text: 'This week' }, { text: 'Next week' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/tg') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await req.json();
      ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error('update failed', e.stack || e)));
      return new Response('ok');
    }
    return new Response('cukz-bot is running');
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([sendReminders(env), pollMicrosoftLogin(env)]));
  },
};

export async function webhookSecret(env) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_TOKEN));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

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

const send = (env, chat_id, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// ---------- Storage ----------

const kvGet = async (env, k) => (await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first())?.v ?? null;
const kvSet = (env, k, v) =>
  env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
const kvDel = (env, k) => env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(k).run();

const getUser = (env, chatId) => env.DB.prepare('SELECT * FROM users WHERE chat_id = ?').bind(chatId).first();

async function sessionsFor(env, sid, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT s.* FROM students st, json_each(st.sessions) j JOIN sessions s ON s.id = j.value
     WHERE st.sid = ? AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start`,
  ).bind(sid, from, to).all();
  return results;
}

// ---------- Updates ----------

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg?.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const isAdmin = String(chatId) === (await kvGet(env, 'admin'));

  if (msg.document && isAdmin) return onTimetableFile(env, chatId, msg.document);

  const text = (msg.text || '').trim();
  const [cmd, ...args] = text.split(/\s+/);
  const command = cmd.toLowerCase().replace(/@.*$/, '');

  if (isStudentId(text)) return setStudent(env, chatId, text);

  switch (command) {
    case '/start':
    case '/help':
      return send(env, chatId,
        '👋 Hi! I show your <b>Cardiff University Kazakhstan</b> timetable.\n\n' +
        'Send me your <b>8-digit student number</b> once, I will remember it.\n\n' +
        '/today · /tomorrow · /week · /nextweek\n' +
        `/remind — turn reminders ${REMIND_MIN} min before class on or off\n` +
        '/id — change your student number', { reply_markup: KEYBOARD });
    case '/today': case 'today':
      return showDay(env, chatId, 0);
    case '/tomorrow': case 'tomorrow':
      return showDay(env, chatId, 1);
    case '/week': case 'this':
      return showWeek(env, chatId, 0);
    case '/nextweek': case 'next':
      return showWeek(env, chatId, 7);
    case '/id':
      return send(env, chatId, 'Send me your 8-digit student number.');
    case '/remind':
      return toggleRemind(env, chatId);
    case '/claim':
      return claimAdmin(env, chatId);
  }

  if (isAdmin) {
    switch (command) {
      case '/login': return startMicrosoftLogin(env, chatId);
      case '/source': return setSource(env, chatId, args[0]);
      case '/status': return showStatus(env, chatId);
    }
  }

  return send(env, chatId, 'Send your 8-digit student number, or use /today, /week, /nextweek.', { reply_markup: KEYBOARD });
}

async function setStudent(env, chatId, sid) {
  const loaded = await env.DB.prepare('SELECT COUNT(*) AS n FROM students').first();
  if (loaded.n > 0) {
    const found = await env.DB.prepare('SELECT 1 FROM students WHERE sid = ?').bind(sid).first();
    if (!found) return send(env, chatId, `❌ Student <b>${sid}</b> is not in the timetable. Check the number and try again.`);
  }
  await env.DB.prepare(
    'INSERT INTO users (chat_id, sid) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET sid = excluded.sid',
  ).bind(chatId, sid).run();
  await send(env, chatId, `✅ Saved student number <b>${sid}</b>.\nReminders ${REMIND_MIN} min before class are on (/remind to turn off).`,
    { reply_markup: KEYBOARD });
  if (loaded.n > 0) return showDay(env, chatId, 0);
  return send(env, chatId, 'The timetable is not loaded yet, try again a bit later.');
}

async function requireStudent(env, chatId) {
  const user = await getUser(env, chatId);
  if (!user?.sid) {
    await send(env, chatId, 'First send me your 8-digit student number.');
    return null;
  }
  return user.sid;
}

async function showDay(env, chatId, offset) {
  const sid = await requireStudent(env, chatId);
  if (!sid) return;
  const date = addDays(astanaNow().date, offset);
  return send(env, chatId, formatDay(date, await sessionsFor(env, sid, date, date)), { reply_markup: KEYBOARD });
}

async function showWeek(env, chatId, offsetDays) {
  const sid = await requireStudent(env, chatId);
  if (!sid) return;
  const monday = mondayOf(addDays(astanaNow().date, offsetDays));
  const sessions = await sessionsFor(env, sid, monday, addDays(monday, 6));
  return send(env, chatId, formatWeek(monday, sessions), { reply_markup: KEYBOARD });
}

async function toggleRemind(env, chatId) {
  const user = await getUser(env, chatId);
  if (!user?.sid) return send(env, chatId, 'First send me your 8-digit student number.');
  const on = user.remind ? 0 : 1;
  await env.DB.prepare('UPDATE users SET remind = ? WHERE chat_id = ?').bind(on, chatId).run();
  return send(env, chatId, on ? `🔔 Reminders on (${REMIND_MIN} min before class).` : '🔕 Reminders off.');
}

// ---------- Reminders (cron) ----------

async function sendReminders(env) {
  const now = astanaNow();
  const from = addMinutes(now.time, REMIND_MIN - 5);
  const to = addMinutes(now.time, REMIND_MIN);
  const { results } = await env.DB.prepare(
    `SELECT u.chat_id, s.* FROM users u JOIN students st ON st.sid = u.sid, json_each(st.sessions) j
     JOIN sessions s ON s.id = j.value
     WHERE u.remind = 1 AND s.date = ? AND s.start > ? AND s.start <= ?`,
  ).bind(now.date, from, to).all();
  const [h, m] = now.time.split(':').map(Number);
  for (const row of results) {
    const [sh, sm] = row.start.split(':').map(Number);
    try {
      await send(env, row.chat_id, formatReminder(row, sh * 60 + sm - (h * 60 + m)));
    } catch (e) {
      console.error('reminder failed', row.chat_id, e);
    }
  }
}

// ---------- Admin: timetable source ----------

async function claimAdmin(env, chatId) {
  const admin = await kvGet(env, 'admin');
  if (admin && admin !== String(chatId)) return send(env, chatId, 'This bot already has an admin.');
  await kvSet(env, 'admin', String(chatId));
  return send(env, chatId,
    '🔑 You are the admin.\n\n' +
    '• Send me <b>Student_Timetables.html</b> as a file to update the timetable.\n' +
    '• /source <i>link</i> — SharePoint link to the file, for automatic updates\n' +
    '• /login — sign in with the university Microsoft account (for automatic updates)\n' +
    '• /status — what is loaded');
}

async function onTimetableFile(env, chatId, doc) {
  if (!/\.html?$/i.test(doc.file_name || '')) return send(env, chatId, 'Send the Student_Timetables.html file.');
  await kvSet(env, 'pending_file', doc.file_id);
  return send(env, chatId, '📥 Got it. The timetable will be updated within the next hour, I will message you.');
}

async function setSource(env, chatId, link) {
  if (!link || !/^https:\/\/[\w.-]+\.sharepoint\.com\//.test(link)) {
    return send(env, chatId, 'Usage: /source https://cf.sharepoint.com/... (the link to Student_Timetables.html)');
  }
  await kvSet(env, 'source_url', link);
  return send(env, chatId, '✅ Source link saved.');
}

async function showStatus(env, chatId) {
  const [updated, loadedAt, source, refresh, lastError, users, students, sessions] = await Promise.all([
    kvGet(env, 'tt_updated'), kvGet(env, 'tt_loaded_at'), kvGet(env, 'source_url'), kvGet(env, 'ms_refresh'),
    kvGet(env, 'last_error'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM users').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM students').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first(),
  ]);
  return send(env, chatId, [
    `Timetable: ${esc(updated || '—')} (loaded ${esc(loadedAt || 'never')})`,
    `Students: ${students.n}, classes: ${sessions.n}, bot users: ${users.n}`,
    `Auto-update: ${source ? 'link set' : 'no link'}, ${refresh ? 'signed in' : 'not signed in'}`,
    lastError && `Last error: ${esc(lastError)}`,
  ].filter(Boolean).join('\n'));
}

// ---------- Admin: Microsoft sign-in (device code) ----------

async function startMicrosoftLogin(env, chatId) {
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: MS_CLIENT, scope: MS_SCOPE }),
  });
  const data = await res.json();
  if (!data.device_code) return send(env, chatId, `Microsoft refused: ${esc(data.error_description || data.error)}`);
  await kvSet(env, 'ms_device', JSON.stringify({ code: data.device_code, chatId, until: Date.now() + data.expires_in * 1000 }));
  return send(env, chatId,
    `1. Open ${data.verification_uri}\n2. Enter the code <code>${esc(data.user_code)}</code>\n` +
    '3. Sign in with your university account and confirm on your phone.\n\nI will message you once it works (up to 5 min).');
}

async function pollMicrosoftLogin(env) {
  const raw = await kvGet(env, 'ms_device');
  if (!raw) return;
  const pending = JSON.parse(raw);
  if (Date.now() > pending.until) {
    await kvDel(env, 'ms_device');
    return send(env, pending.chatId, '⌛ The sign-in code expired. Send /login to try again.');
  }
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: MS_CLIENT, device_code: pending.code,
    }),
  });
  const data = await res.json();
  if (data.error === 'authorization_pending' || data.error === 'slow_down') return;
  await kvDel(env, 'ms_device');
  if (!data.refresh_token) {
    return send(env, pending.chatId, `❌ Sign-in failed: ${esc(data.error_description || data.error)}`);
  }
  await kvSet(env, 'ms_refresh', data.refresh_token);
  return send(env, pending.chatId, '✅ Signed in. The timetable will now update automatically once a day.');
}
