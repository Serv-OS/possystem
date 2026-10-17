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

import { CHANNELS, toPence, fromPence, normName, has } from '../../../supabase/functions/_shared/msmModel.js';

export const ROW_H = 40;
export const CAT_ROW_H = 40;
export const NO_CATEGORY = '__none__';

const listOf = (v) => (Array.isArray(v) ? v : []);
const keyOf = (pid, loc) => `${pid}|${loc}`;

/** The channel names the Prices for picker shows. null = In store (the base price). */
export const CHANNEL_LABELS = Object.freeze({
  dineIn: 'Eat in', takeaway: 'Takeaway', collection: 'Collection', delivery: 'Delivery', driveThru: 'Drive thru',
});
export const channelLabel = (ch) => (ch ? CHANNEL_LABELS[ch] || ch : 'In store');
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
  return { products, sites, sizes, categories, childrenOf, byOrder };
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
  const v = product?.default_channels && has(product.default_channels, ch) ? product.default_channels[ch] : null;
  return v == null ? base : Number(v);
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
  const siteOnlyElsewhere = !!(product.site_only_location_id && product.site_only_location_id !== locationId);
  const defBase = Number(product.default_price ?? 0);
  if (!ps) return { exists: false, active: false, price: null, own: null, follows: true, defaultPrice: defaultFor(product, ch), keptCols: [], siteOnlyElsewhere };
  const keptCols = ps.kept && typeof ps.kept === 'object' ? Object.keys(ps.kept) : [];
  if (!ch) {
    const own = ps.price == null ? null : Number(ps.price);
    return { exists: true, active: ps.active !== false, price: own ?? defBase, own, follows: own == null, defaultPrice: defBase, keptCols, siteOnlyElsewhere };
  }
  const own = ps.channel_prices && has(ps.channel_prices, ch) && ps.channel_prices[ch] != null ? Number(ps.channel_prices[ch]) : null;
  const defCh = product.default_channels && has(product.default_channels, ch) && product.default_channels[ch] != null ? Number(product.default_channels[ch]) : null;
  const fallback = defCh ?? (ps.price != null ? Number(ps.price) : defBase);
  return { exists: true, active: ps.active !== false, price: own ?? fallback, own, follows: own == null, defaultPrice: fallback, keptCols, siteOnlyElsewhere };
}

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
  if (!f) return { price: false, active: false };
  return { price: channel ? f.has('channel_prices') : f.has('price'), active: f.has('active') };
}

// ── Rows ────────────────────────────────────────────────────────────────────

export const SHOW_FILTERS = Object.freeze([
  { id: 'all', label: 'All products' },
  { id: 'staged', label: 'Changed in this draft' },
  { id: 'differ', label: 'Prices differ' },
  { id: 'off', label: 'Off somewhere' },
  { id: 'extras', label: 'Site only extras' },
  { id: 'kept', label: 'A site keeps its own' },
  { id: 'archived', label: 'Removed' },
]);

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
    if (inCat && !inCat.has(p.category_id) && !listOf(p.extra_category_ids).some((c) => inCat.has(c))) return false;
    if (q) {
      const hay = normName([p.name, p.menu_name, p.receipt_name, p.item_code].filter(Boolean).join(' '));
      if (!hay.includes(q)) return false;
    }
    switch (show) {
      case 'staged': return !!(opts.staged && (opts.staged.products.has(p.id) || siteIds.some((l) => opts.staged.sites.has(keyOf(p.id, l)))));
      case 'differ': return pricesDiffer(ix, p, siteIds, opts.channel);
      case 'off': return siteIds.some((l) => { const c = cellFor(ix, p, l); return c.exists && !c.active; });
      case 'extras': return !!p.site_only_location_id;
      case 'kept': return siteIds.some((l) => cellFor(ix, p, l).keptCols.length > 0);
      default: return true;
    }
  };

  // Products by category; a size sits under its product when both show, else on its own.
  const byCat = new Map();
  const shown = new Set();
  for (const p of ix.products.values()) if (matches(p)) shown.add(p.id);
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
  const t = String(text ?? '').trim().replace(/^[£$€]\s*/, '').replace(/,/g, '');
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
