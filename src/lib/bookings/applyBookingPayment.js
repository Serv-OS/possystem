// src/lib/bookings/applyBookingPayment.js
//
// Stamp a booking's captured money onto the check that used it (16 Oct 2026, bookings audit
// item 3). One door for the two closers: CheckoutModal (the till's own checkout) and the store's
// closeApprovedTerminalJob (a check booked from a card machine job).
//
// The check passes how much of the booking money it USED (appliedMinor). apply_booking_payment
// (migration 20261016b) stores that per payment row and keeps the unused part as a refund owed
// to the guest. Before Peter runs the migration the database only knows the two argument
// function: the call is then made again without the amount, which is exactly today's behaviour,
// and the answer says so (fallback:true) so the caller can log it.
//
// rpc is supabase.rpc (bound), passed in so the rule runs under node:test.

// A PostgREST answer that means "this function is not on the database yet" (the migration has
// not been run), as opposed to the function refusing.
export const isMissingFunction = (e) => {
  const code = String(e?.code || '');
  const m = String(e?.message || e || '');
  return code === 'PGRST202' || code === '42883' || /could not find the function|function .* does not exist/i.test(m);
};

export async function applyBookingPayment(rpc, { bookingId, checkId = null, appliedMinor = null } = {}) {
  if (typeof rpc !== 'function' || !bookingId) return { ok: false, error: 'nothing to apply' };
  const base = { p_booking_id: bookingId, p_closed_check_id: checkId };
  const amount = appliedMinor === null || appliedMinor === undefined || appliedMinor === '' ? NaN : Number(appliedMinor);
  const withAmount = Number.isFinite(amount) && amount >= 0;
  try {
    if (withAmount) {
      const { data, error } = await rpc('apply_booking_payment', { ...base, p_applied_minor: Math.round(amount) });
      if (!error) return { ok: true, rows: data ?? null, fallback: false };
      if (!isMissingFunction(error)) return { ok: false, error: error.message || String(error) };
    }
    const { data, error } = await rpc('apply_booking_payment', base);
    if (error) return { ok: false, error: error.message || String(error) };
    return { ok: true, rows: data ?? null, fallback: withAmount };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
