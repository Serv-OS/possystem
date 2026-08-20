// src/lib/bookings/packagePricing.js
//
// Package → POS order lines: THE pricing rules for what a seated booking's tab
// starts with (v5.7.21, the Provo incident fix — a £120-per-cover prepaid
// package used to land at FULL menu prices with the £240 never applied).
//
// The locked decision table (owner, 19 Aug), model × line type × override:
//
//   PREPAY package — the guest already paid for the food, so every line lands
//   at 0.00 unless price_override > 0 (an explicit upcharge). The captured
//   prepay posts to the check as a TENDER leg at close, so only extras are due.
//     fixed line   : override > 0 → override, else 0.00 (null AND 0 = included)
//     matched pick : same rule off ITS package line
//     unmatched    : 0.00 — NEVER the menu price (that is the Provo bug)
//
//   DEPOSIT (and hold / no-model) package — real prices on the check; the
//   captured deposit applies as a credit tender leg at close.
//     fixed line   : override null → live menu price, 0 → 0.00, > 0 → override
//     matched pick : same rule off its package line
//     unmatched    : live menu price (?? 0)
//
//   CHOICE lines (is_preorder_choice) NEVER auto-materialise — only actual
//   booking_preorders picks land. Fixed lines always land, qty_per_cover ×
//   covers.
//
// Pure module (no store, no DB) so the rules are unit-testable — the slice's
// packageLinesToItems delegates here.

// One line's unit price under the package's payment model.
export function packageLinePrice(paymentModel, priceOverride, menuPrice) {
  if (paymentModel === 'prepay') {
    return priceOverride > 0 ? priceOverride : 0;
  }
  return priceOverride != null ? priceOverride : (menuPrice ?? 0);
}

// Materialise a package into ordinary order lines for `covers` guests.
// pkg: camelCase package (lines: [{itemId, displayName, qtyPerCover, course,
// priceOverride, isPreorderChoice}]). preorders: [{id, seat, guestName,
// itemId, displayName, course, notes}]. menuItems: the live menu (id, name,
// price, allergens).
export function packageItemsFor({ pkg, covers, preorders = [], menuItems = [], now = Date.now(), prepayCaptured = true }) {
  if (!pkg) return [];
  // v5.7.23 - the prepay zero-pricing is EARNED by captured money, never by
  // the package model alone: a prepay booking with NO captured, un-applied
  // credit on the ledger (pending_payment, expired, legacy unpaid 'prepaid')
  // prices like the deposit model (override ?? live menu price), so an unpaid
  // party pays real prices at the table. seatBooking passes the flag from the
  // booking_payments credit it already loads.
  const declared = pkg.paymentModel || 'deposit';
  const model = declared === 'prepay' && !prepayCaptured ? 'deposit' : declared;
  const lines = pkg.lines || [];
  const findMenu = (id) => (id ? menuItems.find((m) => m.id === id) : null);

  // Fixed lines: everyone gets them. Choice lines NEVER auto-materialise —
  // before v5.7.21 they were only removed when preorders existed, so a booking
  // with no picks loaded every option for every guest.
  const fixed = lines
    .filter((l) => !l.isPreorderChoice)
    .map((l) => {
      const mi = findMenu(l.itemId);
      return {
        uid: `pl-${l.id}-${now}`,
        itemId: l.itemId || `pkg-line-${l.id}`,
        name: l.displayName || mi?.name || 'Package item',
        price: packageLinePrice(model, l.priceOverride, mi?.price),
        qty: Math.max(1, Math.round((l.qtyPerCover || 1) * covers)),
        mods: [], notes: '', allergens: mi?.allergens || [],
        course: l.course ?? 0,
        fired: (l.course ?? 0) === 0,
        seat: null,
      };
    });

  // Pre-order rows: one line per seat choice, guest's name riding the notes so
  // the KDS ticket and kitchen print show WHO each plate is for. A pick is
  // matched back to its package choice line by itemId first, display name
  // second; an UNMATCHED pick prices per the model rule (prepay → 0, deposit →
  // menu price) — never silently full-price on prepay.
  const norm = (s) => String(s || '').trim().toLowerCase();
  const chosen = preorders.map((r, i) => {
    const mi = findMenu(r.itemId);
    const base = lines.find((l) => l.isPreorderChoice && (
      (l.itemId && r.itemId && l.itemId === r.itemId) ||
      (norm(l.displayName) && norm(l.displayName) === norm(r.displayName))
    )) || null;
    const price = base
      ? packageLinePrice(model, base.priceOverride, mi?.price)
      : (model === 'prepay' ? 0 : (mi?.price ?? 0));
    const who = [r.seat ? `Seat ${r.seat}` : null, r.guestName || null].filter(Boolean).join(' · ');
    return {
      uid: `po-${r.id || i}-${now}`,
      itemId: r.itemId || `preorder-${i}`,
      name: r.displayName || mi?.name || 'Pre-order',
      price,
      qty: 1,
      mods: [],
      notes: [who, r.notes || null].filter(Boolean).join(' — '),
      allergens: mi?.allergens || [],
      course: r.course ?? 0,
      fired: (r.course ?? 0) === 0,
      seat: r.seat ?? null,
    };
  });

  return [...fixed, ...chosen];
}
