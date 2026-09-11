// bookingPayment.js — the booking payment gate, as pure rules (10 Sep 2026).
//
// Peter's rule: "payment must be paid before booking confirms on the system".
// ONE copy of the rules, used by:
//   - supabase/functions/booking-widget (what is due, what may be sold online)
//   - supabase/functions/adyen-webhook (does this event cover the payment)
//   - supabase/functions/_shared/bookingPromote.ts (may this booking promote)
//   - the web app (Back Office package checks, host stand undo and seat notes)
//
// KEEP BYTE-IDENTICAL: supabase/functions/_shared/bookingPayment.js and
// src/lib/bookings/bookingPayment.js. bookingPaymentParity.test.js fails the
// build when they drift (Deno cannot import from src/).
//
// Money is in MINOR units (pence / cents) everywhere in this file. Package
// rows arrive in either shape: snake_case from the database, camelCase from
// the store. No I/O, no clock, no globals.

export const PAYMENT_KINDS = ['prepay', 'deposit', 'hold'];

// Statuses that never block a table (the create_booking free check).
export const NON_BLOCKING_STATUSES = ['departed', 'cancelled', 'no_show', 'expired'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const pick = (o, snake, camel) => {
  if (!o) return undefined;
  return o[snake] !== undefined ? o[snake] : o[camel];
};
const upper = (v) => String(v || '').trim().toUpperCase();

// What a PACKAGE asks for at booking time.
//   prepay with price > 0            → needs a payment (kind prepay)
//   deposit with deposit_per_cover > 0 → needs a payment (kind deposit)
//   prepay at 0, deposit at 0        → misconfigured, never sold online
//   hold (or no package)             → nothing from the package itself
export function packagePaymentNeed(pkg) {
  if (!pkg) return { kind: null, needsPayment: false, misconfigured: false };
  const model = String(pick(pkg, 'payment_model', 'paymentModel') || '');
  if (model === 'prepay') {
    const ok = num(pkg.price) > 0;
    return { kind: 'prepay', needsPayment: ok, misconfigured: !ok };
  }
  if (model === 'deposit') {
    const ok = num(pick(pkg, 'deposit_per_cover', 'depositPerCover')) > 0;
    return { kind: 'deposit', needsPayment: ok, misconfigured: !ok };
  }
  return { kind: null, needsPayment: false, misconfigured: false };
}

// What a booking owes, in minor units, or null when nothing is due.
// Prepay and deposit come from the package whatever the capture switch says
// (the caller refuses to sell them when capture is off). A card hold comes
// from the venue rules, only with card capture on, only from the covers
// threshold up, only above zero. A hold takes NO money: it saves the card.
export function paymentDue({ covers, pkg = null, rules = null } = {}) {
  const c = Math.max(1, Math.round(num(covers)) || 1);
  const need = packagePaymentNeed(pkg);
  if (need.needsPayment && need.kind === 'prepay') {
    const perCover = String(pick(pkg, 'price_unit', 'priceUnit') || '').includes('cover');
    const amount = perCover ? num(pkg.price) * c : num(pkg.price);
    return { kind: 'prepay', amountMinor: Math.round(amount * 100) };
  }
  if (need.needsPayment && need.kind === 'deposit') {
    return { kind: 'deposit', amountMinor: Math.round(num(pick(pkg, 'deposit_per_cover', 'depositPerCover')) * c * 100) };
  }
  if (!pick(rules, 'card_capture_enabled', 'cardCaptureEnabled')) return null;
  const minCovers = num(pick(rules, 'card_capture_min_covers', 'cardCaptureMinCovers'));
  if (minCovers > 0 && c < minCovers) return null;
  const hold = num(pick(rules, 'hold_per_cover', 'holdPerCover')) * c;
  return hold > 0 ? { kind: 'hold', amountMinor: Math.round(hold * 100) } : null;
}

// May the widget offer (and book) this package right now?
export function packageSellableOnline(pkg, { captureOn = false, adyenUsable = false } = {}) {
  const need = packagePaymentNeed(pkg);
  if (need.misconfigured) return { ok: false, reason: 'package_misconfigured' };
  if (need.needsPayment && !captureOn) return { ok: false, reason: 'capture_off' };
  if (need.needsPayment && !adyenUsable) return { ok: false, reason: 'adyen_unusable' };
  return { ok: true, reason: null };
}

// The status a widget booking is WRITTEN with. Never 'prepaid' at book time:
// only the payment server promotes, after the money is authorised.
export const statusAtBooking = (due) => (due ? 'pending_payment' : 'confirmed');

// The status a paid booking promotes to.
export const promotedStatusFor = (kind) => (kind === 'prepay' ? 'prepaid' : 'confirmed');

// What was due, as stored on the booking row at book time (null when the
// columns are absent or empty, then the caller recomputes).
export function storedDue(bk) {
  if (!bk) return null;
  const kind = pick(bk, 'payment_kind', 'paymentKind');
  const minor = pick(bk, 'payment_due_minor', 'paymentDueMinor');
  if (!PAYMENT_KINDS.includes(kind) || minor === null || minor === undefined || minor === '') return null;
  if (!Number.isFinite(Number(minor))) return null;
  const currency = pick(bk, 'payment_currency', 'paymentCurrency');
  return { kind, amountMinor: Math.max(0, Math.round(Number(minor))), currency: currency ? upper(currency) : null };
}

const isMoneyKind = (k) => k === 'prepay' || k === 'deposit';

// What booking_pay may charge (10 Sep 2026 review). The due stored at book
// time can be written by nothing but the payment server once migration
// 20260910 is applied (the trigger freezes it), but before that the booking's
// package and covers are still editable from a browser. So the charge never
// trusts one source alone:
//   stored      what the booking widget stored at book time (storedDue)
//   recomputed  what the booking's own package, the package in the widget's
//               booking_requests audit row, and the venue rules say now
// A stored card hold where any recomputed figure is money (prepay or deposit)
// is refused: that is a booking rewritten to dodge its payment. Otherwise money
// beats a saved card and the LARGEST amount wins, so a smaller figure written
// anywhere can never shrink the charge.
//   { ok:true, due }  due is null when nothing is owed
//   { ok:false, reason:'due_mismatch' }
export function dueForCharge({ stored = null, recomputed = [] } = {}) {
  const valid = (d) => !!d && PAYMENT_KINDS.includes(d.kind);
  const others = (Array.isArray(recomputed) ? recomputed : [recomputed]).filter(valid);
  const all = [...(valid(stored) ? [stored] : []), ...others];
  if (!all.length) return { ok: true, due: null };
  if (valid(stored) && stored.kind === 'hold' && others.some((d) => isMoneyKind(d.kind))) {
    return { ok: false, due: null, reason: 'due_mismatch' };
  }
  const money = all.filter((d) => isMoneyKind(d.kind));
  const pool = money.length ? money : all;
  const top = pool.reduce((a, b) => (Math.round(num(b.amountMinor)) > Math.round(num(a.amountMinor)) ? b : a));
  const currency = (valid(stored) && stored.currency) || top.currency || null;
  return {
    ok: true,
    due: { kind: top.kind, amountMinor: Math.max(0, Math.round(num(top.amountMinor))), currency: currency ? upper(currency) : null },
  };
}

// Does a paid amount cover a due amount? A hold saves a card and takes no
// money, so it is covered by any successful authorisation. Prepay and
// deposit need a due above zero, a paid amount at least that big and the
// SAME currency (both must be known).
export function amountCovers({ kind, dueMinor, paidMinor, dueCurrency, paidCurrency } = {}) {
  if (kind === 'hold') return true;
  if (kind !== 'prepay' && kind !== 'deposit') return false;
  const due = Math.round(num(dueMinor));
  if (!(due > 0)) return false;
  if (!upper(dueCurrency) || !upper(paidCurrency) || upper(dueCurrency) !== upper(paidCurrency)) return false;
  return Math.round(num(paidMinor)) >= due;
}

// Does one successful payment satisfy what a booking owes?
//   due  { kind, amountMinor, currency }
//   paid { kind, amountMinor, currency }
// A hold due is satisfied by any money or saved card. A prepay or deposit due
// needs a prepay or deposit payment that covers it (a saved card never does).
export function paymentSatisfiesDue(due, paid) {
  if (!due || !paid) return false;
  if (due.kind === 'hold') return true;
  if (paid.kind !== 'prepay' && paid.kind !== 'deposit') return false;
  return amountCovers({
    kind: due.kind, dueMinor: due.amountMinor, paidMinor: paid.amountMinor,
    dueCurrency: due.currency, paidCurrency: paid.currency,
  });
}

// A payment row that must go back to the guest. After migration 20260910 the
// status says needs_refund; before it the status could not change, so the
// reason carries "NEEDS REFUND: ..." instead (bookingPromote.ts).
export const isNeedsRefundRow = (p) => !!p
  && (p.status === 'needs_refund' || /^needs refund/i.test(String(p.refusal_reason || '')));

// A payment that really secured the booking: captured or authorised, not a
// refund, not money flagged to go back.
export const isPaidRow = (p) => !!p && (p.status === 'captured' || p.status === 'authorised')
  && p.kind !== 'refund' && !isNeedsRefundRow(p);

// The webhook's check for ONE successful Adyen event (10 Sep 2026 review).
//   rows       the booking_payments rows this event settled
//   bookingId  the booking the merchant reference names
//   event      { value, currency, storedCard } from the notification
//   due        what the booking owes (dueForCharge), or null to judge each
//              row against its own amount
// Returns { row, reason }. row is the payment that may promote the booking;
// reason says why none can: no_row, amount_short (the event is less than the
// row), due_not_covered (the row is less than the booking owes, or a saved
// card on a booking that owes money). A hold row covers a hold booking with or
// without a saved card token (10 Sep 2026: no no-show charge exists yet).
export function coveringBookingPayment({ rows = [], bookingId = null, event = {}, due = null } = {}) {
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && String(r.booking_id) === String(bookingId) && !isNeedsRefundRow(r));
  if (!mine.length) return { row: null, reason: 'no_row' };
  let reason = 'amount_short';
  for (const r of mine) {
    const own = { kind: r.kind, amountMinor: Math.round(num(r.amount) * 100), currency: r.currency };
    const eventPaid = { kind: r.kind, amountMinor: num(event?.value), currency: event?.currency };
    if (!paymentSatisfiesDue(own, eventPaid)) continue;
    const owed = due ? { ...due, currency: due.currency || r.currency } : own;
    if (!paymentSatisfiesDue(owed, own)) { reason = 'due_not_covered'; continue; }
    return { row: r, reason: null };
  }
  return { row: null, reason };
}

// Is there a live till tab on any of these tables TODAY? A walk-in opened
// straight on the till writes no bookings row, so the table free check alone
// would let a late payment bring an expired booking back onto an occupied
// table. sessions are active_sessions rows { table_id, session }.
export function liveTabOnTables({ bookingDate = null, today = null, tableIds = [], sessions = [] } = {}) {
  if (!bookingDate || !today || String(bookingDate).slice(0, 10) !== String(today).slice(0, 10)) return false;
  const mine = new Set((Array.isArray(tableIds) ? tableIds : []).filter(Boolean).map(String));
  if (!mine.size) return false;
  return (Array.isArray(sessions) ? sessions : []).some((s) => !!s
    && mine.has(String(s.table_id ?? s.tableId ?? ''))
    && !!s.session && typeof s.session === 'object');
}

// A promote that did not happen while the money is already in: the plain
// reason for the refund flag, or null when it is not stranded (promoted, already
// at that status, or a lookup that failed and may still succeed later).
const STUCK_BY_STATUS = {
  dining: 'the party was seated before the payment arrived',
  departed: 'the party had already left',
  cancelled: 'the booking was cancelled',
  no_show: 'the booking was marked as a no show',
  confirmed: 'the booking was already confirmed',
  prepaid: 'the booking was already paid',
};
export function stuckPaymentReason({ ok = false, promoted = false, error = null, status = null } = {}) {
  if (ok || promoted) return null;
  if (error === 'table_taken') return 'the table was booked again after the booking expired';
  if (error === 'unknown_booking') return 'the booking no longer exists';
  if (error === 'due_mismatch') return 'the booking did not match what it owed';
  if (error === 'not_promotable') return STUCK_BY_STATUS[status] || 'the booking was closed';
  return null;
}

export function timeToMin(t) {
  if (Number.isFinite(t)) return t;
  const [h, m] = String(t || '').slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
const startOf = (b) => (Number.isFinite(b?.startMin) ? b.startMin : timeToMin(b?.startTime ?? b?.start_time));
const turnOf = (b) => num(b?.turnMinutes ?? b?.turn_minutes);
const tablesOf = (b) => {
  const list = Array.isArray(b?.tables) ? b.tables : [];
  const primary = b?.primaryTableId ?? b?.primary_table_id;
  return [...new Set([...list, ...(primary ? [primary] : [])].map(String))];
};

// Are this booking's tables still free for its own time? The SAME half-open
// overlap test create_booking runs (20260824_booking_payment_flow.sql), over
// the other bookings of the same venue and date.
export function tablesStillFree(booking, others = []) {
  if (!booking) return false;
  const s = startOf(booking);
  const e = s + turnOf(booking);
  const mine = new Set(tablesOf(booking));
  if (!mine.size) return false;
  return !(others || []).some((o) => {
    if (!o || String(o.id) === String(booking.id)) return false;
    if (NON_BLOCKING_STATUSES.includes(o.status)) return false;
    if (!tablesOf(o).some((t) => mine.has(t))) return false;
    const os = startOf(o);
    return os < e && os + turnOf(o) > s;
  });
}

// What to do with a booking whose payment just succeeded.
//   'already'      it is already at the promoted status
//   'promote'      pending_payment, or expired with its tables still free
//   'check_tables' expired, and nobody has looked at the tables yet
//   'needs_refund' expired, and its tables were booked again
//   'refuse'       anything else (cancelled, no_show, departed, dining ...)
export function promotionDecision({ status, nextStatus, tablesFree = null } = {}) {
  if (status === nextStatus) return 'already';
  if (status === 'pending_payment') return 'promote';
  if (status === 'expired') {
    if (tablesFree === true) return 'promote';
    if (tablesFree === false) return 'needs_refund';
    return 'check_tables';
  }
  return 'refuse';
}

// Did this booking owe money? The amount stored at book time wins. Without it
// (older bookings) a package that needs payment says yes. A hold with no
// stored record cannot be proven, so it reads as nothing owed.
export function bookingOwesPayment(booking, pkg = null) {
  const stored = storedDue(booking);
  if (stored) return stored.amountMinor > 0;
  return packagePaymentNeed(pkg).needsPayment;
}

// Undo no-show on the host stand. A seated party goes back to dining.
// 'expired' only for a booking made through the payment gate (it stored what
// it owed) whose ledger was really read and shows no successful payment.
// Older bookings, and anything that owed nothing, go back to confirmed.
// null = the ledger is not known yet (still loading, or the read failed): the
// caller must refuse the undo rather than guess, because expired frees the
// table and cannot be undone from the stand.
export function undoNoShowStatus({ booking, payments = null } = {}) {
  if (booking?.seatedAt) return 'dining';
  const stored = storedDue(booking);
  if (!stored || !(stored.amountMinor > 0)) return 'confirmed';
  if (!Array.isArray(payments)) return null;
  return payments.some(isPaidRow) ? 'confirmed' : 'expired';
}

// Should the stand warn "Not paid online"? Always for pending_payment. For
// other live bookings only when the ledger was read (payments is an array)
// and shows no successful payment for a booking that owed one.
export function bookingUnpaid({ booking, pkg = null, payments = null } = {}) {
  if (!booking) return false;
  if (booking.status === 'pending_payment') return true;
  if (!Array.isArray(payments)) return false;
  if (payments.some(isPaidRow)) return false;
  return bookingOwesPayment(booking, pkg);
}
