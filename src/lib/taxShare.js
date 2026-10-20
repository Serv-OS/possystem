// taxShare.js: a tax record for a SHARE of a bill, and which records a report must take as booked.
//
// Moved here from headlessTax.js (27 Sep 2026) so the check totals seam (payments/checkTotals.js)
// can scale inclusive VAT by the bill's discounts without importing headlessTax, which imports
// checkTotals. PURE apart from taxRule.js (itself import free), runs under node --test.
//
// A record is scaled when the VAT booked is only part of the tax on the goods listed:
//   - a discounted UK bill (inclusive VAT on what was charged, computeCheckTotals);
//   - a 100% comp (share 0, headlessTax.taxForChargedGoods);
//   - a QR tab whose card capture came up short (headlessTax.qrCloseTax).
// Scaled records carry `share`. A report that recomputes UK VAT from the items (recordedCheckTax,
// the History reprint) would book the whole undiscounted VAT again, so it takes these as booked.

import { roundVat } from './taxRule.js';
import { chargedLineValues, sharesDiffer } from '../../supabase/functions/_shared/lineCharged.js';

// 8 Oct 2026: the one rounding rule (half up to the penny on the true value), as every channel.
const round2 = (n) => roundVat(n) ?? 0;

/** A frozen breakdown is usable when it carries a real number for the total tax. */
export function isUsableBreakdown(b) {
  return !!b && typeof b === 'object' && b.totalTax != null && Number.isFinite(Number(b.totalTax));
}

/**
 * A tax record for a share of a bill (0..1): every figure scaled. Per item detail is dropped
 * (lineTaxes, serviceTax, deliveryTax would not add up to the share); the named v2 lines are
 * scaled with the rest, so a receipt still prints them. For a QR tab whose card capture came up
 * short, the check books only what the card took, so it books only that share of the VAT; the
 * rest is taken on the till as its own sale, which books its own (27 Sep 2026, review of the
 * Leeds fix).
 */
export function scaleTaxRecord(t, share) {
  if (!isUsableBreakdown(t)) return null;
  const f = Math.max(0, Math.min(1, Number(share)));
  if (!Number.isFinite(f)) return null;
  if (f === 1) return t;
  const out = {
    ...t,
    subtotal: (Number(t.subtotal) || 0) * f,
    totalTax: round2(Number(t.totalTax) * f),
    total: (Number(t.total) || 0) * f,
    exclusiveTax: round2((Number(t.exclusiveTax) || 0) * f),
    breakdown: Array.isArray(t.breakdown) ? t.breakdown.map((b) => ({ ...b, tax: (Number(b.tax) || 0) * f, net: (Number(b.net) || 0) * f, gross: (Number(b.gross) || 0) * f })) : [],
    share: f,
  };
  delete out.lineTaxes;
  delete out.serviceTax;
  delete out.deliveryTax;
  if (t.taxV2 && typeof t.taxV2 === 'object' && Array.isArray(t.taxV2.lines)) {
    out.taxV2 = {
      ...t.taxV2,
      lines: t.taxV2.lines.map((l) => (l && typeof l === 'object' ? { ...l, amount: (Number(l.amount) || 0) * f } : l)),
      exclusiveTaxTotal: (Number(t.taxV2.exclusiveTaxTotal) || 0) * f,
      inclusiveExtractedTotal: (Number(t.taxV2.inclusiveExtractedTotal) || 0) * f,
    };
  } else {
    delete out.taxV2;
  }
  return out;
}

/**
 * 27 Sep 2026: inclusive VAT on the goods a bill CHARGED. The tax seam extracts inclusive VAT from
 * price x qty (inclusive lines never read the check basis), so a bill discounted by half booked the
 * VAT on the full price. An inclusive-only result is scaled by charged / goods (goods: the lines
 * undiscounted, price x qty; charged: what the bill charges for them after its discounts).
 * Unchanged (the same object) when anything is added on (US tax already carries the basis), when
 * nothing was taken off, or when the figures are not usable.
 */
export function inclusiveTaxOnCharged(tax, goods, charged) {
  if (!isUsableBreakdown(tax) || tax.hasExclusiveTax) return tax;
  const g = Number(goods);
  const c = Number(charged);
  if (!(g > 0) || !Number.isFinite(c) || !(c < g)) return tax;
  return scaleTaxRecord(tax, Math.max(0, c) / g) || tax;
}

/**
 * v5.11.81 (channel parity: "a targeted discount takes VAT off its own lines' rates only"): UK VAT
 * on what each LINE was charged. A discount that names its lines (an item discount, a deal's
 * appliedItems) comes off those lines; the rest is spread pro rata (_shared/lineCharged.js, the tax
 * basis's own steps). When every line keeps the same share, or the bill has one rate, it is exactly
 * inclusiveTaxOnCharged (the same object or the same scaled record, byte for byte). Otherwise the
 * VAT is worked out again on the charged lines (`retax(lines)`: the seam over the lines at what
 * each was charged) and the record is marked as a share of the goods listed (booked, never redone
 * from the items).
 * @param tax        the seam's record over the lines at full price
 * @param items      the bill's lines (voided ones are left out here)
 * @param discounts  the check's discounts (manual and deals; never promo or loyalty credits)
 * @param charged    what the bill charges for the goods (computeCheckTotals discountedSub)
 * @param retax      (lines) => the seam's record for those lines
 * @param goodsIn    the goods the caller always scaled by (optional; else the lines' own), so the
 *                   one share answer stays the caller's old figure byte for byte
 */
export function inclusiveTaxOnChargedLines(tax, items, discounts, charged, retax, goodsIn = null) {
  if (!isUsableBreakdown(tax) || tax.hasExclusiveTax) return tax;
  const live = (Array.isArray(items) ? items : []).filter((i) => i && !i.voided);
  const goods = goodsIn != null && Number.isFinite(Number(goodsIn)) ? Number(goodsIn) : linesGoods(live);
  const c = Number(charged);
  if (!(goods > 0) || !Number.isFinite(c) || !(c < goods)) return tax;
  const rated = (Array.isArray(tax.breakdown) ? tax.breakdown : []).filter((b) => b && b.rate);
  const values = chargedLineValues(live, discounts);
  if (rated.length <= 1 || !sharesDiffer(values) || typeof retax !== 'function') return inclusiveTaxOnCharged(tax, goods, c);
  let t2 = null;
  try {
    t2 = retax(live.map((i, n) => {
      const { discount: _own, ...rest } = i;
      void _own;
      return { ...rest, price: values.net[n] / (i.qty || 1) };
    }));
  } catch { t2 = null; }
  if (!isUsableBreakdown(t2) || t2.hasExclusiveTax) return inclusiveTaxOnCharged(tax, goods, c);
  const out = { ...t2, totalTax: round2(Number(t2.totalTax)), exclusiveTax: 0, share: Math.max(0, Math.min(1, c / goods)), byLine: true };
  delete out.lineTaxes;
  delete out.serviceTax;
  delete out.deliveryTax;
  return out;
}

/** The undiscounted goods of a list of lines (price x qty, voided lines left out), as the seam taxes them. */
export function linesGoods(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && !i.voided)
    .reduce((s, i) => s + (Number(i.price) || 0) * (i.qty || 1), 0);
}

/** True when this record books only a share of the tax on its goods (scaleTaxRecord stamped it). */
export function isScaledTaxRecord(t) {
  return isUsableBreakdown(t) && t.share != null && t.share !== '' && Number.isFinite(Number(t.share));
}

/**
 * The tax a closed check BOOKED, when a report must read it rather than recompute from the items:
 * a check that charged added-on (US) tax (its discounts, service and credits were in the basis,
 * v5.9.12), or a scaled record (discounted UK bill, comp, short capture). Null otherwise: every
 * other inclusive VAT check (and every older row) is recomputed exactly as before.
 */
export function bookedTaxRecord(check) {
  const t = check?.taxBreakdown;
  if (!t || typeof t !== 'object') return null;
  if (t.hasExclusiveTax) return t;
  return isScaledTaxRecord(t) ? t : null;
}
