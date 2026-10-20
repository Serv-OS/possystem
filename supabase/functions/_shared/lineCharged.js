// supabase/functions/_shared/lineCharged.js
//
// v5.11.81 (channel parity, confirmed minor: "UK VAT on a targeted discount is spread over every
// rate"): what each LINE of a bill was charged, so UK VAT (inside the price) is the VAT inside each
// line's own charged money, at the line's own rate. Pure, no imports: the apps (src/lib/taxShare.js)
// and the daily VAT check (vatRederive.js) load the same file.
//
// Before: a discounted UK bill booked its VAT as the whole bill's VAT times charged / goods, the same
// share on every rate. That is right when the discount is spread over the bill (a 10% check
// discount: every line loses 10%), and wrong when the discount belongs to some lines: a deal or an
// item discount on a 20% burger beside a 0% sandwich took VAT off the 0% line too. Now a discount
// that names its lines (an item discount, a deal's appliedItems) comes off those lines first and
// the rest is spread pro rata, exactly as the tax basis allocates it (src/lib/taxBasis.js
// allocateCheckBasis, the same steps), and each line's VAT is worked out on what it was charged.
// When every line keeps the same share, or the bill has one rate, the answer is the old one (the
// callers keep the old figure then, byte for byte).

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** A line after its own item discount (computeCheckTotals' reducer). */
export function lineAfterOwnDiscount(i) {
  const base = num(i?.price) * (i?.qty || 1);
  const d = i?.discount;
  if (!d) return base;
  return d.type === 'percent' ? base * (1 - num(d.value) / 100) : Math.max(0, base - num(d.value));
}

/** One check discount's money: a percent of the subtotal, else its value (or amount). */
export function checkDiscountMoney(d, subtotal) {
  if (!d) return 0;
  if (d.type === 'percent') return subtotal * num(d.value) / 100;
  return num(d.value ?? d.amount);
}

/**
 * Each live line's charged value. `items` are the bill's LIVE lines (voided removed), `discounts`
 * its check discounts (manual, deals, a delivery partner's offer; never a promo or loyalty credit,
 * which are tenders). Returns { gross, net, subtotal, charged }: gross = price x qty, net = after
 * its own discount and its share of the check discounts.
 */
export function chargedLineValues(items, discounts) {
  const live = Array.isArray(items) ? items : [];
  const gross = live.map((i) => num(i?.price) * (i?.qty || 1));
  const after = live.map(lineAfterOwnDiscount);
  const subtotal = after.reduce((a, b) => a + b, 0);
  const remaining = after.slice();
  let untargeted = 0;
  for (const d of (Array.isArray(discounts) ? discounts : [])) {
    const amt = checkDiscountMoney(d, subtotal);
    if (!(amt > 0)) continue;
    let left = amt;
    if (Array.isArray(d.appliedItems)) {
      for (const ai of d.appliedItems) {
        if (!(left > 0)) break;
        if (ai?.uid == null) continue;
        const idx = live.findIndex((i) => i?.uid != null && i.uid === ai.uid);
        if (idx < 0) continue;
        const take = Math.min(num(ai.saving), remaining[idx], left);
        if (take > 0) { remaining[idx] -= take; left -= take; }
      }
    }
    untargeted += left;
  }
  const rest = remaining.reduce((a, b) => a + b, 0);
  const factor = rest > 0 ? Math.max(0, 1 - untargeted / rest) : 0;
  const net = remaining.map((v) => v * factor);
  return { gross, net, subtotal, charged: net.reduce((a, b) => a + b, 0) };
}

/** True when some lines kept a different share of their money (so one share on every rate is wrong). */
export function sharesDiffer(values) {
  const { gross = [], net = [] } = values || {};
  let first = null;
  for (let n = 0; n < gross.length; n++) {
    if (!(gross[n] > 0)) continue;
    const f = net[n] / gross[n];
    if (first == null) first = f;
    else if (Math.abs(f - first) > 1e-9) return true;
  }
  return false;
}
