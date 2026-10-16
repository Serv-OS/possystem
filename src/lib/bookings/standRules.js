// src/lib/bookings/standRules.js
//
// 16 Oct 2026: the small decisions behind the host stand's buttons and words,
// kept pure and tested so the screens only render them. No store, no React.

import { undoNoShowStatus } from './bookingPayment.js';
import { shiftYmd, ymdLabel } from './venueClock.js';

// ── other day seating (audit item 16) ────────────────────────────────────────
// Seating a booking dated another day marked it dining with no till tab, and
// the walk in panel booked and seated tomorrow when the diary was on tomorrow.
// Kept for older callers; the words now name the booking's date.
export const OTHER_DAY_SEAT_TEXT = 'Bookings for another day can be seated on the day';

const hmMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// null = may be seated now; otherwise the words to show.
// 16 Oct 2026 (review): a late booking whose party arrives after midnight (23:30, in at 00:10)
// may still be seated while its booked time has not run out (nowMin is the venue's minute of day).
export function seatRefusal({ booking, today, nowMin = null }) {
  if (!booking) return 'This booking is not on the diary any more.';
  if (!today || !booking.date || booking.date === today) return null;
  if (booking.date === shiftYmd(today, -1) && nowMin != null) {
    const start = hmMin(booking.startTime);
    const turn = Number(booking.turnMinutes) || 90;
    if (start != null && Number(nowMin) + 1440 < start + turn) return null;
  }
  const label = ymdLabel(booking.date, { long: true }).replace(',', '');
  if (booking.date < today) return `This booking was for ${label}.`;
  return `This booking is for ${label}. Seat it on the day.`;
}

// ── Cancel and No-show (audit item 17) ───────────────────────────────────────
export const UNDO_CANCEL_MS = 30 * 1000;
export const CANCEL_REASONS = ['Guest asked', 'Venue cancelled', 'Duplicate booking', 'Other'];
export const NO_SHOW_REASONS = ['Did not arrive', 'Arrived too late', 'Other'];

const isCaptured = (r) => r && r.status === 'captured' && r.kind !== 'refund'
  && !/^needs refund/i.test(String(r.refusal_reason || ''));
const isHeldCard = (r) => r && r.status === 'authorised' && r.kind === 'hold';

// What the confirm sheet says about money on file. rows: the booking_payments
// ledger (null = not read yet). fmt: (major) => '£76.00'.
// { heldMinor, line } where line is null when nothing is on file.
export function moneyOnFileLine(rows, fmt = (v) => `£${Number(v).toFixed(2)}`) {
  if (!Array.isArray(rows)) return { heldMinor: null, line: 'Checking for money on this booking…' };
  const heldMinor = rows.filter(isCaptured).reduce((s, r) => s + Math.round((Number(r.amount) || 0) * 100), 0);
  if (heldMinor > 0) {
    return { heldMinor, line: `${fmt(heldMinor / 100)} was paid on this booking and is not refunded automatically` };
  }
  if (rows.some(isHeldCard)) return { heldMinor: 0, line: 'A card is saved on this booking. Nothing was taken.' };
  return { heldMinor: 0, line: null };
}

// The status Undo cancel puts back, or null when it cannot be undone from the
// stand. A prepaid booking returns as confirmed (only the payment server may
// write prepaid; the Prepaid badge still shows from the ledger). A booking that
// owed money with no payment on the ledger would come back expired, which frees
// its table anyway, so there is nothing to undo.
export function undoCancelStatus({ before, booking, payments = null }) {
  if (before === 'pending_payment') return 'pending_payment';
  if (before !== 'confirmed' && before !== 'prepaid') return null;
  const s = undoNoShowStatus({ booking: { ...(booking || {}), seatedAt: null }, payments });
  return s === 'confirmed' ? 'confirmed' : null;
}

// ── PIN pad (audit item 19) ──────────────────────────────────────────────────
// The pad submitted at exactly 4 digits, so a venue with 6 digit PINs could
// never log in. The venue's PIN length is learnt from the last good login on
// this stand (PINs never reach the device); the OK key submits any length from
// 4 to 8. Until a login has taught it, the length is unknown (null) and the pad
// never auto submits: a 6 digit venue's first login on a fresh stand would
// otherwise be sent at 4 digits and refused every time.
export const PIN_MIN = 4;
export const PIN_MAX = 8;
export const pinLengthKey = (loc) => `rpos-stand-pin-length:${loc || 'none'}`;

export function venuePinLength(stored) {
  const n = Math.round(Number(stored) || 0);
  return n >= PIN_MIN && n <= PIN_MAX ? n : null;
}

// auto: the pad reached the venue's length. ok: the OK key may submit.
export function pinPadState(pin, venueLength = null) {
  const len = String(pin || '').length;
  const known = venuePinLength(venueLength);
  return { auto: known != null && len === known, ok: len >= PIN_MIN && len <= PIN_MAX };
}

// ── the POS linked pill (audit item 9) ───────────────────────────────────────
// status: the realtime channel status ('SUBSCRIBED', 'CHANNEL_ERROR',
// 'TIMED_OUT', 'CLOSED') or null before it has said anything.
export function channelPill(status, { online = true } = {}) {
  if (!online) return { tone: 'red', label: 'Offline', sub: 'no connection' };
  if (status === 'SUBSCRIBED') return { tone: 'green', label: 'POS linked', sub: 'floor + diary live' };
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    return { tone: 'red', label: 'Offline', sub: 'reconnecting' };
  }
  return { tone: 'amber', label: 'Connecting', sub: 'linking to the POS' };
}

// ── Off plan (audit item 21, Timeline part) ──────────────────────────────────
// Live bookings whose tables are none of the floor plan's tables vanished from
// the Timeline and the Floor. They get their own row instead.
export function offPlanBookings(bookings = [], floorTableIds = []) {
  const ids = new Set(floorTableIds || []);
  return (bookings || []).filter((b) => {
    if (!b || b.status === 'cancelled') return false;
    const list = (b.tables && b.tables.length ? b.tables : [b.primaryTableId]).filter(Boolean);
    return !list.some((t) => ids.has(t));
  });
}
