/**
 * stock/counts.js — par levels + stock-count sessions.
 *
 * A count snapshots each item's on-hand at start (expected_qty). On APPROVAL it
 * posts STOCK_COUNT_ADJ movements (delta = counted − current on-hand) via
 * post_stock_movement (idempotent per count+item), so on-hand reconciles to the
 * physical count and the correction feeds "the gap". House pattern throughout.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { postStockMovement } from './data.js';

const nowIso = () => new Date().toISOString();
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

// ── par levels ────────────────────────────────────────────────────────────────
export const fetchParLevels = async (locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  const { data, error } = await supabase.from('par_levels').select('*').eq('location_id', locationId);
  const map = {};
  (data || []).forEach(r => { map[r.inventory_item_id] = { parLevel: r.par_level == null ? null : Number(r.par_level), reorderPoint: r.reorder_point == null ? null : Number(r.reorder_point), minLevel: r.min_level == null ? null : Number(r.min_level) }; });
  return { data: map, error };
};

export const upsertParLevel = async (inventoryItemId, par, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return supabase.from('par_levels').upsert({
    location_id: locationId, inventory_item_id: inventoryItemId,
    par_level: num(par.parLevel), reorder_point: num(par.reorderPoint), min_level: num(par.minLevel), updated_at: nowIso(),
  }, { onConflict: 'location_id,inventory_item_id' });
};

// ── counts ──────────────────────────────────────────────────────────────────
const countFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, countType: r.count_type, status: r.status,
  storageArea: r.storage_area, startedAt: r.started_at, submittedAt: r.submitted_at, approvedAt: r.approved_at,
  varianceValue: r.variance_value == null ? null : Number(r.variance_value), createdAt: r.created_at,
});
const lineFromRow = (r) => ({
  id: r.id, countId: r.count_id, inventoryItemId: r.inventory_item_id,
  countedQty: r.counted_qty == null ? null : Number(r.counted_qty), expectedQty: r.expected_qty == null ? 0 : Number(r.expected_qty),
  varianceQty: r.variance_qty == null ? null : Number(r.variance_qty), unitCost: r.unit_cost == null ? null : Number(r.unit_cost), sortOrder: r.sort_order,
});

export const fetchCounts = async (locationId = null, limit = 60) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('stock_counts').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit);
  return { data: (data || []).map(countFromRow), error };
};

export const fetchCount = async (countId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: null };
  const [{ data: c }, { data: lines }] = await Promise.all([
    supabase.from('stock_counts').select('*').eq('location_id', locationId).eq('id', countId).maybeSingle(),
    supabase.from('stock_count_lines').select('*').eq('location_id', locationId).eq('count_id', countId).order('sort_order'),
  ]);
  if (!c) return { data: null, error: null };
  return { data: { ...countFromRow(c), lines: (lines || []).map(lineFromRow) }, error: null };
};

/** Start a count over the given inventory items (snapshots expected on-hand + cost). */
export const createCount = async ({ name, countType = 'FULL', storageArea, itemIds }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  let ids = itemIds;
  let itemsById = {};
  const { data: items } = await supabase.from('inventory_items').select('id, name, on_hand, current_cost').eq('location_id', locationId).is('archived_at', null);
  (items || []).forEach(i => { itemsById[i.id] = i; });
  if (!ids || !ids.length) ids = (items || []).map(i => i.id);
  const { data: c, error } = await supabase.from('stock_counts').insert({
    location_id: locationId, name: name || `Count ${new Date().toLocaleDateString()}`, count_type: countType, status: 'DRAFT', storage_area: storageArea || null,
  }).select().maybeSingle();
  if (error || !c) return { data: null, error: error || new Error('Could not start count') };
  const lines = ids.map((id, i) => ({
    location_id: locationId, count_id: c.id, inventory_item_id: id,
    expected_qty: Number(itemsById[id]?.on_hand) || 0, unit_cost: itemsById[id]?.current_cost == null ? null : Number(itemsById[id].current_cost), sort_order: i,
  }));
  if (lines.length) await supabase.from('stock_count_lines').insert(lines);
  return { data: countFromRow(c), error: null };
};

export const saveCountLine = async (lineId, countedQty, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  return supabase.from('stock_count_lines').update({ counted_qty: countedQty === '' || countedQty == null ? null : Number(countedQty) })
    .eq('location_id', locationId).eq('id', lineId);
};

export const setCountStatus = async (countId, status, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const patch = { status, updated_at: nowIso() };
  if (status === 'SUBMITTED') patch.submitted_at = nowIso();
  return supabase.from('stock_counts').update(patch).eq('location_id', locationId).eq('id', countId);
};

/**
 * Approve a count: for every counted line, post a STOCK_COUNT_ADJ that moves on-hand
 * to the counted figure (delta = counted − current on-hand), idempotent per
 * count+item, and record the variance. Marks the count APPROVED.
 */
export const approveCount = async (countId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const { data: lines } = await supabase.from('stock_count_lines').select('*').eq('location_id', locationId).eq('count_id', countId);
  if (!lines?.length) return { error: new Error('No lines') };
  const ids = lines.map(l => l.inventory_item_id);
  const { data: items } = await supabase.from('inventory_items').select('id, on_hand, current_cost').eq('location_id', locationId).in('id', ids);
  const onHand = {}; const cost = {};
  (items || []).forEach(i => { onHand[i.id] = Number(i.on_hand) || 0; cost[i.id] = i.current_cost == null ? 0 : Number(i.current_cost); });
  let varianceValue = 0;
  for (const l of lines) {
    if (l.counted_qty == null) continue;
    const counted = Number(l.counted_qty);
    const cur = onHand[l.inventory_item_id] || 0;
    const delta = counted - cur;
    const varQty = counted - (Number(l.expected_qty) || 0);
    varianceValue += varQty * (cost[l.inventory_item_id] || 0);
    if (delta !== 0) {
      await postStockMovement({
        inventoryItemId: l.inventory_item_id, qtyBase: delta, movementType: 'STOCK_COUNT_ADJ',
        sourceType: 'stock_count', sourceId: countId, idempotencyKey: `count:${countId}:${l.inventory_item_id}`,
        notes: 'Stock count',
      }, locationId);
    }
    await supabase.from('stock_count_lines').update({ variance_qty: varQty }).eq('location_id', locationId).eq('id', l.id);
  }
  await supabase.from('stock_counts').update({ status: 'APPROVED', approved_at: nowIso(), variance_value: varianceValue, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', countId);
  return { error: null };
};
