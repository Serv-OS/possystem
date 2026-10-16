// src/lib/bookings/bookingReports.js
//
// Back Office booking reports and booking payments, as pure sums (16 Oct 2026, bookings audit
// section 3 item 10). The screens are reports/BookingsReport.jsx and
// reports/BookingPaymentsReport.jsx; the reads are in bookingMoneyData.js.
//
// THE RULES THIS FILE KEEPS
//   1. A card hold is never money. booking_pay stores the hold FIGURE on the row while Adyen
//      was sent 0, so a sum of amount by status would count it (the audit's report trap). Holds
//      are counted as cards saved, never added to money.
//   2. Rates leave out what was never a real booking: expired (the guest never paid) and
//      pending_payment (still paying) are not in the no show or cancellation denominators.
//   3. Money in two currencies is never added together: every money figure is per currency.
//   4. Money owed back is its own figure: needs_refund rows (paid after the booking closed) and
//      the part of a captured payment the bill did not use (refund_due_minor, 20261016b).
//
// Rows are camelCase bookings (bookingsData.rowToBooking) and snake_case booking_payments rows.
// PURE: no Supabase, no React. Runs under node --test.

import { NO_SHOW_KIND } from './noShowCharge.js';
// v5.11.70 release: the needs refund test and what is left of a payment after refunds are the
// ONE shared rule (bookingPayment.js), the same the guest page, refunds and the till use.
import { isNeedsRefundRow, paymentNetMinor, refundedMinorFor } from './bookingPayment.js';

export const NOT_A_BOOKING = new Set(['expired', 'pending_payment']);
const SEATED = new Set(['dining', 'departed']);
const UPCOMING = new Set(['confirmed', 'prepaid', 'due', 'late']);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const minorOf = (amount) => Math.round(num(amount) * 100);
const upper = (v) => String(v || '').trim().toUpperCase() || null;
const isNeedsRefund = isNeedsRefundRow;
// A card hold's figure: hold_minor since 20261016d (the row's amount is 0, a hold takes nothing),
// the amount before it.
const holdFigureMinor = (p) => (num(p?.hold_minor) > 0 ? Math.round(num(p.hold_minor)) : minorOf(p?.amount));

export const SOURCE_NAMES = {
  host: 'Host stand', phone: 'Phone', widget: 'Online', online: 'Online', walk_in: 'Walk in',
  events: 'Events', pos: 'Till', email: 'Email', social: 'Social', other: 'Other',
};
export const sourceName = (s) => SOURCE_NAMES[s || 'host'] || String(s || 'host').replace(/_/g, ' ');

export const STATUS_NAMES = {
  confirmed: 'Confirmed', prepaid: 'Prepaid', dining: 'Dining', departed: 'Departed', cancelled: 'Cancelled',
  no_show: 'No show', expired: 'Unpaid, expired', pending_payment: 'Awaiting payment', due: 'Due', late: 'Late',
};

// ── services ────────────────────────────────────────────────────────────────────────────────

const clockMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The service a booking time falls in: the venue's own service periods (locationConfig.shifts,
 * { name, start, end }, overnight allowed) when it has them, else Breakfast before 11:00,
 * Lunch to 16:00, Dinner after. Booking times are already the venue's wall clock.
 */
export function serviceFor(startTime, shifts = []) {
  const m = clockMin(startTime);
  if (m == null) return 'No time';
  for (const s of Array.isArray(shifts) ? shifts : []) {
    const a = clockMin(s?.start), b = clockMin(s?.end);
    if (a == null || b == null) continue;
    const inside = b > a ? (m >= a && m < b) : (m >= a || m < b);
    if (inside) return String(s.name || s.label || 'Service');
  }
  if (m < 11 * 60) return 'Breakfast';
  if (m < 16 * 60) return 'Lunch';
  return 'Dinner';
}

// ── the bookings report ─────────────────────────────────────────────────────────────────────

/**
 * Money taken per booking id, from the payments of those bookings: { [bookingId]: { [CUR]:
 * { prepay, deposit, noShow } } } in minor units. Captured or authorised charge rows only;
 * holds and refunds never count; money flagged to go back does not count as taken.
 */
export function moneyByBooking(payments) {
  const out = {};
  for (const p of Array.isArray(payments) ? payments : []) {
    if (!p || isNeedsRefund(p)) continue;
    const kind = p.kind === NO_SHOW_KIND ? 'noShow' : p.kind;
    if (kind !== 'prepay' && kind !== 'deposit' && kind !== 'noShow') continue;
    const taken = p.status === 'captured' || (kind === 'noShow' && p.status === 'authorised');
    if (!taken) continue;
    const cur = upper(p.currency) || 'GBP';
    const b = (out[p.booking_id] ||= {});
    const m = (b[cur] ||= { prepay: 0, deposit: 0, noShow: 0 });
    // net of any refund made since (a part refund keeps the row captured)
    m[kind] += paymentNetMinor(p, payments);
  }
  return out;
}

const addMoney = (into, cur, part) => {
  const m = (into[cur] ||= { prepay: 0, deposit: 0, noShow: 0, total: 0 });
  m.prepay += part.prepay || 0;
  m.deposit += part.deposit || 0;
  m.noShow += part.noShow || 0;
  m.total = m.prepay + m.deposit + m.noShow;
};

/**
 * The bookings report for one set of bookings (one site, or several sharing the sums).
 *   bookings  camelCase bookings for the range (by booking date)
 *   payments  booking_payments rows of those bookings (null = not readable: money says so)
 *   shifts    the venue's service periods
 * Returns { kpis, byService, bySource, byStatus, money, cardsSaved, moneyKnown }.
 */
export function bookingsReport({ bookings = [], payments = null, shifts = [] } = {}) {
  const rows = Array.isArray(bookings) ? bookings : [];
  const real = rows.filter((b) => !NOT_A_BOOKING.has(b.status));
  const live = real.filter((b) => b.status !== 'cancelled');
  const count = (list, fn) => list.filter(fn).length;
  const covers = live.reduce((s, b) => s + num(b.covers), 0);
  const seatedCovers = live.filter((b) => SEATED.has(b.status)).reduce((s, b) => s + num(b.covers), 0);
  const noShows = count(real, (b) => b.status === 'no_show');
  const cancelled = count(real, (b) => b.status === 'cancelled');
  const online = count(real, (b) => b.source === 'widget' || b.source === 'online');
  const kpis = {
    bookings: real.length,
    covers,
    seatedCovers,
    avgParty: live.length ? covers / live.length : 0,
    noShows,
    noShowRate: real.length ? (noShows / real.length) * 100 : 0,
    noShowCovers: real.filter((b) => b.status === 'no_show').reduce((s, b) => s + num(b.covers), 0),
    cancelled,
    cancelRate: real.length ? (cancelled / real.length) * 100 : 0,
    onlineShare: real.length ? (online / real.length) * 100 : 0,
    unpaidExpired: count(rows, (b) => b.status === 'expired'),
    awaitingPayment: count(rows, (b) => b.status === 'pending_payment'),
  };

  const svc = new Map();
  for (const b of real) {
    const name = serviceFor(b.startTime, shifts);
    const r = svc.get(name) || { service: name, bookings: 0, covers: 0, seatedCovers: 0, noShows: 0, cancelled: 0, firstMin: clockMin(b.startTime) ?? 9999 };
    r.bookings += 1;
    if (b.status !== 'cancelled') r.covers += num(b.covers);
    if (SEATED.has(b.status)) r.seatedCovers += num(b.covers);
    if (b.status === 'no_show') r.noShows += 1;
    if (b.status === 'cancelled') r.cancelled += 1;
    r.firstMin = Math.min(r.firstMin, clockMin(b.startTime) ?? 9999);
    svc.set(name, r);
  }
  const byService = [...svc.values()].sort((a, b) => a.firstMin - b.firstMin || a.service.localeCompare(b.service));

  const perBooking = Array.isArray(payments) ? moneyByBooking(payments) : {};
  const src = new Map();
  for (const b of real) {
    const key = b.source || 'host';
    const r = src.get(key) || { source: key, name: sourceName(key), bookings: 0, covers: 0, noShows: 0, cancelled: 0, money: {} };
    r.bookings += 1;
    if (b.status !== 'cancelled') r.covers += num(b.covers);
    if (b.status === 'no_show') r.noShows += 1;
    if (b.status === 'cancelled') r.cancelled += 1;
    for (const [cur, part] of Object.entries(perBooking[b.id] || {})) addMoney(r.money, cur, part);
    src.set(key, r);
  }
  const bySource = [...src.values()]
    .map((r) => ({ ...r, noShowRate: r.bookings ? (r.noShows / r.bookings) * 100 : 0 }))
    .sort((a, b) => b.bookings - a.bookings || a.name.localeCompare(b.name));

  const byStatus = [
    { id: 'departed', label: 'Departed', n: count(rows, (b) => b.status === 'departed') },
    { id: 'dining', label: 'Dining', n: count(rows, (b) => b.status === 'dining') },
    { id: 'upcoming', label: 'Upcoming', n: count(rows, (b) => UPCOMING.has(b.status)) },
    { id: 'no_show', label: 'No shows', n: noShows },
    { id: 'cancelled', label: 'Cancelled', n: cancelled },
    { id: 'expired', label: 'Unpaid, expired', n: kpis.unpaidExpired },
    { id: 'pending_payment', label: 'Awaiting payment', n: kpis.awaitingPayment },
  ];

  const money = {};
  const ids = new Set(rows.map((b) => b.id));
  for (const [id, byCur] of Object.entries(perBooking)) {
    if (!ids.has(id)) continue;
    for (const [cur, part] of Object.entries(byCur)) addMoney(money, cur, part);
  }
  const cardsSaved = Array.isArray(payments)
    ? new Set(payments.filter((p) => p && p.kind === 'hold' && p.status === 'authorised' && ids.has(p.booking_id)).map((p) => p.booking_id)).size
    : null;
  return { kpis, byService, bySource, byStatus, money, cardsSaved, moneyKnown: Array.isArray(payments) };
}

// ── booking payments ────────────────────────────────────────────────────────────────────────

export const KIND_NAMES = {
  prepay: 'Prepaid', deposit: 'Deposit', hold: 'Card saved', [NO_SHOW_KIND]: 'No show or late cancel charge', refund: 'Refund',
};
export const PAY_STATUS_NAMES = {
  pending: 'Waiting', authorised: 'Authorised', captured: 'Taken', failed: 'Failed',
  cancelled: 'Cancelled', refunded: 'Refunded', needs_refund: 'Owed back',
};

/** What is owed back to the guest on one row, in minor units (net of refunds already made). */
export function owedBackMinor(p, rows = []) {
  if (!p) return 0;
  if (isNeedsRefund(p) && p.kind !== 'hold') return paymentNetMinor(p, rows);
  if (p.status === 'captured' && num(p.refund_due_minor) > 0) return Math.round(num(p.refund_due_minor));
  return 0;
}

/** Is this row money taken (never a hold, never a refund, never money owed back in full)? */
export function isMoneyTaken(p) {
  if (!p || p.kind === 'hold' || p.kind === 'refund' || isNeedsRefund(p)) return false;
  if (p.status === 'captured') return true;
  return p.kind === NO_SHOW_KIND && p.status === 'authorised';
}

/** The status a person reads: a saved card is "Card saved", money owed back says so. */
export function payStatusName(p) {
  if (!p) return '';
  if (isNeedsRefund(p)) return p.kind === 'hold' ? 'Card saved late' : 'Owed back';
  if (p.kind === 'hold' && p.status === 'authorised') return 'Card saved';
  return PAY_STATUS_NAMES[p.status] || String(p.status || '');
}

/**
 * One line per payment row for the Booking payments table and CSV.
 *   payments      booking_payments rows
 *   bookingsById  Map id -> camelCase booking (or a plain object)
 *   tableLabel    (id) => label
 *   dayOf         (iso) => 'YYYY-MM-DD' on the venue clock (the business day it was paid)
 */
export function paymentLines({ payments = [], bookingsById = new Map(), tableLabel = (id) => id, dayOf = (iso) => String(iso || '').slice(0, 10) } = {}) {
  const get = (id) => (bookingsById instanceof Map ? bookingsById.get(id) : bookingsById?.[id]) || null;
  return (Array.isArray(payments) ? payments : []).map((p) => {
    const b = get(p.booking_id);
    const cur = upper(p.currency) || 'GBP';
    const isHold = p.kind === 'hold';
    return {
      id: p.id,
      siteId: p.siteId ?? p.location_id ?? null,
      siteName: p.siteName ?? null,
      day: dayOf(p.captured_at || p.authorised_at || p.created_at),
      at: p.captured_at || p.authorised_at || p.created_at || null,
      status: p.status,
      statusName: payStatusName(p),
      kind: p.kind,
      kindName: KIND_NAMES[p.kind] || String(p.kind || ''),
      guest: b?.customer?.name || '',
      phone: b?.customer?.phone || '',
      table: b ? (b.tables && b.tables.length ? b.tables : [b.primaryTableId]).filter(Boolean).map(tableLabel).join(' + ') : '',
      bookingId: p.booking_id,
      bookingDate: b?.date || '',
      bookingTime: b?.startTime || '',
      bookingStatus: b ? (STATUS_NAMES[b.status] || b.status) : '',
      covers: b?.covers ?? null,
      cardEnding: p.card_last4 || '',
      cardBrand: p.card_brand || '',
      currency: cur,
      // A hold's figure is what the hold covers, never money: shown apart, never summed.
      amountMinor: isHold ? 0 : minorOf(p.amount),
      holdMinor: isHold ? holdFigureMinor(p) : 0,
      // given back on this payment (refund rows and amount_refunded_minor); a refund row itself 0
      refundedMinor: isHold || p.kind === 'refund' ? 0
        : p.status === 'refunded' ? Math.max(minorOf(p.amount), refundedMinorFor(p, payments))
        : refundedMinorFor(p, payments),
      taken: isMoneyTaken(p),
      appliedToCheck: !!p.applied_to_check,
      appliedCheckId: p.applied_check_id || null,
      appliedMinor: p.applied_minor == null ? null : Math.round(num(p.applied_minor)),
      owedBackMinor: owedBackMinor(p, payments),
      note: p.status === 'failed' ? String(p.refusal_reason || '') : (p.refund_reason || (isNeedsRefund(p) ? String(p.refusal_reason || '') : '')),
    };
  });
}

/** Totals per currency over payment lines: taken by kind, owed back, refunded, failed, cards saved. */
export function paymentTotals(lines) {
  const out = {};
  for (const l of Array.isArray(lines) ? lines : []) {
    const t = (out[l.currency] ||= { prepay: 0, deposit: 0, noShow: 0, taken: 0, owedBack: 0, refunded: 0, failed: 0, cardsSaved: 0, notOnCheck: 0, rows: 0 });
    t.rows += 1;
    if (l.taken) {
      t.taken += l.amountMinor;
      if (l.kind === 'prepay') t.prepay += l.amountMinor;
      if (l.kind === 'deposit') t.deposit += l.amountMinor;
      if (l.kind === NO_SHOW_KIND) t.noShow += l.amountMinor;
      if (!l.appliedToCheck) t.notOnCheck += 1;
    }
    t.owedBack += l.owedBackMinor;
    // refunds are counted on the payment they give back (never twice through the refund row)
    t.refunded += l.refundedMinor ?? (l.status === 'refunded' && l.kind !== 'refund' ? l.amountMinor : 0);
    if (l.status === 'failed') t.failed += 1;
    if (l.kind === 'hold' && l.status === 'authorised') t.cardsSaved += 1;
  }
  return out;
}

/** The filters on the Booking payments tab. 'all' passes everything. */
export function filterLines(lines, { status = 'all', kind = 'all' } = {}) {
  return (Array.isArray(lines) ? lines : []).filter((l) => {
    if (kind !== 'all' && l.kind !== kind) return false;
    if (status === 'all') return true;
    if (status === 'taken') return l.taken;
    if (status === 'owed') return l.owedBackMinor > 0;
    if (status === 'not_on_check') return l.taken && !l.appliedToCheck;
    return l.status === status;
  });
}
