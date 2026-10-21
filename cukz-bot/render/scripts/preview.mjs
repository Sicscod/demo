// Renders sample images from made-up data: node scripts/preview.mjs <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderPng } from '../api/render.js';

const out = resolve(process.argv[2] || 'preview');
mkdirSync(out, { recursive: true });

const S = (start, end, code, title, type, rooms, staff, grp) => ({ start, end, code, title, type, rooms, staff, grp });

const academic = S('09:00', '09:50', 'EL0016', 'Academic Skills', 'Seminar', 'Room 8.3/C [70]', 'Dana Whitfield', 'Group 02');
const mathsLecture = S('11:10', '13:00', 'PX0003', 'Mathematical Foundations', 'Lecture', 'Room 3.4 [160]', 'Oliver Grant', 'Group A');
const mathsTutorial = S('13:30', '15:50', 'PX0003', 'Mathematical Foundations', 'Tutorial', 'Room 8.2/B [80], Room 8.3/C [70]', 'Marcus Hale', 'Group A');
const programming = S('16:00', '17:50', 'CM1101', 'Introduction to Programming and Computational Thinking', 'Lecture [Supported Locally]', 'Lecture Theatre 1 [200]', '', 'All groups');
const lab = S('10:00', '11:50', 'CH0042', 'General Chemistry', 'Lab', 'Chemistry Lab 2.11 [24]', 'Irina Volkova', '');
const revision = S('10:00', '11:00', 'PX0003', 'Mathematical Foundations', 'Revision & Support [Supported Locally]', 'Room 8.1 [40]', '', '');
const test = S('12:00', '13:00', 'EL0016', 'Academic Skills', 'Class Test', 'Exam Hall [300]', 'Dana Whitfield', 'Group 02');

const samples = {
  day: {
    kind: 'day',
    title: 'Friday, 09 Oct 2026',
    days: [{ label: 'FRI', closed: null, sessions: [academic, mathsTutorial, programming] }],
  },
  week: {
    kind: 'week',
    title: 'Week of 12 Oct 2026',
    days: [
      { label: 'MON', closed: null, sessions: [mathsLecture, mathsTutorial] },
      { label: 'TUE', closed: null, sessions: [academic, mathsLecture, mathsTutorial] },
      { label: 'WED', closed: 'Republic Day', sessions: [] },
      { label: 'THU', closed: null, sessions: [] },
      { label: 'FRI', closed: null, sessions: [academic, lab, programming] },
    ],
  },
  'week-7days': {
    kind: 'week',
    title: 'Week of 19 Oct 2026',
    days: [
      { label: 'MON', closed: null, sessions: [mathsLecture] },
      { label: 'TUE', closed: null, sessions: [academic] },
      { label: 'WED', closed: null, sessions: [mathsTutorial] },
      { label: 'THU', closed: null, sessions: [lab] },
      { label: 'FRI', closed: null, sessions: [academic] },
      { label: 'SAT', closed: null, sessions: [revision] },
      { label: 'SUN', closed: null, sessions: [test] },
    ],
  },
  'day-closed': {
    kind: 'day',
    title: 'Monday, 16 Dec 2026',
    days: [{ label: 'MON', closed: 'Independence Day', sessions: [] }],
  },
  'day-empty': {
    kind: 'day',
    title: 'Saturday, 10 Oct 2026',
    days: [{ label: 'SAT', closed: null, sessions: [] }],
  },
  types: {
    kind: 'day',
    title: 'Class types',
    days: [{
      label: '',
      closed: null,
      sessions: [
        'Lecture', 'Lecture [Supported Locally]', 'Tutorial', 'Seminar', 'Workshop', 'Lab',
        'See Separate Lab Schedule', 'Practical', 'Practical (Locally supported)', 'Class Test',
        'Assessment', 'Revision & Support', 'Revision & Support [Supported Locally]', 'Field Trip',
      ].map((type, i) => S(`${9 + (i % 8)}:00`, `${9 + (i % 8)}:50`, `XX${String(i + 1).padStart(4, '0')}`, 'Sample Module', type, 'Room 1.1 [30]', 'Sam Rivera', 'Group 01')),
    }],
  },
};

for (const [name, body] of Object.entries(samples)) {
  const t0 = performance.now();
  const png = await renderPng(body);
  const ms = performance.now() - t0;
  const file = join(out, `${name}.png`);
  writeFileSync(file, png);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  console.log(`${file}  ${w}x${h}  ${(png.length / 1024).toFixed(0)} KB  ${ms.toFixed(0)} ms`);
}
