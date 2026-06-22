/**
 * explode.test.js — sale → stock-item depletion explosion. Run: npm test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explodeMenuItem, explodeBasket } from './explode.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// A margherita dish: 1 dough (each) + 125 g mozzarella + 100 g tomato.
const ctx = {
  itemsById: {
    dough: { baseUnit: 'each', itemConversions: [] },
    mozzarella: { baseUnit: 'g', itemConversions: [] },
    tomato: { baseUnit: 'g', itemConversions: [] },
    onion: { baseUnit: 'g', itemConversions: [{ fromQty: 1, fromUnit: 'each', toQty: 110, toUnit: 'g' }] },
  },
  menuRecipes: {
    pizza: { portion: 1, wastagePct: 0, lines: [
      { componentItemId: 'dough', qty: 1, unit: 'each', usablePct: 100 },
      { componentItemId: 'mozzarella', qty: 125, unit: 'g', usablePct: 100 },
      { componentItemId: 'tomato', qty: 100, unit: 'g', usablePct: 100 },
    ] },
    soup: { portion: 1, wastagePct: 0, lines: [
      { componentItemId: 'onion', qty: 2, unit: 'each', usablePct: 80 }, // bought in g, recipe in each, 80% usable
    ] },
  },
};

test('explodes one dish into component base quantities', () => {
  const out = explodeMenuItem('pizza', 1, ctx);
  near(out.dough, 1);
  near(out.mozzarella, 125);
  near(out.tomato, 100);
});

test('scales by sold quantity', () => {
  const out = explodeMenuItem('pizza', 3, ctx);
  near(out.dough, 3); near(out.mozzarella, 375); near(out.tomato, 300);
});

test('applies unit bridge + usable% (onion: each→g, 80% usable)', () => {
  const out = explodeMenuItem('soup', 1, ctx);
  // 2 each = 220 g, /0.8 usable = 275 g
  near(out.onion, 275);
});

test('a menu item with no recipe consumes nothing', () => {
  assert.deepEqual(explodeMenuItem('mystery', 5, ctx), {});
});

test('basket aggregates shared ingredients across lines', () => {
  const out = explodeBasket([{ itemId: 'pizza', qty: 2 }, { itemId: 'soup', qty: 1 }], ctx);
  near(out.dough, 2); near(out.mozzarella, 250); near(out.tomato, 200); near(out.onion, 275);
});

test('wastage% inflates consumption', () => {
  const c2 = { ...ctx, menuRecipes: { ...ctx.menuRecipes, pizza: { ...ctx.menuRecipes.pizza, wastagePct: 10 } } };
  near(explodeMenuItem('pizza', 1, c2).mozzarella, 137.5); // 125 × 1.1
});
