// Loads Student_Timetables.html into D1. Runs in GitHub Actions (hourly + after deploys).
// Source, in order: a file the admin sent to the bot, or (once a day) the SharePoint file
// downloaded with the admin's Microsoft sign-in.
//
// Env: TELEGRAM_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID. Flags: --force (ignore 20h auto-update gap).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTimetable } from './parse.mjs';

const MS_TENANT = 'bdb74b30-9568-4856-bdbf-06759778fcbc';
const MS_CLIENT = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
const MS_SCOPE = 'https://graph.microsoft.com/.default offline_access';
const AUTO_EVERY_MS = 20 * 3600 * 1000;
const force = process.argv.includes('--force');

const sql = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function d1(args) {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'cukz-bot', '--remote', '--yes', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function query(command) {
  const out = d1(['--json', '--command', command]);
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const kvSet = (k, v) =>
  `INSERT INTO kv (k, v) VALUES (${sql(k)}, ${sql(v)}) ON CONFLICT(k) DO UPDATE SET v = excluded.v;`;

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

async function downloadTelegramFile(fileId) {
  const info = await tg('getFile', { file_id: fileId });
  if (!info.ok) throw new Error(`Telegram getFile: ${info.description}`);
  const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${info.result.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download: HTTP ${res.status}`);
  return res.text();
}

async function downloadSharePointFile(refreshToken, shareUrl) {
  const tokenRes = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: MS_CLIENT, refresh_token: refreshToken, scope: MS_SCOPE }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) {
    const err = new Error(`Microsoft sign-in expired: ${token.error_description || token.error}`);
    err.signedOut = true;
    throw err;
  }
  const shareId = 'u!' + Buffer.from(shareUrl).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const res = await fetch(`https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/content`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!res.ok) throw new Error(`SharePoint download: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { html: await res.text(), refreshToken: token.refresh_token || refreshToken };
}

export function buildSql({ updated, sessions, students }, extraKv = {}) {
  const lines = ['DELETE FROM sessions;', 'DELETE FROM students;'];
  const cols = ['id', 'date', 'start', 'end', 'code', 'title', 'type', 'rooms', 'staff', 'grp'];
  for (let i = 0; i < sessions.length; i += 200) {
    const rows = sessions.slice(i, i + 200).map((s) => `(${cols.map((c) => (c === 'id' ? Number(s.id) : sql(s[c]))).join(', ')})`);
    lines.push(`INSERT INTO sessions (${cols.join(', ')}) VALUES\n${rows.join(',\n')};`);
  }
  const studentRows = Object.entries(students);
  for (let i = 0; i < studentRows.length; i += 200) {
    const rows = studentRows.slice(i, i + 200).map(([sid, ids]) => `(${sql(sid)}, ${sql(JSON.stringify(ids))})`);
    lines.push(`INSERT INTO students (sid, sessions) VALUES\n${rows.join(',\n')};`);
  }
  lines.push(kvSet('tt_updated', updated || ''), kvSet('tt_loaded_at', new Date().toISOString()));
  for (const [k, v] of Object.entries(extraKv)) lines.push(kvSet(k, v));
  return lines.join('\n');
}

async function main() {
  const kv = Object.fromEntries(query('SELECT k, v FROM kv').map((r) => [r.k, r.v]));
  const admin = kv.admin;
  const notify = (text) => admin && tg('sendMessage', { chat_id: admin, text, parse_mode: 'HTML' });

  let html;
  let source;
  const after = {}; // kv updates to apply together with the new timetable
  try {
    if (kv.pending_file) {
      source = 'upload';
      html = await downloadTelegramFile(kv.pending_file);
      d1(['--command', 'DELETE FROM kv WHERE k = \'pending_file\'']);
    } else if (kv.ms_refresh && kv.source_url && (force || Date.now() - Number(kv.last_auto || 0) > AUTO_EVERY_MS)) {
      source = 'auto';
      const got = await downloadSharePointFile(kv.ms_refresh, kv.source_url);
      html = got.html;
      // Refresh tokens rotate: save the new one right away so a later failure can't lose it.
      d1(['--command', `${kvSet('ms_refresh', got.refreshToken)} ${kvSet('last_auto', String(Date.now()))}`]);
    } else {
      console.log('Nothing to do.');
      return;
    }

    const hash = createHash('sha256').update(html).digest('hex');
    if (hash === kv.tt_hash) {
      console.log('Timetable unchanged.');
      if (source === 'upload') await notify('ℹ️ This file is the same as the loaded timetable, nothing changed.');
      return;
    }
    const data = parseTimetable(html);
    const students = Object.keys(data.students).length;
    if (!students || !data.sessions.length) throw new Error('No students or classes found in the file.');
    Object.assign(after, { tt_hash: hash, last_error: '' });

    const file = join(mkdtempSync(join(tmpdir(), 'cukz-')), 'load.sql');
    writeFileSync(file, buildSql(data, after));
    d1(['--file', file]);
    console.log(`Loaded ${students} students, ${data.sessions.length} classes (${data.updated}).`);
    if (source === 'upload' || kv.tt_updated !== data.updated) {
      await notify(`✅ Timetable updated (${data.updated || 'no date'}): ${students} students, ${data.sessions.length} classes.`);
    }
  } catch (e) {
    console.error(e);
    d1(['--command', kvSet('last_error', `${new Date().toISOString()} ${e.message}`.slice(0, 500))]);
    if (e.signedOut) d1(['--command', 'DELETE FROM kv WHERE k = \'ms_refresh\'']);
    await notify(`❌ Timetable update failed: ${e.message}${e.signedOut ? '\nSend /login to sign in again.' : ''}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
