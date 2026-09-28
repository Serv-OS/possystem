// src/lib/paymentBusy.test.js (v5.11.1): the payment busy flag that holds a release back.
//
// UpdateGuard claimed to pause "while a payment/checkout is in progress (window.__RPOS_BUSY)",
// and nothing ever set that flag. Leeds POS 1, 27 Sep 2026: check minted 13:11:44 UTC, card
// machine job sent 13:11:47, then the page reloaded under it. These tests pin the rule the
// guard now reads: counted holds (never one boolean), a quiet period after the last one, and a
// countdown that pauses instead of running down.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_QUIET_MS,
  holdPaymentBusy,
  withPaymentBusy,
  isPaymentBusy,
  paymentBusyCount,
  paymentBusyReasons,
  updateMayApply,
  updateCountdownStep,
  canApplyUpdate,
  subscribePaymentBusy,
  _resetPaymentBusyForTests,
} from './paymentBusy.js';

let now = 0;
const fresh = (start = 1_000_000) => {
  now = start;
  _resetPaymentBusyForTests({ now: () => now });
};

test('nothing holds on a fresh page, and an update may apply', () => {
  fresh();
  assert.equal(isPaymentBusy(), false);
  assert.equal(paymentBusyCount(), 0);
  assert.deepEqual(paymentBusyReasons(), []);
  assert.equal(canApplyUpdate(now), true);
});

test('a hold makes the device busy until it is released', () => {
  fresh();
  const release = holdPaymentBusy('checkout');
  assert.equal(isPaymentBusy(), true);
  assert.equal(canApplyUpdate(now), false);
  release();
  assert.equal(isPaymentBusy(), false);
});

test('two overlapping flows cannot clear each other (holds are counted, not a boolean)', () => {
  fresh();
  const checkout = holdPaymentBusy('checkout');
  const job = holdPaymentBusy('card machine job live');
  assert.equal(paymentBusyCount(), 2);
  checkout();                                   // the checkout closes first...
  assert.equal(isPaymentBusy(), true, '...the live job still holds');
  job();
  assert.equal(isPaymentBusy(), false);
});

test('releasing the same hold twice does not release anyone else (a bare counter would)', () => {
  fresh();
  const a = holdPaymentBusy('split bill');
  const b = holdPaymentBusy('split card leg');
  a();
  a();                                          // a cleanup that runs twice (StrictMode, a retry)
  assert.equal(paymentBusyCount(), 1, 'b is still held');
  assert.deepEqual(paymentBusyReasons(), ['split card leg']);
  b();
  b();
  assert.equal(paymentBusyCount(), 0, 'never below zero');
});

test('reasons are listed oldest first', () => {
  fresh();
  const r1 = holdPaymentBusy('checkout');
  now += 5;
  const r2 = holdPaymentBusy('card machine job send');
  now += 5;
  const r3 = holdPaymentBusy('card machine screen');
  assert.deepEqual(paymentBusyReasons(), ['checkout', 'card machine job send', 'card machine screen']);
  r2();
  assert.deepEqual(paymentBusyReasons(), ['checkout', 'card machine screen']);
  r1(); r3();
});

test('an update waits PAYMENT_QUIET_MS after the last hold ends, so the sale writes land', () => {
  fresh();
  const release = holdPaymentBusy('checkout');
  now += 40_000;
  release();
  assert.equal(canApplyUpdate(now), false, 'just released');
  assert.equal(canApplyUpdate(now + PAYMENT_QUIET_MS - 1), false, 'still inside the quiet period');
  assert.equal(canApplyUpdate(now + PAYMENT_QUIET_MS), true, 'quiet period over');
  assert.equal(PAYMENT_QUIET_MS, 15_000);
});

test('updateMayApply: the rule on its own', () => {
  const t = 5_000_000;
  assert.equal(updateMayApply({ holdCount: 0, lastReleasedAt: 0, now: t }), true, 'never held');
  assert.equal(updateMayApply({ holdCount: 1, lastReleasedAt: 0, now: t }), false, 'held');
  assert.equal(updateMayApply({ holdCount: 3, lastReleasedAt: t - 999_999, now: t }), false, 'held, however old the last release');
  assert.equal(updateMayApply({ holdCount: 0, lastReleasedAt: t - 14_999, now: t }), false, 'inside quiet');
  assert.equal(updateMayApply({ holdCount: 0, lastReleasedAt: t - 15_000, now: t }), true, 'quiet over');
  assert.equal(updateMayApply({ holdCount: 0, lastReleasedAt: t - 10, now: t, quietMs: 5 }), true, 'custom quiet');
});

test('the Leeds 27 Sep timeline: no moment between checkout open and 15 s after close lets the update in', () => {
  fresh(Date.parse('2026-09-27T13:11:40Z'));
  const tick = (ms) => { now += ms; return canApplyUpdate(now); };
  const checkout = holdPaymentBusy('checkout');           // 13:11:40 staff press Pay
  assert.equal(tick(4_000), false, '13:11:44 check id minted');
  const send = holdPaymentBusy('card machine job send');  // 13:11:47 job sent
  assert.equal(tick(3_000), false, '13:11:47 dispatch in flight (the reload landed here)');
  const watch = holdPaymentBusy('card machine job live');
  send();
  assert.equal(tick(1_000), false, 'send answered, the watch holds');
  assert.equal(tick(40_000), false, 'customer tapping, tipping');
  watch();                                                // approved
  assert.equal(tick(350), false, 'settle handoff');
  checkout();                                             // modal closes, check is booked
  assert.equal(tick(1_000), false, 'closed check write in flight');
  assert.equal(tick(PAYMENT_QUIET_MS), true, 'quiet: now the release may reload the till');
});

test('withPaymentBusy holds for the whole call and releases on resolve', async () => {
  fresh();
  let seen = null;
  const out = await withPaymentBusy('card machine job send', async () => {
    seen = paymentBusyReasons();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(isPaymentBusy(), true, 'still held across an await');
    return { job: { id: 'j1' } };
  });
  assert.deepEqual(seen, ['card machine job send']);
  assert.deepEqual(out, { job: { id: 'j1' } }, 'the result passes through');
  assert.equal(isPaymentBusy(), false);
});

test('withPaymentBusy releases when the call throws, and the error still reaches the caller', async () => {
  fresh();
  await assert.rejects(
    withPaymentBusy('card machine job send', async () => { throw new Error('no terminal to send to'); }),
    /no terminal to send to/,
  );
  assert.equal(isPaymentBusy(), false);
});

test('withPaymentBusy releases when a watch is aborted (a screen unmounting)', async () => {
  fresh();
  const ac = new AbortController();
  const watch = withPaymentBusy('card machine job live', () => new Promise((_, reject) => {
    ac.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  assert.equal(isPaymentBusy(), true);
  ac.abort();
  await assert.rejects(watch, { name: 'AbortError' });
  assert.equal(isPaymentBusy(), false);
});

test('withPaymentBusy releases when fn throws before returning a promise', async () => {
  fresh();
  await assert.rejects(withPaymentBusy('x', () => { throw new Error('sync'); }), /sync/);
  assert.equal(isPaymentBusy(), false);
});

test('subscribers hear every change; a throwing subscriber never breaks a hold', () => {
  fresh();
  const heard = [];
  const off = subscribePaymentBusy((n) => heard.push(n));
  subscribePaymentBusy(() => { throw new Error('listener bug'); });
  const a = holdPaymentBusy('a');
  const b = holdPaymentBusy('b');
  a(); b();
  assert.deepEqual(heard, [1, 2, 1, 0]);
  off();
  holdPaymentBusy('c')();
  assert.deepEqual(heard, [1, 2, 1, 0], 'unsubscribed');
});

test('window.__RPOS_BUSY mirrors the number of live holds (it used to be read, never written)', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prior = globalThis.window;
  globalThis.window = {};
  try {
    fresh();
    assert.equal(globalThis.window.__RPOS_BUSY, 0);
    const a = holdPaymentBusy('checkout');
    const b = holdPaymentBusy('card machine job live');
    assert.equal(globalThis.window.__RPOS_BUSY, 2);
    a();
    assert.equal(globalThis.window.__RPOS_BUSY, 1);
    b();
    assert.equal(globalThis.window.__RPOS_BUSY, 0);
  } finally {
    if (had) globalThis.window = prior; else delete globalThis.window;
  }
});

test('countdown: counts down while quiet and applies at zero', () => {
  let s = { left: 3 };
  s = updateCountdownStep({ left: s.left, mayApply: true });
  assert.deepEqual(s, { left: 2, waiting: false, apply: false });
  s = updateCountdownStep({ left: s.left, mayApply: true });
  s = updateCountdownStep({ left: s.left, mayApply: true });
  assert.deepEqual(s, { left: 0, waiting: false, apply: true });
});

test('countdown: PAUSES while a payment holds (never runs down, never re-arms)', () => {
  let left = 2;
  for (let i = 0; i < 300; i++) {                         // five minutes of card payment
    const s = updateCountdownStep({ left, mayApply: false });
    assert.equal(s.apply, false);
    assert.equal(s.waiting, true);
    left = s.left;
  }
  assert.equal(left, 2, 'resumes where it was');
  const s = updateCountdownStep({ left, mayApply: true });
  assert.deepEqual(s, { left: 1, waiting: false, apply: false });
});

test('countdown: Update now goes straight to zero, but still waits for a quiet till', () => {
  assert.deepEqual(updateCountdownStep({ left: 80, mayApply: false, nowRequested: true }),
    { left: 80, waiting: true, apply: false }, 'refused while busy or just paid');
  assert.deepEqual(updateCountdownStep({ left: 80, mayApply: true, nowRequested: true }),
    { left: 0, waiting: false, apply: true });
});

test('countdown: a paused zero applies the moment the till is quiet (and not before)', () => {
  assert.deepEqual(updateCountdownStep({ left: 0, mayApply: false }), { left: 0, waiting: true, apply: false });
  assert.deepEqual(updateCountdownStep({ left: 0, mayApply: true }), { left: 0, waiting: false, apply: true });
});
