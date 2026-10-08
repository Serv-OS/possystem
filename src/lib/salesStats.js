// src/lib/salesStats.js: the headline sales figures from closed checks. Moved out of the Back
// Office Sales summary on 28 Sep 2026 so the till can print an X or Z report without loading the
// report screens (SalesSummary.jsx and ZReport.jsx re-export and use it unchanged).
import { refundVatOf, saleGoods } from '../../supabase/functions/_shared/saleVat.js';

// Compute the headline statistics from a list of closed checks.
// Tax prefers the stored tax_amount column (v4.6.19) when present, and falls back
// to the derived (total - subtotal - service - tip) formula for pre-migration rows
// or rows closed without taxRates configured.
// v5.6.79 (#108) — REFUNDS ARE NOW SPLIT THREE WAYS BEFORE THEY HIT THE LADDER.
//
// A refund entry used to be items-only, so subtracting its whole `amount` from a
// subtotal-based gross was arithmetically fine. From v5.6.79 a refund can also
// return the tip and the service charge, and subtracting THAT from gross would
// over-state the deduction and stop the ladder reconciling — while "plus Service"
// and "plus Tips" below it still added back money that had gone back to the
// customer. The Z report reads this same function, so it would have been wrong on
// the fiscal document too.
//
// Each portion is now netted against the line it actually belongs to:
//   items portion   → reduces net sales (as before)
//   service portion → reduces Service
//   tip portion     → reduces Tips
//   tax portion     → reduces Tax, when the refund recorded one
// Legacy entries have no split and read as items-only, which is what they were.
// 8 Oct 2026 (the VAT audit): the VAT of a sale is read by the one rule every report shares
// (supabase/functions/_shared/saleVat.js): a refund whose entry saved no VAT figure (a refund made
// on a till that did not make the sale) gives back its share of the sale's VAT, as Xero and Daily
// trading already took it; a sale with goods and NO VAT recorded is counted 0 and NAMED
// (vatMissing), never a silent 0. The legacy fallback (total - subtotal - service - tip) stays for
// a row from before tax_amount existed; at a UK venue it is 0, which is why the sale is named.
export function computeSalesStats(checks) {
  let gross=0, discounts=0, refunds=0, voids=0, service=0, tips=0, taxTotal=0, total=0, covers=0, count=0;
  let taxStored=0, taxDerived=0;  // diagnostic split
  let deliveryFees=0;             // v5.5.853: customer-facing delivery charges (POS/online/catering + channel)
  let refundsItems=0, refundsTip=0, refundsService=0, refundsTax=0;
  const vatMissing = [];          // 8 Oct 2026: sales with goods and no VAT recorded, named
  let refundsTaxEstimated = 0;    // 8 Oct 2026: refund entries whose VAT was pro rated here
  (checks||[]).forEach(c => {
    const sub = c.subtotal || 0;
    const tip = c.tip || 0;
    const svc = c.service || 0;
    const tot = c.total || 0;
    let tax;
    if (c.taxAmount != null) { tax = c.taxAmount; taxStored += tax; }
    else {
      tax = Math.max(0, tot - sub - svc - tip); taxDerived += tax;
      if (c.status !== 'voided' && saleGoods(c) > 0) vatMissing.push({ id: c.id, ref: c.ref, total: tot });
    }
    const dDiscounts = (c.discounts||[]).reduce((s,d) => s + (d.amount || d.value || 0), 0);
    let dRefunds=0, dRefTip=0, dRefSvc=0, dRefTax=0;
    (c.refunds||[]).forEach(r => {
      const amt = Number(r.amount) || 0;
      const rt  = Number(r.tipAmount) || 0;
      const rs  = Number(r.serviceAmount) || 0;
      dRefunds += amt; dRefTip += rt; dRefSvc += rs;
      const rv = refundVatOf(r, c);
      if (rv.estimated && !rv.noVat) refundsTaxEstimated += 1;
      dRefTax  += rv.amount;
    });
    gross      += sub;
    discounts  += dDiscounts;
    refunds    += dRefunds;
    refundsItems   += dRefunds - dRefTip - dRefSvc;
    refundsTip     += dRefTip;
    refundsService += dRefSvc;
    refundsTax     += dRefTax;
    if (c.status === 'voided') voids += tot;
    service    += svc - dRefSvc;
    tips       += tip - dRefTip;
    deliveryFees += Number(c.customer?.delivery_fee ?? c.deliveryFee) || 0;
    taxTotal   += tax - dRefTax;
    total      += tot;
    if (c.status !== 'voided') { covers += c.covers || 1; count += 1; }
  });
  const net = gross - discounts - voids - refundsItems;
  return {
    gross, discounts, voids, refunds, refundsItems, refundsTip, refundsService, refundsTax,
    service, tips, deliveryFees, tax: taxTotal, taxStored, taxDerived, total, covers, count, net,
    vatMissing, vatMissingCount: vatMissing.length, refundsTaxEstimated,
  };
}

/** "1 sale has no VAT recorded: QR-4OGI7", or '' when every sale booked its VAT. */
export function vatMissingLine(stats) {
  const list = stats?.vatMissing || [];
  if (!list.length) return '';
  const refs = list.slice(0, 12).map((x) => x.ref || x.id).filter(Boolean);
  const more = list.length > refs.length ? ` and ${list.length - refs.length} more` : '';
  return `${list.length === 1 ? '1 sale has' : `${list.length} sales have`} no VAT recorded: ${refs.join(', ')}${more}`;
}
