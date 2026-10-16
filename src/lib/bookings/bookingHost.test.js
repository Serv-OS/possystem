/**
 * bookingHost.test.js: the host tools rules (16 Oct 2026, v5.11.70 host track).
 * The same file runs in the host stand, Back Office, the till and the edge
 * functions (supabase/functions/_shared/bookingHost.js), so these tests guard
 * the screens and the servers at once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  visibleTags, guestChips, REGULAR_VISITS,
  refundReference, parseRefundReference, refundRowsFor, refundedMinorFor, refundableMinor,
  refundSuggestion, refundCheck, parentAfterRefund, creditMinorOf, isRefundableRow,
  widgetPartyBounds, partyNeedsRequest, requestRow, inboxRows, declineText,
  lateState, floorDrop, isManagerRole, consentChannel, safeLink, payLinkText,
} from '../../../supabase/functions/_shared/bookingHost.js';
import { payLinkToken, payLinkTokenOk, payLinkUrl } from '../../../supabase/functions/_shared/payLink.js';

const P = '3f2b8c1e-1d2a-4b5c-8d9e-0a1b2c3d4e5f';

// ── guest tags ──────────────────────────────────────────────────────────────
test('visibleTags hides the merge trail, import markers and duplicates', () => {
  assert.deepEqual(
    visibleTags(['vip', 'merge_done', 'merged_into:abc', 'email_join:+44', 'join_notice:+44', 'demo', 'VIP', ' press ', '', null]),
    ['vip', 'press'],
  );
  assert.deepEqual(visibleTags(null), []);
});

test('guestChips: VIP first, Regular from the tag or from visits, the visit count, then the rest', () => {
  assert.deepEqual(guestChips({ tags: ['vip', 'local-business'], visits: 1 }).map((c) => c.label), ['VIP', '1 visit', 'local business']);
  assert.deepEqual(guestChips({ tags: [], visits: REGULAR_VISITS }).map((c) => c.key), ['regular', 'visits']);
  assert.deepEqual(guestChips({ tags: ['Regular'], visits: 0 }).map((c) => c.label), ['Regular']);
  assert.deepEqual(guestChips({ tags: [], visits: 5, noShows: 2 }).map((c) => c.label), ['Regular', '5 visits', '2 no-shows']);
  assert.deepEqual(guestChips({}), []);
});

// ── refunds ─────────────────────────────────────────────────────────────────
const paid = { id: P, kind: 'prepay', status: 'captured', amount: 76 };

test('refund references round trip and fit the 60 character key rule', () => {
  const ref = refundReference(P, 2);
  assert.equal(ref, `bkrf-${P}-2`);
  assert.ok(ref.length <= 60);
  assert.deepEqual(parseRefundReference(ref), { parentId: P, n: 2 });
  assert.equal(parseRefundReference('bkpay-bk-1-prepay-a1'), null);
  assert.equal(parseRefundReference(''), null);
});

test('refunded money counts pending and settled refunds, never failed ones', () => {
  const rows = [
    { kind: 'refund', status: 'refunded', amount: 20, merchant_reference: refundReference(P, 1) },
    { kind: 'refund', status: 'pending', amount: 6, merchant_reference: refundReference(P, 2) },
    { kind: 'refund', status: 'failed', amount: 50, merchant_reference: refundReference(P, 3) },
    { kind: 'refund', status: 'refunded', amount: 9, refund_of: P },
    { kind: 'refund', status: 'refunded', amount: 99, merchant_reference: refundReference('11111111-1111-4111-8111-111111111111', 1) },
  ];
  assert.equal(refundRowsFor(paid, rows).length, 4);
  assert.equal(refundedMinorFor(paid, rows), 3500);
  assert.equal(refundableMinor(paid, rows), 7600 - 3500);
  // the column wins when it knows more than the visible rows
  assert.equal(refundedMinorFor({ ...paid, amount_refunded_minor: 5000 }, []), 5000);
});

test('holds, refunds and money not taken are never refundable', () => {
  assert.equal(isRefundableRow({ kind: 'hold', status: 'authorised', amount: 40 }), false);
  assert.equal(isRefundableRow({ kind: 'hold', status: 'captured', amount: 40 }), false);
  assert.equal(isRefundableRow({ kind: 'prepay', status: 'pending', amount: 40 }), false);
  assert.equal(isRefundableRow({ kind: 'deposit', status: 'needs_refund', amount: 40 }), true);
  assert.equal(refundableMinor({ kind: 'hold', status: 'authorised', amount: 600 }), 0);
});

test('refundCheck explains every refusal in words', () => {
  const fmt = (m) => `£${(m / 100).toFixed(2)}`;
  assert.match(refundCheck({ parent: { kind: 'hold', status: 'authorised', amount: 0 }, amountMinor: 100, fmt }).error, /saved card took no money/);
  assert.match(refundCheck({ parent: { ...paid, status: 'refunded' }, amountMinor: 100, fmt }).error, /refunded in full/);
  assert.match(refundCheck({ parent: paid, amountMinor: 0, fmt }).error, /above zero/);
  assert.match(refundCheck({ parent: paid, amountMinor: 12.5, fmt }).error, /above zero/);
  assert.match(refundCheck({ parent: paid, amountMinor: 9000, fmt }).error, /Only £76.00 can still be refunded/);
  assert.match(refundCheck({ parent: paid, amountMinor: 2000, partialAllowed: false, fmt }).error, /Part refunds arrive with the database update/);
  assert.deepEqual(refundCheck({ parent: paid, amountMinor: 7600, partialAllowed: false, fmt }), { ok: true, error: null, amountMinor: 7600, leftAfterMinor: 0 });
  assert.equal(refundCheck({ parent: paid, amountMinor: 2000, fmt }).leftAfterMinor, 5600);
  assert.match(refundCheck({ parent: null }).error, /could not be found/);
});

test('the suggested refund is what the bill did not use, else everything left', () => {
  assert.equal(refundSuggestion({ ...paid, refund_due_minor: 1400 }, []), 1400);
  assert.equal(refundSuggestion(paid, []), 7600);
  assert.equal(refundSuggestion({ ...paid, refund_due_minor: 99999 }, []), 7600);
});

test('a part refund keeps the payment captured and lowers its credit', () => {
  assert.deepEqual(parentAfterRefund(paid, 2000), { status: 'captured', refundedMinor: 2000 });
  assert.deepEqual(parentAfterRefund(paid, 7600), { status: 'refunded', refundedMinor: 7600 });
  assert.deepEqual(parentAfterRefund(paid, 9999), { status: 'refunded', refundedMinor: 7600 });
  assert.equal(creditMinorOf({ amount: 76, amount_refunded_minor: 2000 }), 5600);
  assert.equal(creditMinorOf({ amount: 76 }), 7600);
});

// ── large parties and the inbox ─────────────────────────────────────────────
test('widget party bounds: defaults, venue settings, never above what the pacing cap can take', () => {
  assert.deepEqual(widgetPartyBounds({}), { min: 1, max: 12 });
  assert.deepEqual(widgetPartyBounds({ widgetMinParty: 2, widgetMaxParty: 8 }), { min: 2, max: 8 });
  assert.deepEqual(widgetPartyBounds({ widget_min_party: 4, widget_max_party: 2 }), { min: 4, max: 4 });
  assert.deepEqual(widgetPartyBounds({ widgetMaxParty: 20 }, 10), { min: 1, max: 10 });
  assert.equal(partyNeedsRequest(9, { max: 8 }), true);
  assert.equal(partyNeedsRequest(8, { max: 8 }), false);
});

test('the inbox lists pending requests with no booking, not for a day gone, newest first', () => {
  const rows = [
    { id: 'a', status: 'pending', booking_id: null, created_at: '2026-10-15T10:00:00Z', payload: { kind: 'large_party', date: '2026-10-20', time: '19:30:00', party: 14, name: 'Ada Lane', phone: '+447700900001' } },
    { id: 'b', status: 'pending', booking_id: 'bk-1', created_at: '2026-10-16T10:00:00Z', payload: { date: '2026-10-20' } },
    { id: 'c', status: 'accepted', booking_id: null, created_at: '2026-10-16T11:00:00Z', payload: {} },
    { id: 'd', status: 'pending', booking_id: null, created_at: '2026-10-16T12:00:00Z', payload: { reason: 'slot_gone', date: '2026-10-17', party: '3' } },
    { id: 'e', status: 'pending', booking_id: null, created_at: '2026-10-16T13:00:00Z', payload: { date: '2026-10-01', party: 2 } },
  ];
  const out = inboxRows(rows, '2026-10-16');
  assert.deepEqual(out.map((r) => r.id), ['d', 'a']);
  assert.equal(out[1].kind, 'large_party');
  assert.equal(out[1].time, '19:30');
  assert.equal(out[0].kind, 'slot_gone');
  assert.equal(out[0].party, 3);
  assert.equal(requestRow({ payload: null }).name, 'Guest');
});

test('the decline SMS greets by first name and falls back to a polite default', () => {
  assert.equal(declineText({ venue: 'Provo', name: 'Ada Lane', message: 'we are closed for a private event.' }), 'Hi Ada, we are closed for a private event.');
  assert.match(declineText({ venue: 'Provo' }), /^Hi there, Sorry, Provo cannot take this booking/);
});

// ── late parties ────────────────────────────────────────────────────────────
test('a late party asks to be released after the venue minutes', () => {
  const b = { status: 'confirmed', startTime: '19:00' };
  assert.equal(lateState({ booking: b, nowMin: 19 * 60 }), null);
  assert.deepEqual(lateState({ booking: b, nowMin: 19 * 60 + 10 }), { lateBy: 10, release: false, releaseMinutes: 15 });
  assert.deepEqual(lateState({ booking: b, nowMin: 19 * 60 + 15 }), { lateBy: 15, release: true, releaseMinutes: 15 });
  assert.equal(lateState({ booking: b, nowMin: 19 * 60 + 5, releaseMinutes: 5 }).release, true);
  assert.equal(lateState({ booking: { ...b, status: 'dining' }, nowMin: 20 * 60 }), null);
  assert.equal(lateState({ booking: b, nowMin: null }), null);
});

// ── floor drag ──────────────────────────────────────────────────────────────
test('floor drop: green when free, red with the clashing name, seats and open tabs checked', () => {
  const booking = { id: 'b1', status: 'confirmed', tables: ['t1'], startTime: '19:00', turnMinutes: 90, covers: 4, customer: { name: 'Oliver' } };
  const t4 = { id: 't4', label: 'T4', maxCovers: 4 };
  const others = [
    { id: 'b2', status: 'confirmed', tables: ['t5'], startTime: '19:30', turnMinutes: 90, customer: { name: 'Mia Hart' } },
    { id: 'b3', status: 'cancelled', tables: ['t4'], startTime: '19:00', turnMinutes: 90 },
    { id: 'b4', status: 'confirmed', tables: ['t4'], startTime: '21:00', turnMinutes: 60 },
  ];
  assert.deepEqual(floorDrop({ booking, table: t4, others }), { ok: true, reason: null, tables: ['t4'], label: 'T4', mode: 'move' });
  const red = floorDrop({ booking, table: { id: 't5', label: 'T5', maxCovers: 6 }, others });
  assert.equal(red.ok, false);
  assert.equal(red.reason, 'T5 is booked for Mia Hart at 19:30.');
  assert.match(floorDrop({ booking, table: { id: 't2', label: 'T2', maxCovers: 2 }, others }).reason, /T2 seats 2, this party is 4/);
  assert.equal(floorDrop({ booking, table: { id: 't1', label: 'T1', maxCovers: 4 }, others }).unchanged, true);
  // seat now: an open tab refuses, and the window runs from now when early
  assert.match(floorDrop({ booking, table: { ...t4, session: { items: [] } }, others, nowMin: 18 * 60, mode: 'seat' }).reason, /open tab/);
  const early = floorDrop({ booking, table: t4, others: [{ id: 'b9', status: 'confirmed', tables: ['t4'], startTime: '18:00', turnMinutes: 60, covers: 2 }], nowMin: 18 * 60 + 30, mode: 'seat' });
  assert.equal(early.ok, false);
  assert.match(early.reason, /Party of 2 at 18:00/);
  assert.equal(floorDrop({ booking, table: null }).ok, false);
});

// ── manager PIN, consent, links ─────────────────────────────────────────────
test('manager roles, consent channel and safe links', () => {
  assert.equal(isManagerRole('Manager'), true);
  assert.equal(isManagerRole('owner'), true);
  assert.equal(isManagerRole('Server'), false);
  assert.equal(isManagerRole(null), false);
  assert.equal(consentChannel({ phone: '+447700900001', email: 'a@b.co' }), 'both');
  assert.equal(consentChannel({ phone: '+447700900001', email: ' ' }), 'sms');
  assert.equal(consentChannel({ email: 'a@b.co' }), 'email');
  assert.equal(consentChannel({}), null);
  assert.equal(safeLink(' https://venue.example/privacy '), 'https://venue.example/privacy');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink(''), null);
});

test('pay link tokens are stable per booking, differ between bookings and check in constant time', async () => {
  const a = await payLinkToken('secret', 'bk-1');
  assert.equal(a.length, 40);
  assert.equal(a, await payLinkToken('secret', 'bk-1'));
  assert.notEqual(a, await payLinkToken('secret', 'bk-2'));
  assert.notEqual(a, await payLinkToken('other', 'bk-1'));
  assert.equal(await payLinkTokenOk('secret', 'bk-1', a), true);
  assert.equal(await payLinkTokenOk('secret', 'bk-2', a), false);
  assert.equal(await payLinkTokenOk('secret', 'bk-1', 'short'), false);
  assert.equal(await payLinkToken('', 'bk-1'), null);
  assert.equal(payLinkUrl('https://provo.example/', 'bk-1', a), `https://provo.example/book?pay=bk-1&t=${a}`);
  assert.equal(payLinkUrl(null, 'bk-1', a), null);
  assert.match(payLinkText({ venue: 'Provo', name: 'Ada Lane', date: 'Sat 17 Oct', time: '19:00', kind: 'deposit', amountText: '£40.00', link: 'L' }), /^Hi Ada, to confirm your table at Provo on Sat 17 Oct at 19:00, please pay your £40.00 deposit: L$/);
  assert.match(payLinkText({ kind: 'hold', link: 'L' }), /save a card to hold your table \(nothing is taken\)/);
});
