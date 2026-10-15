// src/lib/venueMessageRules.test.js: messages from ServOS to venues, the rules (5 Oct 2026).
// Which message shows next, when it must wait for a payment, who may confirm, how ticked
// companies become venues, and the per venue rollup the admin reads.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MESSAGE_MAX, TITLE_MAX, cleanBody, cleanDraft, oneLine, expandRecipients, venueStatus, isOpenMessage,
  rollupBroadcasts, countsLine, sendQuestion, isUuid,
  isMissingVenueMessages, openQueue, nextMessage, applyMessageRow, mergeFetched,
  addTapped, tappedOutcome, tapsToSend, pruneTapped,
  tillMayHostPopup, mayShowPopup, confirmer, chimeKey,
  formatVenueTime, venueStatusLine, receivedList, groupVenues, POPUP_HOSTS, NEEDS_UPDATE_LINE,
  sameMessage, sendResultLine, popupKeyAction, gotItClickCounts, tapsAfterFlush, CONFIRM_TIMEOUT_MS,
} from './venueMessageRules.js';
import { flushVenueMessageTaps, hookStarted, hookStopped } from './venueMessageTaps.js';
import { holdPaymentBusy, canApplyUpdate, PAYMENT_QUIET_MS, _resetPaymentBusyForTests } from './paymentBusy.js';

const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';
const V3 = '00000000-0000-4000-8000-000000000003';
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const venues = [
  { id: V1, name: 'Leeds', org_id: ORG_A, org_name: 'Coffee Boy', timezone: 'Europe/London' },
  { id: V2, name: 'Barnsley', org_id: ORG_A, org_name: 'Coffee Boy', timezone: 'Europe/London' },
  { id: V3, name: 'The Cabin', org_id: ORG_B, org_name: 'American Test', timezone: 'America/New_York' },
];
const row = (over = {}) => ({
  id: 'm1', broadcast_id: 'b1', location_id: V1, kind: 'info', title: null, body: 'Hi',
  sent_at: '2026-10-05T10:00:00Z', resent_at: null, confirmed_at: null, confirmed_by: null, withdrawn_at: null, ...over,
});

// ── the draft ───────────────────────────────────────────────────────────────

test('cleanDraft: Peter\'s own example goes through as written, line breaks kept', () => {
  const d = cleanDraft({ title: '  New update ', body: 'Hi, I have just made an update,\r\nyou need to do XYZ  \n\n\n\nThanks', kind: 'action' });
  assert.deepEqual(d, { ok: true, title: 'New update', body: 'Hi, I have just made an update,\nyou need to do XYZ\n\nThanks', kind: 'action' });
});

test('cleanDraft: the title is optional, the message is not, the kind is one of two', () => {
  assert.equal(cleanDraft({ body: 'x' }).title, null);
  assert.equal(cleanDraft({ body: 'x' }).kind, 'info');
  assert.equal(cleanDraft({ body: '   \n ' }).ok, false);
  assert.equal(cleanDraft({ body: 'x', kind: 'urgent' }).ok, false);
});

test('cleanDraft: too long is refused, never cut', () => {
  assert.equal(cleanDraft({ body: 'x'.repeat(MESSAGE_MAX) }).ok, true);
  const long = cleanDraft({ body: 'x'.repeat(MESSAGE_MAX + 1) });
  assert.equal(long.ok, false);
  assert.match(long.error, /600 characters/);
  assert.equal(cleanDraft({ body: 'x', title: 't'.repeat(TITLE_MAX + 1) }).ok, false);
});

test('text is cleaned of control characters; a title is one line', () => {
  assert.equal(cleanBody('a\u0000b\u0007c\td'), 'abc d');
  assert.equal(oneLine(' two\nlines\there '), 'two lines here');
  assert.equal(cleanBody('\n\nfirst\n\n\nsecond\n\n'), 'first\n\nsecond');
});

test('no em or en dashes in the words people read', () => {
  const lines = [
    cleanDraft({ body: '' }).error, cleanDraft({ body: 'x'.repeat(601) }).error, cleanDraft({ body: 'x', kind: 'z' }).error,
    sendQuestion(6), countsLine({ confirmed: 1, total: 2 }), NEEDS_UPDATE_LINE,
  ];
  for (const l of lines) assert.ok(!/[–—]/.test(l), l);
});

// ── recipients ──────────────────────────────────────────────────────────────

test('expandRecipients: a ticked company is every venue of that company', () => {
  assert.deepEqual(expandRecipients({ companyIds: [ORG_A], venues }), { venueIds: [V1, V2], unknown: 0 });
});

test('expandRecipients: companies and single venues together, each venue once', () => {
  const r = expandRecipients({ companyIds: [ORG_A], venueIds: [V1, V3, V3], venues });
  assert.deepEqual(r, { venueIds: [V1, V2, V3], unknown: 0 });
});

test('expandRecipients: a venue the server does not know is dropped and counted, never sent to', () => {
  const r = expandRecipients({ venueIds: [V1, '99999999-0000-4000-8000-000000000009'], venues });
  assert.deepEqual(r, { venueIds: [V1], unknown: 1 });
  assert.deepEqual(expandRecipients({ companyIds: ['nope'], venues }), { venueIds: [], unknown: 0 });
  assert.deepEqual(expandRecipients({}), { venueIds: [], unknown: 0 });
  assert.deepEqual(expandRecipients(null), { venueIds: [], unknown: 0 });
});

test('expandRecipients: a venue with no company is never swept in by a company tick', () => {
  const r = expandRecipients({ companyIds: [ORG_A, 'null', 'undefined'], venues: [...venues, { id: 'v9', org_id: null }] });
  assert.deepEqual(r.venueIds, [V1, V2]);
});

test('isUuid and sendQuestion', () => {
  assert.equal(isUuid(V1), true);
  assert.equal(isUuid('x'), false);
  assert.equal(isUuid(null), false);
  assert.equal(sendQuestion(6), 'Send to 6 venues?');
  assert.equal(sendQuestion(1), 'Send to 1 venue?');
});

// ── status and the rollup ───────────────────────────────────────────────────

test('venueStatus: waiting, confirmed, and withdrawn wins', () => {
  assert.equal(venueStatus(row()), 'waiting');
  assert.equal(venueStatus(row({ confirmed_at: 'x', confirmed_by: 'Sam' })), 'confirmed');
  assert.equal(venueStatus(row({ confirmed_at: 'x', withdrawn_at: 'y' })), 'withdrawn');
  assert.equal(isOpenMessage(row()), true);
  assert.equal(isOpenMessage(row({ withdrawn_at: 'y' })), false);
  assert.equal(isOpenMessage(null), false);
});

test('rollupBroadcasts: 4 of 6 confirmed, per venue who and when, newest message first', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const six = ids.map((x, i) => row({
    id: `m${x}`, broadcast_id: 'b-six', location_id: i < 3 ? [V1, V2, V3][i] : `gone-${i}`,
    confirmed_at: i < 4 ? '2026-10-05T11:30:00Z' : null, confirmed_by: i < 4 ? `Staff ${i}` : null, confirmed_via: 'till',
  }));
  const older = row({ id: 'old', broadcast_id: 'b-old', sent_at: '2026-10-01T09:00:00Z', location_id: V3 });
  const out = rollupBroadcasts([older, ...six], venues);
  assert.deepEqual(out.map((g) => g.broadcastId), ['b-six', 'b-old']);
  const g = out[0];
  assert.equal(g.total, 6);
  assert.equal(g.confirmed, 4);
  assert.equal(g.waiting, 2);
  assert.equal(countsLine(g), '4 of 6 confirmed');
  const leeds = g.venues.find((v) => v.locationId === V1);
  assert.equal(leeds.venueName, 'Leeds');
  assert.equal(leeds.companyName, 'Coffee Boy');
  assert.equal(leeds.status, 'confirmed');
  assert.equal(leeds.confirmedBy, 'Staff 0');
  assert.equal(g.venues.filter((v) => v.venueName === 'Venue removed').length, 3);
  assert.equal(out[1].waiting, 1);
});

test('rollupBroadcasts: all done, withdrawn, and sent again', () => {
  const done = rollupBroadcasts([row({ confirmed_at: 'x', confirmed_by: 'Sam' })], venues)[0];
  assert.equal(countsLine(done), '1 of 1 confirmed, all done');
  assert.equal(done.withdrawn, false);
  const gone = rollupBroadcasts([
    row({ id: '1', confirmed_at: '2026-10-05T11:00:00Z', confirmed_by: 'Sam', withdrawn_at: '2026-10-05T12:00:00Z' }),
    row({ id: '2', location_id: V2, withdrawn_at: '2026-10-05T12:00:00Z' }),
  ], venues)[0];
  assert.equal(gone.withdrawn, true);
  assert.equal(gone.waiting, 0);
  assert.equal(gone.confirmed, 1);          // a confirmation given before the withdrawal is kept
  assert.equal(countsLine(gone), '1 of 2 confirmed, withdrawn');
  const again = rollupBroadcasts([row({ resent_at: '2026-10-05T13:00:00Z' })], venues)[0];
  assert.equal(again.resentAt, '2026-10-05T13:00:00Z');
  assert.deepEqual(rollupBroadcasts(null), []);
});

test('venueStatusLine: Waiting, or Confirmed by <name> at <time on the VENUE clock>', () => {
  const g = rollupBroadcasts([
    row({ id: '1', location_id: V3, confirmed_at: '2026-10-05T18:30:00Z', confirmed_by: 'Dana' }),
    row({ id: '2', location_id: V1, confirmed_at: '2026-10-05T18:30:00Z', confirmed_by: 'Sam' }),
    row({ id: '3', location_id: V2 }),
  ], venues)[0];
  const by = (id) => g.venues.find((v) => v.locationId === id);
  assert.equal(venueStatusLine(by(V3)), 'Confirmed by Dana at 5 Oct, 14:30');   // New York
  assert.equal(venueStatusLine(by(V1)), 'Confirmed by Sam at 5 Oct, 19:30');    // Leeds, British Summer Time
  assert.equal(venueStatusLine(by(V2)), 'Waiting');
  assert.equal(venueStatusLine({ status: 'withdrawn' }), 'Withdrawn');
  assert.match(venueStatusLine({ status: 'withdrawn', confirmedAt: '2026-10-05T18:30:00Z', confirmedBy: 'Sam', timezone: 'Europe/London' }), /^Confirmed by Sam at 5 Oct, 19:30, then withdrawn$/);
});

test('formatVenueTime: the venue clock, a bad zone falls back to London, a bad date is empty', () => {
  assert.equal(formatVenueTime('2026-01-15T12:00:00Z', 'Europe/London'), '15 Jan, 12:00');
  assert.equal(formatVenueTime('2026-01-15T12:00:00Z', 'America/Los_Angeles'), '15 Jan, 04:00');
  assert.equal(formatVenueTime('2026-01-15T12:00:00Z', 'Not/AZone'), '15 Jan, 12:00');
  assert.equal(formatVenueTime('2026-01-15T12:00:00Z', null), '15 Jan, 12:00');
  assert.equal(formatVenueTime('nonsense', 'Europe/London'), '');
});

// ── which message shows next ────────────────────────────────────────────────

test('nextMessage: several waiting show one at a time, oldest first', () => {
  const rows = [
    row({ id: 'c', sent_at: '2026-10-05T12:00:00Z' }),
    row({ id: 'a', sent_at: '2026-10-05T09:00:00Z' }),
    row({ id: 'b', sent_at: '2026-10-05T10:00:00Z' }),
  ];
  assert.deepEqual(openQueue(rows, V1).map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(nextMessage(rows, V1).id, 'a');
  // "Send again" never jumps the queue: the order is when it was first sent.
  rows[0].resent_at = '2026-10-05T13:00:00Z';
  assert.equal(nextMessage(rows, V1).id, 'a');
});

test('nextMessage: a confirmed or withdrawn message is never shown, and never another venue\'s', () => {
  const rows = [
    row({ id: 'done', confirmed_at: 'x', confirmed_by: 'Sam' }),
    row({ id: 'gone', withdrawn_at: 'y' }),
    row({ id: 'other', location_id: V2 }),
  ];
  assert.equal(nextMessage(rows, V1), null);
  assert.equal(nextMessage(rows, V2).id, 'other');
  assert.equal(nextMessage([], V1), null);
  assert.equal(nextMessage(null, V1), null);
});

test('applyMessageRow: a live confirm on another till clears it here; a withdrawal too', () => {
  let list = [row({ id: 'a' }), row({ id: 'b', sent_at: '2026-10-05T11:00:00Z' })];
  list = applyMessageRow(list, row({ id: 'a', confirmed_at: '2026-10-05T10:05:00Z', confirmed_by: 'Sam' }), V1);
  assert.equal(nextMessage(list, V1).id, 'b');
  list = applyMessageRow(list, row({ id: 'b', sent_at: '2026-10-05T11:00:00Z', withdrawn_at: '2026-10-05T11:05:00Z' }), V1);
  assert.equal(nextMessage(list, V1), null);
});

test('applyMessageRow: a new message arrives live; another venue\'s row is ignored', () => {
  let list = applyMessageRow([], row({ id: 'new' }), V1);
  assert.equal(list.length, 1);
  list = applyMessageRow(list, row({ id: 'theirs', location_id: V2 }), V1);
  assert.equal(list.length, 1);
  assert.equal(applyMessageRow(list, null, V1), list);
});

test('a confirmed or withdrawn message never comes back, whatever arrives late', () => {
  const confirmed = row({ id: 'a', confirmed_at: '2026-10-05T10:05:00Z', confirmed_by: 'Sam' });
  // A stale live event (the "sent again" update, sent before the confirm, delivered after).
  let list = applyMessageRow([confirmed], row({ id: 'a', resent_at: '2026-10-05T10:04:00Z' }), V1);
  assert.equal(list[0].confirmed_by, 'Sam');
  assert.equal(nextMessage(list, V1), null);
  // A slow full read that still has it as waiting.
  list = mergeFetched([confirmed], [row({ id: 'a' }), row({ id: 'b' })], V1);
  assert.deepEqual(openQueue(list, V1).map((r) => r.id), ['b']);
  const withdrawn = row({ id: 'w', withdrawn_at: '2026-10-05T10:05:00Z' });
  list = mergeFetched([withdrawn], [row({ id: 'w' })], V1);
  assert.equal(nextMessage(list, V1), null);
});

test('mergeFetched: a full read replaces what is waiting and drops another venue\'s rows', () => {
  const list = mergeFetched([row({ id: 'old-open' }), row({ id: 'theirs', location_id: V2, confirmed_at: 'x', confirmed_by: 'y' })], [row({ id: 'n' })], V1);
  assert.deepEqual(list.map((r) => r.id), ['n']);
});

// ── a tap with no internet ──────────────────────────────────────────────────

test('Got it clears this screen at once: a tapped message is out of the queue before the server answers', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', sent_at: '2026-10-05T11:00:00Z' })];
  const pending = addTapped({}, 'a', 'Sam', '2026-10-05T10:01:00Z');
  assert.equal(nextMessage(rows, V1, Object.keys(pending)).id, 'b');
  assert.equal(nextMessage(rows, V1, new Set(['a', 'b'])), null);
  assert.deepEqual(pending, { a: { name: 'Sam', at: '2026-10-05T10:01:00Z' } });
});

test('tappedOutcome: sent is done, no internet retries, a refusal is kept and never asked again', () => {
  assert.equal(tappedOutcome({ ok: true, state: 'confirmed' }), 'done');
  assert.equal(tappedOutcome({ ok: true, state: 'withdrawn' }), 'done');
  assert.equal(tappedOutcome({ ok: false, reason: 'failed' }), 'retry');
  assert.equal(tappedOutcome({ ok: false, reason: 'offline' }), 'retry');
  assert.equal(tappedOutcome(null), 'retry');
  assert.equal(tappedOutcome({ ok: false, reason: 'not_allowed' }), 'refused');
  assert.deepEqual(tapsToSend({ a: { name: 'Sam' }, b: { name: 'Jo', refused: true } }), ['a']);
});

test('pruneTapped: a tap is forgotten once the message is finished, or far too old', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const pending = { a: { name: 'Sam', at: '2026-10-05T10:00:00Z' }, b: { name: 'Sam', at: '2026-10-05T10:00:00Z' }, old: { name: 'x', at: '2026-07-01T10:00:00Z' } };
  const rows = [row({ id: 'a', confirmed_at: 'x', confirmed_by: 'Sam' }), row({ id: 'b' })];
  assert.deepEqual(Object.keys(pruneTapped(pending, rows, { now })), ['b']);
});

// ── where it may show, and when it must wait ────────────────────────────────

test('tillMayHostPopup: only the till shell with staff signed in', () => {
  const till = { deviceMode: 'pos', deviceType: 'pos', defaultSurface: 'pos', surface: 'pos', isKdsDevice: false, staffSignedIn: true };
  assert.equal(tillMayHostPopup(till), true);
  for (const surface of ['tables', 'bar', 'orders', 'ai']) assert.equal(tillMayHostPopup({ ...till, surface }), true, surface);
  assert.equal(tillMayHostPopup({ ...till, staffSignedIn: false }), false, 'PIN screen');
  assert.equal(tillMayHostPopup({ ...till, surface: 'kds' }), false, 'a till showing the kitchen screen');
  assert.equal(tillMayHostPopup({ ...till, surface: 'kiosk' }), false);
  assert.equal(tillMayHostPopup({ ...till, defaultSurface: 'kiosk' }), false);
  assert.equal(tillMayHostPopup({ ...till, defaultSurface: 'mpos' }), false, 'the phone till is handed to customers');
  assert.equal(tillMayHostPopup({ ...till, isKdsDevice: true }), false);
  for (const deviceType of ['kds', 'kiosk', 'clock']) assert.equal(tillMayHostPopup({ ...till, deviceType }), false, deviceType);
  for (const deviceMode of ['kiosk', 'kds', 'customer-display', 'menuboard', 'orderscreen', 'clock', 'mpos', 'manager', 'owner', 'staff', 'bookings', 'waitlist', 'ops', 'admin', null, undefined]) {
    assert.equal(tillMayHostPopup({ ...till, deviceMode }), false, String(deviceMode));
  }
  assert.equal(tillMayHostPopup(), false);
  assert.deepEqual([...POPUP_HOSTS], ['till', 'backoffice']);
});

test('mayShowPopup: it waits while a payment holds, and for the quiet seconds after', () => {
  let now = 1_000_000;
  _resetPaymentBusyForTests({ now: () => now });
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), true);

  const releaseCheckout = holdPaymentBusy('checkout');          // the checkout opened
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), false);
  const releaseCard = holdPaymentBusy('card machine screen');   // and then the card screen
  releaseCheckout();
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), false, 'the card screen still holds');
  releaseCard();
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), false, 'the sale is still writing its receipt');
  now += PAYMENT_QUIET_MS - 1;
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), false);
  now += 2;
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), true, 'it shows after');
  _resetPaymentBusyForTests();
});

test('mayShowPopup: every kind of hold stops it (tab capture, split bill, tab close)', () => {
  for (const reason of ['bar tab card hold', 'split bill', 'tab close', 'bar tab close', 'card machine kick']) {
    _resetPaymentBusyForTests({ now: () => 5 });
    const release = holdPaymentBusy(reason);
    assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate() }), false, reason);
    release();
  }
  _resetPaymentBusyForTests();
});

test('mayShowPopup: never while the till is in a customer\'s hands; anything but a clear yes is a no', () => {
  assert.equal(mayShowPopup({ paymentQuiet: true, customerFacing: true }), false);
  assert.equal(mayShowPopup({ paymentQuiet: true }), true);
  assert.equal(mayShowPopup({}), false);
  assert.equal(mayShowPopup(), false);
  assert.equal(mayShowPopup({ paymentQuiet: 'yes' }), false);
});

// ── who may confirm ─────────────────────────────────────────────────────────

test('confirmer: a till needs a member of staff signed in; the name is theirs, one line, 80 characters', () => {
  assert.deepEqual(confirmer({ host: 'till', staffName: ' Sam\nSmith ' }), { ok: true, via: 'till', name: 'Sam Smith' });
  assert.deepEqual(confirmer({ host: 'till', staffName: '' }), { ok: false, reason: 'no_staff' });
  assert.deepEqual(confirmer({ host: 'till' }), { ok: false, reason: 'no_staff' });
  assert.equal(confirmer({ host: 'till', staffName: 'x'.repeat(200) }).name.length, 80);
});

test('confirmer: Back Office needs a real login, never an anonymous session', () => {
  assert.deepEqual(confirmer({ host: 'backoffice', user: { id: 'u1', email: 'm@v.com' }, userName: 'Mandy' }), { ok: true, via: 'backoffice', name: 'Mandy' });
  assert.equal(confirmer({ host: 'backoffice', user: { id: 'u1', email: 'm@v.com' } }).name, 'm@v.com');
  assert.deepEqual(confirmer({ host: 'backoffice', user: { id: 'u1', is_anonymous: true }, userName: 'x' }), { ok: false, reason: 'not_signed_in' });
  assert.deepEqual(confirmer({ host: 'backoffice', user: null }), { ok: false, reason: 'not_signed_in' });
});

test('confirmer: no other screen may confirm', () => {
  for (const host of ['kiosk', 'kds', 'customer-display', 'menuboard', 'orderscreen', 'clock', 'mpos', undefined]) {
    assert.deepEqual(confirmer({ host, staffName: 'Sam', user: { id: 'u' } }), { ok: false, reason: 'wrong_screen' }, String(host));
  }
  assert.deepEqual(confirmer(), { ok: false, reason: 'wrong_screen' });
});

test('chimeKey: one chime per message, one more when ServOS sends it again', () => {
  assert.equal(chimeKey(row({ id: 'a' })), 'a:2026-10-05T10:00:00Z');
  assert.notEqual(chimeKey(row({ id: 'a', resent_at: '2026-10-05T12:00:00Z' })), chimeKey(row({ id: 'a' })));
  assert.equal(chimeKey(null), null);
});

// ── before the database update ──────────────────────────────────────────────

test('isMissingVenueMessages: a database without the table or the function is "not yet", never an error', () => {
  assert.equal(isMissingVenueMessages({ code: '42P01', message: 'relation "public.venue_messages" does not exist' }), true);
  assert.equal(isMissingVenueMessages({ code: 'PGRST205', message: "Could not find the table 'public.venue_messages' in the schema cache" }), true);
  assert.equal(isMissingVenueMessages({ code: 'PGRST202', message: 'Could not find the function public.venue_message_confirm' }), true);
  assert.equal(isMissingVenueMessages({ message: 'Could not find the table public.venue_messages in the schema cache' }), true);
  assert.equal(isMissingVenueMessages({ code: '42501', message: 'permission denied for table venue_messages' }), false);
  assert.equal(isMissingVenueMessages({ message: 'Failed to fetch' }), false);
  assert.equal(isMissingVenueMessages(null), false);
});

// ── the Back Office list and the admin tick list ────────────────────────────

test('receivedList: the last 30 days, newest first', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const rows = [
    row({ id: 'old', sent_at: '2026-08-01T10:00:00Z' }),
    row({ id: 'a', sent_at: '2026-09-10T10:00:00Z', confirmed_at: 'x', confirmed_by: 'Sam' }),
    row({ id: 'b', sent_at: '2026-10-04T10:00:00Z' }),
  ];
  assert.deepEqual(receivedList(rows, { now }).map((r) => r.id), ['b', 'a']);
  assert.deepEqual(receivedList(null, { now }), []);
});

test('groupVenues: grouped by company, both sorted, search matches company or venue', () => {
  const g = groupVenues(venues);
  assert.deepEqual(g.map((x) => x.company), ['American Test', 'Coffee Boy']);
  assert.deepEqual(g[1].venues.map((v) => v.name), ['Barnsley', 'Leeds']);
  assert.deepEqual(groupVenues(venues, 'leeds').map((x) => x.venues.map((v) => v.name)), [['Leeds']]);
  assert.equal(groupVenues(venues, 'coffee')[0].venues.length, 2);
  assert.deepEqual(groupVenues(venues, 'zzz'), []);
  assert.equal(groupVenues([{ id: 'x', name: 'Solo' }])[0].company, 'No company');
});

// ── review fixes, 5 Oct 2026 ────────────────────────────────────────────────

test('sameMessage: one broadcast id is one text (a retry must carry the same words)', () => {
  const stored = { kind: 'info', title: null, body: 'Hi, update the till.' };
  assert.equal(sameMessage(stored, { kind: 'info', title: null, body: 'Hi, update the till.' }), true);
  assert.equal(sameMessage(stored, { kind: 'info', title: undefined, body: 'Hi, update the till.' }), true);
  assert.equal(sameMessage(stored, { kind: 'info', title: null, body: 'Hi, update the tills.' }), false, 'a fixed typo is a different text');
  assert.equal(sameMessage(stored, { kind: 'action', title: null, body: 'Hi, update the till.' }), false);
  assert.equal(sameMessage(stored, { kind: 'info', title: 'New', body: 'Hi, update the till.' }), false);
  assert.equal(sameMessage(null, stored), false);
  assert.equal(sameMessage(stored, null), false);
});

test('sendResultLine: says what was really written, never a send that wrote nothing', () => {
  assert.equal(sendResultLine({ sent: 6, written: 6 }), 'Sent to 6 venues. It is on their tills and Back Office now.');
  assert.equal(sendResultLine({ sent: 1, written: 1 }), 'Sent to 1 venue. It is on their tills and Back Office now.');
  assert.equal(sendResultLine({ sent: 8, written: 2 }), 'Sent to 2 venues. The other 6 already had it. It is on their tills and Back Office now.');
  assert.equal(sendResultLine({ sent: 6, written: 0 }), 'Already sent: all 6 venues have this message. Nothing was sent twice.');
  assert.equal(sendResultLine({ sent: 1, written: 0 }), 'Already sent: that venue has this message. Nothing was sent twice.');
  // An older server that does not say: believe the count asked for.
  assert.equal(sendResultLine({ sent: 3 }), 'Sent to 3 venues. It is on their tills and Back Office now.');
  for (const line of [sendResultLine({ sent: 8, written: 2 }), sendResultLine({ sent: 6, written: 0 })]) assert.ok(!/[\u2013\u2014]/.test(line));
});

test('mayShowPopup: it waits while CHANGE DUE is on the till, anything but a clear no is a wait', () => {
  assert.equal(mayShowPopup({ paymentQuiet: true, changeDueShowing: true }), false);
  assert.equal(mayShowPopup({ paymentQuiet: true, changeDueShowing: false }), true);
  assert.equal(mayShowPopup({ paymentQuiet: true, changeDueShowing: undefined }), true, 'left out = the default, not showing');
  assert.equal(mayShowPopup({ paymentQuiet: true, changeDueShowing: null }), false);
  assert.equal(mayShowPopup({ paymentQuiet: true, changeDueShowing: { amount: 36.5 } }), false);
  // The quiet seconds have passed and no hold is live: change due alone still makes it wait.
  _resetPaymentBusyForTests({ now: () => 10 });
  assert.equal(canApplyUpdate(), true);
  assert.equal(mayShowPopup({ paymentQuiet: canApplyUpdate(), changeDueShowing: true }), false);
  _resetPaymentBusyForTests();
});

test('popupKeyAction: a till takes no keys at all (a wedge ends with Enter)', () => {
  for (const key of ['Enter', ' ', 'Tab', 'a', '5', 'Escape', 'Backspace']) {
    assert.equal(popupKeyAction({ host: 'till', key, onButton: true, armed: true }), 'block', key);
  }
  assert.equal(popupKeyAction({ host: 'kiosk', key: 'Enter', onButton: true, armed: true }), 'block');
  assert.equal(popupKeyAction(), 'block');
});

test('popupKeyAction: Back Office may tab to Got it and press it; typing never reaches the form behind', () => {
  assert.equal(popupKeyAction({ host: 'backoffice', key: 'Tab' }), 'button');
  assert.equal(popupKeyAction({ host: 'backoffice', key: 'Enter', onButton: true, armed: true }), 'press');
  assert.equal(popupKeyAction({ host: 'backoffice', key: ' ', onButton: true, armed: true }), 'press');
  assert.equal(popupKeyAction({ host: 'backoffice', key: 'Enter', onButton: false, armed: true }), 'block', 'Enter anywhere else is swallowed');
  assert.equal(popupKeyAction({ host: 'backoffice', key: 'Enter', onButton: true, armed: false }), 'block', 'not before the button is awake');
  for (const key of ['4', '.', 'a', 'Escape', 'Backspace']) assert.equal(popupKeyAction({ host: 'backoffice', key }), 'block', key);
  // The browser's own keys are not cancelled (reload, dev tools), on either screen.
  assert.equal(popupKeyAction({ host: 'backoffice', key: 'r', modifier: true }), 'browser');
  assert.equal(popupKeyAction({ host: 'till', key: 'F5' }), 'browser');
});

test('gotItClickCounts: on a till only a real press counts, never a click a keyboard made', () => {
  assert.equal(gotItClickCounts({ host: 'till', armed: true, pressed: true }), true);
  assert.equal(gotItClickCounts({ host: 'till', armed: true, pressed: false }), false, 'Enter from a card swipe');
  assert.equal(gotItClickCounts({ host: 'till', armed: false, pressed: true }), false, 'not before the button is awake');
  assert.equal(gotItClickCounts({ host: 'backoffice', armed: true, pressed: false }), true, 'keyboard is fine in Back Office');
  assert.equal(gotItClickCounts({ host: 'backoffice', armed: false }), false);
  assert.equal(gotItClickCounts({ host: 'kiosk', armed: true, pressed: true }), false);
  assert.equal(gotItClickCounts(), false);
});

test('venueStatusLine: a Back Office confirm shows the login email, the proof a name is not', () => {
  const g = rollupBroadcasts([
    row({ id: '1', location_id: V1, confirmed_at: '2026-10-05T18:30:00Z', confirmed_by: 'Peter Roberts', confirmed_via: 'backoffice', confirmed_email: 'manager@venue.com' }),
    row({ id: '2', location_id: V2, confirmed_at: '2026-10-05T18:30:00Z', confirmed_by: 'Sam', confirmed_via: 'till', confirmed_email: null }),
    row({ id: '3', location_id: V3, confirmed_at: '2026-10-05T18:30:00Z', confirmed_by: 'm@v.com', confirmed_via: 'backoffice', confirmed_email: 'm@v.com' }),
  ], venues)[0];
  const by = (id) => g.venues.find((v) => v.locationId === id);
  assert.equal(by(V1).confirmedEmail, 'manager@venue.com');
  assert.equal(venueStatusLine(by(V1)), 'Confirmed by Peter Roberts (manager@venue.com) at 5 Oct, 19:30');
  assert.equal(venueStatusLine(by(V2)), 'Confirmed by Sam at 5 Oct, 19:30');
  assert.equal(venueStatusLine(by(V3)), 'Confirmed by m@v.com at 5 Oct, 14:30', 'not twice when the name IS the email');
  // A venue's own list never has the email (the column is not readable there).
  assert.equal(venueStatusLine({ status: 'confirmed', confirmedAt: '2026-10-05T18:30:00Z', confirmedBy: 'Mandy', confirmedVia: 'backoffice', timezone: 'Europe/London' }), 'Confirmed by Mandy at 5 Oct, 19:30');
});

test('tapsAfterFlush: done is forgotten, refused is kept and never asked again, the rest waits', () => {
  const pending = { a: { name: 'Sam', at: 't' }, b: { name: 'Sam', at: 't' }, c: { name: 'Jo', at: 't' }, d: { name: 'Jo', at: 't' } };
  const out = tapsAfterFlush(pending, {
    a: { ok: true, state: 'confirmed' }, b: { ok: false, reason: 'not_allowed' }, c: { ok: false, reason: 'failed' },
  });
  assert.deepEqual(Object.keys(out).sort(), ['b', 'c', 'd']);
  assert.equal(out.b.refused, true);
  assert.equal(out.c.refused, undefined);
  assert.deepEqual(tapsToSend(out).sort(), ['c', 'd']);
  assert.deepEqual(tapsAfterFlush(null, {}), {});
  assert.equal(CONFIRM_TIMEOUT_MS, 15000);
});

test('flushVenueMessageTaps: sends saved taps from outside the till shell, costs nothing when none are saved', async () => {
  let store = {};
  const calls = [];
  const deps = (answers) => ({
    read: () => JSON.parse(JSON.stringify(store)),
    write: (v) => { store = v; },
    send: async (id, name) => { calls.push([id, name]); const a = answers[id]; if (a instanceof Error) throw a; return a; },
  });
  // Nothing saved: no request.
  assert.equal(await flushVenueMessageTaps(deps({})), 0);
  assert.equal(calls.length, 0);
  // WiFi back on the PIN screen: the tap goes with the name of who tapped.
  store = { m1: { name: 'Sam', at: 't' }, m2: { name: 'Jo', at: 't' }, m3: { name: 'Al', at: 't', refused: true }, m4: { name: 'Di', at: 't' } };
  assert.equal(await flushVenueMessageTaps(deps({ m1: { ok: true, state: 'confirmed' }, m2: { ok: false, reason: 'failed' }, m4: new Error('boom') })), 3);
  assert.deepEqual(calls, [['m1', 'Sam'], ['m2', 'Jo'], ['m4', 'Di']]);
  assert.deepEqual(Object.keys(store).sort(), ['m2', 'm3', 'm4'], 'done forgotten, failed and thrown kept, refused never asked');
  // While a screen is running the hook it owns the list: the flush stands back.
  calls.length = 0;
  hookStarted();
  assert.equal(await flushVenueMessageTaps(deps({ m2: { ok: true } })), 0);
  assert.equal(calls.length, 0);
  hookStopped();
  assert.equal(await flushVenueMessageTaps(deps({ m2: { ok: true }, m4: { ok: true } })), 2);
  assert.deepEqual(Object.keys(store), ['m3']);
});
