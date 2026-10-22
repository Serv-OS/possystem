/**
 * stock/recipeMatch.js: the smart match between a till product and a company recipe (multi site
 * stock Drop 2, map 4.5, contract 3.2). Pure (recipeMatch.test.js). The browser twin of the
 * database's stock_co__match_recipe, used where the screen already holds the rows: the Till product
 * select of the Sites tab (the 'suggested' row) and the words under Recipe missing. The database
 * does the real suggestion under Recipe missing (stock_recipe_missing); nothing here links anything.
 *
 *   normName(s)                   the Multi site menu's name rule (msmModel.js), one copy
 *   matchRecipe({ product, candidates, priceTolerance })  -> { recipeId, how, priceDiffPct } | null
 *   suggestTillProduct({ recipe, sites, menuItems })      -> the menu item id to offer first, or null
 *   suggestWords(row, { fromSiteName })                   'Use Leeds's recipe here' / 'No match'
 *   menuItemLabel, sellableMenuItems, priceDiffPct, linksOf
 */

import { normName } from '../../../supabase/functions/_shared/msmModel.js';

export { normName };

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const id = (v) => (v == null || v === '' ? null : String(v));

/** How far one gross price sits from another, as a fraction of the other (0.05 = 5%); null when unknown. */
export function priceDiffPct(price, other) {
  const p = num(price);
  const o = num(other);
  if (p == null || o == null) return null;
  if (o === 0) return p === 0 ? 0 : null;
  return Math.abs(p - o) / Math.abs(o);
}

const within = (diff, tolerance) => diff == null || diff <= tolerance + 1e-12;

/**
 * The client side twin of stock_co__match_recipe, in its order:
 *   (1) 'msm'    the product and the candidate share a Multi site menu product id
 *   (2) 'master' they share a menu_items.master_id
 *   (3) 'name'   the normalised names are equal (the recipe's own name, or a till product the recipe
 *                is linked to at another site), when the gross prices are within the tolerance
 *                (15%); a side with no price is not compared
 * product: { id, name, masterId, msmProductId, price }. candidates: [{ recipeId, recipeName,
 * msmProductId, masterId, menuItemName, price, siteId }]. Answer { recipeId, how, priceDiffPct } or
 * null. The first candidate in the list wins a tie, so pass them in the order they should.
 */
export function matchRecipe({ product, candidates, priceTolerance = 0.15 } = {}) {
  const p = product || {};
  const list = (candidates || []).filter((c) => c && c.recipeId);
  const pMsm = id(p.msmProductId);
  if (pMsm) {
    const c = list.find((x) => id(x.msmProductId) === pMsm);
    if (c) return { recipeId: c.recipeId, how: 'msm', priceDiffPct: priceDiffPct(p.price, c.price) };
  }
  const pMaster = id(p.masterId);
  if (pMaster) {
    const c = list.find((x) => id(x.masterId) === pMaster);
    if (c) return { recipeId: c.recipeId, how: 'master', priceDiffPct: priceDiffPct(p.price, c.price) };
  }
  const pName = normName(p.name);
  if (!pName) return null;
  for (const c of list) {
    const names = [c.recipeName, c.menuItemName].map(normName).filter(Boolean);
    if (!names.includes(pName)) continue;
    const diff = priceDiffPct(p.price, c.price);
    if (within(diff, priceTolerance)) return { recipeId: c.recipeId, how: 'name', priceDiffPct: diff };
  }
  return null;
}

/** A product's name with its parent's in front ('Latte Large'), the Recipes screen's rule. */
export function menuItemLabel(item, byId = null) {
  if (!item) return '';
  const n = String(item.name || '').trim();
  const parentId = item.parentId ?? item.parent_id ?? null;
  if (!parentId) return n;
  const parent = byId ? (byId instanceof Map ? byId.get(String(parentId)) : byId[String(parentId)]) : null;
  if (!parent) return n;
  const pn = String(parent.name || '').trim();
  return n.toLowerCase().startsWith(pn.toLowerCase()) ? n : `${pn} ${n}`.trim();
}

/**
 * The till products a recipe can be linked to at a site: live rows that are not variant parents (a
 * parent is never sold; its children are). Sub items are sellable (modifier groups sell them).
 * Answer [{ id, name (parent qualified), price, masterId, parentId }], by name.
 */
export function sellableMenuItems(menuItems) {
  const rows = (menuItems || []).filter(Boolean);
  const byId = new Map(rows.map((m) => [String(m.id), m]));
  const parents = new Set(rows.map((m) => m.parentId ?? m.parent_id).filter((x) => x != null).map(String));
  return rows
    .filter((m) => !m.archived && !parents.has(String(m.id)))
    .map((m) => ({
      id: String(m.id),
      name: menuItemLabel(m, byId),
      price: num(m.pricing?.base ?? m.price),
      masterId: id(m.masterId ?? m.master_id),
      parentId: id(m.parentId ?? m.parent_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { numeric: true, sensitivity: 'base' }));
}

/**
 * The 'suggested' row of the Till product select at one site: the first sellable menu item there
 * that matches the recipe (its Multi site menu product, the master id of a product it is linked to
 * elsewhere, or its name or a linked product's name within the price tolerance). recipe: the
 * detail's recipe row; sites: the detail's sites (the other sites' links); menuItems: that site's
 * menu (fetchSiteStockContext). Answer the menu item id, or null.
 */
export function suggestTillProduct({ recipe, sites = [], menuItems = [], siteId = null, priceTolerance = 0.15 } = {}) {
  const r = recipe || {};
  const linked = (sites || []).filter((s) => s && s.on && s.menu_item_id && s.location_id !== siteId);
  const candidates = [
    { recipeId: r.id || 'recipe', recipeName: r.name, msmProductId: r.msm_product_id || null, masterId: null, menuItemName: null, price: null },
    ...linked.map((s) => ({ recipeId: r.id || 'recipe', recipeName: null, msmProductId: null, masterId: s.master_id || null, menuItemName: s.menu_item_name, price: s.sale_price, siteId: s.location_id })),
  ];
  for (const m of sellableMenuItems(menuItems)) {
    const hit = matchRecipe({ product: { id: m.id, name: m.name, masterId: m.masterId, msmProductId: m.msmProductId || null, price: m.price }, candidates, priceTolerance });
    if (hit) return m.id;
  }
  return null;
}

/**
 * The Suggested recipe cell of Recipe missing: 'No match' when the database found none; "Use
 * <site>'s recipe here" when it matched through the Multi site menu or a master id and the recipe
 * is on at another site (fromSiteName); else the recipe's name.
 */
export function suggestWords(row, { fromSiteName = '' } = {}) {
  const s = row?.suggested || null;
  if (!s || !s.recipe_id) return 'No match';
  if ((s.how === 'msm' || s.how === 'master') && fromSiteName) return `Use ${fromSiteName}'s recipe here`;
  return s.name || 'A company recipe';
}

/**
 * The links Link matched sends, at most 200: the ticked rows with a recipe (the suggestion or the
 * one picked by hand). rows: [{ location_id, menu_item_id, suggested }]; picked: { '<loc>|<item>':
 * recipe_id }. Answer { links: [{ location_id, menu_item_id, recipe_id }], over: n left out }.
 */
export function linksOf(rows, ticked, picked = {}, max = 200) {
  const want = ticked instanceof Set ? ticked : new Set(ticked || []);
  const links = [];
  for (const r of rows || []) {
    const key = rowKey(r);
    if (!want.has(key)) continue;
    const recipeId = picked?.[key] || r.suggested?.recipe_id || null;
    if (!recipeId) continue;
    links.push({ location_id: r.location_id, menu_item_id: r.menu_item_id, recipe_id: recipeId });
  }
  return { links: links.slice(0, max), over: Math.max(0, links.length - max) };
}

/** The key of one Recipe missing row: '<location_id>|<menu_item_id>'. */
export const rowKey = (r) => `${r?.location_id || ''}|${r?.menu_item_id || ''}`;
