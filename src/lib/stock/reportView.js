// src/lib/stock/reportView.js
//
// MULTI SITE STOCK, Drop 4a (web-reports): the small pure helpers the 15 Stock report screens share,
// so each screen says a site name, a currency, a day, a cap line or a drill crumb the same way.
// Nothing here reads a clock, the store or the database; node:test drives every function
// (reportView.test.js). Display only: no figure is worked out here from the stock take off.

import { dayWords as rulesDayWords } from './reportRules.js';
import { currencySymbol } from '../currency.js';

/** The words on a tile or a cell whose report waits for a later Drop (contract 2.3 LATER_WORDS). */
export const LATER_WORDS = Object.freeze({
  recipes: 'Comes with the recipes update',
  purchasing: 'Comes with the purchasing update',
});

export const PAGE_CAP = 1000;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The guard's site row for an id, from meta.sites. */
export function metaSite(meta, id) {
  if (!meta || !Array.isArray(meta.sites) || id == null) return null;
  return meta.sites.find((s) => String(s.id) === String(id)) || null;
}

/** A site's name: the scope's row first, then the guard's, then the id's first 8 letters. */
export function siteNameOf(meta, siteById, id) {
  if (id == null) return 'Company';
  const scoped = siteById && siteById[id];
  if (scoped && scoped.name) return scoped.name;
  const g = metaSite(meta, id);
  if (g && g.name) return g.name;
  return String(id).slice(0, 8);
}

/** A site's currency code: the guard's row first, then the scope's, then the first currency in meta. */
export function currencyOf(meta, siteById, id) {
  const g = metaSite(meta, id);
  if (g && g.currency) return g.currency;
  const scoped = siteById && id != null ? siteById[id] : null;
  if (scoped && scoped.currency) return scoped.currency;
  if (meta && Array.isArray(meta.currencies) && meta.currencies.length === 1) return meta.currencies[0];
  return undefined;
}

/** Rows with `site` and `currency` filled from location_id (a row that has them keeps them). */
export function withSites(rows, meta, siteById) {
  return (rows || []).map((r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r };
    if (out.location_id != null) {
      if (out.site == null) out.site = siteNameOf(meta, siteById, out.location_id);
      if (out.currency == null) out.currency = currencyOf(meta, siteById, out.location_id);
    } else if (out.currency == null) {
      out.currency = currencyOf(meta, siteById, null);
    }
    return out;
  });
}

/** '12.3%' (one decimal) or '' for null; `dp` for more places. */
export function fmtPct(v, dp = 1) {
  const n = num(v);
  return n == null ? '' : `${n.toFixed(dp)}%`;
}

/** '1,234' with up to `dp` decimals, '' for null, with a unit when given. */
export function fmtQty(v, unit, dp = 2) {
  const n = num(v);
  if (n == null) return '';
  const text = n.toLocaleString('en-GB', { maximumFractionDigits: dp });
  return unit ? `${text} ${unit}` : text;
}

/** A whole number with thousands separators, '' for null. */
export function fmtInt(v) {
  const n = num(v);
  return n == null ? '' : Math.round(n).toLocaleString('en-GB');
}

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);

/** 'Mon 12 Oct' for a business day (reportRules.dayWords, the one spelling); a timestamp's day part is read. */
export function dayWords(ymd) {
  return rulesDayWords(typeof ymd === 'string' ? ymd.slice(0, 10) : ymd);
}

/** 'Week of Mon 13 Oct'. */
export function weekWords(weekStart) {
  const d = dayWords(weekStart);
  return d ? `Week of ${d}` : '';
}

/** 'Mon 13 Oct, 14:05' for a timestamp, read in the venue's time zone when given. */
export function whenWords(ts, timeZone) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ', ');
  }
}

/** Days in a closed range of business days, 0 when the range is not two days. */
export function rangeDaysCount(from, to) {
  if (!isYmd(from) || !isYmd(to)) return 0;
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * A local choice that falls back to a prop and resets when the prop's key changes (no effect
 * needed): state is { key, value }; the answer is value while key matches, else the fallback.
 */
export function overrideValue(state, key, fallback) {
  if (state && state.key === key && state.value !== undefined && state.value !== null) return state.value;
  return fallback;
}

/** The next sort after a header click: same key flips, a new key starts on its default. */
export function toggleSort(sort, key, defaultDir = 'desc') {
  if (sort && sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: defaultDir };
}

/**
 * The loaded rows sorted by a header click. The report functions answer each drill in their own
 * keyset order (they take no sort), so a header click sorts what is on screen and never asks again.
 * Nulls go last either way; text compares as words, numbers as numbers; ties keep their order.
 * `keyOf` maps a shown column to the key it sorts on ({ _when: 'occurred_at' }).
 */
export function sortLoaded(rows, sort, keyOf = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!sort || !sort.key) return list;
  const key = (keyOf && keyOf[sort.key]) || sort.key;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const valueOf = (r) => {
    const v = r ? r[key] : null;
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(v);
    return typeof v === 'string' && v.trim() !== '' && Number.isFinite(n) ? n : String(v);
  };
  return list
    .map((r, i) => ({ r, i, v: valueOf(r) }))
    .sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v));
      return c === 0 ? a.i - b.i : c * dir;
    })
    .map((x) => x.r);
}

/**
 * A site named by a report cell that may hold an id or a name (best_site, plate_cost_low_site):
 * the site's name when it is an id in scope, else the words as given. Never a cut id.
 */
export function siteLabel(meta, siteById, value) {
  if (value == null || value === '') return '';
  const v = String(value);
  const scoped = siteById && siteById[v];
  if (scoped && scoped.name) return scoped.name;
  const g = metaSite(meta, v);
  if (g && g.name) return g.name;
  return v;
}

/** A timestamp in the words of the site's own clock (its timezone from the guard). */
export function whenAt(meta, locationId, ts) {
  const g = metaSite(meta, locationId);
  return whenWords(ts, g && g.timezone ? g.timezone : undefined);
}

/**
 * Money per base unit (a price per ml or g): four places under one, two from one up, so a milk
 * price per ml never reads as 0.00. '' for null.
 */
export function unitMoney(v, currency) {
  const n = num(v);
  if (n == null) return '';
  const dp = Math.abs(n) < 1 ? 4 : 2;
  const text = Math.abs(n).toFixed(dp);
  return `${n < 0 ? '-' : ''}${currencySymbol(currency || undefined)}${text}`;
}

/**
 * One option a link or a drill handed the screen (initialOpts): the value when it is one of the
 * allowed ones (or any value when allowed is null), else the fallback.
 */
export function initialPick(initialOpts, key, allowed, fallback) {
  const o = initialOpts && typeof initialOpts === 'object' ? initialOpts : null;
  if (!o || !(key in o)) return fallback;
  const v = o[key];
  if (v == null || v === '') return fallback;
  if (Array.isArray(allowed) && !allowed.some((a) => String(a) === String(v))) return fallback;
  if (Array.isArray(allowed)) return allowed.find((a) => String(a) === String(v));
  return v;
}

/** The drill site a link or a league click handed the screen, only when it is one of the sites asked for. */
export function initialSite(initialOpts, sites) {
  const s = initialOpts && typeof initialOpts === 'object' ? initialOpts.site : null;
  if (s == null || s === '') return null;
  return Array.isArray(sites) && sites.some((id) => String(id) === String(s)) ? String(s) : null;
}

/** 'Invoice INV-1203 (Jane)' from a movement's document; '' when none. */
export function documentWords(doc) {
  if (!doc || typeof doc !== 'object') return '';
  const kind = doc.kind ? String(doc.kind) : '';
  const ref = doc.ref ? String(doc.ref) : '';
  const who = doc.who ? ` (${doc.who})` : '';
  const head = [kind, ref].filter(Boolean).join(' ');
  return head ? `${head}${who}` : who.trim().replace(/^\(|\)$/g, '');
}

/** 'Transfer to Leeds (used 12 in 28 days), Hull (used 4 in 28 days)'; '' when nowhere uses it. */
export function transferWords(list, nameOf, fmtUse = null) {
  const rows = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!rows.length) return '';
  const parts = rows.map((t) => {
    const name = t.site || (typeof nameOf === 'function' ? nameOf(t.location_id) : '') || 'another site';
    const use = num(t.use_28d);
    // use_28d is the cost of what that site used (stock_report_days_on_hand): the caller passes money().
    return use != null ? `${name} (used ${typeof fmtUse === 'function' ? fmtUse(use, t) : fmtQty(use)} in 28 days)` : name;
  });
  return `Transfer to ${parts.join(', ')}`;
}

/** 'Leeds catching up' after a Fix. */
export function fixWords(siteName) {
  return `${siteName || 'Site'} catching up`;
}

/** Rows grouped by a key, keeping first seen order: [{ key, rows }]. */
export function groupRows(rows, key) {
  const map = new Map();
  for (const r of rows || []) {
    const k = r && r[key] != null ? String(r[key]) : '';
    if (!map.has(k)) map.set(k, { key: k, rows: [] });
    map.get(k).rows.push(r);
  }
  return [...map.values()];
}

/** A sum over a key of rows of ONE currency; null when every value is null. */
export function sumKey(rows, key) {
  let seen = false;
  let total = 0;
  for (const r of rows || []) {
    const n = num(r && r[key]);
    if (n != null) { seen = true; total += n; }
  }
  return seen ? total : null;
}

/** The biggest absolute value over a key (for bar widths), 0 when none. */
export function maxAbs(rows, key) {
  let m = 0;
  for (const r of rows || []) {
    const n = Math.abs(num(r && r[key]) || 0);
    if (n > m) m = n;
  }
  return m;
}

/** The drill crumbs: [{ id, label }] from a drill state, the company first. */
export function crumbsFor(drill, nameOf, labels = {}) {
  const out = [{ id: 'company', label: labels.company || 'All sites' }];
  if (!drill) return out;
  if (drill.site) out.push({ id: 'site', label: typeof nameOf === 'function' ? nameOf(drill.site) : String(drill.site) });
  if (drill.category_name || drill.category_id) out.push({ id: 'category', label: drill.category_name || 'Category' });
  if (drill.item_name || drill.item_id) out.push({ id: 'item', label: drill.item_name || 'Item' });
  return out;
}

/** Column kinds for the reports (contract 1.6.1 meta.columns kinds plus the screen's own). */
export const KINDS = Object.freeze(['money', 'pct', 'qty', 'text', 'day', 'rag', 'int', 'bool', 'when']);

/** A column spec, checked: { key, label, kind, hint, align }. */
export function col(key, label, kind = 'text', extra = {}) {
  if (!KINDS.includes(kind)) throw new Error(`reportView.col: unknown kind ${kind}`);
  // The kit (and meta.columns) know money, pct, qty, text, day and rag: a whole number is a qty
  // (right aligned, thousands), a time or a yes/no is words.
  const shown = kind === 'int' ? 'qty' : kind === 'when' || kind === 'bool' ? 'text' : kind;
  return { key, label, kind: shown, align: shown === 'text' || shown === 'day' ? 'left' : 'right', ...(kind !== shown ? { as: kind } : {}), ...extra };
}

/** Every key a list of column specs reads. */
export function keysOf(columns) {
  return (columns || []).map((c) => c.key);
}

/** The notes the database put in meta.notes, as a list of lines. */
export function notesOf(meta, except = []) {
  const n = meta && meta.notes;
  if (!n) return [];
  const all = Array.isArray(n) ? n.filter(Boolean).map(String) : [String(n)];
  // A line the screen already prints in its own place is not said twice in the rules line.
  const own = (except || []).filter(Boolean).map((e) => String(e).replace(/\.$/, ''));
  return all.filter((line) => !own.some((e) => line.startsWith(e)));
}

/** True when the loaded page holds every row (no next page): the export can run at once. */
export function allRowsLoaded(rows, next) {
  return !next && Array.isArray(rows) && rows.length < PAGE_CAP;
}

