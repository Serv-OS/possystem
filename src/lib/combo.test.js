// combo.test.js: the Combo rules (lib/combo.js), with Peter's scenarios pinned.
//   A  Build Your Own Package 149.00 (5 pizzas, one repeated, one with a 1.50 extra; 2 breads;
//      Caesar with Chicken +8.00; one six pack that keeps its price 20.00) = 178.50
//   B  a fixed Combo adds in one tap
//   C  Lunch Combo 12.00 with a +2.50 bump
//   D  a Combo with no steps is exactly the product it was
//   E  a pick with a required option cannot be skipped
//   F  a sold out pick, and a daily count a Combo would overrun
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONCE_EACH as COMBO_ONCE_EACH, UNLIMITED, PRICING_OWN, PRICING_SET,
  normaliseStep, comboStepsOf, comboSteps, comboHasSteps, comboColumnValue,
  stepRule, ruleWords, stepSentence, stepForm, stepWithForm, newStep,
  stepProductBlock, stepsEditBlock, comboWarnings,
  unitsUsed, entryState, stepEntries,
  stepStatus, stepNeedWords, stepCountWords, canPick, tapEntry, untapEntry,
  fixedAnswer, comboIsFixed, startingPicks, pickNeeds,
  pickPrice, comboTotal, comboMissing, comboUnsellable,
  pickLineName, comboLinePlan, picksFromLines,
  comboUids, comboLinesOf, comboIsSent, comboLinesTotal, orderBlocks, wholeCombos, keepsCombosWhole,
  isComboParent, isComboPick, isComboLine, comboPosOnly, comboNotHereWords, COMBO_WORDS, cents,
} from './combo.js';
import { ONCE_EACH } from './choiceKinds.js';
import { isOptionOnlyItem } from './menuRules.js';

// ── A small menu ────────────────────────────────────────────────────────────
const row = (id, name, price, extra = {}) => ({ id, name, menuName: name, type: 'simple', pricing: { base: price }, price, archived: false, ...extra });
const MENU = [
  row('p-marg', 'Margherita', 16), row('p-pep', 'Pepperoni', 18), row('p-veg', 'Veggie', 17), row('p-bbq', 'BBQ Chicken', 19), row('p-speck', 'Speck', 20),
  row('b-cheese', 'Cheese Bread', 9), row('b-garlic', 'Garlic Bread', 8),
  row('s-caesar', 'Caesar Salad Catering Size', 45, { type: 'modifiable', assignedModifierGroups: [{ groupId: 'g-protein' }] }),
  row('s-med', 'Mediterranean Salad', 45), row('s-mac', 'Mac and Cheese', 40),
  row('d-six', 'Soda Six Pack', 20), row('d-water', 'Water Case', 18),
  row('z-wings', 'Wings', 0, { type: 'variants' }),
  row('z-wings-s', 'Small', 9, { parentId: 'z-wings' }), row('z-wings-l', 'Large', 15, { parentId: 'z-wings' }),
  row('x-noice', 'No Ice', 0, { type: 'subitem', soldAlone: false }),
  row('x-dip', 'Ranch Dip', 1, { type: 'subitem', soldAlone: true }),
  row('c-other', 'Other Combo', 30, { type: 'combo', combo: { steps: [{ id: 's', products: ['p-marg'] }] } }),
  row('old-pie', 'Old Pie', 10, { archived: true }),
];
const rowsById = new Map(MENU.map((r) => [r.id, r]));
const sizesOf = (id) => MENU.filter((r) => r.parentId === id && !r.archived);
const priceOf = (r) => r.pricing.base;

const BYO_STEPS = [
  { id: 'pizzas', name: 'Pick 5 pizzas', selectionType: 'quantity', min: 5, max: 5, pricing: 'set', products: [{ itemId: 'p-marg' }, { itemId: 'p-pep' }, { itemId: 'p-veg' }, { itemId: 'p-bbq' }, { itemId: 'p-speck', bump: 2.5 }] },
  { id: 'breads', name: 'Pick 2 breads', selectionType: 'quantity', min: 2, max: 2, pricing: 'set', products: [{ itemId: 'b-cheese' }, { itemId: 'b-garlic' }] },
  { id: 'sides', name: 'Pick your sides', selectionType: 'multiple', min: 1, max: 4, pricing: 'set', products: [{ itemId: 's-caesar' }, { itemId: 's-med' }, { itemId: 's-mac' }] },
  { id: 'drinks', name: 'Add drinks?', selectionType: 'multiple', min: 0, max: 99, pricing: 'own', products: [{ itemId: 'd-six' }, { itemId: 'd-water' }] },
];
const BYO = row('c-byo', 'Build Your Own Package', 149, { type: 'combo', combo: { v: 1, steps: BYO_STEPS } });
const ctx = (extra = {}) => ({ rowsById, sizesOf, ...extra });
let k = 0;
const pick = (stepId, entryId, extra = {}) => ({ key: `k${++k}`, stepId, entryId, itemId: entryId, mods: [], notes: '', answers: null, configured: false, ...extra });

// Scenario A's picks.
const picksA = () => [
  pick('pizzas', 'p-marg'), pick('pizzas', 'p-marg'),
  pick('pizzas', 'p-pep', { mods: [{ id: 'o-xc', name: 'Extra cheese', label: 'Extra cheese', price: 1.5, groupLabel: 'Extra cheese' }], configured: true }),
  pick('pizzas', 'p-veg'), pick('pizzas', 'p-bbq'),
  pick('breads', 'b-cheese'), pick('breads', 'b-garlic'),
  pick('sides', 's-caesar', { mods: [{ id: 'o-ch', name: 'Chicken', label: 'Chicken', price: 8, groupLabel: 'Add Protein?' }], configured: true }),
  pick('drinks', 'd-six'),
];

// ── The shape ───────────────────────────────────────────────────────────────

test('the once each word is the option groups own word', () => {
  assert.equal(COMBO_ONCE_EACH, ONCE_EACH);
});

test('a step is always given a valid rule, whatever was saved', () => {
  assert.deepEqual(normaliseStep({ selectionType: 'single', min: 4, max: 9 }, 0), { id: 'step-1', name: 'Step 1', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [] });
  const q = normaliseStep({ selectionType: 'quantity', min: 2, max: 5 });
  assert.equal(q.min, 5); assert.equal(q.max, 5);                         // a box is exactly N
  assert.equal(normaliseStep({ selectionType: 'quantity' }).max, 1);
  const m = normaliseStep({ selectionType: 'multiple', min: 7, max: 4 });
  assert.equal(m.min, 4); assert.equal(m.max, 4);                         // at least can never pass up to
  assert.equal(normaliseStep({ selectionType: 'multiple', max: 500 }).max, UNLIMITED);
  assert.equal(normaliseStep({ selectionType: 'nonsense' }).selectionType, 'single');
  assert.equal(normaliseStep({ selection_type: 'multiple_once', max: 3 }).selectionType, 'multiple_once');
  assert.equal(normaliseStep(null, 2).name, 'Step 3');
});

test('a step holds each product once, a bump is never minus and never on a step that keeps prices', () => {
  const s = normaliseStep({ products: ['p-marg', { itemId: 'p-marg', bump: 3 }, { itemId: 'p-pep', bump: -2 }, { id: 'p-veg', bump: '2.499' }, {}, null] });
  assert.deepEqual(s.products, [{ itemId: 'p-marg', bump: 0 }, { itemId: 'p-pep', bump: 0 }, { itemId: 'p-veg', bump: 2.5 }]);
  const own = normaliseStep({ pricing: 'own', products: [{ itemId: 'd-six', bump: 4 }] });
  assert.equal(own.pricing, PRICING_OWN);
  assert.equal(own.products[0].bump, 0);
});

test('D: only a product of type combo has steps, and a Combo with none is not a steps Combo', () => {
  assert.deepEqual(comboSteps(null), []);
  assert.deepEqual(comboSteps({ type: 'combo' }), []);
  assert.deepEqual(comboSteps({ type: 'combo', combo: null }), []);
  assert.deepEqual(comboSteps({ type: 'combo', combo: { steps: [] } }), []);
  assert.deepEqual(comboSteps({ type: 'combo', combo: 'rubbish' }), []);
  assert.deepEqual(comboSteps({ type: 'combo', combo: { steps: 'rubbish' } }), []);
  assert.equal(comboHasSteps({ type: 'combo', combo: { steps: [] } }), false);
  // The steps stay in the column when the type is changed away, but they do nothing.
  assert.equal(comboHasSteps({ ...BYO, type: 'modifiable' }), false);
  assert.equal(comboHasSteps(BYO), true);
  assert.equal(comboPosOnly(BYO), true);
  assert.equal(comboPosOnly({ type: 'combo', assignedModifierGroups: [{ groupId: 'g' }] }), false);   // today's Combo: never held back
  assert.equal(comboPosOnly(rowsById.get('p-marg')), false);
});

test('two steps never share an id, and what is saved is null when there are no steps', () => {
  const steps = comboStepsOf({ steps: [{ id: 'a' }, { id: 'a' }, { id: 'a' }] });
  assert.deepEqual(steps.map((s) => s.id), ['a', 'a-2', 'a-3']);
  assert.equal(comboColumnValue([]), null);
  assert.equal(comboColumnValue(null), null);
  const v = comboColumnValue(BYO_STEPS);
  assert.equal(v.v, 1);
  assert.equal(v.steps.length, 4);
  assert.deepEqual(comboStepsOf(v), v.steps);                              // saving is a fixed point
});

// ── Rules and words ─────────────────────────────────────────────────────────

test('the rule of a step and its words', () => {
  assert.deepEqual(stepRule(BYO_STEPS[0]), { min: 5, max: 5, repeat: true });
  assert.deepEqual(stepRule({ selectionType: 'multiple_once', min: 1, max: 3 }), { min: 1, max: 3, repeat: false });
  assert.deepEqual(stepRule({ selectionType: 'single' }), { min: 0, max: 1, repeat: false });
  assert.equal(ruleWords(5, 5), 'Choose exactly 5');
  assert.equal(ruleWords(0, 4), 'Choose up to 4');
  assert.equal(ruleWords(1, 4), 'Choose between 1 and 4');
  assert.equal(ruleWords(0, 99), 'Choose as many as they like');
  assert.equal(ruleWords(2, 99), 'Choose at least 2');
  assert.equal(stepSentence(BYO_STEPS[0]), 'Choose exactly 5. Customers must choose. The same product can be picked again.');
  assert.equal(stepSentence(BYO_STEPS[3]), 'Choose as many as they like. Customers can skip it. The same product can be picked again.');
  assert.equal(stepSentence({ selectionType: 'multiple_once', min: 0, max: 2 }), 'Choose up to 2. Customers can skip it. Each product only once.');
  assert.equal(stepSentence({ selectionType: 'single', min: 1 }), 'Choose exactly 1. Customers must choose.');
});

test('the form the Steps tab edits makes the same rules as an option group', () => {
  assert.deepEqual(stepForm(BYO_STEPS[0]), { choice: 'quantity', mustChoose: true, onceEach: false, min: 5, max: 5 });
  assert.deepEqual(stepForm({ selectionType: 'multiple_once', min: 0, max: 3 }), { choice: 'multiple', mustChoose: false, onceEach: true, min: 0, max: 3 });
  const base = { id: 'x', name: 'Sides', products: [{ itemId: 's-mac' }], pricing: 'own' };
  const several = stepWithForm(base, { choice: 'multiple', mustChoose: true, min: 1, max: 4, onceEach: true });
  assert.equal(several.selectionType, 'multiple_once'); assert.equal(several.min, 1); assert.equal(several.max, 4);
  assert.equal(several.name, 'Sides'); assert.equal(several.pricing, 'own'); assert.equal(several.products.length, 1);   // the rest of the step is kept
  assert.equal(stepWithForm(base, { choice: 'multiple', mustChoose: false, min: 3, max: 4 }).min, 0);
  assert.equal(stepWithForm(base, { choice: 'multiple', mustChoose: true, min: 9, max: 4 }).min, 4);
  assert.equal(stepWithForm(base, { choice: 'multiple', max: 99 }).max, UNLIMITED);
  const box = stepWithForm(base, { choice: 'quantity', max: 6 });
  assert.equal(box.min, 6); assert.equal(box.max, 6);
  assert.equal(stepWithForm(base, { choice: 'quantity', max: 999 }).max, 98);
  const one = stepWithForm(base, { choice: 'single', mustChoose: true });
  assert.equal(one.min, 1); assert.equal(one.max, 1);
  assert.equal(stepWithForm(base, { choice: 'single', mustChoose: false }).min, 0);
});

test('a new step is one choice that must be made, part of the set price', () => {
  assert.deepEqual(newStep([{}, {}], 'st-9'), { id: 'st-9', name: 'Step 3', selectionType: 'single', min: 1, max: 1, pricing: PRICING_SET, products: [] });
});

// ── Which products a step may hold ──────────────────────────────────────────

test('a step holds sold products and sizes, never a Combo, itself or an option only sub item', () => {
  assert.equal(stepProductBlock(rowsById.get('p-marg')), null);
  assert.equal(stepProductBlock(rowsById.get('z-wings')), null);            // a product with sizes
  assert.equal(stepProductBlock(rowsById.get('z-wings-l')), null);          // one size of it
  assert.equal(stepProductBlock(rowsById.get('x-dip')), null);              // a sub item that is sold alone
  assert.match(stepProductBlock(rowsById.get('x-noice')), /option only/);
  assert.match(stepProductBlock(rowsById.get('c-other')), /inside another Combo/);
  assert.match(stepProductBlock(BYO, { comboId: 'c-byo' }), /cannot hold itself/);
  assert.match(stepProductBlock({ id: 'sp', type: 'spacer' }), /gap/);
  assert.match(stepProductBlock({ id: 'pz', type: 'pizza' }), /pizza builder/);
  assert.match(stepProductBlock(null), /not on the menu/);
});

test('the option only rule here is the menu rules own (lib/menuRules.js rule 1)', () => {
  for (const r of [...MENU, { type: 'subitem' }, { type: 'subitem', sold_alone: true }, { type: 'subitem', sold_alone: false }, { type: 'subitem', soldAlone: true, sold_alone: false }]) {
    const blocked = /option only/.test(stepProductBlock({ id: 'q', ...r }) || '');
    if (r.type === 'combo' || r.type === 'spacer' || r.type === 'pizza') continue;
    assert.equal(blocked, isOptionOnlyItem(r), JSON.stringify(r));
  }
});

test('steps are set up only on a site\'s own Combo with no sizes', () => {
  assert.equal(stepsEditBlock(BYO), null);
  assert.match(stepsEditBlock({ ...BYO, type: 'simple' }), /Set the type to Combo/);
  assert.match(stepsEditBlock(BYO, { managed: true }), /Head office manages/);
  assert.match(stepsEditBlock({ ...BYO, scope: 'shared' }), /shared with other sites/);
  assert.match(stepsEditBlock({ ...BYO, scope: 'local', master_id: 'm-1' }), /shared with other sites/);
  assert.match(stepsEditBlock(BYO, { sizes: 2 }), /has sizes/);
  assert.match(stepsEditBlock({ ...BYO, parentId: 'x' }), /size cannot be a Combo/);
});

test('the Steps tab says what is wrong in words', () => {
  assert.deepEqual(comboWarnings({ type: 'combo' }, { rowsById }), []);
  assert.deepEqual(comboWarnings(BYO, { rowsById }), []);
  const bad = { id: 'c-bad', name: 'Bad', type: 'combo', combo: { steps: [
    { id: 'a', name: 'Empty', selectionType: 'single', min: 1, products: [] },
    { id: 'b', name: 'Maybe', selectionType: 'single', min: 0, products: [] },
    { id: 'c', name: 'Three once', selectionType: 'multiple_once', min: 3, max: 3, products: ['p-marg', 'old-pie', 'gone', 'x-noice', 'c-other'] },
    { id: 'd', name: 'Hidden', selectionType: 'single', min: 1, products: ['p-speck'] },
    { id: 'e', name: 'Out', selectionType: 'single', min: 1, products: ['p-pep'] },
  ] } };
  const w = comboWarnings(bad, { rowsById, noPrice: true, hiddenHere: (r) => r.id === 'p-speck', eightySix: ['p-pep'] });
  const words = w.map((x) => `${x.level}|${x.stepId}|${x.words}`);
  assert.ok(words.includes('stop|null|This Combo has no price. Set its price on Details: that is the set price.'));
  assert.ok(words.includes('stop|a|"Empty" has no products yet.'));
  assert.ok(words.includes('note|b|"Maybe" has no products yet.'));
  assert.ok(words.includes('note|c|Old Pie is archived, so it is not offered.'));
  assert.ok(words.includes('note|c|A product in "Three once" is not on the menu any more. Take it out of the step.'));
  assert.ok(words.some((x) => x.startsWith('note|c|No Ice: That is an option only')));
  assert.ok(words.some((x) => x.startsWith('note|c|Other Combo: A Combo cannot go inside another Combo')));
  assert.ok(words.includes('stop|c|"Three once" asks for 3, but only 1 product can be picked, each once.'));
  assert.ok(words.includes('note|d|Head office hides Speck on the POS, so it is not offered.'));
  assert.ok(words.includes('stop|d|"Hidden" must be chosen, but none of its products can be picked.'));
  assert.ok(words.includes("note|e|Pepperoni is 86'd right now."));
  assert.equal(w.filter((x) => x.stepId === 'e' && x.level === 'stop').length, 0);   // 86 passes: not a set up fault
});

// ── What can be picked right now ────────────────────────────────────────────

test('F: a product that is 86\'d, sold out, not sold on this order type, hidden or gone', () => {
  const e = (id) => ({ itemId: id, bump: 0 });
  assert.equal(entryState(e('p-marg'), ctx()).state, 'ok');
  assert.equal(entryState(e('p-marg'), ctx()).left, Infinity);
  assert.deepEqual(pickOnly(entryState(e('p-marg'), ctx({ eightySix: new Set(['p-marg']) }))), { state: 'out', words: "86'd" });
  assert.deepEqual(pickOnly(entryState(e('p-marg'), ctx({ remainingOf: (id) => (id === 'p-marg' ? 0 : null) }))), { state: 'out', words: 'Sold out' });
  assert.deepEqual(pickOnly(entryState(e('p-marg'), ctx({ soldAs: (r) => r.id !== 'p-marg', notSoldWords: (r) => `${r.name} is not available for Takeaway.` }))), { state: 'type', words: 'Margherita is not available for Takeaway.' });
  assert.equal(entryState(e('p-marg'), ctx({ hiddenHere: (r) => r.id === 'p-marg' })).state, 'hidden');
  assert.equal(entryState(e('old-pie'), ctx()).state, 'gone');
  assert.equal(entryState(e('nope'), ctx()).state, 'gone');
  assert.equal(entryState(e('x-noice'), ctx()).state, 'gone');
  assert.equal(entryState(e('c-other'), ctx()).state, 'gone');
  assert.equal(entryState(e('c-byo'), ctx({ comboId: 'c-byo', rowsById: new Map([...rowsById, ['c-byo', BYO]]) })).state, 'gone');
});
const pickOnly = ({ state, words }) => ({ state, words });

test('F: a daily count is shared by every pick of the Combo (two of the last two, never a third)', () => {
  const c = ctx({ remainingOf: (id) => (id === 'p-marg' ? 2 : null) });
  const e = { itemId: 'p-marg', bump: 0 };
  assert.equal(entryState(e, c, []).left, 2);
  assert.equal(entryState(e, c, []).words, '2 left');
  assert.equal(entryState(e, c, [pick('pizzas', 'p-marg')]).left, 1);
  const full = entryState(e, c, [pick('pizzas', 'p-marg'), pick('pizzas', 'p-marg')]);
  assert.deepEqual(pickOnly(full), { state: 'out', words: 'Sold out' });
});

test('a product with sizes offers the sizes that can still be picked, and its own count covers them all', () => {
  const e = { itemId: 'z-wings', bump: 0 };
  assert.deepEqual(entryState(e, ctx()).sizes.map((s) => s.id), ['z-wings-s', 'z-wings-l']);
  assert.deepEqual(entryState(e, ctx({ eightySix: ['z-wings-s'] })).sizes.map((s) => s.id), ['z-wings-l']);
  assert.equal(entryState(e, ctx({ eightySix: ['z-wings-s', 'z-wings-l'] })).state, 'out');
  assert.equal(entryState(e, ctx({ eightySix: ['z-wings'] })).state, 'out');           // the product itself 86'd
  // One Wings left on the PRODUCT's count: one pick of any size uses it.
  const c = ctx({ remainingOf: (id) => (id === 'z-wings' ? 1 : null) });
  assert.equal(entryState(e, c, []).left, 1);
  assert.equal(entryState(e, c, [pick('x', 'z-wings', { itemId: 'z-wings-l' })]).state, 'out');
  assert.equal(entryState(e, c, [pick('x', 'z-wings', { itemId: null })]).state, 'out');   // a pick still waiting for its size counts
  // A size listed on its own follows its product's 86 and count too.
  assert.equal(entryState({ itemId: 'z-wings-l' }, ctx({ eightySix: ['z-wings'] })).state, 'out');
  assert.equal(entryState({ itemId: 'z-wings-l' }, c, [pick('x', 'z-wings-s')]).state, 'out');
  assert.equal(entryState({ itemId: 'z-wings' }, ctx({ soldAs: (r) => !r.parentId })).state, 'type');   // no size is sold on this order type
});

test('units used: a size also counts against its product, and a linked option counts too', () => {
  const used = unitsUsed([
    pick('a', 'z-wings', { itemId: 'z-wings-l' }), pick('a', 'z-wings', { itemId: 'z-wings-s' }), pick('a', 'z-wings', { itemId: null }),
    pick('b', 'p-marg', { mods: [{ itemId: 'x-dip', qty: 2 }, { itemId: 'x-dip' }, { label: 'No basil' }] }),
  ], ctx());
  assert.equal(used.get('z-wings'), 3);
  assert.equal(used.get('z-wings-l'), 1);
  assert.equal(used.get('z-wings-s'), 1);
  assert.equal(used.get('p-marg'), 1);
  assert.equal(used.get('x-dip'), 3);
});

test('the products a step shows leave out the gone and the hidden, and keep the greyed', () => {
  const step = { id: 's', products: ['p-marg', 'old-pie', 'p-pep', 'p-speck'] };
  const shown = stepEntries(step, ctx({ eightySix: ['p-pep'], hiddenHere: (r) => r.id === 'p-speck' }));
  assert.deepEqual(shown.map((e) => `${e.entry.itemId}:${e.state}`), ['p-marg:ok', 'p-pep:out']);
});

// ── Picks ───────────────────────────────────────────────────────────────────

test('where a step stands, and what it still needs in words', () => {
  const [pizzas, , sides, drinks] = BYO_STEPS;
  assert.deepEqual(stepStatus(pizzas, []), { count: 0, min: 5, max: 5, need: 5, room: 5, done: false, full: false });
  assert.equal(stepNeedWords(pizzas, []), 'Pick 5');
  assert.equal(stepCountWords(pizzas, []), '0 of 5');
  const three = [pick('pizzas', 'p-marg'), pick('pizzas', 'p-marg'), pick('pizzas', 'p-pep')];
  assert.equal(stepNeedWords(pizzas, three), 'Pick 2 more');
  assert.equal(stepCountWords(pizzas, three), '3 of 5');
  const five = [...three, pick('pizzas', 'p-veg'), pick('pizzas', 'p-bbq')];
  assert.equal(stepStatus(pizzas, five).done, true);
  assert.equal(stepStatus(pizzas, five).full, true);
  assert.equal(stepNeedWords(pizzas, five), 'Done');
  assert.equal(stepNeedWords(sides, []), 'Pick at least 1');
  assert.equal(stepNeedWords(sides, [pick('sides', 's-mac')]), 'Up to 3 more');
  assert.equal(stepNeedWords(drinks, []), 'Optional');
  assert.equal(stepNeedWords(drinks, [pick('drinks', 'd-six')]), 'Add more if you like');
  assert.equal(stepCountWords(drinks, [pick('drinks', 'd-six')]), '1 picked');
  assert.equal(stepNeedWords({ id: 'o', selectionType: 'multiple', min: 0, max: 2 }, []), 'Optional, up to 2');
  assert.equal(stepStatus(drinks, []).done, true);
  assert.equal(stepStatus(drinks, []).room, Infinity);
});

test('every unit is its own pick: a tap adds one, and the same product twice is two picks', () => {
  const [pizzas] = BYO_STEPS;
  const mk = (entryId) => pick('pizzas', entryId);
  let picks = [];
  for (const id of ['p-marg', 'p-marg', 'p-pep', 'p-veg', 'p-bbq']) picks = tapEntry(pizzas, picks, id, mk);
  assert.equal(picks.length, 5);
  assert.equal(picks.filter((p) => p.entryId === 'p-marg').length, 2);
  assert.notEqual(picks[0].key, picks[1].key);
  assert.equal(canPick(pizzas, picks, 'p-speck'), false);                 // the step is full
  assert.equal(tapEntry(pizzas, picks, 'p-speck', mk), picks);            // a tap on a full step changes nothing
  const less = untapEntry(pizzas, picks, 'p-marg');
  assert.equal(less.length, 4);
  assert.equal(less.filter((p) => p.entryId === 'p-marg').length, 1);
  assert.equal(less[0], picks[0]);                                        // the LAST one went: the first keeps its options
  assert.equal(untapEntry(pizzas, picks, 'p-speck'), picks);
});

test('one choice swaps, each only once toggles', () => {
  const one = { id: 'one', selectionType: 'single', min: 1, products: ['p-marg', 'p-pep'] };
  const mk = (stepId) => (entryId) => pick(stepId, entryId);
  let picks = tapEntry(one, [pick('other', 'd-six')], 'p-marg', mk('one'));
  picks = tapEntry(one, picks, 'p-pep', mk('one'));
  assert.deepEqual(picks.map((p) => `${p.stepId}:${p.entryId}`), ['other:d-six', 'one:p-pep']);   // swapped, the other step untouched
  assert.equal(tapEntry(one, picks, 'p-pep', mk('one')), picks);          // it must be chosen: a second tap keeps it
  const maybe = { ...one, min: 0 };
  assert.deepEqual(tapEntry(maybe, picks, 'p-pep', mk('one')).map((p) => p.stepId), ['other']);   // it can be skipped: a second tap takes it off

  const once = { id: 'once', selectionType: 'multiple_once', min: 0, max: 2, products: ['s-mac', 's-med', 's-caesar'] };
  let p2 = tapEntry(once, [], 's-mac', mk('once'));
  p2 = tapEntry(once, p2, 's-med', mk('once'));
  assert.equal(canPick(once, p2, 's-caesar'), false);                     // up to 2
  assert.equal(canPick(once, [p2[0]], 's-mac'), false);                   // each only once
  p2 = tapEntry(once, p2, 's-mac', mk('once'));
  assert.deepEqual(p2.map((p) => p.entryId), ['s-med']);                  // a second tap took it off
});

test('B: a step whose answer is fixed fills itself, and a Combo of such steps adds in one tap', () => {
  const fixed = [
    { id: 'f1', name: 'Margherita', selectionType: 'quantity', min: 2, max: 2, products: ['p-marg'] },
    { id: 'f2', name: 'Named pizzas', selectionType: 'multiple_once', min: 3, max: 3, products: ['p-pep', 'p-veg', 'p-bbq'] },
    { id: 'f3', name: 'Bread', selectionType: 'quantity', min: 3, max: 3, products: ['b-cheese'] },
    { id: 'f4', name: 'Salad', selectionType: 'single', min: 1, products: ['s-caesar'] },
  ];
  assert.deepEqual(fixedAnswer(fixed[0], ctx()), ['p-marg', 'p-marg']);
  assert.deepEqual(fixedAnswer(fixed[1], ctx()), ['p-pep', 'p-veg', 'p-bbq']);
  assert.deepEqual(fixedAnswer(fixed[3], ctx()), ['s-caesar']);
  assert.equal(comboIsFixed(fixed, ctx()), true);
  const start = startingPicks(fixed, ctx(), (stepId, entryId) => pick(stepId, entryId));
  assert.deepEqual(start.map((p) => p.entryId), ['p-marg', 'p-marg', 'p-pep', 'p-veg', 'p-bbq', 'b-cheese', 'b-cheese', 'b-cheese', 's-caesar']);
  assert.equal(comboMissing(fixed, start, ctx()), null);                  // ready: one tap
  // A step with a real choice does not fill itself, and neither does one that can be skipped.
  assert.equal(fixedAnswer(BYO_STEPS[0], ctx()), null);
  assert.equal(fixedAnswer({ id: 'o', selectionType: 'single', min: 0, products: ['p-marg'] }, ctx()), null);
  assert.equal(fixedAnswer({ id: 'o', selectionType: 'multiple', min: 1, max: 2, products: ['p-marg'] }, ctx()), null);
  assert.equal(fixedAnswer({ id: 'o', selectionType: 'single', min: 1, products: ['p-marg', 'p-pep'] }, ctx()), null);
  assert.equal(comboIsFixed(BYO_STEPS, ctx()), false);
  assert.equal(comboIsFixed([], ctx()), false);
  // Sold out is not "no choice": a two product step never fills itself because one ran out.
  assert.equal(fixedAnswer({ id: 'o', selectionType: 'single', min: 1, products: ['p-marg', 'p-pep'] }, ctx({ eightySix: ['p-pep'] })), null);
  // A product hidden here or archived is not part of the step on this screen.
  assert.deepEqual(fixedAnswer({ id: 'o', selectionType: 'single', min: 1, products: ['p-marg', 'old-pie'] }, ctx()), ['p-marg']);
});

test('E: a pick with sizes asks the size, and a required option cannot be skipped', () => {
  const c = ctx({ requiresAnswers: (r) => r.id === 's-caesar' });
  assert.equal(pickNeeds(pick('x', 'z-wings', { itemId: null }), c), 'size');
  assert.equal(pickNeeds(pick('x', 'z-wings', { itemId: 'z-wings' }), c), 'size');          // the product is not a size
  assert.equal(pickNeeds(pick('x', 'z-wings', { itemId: 'z-wings-l' }), c), null);
  assert.equal(pickNeeds(pick('x', 's-caesar'), c), 'options');
  assert.equal(pickNeeds(pick('x', 's-caesar', { configured: true }), c), null);
  assert.equal(pickNeeds(pick('x', 'p-marg'), c), null);
  assert.equal(pickNeeds(null, c), null);
  // The Combo cannot be added until it is answered, and says which pick in words.
  const steps = [{ id: 'x', name: 'Salad', selectionType: 'single', min: 1, products: ['s-caesar'] }, { id: 'y', name: 'Wings', selectionType: 'single', min: 1, products: ['z-wings'] }];
  const picks = [pick('x', 's-caesar'), pick('y', 'z-wings', { itemId: null })];
  assert.equal(comboMissing(steps, picks, c), 'Caesar Salad Catering Size: choose its options');
  picks[0] = { ...picks[0], configured: true };
  assert.equal(comboMissing(steps, picks, c), 'Wings: choose a size');
  picks[1] = { ...picks[1], itemId: 'z-wings-l' };
  assert.equal(comboMissing(steps, picks, c), null);
});

// ── Money ───────────────────────────────────────────────────────────────────

test('a pick is 0.00, or its bump, or its own price, plus its own options', () => {
  const [pizzas, , , drinks] = BYO_STEPS;
  assert.deepEqual(pickPrice({ step: pizzas, entryId: 'p-marg', ownPrice: 16 }), { base: 0, bump: 0, extras: 0, total: 0 });
  assert.deepEqual(pickPrice({ step: pizzas, entryId: 'p-speck', ownPrice: 20 }), { base: 0, bump: 2.5, extras: 0, total: 2.5 });
  assert.deepEqual(pickPrice({ step: pizzas, entryId: 'p-pep', ownPrice: 18, mods: [{ price: 1.5 }, { price: 0 }, { label: 'No basil' }] }), { base: 0, bump: 0, extras: 1.5, total: 1.5 });
  assert.deepEqual(pickPrice({ step: drinks, entryId: 'd-six', ownPrice: 20 }), { base: 20, bump: 0, extras: 0, total: 20 });
  assert.deepEqual(pickPrice({ step: drinks, entryId: 'd-six', ownPrice: 20, mods: [{ price: 0.75 }] }), { base: 20, bump: 0, extras: 0.75, total: 20.75 });
  assert.equal(pickPrice({ step: pizzas, entryId: 'unknown', ownPrice: 9 }).total, 0);
});

test('A: Build Your Own Package comes to 178.50', () => {
  const t = comboTotal({ setPrice: 149, steps: BYO_STEPS, picks: picksA(), rowsById, priceOf });
  assert.deepEqual(t, { setPrice: 149, extras: 29.5, total: 178.5 });
  assert.equal(comboMissing(BYO_STEPS, picksA(), ctx()), null);
});

test('C: Lunch Combo 12.00 with a +2.50 bump is 14.50', () => {
  const steps = [
    { id: 'pz', name: 'Pizza', selectionType: 'single', min: 1, products: [{ itemId: 'p-marg' }, { itemId: 'p-speck', bump: 2.5 }] },
    { id: 'sd', name: 'Side', selectionType: 'single', min: 1, products: ['b-cheese', 'b-garlic', 's-mac', 's-med'] },
    { id: 'dr', name: 'Drink', selectionType: 'single', min: 1, products: ['d-water'] },
  ];
  const plain = [pick('pz', 'p-marg'), pick('sd', 's-mac'), pick('dr', 'd-water')];
  assert.equal(comboTotal({ setPrice: 12, steps, picks: plain, rowsById, priceOf }).total, 12);
  const bumped = [pick('pz', 'p-speck'), pick('sd', 's-mac'), pick('dr', 'd-water')];
  assert.equal(comboTotal({ setPrice: 12, steps, picks: bumped, rowsById, priceOf }).total, 14.5);
  assert.equal(comboMissing(steps, [pick('pz', 'p-speck'), pick('dr', 'd-water')], ctx()), 'Side: pick 1');
  // The drink step is fixed (one product), so it is already picked when the Combo opens.
  assert.deepEqual(startingPicks(steps, ctx(), (s, e) => pick(s, e)).map((p) => p.entryId), ['d-water']);
});

test('what stops a Combo being added: a step short, too many, or the counts across every pick', () => {
  assert.equal(comboMissing(BYO_STEPS, [], ctx()), 'Pick 5 pizzas: pick 5');
  const a = picksA();
  assert.equal(comboMissing(BYO_STEPS, a.slice(1), ctx()), 'Pick 5 pizzas: pick 1 more');
  assert.equal(comboMissing(BYO_STEPS, [...a, pick('breads', 'b-cheese')], ctx()), 'Pick 2 breads: too many picked');
  // F: two Margheritas picked, one left on the count.
  assert.equal(comboMissing(BYO_STEPS, a, ctx({ remainingOf: (id) => (id === 'p-marg' ? 1 : null) })), 'Only 1 × Margherita left');
  assert.equal(comboMissing(BYO_STEPS, a, ctx({ remainingOf: (id) => (id === 'p-marg' ? 0 : null) })), 'Margherita is sold out');
  assert.equal(comboMissing(BYO_STEPS, a, ctx({ remainingOf: (id) => (id === 'p-marg' ? 2 : null) })), null);
  assert.equal(comboMissing(BYO_STEPS, a, ctx({ eightySix: ['b-garlic'] })), "Garlic Bread is 86'd");
  // An option linked to a product with one left, picked on two pizzas.
  const dip = { itemId: 'x-dip', label: 'Ranch Dip', price: 1 };
  const two = a.map((p, i) => (i < 2 ? { ...p, mods: [dip] } : p));
  assert.equal(comboMissing(BYO_STEPS, two, ctx({ remainingOf: (id) => (id === 'x-dip' ? 1 : null) })), 'Only 1 × Ranch Dip left');
  assert.equal(comboMissing([], [], ctx()), null);
});

test('F: a Combo that cannot be made right now says so before it is opened', () => {
  const c = (extra) => ctx({ rowsById: new Map([...rowsById, ['c-byo', BYO]]), ...extra });
  assert.equal(comboUnsellable(BYO, c()), null);
  assert.equal(comboUnsellable(BYO, c({ eightySix: ['b-cheese', 'b-garlic'] })), 'Build Your Own Package cannot be made right now: nothing can be picked for "Pick 2 breads".');
  // 5 pizzas needed, the counts allow 4 in all.
  const few = { 'p-marg': 1, 'p-pep': 1, 'p-veg': 1, 'p-bbq': 1, 'p-speck': 0 };
  assert.equal(comboUnsellable(BYO, c({ remainingOf: (id) => (id in few ? few[id] : null) })), 'Build Your Own Package cannot be made right now: "Pick 5 pizzas" needs 5 and only 4 can be picked.');
  // A step that can be skipped never stops the Combo.
  assert.equal(comboUnsellable(BYO, c({ eightySix: ['d-six', 'd-water'] })), null);
  // Each only once: three named products, one sold out.
  const once = { id: 'c-once', name: 'Trio', type: 'combo', combo: { steps: [{ id: 's', name: 'Three', selectionType: 'multiple_once', min: 3, max: 3, products: ['p-marg', 'p-pep', 'p-veg'] }] } };
  assert.equal(comboUnsellable(once, ctx({ eightySix: ['p-veg'] })), 'Trio cannot be made right now: "Three" needs 3 and only 2 can be picked.');
  assert.equal(comboUnsellable({ type: 'combo' }, ctx()), null);          // D: no steps, nothing to say
});

// ── The lines ───────────────────────────────────────────────────────────────

test('A: the lines of a finished Combo: one line with the set price, one real line per pick', () => {
  const plan = comboLinePlan({ item: BYO, comboId: 'cmb-1', setPrice: 149, picks: picksA(), rowsById, priceOf });
  assert.deepEqual(plan.parent, { comboRole: 'parent', comboId: 'cmb-1', itemId: 'c-byo', name: 'Build Your Own Package', price: 149, noKitchen: true });
  assert.equal(plan.picks.length, 9);
  assert.deepEqual(plan.picks.map((l) => `${l.itemId}|${l.name}|${l.price}`), [
    'p-marg|Margherita|0', 'p-marg|Margherita|0', 'p-pep|Pepperoni|1.5', 'p-veg|Veggie|0', 'p-bbq|BBQ Chicken|0',
    'b-cheese|Cheese Bread|0', 'b-garlic|Garlic Bread|0',
    's-caesar|Caesar Salad Catering Size|8',
    'd-six|Soda Six Pack|20',
  ]);
  for (const l of plan.picks) {
    assert.equal(l.comboRole, 'pick'); assert.equal(l.comboId, 'cmb-1'); assert.equal(l.comboName, 'Build Your Own Package');
    assert.equal(l.noKitchen, undefined);                                 // a pick is a normal kitchen line
  }
  assert.equal(plan.picks[2].mods[0].label, 'Extra cheese');             // its own option rides on its own line
  assert.equal(plan.picks[7].mods[0].label, 'Chicken');
  assert.equal(plan.picks[8].comboKeepsPrice, true);
  assert.equal(plan.picks[0].comboKeepsPrice, false);
  assert.deepEqual([plan.picks[0].comboStepId, plan.picks[0].comboStepName, plan.picks[0].comboEntryId], ['pizzas', 'Pick 5 pizzas', 'p-marg']);
  const total = plan.parent.price + plan.picks.reduce((s, l) => s + l.price, 0);
  assert.equal(cents(total), 178.5);
});

test('a pick with a size is the size\'s own row, named the POS way, and keeps the price bump on its line', () => {
  const steps = [
    { id: 'w', name: 'Wings', selectionType: 'single', min: 1, pricing: 'own', products: ['z-wings'] },
    { id: 'p', name: 'Pizza', selectionType: 'single', min: 1, products: [{ itemId: 'p-speck', bump: 2.5 }] },
  ];
  const picks = [pick('p', 'p-speck'), pick('w', 'z-wings', { itemId: 'z-wings-l', notes: ' extra crispy ', answers: { v: 'z-wings-l' } })];
  const plan = comboLinePlan({ item: { id: 'c', name: 'Deal', type: 'combo' }, comboId: 'cmb-2', setPrice: 10, steps, picks, rowsById, priceOf });
  // Step order, not tap order.
  assert.deepEqual(plan.picks.map((l) => l.itemId), ['z-wings-l', 'p-speck']);
  const wings = plan.picks[0];
  assert.equal(wings.name, 'Wings — Large');
  assert.equal(wings.price, 15);                                          // keeps its own price: the size's
  assert.equal(wings.comboEntryId, 'z-wings');
  assert.equal(wings.notes, 'extra crispy');
  assert.deepEqual(wings.optionAnswers, { v: 'z-wings-l' });
  assert.equal(plan.picks[1].price, 2.5);
  assert.equal(plan.picks[1].comboBump, 2.5);
  assert.equal(pickLineName(rowsById.get('z-wings-s'), rowsById), 'Wings — Small');
  // A pick whose product has gone, or whose step is not the Combo's, makes no line.
  const odd = comboLinePlan({ item: BYO, comboId: 'c3', setPrice: 1, picks: [pick('pizzas', 'nope'), pick('not-a-step', 'p-marg')], rowsById, priceOf });
  assert.equal(odd.picks.length, 0);
});

const asLines = (plan) => [
  { uid: 'u0', qty: 1, status: 'pending', ...plan.parent },
  ...plan.picks.map((l, i) => ({ uid: `u${i + 1}`, qty: 1, status: 'pending', ...l })),
];

test('the picks of a Combo on an order can be read back from its lines', () => {
  const plan = comboLinePlan({ item: BYO, comboId: 'cmb-1', setPrice: 149, picks: picksA(), rowsById, priceOf });
  const lines = asLines(plan);
  const back = picksFromLines(lines);
  assert.equal(back.length, 9);
  assert.deepEqual(back.map((p) => `${p.stepId}:${p.entryId}`), picksA().map((p) => `${p.stepId}:${p.entryId}`));
  assert.ok(back.every((p) => p.configured));
  assert.equal(back[2].mods[0].label, 'Extra cheese');
  // The same picks make the same lines again (add another the same).
  const again = comboLinePlan({ item: BYO, comboId: 'cmb-9', setPrice: 149, picks: back, rowsById, priceOf });
  assert.deepEqual(again.picks.map((l) => [l.itemId, l.price]), plan.picks.map((l) => [l.itemId, l.price]));
  // A voided pick is not read back.
  assert.equal(picksFromLines(lines.map((l, i) => (i === 3 ? { ...l, voided: true } : l))).length, 8);
});

// ── One group of lines ──────────────────────────────────────────────────────

const ORDER = () => {
  const one = asLines(comboLinePlan({ item: BYO, comboId: 'cmb-1', setPrice: 149, picks: picksA(), rowsById, priceOf }));
  const two = asLines(comboLinePlan({ item: BYO, comboId: 'cmb-2', setPrice: 149, picks: picksA().slice(0, 3), rowsById, priceOf })).map((l) => ({ ...l, uid: `v${l.uid}` }));
  return [{ uid: 'x1', itemId: 'd-water', name: 'Water Case', price: 18, qty: 2, status: 'pending' }, ...one, { uid: 'x2', itemId: 'p-marg', name: 'Margherita', price: 16, qty: 1, status: 'sent' }, ...two];
};

test('a Combo is one group: the same uids move together', () => {
  const o = ORDER();
  assert.equal(isComboParent(o[1]), true); assert.equal(isComboPick(o[2]), true); assert.equal(isComboLine(o[0]), false);
  assert.equal(isComboPick(o[1]), false); assert.equal(isComboParent(o[2]), false);
  assert.equal(isComboParent({ comboRole: 'parent' }), false);            // no id, no group
  assert.equal(comboUids(o, 'u3').length, 10);                            // a pick names the whole Combo
  assert.deepEqual(comboUids(o, 'u3'), comboUids(o, 'u0'));
  assert.deepEqual(comboUids(o, 'x1'), ['x1']);
  assert.deepEqual(comboUids(o, 'nope'), []);
  assert.equal(comboLinesOf(o, o[0]).length, 1);
  assert.equal(comboLinesTotal(comboLinesOf(o, o[1])), 178.5);
  assert.equal(comboIsSent(o, 'cmb-1'), false);
  const sent = o.map((l) => (l.uid === 'u4' ? { ...l, status: 'sent' } : l));
  assert.equal(comboIsSent(sent, 'cmb-1'), true);                         // one line at the kitchen: the Combo is sent
  assert.equal(comboIsSent(sent, 'cmb-2'), false);
  assert.equal(comboIsSent(sent.map((l) => (l.uid === 'u4' ? { ...l, voided: true } : l)), 'cmb-1'), false);
});

test('the order as blocks: a Combo is one block with its picks under it', () => {
  const blocks = orderBlocks(ORDER());
  assert.deepEqual(blocks.map((b) => (b.kind === 'combo' ? `combo:${b.comboId}:${b.picks.length}:${b.total}` : `line:${b.line.uid}`)),
    ['line:x1', 'combo:cmb-1:9:178.5', 'line:x2', 'combo:cmb-2:3:150.5']);
  assert.equal(blocks[1].sent, false); assert.equal(blocks[1].voided, false);
  const allVoid = orderBlocks(ORDER().map((l) => (l.comboId === 'cmb-2' ? { ...l, voided: true, status: 'voided' } : l)));
  assert.equal(allVoid[3].voided, true);
  assert.equal(allVoid[3].total, 0);
  // Picks whose Combo line is missing show as ordinary lines (never hidden).
  const orphan = orderBlocks(ORDER().filter((l) => l.uid !== 'u0'));
  assert.equal(orphan.filter((b) => b.kind === 'line').length, 2 + 9);
  assert.deepEqual(orderBlocks(null), []);
});

test('a selection of lines never cuts a Combo', () => {
  const o = ORDER();
  // Add: a Combo with any line picked is picked whole.
  assert.deepEqual(wholeCombos(o, ['x1', 'u5']), ['x1', ...comboUids(o, 'u0')]);
  // Drop: a Combo with any line not picked is dropped whole.
  assert.deepEqual(wholeCombos(o, ['x1', ...comboUids(o, 'u0').slice(1)], 'drop'), ['x1']);
  assert.deepEqual(wholeCombos(o, ['x1', 'x2']), ['x1', 'x2']);
  assert.equal(keepsCombosWhole(o, ['x1']), true);
  assert.equal(keepsCombosWhole(o, comboUids(o, 'u0')), true);
  assert.equal(keepsCombosWhole(o, ['u0']), false);                       // the Combo line without its picks
  assert.equal(keepsCombosWhole(o, ['u3']), false);                       // a pick on its own
  assert.equal(keepsCombosWhole(o, []), true);
});

test('the words every screen uses', () => {
  assert.equal(comboNotHereWords(BYO), 'Build Your Own Package is a Combo with choices. Ring it up on the POS.');
  assert.match(COMBO_WORDS.posOnly, /POS only for now/);
  for (const w of Object.values(COMBO_WORDS)) {
    assert.ok(!/[–—]/.test(w), w);                              // no dashes (Peter's rule)
    assert.ok(!/\btill\b/i.test(w), w);                                   // POS, never till
  }
});
