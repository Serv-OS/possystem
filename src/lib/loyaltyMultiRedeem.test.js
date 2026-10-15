// More than one loyalty reward on one order (Peter, Coffee Boy, 30 Sep 2026): the picks, the
// units they cover, the staged aggregate the till reads, the slots the store commits with, and
// the reward lines the receipt prints. Pure module: src/lib/loyaltyMultiRedeem.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rewardUses, rewardUnits, pickNext, toggleUnit, removeLastPick, pickBlock, pickBlockText,
  planRedemptions, combineRedemptions, redemptionsOf, withSlots, rewardCapacity, rewardsUsedLabel,
  receiptRewardLines, rewardsRecord, pointsPicked, slotOf, slotHonoured, SLOT_NOT_HONOURED,
} from './loyaltyMultiRedeem.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');

// Coffee Boy's Free Drink stamp card: two completed cards ready.
const FREE_DRINK = {
  id: 'stamp:prog-1', label: 'Free Drink', type: 'free_item', stamp: true, stampProgramId: 'prog-1', available: 2,
  value: { eligible_items: [{ id: 'leeds-latte', name: 'Latte' }, { id: 'leeds-mocha', name: 'Mocha' }] },
};
// A points reward: £1 off for 100 points.
const POUND_OFF = { id: 'rw-1', label: 'Pound off', type: 'discount_fixed', pointsCost: 100, value: { amount_minor: 100 } };
// A points reward that is a free item too.
const FREE_CAKE = { id: 'rw-2', label: 'Free Cake', type: 'free_item', pointsCost: 150, value: { eligible_items: [{ id: 'x', name: 'Brownie' }] } };
const REWARDS = [FREE_DRINK, POUND_OFF, FREE_CAKE];

const line = (itemId, name, price, qty = 1) => ({ uid: itemId, itemId, name, price, qty });
// Two lattes on one line, a mocha, a brownie and a sandwich (not eligible for any reward).
const ITEMS = [line('latte', 'Latte', 3.2, 2), line('mocha', 'Mocha', 3.6), line('brownie', 'Brownie', 2.5), line('sand', 'Sandwich', 6)];
const TOTAL = 3.2 * 2 + 3.6 + 2.5 + 6;
const ctx = { items: ITEMS, total: TOTAL, credit: 200 };

test('a stamp reward is usable once per completed card; a points reward once', () => {
  assert.equal(rewardUses(FREE_DRINK), 2);
  assert.equal(rewardUses({ ...FREE_DRINK, available: 0 }), 0);
  assert.equal(rewardUses(POUND_OFF), 1);
  assert.equal(rewardUses(null), 0);
});

test('units: one per unit of each eligible line, cheapest first; nothing for a money reward', () => {
  const units = rewardUnits(FREE_DRINK, ctx);
  assert.deepEqual(units.map((u) => [u.key, u.name, u.priceMinor]), [['0:0', 'Latte', 320], ['0:1', 'Latte', 320], ['1:0', 'Mocha', 360]]);
  assert.deepEqual(rewardUnits(POUND_OFF, ctx), []);
  assert.deepEqual(rewardUnits(FREE_DRINK, { items: [line('sand', 'Sandwich', 6)] }), []);
});

test('picking twice covers two different units, the third pick is refused (two cards only)', () => {
  let r = pickNext([], FREE_DRINK, REWARDS, ctx);
  assert.equal(r.error, null);
  assert.deepEqual(r.picks, [{ rewardId: 'stamp:prog-1', unitKey: '0:0' }]);
  r = pickNext(r.picks, FREE_DRINK, REWARDS, ctx);
  assert.deepEqual(r.picks.map((p) => p.unitKey), ['0:0', '0:1'], 'the second latte unit, not the same one twice');
  const third = pickNext(r.picks, FREE_DRINK, REWARDS, ctx);
  assert.equal(third.picks, r.picks);
  assert.match(third.error, /Every completed card is already used/);
});

test('a free item reward with none of its items on the order is refused with the items to add', () => {
  const r = pickNext([], FREE_DRINK, REWARDS, { items: [line('sand', 'Sandwich', 6)], total: 6 });
  assert.deepEqual(r.picks, []);
  assert.equal(r.error, 'Add Latte, Mocha to the order first. The reward makes it free.');
  assert.equal(pickBlock([], FREE_DRINK, REWARDS, { items: [] }), 'no_item');
  assert.equal(pickBlockText('no_item', { value: {} }), 'Add the eligible item to the order first.');
});

test('a points reward needs the points the other picks have left', () => {
  const one = pickNext([], POUND_OFF, REWARDS, ctx);
  assert.equal(one.error, null);
  const two = pickNext(one.picks, FREE_CAKE, REWARDS, ctx);   // 100 + 150 > 200
  assert.equal(two.picks, one.picks);
  assert.equal(two.error, 'Not enough points left for this reward.');
  assert.equal(pointsPicked(one.picks, REWARDS), 100);
  const again = pickNext(one.picks, POUND_OFF, REWARDS, { ...ctx, credit: 500 });
  assert.equal(again.error, 'This reward is already on the order.');
});

test('a stamp reward never spends points and ignores the balance', () => {
  const r = pickNext([], FREE_DRINK, REWARDS, { ...ctx, credit: 0 });
  assert.equal(r.error, null);
  assert.equal(pointsPicked(r.picks, REWARDS), 0);
});

test('ticking a unit: swap the latte for the mocha, never take a unit another reward holds', () => {
  const start = pickNext([], FREE_DRINK, REWARDS, ctx).picks;   // latte 0:0
  const swapped = toggleUnit(toggleUnit(start, FREE_DRINK, '0:0', REWARDS, ctx).picks, FREE_DRINK, '1:0', REWARDS, ctx);
  assert.equal(swapped.error, null);
  assert.deepEqual(swapped.picks.map((p) => p.unitKey), ['1:0']);
  const cake = pickNext(swapped.picks, FREE_CAKE, REWARDS, ctx).picks;   // brownie 2:0
  const clash = toggleUnit(cake, FREE_DRINK, '2:0', REWARDS, ctx);
  assert.equal(clash.error, 'That item is already covered by another reward.');
  const sandwich = toggleUnit(cake, FREE_DRINK, '3:0', REWARDS, ctx);
  assert.equal(sandwich.error, 'That item is not eligible for this reward.');
  const notMine = toggleUnit(cake, FREE_CAKE, '1:0', REWARDS, ctx);
  assert.equal(notMine.error, 'That item is already covered by another reward.');
  const over = toggleUnit([...swapped.picks, { rewardId: 'stamp:prog-1', unitKey: '0:0' }], FREE_DRINK, '0:1', REWARDS, ctx);
  assert.match(over.error, /Every completed card/);
});

test('removeLastPick takes the newest use of that reward only', () => {
  const picks = [{ rewardId: 'stamp:prog-1', unitKey: '0:0' }, { rewardId: 'rw-1', unitKey: null }, { rewardId: 'stamp:prog-1', unitKey: '0:1' }];
  assert.deepEqual(removeLastPick(picks, FREE_DRINK).map((p) => p.unitKey), ['0:0', null]);
  assert.deepEqual(removeLastPick(picks, FREE_CAKE), picks);
});

test('planRedemptions: one staged redemption per pick, each on its own item, minor units', () => {
  const picks = [
    { rewardId: 'stamp:prog-1', unitKey: '0:0' }, { rewardId: 'stamp:prog-1', unitKey: '1:0' }, { rewardId: 'rw-1', unitKey: null },
  ];
  const plan = planRedemptions(picks, REWARDS, { ...ctx, customerId: 'cust-1' });
  assert.equal(plan.error, null);
  assert.equal(plan.discountMinor, 320 + 360 + 100);
  assert.deepEqual(plan.redemptions.map((r) => [r.stampProgramId, r.reward_id, r.reward_name, r.discount_value, r.item_name, r.points_deducted, r.pending_commit]), [
    ['prog-1', null, 'Free Drink', 320, 'Latte', 0, true],
    ['prog-1', null, 'Free Drink', 360, 'Mocha', 0, true],
    [null, 'rw-1', 'Pound off', 100, null, 100, true],
  ]);
  assert.equal(plan.redemptions[0].customer_id, 'cust-1');
});

test('planRedemptions refuses a pick whose item left the order, and caps the money at the bill', () => {
  const gone = planRedemptions([{ rewardId: 'stamp:prog-1', unitKey: '9:0' }], REWARDS, ctx);
  assert.equal(gone.redemptions.length, 0);
  assert.match(gone.error, /no longer on the order/);
  const small = planRedemptions([{ rewardId: 'rw-1', unitKey: null }, { rewardId: 'rw-1', unitKey: null }], REWARDS, { items: [line('tea', 'Tea', 1.5)], total: 1.5 });
  assert.equal(small.discountMinor, 150);
  assert.deepEqual(small.redemptions.map((r) => r.discount_value), [100, 50]);
  const percent = planRedemptions([{ rewardId: 'pc', unitKey: null }], [{ id: 'pc', label: 'Ten off', type: 'discount_percent', value: { percent: 10 } }], { items: ITEMS, total: 20 });
  assert.equal(percent.discountMinor, 200);
});

test('combineRedemptions keeps the shape the till reads, with every reward inside', () => {
  const plan = planRedemptions([{ rewardId: 'stamp:prog-1', unitKey: '0:0' }, { rewardId: 'stamp:prog-1', unitKey: '0:1' }, { rewardId: 'rw-1', unitKey: null }], REWARDS, ctx);
  const loy = combineRedemptions(plan.redemptions, { customerId: 'cust-1' });
  assert.equal(loy.discount_value, 320 + 320 + 100);   // taxBasis reads this
  assert.equal(loy.points_deducted, 100);
  assert.equal(loy.pending_commit, true);               // the store's gate
  assert.equal(loy.stampProgramId, 'prog-1');
  assert.equal(loy.reward_id, 'rw-1');
  assert.equal(loy.customer_id, 'cust-1');
  assert.equal(loy.reward_name, 'Free Drink x2, Pound off');
  assert.equal(loy.discount_type, 'multi');
  assert.equal(loy.rewards.length, 3);
  assert.equal(combineRedemptions([]), null);
  const one = combineRedemptions([plan.redemptions[0]]);
  assert.equal(one.reward_name, 'Free Drink');
  assert.equal(one.discount_type, 'free_item');
  assert.equal(one.rewards.length, 1);
});

test('redemptionsOf reads the new shape and the old single one alike', () => {
  const old = { stampProgramId: 'prog-1', reward_id: null, discount_value: 320, pending_commit: true };
  assert.deepEqual(redemptionsOf(old), [old]);
  const combined = combineRedemptions([{ stampProgramId: 'prog-1', discount_value: 1 }, { stampProgramId: 'prog-1', discount_value: 2 }]);
  assert.equal(redemptionsOf(combined).length, 2);
  assert.deepEqual(redemptionsOf(null), []);
  assert.deepEqual(redemptionsOf({ discount_value: 0 }), [], 'nothing to commit without a target');
});

test('withSlots numbers the same programme on one check 1, 2, 3 and leaves slot 1 alone', () => {
  const slots = withSlots([
    { stampProgramId: 'prog-1' }, { reward_id: 'rw-1' }, { stampProgramId: 'prog-1' }, { stampProgramId: 'prog-2' }, { stampProgramId: 'prog-1' },
  ]).map((r) => r.slot);
  assert.deepEqual(slots, [1, 1, 2, 1, 3]);
});

test('capacity counts completed cards and affordable points rewards; the label reads plainly', () => {
  assert.equal(rewardCapacity(REWARDS, { credit: 200 }), 2 + 1 + 1);
  assert.equal(rewardCapacity(REWARDS, { credit: 120 }), 2 + 1);
  assert.equal(rewardCapacity(REWARDS, { credit: 0 }), 2);
  assert.equal(rewardsUsedLabel(2, 3), '2 of 3 rewards used');
  assert.equal(rewardsUsedLabel(0, 1), '0 of 1 reward used');
  assert.equal(rewardsUsedLabel(3, 2), '3 of 3 rewards used', 'never fewer than used');
});

test('receipt lines and the record: one per reward, with the item it made free', () => {
  const plan = planRedemptions([{ rewardId: 'stamp:prog-1', unitKey: '0:0' }, { rewardId: 'rw-1', unitKey: null }], REWARDS, ctx);
  const loy = combineRedemptions(plan.redemptions);
  assert.deepEqual(receiptRewardLines(loy), [
    { label: 'Reward: Free Drink (Latte)', amount: 3.2, points: 0 },
    { label: 'Reward: Pound off', amount: 1, points: 100 },
  ]);
  assert.deepEqual(rewardsRecord(loy), [
    { name: 'Free Drink', item: 'Latte', amount: 3.2, stamp_program_id: 'prog-1' },
    { name: 'Pound off', item: null, amount: 1, reward_id: 'rw-1' },
  ]);
  assert.deepEqual(receiptRewardLines(null), []);
  assert.equal(rewardsRecord(null), null);
  // The old single shape prints too.
  assert.deepEqual(receiptRewardLines({ stampProgramId: 'p', reward_name: 'Free Drink', discount_value: 320 }), [{ label: 'Reward: Free Drink', amount: 3.2, points: 0 }]);
});

// 30 Sep 2026 (review): the till can be promoted before loyalty-redeem is redeployed. The old
// function ignores redeem_slot, so slot 2 collides with slot 1's key and comes back 200
// already_processed having redeemed nothing. The reply's key must carry the slot.
test('slotHonoured: slot 1 asks nothing; slot n needs a reply key ending in :n', () => {
  const CHK = 'chk-1700000000000';
  assert.equal(slotOf({}), 1);
  assert.equal(slotOf({ redeem_slot: 2 }), 2);
  assert.equal(slotOf({ redeem_slot: '3' }), 3);
  assert.equal(slotOf({ redeem_slot: 0 }), 1);
  // Slot 1: the old reply and the new reply both pass, even with no key at all.
  assert.equal(slotHonoured({ closed_check_id: CHK }, { status: 'redeemed', idempotency_key: `stampredeem:${CHK}:prog-1` }), true);
  assert.equal(slotHonoured({ closed_check_id: CHK }, { status: 'already_processed' }), true);
  // Slot 2 against the OLD function: 200 already_processed with slot 1's key. Not a deduction.
  assert.equal(slotHonoured({ redeem_slot: 2 }, { status: 'already_processed', idempotency_key: `stampredeem:${CHK}:prog-1` }), false);
  assert.equal(slotHonoured({ redeem_slot: 2 }, { status: 'redeemed' }), false, 'no key is no proof');
  // Slot 2 against the NEW function.
  assert.equal(slotHonoured({ redeem_slot: 2 }, { status: 'redeemed', idempotency_key: `stampredeem:${CHK}:prog-1:2` }), true);
  assert.equal(slotHonoured({ redeem_slot: 2 }, { status: 'already_processed', idempotency_key: `stampredeem:${CHK}:prog-1:2` }), true, 'a retry that already landed');
  assert.equal(slotHonoured({ redeem_slot: 12 }, { idempotency_key: `stampredeem:${CHK}:prog-1:2` }), false, 'the whole number, not a suffix of it');
  assert.match(SLOT_NOT_HONOURED, /not deducted/);
  assert.ok(!/[\u2013\u2014]/.test(SLOT_NOT_HONOURED), 'no dashes in staff copy');
});

test('commitRedemptions scores a 200 with the slot check, on the live call and on the parked replay', () => {
  const src = readSrc('./commitRedemptions.js');
  assert.ok(src.includes("import { slotHonoured, SLOT_NOT_HONOURED } from './loyaltyMultiRedeem.js';"));
  assert.ok(src.includes('if (!slotHonoured(body, j)) return { ok: false, error: SLOT_NOT_HONOURED, retryable: false };'), 'a refusal, not a retry');
  assert.equal((src.match(/outcome\(result\.res, result\.j, result\.bodyRead, call\.body\)/g) || []).length, 2, 'the first answer and the one after a re-link');
  assert.ok(src.includes('outcome(res, j, bodyRead, it.body)'), 'the replay loop sends the parked body and checks the same way');
  // loyalty-redeem answers with the key it used on both the fresh and the already_processed reply.
  const fn = readSrc('../../supabase/functions/loyalty-redeem/index.ts');
  assert.ok(fn.includes("return json({ status: 'already_processed', stamp: true, points_deducted: 0, balance: null, reward: rewardInfo, idempotency_key: idemKey });"), 'already_processed carries the key');
  assert.ok(fn.includes("status: 'redeemed',\n      stamp: true,\n      points_deducted: 0,\n      balance: null,\n      reward: rewardInfo,\n      idempotency_key: idemKey,"), 'redeemed carries the key');
});

// 30 Sep 2026 (review): a refund gave points back and never a stamp reward. With two rewards on
// one order that showed. loyalty-refund now restores every redeem row of the check.
test('loyalty-refund restores the stamp rewards of a refunded check: audit row first, then the redeem row goes', () => {
  const fn = readSrc('../../supabase/functions/loyalty-refund/index.ts');
  const block = fn.indexOf('let stampRewardsRestored = 0;');
  assert.ok(block > 0 && block < fn.indexOf('const idempotencyKey = `refund:${closed_check_id}`;'), 'before the points idempotency short circuit');
  const body = fn.slice(block);
  assert.ok(body.includes(".eq('order_ref', String(closed_check_id))\n      .eq('type', 'redeem');"), 'found by the check, whatever the slot');
  assert.ok(body.indexOf("type: 'refund',") < body.indexOf(".delete().eq('id', row.id).eq('type', 'redeem')"), 'audit row first, delete second');
  assert.ok(body.includes("idempotency_key: `stamprefund:${row.idempotency_key || row.id}`"), 'one claim per reward');
  assert.ok(body.includes("if (auditErr && auditErr.code !== '23505')"), 'a retry after a half done restore carries on');
  // The readers all count type='redeem' rows, so the delete restores the reward everywhere at once.
  for (const f of ['loyalty-balance', 'loyalty-redeem', 'loyalty-earn']) {
    assert.ok(readSrc(`../../supabase/functions/${f}/index.ts`).includes(".eq('type', 'redeem')"), `${f} counts redeem rows`);
  }
  assert.ok(readSrc('../backoffice/sections/Customers.jsx').includes(".eq('type', 'redeem')"));
  assert.ok(readSrc('../backoffice/sections/reports/LoyaltyReport.jsx').includes("Reward restored (refund)"), 'the report names the audit row');
});
