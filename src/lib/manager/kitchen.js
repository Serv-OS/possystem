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
