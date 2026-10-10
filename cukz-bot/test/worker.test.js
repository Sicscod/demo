// Drives the worker's Telegram webhook with fake D1, Telegram and render service.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, { webhookSecret } from '../src/worker.js';
import { loadTimetable } from '../src/timetable.js';
import { fakeD1, timetableHtml, sample } from './d1.js';

async function setup({ renderOk = true } = {}) {
  const env = { DB: fakeD1(), TELEGRAM_TOKEN: '123:abc', RENDER_URL: 'https://render.test/api/render', RENDER_KEY: 'k' };
  await loadTimetable(env.DB, timetableHtml(sample));
  env.DB.sqlite.exec("INSERT INTO users (chat_id, sid) VALUES (7, '10000001')");
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://render.test')) {
      calls.push({ render: JSON.parse(init.body), key: init.headers['x-render-key'] });
      return renderOk ? new Response(new Uint8Array([137, 80, 78, 71])) : new Response('nope', { status: 500 });
    }
    const method = u.split('/').pop();
    const body = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
    calls.push({ method, body });
    const result = method === 'sendPhoto' ? { photo: [{ file_id: 'small' }, { file_id: 'big' }] } : {};
    return Response.json({ ok: true, result });
  });
  const say = async (text, from) => {
    const waits = [];
    const req = new Request('https://bot.test/tg', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(env) },
      body: JSON.stringify({ message: { chat: { id: 7, type: 'private' }, from, text } }),
    });
    await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { env, calls, say };
}

test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 9, 3, 0) })); // Fri 08:00 Astana
test.afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

test('/today sends a picture and reuses it the second time', async () => {
  const { calls, say } = await setup();
  await say('/today');
  const render = calls.find((c) => c.render);
  assert.equal(render.key, 'k');
  assert.equal(render.render.kind, 'day');
  assert.equal(render.render.title, 'Friday, 09 Oct 2026');
  assert.deepEqual(render.render.days[0].sessions.map((s) => [s.start, s.code]), [['09:00', 'EL0016'], ['11:10', 'PX0003']]);
  assert.equal(calls.at(-1).method, 'sendPhoto');

  calls.length = 0;
  await say('Today');
  assert.deepEqual(calls.map((c) => c.method), ['sendPhoto']);
  assert.equal(calls[0].body.photo, 'big');
});

test('/nextweek has Mon–Fri columns, the holiday-free week and weekend only when used', async () => {
  const { calls, say } = await setup();
  await say('/nextweek');
  const { render } = calls.find((c) => c.render);
  assert.equal(render.title, 'Week of 12 Oct 2026');
  assert.deepEqual(render.days.map((d) => [d.label, d.sessions.length]), [['MON', 1], ['TUE', 1], ['WED', 0], ['THU', 0], ['FRI', 0]]);
});

test('holiday and dates outside the timetable get text', async () => {
  const { calls, say } = await setup();
  mock.timers.setTime(Date.UTC(2026, 9, 26, 3, 0));
  await say('/today');
  assert.match(calls.at(-1).body.text, /University closed — Republic Day/);
  mock.timers.setTime(Date.UTC(2027, 0, 11, 3, 0));
  await say('/week');
  assert.match(calls.at(-1).body.text, /not published the timetable/);
});

test('falls back to text when the picture cannot be drawn', async () => {
  const { calls, say } = await setup({ renderOk: false });
  await say('/today');
  assert.equal(calls.at(-1).method, 'sendMessage');
  assert.match(calls.at(-1).body.text, /EL0016 · O'Brien Skills/);
});

test('a typed date or /date shows that day', async () => {
  const { calls, say } = await setup();
  await say('12.10');
  assert.equal(calls.find((c) => c.render).render.title, 'Monday, 12 Oct 2026');
  calls.length = 0;
  await say('/date 13.10.2026');
  assert.equal(calls.find((c) => c.render).render.title, 'Tuesday, 13 Oct 2026');
  await say('/date soon');
  assert.match(calls.at(-1).body.text, /Send a date like/);
});

test('a user who blocks the bot is marked', async () => {
  const { env, say } = await setup();
  await say('/today', { first_name: 'A' });
  mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
  await say('/today');
  assert.ok(env.DB.sqlite.prepare('SELECT blocked FROM people WHERE chat_id = 7').get().blocked);
});

test('/stats counts people for the admin only', async () => {
  const { env, calls, say } = await setup();
  await say('/stats');
  assert.doesNotMatch(calls.at(-1).body.text, /Bot users/);
  env.DB.sqlite.exec("INSERT INTO kv (k, v) VALUES ('admin', '7')");
  await say('/stats');
  const text = calls.at(-1).body.text;
  assert.match(text, /Opened the bot: <b>1<\/b>/);
  assert.match(text, /Saved a student number: <b>1<\/b> \(reminders on: 1\)/);
  assert.match(text, /Active: 1 in 24 h/);
});

test('the button under /stats sends the admin a CSV of everyone', async () => {
  const { env, calls, say } = await setup();
  env.DB.sqlite.exec("INSERT INTO kv (k, v) VALUES ('admin', '7')");
  env.DB.sqlite.exec("INSERT INTO seen (chat_id, first, last) VALUES (9, '2026-10-09 10:00:00', '2026-10-09 10:00:00')");
  await say('/today', { username: 'me', first_name: 'San', last_name: 'Zh', language_code: 'ru' });
  await say('/stats');
  const stats = calls.at(-1).body.text;
  assert.match(stats, /Popular \(7 days\): today 1/);
  assert.match(stats, /Languages: ru 1/);
  assert.match(stats, /Top modules: \w+ 1/);
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data, 'users_csv');

  const press = async (fromId) => {
    const req = new Request('https://bot.test/tg', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(env) },
      body: JSON.stringify({ callback_query: { id: 'q', from: { id: fromId }, data: 'users_csv', message: { chat: { id: fromId } } } }),
    });
    const waits = [];
    await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  calls.length = 0;
  await press(8);
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery']);

  await press(7);
  const doc = calls.find((c) => c.method === 'sendDocument');
  const bytes = new Uint8Array(await doc.body.document.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // BOM so Excel reads Cyrillic names
  const csv = await doc.body.document.text();
  assert.match(csv, /^telegram_id,username,name,student_number,reminders,language,premium/);
  assert.match(csv, /\n9,,,,,,,,2026-10-09 10:00:00,2026-10-09 10:00:00,0,0,,0/);
  assert.match(csv, /\n7,@me,San Zh,10000001,on,ru,no,,[^,]+,[^,]+,1,1,today,0/);
  assert.ok(calls.some((c) => c.method === 'getChat'));
});
