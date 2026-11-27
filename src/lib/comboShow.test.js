// comboShow.test.js: how a Combo shows wherever people READ an order (5.12.123, stage 1).
//
// Peter, 27 Nov 2026: the receipt shows the Combo and its price, with the picks under it. A pick
// prints no price of its own; what it adds (an extra, a price bump, its own price where the step
// keeps prices) prints beside it. So no screen and no paper ever shows a "0.00" line under a Combo,
// and what is printed still adds up to what was charged.
//
// The two rules are lib/combo.js displayOrder + lineShow. The printed bytes are pinned in
// printer.golden.test.js; this file pins the rules, the merge on a receipt, the customer screen's
// lines, and that every screen that lists an order's lines goes through the same two rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { displayOrder, lineShow, comboLinesTotal } from './combo.js';
import { consolidateReceiptLines, receiptLineSig } from './receiptLines.js';
import { displayLinesFor } from './displayLines.js';

const C = 'cmb-a';
const parent = (o = {}) => ({ uid: 'p0', name: 'Build Your Own Package', price: 149, qty: 1, comboId: C, comboRole: 'parent', noKitchen: true, mods: [], ...o });
const pick = (uid, name, o = {}) => ({ uid, name, price: 0, qty: 1, comboId: C, comboRole: 'pick', mods: [], ...o });
// Scenario A as the POS writes it: 5 pizzas (one with an extra), 2 breads, a salad with chicken, a six pack that keeps its price.
const BYO = [
  parent(),
  pick('k1', 'Margherita', { price: 1.5, mods: [{ label: 'Extra cheese', price: 1.5 }] }),
  pick('k2', 'Margherita'),
  pick('k3', 'Pepperoni'),
  pick('k4', 'Pepperoni'),
  pick('k5', 'BBQ chicken pizza'),
  pick('k6', 'Garlic bread'),
  pick('k7', 'Cheese bread'),
  pick('k8', 'Caesar Salad Catering Size', { price: 8, mods: [{ label: 'Chicken', price: 8 }] }),
  pick('k9', 'Soda Six Pack', { price: 20, comboKeepsPrice: true }),
];
const COKE = { uid: 'i1', name: 'Coke', price: 3.5, qty: 2, mods: [] };
const PEP = { uid: 'i2', name: 'Pepperoni', price: 15, qty: 1, mods: [] };

test('an order with no Combo reads in the order it was rung up, the same lines', () => {
  const lines = [COKE, PEP, { uid: 'i3', name: 'Chips', price: 4, qty: 1 }];
  const out = displayOrder(lines);
  assert.deepEqual(out, lines);
  assert.ok(out.every((l, i) => l === lines[i]));          // the same objects, nothing copied or reordered
  assert.deepEqual(displayOrder(null), []);
  assert.deepEqual(displayOrder([null, COKE]), [COKE]);
});

test('a Combo reads as its own line, then its picks, wherever its lines sit in the order', () => {
  // The picks were split up by another line and the Combo's own line came last (it never should, but the rule holds).
  const jumbled = [BYO[1], COKE, BYO[2], BYO[9], BYO[0], ...BYO.slice(3, 9), PEP];
  assert.deepEqual(displayOrder(jumbled).map((l) => l.uid), ['p0', 'k1', 'k2', 'k9', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'i1', 'i2']);
  // Two Combos stay two blocks, each with its own picks.
  const second = [parent({ uid: 'q0', comboId: 'cmb-b', name: 'Lunch Combo', price: 12 }), pick('q1', 'Chicken supreme', { comboId: 'cmb-b', price: 2.5 })];
  assert.deepEqual(displayOrder([...BYO.slice(0, 3), second[0], BYO[3], second[1]]).map((l) => l.uid), ['p0', 'k1', 'k2', 'k3', 'q0', 'q1']);
  // A pick whose Combo line is not in the list (it never should be) is still shown, as a line.
  assert.deepEqual(displayOrder([COKE, BYO[3]]).map((l) => l.uid), ['i1', 'k3']);
});

test('a pick shows an amount only when it adds one; every other line always shows its amount', () => {
  assert.deepEqual(lineShow(BYO[0]), { pick: false, parent: true, lead: '', amount: 149, showAmount: true });
  assert.deepEqual(lineShow(BYO[2]), { pick: true, parent: false, lead: '  ', amount: 0, showAmount: false });   // part of the set price
  assert.deepEqual(lineShow(BYO[1]), { pick: true, parent: false, lead: '  ', amount: 1.5, showAmount: true });  // an extra
  assert.deepEqual(lineShow(BYO[9]), { pick: true, parent: false, lead: '  ', amount: 20, showAmount: true });   // keeps its price
  assert.deepEqual(lineShow(COKE), { pick: false, parent: false, lead: '', amount: 7, showAmount: true });
  // A free ordinary line still prints 0.00, as it always did: only a Combo's pick drops it.
  assert.equal(lineShow({ name: 'Tap water', price: 0, qty: 1 }).showAmount, true);
  // The screen can pass the amount it shows (a line after its discount).
  assert.equal(lineShow(BYO[1], 0).showAmount, false);
  assert.equal(lineShow(BYO[2], 2.5).amount, 2.5);
  assert.equal(lineShow(null).showAmount, true);
});

test('what the picks show adds up to the Combo: nothing is moved between lines', () => {
  const shown = displayOrder(BYO).map((l) => lineShow(l)).filter((s) => s.showAmount).reduce((n, s) => n + s.amount, 0);
  assert.equal(shown, 178.5);
  assert.equal(shown, comboLinesTotal(BYO));
});

test('a receipt merges the same pick inside ONE Combo, and never across a Combo', () => {
  const out = consolidateReceiptLines([...BYO, PEP, COKE, { ...COKE, uid: 'i9' }]);
  assert.deepEqual(out.map((l) => [l.qty, l.name, l.price]), [
    [1, 'Build Your Own Package', 149],
    [1, 'Margherita', 1.5],                  // with Extra cheese: not the same as the plain one
    [1, 'Margherita', 0],
    [2, 'Pepperoni', 0],                     // two the same in this Combo print once
    [1, 'BBQ chicken pizza', 0],
    [1, 'Garlic bread', 0],
    [1, 'Cheese bread', 0],
    [1, 'Caesar Salad Catering Size', 8],
    [1, 'Soda Six Pack', 20],
    [1, 'Pepperoni', 15],                    // the one sold on its own stays its own line
    [4, 'Coke', 3.5],                        // ordinary lines merge exactly as before
  ]);
  // The same Combo rung up twice prints twice, each with its own picks (never "2x" across them).
  const again = BYO.map((l) => ({ ...l, uid: `${l.uid}b`, comboId: 'cmb-b' }));
  const two = consolidateReceiptLines([...BYO, ...again]);
  assert.equal(two.length, 18);
  assert.equal(two.filter((l) => l.comboRole === 'parent').length, 2);
  assert.ok(two.every((l) => l.name !== 'Pepperoni' || l.qty === 2));
  // A voided Combo prints nothing at all.
  assert.deepEqual(consolidateReceiptLines(BYO.map((l) => ({ ...l, voided: true }))), []);
  // A line outside a Combo keeps the very signature it always had.
  assert.equal(receiptLineSig(COKE), JSON.stringify({ n: 'Coke', p: 3.5, m: [], note: '', v: '' }));
});

test('the customer screen: picks follow the Combo and are marked, the totals are untouched', () => {
  const lines = displayLinesFor([COKE, BYO[3], BYO[0], BYO[1], BYO[9]]);
  assert.deepEqual(lines.map((l) => [l.name, l.lineTotal, !!l.pick, !!l.hideAmount]), [
    ['Coke', 7, false, false],
    ['Build Your Own Package', 149, false, false],
    ['Pepperoni', 0, true, true],
    ['Margherita', 1.5, true, false],
    ['Soda Six Pack', 20, true, false],
  ]);
  assert.equal(lines.reduce((n, l) => n + l.lineTotal, 0), 177.5);
  // An ordinary line is the same object shape it always was (no new keys).
  assert.deepEqual(Object.keys(lines[0]), ['uid', 'name', 'qty', 'lineTotal', 'mods', 'notes']);
});

test('every screen and paper that lists an order goes through the same two rules', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  // Thermal and browser receipts take the merged lines (receiptLines.js orders them) and ask lineShow.
  assert.match(read('./receiptLines.js'), /displayOrder\(\(items \|\| \[\]\)\.filter\(\(i\) => i && !i\.voided\)\)/);
  for (const f of ['./printDoc.js', './printer.js']) {
    const src = read(f);
    assert.match(src, /consolidateReceiptLines\(items\)/, f);
    assert.match(src, /const show ?= ?lineShow\(item\)/, f);
    assert.match(src, /show\.showAmount ?\? ?mny\(item\.price\*item\.qty\) ?: ?''/, f);
  }
  // The rest order the lines themselves.
  for (const f of ['../components/ReceiptModal.jsx', '../components/OrderReviewModal.jsx', '../components/CheckHistory.jsx',
    '../surfaces/TablesSurface.jsx', '../surfaces/OrdersHub.jsx', './sendReceipt.js', './displayLines.js']) {
    const src = read(f);
    assert.match(src, /displayOrder\(/, `${f} orders a Combo's picks under it`);
    assert.match(src, /lineShow\(/, `${f} asks whether a pick shows an amount`);
    assert.match(src, /show\.showAmount/, `${f} never prints 0.00 under a Combo`);
  }
  // The emailed receipt has three forms (merge tag text, HTML, plain text): all three.
  assert.equal((read('./sendReceipt.js').match(/const items = displayOrder\(\(check\.items \|\| \[\]\)\.filter\(i => !i\.voided\)\);/g) || []).length, 3);
  assert.equal((read('./sendReceipt.js').match(/const show = lineShow\(it, lineTotal\);/g) || []).length, 3);
  // The customer screen draws what displayLines marks.
  const cds = read('../surfaces/CustomerDisplaySurface.jsx');
  assert.match(cds, /it\.hideAmount \? '' : money\(line\)/);
  assert.match(cds, /it\.pick \?/);
});
