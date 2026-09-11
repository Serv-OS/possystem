// src/lib/payments/venueFees.js
//
// What a VENUE paid and received on its ServOS Payments card payments, and
// which rows a venue screen shows. PURE: no Supabase, no network, no device
// clock.
//
// MIRROR: supabase/functions/_shared/venueFees.ts carries the SAME helpers
// (Deno cannot import from src/). KEEP IN SYNC: change both or neither.
// src/lib/payments/venueFees.test.js is the contract for both copies.
//
// THE RULE (owner, 11 Sep 2026). A venue pays its card rate (the rate card,
// for example 0.8% plus 5p in person). That fee is stamped on every payment
// at authorisation as adyen_payments.commission_minor (rate_category names
// the tier), and Adyen's own balance platform bookings matched it on live
// payments (£1.00: 6p, venue received 94p; £2.50: 7p, venue received £2.43).
// adyen_payments.fee_minor is ADYEN'S COST to the platform (interchange,
// scheme fees, Adyen charge). A venue must NEVER see that, or the margin.
//
// COUNTED. Twin of payments-admin (the admin Revenue screen and the FranPOS
// invoice): a successful authorisation, not cancelled, whose money moved. A
// CAPTURE_FAILED with no successful capture, and a hold (capture_required)
// never captured, are NOT counted: no fee, no You receive, not in the tiles.
// The rows need applied_mods (raw->applied_modifications), capture_required
// and captured_at for this; a row without them reads as auto captured.
//
// HOLDS. A hold can be captured for less than it held (a QR open tab closed
// below its hold). adyen-webhook restamps amount_minor and commission_minor on
// that capture from 11 Sep 2026 and records raw.captured_minor. A hold row is
// only rated when its captured amount is known and matches amount_minor, so a
// fee is never worked out on money that was never taken.
//
// REFUNDS. The split refunds by ratio (refund: deductAccordingToSplitRatio),
// so the venue fee shrinks in proportion to what is refunded:
//   fee = half up rounding of commission * (amount - refunded) / amount
// A half refund of £2.50 at 7p is 3.5p, which rounds up to 4p, so the venue
// receives 250 - 125 - 4 = 121.
//
// VISIBILITY. adyen_payments.live is true for the Adyen live environment,
// false for test, null on rows from before 7 Sep 2026. A live venue shows only
// live true rows unless the viewer asks for test rows; a test venue shows the
// rows whose live is not true.

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const minor = (v) => Math.round(numOrNull(v) ?? 0);

// Did any capture SUCCEED on this row? applied_mods is the settlement truth
// that survives a stale CAPTURE_FAILED overwriting last_event_code.
export function hasSuccessfulCapture(row) {
  return Array.isArray(row?.applied_mods)
    && row.applied_mods.some((m) => String(m).startsWith('CAPTURE:') && String(m).endsWith(':true'));
}

// A successful authorisation whose money never moved: a capture that failed
// with no successful capture anywhere, or a hold never captured.
export function isUncapturedPayment(row) {
  if (!row || row.success !== true || row.last_event_code === 'CANCELLATION') return false;
  const captured = hasSuccessfulCapture(row);
  if (row.last_event_code === 'CAPTURE_FAILED' && !captured) return true;
  if (row.capture_required === true && !row.captured_at && !captured) return true;
  return false;
}

// A payment the tiles count: successful, not cancelled, and captured.
export function isCountedPayment(row) {
  return !!row && row.success === true && row.last_event_code !== 'CANCELLATION' && !isUncapturedPayment(row);
}

// What a capture took on a hold: raw.captured_minor (selected as
// captured_minor), else the last modification when that was the successful
// capture (last_mod_code, last_mod_ok, last_mod_amount). null when not known.
export function capturedMinorFor(row) {
  const stamped = numOrNull(row?.captured_minor);
  if (stamped !== null) return Math.round(stamped);
  if (String(row?.last_mod_code ?? '') === 'CAPTURE' && String(row?.last_mod_ok ?? '') === 'true') {
    const amount = numOrNull(row?.last_mod_amount);
    if (amount !== null) return Math.round(amount);
  }
  return null;
}

// The full venue fee before refunds, or null: not counted, no fee on record,
// or a hold whose captured amount is not known to match amount_minor.
function commissionFor(row) {
  if (!isCountedPayment(row)) return null;
  const commission = numOrNull(row.commission_minor);
  if (commission === null) return null;
  if (row.capture_required === true) {
    const captured = capturedMinorFor(row);
    const amount = numOrNull(row.amount_minor);
    if (captured === null || amount === null || captured !== Math.round(amount)) return null;
  }
  return Math.max(0, Math.round(commission));
}

// The fee left after `refunded` of `amount` is refunded (integer half up).
function feeAfterRefund(fee, amount, refunded) {
  if (refunded <= 0) return fee;
  if (amount <= 0) return 0;
  const kept = Math.max(0, amount - refunded);
  return Math.max(0, Math.floor((2 * fee * kept + amount) / (2 * amount)));
}

// The venue fee in minor units, reduced by the refund ratio. null when the
// row is not a counted payment or has no fee on record.
export function venueFeeFor(row) {
  const commission = commissionFor(row);
  if (commission === null) return null;
  return feeAfterRefund(commission, minor(row.amount_minor), Math.max(0, minor(row.amount_refunded_minor)));
}

// What the venue receives: amount minus refunded minus the venue fee. null
// when the fee is null.
export function venueReceivesFor(row) {
  const fee = venueFeeFor(row);
  if (fee === null) return null;
  return minor(row.amount_minor) - Math.max(0, minor(row.amount_refunded_minor)) - fee;
}

// Whether a payment row shows on a venue screen.
export function isVisiblePayment(row, venueEnv, includeTest) {
  const isLiveRow = row?.live === true;
  if (String(venueEnv ?? '').trim().toLowerCase() === 'live') return isLiveRow || includeTest === true;
  return !isLiveRow;
}

// Sums over a set of rows, ONE rule for the Payments tiles and the statement.
// Only counted payments add up: gross, refunds and fees. receives_minor is
// null while any counted payment has no fee on record (the same as a payout),
// because its fee is not known; unrated_gross_minor says how much that is.
export function summarizeVenueFees(rows) {
  const out = {
    count: 0, gross_minor: 0, refunds_minor: 0, fees_minor: 0, receives_minor: 0,
    fees_rated: 0, fees_unrated: 0, unrated_gross_minor: 0, not_captured: 0,
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (isUncapturedPayment(r)) { out.not_captured++; continue; }
    if (!isCountedPayment(r)) continue;
    out.count++;
    out.gross_minor += minor(r.amount_minor);
    out.refunds_minor += Math.max(0, minor(r.amount_refunded_minor));
    const fee = venueFeeFor(r);
    if (fee === null) { out.fees_unrated++; out.unrated_gross_minor += minor(r.amount_minor); continue; }
    out.fees_rated++;
    out.fees_minor += fee;
    out.receives_minor += venueReceivesFor(r);
  }
  if (out.fees_unrated > 0) out.receives_minor = null;
  return out;
}

// ── Payout lines ─────────────────────────────────────────────────────────────
// A settlement report line a venue may see: money that moved on one of its
// payments. Fee, MiscCosts, PaymentCost, SettleCost, InvoiceDeduction and the
// account level lines (MerchantPayout, DepositCorrection, Balancetransfer) are
// Adyen cost or platform account movements and never reach a venue.
export const PAYOUT_SALE_LINE_TYPES = Object.freeze(['Settled', 'SettledExternally']);
export const PAYOUT_VENUE_LINE_TYPES = Object.freeze([
  'Settled', 'SettledExternally',
  'Refunded', 'RefundedExternally', 'RefundedReversed',
  'Chargeback', 'SecondChargeback', 'ChargebackReversed',
]);
const PAYOUT_REFUND_LINE_TYPES = Object.freeze(['Refunded', 'RefundedExternally', 'RefundedReversed']);

// One line's venue figures, or null for a line a venue never sees. Each line
// carries what the split booked in ITS batch, so every payout matches the bank:
//   sale line   : the full venue fee (commission, before any refund)
//   refund line : the fee that refund gave back, as a negative fee, so its
//                 receives is the refund less the returned fee (a £1.25
//                 refund of £2.50 at 7p gives back 3p: receives -122)
//   reversed    : a refund reversal takes that fee again (positive gross)
//   dispute line: no fee, receives = gross
// The lines of one payment add up to venueFeeFor and venueReceivesFor. With
// more than one refund on a payment each refund line is worked out on its own,
// so the sum can differ from the payment by a penny of rounding.
// `payment` is the matched adyen_payments row (by psp reference), or null.
export function venuePayoutLine(line, payment) {
  const type = String(line?.line_type ?? '');
  if (!PAYOUT_VENUE_LINE_TYPES.includes(type)) return null;
  const gross = minor(line?.gross_minor);
  const isSale = PAYOUT_SALE_LINE_TYPES.includes(type);
  const isRefund = PAYOUT_REFUND_LINE_TYPES.includes(type);
  if (!isSale && !isRefund) return { gross_minor: gross, fee_minor: null, receives_minor: gross, unrated: false };
  const commission = payment ? commissionFor(payment) : null;
  if (commission === null) return { gross_minor: gross, fee_minor: null, receives_minor: null, unrated: true };
  if (isSale) return { gross_minor: gross, fee_minor: commission, receives_minor: gross - commission, unrated: false };
  const returned = commission - feeAfterRefund(commission, minor(payment.amount_minor), Math.abs(gross));
  const fee = returned === 0 ? 0 : (gross < 0 ? -returned : returned);
  return { gross_minor: gross, fee_minor: fee, receives_minor: gross - fee, unrated: false };
}

// Totals over venuePayoutLine results (nulls skipped). fees_minor is null when
// no line has a fee; receives_minor is null while any line has no fee.
export function summarizeVenuePayout(figures) {
  const out = { line_count: 0, gross_minor: 0, fees_minor: null, receives_minor: 0, fees_unrated: 0 };
  for (const f of Array.isArray(figures) ? figures : []) {
    if (!f) continue;
    out.line_count++;
    out.gross_minor += Number(f.gross_minor) || 0;
    if (f.fee_minor !== null && f.fee_minor !== undefined) out.fees_minor = (out.fees_minor ?? 0) + Number(f.fee_minor);
    if (f.unrated) out.fees_unrated++;
    else out.receives_minor += Number(f.receives_minor) || 0;
  }
  if (out.fees_unrated > 0) out.receives_minor = null;
  return out;
}

// ── Venue clock ──────────────────────────────────────────────────────────────
// Business time is the venue time zone, never the device clock.
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() }); return true; } catch { return false; }
}

// The venue time zone from a platform locations row ({ timezone, currency }):
// the row's zone when it is a real one, else America/New_York for USD and
// Europe/London for everything else.
export function venueTimeZoneFor(loc) {
  const tz = typeof loc?.timezone === 'string' ? loc.timezone.trim() : '';
  if (isValidTimeZone(tz)) return tz;
  return String(loc?.currency ?? '').trim().toUpperCase() === 'USD' ? 'America/New_York' : 'Europe/London';
}

// The current 'YYYY-MM' on the venue clock.
export function venueCurrentMonth(timeZone, now = new Date()) {
  const tz = isValidTimeZone(timeZone) ? String(timeZone).trim() : 'Europe/London';
  const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}

// The UTC offset (ms) of a time zone at an instant.
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

// Venue midnight on a calendar day as a UTC instant (ms). Two passes so a day
// that starts either side of a clock change still lands on the right hour.
function venueMidnightMs(y, monthIndex, day, tz) {
  const wall = Date.UTC(y, monthIndex, day);
  const first = wall - tzOffsetMs(wall, tz);
  return wall - tzOffsetMs(first, tz);
}

// A 'YYYY-MM' month on the venue clock as [fromIso, toIso): venue midnight on
// the 1st to venue midnight on the 1st of the next month. null for a bad month.
export function venueMonthBoundsIso(month, timeZone) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month ?? ''));
  if (!m) return null;
  const tz = isValidTimeZone(timeZone) ? String(timeZone).trim() : 'Europe/London';
  const y = Number(m[1]);
  const mi = Number(m[2]) - 1;
  return {
    fromIso: new Date(venueMidnightMs(y, mi, 1, tz)).toISOString(),
    toIso: new Date(venueMidnightMs(y, mi + 1, 1, tz)).toISOString(),
  };
}
