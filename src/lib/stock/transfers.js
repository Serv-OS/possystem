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
import { staleLegError, requestLinesOf } from './transferRules.js';
import { areasReady, fetchTransfer } from './areas.js';
import { fetchReportScopeData } from '../reportSites.js';
import { stockApi } from './stockApi.js';

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
    .select('id, transfer_id, qty_base, qty_received_base, unit_cost, dropped, short_qty_base', first ? { count: 'exact' } : undefined)
    .or(`location_id.eq.${locationId},to_location_id.eq.${locationId}`)
    .order('transfer_id').order('id'));
  if (error) return { data: {}, error };
  const out = {};
  (data || []).forEach((r) => {
    const s = (out[r.transfer_id] ??= { lines: 0, dropped: 0, value: 0, short: 0 });
    s.lines += 1;
    if (r.dropped) { s.dropped += 1; return; }
    // v5.11.96 (Drop 3): a received line that did not all arrive (the 'Short' word for multi site companies)
    if (Number(r.short_qty_base) > 0) s.short += 1;
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
    // v5.11.96 (Drop 3): why it moves, only when a multi site screen gave one (the column is new)
    ...(draft.reason ? { reason: String(draft.reason) } : {}),
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

// ── v5.11.96 (multi site stock Drop 3, contract 3.3): requests, disputes, and the new columns ──
// Each is ONE stockApi call; the database decides who may (the receiving site asks, the sending site
// fulfils, refuses and resolves). None of these moves stock: the existing out and in legs do.

// A refusal inside the answer ({ ok: false, error }) is already an error with the database's words.
const legAnswer = (r) => ({ data: r.data, error: r.error, needsUpdate: r.needsUpdate });

/** The receiving site (to) asks another site (from): picks [{ companyItemId, qty }]. */
export const requestTransfer = async ({ from, to, picks, reason = null, note = null }) => {
  const { lines, error } = requestLinesOf(picks);
  if (error) return { data: null, error: new Error(error) };
  if (!from || !to) return { data: null, error: new Error('Pick the site to ask.') };
  return stockApi.requestTransfer({ from, to, lines, reason, note });
};

/** The sending site turns a request into a draft (optionally changing amounts), then sends it with the out leg. */
export const fulfilRequest = async (transferId, lines = null, byName = null) => {
  const f = await stockApi.fulfilRequest(transferId, lines);
  if (f.error) return f;
  return postTransferLeg(transferId, 'out', byName);
};

/** The sending site says no to a request (REQUESTED to CANCELLED). */
export const refuseRequest = async (transferId, byName = null) => legAnswer(await stockApi.transferLeg(transferId, 'refuse', byName));

/** The receiving site says a received transfer is wrong (paperwork only: the shorts were booked at receive). */
export const disputeTransfer = async (transferId, note) => {
  if (!String(note ?? '').trim()) return { data: null, error: new Error('Say what is wrong.') };
  return stockApi.disputeTransfer(transferId, String(note).trim());
};

/** The sending site settles a dispute (DISPUTED to RECEIVED). */
export const resolveTransfer = async (transferId, byName = null) => legAnswer(await stockApi.transferLeg(transferId, 'resolve', byName));

/**
 * The Drop 3 columns of these transfers (areas.js maps today's columns only): { [id]: { kind,
 * reason, requestedByName, requestedAt, disputeNote, disputedAt, resolvedAt, resolvedByName,
 * purchaseOrderId } }. At most 100 ids. A database without Drop 3 answers {} (needsUpdate true).
 */
export const fetchTransferExtras = async (transferIds) => {
  const ids = [...new Set((transferIds || []).filter(Boolean).map(String))].slice(0, 100);
  if (isMock || !supabase || !ids.length) return { data: {}, error: null };
  const { data, error } = await supabase.from('stock_transfers')
    .select('id, kind, reason, requested_by_name, requested_at, dispute_note, disputed_at, resolved_at, resolved_by_name, purchase_order_id')
    .in('id', ids).limit(100);
  if (error) return { data: {}, error, needsUpdate: /column|42703|PGRST204/i.test(`${error.code || ''} ${error.message || ''}`) };
  const out = {};
  (data || []).forEach((r) => {
    out[r.id] = { kind: r.kind || 'transfer', reason: r.reason || null, requestedByName: r.requested_by_name || null, requestedAt: r.requested_at || null,
      disputeNote: r.dispute_note || null, disputedAt: r.disputed_at || null, resolvedAt: r.resolved_at || null,
      resolvedByName: r.resolved_by_name || null, purchaseOrderId: r.purchase_order_id || null };
  });
  return { data: out, error: null };
};

/** Lot, use by and the amount asked for, per line of one transfer: { [lineId]: { lotCode, useByAt, requestedQtyBase } }. */
export const fetchTransferLineExtras = async (transferId) => {
  if (isMock || !supabase || !transferId) return { data: {}, error: null };
  const { data, error } = await readAllPagesResult('transfer line lots', (first) => supabase.from('stock_transfer_lines')
    .select('id, lot_code, use_by_at, requested_qty_base', first ? { count: 'exact' } : undefined).eq('transfer_id', transferId).order('id'));
  if (error) return { data: {}, error };
  const out = {};
  (data || []).forEach((r) => {
    out[r.id] = { lotCode: r.lot_code || null, useByAt: r.use_by_at || null, requestedQtyBase: r.requested_qty_base == null ? null : Number(r.requested_qty_base) };
  });
  return { data: out, error: null };
};

/** { lineId: receiving item id } for the lines stock_transfer_matches matched by company item (matchTransferLines byCompany). */
export const fetchCompanyMatches = async (transferId) => {
  const r = await stockApi.transferMatches(transferId);
  if (r.error) return { data: null, error: r.error, needsUpdate: r.needsUpdate };
  const map = {};
  (Array.isArray(r.data) ? r.data : []).forEach((m) => { if (m && m.how === 'company' && m.line_id && m.to_inventory_item_id) map[m.line_id] = m.to_inventory_item_id; });
  return { data: map, error: null };
};

/**
 * This site's company items: { toSite: { companyItemId: siteItemId }, toCompany: { siteItemId:
 * companyItemId } } from stock_co_item_sites (paged, 1,000 a page). Saved transfer lists and requests
 * name company items; the send screen works in this site's items.
 */
export const fetchCompanyItemMap = async (locationId) => {
  const none = { toSite: {}, toCompany: {} };
  if (isMock || !supabase || !locationId) return { data: none, error: null };
  const { data, error } = await readAllPagesResult('company items here', (first) => supabase.from('stock_co_item_sites')
    .select('item_id, site_item_id', first ? { count: 'exact' } : undefined).eq('location_id', locationId).order('site_item_id'));
  if (error) return { data: none, error };
  const out = { toSite: {}, toCompany: {} };
  (data || []).forEach((r) => { out.toSite[r.item_id] = r.site_item_id; out.toCompany[r.site_item_id] = r.item_id; });
  return { data: out, error: null };
};
