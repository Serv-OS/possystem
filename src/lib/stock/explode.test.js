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

// ── Per-order-type lines (reusable mug vs disposable cup) ────────────────────
const otCtx = {
  itemsById: {
    espresso: { baseUnit: 'g', itemConversions: [] },
    milk: { baseUnit: 'ml', itemConversions: [] },
    cup: { baseUnit: 'each', itemConversions: [] },
  },
  menuRecipes: {
    latte: { portion: 1, wastagePct: 0, lines: [
      { componentItemId: 'espresso', qty: 27, unit: 'g', usablePct: 100 },               // untagged → all types
      { componentItemId: 'milk', qty: 240, unit: 'ml', usablePct: 100 },                 // untagged → all types
      { componentItemId: 'cup', qty: 1, unit: 'each', usablePct: 100, orderTypes: ['takeaway', 'collection', 'delivery'] }, // packaging
    ] },
  },
};

test('dine-in latte depletes no cup (reusable mug)', () => {
  const out = explodeMenuItem('latte', 1, otCtx, {}, 'dine-in');
  near(out.espresso, 27); near(out.milk, 240);
  assert.equal(out.cup, undefined);
});

test('takeaway / collection / delivery latte deplete the cup', () => {
  near(explodeMenuItem('latte', 1, otCtx, {}, 'takeaway').cup, 1);
  near(explodeMenuItem('latte', 1, otCtx, {}, 'collection').cup, 1);
  near(explodeMenuItem('latte', 1, otCtx, {}, 'delivery').cup, 1);
});

test('no order type defaults to dine-in/base (no cup)', () => {
  const out = explodeMenuItem('latte', 1, otCtx);   // orderType omitted
  assert.equal(out.cup, undefined);
  near(out.milk, 240);
});

test('explodeBasket threads order type through to lines', () => {
  const out = explodeBasket([{ itemId: 'latte', qty: 2 }], otCtx, 'takeaway');
  near(out.cup, 2); near(out.milk, 480);
});

// Drive thru (16 Sep 2026): a recipe with its own drive-thru packaging depletes that, not the takeaway cup as well.
// This is the till path (store closeCheck -> depleteForSale -> explodeBasket); costing.js and the
// stock-deplete edge function already read the recipe this way, explode.js must agree.
const dtCtx = {
  itemsById: {
    espresso: { baseUnit: 'g', itemConversions: [] },
    cup: { baseUnit: 'each', itemConversions: [] },
    tray: { baseUnit: 'each', itemConversions: [] },
  },
  menuRecipes: {
    latte: { portion: 1, wastagePct: 0, lines: [
      { componentItemId: 'espresso', qty: 27, unit: 'g', usablePct: 100 },                            // untagged → all types
      { componentItemId: 'cup', qty: 1, unit: 'each', usablePct: 100, orderTypes: ['takeaway'] },     // takeaway packaging
      { componentItemId: 'tray', qty: 1, unit: 'each', usablePct: 100, orderTypes: ['drive-thru'] },  // drive thru packaging
    ] },
    mocha: { portion: 1, wastagePct: 0, lines: [
      { componentItemId: 'espresso', qty: 27, unit: 'g', usablePct: 100 },
      { componentItemId: 'cup', qty: 1, unit: 'each', usablePct: 100, orderTypes: ['takeaway'] },     // no drive thru line
    ] },
  },
};

test('drive-thru basket depletes the drive-thru tray only when the recipe has one', () => {
  const out = explodeBasket([{ itemId: 'latte', qty: 2 }], dtCtx, 'drive-thru');
  near(out.espresso, 54); near(out.tray, 2);
  assert.equal(out.cup, undefined);
});

test('takeaway basket still depletes the takeaway cup, never the drive-thru tray', () => {
  const out = explodeBasket([{ itemId: 'latte', qty: 1 }], dtCtx, 'takeaway');
  near(out.cup, 1);
  assert.equal(out.tray, undefined);
});

test('a recipe with no drive-thru line depletes its takeaway cup for drive thru', () => {
  const out = explodeMenuItem('mocha', 1, dtCtx, {}, 'drive-thru');
  near(out.cup, 1);
  assert.equal(out.tray, undefined);
});
