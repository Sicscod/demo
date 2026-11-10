// Drives the worker with fake KV, Telegram and Pushover.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, { webhookSecret } from '../src/worker.js';

const HIM = 100, HER = 200, STRANGER = 300;

function fakeKV() {
  const m = new Map();
  return { map: m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
}

function setup() {
  const env = { KV: fakeKV(), TELEGRAM_TOKEN: '123:abc', PUSHOVER_TOKEN: 'pt', PUSHOVER_USER: 'pu' };
  const calls = [];
  let receipt = 0;
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    if (u.includes('pushover')) {
      calls.push({ pushover: u.split('/1/')[1], body });
      return Response.json({ status: 1, receipt: `r${++receipt}` });
    }
    const method = u.split('/').pop();
    calls.push({ method, body });
    return Response.json({ ok: true, result: method === 'getMe' ? { username: 'luna_bot' } : {} });
  });
  const run = async (req) => {
    const waits = [];
    const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return res;
  };
  const tgReq = async (update) => new Request('https://wake.test/tg', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': await webhookSecret(env) }, body: JSON.stringify(update),
  });
  const say = async (from, text) => run(await tgReq({ message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: from === HER ? 'Аня' : 'X' }, text } }));
  const tap = async (from, data) => run(await tgReq({ callback_query: { id: 'q', from: { id: from }, data } }));
  const ack = async (r, k) => {
    const form = new FormData(); form.set('receipt', r);
    return run(new Request(`https://wake.test/ack?k=${k ?? await webhookSecret(env)}`, { method: 'POST', body: form }));
  };
  const cron = async () => { const w = []; await worker.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
  const sent = (chat) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chat).map((c) => c.body.text);
  const pushes = () => calls.filter((c) => c.pushover === 'messages.json').map((c) => c.body);
  const pair = async () => {
    await say(HIM, '/start');
    const link = sent(HIM)[0].match(/start=(\w+)/)[1];
    await say(HER, `/start ${link}`);
    calls.length = 0;
  };
  return { env, calls, say, tap, ack, cron, sent, pushes, pair };
}

test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 9, 21, 0) }));
test.afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

test('first /start owns the bot and gets an invite link; she joins with it', async () => {
  const t = setup();
  await t.say(HIM, '/start');
  assert.equal(t.env.KV.map.get('owner'), String(HIM));
  const link = t.sent(HIM)[0].match(/https:\/\/t\.me\/luna_bot\?start=(\w+)/);
  assert.ok(link);
  await t.say(HER, `/start ${link[1]}`);
  assert.equal(t.env.KV.map.get('partner'), String(HER));
  assert.equal(t.env.KV.map.has('invite'), false);
  assert.match(t.sent(HER)[0], /Не спится/);
  assert.match(t.sent(HIM).at(-1), /подключилась/);
});

test('strangers are ignored, even with an old or wrong code', async () => {
  const t = setup();
  await t.pair();
  await t.say(STRANGER, '/start whatever');
  await t.say(STRANGER, '🌙 Не спится');
  assert.deepEqual(t.calls, []);
});

test('her button sends an emergency Pushover alarm and he gets a Telegram message', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  const [p] = t.pushes();
  assert.equal(p.priority, 2);
  assert.equal(p.retry, 30);
  assert.equal(p.user, 'pu');
  assert.match(p.title, /Аня/);
  assert.match(p.callback, /^https:\/\/wake\.test\/ack\?k=/);
  assert.match(t.sent(HIM)[0], /не может уснуть/);
  assert.match(t.sent(HER)[0], /Бужу его/);
});

test('pressing twice within a minute does not start a second alarm', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  await t.say(HER, '🌙 Не спится');
  assert.equal(t.pushes().length, 1);
  assert.match(t.sent(HER).at(-1), /Уже бужу/);
});

test('when he acknowledges, she is told he is awake', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  await t.ack('r1');
  assert.match(t.sent(HER).at(-1), /Он проснулся/);
  assert.equal(t.env.KV.map.has('alarm'), false);
});

test('ack with a wrong key is rejected', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  const res = await t.ack('r1', 'nope');
  assert.equal(res.status, 403);
  assert.ok(t.env.KV.map.has('alarm'));
});

test('she can cancel the alarm', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  await t.tap(HER, 'cancel');
  assert.ok(t.calls.some((c) => c.pushover === 'receipts/r1/cancel.json'));
  assert.match(t.sent(HIM).at(-1), /выключила/);
  assert.equal(t.env.KV.map.has('alarm'), false);
});

test('after 30 minutes without waking she is told, once', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  mock.timers.tick(10 * 60 * 1000);
  await t.cron();
  assert.doesNotMatch(t.sent(HER).at(-1), /крепко спит/);
  mock.timers.tick(25 * 60 * 1000);
  await t.cron();
  await t.cron();
  assert.equal(t.sent(HER).filter((s) => /крепко спит/.test(s)).length, 1);
});

test('/test rings him without telling her', async () => {
  const t = setup();
  await t.pair();
  await t.say(HIM, '/test');
  assert.equal(t.pushes().length, 1);
  await t.ack('r1');
  assert.deepEqual(t.sent(HER), []);
  assert.match(t.sent(HIM).at(-1), /Проверка прошла/);
});

test('/invite replaces the link and disconnects the old partner', async () => {
  const t = setup();
  await t.pair();
  await t.say(HIM, '/invite');
  assert.equal(t.env.KV.map.has('partner'), false);
  t.calls.length = 0;
  await t.say(HER, '🌙 Не спится');
  assert.equal(t.pushes().length, 0);
});

test('Telegram webhook without the secret is rejected', async () => {
  const t = setup();
  const res = await worker.fetch(new Request('https://wake.test/tg', { method: 'POST', body: '{}' }), t.env, { waitUntil() {} });
  assert.equal(res.status, 403);
});

test('«Позвать» button sends an urgent alarm, and what she writes is passed on', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '📣 Позвать');
  const [p] = t.pushes();
  assert.equal(p.priority, 2);
  assert.match(p.title, /зовёт тебя/);
  assert.match(t.sent(HIM)[0], /зовёт тебя/);
  await t.say(HER, 'потеряла ключи');
  assert.match(t.sent(HIM).at(-1), /Она пишет: потеряла ключи/);
  assert.match(t.sent(HER).at(-1), /Передал/);
  await t.ack('r1');
  assert.match(t.sent(HER).at(-1), /Он увидел/);
});

test('urgent right after a sleepless alarm replaces it; not the other way round', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, '🌙 Не спится');
  await t.say(HER, '📣 Позвать');
  assert.equal(t.pushes().length, 2);
  assert.ok(t.calls.some((c) => c.pushover === 'receipts/r1/cancel.json'));
  await t.say(HER, '🌙 Не спится');
  assert.equal(t.pushes().length, 2);
});

test('her text without an alarm is not forwarded', async () => {
  const t = setup();
  await t.pair();
  await t.say(HER, 'привет');
  assert.deepEqual(t.sent(HIM), []);
  assert.deepEqual(t.pushes(), []);
});

test('in the daytime (his clock) she gets through with an ordinary notification, not a critical alarm', async () => {
  mock.timers.setTime(Date.UTC(2026, 10, 10, 6, 40)); // 14:40 at UTC+8
  const t = setup();
  await t.pair();
  await t.say(HER, '📣 Позвать');
  const [p] = t.pushes();
  assert.equal(p.priority, 0);
  assert.equal(p.callback, undefined);
  assert.match(t.sent(HIM)[0], /зовёт тебя/);
  assert.match(t.sent(HER).at(-1), /Днём/);
  await t.say(HER, 'ты где');
  assert.match(t.sent(HIM).at(-1), /Она пишет: ты где/);
  mock.timers.tick(31 * 60 * 1000);
  await t.cron();
  assert.doesNotMatch(t.sent(HER).at(-1), /30 минут/);
});

test('isNight follows the configured hours', async () => {
  const { isNight } = await import('../src/worker.js');
  const env = { TZ_OFFSET_MIN: '480', NIGHT_FROM: '22', NIGHT_TO: '9' };
  assert.equal(isNight(env, Date.UTC(2026, 10, 9, 14, 0)), true); // 22:00
  assert.equal(isNight(env, Date.UTC(2026, 10, 9, 0, 59)), true); // 08:59
  assert.equal(isNight(env, Date.UTC(2026, 10, 9, 1, 0)), false); // 09:00
  assert.equal(isNight(env, Date.UTC(2026, 10, 9, 13, 59)), false); // 21:59
});
