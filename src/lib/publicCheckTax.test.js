// publicCheckTax.test.js: a paid online, QR or catering order books its VAT.
// 2 Oct 2026: QR-FAUOB at Coffee Boy Leeds (5.60, paid on the phone) was booked with tax_amount 0.
// The page sent the raw VAT (0.9333333333333327) and the server's number parser (_fence_num,
// at most 6 decimals, else 0) threw it away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { publicCheckTaxFields, roundToPence, offerChargedTax, offerScaledTax, PublicCheckTaxError, VAT_NOT_LOADED_MESSAGE } from './publicCheckTax.js';
import { computeOrderTaxUnified, taxCtxHasConfig } from './taxCompute.js';
import { toStoreRate } from './venueTaxRates.js';
import { computeCheckTotals } from './payments/checkTotals.js';
import { bookedTaxRecord } from './taxShare.js';
import { checkTenderParts, taxContext } from '../../supabase/functions/_shared/accountingDay.js';

const here = dirname(fileURLToPath(import.meta.url));

const std = toStoreRate({ id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'leeds' });
const reduced = toStoreRate({ id: 'red', name: 'Reduced Rate', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const zero = toStoreRate({ id: 'zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const UK = { taxRates: [std, reduced, zero] };
const salesTax = toStoreRate({ id: 'us', name: 'Sales Tax', code: 'US_SALES', rate: 0.08875, type: 'exclusive', is_default: true, active: true, location_id: 'cabin' });

// One QR line as QrCheckout builds it for the tax engine.
const line = (price, extra = {}) => ({ uid: 'l0', price, qty: 1, itemId: 'm-1', cat: null, cats: null, taxProfileId: null, taxRateId: null, taxOverrides: {}, ...extra });
const qrTax = (price) => computeOrderTaxUnified([line(price)], UK, 'dine-in', { discounts: [], service: 0 });

// What the live server function does with a number (public._fence_num, 20260919a2).
const FENCE_NUM = /^\s*-?[0-9]{1,12}(\.[0-9]{1,6})?\s*$/;
const oldServerReads = (n) => (FENCE_NUM.test(String(n)) ? Number(n) : 0);

test('QR-FAUOB: the raw VAT the page used to send is read as 0 by the old server, the pence figure is not', () => {
  const tax = qrTax(5.6);
  assert.equal(oldServerReads(tax.totalTax), 0, 'the fault: 0.9333333333333327 has more than 6 decimals');
  const f = publicCheckTaxFields(tax);
  assert.equal(f.tax_amount, 0.93);
  assert.equal(oldServerReads(f.tax_amount), 0.93, 'the page fix works even before the server fix runs');
});

test('the nine sales the server booked with 0 VAT, as the till books the same line', () => {
  // 8 Oct 2026 (D3): 5.85 at 20% is exactly 0.975 and 1.95 at 20% exactly 0.325; the one rounding
  // rule books 0.98 and 0.33 (half up). The 2 Oct backfill wrote 0.97 and 0.32 for them (the floats
  // 0.9749999999999996 and 0.32499999999999996 rounded down); history is left alone, every new sale
  // on a half penny rounds up.
  const cases = [[5.6, 0.93], [4.85, 0.81], [5.85, 0.98], [4.4, 0.73], [4.4, 0.73], [5.15, 0.86], [1.95, 0.33], [1.0, 0.17], [1.0, 0.17]];
  for (const [price, vat] of cases) assert.equal(publicCheckTaxFields(qrTax(price)).tax_amount, vat, `${price}`);
  assert.equal(publicCheckTaxFields(qrTax(3.75)).tax_amount, 0.63, 'QR-N2IYX at Huddersfield, which did get through (0.625)');
});

test('the split by rate goes with it: the engine\'s own record, the same one the till writes', () => {
  const tax = computeOrderTaxUnified([line(5.6), line(2.1, { uid: 'l1', taxRateId: 'red' }), line(3, { uid: 'l2', taxRateId: 'zero' })], UK, 'dine-in');
  const f = publicCheckTaxFields(tax);
  assert.equal(f.tax_breakdown, tax, 'the record itself, not a copy with fewer keys');
  assert.deepEqual(f.tax_breakdown.breakdown.map((b) => b.rate.id), ['std', 'red', 'zero']);
  assert.equal(f.tax_amount, 1.03, '0.9333 at 20% plus 0.10 at 5%');
  assert.equal(typeof f.tax_breakdown.totalTax, 'number', 'the server keeps a record only when totalTax is a number');
  assert.ok(Array.isArray(f.tax_breakdown.breakdown));
});

test('a zero rated basket books 0 with its record, not "not recorded"', () => {
  const f = publicCheckTaxFields(computeOrderTaxUnified([line(3, { taxRateId: 'zero' })], UK, 'takeaway'));
  assert.equal(f.tax_amount, 0);
  assert.equal(f.tax_breakdown.breakdown[0].rate.id, 'zero');
});

test('a venue with no tax set up claims nothing, as before', () => {
  const f = publicCheckTaxFields(computeOrderTaxUnified([line(5.6)], { taxRates: [] }, 'dine-in'));
  assert.deepEqual(f, { tax_amount: null });
});

test('no tax result at all, or one without a number, is not recorded', () => {
  assert.deepEqual(publicCheckTaxFields(null), { tax_amount: null });
  assert.deepEqual(publicCheckTaxFields(undefined), { tax_amount: null });
  assert.deepEqual(publicCheckTaxFields({ breakdown: [] }), { tax_amount: null });
  assert.deepEqual(publicCheckTaxFields({ totalTax: 'lots', breakdown: [{ tax: 1 }] }), { tax_amount: null });
});

// ── 8 Oct 2026: a venue with tax set up never books a sale without VAT ──────────────────────────
test('QR-4OGI7: no rates loaded at a venue that has them is a named error, never tax_amount null', () => {
  // The page's context had NO rates (read before sign in), the venue has three. The page must not
  // send null; the checkout shows the error and does not take payment.
  const noRates = computeOrderTaxUnified([line(4.85)], { taxRates: [] }, 'dine-in');
  assert.deepEqual(publicCheckTaxFields(noRates), { tax_amount: null }, 'without the flag the old answer stands (older callers)');
  assert.throws(() => publicCheckTaxFields(noRates, { hasTaxConfig: true, goods: 4.85 }), (e) => {
    assert.equal(e.name, 'PublicCheckTaxError');
    assert.equal(e.code, 'vat_not_loaded');
    assert.equal(e.message, VAT_NOT_LOADED_MESSAGE);
    assert.ok(e instanceof PublicCheckTaxError);
    return true;
  });
  assert.throws(() => publicCheckTaxFields(null, { hasTaxConfig: true, goods: 4.85 }), PublicCheckTaxError);
  assert.throws(() => publicCheckTaxFields(undefined, { hasTaxConfig: true }), PublicCheckTaxError, 'goods unknown counts as above zero');
  assert.throws(() => publicCheckTaxFields({ totalTax: 'lots', breakdown: [{ tax: 1 }] }, { hasTaxConfig: true, goods: 1 }), PublicCheckTaxError);
});

test('with rates in hand the flag changes nothing: the same fields, a zero rated basket is a real 0', () => {
  const hasTaxConfig = taxCtxHasConfig(UK);
  assert.equal(hasTaxConfig, true);
  const t = qrTax(4.85);
  assert.deepEqual(publicCheckTaxFields(t, { hasTaxConfig, goods: 4.85 }), publicCheckTaxFields(t));
  assert.equal(publicCheckTaxFields(t, { hasTaxConfig, goods: 4.85 }).tax_amount, 0.81, 'what QR-4OGI7 should have booked');
  const zeroRated = computeOrderTaxUnified([line(3, { taxRateId: 'zero' })], UK, 'takeaway');
  const f = publicCheckTaxFields(zeroRated, { hasTaxConfig, goods: 3 });
  assert.equal(f.tax_amount, 0);
  assert.equal(f.tax_breakdown, zeroRated);
});

test('a venue with no tax set up (flag false) still claims nothing, and goods of 0 never throw', () => {
  const none = computeOrderTaxUnified([line(5.6)], { taxRates: [] }, 'dine-in');
  assert.deepEqual(publicCheckTaxFields(none, { hasTaxConfig: false, goods: 5.6 }), { tax_amount: null });
  assert.deepEqual(publicCheckTaxFields(none, { hasTaxConfig: taxCtxHasConfig({ taxRates: [] }), goods: 5.6 }), { tax_amount: null });
  assert.deepEqual(publicCheckTaxFields(null, { hasTaxConfig: true, goods: 0 }), { tax_amount: null }, 'nothing sold, nothing to book');
});

test('guard: the QR and online checkouts pass the flag, so the throw can happen', () => {
  const qr = readFileSync(join(here, '../surfaces/qr/QrCheckout.jsx'), 'utf8');
  assert.match(qr, /publicCheckTaxFields\(taxBreakdown, \{ hasTaxConfig, goods: subtotal \}\)/);
  const online = readFileSync(join(here, '../surfaces/online/OnlineCheckout.jsx'), 'utf8');
  // Four: the two payloads (card, and gift card or reward only), and the two checks BEFORE payment
  // (startPayment, onGiftOnlyPayment) that let the throw stop the card being charged.
  assert.equal((online.match(/publicCheckTaxFields\(chargedTaxBreakdown, \{ hasTaxConfig, goods: subtotal \}\)/g) || []).length, 4, 'both online payloads and both pre-payment checks');
  assert.equal((qr.match(/publicCheckTaxFields\(taxBreakdown, \{ hasTaxConfig, goods: subtotal \}\)/g) || []).length, 2, 'the QR payload and its pre-payment check');
});

test('added-on (US) sales tax: the amount in cents and the named lines, as before', () => {
  const tax = computeOrderTaxUnified([line(20)], { taxRates: [salesTax] }, 'collection');
  const f = publicCheckTaxFields(tax);
  assert.equal(f.tax_amount, 1.78, '8.875% of 20.00 is 1.775');
  assert.equal(f.tax_breakdown, tax);
  assert.equal(f.tax_breakdown.hasExclusiveTax, true);
});

test('a scaled record (an online order with an offer) is sent as it stands', () => {
  const tax = qrTax(10);
  const scaled = { ...tax, totalTax: tax.totalTax * 0.5, breakdown: tax.breakdown.map((b) => ({ ...b, tax: b.tax * 0.5, gross: b.gross * 0.5 })) };
  const f = publicCheckTaxFields(scaled);
  assert.equal(f.tax_amount, 0.83);
  assert.equal(f.tax_breakdown, scaled);
});

test('roundToPence is the one rounding rule (half up on the true value), not Math.round and not the column\'s float reading', () => {
  assert.equal(roundToPence(0.9333333333333327), 0.93);
  assert.equal(roundToPence(0.9749999999999996), 0.98, '5.85 at 20% is exactly 0.975: half up (8 Oct 2026, D3); the column read the float as 0.97');
  assert.equal(roundToPence(1.6749999999999998), 1.68, '10.05 at 20% is exactly 1.675');
  assert.equal(roundToPence(0.625), 0.63);
  assert.equal(roundToPence(1.005), 1.01, 'Math.round(1.005 * 100) / 100 is 1');
  assert.equal(roundToPence(1.7750000000000001), 1.78);
  assert.equal(roundToPence(0.995), 1);
  assert.equal(roundToPence(0.004), 0);
  assert.equal(roundToPence(12), 12);
  assert.equal(roundToPence(0.1), 0.1);
  assert.equal(roundToPence(-0.625), -0.63);
  assert.equal(roundToPence(-0.001), 0);
  assert.equal(roundToPence('4.189'), 4.19);
  assert.equal(roundToPence(1e-9), 0);
  assert.equal(roundToPence(null), null);
  assert.equal(roundToPence(''), null);
  assert.equal(roundToPence(NaN), null);
  assert.equal(roundToPence('abc'), null);
});

test('every pence figure it produces is one the old server function reads', () => {
  for (let p = 5; p <= 6000; p += 5) {
    const f = publicCheckTaxFields(qrTax(p / 100));
    assert.ok(FENCE_NUM.test(String(f.tax_amount)), `${p / 100} -> ${f.tax_amount}`);
    assert.ok(Math.abs(f.tax_amount - p / 600) <= 0.005 + 1e-9, `${p / 100} -> ${f.tax_amount}`);
  }
});

// ── an automatic offer (review of the fix, 2 Oct 2026) ───────────────────────────────────────
// The Xero daily invoice's own reading of a booked check (accountingDay.checkTenderParts), over
// the venue's rate rows as the edge function loads them.
const RATE_ROWS = [
  { id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true },
  { id: 'red', name: 'Reduced Rate', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, active: true },
  { id: 'zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true },
];
const xeroSplit = (tax, cardTotal) => {
  const row = { id: 'c1', total: cardTotal, tip: 0, service: 0, method: 'card', status: 'paid',
    tenders: [{ method: 'card', amount: cardTotal, tip: 0 }], ...publicCheckTaxFields(tax) };
  const r = checkTenderParts(row, taxContext(RATE_ROWS));
  return { byRate: r.parts[0].byRate, source: r.rateSource, flags: r.flags, row };
};
// What the Online page did before the review (v5.5.787), kept here as the yardstick.
const oldOnlineScale = (t, scale) => ({
  ...t,
  totalTax: t.totalTax * scale,
  exclusiveTax: (t.exclusiveTax || 0) * scale,
  breakdown: t.breakdown.map((b) => ({ ...b, tax: b.tax * scale, net: b.net * scale, gross: b.gross * scale })),
  ...(t.taxV2 ? { taxV2: { ...t.taxV2, lines: t.taxV2.lines.map((l) => ({ ...l, amount: l.amount * scale })),
    exclusiveTaxTotal: t.taxV2.exclusiveTaxTotal * scale, inclusiveExtractedTotal: t.taxV2.inclusiveExtractedTotal * scale } } : {}),
});

test('online with an offer: the whole discounted sale goes to Xero on its VAT rate', () => {
  // 10.00 at 20%, automatic offer 2.00 off, card 8.00.
  const full = computeOrderTaxUnified([line(10)], UK, 'collection');
  const before = xeroSplit(oldOnlineScale(full, 0.8), 8);
  assert.deepEqual(before.byRate, { 'rate:std': { sales: 640, tax: 133 }, none: { sales: 160, tax: 0 } },
    'the fault: the record kept the full price total, so the 2.00 offer read as sales with no VAT rate');
  const rec = offerScaledTax(full, 0.8);
  const after = xeroSplit(rec, 8);
  assert.equal(after.row.tax_amount, 1.33);
  assert.deepEqual(after.byRate, { 'rate:std': { sales: 800, tax: 133 } });
  assert.equal(after.source, 'breakdown');
  assert.deepEqual(after.flags, []);
  // The record describes the discounted bill in full: net + VAT = gross = what was charged.
  assert.ok(Math.abs(rec.total - 8) < 1e-9);
  assert.ok(Math.abs(rec.subtotal + rec.totalTax - rec.total) < 1e-9);
  assert.equal(rec.share, 0.8);
  assert.equal(bookedTaxRecord({ taxBreakdown: rec }), rec, 'the Z and Tax reports read the booked VAT, as for a till bill with a discount');
});

test('online with an offer: the VAT, each rate and the named lines are scaled exactly as before', () => {
  const full = computeOrderTaxUnified([line(5.6), line(2.1, { uid: 'l1', taxRateId: 'red' }), line(3, { uid: 'l2', taxRateId: 'zero' })], UK, 'collection');
  const was = oldOnlineScale(full, 0.75);
  const now = offerScaledTax(full, 0.75);
  for (const k of ['totalTax', 'exclusiveTax', 'breakdown', 'taxV2', 'hasExclusiveTax', 'source']) assert.deepEqual(now[k], was[k], k);
  assert.equal(publicCheckTaxFields(now).tax_amount, publicCheckTaxFields(was).tax_amount);
  const split = xeroSplit(now, 8.03);   // 10.70 of goods, a quarter off, rounded to pence
  assert.equal(split.byRate.none, undefined, 'nothing lands on the no VAT rate line');
  assert.equal(Object.values(split.byRate).reduce((a, x) => a + x.sales, 0), 803);
  assert.equal(offerScaledTax(null, 0.5), null);
});

test('QR with an offer books the VAT on what was charged, as the till books the same bill', () => {
  // One 10.00 item at 20%, automatic offer 5.00 off, guest pays 5.00.
  const full = computeOrderTaxUnified([line(10)], UK, 'dine-in', { discounts: [{ type: 'amount', value: 5 }], service: 0 });
  assert.equal(publicCheckTaxFields(full).tax_amount, 1.67, 'the fault: the engine works VAT out on the full menu price');
  const rec = offerChargedTax(full, 10, 5, 5);
  const f = publicCheckTaxFields(rec);
  assert.equal(f.tax_amount, 0.83);
  assert.equal(f.tax_breakdown.share, 0.5);
  // The till, same bill: a 10.00 line with a 5.00 check discount.
  const till = computeCheckTotals({ items: [{ ...line(10), name: 'Item' }], checkDiscounts: [{ type: 'amount', value: 5 }],
    orderType: 'dine-in', deviceConfig: { serviceCharge: { enabled: false } }, discountRules: [], taxRates: UK.taxRates });
  assert.equal(till.total, 5);
  assert.equal(roundToPence(till.tax.totalTax), f.tax_amount, 'to the penny');
  assert.equal(till.tax.share, f.tax_breakdown.share);
  const x = xeroSplit(rec, 5);
  assert.deepEqual(x.byRate, { 'rate:std': { sales: 500, tax: 83 } });
  assert.deepEqual(x.flags, []);
});

test('QR with no offer is sent exactly as before, even when the page rounds the charge to pence', () => {
  const tax = qrTax(5.6);
  assert.equal(offerChargedTax(tax, 5.6, 5.6, 0), tax);
  // 3 x 1.90 is 5.699999999999999 in floating point and the page rounds the charge to 5.70.
  assert.equal(offerChargedTax(tax, 5.699999999999999, 5.7, 0), tax);
  // 0.1 + 0.2 style goods: the rounded charge is BELOW the goods. That alone is not a discount.
  assert.equal(offerChargedTax(tax, 0.30000000000000004, 0.3, 0), tax);
  assert.equal(offerChargedTax(tax, 5.6, 5.6, undefined), tax);
  assert.equal(offerChargedTax(null, 5.6, 2, 3.6), null);
});

test('QR with an offer at an added-on (US) venue: the record is not scaled, the offer is already in its basis', () => {
  const us = computeOrderTaxUnified([line(20)], { taxRates: [salesTax] }, 'dine-in', { discounts: [{ type: 'amount', value: 5 }], service: 0 });
  assert.equal(offerChargedTax(us, 20, 15, 5), us);
});

test('guard: the QR page books the offer scaled record and the Online page scales the whole record', () => {
  const qr = readFileSync(join(here, '../surfaces/qr/QrCheckout.jsx'), 'utf8');
  assert.match(qr, /const taxBreakdown = useMemo\(\s*\(\) => offerChargedTax\(goodsTaxBreakdown, subtotal, discountedSubtotal, autoDiscountTotal\)/);
  assert.match(qr, /publicCheckTaxFields\(taxBreakdown, \{ hasTaxConfig, goods: subtotal \}\)/);   // 8 Oct 2026: with the tax config flag
  const online = readFileSync(join(here, '../surfaces/online/OnlineCheckout.jsx'), 'utf8');
  assert.match(online, /return offerScaledTax\(taxBreakdown, discountedSubtotalMinor \/ subtotalMinor\);/);
});

// The three pages that send a paid check to place_public_order must all use the one helper.
test('guard: the online, QR and catering checkouts book their VAT through publicCheckTaxFields', () => {
  const pages = ['../surfaces/qr/QrCheckout.jsx', '../surfaces/online/OnlineCheckout.jsx', '../surfaces/catering/CateringCheckout.jsx'];
  for (const rel of pages) {
    const src = readFileSync(join(here, rel), 'utf8');
    assert.match(src, /publicCheckTaxFields\(/, `${rel} must build tax_amount with publicCheckTaxFields`);
    assert.doesNotMatch(src, /tax_amount:\s*[A-Za-z]+\?\.totalTax\s*\|\|\s*null/, `${rel} still sends the raw VAT figure`);
  }
});
