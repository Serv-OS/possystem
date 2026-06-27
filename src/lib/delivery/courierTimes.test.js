/**
 * courierTimes.test.js — courier time-flow truth helpers.
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { courierPhase, courierLegs, courierLateness } from './courierTimes.js';

const T = (min) => new Date(Date.now() + min * 60000).toISOString();

test('phase derives from columns, not just status', () => {
  assert.equal(courierPhase(null), 'none');
  assert.equal(courierPhase({ status: 'pending' }), 'awaiting_courier');
  assert.equal(courierPhase({ status: 'pending', eta: T(20) }), 'assigned');
  assert.equal(courierPhase({ status: 'pickup', picked_at: T(-2) }), 'collected');
  assert.equal(courierPhase({ status: 'delivered', delivered_at: T(-1) }), 'done');
  assert.equal(courierPhase({ status: 'failed' }), 'terminal_bad');
  assert.equal(courierPhase({ status: 'canceled' }), 'terminal_bad');
});

test('legs: pending → expected (eta) → actual (picked/delivered)', () => {
  const awaiting = courierLegs({ status: 'pending' });
  assert.equal(awaiting.pickup.kind, 'pending');
  assert.equal(awaiting.dropoff.kind, 'pending');

  const assigned = courierLegs({ pickup_eta: T(10), eta: T(35) });
  assert.equal(assigned.pickup.kind, 'expected');
  assert.equal(assigned.dropoff.kind, 'expected');

  const done = courierLegs({ pickup_eta: T(10), picked_at: T(-5), eta: T(35), delivered_at: T(-1) });
  assert.equal(done.pickup.kind, 'actual');
  assert.equal(done.dropoff.kind, 'actual');
});

test('legs accept camelCase (track_order shape)', () => {
  const l = courierLegs({ pickupEta: T(10), eta: T(35), pickedAt: T(-2) });
  assert.equal(l.pickup.kind, 'actual');     // pickedAt present
  assert.equal(l.dropoff.kind, 'expected');  // eta only
});

test('lateness: unknown without eta; clamped >= 0; grace; uses delivered_at when done', () => {
  assert.equal(courierLateness({ status: 'pending' }).known, false);
  // early courier (eta in the future) → on time, 0 late
  const early = courierLateness({ eta: T(20) });
  assert.equal(early.known, true); assert.equal(early.lateMins, 0); assert.equal(early.onTime, true);
  // overdue by 12 min, not delivered → 12 late, not on time
  const late = courierLateness({ eta: T(-12) });
  assert.equal(late.lateMins, 12); assert.equal(late.onTime, false);
  // delivered 2 min after eta → within grace, on time
  const okDelivered = courierLateness({ eta: T(-10), delivered_at: T(-8) });
  assert.equal(okDelivered.delivered, true); assert.equal(okDelivered.lateMins, 2); assert.equal(okDelivered.onTime, true);
  // delivered 20 min after eta → late
  const lateDelivered = courierLateness({ eta: T(-30), delivered_at: T(-10) });
  assert.equal(lateDelivered.lateMins, 20); assert.equal(lateDelivered.onTime, false);
});
