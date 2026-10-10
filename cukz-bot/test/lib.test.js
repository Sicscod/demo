import test from 'node:test';
import assert from 'node:assert/strict';
import { astanaNow, addDays, mondayOf, addMinutes, formatDay, formatWeek, formatReminder, isStudentId } from '../src/lib.js';

const lesson = { date: '2026-10-09', start: '09:00', end: '09:50', code: 'EL0016', title: 'Academic Skills', type: 'Seminar', rooms: 'Room 8.3/C [70]', staff: 'A. Teacher', grp: 'Group 02' };

test('Astana time is UTC+5', () => {
  assert.deepEqual(astanaNow(Date.UTC(2026, 9, 9, 20, 30)), { date: '2026-10-10', time: '01:30', dow: 5 });
});

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(mondayOf('2026-10-11'), '2026-10-05'); // Sunday -> Monday before
  assert.equal(mondayOf('2026-10-05'), '2026-10-05');
  assert.equal(addMinutes('08:50', 30), '09:20');
  assert.equal(addMinutes('23:50', 30), '23:59');
});

test('student id is exactly 8 digits', () => {
  assert.ok(isStudentId('26082414'));
  assert.ok(!isStudentId('2608241'));
  assert.ok(!isStudentId('26082414a'));
});

test('day view', () => {
  const text = formatDay('2026-10-09', [lesson]);
  assert.match(text, /Friday, 09 Oct/);
  assert.match(text, /<b>9:00–9:50<\/b>  EL0016 · Academic Skills/);
  assert.match(text, /Seminar · Room 8.3\/C \[70\]/);
  assert.match(formatDay('2026-10-10', []), /No classes/);
});

test('week view groups by day and escapes HTML', () => {
  const text = formatWeek('2026-10-05', [{ ...lesson, title: 'A <b> & B' }, { ...lesson, date: '2026-10-05' }]);
  assert.ok(text.indexOf('Monday') < text.indexOf('Friday'));
  assert.match(text, /A &lt;b&gt; &amp; B/);
  assert.match(formatWeek('2026-10-05', []), /No classes this week/);
});

test('reminder', () => {
  assert.equal(formatReminder(lesson, 29),
    '⏰ <b>Starting in 29 min</b>\n\n📘 EL0016 · Academic Skills\n📍 Room 8.3/C [70]\n🕘 9:00–9:50');
  assert.doesNotMatch(formatReminder({ ...lesson, rooms: '' }, 29), /📍/);
});

test('typed dates', async () => {
  const { parseDate } = await import('../src/lib.js');
  assert.equal(parseDate('15.10', '2026-10-10'), '2026-10-15');
  assert.equal(parseDate('5/1/27', '2026-10-10'), '2027-01-05');
  assert.equal(parseDate('15-10-2026', '2026-10-10'), '2026-10-15');
  assert.equal(parseDate('2026-10-15', '2026-10-10'), '2026-10-15');
  assert.equal(parseDate('31.02', '2026-10-10'), null);
  assert.equal(parseDate('12345678', '2026-10-10'), null);
  assert.equal(parseDate('today', '2026-10-10'), null);
});
