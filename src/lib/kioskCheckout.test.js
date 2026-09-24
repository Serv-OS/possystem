import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  giftDueMinor, restageGift, kioskRewardsFromVerify, stageKioskReward, classifyKioskCode,
  kioskGiftLookupResult, kioskPromoResult, applyKioskCode, applyKioskCodeWhileOpen, kioskPayBlock, kioskTotalsRows,
  kioskSubmitArgs, kioskAttributionRecord, kioskSubmitNotice, KIOSK_CARD_MINIMUM, kioskTextAllowed,
} from './kioskCheckout.js';
import { stageGiftCard } from './giftCommit.js';
import { kioskLoyaltyCreditMinor } from './kioskLoyaltyReward.js';

// KioskApp's credit formulas as they are since v5.8.67 (kioskCardPathGuard.test.js fingerprints
// them): the loyalty credit is worked out live from the staged reward's type and value against
// the basket, capped at the goods and at what the staged gift card leaves due.
function credits({ total, discountedSubtotal = total, cart = [], loyaltyRedemption, giftCardPayment, promoApplied }) {
  const loyaltyDiscountMinor = kioskLoyaltyCreditMinor(loyaltyRedemption, {
    cart,
    goodsMinor: Math.round(discountedSubtotal * 100),
    dueMinor: Math.round(total * 100),
    giftMinor: giftCardPayment?.applied || 0,
  });
  const loyaltyCredit = loyaltyDiscountMinor / 100;
  const giftCardCredit = giftCardPayment?.applied ? giftCardPayment.applied / 100 : 0;
  const promoCredit = promoApplied
    ? Math.min(promoApplied.amount || 0, Math.max(0, total - loyaltyCredit - giftCardCredit))
    : 0;
  const grandTotal = Math.max(0, total - loyaltyCredit - giftCardCredit - promoCredit);
  return { loyaltyCredit, giftCardCredit, promoCredit, grandTotal };
}
const stage = (balanceMinor, dueMinor) => stageGiftCard({ cardId: 'c1', code: 'ABCD1234EFGH5678', balanceMinor, amountDueMinor: dueMinor });
// A staged fixed reward in the shape stageKioskReward (and ScreenLoyalty) stage it.
const fixedReward = (amountMinor) => ({ reward_type: 'discount_fixed', reward_value: { amount_minor: amountMinor }, discount_value: amountMinor, pending_commit: true, reward_id: 'r' });

test('gift due agrees with the unchanged credit formulas: enough balance leaves nothing to pay', () => {
  const total = 30; const promoApplied = { amount: 5 }; const loyaltyRedemption = fixedReward(200);
  const due = giftDueMinor({ total, loyaltyCredit: 2, promoAmount: 5 });
  assert.equal(due, 2300);
  const c = credits({ total, loyaltyRedemption, promoApplied, giftCardPayment: stage(5000, due) });
  assert.equal(c.grandTotal, 0);
  assert.equal(c.loyaltyCredit, 2);
  assert.equal(c.promoCredit, 5);
  assert.equal(c.giftCardCredit, 23);
});

test('gift due: a short card leaves total minus reward, balance and promo', () => {
  const total = 30;
  const due = giftDueMinor({ total, loyaltyCredit: 2, promoAmount: 5 });
  const c = credits({ total, loyaltyRedemption: fixedReward(200), promoApplied: { amount: 5 }, giftCardPayment: stage(1000, due) });
  assert.equal(+c.grandTotal.toFixed(2), 13);   // 30 - 2 - 10 - 5
});

test('gift due: a promo bigger than the order leaves 0, so the gift card comes off', () => {
  assert.equal(giftDueMinor({ total: 8, loyaltyCredit: 0, promoAmount: 10 }), 0);
  assert.equal(giftDueMinor({ total: 8, loyaltyCredit: 9 }), 0);
  assert.equal(giftDueMinor({ total: 12.34 }), 1234);
});

test('restaging a gift keeps its idempotency key and card', () => {
  const s = stage(1500, 1000);
  const r = restageGift(s, 1800);
  assert.equal(r.commit_key, s.commit_key);
  assert.equal(r.card_id, 'c1');
  assert.equal(r.code, 'ABCD1234EFGH5678');
  assert.equal(r.balance_at_apply, 1500);
  assert.equal(r.applied, 1500);
  assert.equal(r.remaining_balance, 0);
  const smaller = restageGift(s, 400);
  assert.equal(smaller.applied, 400);
  assert.equal(smaller.remaining_balance, 1100);
  assert.equal(restageGift(null, 5), null);
});

const VERIFY = {
  verified: true,
  customer: { id: 'cust-1', name: 'Private Person', email: 'p@example.com' },
  loyalty: {
    points_balance: 900,
    tier: { name: 'Gold' },
    stamp_rewards: [{ program_id: 'sp1', name: 'Free coffee', reward_type: 'free_item', reward_config: { eligible_items: [{ id: 'k1', name: 'Flat white' }] }, available: 2 }],
    rewards_available: [
      { id: 'r1', name: '£3 off', points_cost: 300, reward_type: 'discount_fixed', reward_value: { amount_minor: 300 } },
      { id: 'r2', name: '10% off', points_cost: 500, reward_type: 'discount_percent', reward_value: { percent: 10 } },
      { id: 'r3', name: 'Old server', points_cost: 100, reward_type: 'discount_fixed' },
    ],
  },
};

test('rewards list: stamps first, then points, and no personal details', () => {
  const list = kioskRewardsFromVerify(VERIFY);
  assert.deepEqual(list.map(r => r.id), ['stamp:sp1', 'r1', 'r2', 'r3']);
  const text = JSON.stringify(list);
  assert.ok(!text.includes('Private Person'));
  assert.ok(!text.includes('example.com'));
  assert.ok(!text.includes('Gold'));
  assert.ok(!text.includes('900'));
  assert.deepEqual(kioskRewardsFromVerify({ loyalty: { ...VERIFY.loyalty, points_enabled: false } }).map(r => r.id), ['stamp:sp1']);
  assert.deepEqual(kioskRewardsFromVerify({ loyalty: { ...VERIFY.loyalty, stamps_enabled: false } }).map(r => r.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(kioskRewardsFromVerify(null), []);
});

test('reward staging: fixed, percent and the same object ScreenLoyalty stages (v5.8.67)', () => {
  const [, fixed, percent, noValue] = kioskRewardsFromVerify(VERIFY);
  const f = stageKioskReward(fixed, { cart: [], discountedSubtotal: 20, total: 20, customerId: 'cust-1' });
  assert.deepEqual(f, {
    ok: true,
    staged: {
      reward_id: 'r1', stampProgramId: null, customer_id: 'cust-1', reward_name: '£3 off', points_deducted: 300,
      discount_type: 'discount_fixed', reward_type: 'discount_fixed', reward_value: { amount_minor: 300 },
      discount_value: 300, idempotency_key: null, balance_after: null, pending_commit: true,
    },
  });
  // Percent of the goods AFTER auto discounts (discountedSubtotal), as KioskApp works it out.
  assert.equal(stageKioskReward(percent, { discountedSubtotal: 25.5, total: 27 }).staged.discount_value, 255);
  assert.equal(stageKioskReward(fixed, { discountedSubtotal: 2, total: 2 }).staged.discount_value, 200);   // never more than the goods
  // A points reward with no value (loyalty-otp before the reward_value fix) is refused, not staged at £0.
  assert.deepEqual(stageKioskReward(noValue, { discountedSubtotal: 20, total: 20 }), { ok: false, reason: 'zero' });
  // An empty basket: nothing to take off, refused.
  assert.deepEqual(stageKioskReward(percent, { discountedSubtotal: 0, total: 0 }), { ok: false, reason: 'zero' });
});

test('reward staging: free item present, missing, and other types', () => {
  const [stamp] = kioskRewardsFromVerify(VERIFY);
  const cart = [{ item: { id: 'k1' }, qty: 1, linePrice: 3.8 }, { item: { id: 'k1' }, qty: 1, linePrice: 3.2 }, { item: { id: 'p1' }, qty: 1, linePrice: 9.5 }];
  const s = stageKioskReward(stamp, { cart, discountedSubtotal: 16.5, total: 16.5 });
  assert.equal(s.ok, true);
  assert.equal(s.staged.discount_value, 320);
  assert.equal(s.staged.reward_id, null);
  assert.equal(s.staged.stampProgramId, 'sp1');
  assert.equal(s.staged.points_deducted, 0);
  assert.equal(s.staged.reward_type, 'free_item');
  assert.deepEqual(stageKioskReward(stamp, { cart: [cart[2]], discountedSubtotal: 9.5, total: 9.5 }), { ok: false, reason: 'needsItem', items: ['Flat white'] });
  // A size line matches on the size too (lib/kioskLoyaltyReward.js).
  const sized = stageKioskReward(stamp, { cart: [{ item: { id: 'coffee' }, variant: { id: 'k1' }, qty: 1, linePrice: 2.9 }], discountedSubtotal: 2.9, total: 2.9 });
  assert.equal(sized.staged.discount_value, 290);
  assert.deepEqual(stageKioskReward({ id: 'x', type: 'free_delivery', value: {} }, { discountedSubtotal: 10, total: 10 }), { ok: false, reason: 'zero' });
  assert.deepEqual(stageKioskReward({ id: 'x', type: 'free_item', value: {} }, { discountedSubtotal: 10, total: 10 }), { ok: false, reason: 'zero' });
});

test('reward staging uses the v5.8.67 tap check: a staged gift card that would cut the reward down refuses it', () => {
  const [, fixed] = kioskRewardsFromVerify(VERIFY);
  // A gift card already covering a £20 order: the reward would take nothing off, so it is refused
  // with its own reason (remove the gift card first), never staged.
  assert.deepEqual(stageKioskReward(fixed, { discountedSubtotal: 20, total: 20, giftMinor: 2000 }), { ok: false, reason: 'giftFirst' });
  // A gift card that leaves more than the reward still due: staged at its full value.
  const ok = stageKioskReward(fixed, { discountedSubtotal: 20, total: 20, giftMinor: 1500 });
  assert.equal(ok.ok, true);
  assert.equal(ok.staged.discount_value, 300);
  // Tap and pay agree: KioskApp's live credit for the staged reward is the tapped figure.
  const cart = [];
  assert.equal(kioskLoyaltyCreditMinor(ok.staged, { cart, goodsMinor: 2000, dueMinor: 2000, giftMinor: 1500 }), ok.staged.discount_value);
});

test('KioskApp builds the live reward context the way kioskRewardContext does', () => {
  const src = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const loyaltyDiscountMinor = kioskLoyaltyCreditMinor(loyaltyRedemption, {'));
  // v5.9.66: plus the kiosk's category rows (a reward can name categories).
  for (const line of ['cart,', 'categories,', 'goodsMinor: Math.round(discountedSubtotal * 100),', 'dueMinor: Math.round(total * 100),', 'giftMinor: giftCardPayment?.applied || 0,']) {
    assert.ok(block.slice(0, 340).includes(line), line);
  }
  assert.deepEqual(kioskRewardContext({ cart: [1], discountedSubtotal: 12.345, total: 13.5, giftMinor: 250 }), { cart: [1], categories: [], goodsMinor: 1235, dueMinor: 1350, giftMinor: 250 });
  assert.deepEqual(kioskRewardContext({ categories: [{ id: 'c' }] }).categories, [{ id: 'c' }]);
});

test('code classification', () => {
  assert.deepEqual(classifyKioskCode(' abcd-1234 efgh-5678 '), { code: 'ABCD-1234 EFGH-5678', stripped: 'ABCD1234EFGH5678', giftCandidate: true });
  assert.equal(classifyKioskCode('SUMMER10').giftCandidate, false);
  assert.equal(classifyKioskCode('').code, '');
});

test('gift lookup results', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  assert.deepEqual(kioskGiftLookupResult({ status: 'active', balance: 500 }, now), { ok: true });
  assert.deepEqual(kioskGiftLookupResult({ status: 'frozen', balance: 500 }, now), { errorKey: 'k2.code.giftInactive' });
  assert.deepEqual(kioskGiftLookupResult({ status: 'active', balance: 0 }, now), { errorKey: 'k2.code.giftEmpty' });
  assert.deepEqual(kioskGiftLookupResult({ status: 'active', balance: 5, expires_at: '2026-09-01' }, now), { errorKey: 'k2.code.giftExpired' });
});

test('promo results', () => {
  const ok = kioskPromoResult('SAVE5', { httpOk: true, body: { valid: true, code_id: 'pc1', offer: { id: 'o1', name: 'Autumn' }, discount: { amount: 5, label: '£5 off' } } });
  assert.deepEqual(ok, { promo: { code: 'SAVE5', code_id: 'pc1', offer_id: 'o1', label: '£5 off', amount: 5 } });
  assert.deepEqual(kioskPromoResult('X', { httpOk: true, body: { valid: false, reason: 'min_spend', min_spend: 20 } }), { errorKey: 'k2.code.minSpend', vars: { amount: 20 } });
  assert.deepEqual(kioskPromoResult('X', { httpOk: true, body: { valid: false, reason: 'expired' } }), { notValid: true });
  assert.deepEqual(kioskPromoResult('X', { networkError: true }), { failed: true });
});

function deps({ gift, promo } = {}) {
  const calls = { gift: [], promo: [] };
  return {
    calls,
    lookupGift: async (c) => { calls.gift.push(c); return gift; },
    validatePromo: async (c) => { calls.promo.push(c); return promo; },
  };
}
const PROMO_OK = { httpOk: true, body: { valid: true, code_id: 'pc', discount: { amount: 5, label: 'Five off' } } };
const GIFT_OK = { httpOk: true, body: { card_id: 'gc1', code_last4: '5678', status: 'active', balance: 2000 } };

test('applying a code: a short code is a promo only', async () => {
  const d = deps({ promo: PROMO_OK });
  const r = await applyKioskCode({ input: 'save5', grandTotal: 20, giftDue: 2000 }, d);
  assert.equal(r.promo.code, 'SAVE5');
  assert.deepEqual(d.calls.gift, []);
  const miss = await applyKioskCode({ input: 'nope', grandTotal: 20 }, deps({ promo: { httpOk: false, body: { valid: false } } }));
  assert.deepEqual(miss, { errorKey: 'k2.code.notRecognised' });
});

test('applying a code: a 16 character gift card stages against the amount due', async () => {
  const d = deps({ gift: GIFT_OK });
  const r = await applyKioskCode({ input: 'abcd-1234-efgh-5678', grandTotal: 25, giftDue: 1500 }, d);
  assert.deepEqual(d.calls.gift, ['ABCD1234EFGH5678']);
  assert.equal(r.gift.card_id, 'gc1');
  assert.equal(r.gift.applied, 1500);
  assert.equal(r.gift.remaining_balance, 500);
  assert.equal(r.gift.pending_commit, true);
});

test('applying a code: a gift lookup miss falls through to the promo check', async () => {
  const d = deps({ gift: { httpOk: false, body: { error: 'Card not found' } }, promo: PROMO_OK });
  const r = await applyKioskCode({ input: 'SUMMER2026PROMO1', grandTotal: 25 }, d);
  assert.equal(r.promo.code, 'SUMMER2026PROMO1');
  const none = await applyKioskCode({ input: 'SUMMER2026PROMO1', grandTotal: 25 }, deps({ gift: { httpOk: false, body: { error: 'x' } }, promo: { httpOk: true, body: { valid: false } } }));
  assert.deepEqual(none, { errorKey: 'k2.code.notRecognised' });
});

test('applying a code: with a gift card on, only a promo can be added', async () => {
  const d = deps({ gift: GIFT_OK, promo: { httpOk: true, body: { valid: false } } });
  const r = await applyKioskCode({ input: 'ABCD1234EFGH5678', giftStaged: { card_id: 'g' }, grandTotal: 10 }, d);
  assert.deepEqual(r, { errorKey: 'k2.code.oneGift' });
  assert.deepEqual(d.calls.gift, []);
});

test('applying a code: an answer that lands after Review and pay closed is dropped (the Pay race)', async () => {
  // The customer taps Apply on a gift card code, then leaves Review and pay before the lookup
  // answers: the late answer must stage nothing, so the card screen can never see it.
  let open = true;
  let answer;
  const gate = new Promise(r => { answer = r; });
  const d = {
    lookupGift: async () => { await gate; return GIFT_OK; },
    validatePromo: async () => PROMO_OK,
  };
  const pending = applyKioskCodeWhileOpen({ input: 'ABCD1234EFGH5678', grandTotal: 18.05, giftDue: 1805 }, d, () => open);
  open = false;            // Pay: the card screen opens
  answer();
  assert.deepEqual(await pending, { dropped: true });
  // Still open when it answers: exactly applyKioskCode's result.
  const kept = await applyKioskCodeWhileOpen({ input: 'ABCD1234EFGH5678', grandTotal: 18.05, giftDue: 1805 }, deps({ gift: GIFT_OK }), () => true);
  assert.equal(kept.gift.applied, 1805);
  // Already closed: nothing is looked up at all.
  const d2 = deps({ gift: GIFT_OK, promo: PROMO_OK });
  assert.deepEqual(await applyKioskCodeWhileOpen({ input: 'save5', grandTotal: 20 }, d2, () => false), { dropped: true });
  assert.deepEqual(d2.calls, { gift: [], promo: [] });
  // A late promo is dropped the same way.
  let open3 = true;
  const d3 = { lookupGift: async () => GIFT_OK, validatePromo: async () => { open3 = false; return PROMO_OK; } };
  assert.deepEqual(await applyKioskCodeWhileOpen({ input: 'save5', grandTotal: 20 }, d3, () => open3), { dropped: true });
});

test('applying a code: errors and nothing to pay', async () => {
  assert.deepEqual(await applyKioskCode({ input: '  ', grandTotal: 10 }, deps()), { none: true });
  assert.deepEqual(await applyKioskCode({ input: 'SAVE5', grandTotal: 0 }, deps()), { errorKey: 'k2.code.nothingToPay' });
  assert.deepEqual(await applyKioskCode({ input: 'SAVE5', grandTotal: 10 }, deps({ promo: { networkError: true } })), { errorKey: 'k2.code.failed' });
  assert.deepEqual(await applyKioskCode({ input: 'ABCD1234EFGH5678', grandTotal: 10 }, deps({ gift: { networkError: true } })), { errorKey: 'k2.code.failed' });
  assert.deepEqual(
    await applyKioskCode({ input: 'ABCD1234EFGH5678', grandTotal: 10 }, deps({ gift: { httpOk: true, body: { status: 'active', balance: 0 } } })),
    { errorKey: 'k2.code.giftEmpty' },
  );
  assert.deepEqual(
    await applyKioskCode({ input: 'MIN20', grandTotal: 10 }, deps({ promo: { httpOk: true, body: { valid: false, reason: 'min_spend', min_spend: 20 } } })),
    { errorKey: 'k2.code.minSpend', vars: { amount: 20 } },
  );
  // A promo already on the order: another promo is not tried.
  const d = deps({ promo: PROMO_OK });
  assert.deepEqual(await applyKioskCode({ input: 'SAVE5', promoStaged: { code: 'A' }, grandTotal: 10 }, d), { errorKey: 'k2.code.notRecognised' });
  assert.deepEqual(d.calls.promo, []);
});

test('pay block order and the card minimum boundary', () => {
  assert.equal(KIOSK_CARD_MINIMUM, 0.30);
  assert.equal(kioskPayBlock({ cartCount: 0, checking: true }), null);
  // A code still being looked up blocks Pay (today's kiosk disables Continue while applying).
  assert.equal(kioskPayBlock({ cartCount: 1, applying: true, grandTotal: 18.05 }), 'k2.pay.blockedChecking');
  assert.equal(kioskPayBlock({ cartCount: 1, applying: true, grandTotal: 0 }), 'k2.pay.blockedChecking');
  assert.equal(kioskPayBlock({ cartCount: 1, applying: false, grandTotal: 18.05 }), null);
  assert.equal(kioskPayBlock({ cartCount: 1, checking: true, allergenAckRequired: true, grandTotal: 0.1 }), 'k2.pay.blockedChecking');
  assert.equal(kioskPayBlock({ cartCount: 1, allergenAckRequired: true, allergenAck: false, grandTotal: 0.1 }), 'k2.pay.blockedAllergens');
  assert.equal(kioskPayBlock({ cartCount: 1, allergenAckRequired: true, allergenAck: true, grandTotal: 0.29 }), 'k2.pay.blockedMinimum');
  assert.equal(kioskPayBlock({ cartCount: 1, grandTotal: 0.01 }), 'k2.pay.blockedMinimum');
  assert.equal(kioskPayBlock({ cartCount: 1, grandTotal: 0.30 }), null);
  assert.equal(kioskPayBlock({ cartCount: 1, grandTotal: 0 }), null);      // fully covered: Place order
  assert.equal(kioskPayBlock({ cartCount: 2, grandTotal: 24.5 }), null);
});

test('totals rows show only what is above zero', () => {
  const plain = kioskTotalsRows({ subtotal: 20, grandTotal: 20 });
  assert.deepEqual(plain.map(r => r.id), ['items', 'total']);
  const full = kioskTotalsRows({
    subtotal: 30, autoDiscounts: [{ label: 'Meal deal', value: 2 }], autoDiscountTotal: 2, exclusiveTax: 2.1, tip: 3,
    loyaltyCredit: 1, promoCredit: 5, giftCardCredit: 4, grandTotal: 23.1,
  });
  assert.deepEqual(full.map(r => r.id), ['items', 'offers', 'tax', 'tip', 'reward', 'promo', 'gift', 'total']);
  assert.equal(full[1].label, 'Meal deal');
  assert.equal(full[1].labelKey, null);
  assert.deepEqual(full.filter(r => r.negative).map(r => r.id), ['offers', 'reward', 'promo', 'gift']);
  const two = kioskTotalsRows({ subtotal: 30, autoDiscounts: [{ label: 'A' }, { label: 'B' }], autoDiscountTotal: 3 });
  assert.equal(two[1].labelKey, 'k2.totals.offers');
  assert.deepEqual(kioskTotalsRows({ subtotal: 5, tip: 0.004 }).map(r => r.id), ['items', 'total']);
});

test('submit args are always strings and only text on take away passes the phone', () => {
  const phone = '+447700900123';
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: true, orderType: 'takeaway', smsOn: true, phoneE164: phone }), ['', phone]);
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: true, orderType: 'takeaway', smsOn: false, phoneE164: phone }), ['', '']);   // points only
  // Eat in at a table: brought to the table, no text. Eat in with no table: collected, texted.
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: true, orderType: 'dineIn', tableNumber: 'B5', smsOn: true, phoneE164: phone }), ['', '']);
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: true, orderType: 'dineIn', tableNumber: '', smsOn: true, phoneE164: phone }), ['', phone]);
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: false, orderType: 'takeaway', smsOn: true, phoneE164: phone }), ['', '']);
  assert.deepEqual(kioskSubmitArgs({ smsEnabled: true, orderType: 'takeaway', smsOn: true, phoneE164: null }), ['', '']);
  assert.deepEqual(kioskSubmitArgs(), ['', '']);
  for (const v of kioskSubmitArgs({ smsEnabled: true, orderType: 'takeaway', smsOn: true })) assert.equal(typeof v, 'string');
});

test('the attribution record has exactly submitOrder\'s field names and method rule', () => {
  const src = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  const block = /const orderRecord = \{([\s\S]*?)\};/.exec(src)[1];
  const names = [...block.matchAll(/^\s*([a-zA-Z_]+)\s*:/gm)].map(m => m[1]);
  const rec = kioskAttributionRecord({
    checkId: 'cc1', orderNumber: 'R12', grandTotal: 10, tip: 1, subtotal: 9,
    cart: [{ item: { id: 'p1', cat: 'pizza', name: 'Margherita' }, name: 'Margherita', qty: 1, linePrice: 9, modsArray: [] }],
    orderType: 'dineIn', locationId: 'loc', now: 5,
  });
  assert.deepEqual(Object.keys(rec), names);
  assert.equal(rec.method, 'card');
  assert.equal(rec.order_type, 'dine-in');
  assert.equal(rec.items[0].id, 'p1');
  assert.equal(rec.closedAt, 5);
  assert.equal(kioskAttributionRecord({ promoCredit: 1 }).method, 'split');
  assert.equal(kioskAttributionRecord({ orderType: 'takeaway' }).order_type, 'takeaway');
});

test('gift only abort messages map to customer keys', () => {
  assert.equal(kioskSubmitNotice('That gift card no longer has enough balance. Please try another card or pay at the reader.'), 'k2.code.giftShort');
  assert.equal(kioskSubmitNotice('Gift card could not be applied: HTTP 500'), 'k2.code.giftFailed');
  assert.equal(kioskSubmitNotice('Order submission failed. Please ask staff for help.'), null);
  assert.equal(kioskSubmitNotice(null), null);
  // The wording is still what submitOrder sets.
  const src = fs.readFileSync(new URL('../surfaces/KioskApp.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("'That gift card no longer has enough balance. Please try another card or pay at the reader.'"));
  assert.ok(src.includes('`Gift card could not be applied: ${giftCommit.error}`'));
});

import { kioskGiftRestage, kioskRewardRestage, kioskRewardCreditNoGift, kioskRewardContext, kioskOtpErrorKey } from './kioskCheckout.js';

test('gift restage: remove when nothing is due, restage when the due moves, else nothing', () => {
  const s = stage(1000, 800);
  assert.deepEqual(kioskGiftRestage({ staged: s, total: 8 }), { action: 'none' });
  assert.deepEqual(kioskGiftRestage({ staged: s, total: 8, promoAmount: 9 }), { action: 'remove' });
  const r = kioskGiftRestage({ staged: s, total: 12 });
  assert.equal(r.action, 'restage');
  assert.equal(r.staged.applied, 1000);
  assert.equal(r.staged.commit_key, s.commit_key);
  assert.deepEqual(kioskGiftRestage({ staged: null, total: 5 }), { action: 'none' });
});

test('a staged reward follows the basket live, and comes off only when it takes nothing off', () => {
  const [stamp, fixed] = kioskRewardsFromVerify(VERIFY);
  const cart = [{ item: { id: 'k1' }, qty: 1, linePrice: 3.2 }];
  const red = stageKioskReward(stamp, { cart, discountedSubtotal: 3.2, total: 3.2, customerId: 'c' }).staged;
  assert.deepEqual(kioskRewardRestage({ redemption: red, cart, discountedSubtotal: 3.2, total: 3.2 }), { action: 'none' });
  // Its free item left the basket: it takes nothing off, so it comes off (with a notice).
  assert.deepEqual(kioskRewardRestage({ redemption: red, cart: [{ item: { id: 'p1' }, qty: 1, linePrice: 9 }], discountedSubtotal: 9, total: 9 }), { action: 'remove' });
  // A smaller basket restages nothing: the live credit shrinks with the goods.
  const fx = stageKioskReward(fixed, { cart: [], discountedSubtotal: 20, total: 20 }).staged;
  assert.deepEqual(kioskRewardRestage({ redemption: fx, cart: [], discountedSubtotal: 2.5, total: 2.5 }), { action: 'none' });
  assert.equal(kioskRewardCreditNoGift({ redemption: fx, cart: [], discountedSubtotal: 2.5, total: 2.5 }), 2.5);
  assert.equal(credits({ total: 2.5, loyaltyRedemption: fx }).loyaltyCredit, 2.5);
  assert.deepEqual(kioskRewardRestage({ redemption: null }), { action: 'none' });
  assert.equal(kioskRewardCreditNoGift({ redemption: null, discountedSubtotal: 5, total: 5 }), 0);
});

test('the gift card is sized around the reward, so the live reward credit is never starved', () => {
  // A 10% reward on a £20 basket, then a £50 gift card sized after it.
  const [, , percent] = kioskRewardsFromVerify(VERIFY);
  const big = [{ item: { id: 'p1' }, qty: 2, linePrice: 10, lineTotal: 20 }];
  const red = stageKioskReward(percent, { cart: big, discountedSubtotal: 20, total: 20 }).staged;
  let gift = stage(5000, giftDueMinor({ total: 20, loyaltyCredit: kioskRewardCreditNoGift({ redemption: red, cart: big, discountedSubtotal: 20, total: 20 }) }));
  let c = credits({ total: 20, cart: big, loyaltyRedemption: red, giftCardPayment: gift });
  assert.equal(gift.applied, 1800);
  assert.equal(c.loyaltyCredit, 2);
  assert.equal(c.grandTotal, 0);
  // The customer takes one item off on Review and pay. On that render KioskApp's credit is
  // capped by the gift card still sized for £20 ...
  const small = [{ ...big[0], qty: 1, lineTotal: 10 }];
  c = credits({ total: 10, cart: small, loyaltyRedemption: red, giftCardPayment: gift });
  assert.equal(c.loyaltyCredit, 0);
  // ... so the gift card is restaged from the reward's own credit (£1), never from that figure.
  const own = kioskRewardCreditNoGift({ redemption: red, cart: small, discountedSubtotal: 10, total: 10 });
  assert.equal(own, 1);
  gift = kioskGiftRestage({ staged: gift, total: 10, loyaltyCredit: own }).staged;
  c = credits({ total: 10, cart: small, loyaltyRedemption: red, giftCardPayment: gift });
  assert.equal(gift.applied, 900);
  assert.equal(c.loyaltyCredit, 1);
  assert.equal(c.grandTotal, 0);
  // Sizing it from the capped credit (0) would have held the reward at 0 for good.
  const wrong = kioskGiftRestage({ staged: stage(5000, 1800), total: 10, loyaltyCredit: 0 }).staged;
  assert.equal(credits({ total: 10, cart: small, loyaltyRedemption: red, giftCardPayment: wrong }).loyaltyCredit, 0);
});

test('OTP errors map to customer keys', () => {
  assert.equal(kioskOtpErrorKey({ action: 'send', status: 429, body: { error: 'A code was just sent.' } }), 'k2.otp.wait');
  assert.equal(kioskOtpErrorKey({ action: 'send', status: 500, body: { error: 'Verification is not configured for this venue yet.' } }), 'k2.otp.notSetUp');
  assert.equal(kioskOtpErrorKey({ action: 'send', status: 400, body: { error: 'Invalid phone number' } }), 'k2.otp.failed');
  assert.equal(kioskOtpErrorKey({ action: 'verify', status: 401, body: { error: 'Invalid or expired code' } }), 'k2.otp.wrong');
  assert.equal(kioskOtpErrorKey({ action: 'verify', status: 429, body: { code: 'otp_locked' } }), 'k2.otp.locked');
  assert.equal(kioskOtpErrorKey({ action: 'verify', status: 0 }), 'k2.otp.failed');
});

import { kioskChargeTotal } from './kioskCheckout.js';

test('the charge total drops floating point crumbs and keeps real amounts', () => {
  // A gift card sized after the promo: the unchanged credit formulas leave a crumb.
  const total = 23.1;
  const c = credits({ total, loyaltyRedemption: fixedReward(300), promoApplied: { amount: 5 }, giftCardPayment: stage(5000, giftDueMinor({ total, loyaltyCredit: 3, promoAmount: 5 })) });
  assert.ok(c.grandTotal < 0.005);
  assert.equal(kioskChargeTotal(c.grandTotal), 0);
  assert.equal(kioskPayBlock({ cartCount: 1, grandTotal: c.grandTotal }), null);
  assert.equal(kioskChargeTotal(5.000000000000002), 5);
  assert.equal(kioskChargeTotal(12.34), 12.34);
  assert.equal(kioskChargeTotal(-1), 0);
  assert.equal(kioskChargeTotal(undefined), 0);
});

test('text me is offered for take away and eat in with no table', () => {
  assert.equal(kioskTextAllowed({ orderType: 'takeaway' }), true);
  assert.equal(kioskTextAllowed({ orderType: 'dineIn', tableNumber: '' }), true);
  assert.equal(kioskTextAllowed({ orderType: 'dineIn', tableNumber: '12' }), false);
  assert.equal(kioskTextAllowed({ orderType: null }), false);
});

test('a promo can still be added after a gift card covers the order (decision 6)', async () => {
  // A £20 gift card covers a £20 order, so nothing is left to pay.
  const gift = stageGiftCard({ cardId: 'g1', code: 'ABCD1234EFGH5678', codeLast4: '5678', balanceMinor: 2000, amountDueMinor: 2000 });
  let calls = 0;
  const d = {
    lookupGift: async () => { throw new Error('not a gift'); },
    validatePromo: async () => { calls++; return { httpOk: true, body: { valid: true, code_id: 'c1', discount: { label: '£5 off', amount: 5 } } }; },
  };
  const r = await applyKioskCode({ input: 'SAVE5', giftStaged: gift, promoStaged: null, grandTotal: 0, giftDue: 2000 }, d);
  assert.equal(calls, 1);
  assert.equal(r.promo.amount, 5);
  // The gift card then covers only what is left after the promo: £15.
  const plan = kioskGiftRestage({ staged: gift, total: 20, loyaltyCredit: 0, promoAmount: r.promo.amount });
  assert.equal(plan.action, 'restage');
  assert.equal(plan.staged.applied, 1500);
  assert.equal(plan.staged.remaining_balance, 500);
  const c = credits({ total: 20, loyaltyRedemption: null, giftCardPayment: plan.staged, promoApplied: r.promo });
  assert.equal(Math.round(c.grandTotal * 100), 0);
  assert.equal(c.promoCredit, 5);
  // With a promo already on, nothing to pay still says so.
  assert.deepEqual(
    await applyKioskCode({ input: 'MORE', giftStaged: plan.staged, promoStaged: r.promo, grandTotal: 0, giftDue: 1500 }, d),
    { errorKey: 'k2.code.nothingToPay' },
  );
});

// v5.8.81: the promo chip shows the server's own English fallback labels in the customer's
// language (supabase/functions/_shared/promo.ts computeDiscount builds them).
import { kioskPromoLabel } from './kioskCheckout.js';

test('promo chip labels: server fallbacks become keys, a venue label shows as written', () => {
  const r = kioskPromoResult('SAVE10', { httpOk: true, body: { valid: true, code_id: 'c', offer: { id: 'o', name: 'Autumn' }, discount: { type: 'percent', value: 10, amount: 2, label: '10% off' } } });
  assert.deepEqual(r.promo, { code: 'SAVE10', code_id: 'c', offer_id: 'o', label: '10% off', amount: 2, discountType: 'percent', discountValue: 10 });
  assert.deepEqual(kioskPromoLabel(r.promo), { key: 'k2.code.promoPercentOff', vars: { pct: 10 } });
  assert.deepEqual(kioskPromoLabel({ label: '12.5% off', discountType: 'percent', discountValue: 12.5 }), { key: 'k2.code.promoPercentOff', vars: { pct: 12.5 } });
  assert.deepEqual(kioskPromoLabel({ label: '£5.00 off', discountType: 'amount', discountValue: 5 }), { key: 'k2.code.promoAmountOff', vars: { amount: 5 }, money: 'amount' });
  assert.deepEqual(kioskPromoLabel({ label: 'Offer', discountType: 'amount', discountValue: 0 }), { key: 'k2.code.promoOffer', vars: {} });
  assert.deepEqual(kioskPromoLabel({ label: 'Free item', discountType: 'free_item', discountValue: 0 }), { key: 'k2.code.promoFreeItem', vars: {} });
  assert.deepEqual(kioskPromoLabel({ label: 'Free delivery', discountType: 'free_delivery', discountValue: 0 }), { key: 'k2.code.promoFreeDelivery', vars: {} });
  assert.deepEqual(kioskPromoLabel({ label: '50 bonus points', discountType: 'points_bonus', discountValue: 50 }), { key: 'k2.code.promoBonusPoints', vars: { n: 50 }, plural: true });
  // A venue's own reward label, or a label that does not match the type and value, stays as written.
  assert.deepEqual(kioskPromoLabel({ label: 'Happy hour 2 for 1', discountType: 'percent', discountValue: 50 }), { text: 'Happy hour 2 for 1' });
  assert.deepEqual(kioskPromoLabel({ label: '20% off', discountType: 'percent', discountValue: 10 }), { text: '20% off' });
  // An older promo object with no type (or none at all) shows its label.
  assert.deepEqual(kioskPromoLabel({ label: '£5 off' }), { text: '£5 off' });
  assert.deepEqual(kioskPromoLabel(null), { text: '' });
  // The fallbacks here are the ones the server builds.
  const server = fs.readFileSync(new URL('../../supabase/functions/_shared/promo.ts', import.meta.url), 'utf8');
  for (const s of ['`${v}% off`', '`£${v.toFixed(2)} off`', "'Free item'", "'Free delivery'", '`${v} bonus points`', "'Offer'"]) assert.ok(server.includes(s), s);
});
