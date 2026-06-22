/**
 * costing.test.js — unit tests for the stock costing engine.
 * Run: `npm test` (Node's built-in runner — no third-party framework).
 *
 * Covers the brief's required cases: the crate-of-24 pack→unit maths flowing
 * through to a recipe's cost and GP, the unit-conversion engine (incl. item
 * cross-dimension bridges), nested sub-recipe roll-up, and cycle detection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convert, canConvert } from './conversion.js';
import { globalFactor } from './units.js';
import {
  packBaseUnitCost,
  movingAverageCost,
  componentUnitCost,
  recipeCost,
  foodCostPct,
  gpAmount,
  gpPct,
} from './costing.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// ── Unit conversion ─────────────────────────────────────────────────────────

test('same-dimension global conversions', () => {
  near(convert(1.5, 'kg', 'g'), 1500);
  near(convert(2, 'l', 'ml'), 2000);
  near(convert(16, 'oz', 'g'), 16 * 28.349523125); // = 453.5923... (1 lb)
  near(convert(1, 'lb', 'g'), 453.59237);
  near(convert(1, 'pt', 'ml'), 568.26125); // UK pint, not US
  near(convert(500, 'ml', 'l'), 0.5);
  near(convert(3, 'each', 'each'), 3); // identity
});

test('cross-dimension needs an item bridge, else it throws', () => {
  assert.throws(() => convert(3, 'each', 'g'), /No conversion path/);
  const onion = [{ fromQty: 1, fromUnit: 'each', toQty: 110, toUnit: 'g' }]; // 1 onion = 110 g
  near(convert(3, 'each', 'g', { itemConversions: onion }), 330);
  near(convert(220, 'g', 'each', { itemConversions: onion }), 2);
  assert.equal(canConvert('each', 'g'), false);
  assert.equal(canConvert('each', 'g', { itemConversions: onion }), true);
});

test('multi-hop conversion through a bridge (kg → each via g)', () => {
  // 1 each onion = 110 g  ⇒  1 kg = 1000 g = 1000/110 each ≈ 9.0909 each
  const onion = [{ fromQty: 1, fromUnit: 'each', toQty: 110, toUnit: 'g' }];
  near(convert(1, 'kg', 'each', { itemConversions: onion }), 1000 / 110);
});

test('globalFactor returns null across dimensions', () => {
  assert.equal(globalFactor('each', 'g'), null);
  near(globalFactor('kg', 'g'), 1000);
});

// ── Pack → base-unit cost (the brief's crate-of-24) ─────────────────────────

test('crate of 24 @ £40 → £1.6667 per single unit', () => {
  const { baseContent, baseUnitCost } = packBaseUnitCost({
    packPrice: 40, packQty: 24, innerQty: 1, innerUnit: 'each', baseUnit: 'each',
  });
  assert.equal(baseContent, 24);
  near(baseUnitCost, 40 / 24); // £1.66667
});

test('pack-of-packs: box of 6 × 0.75 L → £/ml', () => {
  const { baseContent, baseUnitCost } = packBaseUnitCost({
    packPrice: 27, packQty: 6, innerQty: 0.75, innerUnit: 'l', baseUnit: 'ml',
  });
  assert.equal(baseContent, 4500); // 6 × 0.75 L = 4.5 L = 4500 ml
  near(baseUnitCost, 27 / 4500); // £0.006/ml
});

test('moving-average cost weights by on-hand', () => {
  // 10 @ £1.00 then receive 10 @ £2.00 → avg £1.50
  near(movingAverageCost({ onHandQty: 10, currentAvg: 1, receivedQty: 10, receivedUnitCost: 2 }), 1.5);
  // no prior stock → take the received cost
  near(movingAverageCost({ onHandQty: 0, currentAvg: 0, receivedQty: 5, receivedUnitCost: 1.6667 }), 1.6667);
});

// ── Crate-of-24 flowing through to a recipe's cost and GP ────────────────────

test('crate-of-24 unit cost flows into a recipe cost and GP', () => {
  const { baseUnitCost } = packBaseUnitCost({ packPrice: 40, packQty: 24, innerQty: 1, innerUnit: 'each', baseUnit: 'each' });
  const ctx = {
    itemsById: {
      coke_can: { id: 'coke_can', kind: 'PURCHASED', baseUnit: 'each', currentCost: baseUnitCost },
    },
  };
  const serve = { yieldQty: 1, yieldUnit: 'each', lines: [{ componentItemId: 'coke_can', qty: 1, unit: 'each' }] };
  const { totalCost } = recipeCost(serve, ctx);
  near(totalCost, 40 / 24); // £1.6667 plate cost

  const price = 3.5; // ex-VAT
  near(foodCostPct(totalCost, price), (40 / 24) / 3.5 * 100); // ≈ 47.6%
  near(gpAmount(price, totalCost), 3.5 - 40 / 24);            // ≈ £1.8333
  near(gpPct(price, totalCost), (3.5 - 40 / 24) / 3.5 * 100); // ≈ 52.4%
});

// ── Nested sub-recipe roll-up ───────────────────────────────────────────────

test('nested sub-recipe (dough) rolls up into a plate (margherita)', () => {
  const ctx = {
    itemsById: {
      flour:      { id: 'flour',      kind: 'PURCHASED', baseUnit: 'g',  currentCost: 0.0012 }, // £1.20/kg
      water:      { id: 'water',      kind: 'PURCHASED', baseUnit: 'ml', currentCost: 0 },
      olive_oil:  { id: 'olive_oil',  kind: 'PURCHASED', baseUnit: 'ml', currentCost: 0.008 },  // £8/L
      mozzarella: { id: 'mozzarella', kind: 'PURCHASED', baseUnit: 'g',  currentCost: 0.006 },  // £6/kg
      tomato:     { id: 'tomato',     kind: 'PURCHASED', baseUnit: 'g',  currentCost: 0.003 },  // £3/kg
      dough:      { id: 'dough',      kind: 'MADE',      baseUnit: 'each' },                     // dough balls
    },
    recipesByOutputItem: {
      // 8 dough balls from 1 kg flour + 600 ml water + 30 ml oil
      dough: {
        outputItemId: 'dough', yieldQty: 8, yieldUnit: 'each',
        lines: [
          { componentItemId: 'flour', qty: 1000, unit: 'g' },
          { componentItemId: 'water', qty: 600, unit: 'ml' },
          { componentItemId: 'olive_oil', qty: 30, unit: 'ml' },
        ],
      },
    },
  };

  // dough total = 1.20 + 0 + 0.24 = £1.44 over 8 balls = £0.18/ball
  near(componentUnitCost('dough', ctx), 0.18);

  const margherita = {
    yieldQty: 1, yieldUnit: 'each',
    lines: [
      { componentItemId: 'dough', qty: 1, unit: 'each' },     // £0.18
      { componentItemId: 'mozzarella', qty: 125, unit: 'g' }, // £0.75
      { componentItemId: 'tomato', qty: 100, unit: 'g' },     // £0.30
    ],
  };
  const { totalCost } = recipeCost(margherita, ctx);
  near(totalCost, 0.18 + 0.75 + 0.30); // £1.23 plate cost

  const price = 9.5; // ex-VAT
  near(gpPct(price, totalCost), (9.5 - 1.23) / 9.5 * 100); // ≈ 87.1%
});

test('usable-% (trim/yield loss) inflates a line cost', () => {
  const ctx = {
    itemsById: { beef: { id: 'beef', kind: 'PURCHASED', baseUnit: 'g', currentCost: 0.02 } }, // £20/kg
  };
  // 100 g plated at 85% usable costs as 100/0.85 g of raw beef
  const r = { yieldQty: 1, yieldUnit: 'each', lines: [{ componentItemId: 'beef', qty: 100, unit: 'g', usablePct: 85 }] };
  near(recipeCost(r, ctx).totalCost, (100 / 0.85) * 0.02);
});

test('wastagePct inflates the whole recipe', () => {
  const ctx = { itemsById: { x: { id: 'x', kind: 'PURCHASED', baseUnit: 'g', currentCost: 1 } } };
  const r = { yieldQty: 1, yieldUnit: 'g', wastagePct: 10, lines: [{ componentItemId: 'x', qty: 100, unit: 'g' }] };
  near(recipeCost(r, ctx).totalCost, 100 * 1.1);
});

// ── Cycle detection ─────────────────────────────────────────────────────────

test('recipe cycle (A → B → A) throws, not infinite loop', () => {
  const ctx = {
    itemsById: {
      A: { id: 'A', kind: 'MADE', baseUnit: 'each' },
      B: { id: 'B', kind: 'MADE', baseUnit: 'each' },
    },
    recipesByOutputItem: {
      A: { outputItemId: 'A', yieldQty: 1, yieldUnit: 'each', lines: [{ componentItemId: 'B', qty: 1, unit: 'each' }] },
      B: { outputItemId: 'B', yieldQty: 1, yieldUnit: 'each', lines: [{ componentItemId: 'A', qty: 1, unit: 'each' }] },
    },
  };
  assert.throws(() => recipeCost(ctx.recipesByOutputItem.A, ctx), /cycle detected/);
});

test('a MADE item without a recipe falls back to currentCost', () => {
  const ctx = { itemsById: { prep: { id: 'prep', kind: 'MADE', baseUnit: 'g', currentCost: 0.05 } } };
  near(componentUnitCost('prep', ctx), 0.05);
});
