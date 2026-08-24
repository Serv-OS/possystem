/**
 * taxCompute.test.js - the unified tax seam (v5.7.34 cutover).
 * Run: `npm test` (Node's built-in runner).
 *
 * Pins the three shapes the cutover must hold:
 *   1. a UK venue config through the FULL seam (generated venue-default mirror
 *      + legacy trio) = calculateOrderTax BYTE-identical (deepEqual, not near)
 *   2. The Cabin shape (one exclusive default profile via venue default,
 *      generated mirror) = slice-0 numbers identical
 *   3. a 4-line Chicago profile assigned to a category = stacked lines in
 *      tax_breakdown v2 and the summed charge
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeOrderTaxUnified, buildLocalTaxCtx, prepareTaxCtx, taxCtxHasConfig } from './taxCompute.js';
import { calculateOrderTax } from './tax.js';
import { legacyProfileId } from './taxAdapter.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── fixtures ────────────────────────────────────────────────────────────────

const UK_RATES = [
  { id: 'vat20', name: 'Standard Rate', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  { id: 'vat5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', active: true, is_default: false },
  { id: 'zero', name: 'Zero Rate', rate: 0, type: 'inclusive', active: true, is_default: false },
];

// Generated mirror profiles exactly as backfill 20260825c + assembleTaxProfiles produce.
const mirror = (pid, r, jurisdiction = null) => ({
  id: pid,
  name: r.name,
  description: 'Generated from the existing tax rate. Safe to rename or edit.',
  rounding: { mode: 'half_up', level: 'invoice' },
  active: true,
  sortOrder: 0,
  generatedFromRateId: r.id,
  lines: [{
    id: `l-${pid}`, name: r.name, jurisdiction,
    lineType: 'rate', rate: r.rate, flatAmount: 0,
    mode: r.type === 'inclusive' ? 'inclusive' : 'exclusive',
    compound: false, taxable: false, taxBasis: 'pre_discount',
    orderTypes: ['all'], sortOrder: 0, active: true,
  }],
});

const UK_PROFILES = UK_RATES.map(r => mirror(`gen-${r.id}`, r, r.type === 'inclusive' ? 'HMRC' : null));

const UK_ITEMS = [
  { id: 'a', price: 36.00, qty: 1, taxRateId: 'vat20' },
  { id: 'b', price: 6.50, qty: 2, taxRateId: 'vat20' },
  { id: 'c', price: 9.95, qty: 3, taxRateId: null },                       // "Use default"
  { id: 'd', price: 4.00, qty: 2, taxRateId: 'vat5' },
  { id: 'e', price: 2.50, qty: 1, taxRateId: 'zero' },
  { id: 'f', price: 6.00, qty: 1, taxRateId: 'vat20', taxOverrides: { takeaway: 'zero' } },
  { id: 'g', price: 5.00, qty: 1, taxRateId: '__not_in_menu__' },          // channel opt-out
  { id: 'h', price: 99.00, qty: 1, taxRateId: 'vat20', voided: true },
];

/** A UK venue exactly as v5.7.33 delivered it: legacy trio + generated
 *  profiles + the venue default pointing at the default rate's mirror. */
const ukCtx = () => buildLocalTaxCtx({
  taxProfiles: UK_PROFILES,
  menuItems: [],            // NO item assignments
  menuCategories: [],       // NO category assignments
  venueDefaultProfileId: 'gen-vat20',
  taxRates: UK_RATES,
});

// ── 1. UK: full seam = calculateOrderTax byte-identical ─────────────────────

test('UK venue through the FULL seam is byte-identical to calculateOrderTax (dine-in + takeaway)', () => {
  for (const orderType of ['dine-in', 'takeaway']) {
    const uni = computeOrderTaxUnified(UK_ITEMS, ukCtx(), orderType);
    const leg = calculateOrderTax(UK_ITEMS, UK_RATES, orderType);
    // BYTE-identical: the legacy keys are calculateOrderTax's own output.
    assert.equal(uni.source, 'legacy');
    assert.equal(uni.subtotal, leg.subtotal);
    assert.equal(uni.totalTax, leg.totalTax);
    assert.equal(uni.total, leg.total);
    assert.equal(uni.exclusiveTax, leg.exclusiveTax);
    assert.equal(uni.hasExclusiveTax, leg.hasExclusiveTax);
    assert.deepEqual(uni.breakdown, leg.breakdown);
    // The UK lock: nothing is ever ADDED on top.
    assert.equal(uni.exclusiveTax, 0);
    // v2 rides alongside without touching the legacy keys.
    assert.equal(uni.taxV2.version, 2);
    assert.equal(uni.taxV2.source, 'legacy');
    assert.ok(Array.isArray(uni.taxV2.lines) && uni.taxV2.lines.length > 0);
    near(uni.taxV2.inclusiveExtractedTotal, Math.round(leg.totalTax * 100) / 100, 0.011);
  }
});

test('UK venue WITHOUT any profiles delivered (rates only) still routes parity', () => {
  const ctx = buildLocalTaxCtx({ taxRates: UK_RATES });
  const uni = computeOrderTaxUnified(UK_ITEMS, ctx, 'dine-in');
  const leg = calculateOrderTax(UK_ITEMS, UK_RATES, 'dine-in');
  assert.equal(uni.source, 'legacy');
  assert.deepEqual(uni.breakdown, leg.breakdown);
  assert.equal(uni.totalTax, leg.totalTax);
});

test('minimal { taxRates } ctx (channelMoney default) behaves like calculateOrderTax', () => {
  const uni = computeOrderTaxUnified(UK_ITEMS, { taxRates: UK_RATES }, 'dine-in');
  const leg = calculateOrderTax(UK_ITEMS, UK_RATES, 'dine-in');
  assert.equal(uni.source, 'legacy');
  assert.equal(uni.totalTax, leg.totalTax);
  assert.equal(uni.exclusiveTax, 0);
});

test('the __not_in_menu__ sentinel books zero through the seam on both paths', () => {
  const items = [{ id: 'x', price: 10, qty: 1, taxRateId: '__not_in_menu__' }];
  const uk = computeOrderTaxUnified(items, ukCtx(), 'delivery');
  assert.equal(uk.totalTax, 0);
  assert.deepEqual(uk.breakdown, []);
});

// ── 2. The Cabin: one exclusive default profile via venue default ───────────

const CABIN_RATES = [
  { id: 'us', name: 'Sales Tax', rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  { id: 'exempt', name: 'Tax Exempt', rate: 0, type: 'exclusive', active: true, is_default: false },
];
const CABIN_ITEMS = [
  { id: 'a', price: 47.20, qty: 1, taxRateId: 'us' },
  { id: 'b', price: 3.00, qty: 2, taxRateId: 'exempt' },
  { id: 'c', price: 10.00, qty: 1, taxRateId: null },   // "Use default"
];

test('The Cabin: exclusive default profile via venue default = slice-0 numbers identical', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: CABIN_RATES.map(r => mirror(`gen-${r.id}`, r)),
    venueDefaultProfileId: 'gen-us',
    taxRates: CABIN_RATES,
  });
  const uni = computeOrderTaxUnified(CABIN_ITEMS, ctx, 'dine-in');
  const leg = calculateOrderTax(CABIN_ITEMS, CABIN_RATES, 'dine-in');
  assert.equal(uni.source, 'legacy');            // mirror default = legacy-equivalent
  assert.equal(uni.exclusiveTax, leg.exclusiveTax);
  assert.equal(uni.exclusiveTax, 5.08);          // (47.20 + 10.00) x 8.875% = 5.0764 -> 5.08
  assert.equal(uni.totalTax, leg.totalTax);
  assert.deepEqual(uni.breakdown, leg.breakdown);
  assert.equal(uni.hasExclusiveTax, true);
  assert.equal(uni.taxV2.exclusiveTaxTotal, 5.08);
});

// ── 3. Chicago: a 4-line profile assigned to a category ─────────────────────

const CHICAGO = {
  id: 'p-chicago',
  name: 'Chicago restaurant',
  rounding: { mode: 'half_up', level: 'invoice' },
  active: true,
  generatedFromRateId: null,
  lines: [
    { id: 'il', name: 'Illinois State', jurisdiction: 'Illinois', lineType: 'rate', rate: 0.0625, flatAmount: 0, mode: 'exclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 0, active: true },
    { id: 'cook', name: 'Cook County', jurisdiction: 'Cook County', lineType: 'rate', rate: 0.0175, flatAmount: 0, mode: 'exclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 1, active: true },
    { id: 'chi', name: 'City of Chicago', jurisdiction: 'City of Chicago', lineType: 'rate', rate: 0.0125, flatAmount: 0, mode: 'exclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 2, active: true },
    { id: 'rta', name: 'RTA', jurisdiction: 'RTA', lineType: 'rate', rate: 0.0050, flatAmount: 0, mode: 'exclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 3, active: true },
  ],
};

test('Chicago 4-line profile on a category: stacked v2 lines + the summed charge', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: [CHICAGO],
    menuCategories: [{ id: 'cat-food', tax_profile_id: 'p-chicago' }],
    taxRates: [],
  });
  const items = [{ id: 'burger', price: 100, qty: 1, cat: 'cat-food' }];
  const uni = computeOrderTaxUnified(items, ctx, 'dine-in');
  assert.equal(uni.source, 'profiles');
  // The summed charge: 6.25 + 1.75 + 1.25 + 0.50 = 9.75 added on top.
  assert.equal(uni.exclusiveTax, 9.75);
  assert.equal(uni.subtotal, 100);
  assert.equal(uni.total, 109.75);
  assert.equal(uni.hasExclusiveTax, true);
  // Stacked NAMED lines in the v2 record.
  assert.equal(uni.taxV2.version, 2);
  assert.equal(uni.taxV2.source, 'profiles');
  assert.deepEqual(uni.taxV2.lines.map(l => [l.name, l.amount]), [
    ['Illinois State', 6.25], ['Cook County', 1.75], ['City of Chicago', 1.25], ['RTA', 0.50],
  ]);
  // Legacy read shape holds: 4 breakdown entries with net/gross/items.
  assert.equal(uni.breakdown.length, 4);
  for (const b of uni.breakdown) {
    assert.equal(b.net, 100);
    near(b.gross, 100 + b.tax);
    assert.equal(b.items, 1);
    assert.equal(b.rate.type, 'exclusive');
  }
  near(uni.totalTax, 9.75);
});

test('item legacy rate still outranks the category profile (binding cascade)', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: [CHICAGO, ...UK_PROFILES],
    menuCategories: [{ id: 'cat-food', tax_profile_id: 'p-chicago' }],
    taxRates: UK_RATES,
  });
  const items = [{ id: 'pastry', price: 12, qty: 1, cat: 'cat-food', taxRateId: 'vat5' }];
  const uni = computeOrderTaxUnified(items, ctx, 'dine-in');
  assert.equal(uni.source, 'profiles');   // the venue has profile config
  assert.equal(uni.breakdown.length, 1);
  assert.equal(uni.breakdown[0].rate.id, 'vat5');
  near(uni.totalTax, 12 - 12 / 1.05);
  assert.equal(uni.exclusiveTax, 0);
});

// ── mirror remap + edited-profile detection ─────────────────────────────────

test('an EDITED generated profile as venue default routes through the engine, not parity', () => {
  const edited = mirror('gen-vat20', UK_RATES[0]);
  edited.lines = [
    ...edited.lines,
    { id: 'levy', name: 'Sugar Levy', jurisdiction: null, lineType: 'per_unit', rate: 0, flatAmount: 0.25, mode: 'exclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 1, active: true },
  ];
  const ctx = buildLocalTaxCtx({
    taxProfiles: [edited],
    venueDefaultProfileId: 'gen-vat20',
    taxRates: UK_RATES,
  });
  const items = [{ id: 'cola', price: 1.50, qty: 3 }];   // no taxRateId -> venue default
  const uni = computeOrderTaxUnified(items, ctx, 'dine-in');
  assert.equal(uni.source, 'profiles');
  assert.equal(uni.exclusiveTax, 0.75);                  // the levy: 0.25 x 3 added on
  const vatLine = uni.taxV2.lines.find(l => l.mode === 'inclusive');
  near(vatLine.amount, 0.75);                            // VAT still extraction-only
});

test('prepareTaxCtx remaps mirror assignments onto adapter profiles', () => {
  const prep = prepareTaxCtx(ukCtx());
  assert.equal(prep.venueDefaultProfileId, legacyProfileId('vat20'));
  assert.equal(prep.legacyEquivalent, true);
});

test('an item-level mirror assignment is NOT legacy-equivalent (it outranks item legacy config)', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: UK_PROFILES,
    menuItems: [{ id: 'a', tax_profile_id: 'gen-vat5' }],
    venueDefaultProfileId: 'gen-vat20',
    taxRates: UK_RATES,
  });
  const prep = prepareTaxCtx(ctx);
  assert.equal(prep.legacyEquivalent, false);
  // Item 'a' has taxRateId vat20 but the assigned profile (mirror of vat5) wins step 1.
  const uni = computeOrderTaxUnified([{ id: 'a', price: 21, qty: 1, taxRateId: 'vat20' }], ctx, 'dine-in');
  assert.equal(uni.breakdown[0].rate.id, 'vat5');
  near(uni.totalTax, 21 - 21 / 1.05);
});

test('a line-level taxProfileId snapshot forces the engine path even with empty maps', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: [CHICAGO],
    taxRates: [],
  });
  const uni = computeOrderTaxUnified([{ id: 'x', price: 100, qty: 1, taxProfileId: 'p-chicago' }], ctx, 'dine-in');
  assert.equal(uni.source, 'profiles');
  assert.equal(uni.exclusiveTax, 9.75);
});

// ── dangling profile ids: NEVER a tax-free sale (v5.7.34 money fix) ─────────

test('an item assigned to a NONEXISTENT profile id still taxes at the legacy default rate', () => {
  // The venue: UK legacy trio with a default rate, and one item whose
  // tax_profile_id points at a profile that is not loaded (deleted/unloaded).
  const ctx = buildLocalTaxCtx({
    taxProfiles: UK_PROFILES,
    menuItems: [{ id: 'a', tax_profile_id: 'p-deleted-somewhere' }],
    venueDefaultProfileId: 'gen-vat20',
    taxRates: UK_RATES,
  });
  const items = [{ id: 'a', price: 36, qty: 1 }];   // no taxRateId -> cascade
  const uni = computeOrderTaxUnified(items, ctx, 'dine-in');
  const leg = calculateOrderTax(items, UK_RATES, 'dine-in');
  // The dangling assignment is dropped, so the venue is legacy-equivalent
  // again and the line taxes at the legacy default (20% VAT extracted).
  assert.equal(uni.source, 'legacy');
  assert.equal(uni.totalTax, leg.totalTax);
  near(uni.totalTax, 36 - 36 / 1.2);
  assert.ok(uni.totalTax > 5.9);                    // NOT zero - the old bug
  assert.deepEqual(uni.breakdown, leg.breakdown);
});

test('a venue default pointing at a NONEXISTENT profile falls through to the legacy default rate', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: UK_PROFILES,
    venueDefaultProfileId: 'p-gone',
    taxRates: UK_RATES,
  });
  const items = [{ id: 'c', price: 9.95, qty: 3 }];   // "Use default"
  const uni = computeOrderTaxUnified(items, ctx, 'dine-in');
  const leg = calculateOrderTax(items, UK_RATES, 'dine-in');
  assert.equal(uni.source, 'legacy');
  assert.equal(uni.totalTax, leg.totalTax);
  assert.ok(uni.totalTax > 0);
  assert.equal(uni.breakdown[0].rate.id, 'vat20');
});

test('a dangling LINE-LEVEL profile snapshot falls through the cascade, never zero', () => {
  const uni = computeOrderTaxUnified(
    [{ id: 'x', price: 10, qty: 1, taxProfileId: 'p-gone' }], ukCtx(), 'dine-in');
  // The snapshot resolves nothing loaded -> parity path + legacy default rate.
  assert.equal(uni.source, 'legacy');
  near(uni.totalTax, 10 - 10 / 1.2);
});

test('on a real profile venue, a dangling item assignment cascades to the legacy default (mixed venue)', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: [CHICAGO, ...UK_PROFILES],
    menuItems: [{ id: 'a', tax_profile_id: 'p-gone' }],
    menuCategories: [{ id: 'cat-food', tax_profile_id: 'p-chicago' }],
    taxRates: UK_RATES,
  });
  // Item 'a': dangling item profile -> no legacy rate -> no category -> no
  // venue default -> legacy default rate (vat20 inclusive). The burger keeps
  // its Chicago category profile: the real assignment still applies.
  const uni = computeOrderTaxUnified([
    { id: 'a', price: 12, qty: 1 },
    { id: 'burger', price: 100, qty: 1, cat: 'cat-food' },
  ], ctx, 'dine-in');
  assert.equal(uni.source, 'profiles');
  assert.equal(uni.exclusiveTax, 9.75);             // Chicago stack unchanged
  const vat = uni.breakdown.find(b => b.rate?.id === 'vat20');
  assert.ok(vat, 'the dangling item books VAT at the legacy default');
  near(vat.tax, 12 - 12 / 1.2);
});

// ── invariants + fallbacks ──────────────────────────────────────────────────

test('exclusiveTax is the ONLY chargeable figure: inclusive-only profile order adds 0', () => {
  const ctx = ukCtx();
  const uni = computeOrderTaxUnified(UK_ITEMS, ctx, 'dine-in');
  assert.equal(uni.exclusiveTax, 0);
  assert.ok(uni.totalTax > 0);   // extraction still recorded
});

test('an invalid profile config falls back to legacy, flagged, never a guess', () => {
  const bad = {
    id: 'p-bad', name: 'Bad', rounding: { mode: 'half_up', level: 'invoice' }, active: true,
    generatedFromRateId: null,
    lines: [{ id: 'x', name: 'Bad line', lineType: 'per_unit', rate: 0, flatAmount: 0.25, mode: 'inclusive', compound: false, taxable: false, taxBasis: 'pre_discount', orderTypes: ['all'], sortOrder: 0, active: true }],
  };
  const ctx = buildLocalTaxCtx({
    taxProfiles: [bad, ...UK_PROFILES],
    menuCategories: [{ id: 'cat-x', tax_profile_id: 'p-bad' }],
    taxRates: UK_RATES,
  });
  const uni = computeOrderTaxUnified([{ id: 'i', price: 10, qty: 1, cat: 'cat-x' }], ctx, 'dine-in');
  assert.equal(uni.source, 'legacy-fallback');
  assert.equal(uni.taxV2, null);
  const leg = calculateOrderTax([{ id: 'i', price: 10, qty: 1, cat: 'cat-x' }], UK_RATES, 'dine-in');
  assert.equal(uni.totalTax, leg.totalTax);
});

test('taxCtxHasConfig: false for an unconfigured venue, true for rates or profiles', () => {
  assert.equal(taxCtxHasConfig(null), false);
  assert.equal(taxCtxHasConfig(buildLocalTaxCtx({})), false);
  assert.equal(taxCtxHasConfig(buildLocalTaxCtx({ taxRates: UK_RATES })), true);
  assert.equal(taxCtxHasConfig(buildLocalTaxCtx({
    taxProfiles: [CHICAGO],
    menuCategories: [{ id: 'c', tax_profile_id: 'p-chicago' }],
  })), true);
});

test('voided lines are excluded on both paths', () => {
  const ctx = buildLocalTaxCtx({
    taxProfiles: [CHICAGO],
    menuCategories: [{ id: 'cat-food', tax_profile_id: 'p-chicago' }],
  });
  const uni = computeOrderTaxUnified([
    { id: 'a', price: 100, qty: 1, cat: 'cat-food' },
    { id: 'b', price: 500, qty: 1, cat: 'cat-food', voided: true },
  ], ctx, 'dine-in');
  assert.equal(uni.exclusiveTax, 9.75);
  assert.equal(uni.subtotal, 100);
});
