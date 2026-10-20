// inclusiveDiscountVat.test.js: UK inclusive VAT follows the bill's discounts.
// Run: `npm test`, or `node --test src/lib/inclusiveDiscountVat.test.js`.
//
// 27 Sep 2026 (review of the Leeds VAT fix): computeCheckTotals -> computeOrderTaxUnified ->
// calculateOrderTax taxes price x qty before discounts, so a bill discounted by half booked the
// VAT on the full price. Fixed once, in computeCheckTotals (taxShare.inclusiveTaxOnCharged): the
// checkout screen, buildCloseRecord, recordWalkInClosed and headlessTaxBreakdown all read it.
// Reports that recompute UK VAT from the items (recordedCheckTax, the History reprint) take a
// scaled record as booked (taxShare.bookedTaxRecord), so they agree with tax_amount.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeCheckTotals } from './payments/checkTotals.js';
import { headlessTaxBreakdown, taxForChargedGoods } from './headlessTax.js';
import { recordedCheckTax, computeOrderTaxUnified } from './taxCompute.js';
import { scaleTaxRecord, inclusiveTaxOnCharged, linesGoods, bookedTaxRecord, isScaledTaxRecord } from './taxShare.js';
import { linesAfterItemDiscounts, chargedTaxOf, creditDiscounts, LINES_ONLY_BASIS } from './taxBasis.js';
import { toStoreRate } from './venueTaxRates.js';

const std = toStoreRate({ id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'leeds' });
const red = toStoreRate({ id: 'red', name: 'Reduced Rate', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const zero = toStoreRate({ id: 'zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const salesTax = toStoreRate({ id: 'us', name: 'Sales Tax', code: 'US', rate: 0.08875, type: 'exclusive', is_default: true, active: true, location_id: 'provo' });
const UK = [std, red, zero];
const pence = (n) => Math.round(n * 100);

const bill = (items, extra = {}) => computeCheckTotals({
  items, checkDiscounts: [], covers: 1, serviceChargeWaived: false, orderType: 'takeaway',
  deviceConfig: {}, discountRules: [], timezone: 'Europe/London', taxRates: UK, ...extra,
});

test('a bill discounted by half books half the VAT (it booked the full price\'s)', () => {
  const items = [{ uid: 'a', price: 12, qty: 2, taxRateId: 'std' }];   // £24, £4 VAT inside
  const plain = bill(items);
  assert.equal(pence(plain.tax.totalTax), 400);
  const half = bill(items, { checkDiscounts: [{ type: 'percent', value: 50 }] });
  assert.equal(half.discountedSub, 12);
  assert.equal(half.total, 12, 'what the bill charges is unchanged');
  assert.equal(pence(half.tax.totalTax), 200);
  assert.equal(half.tax.share, 0.5);
  assert.equal(pence(half.tax.breakdown[0].gross), 1200);
  assert.equal(pence(half.tax.breakdown[0].net), 1000);
});

test('no discount: the very same result as before, byte for byte (no share key)', () => {
  const items = [{ uid: 'a', price: 3.6, qty: 3, taxRateId: 'std' }, { uid: 'b', price: 2.1, qty: 1, taxRateId: 'red' }];
  const t = bill(items);
  assert.deepEqual(t.tax, computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway'));
  assert.equal('share' in t.tax, false);
  assert.equal(isScaledTaxRecord(t.tax), false);
});

test('an amount off, an item discount and mixed rates: VAT on what EACH line was charged (v5.11.81)', () => {
  const items = [
    { uid: 'a', price: 10, qty: 1, taxRateId: 'std' },
    { uid: 'b', price: 10, qty: 1, taxRateId: 'zero', discount: { type: 'percent', value: 50 } },
  ];
  const t = bill(items, { checkDiscounts: [{ type: 'amount', value: 3 }] });
  // goods 20, after the item discount 15 (a 10, b 5), after £3 off spread by value 12 (a 8, b 4).
  // v5.11.81 (confirmed minor): the item discount belongs to the 0% line, so it takes no VAT off
  // the 20% line. The 20% line was charged 8.00: VAT 1.33. Before, one share (0.6) on every rate
  // booked 1.00, as if half the burger's VAT had gone with the sandwich's discount.
  assert.equal(t.discountedSub, 12);
  assert.equal(t.total, 12, 'what the bill charges is unchanged');
  assert.equal(t.tax.share, 0.6);
  assert.equal(t.tax.byLine, true);
  assert.equal(pence(t.tax.totalTax), pence(8 - 8 / 1.2));
});

test('a check discount alone on mixed rates: the one share, the very same record as before', () => {
  const items = [
    { uid: 'a', price: 10, qty: 1, taxRateId: 'std' },
    { uid: 'b', price: 10, qty: 1, taxRateId: 'zero' },
  ];
  const t = bill(items, { checkDiscounts: [{ type: 'amount', value: 3 }] });
  const full = computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway');
  assert.deepEqual(t.tax, inclusiveTaxOnCharged(full, 20, 17));
  assert.equal('byLine' in t.tax, false);
});

test('a 100% discount books no VAT through the seam itself', () => {
  const t = bill([{ uid: 'a', price: 8, qty: 1, taxRateId: 'std' }], { checkDiscounts: [{ type: 'percent', value: 100 }] });
  assert.equal(t.total, 0);
  assert.equal(t.tax.totalTax, 0);
  assert.equal(taxForChargedGoods(t.tax, { grand: 0 }).totalTax, 0, 'the comp rule still agrees');
});

test('promo and loyalty credits never move UK VAT (they are tenders, the accounting layer spreads over them)', () => {
  const items = [{ uid: 'a', price: 20, qty: 1, taxRateId: 'std' }];
  const credited = bill(items, { creditDiscounts: creditDiscounts({ promo: 5, loyalty: 2 }) });
  assert.deepEqual(credited.tax, bill(items).tax);
});

test('added-on (US) tax is never scaled: it already carries the discount in its basis', () => {
  const items = [{ uid: 'a', price: 100, qty: 1, taxRateId: 'us' }];
  const t = bill(items, { taxRates: [salesTax], checkDiscounts: [{ type: 'percent', value: 50 }] });
  assert.equal(t.tax.hasExclusiveTax, true);
  assert.equal('share' in t.tax, false);
  assert.equal(t.exclusiveTax, 4.44, 'post discount: 8.875% of £50');
});

test('headlessTaxBreakdown (a reader close from an older draft) books the discounted VAT too', () => {
  const draft = { items: [{ price: 12, qty: 2, taxRateId: 'std' }], discounts: [{ type: 'percent', value: 50 }], orderType: 'takeaway' };
  const t = headlessTaxBreakdown(draft, { taxRates: UK });
  assert.equal(pence(t.totalTax), 200);
  assert.equal(t.share, 0.5);
});

test('scaleTaxRecord keeps the named v2 lines, scaled, so a receipt still prints them', () => {
  const items = [{ uid: 'a', price: 12, qty: 1, taxRateId: 'std' }];
  const full = computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway');
  assert.ok(full.taxV2);
  const half = scaleTaxRecord(full, 0.5);
  assert.equal(half.taxV2.lines.length, full.taxV2.lines.length);
  assert.equal(half.taxV2.lines[0].amount, full.taxV2.lines[0].amount * 0.5);
  assert.equal(half.taxV2.inclusiveExtractedTotal, full.taxV2.inclusiveExtractedTotal * 0.5);
  assert.equal(scaleTaxRecord(full, 1), full, 'the whole bill is the same object');
});

test('inclusiveTaxOnCharged: only inclusive, only when something came off', () => {
  const t = computeOrderTaxUnified([{ price: 10, qty: 1, taxRateId: 'std' }], { taxRates: UK }, 'takeaway');
  assert.equal(inclusiveTaxOnCharged(t, 10, 10), t);
  assert.equal(inclusiveTaxOnCharged(t, 10, 12), t, 'never scaled up');
  assert.equal(inclusiveTaxOnCharged(t, 0, 0), t);
  assert.equal(inclusiveTaxOnCharged(null, 10, 5), null);
  assert.equal(inclusiveTaxOnCharged(t, 10, -3).totalTax, 0, 'clamped at nothing');
  assert.equal(pence(inclusiveTaxOnCharged(t, 10, 5).totalTax), pence(t.totalTax / 2));
  assert.equal(linesGoods([{ price: 2, qty: 3 }, { price: 9, qty: 1, voided: true }, { price: 1 }]), 7);
  assert.equal(linesAfterItemDiscounts([{ price: 10, qty: 1, discount: { type: 'percent', value: 50 } }, { price: 4, qty: 1, discount: { type: 'amount', value: 1 } }, { price: 5, qty: 1, voided: true }]), 8);
});

// ── reports agree with what was booked ─────────────────────────────────────

test('the Z report and Tax report (recordedCheckTax) read a scaled record as booked', () => {
  const items = [{ uid: 'a', price: 12, qty: 2, taxRateId: 'std' }];
  const booked = bill(items, { checkDiscounts: [{ type: 'percent', value: 50 }] }).tax;
  const check = { items, discounts: [{ type: 'percent', value: 50 }], orderType: 'takeaway', taxAmount: booked.totalTax, taxBreakdown: booked };
  assert.equal(recordedCheckTax(check, { taxRates: UK }), booked);
  assert.equal(recordedCheckTax(check, { taxRates: UK }).totalTax, check.taxAmount);
});

test('a check as the Back Office loads it: the scaled breakdown comes through the loader gate', () => {
  const items = [{ uid: 'a', price: 12, qty: 2, taxRateId: 'std' }];
  const booked = bill(items, { checkDiscounts: [{ type: 'percent', value: 50 }] }).tax;
  // closed_checks row -> db.js fetchClosedChecksRange mapping (the gate is bookedTaxRecord).
  const row = JSON.parse(JSON.stringify({ items, discounts: [{ type: 'percent', value: 50 }], order_type: 'takeaway', tax_amount: booked.totalTax, tax_breakdown: booked }));
  const loaded = { items: row.items, discounts: row.discounts, orderType: row.order_type, taxAmount: row.tax_amount, ...(bookedTaxRecord({ taxBreakdown: row.tax_breakdown }) ? { taxBreakdown: row.tax_breakdown } : {}) };
  assert.equal(recordedCheckTax(loaded, { taxRates: UK }).totalTax, loaded.taxAmount);
});

test('an undiscounted UK check still recomputes exactly as before', () => {
  const items = [{ uid: 'a', price: 12, qty: 2, taxRateId: 'std' }];
  const check = { items, discounts: [], orderType: 'takeaway', taxAmount: 4 };
  assert.deepEqual(recordedCheckTax(check, { taxRates: UK }), computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway', { discounts: [], service: 0, deliveryFee: 0 }));
  // A plain UK breakdown (no share) is still recomputed, as it always was.
  const plain = computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway');
  assert.equal(bookedTaxRecord({ taxBreakdown: plain }), null);
});

test('a 100% comp record (share 0) reports £0 VAT, not the full price\'s', () => {
  const items = [{ uid: 'a', price: 8, qty: 1, taxRateId: 'std' }];
  const comp = taxForChargedGoods(computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway'), { grand: 0 });
  assert.equal(recordedCheckTax({ items, discounts: [], taxAmount: 0, taxBreakdown: comp }, { taxRates: UK }).totalTax, 0);
});

// ── MPOS books the VAT on what it charged ─────────────────────────────────

test('MPOS: its own VAT (lines after item discounts) is what the close books', () => {
  const items = [{ uid: 'a', price: 10, qty: 2, taxRateId: 'std', discount: { type: 'percent', value: 25 } }];
  const own = inclusiveTaxOnCharged(computeOrderTaxUnified(items, { taxRates: UK }, 'takeaway', LINES_ONLY_BASIS), linesGoods(items), linesAfterItemDiscounts(items));
  assert.equal(own.share, 0.75);
  assert.equal(chargedTaxOf({ chargedTaxBreakdown: own }), own);
  // Never a stub: MTender's fallback { totalTax: 0 } is not a record.
  assert.equal(chargedTaxOf({ chargedTaxBreakdown: { totalTax: 0 } }), null);
  assert.equal(chargedTaxOf({}), null);
  const us = { hasExclusiveTax: true, exclusiveTax: 0.89, totalTax: 0.89, breakdown: [] };
  assert.equal(chargedTaxOf({ chargedTaxBreakdown: us }), us);
});

// ── wiring ────────────────────────────────────────────────────────────────

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('wiring: one seam; every reader of it follows', () => {
  const ct = read('./payments/checkTotals.js');
  // v5.11.81: a discount that names its lines takes VAT off those lines' rates (one share otherwise).
  assert.match(ct, /tax = inclusiveTaxOnChargedLines\(tax, liveItems, allCheckDiscounts, discountedSub,/);
  const tc = read('./taxCompute.js');
  assert.match(tc, /const booked = bookedTaxRecord\(check\);\n {2}if \(booked\) return booked;/);
  const ch = read('../components/CheckHistory.jsx');
  assert.match(ch, /const booked = bookedTaxRecord\(selectedCheck\);/);
  assert.match(ch, /import \{ bookedTaxRecord \} from '\.\.\/lib\/taxShare';/);
  const store = read('../store/index.js');
  assert.equal((store.match(/let taxBreakdown = chargedTaxOf\(paymentInfo\);/g) || []).length, 2);   // buildCloseRecord + recordWalkInClosed
  assert.doesNotMatch(store, /chargedAddedOnTax/);
  const mpos = read('../surfaces/MPOSSurface.jsx');
  assert.match(mpos, /const charged = chargedTaxOf\(flow\.context\.payment\);/);
  assert.match(mpos, /taxBreakdown = computeCheckTotals\(\{\n\s+items,\n\s+checkDiscounts: order\.discounts \|\| \[\],/);
  // 19 Oct 2026 (v5.11.78, channel parity): the handheld charges, shows and prints the TILL'S
  // bill (store.getPOSTotals, computeCheckTotals), whose UK VAT is already on what was charged
  // (inclusiveTaxOnCharged above). Its own lines only sum is gone.
  for (const f of ['../surfaces/mpos/MTender.jsx', '../surfaces/mpos/MCartSheet.jsx']) {
    const src = read(f);
    assert.match(src, /getPOSTotals\(\)/);
    assert.doesNotMatch(src, /LINES_ONLY_BASIS/);
  }
});
