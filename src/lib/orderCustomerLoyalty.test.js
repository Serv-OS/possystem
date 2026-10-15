// src/lib/orderCustomerLoyalty.test.js
//
// The order's customer and their loyalty on the customer display and at checkout (28 Sep 2026,
// Peter at Coffee Boy Leeds). Pure rules and the announce runner against fakes; the wiring is
// pinned in orderCustomerLoyaltyWiring.test.js. SYNTHETIC data shaped like fetchCustomerByPhone's
// answer for a stamps only venue (points off, one 10 stamp card).
// Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupPhoneOf, stillOrderCustomer, displayLoyaltyOf, customerWithStamps, checkoutLoyaltyView, announceOrderCustomer,
} from './orderCustomerLoyalty.js';

const CARD = (collected, ready = 0) => ({
  id: 'prog-1', name: 'Free Drink', icon: '☕', stamps_required: 10, stamps_collected: collected,
  completed_count: ready ? 1 : 0, rewards_available: ready, reward_description: 'Free Drink',
});
const STAMP_REWARD = { id: 'stamp:prog-1', label: 'Free Drink', pointsCost: 0, type: 'free_item', stamp: true, stampProgramId: 'prog-1', available: 1 };

/** What fetchCustomerByPhone answers for a member (lib/customerLookup.js). */
const lookupAnswer = (over = {}) => ({
  customerId: 'cust-1', name: 'Sam Member', email: 'x@example.com', marketingOptIn: false, knownCustomer: true,
  rewards: [], credit: 0, memberCode: 'SRV-TEST01', tier: null, stampCards: [CARD(5)], giftCards: [],
  pointsEnabled: false, stampsEnabled: true,
  ...over,
});

// ── the customer form → the customer display ─────────────────────────────

test('lookupPhoneOf: the phone as on the order, only with seven digits or more', () => {
  assert.equal(lookupPhoneOf({ phone: ' 07700 900123 ' }), '07700 900123');
  assert.equal(lookupPhoneOf({ phone: '+447700900123' }), '+447700900123');
  assert.equal(lookupPhoneOf({ phone: '12345' }), '');
  assert.equal(lookupPhoneOf({ name: 'Sam' }), '', 'name only form: nothing to look up');
  assert.equal(lookupPhoneOf({ phone: null }), '');
  assert.equal(lookupPhoneOf(null), '');
});

test('stillOrderCustomer: same phone as written on the order, nothing else', () => {
  assert.equal(stillOrderCustomer({ phone: '07700900123' }, '07700900123'), true);
  assert.equal(stillOrderCustomer({ phone: '07700900123' }, '+447700900123'), false, 'another spelling: the display join already spoke');
  assert.equal(stillOrderCustomer(null, '07700900123'), false, 'customer removed');
  assert.equal(stillOrderCustomer({ phone: '07700900999' }, '07700900123'), false, 'another customer picked');
  assert.equal(stillOrderCustomer({ phone: '' }, ''), false);
});

test('displayLoyaltyOf: the display join\'s shape, stamps for a stamps venue, nothing for a new number', () => {
  const d = displayLoyaltyOf(lookupAnswer());
  assert.deepEqual(Object.keys(d).sort(), ['customerId', 'known', 'name', 'points', 'pointsEnabled', 'rewards', 'stamps', 'stampsEnabled']);
  assert.equal(d.known, true);
  assert.equal(d.name, 'Sam Member');
  assert.equal(d.points, 0);
  assert.equal(d.pointsEnabled, false, 'the display never says "0 points" at a stamps venue');
  assert.deepEqual(d.stamps.map((s) => [s.name, s.have, s.need, s.ready]), [['Free Drink', 5, 10, 0]]);
  assert.equal(d.customerId, 'cust-1');
  // a profile with no name takes the order's name; stamps off shows no cards
  assert.equal(displayLoyaltyOf(lookupAnswer({ name: '' }), { name: 'Sam' }).name, 'Sam');
  assert.deepEqual(displayLoyaltyOf(lookupAnswer({ stampsEnabled: false })).stamps, []);
  // nobody found: nothing is sent (never "Welcome back" to a stranger)
  assert.equal(displayLoyaltyOf(null), null);
  assert.equal(displayLoyaltyOf({ knownCustomer: false }), null);
});

test('customerWithStamps: the chip gets the stamps; no change means no second setCustomer', () => {
  const cur = { name: 'Sam', phone: '07700900123', isASAP: true };
  const stamps = displayLoyaltyOf(lookupAnswer()).stamps;
  const next = customerWithStamps(cur, stamps);
  assert.deepEqual(next, { ...cur, stampSummary: stamps });
  assert.equal(customerWithStamps(next, stamps), null, 'same stamps: nothing to do');
  assert.equal(customerWithStamps(cur, []), null, 'no stamps either side');
  assert.deepEqual(customerWithStamps({ ...cur, stampSummary: stamps }, []).stampSummary, [], 'stale stamps are cleared');
  assert.equal(customerWithStamps(null, stamps), null);
});

test('announce: the form\'s customer reaches the display and the chip (Leeds, 28 Sep, 10:17 UTC)', async () => {
  let order = { name: 'Sam', phone: '07700900123', email: '', notes: '', isASAP: true };
  const sent = [];
  const looked = [];
  const r = await announceOrderCustomer({
    customer: order,
    displayOn: true,
    lookup: async (p) => { looked.push(p); return lookupAnswer(); },
    current: () => order,
    apply: (c) => { order = c; },
    publish: (l) => sent.push(l),
  });
  assert.equal(r.sent, true);
  assert.deepEqual(looked, ['07700900123'], 'looked up once, by the phone as on the order');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].known, true);
  assert.equal(sent[0].name, 'Sam Member');
  assert.deepEqual(sent[0].stamps.map((s) => `${s.have}/${s.need}`), ['5/10']);
  assert.deepEqual(order.stampSummary, sent[0].stamps, 'the chip shows 5/10');
  assert.equal(order.isASAP, true, 'the rest of the order customer is kept');
});

test('announce: nothing is sent when there is nothing to say, or the order moved on', async () => {
  const base = { customer: { name: 'Sam', phone: '07700900123' }, displayOn: true };
  const run = (over) => {
    const sent = [];
    const applied = [];
    return announceOrderCustomer({
      ...base, lookup: async () => lookupAnswer(), current: () => base.customer,
      apply: (c) => applied.push(c), publish: (l) => sent.push(l), ...over,
    }).then((r) => ({ r, sent, applied }));
  };
  let x = await run({ customer: { name: 'Sam' } });
  assert.deepEqual([x.r.why, x.sent.length, x.applied.length], ['no_phone', 0, 0]);
  x = await run({ displayOn: false });
  assert.deepEqual([x.r.why, x.sent.length], ['no_display', 0], 'a till without a customer display looks nothing up');
  x = await run({ current: () => null });
  assert.deepEqual([x.r.why, x.sent.length, x.applied.length], ['moved_on', 0, 0], 'customer removed while it looked');
  x = await run({ current: () => ({ name: 'Other', phone: '07700900999' }) });
  assert.deepEqual([x.r.why, x.sent.length, x.applied.length], ['moved_on', 0, 0], 'another customer picked meanwhile');
  x = await run({ lookup: async () => null });
  assert.deepEqual([x.r.why, x.sent.length, x.applied.length], ['not_found', 0, 0], 'a new number: the display shows nothing');
  x = await run({ lookup: async () => { throw new Error('offline'); } });
  assert.deepEqual([x.r.why, x.sent.length], ['not_found', 0], 'a failed lookup never throws');
  x = await run({ publish: () => { throw new Error('channel down'); } });
  assert.equal(x.r.sent, true, 'a failed broadcast never throws');
});

test('announce: a customer the lookup finds but who is not a member yet is still greeted', async () => {
  const sent = [];
  const cust = { name: 'New Person', phone: '07700900123' };
  const r = await announceOrderCustomer({
    customer: cust, displayOn: true,
    lookup: async () => lookupAnswer({ name: 'New Person', memberCode: null, stampCards: [] }),
    current: () => cust, apply: () => assert.fail('no stamps: the order customer is not set again'), publish: (l) => sent.push(l),
  });
  assert.equal(r.sent, true);
  assert.deepEqual(sent[0].stamps, []);
  assert.equal(sent[0].pointsEnabled, false);
});

// ── checkout ──────────────────────────────────────────────────────────────

/** The checkout's gate before 28 Sep 2026, to show what it hid. */
const oldGate = (d) => !!d && (((d.points_enabled !== false) && d.credit > 0) || (d.rewards?.length > 0));

test('checkout: a stamps only member with no free drink ready now shows (the Leeds case)', () => {
  const d = lookupAnswer();
  assert.equal(oldGate(d), false, 'the old gate hid it: points 0, no reward');
  const v = checkoutLoyaltyView(d);
  assert.ok(v);
  assert.equal(v.pointsOn, false, 'pointsEnabled false is honoured (the old code read points_enabled)');
  assert.equal(v.line, '☕ Free Drink 5/10 · Nothing to redeem yet');
  assert.equal(v.rewardCount, 0);
});

test('checkout: a ready stamp card says there is a reward to redeem', () => {
  const v = checkoutLoyaltyView(lookupAnswer({ stampCards: [CARD(10, 1)], rewards: [STAMP_REWARD] }));
  assert.equal(v.line, '☕ Free Drink 10/10 · 1 reward to redeem');
  assert.equal(v.rewardCount, 1);
});

test('checkout: a points venue shows the points, 0 included, and its rewards', () => {
  const pts = { pointsEnabled: true, stampsEnabled: false, stampCards: [] };
  assert.equal(checkoutLoyaltyView(lookupAnswer({ ...pts, credit: 0 })).line, '0 points · Nothing to redeem yet');
  assert.equal(checkoutLoyaltyView(lookupAnswer({ ...pts, credit: 1 })).line, '1 point · Nothing to redeem yet');
  assert.equal(checkoutLoyaltyView(lookupAnswer({ ...pts, credit: 120, rewards: [{ id: 'r1' }, { id: 'r2' }] })).line, '120 points · 2 rewards to redeem');
  // both halves on
  assert.equal(checkoutLoyaltyView(lookupAnswer({ pointsEnabled: true, credit: 40 })).line, '40 points · ☕ Free Drink 5/10 · Nothing to redeem yet');
  // loyalty-balance's own spelling of the switch is honoured too
  assert.equal(checkoutLoyaltyView(lookupAnswer({ pointsEnabled: undefined, points_enabled: false })).pointsOn, false);
});

test('checkout: nothing to show for no answer or a profile that is not a loyalty member', () => {
  assert.equal(checkoutLoyaltyView(null), null);
  assert.equal(checkoutLoyaltyView({ knownCustomer: false }), null);
  assert.equal(checkoutLoyaltyView(lookupAnswer({ memberCode: null, stampCards: [], credit: 0, rewards: [] })), null,
    'a customer row with no membership (loyalty-balance 404): joins when paid');
  assert.ok(checkoutLoyaltyView(lookupAnswer({ memberCode: null, stampCards: [], credit: 0, rewards: [STAMP_REWARD] })), 'a reward always shows');
});
