// posIdentity.test.js: the POS gives byte identical figures before and after v5.11.78.
// Run: node --test src/lib/parity/posIdentity.test.js
//
// v5.11.78 makes every other channel call the till's own rules. The till itself must not move:
// posGolden.json holds what the POS charged for every golden basket (unit prices, every line's
// price and tax references, the whole bill: subtotal, discounts, service, added on tax, total and
// the full tax record), written by scripts/parityGolden.mjs on origin/main 2bbd9ecc (v5.11.75)
// BEFORE any parity change. This test runs the same baskets through the till's code on this
// branch and compares with deepStrictEqual on the JSON, so a single penny, a float digit or a
// key out of place fails it.
//
// It also pins that lib/taxRefs.js sizeTaxRefs (the size rule every channel now calls) is the
// till's old inline addItem code (v5.5.338) exactly, over every shape of row the store holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BASKETS } from './fixtures.js';
import { posFigures, posUnit } from './pos.js';
import { sizeTaxRefs } from '../taxRefs.js';

const golden = JSON.parse(fs.readFileSync(new URL('./posGolden.json', import.meta.url), 'utf8'));
const asJson = (v) => JSON.parse(JSON.stringify(v));

test('the golden file was written on v5.11.75, before any parity change', () => {
  assert.equal(golden.reference, 'origin/main 2bbd9ecc (v5.11.75)');
  assert.equal(Object.keys(golden.baskets).length, BASKETS.length, 'one golden entry per basket');
});

for (const b of BASKETS) {
  test(`POS basket "${b.id}": every line, the bill and the tax record are byte identical to v5.11.75`, () => {
    assert.deepStrictEqual(asJson(posFigures(b)), golden.baskets[b.id]);
  });
}

test('POS unit prices: every item, order type and menu is byte identical to v5.11.75', () => {
  const now = {};
  for (const key of Object.keys(golden.units)) {
    const [id, ot, m] = key.split('|');
    now[key] = posUnit(id, ot, m || null);
  }
  assert.deepStrictEqual(asJson(now), golden.units);
});

// The till's addItem tax code as it was on v5.11.75, verbatim (store/index.js, v5.5.338).
function oldTillTaxRefs(item, menuItems) {
  let txRate = item.taxRateId || item.tax_rate_id || null;
  let txOv = item.taxOverrides || item.tax_overrides || {};
  if (item.parentId && (!txOv || Object.keys(txOv).length === 0)) {
    const parent = (menuItems || []).find(m => m.id === item.parentId);
    if (parent) {
      txOv = parent.taxOverrides || parent.tax_overrides || txOv;
      if (!txRate) txRate = parent.taxRateId || parent.tax_rate_id || null;
    }
  }
  return { taxRateId: txRate, taxOverrides: txOv };
}

test('taxRefs.sizeTaxRefs is the till\'s old inline size rule exactly, on every row shape', () => {
  const rates = [null, undefined, '', 'r20', 'r5'];
  const ovs = [null, undefined, {}, { takeaway: 'r0' }, { 'dine-in': 'r5', delivery: 'r0' }];
  let n = 0;
  for (const pr of rates) for (const pov of ovs) for (const cr of rates) for (const cov of ovs) for (const hasParent of [true, false]) {
    const parent = { id: 'p', taxRateId: pr, taxOverrides: pov };
    const child = { id: 'c', parentId: hasParent ? 'p' : null, taxRateId: cr, taxOverrides: cov };
    const menu = [parent, child];
    const old = oldTillTaxRefs(child, menu);
    const parentRow = child.parentId ? menu.find(m => m.id === child.parentId) : null;
    const now = sizeTaxRefs(child, parentRow || null);
    assert.deepStrictEqual({ taxRateId: now.taxRateId, taxOverrides: now.taxOverrides }, old, `parent ${pr}/${JSON.stringify(pov)} child ${cr}/${JSON.stringify(cov)} sized ${hasParent}`);
    n++;
  }
  assert.ok(n >= 1000);
});
