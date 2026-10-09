// Loads the university's Student_Timetables.html into D1.
// The page embeds all data as JSON in <script type="application/json" id="student-data">:
//   { events: { key: { module, title, date, start, end, staff, room, group, type } },
//     students: { '12345678': [eventKey, ...] }, holidays: { date: name }, minDate, maxDate, updated }
// The worker only cuts that JSON out of the page; D1 parses it with json_each, which keeps the
// worker well inside the free plan's CPU limit.

const CHUNK = 60000; // characters per bound parameter, well under D1's statement size limit

export function extractStudentData(html) {
  const tag = /<script\b[^>]*\bid\s*=\s*["']?student-data\b[^>]*>/i.exec(html);
  if (!tag) throw new Error('No student-data block in the file. Is it Student_Timetables.html?');
  const start = tag.index + tag[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) throw new Error('The student-data block is cut off.');
  return html.slice(start, end).trim();
}

export function chunks(text, size = CHUNK) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = Math.min(i + size, text.length);
    const c = text.charCodeAt(j - 1);
    if (j < text.length && c >= 0xd800 && c <= 0xdbff) j += j - 1 > i ? -1 : 1; // keep surrogate pairs together
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

const FROM_JSON = "FROM kv, json_each(kv.v, '$.events') e WHERE kv.k = 'tt_json'";
const pad = (field) => `substr('0' || json_extract(e.value, '$.${field}'), -5)`; // 9:00 -> 09:00

export const CHECK_SQL = `SELECT
  (SELECT count(*) FROM json_each(v, '$.events')) AS events,
  (SELECT count(*) FROM json_each(v, '$.events') e
    WHERE json_extract(e.value, '$.date') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND json_extract(e.value, '$.start') GLOB '*[0-9]:[0-9][0-9]'
      AND json_extract(e.value, '$.end') GLOB '*[0-9]:[0-9][0-9]') AS goodEvents,
  (SELECT count(*) FROM json_each(v, '$.students')) AS students,
  (SELECT count(*) FROM json_each(v, '$.students') s
    WHERE s.type = 'array' AND s.key GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]') AS goodStudents,
  json_extract(v, '$.updated') AS updated
FROM kv WHERE k = 'tt_json'`;

export const SESSIONS_TABLE = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY,     -- event key from the file
  date TEXT NOT NULL,      -- YYYY-MM-DD (Astana local)
  start TEXT NOT NULL,     -- HH:MM
  end TEXT NOT NULL,       -- HH:MM
  code TEXT, title TEXT, type TEXT, rooms TEXT, staff TEXT, grp TEXT
)`;

// Telegram file_id of each rendered timetable image, keyed by a hash of what it shows.
export const IMAGES_TABLE = 'CREATE TABLE IF NOT EXISTS images (k TEXT PRIMARY KEY, file_id TEXT NOT NULL)';

// Run as one D1 batch (a transaction) after the JSON is stored in kv 'tt_json'.
export const LOAD_SQL = [
  'DROP TABLE IF EXISTS sessions',
  SESSIONS_TABLE,
  'CREATE INDEX sessions_date ON sessions(date, start)',
  `INSERT INTO sessions (id, date, start, end, code, title, type, rooms, staff, grp)
   SELECT e.key, json_extract(e.value, '$.date'), ${pad('start')}, ${pad('end')},
     json_extract(e.value, '$.module'), json_extract(e.value, '$.title'), json_extract(e.value, '$.type'),
     json_extract(e.value, '$.room'), json_extract(e.value, '$.staff'), json_extract(e.value, '$.group')
   ${FROM_JSON}`,
  'DELETE FROM students',
  `INSERT INTO students (sid, sessions) SELECT s.key, s.value
   FROM kv, json_each(kv.v, '$.students') s WHERE kv.k = 'tt_json'`,
  `INSERT OR REPLACE INTO kv (k, v)
   SELECT 'tt_updated', json_extract(v, '$.updated') FROM kv WHERE k = 'tt_json'
   UNION ALL SELECT 'tt_holidays', coalesce(json_extract(v, '$.holidays'), '{}') FROM kv WHERE k = 'tt_json'
   UNION ALL SELECT 'tt_min', json_extract(v, '$.minDate') FROM kv WHERE k = 'tt_json'
   UNION ALL SELECT 'tt_max', json_extract(v, '$.maxDate') FROM kv WHERE k = 'tt_json'`,
  IMAGES_TABLE,
  'DELETE FROM images',
  "DELETE FROM kv WHERE k = 'tt_json'",
];

// Replaces the timetable with the one in `html`. Returns { students, sessions, updated }.
export async function loadTimetable(db, html, extraKv = {}, chunkSize = CHUNK) {
  const parts = chunks(extractStudentData(html), chunkSize);
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('tt_json', ?)").bind(parts[0] ?? ''),
    ...parts.slice(1).map((p) => db.prepare("UPDATE kv SET v = v || ? WHERE k = 'tt_json'").bind(p)),
  ]);
  let check;
  try {
    check = await db.prepare(CHECK_SQL).first();
  } catch (e) {
    await db.prepare("DELETE FROM kv WHERE k = 'tt_json'").run();
    throw new Error(`The timetable data could not be read: ${e.message}`);
  }
  if (!check.events || !check.students || check.goodEvents !== check.events || check.goodStudents !== check.students) {
    await db.prepare("DELETE FROM kv WHERE k = 'tt_json'").run();
    throw new Error(`Unexpected timetable format (${check.goodEvents}/${check.events} classes, ` +
      `${check.goodStudents}/${check.students} students readable).`);
  }
  const meta = { tt_loaded_at: new Date().toISOString(), ...extraKv };
  await db.batch([
    ...LOAD_SQL.map((sql) => db.prepare(sql)),
    ...Object.entries(meta).map(([k, v]) => db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').bind(k, v)),
  ]);
  return { students: check.students, sessions: check.events, updated: check.updated };
}
