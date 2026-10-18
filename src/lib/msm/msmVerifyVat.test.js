// Multi site menu, 17 Oct 2026 verification fixes: VAT rates as live data holds them.
// Live tax_rates.rate is a FRACTION (0.2 is 20%), and the import copies it into the group menu as it
// is. GP took 0.2 as 0.2% and the pickers read "Standard Rate (0.2%)". These run on live shaped rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marginFor, siteVatPct, netOf } from './msmMargin.js';
import { siteRateChoices, vatExample, vatCell } from './msmOrderTypes.js';
import { taxChoices } from './msmEdit.js';
import { pctText, ratePercent } from '../../../supabase/functions/_shared/msmModel.js';
import { overrideWords } from '../../../supabase/functions/_shared/msmTax.js';

const LIVE = [
  { id: 'r20', name: 'Standard Rate', rate: 0.2, type: 'inclusive', active: true },
  { id: 'r5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', active: true },
  { id: 'r0', name: 'Zero Rate', rate: 0, type: 'inclusive', active: true },
];

test('GP on a live rate (0.2): a 3.00 price with a 0.80 cost is 68%, not 73%', () => {
  const p = { id: 'p', tax_rate_name: 'Standard Rate', tax_rate_percent: 0.2 };
  const vat = siteVatPct(p, { kept: {} }, LIVE);
  assert.equal(vat, 0.2);
  const m = marginFor({ price: 3, vatPct: vat, cost: 0.8 });
  assert.equal(m.net, 2.5);
  assert.equal(m.words, '68% GP');
  assert.equal(Math.round(netOf(3, 0.2) * 100) / 100, 2.5);
  assert.equal(Math.round(netOf(3.6, 20) * 100) / 100, 3, 'a percent above 1 still reads as a percent');
});

test('VAT labels show 20%, never 0.2%', () => {
  assert.equal(pctText(0.2), '20%');
  assert.equal(pctText(0.08875), '8.875%');
  assert.equal(ratePercent(0.05), 5);
  const choices = siteRateChoices({ A: LIVE });
  assert.deepEqual(choices.map((c) => c.label), ['Standard Rate (20%)', 'Reduced Rate (5%)', 'Zero Rate (0%)']);
  assert.equal(taxChoices({ products: [{ tax_rate_name: 'Standard Rate', tax_rate_percent: 0.2 }] })[0].label, 'Standard Rate 20%');
  assert.equal(overrideWords('r5', LIVE), 'Reduced Rate (5%)');
  assert.equal(vatCell({ tax_rate_name: 'Standard Rate', tax_rate_percent: 0.2 }, null, null, 'dine-in').words, 'Standard Rate 20%');
});

test('the live VAT example on a live rate: a 3.00 Latte has 0.50 VAT at 20%', () => {
  const product = { name: 'Latte', tax_rate_name: 'Standard Rate', tax_rate_percent: 0.2 };
  assert.equal(vatExample({ product, taxByType: {}, rates: LIVE, orderType: 'takeaway', price: 3, siteName: 'Leeds' }).words, 'A 3.00 Latte, takeaway at Leeds: VAT 0.50 (Standard Rate, 20%).');
  const miss = vatExample({ product, taxByType: { takeaway: { name: 'Zero Rate', percent: 0 } }, rates: [LIVE[0]], orderType: 'takeaway', price: 3, siteName: 'Leeds' });
  assert.equal(miss.words, 'Leeds has no Zero Rate at 0%. Add it in Settings, Tax, or that site cannot be published.', 'never "Zero Rate rate"');
});
