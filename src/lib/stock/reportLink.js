/**
 * stock/reportLink.js: the head office report ids and the share link (v5.11.92, multi site stock
 * Drop 4a, contract 2.1 and 4). Pure: no React, no Supabase, no window, so node --test drives it
 * (reportLink.test.js).
 *
 * A share link keeps the filters and nothing else: the report, which sites (by id), the period,
 * the compare, the layout, the stock value date and the report's own options. Never a site name,
 * never a figure. It is read ONCE by BackOfficeApp after the stock scope has loaded and reaches the
 * screen only through the guarded setSection('stock-gp'); a login that may not open Stock and GP
 * lands where it always does. Sites in the link that are not in this login's scope fall back to the
 * picker's default choice (siteScope.defaultChoice), so a link never widens what is shown.
 */

import { defaultChoice, scopeSites } from './siteScope.js';

/** The route the links open. */
export const STOCK_GP_ROUTE = 'stock-gp';

/** The 21 report ids of Reports > Stock and GP, in the mockup's order (stock_home first). */
export const STOCK_REPORT_IDS = Object.freeze([
  'stock_home', 'stock_value', 'stock_movement', 'stock_gap', 'stock_cogs', 'stock_product_gp', 'stock_waste',
  'stock_purchases', 'stock_prices', 'stock_off_contract', 'stock_budget', 'stock_transfers', 'stock_count_compliance',
  'stock_days_on_hand', 'stock_par', 'stock_key_ratios', 'stock_setup_health', 'stock_batches', 'stock_recipe_cost',
  'stock_allergens', 'stock_month_end',
]);

/** The report ids that wait for a later Drop, and which update brings them. */
export const STOCK_LATER = Object.freeze({
  stock_off_contract: 'purchasing', stock_budget: 'purchasing', stock_transfers: 'purchasing',
  stock_count_compliance: 'purchasing', stock_month_end: 'purchasing',
  stock_recipe_cost: 'recipes', stock_allergens: 'recipes',
});

/** The words a waiting tile shows (the Catalog and the dashboard grid read the same two). */
export const LATER_WORDS = Object.freeze({ recipes: 'Comes with the recipes update', purchasing: 'Comes with the purchasing update' });

/** Is this one of the 21 ids? */
export function isStockReportId(id) {
  return typeof id === 'string' && STOCK_REPORT_IDS.includes(id);
}

/** Does this id render a report in 4a (not a waiting tile)? */
export function isLiveStockReport(id) {
  return isStockReportId(id) && !Object.prototype.hasOwnProperty.call(STOCK_LATER, id);
}

/**
 * The database function behind a report id, without the stock_report_ prefix: stock_home is
 * 'dashboard', every other id drops 'stock_'. Null for a waiting tile or an unknown id.
 */
export function reportFnOf(id) {
  if (!isLiveStockReport(id)) return null;
  return id === 'stock_home' ? 'dashboard' : id.slice('stock_'.length);
}

/** The report names stock_report_export_start accepts (1.5): every 4a function but the dashboard and attention. */
export const EXPORTABLE_REPORTS = Object.freeze(['value', 'movement', 'gap', 'cogs', 'product_gp', 'waste', 'purchases', 'prices',
  'days_on_hand', 'par', 'key_ratios', 'setup_health', 'batches', 'league']);

/** May this report id be exported as a file? */
export function canExportReport(id) {
  const fn = reportFnOf(id);
  return !!fn && EXPORTABLE_REPORTS.includes(fn);
}

// ── the link ──────────────────────────────────────────────────────────────────────────────────

const PERIODS = Object.freeze(['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'custom', 'between-counts']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isId = (v) => typeof v === 'string' && UUID.test(v);
const isYmd = (v) => typeof v === 'string' && YMD.test(v);

const bytesToBinary = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
const binaryToBytes = (bin) => Uint8Array.from(bin, (ch) => ch.charCodeAt(0));

/** base64url of a JSON value (UTF-8 safe); '' for nothing worth writing. */
export function encodeOpts(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).length === 0) return '';
  const bytes = new TextEncoder().encode(JSON.stringify(opts));
  return btoa(bytesToBinary(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The JSON object behind encodeOpts, or null for anything that is not one. */
export function decodeOpts(text) {
  if (typeof text !== 'string' || !text || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const parsed = JSON.parse(new TextDecoder().decode(binaryToBytes(atob(b64))));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** The sites part of a link: 'all', 'g:<id>' or 's:<id>,<id>'. */
export function writeSitesPart(sites) {
  if (!sites || sites.kind === 'all') return 'all';
  if (sites.kind === 'group' && isId(sites.id)) return `g:${sites.id}`;
  const ids = Array.isArray(sites.ids) ? sites.ids.filter(isId) : (isId(sites.id) ? [sites.id] : []);
  return ids.length ? `s:${ids.join(',')}` : 'all';
}

/** { kind: 'all' | 'group' | 'sites', id?, ids } from a sites part; null for anything else. */
export function readSitesPart(text) {
  if (text == null || text === '' || text === 'all') return { kind: 'all', ids: [] };
  if (typeof text !== 'string') return null;
  if (text.startsWith('g:')) { const id = text.slice(2); return isId(id) ? { kind: 'group', id, ids: [] } : null; }
  if (text.startsWith('s:')) {
    const ids = [...new Set(text.slice(2).split(',').filter(isId))];
    return ids.length ? { kind: 'sites', ids } : null;
  }
  return null;
}

/** The period part: 'last-week', 'custom:2026-10-01:2026-10-15' or 'counts'. */
export function writePeriodPart(period, custom) {
  if (period === 'between-counts') return 'counts';
  if (period === 'custom') {
    const from = isYmd(custom?.from) ? custom.from : '', to = isYmd(custom?.to) ? custom.to : '';
    return from && to ? `custom:${from}:${to}` : 'custom';
  }
  return PERIODS.includes(period) ? period : 'this-week';
}

/** { period, custom: { from, to } } from a period part; null for anything else. */
export function readPeriodPart(text) {
  if (text == null || text === '') return { period: 'this-week', custom: { from: null, to: null } };
  if (typeof text !== 'string') return null;
  if (text === 'counts') return { period: 'between-counts', custom: { from: null, to: null } };
  if (text.startsWith('custom')) {
    const [, from, to] = text.split(':');
    if (from && to && isYmd(from) && isYmd(to) && from <= to) return { period: 'custom', custom: { from, to } };
    return text === 'custom' ? { period: 'custom', custom: { from: null, to: null } } : null;
  }
  return PERIODS.includes(text) ? { period: text, custom: { from: null, to: null } } : null;
}

/**
 * The query string of a share link: ?bo=stock-gp&r=<report>&sites=...&p=...&cmp=prev|last_year
 * &layout=side|total[&at=YYYY-MM-DD][&o=<base64url json of opts>]. Never a site name, never money.
 *   state: { report, sites: { kind, id?, ids? }, period, custom, compare, layout, at, opts }
 * '' when the report is not one of the 21.
 */
export function writeShareLink(state) {
  if (!isStockReportId(state?.report)) return '';
  const q = new URLSearchParams();
  q.set('bo', STOCK_GP_ROUTE);
  q.set('r', state.report);
  q.set('sites', writeSitesPart(state.sites));
  q.set('p', writePeriodPart(state.period, state.custom));
  q.set('cmp', state.compare === 'last_year' ? 'last_year' : 'prev');
  q.set('layout', state.layout === 'total' ? 'total' : 'side');
  if (isYmd(state.at)) q.set('at', state.at);
  const o = encodeOpts(state.opts);
  if (o) q.set('o', o);
  return `?${q.toString()}`;
}

/**
 * The link in an address bar's search string, or null when it is not a Stock and GP link
 * (bo=stock-gp and r one of the 21 ids). A part that cannot be read falls back to its default,
 * so an old or hand edited link still opens the report with safe filters.
 */
export function readShareLink(search) {
  if (typeof search !== 'string' || !search) return null;
  let q;
  try { q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search); } catch { return null; }
  if (q.get('bo') !== STOCK_GP_ROUTE) return null;
  const report = q.get('r');
  if (!report || !report.startsWith('stock_') || !isStockReportId(report)) return null;
  const sites = readSitesPart(q.get('sites')) || { kind: 'all', ids: [] };
  const period = readPeriodPart(q.get('p')) || { period: 'this-week', custom: { from: null, to: null } };
  const cmp = q.get('cmp');
  const layout = q.get('layout');
  const at = q.get('at');
  return {
    route: STOCK_GP_ROUTE,
    report,
    sites,
    period: period.period,
    custom: period.custom,
    compare: cmp === 'last_year' ? 'last_year' : cmp === 'prev' || cmp == null || cmp === '' ? 'prev' : null,
    layout: layout === 'total' ? 'total' : 'side',
    at: isYmd(at) ? at : null,
    opts: decodeOpts(q.get('o')),
  };
}

/**
 * The site ids a link opens with, inside THIS login's stock scope (useStockScope's answer, or the
 * raw scope: sites, closedSites, groups, level, homeSite). 'all' = every open site; a group = its
 * sites when the group is still there; named sites = the ones in the scope. Anything that leaves
 * no site falls back to the picker's default choice (siteScope.defaultChoice): never a site the
 * login does not reach, never an empty report.
 */
export function applyShareLink(link, scope, homeId = null) {
  const open = Array.isArray(scope?.sites) ? scope.sites : [];
  const known = new Set(open.map((s) => String(s.id)));
  const home = homeId || scope?.homeSite || null;
  const fallback = () => scopeSites(scope, defaultChoice(scope, home), { homeId: home }).map((s) => s.id).filter(Boolean);
  const sites = link?.sites;
  if (!sites || sites.kind === 'all') return open.length ? open.map((s) => s.id) : fallback();
  if (sites.kind === 'group') {
    const g = (Array.isArray(scope?.groups) ? scope.groups : []).find((x) => String(x.id) === String(sites.id));
    const ids = g ? (g.locationIds || g.location_ids || []).map(String).filter((id) => known.has(id)) : [];
    return ids.length ? ids : fallback();
  }
  const ids = (sites.ids || []).map(String).filter((id) => known.has(id));
  return ids.length ? ids : fallback();
}
