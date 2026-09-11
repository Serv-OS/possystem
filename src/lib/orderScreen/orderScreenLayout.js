// src/lib/orderScreen/orderScreenLayout.js
//
// Order screens: pure layout, paging, clock and chime helpers for OrderBoard (the TV and
// the Back Office preview share them). NO imports, so node:test can load it.
//
// Fit rule: a section never scrolls. layoutSection shrinks the row font from 0.045S to a
// floor of 0.03S, trying 1 column up to maxColumns at each size, and only then pages.
// S is the short side of the stage in px. On a 43 inch 1080p portrait TV S is about 1080,
// so rows are 32 to 49 px and readable from 3 metres.

const MAX_FONT_K = 0.045;
const MIN_FONT_K = 0.03;
const STEP_K = 0.0025;
const ROW_K = 1.9;          // row height = font x 1.9
const COL_MIN_EM = 14;      // each column at least 14 x font wide

const k4 = (x) => Math.round(x * 10000) / 10000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * The drawing stage inside the viewport. A portrait design on a landscape TV (the
 * Android APK locks landscape) with "Turn right" (90) or "Turn left" (270) draws a
 * vh x vw stage rotated about the centre. Otherwise the stage is the viewport.
 * Position the stage at left 50%, top 50% and apply `transform`.
 */
export function stageSize({ vw, vh, orientation, rotate } = {}) {
  const w = Math.max(0, num(vw));
  const h = Math.max(0, num(vh));
  const r = Number(rotate);
  if (orientation === 'portrait' && (r === 90 || r === 270) && w > h) {
    return { w: h, h: w, rotate: r, transform: `translate(-50%, -50%) rotate(${r}deg)` };
  }
  return { w, h, rotate: 0, transform: 'translate(-50%, -50%)' };
}

/**
 * Split `available` px between stacked sections. Integer px that sum exactly to the
 * floored total. Each gets its minimum when there is room (`minPx` is one number for all,
 * or one per section), and the rest is shared by row count (equally when every count is
 * 0), with largest remainder rounding. Too little room shares the total by the minimums.
 */
export function splitSectionHeights(available, counts, minPx = 0) {
  const list = Array.isArray(counts) ? counts.map((c) => Math.max(0, num(c))) : [];
  const n = list.length;
  if (!n) return [];
  const total = Math.max(0, Math.floor(num(available)));
  const mins = list.map((_, i) => Math.max(0, Math.floor(num(Array.isArray(minPx) ? minPx[i] : minPx))));
  const minSum = mins.reduce((a, b) => a + b, 0);

  const share = (amount, weights) => {
    const wsum = weights.reduce((a, b) => a + b, 0);
    const raw = weights.map((w) => (wsum > 0 ? (amount * w) / wsum : amount / n));
    const out = raw.map(Math.floor);
    let left = amount - out.reduce((a, b) => a + b, 0);
    const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
    for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left--) out[order[j][1]] += 1;
    return out;
  };

  if (minSum >= total) return share(total, minSum > 0 ? mins : list.map(() => 1));
  const extra = share(total - minSum, list);
  return extra.map((e, i) => e + mins[i]);
}

/**
 * The biggest font and fewest columns that show `count` rows in a listH x boxW box.
 * Returns { font, rowH, columns, perColumn, perPage, pages }. When nothing fits, the
 * floor font, the most columns that meet the width rule, and pages.
 */
export function layoutSection({ count, boxW, listH, S, maxColumns = 1, minColumnEm = COL_MIN_EM } = {}) {
  const n = Math.max(0, Math.floor(num(count)));
  const s = Math.max(0, num(S));
  const W = Math.max(0, num(boxW));
  const H = Math.max(0, num(listH));
  const maxCols = Math.max(1, Math.floor(num(maxColumns) || 1));
  // Never narrower than 14 x font. A caller with long status words asks for more, so a
  // name or a driver's order code is never cut short by a second column.
  const minEm = Math.max(COL_MIN_EM, num(minColumnEm));
  const perColOf = (rowH) => (rowH > 0 ? Math.floor(H / rowH) : 0);
  const steps = Math.round((MAX_FONT_K - MIN_FONT_K) / STEP_K);

  if (n === 0) {
    const font = MAX_FONT_K * s;
    const rowH = font * ROW_K;
    const perColumn = perColOf(rowH);
    return { font, rowH, columns: 1, perColumn, perPage: Math.max(1, perColumn), pages: 1 };
  }

  for (let i = 0; i <= steps; i++) {
    const font = k4(MAX_FONT_K - i * STEP_K) * s;
    const rowH = font * ROW_K;
    const perColumn = perColOf(rowH);
    for (let c = 1; c <= maxCols; c++) {
      if (W / c < minEm * font) break;
      if (n <= perColumn * c) return { font, rowH, columns: c, perColumn, perPage: perColumn * c, pages: 1 };
    }
  }

  const font = MIN_FONT_K * s;
  const rowH = font * ROW_K;
  const perColumn = Math.max(1, perColOf(rowH));
  let columns = 1;
  for (let c = maxCols; c >= 1; c--) { if (W / c >= minEm * font) { columns = c; break; } }
  const perPage = perColumn * columns;
  return { font, rowH, columns, perColumn, perPage, pages: Math.max(1, Math.ceil(n / perPage)) };
}

/**
 * Which page to show. Worked out from server corrected time, so several TVs at one
 * venue turn their pages together.
 */
export function pageIndexAt(nowMs, pages, periodMs = 8000) {
  const p = Math.floor(num(pages));
  const period = num(periodMs);
  const t = Number(nowMs);
  if (p <= 1 || period <= 0 || !Number.isFinite(t)) return 0;
  return Math.floor(Math.abs(t) / period) % p;
}

/** en-US for American venues and Honolulu, else en-GB. */
export function venueLocale(tz) {
  return typeof tz === 'string' && (tz.startsWith('America/') || tz === 'Pacific/Honolulu') ? 'en-US' : 'en-GB';
}

const cleanSpaces = (s) => String(s).replace(/[\u202F\u00A0]/g, ' ');
const pad2 = (n) => String(n).padStart(2, '0');

function formatIn(ms, zone, withDate) {
  const locale = venueLocale(zone);
  const us = locale === 'en-US';
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: zone, hour: us ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: us ? 'h12' : 'h23',
  }).format(ms);
  if (!withDate) return cleanSpaces(time);
  const date = new Intl.DateTimeFormat(locale, { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(ms);
  return cleanSpaces(`${date}, ${time}`);
}

/**
 * Venue wall clock time, "13:42" or "8:42 AM". { date: true } adds the date first.
 * Never the device zone: a bad zone falls back to Europe/London, and never throws.
 */
export function formatVenueTime(ms, tz, opts = {}) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  const withDate = !!(opts && opts.date);
  try { return formatIn(t, tz || 'Europe/London', withDate); } catch { /* bad zone */ }
  try { return formatIn(t, 'Europe/London', withDate); } catch { /* no ICU */ }
  const d = new Date(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Blend two 6 digit hex colours: t of `a` and (1 - t) of `b`. Always 6 digit hex out. */
export function mixHex(a, b, t) {
  if (!HEX6.test(String(a)) || !HEX6.test(String(b))) return HEX6.test(String(a)) ? a : '#000000';
  const k = Math.min(1, Math.max(0, num(t)));
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * k + parseInt(b.slice(i, i + 2), 16) * (1 - k))
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Back Office lets an owner pick the page background and text, but not the muted grey or the
 * pill colours. When either differs from the default theme, derive those from the owner's
 * pair, so sub lines, chips, the footer and pills stay readable on a light page.
 */
export function deriveBoardTheme(theme, defaults) {
  const t = { ...(theme || {}) };
  const d = defaults || {};
  if (!HEX6.test(String(t.bg)) || !HEX6.test(String(t.text))) return t;
  if (String(t.bg).toUpperCase() === String(d.bg || '').toUpperCase()
      && String(t.text).toUpperCase() === String(d.text || '').toUpperCase()) return t;
  t.muted = mixHex(t.text, t.bg, 0.62);
  t.pillBg = mixHex(t.text, t.bg, 0.14);
  t.pillText = t.text;
  return t;
}

/** Keys that became Ready since the last feed. The first load (prevRows null) gives none. */
export function readyArrivals(prevRows, nextRows) {
  if (!Array.isArray(prevRows) || !Array.isArray(nextRows)) return [];
  const before = new Set(prevRows.filter((r) => r && r.bucket === 'ready').map((r) => r.key));
  const out = [];
  for (const r of nextRows) {
    if (!r || r.bucket !== 'ready' || r.key == null) continue;
    if (!before.has(r.key) && !out.includes(r.key)) out.push(r.key);
  }
  return out;
}
