// src/lib/displayLines.js
//
// The cart lines the till sends to a customer facing screen (the dedicated customer display and
// the card reader's own screen). PURE, tested in displayLines.test.js.
//
// THE RULES (21 Oct 2026, v5.11.88):
//   * A till line's `price` ALREADY INCLUDES its paid options. store.addItem prices a line from
//     the option sheet's linePrice (lib/tillLine.js tillLineUnitPrice stacks the option surcharge
//     on the resolved price), a reprice keeps `price = unit + modSum` (store/index.js), and the
//     order panel shows `price * qty` with the options listed under it as a breakdown. The
//     customer display and the reader screen used to add the option prices on top of `price`
//     again, so a Latte at 2.20 with a 0.70 option showed 2.90 on the line while the total (from
//     the store) said 2.20. Peter saw it on a Location 1 till.
//   * An item discount lives in `line.discount` ({ type: 'percent' | 'amount', value }) and comes
//     off the line the way the till charges it (lib/payments/checkTotals.js computeCheckTotals,
//     the same maths the order panel draws). The old code read a `discountAmount` field no till
//     line has, so a discounted line showed full price on both screens while the total was right.
//   Now every screen shows the line the till charges.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The quantity a customer screen shows (never below 1). */
export function displayQty(line) {
  return Math.max(1, num(line?.qty) || 1);
}

/**
 * What the till charges for this line: price times quantity, less its item discount. The same
 * rule as computeCheckTotals (lib/payments/checkTotals.js), byte for byte.
 */
export function lineChargedTotal(line) {
  const base = num(line?.price) * displayQty(line);
  const d = line?.discount;
  if (!d) return base;
  return d.type === 'percent' ? base * (1 - num(d.value) / 100) : Math.max(0, base - num(d.value));
}

/** Lines for the dedicated customer display (name, qty, line total, options listed, note). */
export function displayLinesFor(items) {
  return (items || []).filter((i) => i && !i.voided).map((i) => ({
    uid: i.uid,
    name: i.menuName || i.name || 'Item',
    qty: displayQty(i),
    lineTotal: Math.max(0, lineChargedTotal(i)),
    mods: (i.mods || []).map((m) => ({ label: m.label, price: num(m.price) })),
    notes: i.notes || '',
  }));
}

/** Flat lines for a card reader's screen (description, unit amount in minor units, quantity). */
export function readerLinesFor(items) {
  return (items || []).filter((i) => i && !i.voided).map((i) => {
    const qty = displayQty(i);
    return {
      description: String(i.menuName || i.name || 'Item').slice(0, 60),
      amount: Math.max(0, Math.round((lineChargedTotal(i) / qty) * 100)),
      quantity: qty,
    };
  });
}
