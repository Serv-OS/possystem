// noShowCharge.js: the no show and late cancel charge, as pure rules (16 Oct 2026).
//
// Peter, 16 Oct 2026: guests at a card hold venue save a card when they book (booking-widget
// booking_pay: storePaymentMethod, recurringProcessingModel UnscheduledCardOnFile, shopper
// reference = the guest's customer id). Until now nothing could ever charge it, so the hold
// held nothing. This file decides WHEN a booking may be charged, HOW MUCH, and builds the
// closed check the fee is posted to, so it reaches reports, VAT and Xero like any sale.
//
// ONE copy of the rules, used by:
//   - supabase/functions/booking-charge (the only door that charges the card)
//   - the web app (host stand Inspector, Back Office booking payments)
// KEEP BYTE IDENTICAL: supabase/functions/_shared/noShowCharge.js and
// src/lib/bookings/noShowCharge.js. noShowChargeParity.test.js fails the build when they
// drift (Deno cannot import from src/).
//
// Money is in MINOR units (pence or cents) unless a name says otherwise. Rows arrive as the
// database has them (snake_case). No I/O, no globals. The clock is passed in.

export const NO_SHOW_KIND = 'no_show_charge';

// A charge row that took money (or is being taken): never charge again while one exists.
export const TAKEN_STATUSES = ['authorised', 'captured'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const minorOf = (amount) => Math.round(num(amount) * 100);
const isNeedsRefund = (p) => !!p
  && (p.status === 'needs_refund' || /^needs refund/i.test(String(p.refusal_reason || '')));

const SYMBOL = { GBP: '£', USD: '$', EUR: '€' };

/** "£30.00" in the venue currency (whole pence always shown: this is money taken). */
export function moneyText(minor, currency = 'GBP') {
  const code = String(currency || 'GBP').toUpperCase();
  const v = (Math.round(num(minor)) / 100).toFixed(2);
  return SYMBOL[code] ? `${SYMBOL[code]}${v}` : `${code} ${v}`;
}

/** The payment rows a booking's no show charge lives in. */
export const noShowRows = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.kind === NO_SHOW_KIND);

/**
 * The ledger WITHOUT no show charges, for every screen that reads the ledger as money paid
 * with the booking (credit on the bill, Undo no-show, "paid online"). A no show fee is the
 * venue's revenue, never the guest's credit. null stays null (not read yet).
 */
export function withoutNoShowCharges(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.filter((r) => !r || r.kind !== NO_SHOW_KIND);
}

/** The latest charge that took money, or null. */
export function takenCharge(rows) {
  const list = noShowRows(rows).filter((r) => TAKEN_STATUSES.includes(r.status) && !isNeedsRefund(r));
  return list.length ? list[list.length - 1] : null;
}

/**
 * The latest charge that EVER took money, even if some or all of it was given back since: a
 * refund (partial or full) marks the row refunded, and a booking is still only charged once
 * (£40 charged, £10 back as goodwill, a second tap must not take £40 more). A charge that was
 * only authorised and then released (cancelled) took nothing, so it does not count.
 */
export function everCharged(rows) {
  const list = noShowRows(rows).filter((r) => r.status === 'refunded' || !!r.captured_at
    || (!!r.authorised_at && r.status !== 'cancelled' && r.status !== 'failed'));
  return list.length ? list[list.length - 1] : null;
}

/** "3 hours before", "1 hour before", or "after the booking time" (a cancel made after the start). */
export function hoursText(h) {
  const n = Math.round(num(h));
  if (num(h) < 0) return 'after the booking time';
  return `${n} hour${n === 1 ? '' : 's'} before`;
}

/** A charge waiting for the bank longer than this with no Adyen reference never reached Adyen's answer. */
export const STALE_IN_FLIGHT_MS = 10 * 60 * 1000;

// ── the venue clock ─────────────────────────────────────────────────────────────────────────

// The venue wall clock of an instant, as minutes since 1970 read as if the wall clock were UTC.
// Two wall clocks can then be subtracted. A change of the clocks (BST) can move the answer by
// one hour on two nights a year; the window is a whole number of hours, so that is accepted.
function wallMinutes(epochMs, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(epochMs));
  } catch {
    return null;
  }
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const h = get('hour') === 24 ? 0 : get('hour');
  const ms = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'));
  return Number.isFinite(ms) ? ms / 60000 : null;
}

function bookingWallMinutes(bookingDate, startTime) {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(bookingDate || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(startTime || ''));
  if (!d || !t) return null;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])) / 60000;
}

/**
 * Was a cancellation inside the venue's cancellation window? On the VENUE clock, never the
 * device's (Peter is in California, the venues are in the UK).
 *   { late: true | false | null, hoursBefore }
 * late null = cannot tell (no cancel time on record, or no booking time). A window of 0 (or
 * none) means no late cancellations at all. A cancel after the booking time is late.
 */
export function lateCancel({ bookingDate, startTime, cancelledAtMs, tz, windowHours } = {}) {
  const hours = Math.max(0, Math.round(num(windowHours)));
  const start = bookingWallMinutes(bookingDate, startTime);
  const ms = cancelledAtMs == null || cancelledAtMs === '' ? NaN
    : (typeof cancelledAtMs === 'number' ? cancelledAtMs : Date.parse(cancelledAtMs));
  if (start == null || !Number.isFinite(ms)) return { late: null, hoursBefore: null };
  const at = wallMinutes(ms, tz);
  if (at == null) return { late: null, hoursBefore: null };
  const hoursBefore = Math.round(((start - at) / 60) * 10) / 10;
  if (!(hours > 0)) return { late: false, hoursBefore };
  return { late: hoursBefore < hours, hoursBefore };
}

// ── how much ────────────────────────────────────────────────────────────────────────────────

/**
 * The fee for a no show or a late cancel: the card hold the guest agreed to when they booked.
 * In order:
 *   1. what the booking widget stored as due for the hold (payment_kind hold, payment_due_minor)
 *   2. the hold row's figure (booking_pay stores the hold amount on the row; Adyen was sent 0)
 *   3. the venue's hold per cover times the covers, as the rules say today
 * { amountMinor, perCoverMinor, covers, source: 'booking' | 'hold' | 'rules' | null }
 */
export function noShowFee({ booking, holdRow = null, rules = null } = {}) {
  const covers = Math.max(1, Math.round(num(booking?.covers)) || 1);
  const out = (amountMinor, source) => ({
    amountMinor, covers, source, perCoverMinor: amountMinor > 0 ? Math.round(amountMinor / covers) : 0,
  });
  if (booking?.payment_kind === 'hold' && num(booking?.payment_due_minor) > 0) {
    return out(Math.round(num(booking.payment_due_minor)), 'booking');
  }
  if (holdRow && minorOf(holdRow.amount) > 0) return out(minorOf(holdRow.amount), 'hold');
  const perCover = minorOf(rules?.hold_per_cover);
  if (perCover > 0) return out(perCover * covers, 'rules');
  return out(0, null);
}

// ── may this booking be charged ────────────────────────────────────────────────────────────

const TIME = (ms, tz) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(typeof ms === 'number' ? ms : Date.parse(ms)));
  } catch { return ''; }
};

/**
 * The decision for one booking. Pure: every row is handed in.
 *   booking   bookings row (status, covers, customer_id, booking_date, start_time, cancelled_at,
 *             payment_kind, payment_due_minor, payment_currency)
 *   payments  every booking_payments row of the booking (service role read: with
 *             stored_payment_method_id)
 *   rules     booking_rules row (hold_per_cover, cancellation_window_hours)
 *   customer  customers row (stored_payment_method_id, shopper_reference) or null
 *   tz        the venue timezone
 *   currency  the venue currency
 * Returns { ok, kind, reason, message, amountMinor, currency, last4, brand, storedId,
 *           shopperReference, covers, perCoverMinor, windowHours, hoursBefore, charge }
 *   ok true    the card may be charged amountMinor now (kind 'no_show' or 'late_cancel')
 *   charge     the charge already taken, when there is one
 */
export function chargeDecision({ booking, payments = [], rules = null, customer = null, tz = 'Europe/London', currency = 'GBP', nowMs = null } = {}) {
  const rows = Array.isArray(payments) ? payments : [];
  const cur = String(booking?.payment_currency || currency || 'GBP').toUpperCase();
  const windowHours = Math.max(0, Math.round(num(rules?.cancellation_window_hours)));
  const base = {
    ok: false, kind: null, reason: null, message: '', amountMinor: 0, currency: cur,
    last4: null, brand: null, storedId: null, shopperReference: null,
    covers: Math.max(1, Math.round(num(booking?.covers)) || 1), perCoverMinor: 0,
    windowHours, hoursBefore: null, charge: null,
  };
  const no = (reason, message, extra = {}) => ({ ...base, ...extra, ok: false, reason, message });
  if (!booking) return no('unknown_booking', 'This booking could not be found.');

  const taken = takenCharge(rows);
  if (taken) {
    const last4 = taken.card_last4 ? ` to the card ending ${taken.card_last4}` : '';
    return no('already_charged', `${moneyText(minorOf(taken.amount), taken.currency || cur)} was charged${last4}. A booking is only charged once.`, { charge: taken });
  }
  const ever = everCharged(rows);
  if (ever) {
    return no('already_charged', `${moneyText(minorOf(ever.amount), ever.currency || cur)} was charged on this booking, then refunded. A booking is only charged once.`,
      { charge: ever, kind: kindOfReference(ever.merchant_reference) });
  }
  const inFlight = noShowRows(rows).find((r) => r.status === 'pending');
  if (inFlight) {
    const at = inFlight.created_at ? ` at ${TIME(inFlight.created_at, tz)}` : '';
    // No Adyen reference after 10 minutes: the request may never have reached Adyen (a dropped
    // connection, the function stopped before sending), so no webhook will ever settle it. The
    // host may ask again: the SAME request is re-sent with the same idempotency key, so Adyen
    // replays its first answer if it had one, or takes the charge once if it never got it.
    const created = Date.parse(inFlight.created_at || '');
    const stale = Number.isFinite(nowMs) && Number.isFinite(created) && nowMs - created > STALE_IN_FLIGHT_MS
      && !inFlight.psp_reference && (booking.status === 'no_show' || booking.status === 'cancelled');
    if (stale) {
      const amountMinor = minorOf(inFlight.amount);
      return no('stale_in_flight', `A charge of ${moneyText(amountMinor, inFlight.currency || cur)} was started${at} and the bank never answered. Check with the bank again: the same charge is asked for again, so the card cannot be charged twice.`, {
        retry: inFlight, amountMinor, kind: kindOfReference(inFlight.merchant_reference),
        last4: inFlight.card_last4 || null, brand: inFlight.card_brand || null,
      });
    }
    return no('charge_in_flight', `A charge was started${at} and the bank has not answered yet. Do not charge again; it shows here when Adyen answers.`);
  }

  // Which charge, if any.
  let kind = null;
  let hoursBefore = null;
  if (booking.status === 'no_show') kind = 'no_show';
  else if (booking.status === 'cancelled') {
    const lc = lateCancel({
      bookingDate: booking.booking_date, startTime: booking.start_time,
      cancelledAtMs: booking.cancelled_at, tz, windowHours,
    });
    hoursBefore = lc.hoursBefore;
    if (lc.late === null) return no('cancel_time_unknown', 'This booking has no cancellation time on record, so it cannot be charged as a late cancellation.');
    if (!(windowHours > 0)) return no('no_window', 'This venue has no cancellation window, so a cancellation is never charged.', { hoursBefore });
    if (!lc.late) {
      return no('outside_window', `Cancelled ${hoursText(hoursBefore)} the booking, outside the ${windowHours} hour window. Nothing can be charged.`, { hoursBefore });
    }
    kind = 'late_cancel';
  } else {
    return no('not_chargeable', 'Only a no show, or a cancellation inside the cancellation window, can be charged.');
  }

  // Money already paid with the booking is the venue's to keep or refund: no second charge.
  const paid = rows.find((r) => (r.kind === 'prepay' || r.kind === 'deposit') && r.status === 'captured' && !isNeedsRefund(r));
  if (paid) {
    const what = paid.kind === 'prepay' ? 'prepaid' : 'deposit paid';
    return no('money_on_file', `${moneyText(minorOf(paid.amount), paid.currency || cur)} was already ${what} with this booking. Keep it or refund it; the card is not charged again.`, { kind, hoursBefore });
  }

  // The card saved FOR THIS BOOKING. The token rides the hold row, or (when Adyen sent it on
  // the webhook instead) the guest's record; either way only when this booking saved a card.
  const hold = rows.filter((r) => r.kind === 'hold' && r.status === 'authorised' && !isNeedsRefund(r)).pop() || null;
  if (!hold) return no('no_card', 'No card was saved with this booking, so there is nothing to charge.', { kind, hoursBefore });
  // The guest record holds the card saved MOST RECENTLY, at any booking, which may not be the
  // card on this hold row. Then the hold's last 4 is never shown: the host is asked about "the
  // saved card", never told one card while another is charged.
  const fromHold = !!hold.stored_payment_method_id;
  const storedId = hold.stored_payment_method_id || customer?.stored_payment_method_id || null;
  const shopperReference = customer?.shopper_reference || booking.customer_id || null;
  if (!storedId || !shopperReference) {
    return no('no_token', 'A card was saved, but Adyen never sent back the token needed to charge it. Take the charge another way.', { kind, hoursBefore, last4: hold.card_last4 || null, brand: hold.card_brand || null });
  }

  const fee = noShowFee({ booking, holdRow: hold, rules });
  if (!(fee.amountMinor > 0)) return no('no_fee', 'This venue has no card hold amount set, so there is no fee to charge.', { kind, hoursBefore });

  return {
    ...base, ok: true, kind, reason: null, message: '',
    amountMinor: fee.amountMinor, perCoverMinor: fee.perCoverMinor, covers: fee.covers,
    last4: fromHold ? (hold.card_last4 || null) : null, brand: fromHold ? (hold.card_brand || null) : null,
    storedId, shopperReference, hoursBefore,
  };
}

/**
 * A reply that means the booking-charge function is not on the server yet (the screens stay
 * quiet then, rather than show a button that cannot work). A 404 that names the booking is the
 * function answering, not a missing function.
 */
export function isMissingFunctionReply({ status = null, message = '' } = {}) {
  if (status === 404 && !/unknown_booking|could not be found/i.test(String(message))) return true;
  return /function not found|requested function was not found|not_found/i.test(String(message));
}

/** The question the host is asked: "Charge £30.00 to the card ending 4242?" */
export function chargeQuestion({ amountMinor, currency, last4 } = {}) {
  return `Charge ${moneyText(amountMinor, currency)} to ${last4 ? `the card ending ${last4}` : 'the saved card'}?`;
}

/** What a charge is called on the check, the ledger and the reports. */
export const chargeLabel = (kind) => (kind === 'late_cancel' ? 'Late cancellation charge' : 'No show charge');

// ── the Adyen side ──────────────────────────────────────────────────────────────────────────

/**
 * The merchant reference: bkpay-<booking>-noshow-a<N> or bkpay-<booking>-latecancel-a<N>.
 * bkpay- so the Adyen ledger files it under bookings; the middle word says which charge it was.
 */
export const chargeReference = (bookingId, attempt, kind = 'no_show') =>
  `bkpay-${bookingId}-${kind === 'late_cancel' ? 'latecancel' : 'noshow'}-a${Math.max(1, Math.floor(num(attempt)) || 1)}`;

/** Which charge a reference names: 'late_cancel' or 'no_show'. */
export const kindOfReference = (reference) => (/-latecancel-a\d+$/.test(String(reference || '')) ? 'late_cancel' : 'no_show');

/** The attempt number of the next charge: one more than every charge row so far. */
export const nextAttempt = (rows) => noShowRows(rows).length + 1;

const REFUSAL_WORDS = [
  [/not enough balance|insufficient/i, 'there is not enough money on the card'],
  [/expired/i, 'the card has expired'],
  [/blocked|lost|stolen|restricted/i, 'the card is blocked'],
  [/withdrawal|limit/i, 'the card is over its limit'],
  [/authentication|3d|sca/i, 'the bank wants the guest to approve this charge themselves'],
  [/cvc/i, 'the card details were refused'],
  [/fraud/i, 'the bank flagged it as possible fraud'],
  [/acquirer error|issuer unavailable|not supported/i, 'the card network could not take it right now'],
  [/do not honou?r|declined|refused/i, 'the bank declined it'],
];

/** Plain words for an Adyen answer that did not take the money. Always says nothing was taken. */
export function refusalWords(resultCode, refusalReason) {
  const code = String(resultCode || '');
  const why = String(refusalReason || '');
  const hit = REFUSAL_WORDS.find(([re]) => re.test(why));
  if (code === 'Refused') return `The card was declined: ${hit ? hit[1] : (why ? why.toLowerCase() : 'the bank said no')}. Nothing was taken.`;
  if (code === 'Cancelled') return 'The charge was cancelled. Nothing was taken.';
  if (code === 'Error') return `Adyen could not take the charge${why ? ` (${why})` : ''}. Nothing was taken.`;
  return `The charge did not go through${why ? ` (${why})` : ''}. Nothing was taken.`;
}

// ── the closed check ────────────────────────────────────────────────────────────────────────

// djb2, base 36: a short stable tag for the check ref.
function tag(s) {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36).toUpperCase().padStart(5, '0').slice(-5);
}

/** The check id and ref of one charge attempt. Stable, so a second post is the same check. */
export function chargeCheckIds(bookingId, attempt) {
  const n = Math.max(1, Math.floor(num(attempt)) || 1);
  return { id: `bkns-${bookingId}-a${n}`, ref: `NS-${tag(`${bookingId}|${n}`)}` };
}

/** The attempt number in a charge reference, or 1. */
export function attemptOf(reference) {
  const m = /-(?:noshow|latecancel)-a(\d+)$/.exec(String(reference || ''));
  return m ? Number(m[1]) : 1;
}

const round2 = (x) => Math.round((num(x) + Number.EPSILON) * 100) / 100;

/**
 * The VAT rate a fee is booked at: the venue's default active rate, else its first active
 * rate. null when the venue has no rates (it books no VAT, like every sale there).
 */
export function feeRate(rates) {
  const live = (Array.isArray(rates) ? rates : []).filter((r) => r && r.active !== false);
  return live.find((r) => r.is_default) || live[0] || null;
}

// A no show or late cancel fee pays for a meal that never took place. UK policy generally treats
// that as compensation, outside the scope of VAT (HMRC withdrew its 2020 change on retained
// deposits). PETER DECIDES (with the accountant): until then no VAT is taken out of the fee.
// The 0% entry is named so the Xero posting files it as outside the scope (NONE), and share 0
// makes every report take the record as booked instead of working VAT out from the line.
export const OUTSIDE_SCOPE_RATE = Object.freeze({
  id: null, code: 'OUTSIDE', name: 'Outside the scope of VAT', rate: 0, type: 'inclusive',
  active: true, appliesTo: ['all'], isDefault: false, locationId: null,
});

/**
 * The tax record of a fee. An INCLUSIVE venue (UK VAT): the fee books NO VAT, recorded as
 * outside the scope of VAT (see OUTSIDE_SCOPE_RATE). An EXCLUSIVE rate (US sales tax) is never
 * added on top: the guest agreed to the fee as stated, so the fee books no tax and the record
 * says why. A venue with no rates books no record, like every sale there.
 *   { taxAmount, record }
 */
export function feeTax(amountMinor, rate) {
  const gross = round2(Math.round(num(amountMinor)) / 100);
  if (!rate) return { taxAmount: null, record: null };
  if ((rate.type || 'inclusive') !== 'inclusive') {
    return {
      taxAmount: 0,
      record: {
        total: gross, subtotal: gross, totalTax: 0, exclusiveTax: 0, hasExclusiveTax: false, breakdown: [],
        source: 'no_show_charge', note: 'No sales tax is added to a no show or late cancellation charge.',
      },
    };
  }
  return {
    taxAmount: 0,
    record: {
      total: gross, subtotal: gross, totalTax: 0, exclusiveTax: 0, hasExclusiveTax: false, share: 0,
      breakdown: [{ net: gross, tax: 0, rate: { ...OUTSIDE_SCOPE_RATE }, gross, items: 1 }],
      source: 'no_show_charge', note: 'Outside the scope of VAT: a no show or late cancellation charge is not a sale.',
    },
  };
}

/** closed_checks.source of a charge check. 20261016f adds it to closed_checks_source_check. */
export const CHARGE_SOURCE = 'booking';
/** The source posted instead while the live constraint does not take 'booking' yet. */
export const CHARGE_SOURCE_FALLBACK = 'online';

/** Was this insert refused by closed_checks_source_check (the migration has not run yet)? */
export function isSourceCheckRefusal(error) {
  const e = error || {};
  const text = `${e.message || ''} ${e.details || ''}`;
  return String(e.code || '') === '23514' && /closed_checks_source_check/.test(text);
}

/**
 * The closed_checks row a charge is posted to, so it reaches every report, the VAT and Xero
 * the same way as a sale: one line, paid by card on Adyen, no covers (nobody ate).
 *   booking   bookings row
 *   charge    { pspReference, amountMinor, currency, last4, brand, reference }
 *   kind      'no_show' | 'late_cancel'
 *   rate      feeRate(the venue's tax_rates)
 *   staffName who charged it (the host stand operator), or null
 *   closedAt  ISO time it was charged
 */
export function chargeCheckRow({ booking, charge, kind, rate = null, staffName = null, closedAt, source = CHARGE_SOURCE } = {}) {
  const attempt = attemptOf(charge?.reference);
  const { id, ref } = chargeCheckIds(booking?.id, attempt);
  const gross = round2(Math.round(num(charge?.amountMinor)) / 100);
  const label = chargeLabel(kind);
  const cust = booking?.customer && typeof booking.customer === 'object' ? booking.customer : {};
  const when = `${String(booking?.booking_date || '')} ${String(booking?.start_time || '').slice(0, 5)}`.trim();
  const { taxAmount, record } = feeTax(charge?.amountMinor, rate);
  const card = (charge?.last4 || charge?.brand) ? { brand: charge.brand || null, last4: charge.last4 || null } : null;
  const coversN = Math.max(1, Math.round(num(booking?.covers)) || 1);
  return {
    id,
    ref,
    location_id: booking?.location_id ? String(booking.location_id) : null,
    table_id: null,
    table_label: label,
    staff_name: staffName || null,
    server: staffName || null,
    items: [{
      uid: 'ns1', itemId: null, cat: null, name: label, receiptName: null, kitchenName: null,
      qty: 1, price: gross, mods: [], seat: 'shared', course: 0, fired: true, status: 'sent', voided: false,
      notes: `Booking ${when}, ${coversN} cover${coversN === 1 ? '' : 's'}`,
      taxRateId: null, taxOverrides: {}, allergens: [], parentId: null, centreId: null, pizzaConfig: null,
    }],
    subtotal: gross,
    tax: 0,
    total: gross,
    service: 0,
    tip: 0,
    discounts: [],
    covers: 0,
    order_type: 'dine-in',
    method: 'card',
    payment_method: 'card',
    processor: 'adyen',
    status: 'paid',
    voided: false,
    refunded: false,
    source,
    closed_at: closedAt,
    customer: {
      name: cust.name || null, phone: cust.phone || null, email: cust.email || null,
      // Says what the check is even when it had to be posted as source 'online' (before
      // migration 20261016f lets closed_checks take 'booking').
      charge_source: CHARGE_SOURCE, booking_id: booking?.id ? String(booking.id) : null,
    },
    customer_id: booking?.customer_id || null,
    customer_phone: cust.phone || null,
    tax_amount: taxAmount,
    tax_breakdown: record,
    tenders: [{ method: 'card', amount: gross, tip: 0, psp_ref: charge?.pspReference || null, processor: 'adyen' }],
    payment_intents: [{ id: charge?.pspReference || null, amountMinor: Math.round(num(charge?.amountMinor)), ...(card ? { card } : {}) }],
  };
}
