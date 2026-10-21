/**
 * stock/itemListRules.js: the pure rules behind the company Stock items list, the Sites grid, the
 * bulk bar and the item modals (multi site stock Drop 1, mockup scrItems, gridHtml and the modals).
 * No React, no database: the screens in src/backoffice/sections/stock/items/ call these, and
 * itemListRules.test.js drives every one of them.
 *
 * A one site company never reaches any of this: it keeps today's Stock items screen
 * (stock/items/StockItemsSplit.jsx).
 *
 * Shapes: a "row" is one stock_items_page row (contract 1.7). A "scope" is `{ sites: [{ id, name,
 * status, currency }], siteName(id) }`, the sites in the picker's scope in screen order.
 */

import { UNITS } from './units.js';
import { dayWords } from './pauseRules.js';

const num = (v) => (v == null || v === '' ? null : Number(v));
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The most rows one list read or one export holds (the API cap). */
export const MAX_ROWS = 1000;

/** The type values the database stores and the words people see. */
export const ITEM_TYPES = Object.freeze([
  { value: 'food', label: 'Food' },
  { value: 'drink', label: 'Drink' },
  { value: 'other', label: 'Other' },
]);
export const typeLabel = (t) => ITEM_TYPES.find((x) => x.value === t)?.label || '';

// ── sites ────────────────────────────────────────────────────────────────────

/**
 * The scope's sites as `{ id, name, ... }` objects, whatever form the scope hands over (site objects
 * or bare ids). `siteName(id)` names a bare id.
 */
export function siteList(scopeSites, siteName = null) {
  const out = [];
  const seen = new Set();
  for (const s of scopeSites || []) {
    const id = typeof s === 'string' ? s : s?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = (typeof s === 'object' && s?.name) || (typeof siteName === 'function' ? siteName(id) : '') || '';
    out.push(typeof s === 'object' ? { ...s, name } : { id, name });
  }
  return out;
}

const isOpen = (s) => !s?.status || s.status === 'active';

/** Open sites first, then by name (numbers in names in order: "Site 2" before "Site 10"), then id. */
export function sortSites(sites) {
  return [...(sites || [])].sort((a, b) => {
    const oa = isOpen(a) ? 0 : 1;
    const ob = isOpen(b) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const byName = String(a?.name || '').localeCompare(String(b?.name || ''), 'en-GB', { numeric: true, sensitivity: 'base' });
    if (byName) return byName;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

/**
 * What the list asks the server for as p_sites. All sites (closed ones hidden) sends null, so a
 * company editor also finds items that are at no site yet ("Not at a site", contract 1.7); any
 * narrower scope sends its site ids.
 */
export function pageSites({ isAll = false, showClosed = false, scopeIds = [] } = {}) {
  if (isAll && !showClosed) return null;
  return [...(scopeIds || [])];
}

/** Site groups for SiteChecklist ({ id, name, location_ids }), only the sites in this list. */
export function checklistGroups(groups, siteIds) {
  const have = new Set(siteIds || []);
  return (groups || []).map((g) => {
    const ids = (g?.locationIds || g?.location_ids || []).filter((id) => have.has(id));
    return { id: g?.id, name: g?.name || '', location_ids: ids };
  }).filter((g) => g.id && g.location_ids.length > 0);
}

/** The row's link at one site (on or off), or null when it was never there ("Not here"). */
export function linkAt(row, siteId) {
  return (row?.sites || []).find((s) => s?.location_id === siteId) || null;
}

/** Stocked at that site now. */
export const onAt = (row, siteId) => !!linkAt(row, siteId)?.on;

/**
 * The Sites cell words (mockup sitesText, the same rule as siteScope.sitesText): 'Local to Leeds',
 * 'None here', 'All 7' (or the site's name when the scope is one site), 'Leeds', '5 of 7'.
 */
export function rowSitesText(row, scope) {
  const sites = scope?.sites || [];
  const ids = sites.map((s) => s.id);
  const on = ids.filter((id) => onAt(row, id));
  const name = (id) => sites.find((s) => s.id === id)?.name || (typeof scope?.siteName === 'function' ? scope.siteName(id) : '') || 'one site';
  if (row?.local_location_id && on.length === 1) return `Local to ${name(row.local_location_id)}`;
  if (!on.length) return 'None here';
  if (on.length === ids.length) return ids.length === 1 ? name(on[0]) : `All ${ids.length}`;
  if (on.length === 1) return name(on[0]);
  return `${on.length} of ${ids.length}`;
}

/**
 * The Paused pill for a row, or null: `{ everywhere, siteName, until }` for pauseRules.pauseWords.
 * Paused everywhere wins; else the paused sites in scope ('Leeds', or '3 sites'), with an until day
 * only when every one of them carries the same one.
 */
export function rowPause(row, scope) {
  if (row?.paused) return { everywhere: true, siteName: null, until: row.paused.until || null };
  const sites = scope?.sites || [];
  const paused = sites.map((s) => ({ site: s, link: linkAt(row, s.id) })).filter((x) => x.link?.on && x.link.paused);
  if (!paused.length) return null;
  const untils = [...new Set(paused.map((x) => x.link.paused_until || null))];
  const until = untils.length === 1 ? untils[0] : null;
  return { everywhere: false, siteName: paused.length === 1 ? paused[0].site.name : plural(paused.length, 'site'), until };
}

/** Running out at that site (stop ordering set), or anywhere in scope when no site is given. */
export function runningOut(row, scope, siteId = null) {
  if (siteId) return !!linkAt(row, siteId)?.stop_ordering_at;
  return (scope?.sites || []).some((s) => !!linkAt(row, s.id)?.stop_ordering_at);
}

/** Low at one site: on hand below the reorder point (the server's "low" filter rule). */
export function isLow(link) {
  if (!link?.on || !isNum(link.reorder_point) || !isNum(link.on_hand)) return false;
  return Number(link.on_hand) < Number(link.reorder_point);
}

// ── columns and filters ──────────────────────────────────────────────────────

const COLS = {
  name: { key: 'name', label: 'Name' },
  category: { key: 'category', label: 'Category' },
  type: { key: 'type', label: 'Type' },
  main_supplier: { key: 'main_supplier', label: 'Main supplier' },
  price: { key: 'price', label: 'Price' },
  sites: { key: 'sites', label: 'Sites' },
  stock_value: { key: 'stock_value', label: 'Stock value', right: true },
  supplier_here: { key: 'supplier_here', label: 'Supplier here' },
  price_here: { key: 'price_here', label: 'Price here', right: true },
  cost_here: { key: 'cost_here', label: 'Cost here', right: true },
  on_hand: { key: 'on_hand', label: 'On hand', right: true },
  par: { key: 'par', label: 'Par', right: true },
};

/**
 * The list's columns (contract 4.2). One site view (a multi site company with one site picked):
 * Name, Category, Supplier here, Price here, Cost here, On hand, Par, Stock value. Company view:
 * Name, Category, Type, Main supplier, Price, Sites, Stock value (no Sites column when not multi).
 */
export function listColumns({ oneSite = null, multi = true } = {}) {
  const keys = oneSite
    ? ['name', 'category', 'supplier_here', 'price_here', 'cost_here', 'on_hand', 'par', 'stock_value']
    : ['name', 'category', 'type', 'main_supplier', 'price', ...(multi ? ['sites'] : []), 'stock_value'];
  return keys.map((k) => ({ ...COLS[k] }));
}

/** The filter boxes as the screen holds them. */
export const BLANK_FILTERS = Object.freeze({
  category: '', type: '', supplier: '', notAt: '',
  paused: false, runningOut: false, local: false, archived: false,
});

/** The chips under the search box, in the mockup's order. */
export const FILTER_CHIPS = Object.freeze([
  { key: 'paused', label: 'Paused' },
  { key: 'runningOut', label: 'Running out' },
  { key: 'local', label: 'Local' },
  { key: 'archived', label: 'Archived' },
]);

/** True when any filter box or chip is set (the empty words then say "match"). */
export function filtersActive(ui) {
  const f = { ...BLANK_FILTERS, ...(ui || {}) };
  return !!(f.category || f.type || f.supplier || f.notAt || f.paused || f.runningOut || f.local || f.archived);
}

/**
 * The screen's filters to stock_items_page p_filters (contract 1.7). Only known keys go (an unknown
 * key is refused by the server); nothing set answers null. `onAt` is the one site view's site.
 * category 'none' asks for items with no category.
 */
export function filtersToServer(ui) {
  const f = { ...BLANK_FILTERS, ...(ui || {}) };
  const out = {};
  if (f.category === 'none') out.no_category = true;
  else if (f.category) out.category_id = f.category;
  if (ITEM_TYPES.some((t) => t.value === f.type)) out.type = f.type;
  if (f.supplier) out.supplier_id = f.supplier;
  if (f.notAt) out.not_at = f.notAt;
  if (f.onAt) out.on_at = f.onAt;
  if (f.paused) out.paused = true;
  if (f.runningOut) out.running_out = true;
  if (f.local) out.local = true;
  if (f.low) out.low = true;
  if (f.archived) out.archived = true;
  return Object.keys(out).length ? out : null;
}

/**
 * A loaded list after some of its rows were read again (stock_items_page with the filter ids): each
 * asked row is put back in its place from the answer, and dropped when the answer has no such row
 * (it no longer fits the search, the filters or the scope, as a full read would show); total goes
 * down by the rows dropped. Rows not asked for stay exactly as they are. Answers { rows, total }.
 */
export function replaceRows(page, askedIds, fresh) {
  const rows = page?.rows || [];
  const asked = new Set(askedIds || []);
  const byId = new Map((fresh || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  let dropped = 0;
  const out = [];
  for (const r of rows) {
    if (!asked.has(r?.id)) { out.push(r); continue; }
    const f = byId.get(r.id);
    if (f) out.push(f); else dropped += 1;
  }
  const total = page?.total == null ? null : Math.max(0, Number(page.total) - dropped);
  return { rows: out, total };
}

// ── numbers in words ─────────────────────────────────────────────────────────

const trim = (n, dp = 2) => {
  const v = Math.round(Number(n) * 10 ** dp) / 10 ** dp;
  return String(Object.is(v, -0) ? 0 : v);
};

/**
 * An amount held, in the pack people count in: '3 bottles', '1 bottle', '2.5 kg', '12' (each).
 * qtyBase is in the item's base unit; pack is the count pack ({ name, qty_in_base }).
 */
export function onHandText(qtyBase, pack) {
  if (!isNum(qtyBase)) return '';
  const size = isNum(pack?.qty_in_base) && Number(pack.qty_in_base) > 0 ? Number(pack.qty_in_base) : 1;
  const qty = Number(qtyBase) / size;
  const name = String(pack?.name || '').trim();
  const shown = trim(qty);
  if (!name || name.toLowerCase() === 'each') return shown;
  if (Object.prototype.hasOwnProperty.call(UNITS, name.toLowerCase())) return `${shown} ${name}`;
  const one = Math.abs(qty) === 1;
  return `${shown} ${one || /s$/i.test(name) ? name : `${name}s`}`;
}

/**
 * A typed price: '' or null is "no price here" (follow the company price, null); '1.45', 1.45 and
 * '£1.45' are 1.45; anything else, or below 0, is NaN (the screen says it cannot be).
 */
export function priceInput(v) {
  if (v == null) return null;
  const t = String(v).replace(/[£$€,\s]/g, '');
  if (t === '') return null;
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return Number.NaN;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : Number.NaN;
}

/** A typed GP target: '' is none (null); '68' or '68%' is 68; outside 0 to 100, or junk, is NaN. */
export function pctInput(v) {
  const t = String(v ?? '').replace('%', '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : Number.NaN;
}

/** A typed amount for a par box: '' keeps what the site has (undefined), else a number >= 0 or NaN. */
export function amountInput(v) {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

// ── export ───────────────────────────────────────────────────────────────────

const yesNo = (link) => (!link ? 'Not here' : link.on ? 'Yes' : 'No');

/**
 * The loaded rows (at most 1,000) as CSV columns for reports/_csv.js toCsv: the item, its main
 * supplier and company price, the Sites words, the stock value, then for each site in scope On,
 * Price here, On hand and Par. Numbers stay plain numbers (base units for on hand and par).
 */
export function exportRows(rows, scope) {
  const sites = scope?.sites || [];
  const headers = [
    { label: 'Name', key: (r) => r.name + (r.name_suffix ? ` ${r.name_suffix}` : '') },
    { label: 'Category', key: (r) => r.category || '' },
    { label: 'Type', key: (r) => typeLabel(r.type) },
    { label: 'Base unit', key: (r) => r.base_unit || '' },
    { label: 'SKU', key: (r) => r.sku || '' },
    { label: 'Barcode', key: (r) => r.barcode || '' },
    { label: 'Main supplier', key: (r) => r.main?.supplier_name || '' },
    { label: 'Supplier pack', key: (r) => r.main?.pack_description || '' },
    { label: 'Company price', key: (r) => (isNum(r.main?.pack_price) ? Number(r.main.pack_price) : '') },
    { label: 'Currency', key: (r) => r.main?.currency || '' },
    { label: 'Local', key: (r) => (r.local_location_id ? 'Yes' : '') },
    { label: 'Archived', key: (r) => (r.archived_at ? 'Yes' : '') },
    { label: 'Sites', key: (r) => rowSitesText(r, scope) },
    { label: 'Stock value', key: (r) => (isNum(r.stock_value) ? Number(r.stock_value) : '') },
  ];
  for (const s of sites) {
    headers.push(
      { label: `${s.name}: on`, key: (r) => yesNo(linkAt(r, s.id)) },
      { label: `${s.name}: price here`, key: (r) => { const l = linkAt(r, s.id); return l?.on && isNum(l.price_here) ? Number(l.price_here) : ''; } },
      { label: `${s.name}: on hand`, key: (r) => { const l = linkAt(r, s.id); return l?.on && isNum(l.on_hand) ? Number(l.on_hand) : ''; } },
      { label: `${s.name}: par`, key: (r) => { const l = linkAt(r, s.id); return l?.on && isNum(l.par_level) ? Number(l.par_level) : ''; } },
    );
  }
  return { headers, rows: (rows || []).slice(0, MAX_ROWS) };
}

/** 'stock-items-2026-10-20.csv' (the venue day the screen shows). */
export const exportFileName = (todayIso) => `stock-items-${String(todayIso || '').slice(0, 10) || 'export'}.csv`;

// ── bulk tools ───────────────────────────────────────────────────────────────

/** The bulk bar's buttons in the mockup's order (contract 3.2 kinds); `sites` ones need multi. */
export const BULK_ACTIONS = Object.freeze([
  { kind: 'add_sites', label: 'Add to sites', sites: true },
  { kind: 'remove_sites', label: 'Remove from sites', sites: true },
  { kind: 'run_out', label: 'Stop ordering, run out', sites: true },
  { kind: 'set_par', label: 'Set par at sites', sites: true },
  { kind: 'category', label: 'Change category' },
  { kind: 'pause', label: 'Pause' },
  { kind: 'prices', label: 'Change prices' },
  { kind: 'archive', label: 'Archive' },
  { kind: 'export', label: 'Export' },
]);
export const bulkActions = (multi) => BULK_ACTIONS.filter((a) => multi || !a.sites);

/** Item ids from rows, ids or a mix, once each, in order. */
export function itemIdsOf(items) {
  const out = [];
  for (const it of items || []) {
    const id = typeof it === 'string' ? it : it?.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** '<name>' for one item, '<n> items' for more. */
export function itemsWords(items) {
  const list = (items || []).filter(Boolean);
  if (list.length === 1 && typeof list[0] === 'object' && list[0].name) return list[0].name;
  return plural(itemIdsOf(list).length, 'item');
}

/**
 * One par for every ticked site, or one per site, as saveItemSite calls (contract 3.2 SetParModal).
 * values: { par, reorder, min } (one for all) or { [siteId]: { par, reorder, min } } with perSite.
 * Typed in each item's count pack and sent in base units; an empty box is left out of the patch
 * (the site keeps its value: nothing moves by itself). Only sites where the item is on.
 * Answer `{ calls: [{ itemId, locationId, patch }], error }`.
 */
export function parPlan(rows, siteIds, values, { perSite = false, packOf = (r) => r?.count_pack } = {}) {
  const calls = [];
  const fields = [['par', 'par_level'], ['reorder', 'reorder_point'], ['min', 'min_level']];
  const at = (siteId) => (perSite ? (values || {})[siteId] || {} : values || {});
  for (const siteId of siteIds || []) {
    const typed = at(siteId);
    for (const [k] of fields) {
      if (Number.isNaN(amountInput(typed[k]))) return { calls: [], error: 'Type a number of 0 or more, or leave the box empty.' };
    }
  }
  for (const row of rows || []) {
    const pack = packOf(row);
    const size = isNum(pack?.qty_in_base) && Number(pack.qty_in_base) > 0 ? Number(pack.qty_in_base) : 1;
    for (const siteId of siteIds || []) {
      if (!onAt(row, siteId)) continue;
      const typed = at(siteId);
      const patch = {};
      for (const [k, key] of fields) {
        const v = amountInput(typed[k]);
        if (v !== undefined) patch[key] = Math.round(v * size * 10000) / 10000;
      }
      if (Object.keys(patch).length) calls.push({ itemId: row.id, locationId: siteId, patch });
    }
  }
  if (!calls.length) return { calls, error: 'Type a par, reorder or minimum, at a site where the items are stocked.' };
  return { calls, error: null };
}

/**
 * Pause or unpause (contract 1.8 stock_pause_items): `{ args, error }` with args for
 * stockApi.pauseItems. where 'sites' needs at least one site; 'everywhere' sends sites null.
 * Days are 'YYYY-MM-DD' or empty (from now, until unpaused). Until is never before from.
 */
export function pausePlan({ items, where = 'sites', siteIds = [], from = '', until = '', paused = true, section = 'inventory' } = {}) {
  const ids = itemIdsOf(items);
  if (!ids.length) return { args: null, error: 'Tick at least one item.' };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const f = from ? String(from) : null;
  const u = until ? String(until) : null;
  if ((f && !day.test(f)) || (u && !day.test(u))) return { args: null, error: 'Pick a day such as 2026-11-03.' };
  if (paused && f && u && u < f) return { args: null, error: 'Until must be on or after From.' };
  if (where !== 'everywhere' && !(siteIds || []).length) return { args: null, error: 'Tick at least one site, or choose Everywhere.' };
  return {
    args: { items: ids, sites: where === 'everywhere' ? null : [...siteIds], from: paused ? f : null, until: paused ? u : null, paused: !!paused, section },
    error: null,
  };
}

/** The Change prices target as the server's spec key (exactly one, contract 1.8). */
export function priceSpecBase(target) {
  const t = target || {};
  const keys = [
    ['itemIds', 'item_ids', true], ['supplierItemIds', 'supplier_item_ids', true],
    ['supplierId', 'supplier_id', false], ['categoryId', 'category_id', false],
  ].filter(([k]) => t[k] != null && !(Array.isArray(t[k]) && !t[k].length));
  if (keys.length !== 1) return null;
  const [k, key, list] = keys[0];
  return { [key]: list ? itemIdsOf(t[k]) : t[k] };
}

export const PRICE_HOW = Object.freeze([
  { value: 'percent', label: 'Up or down by %' },
  { value: 'amount', label: 'By an amount' },
  { value: 'set', label: 'Set a price' },
]);

/**
 * The full stock_change_prices p_spec, or `{ error }`. how 'percent' (-99.99 to 1000), 'amount'
 * (any non zero number, down is minus) or 'set' (0 or more); fromDay '' = from today (null);
 * sites null = the company price, a list = price here at those sites.
 */
export function priceSpec({ target, how = 'percent', value, fromDay = '', sites = null } = {}) {
  const base = priceSpecBase(target);
  if (!base) return { spec: null, error: 'Pick what to change.' };
  if (!PRICE_HOW.some((h) => h.value === how)) return { spec: null, error: 'Pick how to change the price.' };
  const t = String(value ?? '').replace(/[£$€%,\s]/g, '');
  const v = Number(t);
  if (t === '' || !Number.isFinite(v)) return { spec: null, error: 'Type a number.' };
  if (how === 'set' && v < 0) return { spec: null, error: 'A price cannot be below 0.' };
  if (how === 'percent' && (v <= -100 || v > 1000)) return { spec: null, error: 'Type a percent above -100.' };
  if (how !== 'set' && v === 0) return { spec: null, error: 'Type how much to change it by.' };
  if (fromDay && !/^\d{4}-\d{2}-\d{2}$/.test(String(fromDay))) return { spec: null, error: 'Pick a day such as 2026-11-03.' };
  if (Array.isArray(sites) && !sites.length) return { spec: null, error: 'Tick at least one site, or choose the company price.' };
  return { spec: { ...base, sites: Array.isArray(sites) ? [...sites] : null, how, value: v, from_day: fromDay || null }, error: null };
}

/**
 * The words beside a date box, so an empty box never looks set (Safari draws today's date in grey
 * in an EMPTY date box): 'Until 3 Nov' when a day is picked, else the empty words.
 */
export function dateBoxWords(ymd, { set = '', empty = 'No day picked yet.' } = {}) {
  const day = dayWords(ymd);
  if (!day) return empty;
  return set ? `${set} ${day}` : day;
}

/** Copy a site needs two different sites. */
export function copySiteCheck(fromId, toId) {
  if (!fromId || !toId) return 'Pick the new site and the site to copy.';
  if (fromId === toId) return 'Pick two different sites.';
  return null;
}

// ── the untick choice ────────────────────────────────────────────────────────

/**
 * What one stock_item_detail read says about taking an item off one site: `{ holds, usedBy }`.
 * holds is the amount in words ('3 bottles') when the site holds some, else null (stock below zero
 * is not held: the item page's untickState rule); usedBy is the live recipes there by name (the
 * server sends the first 3 and a count). The database still decides (stock_set_item_sites).
 */
export function untickFacts(detail, siteId) {
  const site = (detail?.sites || []).find((s) => s?.location_id === siteId) || null;
  const pack = detail?.count_pack || { name: detail?.item?.base_unit || '', qty_in_base: 1 };
  const held = isNum(site?.on_hand) && Number(site.on_hand) > 1e-9 ? onHandText(site.on_hand, pack) : null;
  const names = Array.isArray(site?.recipe_names_here) ? site.recipe_names_here.filter(Boolean) : [];
  const count = isNum(site?.recipes_here) ? Number(site.recipes_here) : names.length;
  const usedBy = [...names];
  if (count > names.length) usedBy.push(plural(count - names.length, 'other recipe'));
  return { holds: held, usedBy };
}

// ── the save queue ───────────────────────────────────────────────────────────

/**
 * Bulk bar progress from stockApi.queueJobs rows (one job per site): `{ line, failed, finished }`.
 * line '<done> of <total> sites done', or 'Done.' when every job is done; failed lists
 * '<site> did not finish: <last_error>.' for each failed job.
 */
export function jobsProgress(rows, ids, siteName = () => '') {
  const want = (ids || []).map(String);
  const byId = new Map((rows || []).map((r) => [String(r.id), r]));
  const list = want.map((id) => byId.get(id) || { id, status: 'waiting' });
  const total = list.length;
  const done = list.filter((r) => r.status === 'done').length;
  const failedRows = list.filter((r) => r.status === 'failed');
  const failed = failedRows.map((r) => ({
    id: r.id,
    words: `${(r.location_id && siteName(r.location_id)) || 'A site'} did not finish: ${String(r.last_error || 'it stopped').replace(/\.\s*$/, '')}.`,
  }));
  const finished = total > 0 && done + failedRows.length === total;
  const line = !total ? '' : done === total ? 'Done.' : `${done} of ${total} sites done`;
  return { line, failed, finished };
}

/** A queued answer's job ids. */
export const jobIdsOf = (queued) => (queued || []).map((q) => q?.job_id).filter((id) => id != null);

/** 'Saved. <n> sites catch up within a minute.' (contract 4.5), or '' when nothing was queued. */
export function queuedWords(queued) {
  const sites = new Set((queued || []).map((q) => q?.location_id).filter(Boolean));
  const n = sites.size || (queued || []).length;
  if (!n) return '';
  return `Saved. ${n === 1 ? '1 site catches' : `${n} sites catch`} up within a minute.`;
}

/**
 * Run async tasks with at most `limit` at once, in order of start; never throws. Each task is a
 * function returning a promise. Answer: the results in task order ({ value } or { error }).
 */
export async function runLimited(tasks, limit = 4, onProgress = null) {
  const list = tasks || [];
  const out = new Array(list.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try { out[i] = { value: await list[i]() }; } catch (e) { out[i] = { error: e }; }
      done++;
      if (typeof onProgress === 'function') { try { onProgress(done, list.length); } catch { /* progress never stops a run */ } }
    }
  };
  const n = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** The first refusal words in runLimited results of api calls ({ data, error }), with a count. */
export function bulkOutcome(results) {
  let ok = 0;
  const errors = [];
  for (const r of results || []) {
    const e = r?.error || r?.value?.error;
    if (e) errors.push(String(e?.message || e)); else ok++;
  }
  return { ok, failed: errors.length, first: errors[0] || null };
}

// ── add item ─────────────────────────────────────────────────────────────────

/**
 * The Add item form to its three saves (contract 3.2 AddItemModal): `{ item, sites, pack, si,
 * error }`. A company item needs at least one ticked site; a local item is at its one site. kind
 * 'MADE' (Purchased or made) makes it a made here item at every site it starts at. The
 * pack people use (name and size in the base unit) becomes the count and buy default; a picked
 * supplier makes a supplier item with its pack and price.
 */
export function addItemPlan(form, { local = false, siteIds = [], localSiteId = null } = {}) {
  const f = form || {};
  const name = String(f.name || '').trim();
  if (!name) return { error: 'Give the item a name.' };
  const baseUnit = String(f.baseUnit || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(UNITS, baseUnit)) return { error: 'Pick a base unit.' };
  const ticked = local ? [localSiteId].filter(Boolean) : [...new Set(siteIds || [])];
  if (!ticked.length) return { error: local ? 'Pick the site this local item is for.' : 'Tick at least one site.' };
  const item = { location_id: ticked[0], name, base_unit: baseUnit };
  if (f.categoryId) item.category_id = f.categoryId;
  if (ITEM_TYPES.some((t) => t.value === f.type)) item.type = f.type;
  // made here (a batch or prep item) at every site it starts at; purchased is what a new item is anyway
  if (f.kind === 'MADE') item.site = { kind: 'MADE' };
  const allergens = (f.allergens || []).filter(Boolean);
  if (allergens.length) item.allergens = [...allergens];
  let pack = null;
  const packName = String(f.packName || '').trim();
  if (packName || isNum(f.packSize)) {
    const size = num(f.packSize);
    if (!packName || !(size > 0)) return { error: 'Give the pack people use a name and a size, or leave both empty.' };
    pack = { name: packName, qty_in_base: size, is_count_default: true, is_purchase_default: true };
  }
  let si = null;
  if (f.supplierId) {
    const price = priceInput(f.price);
    if (price == null || Number.isNaN(price)) return { error: 'Type the price for the supplier pack.' };
    const packQty = isNum(f.packQty) ? Number(f.packQty) : 1;
    const innerQty = num(f.innerQty);
    const innerUnit = String(f.innerUnit || baseUnit).trim().toLowerCase();
    if (!(packQty > 0) || !(innerQty > 0) || !Object.prototype.hasOwnProperty.call(UNITS, innerUnit)) {
      return { error: 'Say what the supplier pack holds, for example 6 x 2 l.' };
    }
    si = {
      supplier_id: f.supplierId,
      pack_description: String(f.packDescription || '').trim() || `${trim(packQty, 3)} x ${trim(innerQty, 3)} ${innerUnit}`,
      pack_qty: packQty, inner_qty: innerQty, inner_unit: innerUnit, pack_price: price,
    };
    const theirName = String(f.supplierProductName || '').trim();
    if (theirName) si.supplier_product_name = theirName;
  }
  return { item, sites: local ? null : ticked.map((id) => ({ location_id: id, on: true })), pack, si, error: null };
}

/** '<item> saved. It is on <n> sites' count sheets and Order pads now.' (contract 4.2). */
export function addItemSavedWords(name, n) {
  if (n === 1) return `${name} saved. It is on 1 site's count sheet and Order pad now.`;
  return `${name} saved. It is on ${n} sites' count sheets and Order pads now.`;
}

// ── import ───────────────────────────────────────────────────────────────────

/** What a file can hold (staged kind, importMappers CSV_COLUMNS key, words). */
export const IMPORT_KINDS = Object.freeze([
  { kind: 'item', key: 'items', label: 'Stock items' },
  { kind: 'supplier', key: 'suppliers', label: 'Suppliers' },
  { kind: 'supplier_item', key: 'supplier_items', label: 'Supplier items and prices' },
  { kind: 'par', key: 'pars', label: 'Pars' },
]);
export const importKey = (kind) => IMPORT_KINDS.find((k) => k.kind === kind || k.key === kind)?.key || null;
export const importKind = (key) => IMPORT_KINDS.find((k) => k.kind === key || k.key === key)?.kind || null;

const countOf = (counts, kind, action) => {
  const c = counts || {};
  const nested = c[kind] && typeof c[kind] === 'object' ? c[kind][action] : undefined;
  const flat = c[`${kind}:${action}`] ?? c[`${kind}_${action}`];
  const v = nested ?? flat;
  return isNum(v) ? Number(v) : 0;
};
const allOf = (counts, action) => {
  const c = counts || {};
  if (isNum(c[action])) return Number(c[action]);
  return ['item', 'supplier', 'supplier_item', 'par', 'recipe'].reduce((t, k) => t + countOf(c, k, action), 0);
};

/**
 * The check screen line '<n> new items, <n> price changes, <n> problems' from the job counts. The
 * counts are read per kind and action ({ item: { new: 3 } }, 'item:new' or 'item_new'); the
 * problems figure also takes a flat { problem: n }.
 */
export function importCountWords(counts) {
  // stock_import_stage answers { rows, new, change, same, skip, problem, new_items, price_changes }
  // (integrator, Drop 1): its own totals win; the per kind shapes stay readable.
  const c = counts || {};
  const newItems = isNum(c.new_items) ? Number(c.new_items) : countOf(counts, 'item', 'new');
  const priceChanges = isNum(c.price_changes) ? Number(c.price_changes) : countOf(counts, 'supplier_item', 'change') + countOf(counts, 'supplier_item', 'new');
  const problems = allOf(counts, 'problem');
  return `${plural(newItems, 'new item')}, ${plural(priceChanges, 'price change')}, ${plural(problems, 'problem')}`;
}

/**
 * What a file holds, in words for 'This file has: <words>.' (importMappers file kinds, in order):
 * ['items', 'supplier_items'] -> 'stock items and supplier items and prices'.
 */
export function importKindsWords(order) {
  const words = (order || []).map((k) => (k === 'recipes' || k === 'recipe' ? 'recipes (skipped)' : (IMPORT_KINDS.find((x) => x.key === k || x.kind === k)?.label || '').toLowerCase())).filter(Boolean);
  if (words.length <= 1) return words[0] || '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The problems the check found (rows the import would refuse). */
export const importProblems = (counts) => allOf(counts, 'problem');

/**
 * A supplier's own price list: every supplier item row that names no supplier is that supplier's
 * (the Items tab's 'Import price list'). Other rows pass as they are.
 */
export function stageWithSupplier(rows, supplier) {
  const name = String(supplier?.name || '').trim();
  return (rows || []).map((r) => {
    if (!name || r?.kind !== 'supplier_item' || String(r?.data?.supplier || '').trim()) return r;
    return { ...r, data: { ...(r.data || {}), supplier: name } };
  });
}

/** Recipe rows in the file (skipped: 'Recipes come in with the recipe update.'). */
export function importRecipeRows(counts) {
  const c = counts || {};
  if (isNum(c.recipe)) return Number(c.recipe);
  return ['new', 'change', 'same', 'skip', 'problem'].reduce((t, a) => t + countOf(c, 'recipe', a), 0);
}

/** '<done> of <total> rows done' from one queue row's progress. */
export function importProgressWords(job) {
  if (!job) return '';
  if (job.status === 'done') return 'Done.';
  const p = job.progress || {};
  const done = isNum(p.done) ? Number(p.done) : 0;
  return isNum(p.total) ? `${done} of ${Number(p.total)} rows done` : `${done} rows done`;
}
