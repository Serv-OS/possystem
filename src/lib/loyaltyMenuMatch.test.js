// A free item reward is per COMPANY (Peter, 18 Sep 2026); menus are per SITE. A Free Drink
// saved with Leeds' Latte must redeem a Barnsley Latte on the till, the kiosk and online.
// Tests src/lib/loyaltyMenuMatch.js through the functions each surface actually calls:
//   till    lib/loyaltyRedeem.js redeemLoyaltyReward (CheckoutModal)
//   kiosk   lib/kioskLoyaltyReward.js + lib/kioskCheckout.js stageKioskReward (both designs)
//   online  eligibleOrderLines (OnlineCheckout.redeemReward)
// and the Back Office picker (lib/loyaltyItemPicker.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normLoyaltyName, itemLabelKey, eligibleItemNames, eligibleMatcher, eligibleOrderLines,
  kioskLineCandidates,
} from './loyaltyMenuMatch.js';
import { normStampName } from '../../supabase/functions/_shared/stampQualify.ts';
import { redeemLoyaltyReward } from './loyaltyRedeem.js';
import { kioskRewardTapCheck, kioskLoyaltyCreditMinor, kioskRewardMissingItems } from './kioskLoyaltyReward.js';
import { stageKioskReward } from './kioskCheckout.js';
import { kioskVariant } from './kioskLine.js';
import {
  groupItemsForPicker, pickGroupSelected, togglePickGroup, selectedChips, removeChip,
} from './loyaltyItemPicker.js';

// The Free Drink stamp card, saved in the Back Office while logged into LEEDS.
const FREE_DRINK = { eligible_items: [{ id: 'leeds-latte', name: 'Latte' }] };
// A Free Large Latte picked as a size at Leeds (older saves use a long dash; new ones ' - ').
const FREE_LARGE = { eligible_items: [{ id: 'leeds-latte-l', name: 'Latte \u2014 Large' }] };

// Barnsley's own menu (different ids for the same things).
const BARNSLEY_MENU = [
  { id: 'barn-latte', name: 'Latte', parentId: null },
  { id: 'barn-mocha', name: 'Mocha', parentId: null },
  { id: 'barn-cap', name: 'Cappuccino', parentId: null },
  { id: 'barn-cap-s', name: 'Small', parentId: 'barn-cap' },
  { id: 'barn-cap-l', name: 'Large', parentId: 'barn-cap' },
  { id: 'barn-flat', name: 'Latte', parent_id: null },
];

// ── till ──────────────────────────────────────────────────────────────
const tillLine = (itemId, name, price, extra = {}) => ({ uid: itemId, itemId, name, price, qty: 1, ...extra });
const tillReward = (value, type = 'free_item') => ({ id: 'stamp:free-drink', label: 'Free Drink', type, value, stamp: true });

test('till: a Free Drink saved with Leeds Latte redeems a Barnsley Latte', async () => {
  const items = [tillLine('barn-latte', 'Latte', 3.2), tillLine('barn-mocha', 'Mocha', 3.6)];
  const r = await redeemLoyaltyReward(tillReward(FREE_DRINK), { customerId: 'c1', items, total: 6.8, menuItems: BARNSLEY_MENU });
  assert.equal(r.discount_value, 320);
  assert.equal(r.stampProgramId, 'free-drink');
});

test('till: the line name alone is enough when the till menu is not passed', async () => {
  const r = await redeemLoyaltyReward(tillReward(FREE_DRINK), { customerId: 'c1', items: [tillLine('barn-latte', '  latte ', 3.2)], total: 3.2 });
  assert.equal(r.discount_value, 320);
});

test('till: a different item does not redeem, and the message names the item once', async () => {
  const saved4Sites = { eligible_items: ['leeds', 'barn', 'pres', 'stat'].map(s => ({ id: `${s}-latte`, name: 'Latte' })) };
  await assert.rejects(
    redeemLoyaltyReward(tillReward(saved4Sites), { customerId: 'c1', items: [tillLine('barn-mocha', 'Mocha', 3.6)], total: 3.6, menuItems: BARNSLEY_MENU }),
    (e) => { assert.match(e.message, /^Add Latte to the order first/); return true; },
  );
});

test('till: the saved id still works at the site it was saved at', async () => {
  const r = await redeemLoyaltyReward(tillReward(FREE_DRINK), { customerId: 'c1', items: [tillLine('leeds-latte', 'Renamed on the till', 2.9)], total: 2.9, menuItems: [] });
  assert.equal(r.discount_value, 290);
});

test('till: a size saved at Leeds matches the same size at Barnsley, not another size', async () => {
  const menu = [...BARNSLEY_MENU, { id: 'barn-latte-l', name: 'Large', parentId: 'barn-latte' }, { id: 'barn-latte-s', name: 'Small', parentId: 'barn-latte' }];
  const large = await redeemLoyaltyReward(tillReward(FREE_LARGE), {
    customerId: 'c1', items: [tillLine('barn-latte-l', 'Latte \u2014 Large', 3.9, { parentId: 'barn-latte' })], total: 3.9, menuItems: menu,
  });
  assert.equal(large.discount_value, 390);
  await assert.rejects(redeemLoyaltyReward(tillReward(FREE_LARGE), {
    customerId: 'c1', items: [tillLine('barn-latte-s', 'Latte \u2014 Small', 3.1, { parentId: 'barn-latte' })], total: 3.1, menuItems: menu,
  }));
});

test('till: voided lines never count, the cheapest eligible line is free', async () => {
  const items = [tillLine('barn-latte', 'Latte', 3.2, { voided: true }), tillLine('barn-flat', 'Latte', 2.5), tillLine('x', 'Latte', 3.0)];
  const r = await redeemLoyaltyReward(tillReward(FREE_DRINK), { customerId: 'c1', items, total: 8.7, menuItems: BARNSLEY_MENU });
  assert.equal(r.discount_value, 250);
});

// ── kiosk ─────────────────────────────────────────────────────────────
const LATTE_ROW = { id: 'barn-latte', name: 'Latte', menu_name: 'Latte' };
const kioskLine = (item, linePrice, variant = null, qty = 1) => ({ key: item.id, item, variant, name: item.name, qty, linePrice, lineTotal: qty * linePrice });
const kioskCtx = (cart) => {
  const goods = cart.reduce((a, l) => a + l.lineTotal, 0);
  return { cart, discountedSubtotal: goods, total: goods, giftMinor: 0 };
};

test('kiosk: a Free Drink saved with Leeds Latte redeems a Barnsley Latte (tap, stage, live credit)', () => {
  const cart = [kioskLine(LATTE_ROW, 3.2), kioskLine({ id: 'barn-mocha', name: 'Mocha' }, 3.6)];
  const ctx = { cart, goodsMinor: 680, dueMinor: 680, giftMinor: 0 };
  assert.deepEqual(kioskRewardTapCheck('free_item', FREE_DRINK, ctx), { discountMinor: 320, error: null });
  const staged = stageKioskReward({ id: 'stamp:free-drink', label: 'Free Drink', type: 'free_item', value: FREE_DRINK, stamp: true }, kioskCtx(cart));
  assert.equal(staged.ok, true);
  assert.equal(staged.staged.discount_value, 320);
  // KioskApp's live credit (the fingerprinted credits block calls this with the same shape).
  assert.equal(kioskLoyaltyCreditMinor(staged.staged, ctx), 320);
});

test('kiosk: a different item does not redeem, and the guest is told the item once', () => {
  const saved4Sites = { eligible_items: [{ id: 'leeds-latte', name: 'Latte' }, { id: 'barn-latte-x', name: 'latte' }] };
  const cart = [kioskLine({ id: 'barn-mocha', name: 'Mocha' }, 3.6)];
  assert.equal(kioskRewardMissingItems('free_item', saved4Sites, cart), 'Latte');
  const staged = stageKioskReward({ id: 'r', label: 'Free Drink', type: 'free_item', value: saved4Sites }, kioskCtx(cart));
  assert.deepEqual(staged, { ok: false, reason: 'needsItem', items: ['Latte'] });
  assert.equal(kioskLoyaltyCreditMinor({ reward_type: 'free_item', reward_value: saved4Sites }, { cart, goodsMinor: 360, dueMinor: 360 }), 0);
});

test('kiosk: the saved id still works at its own site', () => {
  const cart = [kioskLine({ id: 'leeds-latte', name: 'Something else' }, 2.9)];
  assert.equal(kioskRewardTapCheck('free_item', FREE_DRINK, { cart, goodsMinor: 290, dueMinor: 290 }).discountMinor, 290);
});

test('kiosk: a size line matches "<parent> - <size>" saved at another site, whatever the dash', () => {
  const LARGE = { id: 'barn-latte-l', name: 'Large', menu_name: 'Big one', parent_id: 'barn-latte' };
  const SMALL = { id: 'barn-latte-s', name: 'Small', parent_id: 'barn-latte' };
  const large = kioskLine(LATTE_ROW, 3.9, kioskVariant(LATTE_ROW, LARGE));
  const small = kioskLine(LATTE_ROW, 3.1, kioskVariant(LATTE_ROW, SMALL));
  assert.equal(kioskRewardTapCheck('free_item', FREE_LARGE, { cart: [small, large], goodsMinor: 700, dueMinor: 700 }).discountMinor, 390);
  assert.ok(kioskRewardTapCheck('free_item', FREE_LARGE, { cart: [small], goodsMinor: 310, dueMinor: 310 }).error);
  const hyphen = { eligible_items: [{ id: 'z', name: 'latte - large' }] };
  assert.equal(kioskRewardTapCheck('free_item', hyphen, { cart: [large], goodsMinor: 390, dueMinor: 390 }).discountMinor, 390);
  assert.deepEqual(kioskLineCandidates(large).ids, ['barn-latte', 'barn-latte-l']);
});

// ── online ────────────────────────────────────────────────────────────
const onlineLine = (itemId, name, price, parentId = null) => ({ uid: `${itemId}-1`, itemId, name, price, qty: 1, parentId });

test('online: a Free Drink saved with Leeds Latte matches a Barnsley Latte in the cart', () => {
  const cart = [onlineLine('barn-latte', 'Latte', 3.2), onlineLine('barn-mocha', 'Mocha', 3.6)];
  assert.deepEqual(eligibleOrderLines(FREE_DRINK, cart, BARNSLEY_MENU).map(l => l.itemId), ['barn-latte']);
  // Without the menu the cart line's own name still matches.
  assert.equal(eligibleOrderLines(FREE_DRINK, cart, []).length, 1);
});

test('online: a different item does not match; a saved id does; sizes match by parent and size', () => {
  assert.equal(eligibleOrderLines(FREE_DRINK, [onlineLine('barn-mocha', 'Mocha', 3.6)], BARNSLEY_MENU).length, 0);
  assert.equal(eligibleOrderLines(FREE_DRINK, [onlineLine('leeds-latte', 'Latte (menu name)', 3)], []).length, 1);
  const menu = [...BARNSLEY_MENU, { id: 'barn-latte-l', name: 'Large', parent_id: 'barn-latte' }];
  const sized = [onlineLine('barn-latte-l', 'Latte \u2014 Big one', 3.9, 'barn-latte')];
  assert.equal(eligibleOrderLines(FREE_LARGE, sized, menu).length, 1);
  assert.equal(eligibleOrderLines(FREE_LARGE, [onlineLine('barn-cap-l', 'Cappuccino \u2014 Large', 3.9, 'barn-cap')], menu).length, 0);
  // No eligible items configured: [] so the surface keeps its own old fallback.
  assert.deepEqual(eligibleOrderLines({ eligible_items: [] }, sized, menu), []);
});

// ── the rule itself ───────────────────────────────────────────────────
test('the item normaliser is the stamp earn normaliser (parity with stampQualify.ts)', () => {
  for (const s of ['Latte', '  flat   WHITE ', 'Iced\tLatte', '', null, 7, undefined]) {
    assert.equal(normLoyaltyName(s), normStampName(s));
  }
  assert.equal(itemLabelKey('Latte \u2014 Large'), itemLabelKey(' latte  -  LARGE'));
  assert.notEqual(itemLabelKey('Latte-Large'), itemLabelKey('Latte - Large'));
});

test('a Free Latte saved before the Latte had sizes covers a Latte of any size', () => {
  const m = eligibleMatcher(FREE_DRINK);
  assert.equal(m.matches({ ids: ['barn-latte-l', 'barn-latte'], labels: ['Latte - Large', 'Latte'] }), true);
  assert.equal(m.matches({ ids: ['barn-cap-l'], labels: ['Cappuccino - Large', 'Cappuccino'] }), false);
  assert.equal(eligibleMatcher({}).configured, false);
  assert.equal(eligibleMatcher({ eligible_items: [null, 'x', {}] }).configured, false);
});

test('eligibleItemNames shows each item once', () => {
  assert.deepEqual(eligibleItemNames({ eligible_items: [{ id: 'a', name: 'Latte' }, { id: 'b', name: ' latte' }, { id: 'c', name: 'Mocha' }, { id: 'd' }] }), ['Latte', 'Mocha']);
});

// ── Back Office picker ────────────────────────────────────────────────
const COMPANY_ITEMS = [
  { id: 'leeds-latte', name: 'Latte', location_id: 'leeds', price: 3 },
  { id: 'barn-latte', name: 'latte ', location_id: 'barnsley', price: 3.2 },
  { id: 'leeds-cap', name: 'Cappuccino', location_id: 'leeds' },
  { id: 'leeds-cap-l', name: 'Large', parent_id: 'leeds-cap', location_id: 'leeds' },
  { id: 'barn-cap', name: 'Cappuccino', location_id: 'barnsley' },
  { id: 'barn-cap-l', name: 'Large', parent_id: 'barn-cap', location_id: 'barnsley' },
  { id: 'barn-cap-s', name: 'Small', parent_id: 'barn-cap', location_id: 'barnsley' },
];

test('the picker offers one Latte from every site, and ticking it saves every site id', () => {
  const products = groupItemsForPicker(COMPANY_ITEMS);
  const latte = products.find(p => p.key === 'latte');
  assert.equal(latte.siteCount, 2);
  const saved = togglePickGroup(latte, []);
  assert.deepEqual(saved, [{ id: 'leeds-latte', name: 'Latte' }, { id: 'barn-latte', name: 'Latte' }]);
  assert.deepEqual(selectedChips(saved), [{ key: 'latte', name: 'Latte', count: 2 }]);
  assert.equal(pickGroupSelected(latte, [{ id: 'old-site-latte', name: 'Latte' }]), true);   // an older save by name
  assert.deepEqual(togglePickGroup(latte, saved), []);
  assert.deepEqual(removeChip('latte', saved), []);
});

test('the picker groups sizes as "<product> - <size>" across sites', () => {
  const cap = groupItemsForPicker(COMPANY_ITEMS).find(p => p.key === 'cappuccino');
  assert.deepEqual(cap.ids, []);
  const large = cap.variants.find(v => v.name === 'Large');
  assert.equal(large.label, 'Cappuccino - Large');
  assert.deepEqual(large.ids.sort(), ['barn-cap-l', 'leeds-cap-l']);
  assert.equal(cap.variants.find(v => v.name === 'Small').siteCount, 1);
  // What the picker saves redeems on the till at a third site with its own ids.
  const saved = togglePickGroup(large, []);
  const line = { itemId: 'pres-cap-l', parentId: 'pres-cap', name: 'Cappuccino \u2014 Large', price: 3.5 };
  const menu = [{ id: 'pres-cap', name: 'Cappuccino' }, { id: 'pres-cap-l', name: 'Large', parentId: 'pres-cap' }];
  assert.equal(eligibleOrderLines({ eligible_items: saved }, [line], menu).length, 1);
});

// ── categories (v5.9.66: a reward can name CATEGORIES as well as products) ────────────────
import { stageKioskReward as stageKioskRewardCats } from './kioskCheckout.js';
import { eligibleCategoryNames } from './loyaltyMenuMatch.js';

// Barnsley's categories as the online store and kiosk load them (DB rows) ...
const BARN_CATS = [
  { id: 'barn-drinks', label: 'Drinks', parent_id: null, location_id: 'barn' },
  { id: 'barn-coffee', label: 'Coffee', parent_id: 'barn-drinks', location_id: 'barn' },
  { id: 'barn-food', label: 'Food', parent_id: null, location_id: 'barn' },
];
// ... and as the till's store holds them (camelCase, from a config push).
const BARN_STORE_CATS = BARN_CATS.map(({ parent_id, ...c }) => ({ ...c, parentId: parent_id }));
// Saved in the Back Office at LEEDS: the "Drinks / Coffee" path with Leeds' id (Barnsley did not exist).
const FREE_COFFEE = { eligible_categories: [{ id: 'leeds-coffee', name: 'Coffee', path: ['drinks', 'coffee'] }] };
// Saved with Barnsley's own PARENT id only (an older save, no path).
const FREE_DRINKS_ID = { eligible_categories: [{ id: 'barn-drinks', name: 'Drinks' }] };

test('till: a category saved at Leeds by PATH makes the Barnsley coffee free, not the toast', async () => {
  const items = [tillLine('barn-toast', 'Toast', 2.0, { cat: 'barn-food' }), tillLine('barn-latte', 'Latte', 3.2, { cat: 'barn-coffee' })];
  const r = await redeemLoyaltyReward(tillReward(FREE_COFFEE), { customerId: 'c1', items, total: 5.2, menuItems: BARNSLEY_MENU, categories: BARN_CATS });
  assert.equal(r.discount_value, 320);
});

test('till: a saved parent id covers the subcategory through store-shaped rows (ancestor rule)', async () => {
  const items = [tillLine('barn-latte', 'Latte', 3.2, { cat: 'barn-coffee' })];
  const r = await redeemLoyaltyReward(tillReward(FREE_DRINKS_ID), { customerId: 'c1', items, total: 3.2, categories: BARN_STORE_CATS });
  assert.equal(r.discount_value, 320);
});

test('till: nothing from the category on the order refuses and names the category', async () => {
  await assert.rejects(
    redeemLoyaltyReward(tillReward(FREE_COFFEE), { customerId: 'c1', items: [tillLine('barn-toast', 'Toast', 2.0, { cat: 'barn-food' })], total: 2, categories: BARN_CATS }),
    (e) => { assert.match(e.message, /^Add anything from Coffee to the order first/); return true; },
  );
});

test('till: a size with no category on the line takes its parent\'s category from the menu', async () => {
  const menu = [
    { id: 'barn-cap', name: 'Cappuccino', parentId: null, cat: 'barn-coffee' },
    { id: 'barn-cap-l', name: 'Large', parentId: 'barn-cap' },
  ];
  const items = [tillLine('barn-cap-l', 'Cappuccino — Large', 3.8, { parentId: 'barn-cap' })];
  const r = await redeemLoyaltyReward(tillReward(FREE_COFFEE), { customerId: 'c1', items, total: 3.8, menuItems: menu, categories: BARN_CATS });
  assert.equal(r.discount_value, 380);
});

test('till: without category rows a saved category still matches its own id, and only that', async () => {
  const own = { eligible_categories: [{ id: 'barn-coffee', name: 'Coffee' }] };
  const hit = await redeemLoyaltyReward(tillReward(own), { customerId: 'c1', items: [tillLine('barn-latte', 'Latte', 3.2, { cat: 'barn-coffee' })], total: 3.2 });
  assert.equal(hit.discount_value, 320);
  await assert.rejects(redeemLoyaltyReward(tillReward(FREE_COFFEE), { customerId: 'c1', items: [tillLine('barn-latte', 'Latte', 3.2, { cat: 'barn-coffee' })], total: 3.2 }));
});

test('kiosk: the tap check and the live credit honour an eligible category', () => {
  const cart = [
    { item: { id: 'barn-toast', name: 'Toast', cat: 'barn-food' }, qty: 1, linePrice: 2.0 },
    { item: { id: 'barn-latte', name: 'Latte', cat: 'barn-coffee' }, qty: 1, linePrice: 3.2 },
  ];
  const ctx = { cart, goodsMinor: 520, dueMinor: 520, giftMinor: 0, categories: BARN_CATS };
  assert.deepEqual(kioskRewardTapCheck('free_item', FREE_COFFEE, ctx), { discountMinor: 320, error: null });
  assert.equal(kioskLoyaltyCreditMinor({ reward_type: 'free_item', reward_value: FREE_COFFEE }, ctx), 320);
  const foodOnly = { ...ctx, cart: cart.slice(0, 1) };
  assert.match(kioskRewardTapCheck('free_item', FREE_COFFEE, foodOnly).error, /anything from Coffee/);
  assert.equal(kioskRewardMissingItems('free_item', FREE_COFFEE, cart, BARN_CATS), null);
});

test('kiosk: stageKioskReward hands the categories through (new design)', () => {
  const cart = [{ item: { id: 'barn-latte', name: 'Latte', cats: ['barn-coffee'] }, qty: 1, linePrice: 3.2, lineTotal: 3.2 }];
  const ok = stageKioskRewardCats({ id: 'r1', label: 'Free coffee', type: 'free_item', value: FREE_COFFEE }, { cart, discountedSubtotal: 3.2, total: 3.2, categories: BARN_CATS });
  assert.equal(ok.ok, true);
  assert.equal(ok.staged.discount_value, 320);
  const no = stageKioskRewardCats({ id: 'r1', label: 'Free coffee', type: 'free_item', value: FREE_COFFEE }, { cart, discountedSubtotal: 3.2, total: 3.2 });
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'needsItem');
  assert.deepEqual(no.items, ['anything from Coffee']);
});

test('online: a cart line\'s cats array is enough', () => {
  const lines = [{ itemId: 'barn-latte', name: 'Latte', price: 3.2, cats: ['barn-coffee'] }, { itemId: 'barn-toast', name: 'Toast', price: 2, cat: 'barn-food' }];
  assert.deepEqual(eligibleOrderLines(FREE_COFFEE, lines, [], BARN_CATS).map(l => l.itemId), ['barn-latte']);
});

test('categories: configured with categories only; items and categories both count', () => {
  assert.equal(eligibleMatcher(FREE_COFFEE).configured, true);
  assert.equal(eligibleMatcher({ eligible_categories: [] }).configured, false);
  const both = { eligible_items: [{ id: 'x', name: 'Mocha' }], eligible_categories: FREE_COFFEE.eligible_categories };
  const m = eligibleMatcher(both, BARN_CATS);
  assert.equal(m.matches({ ids: [], labels: ['mocha'], catIds: [] }), true);
  assert.equal(m.matches({ ids: [], labels: ['toast'], catIds: ['barn-coffee'] }), true);
  assert.equal(m.matches({ ids: [], labels: ['toast'], catIds: ['barn-food'] }), false);
});

test('categories: names read once each, after the items', () => {
  const v = {
    eligible_items: [{ id: 'a', name: 'Latte' }, { id: 'b', name: 'Latte' }],
    eligible_categories: [{ id: '1', name: 'Coffee', path: ['drinks', 'coffee'] }, { id: '2', name: 'Coffee', path: ['drinks', 'coffee'] }],
  };
  assert.deepEqual(eligibleCategoryNames(v), ['Coffee']);
  assert.deepEqual(eligibleItemNames(v), ['Latte', 'anything from Coffee']);
});
