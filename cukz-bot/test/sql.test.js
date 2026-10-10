// Loads a sample timetable into node:sqlite and runs the worker's queries against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTimetable } from '../src/timetable.js';
import { fakeD1, timetableHtml, sample } from './d1.js';

const workerSrc = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const i = workerSrc.indexOf(start);
  return workerSrc.slice(i + start.length, workerSrc.indexOf(end, i + start.length));
};
const SESSIONS_FOR = between('env.DB.prepare(\n    `', '`');
const REMINDERS = between('const { results } = await env.DB.prepare(\n    `SELECT u.chat_id', '`');

async function db() {
  const d = fakeD1();
  await loadTimetable(d, timetableHtml(sample));
  return d.sqlite;
}

test('sessions for a student in a date range', async () => {
  const d = await db();
  const rows = d.prepare(SESSIONS_FOR).all('10000001', '2026-10-09', '2026-10-09');
  assert.deepEqual(rows.map((r) => r.id), ['n0', 'n1']);
  assert.equal(rows[0].title, "O'Brien Skills");
  assert.deepEqual(d.prepare(SESSIONS_FOR).all('10000001', '2026-10-12', '2026-10-18').map((r) => r.code), ['PX0003', 'CH0001']);
  assert.equal(d.prepare(SESSIONS_FOR).all('10000002', '2026-10-05', '2026-10-11').length, 0);
});

test('reminder query finds classes starting in the window', async () => {
  const d = await db();
  d.exec("INSERT INTO users (chat_id, sid) VALUES (100, '10000001'), (200, '10000002'), (300, '10000001')");
  d.exec('UPDATE users SET remind = 0 WHERE chat_id = 300');
  const rows = d.prepare('SELECT u.chat_id' + REMINDERS).all('2026-10-09', '08:35', '09:00');
  assert.deepEqual(rows.map((r) => [r.chat_id, r.code]), [[100, 'EL0016']]);
  assert.equal(d.prepare('SELECT u.chat_id' + REMINDERS).all('2026-10-09', '09:00', '09:05').length, 0);
});
