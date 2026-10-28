// menuSetPrice.test.js: v5.11.109 "Set every item on this menu to one price" (Back Office, Menu manager).
// Run: node --test src/lib/menuSetPrice.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { menuPriceTargets, pricingWithMenuPrice, readAmount, previewWords, hasOwnMenuPrices } from './menuSetPrice.js';
import { resolveItemPrice } from './menuPricing.js';
import { runBulkEdits } from './menuBulk.js';

const CATS = [
  { id: 'c-pizza', menuId: 'm-happy' },
  { id: 'c-pizza-veg', parentId: 'c-pizza' },
  { id: 'c-drinks', menuId: 'm-main' },
  { id: 'c-sides', menuId: 'm-main' },
];
const LINKS = [{ menu_id: 'm-happy', category_id: 'c-sides' }];
const ITEMS = [
  { id: 'margherita', cat: 'c-pizza', pricing: { base: 9, takeaway: 8.5 } },
  { id: 'veggie', cat: 'c-pizza-veg', pricing: { base: 10, menus: { 'm-happy': { dineIn: 7 }, 'm-main': { all: 12 } } } },
  { id: 'calzone', cat: 'c-pizza', pricing: { base: 11 } },
  { id: 'calzone-s', parentId: 'calzone', cat: 'c-pizza', pricing: { base: 10 } },
  { id: 'calzone-l', parentId: 'calzone', cat: 'c-pizza', pricing: { base: 13 } },
  { id: 'chips', cat: 'c-sides', pricing: { base: 3 } },
  { id: 'old', cat: 'c-pizza', archived: true, pricing: { base: 5 } },
  { id: 'extra-cheese', cat: 'c-pizza', type: 'subitem', pricing: { base: 1 } },
  { id: 'cola', cat: 'c-drinks', pricing: { base: 2 } },
];

test('every item on the menu: its categories, their sub categories and linked categories; sizes instead of their product', () => {
  const r = menuPriceTargets({ menuId: 'm-happy', categories: CATS, links: LINKS, items: ITEMS });
  assert.deepEqual(r.targets.map((t) => t.id).sort(), ['calzone-l', 'calzone-s', 'chips', 'margherita', 'veggie']);
  assert.equal(r.products, 4, 'margherita, veggie, calzone, chips (not the archived one, not an option, not the drinks)');
  assert.equal(r.withSizes, 1);
  assert.equal(r.sizes, 2);
  assert.equal(r.ownPrices, 1, 'veggie had a dine in price on this menu');
  assert.equal(menuPriceTargets({ menuId: null, categories: CATS, links: LINKS, items: ITEMS }).targets.length, 0);
});

test('the menu price wins on that menu only, every order type, and the base prices stay', () => {
  const r = menuPriceTargets({ menuId: 'm-happy', categories: CATS, links: LINKS, items: ITEMS });
  for (const t of r.targets) {
    const next = { ...t, pricing: pricingWithMenuPrice(t.pricing, 'm-happy', 5) };
    for (const ch of ['dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru']) assert.equal(resolveItemPrice(next, ch, 'm-happy'), 5, `${t.id} ${ch}`);
    assert.equal(next.pricing.base, t.pricing.base, 'base untouched');
    assert.equal(resolveItemPrice(next, 'dine-in', null), resolveItemPrice(t, 'dine-in', null), 'off the menu, the price is as before');
  }
  const veg = pricingWithMenuPrice(ITEMS[1].pricing, 'm-happy', 5);
  assert.deepEqual(veg.menus, { 'm-happy': { all: 5 }, 'm-main': { all: 12 } }, 'another menu\'s price is kept');
  assert.equal(hasOwnMenuPrices({ pricing: veg }, 'm-happy'), false);
});

test('typed amounts', () => {
  assert.equal(readAmount('5'), 5);
  assert.equal(readAmount('£4.5'), 4.5);
  assert.equal(readAmount(' 0 '), 0);
  for (const bad of ['', 'abc', '-1', '1.234', '1e3']) assert.equal(readAmount(bad), null, bad);
});

test('the preview says how many change, the sizes, the replaced prices, and that base prices stay', () => {
  const r = menuPriceTargets({ menuId: 'm-happy', categories: CATS, links: LINKS, items: ITEMS });
  const w = previewWords(r, 'Happy hour', '£5.00');
  assert.equal(w, 'This sets 5 items on Happy hour to £5.00. 1 product has sizes: all 2 sizes get £5.00. 1 had their own order type prices on this menu; those are replaced too. Base prices are not changed.');
  assert.doesNotMatch(w, /[–—!]/);
  assert.equal(previewWords({ products: 0, targets: [] }, 'Brunch', '£1.00'), 'No products are on Brunch yet.');
});

test('the bulk writer builds each patch from the row as it is when its turn comes', async () => {
  const rows = { a: { id: 'a', pricing: { base: 1 } } };
  const sent = [];
  const out = await runBulkEdits([{ id: 'a', patch: (row) => ({ pricing: pricingWithMenuPrice(row.pricing, 'm', 2) }) }], {
    getRow: (id) => rows[id],
    update: async (id, patch) => { sent.push(patch); return { ok: true }; },
  });
  assert.equal(out.saved, 1);
  assert.deepEqual(sent[0], { pricing: { base: 1, menus: { m: { all: 2 } } } });
});

test('Menu manager wiring: asks, previews, confirms, then saves through the store', () => {
  const read = (f) => readFileSync(new URL(`../backoffice/sections/${f}`, import.meta.url), 'utf8');
  const mm = read('MenuManager.jsx');
  assert.match(mm, /import MenuOnePrice from '\.\/MenuOnePrice';/);
  assert.match(mm, /<MenuOnePrice menu=\{m\} categoryLinks=\{categoryLinks\} \/>/);
  const ui = read('MenuOnePrice.jsx');
  assert.match(ui, /import \{ menuPriceTargets, pricingWithMenuPrice, readAmount, previewWords \} from '\.\.\/\.\.\/lib\/menuSetPrice';/);
  assert.match(ui, /Set every item on this menu to one price/);
  assert.match(ui, /if \(!window\.confirm\(`\$\{previewWords\(plan, menu\.name, priceText\)\}/, 'confirm before writing, with the preview');
  assert.match(ui, /await bulkUpdateMenuItems\(\s*plan\.targets\.map\(t => \(\{ id: t\.id, patch: \(row\) => \(\{ pricing: pricingWithMenuPrice\(row\.pricing, menu\.id, amount\) \}\) \}\)\)/);
  assert.match(ui, /The menu's schedule decides when this price applies\./);
  assert.doesNotMatch(ui, /supabase|\.from\(/, 'no direct table write');
  assert.doesNotMatch(ui.replace(/\/\/.*$/gm, ''), /[\u2013\u2014!]\s|!\s*$/m, 'no dashes or exclamation marks in the words');
});
