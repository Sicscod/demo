// A small stand-in for the Cloudflare D1 binding on top of node:sqlite, for tests.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
    runNow: () => sqlite.prepare(sql).run(...args),
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try {
        for (const s of list) s.runNow();
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// Builds a Student_Timetables.html-like page around the given data.
export function timetableHtml(data) {
  return `<!doctype html><html><head><title>Timetables</title>
<script type="application/json" id="build-audit">{"source":"x"}</script>
<script type="application/json" id="student-data">${JSON.stringify(data)}</script>
</head><body><script>const data = JSON.parse(document.getElementById('student-data').textContent);</script></body></html>`;
}

export const sample = {
  updated: '2026-10-09',
  baseDate: '2026-09-07',
  minDate: '2026-09-07',
  maxDate: '2026-12-18',
  holidays: { '2026-10-26': 'Republic Day (substitute day off)' },
  holidaySource: 'https://example.org',
  events: {
    n0: { activity: 'Seminar · Group 02', module: 'EL0016', title: "O'Brien Skills", date: '2026-10-09', start: '9:00', end: '9:50', staff: 'A. Teacher', room: 'Room 8.3/C [70]', group: 'Group 02', type: 'Seminar', host: 'grid-000000000001' },
    n1: { activity: 'Tutorial', module: 'PX0003', title: 'Maths', date: '2026-10-09', start: '11:10', end: '13:00', staff: '', room: 'Room 8.2/B [80], Room 8.3/C [70]', group: 'Group B', type: 'Tutorial', host: 'grid-000000000002' },
    n2: { activity: 'Lecture', module: 'PX0003', title: 'Maths', date: '2026-10-12', start: '11:10', end: '13:00', staff: 'Z. Lecturer', room: 'Room 3.4 [160]', group: '', type: 'Lecture', host: 'grid-000000000003' },
    'retained-retained-17': { activity: 'Lab', module: 'CH0001', title: 'Chemistry', date: '2026-10-13', start: '14:00', end: '15:50', staff: 'Q', room: 'Lab 1', group: 'Group A', type: 'Lab', host: 'grid-000000000004' },
  },
  students: {
    10000001: ['n0', 'n1', 'n2', 'retained-retained-17'],
    10000002: ['n2'],
  },
};
