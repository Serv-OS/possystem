// src/lib/bookings/bookingCredit.js
//
// 16 Oct 2026 (Peter): "a seated prepaid booking shows the full total with a
// banner, comes off the bill at close". The guest has paid, so the money is a
// PAYMENT LINE from the moment they sit down, and the screen shows what is
// left to pay: "Bottomless Brunch prepaid £76.00", "To pay £9.50".
//
// ONE helper, read by the order screen (POSSurface), the table card
// (TablesSurface) and checkout (CheckoutModal), so the three can never show
// different money. Display only: checkout still posts the tender through its
// own take(prepaidMinor, 'booking_prepaid') legs, unchanged.
//
// seatBooking stamps session.booking = { bookingId, packageName, prepaidMinor,
// depositMinor, ... } (captured, not yet applied booking_payments money, in
// minor units). Pure: no store, no React.

const minor = (v) => {
  const n = Math.round(Number(v) || 0);
  return n > 0 ? n : 0;
};

export function bookingCreditLabel(booking) {
  const p = minor(booking?.prepaidMinor);
  const d = minor(booking?.depositMinor);
  if (p > 0 && d > 0) return 'Booking payments';
  if (p > 0) return `${booking?.packageName || 'Package'} prepaid`;
  if (d > 0) return 'Booking deposit';
  return null;
}

// session: a table session (or anything with .booking). totalMajor: the bill
// in major units (pounds), or null when only the credit is wanted.
// Returns { hasCredit, creditMinor, prepaidMinor, depositMinor, label,
//           totalMinor, appliedMinor, balanceMinor, surplusMinor }.
// The credit is capped at the bill: an excess prepayment zeroes what is due
// and the surplus stays on the booking (never refunded here).
export function bookingCreditFor(session, totalMajor = null) {
  const b = session?.booking || null;
  const prepaidMinor = minor(b?.prepaidMinor);
  const depositMinor = minor(b?.depositMinor);
  const creditMinor = prepaidMinor + depositMinor;
  const out = {
    hasCredit: creditMinor > 0,
    creditMinor, prepaidMinor, depositMinor,
    label: bookingCreditLabel(b),
    totalMinor: null, appliedMinor: 0, balanceMinor: null, surplusMinor: 0,
  };
  if (totalMajor == null || !Number.isFinite(Number(totalMajor))) return out;
  const totalMinor = Math.max(0, Math.round(Number(totalMajor) * 100));
  const appliedMinor = Math.min(creditMinor, totalMinor);
  return {
    ...out,
    totalMinor,
    appliedMinor,
    balanceMinor: totalMinor - appliedMinor,
    surplusMinor: creditMinor - appliedMinor,
  };
}
