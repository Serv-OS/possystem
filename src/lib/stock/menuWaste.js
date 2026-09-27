/**
 * menuWaste.js: the pure half of wasting a MENU product (till Waste, BO Wastage).
 *
 * 26 Sep 2026, Peter: "waste isn't showing because they don't have any stock set up,
 * but people still like to waste things and should be able to without stock". Until
 * now a product could only be wasted when a recipe turned it into stock lines; a venue
 * with no stock items and no recipes saw a dead end. These helpers have no I/O so the
 * list a venue sees, the rule that may still refuse and the row it writes can be tested
 * on their own.
 *
 *   listWasteProducts(menuItems, menuRecipes) -> what the screen lists
 *   countLiveStockItems(items)                -> stock items that still count (archived ones do not)
 *   stockPresence({...})                      -> does this venue run stock, and are recipes missing
 *   wasteRefusal({ hasStock, linked, rows })  -> why a STOCK venue still says no (null = record it)
 *   buildMenuWasteRow({...})                  -> the waste_events row that gets inserted
 *   firstReadError(results)                   -> the first failed supabase read, or null
 */

// .js on purpose: node --test resolves this file too, and Node ESM needs the extension.
import { isOptionOnlyItem } from '../menuRules.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** Recipe lines that can post a stock movement: an inventory item and a positive base qty. */
export const usableIngredientLines = (ingredients) =>
  (Array.isArray(ingredients) ? ingredients : []).filter(i => i && i.inventoryItemId && Number(i.qtyBase) > 0);

/**
 * Every selling item the POS itself shows, with a parent-qualified label, its menu
 * price and whether a recipe is linked. Variant containers, archived items and option
 * only sub items are left out (you waste the variant, not the container). The list does
 * NOT depend on stock or recipes existing: with none linked every row is simply unlinked.
 */
export function listWasteProducts(menuItems, menuRecipes) {
  const items = Array.isArray(menuItems) ? menuItems : [];
  const linked = menuRecipes || {};
  const byId = {}; items.forEach(m => { byId[String(m.id)] = m; });
  const parents = new Set(items.filter(m => m.parentId).map(m => String(m.parentId)));
  const label = (m) => {
    if (!m?.parentId) return m?.menuName || m?.name || '';
    const p = byId[String(m.parentId)];
    const n = (m.menuName || m.name || '').trim();
    if (!p) return n;
    const pn = (p.menuName || p.name || '');
    return n.toLowerCase().startsWith(pn.toLowerCase()) ? n : `${pn} ${n}`.trim();
  };
  const priceOf = (m) => Number(m.pricing?.base ?? m.price ?? 0);
  return items
    .filter(m => !m.archived && !isOptionOnlyItem(m) && !parents.has(String(m.id)))
    .map(m => ({ id: m.id, label: label(m), linked: !!linked[String(m.id)], price: priceOf(m) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * 26 Sep 2026 (waste without stock review): an ARCHIVED stock item is one the venue has
 * put away, so it must not make a venue count as "runs stock" (that would bring back the
 * refusal Peter asked us to drop). fetchInventoryItems maps archived_at to `archivedAt`;
 * a raw row still carries `archived_at`, so either one means archived.
 */
export const countLiveStockItems = (items) =>
  (Array.isArray(items) ? items : []).filter(it => it && !it.archivedAt && !it.archived_at).length;

/**
 * 26 Sep 2026: what the till Waste modal knows about a venue's stock, once every stock
 * read has succeeded (`loaded`; before that, or after a failed read, it knows nothing).
 *   hasStock        a recipe is linked or a live stock item exists: the stock rules apply
 *   recipesMissing  live stock items but no recipe linked at all: every menu waste would be
 *                   refused, so the screen says why once instead of one toast per product
 * `linkedRecipes` and `liveStockItems` are counts.
 */
export function stockPresence({ loaded, linkedRecipes, liveStockItems }) {
  if (!loaded) return { hasStock: false, recipesMissing: false };
  const linked = Number(linkedRecipes) || 0;
  const live = Number(liveStockItems) || 0;
  return { hasStock: linked > 0 || live > 0, recipesMissing: live > 0 && linked === 0 };
}

/**
 * 26 Sep 2026: may a venue record this menu waste? Peter: "should be able to waste
 * without stock", so a venue with NO stock is never refused (null). A venue WITH stock
 * keeps the rule it always had: when nothing would come off stock the record is refused,
 * because a waste that skips the deduction is a silent wrong number in the ledger. The
 * return value says why, so the screen can word it:
 *   'unlinked'           the product has no recipe (the old "link it in Recipes" toast)
 *   'nothing_to_deduct'  linked, but the recipe explodes to no stock lines (no lines yet,
 *                        an ingredient missing from stock, a unit that will not convert)
 * `rows` are the exploded stock lines the screen shows under "Comes off stock".
 */
export function wasteRefusal({ hasStock, linked, rows }) {
  if (!hasStock) return null;
  if (Array.isArray(rows) && rows.length > 0) return null;
  return linked ? 'nothing_to_deduct' : 'unlinked';
}

/**
 * The waste_events row for a wasted menu product. The schema has no menu item column
 * (production DDL is blocked), so a product waste is the existing product shape:
 * inventory_item_id null, item_name = the product, unit 'item', sale_value = the lost
 * sale at menu price. cost_value is the stock cost of the recipe lines when there are
 * any; with no stock behind the product there is no cost to know, so it is null (the
 * Wastage log shows a dash), never a made up zero.
 */
export function buildMenuWasteRow({ locationId, productName, qty, salePrice, ingredients, costById, reason, note, source = 'pos' }) {
  const n = Number(qty) || 1;
  const lines = usableIngredientLines(ingredients);
  const costs = costById || {};
  const costValue = lines.length
    ? round2(lines.reduce((s, l) => s + Number(l.qtyBase) * (Number(costs[l.inventoryItemId]) || 0), 0))
    : null;
  return {
    location_id: locationId, inventory_item_id: null, item_name: productName, qty: n, unit: 'item',
    qty_base: n, reason: reason || null, note: note || null,
    cost_value: costValue, sale_value: round2((Number(salePrice) || 0) * n), source,
  };
}

/**
 * 26 Sep 2026 (waste without stock review): supabase-js never throws on a failed read, it
 * resolves { data: null, error }, and the stock ctx builders coerce that to []. So an empty
 * ctx looked the same whether the venue has no stock or the network blipped. This hands
 * back the first read's error (null when every read succeeded) so buildCostingCtx and
 * buildDepletionCtx can carry it as ctx.error and the till never guesses "no stock here".
 * Lives here, not in recipes.js, so it runs under node --test without supabase.
 */
export const firstReadError = (results) =>
  ((Array.isArray(results) ? results : []).find(r => r && r.error) || {}).error || null;
