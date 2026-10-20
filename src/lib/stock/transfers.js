/**
 * stock/transfers.js: the data layer for stock transfers (16 Oct 2026, builder B). Tables
 * stock_transfers and stock_transfer_lines, the posting function post_stock_transfer_leg
 * (supabase/migrations/20261016_OPS_stock_areas.sql). Rules in transferRules.js and
 * areaRules.js (transferPlan, matchTransferLines, canReceive). Reads of the list and of one
 * transfer are in areas.js (fetchTransfers, fetchTransfer).
 *
 * The shape of every move: a head row and its lines are written first (every write checked),
 * then ONE call to post_stock_transfer_leg posts every line in one transaction:
 *   'both'   within a venue: TRANSFER_OUT from the from area and TRANSFER_IN to the to area, DONE
 *   'out'    to another venue: TRANSFER_OUT at the sender, SENT
 *   'in'     at the receiver: TRANSFER_IN per matched line into the chosen area, RECEIVED
 *   'cancel' the sender takes it back: a SENT transfer posts TRANSFER_IN back, CANCELLED
 * A head left in DRAFT (the leg call failed) is shown on the list with Send and Cancel so no
 * stock is ever half moved and forgotten.
 *
 * House pattern (data.js): a real locationId or nothing, camelCase to snake_case by hand, every
 * write asked for its rows and nothing coming back treated as the failure it is.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { readAllPagesResult } from '../pagedRead.js';
import { transferReference, chunkArray, INSERT_CHUNK } from './areaRules.js';
import { staleLegError } from './transferRules.js';
import { areasReady, fetchTransfer } from './areas.js';
import { fetchReportScopeData } from '../reportSites.js';

async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}
const nowIso = () => new Date().toISOString();
const zeroRows = (what, data) => (!data || data.length === 0)
  ? new Error(`${what} matched 0 rows: RLS blocked it or the row no longer exists`)
  : null;
const noRow = (what, row) => row ? null : new Error(`${what} returned no row: RLS blocked it or it matched nothing`);

/**
 * The venues this login may send stock to: the other venues of the company that the database
 * lets it read (the same two reads the report Sites control makes). { venues: [{ id, name }],
 * namesById: { id: name } } (namesById includes this venue, for the list).
 */
export const fetchVenueChoices = async (locationId = null) => {
  const none = { venues: [], namesById: {} };
  if (isMock || !supabase) return { data: none, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: none, error: null };
  const scope = await fetchReportScopeData(locationId);
  const readable = scope.readableIds ? new Set(scope.readableIds.map(String)) : null;
  // v5.11.79 (stock plan 4.8): sister sites only, the venues of THIS venue's company (the database
  // refuses a transfer to another company too, in the table rule and in the posting).
  const homeOrg = (scope.locations || []).find((l) => String(l.id) === String(locationId))?.org_id || null;
  const namesById = {};
  (scope.locations || []).forEach((l) => { namesById[String(l.id)] = l.name || 'Venue'; });
  const venues = (scope.locations || [])
    .filter((l) => String(l.id) !== String(locationId) && (!readable || readable.has(String(l.id))) && homeOrg && String(l.org_id) === String(homeOrg))
    .map((l) => ({ id: String(l.id), name: l.name || 'Venue' }));
  return { data: { venues, namesById }, error: null };
};

/** Line counts and sent value per transfer for the list, both ends of this venue (paged). */
export const fetchTransferLineSummary = async (locationId = null) => {
  if (isMock || !supabase) return { data: {}, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: {}, error: null };
  const { data, error } = await readAllPagesResult('transfer lines', (first) => supabase.from('stock_transfer_lines')
    .select('id, transfer_id, qty_base, qty_received_base, unit_cost, dropped', first ? { count: 'exact' } : undefined)
    .or(`location_id.eq.${locationId},to_location_id.eq.${locationId}`)
    .order('transfer_id').order('id'));
  if (error) return { data: {}, error };
  const out = {};
  (data || []).forEach((r) => {
    const s = (out[r.transfer_id] ??= { lines: 0, dropped: 0, value: 0 });
    s.lines += 1;
    if (r.dropped) { s.dropped += 1; return; }
    const qty = Number(r.qty_received_base ?? r.qty_base) || 0;
    s.value += Math.max(0, qty) * (Number(r.unit_cost) || 0);
  });
  return { data: out, error: null };
};

/**
 * Write the head and its lines (chunks of 200, every chunk checked). Nothing is posted yet.
 *   draft: { toLocationId (null within the venue), fromAreaId, toAreaId, note, byName,
 *            lines: [{ inventoryItemId, qtyBase, nameSnapshot, skuSnapshot, baseUnit, sortOrder }] }
 * Returns { data: { id, reference }, error }.
 */
export const createTransfer = async (draft, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const ok = await areasReady(locationId);
  if (!ok) return { data: null, error: new Error('Stock areas need the 16 Oct database update') };
  const lines = (draft?.lines || []).filter((l) => l && Number(l.qtyBase) > 0);
  if (!lines.length) return { data: null, error: new Error('Add at least one line with a quantity') };
  const toLocationId = draft.toLocationId && String(draft.toLocationId) !== String(locationId) ? draft.toLocationId : null;
  const reference = transferReference();
  const { data: head, error: headErr } = await supabase.from('stock_transfers').insert({
    location_id: locationId, to_location_id: toLocationId,
    from_area_id: draft.fromAreaId || null, to_area_id: toLocationId ? (draft.toAreaId || null) : (draft.toAreaId || null),
    status: 'DRAFT', reference, note: draft.note || null, created_by_name: draft.byName || null,
  }).select().maybeSingle();
  const hErr = headErr || noRow('Transfer save', head);
  if (hErr) return { data: null, error: hErr };
  let i = 0;
  for (const chunk of chunkArray(lines, INSERT_CHUNK)) {
    const rows = chunk.map((l) => ({
      transfer_id: head.id, location_id: locationId, to_location_id: toLocationId,
      inventory_item_id: l.inventoryItemId, name_snapshot: l.nameSnapshot || null, sku_snapshot: l.skuSnapshot || null,
      base_unit: l.baseUnit || null, qty_base: Number(l.qtyBase), sort_order: l.sortOrder ?? i++,
    }));
    const { data, error } = await supabase.from('stock_transfer_lines').insert(rows).select('id');
    const err = error || (data?.length === rows.length ? null : new Error(`Transfer lines: ${data?.length || 0} of ${rows.length} saved`));
    if (err) return { data: { id: head.id, reference, linesFailed: true }, error: new Error(`${reference} was saved but its lines were not: ${err.message || err}. It is on the Transfers list as a draft; cancel it and try again.`) };
  }
  return { data: { id: head.id, reference }, error: null };
};

/**
 * One leg through the database function. Returns { data: result, error }; a refusal in words is an
 * error, and so is a duplicate answer whose status is not the one this leg leaves behind (the
 * transfer was cancelled or received from another screen: nothing moved now).
 */
export const postTransferLeg = async (transferId, leg, byName = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  const { data, error } = await supabase.rpc('post_stock_transfer_leg', { p_transfer_id: transferId, p_leg: leg, p_by_name: byName || null });
  if (error) return { data: null, error };
  if (data && data.ok === false) return { data, error: new Error(data.error || 'The transfer was refused') };
  const stale = staleLegError(leg, data);
  if (stale) return { data, error: new Error(stale) };
  return { data: data || {}, error: null };
};

/** Within one venue: write, then post both legs in one transaction (DONE). */
export const moveStock = async (draft, locationId = null) => {
  const made = await createTransfer({ ...draft, toLocationId: null }, locationId);
  if (made.error) return made;
  const leg = await postTransferLeg(made.data.id, 'both', draft.byName);
  if (leg.error) return { data: made.data, error: new Error(`${made.data.reference} is saved but nothing moved: ${leg.error.message || leg.error}. Open it on the Transfers list to try again or cancel it.`) };
  return { data: { ...made.data, ...leg.data }, error: null };
};

/** To another venue: write, then post the out leg (SENT). The receiver takes it from there. */
export const sendTransfer = async (draft, locationId = null) => {
  if (!draft?.toLocationId) return { data: null, error: new Error('Pick the venue to send to') };
  const made = await createTransfer(draft, locationId);
  if (made.error) return made;
  const leg = await postTransferLeg(made.data.id, 'out', draft.byName);
  if (leg.error) return { data: made.data, error: new Error(`${made.data.reference} is saved but not sent: ${leg.error.message || leg.error}. Open it on the Transfers list to send again or cancel it.`) };
  return { data: { ...made.data, ...leg.data }, error: null };
};

/** Send (or move) a draft that was saved but whose leg failed. Decides the leg from the head. */
export const retryTransfer = async (transferId, byName = null, locationId = null) => {
  const { data: t, error } = await fetchTransfer(transferId, locationId);
  if (error) return { data: null, error };
  if (!t) return { data: null, error: new Error('Transfer not found') };
  const within = !t.toLocationId || t.toLocationId === t.locationId;
  return postTransferLeg(transferId, within ? 'both' : 'out', byName);
};

/**
 * The receiving venue saves how each line matched (its item, quantity received, dropped) and
 * which area the stock lands in. Every line write is checked. Nothing is posted here.
 *   updates: receiveLineUpdates(lines) rows: [{ id, to_inventory_item_id, qty_received_base, dropped }]
 */
export const saveReceiveMatches = async (transferId, updates, toAreaId = null) => {
  if (isMock || !supabase) return { error: null };
  for (const u of updates || []) {
    const { data, error } = await supabase.from('stock_transfer_lines')
      .update({ to_inventory_item_id: u.to_inventory_item_id, qty_received_base: u.qty_received_base, dropped: u.dropped === true })
      .eq('transfer_id', transferId).eq('id', u.id).select('id');
    const err = error || zeroRows('Transfer line match', data);
    if (err) return { error: err };
  }
  const { data, error } = await supabase.from('stock_transfers').update({ to_area_id: toAreaId || null, updated_at: nowIso() })
    .eq('id', transferId).select('id');
  return { error: error || zeroRows('Transfer receive area', data) };
};

/** Receive at this venue: the in leg (RECEIVED). The function refuses while a line is neither matched nor dropped. */
export const receiveTransfer = async (transferId, byName = null) => postTransferLeg(transferId, 'in', byName);

/** The sender takes a transfer back (CANCELLED; a SENT one puts its stock back in the from area). */
export const cancelTransfer = async (transferId, byName = null) => postTransferLeg(transferId, 'cancel', byName);
