// comboOnline.test.js: a Combo built from steps on the online page and the catering link (5.12.125,
// stage 3). Peter, 27 Nov 2026: YES to customers building a Combo there, "this is just a combo
// product so yes is the answer thats what we are building these features for".
//
// What is pinned here:
//   1. the basket lines a finished Combo becomes (lib/online/comboCart.js): the Combo's own line at
//      the set price, never to the kitchen; one line per pick, options apart from the price
//   2. they come to exactly what the POS charges for the same Combo (lib/combo.js comboTotal)
//   3. a Combo moves as one in the basket: change, remove, count, an order type that does not sell it
//   4. repricing keeps a pick's rule (bump or its own price)
//   5. what can be picked: 86, daily counts less the basket, Shows on, Sold as, must answer options
//   6. it shows only once the server says it values picks (public_order_features, SQL 20261217a)
//   7. the wiring: both pages and both checkouts, the status page, and catering-release
// The server side is proven on a local database: supabase/tests/combo_online/run.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  comboCartLines, comboPicksInBasket, replaceComboLines, removeBasketLine, basketCount, linesWithoutPicks,
  dropHidden, basketBlocks, customerComboContext, stepGroupIds, comboFieldsOf,
} from './comboCart.js';
import { combosReadyOn, menuHasStepCombos } from './comboReady.js';
import { repriceCartLines, resolveItemPrice } from '../menuPricing.js';
import { channelVisible } from '../channelMenu.js';
import { cateringVisible } from '../cateringPricing.js';
import { comboTotal, comboMissing, entryState, pickNeeds, isComboPick } from '../combo.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const step = (id, name, selectionType, min, max, pricing, products) => ({ id, name, selectionType, min, max, pricing, products: products.map((p) => (typeof p === 'string' ? { itemId: p, bump: 0 } : p)) });
const STEPS = { v: 1, steps: [
  step('st-pizza', 'Pick 3 pizzas', 'quantity', 3, 3, 'set', ['marg', { itemId: 'pep', bump: 1.5 }, 'calz']),
  step('st-side', 'Up to 2 sides', 'multiple_once', 0, 2, 'set', ['bread', 'wings']),
  step('st-drink', 'Pick a drink', 'single', 1, 1, 'own', ['cola', 'lemon']),
] };
const row = (id, name, more = {}) => ({ id, name, menu_name: null, parent_id: null, archived: false, type: 'simple', sold_alone: true, assigned_modifier_groups: [], cat: 'cat-main', cats: [], pricing: { base: 0 }, combo: null, ...more });
const ROWS = [
  row('box', 'Pizza party', { type: 'combo', pricing: { base: 30, delivery: 33 }, combo: STEPS, cat: 'cat-packages', tax_rate_id: 'tr-20' }),
  row('marg', 'Margherita', { pricing: { base: 9 }, assigned_modifier_groups: ['g-extra'], cat: 'cat-pizza' }),
  row('pep', 'Pepperoni', { pricing: { base: 10 }, cat: 'cat-pizza', kitchen_name: 'PEP' }),
  row('calz', 'Calzone', { type: 'variants', pricing: { base: 0 }, cat: 'cat-pizza' }),
  row('calz-s', 'Small', { parent_id: 'calz', pricing: { base: 8 } }),
  row('calz-l', 'Large', { parent_id: 'calz', pricing: { base: 11 } }),
  row('bread', 'Garlic bread', { pricing: {}, cat: 'cat-sides' }),
  row('wings', 'Wings', { pricing: { base: 6 }, cat: 'cat-sides' }),
  row('cola', 'Cola', { pricing: { base: 2, delivery: 2.4 }, cat: 'cat-drinks' }),
  row('lemon', 'Lemonade', { pricing: { base: 2.5 }, cat: 'cat-drinks' }),
  row('soup', 'Soup', { pricing: { base: 5 }, cat: 'cat-sides' }),
];
const BOX = ROWS[0];
const by = (id) => ROWS.find((r) => r.id === id);
const priceFor = (r) => resolveItemPrice(r, 'collection', null);
let n = 0;
const uid = (id) => `${id}-${++n}`;
const pick = (stepId, entryId, itemId = entryId, mods = []) => ({ key: `k${++n}`, stepId, entryId, itemId, mods, notes: '', configured: true });
const cheese = { id: 'o-cheese', name: 'Extra cheese', label: 'Extra cheese', price: 1 };
const PICKS = [pick('st-pizza', 'marg', 'marg', [cheese]), pick('st-pizza', 'pep'), pick('st-pizza', 'calz', 'calz-l'), pick('st-side', 'bread'), pick('st-side', 'wings'), pick('st-drink', 'cola')];
const pageTotal = (lines) => Math.round(lines.reduce((s, l) => s + (l.price + (l.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0)) * (l.qty || 1), 0) * 100) / 100;

test('1. a finished Combo becomes its own line and one line per pick, as a customer page builds every line', () => {
  const lines = comboCartLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, comboId: 'cb-1', menuId: 'menu-1', uid });
  assert.equal(lines.length, 7);
  const [parent, ...picks] = lines;
  assert.deepEqual([parent.itemId, parent.name, parent.price, parent.qty, parent.noKitchen, parent.comboRole, parent.comboId, parent.menuId, parent.cat], ['box', 'Pizza party', 30, 1, true, 'parent', 'cb-1', 'menu-1', 'cat-packages']);
  assert.deepEqual(parent.mods, []);
  // Each pick: its own row, the step's rule as its price (options apart, in mods).
  assert.deepEqual(picks.map((l) => [l.itemId, l.name, l.price, l.mods.length, l.comboStepId, l.comboKeepsPrice, l.comboBump]), [
    ['marg', 'Margherita', 0, 1, 'st-pizza', false, 0],
    ['pep', 'Pepperoni', 1.5, 0, 'st-pizza', false, 1.5],
    ['calz-l', 'Calzone — Large', 0, 0, 'st-pizza', false, 0],
    ['bread', 'Garlic bread', 0, 0, 'st-side', false, 0],
    ['wings', 'Wings', 0, 0, 'st-side', false, 0],
    ['cola', 'Cola', 2, 0, 'st-drink', true, 0],
  ]);
  for (const l of picks) assert.deepEqual([l.comboRole, l.comboId, l.comboName, l.qty, l.menuId, 'noKitchen' in l], ['pick', 'cb-1', 'Pizza party', 1, 'menu-1', false]);
  // The names, categories and tax a line of that product carries anywhere on the page.
  assert.equal(picks[1].kitchenName, 'PEP');
  assert.equal(picks[2].cat, 'cat-pizza', 'a size counts under its product');
  assert.equal(picks[2].parentId, 'calz');
  // The catering link sends the order's menu, not a line's.
  assert.equal('menuId' in comboCartLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, uid })[0], false);
});

test('2. the basket comes to exactly what the POS charges for the same Combo', () => {
  const rowsById = new Map(ROWS.map((r) => [r.id, r]));
  for (const picks of [PICKS, [pick('st-pizza', 'pep'), pick('st-pizza', 'pep'), pick('st-pizza', 'pep'), pick('st-drink', 'lemon')]]) {
    const lines = comboCartLines({ item: BOX, picks, rows: ROWS, priceFor, uid });
    const pos = comboTotal({ setPrice: priceFor(BOX), steps: STEPS.steps, picks, rowsById, priceOf: priceFor }).total;
    assert.equal(pageTotal(lines), pos);
  }
  assert.equal(pageTotal(comboCartLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, uid })), 34.5);
  // The basket's own block says the same.
  const block = basketBlocks([{ uid: 'x', itemId: 'soup', name: 'Soup', price: 5, qty: 2, mods: [] }, ...comboCartLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, uid })]);
  assert.deepEqual(block.map((b) => b.kind), ['line', 'combo']);
  assert.deepEqual([block[1].total, block[1].extras, block[1].picks.length], [34.5, 4.5, 6]);
});

test('3. a Combo moves as one in the basket: change, remove, count, and an order type that does not sell it', () => {
  const soup = { uid: 's1', itemId: 'soup', name: 'Soup', price: 5, qty: 2, mods: [] };
  const tail = { uid: 's2', itemId: 'wings', name: 'Wings', price: 6, qty: 1, mods: [] };
  const box = comboCartLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, comboId: 'cb-1', uid });
  const cart = [soup, ...box, tail];
  assert.equal(basketCount(cart), 4, 'two soups, the Combo once, the wings');
  assert.deepEqual(linesWithoutPicks(cart).map((l) => l.itemId), ['soup', 'box', 'wings']);
  // Opened again with its picks, changed, saved in its place.
  const again = comboPicksInBasket(cart, 'cb-1');
  assert.deepEqual(again.map((p) => [p.stepId, p.entryId, p.itemId, p.mods.length]), PICKS.map((p) => [p.stepId, p.entryId, p.itemId, p.mods.length]));
  const changed = comboCartLines({ item: BOX, picks: [...again.slice(0, 3), again[5]], rows: ROWS, priceFor, comboId: 'cb-1', uid });
  const next = replaceComboLines(cart, 'cb-1', changed);
  assert.deepEqual(next.map((l) => l.itemId), ['soup', 'box', 'marg', 'pep', 'calz-l', 'cola', 'wings']);
  // Remove on any line of it takes all of it; a plain line alone.
  for (const l of box) assert.deepEqual(removeBasketLine(cart, l.uid), [soup, tail]);
  assert.deepEqual(removeBasketLine(cart, 's1'), [...box, tail]);
  // An order type that does not sell one of its picks takes the whole Combo out, named once.
  const r = dropHidden(cart, (l) => l.itemId === 'wings' && isComboPick(l));
  assert.deepEqual([r.kept.map((l) => l.uid), r.gone], [['s1', 's2'], ['Pizza party']]);
  assert.deepEqual(dropHidden(cart, () => false).kept, cart);
  // What a line sends with the order: the Combo words, nothing for any other line.
  assert.deepEqual(Object.keys(comboFieldsOf(box[0])).sort(), ['comboId', 'comboRole', 'noKitchen']);
  assert.deepEqual(Object.keys(comboFieldsOf(box[2])).sort(), ['comboBump', 'comboEntryId', 'comboId', 'comboKeepsPrice', 'comboName', 'comboRole', 'comboStepId', 'comboStepName']);
  assert.deepEqual(comboFieldsOf(soup), {});
});

test('4. an order type change reprices a pick by its own rule: its bump stays, a kept price moves', () => {
  const box = comboCartLines({ item: BOX, picks: PICKS, rows: ROWS, priceFor, uid });
  const out = repriceCartLines(box, ROWS, 'delivery', null);
  assert.deepEqual(out.map((l) => l.price), [33, 0, 1.5, 0, 0, 0, 2.4], 'the set price and the kept price move; the bumps and the 0.00 picks stay');
  assert.equal(out[1], box[1], 'a line that did not move is the same object');
  // Every other line as before.
  const soup = { uid: 's', itemId: 'soup', price: 5, qty: 1, mods: [] };
  assert.equal(repriceCartLines([soup], ROWS, 'delivery', null)[0], soup);
});

test('5. what can be picked on a customer page: 86, daily counts less the basket, Shows on, Sold as, must answer', () => {
  const stock = { marg: { remaining: 2 }, calz: { remaining: 1 } };
  const basket = [{ itemId: 'marg', qty: 1, mods: [] }, { itemId: 'box', qty: 1, noKitchen: true, mods: [] }];
  const ctx = customerComboContext({ item: BOX, rows: ROWS, eightySixIds: ['wings'], stockLevels: stock, basket, orderType: 'collection', modifierGroupDefs: [{ id: 'g-extra', min: 0, max: 2, options: [cheese] }] });
  assert.equal(ctx.remainingOf('marg'), 1, 'the basket holds one already');
  assert.equal(entryState({ itemId: 'wings' }, ctx).state, 'out');
  assert.equal(entryState({ itemId: 'calz' }, ctx).sizes.length, 2);
  assert.equal(entryState({ itemId: 'calz' }, ctx, [pick('st-pizza', 'calz', 'calz-s')]).state, 'out', 'one Calzone of either size left');
  // An optional option group: nothing must be answered. Required: it must.
  assert.equal(ctx.requiresAnswers(by('marg')), false);
  const strict = customerComboContext({ item: BOX, rows: ROWS, modifierGroupDefs: [{ id: 'g-extra', min: 1, max: 2, options: [cheese] }] });
  assert.equal(strict.requiresAnswers(by('marg')), true);
  assert.equal(pickNeeds({ stepId: 'st-pizza', entryId: 'marg', itemId: 'marg', configured: false }, strict), 'options');
  // Still loading the groups: any product with a group is asked, so nothing is skipped.
  assert.equal(customerComboContext({ item: BOX, rows: ROWS }).requiresAnswers(by('marg')), true);
  assert.equal(customerComboContext({ item: BOX, rows: ROWS }).requiresAnswers(by('pep')), false);
  // A product with sizes waits for its size.
  assert.equal(pickNeeds({ stepId: 'st-pizza', entryId: 'calz', itemId: null }, ctx), 'size');
  // Head office hides a product on Online (or on Delivery): it is not offered.
  const hidden = ROWS.map((r) => (r.id === 'lemon' ? { ...r, visibility: { notShownOn: ['onlineDelivery'] } } : r));
  assert.equal(entryState({ itemId: 'lemon' }, customerComboContext({ item: BOX, rows: hidden, fulfilment: 'delivery' })).state, 'hidden');
  assert.equal(entryState({ itemId: 'lemon' }, customerComboContext({ item: BOX, rows: hidden, fulfilment: 'collection' })).state, 'ok');
  // Not sold on this order type: greyed, with the words.
  const noDelivery = ROWS.map((r) => (r.id === 'cola' ? { ...r, visibility: { notSoldAs: ['delivery'] } } : r));
  const dctx = customerComboContext({ item: BOX, rows: noDelivery, orderType: 'delivery' });
  assert.equal(entryState({ itemId: 'cola' }, dctx).state, 'type');
  // The rules every screen shares: a box that is not finished says what is missing.
  assert.match(comboMissing(STEPS.steps, [pick('st-pizza', 'marg')], ctx), /^Pick 3 pizzas: pick 2 more$/);
  assert.equal(comboMissing(STEPS.steps, PICKS.filter((p) => p.entryId !== 'wings'), customerComboContext({ item: BOX, rows: ROWS })), null);
  // The option groups the page loads to ask them: the step products', their sizes', their product's.
  assert.deepEqual(stepGroupIds(BOX, ROWS), ['g-extra']);
});

test('6. a Combo with steps shows on a customer page only once the server values its picks', async () => {
  assert.equal(channelVisible(BOX, 'online'), false, 'not before the page knows');
  assert.equal(channelVisible(BOX, 'online', null, { comboSteps: true }), true);
  for (const ch of ['qr', 'kiosk', 'hubrise', 'delivery', 'bar', 'mpos']) assert.equal(channelVisible(BOX, ch, null, { comboSteps: true }), false, `${ch} has not learned it`);
  assert.equal(channelVisible(BOX, 'pos'), true);
  assert.equal(channelVisible({ ...BOX, visibility: { online: false } }, 'online', null, { comboSteps: true }), false, 'its own switch still counts');
  assert.equal(cateringVisible(BOX, 'collection'), false);
  assert.equal(cateringVisible(BOX, 'collection', { comboSteps: true }), true);
  assert.equal(cateringVisible({ ...BOX, visibility: { onlineDelivery: false } }, 'delivery', { comboSteps: true }), false);
  // Every other product is exactly as before.
  assert.equal(channelVisible(by('soup'), 'online'), true);
  assert.equal(cateringVisible(by('soup'), null), true);
  // The question: yes only when the server says so. A failure is no, and it is asked again.
  let calls = 0;
  const yes = { rpc: async () => { calls++; return { data: { combo_steps: true }, error: null }; } };
  assert.equal(await combosReadyOn(yes), true);
  assert.equal(await combosReadyOn(yes), true);
  assert.equal(calls, 1, 'asked once per page');
  let tries = 0;
  const notRun = { rpc: async () => { tries++; return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.public_order_features' } }; } };
  assert.equal(await combosReadyOn(notRun), false);
  assert.equal(await combosReadyOn(notRun), false);
  assert.equal(tries, 2, 'not run yet: asked again next time');
  assert.equal(await combosReadyOn({ rpc: async () => { throw new Error('offline'); } }), false);
  assert.equal(await combosReadyOn(null), false);
  assert.equal(menuHasStepCombos(ROWS), true);
  assert.equal(menuHasStepCombos(ROWS.filter((r) => r.id !== 'box')), false);
  assert.equal(menuHasStepCombos([{ ...BOX, archived: true }]), false);
});

test('7. the wiring: both pages, both checkouts, the status page and catering-release', () => {
  const online = read('../../surfaces/online/OnlineSurface.jsx');
  assert.match(online, /combosReadyOn\(supabase\)\.then\(\(yes\) => \{ if \(alive && yes\) setCombosReady\(true\); \}\);/);
  assert.match(online, /if \(combosReady \|\| isQr \|\| !menuHasStepCombos\(items\)\) return undefined;/, 'QR never asks (it has not learned Combos)');
  assert.match(online, /\{openItem && combosReady && comboHasSteps\(openItem\) && \(\n\s+<OnlineComboSheet/);
  assert.match(online, /\{openItem && !\(combosReady && comboHasSteps\(openItem\)\) && \(\n\s+<OnlineItemSheet/);
  assert.match(online, /const removeFromCart = \(uid\) => setCart\(c => removeBasketLine\(c, uid\)\);/);
  assert.match(online, /const cartCount = basketCount\(cart\);/);
  assert.match(online, /const lines = comboCartLines\(\{ item, picks, rows: items, priceFor, comboId: editing \|\| newComboId\(\), menuId: effectiveMenuId \|\| null \}\);/);
  assert.match(online, /const gone = dropHidden\(cart, hidden\)\.gone;/);
  assert.match(online, /const addToCart = \(item, mods, qty, notes = ''\) => \{\n(?:\s+\/\/[^\n]*\n)+\s+if \(comboHasSteps\(item\)\) \{ alert\(/, 'a Combo with steps is never a plain line');
  const catering = read('../../surfaces/catering/CateringSurface.jsx');
  assert.match(catering, /combosReadyOn\(supabase\)\.then/);
  assert.match(catering, /\{openItem && combosReady && comboHasSteps\(openItem\) && \(\n\s+<OnlineComboSheet/);
  assert.match(catering, /onRemove=\{\(uid\) => setCart\(\(c\) => removeBasketLine\(c, uid\)\)\}/);
  assert.match(catering, /View basket \(\{basketCount\(cart\)\}\)/);
  assert.match(catering, /if \(n > lim\.max\) \{ alert\(`You've reached the maximum \(\$\{lim\.max\}\) for \$\{l\.name\}\.`\); return; \}/);
  // The lines the server gets carry the Combo words; deals, promo codes and rewards never read a pick.
  const oc = read('../../surfaces/online/OnlineCheckout.jsx');
  assert.match(oc, /course: l\.noKitchen \? 0 : 1,\n\s+\.\.\.comboFieldsOf\(l\),/);
  assert.match(oc, /const items = linesWithoutPicks\(cart\)\.map\(\(l, i\) => \(\{/);
  assert.equal((oc.match(/promoBasketLines\(linesWithoutPicks\(cart\), \{ modsInPrice: false \}\)/g) || []).length, 2);
  assert.ok(!/promoBasketLines\(cart,/.test(oc));
  assert.match(oc, /const cheapest = \[\.\.\.linesWithoutPicks\(cart\)\]\.sort/);
  assert.equal((oc.match(/\{displayOrder\(cart\)\.map\(line => \{/g) || []).length, 3, 'every order summary shows a Combo with its picks under it');
  const cc = read('../../surfaces/catering/CateringCheckout.jsx');
  assert.match(cc, /course: l\.noKitchen \? 0 : 1, \.\.\.comboFieldsOf\(l\) \}\)\);/);
  assert.equal((cc.match(/promoBasketLines\(linesWithoutPicks\(cart\), \{ modsInPrice: false \}\)/g) || []).length, 2);
  assert.match(cc, /\{displayOrder\(P\.items\)\.map\(\(it, i\) => \{/);
  assert.match(read('../../surfaces/online/OrderTracker.jsx'), /\{displayOrder\(order\.items \|\| \[\]\)\.map\(\(line, i\) => \{/);
  assert.match(read('../../surfaces/online/OnlineCart.jsx'), /\{basketBlocks\(cart\)\.map\(block => \{/);
  // A catering order released to the kitchen never puts the Combo's own line on the ticket.
  const rel = read('../../../supabase/functions/catering-release/index.ts');
  assert.match(rel, /const kitchenItems = \(Array\.isArray\(row\.items\) \? row\.items : \[\]\)\.filter\(\(i: any\) => !\(i && typeof i === 'object' && i\.noKitchen\)\);/);
  assert.match(rel, /items: kitchenItems,/);
  // The sheet draws the shared rules, never its own.
  const sheet = read('../../surfaces/online/OnlineComboSheet.jsx');
  for (const fn of ['stepEntries', 'tapEntry', 'untapEntry', 'comboMissing', 'comboTotal', 'pickNeeds', 'startingPicks', 'pickFlowSetup', 'customerComboContext']) assert.match(sheet, new RegExp(`\\b${fn}\\(`), fn);
  assert.match(sheet, /maxHeight: 'min\(94vh, calc\(100% - 12px\)\)'/);
});
