/**
 * taxBasis.test.js - v5.9.12: US sales tax charged on the right amount.
 *
 * The defect (found 19 Sep 2026): added-on (US exclusive) sales tax was charged
 * on item price x qty BEFORE any discount, and never on the service charge or
 * the delivery fee. These tests lock the fix and, above all, the UK lock: an
 * inclusive-VAT check must come out BYTE-IDENTICAL whatever discounts, service,
 * delivery or credits the new check basis carries.
 *
 * Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateCheckBasis, lineAfterItemDiscount, creditDiscounts, creditDiscountsFromPayment,
  recordCheckBasis, chargedAddedOnTax, LINES_ONLY_BASIS,
} from './taxBasis.js';
import { computeOrderTaxUnified, buildLocalTaxCtx, prepareTaxCtx, recordedCheckTax, chargesAddedOnRate } from './taxCompute.js';
import fs from 'node:fs';
import { calculateOrderTax } from './tax.js';
import { lineBasisSettings, isAddedOnRateLine } from './taxEngine.js';
import { buildLegacyProfiles } from './taxAdapter.js';
import { normaliseTaxProfileLineRow } from './rowMapping.js';
import { computeCheckTotals } from './payments/checkTotals.js';
import { refundBreakdown, refundedSoFar, addedOnTaxOf, r2 } from './payments/refundMath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── fixtures ────────────────────────────────────────────────────────────────

const UK_RATES = [
  { id: 'vat20', name: 'Standard Rate', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  { id: 'vat5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', active: true, is_default: false },
  { id: 'zero', name: 'Zero Rate', rate: 0, type: 'inclusive', active: true, is_default: false },
];

const mirror = (pid, r, over = {}) => ({
  id: pid, name: r.name, rounding: { mode: 'half_up', level: 'invoice' }, active: true,
  generatedFromRateId: r.id,
  lines: [{
    id: `l-${pid}`, name: r.name, lineType: 'rate', rate: r.rate, flatAmount: 0,
    mode: r.type === 'inclusive' ? 'inclusive' : 'exclusive',
    compound: false, taxable: false,
    taxBasis: r.type === 'inclusive' ? 'pre_discount' : 'post_discount',
    orderTypes: ['all'], sortOrder: 0, active: true, ...over,
  }],
});

const ukCtx = () => buildLocalTaxCtx({
  taxProfiles: UK_RATES.map(r => mirror(`gen-${r.id}`, r)),
  venueDefaultProfileId: 'gen-vat20',
  taxRates: UK_RATES,
});

const US_RATES = [
  { id: 'us', name: 'Sales Tax', rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  { id: 'exempt', name: 'Tax Exempt', rate: 0, type: 'exclusive', active: true, is_default: false },
];
const TEN = [{ id: 'ten', name: 'Sales Tax', rate: 0.10, type: 'exclusive', active: true, is_default: true },
  { id: 'free', name: 'Exempt', rate: 0, type: 'exclusive', active: true, is_default: false }];

const pline = (over = {}) => ({
  id: over.id || 'x', name: over.name || 'Tax', lineType: 'rate', rate: 0, flatAmount: 0,
  mode: 'exclusive', compound: false, taxable: false, taxBasis: 'post_discount',
  orderTypes: ['all'], sortOrder: 0, active: true, ...over,
});
const profileVenue = (profile, extraRates = []) => buildLocalTaxCtx({
  taxProfiles: [profile], venueDefaultProfileId: profile.id, taxRates: extraRates,
});

const CHICAGO = {
  id: 'p-chicago', name: 'Chicago', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
  lines: [
    pline({ id: 'il', name: 'Illinois', rate: 0.0625, sortOrder: 0 }),
    pline({ id: 'cook', name: 'Cook County', rate: 0.0175, sortOrder: 1 }),
    pline({ id: 'chi', name: 'City of Chicago', rate: 0.0125, sortOrder: 2 }),
    pline({ id: 'rta', name: 'RTA', rate: 0.005, sortOrder: 3 }),
  ],
};
const OMAHA = {
  id: 'p-omaha', name: 'Omaha', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
  lines: [
    pline({ id: 'occ', name: 'Occupation', rate: 0.025, taxable: true, sortOrder: 0 }),
    pline({ id: 'sales', name: 'Sales', rate: 0.075, compound: true, sortOrder: 1 }),
  ],
};

// ── 1. defaults, adapter, row mapping ───────────────────────────────────────

test('US defaults: an added-on rate line is post-discount, taxes service, not delivery', () => {
  assert.deepEqual(lineBasisSettings({ mode: 'exclusive', lineType: 'rate' }),
    { taxBasis: 'post_discount', taxServiceCharge: true, taxDeliveryFee: false });
  // Inclusive (UK VAT) and per-unit lines never take the check basis.
  assert.deepEqual(lineBasisSettings({ mode: 'inclusive', lineType: 'rate' }),
    { taxBasis: 'pre_discount', taxServiceCharge: false, taxDeliveryFee: false });
  assert.equal(isAddedOnRateLine({ lineType: 'per_unit', mode: 'exclusive' }), false);
  // An explicit value always wins.
  assert.deepEqual(lineBasisSettings({ mode: 'exclusive', taxBasis: 'pre_discount', taxServiceCharge: false, taxDeliveryFee: true }),
    { taxBasis: 'pre_discount', taxServiceCharge: false, taxDeliveryFee: true });
});

test('legacy adapter: exclusive rates take the US defaults, inclusive rates are untouched', () => {
  const { profilesById } = buildLegacyProfiles([...UK_RATES, ...US_RATES]);
  const us = profilesById['legacy:us'].lines[0];
  assert.equal(us.taxBasis, 'post_discount');
  assert.equal(us.taxServiceCharge, true);
  assert.equal(us.taxDeliveryFee, false);
  const vat = profilesById['legacy:vat20'].lines[0];
  assert.equal(vat.taxBasis, 'pre_discount');
  assert.equal(vat.taxServiceCharge, false);
  assert.equal(vat.taxDeliveryFee, false);
});

test('row mapping: the new columns pass through, and read null before migration 20260919t', () => {
  const before = normaliseTaxProfileLineRow({ id: 'a', mode: 'exclusive', tax_basis: 'post_discount' });
  assert.equal(before.taxServiceCharge, null);
  assert.equal(before.taxDeliveryFee, null);
  const after = normaliseTaxProfileLineRow({ id: 'a', mode: 'exclusive', tax_service_charge: false, tax_delivery_fee: true });
  assert.equal(after.taxServiceCharge, false);
  assert.equal(after.taxDeliveryFee, true);
  // camel wins over a stale snake field
  assert.equal(normaliseTaxProfileLineRow({ taxServiceCharge: true, tax_service_charge: false }).taxServiceCharge, true);
});

test('mirror detection: a generated US profile on the adapter defaults stays legacy-equivalent', () => {
  const us = US_RATES[0];
  const post = prepareTaxCtx(buildLocalTaxCtx({ taxProfiles: [mirror('gen-us', us)], venueDefaultProfileId: 'gen-us', taxRates: US_RATES }));
  assert.equal(post.legacyEquivalent, true);
  // Before migration 20260919t the generated row still says pre_discount: that
  // is an explicit value, so it is honoured as a real profile (never guessed).
  const pre = prepareTaxCtx(buildLocalTaxCtx({ taxProfiles: [mirror('gen-us2', us, { taxBasis: 'pre_discount' })], venueDefaultProfileId: 'gen-us2', taxRates: US_RATES }));
  assert.equal(pre.legacyEquivalent, false);
  // UK mirrors (inclusive, explicit false switches after the migration) stay mirrors.
  const uk = prepareTaxCtx(buildLocalTaxCtx({
    taxProfiles: UK_RATES.map(r => mirror(`g-${r.id}`, r, { taxServiceCharge: false, taxDeliveryFee: false })),
    venueDefaultProfileId: 'g-vat20', taxRates: UK_RATES,
  }));
  assert.equal(uk.legacyEquivalent, true);
});

// ── 2. allocation ───────────────────────────────────────────────────────────

test('allocation: item discount on its line, check discount pro rata, lines add up to the bill', () => {
  const items = [
    { uid: 'a', price: 20, qty: 1, discount: { type: 'amount', value: 5 } },   // 15
    { uid: 'b', price: 10, qty: 3, discount: { type: 'percent', value: 50 } }, // 15
  ];
  assert.equal(lineAfterItemDiscount(items[0]), 15);
  assert.equal(lineAfterItemDiscount(items[1]), 15);
  const a = allocateCheckBasis(items, { discounts: [{ type: 'percent', value: 10 }], service: 2.7, deliveryFee: 3 });
  assert.equal(a.subtotal, 30);
  near(a.discount, 3);
  near(a.lines[0].netValue, 13.5);
  near(a.lines[1].netValue, 13.5);
  near(a.lines[0].serviceShare + a.lines[1].serviceShare, 2.7);
  near(a.lines[0].deliveryShare + a.lines[1].deliveryShare, 3);
});

test('allocation: an auto discount that names its units comes off THOSE lines first', () => {
  const items = [{ uid: 'a', price: 10, qty: 1 }, { uid: 'b', price: 10, qty: 1 }];
  const a = allocateCheckBasis(items, { discounts: [{ type: 'amount', value: 10, appliedItems: [{ uid: 'b', saving: 10 }] }] });
  near(a.lines[0].netValue, 10);
  near(a.lines[1].netValue, 0);
});

test('allocation: a discount bigger than the bill floors every line at zero', () => {
  const a = allocateCheckBasis([{ price: 5, qty: 1 }, { price: 5, qty: 1 }], { discounts: [{ type: 'amount', value: 50 }] });
  assert.deepEqual(a.lines.map(l => l.netValue), [0, 0]);
});

// ── 3. the UK lock ──────────────────────────────────────────────────────────

// Deterministic PRNG so a failure is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function randomUkCheck(r) {
  const n = 1 + Math.floor(r() * 6);
  const items = [];
  for (let i = 0; i < n; i++) {
    const it = {
      uid: `u${i}`, itemId: `i${i}`,
      price: Math.round(r() * 4000) / 100,
      qty: 1 + Math.floor(r() * 3),
      taxRateId: pick(r, ['vat20', 'vat5', 'zero', null]),
    };
    if (r() < 0.2) it.taxOverrides = { takeaway: 'zero' };
    if (r() < 0.25) it.discount = r() < 0.5 ? { type: 'percent', value: pick(r, [10, 25, 50, 100]) } : { type: 'amount', value: Math.round(r() * 500) / 100 };
    if (r() < 0.05) it.voided = true;
    items.push(it);
  }
  const discounts = [];
  if (r() < 0.4) discounts.push(r() < 0.5 ? { type: 'percent', value: pick(r, [5, 10, 15]) } : { type: 'amount', value: Math.round(r() * 800) / 100 });
  if (r() < 0.2) discounts.push({ type: 'amount', value: 2, appliedItems: [{ uid: 'u0', saving: 2 }] });
  return {
    items,
    orderType: pick(r, ['dine-in', 'takeaway', 'delivery', 'drive-thru', 'bar-tab']),
    basis: {
      discounts: [...discounts, ...creditDiscounts({ promo: r() < 0.2 ? 3 : 0, loyalty: r() < 0.2 ? 1.5 : 0 })],
      service: r() < 0.5 ? Math.round(r() * 1000) / 100 : 0,
      deliveryFee: r() < 0.3 ? Math.round(r() * 600) / 100 : 0,
    },
  };
}

test('UK LOCK: 2000 random inclusive checks - the check basis changes NOTHING, byte for byte', () => {
  const r = rng(20260919);
  const ctxs = [ukCtx(), buildLocalTaxCtx({ taxRates: UK_RATES }), { taxRates: UK_RATES }];
  for (let k = 0; k < 2000; k++) {
    const c = randomUkCheck(r);
    const ctx = ctxs[k % ctxs.length];
    const without = computeOrderTaxUnified(c.items, ctx, c.orderType);
    const withBasis = computeOrderTaxUnified(c.items, ctx, c.orderType, c.basis);
    // Same keys (no lineTaxes / checkBasisApplied on a UK record), same values.
    assert.deepEqual(Object.keys(withBasis).sort(), Object.keys(without).sort());
    assert.deepEqual(withBasis, without);
    assert.equal(withBasis.source, 'legacy');
    assert.equal(withBasis.exclusiveTax, 0);
    // And still the pre-cutover engine's own numbers.
    const leg = calculateOrderTax(c.items, UK_RATES, c.orderType);
    assert.equal(withBasis.totalTax, leg.totalTax);
    assert.deepEqual(withBasis.breakdown, leg.breakdown);
  }
});

test('UK LOCK: computeCheckTotals totals are unchanged with discounts, service, delivery and credits', () => {
  const ctx = {
    items: [
      { uid: 'a', price: 36.00, qty: 1, taxRateId: 'vat20' },
      { uid: 'b', price: 6.50, qty: 2, taxRateId: 'vat20' },
      { uid: 'c', price: 12.00, qty: 1, taxRateId: 'vat5', discount: { type: 'percent', value: 50 } },
      { uid: 'd', price: 9.99, qty: 1, taxRateId: 'vat20', voided: true },
    ],
    checkDiscounts: [{ id: 'd1', type: 'amount', value: 5 }],
    covers: 2, serviceChargeWaived: false, orderType: 'dine-in',
    deviceConfig: { serviceCharge: { enabled: true, rate: 12.5, applyTo: 'all', minCovers: 8 } },
    discountRules: [], timezone: 'Europe/London', deliveryQuote: null,
  };
  // v5.7.30 literals (checkTotals.test.js GOLDEN): 55 / 50 / 6.25 / 56.25.
  for (const variant of [
    { taxRates: UK_RATES },
    { taxCtx: ukCtx() },
    { taxCtx: ukCtx(), creditDiscounts: creditDiscounts({ promo: 4, loyalty: 2 }) },
  ]) {
    const t = computeCheckTotals({ ...ctx, ...variant });
    assert.equal(t.subtotal, 55);
    assert.equal(t.discountedSub, 50);
    assert.equal(t.service, 6.25);
    assert.equal(t.total, 56.25);
    assert.equal(t.exclusiveTax, 0);
    // The booked breakdown is the items-only one, exactly as closes booked before.
    assert.deepEqual(t.tax, computeOrderTaxUnified(ctx.items.filter(i => !i.voided), variant.taxCtx || { taxRates: UK_RATES }, 'dine-in'));
  }
});

test('UK LOCK: a sugar levy (per-unit, added on) ignores the basis too', () => {
  const sugar = {
    id: 'p-sugar', name: 'Sugar', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
    lines: [
      pline({ id: 'vat', rate: 0.2, mode: 'inclusive', taxBasis: 'pre_discount' }),
      pline({ id: 'levy', lineType: 'per_unit', flatAmount: 0.25, sortOrder: 1 }),
    ],
  };
  const ctx = profileVenue(sugar, UK_RATES);
  const items = [{ price: 1.5, qty: 3 }];
  const plain = computeOrderTaxUnified(items, ctx, 'takeaway');
  const based = computeOrderTaxUnified(items, ctx, 'takeaway', { discounts: [{ type: 'percent', value: 50 }], service: 1, deliveryFee: 2 });
  assert.equal(based.exclusiveTax, 0.75);
  assert.equal(based.checkBasisApplied, undefined);
  assert.equal(based.totalTax, plain.totalTax);
  assert.deepEqual(based.taxV2, plain.taxV2);
});

// ── 4. US: discounts reduce the base ────────────────────────────────────────

test('NY 8.875% canary: 10% check discount on 47.20 taxes 42.48 (3.77), not 47.20 (4.19)', () => {
  const ctx = buildLocalTaxCtx({ taxRates: US_RATES });
  const items = [{ price: 47.20, qty: 1, taxRateId: 'us' }];
  assert.equal(computeOrderTaxUnified(items, ctx, 'takeaway').exclusiveTax, 4.19);
  const r = computeOrderTaxUnified(items, ctx, 'takeaway', { discounts: [{ type: 'percent', value: 10 }] });
  assert.equal(r.exclusiveTax, 3.77);            // 42.48 x 8.875% = 3.7701
  assert.equal(r.checkBasisApplied, true);
  assert.equal(r.hasExclusiveTax, true);
  near(r.lineTaxes[0], 3.7701);
});

test('US: an amount item discount and a percent item discount both come off', () => {
  const ctx = buildLocalTaxCtx({ taxRates: TEN });
  const r = computeOrderTaxUnified([
    { price: 20, qty: 1, taxRateId: 'ten', discount: { type: 'amount', value: 5 } },     // 15
    { price: 10, qty: 2, taxRateId: 'ten', discount: { type: 'percent', value: 25 } },   // 15
  ], ctx, 'dine-in', {});
  assert.equal(r.exclusiveTax, 3);
});

test('US: a free item from an auto discount loses ITS tax, not a slice of everyone\'s', () => {
  const ctx = buildLocalTaxCtx({ taxRates: TEN });
  const items = [
    { uid: 'a', price: 10, qty: 1, taxRateId: 'ten' },
    { uid: 'b', price: 10, qty: 1, taxRateId: 'free' },   // exempt, and the free one
  ];
  const r = computeOrderTaxUnified(items, ctx, 'dine-in', {
    discounts: [{ type: 'amount', value: 10, appliedItems: [{ uid: 'b', saving: 10 }] }],
  });
  assert.equal(r.exclusiveTax, 1);   // pro rata would have wrongly given 0.50
});

test('US: nothing to adjust = the exact pre-v5.9.12 result (parity path, calculateOrderTax)', () => {
  const ctx = buildLocalTaxCtx({ taxRates: US_RATES });
  const items = [{ price: 12, qty: 2, taxRateId: 'us' }];
  const r = computeOrderTaxUnified(items, ctx, 'takeaway', { discounts: [], service: 0, deliveryFee: 0 });
  assert.equal(r.source, 'legacy');
  assert.equal(r.checkBasisApplied, undefined);
  assert.equal(r.exclusiveTax, calculateOrderTax(items, US_RATES, 'takeaway').exclusiveTax);
});

// ── 5. service charge and delivery fee ──────────────────────────────────────

test('US: a mandatory service charge is taxed by default (18% table, 10% off)', () => {
  const t = computeCheckTotals({
    items: [{ uid: 'a', price: 20, qty: 1, taxRateId: 'us' }, { uid: 'b', price: 5, qty: 2, taxRateId: 'us' }],
    checkDiscounts: [{ type: 'percent', value: 10 }],
    covers: 4, orderType: 'dine-in',
    deviceConfig: { serviceCharge: { enabled: true, rate: 18, applyTo: 'all' } },
    discountRules: [], taxRates: US_RATES,
  });
  assert.equal(t.discountedSub, 27);
  near(t.service, 4.86);
  // (27 + 4.86) x 8.875% = 2.827575 -> 2.83. The old basis charged 30 x 8.875% = 2.66.
  assert.equal(t.exclusiveTax, 2.83);
  near(t.total, 27 + 4.86 + 2.83);
});

test('US: a profile that says NO to service tax charges only the goods', () => {
  const noSvc = { id: 'p-nosvc', name: 'No service tax', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
    lines: [pline({ id: 's', rate: 0.08875, taxServiceCharge: false })] };
  const r = computeOrderTaxUnified([{ price: 30, qty: 1 }], profileVenue(noSvc), 'dine-in',
    { discounts: [{ type: 'amount', value: 3 }], service: 4.86 });
  assert.equal(r.exclusiveTax, 2.40);   // 27 x 8.875% = 2.39625
});

test('US: an exempt line\'s share of the service charge stays untaxed', () => {
  const ctx = buildLocalTaxCtx({ taxRates: US_RATES });
  const r = computeOrderTaxUnified([
    { price: 20, qty: 1, taxRateId: 'us' },
    { price: 10, qty: 1, taxRateId: 'exempt' },
  ], ctx, 'dine-in', { service: 3 });
  assert.equal(r.exclusiveTax, 1.95);   // (20 + 2) x 8.875% = 1.9525
});

test('US: the delivery fee is untaxed by default and taxed when the profile says so', () => {
  const ctx = buildLocalTaxCtx({ taxRates: US_RATES });
  const items = [{ price: 20, qty: 1, taxRateId: 'us' }];
  assert.equal(computeOrderTaxUnified(items, ctx, 'delivery', { deliveryFee: 5 }).exclusiveTax, 1.78);   // 1.775
  const withDel = { id: 'p-del', name: 'Delivery taxed', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
    lines: [pline({ id: 'd', rate: 0.08875, taxDeliveryFee: true })] };
  // (no legacy rate id on the line: a set id this venue does not have would opt it out)
  assert.equal(computeOrderTaxUnified([{ price: 20, qty: 1 }], profileVenue(withDel), 'delivery', { deliveryFee: 5 }).exclusiveTax, 2.22);   // 25 x 8.875% = 2.21875
});

// ── 6. stacked and compound profiles ────────────────────────────────────────

test('Chicago stack: every line taxes the discounted goods plus service, each line rounded', () => {
  const ctx = profileVenue(CHICAGO);
  const items = [{ price: 100, qty: 1 }];
  const disc = computeOrderTaxUnified(items, ctx, 'dine-in', { discounts: [{ type: 'amount', value: 20 }] });
  assert.deepEqual(disc.taxV2.lines.map(l => l.amount), [5, 1.4, 1, 0.4]);
  assert.equal(disc.exclusiveTax, 7.8);
  const svc = computeOrderTaxUnified(items, ctx, 'dine-in', { discounts: [{ type: 'amount', value: 20 }], service: 8 });
  assert.deepEqual(svc.taxV2.lines.map(l => l.amount), [5.5, 1.54, 1.1, 0.44]);
  assert.equal(svc.exclusiveTax, 8.58);
});

test('Omaha compound: occupation on the discounted base, sales compounds on base + occupation', () => {
  const r = computeOrderTaxUnified([{ price: 100, qty: 1 }], profileVenue(OMAHA), 'dine-in',
    { discounts: [{ type: 'amount', value: 10 }] });
  const byId = Object.fromEntries(r.taxV2.lines.map(l => [l.lineId, l.amount]));
  assert.equal(byId.occ, 2.25);    // 90 x 2.5%
  assert.equal(byId.sales, 6.92);  // (90 + 2.25) x 7.5% = 6.91875
  assert.equal(r.exclusiveTax, 9.17);
});

test('a pre_discount line on a mixed profile keeps the menu price while its neighbour discounts', () => {
  const mixed = { id: 'p-mix', name: 'Mixed', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
    lines: [pline({ id: 'st', rate: 0.05, taxBasis: 'pre_discount', taxServiceCharge: false }), pline({ id: 'loc', rate: 0.05, sortOrder: 1, taxServiceCharge: false })] };
  const r = computeOrderTaxUnified([{ price: 100, qty: 1 }], profileVenue(mixed), 'dine-in', { discounts: [{ type: 'percent', value: 50 }] });
  const byId = Object.fromEntries(r.taxV2.lines.map(l => [l.lineId, l.amount]));
  assert.equal(byId.st, 5);
  assert.equal(byId.loc, 2.5);
});

// ── 7. checkout credits ─────────────────────────────────────────────────────

test('promo and loyalty credits lower the tax, not the bill (the checkout takes the credit off)', () => {
  const base = {
    items: [{ uid: 'a', price: 50, qty: 1, taxRateId: 'ten' }],
    orderType: 'takeaway', deviceConfig: {}, discountRules: [], taxRates: TEN,
  };
  const plain = computeCheckTotals(base);
  assert.equal(plain.exclusiveTax, 5);
  const credited = computeCheckTotals({ ...base, creditDiscounts: creditDiscounts({ promo: 8, loyalty: 2 }) });
  assert.equal(credited.exclusiveTax, 4);            // 40 x 10%
  assert.equal(credited.discountedSub, 50);          // credits are NOT taken here
  assert.equal(credited.total, 54);
});

test('credits read off a paymentInfo: promo in major units, loyalty in minor, a draft passes through', () => {
  assert.deepEqual(creditDiscountsFromPayment({ promoRedemption: { amount: 5 }, loyaltyRedemption: { discount_value: 250 } }).map(d => d.value), [5, 2.5]);
  assert.deepEqual(creditDiscountsFromPayment({}), []);
  const frozen = [{ type: 'amount', value: 3, source: 'promo' }];
  assert.equal(creditDiscountsFromPayment({ taxCredits: frozen }), frozen);
});

test('chargedAddedOnTax: a device\'s charged tax is booked only when it carries added-on tax', () => {
  const us = computeOrderTaxUnified([{ price: 10, qty: 1, taxRateId: 'ten' }], { taxRates: TEN }, 'takeaway', LINES_ONLY_BASIS);
  assert.equal(chargedAddedOnTax({ chargedTaxBreakdown: us }), us);
  const uk = computeOrderTaxUnified([{ price: 10, qty: 1, taxRateId: 'vat20' }], { taxRates: UK_RATES }, 'takeaway', LINES_ONLY_BASIS);
  assert.equal(chargedAddedOnTax({ chargedTaxBreakdown: uk }), null);
  assert.equal(chargedAddedOnTax({}), null);
});

test('recordedCheckTax: a US check reports the tax it charged; a UK check recomputes as before', () => {
  const charged = computeOrderTaxUnified([{ price: 50, qty: 1, taxRateId: 'ten' }], { taxRates: TEN }, 'takeaway', { discounts: [{ type: 'amount', value: 10 }] });
  const usCheck = { items: [{ price: 50, qty: 1, taxRateId: 'ten' }], orderType: 'takeaway', taxBreakdown: charged };
  assert.equal(recordedCheckTax(usCheck, { taxRates: TEN }).exclusiveTax, 4);
  const ukCheck = { items: [{ price: 12, qty: 1, taxRateId: 'vat20' }], orderType: 'dine-in', discounts: [{ type: 'amount', value: 2 }], service: 1.5 };
  assert.deepEqual(recordedCheckTax(ukCheck, { taxRates: UK_RATES }), computeOrderTaxUnified(ukCheck.items, { taxRates: UK_RATES }, 'dine-in'));
  assert.deepEqual(recordCheckBasis({ discounts: [], service: 2, loyalty: { discount_value: 150 }, customer: { delivery_fee: 4 } }),
    { discounts: [{ type: 'amount', value: 1.5, source: 'loyalty' }], service: 2, deliveryFee: 4 });
});

// ── 8. refunds pro rata ─────────────────────────────────────────────────────

// A US check: 20 steak + 2 x 10 wine, 10% off, 10% sales tax on 36 = 3.60, total 39.60.
const usCheck = () => {
  const items = [
    { uid: 'a', name: 'Steak', price: 20, qty: 1, taxRateId: 'ten' },
    { uid: 'b', name: 'Wine', price: 10, qty: 2, taxRateId: 'ten' },
  ];
  const tb = computeOrderTaxUnified(items, { taxRates: TEN }, 'dine-in', { discounts: [{ type: 'percent', value: 10 }] });
  return { id: 'chk-us', total: 39.6, subtotal: 40, service: 0, tip: 0, taxAmount: tb.totalTax, items, taxBreakdown: tb, refunds: [] };
};

test('refund: the check carries 3.60 of added-on tax and one figure per line', () => {
  const c = usCheck();
  assert.equal(addedOnTaxOf(c), 3.6);
  near(c.taxBreakdown.lineTaxes[0], 1.8);
  near(c.taxBreakdown.lineTaxes[1], 1.8);
});

test('refund: a partial refund gives back the tax THOSE items carried', () => {
  const bd = refundBreakdown(usCheck(), { items: [{ uid: 'b', price: 10, refundQty: 1 }] });
  assert.equal(bd.tax, 0.9);           // half of the wine line's 1.80
  assert.equal(bd.itemsAmount, 10);
  assert.equal(bd.amount, 10.9);
});

test('refund: a check without per-line figures falls back to pro rata by value', () => {
  const c = usCheck();
  delete c.taxBreakdown.lineTaxes;
  const bd = refundBreakdown(c, { items: [{ uid: 'a', price: 20, refundQty: 1 }] });
  assert.equal(bd.tax, 1.8);           // 3.60 x 20/40
});

test('refund: a full refund returns every penny, tax included, and the parts re-sum', () => {
  const bd = refundBreakdown(usCheck(), { isFullRefund: true });
  assert.equal(bd.amount, 39.6);
  assert.equal(bd.tax, 3.6);
  assert.equal(bd.itemsAmount, 36);
  assert.equal(r2(bd.itemsAmount + bd.tip + bd.service + bd.tax), bd.amount);
});

test('refund: tax already returned is never returned twice, and the total is capped', () => {
  const c = usCheck();
  c.refunds = [{ amount: 10.9, tipAmount: 0, serviceAmount: 0, addedTaxAmount: 0.9 }];
  assert.deepEqual(refundedSoFar(c), { items: 10, tip: 0, service: 0, addedTax: 0.9, total: 10.9 });
  const rest = refundBreakdown(c, { isFullRefund: true });
  assert.equal(rest.amount, 28.7);
  assert.equal(rest.tax, 2.7);
  assert.equal(rest.itemsAmount, 26);
});

test('refund: a UK inclusive check refunds exactly as before (no tax part at all)', () => {
  const items = [{ uid: 'a', price: 25, qty: 1, taxRateId: 'vat20' }, { uid: 'b', price: 7.5, qty: 2, taxRateId: 'vat20' }];
  const uk = {
    total: 51, subtotal: 40, service: 5, tip: 6, taxAmount: 6.67, items, refunds: [],
    taxBreakdown: computeOrderTaxUnified(items, { taxRates: UK_RATES }, 'dine-in', { service: 5 }),
  };
  assert.equal(addedOnTaxOf(uk), 0);
  const part = refundBreakdown(uk, { items: [{ uid: 'b', price: 7.5, refundQty: 2 }] });
  assert.equal(part.tax, 0);
  assert.equal(part.itemsAmount, 15);
  assert.equal(part.amount, r2(15 + part.tip + part.service));
  const full = refundBreakdown(uk, { isFullRefund: true });
  assert.equal(full.amount, 51);
  assert.equal(full.itemsAmount, 40);
  assert.equal(full.tax, 0);
});

// ── 9. review round 1 (19 Sep 2026) ─────────────────────────────────────────

test('review: a part refund keeps the service tax when the service is kept, returns it pro rata when not', () => {
  const items = [{ uid: 'a', price: 50, qty: 1, taxRateId: 'us' }, { uid: 'b', price: 50, qty: 1, taxRateId: 'us' }];
  const tb = computeOrderTaxUnified(items, { taxRates: US_RATES }, 'dine-in', { service: 18 });
  // (100 + 18) x 8.875% = 10.4725 -> 10.47; the service part is 18 x 8.875% = 1.5975.
  assert.equal(tb.exclusiveTax, 10.47);
  near(tb.serviceTax, 1.5975);
  near(tb.lineTaxes[0], 4.4375);   // goods only
  const check = { total: 128.47, subtotal: 100, service: 18, tip: 0, items, taxBreakdown: tb, refunds: [] };
  const kept = refundBreakdown(check, { items: [{ uid: 'b', price: 50, refundQty: 1 }], serviceOverride: 0 });
  assert.equal(kept.service, 0);
  assert.equal(kept.tax, 4.44);          // goods tax only (was 5.24 before the fix)
  const proRata = refundBreakdown(check, { items: [{ uid: 'b', price: 50, refundQty: 1 }] });
  assert.equal(proRata.service, 9);
  assert.equal(proRata.tax, 5.24);       // 4.4375 + 1.5975 / 2
});

test('review: a 0% added-on row moving its basis stays on the byte-identical path', () => {
  const rates = [...UK_RATES, { id: 'zx', name: 'Zero (exclusive)', rate: 0, type: 'exclusive', active: true, is_default: false }];
  const items = [{ price: 12, qty: 1, taxRateId: 'vat20' }, { price: 3, qty: 2, taxRateId: 'zx' }];
  const plain = computeOrderTaxUnified(items, { taxRates: rates }, 'dine-in');
  const based = computeOrderTaxUnified(items, { taxRates: rates }, 'dine-in', { discounts: [{ type: 'percent', value: 20 }], service: 2 });
  assert.equal(based.source, 'legacy');
  assert.equal(based.checkBasisApplied, undefined);
  assert.deepEqual(based, plain);
});

test('review: online takes the exact result when an offer hits an exempt line', () => {
  // taxable 10 at 8%, exempt 10 typed inclusive 0%; the offer takes 5 off the exempt line.
  const rates = [{ id: 't', name: 'Sales', rate: 0.08, type: 'exclusive', active: true, is_default: true },
    { id: 'z', name: 'Exempt', rate: 0, type: 'inclusive', active: true, is_default: false }];
  const items = [{ uid: 'a', price: 10, qty: 1, taxRateId: 't' }, { uid: 'b', price: 10, qty: 1, taxRateId: 'z' }];
  const r = computeOrderTaxUnified(items, { taxRates: rates }, 'collection',
    { discounts: [{ type: 'amount', value: 5, appliedItems: [{ uid: 'b', saving: 5 }] }] });
  assert.equal(r.checkBasisApplied, undefined);   // nothing taxed moved...
  assert.equal(chargesAddedOnRate(r), true);      // ...but it charges added-on tax, so online uses it
  assert.equal(r.exclusiveTax, 0.8);              // pro rata scaling would have charged 0.60
  // Inclusive-only (UK) and per-unit levy results never count.
  assert.equal(chargesAddedOnRate(computeOrderTaxUnified(items, { taxRates: UK_RATES }, 'collection')), false);
});

test('review: the kiosk V2 gift card is sized on the bill after the tax relief', () => {
  const src = fs.readFileSync(new URL('../surfaces/kiosk/useKioskCheckout.js', import.meta.url), 'utf8');
  assert.match(src, /const giftTotal = engine\.taxRelief > 0 \? \+\(total - engine\.taxRelief\)\.toFixed\(2\) : total;/);
  assert.match(src, /kioskGiftRestage\(\{ staged: giftCardPayment, total: giftTotal,/);
  assert.match(src, /giftDueMinor\(\{ total: giftTotal,/);
});

test('review: every closed-check door carries the booked US tax, and only US tax', () => {
  const gate = /\.tax_breakdown\?\.hasExclusiveTax \? \{ taxAmount: \w+\.tax_amount \?\? null, taxBreakdown: \w+\.tax_breakdown \} : \{\}/g;
  const rt = fs.readFileSync(new URL('./realtime.js', import.meta.url), 'utf8');
  assert.equal((rt.match(gate) || []).length, 2);   // realtime INSERT + UPDATE-append
  const ms = fs.readFileSync(new URL('../sync/MasterSync.js', import.meta.url), 'utf8');
  assert.equal((ms.match(gate) || []).length, 1);   // force sync
  const db = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  assert.equal((db.match(/\.\.\.\(c\.tax_breakdown\?\.hasExclusiveTax \? \{ taxBreakdown: c\.tax_breakdown \} : \{\}\)/g) || []).length, 2);
});

test('review: a catering record\'s delivery fee (booked in service) is counted once', () => {
  assert.deepEqual(recordCheckBasis({ source: 'catering', service: 6, customer: { delivery_fee: 6 } }),
    { discounts: [], service: 0, deliveryFee: 6 });
});

test('decision: a per-unit levy is added on top, so a part refund returns it with the items', () => {
  const sugar = { id: 'p-sugar', name: 'Sugar', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
    lines: [pline({ id: 'vat', rate: 0.2, mode: 'inclusive', taxBasis: 'pre_discount' }),
            pline({ id: 'levy', lineType: 'per_unit', flatAmount: 0.25, sortOrder: 1 })] };
  const items = [{ uid: 'a', price: 1.5, qty: 3 }];
  const tb = computeOrderTaxUnified(items, profileVenue(sugar, UK_RATES), 'takeaway');
  const check = { total: 5.25, subtotal: 4.5, service: 0, tip: 0, items, taxBreakdown: tb, refunds: [] };
  const bd = refundBreakdown(check, { items: [{ uid: 'a', price: 1.5, refundQty: 1 }] });
  assert.equal(bd.tax, 0.25);
  assert.equal(bd.amount, 1.75);
});
