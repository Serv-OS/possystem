// US basics 9.2 (5.12.57): the Pizza item type carries the demo venue's sample sizes, crusts and
// toppings from src/data/seed.js, priced in the demo's numbers, and no screen lets a venue change
// them. So no type picker offers Pizza on an item that is not already one (the demo venue's pizzas
// keep their tab), and the unused till PizzaBuilder is gone. The online pizza modal still honours an
// item's own sizes, bases and crusts, exactly as before.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('pizza samples (9.2)', () => {
  it('Menu Manager never offers the Pizza type as a choice', () => {
    const src = read('src/backoffice/sections/MenuManager.jsx');
    const picker = src.match(/\[\['simple','Simple'\][^\n]*\]\.map\(/g) || [];
    assert.ok(picker.length > 0);
    for (const line of picker) assert.ok(!line.includes("'pizza'"));
    assert.ok(src.includes("isPizza && { id:'pizza', label:'Pizza' }"));
  });

  it('Menu Visualizer offers Pizza only on an item that already is one', () => {
    const src = read('src/backoffice/sections/MenuVisualizer.jsx');
    assert.ok(src.includes("...(isPizza?[['pizza','Pizza']]:[])"));
    assert.ok(!src.includes("['variants','Has sizes'],['pizza','Pizza']]"));
  });

  it('the unused till PizzaBuilder is removed; the online modal keeps per item options', () => {
    assert.equal(existsSync(new URL('../components/PizzaBuilder.jsx', import.meta.url)), false);
    const pm = read('src/components/ProductModal.jsx');
    assert.ok(pm.includes('item.pizzaSizes  || PIZZA_SIZES'));
    assert.ok(pm.includes('item.pizzaBases  ? PIZZA_BASES.filter'));
  });
});
