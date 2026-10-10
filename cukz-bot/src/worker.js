// Cardiff University Kazakhstan timetable bot (Cloudflare Worker).
// Telegram webhook, a 5-minute cron for class reminders and Microsoft sign-in polling,
// and a 3-hourly cron that downloads Student_Timetables.html from SharePoint when it changes.

import {
  astanaNow, addDays, mondayOf, addMinutes, formatDay, formatWeek, formatReminder, isStudentId, esc,
  dayTitle, weekdayLabel, parseDate,
} from './lib.js';
import { loadTimetable } from './timetable.js';

// Microsoft sign-in (device code flow) for automatic timetable downloads.
const MS_TENANT = 'bdb74b30-9568-4856-bdbf-06759778fcbc'; // cf.ac.uk
const MS_CLIENT = 'd3590ed6-52b3-4102-aeff-aad2292ab01c'; // Microsoft Office public client
const MS_SCOPE = 'https://graph.microsoft.com/.default offline_access';
const REMIND_MIN = 30;
const UPDATE_CRON = '7 */3 * * *'; // must match wrangler.toml
const FILE_NAME = 'Student_Timetables.html';

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
    // Manual timetable refresh from SharePoint, for whoever holds the bot token.
    if (req.method === 'POST' && url.pathname === '/update') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== (await webhookSecret(env))) {
        return new Response('forbidden', { status: 403 });
      }
      return Response.json(await autoUpdate(env, { force: url.searchParams.has('force') }));
    }
    return new Response('cukz-bot is running');
  },

  async scheduled(event, env, ctx) {
    if (event.cron === UPDATE_CRON) ctx.waitUntil(autoUpdate(env, {}));
    else ctx.waitUntil(Promise.all([sendReminders(env), pollMicrosoftLogin(env)]));
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

const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

// Sends the timetable as a picture drawn by the render service (render/), reusing the Telegram
// file_id when the same picture was sent before. Falls back to the text version.
async function sendTimetable(env, chatId, picture, text) {
  if (env.RENDER_URL) {
    try {
      const body = JSON.stringify(picture);
      const key = await sha256(body);
      const cached = await env.DB.prepare('SELECT file_id FROM images WHERE k = ?').bind(key).first();
      if (cached && (await tg(env, 'sendPhoto', { chat_id: chatId, photo: cached.file_id, reply_markup: KEYBOARD })).ok) return;
      const res = await fetch(env.RENDER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-key': env.RENDER_KEY || '' },
        body,
      });
      if (!res.ok) throw new Error(`render: HTTP ${res.status}`);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('reply_markup', JSON.stringify(KEYBOARD));
      form.append('photo', new Blob([await res.arrayBuffer()], { type: 'image/png' }), 'timetable.png');
      const sent = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
        method: 'POST', body: form,
      })).json();
      if (!sent.ok) throw new Error(`sendPhoto: ${sent.description}`);
      const fileId = sent.result.photo.at(-1).file_id;
      await env.DB.prepare('INSERT OR REPLACE INTO images (k, file_id) VALUES (?, ?)').bind(key, fileId).run();
      return;
    } catch (e) {
      console.error('picture failed', e.stack || e);
    }
  }
  return send(env, chatId, text, { reply_markup: KEYBOARD });
}

const pictureSession = ({ start, end, code, title, type, rooms, staff, grp }) =>
  ({ start, end, code, title, type, rooms, staff, grp });

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
  if (update.callback_query) return onButton(env, update.callback_query);
  const msg = update.message;
  if (!msg?.chat || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  await env.DB.prepare(
    `INSERT INTO seen (chat_id, first, last) VALUES (?, datetime('now'), datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET last = excluded.last`,
  ).bind(chatId).run();
  await saveProfile(env, chatId, msg.from);
  const isAdmin = String(chatId) === (await kvGet(env, 'admin'));

  if (msg.document && isAdmin) return onTimetableFile(env, chatId, msg.document);

  const text = (msg.text || '').trim();
  const [cmd, ...args] = text.split(/\s+/);
  const command = cmd.toLowerCase().replace(/@.*$/, '');

  if (isStudentId(text)) return setStudent(env, chatId, text);
  const typedDate = parseDate(text, astanaNow().date);
  if (typedDate) return showDate(env, chatId, typedDate);

  switch (command) {
    case '/start':
    case '/help':
      return send(env, chatId,
        '👋 Hi! I show your <b>Cardiff University Kazakhstan</b> timetable.\n\n' +
        'Send me your <b>8-digit student number</b> once, I will remember it.\n\n' +
        '/today · /tomorrow · /week · /nextweek\n' +
        'Any day: send a date like <b>15.10</b>\n' +
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
    case '/date': {
      const date = parseDate(args.join(''), astanaNow().date);
      if (date) return showDate(env, chatId, date);
      return send(env, chatId, 'Send a date like <b>15.10</b> or <b>15.10.2026</b>.', { reply_markup: KEYBOARD });
    }
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
      case '/stats': return showStats(env, chatId);
      case '/users': return sendUserList(env, chatId);
      case '/update': {
        await send(env, chatId, '⏳ Checking SharePoint…');
        const result = await autoUpdate(env, { force: true, quiet: true });
        return send(env, chatId, updateMessage(result));
      }
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

// { holidays: { date: name }, min, max } of the loaded timetable
async function calendar(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM kv WHERE k IN ('tt_holidays', 'tt_min', 'tt_max')").all();
  const kv = Object.fromEntries(results.map((r) => [r.k, r.v]));
  let holidays = {};
  try {
    holidays = JSON.parse(kv.tt_holidays || '{}');
  } catch {}
  return { holidays: holidays && !Array.isArray(holidays) ? holidays : {}, min: kv.tt_min, max: kv.tt_max };
}

const noTimetable = (env, chatId, title) =>
  send(env, chatId, `${title}\nThe university has not published the timetable for these dates yet.`, { reply_markup: KEYBOARD });

const showDay = (env, chatId, offset) => showDate(env, chatId, addDays(astanaNow().date, offset));

async function showDate(env, chatId, date) {
  const sid = await requireStudent(env, chatId);
  if (!sid) return;
  const [sessions, cal] = await Promise.all([sessionsFor(env, sid, date, date), calendar(env)]);
  const text = formatDay(date, sessions, cal.holidays);
  if (!sessions.length) {
    if ((cal.min && date < cal.min) || (cal.max && date > cal.max)) return noTimetable(env, chatId, `📅 <b>${dayTitle(date)}</b>`);
    return send(env, chatId, text, { reply_markup: KEYBOARD });
  }
  return sendTimetable(env, chatId, {
    kind: 'day',
    title: dayTitle(date, true),
    days: [{ label: weekdayLabel(date), closed: cal.holidays[date] || null, sessions: sessions.map(pictureSession) }],
  }, text);
}

async function showWeek(env, chatId, offsetDays) {
  const sid = await requireStudent(env, chatId);
  if (!sid) return;
  const monday = mondayOf(addDays(astanaNow().date, offsetDays));
  const sunday = addDays(monday, 6);
  const [sessions, cal] = await Promise.all([sessionsFor(env, sid, monday, sunday), calendar(env)]);
  const text = formatWeek(monday, sessions, cal.holidays);
  if (!sessions.length) {
    if ((cal.min && sunday < cal.min) || (cal.max && monday > cal.max)) {
      return noTimetable(env, chatId, `🗓 <b>Week of ${dayTitle(monday).split(', ')[1]}</b>`);
    }
    return send(env, chatId, text, { reply_markup: KEYBOARD });
  }
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const list = sessions.filter((s) => s.date === date);
    if (i < 5 || list.length) {
      days.push({ label: weekdayLabel(date), closed: cal.holidays[date] || null, sessions: list.map(pictureSession) });
    }
  }
  return sendTimetable(env, chatId, { kind: 'week', title: `Week of ${dayTitle(monday, true).split(', ')[1]}`, days }, text);
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
    '• /login — sign in with the university Microsoft account, then the timetable updates by itself\n' +
    '• /source <i>link</i> — SharePoint link to the file (optional, found automatically)\n' +
    '• /update — check for a new timetable now\n' +
    '• Or send me <b>Student_Timetables.html</b> as a file.\n' +
    '• /status — what is loaded\n' +
    '• /stats — how many people use the bot\n' +
    '• /users — file with everyone who uses the bot');
}

async function onTimetableFile(env, chatId, doc) {
  if (!/\.html?$/i.test(doc.file_name || '')) return send(env, chatId, 'Send the Student_Timetables.html file.');
  try {
    const info = await tg(env, 'getFile', { file_id: doc.file_id });
    if (!info.ok) throw new Error(`Telegram getFile: ${info.description}`);
    const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${info.result.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download: HTTP ${res.status}`);
    const result = await loadTimetable(env.DB, await res.text(), { last_error: '' });
    return send(env, chatId, updateMessage({ ok: true, loaded: true, ...result }));
  } catch (e) {
    await kvSet(env, 'last_error', `${new Date().toISOString()} ${e.message}`.slice(0, 500));
    return send(env, chatId, `❌ Timetable update failed: ${esc(e.message)}`);
  }
}

async function setSource(env, chatId, link) {
  if (!link || !/^https:\/\/[\w.-]+\.sharepoint\.com\//.test(link)) {
    return send(env, chatId, 'Usage: /source https://cf.sharepoint.com/... (the link to Student_Timetables.html)');
  }
  await kvSet(env, 'source_url', link);
  return send(env, chatId, '✅ Source link saved.');
}

async function showStatus(env, chatId) {
  const [updated, loadedAt, source, refresh, lastError, lastCheck, users, students, sessions] = await Promise.all([
    kvGet(env, 'tt_updated'), kvGet(env, 'tt_loaded_at'), kvGet(env, 'source_url'), kvGet(env, 'ms_refresh'),
    kvGet(env, 'last_error'), kvGet(env, 'last_check'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM users').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM students').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first(),
  ]);
  return send(env, chatId, [
    `Timetable: ${esc(updated || '—')} (loaded ${esc(loadedAt || 'never')})`,
    `Students: ${students.n}, classes: ${sessions.n}, bot users: ${users.n}`,
    `Auto-update: ${refresh ? 'signed in' : 'not signed in (/login)'}, ${source ? 'link set' : 'link found automatically'}, ` +
      `last check ${esc(lastCheck || 'never')}`,
    lastError && `Last error: ${esc(lastError)}`,
  ].filter(Boolean).join('\n'));
}

const saveProfile = (env, chatId, from) => from && env.DB.prepare(
  'INSERT OR REPLACE INTO profiles (chat_id, username, name) VALUES (?, ?, ?)',
).bind(chatId, from.username || '', [from.first_name, from.last_name].filter(Boolean).join(' ')).run();

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Admin: a CSV of everyone who has written to the bot. Names of people who have not written
// since profiles were added are looked up once with getChat.
async function sendUserList(env, chatId) {
  const missing = await env.DB.prepare(
    'SELECT seen.chat_id FROM seen LEFT JOIN profiles p ON p.chat_id = seen.chat_id WHERE p.chat_id IS NULL LIMIT 40',
  ).all();
  for (const { chat_id } of missing.results) {
    const chat = await tg(env, 'getChat', { chat_id });
    if (chat.ok) await saveProfile(env, chat_id, chat.result);
  }
  const { results } = await env.DB.prepare(
    `SELECT seen.chat_id, p.username, p.name, u.sid, u.remind, seen.first, seen.last
     FROM seen LEFT JOIN profiles p ON p.chat_id = seen.chat_id LEFT JOIN users u ON u.chat_id = seen.chat_id
     ORDER BY seen.first`,
  ).all();
  const rows = [['telegram_id', 'username', 'name', 'student_number', 'reminders', 'first_seen_utc', 'last_seen_utc']];
  for (const r of results) {
    rows.push([r.chat_id, r.username ? `@${r.username}` : '', r.name, r.sid, r.sid ? (r.remind ? 'on' : 'off') : '', r.first, r.last]);
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `👥 ${results.length} people`);
  form.append('document', new Blob(['\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }),
    `bot-users-${astanaNow().date}.csv`);
  const sent = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: 'POST', body: form })).json();
  if (!sent.ok) return send(env, chatId, `❌ Could not send the file: ${esc(sent.description)}`);
}

const USERS_BUTTON = { inline_keyboard: [[{ text: '📄 Детальная статистика', callback_data: 'users_csv' }]] };

async function onButton(env, query) {
  await tg(env, 'answerCallbackQuery', { callback_query_id: query.id });
  const chatId = query.message?.chat?.id;
  if (query.data !== 'users_csv' || !chatId || String(query.from.id) !== (await kvGet(env, 'admin'))) return;
  return sendUserList(env, chatId);
}

async function showStats(env, chatId) {
  const r = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM seen) AS started,
    (SELECT COUNT(*) FROM users WHERE sid IS NOT NULL) AS saved,
    (SELECT COUNT(*) FROM users WHERE sid IS NOT NULL AND remind = 1) AS reminders,
    (SELECT COUNT(*) FROM seen WHERE first >= datetime('now', '-1 day')) AS newDay,
    (SELECT COUNT(*) FROM seen WHERE first >= datetime('now', '-7 days')) AS newWeek,
    (SELECT COUNT(*) FROM seen WHERE last >= datetime('now', '-1 day')) AS activeDay,
    (SELECT COUNT(*) FROM seen WHERE last >= datetime('now', '-7 days')) AS activeWeek`).first();
  return send(env, chatId, [
    '📊 <b>Bot users</b>',
    `Opened the bot: <b>${r.started}</b>`,
    `Saved a student number: <b>${r.saved}</b> (reminders on: ${r.reminders})`,
    `New: ${r.newDay} in 24 h, ${r.newWeek} in 7 days`,
    `Active: ${r.activeDay} in 24 h, ${r.activeWeek} in 7 days`,
  ].join('\n'), { reply_markup: USERS_BUTTON });
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
  return send(env, pending.chatId,
    '✅ Signed in. I will check for a new timetable every 3 hours. Send /update to load it right now.');
}

// ---------- Automatic timetable updates from SharePoint ----------

const shareId = (url) =>
  'u!' + btoa(String.fromCharCode(...new TextEncoder().encode(url))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');

async function microsoftToken(env) {
  const refresh = await kvGet(env, 'ms_refresh');
  if (!refresh) return null;
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: MS_CLIENT, refresh_token: refresh, scope: MS_SCOPE }),
  });
  const data = await res.json();
  if (!data.access_token) {
    const err = new Error(`Microsoft sign-in: ${data.error_description?.split('\r\n')[0] || data.error || `HTTP ${res.status}`}`);
    err.signedOut = ['invalid_grant', 'interaction_required'].includes(data.error);
    throw err;
  }
  // Refresh tokens rotate: keep the newest one.
  if (data.refresh_token && data.refresh_token !== refresh) await kvSet(env, 'ms_refresh', data.refresh_token);
  return data.access_token;
}

async function graph(token, path, init = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  if (res.status >= 400) {
    throw new Error(`SharePoint ${path.split('?')[0].split('/')[1]}: HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
  }
  return res;
}

// Newest Student_Timetables.html the signed-in student can see (used when /source is not set).
async function findTimetableUrl(token) {
  const res = await graph(token, '/search/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ entityTypes: ['driveItem'], query: { queryString: `filename:${FILE_NAME}` }, size: 25 }] }),
  });
  const hits = (await res.json()).value?.[0]?.hitsContainers?.flatMap((c) => c.hits || []) || [];
  const files = hits.map((h) => h.resource).filter((r) => r?.name?.toLowerCase() === FILE_NAME.toLowerCase());
  files.sort((a, b) => String(b.lastModifiedDateTime).localeCompare(String(a.lastModifiedDateTime)));
  if (!files.length) throw new Error(`Could not find ${FILE_NAME} on SharePoint. Send /source with its link.`);
  return files[0].webUrl;
}

// Downloads the timetable if it changed since the last load (or always with force) and loads it.
// Returns { ok, loaded, students, sessions, updated } or { ok: false, error }.
export async function autoUpdate(env, { force = false, quiet = false }) {
  try {
    const token = await microsoftToken(env);
    if (!token) return { ok: false, error: 'Not signed in to Microsoft. Send /login first.' };
    let url = await kvGet(env, 'source_url');
    if (!url) {
      url = await findTimetableUrl(token);
      await kvSet(env, 'source_url', url);
    }
    const id = shareId(url);
    const item = await (await graph(token, `/shares/${id}/driveItem?$select=eTag,lastModifiedDateTime`)).json();
    await kvSet(env, 'last_check', new Date().toISOString());
    if (!force && item.eTag && item.eTag === (await kvGet(env, 'tt_etag'))) return { ok: true, loaded: false };

    // /content answers with a redirect to a pre-signed download link, which must be fetched without our token.
    let res = await graph(token, `/shares/${id}/driveItem/content`, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) res = await fetch(res.headers.get('location'));
    if (!res.ok) throw new Error(`SharePoint download: HTTP ${res.status}`);
    const result = await loadTimetable(env.DB, await res.text(), { tt_etag: item.eTag || '', last_error: '' });
    const out = { ok: true, loaded: true, ...result };
    const admin = await kvGet(env, 'admin');
    if (admin && !quiet) await send(env, admin, updateMessage(out));
    return out;
  } catch (e) {
    console.error('auto update failed', e.stack || e);
    const previous = (await kvGet(env, 'last_error')) || '';
    const line = `${new Date().toISOString()} ${e.message}`.slice(0, 500); // ISO time is 24 characters
    await kvSet(env, 'last_error', line);
    if (e.signedOut) await kvDel(env, 'ms_refresh');
    const admin = await kvGet(env, 'admin');
    // Tell the admin once per new problem, not every 3 hours.
    if (admin && !quiet && previous.slice(25) !== line.slice(25)) {
      await send(env, admin, `❌ Timetable update failed: ${esc(e.message)}${e.signedOut ? '\nSend /login to sign in again.' : ''}`);
    }
    return { ok: false, error: e.message + (e.signedOut ? ' Send /login to sign in again.' : '') };
  }
}

function updateMessage(r) {
  if (!r.ok) return `❌ Timetable update failed: ${esc(r.error)}`;
  if (!r.loaded) return 'ℹ️ The timetable has not changed.';
  return `✅ Timetable updated (${esc(r.updated || 'no date')}): ${r.students} students, ${r.sessions} classes.`;
}
