// src/lib/manager/kitchen.js
//
// Pure stock-to-order + batch-cook status for the ServOS Manager Kitchen tab. No I/O — unit-tested.
// Reads from the existing stock system (inventory_items + par_levels + eighty_six) and the new
// prep_schedule table; this file only decides what's below par + each batch's status.
//
// stockItem: { itemId, name, onHand, par, reorderPoint?, supplier, eightySixed }
// batch:     { id, name, dueAtMs, completedAtMs|null, plannedQty, actualQty?, assignee }

/** Items needing a reorder: 86'd, or on-hand below par. Enriched + sorted (86 first, then biggest gap). */
export function belowPar(items) {
  return (items || [])
    .filter((i) => i && (i.eightySixed || (i.par != null && Number(i.onHand) < Number(i.par))))
    .map((i) => ({
      ...i,
      shortfall: i.par != null ? Math.max(0, Number(i.par) - Number(i.onHand || 0)) : 0,
      belowReorder: i.reorderPoint != null && Number(i.onHand || 0) <= Number(i.reorderPoint),
    }))
    .sort((a, b) => ((b.eightySixed ? 1 : 0) - (a.eightySixed ? 1 : 0)) || (b.shortfall - a.shortfall));
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
