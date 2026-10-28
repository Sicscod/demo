// Personal Telegram Business bot (Cloudflare Worker): shows the owner messages that
// people deleted or edited in their private chats.
// The owner connects it in Telegram: Settings → Telegram Business → Chatbots.

const KEEP_DAYS = 30;
const MAX_MEDIA = 25; // per delete event; free Workers allow 50 subrequests per run
const TZ_OFFSET_MIN = 5 * 60; // Astana

// Message field → Telegram send method and its file parameter. Order matters: an animation also has `document`.
export const MEDIA = [
  ['photo', 'sendPhoto', 'photo'],
  ['animation', 'sendAnimation', 'animation'],
  ['video', 'sendVideo', 'video'],
  ['video_note', 'sendVideoNote', 'video_note'],
  ['voice', 'sendVoice', 'voice'],
  ['audio', 'sendAudio', 'audio'],
  ['document', 'sendDocument', 'document'],
  ['sticker', 'sendSticker', 'sticker'],
];
const NO_CAPTION = new Set(['video_note', 'sticker']);
const OTHER = {
  location: 'геолокация', venue: 'место', contact: 'контакт', poll: 'опрос', dice: 'кубик', story: 'история',
};
const KIND_LABEL = {
  photo: 'фото', animation: 'GIF', video: 'видео', video_note: 'кружок', voice: 'голосовое',
  audio: 'аудио', document: 'файл', sticker: 'стикер',
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
    return new Response('msg-keeper is running');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.DB.prepare(`DELETE FROM messages WHERE at < datetime('now', '-${KEEP_DAYS} days')`).run());
  },
};

export async function webhookSecret(env) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_TOKEN));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

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

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Settings ----------

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}

async function ownerId(env) {
  const v = await getSetting(env, 'owner_id');
  return v ? Number(v) : null;
}

// True when the business connection belongs to the owner. Unknown ids are checked with Telegram once.
async function isOwnerConnection(env, connId, owner) {
  if (!connId || !owner) return false;
  const known = await getSetting(env, `conn:${connId}`);
  if (known !== null) return known === '1';
  const res = await tg(env, 'getBusinessConnection', { business_connection_id: connId });
  if (!res.ok) return false;
  const mine = res.result.user.id === owner;
  await setSetting(env, `conn:${connId}`, mine ? '1' : '0');
  return mine;
}

// ---------- Updates ----------

export async function handleUpdate(update, env) {
  if (update.message) return onBotMessage(update.message, env);
  const owner = await ownerId(env);
  if (!owner) return;
  if (update.business_connection) return onConnection(update.business_connection, env, owner);
  const m = update.business_message || update.edited_business_message;
  if (m) {
    if (!(await isOwnerConnection(env, m.business_connection_id, owner))) return;
    if (m.from?.id === owner || m.chat.type !== 'private') return; // only what others send the owner
    if (update.business_message) return saveMessage(env, m);
    return onEdit(env, m, owner);
  }
  const d = update.deleted_business_messages;
  if (d) {
    if (!(await isOwnerConnection(env, d.business_connection_id, owner))) return;
    return onDelete(env, d, owner);
  }
}

async function onBotMessage(m, env) {
  if (m.chat.type !== 'private') return;
  const owner = await ownerId(env);
  if (!owner && (m.text || '').startsWith('/start')) {
    await setSetting(env, 'owner_id', m.from.id);
    return tg(env, 'sendMessage', { chat_id: m.chat.id, parse_mode: 'HTML', text: HELP });
  }
  if (m.from.id !== owner) {
    return tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'Это личный бот, он работает только для своего владельца.' });
  }
  if ((m.text || '').startsWith('/stats')) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT chat_id) AS chats FROM messages').first();
    return tg(env, 'sendMessage', {
      chat_id: m.chat.id,
      text: `Хранится ${row.n} сообщений из ${row.chats} чатов (за последние ${KEEP_DAYS} дней).`,
    });
  }
  return tg(env, 'sendMessage', { chat_id: m.chat.id, parse_mode: 'HTML', text: HELP });
}

const HELP = `Я сохраняю сообщения из твоих личных чатов и показываю, если собеседник их <b>удалил</b> или <b>изменил</b>.

Подключение: Настройки → Telegram Business → Чат-боты → добавь меня. Нужен Telegram Premium.
Работаю только для тебя, сообщения храню ${KEEP_DAYS} дней.

/stats — сколько сообщений сохранено`;

async function onConnection(c, env, owner) {
  const mine = c.user.id === owner;
  await setSetting(env, `conn:${c.id}`, mine ? '1' : '0');
  if (!mine) return;
  await tg(env, 'sendMessage', {
    chat_id: owner,
    text: c.is_enabled
      ? '✅ Подключено. Теперь покажу удалённые и изменённые сообщения из твоих чатов.'
      : '⏸ Бот отключён от твоего аккаунта, новые сообщения не сохраняются.',
  });
}

// Kind, text and file_id of a message.
export function describe(m) {
  for (const [field] of MEDIA) {
    if (!m[field]) continue;
    const file = field === 'photo' ? m.photo[m.photo.length - 1] : m[field];
    return { kind: field, text: m.caption ?? (field === 'sticker' ? m.sticker.emoji : null) ?? null, file_id: file.file_id };
  }
  for (const [field, label] of Object.entries(OTHER)) {
    if (m[field]) return { kind: 'text', text: `[${label}]`, file_id: null };
  }
  return { kind: 'text', text: m.text ?? m.caption ?? '[сообщение]', file_id: null };
}

function senderName(m) {
  const u = m.from || m.chat;
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.title || 'Без имени';
}

async function saveMessage(env, m) {
  const { kind, text, file_id } = describe(m);
  await env.DB.prepare(`INSERT INTO messages (chat_id, message_id, from_name, from_username, kind, text, file_id, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET kind = excluded.kind, text = excluded.text, file_id = excluded.file_id`)
    .bind(m.chat.id, m.message_id, senderName(m), m.from?.username ?? null, kind, text, file_id, m.date).run();
}

function who(row) {
  const name = `<b>${esc(row.from_name)}</b>`;
  return row.from_username ? `${name} (@${esc(row.from_username)})` : name;
}

export function formatTime(unix) {
  const d = new Date((unix + TZ_OFFSET_MIN * 60) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function onEdit(env, m, owner) {
  const old = await env.DB.prepare('SELECT * FROM messages WHERE chat_id = ? AND message_id = ?').bind(m.chat.id, m.message_id).first();
  const now = describe(m);
  await saveMessage(env, m);
  if (old && (old.text ?? '') === (now.text ?? '') && old.file_id === now.file_id) return; // nothing visible changed
  const row = old || { from_name: senderName(m), from_username: m.from?.username, sent_at: m.date };
  const before = old ? quote(old) : '<i>не сохранено (пришло до подключения бота)</i>';
  const mediaChanged = old && old.file_id && old.file_id !== now.file_id;
  const text = `✏️ ${who(row)} изменил(а) сообщение от ${formatTime(row.sent_at)}\n\n<b>Было:</b>\n${before}\n\n<b>Стало:</b>\n${quote(now)}`;
  await tg(env, 'sendMessage', { chat_id: owner, parse_mode: 'HTML', text: cut(text) });
  if (mediaChanged) await sendMedia(env, owner, old, 'Было:');
}

function quote(row) {
  const label = KIND_LABEL[row.kind];
  const body = row.text ? esc(row.text) : '';
  return `<blockquote>${label ? `[${label}] ` : ''}${body}</blockquote>`;
}

function cut(text) {
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

async function sendMedia(env, chat, row, caption) {
  const [, method, param] = MEDIA.find(([f]) => f === row.kind);
  const body = { chat_id: chat, [param]: row.file_id };
  if (!NO_CAPTION.has(row.kind)) {
    body.caption = caption.slice(0, 1024);
    body.parse_mode = 'HTML';
  }
  return tg(env, method, body);
}

async function onDelete(env, d, owner) {
  if (d.chat.type && d.chat.type !== 'private') return;
  const ids = d.message_ids;
  const rows = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND message_id IN (${part.map(() => '?').join(',')}) ORDER BY message_id`,
    ).bind(d.chat.id, ...part).all();
    rows.push(...results);
  }
  if (!rows.length) return; // the owner's own messages, or ones sent before the bot was connected

  const chatName = [d.chat.first_name, d.chat.last_name].filter(Boolean).join(' ');
  const head = `🗑 ${who(rows[0] || { from_name: chatName })} удалил(а) ${rows.length === 1 ? 'сообщение' : `${rows.length} сообщ.`}`;

  // Texts go together in as few messages as possible; media one by one.
  const texts = rows.filter((r) => !r.file_id);
  const media = rows.filter((r) => r.file_id);
  let chunk = head;
  for (const r of texts) {
    const line = `\n\n<i>${formatTime(r.sent_at)}</i>\n${quote(r)}`;
    if (chunk.length + line.length > 4000) {
      await tg(env, 'sendMessage', { chat_id: owner, parse_mode: 'HTML', text: chunk });
      chunk = '';
    }
    chunk += line;
  }
  if (chunk && (texts.length || !media.length)) await tg(env, 'sendMessage', { chat_id: owner, parse_mode: 'HTML', text: cut(chunk) });

  for (const r of media.slice(0, MAX_MEDIA)) {
    const caption = `${texts.length ? '' : `${head}\n`}<i>${formatTime(r.sent_at)}</i>${r.text ? `\n${esc(r.text)}` : ''}`;
    if (NO_CAPTION.has(r.kind)) {
      await tg(env, 'sendMessage', { chat_id: owner, parse_mode: 'HTML', text: `${caption}\n[${KIND_LABEL[r.kind]}]` });
    }
    await sendMedia(env, owner, r, caption);
  }
  if (media.length > MAX_MEDIA) {
    await tg(env, 'sendMessage', { chat_id: owner, text: `…и ещё ${media.length - MAX_MEDIA} медиа не показано.` });
  }
  // Shown once; no need to keep them.
  await env.DB.prepare(`DELETE FROM messages WHERE chat_id = ? AND message_id IN (${rows.map(() => '?').join(',')})`)
    .bind(d.chat.id, ...rows.map((r) => r.message_id)).run();
}
