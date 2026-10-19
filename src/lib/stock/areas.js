/**
 * stock/areas.js: the data layer for stock areas (16 Oct 2026). Tables storage_areas,
 * inventory_item_areas, inventory_item_area_stock, stock_transfers, stock_transfer_lines
 * (supabase/migrations/20261016_OPS_stock_areas.sql). Rules in areaRules.js.
 *
 * House pattern (data.js): every function resolves a real locationId (never loc-demo), maps
 * camelCase to snake_case explicitly, asks every write for its rows back and treats nothing
 * coming back as the failure it is, and reads in pages of 1,000 (lib/pagedRead.js) because
 * PostgREST answers 1,000 rows at most whatever .limit() asks for.
 *
 * FEATURE DETECTION. Peter runs the migration by hand; until then nothing here may change what
 * works today. areasReady(locationId) probes `select id from storage_areas limit 1` once a
 * session: a missing relation (42P01 / PGRST205) means "not ready" and every screen keeps its old
 * shape. data.js reads areasReadySync() before it sends p_area_id to post_stock_movement, because
 * an unknown argument name against the 11 argument function fails with PGRST202 and the movement
 * would be lost.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { readAllPagesResult } from '../pagedRead.js';
import { transferReference, USUAL_SIX, normaliseAreaName } from './areaRules.js';
import { displayInUnits } from './uom.js';

const nowIso = () => new Date().toISOString();

async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

const zeroRows = (what, data) => (!data || data.length === 0)
  ? new Error(`${what} matched 0 rows: RLS blocked it or the row no longer exists`)
  : null;
const noRow = (what, row) => row ? null : new Error(`${what} returned no row: RLS blocked it or it matched nothing`);
/** "24 Bottle" for a base quantity of a fetchInventoryItems item (its count pack, else its base unit); the bare figure when no item is known. */
const qtyWords = (qtyBase, item) => {
  if (!item) return String(qtyBase);
  const d = displayInUnits(qtyBase, { baseUnit: item.baseUnit, formats: item.packaging || item.formats || [], itemConversions: item.conversions || [] });
  return `${d.qty} ${d.label}`.trim();
};

// ── Feature detection ─────────────────────────────────────────────────────────
/** True when the error says the table is not there yet (42P01, PGRST205, or the wording). */
export function isMissingRelationError(error) {
  if (!error) return false;
  const msg = `${error.code || ''} ${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  if (/PGRST205|42P01/.test(msg)) return true;
  return /relation .* does not exist|could not find the table/i.test(msg);
}

let _ready = null;      // null = not probed, true, false
let _readyAt = 0;
let _probe = null;
/** The cached answer, or null when the probe has not run. For the write path (no await). */
export function areasReadySync() { return _ready; }
/** Forget the answer (after Peter runs the migration, the next screen load probes again). */
export function resetAreasReady() { _ready = null; _readyAt = 0; _probe = null; }

/**
 * Has the 16 Oct migration run on this database? One probe a session; "not ready" is kept for
 * 60 seconds so a screen that opens before the migration finds the tables on its next load.
 */
export async function areasReady(locationId = null) {
  if (isMock || !supabase) return false;
  if (_ready === true) return true;
  if (_ready === false && Date.now() - _readyAt < 60000) return false;
  if (_probe) return _probe;
  _probe = (async () => {
    const loc = await ensureLoc(locationId);
    let q = supabase.from('storage_areas').select('id').limit(1);
    if (loc) q = q.eq('location_id', loc);
    const { error } = await q;
    _readyAt = Date.now();
    if (error) { _ready = isMissingRelationError(error) ? false : null; return false; }
    _ready = true;
    return true;
  })();
  try { return await _probe; } finally { _probe = null; }
}

// ── Mappers ───────────────────────────────────────────────────────────────────
const areaFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, kind: r.kind || 'other', sortOrder: Number(r.sort_order) || 0,
  isReceiving: r.is_receiving === true, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const transferFromRow = (r) => ({
  id: r.id, locationId: r.location_id, toLocationId: r.to_location_id, fromAreaId: r.from_area_id, toAreaId: r.to_area_id,
  status: r.status, reference: r.reference, note: r.note, createdByName: r.created_by_name,
  sentByName: r.sent_by_name, sentAt: r.sent_at, receivedByName: r.received_by_name, receivedAt: r.received_at,
  cancelledByName: r.cancelled_by_name || null, cancelledAt: r.cancelled_at || null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const transferLineFromRow = (r) => ({
  id: r.id, transferId: r.transfer_id, locationId: r.location_id, toLocationId: r.to_location_id,
  inventoryItemId: r.inventory_item_id, toInventoryItemId: r.to_inventory_item_id,
  nameSnapshot: r.name_snapshot, skuSnapshot: r.sku_snapshot, baseUnit: r.base_unit,
  qtyBase: Number(r.qty_base) || 0, unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
  qtyReceivedBase: r.qty_received_base == null ? null : Number(r.qty_received_base),
  dropped: r.dropped === true, sortOrder: Number(r.sort_order) || 0,
  // v5.11.79 (20261019a): the receiving item's unit at the receive, and what did not arrive (in the
  // SENDER's unit), booked at the sender as Short on transfer. Null before the migration.
  toBaseUnit: r.to_base_unit || null, shortQtyBase: r.short_qty_base == null ? null : Number(r.short_qty_base),
  toUnitCost: r.to_unit_cost == null ? null : Number(r.to_unit_cost),
});

// ── Areas ─────────────────────────────────────────────────────────────────────
/** The venue's areas in sort order (live only unless includeArchived). */
export const fetchAreas = async (locationId = null, { includeArchived = false } = {}) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('storage_areas').select('*').eq('location_id', locationId).order('sort_order').order('name');
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  if (error) return { data: [], error, notReady: isMissingRelationError(error) };
  return { data: (data || []).map(areaFromRow), error: null };
};

/** Add or rename an area (name, kind, sortOrder). */
export const saveArea = async (area, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const name = String(area?.name || '').trim();
  if (!name) return { data: null, error: new Error('Give the area a name') };
  const row = {
    ...(area.id ? { id: area.id } : {}),
    location_id: locationId, name, kind: area.kind || 'other',
    sort_order: area.sortOrder == null ? 0 : Number(area.sortOrder), updated_at: nowIso(),
  };
  const { data, error } = await supabase.from('storage_areas').upsert(row).select().maybeSingle();
  if (error && /storage_areas_name_uniq|duplicate key/i.test(error.message || '')) {
    return { data: null, error: new Error(`There is already an area called ${name}`) };
  }
  return { data: data ? areaFromRow(data) : null, error: error || noRow('Area save', data) };
};

/** The usual six for a venue with none. Returns how many were added. */
export const addUsualSix = async (locationId = null) => {
  if (isMock || !supabase) return { data: 0, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: 0, error: new Error('No locationId') };
  const { data: existing, error: readErr } = await fetchAreas(locationId);
  if (readErr) return { data: 0, error: readErr };
  // the same spelling rule as the migration's backfill: a backfilled "Walk-in fridge" is the usual "Walk in fridge"
  const have = new Set((existing || []).map((a) => normaliseAreaName(a.name)));
  const rows = USUAL_SIX.filter((s) => !have.has(normaliseAreaName(s.name)))
    .map((s, i) => ({ location_id: locationId, name: s.name, kind: s.kind, sort_order: ((existing || []).length + i + 1) * 10 }));
  if (!rows.length) return { data: 0, error: null };
  const { data, error } = await supabase.from('storage_areas').insert(rows).select('id');
  return { data: (data || []).length, error: error || zeroRows('Add the usual six', data) };
};

/** Items assigned to an area and holdings in it (for the archive refusal and the list). */
export const areaUsage = async (areaId, locationId = null) => {
  if (isMock || !supabase) return { data: { items: 0, holdings: 0 }, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: { items: 0, holdings: 0 }, error: new Error('No locationId') };
  const [{ count: items, error: e1 }, { data: hold, error: e2 }] = await Promise.all([
    supabase.from('inventory_item_areas').select('id', { count: 'exact', head: true }).eq('location_id', locationId).eq('area_id', areaId),
    supabase.from('inventory_item_area_stock').select('inventory_item_id, on_hand').eq('location_id', locationId).eq('area_id', areaId).neq('on_hand', 0).limit(1000),
  ]);
  if (e1 || e2) return { data: { items: 0, holdings: 0 }, error: e1 || e2 };
  return { data: { items: Number(items) || 0, holdings: (hold || []).length }, error: null };
};

/** Archive an area. Refused while it has items assigned or a non zero holding (the rule is in the screen's words). */
export const archiveArea = async (areaId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data: usage, error: uErr } = await areaUsage(areaId, locationId);
  if (uErr) return { data: null, error: uErr };
  if (usage.items > 0 || usage.holdings > 0) {
    const e = new Error('The area still holds stock or items');
    e.usage = usage;
    return { data: null, error: e };
  }
  const { data, error } = await supabase.from('storage_areas')
    .update({ archived_at: nowIso(), is_receiving: false, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', areaId).select('id');
  return { data, error: error || zeroRows('Archive area', data) };
};

/**
 * Set (or clear, with null) the receiving area. Clear first, set second, read back: one
 * receiving area at most, and the database refuses two (storage_areas_receiving_uniq).
 */
export const setReceivingArea = async (areaId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  let clear = supabase.from('storage_areas').update({ is_receiving: false, updated_at: nowIso() }).eq('location_id', locationId).eq('is_receiving', true);
  if (areaId) clear = clear.neq('id', areaId);
  const { error: clearErr } = await clear.select('id');
  if (clearErr) return { error: clearErr };
  if (!areaId) return { error: null };
  const { data, error } = await supabase.from('storage_areas').update({ is_receiving: true, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', areaId).is('archived_at', null).select('id');
  return { error: error || zeroRows('Set receiving area', data) };
};

/** Save a new order: ids in the order shown become sort_order 10, 20, 30 ... Every write checked. */
export const reorderAreas = async (orderedIds, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  let i = 0;
  for (const id of orderedIds || []) {
    i += 1;
    const { data, error } = await supabase.from('storage_areas').update({ sort_order: i * 10, updated_at: nowIso() })
      .eq('location_id', locationId).eq('id', id).select('id');
    const err = error || zeroRows('Reorder areas', data);
    if (err) return { error: err };
  }
  return { error: null };
};

// ── Items in areas ────────────────────────────────────────────────────────────
/** { itemId: areaId } for every item with a use area at the venue (paged). */
export const fetchItemAreas = async (locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  const { data, error } = await readAllPagesResult('item areas', (first) => supabase.from('inventory_item_areas')
    .select('id, inventory_item_id, area_id, is_primary', first ? { count: 'exact' } : undefined)
    .eq('location_id', locationId).eq('is_primary', true).order('inventory_item_id').order('id'));
  if (error) return { data: {}, error, notReady: isMissingRelationError(error.cause || error) };
  const map = {};
  (data || []).forEach((r) => { map[r.inventory_item_id] = r.area_id; });
  return { data: map, error: null };
};

/** { itemId: { areaId: qty } } for the venue (paged). Rows at exactly zero are kept out. */
export const fetchAreaHoldings = async (locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  const { data, error } = await readAllPagesResult('area holdings', (first) => supabase.from('inventory_item_area_stock')
    .select('inventory_item_id, area_id, on_hand', first ? { count: 'exact' } : undefined)
    .eq('location_id', locationId).order('inventory_item_id').order('area_id'));
  if (error) return { data: {}, error, notReady: isMissingRelationError(error.cause || error) };
  const map = {};
  (data || []).forEach((r) => {
    const q = Number(r.on_hand) || 0;
    if (q === 0) return;
    (map[r.inventory_item_id] ??= {})[r.area_id] = q;
  });
  return { data: map, error: null };
};

/** One item's holdings { areaId: qty }, zero rows included (the item's Stock tab). */
export const fetchItemAreaHoldings = async (inventoryItemId, locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  const { data, error } = await supabase.from('inventory_item_area_stock').select('area_id, on_hand')
    .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId).limit(1000);
  if (error) return { data: {}, error };
  const map = {};
  (data || []).forEach((r) => { map[r.area_id] = Number(r.on_hand) || 0; });
  return { data: map, error: null };
};

/**
 * Move one item's holding between two areas of the venue as a within venue transfer (one
 * row, one line, post_stock_transfer_leg 'both'): the ledger shows TRANSFER_OUT and TRANSFER_IN
 * with the reference. Used when an item's use area changes and the old area still holds stock,
 * by the approval's "It was moved from Cellar", and by builder B's Move stock form.
 */
export const moveHoldingBetweenAreas = async ({ inventoryItemId, fromAreaId, toAreaId, qtyBase, note = null, byName = null, item = null }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const qty = Number(qtyBase);
  if (!(qty > 0)) return { data: null, error: new Error('Nothing to move') };
  if (!fromAreaId || !toAreaId || fromAreaId === toAreaId) return { data: null, error: new Error('Pick two different areas') };
  const reference = transferReference();
  const { data: head, error: headErr } = await supabase.from('stock_transfers').insert({
    location_id: locationId, to_location_id: null, from_area_id: fromAreaId, to_area_id: toAreaId,
    status: 'DRAFT', reference, note: note || null, created_by_name: byName || null,
  }).select().maybeSingle();
  const hErr = headErr || noRow('Transfer save', head);
  if (hErr) return { data: null, error: hErr };
  const { data: line, error: lineErr } = await supabase.from('stock_transfer_lines').insert({
    transfer_id: head.id, location_id: locationId, to_location_id: null, inventory_item_id: inventoryItemId,
    name_snapshot: item?.name || null, sku_snapshot: item?.sku || null, base_unit: item?.baseUnit || null,
    qty_base: qty, sort_order: 0,
  }).select('id').maybeSingle();
  const lErr = lineErr || noRow('Transfer line save', line);
  if (lErr) return { data: null, error: lErr };
  const { data: res, error: rpcErr } = await supabase.rpc('post_stock_transfer_leg', { p_transfer_id: head.id, p_leg: 'both', p_by_name: byName || null });
  if (rpcErr) return { data: null, error: rpcErr };
  if (res && res.ok === false) return { data: null, error: new Error(res.error || 'The transfer was refused') };
  return { data: { transferId: head.id, reference, ...(res || {}) }, error: null };
};

/**
 * Set an item's use area (null = No area). When the OLD area still holds a non zero quantity
 * and `moveHolding` is on, the holding goes with it as a within venue transfer in the same
 * action (16 Oct review, finding 2: otherwise new sales deplete the new area to below zero and
 * the old area keeps the figure for ever). Stock the item holds in NO area (movements posted
 * before it had one) goes to the new area inside the database: the inventory_item_areas trigger
 * re homes those movements and rebuilds the cache row as the area row is written, so nothing
 * here has to post it and the next count cannot find it twice. Returns { data: { movedQty }, error }.
 */
export const assignItemArea = async (inventoryItemId, areaId, { moveHolding = true, byName = null, item = null } = {}, locationId = null) => {
  if (isMock || !supabase) return { data: { movedQty: 0 }, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data: cur, error: curErr } = await supabase.from('inventory_item_areas').select('id, area_id')
    .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId).eq('is_primary', true).maybeSingle();
  if (curErr) return { data: null, error: curErr };
  const oldArea = cur?.area_id || null;
  if ((oldArea || null) === (areaId || null)) return { data: { movedQty: 0, unchanged: true }, error: null };
  if (!areaId) {
    const { data, error } = await supabase.from('inventory_item_areas').delete()
      .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId).eq('is_primary', true).select('id');
    return { data: { movedQty: 0 }, error: error || zeroRows('Clear item area', data) };
  }
  if (cur) {
    const { data, error } = await supabase.from('inventory_item_areas').update({ area_id: areaId })
      .eq('location_id', locationId).eq('id', cur.id).select('id');
    const err = error || zeroRows('Item area change', data);
    if (err) return { data: null, error: err };
  } else {
    const { data, error } = await supabase.from('inventory_item_areas')
      .insert({ location_id: locationId, inventory_item_id: inventoryItemId, area_id: areaId, is_primary: true }).select('id');
    const err = error || zeroRows('Item area save', data);
    if (err) return { data: null, error: err };
  }
  let movedQty = 0;
  if (moveHolding && oldArea) {
    const { data: hold } = await supabase.from('inventory_item_area_stock').select('on_hand')
      .eq('location_id', locationId).eq('inventory_item_id', inventoryItemId).eq('area_id', oldArea).maybeSingle();
    const qty = Number(hold?.on_hand) || 0;
    if (qty > 0) {
      const mv = await moveHoldingBetweenAreas({ inventoryItemId, fromAreaId: oldArea, toAreaId: areaId, qtyBase: qty, note: 'Area changed', byName, item }, locationId);
      if (mv.error) return { data: { movedQty: 0, areaSaved: true }, error: new Error(`Area changed, but its ${qtyWords(qty, item)} could not be moved: ${mv.error.message || mv.error}`) };
      movedQty = qty;
    }
  }
  return { data: { movedQty }, error: null };
};

/**
 * Bulk assign: one assignItemArea per item, every result checked.
 * Returns { data: { moved, holdings, failed, failures: [{ itemId, message }] }, error: null }.
 */
export const bulkAssignItemArea = async (itemIds, areaId, opts = {}, locationId = null) => {
  const out = { moved: 0, holdings: 0, failed: 0, failures: [] };
  if (isMock || !supabase) return { data: out, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: out, error: new Error('No locationId') };
  const itemsById = opts.itemsById || {};
  for (const id of itemIds || []) {
    const { data, error } = await assignItemArea(id, areaId, { ...opts, item: itemsById[id] || null }, locationId);
    if (error) { out.failed += 1; out.failures.push({ itemId: id, message: error.message || String(error) }); continue; }
    out.moved += 1;
    if (data?.movedQty > 0) out.holdings += 1;
  }
  return { data: out, error: null };
};

/** The venue's receiving area id (null when none is flagged, or before the migration). */
export const fetchReceivingArea = async (locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: null };
  const ok = await areasReady(locationId);
  if (!ok) return { data: null, error: null };
  const { data, error } = await supabase.from('storage_areas').select('id')
    .eq('location_id', locationId).eq('is_receiving', true).is('archived_at', null).limit(1).maybeSingle();
  if (error) return { data: null, error };
  return { data: data?.id || null, error: null };
};

// ── Transfers (reads; the send and receive paths are in transfers.js) ──────────
/** Transfers where this venue is either end, newest first. */
export const fetchTransfers = async (locationId = null, limit = 100) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('stock_transfers').select('*')
    .or(`location_id.eq.${locationId},to_location_id.eq.${locationId}`)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) return { data: [], error, notReady: isMissingRelationError(error) };
  return { data: (data || []).map(transferFromRow), error: null };
};

/** One transfer with its lines (paged). */
export const fetchTransfer = async (transferId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: null };
  const [{ data: head, error: hErr }, lines] = await Promise.all([
    supabase.from('stock_transfers').select('*').eq('id', transferId).maybeSingle(),
    readAllPagesResult('transfer lines', (first) => supabase.from('stock_transfer_lines')
      .select('*', first ? { count: 'exact' } : undefined).eq('transfer_id', transferId).order('sort_order').order('id')),
  ]);
  if (hErr) return { data: null, error: hErr };
  if (!head) return { data: null, error: null };
  if (lines.error) return { data: null, error: lines.error };
  return { data: { ...transferFromRow(head), lines: (lines.data || []).map(transferLineFromRow) }, error: null };
};
