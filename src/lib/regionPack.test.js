// src/lib/regionPack.test.js
//
// v5.11.101: the region pack (_shared/regionPack.js). The pack follows the venue (country if there
// is one, else the currency), phones read with the venue's country, money and dates the venue's way,
// and the UK pack is exactly what the app did before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionOf, regionPack, toE164, fmtDateNumeric, wfMoneyText, payPeriodAllowed, docLabel, DOC_INFO } from '../../supabase/functions/_shared/regionPack.js';

test('the venue decides: country first, else the currency, else the UK', () => {
  assert.equal(regionOf({ currency: 'USD' }), 'US');
  assert.equal(regionOf({ currency: 'GBP' }), 'UK');
  assert.equal(regionOf({ currency: 'EUR' }), 'IE');
  assert.equal(regionOf('usd'), 'US');
  assert.equal(regionOf({}), 'UK');
  assert.equal(regionOf(null), 'UK');
  assert.equal(regionOf({ currency: 'XYZ' }), 'UK');
  assert.equal(regionOf({ country: 'US', currency: 'GBP' }), 'US');
  assert.equal(regionOf({ country: 'GB', currency: 'USD' }), 'UK');
  assert.equal(regionOf({ country: 'nowhere', currency: 'USD' }), 'US');
});

test('the UK pack is what the app did before', () => {
  const p = regionPack('GBP');
  assert.equal(p.currencySymbol, '£');
  assert.equal(p.holidayRules, 'uk');
  assert.equal(p.payrollExport, 'bacs');
  assert.equal(p.bankDetails, true);
  assert.deepEqual(p.payrollFields, ['bankSortCode', 'bankAccount', 'bankAccountName', 'niNumber', 'taxCode']);
  assert.deepEqual(p.documentTypes, ['RTW', 'foodHygieneL2', 'allergenTraining', 'SIA', 'firstAid', 'other']);
  assert.deepEqual(p.requiredDocs, ['RTW']);
  assert.equal(p.overtimeWeeklyHours, null);
  assert.ok(!p.payPeriods.includes('semimonthly'));
});

test('the US pack: dollars, no bank fields, SSN last 4 and the payroll id, I-9 and W-4, semi-monthly, 40 hour overtime', () => {
  const p = regionPack({ currency: 'USD' });
  assert.equal(p.country, 'US');
  assert.equal(p.currencySymbol, '$');
  assert.equal(p.dateFormat, 'MM/DD/YYYY');
  assert.equal(p.phoneDefaultCountryCode, '1');
  assert.equal(p.bankDetails, false);
  assert.ok(!p.payrollFields.some(f => /bank|sort/i.test(f)));
  assert.deepEqual(p.payrollFields, ['ssnLast4', 'payrollEmployeeId']);
  assert.deepEqual(p.requiredDocs, ['I9', 'W4']);
  assert.ok(p.documentTypes.includes('foodHandler'));
  assert.ok(payPeriodAllowed('USD', 'semimonthly'));
  assert.ok(!payPeriodAllowed('GBP', 'semimonthly'));
  assert.equal(p.holidayRules, 'us');
  assert.equal(p.overtimeWeeklyHours, 40);
  assert.equal(p.payrollExport, 'us_payroll');
  for (const t of p.documentTypes) assert.ok(DOC_INFO[t], t);
  assert.equal(docLabel('I9'), 'Form I-9 (work eligibility)');
  assert.equal(docLabel('mystery'), 'mystery');
});

test('a pack is a copy: changing it never changes the next one', () => {
  const a = regionPack('USD'); a.documentTypes.push('x'); a.payPeriods.length = 0;
  const b = regionPack('USD');
  assert.ok(!b.documentTypes.includes('x'));
  assert.ok(b.payPeriods.length > 0);
});

test('phones: a UK venue reads UK numbers exactly as before', () => {
  assert.equal(toE164('07931129015'), '+447931129015');
  assert.equal(toE164('07931 129 015', '44'), '+447931129015');
  assert.equal(toE164('00447931129015', '44'), '+447931129015');
  assert.equal(toE164('447931129015', '44'), '+447931129015');
  assert.equal(toE164('7931129015', '44'), '+447931129015');
  assert.equal(toE164('+447931129015', 'GBP'), '+447931129015');
  assert.equal(toE164('(0113) 496-0000', '44'), '+441134960000');
  assert.equal(toE164('', '44'), null);
  assert.equal(toE164(null, '44'), null);
  assert.equal(toE164('abc', '44'), null);
  assert.equal(toE164('+12', '44'), null);
});

test('phones: a US venue reads US numbers as +1 (the bug: 801 555 1234 became +44)', () => {
  assert.equal(toE164('801 555 1234', '1'), '+18015551234');
  assert.equal(toE164('(801) 555-1234', 'USD'), '+18015551234');
  assert.equal(toE164('801-555-1234', { currency: 'USD' }), '+18015551234');
  assert.equal(toE164('801.555.1234', '1'), '+18015551234');
  assert.equal(toE164('1 801 555 1234', '1'), '+18015551234');
  assert.equal(toE164('18015551234', '1'), '+18015551234');
  assert.equal(toE164('+18015551234', '1'), '+18015551234');
  // A UK mobile typed with its +44 at a US venue still goes to the UK.
  assert.equal(toE164('+447931129015', '1'), '+447931129015');
  assert.equal(toE164('00447931129015', '1'), '+447931129015');
  // Not a North American number: refused, never guessed into another country.
  assert.equal(toE164('555 1234', '1'), null);
  assert.equal(toE164('0801 555 1234', '1'), null);
  assert.equal(toE164('101 555 1234', '1'), null);
  assert.equal(toE164('07931129015', '1'), null);
});

test('phones: Ireland', () => {
  assert.equal(toE164('085 123 4567', '353'), '+353851234567');
  assert.equal(toE164('353851234567', 'EUR'), '+353851234567');
});

test('dates the venue way', () => {
  assert.equal(fmtDateNumeric('2026-10-24', 'GBP'), '24/10/2026');
  assert.equal(fmtDateNumeric('2026-10-24', 'USD'), '10/24/2026');
  assert.equal(fmtDateNumeric('nope', 'USD'), '');
});

test('money: a GBP venue reads byte for byte as the old Workforce formatter', () => {
  const old = (n, dp = 0) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  for (const [n, dp] of [[0, 0], [1234.5, 0], [1234.5, 2], [-12.345, 2], [null, 2], [1e6, 0], ['12.5', 2]]) {
    assert.equal(wfMoneyText(n, dp, 'GBP'), old(n, dp));
  }
  assert.equal(wfMoneyText(1234.5, 2, 'USD'), '$1,234.50');
  assert.equal(wfMoneyText(1234, 0, 'EUR'), '€1,234');
});
