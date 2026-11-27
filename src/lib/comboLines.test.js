// comboLines.test.js: a finished Combo as real POS order lines (lib/comboLines.js), and the money,
// tax, deals and totals that follow from them.
//   A  Build Your Own Package 149.00 ... = 178.50 before tax: the lines, what the bill charges,
//      the tax, an order type switch
//   B/E  what a product's own options ask (sizes, a group that must be answered)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comboOrderLines, changedPickLine, repricedPickLine, comboPosContext, optionFacts, tillLineBase, lineCourse, pickBaseOf } from './comboLines.js';
import { comboMissing, comboUnsellable, entryState, comboSteps, picksFromLines, comboLinesTotal, isComboParent, isComboPick, cents } from './combo.js';
import { kitchenOverride, receiptOverride } from './itemDisplay.js';
import { tillLineCat, tillLineTaxRefs, tillLineTaxFields } from './tillLine.js';
import { resolveItemPrice } from './menuPricing.js';
import { computeCheckTotals } from './payments/checkTotals.js';
import { evaluateAutoDiscounts } from './discountEngine.js';
import { stickerUnits } from './itemSticker.js';

const CATS = [
  { id: 'cat-pizza', label: 'Pizza', defaultCourse: 2 },
  { id: 'cat-bread', label: 'Breads', defaultCourse: 1 },
  { id: 'cat-salad', label: 'Salads', defaultCourse: 1 },
  { id: 'cat-drink', label: 'Drinks', defaultCourse: 0 },
  { id: 'cat-cater', label: 'Catering', defaultCourse: 1 },
];
const RATES = [{ id: 'r-food', name: 'Prepared food', rate: 0.0845, type: 'exclusive', isDefault: true, active: true, locationId: 'L1' }];
const row = (id, name, price, cat, extra = {}) => ({ id, name, menuName: name, kitchenName: name, receiptName: name, type: 'simple', pricing: { base: price }, price, cat, archived: false, allergens: [], ...extra });
const MENU = [
  row('p-marg', 'Margherita', 16, 'cat-pizza', { allergens: ['milk', 'gluten'], centreId: 'pc3' }),
  row('p-pep', 'Pepperoni', 18, 'cat-pizza', { kitchenName: 'PEP', centreId: 'pc3' }),
  row('p-veg', 'Veggie', 17, 'cat-pizza'), row('p-bbq', 'BBQ Chicken', 19, 'cat-pizza'), row('p-speck', 'Speck', 20, 'cat-pizza'),
  row('b-cheese', 'Cheese Bread', 9, 'cat-bread'), row('b-garlic', 'Garlic Bread', 8, 'cat-bread'),
  row('s-caesar', 'Caesar Salad Catering Size', 45, 'cat-salad', { type: 'modifiable', assignedModifierGroups: [{ groupId: 'g-protein' }] }),
  row('s-med', 'Mediterranean Salad', 45, 'cat-salad'), row('s-mac', 'Mac and Cheese', 40, 'cat-salad'),
  row('d-six', 'Soda Six Pack', 20, 'cat-drink', { pricing: { base: 20, delivery: 22 } }), row('d-water', 'Water Case', 18, 'cat-drink'),
  row('z-wings', 'Wings', 0, 'cat-salad', { type: 'variants' }),
  row('z-wings-s', 'Small', 9, 'cat-other', { parentId: 'z-wings', kitchenName: 'Small' }),
  row('z-wings-l', 'Large', 15, 'cat-other', { parentId: 'z-wings', kitchenName: 'Large', assignedInstructionGroups: [{ groupId: 'ig-heat', min: 1 }] }),
  row('x-dip', 'Ranch Dip', 1, 'cat-salad', { type: 'subitem', soldAlone: true }),
];
const STEPS = [
  { id: 'pizzas', name: 'Pick 5 pizzas', selectionType: 'quantity', min: 5, max: 5, pricing: 'set', products: [{ itemId: 'p-marg' }, { itemId: 'p-pep' }, { itemId: 'p-veg' }, { itemId: 'p-bbq' }, { itemId: 'p-speck', bump: 2.5 }] },
  { id: 'breads', name: 'Pick 2 breads', selectionType: 'quantity', min: 2, max: 2, pricing: 'set', products: [{ itemId: 'b-cheese' }, { itemId: 'b-garlic' }] },
  { id: 'sides', name: 'Pick your sides', selectionType: 'multiple', min: 1, max: 4, pricing: 'set', products: [{ itemId: 's-caesar' }, { itemId: 's-med' }, { itemId: 's-mac' }, { itemId: 'z-wings' }] },
  { id: 'drinks', name: 'Add drinks?', selectionType: 'multiple', min: 0, max: 99, pricing: 'own', products: [{ itemId: 'd-six' }, { itemId: 'd-water' }] },
];
const BYO = row('c-byo', 'Build Your Own Package', 149, 'cat-cater', { type: 'combo', pricing: { base: 149, delivery: 159 }, combo: { v: 1, steps: STEPS } });
const ALL = [...MENU, BYO];
const GROUPS = [{ id: 'g-protein', name: 'Add Protein?', min: 0, max: 1, selectionType: 'single', options: [{ id: 'o-ch', name: 'Chicken', price: 8 }] }];
const INST = [{ id: 'ig-heat', name: 'How hot?', options: ['Mild', 'Hot'] }];
let n = 0;
const uid = () => `cl-${++n}`;
const pick = (stepId, entryId, extra = {}) => ({ key: `k${++n}`, stepId, entryId, itemId: entryId, mods: [], notes: '', answers: null, configured: false, ...extra });
const picksA = () => [
  pick('pizzas', 'p-marg'), pick('pizzas', 'p-marg'),
  pick('pizzas', 'p-pep', { mods: [{ id: 'o-xc', name: 'Extra cheese', label: 'Extra cheese', price: 1.5 }], configured: true }),
  pick('pizzas', 'p-veg'), pick('pizzas', 'p-bbq'),
  pick('breads', 'b-cheese'), pick('breads', 'b-garlic'),
  pick('sides', 's-caesar', { mods: [{ id: 'o-ch', name: 'Chicken', label: 'Chicken', price: 8, groupLabel: 'Add Protein?' }], configured: true }),
  pick('drinks', 'd-six'),
];
const build = (orderType = 'dine-in', picks = picksA()) => comboOrderLines({
  item: BYO, comboId: 'cmb-1', picks, setPrice: resolveItemPrice(BYO, orderType, null), priceOf: (r) => resolveItemPrice(r, orderType, null),
  uid, menuItems: ALL, menuCategories: CATS, taxRates: RATES,
});

test('A: the Combo is one line with the set price that never reaches the kitchen, plus one real line per pick', () => {
  const { lines } = build();
  assert.equal(lines.length, 10);
  const [parent, ...picks] = lines;
  assert.equal(isComboParent(parent), true);
  assert.equal(parent.itemId, 'c-byo');
  assert.equal(parent.price, 149);
  assert.equal(parent.noKitchen, true);
  assert.equal(parent.course, 0); assert.equal(parent.fired, true);       // it never holds a course
  assert.equal(parent.cat, 'cat-cater');                                 // it reports and is taxed as its own product
  assert.equal(parent.qty, 1); assert.equal(parent.status, 'pending'); assert.equal(parent.seat, 'shared');
  assert.ok(picks.every(isComboPick));
  assert.ok(picks.every((l) => l.comboId === 'cmb-1' && l.qty === 1 && l.status === 'pending' && l.noKitchen === undefined));
  assert.equal(new Set(lines.map((l) => l.uid)).size, 10);                // every line its own uid
  assert.equal(comboLinesTotal(lines), 178.5);
  assert.deepEqual(picks.map((l) => l.price), [0, 0, 1.5, 0, 0, 0, 0, 8, 20]);
});

test('a pick is the line the counter would ring for that product: its names, category, tax, course and allergens', () => {
  const { lines } = build();
  const marg = lines[1];
  const src = ALL.find((r) => r.id === 'p-marg');
  assert.equal(marg.itemId, 'p-marg');
  assert.equal(marg.name, 'Margherita');
  assert.equal(marg.kitchenName, kitchenOverride(src));
  assert.equal(marg.receiptName, receiptOverride(src));
  assert.equal(marg.cat, tillLineCat(src, ALL));
  assert.deepEqual({ taxRateId: marg.taxRateId, taxOverrides: marg.taxOverrides }, tillLineTaxFields(tillLineTaxRefs(src, ALL, RATES)));
  assert.deepEqual(marg.allergens, ['milk', 'gluten']);
  assert.equal(marg.centreId, 'pc3');
  assert.equal(marg.course, 2); assert.equal(marg.fired, false);          // the pizza category's own course
  assert.equal(lines[3].kitchenName, 'PEP');                              // a real kitchen name override rides along
  assert.equal(lines[6].course, 1);                                       // bread
  assert.equal(lines[9].course, 0); assert.equal(lines[9].fired, true);   // a drink fires at once, like any drink
  assert.equal(lineCourse(src, ALL, CATS), 2);
  assert.deepEqual(Object.keys(tillLineBase(src, { menuItems: ALL, menuCategories: CATS, taxRates: RATES }).fields).sort(),
    ['allergens', 'cat', 'centreId', 'course', 'fired', 'kitchenName', 'parentId', 'receiptName', 'taxOverrides', 'taxRateId'].sort());
});

test('a pick with a size is the size\'s own row and reports under its product', () => {
  const picks = [...picksA(), pick('sides', 'z-wings', { itemId: 'z-wings-l', mods: [{ groupLabel: 'How hot?', label: 'Hot', price: 0, _instruction: true }], configured: true })];
  const { lines } = build('dine-in', picks);
  const wings = lines.find((l) => l.itemId === 'z-wings-l');
  assert.equal(wings.name, 'Wings — Large');
  assert.equal(wings.parentId, 'z-wings');
  assert.equal(wings.cat, 'cat-salad');                                   // the product's category, never the size row's
  assert.equal(wings.comboEntryId, 'z-wings');
  assert.equal(wings.price, 0);                                           // part of the set price whatever the size costs
  assert.equal(wings.mods[0]._instruction, true);
});

test('A: the bill charges 178.50 and the tax is the tax on 178.50 (0.00 picks add nothing, extras are taxed)', () => {
  const { lines } = build();
  const t = computeCheckTotals({ items: lines, checkDiscounts: [], covers: 1, orderType: 'takeaway', deviceConfig: {}, discountRules: [], taxRates: RATES });
  assert.equal(cents(t.subtotal), 178.5);
  assert.equal(t.itemCount, 10);
  assert.equal(cents(t.exclusiveTax), cents(178.5 * 0.0845));
  assert.equal(cents(t.total), cents(178.5 + 178.5 * 0.0845));
  // A check discount takes its percent of the whole bill, the Combo and its extras included.
  const d = computeCheckTotals({ items: lines, checkDiscounts: [{ id: 'd', type: 'percent', value: 10 }], covers: 1, orderType: 'takeaway', deviceConfig: {}, discountRules: [] });
  assert.equal(cents(d.checkDiscount), 17.85);
  // Service charge is worked on the whole Combo too.
  const s = computeCheckTotals({ items: lines, checkDiscounts: [], covers: 2, orderType: 'dine-in', deviceConfig: { serviceCharge: { enabled: true, rate: 10 } }, discountRules: [] });
  assert.equal(cents(s.service), 17.85);
});

test('A: a line discount on the Combo comes off every line of it (percent), the totals follow', () => {
  const { lines } = build();
  const half = lines.map((l) => ({ ...l, discount: { id: 'x', type: 'percent', value: 50 } }));
  const t = computeCheckTotals({ items: half, checkDiscounts: [], covers: 1, orderType: 'takeaway', deviceConfig: {}, discountRules: [] });
  assert.equal(cents(t.subtotal), 89.25);
});

test('picks never trigger or take an automatic deal; the Combo\'s own line is an ordinary product', () => {
  const { lines } = build();
  const loosePizza = { uid: 'i1', itemId: 'p-speck', name: 'Speck', cat: 'cat-pizza', price: 20, qty: 1, status: 'pending' };
  const loose2 = { uid: 'i2', itemId: 'p-bbq', name: 'BBQ Chicken', cat: 'cat-pizza', price: 19, qty: 1, status: 'pending' };
  const bogo = [{ id: 'r1', name: 'Pizza BOGOF', active: true, triggerType: 'buy_x', triggerQty: 1, rewardQty: 1, rewardType: 'free', rewardValue: 100, triggerCategoryIds: ['cat-pizza'] }];
  // Two pizzas rung up on their own beside a Combo of five: the cheaper of THOSE TWO is free.
  const got = evaluateAutoDiscounts([...lines, loosePizza, loose2], bogo, 'pos');
  assert.equal(got.length, 1);
  assert.equal(got[0].totalSaving, 19);
  assert.deepEqual(got[0].appliedItems.map((a) => a.uid), ['i2']);
  // One pizza on its own beside the Combo: no deal (the five picks do not make up the pair).
  assert.deepEqual(evaluateAutoDiscounts([...lines, loosePizza], bogo, 'pos'), []);
  // "Any 6 pizzas, 15% off": five picks and one bought pizza is not six bought pizzas.
  const six = [{ id: 'r2', name: 'Six', active: true, triggerType: 'buy_x_all', triggerQty: 6, rewardType: 'percent', rewardValue: 15, triggerCategoryIds: ['cat-pizza'] }];
  assert.deepEqual(evaluateAutoDiscounts([...lines, loosePizza], six, 'pos'), []);
  // A pick that keeps its price is still a pick: a drinks deal does not reach inside the Combo.
  const drinks = [{ id: 'r3', name: 'Drinks 20%', active: true, triggerType: 'buy_x_all', triggerQty: 1, rewardType: 'percent', rewardValue: 20, triggerCategoryIds: ['cat-drink'] }];
  assert.deepEqual(evaluateAutoDiscounts(lines, drinks, 'pos'), []);
  // A deal on the Combo's own category reaches the Combo's own line, as for any product.
  const cater = [{ id: 'r4', name: 'Catering 10%', active: true, triggerType: 'buy_x_all', triggerQty: 1, rewardType: 'percent', rewardValue: 10, triggerCategoryIds: ['cat-cater'] }];
  const c = evaluateAutoDiscounts(lines, cater, 'pos');
  assert.equal(c[0].totalSaving, 14.9);
  assert.deepEqual(c[0].appliedItems.map((a) => a.uid), [lines[0].uid]);
});

test('the kitchen counts one sticker per pick and none for the Combo', () => {
  const { lines } = build();
  assert.equal(stickerUnits(lines), 9);
});

test('A: an order type switch never reprices a pick that is part of the set price; one that keeps its price follows the order type', () => {
  const { lines } = build('dine-in');
  const priceOf = (r) => resolveItemPrice(r, 'delivery', null);
  const byId = new Map(ALL.map((r) => [r.id, r]));
  const after = lines.map((l) => (isComboPick(l) ? repricedPickLine(l, byId.get(l.itemId), priceOf) : l));
  assert.deepEqual(after.slice(1).map((l) => l.price), [0, 0, 1.5, 0, 0, 0, 0, 8, 22]);   // only the six pack moved: 20.00 to its delivery 22.00
  assert.equal(after[1], lines[1]);                                       // an unchanged line is the same object
  assert.equal(repricedPickLine(lines[0], BYO, priceOf), lines[0]);       // the Combo's own line is not a pick
  // A pick whose product has gone keeps the price it has.
  assert.equal(repricedPickLine(lines[9], undefined, priceOf), lines[9]);
  // A bump and an option stay on a set price pick whatever the order type.
  const speck = build('dine-in', [...picksA().slice(0, 4), pick('pizzas', 'p-speck', { mods: [{ label: 'Extra', price: 1 }] }), ...picksA().slice(5)]).lines.find((l) => l.itemId === 'p-speck');
  assert.equal(speck.price, 3.5);
  assert.equal(repricedPickLine(speck, byId.get('p-speck'), priceOf).price, 3.5);
});

test('changing a pick on the order: its options replace the old ones and its price follows its own rule', () => {
  const { lines } = build();
  const caesar = lines.find((l) => l.itemId === 's-caesar');
  const priceOf = (r) => resolveItemPrice(r, 'dine-in', null);
  const ctx = { priceOf, menuItems: ALL, menuCategories: CATS, taxRates: RATES };
  const plain = changedPickLine({ line: caesar, target: ALL.find((r) => r.id === 's-caesar'), mods: [], notes: ' no croutons ', ...ctx });
  assert.equal(plain.price, 0);
  assert.equal(plain.notes, 'no croutons');
  assert.deepEqual(plain.mods, []);
  assert.equal(plain.uid, caesar.uid);
  assert.equal(plain.comboId, 'cmb-1');
  assert.equal('optionAnswers' in plain, false);
  // A pick that keeps its price: the product's price plus its options.
  const six = lines.find((l) => l.itemId === 'd-six');
  assert.equal(changedPickLine({ line: six, target: ALL.find((r) => r.id === 'd-six'), mods: [{ label: 'Chilled', price: 0.5 }], ...ctx }).price, 20.5);
  // A new size: the line becomes that size's row, keeps its course and seat, and stays in the Combo.
  const wingsPicks = [...picksA(), pick('sides', 'z-wings', { itemId: 'z-wings-s', configured: true })];
  const small = build('dine-in', wingsPicks).lines.find((l) => l.itemId === 'z-wings-s');
  const moved = { ...small, course: 3, seat: 2 };
  const large = changedPickLine({ line: moved, target: ALL.find((r) => r.id === 'z-wings-l'), mods: [], answers: { v: 'z-wings-l' }, ...ctx });
  assert.equal(large.itemId, 'z-wings-l');
  assert.equal(large.name, 'Wings — Large');
  assert.equal(large.kitchenName, null);                                  // "Large" is only the size: the kitchen reads the full name
  assert.equal(large.course, 3); assert.equal(large.seat, 2);
  assert.equal(large.comboEntryId, 'z-wings');
  assert.deepEqual(large.optionAnswers, { v: 'z-wings-l' });
  assert.equal(changedPickLine({ line: lines[0], target: BYO, ...ctx }), null);   // the Combo's own line is not a pick
  assert.equal(changedPickLine({ line: caesar, target: null, ...ctx }), null);
});

test('E: what a product\'s own options ask (the POS option flow\'s rules)', () => {
  const f = (id, extra = {}) => optionFacts(ALL.find((r) => r.id === id), { menuItems: ALL, modifierGroupDefs: GROUPS, instructionGroupDefs: INST, ...extra });
  assert.deepEqual(f('p-marg'), { hasOptions: false, requiresAnswers: false });
  assert.deepEqual(f('s-caesar'), { hasOptions: true, requiresAnswers: false });           // Add Protein? can be skipped
  assert.deepEqual(f('s-caesar', { modifierGroupDefs: [{ ...GROUPS[0], min: 1 }] }), { hasOptions: true, requiresAnswers: true });
  assert.deepEqual(f('z-wings'), { hasOptions: true, requiresAnswers: true });             // a size must be picked
  assert.deepEqual(f('z-wings-l'), { hasOptions: true, requiresAnswers: true });           // its own required instruction
  assert.deepEqual(f('z-wings-s'), { hasOptions: false, requiresAnswers: false });
  // A group the venue no longer has asks nothing.
  assert.deepEqual(f('s-caesar', { modifierGroupDefs: [] }), { hasOptions: false, requiresAnswers: false });
  assert.deepEqual(optionFacts(null), { hasOptions: false, requiresAnswers: false });
  // A size with no groups of its own uses its product's (rule 2).
  const menu = ALL.map((r) => (r.id === 'z-wings' ? { ...r, assignedModifierGroups: [{ groupId: 'g-protein' }] } : r));
  assert.equal(optionFacts(menu.find((r) => r.id === 'z-wings-s'), { menuItems: menu, modifierGroupDefs: [{ ...GROUPS[0], min: 1 }], instructionGroupDefs: INST }).requiresAnswers, true);
});

test('F: the POS context: 86, daily counts, Sold as and head office\'s Shows on, from the store\'s own state', () => {
  const ctx = (extra = {}) => comboPosContext({ item: BYO, menuItems: ALL, eightySixIds: [], dailyCounts: {}, orderType: 'takeaway', modifierGroupDefs: GROUPS, instructionGroupDefs: INST, ...extra });
  assert.equal(comboUnsellable(BYO, ctx()), null);
  assert.equal(comboMissing(STEPS, picksA(), ctx()), null);
  assert.equal(ctx().sizesOf('z-wings').length, 2);
  assert.equal(ctx().requiresAnswers(ALL.find((r) => r.id === 'z-wings')), true);
  assert.equal(ctx().hasOptions(ALL.find((r) => r.id === 's-caesar')), true);
  // 86.
  const off = ctx({ eightySixIds: ['b-cheese'] });
  assert.equal(entryState({ itemId: 'b-cheese' }, off).state, 'out');
  assert.equal(comboMissing(STEPS, picksA(), off), "Cheese Bread is 86'd");
  // A daily count: one Margherita left, the Combo asks for two.
  const one = ctx({ dailyCounts: { 'p-marg': { par: 10, remaining: 1 } } });
  assert.equal(comboMissing(STEPS, picksA(), one), 'Only 1 × Margherita left');
  // The units a Combo already on the order holds count as free while it is changed.
  assert.equal(comboMissing(STEPS, picksA(), ctx({ dailyCounts: { 'p-marg': { par: 10, remaining: 0 } }, giveBack: new Map([['p-marg', 2]]) })), null);
  // Sold as: the six pack is not sold for takeaway.
  const menu = ALL.map((r) => (r.id === 'd-six' ? { ...r, visibility: { notSoldAs: ['takeaway'] } } : r));
  const noSix = ctx({ menuItems: menu });
  assert.equal(entryState({ itemId: 'd-six' }, noSix).state, 'type');
  assert.equal(entryState({ itemId: 'd-six' }, noSix).words, 'Soda Six Pack is not available for Takeaway.');
  assert.equal(comboMissing(STEPS, picksA(), noSix), 'Soda Six Pack is not available for Takeaway.');
  assert.equal(entryState({ itemId: 'd-six' }, ctx({ menuItems: menu, orderType: 'dine-in' })).state, 'ok');
  // Head office hides the Speck on the POS: it is not offered (the same rule as an option linked to it).
  const hid = ctx({ menuItems: ALL.map((r) => (r.id === 'p-speck' ? { ...r, visibility: { pos: false, notShownOn: ['pos'] } } : r)) });
  assert.equal(entryState({ itemId: 'p-speck' }, hid).state, 'hidden');
  // The site's own POS switch alone does not: the venue put the product in the step.
  const plainOff = ctx({ menuItems: ALL.map((r) => (r.id === 'p-speck' ? { ...r, visibility: { pos: false } } : r)) });
  assert.equal(entryState({ itemId: 'p-speck' }, plainOff).state, 'ok');
});

test('the picks of the lines build the same lines again (another the same)', () => {
  const { lines } = build();
  const again = comboOrderLines({ item: BYO, comboId: 'cmb-2', picks: picksFromLines(lines), setPrice: 149, priceOf: (r) => resolveItemPrice(r, 'dine-in', null), uid, menuItems: ALL, menuCategories: CATS, taxRates: RATES }).lines;
  assert.deepEqual(again.map((l) => [l.itemId, l.price, l.comboRole, l.mods.length]), lines.map((l) => [l.itemId, l.price, l.comboRole, l.mods.length]));
  assert.ok(again.every((l) => l.comboId === 'cmb-2'));
  assert.ok(again.every((l, i) => l.uid !== lines[i].uid));
  assert.equal(comboSteps(BYO).length, 4);
});

test('what a pick\'s rule adds before its options: nothing, its bump, or its own price', () => {
  const { lines } = build('dine-in', [...picksA().slice(0, 4), pick('pizzas', 'p-speck'), ...picksA().slice(5)]);
  assert.deepEqual(pickBaseOf(lines.find((l) => l.itemId === 'p-marg'), BYO, 16), { base: 0, bump: 0 });
  assert.deepEqual(pickBaseOf(lines.find((l) => l.itemId === 'p-speck'), BYO, 20), { base: 0, bump: 2.5 });
  assert.deepEqual(pickBaseOf(lines.find((l) => l.itemId === 'd-six'), BYO, 20), { base: 20, bump: 0 });
  // The step has gone from the Combo since: the line's own record answers.
  assert.deepEqual(pickBaseOf({ comboStepId: 'gone', comboKeepsPrice: true, comboBump: 0 }, BYO, 7), { base: 7, bump: 0 });
});
