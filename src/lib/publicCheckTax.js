// publicCheckTax.js: the VAT a customer page puts on the paid check it sends to the server.
//
// 2 Oct 2026, Coffee Boy Leeds: QR order QR-FAUOB (5.60, paid on the phone) was booked with
// tax_amount 0. The page worked the VAT out correctly and sent the raw figure
// (0.9333333333333327). The server read it through a parser that only accepts 6 decimals and
// answers 0 for anything else, so the check said "zero rated" to every report and to Xero.
// A sale whose VAT happened to be short (3.75 sends 0.625) got through, so it looked random.
// Every online, QR pay now and catering order placed since 20 Sep 2026 went that way.
//
// The server is fixed by supabase/migrations/20261002b_OPS_public_order_vat.sql. This is the
// page's half, and it stands on its own:
//   tax_amount     in pence, rounded exactly as closed_checks.tax_amount (numeric(10,2)) rounds
//                  a till sale's raw figure, so the old server function reads it too.
//   tax_breakdown  the tax engine's own record, the same one the till writes, whenever a rate
//                  was resolved. The Xero daily invoice splits a sale by VAT rate from it
//                  (_shared/accountingDay.js checkRateWeights); without it the split is
//                  estimated from the VAT. Until now a page sent it only for added-on (US) tax.
//                  It is kept by the server only after 20261002b has run.
// A basket with a rate that comes to no VAT (all zero rated) books 0 with its record, as the
// till does. With no rate resolved at all (a venue with no tax set up) nothing is claimed:
// null, as before.
//
//
// AN AUTOMATIC OFFER (review of this fix, 2 Oct 2026). The record sent must describe the bill
// that was CHARGED, in full, or the fix above books a wrong figure where it used to book none:
//   QR      the engine works UK VAT out on the full menu price (VAT inside the price never
//           reads the discount). The page now books the VAT on what was charged, with the
//           till's own rule (offerChargedTax below): 10.00 with 5.00 off books 0.83, not 1.67.
//   Online  already scaled the VAT and each rate by the offer (v5.5.787) but left the record's
//           own subtotal and total at the full price, so the Xero daily invoice read the
//           offer as sales with no VAT rate. offerScaledTax below scales those too.
// Both stamp `share`, as the till's discounted record does, so the Z and Tax reports read the
// VAT that was booked instead of working out the full price's VAT again (taxShare.js).
//
// PURE: no imports beyond taxShare.js and taxRule.js, runs under node --test.

import { isUsableBreakdown, inclusiveTaxOnCharged } from './taxShare.js';
import { roundVat } from './taxRule.js';

/**
 * A money figure rounded to pence. 8 Oct 2026: the one rounding rule every channel uses
 * (taxRule.roundVat, half up on the true value, so 5.85 at 20% inside the price, exactly 0.975,
 * gives 0.98 whatever floating point noise it arrives with). Until then this rounded the
 * shortest decimal form the way the closed_checks column would, which read 0.9749999999999996
 * as 0.97: the same sale was a penny apart depending on which path booked it. Null when the
 * figure is not a finite number. Kept under its old name for the pages that import it.
 */
export function roundToPence(n) {
  return roundVat(n);
}

/**
 * The tax fields of the closed check a customer page sends to place_public_order (and writes
 * itself on the legacy path): { tax_amount } and, when a rate was resolved, { tax_breakdown }.
 * `tax` is a computeOrderTaxUnified result (or a scaled copy of one).
 */
export function publicCheckTaxFields(tax) {
  if (!isUsableBreakdown(tax)) return { tax_amount: null };
  const amount = roundToPence(tax.totalTax);
  const rated = Array.isArray(tax.breakdown) && tax.breakdown.length > 0;
  if (!rated) return { tax_amount: amount > 0 ? amount : null };
  return { tax_amount: amount == null ? null : Math.max(0, amount), tax_breakdown: tax };
}

/**
 * QR pay now: the tax record of a bill with an automatic offer taken off. UK VAT (inside the
 * price) is booked on what was charged, exactly as the till books a discounted bill
 * (payments/checkTotals.js, taxShare.inclusiveTaxOnCharged): `goods` is the lines at full price,
 * `charged` what the bill charges for them after the offer. With no offer it is the SAME object,
 * so an undiscounted sale is sent exactly as before (the page rounds `charged` to pence, which
 * alone must never count as a discount). Added-on (US) tax already carries the offer in its
 * basis and is never scaled.
 */
export function offerChargedTax(tax, goods, charged, offer) {
  if (!(Number(offer) > 0)) return tax;
  return inclusiveTaxOnCharged(tax, goods, charged);
}

/**
 * Online: the tax record scaled by an automatic offer (v5.5.787: offers come off across the
 * goods, so every rate's share is scaled by charged / goods). Moved here from OnlineCheckout
 * with the same sums for the VAT, each rate and the named lines. 2 Oct 2026: the record's own
 * `subtotal` and `total` are scaled too. They were left at the full price, and the Xero daily
 * invoice reads total less the rates' gross as sales with no VAT rate
 * (_shared/accountingDay.js checkRateWeights): 10.00 with 2.00 off posted 1.60 of standard
 * rated sales on the no VAT line. `share` marks it as a record for part of the goods listed.
 */
export function offerScaledTax(tax, scale) {
  if (!tax) return tax;
  return {
    ...tax,
    subtotal: (Number(tax.subtotal) || 0) * scale,
    totalTax: tax.totalTax * scale,
    total: (Number(tax.total) || 0) * scale,
    exclusiveTax: (tax.exclusiveTax || 0) * scale,   // v5.7.31: the charged share scales with the goods discount too
    breakdown: tax.breakdown.map((b) => ({ ...b, tax: b.tax * scale, net: b.net * scale, gross: b.gross * scale })),
    // v5.7.34: the v2 named-lines record scales with the goods discount too: its figures must
    // describe the same discounted bill as the legacy keys.
    ...(tax.taxV2 ? { taxV2: {
      ...tax.taxV2,
      lines: tax.taxV2.lines.map((l) => ({ ...l, amount: l.amount * scale })),
      exclusiveTaxTotal: tax.taxV2.exclusiveTaxTotal * scale,
      inclusiveExtractedTotal: tax.taxV2.inclusiveExtractedTotal * scale,
    } } : {}),
    share: scale,
  };
}
