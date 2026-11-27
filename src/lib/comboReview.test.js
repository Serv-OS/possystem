// comboReview.test.js: what an independent review of Combo steps found, each pinned (5.12.123).
//
// Every test here is a real order a POS could ring up that came out wrong before it was fixed.
// The scenario is in the test's name; the rule that now holds it is in lib/combo.js unless said.
//   1. A free item reward, or a free item code, landed on a Combo's 0.00 pick and was used up
//      for nothing.
//   2. A note put on a pick with the Note button was wiped (or an older one came back) when
//      Change was used afterwards.
//   3. A part refund from the phone POS took a stamp back for every pick of a Combo.
//   4. An amount discount bigger than the Combo's own line was cut short, though the discount
//      screen offered it against the whole Combo.
//   5. A pick that keeps its own price, of a product with no price set, was sold at 0.00.
//   6. A Combo was refused as "cannot be made" when a product's sizes had their own counts.
//   7. A Combo with nothing picked charged the set price and sent the kitchen nothing.
//   8. "Each product once" was only a rule of the screen.
//   9. A product a step picks by itself was added with no allergen warning.
//  10. A rolled back database refused a new row that still carried steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  comboMissing, comboUnsellable, comboWarnings, comboDiscount, comboLinesTotal, entryState, stepEntries,
  selfPickAllergens, linesForPromo, lineShow, displayOrder, isComboPick, cents,
} from './combo.js';
import { comboPosContext } from './comboLines.js';
import { eligibleOrderLines } from './loyaltyMenuMatch.js';
import { rewardUnits, pickNext, pickBlock, pickBlockText } from './loyaltyMultiRedeem.js';
import { promoBasketLines, promoDiscountForBasket } from '../../supabase/functions/_shared/promoMath.js';
import { answersWithNote, answersFromFlow, flowFromAnswers } from './optionAnswers.js';
import { partRefundLoyaltyBody, loyaltyEarnItems } from './loyaltyEarnItems.js';
import { countQualifyingStamps } from '../../supabase/functions/_shared/stampQualify.ts';
import { lineAfterItemDiscount, linesAfterItemDiscounts } from './taxBasis.js';
import { comboColumnRetry, itemInsertRetry, itemCodeRetry, isMissingComboColumn } from './menuWriters.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── A small order: scenario A's Combo, and a Margherita rung up on its own ──────────────────────
const C = 'cmb-a';
const parent = (o = {}) => ({ uid: 'p0', itemId: 'c-byo', name: 'Build Your Own Package', cat: 'cat-catering', price: 149, qty: 1, comboId: C, comboRole: 'parent', noKitchen: true, mods: [], ...o });
const pick = (uid, itemId, name, o = {}) => ({ uid, itemId, name, cat: 'cat-pizza', price: 0, qty: 1, comboId: C, comboRole: 'pick', mods: [], ...o });
const BYO = [
  parent(),
  pick('k1', 'p-marg', 'Margherita'),
  pick('k2', 'p-pep', 'Pepperoni', { price: 1.5, mods: [{ label: 'Extra cheese', price: 1.5 }] }),
  pick('k3', 's-caesar', 'Caesar Salad', { cat: 'cat-sides', price: 8, mods: [{ label: 'Chicken', price: 8 }] }),
  pick('k4', 'd-six', 'Soda Six Pack', { cat: 'cat-drinks', price: 15, comboKeepsPrice: true }),
];
const MARG = { uid: 'i1', itemId: 'p-marg', name: 'Margherita', cat: 'cat-pizza', price: 17, qty: 1, mods: [] };
const MENU = [
  { id: 'c-byo', name: 'Build Your Own Package', cat: 'cat-catering' }, { id: 'p-marg', name: 'Margherita', cat: 'cat-pizza' },
  { id: 'p-pep', name: 'Pepperoni', cat: 'cat-pizza' }, { id: 's-caesar', name: 'Caesar Salad', cat: 'cat-sides' }, { id: 'd-six', name: 'Soda Six Pack', cat: 'cat-drinks' },
];

// ── 1. Rewards and codes ────────────────────────────────────────────────────────────────────────

test('1 a free item reward lands on the product rung up on its own, never on a Combo\'s pick', () => {
  const FREE = { id: 'rw-1', label: 'Free Margherita', type: 'free_item', pointsCost: 0, stamp: true, available: 1, value: { eligible_items: [{ id: 'p-marg', name: 'Margherita' }] } };
  const order = [...BYO, MARG];
  // The one rule every reward screen reads.
  assert.deepEqual(eligibleOrderLines(FREE.value, order, MENU, []).map((l) => l.uid), ['i1']);
  const ctx = { items: order, menuItems: MENU, categories: [], credit: 0 };
  const units = rewardUnits(FREE, ctx);
  assert.deepEqual(units.map((u) => [u.name, u.priceMinor]), [['Margherita', 1700]]);
  const next = pickNext([], FREE, [FREE], ctx);
  assert.equal(next.error, null);
  assert.equal(next.picks[0].unitKey, `${order.indexOf(MARG)}:0`);          // the 17.00 one, not the pick at 0.00
  // With only the Combo on the order the reward is refused in words, not used up for nothing.
  const only = { items: BYO, menuItems: MENU, categories: [], credit: 0 };
  assert.deepEqual(rewardUnits(FREE, only), []);
  assert.equal(pickBlock([], FREE, [FREE], only), 'no_item');
  assert.equal(pickBlockText('no_item', FREE), 'Add Margherita to the order first. The reward makes it free.');
  assert.deepEqual(pickNext([], FREE, [FREE], only).picks, []);
  // A reward for the Combo itself still lands on the Combo's own line, at its set price.
  const COMBO_FREE = { ...FREE, value: { eligible_items: [{ id: 'c-byo', name: 'Build Your Own Package' }] } };
  assert.deepEqual(rewardUnits(COMBO_FREE, only).map((u) => [u.name, u.priceMinor]), [['Build Your Own Package', 14900]]);
  // A pick is told by BOTH marks: a stray field alone never hides a line from a reward.
  assert.equal(eligibleOrderLines(FREE.value, [{ ...MARG, comboRole: 'pick' }], MENU, []).length, 1);
  assert.equal(eligibleOrderLines(FREE.value, [{ ...MARG, comboId: 'x' }], MENU, []).length, 1);
  assert.match(read('./loyaltyMenuMatch.js'), /!\(l\.comboId && l\.comboRole === 'pick'\) && matcher\.matches\(/);
});

test('1 a free item code: the same, and a code with a category rule still counts what a pick adds', () => {
  const offer = { reward_type: 'free_item', reward_item_id: 'p-marg', reward_value: 0 };
  const basket = (items) => ({ subtotal: items.reduce((s, l) => s + l.price * l.qty, 0), lines: promoBasketLines(linesForPromo(items)) });
  assert.equal(promoDiscountForBasket(offer, basket([...BYO, MARG])).amount, 17);
  const only = promoDiscountForBasket(offer, basket(BYO));
  assert.equal(only.missing, true);                       // "add it first", not "valid, 0.00 off"
  assert.equal(only.amount, 0);
  // Before the fix the basket named the pick, and the cheapest "Margherita" was its 0.00.
  assert.equal(promoDiscountForBasket(offer, { subtotal: 190.5, lines: promoBasketLines([...BYO, MARG]) }).amount, 0);
  // The lines keep their money and category: 20% off pizzas takes it off the 1.50 a pizza pick adds too.
  const lines = promoBasketLines(linesForPromo([...BYO, MARG]));
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.filter((l) => l.itemId == null).map((l) => [l.cat, l.price]), [['cat-pizza', 0], ['cat-pizza', 1.5], ['cat-sides', 8], ['cat-drinks', 15]]);
  const pizzas = promoDiscountForBasket({ reward_type: 'percent', reward_value: 20, include_category_ids: ['cat-pizza'] }, { subtotal: 190.5, lines });
  assert.equal(pizzas.amount, 3.7);                       // 20% of 17.00 + 1.50
  // An order with no Combo sends exactly the lines it always sent (the same objects in, the same basket out).
  const plain = [MARG, { uid: 'i2', itemId: 'd-six', name: 'Soda Six Pack', cat: 'cat-drinks', price: 20, qty: 2 }];
  assert.ok(linesForPromo(plain).every((l, i) => l === plain[i]));
  assert.deepEqual(promoBasketLines(linesForPromo(plain)), promoBasketLines(plain));
  assert.match(read('../surfaces/CheckoutModal.jsx'), /const lines = promoBasketLines\(linesForPromo\(items\)\);/);
});

// ── 2. A pick's note ────────────────────────────────────────────────────────────────────────────

test('2 the line\'s note is the truth: Change opens with it, and never wipes it or brings an old one back', () => {
  // Rung up with a crust and no note; then "ALLERGY: no nuts" is put on with the Note button.
  const rec = answersFromFlow({ selections: { 'mg-crust': { id: 'o-thin', name: 'Thin' } } });
  assert.deepEqual(rec, { s: { 'mg-crust': { one: 'o-thin' } } });
  const seeded = answersWithNote(rec, 'ALLERGY: no nuts');
  assert.deepEqual(seeded, { s: { 'mg-crust': { one: 'o-thin' } }, n: 'ALLERGY: no nuts' });
  assert.equal(flowFromAnswers(seeded, [{ id: 'mg-crust', options: [{ id: 'o-thin', name: 'Thin' }] }]).notes, 'ALLERGY: no nuts');
  // The other way: a note typed in the flow, then changed with the Note button. The old one is gone.
  const typed = answersFromFlow({ selections: {}, notes: 'no onion' });
  assert.deepEqual(answersWithNote(typed, 'no onion, no garlic'), { n: 'no onion, no garlic' });
  assert.equal(answersWithNote(typed, ''), null);         // the note was cleared and nothing else was answered
  assert.deepEqual(answersWithNote({ v: 'size-l', n: 'old' }, '  '), { v: 'size-l' });
  assert.deepEqual(answersWithNote(null, 'new'), { n: 'new' });
  assert.equal(answersWithNote(null, null), null);
  assert.deepEqual(answersWithNote('rubbish', 'x'), { n: 'x' });
  assert.notEqual(answersWithNote(rec, 'x'), rec, 'the record on the line is never changed in place');
  assert.deepEqual(rec, { s: { 'mg-crust': { one: 'o-thin' } } });

  // The POS opens Change from the line's own note, and the Note button keeps the record in step.
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /answers: answersWithNote\(line\.optionAnswers, line\.notes\),/);
  assert.ok(!/answers: line\.optionAnswers \|\| null,/.test(pos), 'never from the record alone');
  const store = read('../store/index.js');
  const note = store.slice(store.indexOf('\n  updateItemNote: '), store.indexOf('\n  configureLineOptions: '));
  assert.match(note, /const rec = answersWithNote\(i\.optionAnswers, note\);/);
  assert.match(note, /if \(!i\.optionAnswers\) return next;/);          // a line with no record is exactly what it was
  // A size picked on a product with no options shows no note box: the note it opened with is handed back.
  const flow = read('../components/InlineItemFlow.jsx');
  assert.match(flow, /notes: notes\.trim\(\), qty, linePrice: \(variant\.pricing\?\.base \?\? variant\.price \?\? 0\) \* qty, displayName,\n\s+answers: answersFromFlow\(\{ variantId: variant\.id, notes \}\),/);
  assert.ok(!/notes: '', qty, linePrice/.test(flow));
});

// ── 3. A part refund from the phone POS ─────────────────────────────────────────────────────────

test('3 a part refund counts a Combo as one stamp whichever screen asks (the phone POS sends less of each line)', () => {
  const lattes = { uid: 'i9', itemId: 'm-latte', name: 'Latte', cat: 'cat-coffee', price: 3.5, qty: 3, mods: [] };
  const check = [...BYO, lattes];
  const EVERY = { id: 'sc-1', qualifying_category_ids: [], qualifying_item_ids: [] };
  const bd = { itemsAmount: 173.5 };
  // POS History and Back Office send the whole line.
  const whole = BYO.map((l) => ({ ...l, refundQty: l.qty }));
  // The phone POS sends this and no more (surfaces/mpos/MOrderDetail.jsx).
  const thin = BYO.map((l) => ({ uid: l.uid, name: l.name, price: l.price, qty: l.qty, refundQty: l.qty }));
  const a = partRefundLoyaltyBody({ refundId: 'r1', bd, chargedGoods: 184, refundItems: whole, menuItems: MENU, checkItems: check });
  const b = partRefundLoyaltyBody({ refundId: 'r1', bd, chargedGoods: 184, refundItems: thin, menuItems: MENU, checkItems: check });
  assert.deepEqual(b.items, a.items, 'the same lines whichever screen sent them');
  assert.deepEqual(b.items.map((i) => !!i.noStamp), [false, true, true, true, true]);
  assert.equal(countQualifyingStamps(b.items, EVERY), 1);                  // the Combo, once
  assert.deepEqual(b.items.map((i) => i.id), ['c-byo', 'p-marg', 'p-pep', 's-caesar', 'd-six']);   // and the product each line is
  // Without the check's own lines (the old call) every pick counted: 5, and the lattes' stamps went with them.
  const old = partRefundLoyaltyBody({ refundId: 'r1', bd, chargedGoods: 184, refundItems: thin, menuItems: MENU });
  assert.equal(countQualifyingStamps(old.items, EVERY), 5);
  // What the screen sent still wins: the quantity refunded.
  const one = partRefundLoyaltyBody({ refundId: 'r2', bd: { itemsAmount: 3.5 }, chargedGoods: 184, refundItems: [{ uid: 'i9', name: 'Latte', price: 3.5, qty: 3, refundQty: 1 }], menuItems: MENU, checkItems: check });
  assert.deepEqual(one.items.map((i) => [i.name, i.qty, i.cat, i.id]), [['Latte', 1, 'cat-coffee', 'm-latte']]);
  // A line the check does not hold (never, from a real screen) is sent as it came.
  assert.equal(partRefundLoyaltyBody({ refundItems: [{ uid: 'zz', name: 'X', price: 1, qty: 1, refundQty: 1 }], checkItems: check }).items.length, 1);
  assert.match(read('../store/index.js'), /partRefundLoyaltyBody\(\{ refundId, bd, chargedGoods: chargedGoodsOf\(chkBefore\), refundItems, menuItems: get\(\)\.menuItems \|\| \[\], checkItems: chkBefore\.items \|\| \[\] \}\)/);
  // The earn side is untouched: the same lines, the same marks.
  assert.deepEqual(loyaltyEarnItems(BYO, MENU).map((i) => !!i.noStamp), [false, true, true, true, true]);
});

// ── 4. An amount discount on a Combo ────────────────────────────────────────────────────────────

test('4 an amount off a Combo comes off the whole Combo: its own line first, then what its picks add', () => {
  const D = { id: 'disc-1', label: 'Custom 160.00', type: 'amount', value: 160, presetId: null, kind: null };
  assert.equal(comboLinesTotal(BYO), 173.5);
  const out = comboDiscount([MARG, ...BYO], BYO[2], D);                    // put on through a pick: still the Combo's
  const byUid = new Map(out.map((l) => [l.uid, l]));
  assert.deepEqual(BYO.map((l) => byUid.get(l.uid).discount?.value ?? null), [149, null, 1.5, 8, 1.5]);
  assert.equal(byUid.get('i1').discount ?? null, null);                    // a line outside the Combo is untouched
  // Every reader takes a line discount off its own line: together they take exactly what was approved.
  const charged = out.filter((l) => l.comboId === C).reduce((s, l) => s + lineAfterItemDiscount(l), 0);
  assert.equal(cents(charged), 13.5);                                      // 173.50 less 160.00
  assert.equal(cents(linesAfterItemDiscounts(out)), 30.5);                 // plus the 17.00 Margherita
  // Each share is an ordinary line discount with the same label, so receipts and reports read it as any other.
  assert.deepEqual(byUid.get('k3').discount, { ...D, value: 8 });
  // A comp by typing the whole amount: the Combo costs nothing, never less than nothing.
  const comp = comboDiscount(BYO, BYO[0], { ...D, value: 500 });
  assert.equal(cents(comp.reduce((s, l) => s + lineAfterItemDiscount(l), 0)), 0);
  assert.deepEqual(comp.map((l) => l.discount?.value ?? null), [149, null, 1.5, 8, 15]);
  // The everyday case is exactly what it was: 10.00 off sits on the Combo's own line, the same object.
  const TEN = { ...D, label: '10 off', value: 10 };
  const ten = comboDiscount(BYO, BYO[1], TEN);
  assert.deepEqual(ten[0].discount, TEN);
  assert.ok(ten.slice(1).every((l) => l.discount === null));
  // A percent is unchanged (every line), and taking it off clears every line.
  const pct = comboDiscount(BYO, BYO[0], { id: 'p', label: '10%', type: 'percent', value: 10 });
  assert.ok(pct.every((l) => l.discount && l.discount.value === 10));
  assert.ok(comboDiscount(out, BYO[0], null).filter((l) => l.comboId === C).every((l) => l.discount === null));
  // A voided pick takes no share.
  const voided = BYO.map((l) => (l.uid === 'k3' ? { ...l, voided: true } : l));
  assert.deepEqual(comboDiscount(voided, voided[0], D).map((l) => l.discount?.value ?? null), [149, null, 1.5, null, 9.5]);
  // The discount screen offers the whole Combo as one row, which is what is now taken.
  assert.match(read('../surfaces/POSSurface.jsx'), /isComboLine\(i\) \? \{ \.\.\.i, price: comboLinesTotal\(comboLinesOf\(items, i\)\), qty: 1 \} : i/);
});

// ── 5 to 8. What can be added ───────────────────────────────────────────────────────────────────

const row = (id, name, price, extra = {}) => ({ id, name, menuName: name, type: 'simple', pricing: { base: price }, archived: false, ...extra });
const ROWS = [
  row('p-marg', 'Margherita', 16, { allergens: ['gluten', 'milk'] }), row('p-pep', 'Pepperoni', 18, { allergens: ['gluten', 'milk'] }),
  row('f-fish', 'Market fish', null), row('d-six', 'Soda Six Pack', 20),
  row('z-soda', 'Soda', null, { type: 'variants' }), row('z-soda-s', 'Small', 2, { parentId: 'z-soda' }), row('z-soda-l', 'Large', 3, { parentId: 'z-soda' }),
  row('n-nuts', 'Nut brownie', 4, { allergens: ['nuts'] }), row('w-water', 'Water', 1),
];
const rowsById = new Map(ROWS.map((r) => [r.id, r]));
const sizesOf = (id) => ROWS.filter((r) => r.parentId === id && !r.archived);
const ctxOf = (extra = {}) => ({ rowsById, sizesOf, ...extra });
let n = 0;
const p = (stepId, entryId, extra = {}) => ({ key: `k${++n}`, stepId, entryId, itemId: entryId, mods: [], notes: '', answers: null, configured: false, ...extra });
const combo = (steps, extra = {}) => row('c-x', 'Test Combo', 30, { type: 'combo', combo: { v: 1, steps }, ...extra });

test('5 a pick that keeps its own price is never sold at 0.00 for a product with no price set', () => {
  const steps = [
    { id: 'mains', name: 'Pick a main', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'f-fish' }] },
    { id: 'extras', name: 'Add extras?', selectionType: 'multiple', min: 0, max: 9, pricing: 'own', products: [{ itemId: 'f-fish' }, { itemId: 'd-six' }] },
  ];
  // The POS's own rule for every line, as the store hands it to the Combo rules (comboContext).
  const noPriceLine = (r, extras = 0) => r.pricing.base == null && !(extras > 0);
  const c = ctxOf({ noPriceLine });
  // In a "part of the set price" step the product's own price is not charged, so it is fine.
  assert.equal(comboMissing(steps, [p('mains', 'f-fish')], c), null);
  // In a step that keeps prices it would be a free Market fish: refused, in the words addItem uses.
  assert.equal(comboMissing(steps, [p('mains', 'f-fish'), p('extras', 'f-fish')], c), 'Market fish has no price set. Set one in Back Office before selling it.');
  assert.equal(comboMissing(steps, [p('mains', 'f-fish'), p('extras', 'd-six')], c), null);
  // A paid option makes it a real sale (the same exception every POS line has).
  assert.equal(comboMissing(steps, [p('mains', 'f-fish'), p('extras', 'f-fish', { mods: [{ label: 'Sauce', price: 2 }] })], c), null);
  // A context that does not ask (a screen that prices nothing) refuses nothing: as before.
  assert.equal(comboMissing(steps, [p('mains', 'f-fish'), p('extras', 'f-fish')], ctxOf()), null);
  // The store is the one that asks, with the price for this order type and menu.
  const store = read('../store/index.js');
  assert.match(store, /noPriceLine: \(row, extras = 0\) => refusesNoPriceLine\(row, st\.orderType, st\.activeMenuId, tillLineUnitPrice\(row, st\.orderType, st\.activeMenuId, null, 1\) \+ \(Number\(extras\) \|\| 0\)\),/);
  assert.equal(typeof comboPosContext({ noPriceLine }).noPriceLine, 'function');
  assert.equal('noPriceLine' in comboPosContext({}), false);
  // The Back Office says it on the step, before anybody is at the POS.
  const warn = comboWarnings(combo(steps), { rowsById, noPriceRow: (r) => r.pricing.base == null });
  assert.deepEqual(warn.filter((w) => w.stepId === 'extras').map((w) => w.words), ['Market fish has no price set, so it cannot be picked in a step that keeps prices. Set its price first.']);
  assert.deepEqual(warn.filter((w) => w.stepId === 'mains'), []);
  assert.match(read('../backoffice/sections/ComboStepsTab.jsx'), /noPriceRow: \(row\) => \{ const kids = sizesOf\.get\(row\.id\) \|\| \[\]; return kids\.length \? kids\.every\(k => hasNoSellPrice\(k\)\) : hasNoSellPrice\(row\); \},/);
});

test('6 a product whose sizes have their own counts: what is left is every size together', () => {
  const steps = [{ id: 'drinks', name: 'Drinks', selectionType: 'quantity', min: 5, max: 5, pricing: 'set', products: [{ itemId: 'z-soda' }] }];
  const counts = { 'z-soda-s': 2, 'z-soda-l': 3 };
  const c = ctxOf({ remainingOf: (id) => (id in counts ? counts[id] : null) });
  assert.equal(entryState({ itemId: 'z-soda' }, c, []).left, 5);
  assert.equal(comboUnsellable(combo(steps), c), null, '2 Small and 3 Large make the 5');
  // One short, and it is refused with the real figure.
  const c4 = ctxOf({ remainingOf: (id) => ({ 'z-soda-s': 1, 'z-soda-l': 3 })[id] ?? null });
  assert.equal(comboUnsellable(combo(steps), c4), 'Test Combo cannot be made right now: "Drinks" needs 5 and only 4 can be picked.');
  // The product's own count still caps it, whatever its sizes hold.
  const own = ctxOf({ remainingOf: (id) => ({ 'z-soda': 4, 'z-soda-s': 9, 'z-soda-l': 9 })[id] ?? null });
  assert.equal(entryState({ itemId: 'z-soda' }, own, []).left, 4);
  // A size with no count is never the limit.
  assert.equal(entryState({ itemId: 'z-soda' }, ctxOf({ remainingOf: (id) => (id === 'z-soda-s' ? 1 : null) }), []).left, Infinity);
  // "N left" is said from the same figure.
  assert.equal(entryState({ itemId: 'z-soda' }, ctxOf({ remainingOf: (id) => ({ 'z-soda-s': 1, 'z-soda-l': 1 })[id] ?? null }), []).words, '2 left');
});

test('7 a Combo with nothing picked is never added, and one with nothing to pick is never opened', () => {
  const optional = [
    { id: 'a', name: 'Add drinks?', selectionType: 'multiple', min: 0, max: 9, pricing: 'own', products: [{ itemId: 'd-six' }] },
    { id: 'b', name: 'Add a treat?', selectionType: 'single', min: 0, max: 1, pricing: 'set', products: [] },   // left empty in the Back Office
  ];
  assert.equal(comboMissing(optional, [], ctxOf()), 'Nothing is picked yet. Pick at least one thing.');
  assert.equal(comboMissing(optional, [p('zz', 'd-six')], ctxOf()), 'Nothing is picked yet. Pick at least one thing.');   // a pick of no step of this Combo makes no line
  assert.equal(comboMissing(optional, [p('a', 'd-six')], ctxOf()), null);
  // A step that must be chosen still speaks first.
  const must = [{ id: 'm', name: 'Pick a pizza', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'p-marg' }] }, ...optional];
  assert.match(comboMissing(must, [], ctxOf()), /^Pick a pizza: /);
  // Nothing at all can be picked (every product is gone or 86'd): it is not opened.
  assert.equal(comboUnsellable(combo(optional), ctxOf({ eightySix: ['d-six'] })), 'Test Combo cannot be made right now: nothing can be picked.');
  assert.equal(comboUnsellable(combo(optional), ctxOf()), null);
  assert.equal(stepEntries(optional[0], ctxOf(), []).length, 1);
  // The Back Office says that at least one thing must be picked.
  assert.ok(comboWarnings(combo(optional), { rowsById }).some((w) => w.stepId === null && w.level === 'note' && /Every step can be skipped/.test(w.words)));
  assert.ok(!comboWarnings(combo(must), { rowsById }).some((w) => /Every step can be skipped/.test(w.words)));
});

test('8 "each product once" is a rule of the step, whoever sends the picks', () => {
  const once = [{ id: 'o', name: 'Pick 2 pizzas', selectionType: 'multiple_once', min: 2, max: 2, pricing: 'set', products: [{ itemId: 'p-marg' }, { itemId: 'p-pep' }] }];
  assert.equal(comboMissing(once, [p('o', 'p-marg'), p('o', 'p-marg')], ctxOf()), 'Pick 2 pizzas: Margherita can only be picked once');
  assert.equal(comboMissing(once, [p('o', 'p-marg'), p('o', 'p-pep')], ctxOf()), null);
  // A step that allows the same product again is as it was.
  const again = [{ ...once[0], selectionType: 'quantity' }];
  assert.equal(comboMissing(again, [p('o', 'p-marg'), p('o', 'p-marg')], ctxOf()), null);
});

// ── 9. Allergens ────────────────────────────────────────────────────────────────────────────────

test('9 a product a step picks by itself is warned on when the Combo is tapped', () => {
  // A fixed Combo: one pizza (the only product of a must choose step), and a choice of treat.
  const steps = [
    { id: 'pz', name: 'Pizza', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'p-marg' }] },
    { id: 'tr', name: 'Pick a treat', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'n-nuts' }, { itemId: 'w-water' }] },
  ];
  const item = combo(steps, { allergens: ['soy'] });
  // Its own, and the self picked pizza's. The treat is a choice: it is warned on when it is tapped.
  assert.deepEqual(selfPickAllergens(item, ctxOf()), ['soy', 'gluten', 'milk']);
  assert.deepEqual(selfPickAllergens(combo(steps), ctxOf()), ['gluten', 'milk']);
  // A Combo whose steps are all choices brings only its own.
  assert.deepEqual(selfPickAllergens(combo([steps[1]]), ctxOf()), []);
  assert.deepEqual(selfPickAllergens(null, ctxOf()), []);
  const pos = read('../surfaces/POSSurface.jsx');
  assert.match(pos, /const allergensOnAdd = \(item\) => \(comboHasSteps\(item\) \? selfPickAllergens\(item, useStore\.getState\(\)\.comboContext\(item\)\) : \(item\.allergens \|\| \[\]\)\);/);
  assert.match(pos, /if \(allergens\.some\(a=>allergensOnAdd\(item\)\.includes\(a\)\)\) \{ setPendingItem\(item\); return; \}/);
  assert.ok(pos.indexOf('const allergensOnAdd = ') < pos.indexOf('const handleItemTap = '), 'defined before the tap that reads it');
  // The warning lists them, and what is added is still the real product (never the copy the warning shows).
  assert.match(pos, /<AllergenModal item=\{comboHasSteps\(pendingItem\) \? \{ \.\.\.pendingItem, allergens: allergensOnAdd\(pendingItem\) \} : pendingItem\}[^\n]*onConfirm=\{\(\)=>\{const i=pendingItem;clearPendingItem\(\);openFlow\(i\);\}\}/);
});

// ── 10. The database without the column ─────────────────────────────────────────────────────────

test('10 a NEW row is saved without steps the database cannot take; an edit of the steps is never called saved', () => {
  const gone = { code: '42703', message: 'column "combo" of relation "menu_items" does not exist' };
  const cache = { code: 'PGRST204', message: "Could not find the 'combo' column of 'menu_items' in the schema cache" };
  const other = { code: '42703', message: 'column "item_code" of relation "menu_items" does not exist' };
  for (const e of [gone, cache]) assert.equal(isMissingComboColumn(e), true, e.message);
  for (const e of [other, null, { code: '23505', message: 'duplicate key' }, { message: 'combo deal not found' }]) assert.equal(isMissingComboColumn(e), false);
  const cols = { name: 'Copy of Build Your Own', combo: { v: 1, steps: [] }, item_code: 'A1' };
  assert.deepEqual(comboColumnRetry(gone, cols), { cols: { name: 'Copy of Build Your Own', item_code: 'A1' }, note: 'combo-missing-column' });
  assert.equal(comboColumnRetry(gone, { name: 'x' }), null);              // nothing of ours in the write
  assert.equal(comboColumnRetry(other, cols), null);
  // The insert's retry takes each refused column in turn; the item code rule is unchanged.
  assert.deepEqual(itemInsertRetry(gone, cols).note, 'combo-missing-column');
  assert.deepEqual(itemInsertRetry(other, cols), itemCodeRetry(other, cols));
  assert.equal(itemInsertRetry({ code: '23505', message: 'x' }, cols), null);
  // Only a NEW row: an edit keeps the old retry, so a steps edit that cannot be saved fails and says so.
  const w = read('./menuWriters.js');
  assert.match(w, /retryWithout: itemCodeRetry,\n\s+insertRetry: itemInsertRetry,/);
  assert.match(w, /const retry = job\.retryWithout \|\| t\.insertRetry \|\| t\.retryWithout;/);
  assert.match(w, /freshCols: t\.freshCols, retryWithout: t\.retryWithout,/);
  assert.match(read('./db.js'), /retryWithout: itemInsertRetry,/);
});

// ── And two that are about what is shown ────────────────────────────────────────────────────────

test('the Back Office sale detail lists a Combo with its picks under it, never a 0.00 pick', () => {
  const tx = read('../backoffice/sections/Transactions.jsx');
  assert.match(tx, /\{displayOrder\(c\.items \|\| \[\]\)\.map\(\(item, idx\) => \{\n\s+const show = lineShow\(item\);/);
  assert.ok(tx.includes("{show.showAmount ? fmt(item.price) : ''}"), 'the price of a line');
  assert.ok(tx.includes("{show.showAmount ? fmt((item.price || 0) * (item.qty || 1)) : ''}"), 'the total of a line');
  assert.ok(!/\{\(c\.items \|\| \[\]\)\.map\(\(item, idx\) => \(/.test(tx));
  // The rule it reads: a pick shows an amount only when it adds one.
  assert.deepEqual(displayOrder([BYO[2], MARG, BYO[0], BYO[1]]).map((l) => [l.uid, lineShow(l).showAmount]), [['p0', true], ['k2', true], ['k1', false], ['i1', true]]);
  assert.equal(isComboPick(BYO[1]), true);
});

test('steps that are still live can always be taken off, even when the editor is hidden', () => {
  const tab = read('../backoffice/sections/ComboStepsTab.jsx');
  // 5.12.124: never at a site where head office sets the steps (read only there).
  assert.match(tab, /\{block && !readOnly && columnReady && comboHasSteps\(item\) && \(/);
  assert.match(tab, /data-testid="combo-steps-take-off"[^\n]*onClick=\{takeStepsOff\}>Take the steps off<\/button>/);
  assert.match(tab, /if \(!window\.confirm\(`Take the \$\{steps\.length === 1 \? 'step' : `\$\{steps\.length\} steps`\} off \$\{nameOf\(item\)\}\?[^\n]*\)\) return;\n\s+save\(\[\]\);/);
});

// ── The second review (screens and guards) ──────────────────────────────────────────────────────

test('B1 Change on a pick: what the pick holds counts as free, and is never refused for being 86\'d', async () => {
  const { stockGivenBack } = await import('./comboLines.js');
  // Garlic dip had 1; the pick took it (0 left, auto 86'd). Change on that pick must see 1, not 0.
  const held = new Map([['p-marg', 1], ['x-dip', 1]]);
  const counts = { 'x-dip': { remaining: 0, initial: 1 }, 'p-pep': { remaining: 4 } };
  const out = stockGivenBack(['x-dip', 'p-other'], counts, held);
  assert.deepEqual(out.eightySixIds, ['p-other']);
  assert.deepEqual(out.dailyCounts['x-dip'], { remaining: 1, initial: 1 });
  assert.equal(out.dailyCounts['p-pep'], counts['p-pep']);                // a count the pick does not touch is the same object
  assert.deepEqual(counts['x-dip'], { remaining: 0, initial: 1 }, 'the store\'s own counts are never changed');
  // No give back: the very same list and counts (every other flow on the POS).
  const same = stockGivenBack(['a'], counts, null);
  assert.equal(same.dailyCounts, counts);
  assert.deepEqual(same.eightySixIds, ['a']);
  assert.equal(stockGivenBack(['a'], counts, new Map()).dailyCounts, counts);
  // The Combo rules read the same: a size whose PRODUCT the pick ran down is still offered.
  const rows = [
    { id: 'z-soda', name: 'Soda', type: 'variants', pricing: { base: null } },
    { id: 'z-soda-s', name: 'Small', parentId: 'z-soda', pricing: { base: 2 } }, { id: 'z-soda-l', name: 'Large', parentId: 'z-soda', pricing: { base: 3 } },
  ];
  const ctxNow = comboPosContext({ menuItems: rows, eightySixIds: ['z-soda'], dailyCounts: { 'z-soda': { remaining: 0 } } });
  assert.equal(entryState({ itemId: 'z-soda' }, ctxNow, []).state, 'out');
  const ctxBack = comboPosContext({ menuItems: rows, eightySixIds: ['z-soda'], dailyCounts: { 'z-soda': { remaining: 0 } }, giveBack: new Map([['z-soda-s', 1], ['z-soda', 1]]) });
  assert.deepEqual(entryState({ itemId: 'z-soda' }, ctxBack, []).sizes.map((r) => r.id).sort(), ['z-soda-l', 'z-soda-s']);
  // The option flow is opened with the pick's own units, and reads its stock through the rule.
  assert.match(read('../surfaces/POSSurface.jsx'), /initialAnswers=\{setup\.answers\}\n\s+stockGiveBack=\{held\}/);
  assert.match(read('../components/InlineItemFlow.jsx'), /const \{ eightySixIds, dailyCounts \} = useMemo\(\(\) => stockGivenBack\(storeEightySix, storeCounts, stockGiveBack\), \[storeEightySix, storeCounts, stockGiveBack\]\);/);
});

test('B3 a pick prints the kitchen and receipt names the same product prints rung up on its own', async () => {
  const { comboOrderLines, asCounterRow, tillLineBase } = await import('./comboLines.js');
  const { kitchenOverride, receiptOverride } = await import('./itemDisplay.js');
  // Name "Vegetarian Supreme 12in", button "Veggie"; kitchen and receipt names left as the name (what
  // a publish writes when head office sets only a POS name).
  const veg = { id: 'p-veg', name: 'Vegetarian Supreme 12in', menuName: 'Veggie', kitchenName: 'Vegetarian Supreme 12in', receiptName: 'Vegetarian Supreme 12in', type: 'simple', pricing: { base: 16 }, cat: 'c' };
  const deal = { id: 'c-deal', name: 'Build Your Own Package', menuName: 'Test Deal', receiptName: 'Build Your Own Package', kitchenName: 'Build Your Own Package', type: 'combo', pricing: { base: 30 }, cat: 'c',
    combo: { v: 1, steps: [{ id: 's1', name: 'Pizza', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'p-veg', bump: 0 }] }] } };
  // What the counter does: it hands addItem the row with the button's name.
  const counter = { ...veg, name: veg.menuName };
  assert.deepEqual([kitchenOverride(counter), receiptOverride(counter)], ['Vegetarian Supreme 12in', 'Vegetarian Supreme 12in']);
  assert.deepEqual(asCounterRow(veg), counter);
  assert.equal(asCounterRow(counter).name, 'Veggie');                        // the same either way
  let n = 0;
  const lines = comboOrderLines({ item: deal, comboId: 'cmb', setPrice: 30, picks: [{ key: 'k', stepId: 's1', entryId: 'p-veg', itemId: 'p-veg', mods: [], notes: '', configured: true }], uid: () => `u${++n}`, menuItems: [veg, deal] }).lines;
  assert.deepEqual(lines.map((l) => [l.name, l.kitchenName, l.receiptName]), [
    ['Test Deal', 'Build Your Own Package', 'Build Your Own Package'],     // the Combo, as its first add from the counter
    ['Veggie', 'Vegetarian Supreme 12in', 'Vegetarian Supreme 12in'],      // the pick, as the product alone
  ]);
  // Built from the counter's row or the raw row ("Another the same"), the Combo line is the same.
  assert.deepEqual(tillLineBase({ ...deal, name: deal.menuName }).fields, tillLineBase(deal).fields);
  // A product with no names of its own still prints no override.
  assert.deepEqual([tillLineBase({ id: 'x', name: 'Cola', menuName: 'Cola', kitchenName: 'Cola' }).fields.kitchenName], [null]);
});

test('B4 a booking package never seats a Combo with steps as one bare line, and says so', async () => {
  const { packageItemsFor, packageCombosLeftOut } = await import('./bookings/packagePricing.js');
  const menu = [
    { id: 'byo', name: 'Build Your Own Package', type: 'combo', price: 149, combo: { v: 1, steps: [{ id: 's', name: 'Pick', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'marg' }] }] } },
    { id: 'deal', name: 'Old Combo', type: 'combo', price: 20, combo: null },
    { id: 'marg', name: 'Margherita', type: 'simple', price: 16 },
  ];
  const pkg = { id: 'pk', name: 'Party', paymentModel: 'deposit', lines: [
    { id: 'l1', itemId: 'byo', qtyPerCover: 1 }, { id: 'l2', itemId: 'marg', qtyPerCover: 1 }, { id: 'l3', itemId: 'deal', qtyPerCover: 1 },
    { id: 'l4', itemId: 'byo', isPreorderChoice: true }, { id: 'l5', itemId: 'marg', isPreorderChoice: true },
  ] };
  const preorders = [{ id: 'r1', itemId: 'byo', seat: 1 }, { id: 'r2', itemId: 'marg', seat: 2 }];
  const out = packageItemsFor({ pkg, covers: 2, preorders, menuItems: menu, now: 1 });
  assert.deepEqual(out.map((l) => [l.itemId, l.qty, l.price]), [['marg', 2, 16], ['deal', 2, 20], ['marg', 1, 16]]);
  assert.ok(!out.some((l) => l.itemId === 'byo'), 'never the set price with no picks');
  assert.deepEqual(packageCombosLeftOut({ pkg, preorders, menuItems: menu }), ['Build Your Own Package']);
  assert.deepEqual(packageCombosLeftOut({ pkg: { lines: [{ itemId: 'marg' }] }, preorders: [], menuItems: menu }), []);
  assert.deepEqual(packageCombosLeftOut({}), []);
  // A package with no Combo is exactly what it was.
  const plain = { ...pkg, lines: pkg.lines.filter((l) => l.itemId !== 'byo') };
  assert.deepEqual(packageItemsFor({ pkg: plain, covers: 2, preorders: [preorders[1]], menuItems: menu, now: 1 }), packageItemsFor({ pkg: plain, covers: 2, preorders: [preorders[1]], menuItems: menu, now: 1 }));
  // Seating says so, and the builder marks the line.
  const slice = read('../store/bookingsSlice.js');
  assert.match(slice, /const combosLeft = b\.packageId \? packageCombosLeftOut\(\{ pkg, preorders: preorders \|\| \[\], menuItems: get\(\)\.menuItems \|\| \[\] \}\) : \[\];/);
  assert.match(slice, /if \(combosLeft\.length\) get\(\)\.showToast\?\.\(/);
  assert.match(read('../backoffice/sections/PackageBuilder.jsx'), /data-testid="package-line-combo"/);
});

test('B5 B6 the flow opens on the first step with something to do, and a size listed on its own reads in full', () => {
  const flow = read('../components/ComboFlow.jsx');
  assert.match(flow, /const stepOpen = \(s, list\) => !\(fixedAnswer\(s, ctx\) && stepStatus\(s, list\)\.done && !picksOfStep\(list, s\.id\)\.some\(p => pickNeeds\(p, ctx\)\)\);/);
  assert.match(flow, /const firstOpen = \(list\) => \{ const i = steps\.findIndex\(s => stepOpen\(s, list\)\); return i < 0 \? 'summary' : i; \};/);
  assert.match(flow, /for \(let i = index \+ 1; i < steps\.length; i\+\+\) if \(stepOpen\(steps\[i\], list\)\) \{ goTo\(i\); return; \}/);
  assert.ok(!/steps\.findIndex\(s => !stepStatus\(s, list\)\.done/.test(flow), 'an optional step is never passed over');
  assert.match(flow, /const tileName = \(row\) => pickLineName\(row, ctx\.rowsById\);/);
  assert.equal((flow.match(/e\.row\.menuName \|\| e\.row\.name/g) || []).length, 0);
  // Backing out of a pick's options puts back what the step held.
  assert.match(flow, /setConfiguring\(\{ key: made\.key, fresh: true, before: picks \}\)/);
  assert.match(flow, /setPicks\(configuring\.before \|\| picks\.filter\(p => p\.key !== cfgPick\.key\)\)/);
});

test('the rest of the second review: a note box with no options, a category tap, the phone POS lists, price bumps', () => {
  assert.match(read('../components/InlineItemFlow.jsx'), /data-testid="flow-note-no-options"/);
  assert.match(read('../surfaces/POSSurface.jsx'), /onClick=\{\(\) => \{ setCat\(c\.id\); setSearch\(''\); setRightTab\('menu'\); setModalItem\(null\); setEditLine\(null\); setComboItem\(null\); setEditPick\(null\); \}\}/);
  const cart = read('../surfaces/mpos/MCartSheet.jsx');
  assert.match(cart, /displayOrder\(items\)\.reduce\(\(acc, it\) => \{\n\s+const c = isComboLine\(it\) \? 0 : \(it\.course \?\? 1\);/);
  const q = read('../surfaces/mpos/MQueueDetail.jsx');
  assert.match(q, /\{displayOrder\(items\)\.map\(\(it, i\) => \{/);
  assert.match(q, /const show = lineShow\(it, lineTotal\);/);
  assert.match(q, /\{show\.showAmount \? money\(lineTotal\) : ''\}/);
  const tab = read('../backoffice/sections/ComboStepsTab.jsx');
  assert.match(tab, /onClick=\{\(\) => \{ if \(!on && keepPricesOk\(s, id\)\) setStep\(s\.id, x => \(\{ \.\.\.x, pricing: id \}\)\); \}\}/);
  assert.match(tab, /return !n \|\| window\.confirm\(/);
});
