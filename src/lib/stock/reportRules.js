/**
 * stock/reportRules.js: the words and the small sums the head office report screens share
 * (v5.11.92, multi site stock Drop 4a, contract 2.1 and 1.11). Pure: no React, no Supabase, so
 * node --test drives it (reportRules.test.js).
 *
 * Every figure comes from the database (the stock_report_* functions over the stored day totals).
 * Nothing here works a number out from checks or movements: it only turns the answer's meta into
 * lines ("Counted", "Estimated (ledger)", "Demo history left out", "Shown per currency", the not
 * posted line), splits totals per currency (never a sum across two), lays rows out side by side or
 * as the company total, and writes the CSV from meta.columns so the export and the screen agree.
 */

import { signedMoney } from '../currency.js';
import { toCsv } from '../../backoffice/sections/reports/_csv.js';
import { compareChip } from '../reportCompare.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const list = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v == null || v === '' ? null : Number(v));
const finite = (v) => v != null && Number.isFinite(v);

/** The rules line under the dashboard (the mockup's .design, word for word). */
export const RULES_LINE = 'The rules behind every number. Product GP adds up to site GP. Loyalty, staff and comps sit on their own line. Each venue uses its own business day. A locked month never changes. Two currencies are never added together.';

/** 'Mon 6 Oct' for a business day, whatever the browser's zone (no clock involved). */
export function dayWords(ymd) {
  if (!isYmd(ymd)) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1]}`;
}

/** 'Counted' when the figure comes from an approved count that day, else 'Estimated (ledger)'. */
export function countedWords(flag) {
  return flag === true ? 'Counted' : 'Estimated (ledger)';
}

/**
 * The days a site's window covers: 'Mon 6 Oct to Sun 12 Oct', one day as 'Mon 6 Oct', and
 * 'Needs two full counts' when between two counts could not be worked out for that site.
 */
export function windowWords(window) {
  if (!window) return '';
  if (window.window_missing === true) return 'Needs two full counts';
  const from = dayWords(window.from_day), to = dayWords(window.to_day);
  if (!from && !to) return '';
  if (!to || from === to) return from || to;
  return `${from} to ${to}`;
}

/** The flags on a window, as lines: snapshot, part locked, needs two full counts. */
export function windowFlags(window) {
  const out = [];
  if (!window) return out;
  if (window.window_missing === true) out.push('Needs two full counts');
  if (window.snapshot === true) out.push('Locked period: from the snapshot');
  if (window.part_locked === true) out.push('Part of a locked period: read live');
  return out;
}

/**
 * 'Plate cost not known before Mon 6 Oct' when a site's product theo cost starts inside the window
 * (its first stock_sale_takes day is after the window's first day); 'Plate cost not known yet' when
 * it has none; null when the whole window is known.
 */
export function takesFromLine(window) {
  if (!window) return null;
  if (window.takes_from == null) return 'Plate cost not known yet';
  if (isYmd(window.from_day) && isYmd(window.takes_from) && window.takes_from > window.from_day) return `Plate cost not known before ${dayWords(window.takes_from)}`;
  return null;
}

/** The window row for a site in meta.windows, or null. */
export function windowOf(meta, locationId) {
  return list(meta?.windows).find((w) => w && String(w.location_id) === String(locationId)) || null;
}

/** The site row for a site in meta.sites, or null. */
export function siteOf(meta, locationId) {
  return list(meta?.sites).find((s) => s && String(s.id) === String(locationId)) || null;
}

/** A site's name from meta, else 'Company' for the company rows, else ''. */
export function siteNameOf(meta, locationId) {
  if (locationId == null) return 'Company';
  return siteOf(meta, locationId)?.name || '';
}

/** A percent as words, one decimal: '72.8%'. Null reads ''. */
export function pctWordsOf(value) {
  const v = num(value);
  return finite(v) ? `${v.toFixed(1)}%` : '';
}

/**
 * The GP % cell: 'No sales' when the row has no sales (the database answers null then, never a
 * divide by zero), the percent otherwise. For a theoretical GP the site's takes_from line is
 * returned as `note` when the plate cost is not known for the whole window.
 */
export function gpWords(meta, row, key = 'gp_pct_actual') {
  const sales = num(row?.sales_net);
  const v = num(row?.[key]);
  const text = !finite(v) || (finite(sales) && sales === 0) ? 'No sales' : pctWordsOf(v);
  const theo = /theo/.test(String(key));
  const note = theo && row?.location_id != null ? takesFromLine(windowOf(meta, row.location_id)) : null;
  return { text, note };
}

/** '<n> sales not yet posted to stock (<money>)', or null when nothing is waiting. */
export function notPostedLine(meta) {
  const np = meta?.not_posted;
  const count = Number(np?.count) || 0;
  if (count <= 0) return null;
  const currency = list(meta?.currencies).length === 1 ? meta.currencies[0] : (list(meta?.sites)[0]?.currency || undefined);
  const value = signedMoney(Number(np?.value) || 0, currency);
  return `${count} sale${count === 1 ? '' : 's'} not yet posted to stock (${value})`;
}

/** 'Demo history left out' when the guard found demo rows at the sites asked for, else null. */
export function demoLine(meta) {
  return meta?.demo_left_out === true ? 'Demo history left out' : null;
}

/** 'Shown per currency' when the sites asked for use two currencies, else null. */
export function currencyLine(meta) {
  return meta?.mixed_currency === true ? 'Shown per currency' : null;
}

/**
 * Every line the frame prints under a report's title, in order: each site's window words (when
 * more than one site, or the window differs from the period), the snapshot and part locked flags,
 * 'Demo history left out', 'Shown per currency', the not posted line, then meta.notes.
 */
export function metaLines(meta) {
  const out = [];
  if (!meta) return out;
  const windows = list(meta.windows);
  for (const w of windows) {
    const name = siteNameOf(meta, w.location_id);
    const words = windowWords(w);
    const differs = w.from_day !== meta.from || w.to_day !== meta.to || w.window_missing === true;
    if (words && (windows.length > 1 || differs)) out.push(name ? `${name}: ${words}` : words);
    for (const f of windowFlags(w)) if (f !== 'Needs two full counts') out.push(name ? `${name}: ${f}` : f);
  }
  for (const line of [demoLine(meta), currencyLine(meta), notPostedLine(meta)]) if (line) out.push(line);
  for (const n of list(meta.notes)) if (typeof n === 'string' && n.trim()) out.push(n.trim());
  return out;
}

/**
 * Totals split per currency: [{ currency, sites: [site rows], company: the company row or null }],
 * in first seen order. Two currencies are never added together: a company with GBP and USD sites
 * gets two blocks, each with its own company row from the database.
 */
export function currencyBlocks(totals) {
  const map = new Map();
  for (const r of list(totals)) {
    if (!r) continue;
    const cur = r.currency || 'unknown';
    const b = map.get(cur) || map.set(cur, { currency: r.currency || null, sites: [], company: null }).get(cur);
    if (r.location_id == null) { if (!b.company) b.company = r; } else b.sites.push(r);
  }
  return [...map.values()];
}

/** value / base * 100; null when the base is 0 or either is not a number (never divide by zero). */
export function pct(value, base) {
  const v = num(value), b = num(base);
  if (!finite(v) || !finite(b) || b === 0) return null;
  return (v / b) * 100;
}

/**
 * The rows a totals table shows: 'side' = the site rows then the company rows (per currency);
 * 'total' = the company rows only. Any other layout reads as 'side'.
 */
export function layoutRows(totals, layout) {
  const rows = list(totals).filter(Boolean);
  const sites = rows.filter((r) => r.location_id != null);
  const company = rows.filter((r) => r.location_id == null);
  return layout === 'total' ? company : [...sites, ...company];
}

/** The company row of a currency (location_id null), or null. */
export function companyRowOf(totals, currency) {
  return list(totals).find((r) => r && r.location_id == null && (currency == null || r.currency === currency)) || null;
}

/** The compare row for a totals row: the same site (or the same currency's company row). */
export function matchingRow(row, thenTotals) {
  if (!row) return null;
  return list(thenTotals).find((t) => t && (row.location_id == null
    ? t.location_id == null && t.currency === row.currency
    : String(t.location_id) === String(row.location_id))) || null;
}

/**
 * The change per column between this period's row and the compare period's row:
 * { [key]: { now, then, delta, kind, chip } }. Money and quantities get the one percent rule's
 * chip (compareChip: no comparison figure at all = no percent, never a red minus 100%); a percent
 * gets its difference in points as `delta` and a plain chip text ('+1.2 pts'). Text, day and rag
 * columns are left out. `compare` is compareRange's answer (the words on the chip).
 */
export function compareCells(now, then, { columns = null, compare = null } = {}) {
  const out = {};
  if (!now) return out;
  const cols = columns ? list(columns) : Object.keys(now).map((key) => ({ key, kind: typeof now[key] === 'number' ? 'money' : 'text' }));
  for (const c of cols) {
    if (!c || !['money', 'pct', 'qty'].includes(c.kind)) continue;
    const a = num(now[c.key]), b = num(then?.[c.key]);
    if (c.kind === 'pct') {
      const delta = finite(a) && finite(b) ? a - b : null;
      const text = delta == null ? (then ? 'No figure to compare with' : '') : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts`;
      out[c.key] = { now: a, then: b, delta, kind: 'pct', chip: { kind: delta == null ? 'quiet' : 'pct', pct: delta, text, words: compare?.label || '' } };
      continue;
    }
    const chip = compareChip(a, b, then ? compare : { ...(compare || {}), loaded: false }, c.noun || 'figures');
    out[c.key] = { now: a, then: b, delta: finite(a) && finite(b) ? a - b : null, kind: c.kind, chip };
  }
  return out;
}

/**
 * One cell as words: money in the row's currency (the sign before the symbol), a percent to one
 * decimal, a quantity with up to two decimals, a day as 'Mon 6 Oct', a rag word capitalised, text
 * as it is. Null is '' except a GP percent, which reads 'No sales'.
 */
export function cellWords(column, value, currency) {
  const kind = column?.kind || 'text';
  if (value == null || value === '') return kind === 'pct' && /^gp_/.test(String(column?.key || '')) ? 'No sales' : '';
  if (kind === 'money') return signedMoney(value, currency || undefined);
  if (kind === 'pct') return pctWordsOf(value);
  if (kind === 'qty') { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(value); }
  if (kind === 'day') return dayWords(String(value).slice(0, 10)) || String(value);
  if (kind === 'rag') { const s = String(value); return s.charAt(0).toUpperCase() + s.slice(1); }
  return String(value);
}

/** The columns with Site and Currency in front, when the list does not already carry them. */
export function withSiteColumns(columns) {
  const cols = list(columns).filter((c) => c && c.key);
  const keys = new Set(cols.map((c) => c.key));
  const front = [];
  if (!keys.has('site')) front.push({ key: 'site', label: 'Site', kind: 'text' });
  if (!keys.has('currency')) front.push({ key: 'currency', label: 'Currency', kind: 'text' });
  return [...front, ...cols];
}

const csvValue = (c, r) => {
  const v = r?.[c.key];
  if (v == null) return '';
  if (c.kind === 'money') { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : v; }
  if (c.kind === 'pct' || c.kind === 'qty') { const n = Number(v); return Number.isFinite(n) ? n : v; }
  if (c.kind === 'day') return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};

/**
 * The CSV of rows over exactly these columns (meta.columns, so the export and the screen share
 * them): money and percents as plain numbers, days as 'YYYY-MM-DD', a nested value as JSON.
 */
export function columnsToCsv(columns, rows) {
  const cols = list(columns).filter((c) => c && c.key);
  const headers = cols.map((c) => ({ key: (r) => csvValue(c, r), label: c.label || c.key }));
  return toCsv(list(rows), headers);
}

/** '<report>-<from>-<to>.csv' (the same name the edge function gives a background file). */
export function exportFileName(report, from, to) {
  const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe(report) || 'report'}-${safe(from)}-${safe(to)}.csv`;
}

/** The line a screen shows when a drill level stopped at the cap. */
export const CAP_LINE = 'Showing the first 1,000 rows. Export for all.';
