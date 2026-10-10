// POST /api/render -> image/png (timetable day or week). See ../README.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { ImageResponse } from '@vercel/og';
import { buildImage, validate, InputError } from '../lib/card.js';
import { fontMetrics } from '../lib/fontmetrics.js';

// Literal paths so Vercel's file tracer bundles the fonts (vercel.json also
// lists them in includeFiles).
const REGULAR = readFileSync(fileURLToPath(new URL('../fonts/DejaVuSans.ttf', import.meta.url)));
const BOLD = readFileSync(fileURLToPath(new URL('../fonts/DejaVuSans-Bold.ttf', import.meta.url)));

const FONTS = [
  { name: 'DejaVu Sans', data: REGULAR, weight: 400, style: 'normal' },
  { name: 'DejaVu Sans', data: BOLD, weight: 700, style: 'normal' },
];
const METRICS = { regular: fontMetrics(REGULAR), bold: fontMetrics(BOLD) };

const MAX_BODY_BYTES = 256 * 1024;

// Validates the body and renders it. Throws InputError for bad input.
export async function renderPng(body) {
  const data = validate(body);
  const { element, width, height } = buildImage(data, METRICS);
  const response = new ImageResponse(element, { width, height, fonts: FONTS });
  return Buffer.from(await response.arrayBuffer());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const key = process.env.RENDER_KEY;
  if (key && !sameKey(req.headers['x-render-key'], key)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  try {
    const png = await renderPng(await readJson(req));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(png.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.end(png);
  } catch (err) {
    if (err instanceof InputError) return sendJson(res, 400, { error: err.message });
    console.error('render failed', err);
    return sendJson(res, 500, { error: 'render failed' });
  }
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function sameKey(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Vercel's helpers may already have parsed req.body (and its getter throws on
// invalid JSON); otherwise read the raw stream ourselves.
async function readJson(req) {
  let body;
  try {
    body = req.body;
  } catch {
    throw new InputError('body is not valid JSON');
  }
  if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    return body;
  }
  let raw = body ?? (req.readableEnded ? '' : await readStream(req));
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (raw.length > MAX_BODY_BYTES) throw new InputError('body too large');
  if (!raw.trim()) throw new InputError('body is empty');
  try {
    return JSON.parse(raw);
  } catch {
    throw new InputError('body is not valid JSON');
  }
}

async function readStream(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InputError('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
