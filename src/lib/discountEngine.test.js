/**
 * discountEngine.test.js — auto-discount evaluation: BOGO, bundles, scheduling,
 * expiry, channel targeting, and stacking (no double-dip).
 * Run: `npm test` (Node's built-in runner — no third-party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAutoDiscounts, isRuleActiveNow } from './discountEngine.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── helpers ───────────────────────────────────────────────────────────────────
const pizza = (uid, price) => ({ uid, itemId: 'pizza', name: 'Pizza', cat: 'pizza', price, qty: 1 });
const BOGO = {
  id: 'r-bogo', name: 'Buy 2 Pizzas get 1 20% off', active: true,
  triggerType: 'buy_x', triggerCategoryIds: ['pizza'], triggerQty: 2, rewardQty: 1,
  rewardType: 'percent', rewardValue: 20, channels: { pos: true, online: true, qr: true, kiosk: true },
};
const LUNCH = {
  id: 'r-lunch', name: 'Lunch Deal', active: true,
  triggerType: 'bundle', rewardType: 'fixed_price', rewardValue: 8.99,
  triggerGroups: [
    { categoryIds: ['chk'], qty: 1 },
    { categoryIds: ['drk'], qty: 1 },
    { categoryIds: ['sid'], qty: 1 },
  ],
  channels: { pos: true, online: true, qr: true, kiosk: true },
};

// ── isRuleActiveNow: schedule + expiry ──────────────────────────────────────────
test('isRuleActiveNow: no schedule → always on (back-compat)', () => {
  assert.equal(isRuleActiveNow({ schedule: null }, { nowMinutes: 0, isoDay: 3, ymd: '2026-06-24' }), true);
  assert.equal(isRuleActiveNow({}, { nowMinutes: 0, isoDay: 3, ymd: '2026-06-24' }), true);
});

test('isRuleActiveNow: day-of-week gate', () => {
  const r = { schedule: { days: [1, 2, 3, 4, 5] } }; // weekdays only
  assert.equal(isRuleActiveNow(r, { isoDay: 1, nowMinutes: 600, ymd: '2026-06-22' }), true);  // Mon
  assert.equal(isRuleActiveNow(r, { isoDay: 6, nowMinutes: 600, ymd: '2026-06-27' }), false); // Sat
});

test('isRuleActiveNow: time window inclusive-start, exclusive-end', () => {
  const r = { schedule: { windows: [{ start: '11:00', end: '15:00' }] } };
  assert.equal(isRuleActiveNow(r, { nowMinutes: 11 * 60, isoDay: 1, ymd: '2026-06-22' }), true);   // 11:00 in
  assert.equal(isRuleActiveNow(r, { nowMinutes: 12 * 60, isoDay: 1, ymd: '2026-06-22' }), true);   // 12:00 in
  assert.equal(isRuleActiveNow(r, { nowMinutes: 15 * 60, isoDay: 1, ymd: '2026-06-22' }), false);  // 15:00 out (exclusive)
  assert.equal(isRuleActiveNow(r, { nowMinutes: 10 * 60 + 59, isoDay: 1, ymd: '2026-06-22' }), false);
});

test('isRuleActiveNow: window crossing midnight', () => {
  const r = { schedule: { windows: [{ start: '22:00', end: '02:00' }] } };
  assert.equal(isRuleActiveNow(r, { nowMinutes: 23 * 60 + 30, isoDay: 1, ymd: '2026-06-22' }), true); // 23:30
  assert.equal(isRuleActiveNow(r, { nowMinutes: 60, isoDay: 1, ymd: '2026-06-22' }), true);            // 01:00
  assert.equal(isRuleActiveNow(r, { nowMinutes: 12 * 60, isoDay: 1, ymd: '2026-06-22' }), false);      // 12:00
});

test('isRuleActiveNow: expiry + start date (inclusive)', () => {
  const r = { schedule: { startsAt: '2026-07-01', expiresAt: '2026-09-30' } };
  assert.equal(isRuleActiveNow(r, { ymd: '2026-06-30', isoDay: 2, nowMinutes: 600 }), false); // before start
  assert.equal(isRuleActiveNow(r, { ymd: '2026-07-01', isoDay: 3, nowMinutes: 600 }), true);  // start day (incl)
  assert.equal(isRuleActiveNow(r, { ymd: '2026-09-30', isoDay: 3, nowMinutes: 600 }), true);  // expiry day (incl)
  assert.equal(isRuleActiveNow(r, { ymd: '2026-10-01', isoDay: 4, nowMinutes: 600 }), false); // after expiry
});

// ── BOGO (buy_x) ────────────────────────────────────────────────────────────────
test('BOGO buy_x: 3 pizzas (10/12/8) → cheapest 1 at 20% = 1.60', () => {
  const items = [pizza('p1', 10), pizza('p2', 12), pizza('p3', 8)];
  const res = evaluateAutoDiscounts(items, [BOGO], 'pos');
  assert.equal(res.length, 1);
  near(res[0].totalSaving, 1.6);
  assert.equal(res[0].appliedItems[0].uid, 'p3'); // the £8 unit
});

test('BOGO buy_x: only 2 pizzas → does NOT fire (needs trigger+reward = 3)', () => {
  const res = evaluateAutoDiscounts([pizza('p1', 10), pizza('p2', 12)], [BOGO], 'pos');
  assert.equal(res.length, 0);
});

// ── Bundle (fixed_price) ─────────────────────────────────────────────────────────
test('Bundle fixed_price: chicken 7 + drink 3 + side 2.5 = 12.5 → 8.99 saves 3.51', () => {
  const items = [
    { uid: 'c1', name: 'Fried Chicken', cat: 'chk', price: 7, qty: 1 },
    { uid: 'd1', name: 'Soft Drink', cat: 'drk', price: 3, qty: 1 },
    { uid: 's1', name: 'Sides', cat: 'sid', price: 2.5, qty: 1 },
  ];
  const res = evaluateAutoDiscounts(items, [LUNCH], 'pos');
  assert.equal(res.length, 1);
  assert.equal(res[0].rewardType, 'fixed_price');
  near(res[0].totalSaving, 3.51);
  // savings distributed across the 3 components, summing to the total
  near(res[0].appliedItems.reduce((s, a) => s + a.saving, 0), 3.51, 0.011);
});

test('Bundle: incomplete (no side) → does not fire', () => {
  const items = [
    { uid: 'c1', name: 'Fried Chicken', cat: 'chk', price: 7, qty: 1 },
    { uid: 'd1', name: 'Soft Drink', cat: 'drk', price: 3, qty: 1 },
  ];
  assert.equal(evaluateAutoDiscounts(items, [LUNCH], 'pos').length, 0);
});

// ── scheduling integrated into evaluate ─────────────────────────────────────────
test('evaluate: rule out of its time window does not fire even when trigger met', () => {
  const lunchtimeBogo = { ...BOGO, schedule: { windows: [{ start: '11:00', end: '15:00' }] } };
  const items = [pizza('p1', 10), pizza('p2', 12), pizza('p3', 8)];
  const ctxOut = { nowMinutes: 18 * 60, isoDay: 1, ymd: '2026-06-22' }; // 18:00
  const ctxIn = { nowMinutes: 12 * 60, isoDay: 1, ymd: '2026-06-22' };  // 12:00
  assert.equal(evaluateAutoDiscounts(items, [lunchtimeBogo], 'pos', ctxOut).length, 0);
  assert.equal(evaluateAutoDiscounts(items, [lunchtimeBogo], 'pos', ctxIn).length, 1);
});

test('evaluate: expired rule does not fire', () => {
  const expired = { ...BOGO, schedule: { expiresAt: '2026-06-01' } };
  const items = [pizza('p1', 10), pizza('p2', 12), pizza('p3', 8)];
  assert.equal(evaluateAutoDiscounts(items, [expired], 'pos', { ymd: '2026-06-24', isoDay: 3, nowMinutes: 720 }).length, 0);
});

// ── channel targeting ───────────────────────────────────────────────────────────
test('channel filter: kiosk-disabled rule skipped on kiosk, applied on pos', () => {
  const posOnly = { ...BOGO, channels: { pos: true, online: true, qr: true, kiosk: false } };
  const items = [pizza('p1', 10), pizza('p2', 12), pizza('p3', 8)];
  assert.equal(evaluateAutoDiscounts(items, [posOnly], 'kiosk').length, 0);
  assert.equal(evaluateAutoDiscounts(items, [posOnly], 'pos').length, 1);
});

// ── stacking: no double-dip ─────────────────────────────────────────────────────
test('stacking: two identical rules + 3 pizzas → only the first fires (units consumed)', () => {
  const ruleA = { ...BOGO, id: 'A', priority: 10 };
  const ruleB = { ...BOGO, id: 'B', priority: 5 };
  const items = [pizza('p1', 10), pizza('p2', 12), pizza('p3', 8)];
  const res = evaluateAutoDiscounts(items, [ruleA, ruleB], 'pos');
  assert.equal(res.length, 1);
  assert.equal(res[0].ruleId, 'A'); // higher-priority (first in array) claims the units
});

test('stacking: higher-priority rule fires as many times as it can, consuming its units', () => {
  // 6 pizzas, two identical BOGOs: rule A fires twice (floor(6/3)=2) and consumes all 6;
  // rule B then has nothing left. One result, two reward units.
  const items = [1, 2, 3, 4, 5, 6].map(n => pizza('p' + n, 10));
  const res = evaluateAutoDiscounts(items, [{ ...BOGO, id: 'A' }, { ...BOGO, id: 'B' }], 'pos');
  assert.equal(res.length, 1);
  assert.equal(res[0].ruleId, 'A');
  assert.equal(res[0].appliedItems.length, 2); // fired twice
});

test('stacking: two DIFFERENT rules both apply on distinct items (BOGO + bundle)', () => {
  const items = [
    pizza('p1', 10), pizza('p2', 12), pizza('p3', 8),      // → BOGO saves 1.60
    { uid: 'c1', name: 'Fried Chicken', cat: 'chk', price: 7, qty: 1 },
    { uid: 'd1', name: 'Soft Drink', cat: 'drk', price: 3, qty: 1 },
    { uid: 's1', name: 'Sides', cat: 'sid', price: 2.5, qty: 1 }, // → Lunch saves 3.51
  ];
  const res = evaluateAutoDiscounts(items, [BOGO, LUNCH], 'pos');
  assert.equal(res.length, 2);
  near(res.reduce((s, r) => s + r.totalSaving, 0), 1.6 + 3.51, 0.011);
});

test('manual item discount wins: a line carrying item.discount is excluded from auto', () => {
  const items = [
    pizza('p1', 10),
    pizza('p2', 12),
    { ...pizza('p3', 8), discount: { type: 'percent', value: 50 } }, // manual on the cheapest
  ];
  // only 2 auto-available pizzas now → BOGO (needs 3) cannot fire
  assert.equal(evaluateAutoDiscounts(items, [BOGO], 'pos').length, 0);
});

test('voided items are ignored', () => {
  const items = [pizza('p1', 10), pizza('p2', 12), { ...pizza('p3', 8), voided: true }];
  assert.equal(evaluateAutoDiscounts(items, [BOGO], 'pos').length, 0);
});

// ── Buy X, discount the lot (v5.11.109) ─────────────────────────────────────────
const donut = (uid, price, qty = 1) => ({ uid, itemId: 'donut', name: 'Donut', cat: 'donuts', price, qty });
const SIX15 = {
  id: 'r-six', name: '6 donuts 15% off', active: true,
  triggerType: 'buy_x_all', triggerCategoryIds: ['donuts'], triggerQty: 6, rewardQty: 1,
  rewardType: 'percent', rewardValue: 15, channels: { pos: true, online: true, qr: true, kiosk: true },
};
const sumSaving = (res) => Math.round(res.reduce((s, r) => s + r.totalSaving, 0) * 100) / 100;

test('buy_x_all: 6 donuts at 15% take 15% off all 6', () => {
  const res = evaluateAutoDiscounts([donut('d', 2, 6)], [SIX15], 'pos');
  assert.equal(res.length, 1);
  assert.equal(res[0].appliedItems.length, 6);
  near(res[0].totalSaving, 1.8);
  for (const a of res[0].appliedItems) near(a.saving, 0.3);
  // every channel runs it the same way
  for (const ch of ['kiosk', 'online', 'qr']) near(sumSaving(evaluateAutoDiscounts([donut('d', 2, 6)], [SIX15], ch)), 1.8);
});

test('buy_x_all: 5 donuts is not enough, nothing comes off', () => {
  assert.equal(evaluateAutoDiscounts([donut('d', 2, 5)], [SIX15], 'pos').length, 0);
});

test('buy_x_all: 7 donuts discount the cheapest 6, once', () => {
  const items = [donut('a', 3), donut('b', 2, 5), donut('c', 1)];
  const res = evaluateAutoDiscounts(items, [SIX15], 'pos');
  assert.equal(res.length, 1);
  assert.equal(res[0].appliedItems.length, 6);
  assert.ok(!res[0].appliedItems.some((a) => a.uid === 'a'), 'the dearest donut pays full price');
  near(res[0].totalSaving, Math.round((2 * 5 + 1) * 0.15 * 100) / 100);
});

test('buy_x_all: 12 donuts and two rules, the higher priority rule takes them and a unit is discounted once', () => {
  const DOZEN25 = { ...SIX15, id: 'r-dozen', name: '12 donuts 25% off', triggerQty: 12, rewardValue: 25 };
  const items = [donut('d', 2, 12)];
  const sixFirst = evaluateAutoDiscounts(items, [SIX15, DOZEN25], 'pos');
  assert.deepEqual(sixFirst.map((r) => r.ruleId), ['r-six'], 'the six deal fires twice and uses all 12');
  assert.equal(sixFirst[0].appliedItems.length, 12);
  near(sixFirst[0].totalSaving, 3.6);
  const dozenFirst = evaluateAutoDiscounts(items, [DOZEN25, SIX15], 'pos');
  assert.deepEqual(dozenFirst.map((r) => r.ruleId), ['r-dozen']);
  near(dozenFirst[0].totalSaving, 6);
  // beside a Buy X get Y rule: a unit never takes two deals
  const BOGO_D = { ...SIX15, id: 'r-bogo', triggerType: 'buy_x', triggerQty: 2, rewardQty: 1, rewardType: 'free' };
  const both = evaluateAutoDiscounts([donut('d', 2, 9)], [SIX15, BOGO_D], 'pos');
  assert.deepEqual(both.map((r) => r.ruleId), ['r-six', 'r-bogo']);
  assert.equal(both[0].appliedItems.length, 6);
  assert.equal(both[1].appliedItems.length, 1, 'the 3 left over make one buy 2 get 1 free');
});

test('buy_x_all: mixed categories count together, other items are left alone', () => {
  const rule = { ...SIX15, triggerCategoryIds: ['donuts', 'muffins'], rewardType: 'amount', rewardValue: 0.5 };
  const items = [donut('d', 2, 4), { uid: 'm', name: 'Muffin', cat: 'muffins', price: 3, qty: 2 }, { uid: 'c', name: 'Coffee', cat: 'coffee', price: 3, qty: 1 }];
  const res = evaluateAutoDiscounts(items, [rule], 'pos');
  assert.equal(res.length, 1);
  assert.equal(res[0].appliedItems.length, 6);
  assert.ok(!res[0].appliedItems.some((a) => a.uid === 'c'), 'the coffee is not in the deal');
  near(res[0].totalSaving, 3, 1e-9);
  // a line carried by its other categories (cats) counts too
  const multi = [donut('d', 2, 5), { uid: 'x', name: 'Box', cat: 'boxes', cats: ['boxes', 'muffins'], price: 4, qty: 1 }];
  assert.equal(evaluateAutoDiscounts(multi, [rule], 'pos')[0].appliedItems.length, 6);
});
