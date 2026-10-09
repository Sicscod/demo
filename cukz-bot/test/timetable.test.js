import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStudentData, chunks, loadTimetable } from '../src/timetable.js';
import { fakeD1, timetableHtml, sample } from './d1.js';

test('finds the student-data JSON in the page', () => {
  const json = extractStudentData(timetableHtml(sample));
  assert.deepEqual(JSON.parse(json), sample);
  assert.throws(() => extractStudentData('<html><script>1</script></html>'), /No student-data/);
});

test('chunks keep surrogate pairs together', () => {
  const text = 'ab😀cd😀'.repeat(50);
  for (const size of [1, 2, 3, 7, 1000]) {
    const parts = chunks(text, size);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p)));
  }
});

test('loads sessions, students and calendar into D1', async () => {
  const db = fakeD1();
  const json = extractStudentData(timetableHtml(sample));
  // Small chunks so the JSON is stitched together from many statements.
  const result = await loadTimetable(db, timetableHtml(sample), { tt_etag: 'e1' }, 100);
  assert.deepEqual(result, { students: 2, sessions: 4, updated: '2026-10-09' });
  assert.ok(json.length > 1000);

  const rows = db.sqlite.prepare('SELECT * FROM sessions ORDER BY date, start').all();
  assert.deepEqual({ ...rows[0] }, {
    id: 'n0', date: '2026-10-09', start: '09:00', end: '09:50', code: 'EL0016', title: "O'Brien Skills",
    type: 'Seminar', rooms: 'Room 8.3/C [70]', staff: 'A. Teacher', grp: 'Group 02',
  });
  assert.equal(rows.find((r) => r.code === 'CH0001').id, 'retained-retained-17');
  const kv = Object.fromEntries(db.sqlite.prepare('SELECT k, v FROM kv').all().map((r) => [r.k, r.v]));
  assert.equal(kv.tt_updated, '2026-10-09');
  assert.deepEqual(JSON.parse(kv.tt_holidays), sample.holidays);
  assert.equal(kv.tt_min, '2026-09-07');
  assert.equal(kv.tt_max, '2026-12-18');
  assert.equal(kv.tt_etag, 'e1');
  assert.equal(kv.tt_json, undefined);
});

test('a bad file leaves the loaded timetable alone', async () => {
  const db = fakeD1();
  await loadTimetable(db, timetableHtml(sample));
  const broken = { ...sample, events: { ...sample.events, n9: { date: 'soon', start: '9:00', end: '9:50' } } };
  await assert.rejects(loadTimetable(db, timetableHtml(broken)), /Unexpected timetable format \(4\/5 classes/);
  await assert.rejects(loadTimetable(db, '<script id="student-data">{"events": </script>'), /could not be read/);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 4);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM kv WHERE k = 'tt_json'").get().n, 0);
});

test('reloading replaces old data and clears cached pictures', async () => {
  const db = fakeD1();
  await loadTimetable(db, timetableHtml(sample));
  db.sqlite.exec("INSERT INTO images (k, file_id) VALUES ('x', 'y')");
  await loadTimetable(db, timetableHtml({ ...sample, updated: 'new', events: { n5: sample.events.n0 }, students: { 22222222: ['n5'] } }));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM images').get().n, 0);
  assert.equal(db.sqlite.prepare("SELECT v FROM kv WHERE k = 'tt_updated'").get().v, 'new');
});
