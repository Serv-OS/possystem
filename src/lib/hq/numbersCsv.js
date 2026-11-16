// src/lib/hq/numbersCsv.js
//
// Daily numbers, pasted as rows. One row per site per business day. The columns are the
// ones the Mozz leadership app used, so an export made for it pastes straight in, with a
// few spellings accepted (labor or labour, store or site or location). Unknown columns are
// ignored and named back; a bad row is refused with its line number and nothing else moves.

export const CSV_COLUMNS = Object.freeze([
  'store', 'date', 'net_sales', 'cogs', 'labor', 'projected_lunch', 'projected_dinner', 'projected_late',
  'cash_on_hand', 'reviews_count', 'review_rating', 'turnover_pct', 'morale_score', 'hires_needed', 'notes',
]);

export const CSV_TEMPLATE = CSV_COLUMNS.join(',') + '\nProvo,2026-11-16,5230,1510,1560,1720,2400,1100,18400,7,4.6,42,8.1,2,';

const ALIASES = {
  store: 'store', site: 'store', location: 'store', venue: 'store',
  date: 'date', business_date: 'date', day: 'date',
  net_sales: 'net_sales', net: 'net_sales', sales: 'net_sales',
  cogs: 'cogs', food_cost: 'cogs', cost_of_goods: 'cogs',
  labor: 'labour', labour: 'labour', labor_cost: 'labour', labour_cost: 'labour',
  projected_lunch: 'projected_lunch', lunch: 'projected_lunch',
  projected_dinner: 'projected_dinner', dinner: 'projected_dinner',
  projected_late: 'projected_late', late_night: 'projected_late', late: 'projected_late',
  cash_on_hand: 'cash_on_hand', cash: 'cash_on_hand',
  reviews_count: 'reviews_count', reviews: 'reviews_count', new_reviews: 'reviews_count',
  review_rating: 'review_rating', rating: 'review_rating', average_rating: 'review_rating',
  turnover_pct: 'turnover_pct', turnover: 'turnover_pct',
  morale_score: 'morale_score', morale: 'morale_score',
  hires_needed: 'hires_needed', hires: 'hires_needed', open_hires: 'hires_needed',
  notes: 'notes', note: 'notes',
};

const NUMERIC = ['net_sales', 'cogs', 'labour', 'projected_lunch', 'projected_dinner', 'projected_late',
  'cash_on_hand', 'reviews_count', 'review_rating', 'turnover_pct', 'morale_score', 'hires_needed'];
const INTEGER = ['reviews_count', 'hires_needed'];
const RANGE = { review_rating: [0, 5], morale_score: [0, 10], turnover_pct: [0, 999] };

/** Split one CSV line, honouring double quotes. A line with a tab in it (a paste from a sheet)
 *  splits on tabs only, so "$6,400.50" stays one cell. */
export function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  const s = String(line ?? '');
  const sep = s.includes('\t') ? '\t' : ',';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const normHeader = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** A date as the sheet wrote it: 2026-11-16, 11/16/2026 (US), 16/11/2026 when the first part is over 12. */
export function parseCsvDate(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return isoIfValid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1]; const b = +m[2]; const y = +m[3];
    return a > 12 ? isoIfValid(y, b, a) : isoIfValid(y, a, b);
  }
  return null;
}
function isoIfValid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseNumber(raw) {
  const s = String(raw ?? '').trim().replace(/[$£€,\s]/g, '').replace(/%$/, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * parseNumbersCsv(text, sites) where sites = [{ id, name, code }].
 * Returns { rows: [{ location_id, business_date, ...fields, source: 'csv' }], errors: ['line 3: ...'],
 *           ignoredColumns: [...], count }.
 * The header row is required. A row whose store or date cannot be read is an error; the whole
 * paste is refused when there is any error, so a half import never happens.
 */
export function parseNumbersCsv(text, sites = []) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  const errors = []; const rows = []; const ignoredColumns = [];
  if (!lines.length) return { rows, errors: ['Nothing to import. Paste the header row and at least one row of numbers.'], ignoredColumns, count: 0 };

  const header = splitCsvLine(lines[0]).map(normHeader);
  const cols = header.map((h) => { const k = ALIASES[h]; if (!k && h) ignoredColumns.push(h); return k || null; });
  if (!cols.includes('store')) errors.push('The header needs a store column.');
  if (!cols.includes('date')) errors.push('The header needs a date column.');
  if (errors.length) return { rows, errors, ignoredColumns, count: 0 };

  const byName = new Map();
  for (const s of sites) {
    if (s?.name) byName.set(normName(s.name), s);
    if (s?.code) byName.set(normName(s.code), s);
    if (s?.id) byName.set(normName(s.id), s);
  }
  const seen = new Set();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.every((c) => c === '')) continue;
    const lineNo = i + 1;
    const rec = { source: 'csv' };
    let storeRaw = ''; let dateRaw = '';
    cols.forEach((k, ci) => {
      if (!k) return;
      const v = cells[ci] ?? '';
      if (k === 'store') storeRaw = v;
      else if (k === 'date') dateRaw = v;
      else if (k === 'notes') rec.notes = v || null;
      else rec[k] = v;
    });
    const site = byName.get(normName(storeRaw));
    if (!site) { errors.push(`line ${lineNo}: store "${storeRaw}" is not one of your sites.`); continue; }
    const date = parseCsvDate(dateRaw);
    if (!date) { errors.push(`line ${lineNo}: date "${dateRaw}" was not read. Use 2026-11-16 or 11/16/2026.`); continue; }
    let bad = false;
    for (const k of NUMERIC) {
      if (!(k in rec)) continue;
      const n = parseNumber(rec[k]);
      if (Number.isNaN(n)) { errors.push(`line ${lineNo}: ${k} "${rec[k]}" is not a number.`); bad = true; break; }
      if (n !== null && INTEGER.includes(k) && !Number.isInteger(n)) { errors.push(`line ${lineNo}: ${k} must be a whole number.`); bad = true; break; }
      if (n !== null && RANGE[k] && (n < RANGE[k][0] || n > RANGE[k][1])) { errors.push(`line ${lineNo}: ${k} ${n} is outside ${RANGE[k][0]} to ${RANGE[k][1]}.`); bad = true; break; }
      rec[k] = n;
    }
    if (bad) continue;
    const key = `${site.id}|${date}`;
    if (seen.has(key)) { errors.push(`line ${lineNo}: ${site.name} on ${date} appears twice.`); continue; }
    seen.add(key);
    rows.push({ location_id: site.id, business_date: date, ...rec });
  }
  if (!rows.length && !errors.length) errors.push('No rows of numbers under the header.');
  return { rows: errors.length ? [] : rows, errors, ignoredColumns, count: rows.length };
}
