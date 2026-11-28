// kioskCombo.test.js: a Combo with steps on the kiosk, both designs (5.12.128). Peter, 27 Nov 2026:
// "yes build kiosk". The kiosk keeps one basket line per order line, so its own totals, payment and
// order write (fingerprinted in kioskCardPathGuard.test.js) carry a Combo as they carry any line.
// Proven here: the lines, the money (= the POS's comboTotal), the deals, promo codes, rewards,
// repricing, counts, the order lines written, and that a basket with NO Combo is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kioskComboLines, kioskItemCount, kioskBasketView, kioskWithoutCombo, kioskBasketForCombo } from './kioskCombo.js';
import { kioskOrderItem } from './kioskLine.js';
import { repriceKioskCart } from './kioskBasket.js';
import { kioskAddMode, kioskCardEligible } from './kioskMenu.js';
import { kioskRewardDiscountMinor, kioskRewardMissingItems } from './kioskLoyaltyReward.js';
import { promoBasketLines } from '../../supabase/functions/_shared/promoMath.js';
import { evaluateAutoDiscounts } from './discountEngine.js';
import { comboTotal } from './combo.js';
import { resolveItemPrice } from './menuPricing.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const step = (id, name, selectionType, min, max, pricing, products) => ({ id, name, selectionType, min, max, pricing, products: products.map((p) => (typeof p === 'string' ? { itemId: p, bump: 0 } : p)) });
const STEPS = { v: 1, steps: [step('st-p', 'Pick 2 pizzas', 'quantity', 2, 2, 'set', ['marg', { itemId: 'pep', bump: 1.5 }, 'calz']), step('st-d', 'Drink', 'single', 1, 1, 'own', ['cola'])] };
const row = (id, name, more = {}) => ({ id, name, menu_name: null, parent_id: null, archived: false, type: 'simple', cat: 'c-main', cats: [], pricing: { base: 0 }, ...more });
const ROWS = [
  row('box', 'Pizza box', { type: 'combo', pricing: { base: 20, takeaway: 21 }, combo: STEPS, cat: 'c-box' }),
  row('marg', 'Margherita', { pricing: { base: 9 }, cat: 'c-pizza' }), row('pep', 'Pepperoni', { pricing: { base: 10 }, cat: 'c-pizza' }),
  row('calz', 'Calzone', { type: 'variants' }), row('calz-l', 'Large', { parent_id: 'calz', pricing: { base: 11 } }),
  row('cola', 'Cola', { pricing: { base: 2, takeaway: 2.2 }, cat: 'c-drink' }), row('soup', 'Soup', { pricing: { base: 5 }, cat: 'c-main' }),
];
const BOX = ROWS[0];
const priceFor = (r) => resolveItemPrice(r, 'dineIn', null);
const cheese = { id: 'o-ch', label: 'Extra cheese', name: 'Extra cheese', price: 1 };
const pick = (stepId, entryId, itemId = entryId, mods = []) => ({ key: `${stepId}-${entryId}-${Math.random()}`, stepId, entryId, itemId, mods, notes: '', configured: true });
const PICKS = [pick('st-p', 'marg', 'marg', [cheese]), pick('st-p', 'calz', 'calz-l'), pick('st-d', 'cola')];
const soup = { key: 'soup', item: ROWS[6], variant: null, name: 'Soup', qty: 2, mods: '', modsArray: [], instructions: '', linePrice: 5, lineTotal: 10 };
// The guarded totals block's own sum and deals mapping, as KioskApp.jsx writes them.
const subtotal = (cart) => cart.reduce((a, l) => a + l.lineTotal, 0);
const dealItems = (cart) => cart.map((l, i) => ({ uid: l.key || `l${i}`, cat: l.item?.cat || null, cats: l.item?.cats || null, price: l.linePrice, qty: l.qty || 1, name: l.name || l.item?.name || 'Item', comboRole: l.comboRole, comboId: l.comboId }));

test('a Combo is the kiosk\'s own basket lines: one per order line, options inside the price, keys of their own', () => {
  const lines = kioskComboLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, comboId: 'cb-1' });
  assert.deepEqual(lines.map((l) => [l.item.id, l.variant?.id || null, l.linePrice, l.lineTotal, l.qty, l.comboRole, !!l.noKitchen]), [
    ['box', null, 20, 20, 1, 'parent', true], ['marg', null, 1, 1, 1, 'pick', false], ['calz', 'calz-l', 0, 0, 1, 'pick', false], ['cola', null, 2, 2, 1, 'pick', false],
  ]);
  assert.equal(new Set(lines.map((l) => l.key)).size, 4, 'never merged');
  assert.equal(lines[1].mods, 'Extra cheese');
  assert.equal(lines[2].variant.lineName, 'Calzone — Large');
  // The money the guarded totals sum is the POS's own price for the same Combo.
  const pos = comboTotal({ setPrice: 20, steps: STEPS.steps, picks: PICKS, rowsById: new Map(ROWS.map((r) => [r.id, r])), priceOf: priceFor }).total;
  assert.equal(subtotal(lines), pos);
  assert.equal(subtotal([soup, ...lines]), 10 + pos);
});

test('the order lines written: the Combo words go with the order; a basket with no Combo writes what it always did', () => {
  const lines = kioskComboLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, comboId: 'cb-1' });
  const items = [soup, ...lines].map(kioskOrderItem);
  assert.deepEqual(items.map((o) => [o.id, o.itemId || null, o.price, o.course, o.comboRole || null, o.comboId || null, !!o.noKitchen]), [
    ['soup', null, 5, 1, null, null, false], ['box', 'box', 20, 0, 'parent', 'cb-1', true], ['marg', 'marg', 1, 1, 'pick', 'cb-1', false],
    ['calz-l', 'calz-l', 0, 1, 'pick', 'cb-1', false], ['cola', 'cola', 2, 1, 'pick', 'cb-1', false],
  ]);
  assert.equal(items[2].comboStepId, 'st-p');
  // A plain line: no Combo key at all (byte for byte what the kiosk wrote before).
  for (const k of ['comboId', 'comboRole', 'noKitchen', 'itemId', 'comboStepId']) assert.equal(k in items[0], false, k);
});

test('deals, promo codes and rewards never count a pick; a basket with no Combo gets the very same deals', () => {
  const lines = kioskComboLines({ item: BOX, picks: [pick('st-p', 'marg'), pick('st-p', 'marg'), pick('st-d', 'cola')], rows: ROWS, priceFor, comboId: 'cb-1' });
  const rule = { id: 'r2', name: '2 pizzas, 10% off all', active: true, trigger_type: 'buy_x_all', trigger_category_ids: ['c-pizza'], trigger_qty: 2, reward_type: 'percent', reward_value: 10, reward_qty: 1, priority: 1 };
  const onePizza = { key: 'm1', item: ROWS[1], name: 'Margherita', qty: 1, linePrice: 9, lineTotal: 9 };
  const withCombo = dealItems([onePizza, ...lines]);
  assert.deepEqual(evaluateAutoDiscounts(withCombo, [rule], 'kiosk', {}), [], 'one pizza plus two 0.00 picks: no deal');
  // Without a Combo the two extra keys are undefined and change nothing.
  const plain = dealItems([{ ...onePizza, qty: 2, lineTotal: 18 }]);
  assert.deepEqual(evaluateAutoDiscounts(plain, [rule], 'kiosk', {}), evaluateAutoDiscounts(plain.map(({ comboRole, comboId, ...x }) => x), [rule], 'kiosk', {}));
  assert.equal(evaluateAutoDiscounts(plain, [rule], 'kiosk', {}).length, 1);
  // A promo code: a pick keeps its money and category, never its id (never THE free item).
  const promo = promoBasketLines([soup, ...lines]);
  assert.deepEqual(promo.map((l) => [l.itemId, l.price]), [['soup', 5], ['box', 20], [null, 0], [null, 0], [null, 2]]);
  assert.deepEqual(promoBasketLines([soup]), [{ itemId: 'soup', parentId: null, cat: 'c-main', cats: [], price: 5, qty: 2 }]);
  // A free item reward: never a pick, and a pick never makes one possible.
  const value = { eligible_items: [{ id: 'marg', name: 'Margherita' }] };
  assert.equal(kioskRewardDiscountMinor('free_item', value, { cart: lines, goodsMinor: 2200 }), 0, 'a pick is never the free item');
  assert.equal(kioskRewardMissingItems('free_item', value, lines), 'Margherita', 'a pick never makes the reward possible');
  const plainMarg = [{ key: 'm', item: ROWS[1], name: 'Margherita', qty: 1, linePrice: 9, lineTotal: 9 }];
  assert.equal(kioskRewardDiscountMinor('free_item', value, { cart: plainMarg, goodsMinor: 900 }), 900, 'a plain line as before');
  assert.equal(kioskRewardMissingItems('free_item', value, plainMarg), null);
});

test('repricing keeps a pick\'s rule; an order type that does not sell a pick takes the whole Combo out', () => {
  const lines = kioskComboLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, comboId: 'cb-1' });
  const out = repriceKioskCart([soup, ...lines], ROWS, 'takeaway');
  assert.deepEqual(out.map((l) => l.linePrice), [5, 21, 1, 0, 2.2], 'the set price and a kept price move; a 0.00 pick with an extra stays');
  const noTakeaway = ROWS.map((r) => (r.id === 'cola' ? { ...r, visibility: { notSoldAs: ['takeaway'] } } : r));
  assert.deepEqual(repriceKioskCart([soup, ...lines], noTakeaway, 'takeaway').map((l) => l.key), ['soup']);
  assert.equal(repriceKioskCart([soup], ROWS, 'dineIn')[0], soup, 'a plain line as before');
});

test('the menu, the basket view and the counts', () => {
  assert.equal(kioskCardEligible(BOX), true);
  assert.deepEqual(kioskAddMode(BOX, { items: ROWS }), { mode: 'combo' });
  assert.equal(kioskAddMode(BOX, { items: ROWS, eightySixIds: ['marg', 'pep', 'calz-l'] }).mode, 'soldout', 'nothing to pick for a must step');
  const lines = kioskComboLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, comboId: 'cb-1' });
  const cart = [soup, ...lines];
  assert.equal(kioskItemCount(cart), 3, 'two soups and the Combo once');
  const view = kioskBasketView(cart);
  assert.deepEqual(view.map((l) => [l.name, l.lineTotal, !!l.comboWhole]), [['Soup', 10, false], ['Pizza box', 23, true]]);
  assert.equal(view[1].mods, 'Margherita (Extra cheese), Calzone — Large, Cola');
  assert.deepEqual(kioskWithoutCombo(cart, 'cb-1'), [soup]);
  assert.deepEqual(kioskBasketForCombo([soup])[0], { itemId: 'soup', qty: 2, mods: [], noKitchen: false });
});

test('the wiring: both designs open the steps; the guarded blocks change by one line only', () => {
  const app = read('../surfaces/KioskApp.jsx');
  assert.match(app, /onSelectItem=\{\(item\) => \{ if \(comboHasSteps\(item\)\) \{ setComboItem\(item\); return; \}/);
  assert.match(app, /<OnlineComboSheet size="kiosk" screen="kiosk" item=\{comboItem\}/);
  assert.match(app, /\{kioskBasketView\(cart\)\.map\(l => \{/);
  assert.match(app, /onRemove=\{\(\) => \(l\.comboWhole \? onRemoveCombo\(l\.comboId\) : onUpdate\(l\.key, -l\.qty\)\)\}/);
  assert.match(app, /const cartItemCount = useMemo\(\(\) => kioskItemCount\(cart\), \[cart\]\);/);
  assert.match(app, /      comboRole: l\.comboRole, comboId: l\.comboId,   \/\/ 5\.12\.128/);
  const v2 = read('../surfaces/kiosk/KioskFlowV2.jsx');
  assert.match(v2, /setOverlay\(comboHasSteps\(item\) \? 'combo' : 'item'\);/);
  assert.match(v2, /<OnlineComboSheet size="kiosk" screen="kiosk" item=\{engine\.selectedItem\}/);
  for (const f of ['KioskBasketSheet.jsx', 'KioskReviewScreen.jsx']) assert.match(read(`../surfaces/kiosk/${f}`), /kioskBasketView\(cart\)\.map\(\(line, i\) => \{/);
  assert.match(read('./kioskCardPathGuard.test.js'), /length: 3673,\n\s+sha256: 'd37d1f8981b97828fd546dea3079de69a7697199f211bd9cdcdece9cb69912ef',/);
});
