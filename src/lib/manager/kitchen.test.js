/** kitchen.test.js — Manager Kitchen below-par + batch status. Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belowPar, bySupplier, batchStatus, groupBatches, roundQty, qtyText } from './kitchen.js';

const NOW = 1_800_000_000_000;
const min = (n) => NOW - n * 60000;

test('belowPar: below par or 86, 86 first then biggest gap', () => {
  const r = belowPar([
    { itemId: '1', name: 'Buns', onHand: 10, par: 4, supplier: 'A' },   // ok
    { itemId: '2', name: 'Milk', onHand: 1, par: 6, supplier: 'B' },    // gap 5
    { itemId: '3', name: 'Limes', onHand: 0, par: 2, supplier: 'B', eightySixed: true },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].itemId, '3');   // 86 first
  assert.equal(r[1].itemId, '2');
  assert.equal(r[1].shortfall, 5);
});
test('bySupplier groups below-par items', () => {
  const g = bySupplier([
    { itemId: '2', name: 'Milk', onHand: 1, par: 6, supplier: 'B' },
    { itemId: '4', name: 'Beer', onHand: 2, par: 10, supplier: 'C' },
  ]);
  assert.deepEqual(Object.keys(g).sort(), ['B', 'C']);
});
test('batchStatus: done / overdue / due', () => {
  assert.equal(batchStatus({ completedAtMs: min(5), dueAtMs: min(60) }, NOW), 'done');
  assert.equal(batchStatus({ completedAtMs: null, dueAtMs: min(10) }, NOW), 'overdue');
  assert.equal(batchStatus({ completedAtMs: null, dueAtMs: min(-30) }, NOW), 'due');
});
test('groupBatches: counts + notRecorded', () => {
  const g = groupBatches([
    { id: 'a', dueAtMs: min(60), completedAtMs: min(50) },
    { id: 'b', dueAtMs: min(20), completedAtMs: null },
    { id: 'c', dueAtMs: min(-30), completedAtMs: null },
  ], NOW);
  assert.equal(g.counts.done, 1);
  assert.equal(g.counts.overdue, 1);
  assert.equal(g.counts.due, 1);
  assert.equal(g.notRecorded, 2);
});
test('qtyText: whole numbers for counted units, two decimals for weight and volume, unit appended', () => {
  assert.equal(qtyText(70.44800000000001, 'l'), '70.45 l');
  assert.equal(qtyText(39.4, 'kg'), '39.4 kg');
  assert.equal(qtyText(15.04, 'l'), '15.04 l');
  assert.equal(qtyText(1080, 'each'), '1080 each');
  assert.equal(qtyText(2.4, 'each'), '3 each');        // you cannot order 2.4 patties
  assert.equal(qtyText(5, null), '5');
  assert.equal(qtyText('nonsense', 'kg'), '0 kg');
  assert.equal(roundQty(29.552, 'l'), 29.55);
  assert.equal(roundQty(3, 'each'), 3);               // an exact whole stays itself
});
test('belowPar: the shortfall is already rounded for its unit', () => {
  const r = belowPar([{ itemId: 'k', name: 'Keg', onHand: 29.552, par: 100, unit: 'l', supplier: 'A' }]);
  assert.equal(r[0].shortfall, 70.45);
  const w = belowPar([{ itemId: 'b', name: 'Buns', onHand: 10.5, par: 20, unit: 'each', supplier: 'A' }]);
  assert.equal(w[0].shortfall, 10);
});
