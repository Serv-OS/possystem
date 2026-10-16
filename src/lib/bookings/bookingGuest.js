// bookingGuest.js: the guest's own link and the guest messages, as pure rules (16 Oct 2026).
//
// Peter is sending a bookings demo to customers who run ResDiary, OpenTable, SevenRooms,
// Collins and Eat App. Every one of those gives the guest a link to change or cancel, a
// reminder the day before and on the day, and a message when anything changes. This file
// decides all of that in plain functions so node:test covers every rule:
//
//   venueClockParts, zonedToEpoch   the VENUE clock (never the server's, never the device's)
//   guestWindow, manageState        may the guest cancel or change online right now, and why not
//   moneyOnBooking, cancelMoney,    what happens to money already paid when the guest cancels or
//   changeMoney, owedBackOnBooking  changes the party (never refunded by itself: flagged as owed back)
//   packageOnDate                   is the booking's package sold on the new date
//   reminderDue                     is the day before or the 2 hours before reminder due now
//   confirmationToSend, cancelToTell, changeToTell   the backstops the 5 minute sweep runs
//   nextAttempt, isPermanentFailure  stop after 3 tries, and at once for a number that can never work
//   calendarLinks                   Google Calendar link and an .ics file for Apple and Outlook
//   guestTemplateData               the merge tags every booking message uses
//
// TWO COPIES, BYTE IDENTICAL: src/lib/bookings/bookingGuest.js (the web app and the tests) and
// supabase/functions/_shared/bookingGuest.js (booking-widget and booking-reminders, Deno cannot
// import from src/). bookingGuestParity.test.js fails the suite when they drift. Edit one, copy
// it over the other.

import { paymentDue, paymentNetMinor, isNeedsRefundRow } from './bookingPayment.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const hm = (s) => String(s || '').slice(0, 5);
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// The statuses a guest's booking is live in (a booking the guest can still turn up to).
export const LIVE_FOR_GUEST = ['confirmed', 'prepaid'];
// A guest message is tried at most this many times, then left as failed with the reason.
export const MAX_SEND_ATTEMPTS = 3;
// Minutes to wait before the second and the third try.
export const RETRY_GAPS_MIN = [10, 30];

// ── the venue clock ───────────────────────────────────────────────────────────

const safeTz = (tz) => {
  const z = String(tz || '').trim() || 'Europe/London';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: z }).format(0); return z; } catch { return 'Europe/London'; }
};

function partsAt(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTz(tz), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of f.formatToParts(new Date(epoch))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// The venue's date ('YYYY-MM-DD') and minute of the day right now.
export function venueClockParts(tz, now = Date.now()) {
  const p = partsAt(now, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return { ymd: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, min: p.h * 60 + p.mi };
}

// The instant (epoch ms) of a venue wall clock date and time ('2026-10-17', '19:30') in tz.
// Correct across the clock change: the offset is read at the guessed instant, then once more.
export function zonedToEpoch(dateISO, time, tz) {
  const [y, mo, d] = String(dateISO || '').split('-').map(Number);
  const [h, mi] = hm(time).split(':').map(Number);
  if (!y || !mo || !d) return NaN;
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  const offsetAt = (t) => {
    const p = partsAt(t, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  const off = offsetAt(guess);
  let t = guess - off;
  const off2 = offsetAt(t);
  if (off2 !== off) t = guess - off2;
  return t;
}

export function addDaysISO(iso, days) {
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (Number.isNaN(t)) return '';
  return new Date(t + num(days) * DAY_MS).toISOString().slice(0, 10);
}

// "Saturday 17 October" (a date has no time zone: read at noon UTC so it never shifts a day).
export function fmtDateWords(iso) {
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (Number.isNaN(t)) return String(iso || '');
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(t));
}

// ── may the guest cancel or change online ─────────────────────────────────────

// The cancellation window: online changes close this many hours before the booking.
// 0 means the guest can change or cancel until the booking starts.
export function guestWindow({ date, startTime, windowHours = 0, tz, now = Date.now() } = {}) {
  const start = zonedToEpoch(date, startTime, tz);
  if (Number.isNaN(start)) return { open: false, reason: 'started', minsLeft: 0 };
  const minsLeft = Math.floor((start - now) / 60000);
  const w = Math.max(0, num(windowHours));
  if (minsLeft <= 0) return { open: false, reason: 'started', minsLeft };
  if (w > 0 && minsLeft < w * 60) return { open: false, reason: 'inside_window', minsLeft };
  return { open: true, reason: null, minsLeft };
}

// What the guest's page offers, with the words for anything it does not.
//   booking  { status, date | booking_date, startTime | start_time }
//   rules    { cancellationWindowHours | cancellation_window_hours, guestManageEnabled | guest_manage_enabled }
// view: 'live' | 'awaiting_payment' | 'cancelled' | 'closed'
export function manageState({ booking, rules = {}, tz, now = Date.now() } = {}) {
  const b = booking || {};
  const status = String(b.status || '');
  const windowHours = Math.max(0, num(rules.cancellationWindowHours ?? rules.cancellation_window_hours));
  const enabled = (rules.guestManageEnabled ?? rules.guest_manage_enabled) !== false;
  const base = { canCancel: false, canChange: false, windowHours, why: null };
  if (status === 'cancelled') return { ...base, view: 'cancelled', why: 'This booking is cancelled.' };
  if (status === 'dining') return { ...base, view: 'closed', why: 'You are at your table. Ask the team if anything needs to change.' };
  if (status === 'departed') return { ...base, view: 'closed', why: 'This booking is finished. We hope to see you again soon.' };
  if (status === 'no_show') return { ...base, view: 'closed', why: 'This booking time has passed.' };
  if (status === 'expired') return { ...base, view: 'closed', why: 'This booking was not paid in time, so the table was released. Please book again.' };
  const date = String(b.date ?? b.booking_date ?? '');
  const startTime = hm(b.startTime ?? b.start_time);
  const win = guestWindow({ date, startTime, windowHours, tz, now });
  if (status === 'pending_payment') {
    // Nothing was paid, so letting the guest give the table back is always safe.
    return { ...base, view: 'awaiting_payment', canCancel: win.reason !== 'started', why: 'This booking is waiting for payment. It can be changed once the payment has gone through.' };
  }
  if (!LIVE_FOR_GUEST.includes(status)) return { ...base, view: 'closed', why: 'This booking can no longer be changed online.' };
  if (!enabled) return { ...base, view: 'live', why: 'To change or cancel, please call the venue.' };
  if (win.reason === 'started') return { ...base, view: 'live', why: 'Your booking time has passed.' };
  if (win.reason === 'inside_window') {
    return { ...base, view: 'live', why: `Online changes close ${windowHours} ${windowHours === 1 ? 'hour' : 'hours'} before your booking. Please call the venue.` };
  }
  return { ...base, view: 'live', canCancel: true, canChange: true };
}

// ── money already paid ────────────────────────────────────────────────────────

const needsRefund = isNeedsRefundRow;

// What a payment row still holds, in minor units: its amount less anything refunded or being
// refunded on it (refund rows and amount_refunded_minor, 20261016d). The ONE shared rule lives in
// bookingPayment.js (v5.11.70 release: the guest, host and reports tracks each had a copy).
export { paymentNetMinor };

// Captured prepay and deposit money that has not been used on a bill and is not already
// flagged to go back, net of any part refund. A saved card (hold) took nothing, so it is
// never money on the booking.
export function moneyOnBooking(payments = []) {
  const rows = (payments || []).filter((p) => p && p.status === 'captured'
    && (p.kind === 'prepay' || p.kind === 'deposit') && !p.applied_to_check && !needsRefund(p)
    && paymentNetMinor(p, payments) > 0);
  const list = rows.map((p) => ({ id: p.id, kind: p.kind, amountMinor: paymentNetMinor(p, payments) }));
  const currency = String(rows[0]?.currency || '').toUpperCase() || null;
  return { capturedMinor: list.reduce((s, r) => s + r.amountMinor, 0), rows: list, currency };
}

// Money already flagged to go back to the guest (a cancel in time), net of any part refund.
export function owedBackOnBooking(payments = []) {
  const rows = (payments || []).filter((p) => p && (p.kind === 'prepay' || p.kind === 'deposit') && needsRefund(p));
  const currency = String(rows[0]?.currency || '').toUpperCase() || null;
  return { owedBackMinor: rows.reduce((s, p) => s + paymentNetMinor(p, payments), 0), currency };
}

// A cancel in time: every captured row is owed back to the guest. The venue refunds it (the
// rows are flagged and raised on the activity feed); nothing is refunded by itself.
export function cancelMoney(payments = []) {
  const m = moneyOnBooking(payments);
  return { owedBackMinor: m.capturedMinor, rowIds: m.rows.map((r) => r.id), currency: m.currency };
}

// The party changes on a booking with money paid. What is owed back is worked out from what
// the guest PAID, never from the package's price today (a price changed since would give back
// the wrong sum):
//   paidCovers   the party the money was taken for (the booking page's request row); missing
//                means the booking's party before this change
//   owed back    captured x (paidCovers - newCovers) / paidCovers, for a per guest price only.
//                It is the WHOLE figure owed back now, not the step: 6 to 4 to 5 owes one
//                seat, 6 to 4 to 6 owes nothing. The caller stores it in place of any older one.
//   top up       more guests than were paid for, at today's price for the extra seats. There
//                is no online top up yet, so the page refuses and the guest calls.
//   state 'none'          nothing was paid
//   state 'settled'       what was paid still covers the party (or cannot be worked out: no
//                         package, or a price per booking that does not move with the party)
//   state 'needs_top_up'  diffMinor more is owed
//   state 'owed_back'     diffMinor goes back unless the bill uses it
export function changeMoney({ pkg = null, oldCovers, newCovers, paidCovers = null, payments = [] } = {}) {
  const m = moneyOnBooking(payments);
  const from = Math.max(1, Math.round(num(oldCovers)) || 1);
  const to = Math.max(1, Math.round(num(newCovers)) || 1);
  const paid = Math.max(1, Math.round(num(paidCovers)) || from);
  const base = { capturedMinor: m.capturedMinor, currency: m.currency };
  if (!m.capturedMinor) return { state: 'none', diffMinor: 0, ...base, capturedMinor: 0 };
  const dueAt = (c) => {
    const due = pkg ? paymentDue({ covers: Math.max(1, c), pkg, rules: null }) : null;
    return due && (due.kind === 'prepay' || due.kind === 'deposit') ? due.amountMinor : null;
  };
  const duePaid = dueAt(paid);
  const settled = { state: 'settled', diffMinor: 0, ...base };
  if (duePaid === null) return settled;
  const perGuest = dueAt(paid + 1) !== duePaid;
  if (!perGuest) return settled;
  if (to > paid) {
    const more = (dueAt(to) ?? duePaid) - duePaid;
    return more > 0 ? { state: 'needs_top_up', diffMinor: more, ...base } : settled;
  }
  if (to < paid) {
    const owed = Math.min(m.capturedMinor, Math.round((m.capturedMinor * (paid - to)) / paid));
    return owed > 0 ? { state: 'owed_back', diffMinor: owed, ...base } : settled;
  }
  return settled;
}

const SYMBOL = { GBP: '£', USD: '$', EUR: '€' };
export function moneyWords(minor, currency = 'GBP') {
  const code = String(currency || 'GBP').toUpperCase();
  const v = (Math.round(num(minor)) / 100).toFixed(2).replace(/\.00$/, '');
  return SYMBOL[code] ? `${SYMBOL[code]}${v}` : `${code} ${v}`;
}

// Is a package sold on this date (its date range and its days of the week)?
export function packageOnDate(pkg, dateISO) {
  if (!pkg) return true;
  const from = pkg.available_from ?? pkg.availableFrom;
  const to = pkg.available_to ?? pkg.availableTo;
  if (from && dateISO < String(from)) return false;
  if (to && dateISO > String(to)) return false;
  const days = pkg.available_days ?? pkg.availableDays;
  if (Array.isArray(days) && days.length) {
    const t = Date.parse(`${dateISO}T12:00:00Z`);
    if (Number.isNaN(t) || !days.map(Number).includes(new Date(t).getUTCDay())) return false;
  }
  return true;
}

// ── reminders and the sweep's backstops ───────────────────────────────────────

const no = (reason) => ({ due: false, reason });
const yes = { due: true, reason: null };

// Is a visit reminder due right now? kind 'reminder_day' (the day before, 10:00 to 21:00 on the
// venue clock) or 'reminder_2h' (2 hours to 30 minutes before, never before 08:00). A booking
// made in the last 12 hours (day) or 3 hours (2h) just had its confirmation, so it is skipped.
//   booking { status, source, date | booking_date, startTime | start_time, createdAt | created_at }
export function reminderDue({ kind, booking, tz, now = Date.now() } = {}) {
  const b = booking || {};
  if (!LIVE_FOR_GUEST.includes(String(b.status || ''))) return no('not_live');
  if (b.source === 'walk_in') return no('walk_in');
  const date = String(b.date ?? b.booking_date ?? '');
  const start = zonedToEpoch(date, b.startTime ?? b.start_time, tz);
  if (Number.isNaN(start)) return no('no_time');
  const created = Date.parse(String(b.createdAt ?? b.created_at ?? '')) || 0;
  const clock = venueClockParts(tz, now);
  if (kind === 'reminder_day') {
    if (clock.ymd !== addDaysISO(date, -1)) return no('not_the_day_before');
    if (clock.min < 10 * 60 || clock.min >= 21 * 60) return no('quiet_hours');
    if (now - created < 12 * HOUR_MS) return no('booked_recently');
    return yes;
  }
  if (kind === 'reminder_2h') {
    const left = (start - now) / 60000;
    if (left > 120) return no('not_yet');
    if (left <= 30) return no('too_close');
    if (clock.min < 8 * 60) return no('quiet_hours');
    if (now - created < 3 * HOUR_MS) return no('booked_recently');
    return yes;
  }
  return no('unknown_kind');
}

// The confirmation backstop: a live booking made in the last 2 hours with a phone or an email,
// whose confirmation never went (a till or host stand booking on an older build, a call that
// dropped). The ledger still sends each channel once.
export function confirmationToSend({ booking, tz, now = Date.now() } = {}) {
  const b = booking || {};
  if (!LIVE_FOR_GUEST.includes(String(b.status || ''))) return no('not_live');
  if (b.source === 'walk_in') return no('walk_in');
  const c = b.customer || {};
  if (!String(c.phone || '').trim() && !String(c.email || '').trim()) return no('no_contact');
  const created = Date.parse(String(b.createdAt ?? b.created_at ?? '')) || 0;
  if (now - created > 2 * HOUR_MS) return no('not_recent');
  const start = zonedToEpoch(String(b.date ?? b.booking_date ?? ''), b.startTime ?? b.start_time, tz);
  if (!(start > now)) return no('started');
  return yes;
}

// Cancels the guest is NOT told about: the team removing a duplicate, a mistake or a test.
export const SILENT_CANCEL = /duplicate|mistake|test|wrong|entered twice/i;

// Tell the guest their booking was cancelled? Only when they were told it existed (a
// confirmation went), it is today or later, it was cancelled in the last 24 hours, and the
// reason is not one of the team's own clean ups.
export function cancelToTell({ booking, confirmationSent = false, tz, now = Date.now() } = {}) {
  const b = booking || {};
  if (b.status !== 'cancelled') return no('not_cancelled');
  if (!confirmationSent) return no('never_told');
  const date = String(b.date ?? b.booking_date ?? '');
  if (date < venueClockParts(tz, now).ymd) return no('past');
  const at = Date.parse(String(b.cancelledAt ?? b.cancelled_at ?? b.updatedAt ?? b.updated_at ?? '')) || 0;
  if (!at || now - at > DAY_MS) return no('not_recent');
  if (SILENT_CANCEL.test(String(b.cancelReason ?? b.cancel_reason ?? ''))) return no('team_clean_up');
  return yes;
}

// What the guest is told a booking is: its date, time and party. Tables are the venue's business.
export const snapshotOf = (b) => ({
  date: String(b?.date ?? b?.booking_date ?? ''),
  time: hm(b?.startTime ?? b?.start_time),
  covers: Math.round(num(b?.covers)),
});
export const sameSnapshot = (a, b) => !!a && !!b
  && String(a.date) === String(b.date) && hm(a.time) === hm(b.time) && num(a.covers) === num(b.covers);

// Tell the guest about a change? told = what they were last told (their confirmation, or the
// last change message that went); tried = the last change message tried, sent or not. A change
// is told once: a booking edited back to what they were told says nothing.
export function changeToTell({ booking, told = null, tried = null } = {}) {
  if (!booking || !LIVE_FOR_GUEST.includes(String(booking.status || ''))) return false;
  if (!told) return false;
  const now = snapshotOf(booking);
  if (sameSnapshot(now, told)) return false;
  if (tried && sameSnapshot(now, tried)) return false;
  return true;
}

// ── retries ───────────────────────────────────────────────────────────────────

// After a failed try: give up at 3, otherwise when to try again.
export function nextAttempt({ attempts = 1, now = Date.now(), permanent = false } = {}) {
  const n = Math.max(1, Math.round(num(attempts)));
  if (permanent || n >= MAX_SEND_ATTEMPTS) return { giveUp: true, nextTryAt: null };
  const gap = RETRY_GAPS_MIN[n - 1] ?? 60;
  return { giveUp: false, nextTryAt: new Date(now + gap * 60000).toISOString() };
}

// A failure no retry can fix: a number that is not a mobile, an invalid address, a guest who
// replied STOP. Twilio codes 21211 (invalid number), 21614 (not a mobile), 21610 (unsubscribed).
export function isPermanentFailure(reason) {
  const r = String(reason || '');
  return /\b(21211|21614|21610|21408)\b/.test(r)
    || /invalid phone|not a valid phone|unsubscribed|no_phone|no_email|invalid email|validation_error|http_4(00|22)\b/i.test(r);
}

// ── calendar ──────────────────────────────────────────────────────────────────

const icsEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// A Google Calendar link and an .ics file (Apple Calendar, Outlook) for the booking, in UTC so
// every calendar puts it at the venue's time.
export function calendarLinks({ uid = '', title, date, time, minutes = 90, tz, address = '', details = '', now = Date.now() } = {}) {
  const start = zonedToEpoch(date, time, tz);
  if (Number.isNaN(start)) return { google: null, ics: null };
  const end = start + Math.max(15, num(minutes) || 90) * 60000;
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: String(title || 'Table booking'), dates: `${utcStamp(start)}/${utcStamp(end)}`,
    details: String(details || ''), location: String(address || ''),
  });
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ServOS//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid || `${utcStamp(start)}@serv-os.app`)}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsEscape(title || 'Table booking')}`,
    ...(address ? [`LOCATION:${icsEscape(address)}`] : []),
    ...(details ? [`DESCRIPTION:${icsEscape(details)}`] : []),
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  return { google: `https://calendar.google.com/calendar/render?${q.toString()}`, ics };
}

// ── message merge tags ────────────────────────────────────────────────────────

// The data every booking message renders from. The *_line tags are whole sentences that are
// EMPTY when they do not apply (no link yet, no phone saved), so one template reads right for
// every booking and every venue.
export function guestTemplateData({
  booking, venueName = 'the venue', venuePhone = '', venueAddress = '', manageLink = '', calendarLink = '',
  preorderLink = '', packageName = '', when = '', moneyLine = '',
} = {}) {
  const b = booking || {};
  const cust = b.customer || {};
  const date = String(b.date ?? b.booking_date ?? '');
  return {
    customer_name: String(cust.name || 'there').trim().split(/\s+/)[0] || 'there',
    venue_name: venueName,
    date: fmtDateWords(date),
    time: hm(b.startTime ?? b.start_time),
    party_size: String(Math.round(num(b.covers)) || ''),
    package_name: packageName || '',
    package_line: packageName ? `with ${packageName} ` : '',
    preorder_link: preorderLink || '',
    preorder_link_line: preorderLink ? `Choose your menu: ${preorderLink} ` : '',
    manage_link: manageLink || '',
    manage_link_line: manageLink ? `Change or cancel: ${manageLink} ` : '',
    venue_phone: venuePhone || '',
    venue_phone_line: venuePhone ? `Call us on ${venuePhone}. ` : '',
    venue_address: venueAddress || '',
    venue_address_line: venueAddress ? `Find us at ${venueAddress}. ` : '',
    calendar_link: calendarLink || '',
    calendar_link_line: calendarLink ? `Add it to your calendar: ${calendarLink} ` : '',
    when: when || '',
    money_line: moneyLine || '',
  };
}

// The guest's page: https://<venue>.<root>/book?manage=<token>
export const manageUrl = (base, token) => (base && token ? `${String(base).replace(/\/+$/, '')}/book?manage=${token}` : '');

// The venue's phone and address for guests: the bookings phone set in Back Office first, then
// the phone and address printed on the receipt, then the venue's address.
export function venueContact({ rules = {}, receiptBranding = null, address = '' } = {}) {
  const header = receiptBranding && typeof receiptBranding === 'object' ? (receiptBranding.header || {}) : {};
  const phone = String(rules.guest_phone ?? rules.guestPhone ?? '').trim() || String(header.phone || '').trim();
  const lines = Array.isArray(header.address_lines) ? header.address_lines.filter(Boolean).join(', ') : '';
  return { phone, address: String(address || '').trim() || lines };
}
