// headlessTax.test.js: a card sale closed by the reconciler books VAT like any other.
// 27 Sep 2026: Leeds had 183 of 298 checks with no VAT; all were reader sales closed by
// TerminalJobReconciler, whose record hard coded taxAmount null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headlessTaxBreakdown, isUsableBreakdown, itemsTaxRecord, scaleTaxRecord, paidShare, headlessService } from './headlessTax.js';
import { toStoreRate } from './venueTaxRates.js';

const LEEDS = 'leeds';
const std = toStoreRate({ id: 'leeds-std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: LEEDS });
const zero = toStoreRate({ id: 'leeds-zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: LEEDS });

test('the bill\'s own frozen tax is booked as charged', () => {
  const frozen = { totalTax: 0.6, breakdown: [{ rate: std, tax: 0.6, net: 3, gross: 3.6, items: 1 }], subtotal: 3, total: 3.6 };
  assert.equal(headlessTaxBreakdown({ items: [{ price: 3.6, qty: 1 }], taxBreakdown: frozen }, { taxRates: [std] }), frozen);
});

test('an older draft (no frozen tax) is computed from its items with the till\'s rates', () => {
  const draft = { items: [{ id: 'l', price: 3.6, qty: 1, taxRateId: 'leeds-std' }, { id: 'c', price: 2.4, qty: 2, taxRateId: null }], orderType: 'dine-in', discounts: [] };
  const t = headlessTaxBreakdown(draft, { taxRates: [std, zero] });
  assert.ok(isUsableBreakdown(t));
  assert.equal(Math.round(t.totalTax * 100), 140, '£8.40 inclusive of 20% VAT is £1.40: a product with no rate takes the venue default');
  assert.equal(t.breakdown[0].rate.id, 'leeds-std');
});

test('voided lines are left out; a zero rated line books zero', () => {
  const draft = { items: [{ price: 5, qty: 1, taxRateId: 'leeds-zero' }, { price: 6, qty: 1, taxRateId: 'leeds-std', voided: true }] };
  const t = headlessTaxBreakdown(draft, { taxRates: [std, zero] });
  assert.equal(t.totalTax, 0);
});

test('no tax set up at all, or no items: null (never a guessed figure)', () => {
  assert.equal(headlessTaxBreakdown({ items: [{ price: 1, qty: 1 }] }, { taxRates: [] }), null);
  assert.equal(headlessTaxBreakdown({ items: [] }, { taxRates: [std] }), null);
  assert.equal(headlessTaxBreakdown(null, { taxRates: [std] }), null);
});

test('a frozen breakdown without a real number is not trusted', () => {
  assert.equal(isUsableBreakdown({ totalTax: null }), false);
  assert.equal(isUsableBreakdown({ totalTax: 'abc' }), false);
  assert.equal(isUsableBreakdown({ totalTax: 0 }), true);
  const t = headlessTaxBreakdown({ items: [{ price: 1.2, qty: 1 }], taxBreakdown: { totalTax: null } }, { taxRates: [std] });
  assert.equal(Math.round(t.totalTax * 100), 20);
});


test('REVIEW: a draft line naming another venue\'s rate books the venue default, never zero', () => {
  const draft = { items: [{ price: 3.6, qty: 1, taxRateId: '6a159b5e-train-station' }] };
  const t = headlessTaxBreakdown(draft, { taxRates: [std, zero] });
  assert.equal(Math.round(t.totalTax * 100), 60);
});

test('REVIEW: a QR tab the till force closes books its VAT (it booked none)', () => {
  const items = [{ price: 3.6, qty: 2, taxRateId: 'leeds-std' }, { price: 2, qty: 1, taxRateId: 'leeds-zero' }, { price: 9, qty: 1, voided: true }];
  const t = itemsTaxRecord(items, { taxRates: [std, zero] });
  assert.equal(Math.round(t.totalTax * 100), 120, '£7.20 at 20% inclusive is £1.20; the zero rated line and the void add nothing');
  assert.equal(itemsTaxRecord(items, { taxRates: [] }), null, 'no tax set up: no figure');
  assert.equal(itemsTaxRecord([], { taxRates: [std] }), null);
  assert.equal(Math.round(itemsTaxRecord([{ price: 1.2, qty: 1 }], { taxRates: [std] }).totalTax * 100), 20, 'a line with no rate takes the venue default');
});

test('REVIEW: a QR tab closed short books the VAT of what the card took', () => {
  const items = [{ price: 6, qty: 2, taxRateId: 'leeds-std' }];   // £12.00, £2.00 VAT
  const share = paidShare(9, items);                               // the card took £9 of goods
  assert.equal(share, 0.75);
  const t = itemsTaxRecord(items, { taxRates: [std] }, { share });
  assert.equal(t.totalTax, 1.5);
  assert.equal(t.share, 0.75);
  assert.equal(Math.round(t.breakdown[0].gross * 100), 900);
  assert.equal(scaleTaxRecord({ totalTax: 2, breakdown: [] }, 1).totalTax, 2, 'the whole bill is unchanged');
  assert.equal(scaleTaxRecord({ totalTax: null }, 0.5), null);
  assert.equal(paidShare(20, items), 1, 'never more than the goods');
  assert.equal(paidShare(5, []), 1, 'nothing to measure against: the whole');
  assert.equal(scaleTaxRecord({ totalTax: 2, lineTaxes: [1, 1], breakdown: [] }, 0.5).lineTaxes, undefined, 'per item detail is dropped');
});

test('SECOND REVIEW: at a sales tax venue the headless service never holds the tax booked as tax', () => {
  // A US (exclusive) draft: $10.00 of goods, 8% added on top, no service: the till stamped
  // total 10.80. The record books taxAmount 0.80, so service must be 0, not 0.80 (the accounting
  // day takes tax out of sales; tax left in service too understated goods by the tax).
  const us = toStoreRate({ id: 'cabin-tax', name: 'Sales tax', rate: 0.08, type: 'exclusive', is_default: true, location_id: 'cabin' });
  const draft = { items: [{ price: 10, qty: 1, taxRateId: null }], subtotalMinor: 1000, totalMinor: 1080, orderType: 'takeaway' };
  const t = headlessTaxBreakdown(draft, { taxRates: [us] });
  assert.equal(Math.round(t.totalTax * 100), 80);
  assert.equal(Math.round(t.exclusiveTax * 100), 80);
  assert.equal(headlessService(draft, t), 0, 'the added-on tax is not service');
  // A real service charge on top stays service.
  assert.equal(headlessService({ ...draft, totalMinor: 1205 }, t), 1.25);
  // UK inclusive VAT adds nothing on top: the old figure, unchanged.
  const uk = headlessTaxBreakdown({ items: [{ price: 3.6, qty: 1, taxRateId: 'leeds-std' }] }, { taxRates: [std] });
  assert.equal(headlessService({ subtotalMinor: 360, totalMinor: 405 }, uk), 0.45);
  // No tax figure: the old maths; never below zero.
  assert.equal(headlessService({ subtotalMinor: 1000, totalMinor: 1080 }, null), 0.8);
  assert.equal(headlessService({ subtotalMinor: 1000, totalMinor: 1050 }, t), 0, 'floored at zero');
});

test('v5.9.97 wiring: reader closes, the checkout draft and 100% comps (source pins)', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const store = read('../store/index.js');
  assert.match(store, /import \{ headlessTaxBreakdown, headlessService, taxForChargedGoods \} from '\.\.\/lib\/headlessTax';/);
  assert.match(store, /let headlessTax = null;\n\s*try \{\n\s*headlessTax = headlessTaxBreakdown\(d, \{/, 'the reader close never throws on tax');
  // 8 Oct 2026 (VAT audit, Fix 3): the catch LOGS the error and leaves null for the save time guard
  // (lib/saleVatGuard.js) to repair or refuse; the in memory figure is rounded like the row.
  assert.match(store, /\} catch \(e\) \{\n(?:\s*\/\/.*\n)*\s*console\.error\(\x27\[tax\] reconciler headless record: the VAT could not be worked out:\x27, e\?\.message \|\| e\);\n\s*headlessTax = null;\n\s*\}/);
  assert.match(store, /taxAmount: roundVat\(headlessTax\?\.totalTax\),/);
  assert.match(store, /taxBreakdown: headlessTax,/);
  assert.match(store, /subtotal, service: headlessService\(d, headlessTax\),/);
  assert.doesNotMatch(store, /total: paymentInfo\.grand \|\| subtotal/, 'a 100% comp books £0, not the full price in cash');
  assert.equal((store.match(/paymentInfo\.grand \?\? subtotal/g) || []).length, 2);
  const modal = read('../surfaces/CheckoutModal.jsx');
  assert.match(modal, /\.\.\.\(taxBreakdown && Number\.isFinite\(Number\(taxBreakdown\.totalTax\)\) \? \{ taxBreakdown \} : \{\}\),/, 'the draft carries the bill tax');
  assert.equal((store.match(/taxBreakdown = taxForChargedGoods\(taxBreakdown, paymentInfo\);/g) || []).length, 2, 'table and walk in comps book no VAT');
  assert.match(store, /total: {6}paymentInfo\.grand \?\? session\.total \?\? 0,/, 'a table comp books £0, not the bill');
  assert.doesNotMatch(store, /paymentInfo\.grand \|\| session\.total/);
});

test('v5.9.97: a bill discounted to nothing books no VAT; anything charged keeps its VAT', async () => {
  const { taxForChargedGoods } = await import('./headlessTax.js');
  const tax = { totalTax: 7.48, subtotal: 44.9, total: 44.9, exclusiveTax: 0, breakdown: [{ rate: 20, tax: 7.48, net: 37.42, gross: 44.9 }] };
  const comp = taxForChargedGoods(tax, { grand: 0, tip: 0 });
  assert.equal(comp.totalTax, 0);
  assert.equal(comp.breakdown[0].tax, 0);
  assert.equal(taxForChargedGoods(tax, { grand: 1.5, tip: 1.5 }).totalTax, 0, 'a comp with a tip: the tip is not goods');
  assert.equal(taxForChargedGoods(tax, { grand: 44.9, tip: 0 }), tax);
  assert.equal(taxForChargedGoods(tax, { grand: 22.45 }), tax, 'a partial discount is left to the tax engine');
  assert.equal(taxForChargedGoods(tax, { method: 'void' }), tax, 'no charged amount: unchanged');
  assert.equal(taxForChargedGoods(tax, {}), tax);
  assert.equal(taxForChargedGoods(null, { grand: 0 }), null);
});
