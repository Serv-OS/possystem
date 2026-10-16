// supabase/functions/_shared/bookingGuestDb.ts
//
// The guest link's database helpers, shared by booking-widget (the guest's manage page and the
// Booked screen) and booking-reminders (every guest message and the 5 minute sweep). 16 Oct 2026.
//
//   manageTokenFor      the guest's change and cancel code for a booking, from
//                       booking_manage_tokens (migration 20261016c). The codes live in their own
//                       table, closed to the anon key, because bookings is still readable with
//                       that key. A booking with no code (the minting trigger caught an error)
//                       gets one here. null before the migration.
//   readBookingPayments the payment rows, oldest first, with amount_refunded_minor when the
//                       column exists (migration 20261016d)
//   healGuestCancel     a guest cancel and its refund flag are two writes; if the flag was lost
//                       the booking is cancelled with its money still 'captured'. This flags it.

import { cancelMoney } from './bookingGuest.js';
import { markPaymentNeedsRefund, isMissingColumnError } from './bookingPromote.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Db = any;

// The words a guest cancel is stamped with. healGuestCancel looks for them.
export const GUEST_CANCEL_REASON = 'Guest cancelled online';
export const GUEST_CANCEL_REFUND = 'the guest cancelled online in time';

// A table that is not there yet (before migration 20261016c): 42P01 from Postgres, PGRST205 or
// "schema cache" from PostgREST.
export const isMissingTable = (e: Row | null) => !!e && (['42P01', 'PGRST205'].includes(String(e.code || ''))
  || isMissingColumnError(e));

export async function manageTokenFor(db: Db, booking: { id: unknown; location_id: unknown }): Promise<string | null> {
  const id = String(booking?.id || '');
  if (!id) return null;
  try {
    const { data, error } = await db.from('booking_manage_tokens').select('token').eq('booking_id', id).maybeSingle();
    if (error) {
      if (!isMissingTable(error)) console.warn('[bookingGuestDb] manage code read failed:', error.message);
      return null;
    }
    if (data?.token) return String(data.token);
    if (!booking.location_id) return null;
    // No code yet: mint one (the database fills the code itself).
    await db.from('booking_manage_tokens').insert({ booking_id: id, location_id: booking.location_id });
    const { data: again } = await db.from('booking_manage_tokens').select('token').eq('booking_id', id).maybeSingle();
    return again?.token ? String(again.token) : null;
  } catch {
    return null;
  }
}

// merchant_reference links a refund row to its payment (bkrf-<id>-<n>), so a refund still on its
// way is never counted as money on the booking (paymentNetMinor, bookingPayment.js).
const PAY_COLS = 'id, kind, status, amount, currency, applied_to_check, refusal_reason, merchant_reference, created_at';
export async function readBookingPayments(db: Db, bookingId: string): Promise<Row[]> {
  const read = (cols: string) => db.from('booking_payments').select(cols).eq('booking_id', bookingId)
    .order('created_at', { ascending: true }).order('id', { ascending: true });
  let { data, error } = await read(`${PAY_COLS}, amount_refunded_minor, refund_of`);
  if (error && isMissingColumnError(error)) ({ data, error } = await read(PAY_COLS));
  if (error) console.error('[bookingGuestDb] payments read failed:', error.message);
  return (data || []) as Row[];
}

export async function healGuestCancel(db: Db, bk: Row, pays: Row[]): Promise<boolean> {
  if (bk?.status !== 'cancelled' || bk?.cancel_reason !== GUEST_CANCEL_REASON) return false;
  const owed = cancelMoney(pays || []);
  if (!owed.rowIds.length) return false;
  const cust = (bk.customer || {}) as Row;
  await markPaymentNeedsRefund(db, owed.rowIds, GUEST_CANCEL_REFUND, {
    guestName: cust.name ? String(cust.name) : null, time: String(bk.start_time || '').slice(0, 5),
  });
  for (const p of pays || []) {
    if (owed.rowIds.includes(p.id)) Object.assign(p, { status: 'needs_refund', refusal_reason: `needs refund: ${GUEST_CANCEL_REFUND}` });
  }
  return true;
}
