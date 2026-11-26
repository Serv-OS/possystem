// Multi site menu, 5.12.109. Peter, 26 Nov 2026: "on the multi site menu manager you cant change
// the various names POS, receipt and KDS".
//
// The three names could be changed, but only after tapping one small link ("Menu, receipt and
// kitchen names") that nobody found. Menu Manager locks those names for a group product and sends
// people to the Multi site menu, so the boxes must be in plain sight there. These tests pin:
//   1. the product sheet always shows the three boxes, with Menu Manager's words;
//   2. each name stages its own change, is accepted by the server's check, and blank clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { productUpdate } from './msmEdit.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkChange } from '../../../supabase/functions/_shared/msmModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(join(here, '../../backoffice/sections/msm/MsmProductSheet.jsx'), 'utf8');

const L1 = 'site-0000-0000-0000-00000000aa01';
function ctxOf() {
  const live = {
    menu: { id: 'm', name: 'Menu' },
    sites: [{ location_id: L1 }],
    categories: [{ id: 'hot', label: 'Hot', sort_order: 1 }],
    products: [{ id: 'latte', name: 'Latte', menu_name: 'Latte', receipt_name: null, kitchen_name: null, category_id: 'hot', default_price: 3, default_channels: null, tax_rate_name: 'VAT', tax_rate_percent: 20, family_base: 'm-latte' }],
    productSites: [{ product_id: 'latte', location_id: L1, venue_item_id: 'm-latte', price: null, active: true, kept: {} }],
    groups: [], groupSites: [],
  };
  return { live, eff: applyChanges(live, []).central };
}

test('the product sheet always shows the POS, receipt and kitchen name boxes', () => {
  assert.doesNotMatch(sheet, /moreNames/, 'the boxes are not behind a link or a switch');
  for (const id of ['msm-name-pos', 'msm-name-receipt', 'msm-name-kitchen']) assert.match(sheet, new RegExp(`data-testid="${id}"`), `${id} is on the sheet`);
  assert.match(sheet, /label="POS button name"[^\n]*set\('menu_name'/);
  assert.match(sheet, /label="Receipt name"[^\n]*set\('receipt_name'/);
  assert.match(sheet, /label="Kitchen \/ KDS name"[^\n]*set\('kitchen_name'/);
});

test('each name stages its own change and the server check accepts it', () => {
  const ctx = ctxOf();
  const r = productUpdate(ctx, 'latte', { name: 'Latte', menu_name: 'Caffe latte', receipt_name: 'Latte 12oz', kitchen_name: 'LATTE HOT' });
  assert.deepEqual(r.change.after, { menu_name: 'Caffe latte', receipt_name: 'Latte 12oz', kitchen_name: 'LATTE HOT' });
  assert.deepEqual(r.change.before, { menu_name: 'Latte', receipt_name: null, kitchen_name: null });
  assert.equal(checkChange(r.change).ok, true);
  // The name itself is untouched: only the three names move.
  const after = applyChanges(ctx.live, [r.change]).central.products.find((p) => p.id === 'latte');
  assert.equal(after.name, 'Latte');
  assert.equal(after.kitchen_name, 'LATTE HOT');
  assert.equal(after.receipt_name, 'Latte 12oz');
});

test('one name on its own, and a blank box puts it back on the name', () => {
  const ctx = ctxOf();
  const one = productUpdate(ctx, 'latte', { kitchen_name: 'LATTE HOT' });
  assert.deepEqual(one.change.after, { kitchen_name: 'LATTE HOT' });
  const eff = applyChanges(ctx.live, [one.change]).central;
  // The sheet sends null for a blank box (fieldsOut), which clears it.
  const back = productUpdate({ live: ctx.live, eff }, 'latte', { kitchen_name: null });
  assert.deepEqual(back.change.after, { kitchen_name: null });
  // Nothing typed, nothing staged.
  assert.equal(productUpdate(ctx, 'latte', { receipt_name: null, kitchen_name: null }).change, null);
});
