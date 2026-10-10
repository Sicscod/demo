// Pure helpers shared by the worker and tests: dates in Astana time and message formatting.

export const TZ_OFFSET_MIN = 5 * 60; // Kazakhstan, UTC+5 all year

// "Now" in Astana as { date: 'YYYY-MM-DD', time: 'HH:MM', dow: 0..6 (Mon=0) }
export function astanaNow(ms = Date.now()) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), dow: (d.getUTCDay() + 6) % 7 };
}

export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function mondayOf(date) {
  const d = new Date(date + 'T00:00:00Z');
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}

export function addMinutes(hhmm, n) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Math.min(h * 60 + m + n, 24 * 60 - 1);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayTitle(date, withYear = false) {
  const d = new Date(date + 'T00:00:00Z');
  const title = `${DAYS[(d.getUTCDay() + 6) % 7]}, ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${title} ${d.getUTCFullYear()}` : title;
}

export const weekdayLabel = (date) => dayTitle(date).slice(0, 3).toUpperCase(); // 'MON'

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const trimTime = (t) => t.replace(/^0(\d)/, '$1');

export function formatSession(s) {
  const head = [s.code, s.title].filter(Boolean).map(esc).join(' · ');
  const where = [s.type, s.rooms].filter(Boolean).map(esc).join(' · ');
  const who = [s.staff, s.grp].filter(Boolean).map(esc).join(' · ');
  return [`<b>${trimTime(s.start)}–${trimTime(s.end)}</b>  ${head}`, where, who && `<i>${who}</i>`]
    .filter(Boolean).join('\n');
}

const closedLine = (name) => `🏖 University closed — ${esc(name)}`;

// holidays: { 'YYYY-MM-DD': 'Republic Day' }
export function formatDay(date, sessions, holidays = {}) {
  const title = `📅 <b>${dayTitle(date)}</b>`;
  const closed = holidays[date] ? `\n${closedLine(holidays[date])}` : '';
  if (!sessions.length) return `${title}${closed || '\nNo classes 🎉'}`;
  return `${title}${closed}\n\n${sessions.map(formatSession).join('\n\n')}`;
}

// Week view: one block per day that has classes (Mon–Sun).
export function formatWeek(monday, sessions, holidays = {}) {
  const byDay = new Map();
  for (const s of sessions) (byDay.get(s.date) || byDay.set(s.date, []).get(s.date)).push(s);
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const list = byDay.get(date);
    if (list?.length) parts.push(`📅 <b>${dayTitle(date)}</b>\n\n${list.map(formatSession).join('\n\n')}`);
    else if (holidays[date] && i < 5) parts.push(`📅 <b>${dayTitle(date)}</b>\n${closedLine(holidays[date])}`);
  }
  const head = `🗓 <b>Week of ${dayTitle(monday).split(', ')[1]}</b>`;
  return parts.length ? `${head}\n\n${parts.join('\n\n— — —\n\n')}` : `${head}\nNo classes this week 🎉`;
}

export function formatReminder(s, minutes) {
  const body = [
    `📘 ${[s.code, s.title].filter(Boolean).map(esc).join(' · ')}`,
    s.rooms && `📍 ${esc(s.rooms)}`,
    `🕘 ${trimTime(s.start)}–${trimTime(s.end)}`,
  ].filter(Boolean);
  return `⏰ <b>Starting in ${minutes} min</b>\n\n${body.join('\n')}`;
}

export const isStudentId = (t) => /^\d{8}$/.test(t);

// "15.10", "15/10/2026", "15-10-26" or "2026-10-15" -> '2026-10-15' (year defaults to today's), else null.
export function parseDate(text, today) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  let [y, mo, d] = m ? [m[1], m[2], m[3]] : [];
  if (!m) {
    m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(text);
    if (!m) return null;
    [d, mo, y] = [m[1], m[2], m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : today.slice(0, 4)];
  }
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date ? date : null; // rejects 31.02
}
