// barTabTax.test.js: a bar tab close books its VAT. Run: `npm test`, or `node --test src/lib/barTabTax.test.js`.
//
// 27 Sep 2026: BarSurface stamped tax only when the tab charged added-on (US) tax, so every UK bar
// tab closed with tax_amount null (the same fault as the 192 Leeds reader sales, v5.9.97). The
// record now books UK VAT through computeCheckTotals, like every other till close; US is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tabBill, tabCloseTax } from './barTabTax.js';
import { computeCheckTotals } from './payments/checkTotals.js';
import { computeOrderTaxUnified } from './taxCompute.js';
import { creditDiscounts } from './taxBasis.js';
import { toStoreRate } from './venueTaxRates.js';

const std = toStoreRate({ id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'leeds' });
const zero = toStoreRate({ id: 'zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const salesTax = toStoreRate({ id: 'us', name: 'Sales Tax', code: 'US', rate: 0.1, type: 'exclusive', is_default: true, active: true, location_id: 'provo' });
const uk = { taxRates: [std, zero] };
const us = { taxRates: [salesTax] };

// A tab as the store keeps it: rounds of lines, total = price x qty over the rounds.
const tabOf = (lines) => ({ id: 't1', name: 'Sam', rounds: [{ id: 'r1', items: lines, subtotal: lines.reduce((s, i) => s + i.price * i.qty, 0) }], total: lines.reduce((s, i) => s + i.price * i.qty, 0) });
const ukLines = () => ([
  { uid: 'a', id: 'lager', name: 'Lager', price: 6, qty: 2, taxRateId: 'std' },
  { uid: 'b', id: 'crisps', name: 'Crisps', price: 1.5, qty: 1, taxRateId: 'zero' },
]);
const closeTax = (tab, ctx, paymentInfo = {}) => {
  const items = tab.rounds.flatMap(r => r.items.filter(i => !i.voided));
  const bill = tabBill(tab, ctx, []);
  return tabCloseTax(items, ctx, { bill, paymentInfo });
};

test('a UK bar tab books its VAT (it booked null)', () => {
  const tab = tabOf(ukLines());
  const bill = tabBill(tab, uk);
  assert.equal(bill.taxBreakdown, null, 'the bill still adds nothing on for UK VAT');
  assert.equal(bill.total, 13.5, 'the bill is the tab total, unchanged');
  const t = closeTax(tab, uk, { method: 'card', grand: 13.5, tip: 0 });
  assert.equal(t.taxAmount, 2, '£12 of lager at 20% inclusive = £2.00; the zero rated crisps add nothing');
  assert.equal(t.taxBreakdown.totalTax, 2);
  assert.equal(t.taxBreakdown.hasExclusiveTax, false);
  // What the checkout screen showed ("of which VAT") is what the record books.
  assert.equal(t.taxAmount, bill.tax.totalTax);
});

test('the record is computeCheckTotals over the same lines, as every till close', () => {
  const lines = ukLines();
  const t = closeTax(tabOf(lines), uk, { grand: 13.5 });
  const ct = computeCheckTotals({ items: lines, checkDiscounts: [], covers: 1, orderType: 'bar-tab', taxCtx: uk }).tax;
  assert.deepEqual(t.taxBreakdown, ct);
  // A discounted line (tabs have none today) would book VAT on what was charged, as the till does.
  const disc = [{ ...lines[0], discount: { type: 'percent', value: 50 } }, lines[1]];
  const d = tabCloseTax(disc, uk, { bill: tabBill(tabOf(disc), uk), paymentInfo: {} });
  assert.equal(d.taxAmount, computeCheckTotals({ items: disc, checkDiscounts: [], orderType: 'bar-tab', taxCtx: uk }).tax.totalTax);
  assert.ok(d.taxAmount < 2);
});

test('loyalty and promo credits never move UK VAT (they are tenders)', () => {
  const tab = tabOf(ukLines());
  const credits = creditDiscounts({ promo: 3, loyalty: 2 });
  const bill = tabBill(tab, uk, credits);
  const t = tabCloseTax(tab.rounds[0].items, uk, { bill, paymentInfo: { grand: 13.5, promoRedemption: { amount: 3 }, loyaltyRedemption: { discount_value: 200 } } });
  assert.equal(t.taxAmount, 2);
});

test('a tab charged nothing for goods books no VAT, as recordWalkInClosed', () => {
  const t = closeTax(tabOf(ukLines()), uk, { grand: 0, tip: 0 });
  assert.equal(t.taxAmount, 0);
  assert.equal(t.taxBreakdown.share, 0);
});

test('added-on (US) tax: exactly the bill record, as before', () => {
  const tab = tabOf([{ uid: 'a', id: 'beer', name: 'Beer', price: 20, qty: 1 }]);
  const bill = tabBill(tab, us);
  assert.equal(bill.exclusiveTax, 2);
  assert.equal(bill.total, 22);
  const t = tabCloseTax(tab.rounds[0].items, us, { bill, paymentInfo: { grand: 22 } });
  assert.equal(t.taxBreakdown, bill.taxBreakdown, 'the very same object the bill charged');
  assert.equal(t.taxAmount, 2);
  // And the bill is what the seam says, with or without credits (the moved code is unchanged).
  const credits = creditDiscounts({ promo: 5 });
  assert.deepEqual(tabBill(tab, us, credits).taxBreakdown, computeOrderTaxUnified(tab.rounds[0].items, us, 'bar-tab', { discounts: credits }));
  assert.deepEqual(tabBill(tab, us).taxBreakdown, computeOrderTaxUnified(tab.rounds[0].items, us, 'bar-tab', null));
});

test('no tax set up, nothing to tax, or anything unexpected: nothing stamped, as before', () => {
  const tab = tabOf(ukLines());
  assert.equal(closeTax(tab, { taxRates: [] }), null);
  assert.equal(closeTax(tab, null), null);
  assert.equal(tabCloseTax([], uk, { bill: tabBill(tabOf([]), uk) }), null);
  assert.equal(tabCloseTax([{ price: 5, qty: 1, voided: true }], uk, {}), null);
  assert.equal(tabCloseTax(ukLines(), { get taxRates() { throw new Error('boom'); } }, {}), null);
});

test('wiring: the bar tab close books tabCloseTax, never only the added-on record', () => {
  const bar = fs.readFileSync(new URL('../surfaces/BarSurface.jsx', import.meta.url), 'utf8');
  assert.match(bar, /import \{ tabBill, tabCloseTax \} from '\.\.\/lib\/barTabTax';/);
  assert.match(bar, /const recTax = tabCloseTax\(allItems, useStore\.getState\(\)\.getTaxContext\(\), \{ bill, paymentInfo: payInfo \}\);/);
  assert.match(bar, /\.\.\.\(recTax \? \{ taxAmount: recTax\.taxAmount, taxBreakdown: recTax\.taxBreakdown \} : \{\}\),/);
  assert.doesNotMatch(bar, /bill\.taxBreakdown \? \{ taxAmount/);
  assert.match(bar, /tabBill\(tab, useStore\.getState\(\)\.getTaxContext\(\), creditDiscounts\)/);
});
