/**
 * stock/waste.js — log wastage and post it to the stock ledger.
 * Recording waste posts a WASTE movement (negative, valued at current cost) and
 * an audit row in waste_events. Idempotent per event id.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { isTrainingMode } from '../trainingMode';
import { toBase, unitLabel } from './uom.js';
import { postStockMovement } from './data.js';
import { buildMenuWasteRow, usableIngredientLines } from './menuWaste.js';

export const WASTE_REASONS = ['Spoilage', 'Out of date', 'Prep / trim', 'Over-production', 'Breakage / spill', 'Staff meal', 'Customer return', 'Training', 'Other'];

const nowIso = () => new Date().toISOString();
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

export const fetchWaste = async (fromIso, toIso, locationId = null, limit = 500) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('waste_events').select('*').eq('location_id', locationId);
  if (fromIso) q = q.gte('occurred_at', fromIso);
  if (toIso) q = q.lte('occurred_at', toIso);
  const { data, error } = await q.order('occurred_at', { ascending: false }).limit(limit);
  return {
    data: (data || []).map(r => ({
      id: r.id, inventoryItemId: r.inventory_item_id, itemName: r.item_name, qty: Number(r.qty), unit: r.unit,
      reason: r.reason, note: r.note, costValue: r.cost_value == null ? null : Number(r.cost_value),
      saleValue: r.sale_value == null ? null : Number(r.sale_value), source: r.source, occurredAt: r.occurred_at,
    })),
    error,
  };
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
export const logMenuItemWaste = async ({ productName, qty, salePrice, ingredients, reason, note, source = 'pos' }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  // 26 Sep 2026: in Training Mode "NOTHING the device does is committed" (lib/trainingMode.js). Waste without
  // stock made this insert reachable at every venue with no stock, so a practice waste on a
  // training till would land in waste_events. No write; `training` lets the screen say so.
  if (isTrainingMode()) return { data: null, error: null, training: true };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const lines = usableIngredientLines(ingredients);

  // Current (net) cost per ingredient → total stock cost of the waste (only when there are lines).
  const costById = {};
  if (lines.length) {
    const ids = [...new Set(lines.map(l => l.inventoryItemId))];
    const { data: rows } = await supabase.from('inventory_items').select('id, current_cost').eq('location_id', locationId).in('id', ids);
    (rows || []).forEach(r => { costById[r.id] = r.current_cost == null ? 0 : Number(r.current_cost); });
  }

  const row = buildMenuWasteRow({ locationId, productName, qty, salePrice, ingredients: lines, costById, reason, note, source });
  const { data: ev, error } = await supabase.from('waste_events').insert(row).select().maybeSingle();
  if (error || !ev) return { data: null, error: error || new Error('Could not log waste') };

  for (const l of lines) {
    await postStockMovement({
      inventoryItemId: l.inventoryItemId, qtyBase: -Number(l.qtyBase),
      unitCost: costById[l.inventoryItemId] == null ? null : costById[l.inventoryItemId],
      movementType: 'WASTE', sourceType: 'waste', sourceId: ev.id,
      idempotencyKey: `waste:${ev.id}:${l.inventoryItemId}`, notes: reason || 'waste',
    }, locationId);
  }
  return { data: ev, error: null };
};

/** Log waste of an inventory item: writes waste_events + posts a WASTE movement. */
export const logWaste = async ({ inventoryItemId, qty, unit, reason, note, source = 'backoffice' }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  // 26 Sep 2026: same Training Mode gate as logMenuItemWaste (a waste row + a WASTE movement
  // are both commits). Back Office Wastage reads `training` for its toast.
  if (isTrainingMode()) return { data: null, error: null, training: true };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  if (!(Number(qty) > 0)) return { data: null, error: new Error('Quantity must be > 0') };

  const [{ data: item }, { data: convs }, { data: packs }] = await Promise.all([
    supabase.from('inventory_items').select('name, base_unit, current_cost').eq('location_id', locationId).eq('id', inventoryItemId).maybeSingle(),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId).eq('inventory_item_id', inventoryItemId),
    supabase.from('item_packaging_formats').select('id, name, qty_in_base').eq('location_id', locationId).eq('inventory_item_id', inventoryItemId),
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
  const costValue = qtyBase * (item.current_cost == null ? 0 : Number(item.current_cost));

  const { data: ev, error } = await supabase.from('waste_events').insert({
    location_id: locationId, inventory_item_id: inventoryItemId, item_name: item.name, qty: Number(qty), unit: unitLabel(token, itemCtx),
    qty_base: qtyBase, reason: reason || null, note: note || null, cost_value: costValue, source,
  }).select().maybeSingle();
  if (error || !ev) return { data: null, error: error || new Error('Could not log waste') };

  await postStockMovement({
    inventoryItemId, qtyBase: -qtyBase, unitCost: item.current_cost == null ? null : Number(item.current_cost),
    movementType: 'WASTE', sourceType: 'waste', sourceId: ev.id, idempotencyKey: `waste:${ev.id}`, notes: reason || 'waste',
  }, locationId);
  return { data: ev, error: null };
};
