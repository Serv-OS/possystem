// src/lib/stock/alignTwin.js: the JS twin of the Stock and GP day figures after Reports align (v5.11.99,
// supabase/migrations/20261029a_OPS_reports_align.sql), for the cross report parity test
// (src/lib/reportsAlign.test.js). Nothing in the app reads it: the database answers Stock and GP. It says in
// a few lines what the SQL does, so the parity test can hold the SQL's RULE to the P&L's on any data, and
// the harness (supabase/tests/stock_native/align.mjs) holds the SQL itself to the same rows.
//
// Per venue business day (dayOf), the SQL's rules:
//   net     sales_day_sums v3: the one sales rule (checkSalesParts) over the checks that closed that day,
//           voided and demo checks never, LESS the refunds MADE that day by the refund rule
//           (refundSalesParts; each refunds[] entry once, by its id else its place), ex VAT
//   theo    the sold lines' cost on the day the check closed (the sale's own takes: here its
//           closed_check SALE_DEPLETION rows), voided and demo checks never, LESS what refunds gave back
//           to the ledger that day (the unsale: SALE_DEPLETION from closed_check_refund, a void's
//           unsale and demo rows left out) (stock_rp__site_figures)
//   waste   the ledger's WASTE rows that day, demo left out (stock_report_waste, the dashboard)
//   labour  approved and paid timesheets' pay on the day the middle of the shift falls in (stock_rp__labour)
//   gp_after = net - theo; gp_before = gp_after + comps (the cost of comp, staff and loyalty plates)
//
// PURE: runs under node --test.

import { checkSalesParts, refundSalesParts } from '../../../supabase/functions/_shared/tradingSales.js';
import { isVoidedCheck, toMinor } from '../../../supabase/functions/_shared/accountingDay.js';
import { isDemoCheck, isDemoStockKey } from '../../../supabase/functions/_shared/demoHistory.js';

const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };

/** The middle of a shift to the millisecond (stock_rp__labour), else its clock in; null without one. */
function shiftMiddleMs(t) {
  const a = Date.parse(t?.clock_in);
  if (!Number.isFinite(a)) return null;
  const b = Date.parse(t?.clock_out);
  return Number.isFinite(b) && b > a ? a + Math.floor((b - a) / 2) : a;
}

/**
 * @param {object} a
 * @param {any[]} a.checks      closed_checks rows of one venue (refunds inside)
 * @param {any[]} a.movements   stock_movements rows: value_delta, occurred_at, movement_type, source_type, source_id, idempotency_key
 * @param {any[]} a.timesheets  wf_timesheets rows
 * @param {(ms: number) => string} a.dayOf
 * @param {(row: any) => boolean} [a.isComp]  the checks whose plates are loyalty, staff or comps
 * @returns {Record<string, { net: number, theo: number, waste: number, labour: number, comps: number, gp_after: number, gp_before: number }>}
 */
export function stockGpDays({ checks = [], movements = [], timesheets = [], dayOf, isComp = () => false }) {
  const net = {}, theo = {}, waste = {}, labour = {}, comps = {};
  const days = new Set();
  const live = new Map();
  for (const c of checks) if (c && !isDemoCheck(c) && !isVoidedCheck(c)) live.set(c.id, c);
  for (const c of live.values()) {
    const ms = Date.parse(c.closed_at);
    if (!Number.isFinite(ms)) continue;
    const d = dayOf(ms); days.add(d);
    add(net, d, toMinor(checkSalesParts(c).net));
  }
  const seen = new Set();
  for (const c of live.values()) {
    (Array.isArray(c.refunds) ? c.refunds : []).forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const key = `${c.id}:${e.id || i}`;
      if (seen.has(key)) return;
      seen.add(key);
      const r = refundSalesParts(e, c);
      if (r.skipped || r.atMs == null) return;
      const d = dayOf(r.atMs); days.add(d);
      add(net, d, -toMinor(r.net));
    });
  }
  for (const m of movements) {
    if (!m || isDemoStockKey(m.idempotency_key)) continue;
    const v = Number(m.value_delta) || 0;
    if (m.movement_type === 'WASTE') { const d = dayOf(Date.parse(m.occurred_at)); days.add(d); add(waste, d, -v); continue; }
    if (m.movement_type !== 'SALE_DEPLETION') continue;
    if (m.source_type === 'closed_check') {
      const c = live.get(m.source_id);
      if (!c) continue;   // a voided or demo check's sale is in no day total
      const d = dayOf(Date.parse(c.closed_at)); days.add(d);
      add(theo, d, -v);
      if (isComp(c)) add(comps, d, -v);
    } else if (m.source_type === 'closed_check_refund') {
      const k = String(m.idempotency_key || '');
      if (/^(undo:)?unsale:.*:void:/.test(k)) continue;
      const d = dayOf(Date.parse(m.occurred_at)); days.add(d);
      add(theo, d, -v);
    }
  }
  for (const t of timesheets) {
    if (!t || !['approved', 'paid'].includes(t.status)) continue;
    const ms = shiftMiddleMs(t);
    if (ms == null) continue;
    const d = dayOf(ms); days.add(d);
    add(labour, d, toMinor(t.pay_amount));
  }
  const out = {};
  for (const d of days) {
    const n = (net[d] || 0) / 100, th = theo[d] || 0;
    out[d] = { net: n, theo: th, waste: waste[d] || 0, labour: (labour[d] || 0) / 100, comps: comps[d] || 0, gp_after: n - th, gp_before: n - th + (comps[d] || 0) };
  }
  return out;
}
