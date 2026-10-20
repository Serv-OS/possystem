/**
 * stock/counts.js: par levels + stock count sessions.
 *
 * A count snapshots each line's expected quantity at start (expected_qty). On APPROVAL it
 * posts STOCK_COUNT_ADJ movements (delta = counted minus what the system held when the line was
 * counted, v5.11.79) through ONE database call (approve_stock_count), so stock reconciles to the
 * physical count and the correction feeds "the gap". A first count is Opening stock. House pattern.
 *
 * 16 Oct 2026 (stock areas): a count is Full, By area, By supplier or Spot check; a line is one
 * (item, area); each area on the sheet is marked complete by its counter (stock_count_areas);
 * approval compares each line with THAT AREA's holding. Until Peter runs the migration
 * (areasReady false) everything here keeps its 15 Oct shape: one Full count, lines with no area,
 * adjustments against the item's on hand, the old idempotency keys.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { resolveCountScope, chunkArray, INSERT_CHUNK, countNameFor } from './areaRules.js';
import { areasReady, fetchAreas, fetchItemAreas, fetchAreaHoldings } from './areas.js';
import { countName } from '../venueDate.js';
import { getLocationConfig } from '../locationTime';
import { readAllPagesResult } from '../pagedRead.js';
import { approvalOutcome, isMissingFunctionError } from './phase0Rules.js';
import { parPatch, NEEDS_UPDATE, SECTIONS } from './saveRules.js';
import { saveOrDirect, liveOrAll } from './companyData.js';

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

// ── par levels ────────────────────────────────────────────────────────────────
export const fetchParLevels = async (locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  // v5.11.67: in pages of 1,000; one request is capped at 1,000 rows by PostgREST, so the par of
  // every item past the thousandth read as "no par" on the Order pad and the Orders screen.
  const { data, error } = await readAllPagesResult('par levels', (first) => supabase.from('par_levels')
    .select('*', first ? { count: 'exact' } : undefined).eq('location_id', locationId).order('id'));
  const map = {};
  (data || []).forEach(r => { map[r.inventory_item_id] = { parLevel: r.par_level == null ? null : Number(r.par_level), reorderPoint: r.reorder_point == null ? null : Number(r.reorder_point), minLevel: r.min_level == null ? null : Number(r.min_level) }; });
  return { data: map, error };
};

/**
 * Save an item's par, reorder point and minimum. v5.11.82 (multi site stock Drop 0): one save
 * function (stock_save_item_site) that writes all three together and keeps a figure the screen did
 * not send (the old upsert wrote min_level null every time the Stock tab saved par and reorder).
 * Before the database has it: today's upsert.
 */
export const upsertParLevel = async (inventoryItemId, par, locationId = null, opts = {}) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const r = await saveOrDirect(supabase, 'stock_save_item_site', {
    p_item: inventoryItemId, p_location: locationId, p_patch: parPatch(par), p_version: null,
    p_section: opts.section || SECTIONS.inventory,
  }, () => {
    const num = (v) => (v === '' || v == null ? null : Number(v));
    return supabase.from('par_levels').upsert({
      location_id: locationId, inventory_item_id: inventoryItemId,
      par_level: num(par.parLevel), reorder_point: num(par.reorderPoint), min_level: num(par.minLevel), updated_at: nowIso(),
    }, { onConflict: 'location_id,inventory_item_id' });
  });
  return { data: r.data ?? null, error: r.error || null };
};

// ── counts ──────────────────────────────────────────────────────────────────
const countFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, countType: r.count_type, status: r.status,
  storageArea: r.storage_area, startedAt: r.started_at, submittedAt: r.submitted_at, approvedAt: r.approved_at,
  varianceValue: r.variance_value == null ? null : Number(r.variance_value), createdAt: r.created_at,
  supplierId: r.supplier_id || null, approvalNote: r.approval_note || null,
  startedByName: r.started_by_name || null, approvedByName: r.approved_by_name || null,
  areas: [],
});
const lineFromRow = (r) => ({
  id: r.id, countId: r.count_id, inventoryItemId: r.inventory_item_id, areaId: r.area_id || null,
  countedQty: r.counted_qty == null ? null : Number(r.counted_qty), expectedQty: r.expected_qty == null ? 0 : Number(r.expected_qty),
  varianceQty: r.variance_qty == null ? null : Number(r.variance_qty), unitCost: r.unit_cost == null ? null : Number(r.unit_cost), sortOrder: r.sort_order,
});
const areaRowFromRow = (r, areasById = {}) => ({
  id: r.id, countId: r.count_id, areaId: r.area_id, name: areasById[r.area_id]?.name || 'Area',
  status: r.status === 'complete' ? 'complete' : 'open', completedByName: r.completed_by_name || null, completedAt: r.completed_at || null,
});

/** The per area rows of these counts: { countId: [rows] }. Nothing when the migration has not run. */
async function fetchCountAreaRows(countIds, locationId) {
  if (!countIds.length || !(await areasReady(locationId))) return { data: {}, error: null };
  const [{ data: rows, error }, { data: areas }] = await Promise.all([
    supabase.from('stock_count_areas').select('*').eq('location_id', locationId).in('count_id', countIds).limit(1000),
    fetchAreas(locationId, { includeArchived: true }),
  ]);
  if (error) return { data: {}, error };
  const areasById = {};
  (areas || []).forEach((a) => { areasById[a.id] = a; });
  const out = {};
  (rows || []).forEach((r) => { (out[r.count_id] ??= []).push(areaRowFromRow(r, areasById)); });
  for (const list of Object.values(out)) list.sort((a, b) => (areasById[a.areaId]?.sortOrder ?? 0) - (areasById[b.areaId]?.sortOrder ?? 0));
  return { data: out, error: null };
}

export const fetchCounts = async (locationId = null, limit = 60) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('stock_counts').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit);
  const counts = (data || []).map(countFromRow);
  const { data: areaRows } = await fetchCountAreaRows(counts.map((c) => c.id), locationId);
  counts.forEach((c) => { c.areas = areaRows[c.id] || []; });
  return { data: counts, error };
};

/** One count with its lines (paged: a Full count at a 1,000 item venue is well over 1,000 lines) and its area rows. */
export const fetchCount = async (countId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: null };
  const [{ data: c, error: cErr }, lines, areaRows] = await Promise.all([
    supabase.from('stock_counts').select('*').eq('location_id', locationId).eq('id', countId).maybeSingle(),
    readAllPagesResult('count lines', (first) => supabase.from('stock_count_lines')
      .select('*', first ? { count: 'exact' } : undefined).eq('location_id', locationId).eq('count_id', countId).order('sort_order').order('id')),
    fetchCountAreaRows([countId], locationId),
  ]);
  if (cErr) return { data: null, error: cErr };
  if (!c) return { data: null, error: null };
  if (lines.error) return { data: null, error: lines.error };
  return { data: { ...countFromRow(c), lines: (lines.data || []).map(lineFromRow), areas: areaRows.data?.[countId] || [] }, error: null };
};

/**
 * Start a count. scope: { type: FULL | AREA | SUPPLIER | SPOT | PARTIAL, areaIds, supplierId,
 * itemIds }. `items` (from fetchInventoryItems) may be handed in to save a read. Snapshots each
 * line's expected quantity (the area's holding, or the item's on hand for a line with no area)
 * and cost; inserts lines 200 a request with every insert checked; writes one stock_count_areas
 * row per area on the sheet. Before the migration: the 15 Oct behaviour, one line per item.
 */
export const createCount = async ({ name, countType = 'FULL', storageArea, itemIds, areaIds, supplierId, startedByName, items: givenItems, tz: givenTz }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const ready = await areasReady(locationId);
  const type = String(countType || 'FULL').toUpperCase();
  // v5.11.65: a count with no name is dated on the VENUE's clock (a US venue after 17:00 local was
  // being named with London's tomorrow)
  const tz = givenTz !== undefined ? givenTz : (name ? null : ((await getLocationConfig(locationId).catch(() => null))?.timezone || null));

  if (!ready || (type !== 'AREA' && type !== 'SUPPLIER' && type !== 'SPOT' && type !== 'FULL')) {
    // ── the 15 Oct shape ──
    let ids = itemIds;
    const itemsById = {};
    // v5.11.79: in pages of 1,000 (a venue past 1,000 items lost the tail of its count sheet)
    const { data: items, error: itemsErr } = await readAllPagesResult('stock items', (first) => supabase.from('inventory_items')
      .select('id, name, on_hand, current_cost', first ? { count: 'exact' } : undefined).eq('location_id', locationId).is('archived_at', null).order('name').order('id'));
    if (itemsErr) return { data: null, error: itemsErr };
    (items || []).forEach(i => { itemsById[i.id] = i; });
    if (!ids || !ids.length) ids = (items || []).map(i => i.id);
    const legacyType = ready ? type : (type === 'AREA' || type === 'SUPPLIER' ? 'FULL' : type);
    const { data: c, error } = await supabase.from('stock_counts').insert({
      location_id: locationId, name: name || countName(new Date(), tz, legacyType, storageArea), count_type: legacyType, status: 'DRAFT', storage_area: storageArea || null,
      ...(ready ? { started_by_name: startedByName || null } : {}),
    }).select().maybeSingle();
    if (error || !c) return { data: null, error: error || new Error('Could not start count') };
    const lines = ids.map((id, i) => ({
      location_id: locationId, count_id: c.id, inventory_item_id: id,
      expected_qty: Number(itemsById[id]?.on_hand) || 0, unit_cost: itemsById[id]?.current_cost == null ? null : Number(itemsById[id].current_cost), sort_order: i,
    }));
    for (const chunk of chunkArray(lines, INSERT_CHUNK)) {
      const { data: ins, error: lineErr } = await supabase.from('stock_count_lines').insert(chunk).select('id');
      const err = lineErr || zeroRows('Count lines', ins);
      if (err) return { data: countFromRow(c), error: new Error(`The count was started but its lines did not all save: ${err.message}. Delete it and start again.`) };
    }
    return { data: countFromRow(c), error: null };
  }

  // ── with areas ──
  const [itemsRes, areasRes, itemAreasRes, holdingsRes, spRes] = await Promise.all([
    givenItems ? Promise.resolve({ data: givenItems, error: null }) : readAllPagesResult('stock items', (first) => supabase.from('inventory_items')
      .select('id, name, on_hand, current_cost, archived_at, is_tracked', first ? { count: 'exact' } : undefined).eq('location_id', locationId).order('name').order('id')),
    fetchAreas(locationId),
    fetchItemAreas(locationId),
    fetchAreaHoldings(locationId),
    // v5.11.82 (Drop 0): an archived supplier price never puts its item on a supplier's count
    type === 'SUPPLIER' && supplierId
      ? liveOrAll((live) => readAllPagesResult('supplier packs', (first) => {
        let q = supabase.from('supplier_products')
          .select('inventory_item_id, supplier_id', first ? { count: 'exact' } : undefined).eq('location_id', locationId).eq('supplier_id', supplierId);
        if (live) q = q.is('archived_at', null);
        return q.order('id');
      }))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const readErr = itemsRes.error || areasRes.error || itemAreasRes.error || holdingsRes.error || spRes.error;
  if (readErr) return { data: null, error: readErr };
  // rows from fetchInventoryItems are camelCase already; a raw read is mapped here
  const items = (itemsRes.data || []).map((i) => (i.onHand !== undefined) ? i : {
    id: i.id, name: i.name, onHand: Number(i.on_hand) || 0, currentCost: i.current_cost == null ? null : Number(i.current_cost),
    archivedAt: i.archived_at, isTracked: i.is_tracked !== false,
  });
  const supplierProducts = (spRes.data || []).map((r) => (r.inventoryItemId ? r : { inventoryItemId: r.inventory_item_id, supplierId: r.supplier_id }));
  const areas = areasRes.data || [];
  const scope = resolveCountScope({ type, areaIds, supplierId, itemIds }, { items, itemAreas: itemAreasRes.data || {}, holdings: holdingsRes.data || {}, supplierProducts, areas });
  if (!scope.lines.length) return { data: null, error: new Error('Nothing to count: no tracked items match that choice') };

  let supplierName = null;
  if (type === 'SUPPLIER' && supplierId) {
    const { data: s } = await supabase.from('suppliers').select('name').eq('location_id', locationId).eq('id', supplierId).maybeSingle();
    supplierName = s?.name || null;
  }
  const areaNames = (areaIds || []).map((id) => areas.find((a) => a.id === id)?.name).filter(Boolean);
  const finalName = name || countNameFor({ ts: new Date(), tz, type, areaNames, supplierName });
  const { data: c, error } = await supabase.from('stock_counts').insert({
    location_id: locationId, name: finalName, count_type: type, status: 'DRAFT', storage_area: storageArea || null,
    supplier_id: type === 'SUPPLIER' ? (supplierId || null) : null, started_by_name: startedByName || null,
  }).select().maybeSingle();
  if (error || !c) return { data: null, error: error || new Error('Could not start count') };

  const lines = scope.lines.map((l) => ({
    location_id: locationId, count_id: c.id, inventory_item_id: l.itemId, area_id: l.areaId,
    expected_qty: l.expectedQty, unit_cost: l.unitCost, sort_order: l.sortOrder,
  }));
  for (const chunk of chunkArray(lines, INSERT_CHUNK)) {
    const { data: ins, error: lineErr } = await supabase.from('stock_count_lines').insert(chunk).select('id');
    const err = lineErr || zeroRows('Count lines', ins);
    if (err) return { data: countFromRow(c), error: new Error(`The count was started but its lines did not all save: ${err.message}. Delete it and start again.`) };
  }
  // AREA counts: one row per ticked area (an area ticked but empty still gets its row, so it can be
  // marked complete); other types: one row per area that has lines. The Unassigned group has none.
  const rowAreas = type === 'AREA' ? [...new Set([...(areaIds || []).filter((id) => areas.some((a) => a.id === id)), ...scope.areaIds])] : scope.areaIds;
  if (rowAreas.length) {
    const { data: ar, error: arErr } = await supabase.from('stock_count_areas')
      .insert(rowAreas.map((areaId) => ({ location_id: locationId, count_id: c.id, area_id: areaId, status: 'open' }))).select('id');
    const err = arErr || zeroRows('Count areas', ar);
    if (err) return { data: countFromRow(c), error: new Error(`The count was started but its area rows did not save: ${err.message}. Delete it and start again.`) };
  }
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
 * Mark one area of a count complete (or reopen it). Refused on an approved count. The caller
 * flushes that area's dirty lines first (StockCounts.jsx) and passes the counter's name.
 */
export const markAreaComplete = async (countId, areaId, { complete = true, byName = null } = {}, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const { data: count } = await supabase.from('stock_counts').select('status').eq('location_id', locationId).eq('id', countId).maybeSingle();
  if (!count) return { error: new Error('Count not found') };
  if (count.status === 'APPROVED') return { error: new Error('This count has been approved; its areas cannot be changed.') };
  const patch = complete
    ? { status: 'complete', completed_by_name: byName || null, completed_at: nowIso() }
    : { status: 'open', completed_by_name: null, completed_at: null };
  const { data, error } = await supabase.from('stock_count_areas').update(patch)
    .eq('location_id', locationId).eq('count_id', countId).eq('area_id', areaId).select('id');
  return { error: error || zeroRows(complete ? 'Mark area complete' : 'Reopen area', data) };
};

/**
 * Remove one item from a count sheet. Only meaningful before approval: once a count is
 * APPROVED its lines are the evidence behind posted STOCK_COUNT_ADJ movements, so they must
 * not be edited away.
 */
export const removeCountLine = async (lineId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const { data: line } = await supabase.from('stock_count_lines')
    .select('id, count_id').eq('location_id', locationId).eq('id', lineId).maybeSingle();
  if (!line) return { error: new Error('Line not found') };
  const { data: count } = await supabase.from('stock_counts')
    .select('status').eq('location_id', locationId).eq('id', line.count_id).maybeSingle();
  if (count?.status === 'APPROVED') return { error: new Error('This count has been approved: its lines are part of your stock history and cannot be removed.') };
  return supabase.from('stock_count_lines').delete().eq('location_id', locationId).eq('id', lineId);
};

/**
 * Delete a whole count sheet.
 *
 * Guarded on purpose: approving a count posts STOCK_COUNT_ADJ movements, and those
 * movements are what The Gap report measures variance from. Deleting an approved
 * count would silently rewrite stock history and leave the adjustments orphaned, so
 * it is refused: a DRAFT or SUBMITTED count has posted nothing and is safe to bin.
 */
export const deleteCount = async (countId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const { data: count } = await supabase.from('stock_counts')
    .select('status').eq('location_id', locationId).eq('id', countId).maybeSingle();
  if (!count) return { error: new Error('Count not found') };
  if (count.status === 'APPROVED') {
    return { error: new Error('This count has been approved and already adjusted your stock, so it cannot be deleted.') };
  }
  const { error: lineErr } = await supabase.from('stock_count_lines')
    .delete().eq('location_id', locationId).eq('count_id', countId);
  if (lineErr) return { error: lineErr };
  return supabase.from('stock_counts').delete().eq('location_id', locationId).eq('id', countId);
};

/**
 * Approve a count: ONE database call moves every counted line's holding to the counted figure, works
 * each line out from the moment it was counted, records the variance and marks the count APPROVED
 * with the approver's name and note (all or nothing; a retry posts nothing twice).
 *
 * v5.11.79 (stock plan Phase 0, 11.5 item 1 and 4.6): approve_stock_count (20261019b). The first
 * count of an item posts Opening stock (out of The Gap), valued at a real cost, never 0: with no cost
 * known the call answers needs_cost and nothing is written, and the screen asks the manager for one
 * (`costs`: { itemId: cost per base unit }).
 * v5.11.82 (multi site stock Drop 0, plan 4.17): a manager PIN approves the count
 * (stock_approve_count_pin, 0a): the database checks the PIN against the venue's managers, refuses
 * after five wrong ones in 15 minutes and stores who it was. Before 0a that call is missing and the
 * call without a PIN runs, as in v5.11.81. The old line by line browser path is gone (it never ran
 * once 20261019b was in): a database with neither call is told it needs the update.
 */
export const approveCount = async (countId, locationId = null, { approvedByName = null, approvalNote = null, costs = null, pin = null } = {}) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const pCosts = costs && Object.keys(costs).length ? costs : null;
  const done = (res, extra = '') => {
    const outcome = approvalOutcome(res);
    if (!outcome.ok) return { error: new Error(outcome.text), needsCost: outcome.needsCost || null, data: res };
    return { error: null, data: { posted: Number(res?.posted) || 0, total: Number(res?.total) || 0, opening: Number(res?.opening) || 0,
      varianceValue: res?.variance_value ?? null, openingValue: res?.opening_value ?? null, uncounted: res?.uncounted ?? null,
      duplicate: !!res?.duplicate, text: `${outcome.text}${extra}`, oneCall: true } };
  };
  {
    const { data: pres, error: pErr } = await supabase.rpc('stock_approve_count_pin', {
      p_count_id: countId, p_pin: String(pin || ''), p_approved_by_name: approvedByName || null, p_approval_note: approvalNote || null,
      p_costs: pCosts, p_preview: false,
    });
    if (!pErr) {
      // Nothing was written: the PIN was missing, wrong or locked out.
      if (pres && pres.ok === false && pres.pin) return { error: new Error(pres.error || 'That PIN is not a manager at this venue.'), pinRefused: true, data: pres };
      return done(pres, pres?.approved_by_pin ? ` Approved by ${pres.approved_by_pin}.` : '');
    }
    if (!isMissingFunctionError(pErr)) return { error: pErr };
  }
  const { data: res, error: rpcErr } = await supabase.rpc('approve_stock_count', {
    p_count_id: countId, p_approved_by_name: approvedByName || null, p_approval_note: approvalNote || null,
    p_costs: costs && Object.keys(costs).length ? costs : null, p_preview: false,
  });
  if (!rpcErr) return done(res);
  if (isMissingFunctionError(rpcErr)) return { error: new Error(`Not approved. ${NEEDS_UPDATE}`) };
  return { error: rpcErr };
};
