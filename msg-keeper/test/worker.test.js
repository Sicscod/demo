import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './d1.js';
import { handleUpdate, describe, formatTime } from '../src/worker.js';

const OWNER = 111;
const FRIEND = { id: 222, is_bot: false, first_name: 'Аня', username: 'anya' };
const STRANGER = 333;
let env, sent;

beforeEach(() => {
  env = { DB: fakeD1(), TELEGRAM_TOKEN: 'x' };
  sent = [];
  globalThis.fetch = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    sent.push({ method, ...body });
    if (method === 'getBusinessConnection') {
      const user = body.business_connection_id === 'mine' ? OWNER : STRANGER;
      return Response.json({ ok: true, result: { id: body.business_connection_id, user: { id: user }, is_enabled: true } });
    }
    return Response.json({ ok: true, result: {} });
  };
});

const chat = { id: FRIEND.id, type: 'private', first_name: 'Аня' };
const msg = (id, extra, conn = 'mine') => ({
  business_connection_id: conn, message_id: id, from: FRIEND, chat, date: 1793200000, ...extra,
});

async function claim() {
  await handleUpdate({ message: { message_id: 1, from: { id: OWNER }, chat: { id: OWNER, type: 'private' }, text: '/start' } }, env);
  sent = [];
}

test('first /start becomes the owner, others are turned away', async () => {
  await claim();
  await handleUpdate({ message: { message_id: 2, from: { id: STRANGER }, chat: { id: STRANGER, type: 'private' }, text: '/start' } }, env);
  assert.match(sent[0].text, /личный бот/);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'owner_id'").first();
  assert.equal(row.value, String(OWNER));
});

test('deleted text is sent to the owner', async () => {
  await claim();
  await handleUpdate({ business_message: msg(10, { text: 'привет <b>' }) }, env);
  await handleUpdate({ deleted_business_messages: { business_connection_id: 'mine', chat, message_ids: [10, 99] } }, env);
  const out = sent.filter((s) => s.method === 'sendMessage');
  assert.equal(out.length, 1);
  assert.equal(out[0].chat_id, OWNER);
  assert.match(out[0].text, /Аня<\/b> \(@anya\) удалил\(а\) сообщение/);
  assert.match(out[0].text, /привет &lt;b&gt;/);
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first();
  assert.equal(left.n, 0);
});

test('deleted photo is re-sent by file_id', async () => {
  await claim();
  await handleUpdate({ business_message: msg(11, { photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: 'смотри' }) }, env);
  await handleUpdate({ deleted_business_messages: { business_connection_id: 'mine', chat, message_ids: [11] } }, env);
  const photo = sent.find((s) => s.method === 'sendPhoto');
  assert.equal(photo.photo, 'big');
  assert.match(photo.caption, /удалил\(а\) сообщение/);
  assert.match(photo.caption, /смотри/);
});

test('edit shows before and after', async () => {
  await claim();
  await handleUpdate({ business_message: msg(12, { text: 'буду в 5' }) }, env);
  await handleUpdate({ edited_business_message: msg(12, { text: 'буду в 7', edit_date: 1793200100 }) }, env);
  const out = sent.find((s) => s.method === 'sendMessage');
  assert.match(out.text, /изменил\(а\)/);
  assert.match(out.text, /Было:<\/b>\n<blockquote>буду в 5/);
  assert.match(out.text, /Стало:<\/b>\n<blockquote>буду в 7/);
  // An edit that changes nothing visible is ignored.
  sent = [];
  await handleUpdate({ edited_business_message: msg(12, { text: 'буду в 7' }) }, env);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0);
});

test("the owner's own messages are not stored", async () => {
  await claim();
  await handleUpdate({ business_message: msg(13, { from: { id: OWNER, first_name: 'Я' }, text: 'моё' }) }, env);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first();
  assert.equal(n.n, 0);
});

test("someone else's business connection is ignored", async () => {
  await claim();
  await handleUpdate({ business_connection: { id: 'theirs', user: { id: STRANGER }, user_chat_id: STRANGER, is_enabled: true, date: 1 } }, env);
  await handleUpdate({ business_message: msg(14, { text: 'чужое' }, 'theirs') }, env);
  await handleUpdate({ business_message: msg(15, { text: 'тоже чужое' }, 'unknown') }, env);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first();
  assert.equal(n.n, 0);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0);
});

test('nothing works before an owner exists', async () => {
  await handleUpdate({ business_message: msg(16, { text: 'x' }) }, env);
  assert.equal(sent.length, 0);
});

test('describe picks the right kind', () => {
  assert.equal(describe({ animation: { file_id: 'a' }, document: { file_id: 'd' } }).kind, 'animation');
  assert.equal(describe({ voice: { file_id: 'v' } }).file_id, 'v');
  assert.equal(describe({ location: {} }).text, '[геолокация]');
  assert.equal(formatTime(0), '01.01 05:00');
});
