// Automatic SharePoint updates with fake Microsoft, Graph and Telegram endpoints.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { autoUpdate } from '../src/worker.js';
import { fakeD1, timetableHtml, sample } from './d1.js';

function setup({ etag = 'e1', token = { access_token: 'at', refresh_token: 'r2' } } = {}) {
  const env = { DB: fakeD1(), TELEGRAM_TOKEN: '123:abc' };
  env.DB.sqlite.exec("INSERT INTO kv (k, v) VALUES ('ms_refresh', 'r1'), ('admin', '42'), ('source_url', 'https://x.sharepoint.com/f?id=a b')");
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = String(url);
    calls.push(u.replace(/^https:\/\/[^/]+/, '').split('?')[0]);
    if (u.includes('/oauth2/v2.0/token')) return Response.json(token, { status: token.access_token ? 200 : 400 });
    if (u.endsWith('/driveItem/content')) {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://download.test/file' } });
    }
    if (u.includes('/driveItem')) return Response.json({ eTag: etag });
    if (u === 'https://download.test/file') return new Response(timetableHtml(sample));
    if (u.includes('api.telegram.org')) {
      calls.push(JSON.parse(init.body).text);
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  const kv = (k) => env.DB.sqlite.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v;
  return { env, calls, kv };
}

test.afterEach(() => mock.restoreAll());

test('downloads a changed file, loads it and tells the admin', async () => {
  const { env, calls, kv } = setup();
  assert.deepEqual(await autoUpdate(env, {}), { ok: true, loaded: true, students: 2, sessions: 4, updated: '2026-10-09' });
  assert.equal(kv('ms_refresh'), 'r2');
  assert.equal(kv('tt_etag'), 'e1');
  assert.match(calls.at(-1), /Timetable updated \(2026-10-09\): 2 students, 4 classes/);
  assert.ok(calls.some((c) => c.startsWith('/v1.0/shares/u!')));

  calls.length = 0;
  assert.deepEqual(await autoUpdate(env, {}), { ok: true, loaded: false });
  assert.ok(!calls.some((c) => c.endsWith('/content')));
  assert.equal((await autoUpdate(env, { force: true })).loaded, true);
});

test('expired sign-in is reported once and forgotten', async () => {
  const { env, calls, kv } = setup({ token: { error: 'invalid_grant', error_description: 'AADSTS700082: expired.\r\nTrace ID: x' } });
  const result = await autoUpdate(env, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /AADSTS700082: expired\. Send \/login/);
  assert.equal(kv('ms_refresh'), undefined);
  assert.match(calls.at(-1), /Send \/login to sign in again/);
  assert.deepEqual(await autoUpdate(env, {}), { ok: false, error: 'Not signed in to Microsoft. Send /login first.' });
});

test('the same error is not repeated to the admin', async () => {
  const { env, calls } = setup({ token: { error: 'temporarily_unavailable' } });
  await autoUpdate(env, {});
  await autoUpdate(env, {});
  assert.equal(calls.filter((c) => /failed/.test(c)).length, 1);
});

test('the update cron in the worker is one wrangler.toml schedules', async () => {
  const { readFileSync } = await import('node:fs');
  const cron = /const UPDATE_CRON = '([^']+)'/.exec(readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8'))[1];
  assert.ok(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').includes(`"${cron}"`));
});
