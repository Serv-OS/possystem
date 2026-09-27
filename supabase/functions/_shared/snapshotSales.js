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

import { checkSalesParts } from './tradingSales.js';
import { isVoidedCheck } from './accountingDay.js';

// The columns checkSalesParts reads a check's tenders from (rows from before tenders included),
// plus discounts for a 100% comp, voided and status, and id and closed_at to page and bucket by.
export const SALES_CHECK_COLS = 'id, closed_at, subtotal, total, tax_amount, service, tip, status, voided, discounts, tenders, method, payment_method, source, processor, gift_card, loyalty, promo, payment_intents';

/** A day's running figures, major units. */
export function emptySales() {
  return { net: 0, vat: 0, gross: 0, orders: 0, tips: 0 };
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
  return true;
}
