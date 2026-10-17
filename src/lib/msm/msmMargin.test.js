// Multi site menu: margin as you price (msmMargin.js) and the till's idle rule (msmTill.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marginFor, netOf, siteMargins, withMargins } from './msmMargin.js';
import { tillIsIdle, isMsmAutoApply, shouldCatchUp } from './msmTill.js';

test('GP against the net price; no recipe says so and never shows a figure', () => {
  assert.equal(Math.round(netOf(3.6, 20) * 100) / 100, 3);
  assert.deepEqual(marginFor({ price: 3.6, vatPct: 20, cost: 0.9 }), { noRecipe: false, net: 3, cost: 0.9, gp: 2.1, gpPct: 70, words: '70% GP' });
  assert.deepEqual(marginFor({ price: 3.6, vatPct: 20, cost: null }), { noRecipe: true, words: 'No recipe' });
  assert.equal(marginFor({ price: 0, vatPct: 20, cost: 1 }).words, 'No price');
});

test('per site margins use each site\'s own recipe cost and price; the price change preview shows before and after', () => {
  const central = {
    products: [{ id: 'p', default_price: 3.6, tax_rate_percent: 20 }],
    productSites: [{ product_id: 'p', location_id: 's1', venue_item_id: 'v1', price: null }, { product_id: 'p', location_id: 's2', venue_item_id: 'v2', price: 4.8 }],
  };
  const costs = { s1: new Map([['v1', 0.9]]), s2: new Map() };
  const m = siteMargins(central, costs, {});
  assert.equal(m.get('p').get('s1').gpPct, 70);
  assert.equal(m.get('p').get('s2').noRecipe, true);
  const rows = withMargins([{ productId: 'p', locationId: 's1', before: 3.6, after: 4.2 }], central, costs, {});
  assert.equal(rows[0].gpBefore.gpPct, 70);
  assert.equal(rows[0].gpAfter.gpPct, 74.3);
});

test('a till takes a head office update by itself only when idle, and only an msm push asks for it', () => {
  assert.equal(tillIsIdle({ lines: [], paymentInProgress: false }), true);
  assert.equal(tillIsIdle({ lines: [{ id: 1 }] }), false, 'never mid sale');
  assert.equal(tillIsIdle({ paymentInProgress: true }), false);
  assert.equal(tillIsIdle({ checkOpen: true }), false);
  assert.equal(tillIsIdle({ modalOpen: true }), false);
  assert.equal(isMsmAutoApply({ pushSource: { kind: 'msm', applyWhenIdle: true } }), true);
  assert.equal(isMsmAutoApply({ pushSource: { kind: 'msm', applyWhenIdle: false } }), false);
  assert.equal(isMsmAutoApply({ pushedBy: 'Someone' }), false, 'an ordinary Push to POS keeps today\'s banner');
  assert.equal(shouldCatchUp({ id: 'b', kind: 'msm', created_at: '2026-10-20T05:55:00Z' }, { id: 'a', created_at: '2026-10-19T05:55:00Z' }), true);
  assert.equal(shouldCatchUp({ id: 'a', kind: 'msm' }, { id: 'a' }), false);
  assert.equal(shouldCatchUp({ id: 'b', kind: 'push' }, { id: 'a' }), false);
});

test('GP takes off the SITE\'s VAT: a kept rate, the mapped rate, and none for an exclusive (US) rate', async () => {
  const { siteVatPct, vatMaps } = await import('./msmMargin.js');
  const p = { id: 'p', tax_rate_name: 'VAT', tax_rate_percent: 20 };
  const rates = [{ id: 'r20', name: 'VAT', rate: 20, active: true }, { id: 'r5', name: 'Reduced', rate: 5, active: true }];
  assert.equal(siteVatPct(p, { kept: {} }, rates), 20);
  assert.equal(siteVatPct(p, { kept: { tax_rate_id: 'r5' } }, rates), 5, 'the site kept its own rate');
  assert.equal(siteVatPct(p, null, [{ id: 'us', name: 'VAT', rate: 20, type: 'exclusive', active: true }]), 0, 'exclusive: the price is already net');
  assert.equal(siteVatPct(p, null, null), 20, 'rates not read: the group\'s rate');
  const m = vatMaps({ productSites: [{ product_id: 'p', location_id: 'L', kept: { tax_rate_id: 'r5' } }] }, { L: rates });
  assert.equal(m.L(p), 5);
});
