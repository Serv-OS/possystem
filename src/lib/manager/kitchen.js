// src/lib/manager/kitchen.js
//
// Pure stock-to-order + batch-cook status for the ServOS Manager Kitchen tab. No I/O — unit-tested.
// Reads from the existing stock system (inventory_items + par_levels + eighty_six) and the new
// prep_schedule table; this file only decides what's below par + each batch's status.
//
// stockItem: { itemId, name, onHand, unit, par, reorderPoint?, supplier, supplierId, eightySixed, pack? }
//   pack (v5.11.64, from manager-snapshot): { id, description, packQty, innerQty, innerUnit, perPack, perPackBase?, packPrice, vatRate }
//     perPack is the pack content in the PACK's unit, perPackBase (v5.11.65) the same in the item's base unit
// batch:     { id, name, dueAtMs, completedAtMs|null, plannedQty, actualQty?, assignee }

import { packsForBase } from '../stock/purchasingRules.js';

/** Items needing a reorder: 86'd, or on-hand below par. Enriched + sorted (86 first, then biggest gap). */
export function belowPar(items) {
  return (items || [])
    .filter((i) => i && (i.eightySixed || (i.par != null && Number(i.onHand) < Number(i.par))))
    .map((i) => ({
      ...i,
      shortfall: i.par != null ? roundQty(Math.max(0, Number(i.par) - Number(i.onHand || 0)), i.unit) : 0,
      belowReorder: i.reorderPoint != null && Number(i.onHand || 0) <= Number(i.reorderPoint),
    }))
    .sort((a, b) => ((b.eightySixed ? 1 : 0) - (a.eightySixed ? 1 : 0)) || (b.shortfall - a.shortfall));
}

// Units counted in wholes: a shortfall of 2.4 patties is 3 patties to order. An UNKNOWN unit is
// not in this set on purpose: a phone talking to a snapshot that sends no unit (before the
// manager-snapshot deploy) must print 70.45, not round 70.448 litres UP to 71.
const WHOLE_UNITS = new Set(['each', 'ea', 'unit', 'units', 'pack', 'packs', 'portion', 'portions', 'bottle', 'bottles', 'can', 'cans', 'keg', 'kegs', 'case', 'cases', 'tray', 'trays', 'bag', 'bags', 'box', 'boxes']);
const isWholeUnit = (unit) => WHOLE_UNITS.has(String(unit || '').trim().toLowerCase());

/**
 * A stock quantity rounded for a human: whole numbers for things you count (each, bottles),
 * two decimals for things you weigh or pour (kg, l, g, ml). v5.11.64: the Kitchen tab printed
 * "+70.44800000000001", the raw subtraction, with no unit.
 */
export function roundQty(n, unit) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return isWholeUnit(unit) ? Math.ceil(v - 1e-9) : Math.round(v * 100) / 100;
}

/** "70.45 l", "1080 each", "3 kg": the rounded quantity with its unit when one is known. */
export function qtyText(n, unit) {
  const v = roundQty(n, unit);
  const u = String(unit || '').trim();
  return u ? `${v} ${u}` : String(v);
}

/**
 * How many supplier packs the Raise order sheet starts with for a below par item: the shortfall
 * in base units turned into whole packs (never fewer than one). v5.11.64: the sheet used to start
 * at the shortfall itself, 32 eggs, and the server wrote that as 32 PACKS of 1 x 1 at a price of 0.
 * An item with no pack answers 0: it cannot be ordered from the phone and the sheet says so.
 * v5.11.65: the shortfall is in the item's base unit, so it divides by the pack content in that
 * unit (perPackBase from manager-snapshot). A 4.5 kg shortfall on a 1 x 2.5 kg pack is 2 packs,
 * not 1800. An older snapshot with no perPackBase falls back to perPack (the pack's own unit),
 * which is right whenever the pack unit is the item unit, as the Back Office pack editor enforces.
 */
export function orderPacksFor(item) {
  if (!item?.pack) return 0;
  const per = Number(item.pack.perPackBase) > 0 ? Number(item.pack.perPackBase) : null;
  if (per) return Math.max(1, Math.ceil((Number(item.shortfall) || 0) / per - 1e-9));
  return packsForBase(Number(item.shortfall) || 0, item.pack);
}

/** The order value (ex VAT) of a set of sheet lines: packs x net pack price. */
export function orderValue(lines, packsById) {
  return (lines || []).reduce((s, i) => {
    const n = Number(packsById?.[i.itemId]) || 0;
    const price = Number(i.pack?.packPrice) || 0;
    return s + n * price;
  }, 0);
}

/** Group below-par items by supplier (for raising one PO per supplier). */
export function bySupplier(items) {
  const out = {};
  belowPar(items).forEach((i) => {
    const key = i.supplier || 'Unassigned';
    (out[key] = out[key] || []).push(i);
  });
  return out;
}

/** Batch status → 'done' | 'overdue' | 'due'. Done wins; then overdue if past due + not recorded. */
export function batchStatus(b, nowMs = Date.now()) {
  if (!b) return 'due';
  if (b.completedAtMs != null) return 'done';
  if (b.dueAtMs != null && b.dueAtMs < nowMs) return 'overdue';
  return 'due';
}

/** Group today's batches by status, each with `status`; counts + the not-yet-recorded total. */
export function groupBatches(batches, nowMs = Date.now()) {
  const out = { done: [], overdue: [], due: [] };
  (batches || []).forEach((b) => { const s = batchStatus(b, nowMs); out[s].push({ ...b, status: s }); });
  out.overdue.sort((a, b) => (a.dueAtMs || 0) - (b.dueAtMs || 0));
  out.due.sort((a, b) => (a.dueAtMs || 0) - (b.dueAtMs || 0));
  return { ...out, counts: { done: out.done.length, overdue: out.overdue.length, due: out.due.length }, notRecorded: out.overdue.length + out.due.length };
}

// -- v5.11.96 (multi site stock Drop 3, contract 3.4 and 4.5): the phone's order by line, approvals,
// transfers, shop buys, the fresh close down, forecast edits and the Home needNow rows. Pure. --------

const DAY3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymdOf = (v) => /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));

/** 'Tue' for a 'YYYY-MM-DD' (or the date part of a venue local 'YYYY-MM-DDTHH:MM'). */
export function dowWord(v) {
  const m = ymdOf(v);
  return m ? DAY3[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()] : '';
}

/** 'Wed 22 Oct' for a day. */
export function dayWord(v) {
  const m = ymdOf(v);
  return m ? `${dowWord(v)} ${Number(m[3])} ${MON3[Number(m[2]) - 1]}` : '';
}

/** Minutes as '3 h 20 m' or '45 m'. */
export function leftWords(minutes) {
  const n = Math.max(0, Math.floor(Number(minutes) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? `${h} h ${m} m` : `${m} m`;
}

/**
 * The phone's order by line for a supplier (snapshot kitchen.orderBy row): 'Order by Tue 14:00
 * (in 3 h 20 m)', '(passed)' after the time, '' with no rules. minutesLeft was worked out when the
 * snapshot was made (generatedMs); the minutes since then come off.
 */
export function orderByLine(row, { nowMs = Date.now(), generatedMs = null } = {}) {
  if (!row || !row.deliveryDay) return '';
  const at = String(row.orderByAt || '');
  const hm = row.orderByHm || (at.length >= 16 ? at.slice(11, 16) : '');
  const ymd = row.orderByYmd || at.slice(0, 10);
  let left = row.minutesLeft == null ? null : Number(row.minutesLeft);
  if (left != null && generatedMs != null && Number.isFinite(Number(generatedMs))) left -= Math.floor((nowMs - Number(generatedMs)) / 60000);
  const when = left == null ? '' : left <= 0 ? ' (passed)' : ` (in ${leftWords(left)})`;
  return hm ? `Order by ${dowWord(ymd)} ${hm}${when}` : `Next delivery ${dayWord(row.deliveryDay)}`;
}

/** The words after po.raise: sent, sent for approval, gone to the kitchen, or kept as sent with the reason. */
export function raiseWords(r, { supplier = 'the supplier' } = {}) {
  if (!r || !r.ok) return '';
  if (r.needs_approval) {
    const names = (Array.isArray(r.approvers) ? r.approvers : []).filter(Boolean);
    return `Sent for approval. ${names.length ? `${names.slice(0, 3).join(', ')} can approve it.` : 'Another manager approves it.'} It passes up 60 and 30 minutes before the cut off.`;
  }
  const order = r.reference ? `Order ${r.reference}` : 'The order';
  if (r.internal) return `${order} is with the central kitchen. It arrives as a transfer.`;
  if (r.emailed === false) return `${order} is on order, but the email to ${supplier} did not go: ${r.email_error || 'send failed'}. Phone them.`;
  return `${order} sent to ${supplier}.`;
}

/** Waiting approval rows at the site: '2 orders waiting for approval' or ''. */
export function approvalsLine(approvals) {
  const n = (Array.isArray(approvals) ? approvals : []).filter((a) => a && a.status === 'waiting').length;
  return n ? `${n} order${n === 1 ? '' : 's'} waiting for approval` : '';
}

const NEED_WORDS = {
  count_due: 'Count due today',
  count_missed: 'Count missed',
  transfer_waiting: 'Transfer waiting',
  delivery_overdue: 'Delivery overdue',
};

/**
 * The Home needNow rows from the snapshot's stock alerts (the bell rows): one row per kind, the
 * approvals counted ('2 orders waiting for approval'), 'Order by in 1 hour: <supplier>' as titled.
 * [{ key, words, tone }], at most 6.
 */
export function stockNeedNow(alerts) {
  const list = Array.isArray(alerts) ? alerts : [];
  const out = [];
  const seen = new Set();
  const approvals = new Set(list.filter((a) => /^approval_/.test(String(a?.kind || ''))).map((a) => a.refId || a.id));
  if (approvals.size) out.push({ key: 'approvals', words: `${approvals.size} order${approvals.size === 1 ? '' : 's'} waiting for approval`, tone: 'warn' });
  for (const a of list) {
    const k = String(a?.kind || '');
    if (k === 'order_by') {
      const key = `order_by:${a.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, words: String(a.title || 'Order by in 1 hour'), tone: 'warn' });
    } else if (NEED_WORDS[k] && !seen.has(k)) {
      seen.add(k);
      out.push({ key: k, words: NEED_WORDS[k], tone: k === 'count_due' || k === 'transfer_waiting' ? 'info' : 'warn' });
    }
  }
  return out.slice(0, 6);
}

/** A typed amount in base units at or above 0 ('' or a bad figure is null). */
export function typedBase(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : null;
}

/** transfer.receive lines: what arrived per line (as sent unless typed). */
export function receiveLines(transfer, typed = {}) {
  return (transfer?.lines || []).map((l) => {
    const t = typedBase(typed[l.id]);
    return { line_id: l.id, qty_received_base: t == null ? Number(l.qtyBase) || 0 : t };
  });
}

/** transfer.send / transfer.request lines from the picked rows: [{ <idKey>, qty_base }] above 0. */
export function pickedLines(picked, idKey = 'inventory_item_id') {
  const out = [];
  for (const [id, v] of Object.entries(picked || {})) {
    const q = typedBase(v);
    if (q != null && q > 0) out.push({ [idKey]: id, qty_base: q });
  }
  return out;
}

/** The fresh close down: what is left per item, as waste lines ([{ inventory_item_id, qty_base }] above 0). */
export function closeDownLines(rows, typed = {}) {
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const q = typedBase(typed[r.inventory_item_id]);
    if (q != null && q > 0) out.push({ inventory_item_id: r.inventory_item_id, qty_base: q });
  }
  return out;
}

/** Shop buy lines: [{ inventory_item_id, qty_base, line_total }] with both figures above 0; a bad line is named. */
export function shopBuyLines(rows) {
  const lines = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const q = typedBase(r?.qty);
    const t = typedBase(r?.total);
    if (!r?.itemId) continue;
    if (q == null || q <= 0) return { lines: [], error: `${r.name || 'A line'}: type how much you bought.` };
    if (t == null) return { lines: [], error: `${r.name || 'A line'}: type what it cost.` };
    lines.push({ inventory_item_id: r.itemId, qty_base: q, line_total: t });
  }
  if (!lines.length) return { lines: [], error: 'Add what you bought.' };
  return { lines, error: null, total: Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100 };
}

/** The forecast reasons (contract 4.2): stored value and words. */
export const FORECAST_REASONS = Object.freeze([
  { value: 'weather', label: 'Weather' }, { value: 'local_event', label: 'Local event' }, { value: 'booking', label: 'Pre order or booking' },
  { value: 'promotion', label: 'Promotion' }, { value: 'closure', label: 'Closure' }, { value: 'other', label: 'Other' },
]);

/**
 * forecast.edit days from the phone's edits: { [day]: { amount, reason, note } } against the saved days.
 * A changed day needs a reason ('Pick a reason for Wed 22 Oct.'), the database's own words. Returns { days, error }.
 */
export function forecastDays(saved, edits) {
  const byDay = {};
  for (const d of (Array.isArray(saved) ? saved : [])) byDay[d.day] = d;
  const days = [];
  for (const [day, e] of Object.entries(edits || {})) {
    const amount = typedBase(e?.amount);
    if (amount == null) return { days: [], error: `Type a figure for ${dayWord(day)}.` };
    const before = byDay[day]?.amount;
    if (before != null && Math.abs(Number(before) - amount) < 0.005 && (e?.reason || null) === (byDay[day]?.reason || null)) continue;
    if (!e?.reason) return { days: [], error: `Pick a reason for ${dayWord(day)}.` };
    days.push({ day, amount, reason: e.reason, reason_note: e.note ? String(e.note).slice(0, 200) : null });
  }
  return { days, error: null };
}
