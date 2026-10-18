// src/lib/msm/msmGrid.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the grid's rules. Pure, tested (msmGrid.test.js).
// The screen (src/backoffice/sections/msm/MsmGrid.jsx) only draws what these return.
//
// THE GRID
//   Products down the side, grouped by category (central order, sub categories under their
//   parent), sizes straight under the product they are a size of. Sites across the top, a
//   Default column first. A cell is the price at that site with its on or off switch. A site that
//   follows the default shows the price in grey; its own price shows in full colour.
//   1,000 products by 20 sites is 20,000 cells, so only the rows on screen are drawn
//   (visibleRange, fixed row height).
//
// PRICES FOR A CHANNEL (design 1.12) work exactly as the Change prices maths reads them
// (supabase/functions/_shared/msmPrice.js): a site's own channel price, else the group's channel
// price, else the site's In store price, else the group's In store price.

import { CHANNELS, toPence, fromPence, normName, has, channelFallback, NO_PRICE, noPriceAt, pricedBySizes } from '../../../supabase/functions/_shared/msmModel.js';
import { isOptionOnlyItem } from '../menuRules.js';

export const ROW_H = 40;
export const CAT_ROW_H = 40;
export const NO_CATEGORY = '__none__';

const listOf = (v) => (Array.isArray(v) ? v : []);
const keyOf = (pid, loc) => `${pid}|${loc}`;

/** The order type names the Showing picker uses. null = the Standard price (the base price). */
export const CHANNEL_LABELS = Object.freeze({
  dineIn: 'Eat in', takeaway: 'Takeaway', collection: 'Collection', delivery: 'Delivery', driveThru: 'Drive thru',
});
// Round 2 (the clarity pass): "In store" read as "only in the shop"; it is the price used when no
// order type price is set, so it is the Standard price (design 2, item 5).
export const channelLabel = (ch) => (ch ? CHANNEL_LABELS[ch] || 'Another order type' : 'Standard price');
/** "Standard price" or "Eat in price", for the Showing picker and the column header. */
export const priceLabel = (ch) => (ch ? `${CHANNEL_LABELS[ch] || 'Order type'} price` : 'Standard price');
const okChannel = (ch) => (ch && CHANNELS.includes(ch) ? ch : null);

// ── Indexing ────────────────────────────────────────────────────────────────

/**
 * Lookups over central state, built once per change of state.
 * Returns { products: Map, sites: Map(pid|loc -> product site), sizes: Map(parentId -> [product]),
 *           categories: Map, childrenOf: Map(parentId|null -> [category]) }.
 */
export function indexCentral(central) {
  const products = new Map();
  for (const p of listOf(central?.products)) products.set(p.id, p);
  const sites = new Map();
  for (const ps of listOf(central?.productSites)) sites.set(keyOf(ps.product_id, ps.location_id), ps);
  const sizes = new Map();
  for (const p of products.values()) {
    if (!p.parent_product_id || !products.has(p.parent_product_id)) continue;
    if (!sizes.has(p.parent_product_id)) sizes.set(p.parent_product_id, []);
    sizes.get(p.parent_product_id).push(p);
  }
  const categories = new Map();
  for (const c of listOf(central?.categories)) categories.set(c.id, c);
  const childrenOf = new Map();
  for (const c of categories.values()) {
    const parent = c.parent_id && categories.has(c.parent_id) ? c.parent_id : null;
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(c);
  }
  const byOrder = (a, b) => (Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)) || String(a.label || a.name || '').localeCompare(String(b.label || b.name || '')) || String(a.id).localeCompare(String(b.id));
  for (const list of childrenOf.values()) list.sort(byOrder);
  for (const list of sizes.values()) list.sort(byOrder);
  // Round 2: which option groups each sub item is an option in ("also an option in 2 groups").
  const liveGroups = new Set(listOf(central?.groups).filter((g) => g && !g.archived).map((g) => g.id));
  const optionIn = new Map();
  for (const o of listOf(central?.options)) {
    if (!o || o.archived || !o.product_id || !liveGroups.has(o.group_id)) continue;
    if (!optionIn.has(o.product_id)) optionIn.set(o.product_id, new Set());
    optionIn.get(o.product_id).add(o.group_id);
  }
  return { products, sites, sizes, categories, childrenOf, byOrder, optionIn };
}

/**
 * The category tree in central order, depth first: [{ id, label, depth, category }].
 * Archived categories are left out unless includeArchived.
 */
export function categoryTree(central, { includeArchived = false } = {}) {
  const ix = central && central.childrenOf ? central : indexCentral(central);
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const c of ix.childrenOf.get(parent) || []) {
      if (seen.has(c.id) || depth > 12) continue;
      seen.add(c.id);
      if (c.archived && !includeArchived) continue;
      out.push({ id: c.id, label: c.label, depth, category: c });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** A category and every category under it (ids). */
export function withSubcategories(central, categoryId) {
  const ix = central && central.childrenOf ? central : indexCentral(central);
  const out = new Set([categoryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of ix.categories.values()) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true; }
  }
  return out;
}

/** "Hot drinks > Coffee" for a category id. */
export function categoryPath(central, categoryId) {
  const ix = central && central.childrenOf ? central : indexCentral(central);
  const parts = [];
  let c = ix.categories.get(categoryId), n = 0;
  while (c && n++ < 12) { parts.unshift(c.label); c = c.parent_id ? ix.categories.get(c.parent_id) : null; }
  return parts.join(' > ');
}

// ── Cells ───────────────────────────────────────────────────────────────────

/** The group's price for a product (In store, or a channel: its own channel price, else In store). */
export function defaultFor(product, channel = null) {
  const ch = okChannel(channel);
  const base = product ? Number(product.default_price ?? 0) : 0;
  if (!ch) return base;
  // Drive thru reads takeaway before In store, like the till (msmModel.channelFallback).
  return channelFallback(product, null, ch) ?? base;
}

/**
 * One cell: the product at one site.
 *   ix        indexCentral(central)
 * Returns { exists, active, price, own, follows, defaultPrice, keptCols, siteOnlyElsewhere }.
 *   exists    the product is in the group menu at that site at all
 *   own       the site's own price (null when it follows)
 */
export function cellFor(ix, product, locationId, channel = null) {
  const ch = okChannel(channel);
  const ps = ix.sites.get(keyOf(product.id, locationId)) || null;
  const siteOnlyElsewhere = false;   // round 2: no "site only extra" (Peter, UI issue 6)
  const defBase = Number(product.default_price ?? 0);
  if (!ps) return { exists: false, active: false, price: null, own: null, follows: true, defaultPrice: defaultFor(product, ch), keptCols: [], siteOnlyElsewhere, noPrice: false };
  // "No price" (kept no_price, 17 Oct recheck) is not a setting the site keeps: it is shown as
  // "No price at <site>" in the cell, never as a blue dot, never as 0.00.
  const keptCols = ps.kept && typeof ps.kept === 'object' ? Object.keys(ps.kept).filter((k) => k !== NO_PRICE) : [];
  const noPrice = noPriceAt(product, ps, ch);
  if (!ch) {
    const own = ps.price == null ? null : Number(ps.price);
    return { exists: true, active: ps.active !== false, price: noPrice ? null : own ?? defBase, own, follows: own == null && !noPrice, defaultPrice: defBase, keptCols, siteOnlyElsewhere, noPrice };
  }
  const own = ps.channel_prices && has(ps.channel_prices, ch) && ps.channel_prices[ch] != null ? Number(ps.channel_prices[ch]) : null;
  // The till's chain (msmModel.channelFallback): drive thru reads takeaway before In store.
  const fallback = channelFallback(product, ps, ch) ?? defBase;
  return { exists: true, active: ps.active !== false, price: noPrice ? null : own ?? fallback, own, follows: own == null && !noPrice, defaultPrice: fallback, keptCols, siteOnlyElsewhere, noPrice };
}

/** "No price at Leeds" (the words every screen uses for a site with no price). */
export const noPriceWords = (siteName) => `No price at ${siteName || 'this site'}`;

/** Prices at the sites where the product is on, In store or a channel: [number]. */
export function activePrices(ix, product, locationIds, channel = null) {
  const out = [];
  for (const loc of locationIds) {
    const c = cellFor(ix, product, loc, channel);
    if (c.exists && c.active && c.price != null) out.push(c.price);
  }
  return out;
}

/** Do the sites selling this product charge different prices? */
export function pricesDiffer(ix, product, locationIds, channel = null) {
  const ps = activePrices(ix, product, locationIds, channel).map((v) => toPence(v));
  return new Set(ps).size > 1;
}

// ── What a draft has staged ─────────────────────────────────────────────────

/**
 * Which cells and products a draft touches, for the marks on the grid.
 * Returns { products: Map(pid -> Set(fields)), created: Set(pid), sites: Map(pid|loc -> Set(fields)),
 *           categories: Map(cid -> Set(fields)), count }.
 */
export function stagedIndex(rows) {
  const products = new Map(), sites = new Map(), categories = new Map();
  const created = new Set();
  for (const r of listOf(rows)) {
    const fields = new Set(Object.keys(r.after || {}));
    if (r.target === 'product') {
      products.set(r.entity_id, fields);
      if (r.op === 'create') created.add(r.entity_id);
    } else if (r.target === 'product_site') {
      sites.set(keyOf(r.entity_id, r.location_id), new Set([...fields, ...(r.op === 'create' ? ['active'] : [])]));
    } else if (r.target === 'category') {
      categories.set(r.entity_id, fields);
    }
  }
  return { products, created, sites, categories, count: listOf(rows).length };
}

/** Is a cell's price, or its switch, staged? */
export function cellStaged(staged, productId, locationId, channel = null) {
  const f = staged?.sites?.get(keyOf(productId, locationId));
  if (!f) return { price: false, active: false, kept: false };
  // kept: "Use the group's settings" staged on the blue dot (17 Oct verification: it left no mark).
  return { price: channel ? f.has('channel_prices') : f.has('price'), active: f.has('active'), kept: f.has('kept') };
}

// ── Rows ────────────────────────────────────────────────────────────────────

// Round 2 (design 1.5): sub items only ever used as options are hidden from "Products", so they
// stop sitting among the products; "Sub items only used as options" and "Everything" show them.
export const SHOW_FILTERS = Object.freeze([
  { id: 'all', label: 'Products' },
  { id: 'subs', label: 'Sub items only used as options' },
  { id: 'everything', label: 'Everything' },
  { id: 'staged', label: 'Changed in this draft' },
  { id: 'differ', label: 'Prices differ' },
  { id: 'off', label: 'Turned off somewhere' },
  { id: 'kept', label: 'A site keeps its own' },
  { id: 'archived', label: 'Removed' },
]);
export const showLabel = (id) => (SHOW_FILTERS.find((f) => f.id === id) || SHOW_FILTERS[0]).label;

/**
 * The rows the grid draws, in order.
 *   central    central state with the draft applied
 *   opts       { search, categoryId, show, siteIds (the site columns), staged, collapsed: Set(catId), channel }
 * Returns { rows: [{ kind: 'cat', id, label, depth, count, collapsed } | { kind: 'product', id, product, depth, size }],
 *           products: number of product rows that match (whatever is collapsed) }.
 */
export function buildGridRows(central, opts = {}) {
  const ix = central && central.childrenOf ? central : indexCentral(central);
  const siteIds = listOf(opts.siteIds);
  const show = opts.show || 'all';
  const q = normName(opts.search || '');
  const collapsed = opts.collapsed instanceof Set ? opts.collapsed : new Set(opts.collapsed || []);
  const inCat = opts.categoryId ? withSubcategories(ix, opts.categoryId) : null;

  const matches = (p) => {
    if (show === 'archived' ? !p.archived : p.archived) return false;
    const optionOnly = isOptionOnlyItem(p);
    if (show === 'subs' ? !optionOnly : (optionOnly && show !== 'everything' && show !== 'staged' && show !== 'archived')) return false;
    if (inCat && !inCat.has(p.category_id) && !listOf(p.extra_category_ids).some((c) => inCat.has(c))) return false;
    if (q) {
      const hay = normName([p.name, p.menu_name, p.receipt_name, p.item_code].filter(Boolean).join(' '));
      if (!hay.includes(q)) return false;
    }
    switch (show) {
      case 'staged': return !!(opts.staged && (opts.staged.products.has(p.id) || siteIds.some((l) => opts.staged.sites.has(keyOf(p.id, l)))));
      case 'differ': return pricesDiffer(ix, p, siteIds, opts.channel);
      case 'off': return siteIds.some((l) => { const c = cellFor(ix, p, l); return c.exists && !c.active; });
      case 'kept': return siteIds.some((l) => cellFor(ix, p, l).keptCols.length > 0);
      default: return true;
    }
  };

  // Products by category; a size sits under its product when both show, else on its own.
  const byCat = new Map();
  const shown = new Set();
  for (const p of ix.products.values()) if (matches(p)) shown.add(p.id);
  // Peter, 17 Oct 2026 (UI issue 9): searching "House Red" must show its sizes under it, and
  // searching "250" must show the 250 ml glass under House Red, never on its own. A size whose
  // product is listed is drawn under it below; a matched size brings its product in above it.
  const archivedOk = (p) => (show === 'archived' ? !!p.archived : !p.archived);
  if (q || inCat) {
    for (const id of [...shown]) for (const sz of ix.sizes.get(id) || []) if (archivedOk(sz)) shown.add(sz.id);
  }
  for (const id of [...shown]) {
    const parentId = ix.products.get(id)?.parent_product_id;
    const parent = parentId ? ix.products.get(parentId) : null;
    if (parent && archivedOk(parent)) shown.add(parent.id);
  }
  for (const p of ix.products.values()) {
    if (!shown.has(p.id)) continue;
    if (p.parent_product_id && shown.has(p.parent_product_id)) continue;   // drawn under its parent
    const cid = p.category_id && ix.categories.has(p.category_id) ? p.category_id : NO_CATEGORY;
    if (!byCat.has(cid)) byCat.set(cid, []);
    byCat.get(cid).push(p);
  }
  for (const list of byCat.values()) list.sort(ix.byOrder);

  const rows = [];
  let count = 0;
  const pushProducts = (cid, depth) => {
    for (const p of byCat.get(cid) || []) {
      rows.push({ kind: 'product', id: p.id, product: p, depth, size: false });
      for (const s of ix.sizes.get(p.id) || []) if (shown.has(s.id)) rows.push({ kind: 'product', id: s.id, product: s, depth, size: true });
    }
  };
  const countIn = (cid) => {
    let n = 0;
    for (const p of byCat.get(cid) || []) { n++; for (const s of ix.sizes.get(p.id) || []) if (shown.has(s.id)) n++; }
    return n;
  };
  const tree = categoryTree(ix, { includeArchived: show === 'archived' });
  // A category shows when it, or one under it, holds a matching product.
  const totals = new Map();
  for (let i = tree.length - 1; i >= 0; i--) {
    const t = tree[i];
    let n = countIn(t.id);
    for (const c of ix.childrenOf.get(t.id) || []) n += totals.get(c.id) || 0;
    totals.set(t.id, n);
  }
  let hideBelow = null;   // depth under a collapsed category
  for (const t of tree) {
    if (hideBelow != null && t.depth > hideBelow) continue;
    hideBelow = null;
    const total = totals.get(t.id) || 0;
    if (!total) continue;
    const isCollapsed = collapsed.has(t.id);
    rows.push({ kind: 'cat', id: t.id, label: t.label, depth: t.depth, count: total, collapsed: isCollapsed });
    if (isCollapsed) { hideBelow = t.depth; continue; }
    pushProducts(t.id, t.depth);
  }
  if (byCat.has(NO_CATEGORY)) {
    const isCollapsed = collapsed.has(NO_CATEGORY);
    rows.push({ kind: 'cat', id: NO_CATEGORY, label: 'No category', depth: 0, count: countIn(NO_CATEGORY), collapsed: isCollapsed });
    if (!isCollapsed) pushProducts(NO_CATEGORY, 0);
  }
  count = shown.size;
  return { rows, products: count };
}

// ── Drawing only what is on screen ──────────────────────────────────────────

/** May this product's price cells be edited from the keyboard? A variants parent is priced by its sizes. */
// A product priced by its sizes (typed 'variants', or with live sizes under it when the products are
// passed: Menu Manager shows no Standard price box for it either) has no price cell of its own.
export const priceEditable = (product, products = null) => !!product && !pricedBySizes(product, products);

/** The first and one past the last row to draw. */
export function visibleRange(scrollTop, viewportH, total, rowH = ROW_H, overscan = 8) {
  const top = Math.max(0, Number(scrollTop) || 0);
  const h = Math.max(0, Number(viewportH) || 0);
  const start = Math.max(0, Math.floor(top / rowH) - overscan);
  const end = Math.min(total, Math.ceil((top + h) / rowH) + overscan);
  return { start, end: Math.max(start, end) };
}

// ── Typing and pasting prices ───────────────────────────────────────────────

/**
 * What a person typed into a price cell.
 *   ''           { ok, value: null }   blank = follow the group's price
 *   '£3.20'      { ok, value: 3.2 }
 *   anything else { ok: false, words }
 */
export function priceInput(text) {
  let t = String(text ?? '').trim().replace(/^[£$€]\s*/, '');
  // A comma only ever separates thousands (1,250.00). '3,20' is a slip of the key next to the
  // full stop (or a comma decimal pasted in): refused, never read as 320.00.
  if (/,/.test(t)) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) return { ok: false, words: 'Use a full stop for pence, like 3.20.' };
    t = t.replace(/,/g, '');
  }
  if (!t) return { ok: true, value: null };
  if (!/^\d{0,5}(\.\d{0,2})?$/.test(t) || t === '.') return { ok: false, words: 'Type a price in pounds and pence, like 3.20.' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, words: 'Type a price in pounds and pence, like 3.20.' };
  if (n > 9999.99) return { ok: false, words: 'That price is too high.' };
  return { ok: true, value: fromPence(toPence(n)) };
}

/**
 * A column pasted from a spreadsheet: one price per line (the first cell of each line).
 * Returns [{ value } | { skip: true } | { invalid: true, text }]. A blank line is skipped, never
 * read as "follow the group's price".
 */
export function parsePastedColumn(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.map((line) => {
    const first = line.split('\t')[0].trim();
    if (!first) return { skip: true };
    const r = priceInput(first);
    return r.ok && r.value != null ? { value: r.value } : { invalid: true, text: first };
  });
}

/** Money for the grid: 3.2 -> "3.20" (the currency symbol is added by the screen). */
export const price2 = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : (Math.round(Number(v) * 100) / 100).toFixed(2));

// ── Keyboard ────────────────────────────────────────────────────────────────

/**
 * Where the focus goes from { row, col } on a key, skipping category rows.
 *   rows   the grid rows; cols = number of price columns (0 is Default)
 */
export function moveFocus(rows, cols, at, key) {
  if (!at || !rows.length || cols < 1) return at;
  let { row, col } = at;
  const step = (dir) => {
    let r = row + dir;
    while (r >= 0 && r < rows.length && rows[r].kind !== 'product') r += dir;
    return r >= 0 && r < rows.length ? r : row;
  };
  if (key === 'ArrowDown' || key === 'Enter') row = step(1);
  else if (key === 'ArrowUp') row = step(-1);
  else if (key === 'ArrowRight' || key === 'Tab') col = Math.min(cols - 1, col + 1);
  else if (key === 'ArrowLeft' || key === 'ShiftTab') col = Math.max(0, col - 1);
  return { row, col };
}
