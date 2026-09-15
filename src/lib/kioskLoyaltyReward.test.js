// Kiosk points rewards took 0p off and still spent the points (14 Sep 2026, finding F4).
// loyalty-otp verify left reward_value out of rewards_available, so the kiosk staged a 0p
// discount and submitOrder committed the redemption anyway. These tests pin the money:
// fixed, percent and free item each take the right amount off, exactly once, and a reward
// that takes nothing off is never committed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  kioskRewardDiscountMinor,
  kioskRewardMissingItems,
  kioskLoyaltyCreditMinor,
  kioskRewardTapCheck,
} from './kioskLoyaltyReward.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');

// ── Basket (kiosk cart lines: major units, l.item = menu row) ────────────────
// 2 × Latte £3.50 + 1 × Croissant £2.80 = £9.80. UK inclusive VAT (no added tax), no tip.
const LATTE = { id: 'm-latte', name: 'Latte' };
const CROISSANT = { id: 'm-croissant', name: 'Croissant' };
const CART = [
  { key: 'a', item: LATTE, qty: 2, linePrice: 3.5, lineTotal: 7 },
  { key: 'b', item: CROISSANT, qty: 1, linePrice: 2.8, lineTotal: 2.8 },
];
const GOODS = 980;

// The verify payload as loyalty-otp sends it NOW, mapped exactly like ScreenLoyalty does.
const VERIFY = {
  loyalty: {
    rewards_available: [
      { id: 'r-fixed', name: '£2 off', points_cost: 150, reward_type: 'discount_fixed', reward_value: { amount_minor: 200 } },
      { id: 'r-pct', name: '10% off', points_cost: 300, reward_type: 'discount_percent', reward_value: { percent: 10 } },
      { id: 'r-free', name: 'Free croissant', points_cost: 250, reward_type: 'free_item', reward_value: { eligible_items: [{ id: 'm-croissant', name: 'Croissant' }] } },
    ],
  },
};
const kioskRewards = (data) => (data.loyalty?.rewards_available || []).map(r => ({
  id: r.id, label: r.name, pointsCost: r.points_cost, type: r.reward_type, value: r.reward_value,
}));

// Mirror of KioskApp's money lines (major units) so "exactly once" is checked on the total.
function kioskTotals({ cart = CART, goodsMinor = GOODS, tip = 0, redemption, giftMinor = 0, promo = 0 }) {
  const total = goodsMinor / 100 + tip;
  const loyaltyMinor = kioskLoyaltyCreditMinor(redemption, { cart, goodsMinor, dueMinor: Math.round(total * 100), giftMinor });
  const loyaltyCredit = loyaltyMinor / 100;
  const giftCardCredit = giftMinor / 100;
  const promoCredit = Math.min(promo, Math.max(0, total - loyaltyCredit - giftCardCredit));
  const grandTotal = Math.max(0, total - loyaltyCredit - giftCardCredit - promoCredit);
  return { loyaltyMinor, grandTotalMinor: Math.round(grandTotal * 100), commits: loyaltyMinor > 0 };
}
const stage = (reward) => ({ reward_id: reward.id, reward_type: reward.type, reward_value: reward.value, pending_commit: true });

test('BEFORE the fix: a payload without reward_value gives 0p off (the reported bug)', () => {
  const old = { loyalty: { rewards_available: VERIFY.loyalty.rewards_available.map(r => { const o = { ...r }; delete o.reward_value; return o; }) } };
  for (const r of kioskRewards(old)) {
    assert.equal(kioskRewardDiscountMinor(r.type, r.value, { cart: CART, goodsMinor: GOODS }), 0, r.id);
  }
});

test('fixed reward: £2.00 off £9.80, card charged £7.80, committed once', () => {
  const r = kioskRewards(VERIFY)[0];
  assert.equal(kioskRewardDiscountMinor(r.type, r.value, { cart: CART, goodsMinor: GOODS }), 200);
  const t = kioskTotals({ redemption: stage(r) });
  assert.deepEqual(t, { loyaltyMinor: 200, grandTotalMinor: 780, commits: true });
});

test('percent reward: 10% of £9.80 = 98p off, card charged £8.82', () => {
  const r = kioskRewards(VERIFY)[1];
  assert.equal(kioskRewardDiscountMinor(r.type, r.value, { cart: CART, goodsMinor: GOODS }), 98);
  assert.deepEqual(kioskTotals({ redemption: stage(r) }), { loyaltyMinor: 98, grandTotalMinor: 882, commits: true });
});

test('percent rounds to the nearest penny, on goods after auto-discounts, never the tip', () => {
  // £12.35 × 15% = 185.25p → 185p. A £1.00 tip does not grow the discount.
  assert.equal(kioskRewardDiscountMinor('discount_percent', { percent: 15 }, { goodsMinor: 1235 }), 185);
  const t = kioskTotals({ goodsMinor: 1235, tip: 1, redemption: { reward_type: 'discount_percent', reward_value: { percent: 15 } } });
  assert.deepEqual(t, { loyaltyMinor: 185, grandTotalMinor: 1235 + 100 - 185, commits: true });
});

test('free item reward: the croissant (£2.80) comes off, one unit, card charged £7.00', () => {
  const r = kioskRewards(VERIFY)[2];
  assert.equal(kioskRewardMissingItems(r.type, r.value, CART), null);
  assert.equal(kioskRewardDiscountMinor(r.type, r.value, { cart: CART, goodsMinor: GOODS }), 280);
  assert.deepEqual(kioskTotals({ redemption: stage(r) }), { loyaltyMinor: 280, grandTotalMinor: 700, commits: true });
});

test('free item: cheapest eligible line, ONE unit even when qty > 1, sizes match too', () => {
  const value = { eligible_items: [{ id: 'm-latte' }, { id: 'm-large' }] };
  const cart = [
    { item: LATTE, qty: 3, linePrice: 3.5 },
    { item: LATTE, variant: { id: 'm-large' }, qty: 1, linePrice: 4.2 },
  ];
  assert.equal(kioskRewardDiscountMinor('free_item', value, { cart, goodsMinor: 1470 }), 350);
  const sizeOnly = [{ item: { id: 'parent' }, variant: { id: 'm-large' }, qty: 1, linePrice: 4.2 }];
  assert.equal(kioskRewardDiscountMinor('free_item', value, { cart: sizeOnly, goodsMinor: 420 }), 420);
});

test('free item not in the basket: apply is refused with the item names, and 0p', () => {
  const r = kioskRewards(VERIFY)[2];
  const cart = [CART[0]];
  assert.equal(kioskRewardMissingItems(r.type, r.value, cart), 'Croissant');
  assert.equal(kioskRewardDiscountMinor(r.type, r.value, { cart, goodsMinor: 700 }), 0);
});

test('nothing double counted: the reward comes off the total once, promo only fills what is left', () => {
  const r = kioskRewards(VERIFY)[0];
  // £9.80, £2 reward, £10 promo: promo is capped at £7.80, grand total 0, reward still 200.
  const t = kioskTotals({ redemption: stage(r), promo: 10 });
  assert.equal(t.loyaltyMinor, 200);
  assert.equal(t.grandTotalMinor, 0);
});

test('never more than the goods: £20 fixed reward on a £9.80 basket takes £9.80', () => {
  assert.equal(kioskRewardDiscountMinor('discount_fixed', { amount_minor: 2000 }, { cart: CART, goodsMinor: GOODS }), 980);
  assert.equal(kioskRewardDiscountMinor('discount_percent', { percent: 250 }, { goodsMinor: GOODS }), 980);
});

test('gift card already covering the order: a reward tapped after it takes 0p and is NOT committed', () => {
  const r = kioskRewards(VERIFY)[0];
  const t = kioskTotals({ redemption: stage(r), giftMinor: 980 });
  assert.deepEqual(t, { loyaltyMinor: 0, grandTotalMinor: 0, commits: false });
  // The live figure is still capped as a backstop (gift + reward never exceed the total), but
  // the kiosk no longer lets a guest reach this state: the tap is refused (next test).
  const part = kioskTotals({ redemption: stage(r), giftMinor: 900 });
  assert.deepEqual(part, { loyaltyMinor: 80, grandTotalMinor: 0, commits: true });
});

test('tap with a gift card staged: refused when the gift would cut the reward down, so no points are spent for part of it', () => {
  const [fixed, pct, free] = kioskRewards(VERIFY);
  const ctx = { cart: CART, goodsMinor: GOODS, dueMinor: 980 };
  const GIFT_MSG = 'Remove the gift card first to use your reward.';
  // (A) £9.00 gift on £9.80: £2 reward would only get 80p. Refused, nothing staged.
  assert.deepEqual(kioskRewardTapCheck(fixed.type, fixed.value, { ...ctx, giftMinor: 900 }), { discountMinor: 0, error: GIFT_MSG });
  assert.deepEqual(kioskRewardTapCheck(free.type, free.value, { ...ctx, giftMinor: 900 }), { discountMinor: 0, error: GIFT_MSG });
  // (B) gift already covers the whole order: refused with the message, not silently staged.
  assert.deepEqual(kioskRewardTapCheck(pct.type, pct.value, { ...ctx, giftMinor: 980 }), { discountMinor: 0, error: GIFT_MSG });
  // Gift leaves enough room for the full reward: accepted at full value, and the live credit matches.
  // (Reward staged first at £2, gift then applied to the £7.80 left, guest comes back and re-taps.)
  assert.deepEqual(kioskRewardTapCheck(fixed.type, fixed.value, { ...ctx, giftMinor: 780 }), { discountMinor: 200, error: null });
  const t = kioskTotals({ redemption: stage(fixed), giftMinor: 780 });
  assert.deepEqual(t, { loyaltyMinor: 200, grandTotalMinor: 0, commits: true });
  // Tip in the due amount gives room too: £1 tip, £9.00 gift, due £10.80, £1.80 left ≥ 98p.
  assert.deepEqual(kioskRewardTapCheck(pct.type, pct.value, { ...ctx, dueMinor: 1080, giftMinor: 900 }), { discountMinor: 98, error: null });
});

test('tap with no gift card: fixed, percent and free item accepted at the same figure the order is charged', () => {
  const ctx = { cart: CART, goodsMinor: GOODS, dueMinor: 980 };
  const want = { 'r-fixed': 200, 'r-pct': 98, 'r-free': 280 };
  for (const r of kioskRewards(VERIFY)) {
    const tap = kioskRewardTapCheck(r.type, r.value, ctx);
    assert.deepEqual(tap, { discountMinor: want[r.id], error: null }, r.id);
    assert.equal(kioskTotals({ redemption: stage(r) }).loyaltyMinor, tap.discountMinor, r.id);
  }
  // Refusals keep their messages.
  assert.match(kioskRewardTapCheck('free_item', kioskRewards(VERIFY)[2].value, { ...ctx, cart: [CART[0]], goodsMinor: 700 }).error, /Add Croissant/);
  assert.equal(kioskRewardTapCheck('discount_fixed', { amount_minor: 200 }, { cart: [], goodsMinor: 0, dueMinor: 0 }).error, 'Add items to your order first, then use your reward.');
  assert.equal(kioskRewardTapCheck('custom', {}, ctx).error, 'This reward cannot be used on the kiosk. Please ask a member of staff.');
  // Over the goods is still accepted, capped at the goods (no gift involved).
  assert.deepEqual(kioskRewardTapCheck('discount_fixed', { amount_minor: 2000 }, ctx), { discountMinor: 980, error: null });
});

test('basket changed after the tap: the credit follows the live basket', () => {
  const pct = stage(kioskRewards(VERIFY)[1]);
  const free = stage(kioskRewards(VERIFY)[2]);
  const smaller = [CART[1]]; // lattes removed, £2.80 left
  assert.equal(kioskTotals({ cart: smaller, goodsMinor: 280, redemption: pct }).loyaltyMinor, 28);
  const noCroissant = [CART[0]]; // croissant removed: free item gives nothing, not committed
  assert.deepEqual(kioskTotals({ cart: noCroissant, goodsMinor: 700, redemption: free }), { loyaltyMinor: 0, grandTotalMinor: 700, commits: false });
});

test('rewards with no kiosk money off are 0p (so never committed)', () => {
  const opts = { cart: CART, goodsMinor: GOODS };
  assert.equal(kioskRewardDiscountMinor('free_delivery', {}, opts), 0);
  assert.equal(kioskRewardDiscountMinor('custom', {}, opts), 0);
  assert.equal(kioskRewardDiscountMinor('free_item', {}, opts), 0);
  assert.equal(kioskRewardDiscountMinor('discount_fixed', { amount_minor: 200 }, { cart: [], goodsMinor: 0 }), 0);
  assert.equal(kioskLoyaltyCreditMinor(null, opts), 0);
});

test('loyalty-otp verify sends reward_value on rewards_available', () => {
  const src = read('supabase/functions/loyalty-otp/index.ts');
  const block = src.slice(src.indexOf('rewards_available: rewards.map('), src.indexOf('stamp_rewards: stampRewardsVerify'));
  assert.match(block, /reward_value: r\.reward_value/);
});

test('KioskApp commits and records the loyalty reward only when the live credit is above 0', () => {
  const src = read('src/surfaces/KioskApp.jsx');
  assert.match(src, /const loyaltyDiscountMinor = kioskLoyaltyCreditMinor\(loyaltyRedemption,/);
  assert.match(src, /const loyaltyCredit = loyaltyDiscountMinor \/ 100;/);
  assert.match(src, /if \(loyaltyDiscountMinor > 0 && loyaltyRedemption\?\.pending_commit/);
  assert.match(src, /loyalty: \(loyaltyRedemption && loyaltyDiscountMinor > 0\)/);
  assert.match(src, /discount_value: loyaltyDiscountMinor,/);
  // The tap uses the same gift cap as the live credit.
  assert.match(src, /dueMinor=\{Math\.round\(total \* 100\)\} giftMinor=\{giftCardPayment\?\.applied \|\| 0\}/);
  assert.match(src, /kioskRewardTapCheck\(reward\.type, rv, \{ cart, goodsMinor, dueMinor, giftMinor \}\)/);
  // The frozen tap-time figure is no longer what the order is charged on.
  assert.doesNotMatch(src, /loyaltyCredit = loyaltyRedemption\?\.discount_value/);
});
