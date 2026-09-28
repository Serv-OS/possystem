/**
 * xeroTax.test.js: which Xero tax rate each ServOS sale posts at (28 Sep 2026).
 * Run: `npm test`, or `node --test src/lib/accounting/xeroTax.test.js`.
 *
 * Pinned:
 *   1. The picker never returns an expense rate. Xero lists "20% (VAT on Expenses)" (INPUT2)
 *      before "20% (VAT on Income)" (OUTPUT2); the old picker took INPUT2 and Xero refused
 *      Leeds's 26 Sep post. A cached INPUT2 heals to OUTPUT2.
 *   2. 0% is zero rated (ZERORATEDOUTPUT), exempt or outside the scope by the rate's name,
 *      and NONE in a US org, where NONE is "Tax Exempt". Never 20%.
 *   3. The operator's per rate choice wins; an expense or unknown choice is ignored and named;
 *      the older single taxDefault applies only at its own percentage; not VAT registered
 *      (salesNoVat, or taxDefault 'NONE') is NONE everywhere.
 *   4. Xero's own VAT on an inclusive line: 1233.09 at 20% is 205.51.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPENSE_TAX_RE, revenueTaxRates, expenseTaxRates, pickSalesTaxType, resolveSalesTaxType, serviceTaxType,
  healedTaxType, inclusiveTaxMinor, lineLabel, validateTaxMapping, migrateTaxMapping, rateOf, isSalesType,
} from '../../../supabase/functions/_shared/xeroTax.js';

// Xero's /TaxRates as its own example sends it: string flags, INPUT2 before OUTPUT2.
const xr = (TaxType, Name, rate, revenue, expense, extra = {}) => ({
  Name, TaxType, Status: 'ACTIVE', CanApplyToAssets: 'true', CanApplyToEquity: 'true', CanApplyToExpenses: String(expense),
  CanApplyToLiabilities: 'true', CanApplyToRevenue: String(revenue), DisplayTaxRate: rate.toFixed(4), EffectiveRate: rate.toFixed(4), ReportTaxType: '', ...extra,
});
const UK = [
  xr('INPUT2', '20% (VAT on Expenses)', 20, false, true),
  xr('OUTPUT2', '20% (VAT on Income)', 20, true, false),
  xr('RRINPUT', '5% (VAT on Expenses)', 5, false, true),
  xr('RROUTPUT', '5% (VAT on Income)', 5, true, false),
  xr('ZERORATEDINPUT', 'Zero Rated Expenses', 0, false, true),
  xr('ZERORATEDOUTPUT', 'Zero Rated Income', 0, true, false),
  xr('EXEMPTINPUT', 'Exempt Expenses', 0, false, true),
  xr('EXEMPTOUTPUT', 'Exempt Income', 0, true, false),
  xr('DRCHARGE20', 'Domestic Reverse Charge @ 20% (VAT on Income)', 20, true, false),
  xr('CAPEXINPUT2', '20% VAT on Capital Purchases', 20, false, false),
  xr('NONE', 'No VAT', 0, true, true),
];
const US = [
  { Name: 'Tax Exempt', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, CanApplyToExpenses: true, EffectiveRate: 0 },
  { Name: 'Tax on Purchases', TaxType: 'INPUT', Status: 'ACTIVE', CanApplyToRevenue: false, CanApplyToExpenses: true, EffectiveRate: 0 },
  { Name: 'Tax on Sales', TaxType: 'OUTPUT', Status: 'ACTIVE', CanApplyToRevenue: true, CanApplyToExpenses: false, EffectiveRate: 0 },
  { Name: 'Sales Tax on Imports', TaxType: 'GSTONIMPORTS', Status: 'ACTIVE', CanApplyToRevenue: false, CanApplyToExpenses: false, EffectiveRate: 0 },
  { Name: 'Auto Look Up (DO NOT USE)', TaxType: 'AVALARA', Status: 'ACTIVE', ReportTaxType: 'AVALARA', CanApplyToRevenue: true, EffectiveRate: 0 },
  { Name: 'NYC Sales Tax', TaxType: 'TAX001', Status: 'ACTIVE', CanApplyToRevenue: true, CanApplyToExpenses: false, EffectiveRate: 8.875 },
];
const rev = revenueTaxRates(UK);
const pick = (pct, zeroKind) => pickSalesTaxType(rev, { pct, zeroKind });

test('picker: never an expense rate', () => {
  assert.deepEqual(rev.map((r) => r.taxType), ['DRCHARGE20', 'EXEMPTOUTPUT', 'NONE', 'OUTPUT2', 'RROUTPUT', 'ZERORATEDOUTPUT']);
  assert.ok(rev.every((r) => !EXPENSE_TAX_RE.test(r.taxType)));
  assert.equal(pick(20), 'OUTPUT2');
  assert.equal(pick(5), 'RROUTPUT');
  assert.equal(pick(0, 'zero'), 'ZERORATEDOUTPUT');
  assert.equal(pick(0), 'ZERORATEDOUTPUT');
  assert.equal(pick(0, 'exempt'), 'EXEMPTOUTPUT');
  assert.equal(pick(0, 'outside'), 'NONE');
  assert.equal(pick(12.5), null);
  assert.equal(pick(null), null);
  // Xero's spec sends real booleans; the same answer
  const bools = UK.map((r) => ({ ...r, CanApplyToRevenue: r.CanApplyToRevenue === 'true', CanApplyToExpenses: r.CanApplyToExpenses === 'true' }));
  assert.deepEqual(revenueTaxRates(bools), rev);
  // flags left out: the code decides (INPUT2 is an expense rate by its name)
  const bare = UK.map((r) => { const x = { ...r }; delete x.CanApplyToRevenue; delete x.CanApplyToExpenses; return x; });
  assert.equal(pickSalesTaxType(revenueTaxRates(bare), { pct: 20 }), 'OUTPUT2');
  assert.ok(!revenueTaxRates(bare).some((r) => r.taxType === 'INPUT2' || r.taxType === 'CAPEXINPUT2'));
  // OUTPUT2 archived, a user's own 20% sales rate: that one, never the reverse charge rate
  const own = revenueTaxRates([...UK.map((r) => (r.TaxType === 'OUTPUT2' ? { ...r, Status: 'ARCHIVED' } : r)), xr('TAX001', 'Standard sales', 20, true, false)]);
  assert.equal(pickSalesTaxType(own, { pct: 20 }), 'TAX001');
  // purchases list the other way round
  const exp = expenseTaxRates(UK).map((r) => r.taxType);
  assert.ok(exp.includes('INPUT2') && exp.includes('NONE') && !exp.includes('OUTPUT2'));
});

test('picker: a US org list maps 0% to NONE', () => {
  const us = revenueTaxRates(US);
  assert.deepEqual(us.map((r) => r.taxType), ['NONE', 'OUTPUT', 'TAX001']);   // Avalara never
  assert.equal(pickSalesTaxType(us, { pct: 0 }), 'NONE');
  assert.equal(pickSalesTaxType(us, { pct: 0, zeroKind: 'exempt' }), 'NONE');
  assert.equal(pickSalesTaxType(us, { pct: 8.875 }), 'TAX001');
  assert.equal(pickSalesTaxType(us, { pct: 20 }), null);
  assert.equal(healedTaxType({ taxType: 'NONE' }, us), 'NONE');
});

test('resolver: per-rate mapping wins; expense or unknown mapping ignored and warned; legacy taxDefault only at its own percentage; taxDefault NONE or salesNoVat gives all NONE', () => {
  const std = { key: 'rate:s', rateId: 's', pct: 20, mode: 'inclusive' };
  const red = { key: 'rate:r', rateId: 'r', pct: 5, mode: 'inclusive' };
  const zero = { key: 'rate:z', rateId: 'z', pct: 0, mode: 'inclusive', zeroKind: 'zero' };
  const none = { key: 'none', pct: 0, mode: 'none' };
  const r = (b, mapping, detail = {}, list = rev) => resolveSalesTaxType(b, { mapping, revenueRates: list, detail });
  // auto by percentage
  assert.deepEqual(r(std, {}), { taxType: 'OUTPUT2', source: 'auto', invalid: null });
  assert.deepEqual(r(zero, {}), { taxType: 'ZERORATEDOUTPUT', source: 'auto', invalid: null });
  assert.equal(r(none, {}).taxType, 'ZERORATEDOUTPUT');
  // a dry run with no list: UK assumed, said so
  assert.deepEqual(r(red, {}, {}, null), { taxType: 'RROUTPUT', source: 'assumed', invalid: null });
  // the operator's choice
  assert.deepEqual(r(zero, { taxRateMap: { z: 'EXEMPTOUTPUT' } }), { taxType: 'EXEMPTOUTPUT', source: 'mapped', invalid: null });
  assert.equal(r(none, { taxRateMap: { none: 'NONE' } }).taxType, 'NONE');
  // an expense rate, or one the org does not have, is ignored and named
  assert.deepEqual(r(std, { taxRateMap: { s: 'INPUT2' } }), { taxType: 'OUTPUT2', source: 'auto', invalid: 'INPUT2' });
  assert.deepEqual(r(std, { taxRateMap: { s: 'TAX999' } }), { taxType: 'OUTPUT2', source: 'auto', invalid: 'TAX999' });
  assert.equal(r(std, { taxDefault: 'INPUT2' }).invalid, 'INPUT2');
  // the older single taxDefault: at its own percentage only, never on 0% or unrated goods
  assert.deepEqual(r(std, { taxDefault: 'OUTPUT2' }), { taxType: 'OUTPUT2', source: 'legacy', invalid: null });
  assert.equal(r(zero, { taxDefault: 'OUTPUT2' }).taxType, 'ZERORATEDOUTPUT');
  assert.equal(r(none, { taxDefault: 'OUTPUT2' }).taxType, 'ZERORATEDOUTPUT');
  assert.equal(r(red, { taxDefault: 'OUTPUT2' }).taxType, 'RROUTPUT');
  assert.equal(r({ key: 'default', pct: null }, { taxDefault: 'RROUTPUT' }).taxType, 'RROUTPUT');
  // the default bucket (rates unknown) and added-on tax: today's taxDefault, else the cached default
  assert.equal(r({ key: 'default', pct: null }, {}, { taxType: 'OUTPUT2' }).taxType, 'OUTPUT2');
  assert.equal(r({ key: 'excl', pct: null, mode: 'exclusive' }, {}, { taxType: 'NONE' }).taxType, 'NONE');
  assert.equal(r({ key: 'default', pct: null }, {}, { taxType: 'INPUT2' }).taxType, 'OUTPUT2');
  // a percentage the org has no rate for: unmapped, never guessed
  assert.deepEqual(r({ key: 'pct:12.5', pct: 12.5, mode: 'inclusive' }, {}), { taxType: null, source: 'unmapped', invalid: null });
  // not VAT registered
  for (const mapping of [{ salesNoVat: true, taxRateMap: { s: 'OUTPUT2' } }, { taxDefault: 'NONE' }]) {
    for (const b of [std, red, zero, none, { key: 'pct:12.5', pct: 12.5 }]) assert.deepEqual(r(b, mapping), { taxType: 'NONE', source: 'no_vat', invalid: null });
  }
});

test('service charge: No VAT unless opted in', () => {
  const std = { key: 'rate:s', rateId: 's', pct: 20, mode: 'inclusive' };
  const s = (mapping) => serviceTaxType({ mapping, revenueRates: rev, detail: {} }, std);
  assert.equal(s({}), 'NONE');
  assert.equal(s({ serviceTax: 'OUTPUT2' }), 'OUTPUT2');
  assert.equal(s({ serviceTax: 'INPUT2' }), 'NONE');
  assert.equal(s({ serviceTaxable: true }), 'OUTPUT2');
  assert.equal(s({ serviceTaxable: true, taxRateMap: { s: 'RROUTPUT' } }), 'RROUTPUT');
  assert.equal(s({ serviceTaxable: false, serviceTax: 'OUTPUT2' }), 'NONE');
  assert.equal(s({ salesNoVat: true, serviceTax: 'OUTPUT2' }), 'NONE');
  // taxable, but the default rate has no Xero match: null, so the day is refused
  assert.equal(serviceTaxType({ mapping: { serviceTaxable: true }, revenueRates: rev }, { key: 'pct:12.5', pct: 12.5 }), null);
  // a venue that adds tax on top (US): today's rule, the sales line's rate
  const us = revenueTaxRates(US);
  const excl = { key: 'excl', pct: null, mode: 'exclusive' };
  const u = (mapping, detail = { taxType: 'NONE' }) => serviceTaxType({ mapping, revenueRates: us, detail }, excl);
  assert.equal(u({ taxDefault: 'TAX001' }), 'TAX001');
  assert.equal(u({}), 'NONE');
  assert.equal(u({}, { taxType: 'TAX001' }), 'TAX001');
  assert.equal(u({ taxDefault: 'TAX001', serviceTax: 'NONE' }), 'NONE');
  assert.equal(u({ taxDefault: 'TAX001', serviceTaxable: false }), 'NONE');
});

test('healedTaxType: a cached INPUT2 heals to OUTPUT2', () => {
  assert.equal(healedTaxType({ taxType: 'INPUT2' }, rev), 'OUTPUT2');
  assert.equal(healedTaxType({ taxType: 'OUTPUT2' }, rev), 'OUTPUT2');
  assert.equal(healedTaxType({ taxType: 'NONE' }, rev), 'NONE');
  assert.equal(healedTaxType({}, rev), 'OUTPUT2');
  assert.equal(healedTaxType({ taxType: 'INPUT2' }, revenueTaxRates(US)), 'NONE');
  assert.equal(isSalesType('INPUT2', null), false);
  assert.equal(isSalesType('TAX001', null), true);
});

test('inclusiveTaxMinor matches Xero: 123309 at 20 gives 20551', () => {
  assert.equal(inclusiveTaxMinor(123309, 20), 20551);   // Leeds 26 Sep, Xero's own TaxAmount
  assert.equal(inclusiveTaxMinor(1600, 20), 267);
  assert.equal(inclusiveTaxMinor(1050, 5), 50);
  assert.equal(inclusiveTaxMinor(400, 0), 0);
  assert.equal(rateOf('OUTPUT2', null), 20);
  assert.equal(rateOf('TAX001', revenueTaxRates(US)), 8.875);
  assert.equal(rateOf('TAX001', null), null);
});

test('line labels come from ServOS percentages and our codes, never Xero names', () => {
  assert.equal(lineLabel({ key: 'rate:s', pct: 20 }, 'OUTPUT2'), '20%');
  assert.equal(lineLabel({ key: 'pct:8.875', pct: 8.875 }, 'TAX001'), '8.875%');
  assert.equal(lineLabel({ key: 'rate:z', pct: 0 }, 'ZERORATEDOUTPUT'), 'zero rated');
  assert.equal(lineLabel({ key: 'rate:e', pct: 0 }, 'EXEMPTOUTPUT'), 'exempt');
  assert.equal(lineLabel({ key: 'rate:o', pct: 0 }, 'NONE'), 'no VAT');
  assert.equal(lineLabel({ key: 'none', pct: 0 }, 'ZERORATEDOUTPUT'), 'no tax rate');
  assert.equal(lineLabel({ key: 'default', pct: null }, 'OUTPUT2'), '');
  assert.equal(lineLabel({ key: 'excl', pct: null }, 'NONE'), '');
});

test('validateTaxMapping refuses INPUT2 for sales', () => {
  assert.equal(validateTaxMapping(null), null);
  assert.equal(validateTaxMapping({}), null);
  assert.equal(validateTaxMapping({ taxRateMap: { abc: 'OUTPUT2', none: 'ZERORATEDOUTPUT', old: '' }, serviceTax: 'NONE', salesNoVat: false, purchaseTax: 'INPUT2', extra: 1 }), null);
  assert.match(validateTaxMapping({ taxRateMap: { abc: 'INPUT2' } }), /INPUT2 cannot be used for sales/);
  assert.match(validateTaxMapping({ serviceTax: 'RRINPUT' }), /RRINPUT cannot be used for service charge/);
  assert.match(validateTaxMapping({ taxDefault: 'INPUT2' }), /INPUT2 cannot be used for sales/);
  assert.ok(validateTaxMapping({ taxRateMap: { abc: 'OUT PUT;' } }));
  assert.ok(validateTaxMapping({ taxRateMap: ['OUTPUT2'] }));
  assert.ok(validateTaxMapping({ salesNoVat: 'yes' }));
  assert.ok(validateTaxMapping([]));
});

// A UK org whose accountant keeps a custom 20% income rate.
const own = revenueTaxRates([...UK, xr('TAX005', 'Standard sales (own)', 20, true, false)]);

test('the older single VAT choice moves to per rate choices on the mapping screen', () => {
  const servos = [
    { id: 's', name: 'Standard', pct: 20, mode: 'inclusive', isDefault: true, active: true },
    { id: 'z', name: 'Zero', pct: 0, mode: 'inclusive', isDefault: false, active: true },
  ];
  const opts = { servosTaxRates: servos, salesTaxRates: rev };
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'OUTPUT2', revenueAccount: '200' }, opts), { revenueAccount: '200', taxRateMap: { s: 'OUTPUT2' } });
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'OUTPUT2', taxRateMap: { s: 'TAX001' } }, opts), { taxRateMap: { s: 'TAX001' } });
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'NONE' }, opts), { salesNoVat: true });
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'INPUT2' }, opts), {});
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'RROUTPUT' }, opts), {});   // not the default rate's %: Auto does better
  // a US venue keeps it (its added-on tax line still posts at it); nothing moves without both lists
  const us = { servosTaxRates: [{ id: 'st', pct: 6, mode: 'exclusive', isDefault: true, active: true }], salesTaxRates: revenueTaxRates(US) };
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'TAX001' }, us), { taxDefault: 'TAX001' });
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'OUTPUT2' }, { servosTaxRates: servos, salesTaxRates: [] }), { taxDefault: 'OUTPUT2' });
  assert.deepEqual(migrateTaxMapping({ paymentMap: { card: 'X' } }, opts), { paymentMap: { card: 'X' } });
  // every ServOS rate at its percentage keeps the choice, as the server applied it (not only the default)
  const two = { servosTaxRates: [...servos, { id: 'a', name: 'Alcohol', pct: 20, mode: 'inclusive', isDefault: false, active: true }], salesTaxRates: own };
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'TAX005' }, two), { taxRateMap: { s: 'TAX005', a: 'TAX005' } });
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'TAX005', taxRateMap: { a: 'OUTPUT2' } }, two), { taxRateMap: { a: 'OUTPUT2', s: 'TAX005' } });
  // no active inclusive default: checks with no breakdown still post at taxDefault, so it stays (and shows)
  const noDefault = { servosTaxRates: servos.map((r) => ({ ...r, isDefault: false })), salesTaxRates: own };
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'TAX005' }, noDefault), { taxDefault: 'TAX005', taxRateMap: { s: 'TAX005' } });
  // no ServOS rates at all: nothing moves
  assert.deepEqual(migrateTaxMapping({ taxDefault: 'TAX005' }, { servosTaxRates: [], salesTaxRates: own }), { taxDefault: 'TAX005' });
});
