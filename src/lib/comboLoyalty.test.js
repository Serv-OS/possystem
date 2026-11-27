// comboLoyalty.test.js: stamp cards and a Combo (5.12.123, stage 1).
//
// THE DEFAULT TAKEN (the brief: "judgement rules take the safe default (picks do not count for
// stamp cards) and list it"): a product picked inside a Combo earns NO stamp of its own. The
// Combo's own line is the product that was sold, and it stamps exactly as any product does. So a
// "buy 9 pizzas, the 10th is free" card does not fill half way from one Build Your Own Package.
// What a pick adds to the bill (an extra, its own price where the step keeps prices) is money, and
// money still counts towards points as it always has.
//
// Stamps are counted on the SERVER (loyalty-earn, from the check's own lines), so the rule is in
// supabase/functions/_shared/earnFromCheck.ts + stampQualify.ts, and the till sends the same flag
// (lib/loyaltyEarnItems.js) for the path that still reads the request, and for a part refund.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { earnItemsFromCheck } from '../../supabase/functions/_shared/earnFromCheck.ts';
import { countQualifyingStamps, stampLookupNeeded } from '../../supabase/functions/_shared/stampQualify.ts';
import { loyaltyEarnItems } from './loyaltyEarnItems.js';

const C = 'cmb-a';
const pick = (uid, itemId, name, cat, o = {}) => ({ uid, itemId, name, cat, price: 0, qty: 1, comboId: C, comboRole: 'pick', ...o });
// Scenario A as the till closes it, plus one pizza and one coffee sold on their own.
const CHECK = {
  id: 'chk-1', items: [
    { uid: 'p0', itemId: 'm-byo', name: 'Build Your Own Package', cat: 'cat-catering', price: 149, qty: 1, comboId: C, comboRole: 'parent', noKitchen: true },
    pick('k1', 'm-marg', 'Margherita', 'cat-pizza', { price: 1.5 }),
    pick('k2', 'm-marg', 'Margherita', 'cat-pizza'),
    pick('k3', 'm-pep', 'Pepperoni', 'cat-pizza'),
    pick('k4', 'm-pep', 'Pepperoni', 'cat-pizza'),
    pick('k5', 'm-bbq', 'BBQ chicken pizza', 'cat-pizza'),
    pick('k6', 'm-garlic', 'Garlic bread', 'cat-sides'),
    pick('k7', 'm-sixpack', 'Soda Six Pack', 'cat-drinks', { price: 20, comboKeepsPrice: true }),
    { uid: 'i1', itemId: 'm-pep', name: 'Pepperoni', cat: 'cat-pizza', price: 15, qty: 2 },
    { uid: 'i2', itemId: 'm-latte', name: 'Latte', cat: 'cat-coffee', price: 3.5, qty: 1 },
    { uid: 'i3', itemId: 'm-marg', name: 'Margherita', cat: 'cat-pizza', price: 13, qty: 1, voided: true },
  ],
};
const MENU = [
  { id: 'm-byo', cat: 'cat-catering' }, { id: 'm-marg', cat: 'cat-pizza' }, { id: 'm-pep', cat: 'cat-pizza' }, { id: 'm-bbq', cat: 'cat-pizza' },
  { id: 'm-garlic', cat: 'cat-sides' }, { id: 'm-sixpack', cat: 'cat-drinks' }, { id: 'm-latte', cat: 'cat-coffee' },
];
const prog = (o = {}) => ({ id: 'sc-1', qualifying_category_ids: [], qualifying_item_ids: [], ...o });

test('the server marks a pick, and only a pick, from the check\'s own lines', () => {
  const items = earnItemsFromCheck(CHECK, MENU);
  assert.equal(items.length, 10);                                           // the voided line is gone
  assert.deepEqual(items.map((i) => [i.name, !!i.noStamp]), [
    ['Build Your Own Package', false],
    ['Margherita', true], ['Margherita', true], ['Pepperoni', true], ['Pepperoni', true], ['BBQ chicken pizza', true],
    ['Garlic bread', true], ['Soda Six Pack', true],
    ['Pepperoni', false], ['Latte', false],
  ]);
  // A line that is not a pick carries no such key at all: it is what it always was.
  assert.equal('noStamp' in items[0], false);
  assert.equal('noStamp' in items[8], false);
  // The money on a pick is still there for points (1.50 extra, 20.00 kept price).
  assert.deepEqual(items.filter((i) => i.noStamp).map((i) => i.price), [1.5, 0, 0, 0, 0, 0, 20]);
  // A pick is told by BOTH marks: a stray field alone never drops a stamp.
  assert.equal('noStamp' in earnItemsFromCheck({ items: [{ itemId: 'x', name: 'X', qty: 1, comboRole: 'pick' }] })[0], false);
  assert.equal('noStamp' in earnItemsFromCheck({ items: [{ itemId: 'x', name: 'X', qty: 1, comboId: 'c' }] })[0], false);
});

test('a card where everything stamps: the Combo is one stamp, not one per pick', () => {
  const items = earnItemsFromCheck(CHECK, MENU);
  // The Combo (1) + two Pepperoni sold on their own (2) + the Latte (1). Never 4 + 7.
  assert.equal(countQualifyingStamps(items, prog()), 4);
  // The same order with the same products rung up plainly stamps every line, as it always did.
  const plain = CHECK.items.map((i) => { const c = { ...i }; delete c.comboId; delete c.comboRole; return c; });
  assert.equal(countQualifyingStamps(earnItemsFromCheck({ items: plain }, MENU), prog()), 11);
});

test('a pizza card: pizzas picked inside a Combo do not stamp, a pizza sold on its own does', () => {
  const items = earnItemsFromCheck(CHECK, MENU);
  assert.equal(countQualifyingStamps(items, prog({ qualifying_category_ids: ['cat-pizza'] })), 2);     // the two Pepperoni on their own
  assert.equal(countQualifyingStamps(items, prog({ qualifying_item_ids: ['m-marg'] })), 0);            // Margherita only ever inside the Combo here
  assert.equal(countQualifyingStamps(items, prog({ qualifying_item_ids: ['m-pep'] })), 2);
  // A card on the Combo itself, or on its category, stamps the Combo once.
  assert.equal(countQualifyingStamps(items, prog({ qualifying_item_ids: ['m-byo'] })), 1);
  assert.equal(countQualifyingStamps(items, prog({ qualifying_category_ids: ['cat-catering'] })), 1);
});

test('a pick never sends the server off to look names up', () => {
  const picksOnly = earnItemsFromCheck({ items: CHECK.items.filter((i) => i.comboRole === 'pick') }, MENU);
  assert.equal(stampLookupNeeded([prog({ qualifying_category_ids: ['other-site-pizza'] })], picksOnly), false);
  // An ordinary pizza the card does not know by id still does, as before.
  assert.equal(stampLookupNeeded([prog({ qualifying_category_ids: ['other-site-pizza'] })], earnItemsFromCheck({ items: [CHECK.items[8]] }, MENU)), true);
});

test('the till sends the same mark (the request path, and a part refund\'s lines)', () => {
  const sent = loyaltyEarnItems(CHECK.items.filter((i) => !i.voided), MENU.map((m) => ({ ...m })));
  assert.deepEqual(sent.map((i) => !!i.noStamp), [false, true, true, true, true, true, true, true, false, false]);
  assert.deepEqual(Object.keys(sent[0]), ['name', 'qty', 'price', 'cat', 'id', 'isComp', 'staffDiscount', 'isGiftCard']);   // a plain line: no new key
  assert.equal(sent[1].noStamp, true);
  // And the server counts those lines the same way it counts its own.
  assert.equal(countQualifyingStamps(sent, prog()), 4);
  assert.equal(countQualifyingStamps(sent, prog({ qualifying_category_ids: ['cat-pizza'] })), 2);
});

test('the rule is in the functions that count stamps (deploy: loyalty-earn and loyalty-refund)', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const q = read('../../supabase/functions/_shared/stampQualify.ts');
  assert.equal((q.match(/it(em)?\.isComp \|\| it(em)?\.isGiftCard \|\| it(em)?\.noStamp\) continue;/g) || []).length, 2);
  assert.match(read('../../supabase/functions/_shared/earnFromCheck.ts'), /\.\.\.\(i\.comboId && i\.comboRole === 'pick' \? \{ noStamp: true \} : \{\}\),/);
  assert.match(read('./loyaltyEarnItems.js'), /\.\.\.\(i\.comboId && i\.comboRole === 'pick' \? \{ noStamp: true \} : \{\}\),/);
  // Both functions count through that one rule.
  assert.match(read('../../supabase/functions/loyalty-earn/index.ts'), /items = earnItemsFromCheck\(check as CheckRow, menu\);/);
  assert.match(read('../../supabase/functions/loyalty-earn/index.ts'), /countQualifyingStamps\(items as any\[\], prog, stampNames\)/);
  assert.match(read('../../supabase/functions/loyalty-refund/index.ts'), /countQualifyingStamps\(partItems, prog as any, stampNames\)/);
});
