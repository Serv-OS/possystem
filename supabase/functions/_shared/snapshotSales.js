// snapshotSales.js: a day's takings for the Owner app (owner-snapshot) and the Manager app
// (manager-snapshot). Both read a check exactly as the Daily trading report does.
//
// 27 Sep 2026: both functions took net sales (ex-VAT) = closed_checks.subtotal and gross =
// closed_checks.total. The subtotal is shelf prices BEFORE every discount, and at a UK venue it
// INCLUDES VAT, so net was overstated by the VAT and by every discount and comp. total is gross
// on the till but net of credits on kiosk, online and reader closes. Each check now goes through
// checkSalesParts (_shared/tradingSales.js): gross, VAT and net of what the customer paid for the
// goods, per tender like the accounting day layer; loyalty and promo credit are discounts; a
// check whose recorded discounts cover its whole subtotal sold nothing.
//
// Unchanged: an order is any check that is not voided (a comp is still an order, at £0), and
// tips are the check's own tip, never sales.
//
// PURE: imports only tradingSales.js and accountingDay.js (both pure); runs under node --test
// and in Deno.

import { checkSalesParts, refundSalesParts } from './tradingSales.js';
import { isVoidedCheck, checkTaxRecorded } from './accountingDay.js';

// The columns checkSalesParts reads a check's tenders from (rows from before tenders included),
// plus discounts for a 100% comp, voided and status, and id and closed_at to page and bucket by.
// 8 Oct 2026: ref and refunds too, so a sale with no VAT can be named and a refund made on the
// day can come off the day (addRefundSales), as Daily trading and Xero take it.
export const SALES_CHECK_COLS = 'id, ref, closed_at, subtotal, total, tax_amount, service, tip, status, voided, discounts, refunds, tenders, method, payment_method, source, processor, gift_card, loyalty, promo, payment_intents';

/** A day's running figures, major units. */
export function emptySales() {
  return { net: 0, vat: 0, gross: 0, orders: 0, tips: 0, refunds: 0, refund_vat: 0, vat_missing: 0, vat_missing_refs: [] };
}

/** Adds one closed check to `agg`. A voided check adds nothing; returns whether it counted. */
export function addCheckSales(agg, row) {
  if (isVoidedCheck(row)) return false;
  const p = checkSalesParts(row);
  agg.net += p.net;
  agg.vat += p.vat;
  agg.gross += p.gross;
  agg.orders += 1;
  agg.tips += Number(row?.tip) || 0;
  // 8 Oct 2026 (the VAT audit): money taken and no VAT recorded counts 0 VAT and is named.
  if (p.gross > 0 && !checkTaxRecorded(row)) {
    agg.vat_missing = (agg.vat_missing || 0) + 1;
    if (!Array.isArray(agg.vat_missing_refs)) agg.vat_missing_refs = [];
    if (agg.vat_missing_refs.length < 25) agg.vat_missing_refs.push(row?.ref || row?.id);
  }
  return true;
}

/**
 * 8 Oct 2026: takes one refund entry off `agg` (the day the REFUND was made, the caller's
 * choice), by the accounting layer's rule (tradingSales.refundSalesParts): the goods money that
 * went back less tip and service, with its VAT. A refund that moved no money takes nothing off.
 * Returns whether it counted. The Owner and Manager apps then agree with Daily trading and
 * Xero on VAT and net sales after refunds.
 */
export function addRefundSales(agg, entry, row) {
  if (isVoidedCheck(row)) return false;
  const r = refundSalesParts(entry, row);
  if (r.skipped) return false;
  agg.net -= r.net;
  agg.vat -= r.vat;
  agg.gross -= r.gross;
  agg.refunds = (agg.refunds || 0) + r.gross;
  agg.refund_vat = (agg.refund_vat || 0) + r.vat;
  return true;
}

/** The instant (ms) a refund entry was made, else the check's close time, else null. */
export function refundMadeAt(entry, row) {
  for (const c of [entry?.timestamp, entry?.at, entry?.created_at]) {
    if (c == null || c === '') continue;
    const ms = typeof c === 'number' ? c : /^\d+$/.test(String(c)) ? Number(c) : Date.parse(c);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const closed = Date.parse(row?.closed_at);
  return Number.isFinite(closed) ? closed : null;
}
