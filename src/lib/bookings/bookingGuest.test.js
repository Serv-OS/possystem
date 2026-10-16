// bookingGuest.test.js: the guest link and guest message rules (16 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  venueClockParts, zonedToEpoch, addDaysISO, fmtDateWords, guestWindow, manageState,
  reminderIsStale, moneyOnBooking, cancelMoney, changeMoney, owedBackOnBooking, paymentNetMinor, moneyWords, packageOnDate, reminderDue,
  confirmationToSend, cancelToTell, snapshotOf, sameSnapshot, changeToTell, nextAttempt,
  isPermanentFailure, calendarLinks, guestTemplateData, manageUrl, venueContact, MAX_SEND_ATTEMPTS,
} from './bookingGuest.js';

const LDN = 'Europe/London';
const at = (iso) => Date.parse(iso);

test('venue clock: a London venue read from anywhere', () => {
  // 01:30 UTC on 17 Oct is 02:30 BST in London, 18:30 the day before in California.
  const p = venueClockParts(LDN, at('2026-10-17T01:30:00Z'));
  assert.equal(p.ymd, '2026-10-17');
  assert.equal(p.min, 2 * 60 + 30);
  const la = venueClockParts('America/Los_Angeles', at('2026-10-17T01:30:00Z'));
  assert.equal(la.ymd, '2026-10-16');
  assert.equal(la.min, 18 * 60 + 30);
});

test('zonedToEpoch: summer, winter and the clock change', () => {
  assert.equal(zonedToEpoch('2026-10-17', '19:30', LDN), at('2026-10-17T18:30:00Z')); // BST
  assert.equal(zonedToEpoch('2026-11-17', '19:30', LDN), at('2026-11-17T19:30:00Z')); // GMT
  assert.equal(zonedToEpoch('2026-10-25', '12:00', LDN), at('2026-10-25T12:00:00Z')); // after the change
  assert.equal(zonedToEpoch('2026-10-17', '19:30', 'America/Los_Angeles'), at('2026-10-18T02:30:00Z'));
  assert.ok(Number.isNaN(zonedToEpoch('', '19:30', LDN)));
  // A bad zone falls back to London rather than throwing.
  assert.equal(zonedToEpoch('2026-10-17', '19:30', 'Not/AZone'), at('2026-10-17T18:30:00Z'));
});

test('dates in words and day arithmetic', () => {
  assert.equal(fmtDateWords('2026-10-17'), 'Saturday 17 October');
  assert.equal(addDaysISO('2026-10-01', -1), '2026-09-30');
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
});

test('guestWindow: open, inside the window, started', () => {
  const now = at('2026-10-16T12:00:00Z'); // 13:00 London
  assert.deepEqual(guestWindow({ date: '2026-10-17', startTime: '19:00', windowHours: 24, tz: LDN, now }).open, true);
  const inside = guestWindow({ date: '2026-10-16', startTime: '19:00', windowHours: 24, tz: LDN, now });
  assert.equal(inside.open, false);
  assert.equal(inside.reason, 'inside_window');
  assert.equal(guestWindow({ date: '2026-10-16', startTime: '19:00', windowHours: 0, tz: LDN, now }).open, true);
  assert.equal(guestWindow({ date: '2026-10-16', startTime: '12:00', windowHours: 0, tz: LDN, now }).reason, 'started');
});

test('manageState: what the page offers for each status', () => {
  const now = at('2026-10-16T12:00:00Z');
  const live = { status: 'confirmed', booking_date: '2026-10-20', start_time: '19:00:00' };
  assert.deepEqual(
    (({ view, canCancel, canChange }) => ({ view, canCancel, canChange }))(manageState({ booking: live, rules: { cancellation_window_hours: 24 }, tz: LDN, now })),
    { view: 'live', canCancel: true, canChange: true },
  );
  const late = manageState({ booking: { ...live, booking_date: '2026-10-16' }, rules: { cancellation_window_hours: 24 }, tz: LDN, now });
  assert.equal(late.canCancel, false);
  assert.match(late.why, /close 24 hours before/);
  assert.match(manageState({ booking: { ...live, booking_date: '2026-10-16' }, rules: { cancellation_window_hours: 1 }, tz: LDN, now }).why || 'open', /open/);
  const off = manageState({ booking: live, rules: { guest_manage_enabled: false }, tz: LDN, now });
  assert.equal(off.canChange, false);
  assert.match(off.why, /call the venue/);
  assert.equal(manageState({ booking: { ...live, status: 'cancelled' }, tz: LDN, now }).view, 'cancelled');
  assert.equal(manageState({ booking: { ...live, status: 'dining' }, tz: LDN, now }).view, 'closed');
  const unpaid = manageState({ booking: { ...live, status: 'pending_payment' }, tz: LDN, now });
  assert.equal(unpaid.canCancel, true);
  assert.equal(unpaid.canChange, false);
  for (const s of ['cancelled', 'dining', 'departed', 'no_show', 'expired', 'pending_payment', 'confirmed']) {
    const w = manageState({ booking: { ...live, status: s, booking_date: '2026-10-16' }, rules: { cancellation_window_hours: 24 }, tz: LDN, now }).why || '';
    assert.doesNotMatch(w, /[\u2013\u2014]/, `no long dashes in the words for ${s}`);
  }
});

const PAID = [
  { id: 'p1', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp', applied_to_check: false },
  { id: 'h1', kind: 'hold', status: 'authorised', amount: 40, currency: 'gbp' },
  { id: 'p0', kind: 'prepay', status: 'failed', amount: 120, currency: 'gbp' },
  { id: 'p2', kind: 'deposit', status: 'captured', amount: 20, currency: 'gbp', refusal_reason: 'NEEDS REFUND: paid late' },
  { id: 'p3', kind: 'deposit', status: 'captured', amount: 10, currency: 'gbp', applied_to_check: true },
];

test('money on the booking: captured, unused, not already owed back', () => {
  const m = moneyOnBooking(PAID);
  assert.equal(m.capturedMinor, 12000);
  assert.deepEqual(m.rows.map((r) => r.id), ['p1']);
  assert.equal(m.currency, 'GBP');
  assert.deepEqual(cancelMoney(PAID), { owedBackMinor: 12000, rowIds: ['p1'], currency: 'GBP' });
  assert.equal(cancelMoney([{ id: 'h', kind: 'hold', status: 'authorised', amount: 40 }]).owedBackMinor, 0);
});

test('changeMoney: more guests on a paid menu needs a top up, fewer is owed back', () => {
  const pkg = { payment_model: 'prepay', price: 60, price_unit: 'per_cover' };
  const pay = [{ id: 'p', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp' }];
  assert.deepEqual(changeMoney({ pkg, oldCovers: 2, newCovers: 3, payments: pay }).state, 'needs_top_up');
  assert.equal(changeMoney({ pkg, oldCovers: 2, newCovers: 3, payments: pay }).diffMinor, 6000);
  const down = changeMoney({ pkg, oldCovers: 2, newCovers: 1, payments: pay });
  assert.equal(down.state, 'owed_back');
  assert.equal(down.diffMinor, 6000);
  assert.equal(changeMoney({ pkg, oldCovers: 2, newCovers: 2, payments: pay }).state, 'settled');
  assert.equal(changeMoney({ pkg, oldCovers: 2, newCovers: 4, payments: [] }).state, 'none');
  // A per booking price does not move with the party.
  const flat = { payment_model: 'prepay', price: 200, price_unit: 'per_booking' };
  assert.equal(changeMoney({ pkg: flat, oldCovers: 2, newCovers: 6, payments: [{ id: 'f', kind: 'prepay', status: 'captured', amount: 200 }] }).state, 'settled');
  // Deposit per guest.
  const dep = { payment_model: 'deposit', deposit_per_cover: 10 };
  assert.equal(changeMoney({ pkg: dep, oldCovers: 4, newCovers: 6, payments: [{ id: 'd', kind: 'deposit', status: 'captured', amount: 40 }] }).state, 'needs_top_up');
  // No package to work it out from: never guessed.
  assert.equal(changeMoney({ pkg: null, oldCovers: 4, newCovers: 2, payments: pay }).state, 'settled');
});

test('changeMoney: seats the venue already refunded must be paid again to come back', () => {
  // £10 a guest, 6 paid; the guest goes to 4 and the venue refunds £20 (16 Oct 2026 review).
  const pkg = { payment_model: 'prepay', price: 10, price_unit: 'per_cover' };
  const pays = [
    { id: 'p', kind: 'prepay', status: 'captured', amount: 60, currency: 'gbp' },
    { id: 'r', kind: 'refund', status: 'refunded', amount: 20, refund_of: 'p' },
  ];
  const back = changeMoney({ pkg, oldCovers: 4, newCovers: 6, paidCovers: 6, payments: pays });
  assert.equal(back.state, 'needs_top_up');
  assert.equal(back.diffMinor, 2000);
  const five = changeMoney({ pkg, oldCovers: 4, newCovers: 5, paidCovers: 6, payments: pays });
  assert.equal(five.state, 'needs_top_up');
  assert.equal(five.diffMinor, 1000);
  assert.equal(changeMoney({ pkg, oldCovers: 4, newCovers: 4, paidCovers: 6, payments: pays }).state, 'settled');
  const three = changeMoney({ pkg, oldCovers: 4, newCovers: 3, paidCovers: 6, payments: pays });
  assert.equal(three.state, 'owed_back');
  assert.equal(three.diffMinor, 1000);
  // With nothing refunded, 6 to 4 to 6 still owes nothing.
  assert.equal(changeMoney({ pkg, oldCovers: 4, newCovers: 6, paidCovers: 6, payments: [pays[0]] }).state, 'settled');
  assert.equal(changeMoney({ pkg, oldCovers: 6, newCovers: 4, paidCovers: 6, payments: [pays[0]] }).diffMinor, 2000);
});

test('moneyWords', () => {
  assert.equal(moneyWords(12000, 'GBP'), '£120');
  assert.equal(moneyWords(4550, 'usd'), '$45.50');
  assert.equal(moneyWords(100, 'CHF'), 'CHF 1');
});

test('packageOnDate: range and weekdays', () => {
  const pkg = { available_from: '2026-10-01', available_to: '2026-10-31', available_days: [5, 6] };
  assert.equal(packageOnDate(pkg, '2026-10-17'), true);  // Saturday
  assert.equal(packageOnDate(pkg, '2026-10-19'), false); // Monday
  assert.equal(packageOnDate(pkg, '2026-11-06'), false); // after the range
  assert.equal(packageOnDate(null, '2026-11-06'), true);
});

test('reminderDue: the day before, inside 10:00 to 21:00, not for a booking made just now', () => {
  const b = { status: 'confirmed', source: 'widget', booking_date: '2026-10-17', start_time: '19:00:00', created_at: '2026-10-10T10:00:00Z' };
  assert.equal(reminderDue({ kind: 'reminder_day', booking: b, tz: LDN, now: at('2026-10-16T09:30:00Z') }).due, true); // 10:30 BST
  assert.equal(reminderDue({ kind: 'reminder_day', booking: b, tz: LDN, now: at('2026-10-16T08:30:00Z') }).reason, 'quiet_hours');
  assert.equal(reminderDue({ kind: 'reminder_day', booking: b, tz: LDN, now: at('2026-10-16T20:30:00Z') }).reason, 'quiet_hours');
  assert.equal(reminderDue({ kind: 'reminder_day', booking: b, tz: LDN, now: at('2026-10-15T12:00:00Z') }).reason, 'not_the_day_before');
  assert.equal(reminderDue({ kind: 'reminder_day', booking: { ...b, created_at: '2026-10-16T08:00:00Z' }, tz: LDN, now: at('2026-10-16T12:00:00Z') }).reason, 'booked_recently');
  assert.equal(reminderDue({ kind: 'reminder_day', booking: { ...b, status: 'pending_payment' }, tz: LDN, now: at('2026-10-16T12:00:00Z') }).reason, 'not_live');
  assert.equal(reminderDue({ kind: 'reminder_day', booking: { ...b, source: 'walk_in' }, tz: LDN, now: at('2026-10-16T12:00:00Z') }).reason, 'walk_in');
});

test('reminderDue: 2 hours before, not inside the last 30 minutes, not before 08:00', () => {
  const b = { status: 'prepaid', source: 'host', booking_date: '2026-10-17', start_time: '19:00', created_at: '2026-10-10T10:00:00Z' };
  // 19:00 BST is 18:00 UTC.
  assert.equal(reminderDue({ kind: 'reminder_2h', booking: b, tz: LDN, now: at('2026-10-17T16:00:00Z') }).due, true);
  assert.equal(reminderDue({ kind: 'reminder_2h', booking: b, tz: LDN, now: at('2026-10-17T15:50:00Z') }).reason, 'not_yet');
  assert.equal(reminderDue({ kind: 'reminder_2h', booking: b, tz: LDN, now: at('2026-10-17T17:40:00Z') }).reason, 'too_close');
  const breakfast = { ...b, start_time: '08:30' };
  assert.equal(reminderDue({ kind: 'reminder_2h', booking: breakfast, tz: LDN, now: at('2026-10-17T05:45:00Z') }).reason, 'quiet_hours');
  assert.equal(reminderDue({ kind: 'reminder_2h', booking: { ...b, created_at: '2026-10-17T15:00:00Z' }, tz: LDN, now: at('2026-10-17T16:30:00Z') }).reason, 'booked_recently');
});

test('confirmation backstop: recent, live, contactable, not started', () => {
  const now = at('2026-10-16T12:00:00Z');
  const b = { status: 'confirmed', source: 'pos', booking_date: '2026-10-18', start_time: '19:00', created_at: '2026-10-16T11:30:00Z', customer: { phone: '+447700900001' } };
  assert.equal(confirmationToSend({ booking: b, tz: LDN, now }).due, true);
  assert.equal(confirmationToSend({ booking: { ...b, customer: {} }, tz: LDN, now }).reason, 'no_contact');
  assert.equal(confirmationToSend({ booking: { ...b, created_at: '2026-10-16T08:00:00Z' }, tz: LDN, now }).reason, 'not_recent');
  assert.equal(confirmationToSend({ booking: { ...b, source: 'walk_in' }, tz: LDN, now }).reason, 'walk_in');
  assert.equal(confirmationToSend({ booking: { ...b, booking_date: '2026-10-16', start_time: '12:30' }, tz: LDN, now }).reason, 'started');
});

test('cancelToTell: only guests who were told, recent, not a team clean up', () => {
  const now = at('2026-10-16T12:00:00Z');
  const b = { status: 'cancelled', booking_date: '2026-10-18', cancelled_at: '2026-10-16T11:00:00Z', cancel_reason: 'Guest asked' };
  assert.equal(cancelToTell({ booking: b, confirmationSent: true, tz: LDN, now }).due, true);
  assert.equal(cancelToTell({ booking: b, confirmationSent: false, tz: LDN, now }).reason, 'never_told');
  assert.equal(cancelToTell({ booking: { ...b, cancel_reason: 'Duplicate booking' }, confirmationSent: true, tz: LDN, now }).reason, 'team_clean_up');
  assert.equal(cancelToTell({ booking: { ...b, booking_date: '2026-10-15' }, confirmationSent: true, tz: LDN, now }).reason, 'past');
  assert.equal(cancelToTell({ booking: { ...b, cancelled_at: '2026-10-14T11:00:00Z' }, confirmationSent: true, tz: LDN, now }).reason, 'not_recent');
  assert.equal(cancelToTell({ booking: { ...b, cancelled_at: null, updated_at: '2026-10-16T11:00:00Z' }, confirmationSent: true, tz: LDN, now }).due, true);
});

test('changeToTell: told once, never for a change back', () => {
  const told = { date: '2026-10-18', time: '19:00', covers: 2 };
  const b = { status: 'confirmed', booking_date: '2026-10-18', start_time: '19:30:00', covers: 2 };
  assert.deepEqual(snapshotOf(b), { date: '2026-10-18', time: '19:30', covers: 2 });
  assert.equal(sameSnapshot(told, { ...told, time: '19:00:00' }), true);
  assert.equal(changeToTell({ booking: b, told }), true);
  assert.equal(changeToTell({ booking: b, told, tried: snapshotOf(b) }), false);
  assert.equal(changeToTell({ booking: { ...b, start_time: '19:00' }, told }), false);
  assert.equal(changeToTell({ booking: b, told: null }), false);
  assert.equal(changeToTell({ booking: { ...b, status: 'cancelled' }, told }), false);
});

test('retries stop after 3, and at once for a number that can never work', () => {
  const now = at('2026-10-16T12:00:00Z');
  assert.deepEqual(nextAttempt({ attempts: 1, now }), { giveUp: false, nextTryAt: '2026-10-16T12:10:00.000Z' });
  assert.deepEqual(nextAttempt({ attempts: 2, now }), { giveUp: false, nextTryAt: '2026-10-16T12:30:00.000Z' });
  assert.deepEqual(nextAttempt({ attempts: MAX_SEND_ATTEMPTS, now }), { giveUp: true, nextTryAt: null });
  assert.equal(nextAttempt({ attempts: 1, now, permanent: true }).giveUp, true);
  assert.equal(isPermanentFailure('SMS send failed: The To number +447700900305 is not a valid phone number. (21211)'), true);
  assert.equal(isPermanentFailure('send-sms_http_400'), true);
  assert.equal(isPermanentFailure('send-sms_http_502'), false);
  assert.equal(isPermanentFailure('resend_http_422'), true);
  assert.equal(isPermanentFailure('email_provider_unreachable'), false);
});

test('calendar links are in UTC at the venue time', () => {
  const c = calendarLinks({ uid: 'bk-1', title: 'Table at Provo', date: '2026-10-17', time: '19:00', minutes: 90, tz: LDN, address: '9a New Street, Huddersfield', now: at('2026-10-16T12:00:00Z') });
  assert.match(c.google, /dates=20261017T180000Z%2F20261017T193000Z/);
  assert.match(c.ics, /DTSTART:20261017T180000Z/);
  assert.match(c.ics, /DTEND:20261017T193000Z/);
  assert.match(c.ics, /LOCATION:9a New Street\\, Huddersfield/);
  assert.match(c.ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.deepEqual(calendarLinks({ date: '', time: '19:00', tz: LDN }), { google: null, ics: null });
});

test('template data: every line is empty when it does not apply', () => {
  const booking = { booking_date: '2026-10-17', start_time: '19:00:00', covers: 4, customer: { name: 'Sam Jones' } };
  const full = guestTemplateData({ booking, venueName: 'Provo', venuePhone: '01484 000000', manageLink: 'https://x/book?manage=t', calendarLink: 'https://cal', when: 'tomorrow' });
  assert.equal(full.customer_name, 'Sam');
  assert.equal(full.date, 'Saturday 17 October');
  assert.equal(full.time, '19:00');
  assert.equal(full.party_size, '4');
  assert.equal(full.manage_link_line, 'Change or cancel: https://x/book?manage=t ');
  assert.equal(full.venue_phone_line, 'Call us on 01484 000000. ');
  assert.equal(full.when, 'tomorrow');
  const bare = guestTemplateData({ booking: { ...booking, customer: null } });
  assert.equal(bare.customer_name, 'there');
  for (const k of ['manage_link_line', 'venue_phone_line', 'venue_address_line', 'calendar_link_line', 'preorder_link_line', 'package_line', 'money_line']) {
    assert.equal(bare[k], '', `${k} empty`);
  }
});

test('manage link and venue contact', () => {
  assert.equal(manageUrl('https://provo.serv-os.app/', 'abc'), 'https://provo.serv-os.app/book?manage=abc');
  assert.equal(manageUrl(null, 'abc'), '');
  assert.deepEqual(
    venueContact({ rules: {}, receiptBranding: { header: { phone: '01484 111', address_lines: ['9a New Street', 'Huddersfield'] } }, address: '' }),
    { phone: '01484 111', address: '9a New Street, Huddersfield' },
  );
  assert.equal(venueContact({ rules: { guest_phone: '0113 222' }, receiptBranding: { header: { phone: '01484 111' } }, address: 'The Light' }).phone, '0113 222');
  assert.deepEqual(venueContact({}), { phone: '', address: '' });
});

test('changeMoney: owed back follows what was paid, not the price today', () => {
  const pay = [{ id: 'p', kind: 'prepay', status: 'captured', amount: 80, currency: 'gbp' }];
  // 4 paid £80 at £20; the menu is now £15 (or £25). One seat fewer owes back one paid seat.
  for (const price of [15, 25]) {
    const pkg = { payment_model: 'prepay', price, price_unit: 'per_cover' };
    const r = changeMoney({ pkg, oldCovers: 4, newCovers: 3, paidCovers: 4, payments: pay });
    assert.equal(r.state, 'owed_back');
    assert.equal(r.diffMinor, 2000, `price ${price}`);
  }
});

test('changeMoney: the figure is the whole amount owed now, measured from the party that paid', () => {
  const pkg = { payment_model: 'prepay', price: 20, price_unit: 'per_cover' };
  const pay = [{ id: 'p', kind: 'prepay', status: 'captured', amount: 120, currency: 'gbp' }];
  assert.equal(changeMoney({ pkg, oldCovers: 6, newCovers: 4, paidCovers: 6, payments: pay }).diffMinor, 4000);
  assert.equal(changeMoney({ pkg, oldCovers: 4, newCovers: 6, paidCovers: 6, payments: pay }).state, 'settled');
  const five = changeMoney({ pkg, oldCovers: 4, newCovers: 5, paidCovers: 6, payments: pay });
  assert.equal(five.state, 'owed_back');
  assert.equal(five.diffMinor, 2000);
  // More than were paid for: a top up at today's price for the extra seats only.
  const seven = changeMoney({ pkg, oldCovers: 4, newCovers: 7, paidCovers: 6, payments: pay });
  assert.equal(seven.state, 'needs_top_up');
  assert.equal(seven.diffMinor, 2000);
});

test('money net of part refunds (amount_refunded_minor)', () => {
  const row = { id: 'd', kind: 'deposit', status: 'captured', amount: 80, amount_refunded_minor: 2000, currency: 'gbp' };
  assert.equal(paymentNetMinor(row), 6000);
  assert.equal(moneyOnBooking([row]).capturedMinor, 6000);
  assert.equal(moneyOnBooking([{ ...row, amount_refunded_minor: 8000 }]).rows.length, 0, 'fully refunded is not money on the booking');
  assert.equal(owedBackOnBooking([{ ...row, status: 'needs_refund' }]).owedBackMinor, 6000);
  assert.equal(owedBackOnBooking([{ ...row, refusal_reason: 'needs refund: the guest cancelled online in time' }]).owedBackMinor, 6000);
});

test('reminderIsStale: a reminder sent for the old date or time goes again after a move', () => {
  const bk = { booking_date: '2026-10-23', start_time: '19:00:00', covers: 4 };
  assert.equal(reminderIsStale({ detail: { date: '2026-10-17', time: '19:00', covers: 4 } }, bk), true);
  assert.equal(reminderIsStale({ detail: { date: '2026-10-23', time: '18:30', covers: 4 } }, bk), true);
  assert.equal(reminderIsStale({ detail: { date: '2026-10-23', time: '19:00', covers: 2 } }, bk), false, 'a party change alone does not resend');
  assert.equal(reminderIsStale({ detail: null }, bk), false);
  assert.equal(reminderIsStale(null, bk), false);
});
