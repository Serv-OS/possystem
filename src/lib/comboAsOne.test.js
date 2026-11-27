// comboAsOne.test.js: the screens that let staff PICK lines take a Combo whole (5.12.123, stage 1).
//
// Peter, 27 Nov 2026 (defaults he did not object to): void, refund, discount and split act on the
// whole Combo. The store is the one door for void, discount, seat, quantity, transfer and refund
// (comboStore.test.js pins those). This file pins the screens in front of that door: split bill by
// item, and the three refund pickers (POS History, Back Office Transactions, phone POS), so nobody
// is ever offered half a Combo and then refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { splitUnits, comboUids, keepsCombosWhole, wholeCombos, comboLinesTotal } from './combo.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const C = 'cmb-a';
const BYO = [
  { uid: 'p0', name: 'Build Your Own Package', price: 149, qty: 1, comboId: C, comboRole: 'parent', noKitchen: true, seat: '1' },
  { uid: 'k1', name: 'Margherita', price: 1.5, qty: 1, comboId: C, comboRole: 'pick', seat: '1' },
  { uid: 'k2', name: 'Pepperoni', price: 0, qty: 1, comboId: C, comboRole: 'pick', seat: '1' },
  { uid: 'k3', name: 'Soda Six Pack', price: 20, qty: 1, comboId: C, comboRole: 'pick', seat: '1' },
];
const COKE = { uid: 'i1', name: 'Coke', price: 3.5, qty: 2, seat: '2' };
const CHIPS = { uid: 'i2', name: 'Chips', price: 4, qty: 1, seat: 'shared' };

test('split by item: a Combo is ONE piece at what the whole Combo comes to', () => {
  const units = splitUnits([COKE, ...BYO, CHIPS]);
  assert.deepEqual(units.map((u) => [u.uid, u.name, u.price, u.qty, u.comboPicks || 0]), [
    ['i1', 'Coke', 3.5, 2, 0],
    ['p0', 'Build Your Own Package', 170.5, 1, 3],
    ['i2', 'Chips', 4, 1, 0],
  ]);
  // Ordinary lines are the very same objects the split always moved.
  assert.equal(units[0], COKE);
  assert.equal(units[2], CHIPS);
  // No pick is a piece of its own, so no pick can land on another check.
  assert.ok(!units.some((u) => ['k1', 'k2', 'k3'].includes(u.uid)));
  // Whatever checks the pieces land on, the money is all there, once.
  const money = (list) => list.reduce((s, i) => s + i.price * i.qty, 0);
  assert.equal(money(units), money([COKE, ...BYO, CHIPS]));
  assert.equal(units[1].price, comboLinesTotal(BYO));
});

test('split by item: a voided Combo is left out, a part voided line set never counts twice', () => {
  assert.deepEqual(splitUnits(BYO.map((l) => ({ ...l, voided: true }))), []);
  assert.deepEqual(splitUnits([]), []);
  assert.deepEqual(splitUnits(null), []);
  // An order with no Combo splits exactly as it always did.
  assert.deepEqual(splitUnits([COKE, { ...CHIPS, voided: true }]), [COKE]);
});

test('the split screen deals in those pieces, and says a Combo moves as one', () => {
  const src = read('../components/SplitModal.jsx');
  assert.match(src, /import \{ splitUnits \} from '\.\.\/lib\/combo\.js';/);
  assert.match(src, /setUnassigned\(splitUnits\(nonVoided\)\);/);
  assert.ok(!/setUnassigned\(\[\.\.\.nonVoided\]\)/.test(src), 'the pool is never the raw lines again');
  assert.match(src, /moves as one/);
});

test('a refund pick of any line of a Combo is a pick of the whole Combo', () => {
  const lines = [COKE, ...BYO];
  // What the three screens ask: which uids go together.
  assert.deepEqual(comboUids(lines, 'k2'), ['p0', 'k1', 'k2', 'k3']);
  assert.deepEqual(comboUids(lines, 'p0'), ['p0', 'k1', 'k2', 'k3']);
  assert.deepEqual(comboUids(lines, 'i1'), ['i1']);
  // What the store then checks before any money moves.
  assert.equal(keepsCombosWhole(lines, ['p0', 'k1', 'k2', 'k3']), true);
  assert.equal(keepsCombosWhole(lines, ['i1']), true);
  assert.equal(keepsCombosWhole(lines, ['k2']), false);                 // one pick alone: refused
  assert.equal(keepsCombosWhole(lines, ['p0']), false);                 // the Combo's own line alone: refused
  assert.deepEqual(wholeCombos(lines, ['k2', 'i1']), ['i1', 'p0', 'k1', 'k2', 'k3']);
});

test('the three refund screens tick a Combo whole and say so', () => {
  // POS History.
  const pos = read('../components/CheckHistory.jsx');
  assert.match(pos, /const group=comboUids\(check\.items,uid\);/);
  assert.match(pos, /group\.forEach\(u=>\{/);
  assert.match(pos, /\{isOn&&remaining>1&&!isComboLine\(item\)&&\(/, 'no quantity stepper on a Combo line');
  assert.match(pos, /COMBO_WORDS\.refundWhole/);
  // Back Office Transactions.
  const bo = read('../backoffice/sections/Transactions.jsx');
  assert.match(bo, /const group = comboUids\(lines, uid\);/);
  assert.match(bo, /const on = !group\.some\(u => prev\[u\] > 0\);/);
  assert.match(bo, /COMBO_WORDS\.refundWhole/);
  // Phone POS.
  const phone = read('../surfaces/mpos/MOrderDetail.jsx');
  assert.match(phone, /const group = comboUids\(items, uid\);/);
  assert.match(phone, /group\.forEach\(u => \{ next\[u\] = qty > 0 \?/);
  assert.match(phone, /COMBO_WORDS\.refundWhole/);
  // And behind all three, the store refuses anything that cuts a Combo.
  const store = read('../store/index.js');
  assert.match(store, /if \(!isFullRefund && !keepsCombosWhole\(\(chkFound\.items \|\| \[\]\)\.filter\(i => i && !i\.voided\), \(refundItems \|\| \[\]\)\.map\(i => i\?\.uid\)\)\) \{/);
});
