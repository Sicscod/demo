// Advance widths straight from a TrueType file (cmap + hmtx), so card.js can
// wrap text itself and know the exact image height before rendering.
// Kerning is ignored on purpose: DejaVu's kerning only tightens pairs, so
// these widths are never smaller than what satori draws.

export function fontMetrics(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tables = {};
  const numTables = dv.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(u8[rec], u8[rec + 1], u8[rec + 2], u8[rec + 3]);
    tables[tag] = dv.getUint32(rec + 8);
  }
  for (const t of ['head', 'hhea', 'hmtx', 'cmap']) {
    if (tables[t] === undefined) throw new Error(`font has no ${t} table`);
  }
  const unitsPerEm = dv.getUint16(tables.head + 18);
  const numberOfHMetrics = dv.getUint16(tables.hhea + 34);
  const advanceOf = (gid) => dv.getUint16(tables.hmtx + 4 * Math.min(gid, numberOfHMetrics - 1));
  const glyphOf = cmapLookup(dv, tables.cmap);

  const cache = new Map();
  // Width of one code point in em units. Missing glyphs count as 1em: satori
  // would draw them with a fallback font, and 1em is a safe upper bound.
  function em(cp) {
    let w = cache.get(cp);
    if (w === undefined) {
      const gid = glyphOf(cp);
      w = gid ? advanceOf(gid) / unitsPerEm : 1;
      cache.set(cp, w);
    }
    return w;
  }
  return {
    width(text, fontSize) {
      let sum = 0;
      for (const ch of text) sum += em(ch.codePointAt(0));
      return sum * fontSize;
    },
  };
}

function cmapLookup(dv, cmap) {
  const n = dv.getUint16(cmap + 2);
  let fmt4 = null;
  let fmt12 = null;
  for (let i = 0; i < n; i++) {
    const platform = dv.getUint16(cmap + 4 + i * 8);
    const encoding = dv.getUint16(cmap + 4 + i * 8 + 2);
    const off = cmap + dv.getUint32(cmap + 4 + i * 8 + 4);
    const format = dv.getUint16(off);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12 && fmt12 === null) fmt12 = off;
    if (format === 4 && fmt4 === null) fmt4 = off;
  }
  if (fmt12 !== null) {
    const groups = dv.getUint32(fmt12 + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = fmt12 + 16 + mid * 12;
        const start = dv.getUint32(g);
        const end = dv.getUint32(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return dv.getUint32(g + 8) + (cp - start);
      }
      return 0;
    };
  }
  if (fmt4 !== null) {
    const segX2 = dv.getUint16(fmt4 + 6);
    const ends = fmt4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < segX2; s += 2) {
        if (cp > dv.getUint16(ends + s)) continue;
        const start = dv.getUint16(starts + s);
        if (cp < start) return 0;
        const delta = dv.getUint16(deltas + s);
        const rangeOffset = dv.getUint16(ranges + s);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const gid = dv.getUint16(ranges + s + rangeOffset + 2 * (cp - start));
        return gid === 0 ? 0 : (gid + delta) & 0xffff;
      }
      return 0;
    };
  }
  throw new Error('font has no unicode cmap');
}
