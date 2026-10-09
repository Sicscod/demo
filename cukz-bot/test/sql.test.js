// Loads generated SQL into a local SQLite (node:sqlite) and runs the worker's queries against it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildSql } from '../scripts/ingest.mjs';

const workerSrc = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const i = workerSrc.indexOf(start);
  return workerSrc.slice(i + start.length, workerSrc.indexOf(end, i + start.length));
};
const SESSIONS_FOR = between('env.DB.prepare(\n    `', '`');
const REMINDERS = between('const { results } = await env.DB.prepare(\n    `SELECT u.chat_id', '`');

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  d.exec(buildSql({
    updated: '7 October 2026',
    sessions: [
      { id: 1, date: '2026-10-09', start: '09:00', end: '09:50', code: 'EL0016', title: "O'Brien Skills", type: 'Seminar', rooms: 'Room 8.3/C', staff: 'X', grp: '02' },
      { id: 2, date: '2026-10-09', start: '11:10', end: '13:00', code: 'PX0003', title: 'Maths', type: 'Tutorial', rooms: 'Room 8.2/B', staff: 'Y', grp: 'B' },
      { id: 3, date: '2026-10-12', start: '11:10', end: '13:00', code: 'PX0003', title: 'Maths', type: 'Lecture', rooms: 'Room 3.4', staff: 'Z', grp: 'A' },
    ],
    students: { 26082414: [1, 2, 3], 11111111: [3] },
  }, { tt_hash: 'abc' }));
  return d;
}

test('sessions for a student in a date range', () => {
  const rows = db().prepare(SESSIONS_FOR).all('26082414', '2026-10-09', '2026-10-09');
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.equal(rows[0].title, "O'Brien Skills");
  assert.equal(db().prepare(SESSIONS_FOR).all('11111111', '2026-10-05', '2026-10-11').length, 0);
});

test('reminder query finds classes starting in the window', () => {
  const d = db();
  d.exec("INSERT INTO users (chat_id, sid) VALUES (100, '26082414'), (200, '11111111'), (300, '26082414')");
  d.exec('UPDATE users SET remind = 0 WHERE chat_id = 300');
  const rows = d.prepare('SELECT u.chat_id' + REMINDERS).all('2026-10-09', '08:35', '09:00');
  assert.deepEqual(rows.map((r) => [r.chat_id, r.code]), [[100, 'EL0016']]);
  assert.equal(d.prepare('SELECT u.chat_id' + REMINDERS).all('2026-10-09', '09:00', '09:05').length, 0);
});

test('reloading replaces old data and stores meta', () => {
  const d = db();
  d.exec(buildSql({ updated: 'new', sessions: [{ id: 9, date: '2026-11-01', start: '10:00', end: '11:00' }], students: { 22222222: [9] } }));
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(d.prepare("SELECT v FROM kv WHERE k = 'tt_updated'").get().v, 'new');
  assert.equal(d.prepare("SELECT v FROM kv WHERE k = 'tt_hash'").get().v, 'abc'); // kept from before
});
