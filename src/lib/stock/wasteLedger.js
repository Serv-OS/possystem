// src/lib/stock/wasteLedger.js: the Wastage log's money, from the stock ledger (v5.11.99, Reports align).
//
// WHY ONE SOURCE. Waste was valued from two places: the Wastage log and the Stock and GP Waste report
// added up waste_events.cost_value (what the screen worked out when the waste was typed), while the
// Stock and GP dashboard, the league, the Owner app and Daily trading added up the stock ledger's WASTE
// movements. The two drift: a waste row can carry a cost with no movement behind it (three dish rows at
// the test company did, 3.42, 0.46 and 4.05, written straight into waste_events by a demo file), a
// movement is valued at the item's cost when it posts while the row keeps the screen's rounding, and an
// undone refund deletes its row but leaves its movements (which net to zero). The ledger is what stock
// value, on hand and the gap are made of, so it is the source of truth for what waste cost: every
// report now values waste from it, demo movements left out (demoHistory.js), on the venue business day.
// waste_events stays the list of WHO wasted WHAT and WHY; each row's cost is the ledger's for that row.
//
// Linking a ledger row to its waste row:
//   source_type 'waste'               source_id is the waste row's id (stock_record_waste, every screen)
//   source_type 'closed_check_refund' the refunded food (key 'waste:<check>:<refund>:<item>') and
//   or 'closed_check_void'            a voided order's made food (key 'waste:<check>:tomb:<item>'): the
//                                     waste row the drainer wrote beside it, same item, same instant
//                                     (the database links them by md5 of the key, stock_report_waste)
// A movement with no row (none today) still counts in the total and is reported as unlisted.
//
// PURE: runs under node --test and in the browser.

import { isDemoStockKey } from '../../../supabase/functions/_shared/demoHistory.js';

const msOf = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const minor = (v) => Math.round((Number(v) || 0) * 10000);   // 4 decimal places, the ledger's own

/**
 * @param {object} a
 * @param {any[]} a.events     waste rows (lib/stock/waste.js fetchWaste: id, inventoryItemId, occurredAt, source, costValue ...)
 * @param {any[]} a.movements  WASTE ledger rows of the same window: source_type, source_id, idempotency_key,
 *                             inventory_item_id, value_delta, occurred_at
 * @returns {{ rows: any[], total: number, demoLeft: number, unlisted: number, unlistedValue: number }}
 *   rows   the waste rows to list, demo ones left out, each with ledgerCost (the ledger's value of that
 *          row, positive, null when no stock came off) and onLedger
 *   total  the window's waste at cost by the ledger, demo left out (major units, 2 places)
 */
export function wasteFromLedger({ events = [], movements = [] } = {}) {
  const bySource = new Map();     // waste row id -> { v, demo, real }
  const besideRows = new Map();   // item|instant -> waste row id (the rows the drainer writes beside its movement)
  for (const e of events || []) {
    if (!e || !['refund', 'void'].includes(e.source) || !e.inventoryItemId) continue;
    const t = msOf(e.occurredAt);
    if (t != null) besideRows.set(`${e.inventoryItemId}|${t}`, e.id);
  }
  let total = 0, demoLeft = 0, unlisted = 0, unlistedValue = 0;
  for (const m of movements || []) {
    if (!m || (m.movement_type && m.movement_type !== 'WASTE')) continue;
    const demo = isDemoStockKey(m.idempotency_key);
    const v = -minor(m.value_delta);
    let rid = null;
    if (m.source_type === 'waste' && m.source_id) rid = String(m.source_id);
    else if (m.source_type === 'closed_check_refund' || m.source_type === 'closed_check_void') rid = besideRows.get(`${m.inventory_item_id}|${msOf(m.occurred_at)}`) || null;
    if (demo) demoLeft += 1; else total += v;
    if (rid == null) { if (!demo) { unlisted += 1; unlistedValue += v; } continue; }
    const s = bySource.get(rid) || { v: 0, demo: 0, real: 0 };
    if (demo) s.demo += 1; else { s.v += v; s.real += 1; }
    bySource.set(rid, s);
  }
  const rows = [];
  for (const e of events || []) {
    if (!e) continue;
    const s = bySource.get(String(e.id));
    // a row whose every movement is demo history is demo history itself
    if (s && s.demo > 0 && s.real === 0) continue;
    rows.push({ ...e, onLedger: !!(s && s.real > 0), ledgerCost: s && s.real > 0 ? Math.round(s.v / 100) / 100 : null });
  }
  return { rows, total: Math.round(total / 100) / 100, demoLeft, unlisted, unlistedValue: Math.round(unlistedValue / 100) / 100 };
}
