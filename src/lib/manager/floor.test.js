/** floor.test.js — Manager floor-state + stalled rule. Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableState, classifyFloor, floorCounts } from './floor.js';

const NOW = 1_800_000_000_000;
const min = (n) => NOW - n * 60000;

test('dining: ordered + recent course', () => {
  assert.equal(tableState({ seatedAtMs: min(40), hasOrder: true, lastFiredAtMs: min(5) }, {}, NOW), 'dining');
});
test('seated, no order, under threshold → seated_no_order', () => {
  assert.equal(tableState({ seatedAtMs: min(5), hasOrder: false, lastFiredAtMs: null }, {}, NOW), 'seated_no_order');
});
test('stalled: seated past threshold with no order', () => {
  assert.equal(tableState({ seatedAtMs: min(15), hasOrder: false, lastFiredAtMs: null }, {}, NOW), 'stalled');
});
test('stalled: too long since last course', () => {
  assert.equal(tableState({ seatedAtMs: min(60), hasOrder: true, lastFiredAtMs: min(30) }, {}, NOW), 'stalled');
});
test('held: bill requested', () => {
  assert.equal(tableState({ seatedAtMs: min(50), hasOrder: true, status: 'bill_req' }, {}, NOW), 'held');
});
test('thresholds are configurable', () => {
  const s = { seatedAtMs: min(8), hasOrder: false };
  assert.equal(tableState(s, { stalledNoOrderMin: 10 }, NOW), 'seated_no_order');
  assert.equal(tableState(s, { stalledNoOrderMin: 5 }, NOW), 'stalled');
});
test('classifyFloor groups + sorts stalled worst-first', () => {
  const g = classifyFloor([
    { id: 'a', seatedAtMs: min(12), hasOrder: false },
    { id: 'b', seatedAtMs: min(40), hasOrder: false },
    { id: 'c', seatedAtMs: min(20), hasOrder: true, lastFiredAtMs: min(2) },
  ], {}, NOW);
  assert.equal(g.stalled.length, 2);
  assert.equal(g.stalled[0].id, 'b');        // longest wait first
  assert.equal(g.dining.length, 1);
  assert.equal(floorCounts([{ seatedAtMs: min(12), hasOrder: false }], {}, NOW).stalled, 1);
});
