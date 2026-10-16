/**
 * transferRules.js: the pure rules behind stock transfers (16 Oct 2026, builder B). Peter:
 * "transfers between locations and stock areas, so then each stock area should have its own
 * holding of said item."
 *
 * A transfer moves stock between two areas of one venue (born and finished DONE in one step) or
 * from one venue to another (SENT by the sender, RECEIVED by the receiver, or CANCELLED by the
 * sender before that). The posting itself is post_stock_transfer_leg in SQL (one transaction
 * for every line); this file decides what to post, what to warn about and what to say.
 * The data layer is transfers.js. Matching lines at the receiving venue is
 * areaRules.matchTransferLines (SKU first, then name, never an archived item).
 *
 * No React, no Supabase. Everything here is tested in transferRules.test.js.
 */

import { toBase, fromBase, formatToken, unitLabel } from './uom.js';
import { lineValue } from './valuation.js';
import { matchTransferLines, canReceive } from './areaRules.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r4 = (v) => Math.round(num(v) * 10000) / 10000;
const r3 = (v) => Math.round(num(v) * 1000) / 1000;

export const TRANSFER_STATUS_WORDS = Object.freeze({ DRAFT: 'Draft', SENT: 'Sent', RECEIVED: 'Received', CANCELLED: 'Cancelled', DONE: 'Done' });
export const TRANSFER_FILTERS = Object.freeze([
  { id: 'all', label: 'All' }, { id: 'open', label: 'Not finished' }, { id: 'done', label: 'Done' }, { id: 'cancelled', label: 'Cancelled' },
]);
/** The status each leg leaves behind. */
export const LEG_END_STATUS = Object.freeze({ out: 'SENT', both: 'DONE', in: 'RECEIVED', cancel: 'CANCELLED' });

/**
 * post_stock_transfer_leg answers { ok: true, duplicate: true, status } whenever the status has
 * already moved past the asked leg. That is only a harmless retry when the status is the one this
 * leg leaves behind; a Receive on a transfer the sender cancelled, or a Send on a cancelled
 * draft, moved nothing and must not be toasted as a success (16 Oct review). Returns the words
 * for the error, or null when the answer is fine.
 */
export function staleLegError(leg, result) {
  if (!result || result.duplicate !== true) return null;
  const want = LEG_END_STATUS[leg];
  if (!want || result.status === want) return null;
  const word = (TRANSFER_STATUS_WORDS[result.status] || result.status || 'changed').toLowerCase();
  return `This transfer is already ${word}: nothing moved. Refresh the list.`;
}

/** The uom context the unit helpers want, from a fetchInventoryItems item. */
export function uomCtxOf(item) {
  return { baseUnit: item?.baseUnit || 'each', formats: item?.packaging || [], itemConversions: item?.conversions || [] };
}

/** The units a line can be typed in: named packs largest first, else the base unit. Same list as the count sheet. */
export function transferUnitsFor(item) {
  const u = uomCtxOf(item);
  const fmts = [...u.formats].sort((a, b) => num(b.qtyInBase) - num(a.qtyInBase)).map((f) => ({ token: formatToken(f.id), label: f.name }));
  fmts.push({ token: u.baseUnit, label: u.baseUnit });
  return fmts;
}

/** The unit a quantity is shown in: the count default pack, else the base unit. */
export function defaultTokenOf(item) {
  const cd = (item?.packaging || []).find((f) => f.isCountDefault);
  return cd ? formatToken(cd.id) : (item?.baseUnit || 'each');
}

/** "12 Bottle" for a base quantity of an item, in its count unit, three places. */
export function fmtQtyOf(qtyBase, item) {
  const u = uomCtxOf(item);
  const tok = defaultTokenOf(item);
  const v = fromBase(qtyBase, tok, u);
  return `${r3(v == null ? qtyBase : v)} ${unitLabel(tok, u)}`;
}

/** 'within' (one venue), 'outgoing' (this venue sends) or 'incoming' (this venue receives). */
export function transferDirection(t, homeId) {
  if (!t) return 'within';
  if (!t.toLocationId || t.toLocationId === t.locationId) return 'within';
  return String(t.toLocationId) === String(homeId) ? 'incoming' : 'outgoing';
}

/**
 * The first line of a transfer row: "Cellar to Walk in fridge", "Sent to Coffee Boy Leeds",
 * "Incoming from Coffee Boy Leeds". areaName(id) and venueName(id) are the caller's lookups.
 */
export function transferHeadline(t, { homeId = null, areaName = () => '', venueName = () => '' } = {}) {
  const dir = transferDirection(t, homeId);
  if (dir === 'within') return `${areaName(t.fromAreaId) || 'No area'} to ${areaName(t.toAreaId) || 'No area'}`;
  if (dir === 'outgoing') return `Sent to ${venueName(t.toLocationId) || 'another venue'}`;
  return `Incoming from ${venueName(t.locationId) || 'another venue'}`;
}

/** Which rows a list filter keeps. */
export function transferMatchesFilter(t, filter) {
  if (!t) return false;
  if (filter === 'open') return t.status === 'SENT' || t.status === 'DRAFT';
  if (filter === 'done') return t.status === 'DONE' || t.status === 'RECEIVED';
  if (filter === 'cancelled') return t.status === 'CANCELLED';
  return true;
}

/**
 * Is this draft ready to post? Returns the refusal in words, or null when it is fine.
 *   draft: { mode: 'within' | 'venue', fromAreaId, toAreaId, toLocationId, lines }
 *   hasAreas: the sending venue has at least one live area
 */
export function validateTransferDraft(draft, { homeId = null, hasAreas = true } = {}) {
  const lines = (draft?.lines || []).filter((l) => l && num(l.qtyBase) > 0);
  if (!lines.length) return 'Add at least one line with a quantity';
  if (draft?.mode === 'venue') {
    if (!draft.toLocationId) return 'Pick the venue to send to';
    if (String(draft.toLocationId) === String(homeId)) return 'That is this venue: pick another, or move stock within this venue';
    if (hasAreas && !draft.fromAreaId) return 'Pick the area the stock leaves from';
    return null;
  }
  if (!hasAreas) return 'This venue has no stock areas yet: set them up on Stock areas first';
  if (!draft?.fromAreaId || !draft?.toAreaId) return 'Pick the area it leaves and the area it goes to';
  if (draft.fromAreaId === draft.toAreaId) return 'Pick two different areas';
  return null;
}

/**
 * Turn what was typed into lines in base units.
 *   picks: { [itemId]: { qty: '6', token: 'f<id>' | 'l' } }
 *   itemsById: fetchInventoryItems items by id
 * Returns { lines: [{ inventoryItemId, qtyBase, nameSnapshot, skuSnapshot, baseUnit, sortOrder }],
 *           errors: [{ itemId, message }] }. A blank or zero quantity is left out, not an error;
 * a quantity that cannot be converted is.
 */
export function buildTransferLines(picks, itemsById) {
  const lines = [];
  const errors = [];
  let i = 0;
  for (const [itemId, p] of Object.entries(picks || {})) {
    const item = itemsById?.[itemId];
    if (!item) { errors.push({ itemId, message: 'This item is not at this venue any more' }); continue; }
    const raw = p?.qty;
    if (raw === '' || raw == null) continue;
    const n = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) { errors.push({ itemId, message: `${item.name}: the quantity must be a number` }); continue; }
    if (n === 0) continue;
    let qtyBase;
    try { qtyBase = toBase(n, p?.token || defaultTokenOf(item), uomCtxOf(item)); }
    catch { errors.push({ itemId, message: `${item.name}: that unit cannot be converted to ${item.baseUnit}` }); continue; }
    if (!(qtyBase > 0)) continue;
    lines.push({ inventoryItemId: itemId, qtyBase: r4(qtyBase), nameSnapshot: item.name || null, skuSnapshot: item.sku || null, baseUnit: item.baseUnit || null, sortOrder: i });
    i += 1;
  }
  return { lines, errors };
}

/**
 * Lines that would take the from area below zero: shown in amber, allowed (Peter: nothing is
 * hidden; the holding goes red and a count or another transfer puts it right).
 *   holdings: { itemId: { areaId: qtyBase } }; fmt(qtyBase, item) formats in count units.
 * Returns [{ itemId, text }] like "Cellar has 4 Bottle, you are moving 6 Bottle".
 */
export function lineWarnings(lines, fromAreaId, { holdings = {}, itemsById = {}, areaName = 'This area', fmt = (q) => String(r3(q)) } = {}) {
  if (!fromAreaId) return [];
  const out = [];
  for (const l of lines || []) {
    if (!l || !(num(l.qtyBase) > 0)) continue;
    const have = num(holdings?.[l.inventoryItemId]?.[fromAreaId]);
    if (have >= num(l.qtyBase) - 1e-9) continue;
    const item = itemsById[l.inventoryItemId];
    out.push({ itemId: l.inventoryItemId, text: `${areaName} has ${fmt(have, item)}, you are moving ${fmt(l.qtyBase, item)}` });
  }
  return out;
}

/** The value of a transfer at the sender's cost: sum of qty x cost, floored per line at zero like valuation. */
export function transferValue(lines, costById = {}) {
  return (lines || []).reduce((s, l) => {
    if (!l) return s;
    const cost = l.unitCost != null ? num(l.unitCost) : num(costById[l.inventoryItemId]);
    return s + lineValue(num(l.qtyReceivedBase ?? l.qtyBase), cost);
  }, 0);
}

/**
 * What the receiving venue sees: each line matched to one of its items (SKU, then name), the
 * quantity received defaulting to the quantity sent, and whether Receive may go ahead.
 * Lines already matched by hand (toInventoryItemId set to a live item) are kept.
 */
export function receivePlan(lines, receiverItems) {
  const { lines: matched, unmatched } = matchTransferLines(lines, receiverItems);
  const out = matched.map((l) => ({ ...l, qtyReceivedBase: l.qtyReceivedBase == null ? num(l.qtyBase) : num(l.qtyReceivedBase) }));
  return { lines: out, unmatched, canReceive: canReceive(out) };
}

/** The receiving venue's items that look like a line, for the match by hand list: name, SKU or supplier code contains the words. */
export function matchCandidates(query, receiverItems, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  const live = (receiverItems || []).filter((i) => i && !i.archivedAt);
  if (!q) return live.slice(0, limit);
  const words = q.split(/\s+/);
  const hay = (i) => `${i.name || ''} ${i.sku || ''} ${(i.supplierProducts || []).map((sp) => sp.supplierSku || '').join(' ')}`.toLowerCase();
  return live.filter((i) => { const h = hay(i); return words.every((w) => h.includes(w)); }).slice(0, limit);
}

/** The rows the receive step writes on each line (snake_case, as the table has them). */
export function receiveLineUpdates(lines) {
  return (lines || []).filter(Boolean).map((l) => ({
    id: l.id,
    to_inventory_item_id: l.dropped ? null : (l.toInventoryItemId || null),
    qty_received_base: l.dropped ? null : r4(l.qtyReceivedBase == null ? l.qtyBase : l.qtyReceivedBase),
    dropped: l.dropped === true,
  }));
}

/** "12 lines" / "12 lines, 2 dropped" */
export function linesText(lines) {
  const all = (lines || []).filter(Boolean);
  const dropped = all.filter((l) => l.dropped).length;
  const n = all.length;
  return `${n} line${n === 1 ? '' : 's'}${dropped ? `, ${dropped} dropped` : ''}`;
}

/** The confirm before Cancel: a sent transfer puts the stock back; a draft just goes. */
export function cancelText(t, lineCount = 0, areaName = '') {
  if (t?.status === 'SENT') {
    return `Cancel ${t.reference || 'this transfer'}? Its ${lineCount} line${lineCount === 1 ? '' : 's'} go back into ${areaName || 'the area they left'} and the other venue will not receive it.`;
  }
  return `Cancel ${t?.reference || 'this transfer'}? Nothing has moved.`;
}

/** The toast after a within venue move: "6 Bottle moved from Cellar to Walk in fridge" or "3 lines moved from Cellar to Walk in fridge". */
export function movedText(lines, fromName, toName, itemsById = {}) {
  const list = (lines || []).filter((l) => l && num(l.qtyBase) > 0);
  if (list.length === 1) {
    const item = itemsById[list[0].inventoryItemId];
    const qty = item ? fmtQtyOf(list[0].qtyBase, item) : `${r3(list[0].qtyBase)} ${list[0].baseUnit || ''}`.trim();
    return `${qty} of ${item?.name || list[0].nameSnapshot || 'stock'} moved from ${fromName || 'No area'} to ${toName || 'No area'}`;
  }
  return `${list.length} lines moved from ${fromName || 'No area'} to ${toName || 'No area'}`;
}

/** Ledger notes carry the reference, so Movements shows "Transfer TR-ABC123" on both legs. */
export const transferNote = (reference) => `Transfer ${reference || ''}`.trim();
