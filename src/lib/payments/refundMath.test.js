// Tests for the refund money maths (v5.6.79, tasks #107 + #108).
//
// The two defects these lock down:
//   #108  a "full" refund returned ITEMS ONLY, so the tip and the service charge
//         were never given back, and full-vs-partial was decided against subtotal.
//   #107  every card leg was routed to Stripe unless the check said 'ryft', so
//         Adyen refunds aimed at a processor that had never heard of the payment.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refundedSoFar, itemsBasis, refundBreakdown, cardLegsOf, legRefundedMinor,
  allocateToLegs, refundReference, rollUpLegStatus, retryableLegs,
  ADYEN_REFERENCE_MAX, toMinor, r2,
} from './refundMath.js';

// A £40 meal + £5 service + £6 tip = £51 paid on one card.
const check = () => ({
  id: 'chk-1', total: 51, subtotal: 40, service: 5, tip: 6, taxAmount: 8.5,
  processor: 'adyen', method: 'card',
  items: [
    { uid: 'a', name: 'Steak', price: 25, qty: 1 },
    { uid: 'b', name: 'Wine', price: 7.5, qty: 2 },
  ],
  paymentIntents: [{ id: 'psp1', amountMinor: 5100, card: { brand: 'visa', last4: '4242' } }],
  refunds: [],
});

// ── #108 — tips and service are refundable ──────────────────────────────────

test('full refund returns the WHOLE total, not just the items', () => {
  const bd = refundBreakdown(check(), { isFullRefund: true });
  assert.equal(bd.amount, 51);          // was 40 (subtotal) before v5.6.79
  assert.equal(bd.tip, 6);
  assert.equal(bd.service, 5);
  assert.equal(bd.itemsAmount, 40);
  // The three parts must always re-sum to the amount — no penny left loose.
  assert.equal(r2(bd.itemsAmount + bd.tip + bd.service), bd.amount);
});

test('an ordinary no-tip no-service check is UNCHANGED by the rewrite', () => {
  const plain = { total: 40, subtotal: 40, service: 0, tip: 0, items: [{ uid: 'a', price: 40, qty: 1 }], refunds: [] };
  const bd = refundBreakdown(plain, { isFullRefund: true });
  assert.equal(bd.amount, 40);
  assert.equal(bd.tip, 0);
  assert.equal(bd.service, 0);
});

test('full refund on a DISCOUNTED check returns what was paid, never the subtotal', () => {
  // £40 of items, £10 off, so £30 was taken. Refunding `subtotal` would have
  // returned £40 — £10 more than the customer ever paid.
  const disc = { total: 30, subtotal: 40, service: 0, tip: 0, items: [{ uid: 'a', price: 40, qty: 1 }], refunds: [] };
  assert.equal(refundBreakdown(disc, { isFullRefund: true }).amount, 30);
});

test('partial refund apportions tip and service PRO RATA to the items returned', () => {
  // Half the food back (£20 of £40) → half the tip and half the service.
  const bd = refundBreakdown(check(), { items: [{ uid: 'b', price: 7.5, refundQty: 2 }] });
  assert.equal(bd.itemsAmount, 15);
  assert.equal(r2(bd.share), r2(15 / 40));
  assert.equal(bd.proRataTip, 2.25);        // 6 × 0.375
  assert.equal(bd.proRataService, 1.88);    // 5 × 0.375, rounded
  assert.equal(bd.amount, r2(15 + 2.25 + 1.88));
});

test('the operator can override the tip and the service, and 0 is a real answer', () => {
  const items = [{ uid: 'b', price: 7.5, refundQty: 2 }];
  const goodwill = refundBreakdown(check(), { items, tipOverride: 6 });
  assert.equal(goodwill.tip, 6);            // whole tip back as a gesture

  const none = refundBreakdown(check(), { items, tipOverride: 0, serviceOverride: 0 });
  assert.equal(none.tip, 0);
  assert.equal(none.service, 0);
  assert.equal(none.amount, 15);            // items only — 0 is not "use pro-rata"
});

test('an override cannot exceed what is left of the tip', () => {
  const bd = refundBreakdown(check(), { items: [{ uid: 'a', price: 25, refundQty: 1 }], tipOverride: 999 });
  assert.equal(bd.tip, 6);
});

test('cumulative refunds can never exceed the check total', () => {
  const c = { ...check(), refunds: [{ id: 'r1', amount: 45, tipAmount: 6, serviceAmount: 5 }] };
  const bd = refundBreakdown(c, { isFullRefund: true });
  assert.equal(bd.maxRefund, 6);            // 51 − 45
  assert.equal(bd.amount, 6);
  // And a partial that asks for more is trimmed to the remainder.
  const over = refundBreakdown(c, { items: [{ uid: 'a', price: 25, refundQty: 1 }], tipOverride: 0, serviceOverride: 0 });
  assert.equal(over.amount, 6);
});

test('tip and service already refunded are not offered twice', () => {
  const c = { ...check(), refunds: [{ id: 'r1', amount: 8, tipAmount: 6, serviceAmount: 2 }] };
  const bd = refundBreakdown(c, { isFullRefund: true });
  assert.equal(bd.tipRemaining, 0);
  assert.equal(bd.serviceRemaining, 3);
  assert.equal(bd.tip, 0);
  assert.equal(bd.service, 3);
});

test('LEGACY refund entries read as items-only so old checks still total honestly', () => {
  // Written before v5.6.79: an items-only amount and no split at all.
  const c = { ...check(), refunds: [{ id: 'old', amount: 15 }] };
  const done = refundedSoFar(c);
  assert.equal(done.items, 15);
  assert.equal(done.tip, 0);
  assert.equal(done.service, 0);
  // The tip was genuinely never returned, so it is still available.
  assert.equal(refundBreakdown(c, { isFullRefund: true }).tip, 6);
});

test('itemsBasis ignores voided lines and falls back to subtotal', () => {
  assert.equal(itemsBasis(check()), 40);
  assert.equal(itemsBasis({ subtotal: 12, items: [{ uid: 'a', price: 5, qty: 1, voided: true }] }), 12);
  assert.equal(itemsBasis({ subtotal: 9, items: [] }), 9);
});

// ── #107 — per-leg routing ──────────────────────────────────────────────────

test('a leg inherits the CHECK processor, so an Adyen check routes to Adyen', () => {
  const legs = cardLegsOf(check());
  assert.equal(legs.length, 1);
  assert.equal(legs[0].processor, 'adyen');   // the old rule made this 'stripe'
  assert.equal(legs[0].last4, '4242');
});

test('a leg may name its OWN processor, overriding the check', () => {
  const c = { ...check(), processor: 'adyen', paymentIntents: [{ id: 'pi_1', amountMinor: 100, processor: 'stripe' }] };
  assert.equal(cardLegsOf(c)[0].processor, 'stripe');
});

test('the legacy single-id field normalises to a one-leg list', () => {
  const c = { total: 20, processor: 'ryft', stripePaymentIntentId: 'ps_9', refunds: [] };
  const legs = cardLegsOf(c);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].id, 'ps_9');
  assert.equal(legs[0].amountMinor, 2000);
  assert.equal(legs[0].processor, 'ryft');
});

test('a 3-card split fills legs front-to-back, each capped at its own charge', () => {
  const legs = [
    { id: 'L1', amountMinor: 1000, processor: 'adyen' },
    { id: 'L2', amountMinor: 2000, processor: 'adyen' },
    { id: 'L3', amountMinor: 3000, processor: 'adyen' },
  ];
  const { allocations, unallocatedMinor } = allocateToLegs(legs, 2500);
  assert.deepEqual(allocations.map(a => [a.id, a.refundMinor]), [['L1', 1000], ['L2', 1500]]);
  assert.equal(unallocatedMinor, 0);
});

test('per-leg operator picks are honoured but still clamped to each card', () => {
  const legs = [
    { id: 'L1', amountMinor: 1000, processor: 'adyen' },
    { id: 'L2', amountMinor: 2000, processor: 'adyen' },
  ];
  // Ask for more than L1 ever took — it is trimmed, never funded by L2.
  const { allocations } = allocateToLegs(legs, 2500, { L1: 5000, L2: 500 });
  assert.deepEqual(allocations.map(a => [a.id, a.refundMinor]), [['L1', 1000], ['L2', 500]]);
});

test('a leg with an UNKNOWN captured amount is not capped', () => {
  const { allocations } = allocateToLegs([{ id: 'L1', amountMinor: null, processor: 'stripe' }], 4200);
  assert.equal(allocations[0].refundMinor, 4200);
});

test('headroom excludes what a leg was already refunded', () => {
  const legs = [{ id: 'L1', amountMinor: 1000, processor: 'adyen' }];
  const { allocations, unallocatedMinor } = allocateToLegs(legs, 1000, null, { L1: 600 });
  assert.equal(allocations[0].refundMinor, 400);
  assert.equal(unallocatedMinor, 600);
});

test('only legs that MOVED money count against the cap — a failed one stays retryable', () => {
  const c = {
    refunds: [{
      id: 'r1',
      legs: [
        { id: 'L1', amountMinor: 500, status: 'succeeded' },
        { id: 'L2', amountMinor: 700, status: 'failed' },
        { id: 'L3', amountMinor: 300, status: 'accepted' },
      ],
    }],
  };
  const done = legRefundedMinor(c);
  assert.equal(done.L1, 500);
  assert.equal(done.L2, undefined);   // nothing moved, headroom intact
  assert.equal(done.L3, 300);         // in flight at Adyen — absolutely counts
});

// ── outcome roll-up: only 'succeeded' may look finished ─────────────────────

test('rollUpLegStatus never calls a part-failed reversal a success', () => {
  assert.equal(rollUpLegStatus([]), 'none');
  assert.equal(rollUpLegStatus([{ status: 'succeeded' }, { status: 'succeeded' }]), 'succeeded');
  assert.equal(rollUpLegStatus([{ status: 'succeeded' }, { status: 'accepted' }]), 'accepted');
  assert.equal(rollUpLegStatus([{ status: 'succeeded' }, { status: 'failed' }]), 'partial');
  assert.equal(rollUpLegStatus([{ status: 'failed' }, { status: 'failed' }]), 'failed');
  assert.equal(rollUpLegStatus([{ status: 'skipped' }]), 'none');
});

test('retryableLegs picks out exactly the failed ones', () => {
  const legs = [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'accepted' }];
  assert.deepEqual(retryableLegs({ legs }).map(l => l.id), ['b']);
});

// ── idempotency key length: Adyen's hard 64-char limit ──────────────────────

test('the refund reference stays inside Adyen Idempotency-Key limits', () => {
  const ref = refundReference('ref-1755273600000', 'NX4TFC9DBQ8GWR82');
  assert.ok(ref.length <= ADYEN_REFERENCE_MAX);
  // adyen-modify prefixes 'mod:' — the whole key must fit in 64.
  assert.ok(`mod:${ref}`.length <= 64);
});

test('a very long leg id is truncated but the key is still deterministic', () => {
  const long = 'x'.repeat(200);
  const a = refundReference('ref-1', long);
  const b = refundReference('ref-1', long);
  assert.equal(a, b);
  assert.ok(`mod:${a}`.length <= 64);
});

test('different refunds of the same leg get DIFFERENT keys', () => {
  // Two genuine partial refunds of one card must not collapse into one at Adyen,
  // which replays the first response for a reused key.
  assert.notEqual(refundReference('ref-1', 'psp1'), refundReference('ref-2', 'psp1'));
});

test('toMinor rounds once, at the boundary', () => {
  assert.equal(toMinor(51), 5100);
  assert.equal(toMinor(0), 0);
  assert.equal(toMinor(2.25), 225);
  assert.equal(toMinor(1.88), 188);
  // Same implementation as terminalJobs.toMinor, float quirks and all: 1.005
  // is really 1.00499999… in IEEE754, so it floors to 100. Documented rather
  // than "fixed" so the two converters cannot drift apart — a payments path
  // with two different opinions about a penny is worse than a known one.
  assert.equal(toMinor(1.005), 100);
});

test('a full refund of a part-gift-paid check does not ask the card for the gift share', () => {
  // £51 bill, £30 paid by gift card, £21 on the card. The card leg records what
  // it actually captured, so the reversal is capped there and the gift portion
  // is left to the gift-reversal path that owns it.
  const c = { ...check(), paymentIntents: [{ id: 'psp1', amountMinor: 2100 }] };
  const bd = refundBreakdown(c, { isFullRefund: true });
  assert.equal(bd.amount, 51);
  const { allocations, unallocatedMinor } = allocateToLegs(cardLegsOf(c), toMinor(bd.amount));
  assert.equal(allocations[0].refundMinor, 2100);
  assert.equal(unallocatedMinor, 3000);
});
