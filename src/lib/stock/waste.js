/**
 * stock/waste.js — log wastage and post it to the stock ledger.
 * Recording waste posts a WASTE movement (negative, valued at current cost) and
 * an audit row in waste_events. Idempotent per event id.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { convert } from './conversion.js';
import { postStockMovement } from './data.js';

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
      reason: r.reason, note: r.note, costValue: r.cost_value == null ? null : Number(r.cost_value), source: r.source, occurredAt: r.occurred_at,
    })),
    error,
  };
};

/** Log waste of an inventory item: writes waste_events + posts a WASTE movement. */
export const logWaste = async ({ inventoryItemId, qty, unit, reason, note, source = 'backoffice' }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  if (!(Number(qty) > 0)) return { data: null, error: new Error('Quantity must be > 0') };

  const [{ data: item }, { data: convs }] = await Promise.all([
    supabase.from('inventory_items').select('name, base_unit, current_cost').eq('location_id', locationId).eq('id', inventoryItemId).maybeSingle(),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId).eq('inventory_item_id', inventoryItemId),
  ]);
  if (!item) return { data: null, error: new Error('Item not found') };
  const bridges = (convs || []).map(c => ({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }));
  let qtyBase;
  try { qtyBase = convert(Number(qty), unit || item.base_unit, item.base_unit, { itemConversions: bridges }); }
  catch { return { data: null, error: new Error(`Can't convert ${unit} to ${item.base_unit} — add a unit bridge on the item`) }; }
  const costValue = qtyBase * (item.current_cost == null ? 0 : Number(item.current_cost));

  const { data: ev, error } = await supabase.from('waste_events').insert({
    location_id: locationId, inventory_item_id: inventoryItemId, item_name: item.name, qty: Number(qty), unit: unit || item.base_unit,
    qty_base: qtyBase, reason: reason || null, note: note || null, cost_value: costValue, source,
  }).select().maybeSingle();
  if (error || !ev) return { data: null, error: error || new Error('Could not log waste') };

  await postStockMovement({
    inventoryItemId, qtyBase: -qtyBase, unitCost: item.current_cost == null ? null : Number(item.current_cost),
    movementType: 'WASTE', sourceType: 'waste', sourceId: ev.id, idempotencyKey: `waste:${ev.id}`, notes: reason || 'waste',
  }, locationId);
  return { data: ev, error: null };
};
