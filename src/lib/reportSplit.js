// src/lib/reportSplit.js
//
// THE SITE SPLIT: the shared maths every Back Office report uses once more than one site is
// ticked (Peter, 5 Oct 2026: "make every report we have multi site when sites are connected
// together, and you can filter them down to just one site").
//
// The shell (BOReports.jsx) hands a multi site report every ticked site's rows in one list,
// each row tagged siteId and siteName (src/lib/reportScopeLoad.js). This file turns that
// list back into one PART per site, so a report can run the very same sums it runs for one
// site, once per site, each on that site's own clock, and then put a group total on top.
//
// THE RULES THIS FILE KEEPS
//   1. ONE SITE IS LEFT ALONE. splitBySite with one site hands back the same array it was
//      given: nothing is copied, filtered or re-ordered, so a single site report gets
//      exactly the rows it got before there was a split.
//   2. EVERY SITE ON ITS OWN CLOCK AND BUSINESS DAY. A part's clock is the clock its own
//      window was read on (site.range), never the first site's.
//   3. CURRENCIES ARE NEVER ADDED TOGETHER. currencyBlocks groups the parts by currency;
//      a total is only ever taken inside one block. A site whose currency nobody knows is
//      a block of its own.
//   4. A ROW NOBODY ASKED FOR IS NEVER COUNTED. A row tagged with a site that is not in
//      the list is dropped, not added to the nearest site.
//   5. ONE SOURCE PER SCREEN. A part is built from rows OR from the server day sums
//      (src/lib/reportDaySums.js), never both. The adapters at the bottom give the sums
//      the same meaning as the browser figures of each report.
//
// PURE: no Supabase, no React. Runs under node --test.

import { money } from './currency.js';
import { notLoaded } from './reportCompare.js';

/** More than one site on screen. */
export const isSplit = (sites) => Array.isArray(sites) && sites.length > 1;

const idOf = (r) => String(r?.siteId ?? r?.locationId ?? '');

/**
 * Rows per site, in the sites' order: [{ site, rows }]. A site with no rows is there with
 * an empty list (a quiet site is still a site). One site, or none: ONE entry holding the
 * very array that was passed in.
 */
export function splitBySite(rows, sites) {
  const list = Array.isArray(sites) ? sites : [];
  const all = rows || [];
  if (list.length <= 1) return [{ site: list[0] || null, rows: all }];
  const by = new Map(list.map((s) => [String(s.id), []]));
  for (const r of all) { const b = by.get(idOf(r)); if (b) b.push(r); }
  return list.map((s) => ({ site: s, rows: by.get(String(s.id)) }));
}

/**
 * Site names for a narrow column heading: the words every name starts with are dropped
 * ("Coffee Boy Leeds", "Coffee Boy Preston" = "Leeds", "Preston"). Only whole words, and
 * only when every site still has a name left; else the names come back as they are.
 */
export function shortSiteNames(names) {
  const list = (names || []).map((n) => String(n ?? '').trim());
  if (list.length < 2) return list;
  const words = list.map((n) => n.split(/\s+/));
  let k = 0;
  while (words.every((w) => w.length > k + 1 && w[k].toLowerCase() === words[0][k].toLowerCase())) k += 1;
  return k ? words.map((w) => w.slice(k).join(' ')) : list;
}

/**
 * One part per site: everything a report needs to work that site out by itself.
 *   sites     the shell's `sites` prop (each with its own `range`)
 *   compare   the shell's comparison: only its "did not load" mark is read
 *   fmt       the money format to fall back on for a site with no currency on record
 *   daySums   the shell's `daySums` prop when the figures are the server day sums
 *
 * A part is { site, id, name, short, rows, prevRows, tickets, clock, config, currency, fmt,
 * compare, sums, prevSums }. `config` has the shape of getLocationConfig, so it can be
 * passed wherever a report takes locationConfig. `compare` is the SITE's own comparison
 * (cut on its own clock), marked not loaded when the previous period did not load, and
 * null when there is nothing fair to compare with.
 */
export function siteParts({ sites, scope = null, checks = null, prevChecks = null, tickets = null, compare = null, fmt = null, daySums = null } = {}) {
  const list = Array.isArray(sites) ? sites : [];
  const cur = splitBySite(checks, list), prev = splitBySite(prevChecks, list), kds = splitBySite(tickets, list);
  const fromSums = daySums?.available === true;
  // Day sums are whole days. A comparison cut part way through a day ("by 2pm") cannot be
  // matched by them, so no percent is shown off it at all.
  const cut = fromSums && daySums.compareCut === true;
  const sumsOf = (set, id) => (set?.sites || []).find((s) => String(s.locationId) === id) || null;
  const short = shortSiteNames(list.map((s) => s.name || String(s.id)));
  return list.map((site, i) => {
    const id = String(site.id);
    const sums = fromSums ? sumsOf(daySums.current, id) : null;
    const prevSums = fromSums && !cut ? sumsOf(daySums.previous, id) : null;
    const currency = site.currency || scope?.currencyOf?.(id) || sums?.currency || null;
    const own = site.range?.compare || null;
    let cmp = own;
    if (fromSums) cmp = cut || !own ? null : (daySums.previous ? own : notLoaded(own));
    else if (own && compare?.loaded === false) cmp = notLoaded(own);
    return {
      site, id, name: site.name || id, short: short[i] || site.name || id,
      rows: cur[i]?.rows || [], prevRows: prev[i]?.rows || [], tickets: kds[i]?.rows || [],
      clock: {
        timeZone: site.range?.timeZone || site.timezone || 'Europe/London',
        dayStart: site.range?.dayStart || site.businessDayStart || '00:00',
      },
      config: {
        timezone: site.range?.timeZone || site.timezone || 'Europe/London',
        businessDayStart: site.range?.dayStart || site.businessDayStart || '00:00',
        shifts: Array.isArray(site.shifts) ? site.shifts : [],
        currency,
      },
      currency,
      fmt: currency ? (n) => money(n || 0, currency) : (fmt || ((n) => money(n || 0))),
      compare: cmp,
      sums, prevSums,
    };
  });
}

/**
 * The parts grouped by currency, in first seen order: [{ key, currency, parts, fmt }].
 * Money is only ever added inside one block. A site with no currency on record is a block
 * of its own (key 'unknown:<id>'), never added to another.
 */
export function currencyBlocks(parts) {
  const map = new Map();
  for (const p of parts || []) {
    const key = p.currency || `unknown:${p.id}`;
    const b = map.get(key) || map.set(key, { key, currency: p.currency || null, parts: [], fmt: p.fmt }).get(key);
    b.parts.push(p);
  }
  return [...map.values()];
}

/** The heading of a block when there is more than one: "GBP sites", "Currency not set: Leeds". */
export function blockTitle(block) {
  return block.currency ? `${block.currency} sites` : `Currency not set: ${block.parts.map((p) => p.name).join(', ')}`;
}

/** Add the named number fields of a list of objects: sumFields([{a:1},{a:2}], ['a']) = {a:3}. */
export function sumFields(list, fields) {
  const out = Object.fromEntries(fields.map((f) => [f, 0]));
  for (const o of list || []) for (const f of fields) out[f] += Number(o?.[f]) || 0;
  return out;
}

/**
 * A keyed table with a column per site and a total: rows of a report that is a list of
 * named things (order types, payment methods, days, hours).
 *   cellsOf(part)  => { [key]: number }
 *   opts.keys      the keys to show, in order (default: every key seen, biggest total first)
 * Returns { rows: [{ key, bySite: { [siteId]: number }, total }], bySite, total }. Call it
 * with the parts of ONE currency block when the numbers are money.
 */
export function keyedMatrix(parts, cellsOf, { keys = null } = {}) {
  const list = parts || [];
  const cells = list.map((p) => cellsOf(p) || {});
  const seen = keys ? [...keys] : [...new Set(cells.flatMap((c) => Object.keys(c)))];
  const rows = seen.map((key) => {
    const bySite = {};
    let total = 0;
    list.forEach((p, i) => { const v = Number(cells[i][key]) || 0; bySite[p.id] = v; total += v; });
    return { key, bySite, total };
  });
  if (!keys) rows.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
  const bySite = Object.fromEntries(list.map((p) => [p.id, rows.reduce((s, r) => s + r.bySite[p.id], 0)]));
  return { rows, bySite, total: rows.reduce((s, r) => s + r.total, 0) };
}

/** CSV headers with Site first. The rows must carry siteName. */
export function withSiteColumn(columns, label = 'Site') {
  return [{ label, key: (r) => r?.siteName || '' }, ...(columns || [])];
}

/** Tag each of a part's worked out rows with its site, for one list across sites. */
export function tagPartRows(part, rows) {
  return (rows || []).map((r) => ({ ...r, siteId: part.id, siteName: part.name, siteKey: siteNameKey(part.id, r.key ?? r.server ?? '') }));
}

/** A key for a named thing AT a site: two people called Sam at two sites never merge. */
export function siteNameKey(siteId, name) {
  return `${String(siteId)}\u0000${String(name ?? '')}`;
}

// ── the server day sums, in each report's own meaning ────────────────────────
//
// reportDaySums.shapeDaySums hands each site { totals, days[] }, each a set of sums
// { stats, byMethod, byOrderType, ... }. The figures below are worked out so they mean what
// the browser figure of the same name means in each report.

/**
 * The Daily trend figures of one set of sums. That report's revenue is the total of every
 * check that is not voided: the same money byOrderType adds up (every live check has one
 * order type). Its tips are the tips as taken (byMethod), not net of refunds.
 */
export function trendFromSums(sums) {
  const add = (map, f) => Object.values(map || {}).reduce((s, v) => s + (Number(v?.[f]) || 0), 0);
  return {
    revenue: add(sums?.byOrderType, 'revenue'),
    covers: Number(sums?.stats?.covers) || 0,
    checks: Number(sums?.stats?.count) || 0,
    tips: add(sums?.byMethod, 'tips'),
    voids: Number(sums?.voidedChecks) || 0,
  };
}

/** The Order types rows of one set of sums: { [type]: { type, checks, revenue } }. */
export function orderTypesFromSums(sums) {
  const out = {};
  for (const [type, v] of Object.entries(sums?.byOrderType || {})) {
    out[type] = { type, checks: Number(v?.checks) || 0, revenue: Number(v?.revenue) || 0 };
  }
  return out;
}

/**
 * The Payments rows of one set of sums. The database keys them by the method as written;
 * `bucketOf` is the report's own folding (card, cash, apple-pay ...), so two spellings of
 * one method land in one row as they do in the browser.
 */
export function methodsFromSums(sums, bucketOf = (m) => m || 'other') {
  const out = {};
  for (const [raw, v] of Object.entries(sums?.byMethod || {})) {
    const b = bucketOf(raw);
    const row = (out[b] ||= { method: b, revenue: 0, count: 0, tips: 0 });
    row.revenue += Number(v?.revenue) || 0;
    row.count += Number(v?.checks) || 0;
    row.tips += Number(v?.tips) || 0;
  }
  return out;
}

// ── what may be done to a row from another site ──────────────────────────────

/**
 * Refunds, receipts and every other write stay locked to the signed in site (card safety:
 * a refund fired from an All sites list could go against the wrong site's reader and
 * books). Null when the row may be acted on; else { siteId, siteName, text } with the plain
 * line to show in place of the buttons. A row with no site on it is the signed in site's
 * (the till's own live sales), as it always was.
 */
export function actionLock(row, scope) {
  const home = scope?.homeId ? String(scope.homeId) : null;
  const at = idOf(row) || null;
  if (!home || !at || at === home) return null;
  const siteName = row?.siteName || scope?.siteOf?.(at)?.name || 'another site';
  return {
    siteId: at, siteName,
    text: `This sale belongs to ${siteName}. Refunds and receipts are only done from the site you are signed in to. Sign in to ${siteName} to refund it or send its receipt.`,
  };
}
