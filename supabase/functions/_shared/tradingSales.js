// tradingSales.js: one closed check's sales for the Daily trading (P&L) report.
//
// 27 Sep 2026 (v5.9.98): at a UK venue the subtotal is shelf prices, which already include
// VAT, so gross = subtotal + VAT counted the VAT twice.
//
// 27 Sep 2026 (v5.9.99): closed_checks.subtotal is shelf prices BEFORE discounts on every
// surface, so the report showed a 50% staff discount or a 100% comp as full price sales. The
// basis is now the goods the customer actually paid for, read the way the accounting day layer
// reads a check (_shared/accountingDay.js checkTenderParts, what Xero is posted from):
//
//   gross = the money tenders' sales: the bill money each took, less its share of service.
//           Tax is inside it (UK VAT and US added-on tax alike), tips are not. Card, cash,
//           gift card, booking deposit, a channel payment and an old split's unallocated
//           money count. Loyalty rewards and promo codes are discounts, never takings.
//   vat   = the check's tax (tax_amount, else the legacy fallback total - subtotal - service
//           - tip) spread over its tenders in proportion, the money tenders' share. From
//           v5.9.98 a UK check's tax_amount is the VAT on what it charged.
//   net   = gross - vat.
//
// A check whose own recorded discounts cover its whole subtotal charged nothing, so gross, VAT
// and net are 0 whatever its tenders say. Before v5.9.97 a 100% comp recorded total = subtotal
// and a cash tender for money never taken (7 Coffee Boy Leeds checks, 26 and 27 Sep 2026).
//
// Rows from before closed_checks.tenders (v5.9.11) are read by the accounting layer's legacy
// rules (kiosk and online credits from their own fields, composite methods, one unallocated
// tender for an old split). A delivery fee the customer paid counts, as it does there.
//
// 28 Sep 2026 (v5.10.1): refunds are taken off, on the day of the REFUND (refunds[].timestamp),
// never the day the check closed, read by the accounting layer's refundParts: the money that
// went back less its tip and service share, with its own VAT. A refund that failed or never
// finished moved no money and takes nothing off. A check that sold nothing (above) refunds
// nothing either. tradingDays sums sales and refunds per day with a day rule the caller passes
// (dayOf), so the report and its tests share one piece of maths.
//
// 28 Sep 2026 (v5.10.1, Peter's call): a day is the venue BUSINESS day (platform
// locations.business_day_start, 06:30 at Coffee Boy), the day Sales summary and Xero use, not
// midnight. The rota keeps its own shift_date (the day the manager planned the shift for). A
// timesheet counts on the business day MOST of the shift falls in (timesheetDayMs, the middle
// of the shift), so an opener who clocks in at 06:00 for a 06:30 day stays on that day and a
// closer working 18:00 to 02:00 stays on the night.
//
// PURE: imports only accountingDay.js (pure as well); runs under node --test and in Deno.

import { checkTenderParts, refundParts, isVoidedCheck, MONEY_KINDS, toMinor } from './accountingDay.js';

/** The check's recorded discounts (closed_checks.discounts[].amount, major units) in minor units. */
export function recordedDiscountMinor(row) {
  const list = Array.isArray(row?.discounts) ? row.discounts : [];
  return list.reduce((s, d) => s + Math.max(0, toMinor(d?.amount)), 0);
}

/** True when the check's own discounts cover its whole subtotal: it charged nothing for goods. */
export function chargedNothing(row) {
  const sub = toMinor(row?.subtotal);
  return sub > 0 && recordedDiscountMinor(row) >= sub;
}

/**
 * @param {any} row  a closed_checks row: subtotal, total, tax_amount, service, tip, discounts,
 *                   tenders, and for rows before tenders: method, payment_method, source,
 *                   gift_card, loyalty, promo, payment_intents, processor
 * @returns {{ net: number, vat: number, gross: number }}  major units, each a whole number of pence
 */
export function checkSalesParts(row) {
  const { sales, tax } = checkSalesMinor(row);
  return { net: (sales - tax) / 100, vat: tax / 100, gross: sales / 100 };
}

// The money parts' sales and tax, minor units. Loyalty and promo parts are discounts.
function moneyMinor(parts) {
  let sales = 0, tax = 0;
  for (const p of parts) {
    if (!MONEY_KINDS.has(p.kind)) continue;
    sales += p.sales;
    tax += p.tax;
  }
  return { sales, tax };
}

function checkSalesMinor(row) {
  if (chargedNothing(row)) return { sales: 0, tax: 0 };
  return moneyMinor(checkTenderParts(row || {}).parts);
}

/**
 * One refunds[] entry of a check, as the report takes it off.
 *   atMs     when the refund happened (refunds[].timestamp), else the check's close time
 *   skipped  true when no money went back (failed, still pending, nothing to give back, or a
 *            check that sold nothing)
 * The amounts are what went back for goods: tax inside, tip and service share out, loyalty and
 * promo credit put back on a full refund left out (they were never takings).
 * @returns {{ atMs: number|null, skipped: boolean, net: number, vat: number, gross: number }} major units
 */
export function refundSalesParts(entry, row) {
  const { atMs, skipped, sales, tax } = refundSalesMinor(entry, row);
  return { atMs, skipped, net: (sales - tax) / 100, vat: tax / 100, gross: sales / 100 };
}

function refundSalesMinor(entry, row) {
  const r = refundParts(entry, row || {});
  const closed = Date.parse(row?.closed_at);
  const atMs = r.atMs ?? (Number.isFinite(closed) ? closed : null);
  if (r.skipped || chargedNothing(row)) return { atMs, skipped: true, sales: 0, tax: 0 };
  return { atMs, skipped: false, ...moneyMinor(r.parts) };
}

/**
 * Sales and refunds per day, the Daily trading report's sales lines.
 *   saleRows    closed_checks rows that closed in the range (read with the columns above)
 *   refundRows  closed_checks rows carrying refunds, whenever they closed (plus `refunds`)
 *   dayOf       (ms) => 'YYYY-MM-DD', the day an instant belongs to (_shared/businessDay.js)
 * A sale counts on the day its check closed, a refund on the day it was made. Voided checks
 * count for neither. A row read twice counts once.
 * Per day, major units: gross (sales inc VAT, before refunds), refunds (inc VAT), sales_vat,
 * refund_vat, vat (sales_vat - refund_vat, the VAT owed), net (gross - refunds - vat), and
 * checks / refund_count.
 * @returns {Record<string, { gross: number, refunds: number, sales_vat: number, refund_vat: number, vat: number, net: number, checks: number, refund_count: number }>}
 */
export function tradingDays({ saleRows = [], refundRows = [], dayOf }) {
  const acc = {};
  const at = (key) => (acc[key] ??= { sales: 0, salesTax: 0, refunds: 0, refundTax: 0, checks: 0, refundCount: 0 });
  const seen = new Set();
  for (const row of saleRows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    if (isVoidedCheck(row)) continue;
    const ms = Date.parse(row.closed_at);
    if (!Number.isFinite(ms)) continue;
    const { sales, tax } = checkSalesMinor(row);
    const d = at(dayOf(ms));
    d.sales += sales; d.salesTax += tax; d.checks += 1;
  }
  const seenRefund = new Set();
  for (const row of refundRows) {
    if (!row || isVoidedCheck(row)) continue;
    const list = Array.isArray(row.refunds) ? row.refunds : [];
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const rid = `${row.id}:${entry.id || i}`;
      if (seenRefund.has(rid)) return;
      seenRefund.add(rid);
      const r = refundSalesMinor(entry, row);
      if (r.skipped || r.atMs == null) return;
      const d = at(dayOf(r.atMs));
      d.refunds += r.sales; d.refundTax += r.tax; d.refundCount += 1;
    });
  }
  const out = {};
  for (const [key, d] of Object.entries(acc)) {
    out[key] = {
      gross: d.sales / 100,
      refunds: d.refunds / 100,
      sales_vat: d.salesTax / 100,
      refund_vat: d.refundTax / 100,
      vat: (d.salesTax - d.refundTax) / 100,
      net: (d.sales - d.salesTax - d.refunds + d.refundTax) / 100,
      checks: d.checks,
      refund_count: d.refundCount,
    };
  }
  return out;
}

// ── labour ──────────────────────────────────────────────────────────────────

/**
 * The instant a timesheet is counted at: the middle of the shift, so it lands on the business
 * day most of the shift falls in. Without a usable clock out, the clock in. null without a
 * clock in.
 */
export function timesheetDayMs(ts) {
  const a = Date.parse(ts?.clock_in);
  if (!Number.isFinite(a)) return null;
  const b = Date.parse(ts?.clock_out);
  if (!Number.isFinite(b) || b <= a) return a;
  return a + Math.floor((b - a) / 2);
}

/**
 * Actual labour per day: the pay of approved and paid timesheets (wf_timesheets.pay_amount),
 * each on the day of timesheetDayMs. Drafts and open timesheets are not labour yet.
 * @returns {Record<string, number>} major units
 */
export function timesheetDays({ timesheets = [], dayOf }) {
  const acc = {};
  const seen = new Set();
  for (const t of timesheets) {
    if (!t || (t.id != null && seen.has(t.id))) continue;
    if (t.id != null) seen.add(t.id);
    if (!['approved', 'paid'].includes(t.status)) continue;
    const ms = timesheetDayMs(t);
    if (ms == null) continue;
    const key = dayOf(ms);
    acc[key] = (acc[key] || 0) + toMinor(t.pay_amount);
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v / 100]));
}
