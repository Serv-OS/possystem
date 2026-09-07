/**
 * hubriseCatalogPrice.test.js - the price HubRise publishes for a sku.
 * Run: `npm test` (Node's built-in runner; node strips the .ts types).
 *
 * supabase/functions/_shared/hubrise-map.ts carries its own copy of the item
 * price precedence because the edge runtime cannot import src/. This pins that
 * copy to the app's ONE resolver (src/lib/menuPricing.js resolveItemPrice):
 *   menu+channel -> menu.all -> menu.base -> channel default -> base
 * so a Deliveroo or UberEats price can never diverge from what the till,
 * kiosk, phone, online and QR charge for the same item on the same menu.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCatalog } from '../../supabase/functions/_shared/hubrise-map.ts';
import { resolveItemPrice } from './menuPricing.js';

const MENU = 'deliverooMenu';
const cats = [{ id: 'c1', name: 'Mains' }];

const skuPrices = (items, itemMenuId = {}, channel = 'delivery') => {
  const out = buildCatalog({ categories: cats, items, modifierGroups: [], currency: 'GBP', itemMenuId, channel });
  const map = {};
  for (const p of out.products) for (const s of p.skus) map[s.ref] = s.price;
  return map;
};

test('a Base typed into a menu tier is published for that menu, matching the app resolver (9.00, not the 12.00 delivery price)', () => {
  const burger = { id: 'b1', name: 'Burger', cat: 'c1', pricing: { base: 10.5, delivery: 12, menus: { [MENU]: { base: 9 } } } };
  assert.equal(skuPrices([burger], { b1: MENU }).b1, '9.00 GBP');
  assert.equal(resolveItemPrice(burger, 'delivery', MENU), 9);
  // no menu selected for the item: the delivery price, as before
  assert.equal(skuPrices([burger], {}).b1, '12.00 GBP');
  assert.equal(resolveItemPrice(burger, 'delivery', null), 12);
});

test('tier precedence in the mapper equals resolveItemPrice over channel, all, base and the item defaults', () => {
  const rows = [
    { id: 'r1', pricing: { base: 10.5, delivery: 12, menus: { [MENU]: { delivery: 8, all: 8.5, base: 9 } } } },   // tier channel
    { id: 'r2', pricing: { base: 10.5, delivery: 12, menus: { [MENU]: { all: 8.5, base: 9 } } } },                // tier all
    { id: 'r3', pricing: { base: 10.5, delivery: 12, menus: { [MENU]: { base: 9 } } } },                          // tier base
    { id: 'r4', pricing: { base: 10.5, delivery: 12, menus: { [MENU]: { takeaway: 7 } } } },                       // tier for another channel only
    { id: 'r5', pricing: { base: 10.5, delivery: 12 } },                                                          // channel default
    { id: 'r6', pricing: { base: 10.5 } },                                                                        // base
    { id: 'r7', pricing: { base: 0, menus: { [MENU]: { all: 5 } } } },                                            // menu-only item
    { id: 'r8', pricing: { base: 3.5, menus: { [MENU]: { all: 0 } } } },                                          // explicit tier zero
  ].map(r => ({ ...r, name: r.id, cat: 'c1' }));
  const want = { r1: 8, r2: 8.5, r3: 9, r4: 12, r5: 12, r6: 10.5, r7: 5, r8: 0 };
  const itemMenuId = Object.fromEntries(rows.map(r => [r.id, MENU]));
  const got = skuPrices(rows, itemMenuId);
  for (const r of rows) {
    assert.equal(got[r.id], want[r.id].toFixed(2) + ' GBP', r.id);
    assert.equal(resolveItemPrice(r, 'delivery', MENU), want[r.id], `${r.id} app resolver`);
  }
});

test('variant children publish their own tier, with the parent menu as the fallback menu', () => {
  const parent = { id: 'hk', name: 'Heineken', type: 'variants', cat: 'c1', pricing: { base: 0 } };
  const half = { id: 'hk-half', name: 'Half', parent_id: 'hk', pricing: { base: 2.85, delivery: 3.1, menus: { [MENU]: { base: 2.5 } } } };
  const pint = { id: 'hk-pint', name: 'Pint', parent_id: 'hk', pricing: { base: 3.85 } };
  const got = skuPrices([parent, half, pint], { hk: MENU });
  assert.equal(got['hk-half'], '2.50 GBP');
  assert.equal(got['hk-pint'], '3.85 GBP');
  assert.equal(resolveItemPrice(half, 'delivery', MENU), 2.5);
  assert.equal(resolveItemPrice(pint, 'delivery', MENU), 3.85);
});
