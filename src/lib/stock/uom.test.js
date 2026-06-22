/**
 * uom.test.js — unit resolver: named packs (Keg/Case/Bottle/glass) + globals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBase, fromBase, formatToken, unitLabel } from './uom.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// Keg: base litres, one named pack "Keg = 50 l"
const keg = { baseUnit: 'l', itemConversions: [], formats: [{ id: 'k1', name: 'Keg', qtyInBase: 50 }] };
// Wine: base ml, Bottle 750, Case 4500, 175ml glass
const wine = { baseUnit: 'ml', itemConversions: [], formats: [
  { id: 'b1', name: 'Bottle', qtyInBase: 750 },
  { id: 'c1', name: 'Case', qtyInBase: 4500 },
  { id: 'g1', name: '175ml glass', qtyInBase: 175 },
] };

test('count kegs → litres', () => {
  near(toBase(2.5, formatToken('k1'), keg), 125);   // 2.5 kegs = 125 l
  near(fromBase(125, formatToken('k1'), keg), 2.5);
});

test('count wine in cases + bottles → ml', () => {
  near(toBase(2, formatToken('c1'), wine), 9000);   // 2 cases
  near(toBase(3, formatToken('b1'), wine), 2250);   // 3 bottles
  near(toBase(2, formatToken('c1'), wine) + toBase(3, formatToken('b1'), wine), 11250); // mixed = 15 bottles
});

test('sell units resolve (175ml glass, bottle)', () => {
  near(toBase(1, formatToken('g1'), wine), 175);
  near(toBase(1, formatToken('b1'), wine), 750);
});

test('global units still work alongside packs (keg half-pint)', () => {
  near(toBase(0.5, 'pt', keg), 0.5 * 568.26125 / 1000); // half pint in litres ≈ 0.284
});

test('unitLabel reads the pack name', () => {
  assert.equal(unitLabel(formatToken('k1'), keg), 'Keg');
  assert.equal(unitLabel('l', keg), 'l');
});

test('unknown pack token throws', () => {
  assert.throws(() => toBase(1, formatToken('nope'), keg), /unknown pack unit/);
});
