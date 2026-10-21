// Pure layout: request body -> { element, width, height } for @vercel/og.
// No I/O here. Text is wrapped by this module (using real font advance
// widths), so every line is its own fixed-height row and the image height is
// known exactly before rendering.

export class InputError extends Error {}

export const LIMITS = { days: 7, sessions: 30, text: 300, label: 24, title: 120 };

// Matched against the start of the class type, case-insensitive, first hit wins.
const TYPE_COLORS = [
  ['lecture', '#4a6ea8'], // blue
  ['tutorial', '#2bae66'], // green
  ['seminar', '#e8812a'], // orange
  ['workshop', '#c2519a'], // magenta
  ['lab', '#7e57c2'], // purple
  ['see separate lab', '#9a7fd1'], // light purple: the lab is listed elsewhere
  ['practical', '#16a2a2'], // teal
  ['class test', '#d64541'], // red
  ['test', '#d64541'],
  ['exam', '#b0322a'],
  ['assessment', '#b0322a'], // darker red
  ['revision', '#6b83a0'], // gray-blue
];
export const NEUTRAL_COLOR = '#8c9096';
const CLOSED_COLOR = '#b4b4b4';

export function colorForType(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!t) return NEUTRAL_COLOR;
  for (const [prefix, color] of TYPE_COLORS) if (t.startsWith(prefix)) return color;
  return NEUTRAL_COLOR;
}

const INK = {
  title: '#1a1a1a',
  header: '#333333',
  time: '#222222',
  meta: '#444444',
  staff: '#666666',
  quiet: '#9a9a9a',
  closed: '#555555',
  card: '#f4f4f4',
  page: '#ffffff',
};

// Sizes in px, taken from the old bot's day image (1050 px wide).
const DAY = {
  width: 1050,
  margin: 43,
  top: 65,
  titleSize: 46.5,
  titleLine: 56,
  titleGap: 34,
  bar: 19,
  barInset: 3,
  radius: 10,
  padTop: 35,
  padBottom: 21,
  padLeft: 28,
  padRight: 28,
  bigSize: 28.5,
  bigLine: 43,
  metaSize: 24.5,
  metaLine: 39,
  timeGap: 10,
  staffGap: 8,
  cardGap: 26,
  bottom: 48,
};

// The week image uses the same design scaled so five columns are 2000 px wide
// (column 356, gap 36, margin 38). More columns make the image wider.
const WEEK_SCALE = 356 / 413;
const WEEK = {
  ...scaleAll(DAY, WEEK_SCALE),
  top: 55,
  margin: 38,
  column: 356,
  columnGap: 36,
  titleSize: 43,
  titleLine: 52,
  titleGap: 38,
  headerSize: 26.5,
  headerLine: 32,
  headerGap: 12,
};

function scaleAll(m, s) {
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = k.endsWith('Size') ? Math.round(v * s * 10) / 10 : Math.round(v * s);
  }
  return out;
}

// ---------- input ----------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function text(value, where, max = LIMITS.text) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') throw new InputError(`${where} must be a string`);
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length > max) throw new InputError(`${where} is longer than ${max} characters`);
  return clean;
}

const SESSION_FIELDS = ['start', 'end', 'code', 'title', 'type', 'rooms', 'staff', 'grp'];

export function validate(body) {
  if (!isPlainObject(body)) throw new InputError('body must be a JSON object');
  const { kind } = body;
  if (kind !== 'day' && kind !== 'week') throw new InputError('kind must be "day" or "week"');
  const title = text(body.title, 'title', LIMITS.title);
  if (!Array.isArray(body.days)) throw new InputError('days must be an array');
  if (kind === 'day' && body.days.length !== 1) throw new InputError('kind "day" needs exactly one entry in days');
  if (kind === 'week' && (body.days.length < 1 || body.days.length > LIMITS.days)) {
    throw new InputError(`kind "week" needs 1 to ${LIMITS.days} entries in days`);
  }
  const days = body.days.map((day, i) => {
    const at = `days[${i}]`;
    if (!isPlainObject(day)) throw new InputError(`${at} must be an object`);
    const sessions = day.sessions ?? [];
    if (!Array.isArray(sessions)) throw new InputError(`${at}.sessions must be an array`);
    if (sessions.length > LIMITS.sessions) {
      throw new InputError(`${at}.sessions has more than ${LIMITS.sessions} entries`);
    }
    return {
      label: text(day.label, `${at}.label`, LIMITS.label),
      closed: text(day.closed, `${at}.closed`) || null,
      sessions: sessions.map((s, j) => {
        if (!isPlainObject(s)) throw new InputError(`${at}.sessions[${j}] must be an object`);
        const out = {};
        for (const f of SESSION_FIELDS) out[f] = text(s[f], `${at}.sessions[${j}].${f}`);
        return out;
      }),
    };
  });
  return { kind, title, days };
}

// ---------- text helpers ----------

// "09:00" -> "9:00"; anything that is not H:MM is shown as given.
export function formatTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? `${Number(m[1])}:${m[2]}` : t;
}

export function timeRange(start, end) {
  const a = formatTime(start);
  const b = formatTime(end);
  return a && b ? `${a}–${b}` : a || b;
}

const joinDot = (...parts) => parts.filter(Boolean).join(' · ');

// Greedy wrap at spaces; a word wider than the line is split by characters.
export function wrap(str, maxWidth, size, font) {
  const fits = (s) => font.width(s, size) <= maxWidth;
  const lines = [];
  let line = '';
  for (let word of str.split(' ').filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    while (!fits(word)) {
      const chars = Array.from(word);
      let n = 1;
      while (n < chars.length && fits(chars.slice(0, n + 1).join(''))) n++;
      lines.push(chars.slice(0, n).join(''));
      word = chars.slice(n).join('');
    }
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

// ---------- elements ----------

const div = (style, children) => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
});

// A block of wrapped text: one fixed-height row per line. Returns its height.
function textBlock(str, { size, line, bold, color, maxWidth, fonts }) {
  const font = bold ? fonts.bold : fonts.regular;
  const rows = wrap(str, maxWidth, size, font).map((l) =>
    div(
      {
        height: line,
        lineHeight: `${line}px`,
        fontSize: size,
        fontWeight: bold ? 700 : 400,
        color,
        whiteSpace: 'nowrap',
      },
      l,
    ),
  );
  return { el: div({ flexDirection: 'column' }, rows), height: rows.length * line };
}

// Stack blocks vertically; gap[i] is the space above block i (skipped for the first one).
function stack(blocks) {
  const children = [];
  let height = 0;
  for (const b of blocks) {
    if (!b || b.height === 0) continue;
    const gap = children.length ? b.gap || 0 : 0;
    children.push(gap ? div({ marginTop: gap }, [b.el]) : b.el);
    height += gap + b.height;
  }
  return { children, height };
}

function card(color, blocks, M, width) {
  const inner = stack(blocks);
  const height = M.padTop + inner.height + M.padBottom;
  const el = div({ width, height, flexDirection: 'row', flexShrink: 0 }, [
    div({ width: M.bar, marginTop: M.barInset, marginBottom: M.barInset, backgroundColor: color }),
    div(
      {
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: INK.card,
        borderRadius: `0 ${M.radius}px ${M.radius}px 0`,
        paddingTop: M.padTop,
        paddingLeft: M.padLeft,
        paddingRight: M.padRight,
      },
      inner.children,
    ),
  ]);
  return { el, height };
}

function sessionCard(s, M, width, fonts) {
  const color = colorForType(s.type);
  const maxWidth = width - M.bar - M.padLeft - M.padRight;
  const big = { size: M.bigSize, line: M.bigLine, bold: true, maxWidth, fonts };
  const meta = { size: M.metaSize, line: M.metaLine, bold: false, maxWidth, fonts };
  return card(
    color,
    [
      textBlock(timeRange(s.start, s.end), { ...big, color: INK.time }),
      { ...textBlock(joinDot(s.code, s.title), { ...big, color }), gap: M.timeGap },
      textBlock(joinDot(s.type, s.rooms), { ...meta, color: INK.meta }),
      { ...textBlock(joinDot(s.staff, s.grp), { ...meta, color: INK.staff }), gap: M.staffGap },
    ],
    M,
    width,
  );
}

function closedCard(name, M, width, fonts) {
  const maxWidth = width - M.bar - M.padLeft - M.padRight;
  return card(
    CLOSED_COLOR,
    [
      textBlock('University closed', {
        size: M.bigSize, line: M.bigLine, bold: true, color: INK.closed, maxWidth, fonts,
      }),
      {
        ...textBlock(name, {
          size: M.metaSize, line: M.metaLine, bold: false, color: INK.staff, maxWidth, fonts,
        }),
        gap: M.staffGap,
      },
    ],
    M,
    width,
  );
}

function noClasses(M, width, fonts) {
  return textBlock('No classes', {
    size: M.metaSize, line: M.metaLine, bold: false, color: INK.quiet, maxWidth: width, fonts,
  });
}

// One day's content (cards or a placeholder) as a column. Returns its height.
function dayColumn(day, M, width, fonts) {
  let items;
  if (day.closed) items = [closedCard(day.closed, M, width, fonts)];
  else if (day.sessions.length === 0) items = [noClasses(M, width, fonts)];
  else items = day.sessions.map((s) => sessionCard(s, M, width, fonts));
  const { children, height } = stack(items.map((it, i) => ({ ...it, gap: i ? M.cardGap : 0 })));
  return { el: div({ flexDirection: 'column', width }, children), height };
}

// fonts: { regular, bold }, each with width(text, fontSize) (see fontmetrics.js).
export function buildImage(data, fonts) {
  const week = data.kind === 'week';
  const M = week ? WEEK : DAY;
  const n = data.days.length;
  const width = week ? 2 * M.margin + n * M.column + (n - 1) * M.columnGap : M.width;
  const inner = width - 2 * M.margin;

  const title = textBlock(data.title, {
    size: M.titleSize, line: M.titleLine, bold: true, color: INK.title, maxWidth: inner, fonts,
  });

  let body;
  if (week) {
    const columns = data.days.map((day) => {
      const header = textBlock(day.label.toUpperCase(), {
        size: M.headerSize, line: M.headerLine, bold: true, color: INK.header, maxWidth: M.column, fonts,
      });
      const content = dayColumn(day, M, M.column, fonts);
      const col = stack([header, { ...content, gap: M.headerGap }]);
      return { el: div({ flexDirection: 'column', width: M.column, flexShrink: 0 }, col.children), height: col.height };
    });
    body = {
      el: div(
        { flexDirection: 'row', alignItems: 'flex-start' },
        columns.map((c, i) => (i ? div({ marginLeft: M.columnGap }, [c.el]) : c.el)),
      ),
      height: Math.max(...columns.map((c) => c.height)),
    };
  } else {
    body = dayColumn(data.days[0], M, inner, fonts);
  }

  const content = stack([title, { ...body, gap: title.height ? M.titleGap : 0 }]);
  const height = Math.ceil(M.top + content.height + M.bottom);
  const element = div(
    {
      width,
      height,
      flexDirection: 'column',
      backgroundColor: INK.page,
      paddingTop: M.top,
      paddingLeft: M.margin,
      paddingRight: M.margin,
      fontFamily: 'DejaVu Sans',
    },
    content.children,
  );
  return { element, width, height };
}
