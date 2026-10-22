/**
 * stock/waste.js — log wastage and post it to the stock ledger.
 * Recording waste posts a WASTE movement (negative, valued at current cost) and
 * an audit row in waste_events. Idempotent per event id.
 *
 * v5.11.84 (multi site stock Drop 0): both writers are the one database call (stock_record_waste)
 * only. The old browser paths never ran once 20261019b was in; a database without the call is told
 * it needs the update and nothing is written.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { isTrainingMode } from '../trainingMode';
import { toBase, unitLabel } from './uom.js';
import { usableIngredientLines } from './menuWaste.js';
import { isMissingFunctionError, newUuid } from './phase0Rules.js';
import { readAllPagesResult } from '../pagedRead.js';
import { NEEDS_UPDATE } from './saveRules.js';
import { liveOrAll } from './companyData.js';
import { WASTE_REASONS } from './wasteReasons.js';
import { pinAsk, END_OF_DAY_REASON } from './wasteReasons.js';

// v5.11.96 (Drop 3): the list moved to wasteReasons.js (pure, read by the company reasons hook); the same words.
export { WASTE_REASONS };

/**
 * v5.11.96 (multi site stock Drop 3, map J5): over the company's limit stock_record_waste answers
 * { ok: false, pin: 'needed' | 'wrong' | 'locked', error, limit } and writes nothing. That answer is
 * an error with the database's words plus `pin` and `limit`, never "Waste logged". The PIN rides in
 * the event (p_event.pin, never stored, decision 1). No limit is set anywhere live, so every company
 * gets today's answer.
 */
function pinRefusal(res) {
  const ask = pinAsk(res);
  return ask ? { data: res, error: new Error(ask.words), pin: ask.state, limit: ask.limit } : null;
}

async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

export const fetchWaste = async (fromIso, toIso, locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  // v5.11.79 (stock plan Phase 0, 1,000 row cap): every row of the period in pages of 1,000
  // (lib/pagedRead.js), newest first, ordered on a unique key. It asked for 500 in one request and
  // silently left the rest of the period out of the Wastage log.
  const { data, error } = await readAllPagesResult('waste', (first) => {
    let q = supabase.from('waste_events').select('*', first ? { count: 'exact' } : undefined).eq('location_id', locationId);
    if (fromIso) q = q.gte('occurred_at', fromIso);
    if (toIso) q = q.lte('occurred_at', toIso);
    return q.order('occurred_at', { ascending: false }).order('id');
  });
  return {
    data: (data || []).map(r => ({
      id: r.id, inventoryItemId: r.inventory_item_id, itemName: r.item_name, qty: Number(r.qty), unit: r.unit,
      reason: r.reason, note: r.note, costValue: r.cost_value == null ? null : Number(r.cost_value),
      saleValue: r.sale_value == null ? null : Number(r.sale_value), source: r.source, occurredAt: r.occurred_at,
      // v5.11.79 (20261019b): the product wasted and whether nothing came off stock (null before the migration)
      menuItemId: r.menu_item_id ?? null, noRecipe: r.no_recipe === true,
    })),
    error,
  };
};

/**
 * v5.11.79 (stock plan Phase 0, 11.5 item 8): what the till Waste screen needs up front, and no more:
 * which menu products have a recipe linked (one paged read of the links, never the recipe book)
 * and whether the venue runs stock at all (a head count of live stock items). Returns
 * { links: { [menuItemId]: true }, liveStockItems, error }. A failed read is an error, never
 * "no stock here".
 */
export const fetchWasteLinks = async (locationId = null) => {
  if (isMock || !supabase) return { links: {}, liveStockItems: 0, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { links: {}, liveStockItems: 0, error: new Error('No locationId') };
  const [linkRes, countRes] = await Promise.all([
    readAllPagesResult('recipe links', (first) => supabase.from('menu_item_recipes')
      .select('id, menu_item_id', first ? { count: 'exact' } : undefined).eq('location_id', locationId).order('id')),
    supabase.from('inventory_items').select('id', { count: 'exact', head: true }).eq('location_id', locationId).is('archived_at', null),
  ]);
  const error = linkRes.error || countRes.error || null;
  if (error) return { links: {}, liveStockItems: 0, error };
  const links = {};
  (linkRes.data || []).forEach((k) => { links[String(k.menu_item_id)] = true; });
  return { links, liveStockItems: Number(countRes.count) || 0, error: null };
};

/**
 * v5.11.79: the "Comes off stock" box for ONE product, worked out by the database (stock_record_waste
 * with preview true: nothing written). { data: { lines: [{ item_id, name, base_unit, qty_base, cost }],
 * cost_value, tag, linked }, error, missing } where missing = 20261019b is not run yet (the screen then
 * falls back to reading the recipe book itself, as before).
 */
export const previewMenuWaste = async ({ menuItemId, qty }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null, missing: true };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId'), missing: false };
  const { data, error } = await supabase.rpc('stock_record_waste', {
    p_location_id: locationId,
    p_event: { kind: 'menu', menu_item_id: String(menuItemId), qty: Number(qty) || 1, preview: true },
    p_lines: null,
  });
  if (error) return { data: null, error, missing: isMissingFunctionError(error) };
  return { data, error: null, missing: false };
};

/**
 * Log waste of a sellable MENU item (POS). Writes ONE summary waste_events row
 * (inventory_item_id null, item_name = the product, cost_value = total stock cost,
 * sale_value = forgone revenue) and posts a WASTE movement per recipe ingredient so
 * stock actually comes off. `ingredients` = [{ inventoryItemId, qtyBase }] from the
 * recipe explosion. Idempotent per (event, ingredient).
 *
 * 26 Sep 2026, Peter: "should be able to waste without stock". A product with no
 * recipe lines (no stock set up, or not linked yet) is recorded all the same: the
 * summary row keeps product, qty, reason, note and the lost sale; cost_value is null
 * and no movement posts because there is no stock to take it off. Venues with recipes
 * behave exactly as before.
 */
export const logMenuItemWaste = async ({ menuItemId = null, productName, qty, salePrice, ingredients, reason, note, source = 'pos', pin = null }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  // 26 Sep 2026: in Training Mode "NOTHING the device does is committed" (lib/trainingMode.js). Waste without
  // stock made this insert reachable at every venue with no stock, so a practice waste on a
  // training till would land in waste_events. No write; `training` lets the screen say so.
  if (isTrainingMode()) return { data: null, error: null, training: true };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // v5.11.79 (stock plan Phase 0, 4.7 and 11.5 item 8): ONE database call. The database explodes
  // this one product through its recipe (the same rule as central depletion), writes the waste row
  // with the product id and every WASTE movement together, and NEVER refuses: a product with no
  // recipe is recorded with the lost sale and tagged "No recipe: stock not taken off".
  const n = Number(qty) || 1;
  const event = {
    id: newUuid(), kind: 'menu', menu_item_id: menuItemId ? String(menuItemId) : null, item_name: productName,
    qty: n, unit: 'item', qty_base: n, reason: reason || null, note: note || null,
    sale_value: Math.round((Number(salePrice) || 0) * n * 100) / 100, source,
    ...(pin ? { pin: String(pin) } : {}),
  };
  const rpcLines = menuItemId ? null : usableIngredientLines(ingredients).map((l) => ({ item_id: l.inventoryItemId, qty_base: Number(l.qtyBase) }));
  const { data: res, error: rpcErr } = await supabase.rpc('stock_record_waste', { p_location_id: locationId, p_event: event, p_lines: rpcLines });
  if (!rpcErr) return pinRefusal(res) || { data: res && res.id ? { id: res.id } : res, error: null, tag: res?.tag || null, costValue: res?.cost_value ?? null };
  if (isMissingFunctionError(rpcErr)) return { data: null, error: new Error(`Waste not recorded. ${NEEDS_UPDATE}`) };
  return { data: null, error: rpcErr };
};

/** Log waste of an inventory item: writes waste_events + posts a WASTE movement. */
export const logWaste = async ({ inventoryItemId, qty, unit, reason, note, source = 'backoffice', pin = null }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  // 26 Sep 2026: same Training Mode gate as logMenuItemWaste (a waste row + a WASTE movement
  // are both commits). Back Office Wastage reads `training` for its toast.
  if (isTrainingMode()) return { data: null, error: null, training: true };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  if (!(Number(qty) > 0)) return { data: null, error: new Error('Quantity must be > 0') };

  // v5.11.84 (Drop 0): an archived unit bridge or pack is not offered (archived_at, before 0a: all)
  const live = (table, cols) => liveOrAll((on) => {
    const q = supabase.from(table).select(cols).eq('location_id', locationId).eq('inventory_item_id', inventoryItemId);
    return on ? q.is('archived_at', null) : q;
  });
  const [{ data: item }, { data: convs }, { data: packs }] = await Promise.all([
    supabase.from('inventory_items').select('name, base_unit, current_cost').eq('location_id', locationId).eq('id', inventoryItemId).maybeSingle(),
    live('inventory_item_conversions', '*'),
    live('item_packaging_formats', 'id, name, qty_in_base'),
  ]);
  if (!item) return { data: null, error: new Error('Item not found') };
  // shape an item ctx the uom resolver understands: friendly packs + unit bridges.
  const itemCtx = {
    baseUnit: item.base_unit,
    itemConversions: (convs || []).map(c => ({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit })),
    formats: (packs || []).map(p => ({ id: p.id, name: p.name, qtyInBase: Number(p.qty_in_base) })),
  };
  const token = unit || item.base_unit;
  let qtyBase;
  try { qtyBase = toBase(Number(qty), token, itemCtx); }
  catch { return { data: null, error: new Error(`Can't convert ${unitLabel(token, itemCtx)} to ${item.base_unit} — add a unit bridge on the item`) }; }

  // v5.11.79: the waste row and its WASTE movement in ONE database call (stock_record_waste,
  // 20261019b), so a refused movement can never leave a waste row with no stock taken off.
  const { data: res, error: rpcErr } = await supabase.rpc('stock_record_waste', {
    p_location_id: locationId,
    p_event: { id: newUuid(), kind: 'item', inventory_item_id: inventoryItemId, item_name: item.name, qty: Number(qty),
      unit: unitLabel(token, itemCtx), qty_base: qtyBase, reason: reason || null, note: note || null, source, ...(pin ? { pin: String(pin) } : {}) },
    p_lines: [{ item_id: inventoryItemId, qty_base: qtyBase }],
  });
  if (!rpcErr) return pinRefusal(res) || { data: res && res.id ? { id: res.id } : res, error: null };
  if (isMissingFunctionError(rpcErr)) return { data: null, error: new Error(`Waste not recorded. ${NEEDS_UPDATE}`) };
  return { data: null, error: rpcErr };
};

/**
 * v5.11.96 (Drop 3, J6): the end of day fresh close down. ONE stock_record_waste call books every
 * line typed as left (reason 'End of day'); the database asks for the PIN over the limit exactly
 * as for one waste. lines: [{ inventoryItemId, name, qtyBase, unit }] (qtyBase above 0 only).
 * Returns { data, error, pin, limit, count }.
 */
export const logCloseDownWaste = async ({ lines, note = null, pin = null }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null, count: 0 };
  if (isTrainingMode()) return { data: null, error: null, training: true, count: 0 };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId'), count: 0 };
  const rows = (lines || []).filter((l) => l && l.inventoryItemId && Number(l.qtyBase) > 0);
  if (!rows.length) return { data: null, error: new Error('Type what is left on at least one line.'), count: 0 };
  const { data: res, error: rpcErr } = await supabase.rpc('stock_record_waste', {
    p_location_id: locationId,
    p_event: { id: newUuid(), kind: 'closedown', item_name: 'End of day', qty: rows.length, unit: 'item', reason: END_OF_DAY_REASON,
      note: note || null, source: 'backoffice', ...(pin ? { pin: String(pin) } : {}) },
    p_lines: rows.map((l) => ({ item_id: l.inventoryItemId, qty_base: Number(l.qtyBase) })),
  });
  if (!rpcErr) return pinRefusal(res) || { data: res, error: null, count: rows.length };
  if (isMissingFunctionError(rpcErr)) return { data: null, error: new Error(`Waste not recorded. ${NEEDS_UPDATE}`), count: 0 };
  return { data: null, error: rpcErr, count: 0 };
};
