// src/lib/bookings/sessionTotal.js
//
// The running total the host stand's Floor card shows for an open tab.
//
// A till line's price ALREADY includes its option prices (addItem via
// cartUnitPrice, configureLineOptions, and seated pre-order choices), the same
// price × qty the check totals use (lib/payments/checkTotals.js). Adding the
// mods again here over-stated the Floor card total for every line with paid
// options (fixed 10 Sep 2026). Moved out of bits.jsx so it can be tested.
export const sessionTotal = (session) =>
  (session?.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
