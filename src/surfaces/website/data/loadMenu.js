// src/surfaces/website/data/loadMenu.js
//
// The live menu for the public site (ARCHITECTURE.md section 7). Reads the Ops DB exactly like
// OnlineSurface.jsx does (menu_items, menu_categories, menu_category_links, menus, eighty_six,
// stock_levels; anon RLS already allows every one of them) and returns one plain shape:
//   { categories: [{ id, label, items: [{ id, name, description, price, currency, image,
//                    dietary[], allergens[], sold_out }] }], specials: [...], menuId, error }
// Shared by React (browser client) and api/site.js (Node client, same anon RLS). Pure apart from
// the client passed in, so node:test drives it with a fake.
//
// Never throws: any failed read gives { categories: [], specials: [], error }. A customer page and
// Google's crawler both prefer an empty menu section to a broken page.
//
// Pricing is the till's: resolveItemPrice with the price mode's channel and the resolved menu, so
// the website shows the number the venue charges. Sizes (variant children) show "from" the cheapest.

import { resolveItemPrice, variantFromPrice, variantChildren } from '../../../lib/menuPricing.js';
import { dietaryBadges } from '../../../lib/dietary.js';
import { resolveActiveMenu } from '../../../lib/menus/resolveActiveMenu.js';
import { allowedCategoryIds } from '../../../lib/menuMembership.js';

export const PAGE = 1000;           // the Data API's row cap per request
export const MENU_TIMEOUT_MS = 8000; // a slow database never holds the page hostage
export const PRICE_CHANNEL = Object.freeze({ collection: 'collection', dinein: 'dineIn', delivery: 'delivery', takeaway: 'takeaway' });

// Every row of a query, page by page (lib/venueMenuRead.js readAllRows, copied so this file stays
// free of Back Office imports). `make()` builds a fresh query each time.
async function readAllRows(make, { page = PAGE, max = 20 } = {}) {
  const rows = [];
  for (let i = 0; i < max; i++) {
    let res;
    try { res = await make().range(i * page, i * page + page - 1); }
    catch (e) { return { rows: null, error: e }; }
    if (res && res.error) return { rows: null, error: res.error };
    const data = res && Array.isArray(res.data) ? res.data : null;
    if (!data) return { rows: null, error: new Error('no rows came back') };
    rows.push(...data);
    if (data.length < page) return { rows, error: null };
  }
  return { rows: null, error: new Error('too many rows to read') };
}

function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(t));
}

const str = (v) => (v == null ? '' : String(v));

// 5.12.5: Ops menu_items carry the category as `cat` (text, the primary one) and `cats` (text[],
// every category the item sits in). There is no category_id column; the first build read one and
// every item fell out of the menu ("The menu is being updated" on a live site with 157 items).
// The fixtures' category_id is still honoured so a caller may hand in the shaped name.
export function itemCategoryIds(row) {
  const out = [];
  const push = (v) => { const id = str(v); if (id && !out.includes(id)) out.push(id); };
  if (row) { push(row.cat); if (Array.isArray(row.cats)) row.cats.forEach(push); push(row.category_id); }
  return out;
}

/** False when the venue hid the item from online channels (visibility.online === false). */
export function visibleOnline(row) {
  const v = row && row.visibility;
  return !(v && typeof v === 'object' && v.online === false);
}

/** Shape one product row for the site. `kids` are its size children (empty for a plain item). */
export function shapeItem(row, { channel, menuId, currency, kids = [], soldOutIds, stock }) {
  const hasKids = kids.length > 0;
  const price = hasKids ? variantFromPrice(row, kids, channel, menuId) : resolveItemPrice(row, channel, menuId);
  const eighty = soldOutIds && soldOutIds.has(row.id);
  const remaining = stock && stock.has(row.id) ? stock.get(row.id) : null;
  const sold_out = !!eighty || (remaining != null && remaining <= 0);
  return {
    id: row.id,
    name: str(row.menu_name || row.name || 'Item'),
    description: str(row.description),
    price: Number.isFinite(Number(price)) ? Number(price) : 0,
    from: hasKids,
    currency: currency || 'GBP',
    image: typeof row.image === 'string' && row.image ? row.image : null,
    dietary: dietaryBadges(row),
    allergens: Array.isArray(row.allergens) ? row.allergens.map(str).filter(Boolean) : [],
    sold_out,
    tags: Array.isArray(row.tags) ? row.tags.map(str) : [],
    category_id: itemCategoryIds(row)[0] || null,
    category_ids: itemCategoryIds(row),
  };
}

/**
 * Group rows into [{id, label, items}] in Back Office order. Top level categories only; items in a
 * sub category are listed under its parent. `allowed` (a Set) restricts to the resolved menu.
 */
export function groupMenu(items, categories, { allowed, onlyCategoryIds, hideSoldOut, maxItems } = {}) {
  const cats = (categories || []).filter((c) => c && c.archived !== true && !c.is_special);
  const parentOf = new Map(cats.map((c) => [c.id, c.parent_id || null]));
  const topOf = (id) => {
    let cur = id, hops = 0;
    while (cur && parentOf.get(cur) && hops < 6) { cur = parentOf.get(cur); hops++; }
    return cur;
  };
  const top = cats.filter((c) => !c.parent_id && (!allowed || allowed.has(c.id)));
  const only = onlyCategoryIds && onlyCategoryIds.length ? new Set(onlyCategoryIds) : null;
  const buckets = new Map(top.map((c) => [c.id, []]));
  let count = 0;
  for (const it of items || []) {
    if (!it || (hideSoldOut && it.sold_out)) continue;
    // An item in several categories (cats) is listed once under each top level section.
    const ids = Array.isArray(it.category_ids) && it.category_ids.length ? it.category_ids : [it.category_id];
    const tops = [];
    for (const id of ids) { const t = topOf(id); if (t && buckets.has(t) && !tops.includes(t)) tops.push(t); }
    let placed = false;
    for (const t of tops) {
      if (only && !only.has(t) && !ids.some((id) => only.has(id))) continue;
      if (maxItems > 0 && count >= maxItems) break;
      buckets.get(t).push(it);
      placed = true;
    }
    if (placed) count++;
  }
  return top
    .filter((c) => !only || only.has(c.id) || (buckets.get(c.id) || []).length)
    .map((c) => ({ id: c.id, label: str(c.name || c.label || 'Menu'), items: buckets.get(c.id) || [] }))
    .filter((c) => c.items.length);
}

/**
 * loadMenu(client, opsLocationId, options) → { categories, specials, menuId, currency, error }
 * options: { menuId:'follow'|<id>, pinnedMenuId, timezone, priceMode, categories:[ids], hideSoldOut,
 *            maxItems, currency, now }
 */
export async function loadMenu(client, opsLocationId, options = {}) {
  const empty = (error) => ({ categories: [], specials: [], menuId: null, currency: options.currency || 'GBP', error: error || null });
  if (!client || !opsLocationId) return empty(new Error('no client or location'));
  const loc = String(opsLocationId);
  try {
    const run = Promise.allSettled([
      readAllRows(() => client.from('menu_items').select('*').eq('location_id', loc).eq('archived', false).order('sort_order').order('id')),
      client.from('menu_categories').select('*').eq('location_id', loc).order('sort_order'),
      client.from('menus').select('*').eq('location_id', loc).order('sort_order'),
      client.from('eighty_six').select('item_id').eq('location_id', loc),
      client.from('stock_levels').select('item_id, remaining').eq('location_id', loc),
    ]);
    const [iRes, cRes, mRes, eRes, sRes] = await withTimeout(run, options.timeoutMs || MENU_TIMEOUT_MS, 'menu read');
    const itemsRead = iRes.status === 'fulfilled' ? iRes.value : { rows: null, error: iRes.reason };
    if (!itemsRead.rows) return empty(itemsRead.error || new Error('menu items unavailable'));
    const items = itemsRead.rows;
    const categories = cRes.status === 'fulfilled' && Array.isArray(cRes.value?.data) ? cRes.value.data : [];
    const menus = mRes.status === 'fulfilled' && Array.isArray(mRes.value?.data) ? mRes.value.data.filter((m) => m && m.is_active !== false) : [];
    const soldOutIds = new Set(eRes.status === 'fulfilled' && Array.isArray(eRes.value?.data) ? eRes.value.data.map((r) => r.item_id) : []);
    const stock = new Map();
    if (sRes.status === 'fulfilled' && Array.isArray(sRes.value?.data)) {
      for (const r of sRes.value.data) if (r && r.item_id != null && r.remaining != null) stock.set(r.item_id, Number(r.remaining));
    }

    // Links for every menu (the links table has no venue column, so it is keyed by the menu ids).
    let links = [];
    const menuIds = menus.map((m) => m.id).filter(Boolean);
    if (menuIds.length) {
      const la = await withTimeout(
        readAllRows(() => client.from('menu_category_links').select('menu_id, category_id').in('menu_id', menuIds).order('menu_id').order('category_id')),
        options.timeoutMs || MENU_TIMEOUT_MS, 'menu links');
      links = la.rows || [];
    }

    // Which menu: a named one when it exists, else the one live right now (timed menus).
    let menuId = null;
    const wanted = options.menuId && options.menuId !== 'follow' ? options.menuId : null;
    if (wanted && menus.some((m) => m.id === wanted)) menuId = wanted;
    else menuId = resolveActiveMenu({ menus, categories, links, pinnedMenuId: options.pinnedMenuId || null, timezone: options.timezone, now: options.now });
    const allowed = allowedCategoryIds(categories, menuId, links);

    const channel = PRICE_CHANNEL[options.priceMode] || 'collection';
    const currency = options.currency || 'GBP';
    // Parents only (sizes hang off them), and never an item the venue hid from online.
    const parents = items.filter((r) => r && !r.parent_id && visibleOnline(r));
    const shaped = parents.map((row) => shapeItem(row, { channel, menuId, currency, kids: variantChildren(row, items), soldOutIds, stock }));

    const specialCatIds = new Set(categories.filter((c) => c && c.is_special).map((c) => c.id));
    const specials = shaped.filter((it) => specialCatIds.has(it.category_id) || it.tags.some((t) => /^special/i.test(t)));

    const grouped = groupMenu(shaped, categories, {
      allowed, onlyCategoryIds: Array.isArray(options.categories) ? options.categories : null,
      hideSoldOut: !!options.hideSoldOut, maxItems: Number(options.maxItems) || 0,
    });
    return { categories: grouped, specials, menuId, currency, error: null };
  } catch (e) {
    return empty(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Categories with sold out rows dropped (when asked) and the item cap spread across them in order. */
export function capCategories(cats, hideSoldOut, maxItems) {
  const out = [];
  let left = Number(maxItems) > 0 ? Number(maxItems) : Infinity;
  for (const c of cats || []) {
    const items = (c.items || []).filter((it) => !(hideSoldOut && it.sold_out)).slice(0, Math.max(0, left));
    left -= items.length;
    if (items.length) out.push({ ...c, items });
  }
  return out;
}

/** Money text for a price in the venue's currency, e.g. £4.50 or $12.00. Never throws. */
export function formatPrice(amount, currency = 'GBP', locale) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(locale || (currency === 'USD' ? 'en-US' : 'en-GB'), { style: 'currency', currency: currency || 'GBP' }).format(n);
  } catch {
    return n.toFixed(2);
  }
}
