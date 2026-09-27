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
// PURE: imports only accountingDay.js (pure as well); runs under node --test and in Deno.

import { checkTenderParts, MONEY_KINDS, toMinor } from './accountingDay.js';

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
  if (chargedNothing(row)) return { net: 0, vat: 0, gross: 0 };
  const { parts } = checkTenderParts(row || {});
  let sales = 0, tax = 0;
  for (const p of parts) {
    if (!MONEY_KINDS.has(p.kind)) continue;
    sales += p.sales;
    tax += p.tax;
  }
  return { net: (sales - tax) / 100, vat: tax / 100, gross: sales / 100 };
}
