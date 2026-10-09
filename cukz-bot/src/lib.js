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

export function dayTitle(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `${DAYS[(d.getUTCDay() + 6) % 7]}, ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const trimTime = (t) => t.replace(/^0(\d)/, '$1');

export function formatSession(s) {
  const head = [s.code, s.title].filter(Boolean).map(esc).join(' · ');
  const where = [s.type, s.rooms].filter(Boolean).map(esc).join(' · ');
  const who = [s.staff, s.grp].filter(Boolean).map(esc).join(' · ');
  return [`<b>${trimTime(s.start)}–${trimTime(s.end)}</b>  ${head}`, where, who && `<i>${who}</i>`]
    .filter(Boolean).join('\n');
}

export function formatDay(date, sessions) {
  const title = `📅 <b>${dayTitle(date)}</b>`;
  if (!sessions.length) return `${title}\nNo classes 🎉`;
  return `${title}\n\n${sessions.map(formatSession).join('\n\n')}`;
}

// Week view: one block per day that has classes (Mon–Sun).
export function formatWeek(monday, sessions) {
  const byDay = new Map();
  for (const s of sessions) (byDay.get(s.date) || byDay.set(s.date, []).get(s.date)).push(s);
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const list = byDay.get(date);
    if (list?.length) parts.push(`📅 <b>${dayTitle(date)}</b>\n\n${list.map(formatSession).join('\n\n')}`);
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
