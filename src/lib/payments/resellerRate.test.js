/**
 * resellerRate.test.js: what FranPOS keeps per payment, per currency.
 * Run: `node --test src/lib/payments/resellerRate.test.js`.
 *
 * The contract for BOTH copies: src/lib/payments/resellerRate.js and
 * supabase/functions/_shared/resellerRate.ts (the TS mirror test at the end).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import * as jsModule from './resellerRate.js';
import {
  RESELLER_DEFAULT_FIXED_BY_CURRENCY, RESELLER_CURRENCIES,
  resellerRateFor, resellerMarginFor, resellerRateLine, resellerRateSummary, resellerFixedTable, parseFixedByCurrency,
} from './resellerRate.js';

// payments-admin's rate resolution as it was before 10 Sep 2026, verbatim in
// shape, so "an entry with no per currency map reads exactly as before" is a
// test, not a promise.
function legacyRate(st, month) {
  let buyPercent = 0.10, buyFixedMinor = 5;
  if (st) {
    if (st.adyen_reseller_buy_percent != null) buyPercent = Number(st.adyen_reseller_buy_percent);
    if (st.adyen_reseller_buy_fixed_minor != null) buyFixedMinor = Number(st.adyen_reseller_buy_fixed_minor);
    const hist = st.adyen_reseller_rate_history;
    if (Array.isArray(hist) && hist.length) {
      const governing = hist
        .filter((h) => h && typeof h.from_month === 'string' && h.from_month <= month)
        .sort((a, b) => String(a.from_month).localeCompare(String(b.from_month)))
        .pop();
      if (governing && Number.isFinite(Number(governing.percent)) && Number.isFinite(Number(governing.fixed_minor))) {
        buyPercent = Number(governing.percent);
        buyFixedMinor = Number(governing.fixed_minor);
      }
    }
  }
  return { percent: buyPercent, fixedMinor: buyFixedMinor };
}
const settingsOf = (st) => ({ history: st?.adyen_reseller_rate_history, buyPercent: st?.adyen_reseller_buy_percent, buyFixedMinor: st?.adyen_reseller_buy_fixed_minor });

test('the defaults: 3p in GBP, 5c in USD and EUR, in editor order', () => {
  assert.deepEqual({ ...RESELLER_DEFAULT_FIXED_BY_CURRENCY }, { GBP: 3, USD: 5, EUR: 5 });
  assert.deepEqual([...RESELLER_CURRENCIES], ['GBP', 'USD', 'EUR']);
  assert.ok(Object.isFrozen(RESELLER_DEFAULT_FIXED_BY_CURRENCY));
});

test('resellerRateFor: nothing on file is 0.10% + 5, source default', () => {
  assert.deepEqual(resellerRateFor({}, 'GBP', '2026-09'), { percent: 0.10, fixedMinor: 5, fromMonth: null, source: 'default' });
  assert.deepEqual(resellerRateFor(null, 'USD', '2026-09'), { percent: 0.10, fixedMinor: 5, fromMonth: null, source: 'default' });
});

test('resellerRateFor: the settings columns when there is no history', () => {
  assert.deepEqual(resellerRateFor({ buyPercent: 0.12, buyFixedMinor: 4 }, 'GBP', '2026-09'), { percent: 0.12, fixedMinor: 4, fromMonth: null, source: 'settings' });
  // a fixed with no percent is still read, the source stays default as before
  assert.deepEqual(resellerRateFor({ buyFixedMinor: 7 }, 'GBP', '2026-09'), { percent: 0.10, fixedMinor: 7, fromMonth: null, source: 'default' });
});

test('resellerRateFor: the governing entry is the latest from_month at or before the month', () => {
  const history = [
    { percent: 0.10, fixed_minor: 5, from_month: '2026-08' },
    { percent: 0.15, fixed_minor: 6, from_month: '2026-10' },
    { percent: 0.12, fixed_minor: 4, from_month: '2026-09' },
  ];
  const s = { history, buyPercent: 0.15, buyFixedMinor: 6 };
  assert.deepEqual(resellerRateFor(s, 'GBP', '2026-09'), { percent: 0.12, fixedMinor: 4, fromMonth: '2026-09', source: 'history' });
  assert.deepEqual(resellerRateFor(s, 'GBP', '2026-08'), { percent: 0.10, fixedMinor: 5, fromMonth: '2026-08', source: 'history' });
  assert.deepEqual(resellerRateFor(s, 'GBP', '2026-12'), { percent: 0.15, fixedMinor: 6, fromMonth: '2026-10', source: 'history' });
  // before any entry: the settings
  assert.deepEqual(resellerRateFor(s, 'GBP', '2026-07'), { percent: 0.15, fixedMinor: 6, fromMonth: null, source: 'settings' });
});

test('resellerRateFor: the per currency fixed fee wins when it is a whole number 0 to 100', () => {
  const history = [{ percent: 0.10, fixed_minor: 5, fixed_minor_by_currency: { GBP: 3, USD: 5, EUR: 5 }, from_month: '2026-09' }];
  const s = { history, buyPercent: 0.10, buyFixedMinor: 5 };
  assert.equal(resellerRateFor(s, 'GBP', '2026-09').fixedMinor, 3);
  assert.equal(resellerRateFor(s, 'gbp', '2026-09').fixedMinor, 3);
  assert.equal(resellerRateFor(s, 'USD', '2026-09').fixedMinor, 5);
  assert.equal(resellerRateFor(s, 'EUR', '2026-09').fixedMinor, 5);
  // a currency the map does not name: the entry's fixed_minor
  assert.equal(resellerRateFor(s, 'CAD', '2026-09').fixedMinor, 5);
  // not whole, out of range, text, boolean, null: the entry's fixed_minor
  for (const bad of [2.5, -1, 101, 'x', true, null, '']) {
    const h = [{ percent: 0.10, fixed_minor: 5, fixed_minor_by_currency: { GBP: bad }, from_month: '2026-09' }];
    assert.equal(resellerRateFor({ history: h }, 'GBP', '2026-09').fixedMinor, 5, `GBP ${bad}`);
  }
  // 0 is a fee
  const zero = [{ percent: 0.10, fixed_minor: 5, fixed_minor_by_currency: { GBP: 0 }, from_month: '2026-09' }];
  assert.equal(resellerRateFor({ history: zero }, 'GBP', '2026-09').fixedMinor, 0);
});

test('resellerRateFor: an entry with no per currency map reads exactly as payments-admin did', () => {
  const shapes = [
    null,
    {},
    { adyen_reseller_buy_percent: 0.2 },
    { adyen_reseller_buy_percent: 0.2, adyen_reseller_buy_fixed_minor: 8 },
    { adyen_reseller_rate_history: [{ percent: 0.1, fixed_minor: 5, from_month: '2026-08' }] },
    { adyen_reseller_rate_history: [{ percent: 'x', fixed_minor: 5, from_month: '2026-08' }], adyen_reseller_buy_percent: 0.3 },
    { adyen_reseller_rate_history: [{ percent: 0.1, fixed_minor: null, from_month: '2026-08' }] },
    { adyen_reseller_rate_history: [null, { percent: 0.1, fixed_minor: 6 }, { percent: 0.11, fixed_minor: 7, from_month: '2026-09' }] },
    { adyen_reseller_rate_history: 'nope', adyen_reseller_buy_fixed_minor: 2 },
  ];
  for (const st of shapes) {
    for (const month of ['2026-07', '2026-08', '2026-09', '2027-01']) {
      for (const cur of ['GBP', 'USD', 'EUR']) {
        const got = resellerRateFor(settingsOf(st), cur, month);
        assert.deepEqual({ percent: got.percent, fixedMinor: got.fixedMinor }, legacyRate(st, month), `${JSON.stringify(st)} ${month} ${cur}`);
      }
    }
  }
});

test('resellerMarginFor: half up on the percent, plus the fixed fee (the Provo £1.00)', () => {
  assert.deepEqual(resellerMarginFor(100, { percent: 0.10, fixedMinor: 3 }), { percentMinor: 0, fixedMinor: 3, totalMinor: 3 });
  assert.deepEqual(resellerMarginFor(500, { percent: 0.10, fixedMinor: 3 }), { percentMinor: 1, fixedMinor: 3, totalMinor: 4 });   // 0.5 rounds up
  assert.deepEqual(resellerMarginFor(449, { percent: 0.10, fixedMinor: 5 }), { percentMinor: 0, fixedMinor: 5, totalMinor: 5 });
  assert.deepEqual(resellerMarginFor(12345, { percent: 0.10, fixedMinor: 5 }), { percentMinor: 12, fixedMinor: 5, totalMinor: 17 });
  // the same number the statement always computed
  for (const amount of [0, 1, 99, 100, 250, 1499, 1500, 99999]) {
    const legacy = Math.floor((amount * 0.1) / 100 + 0.5) + 5;
    assert.equal(resellerMarginFor(amount, { percent: 0.1, fixedMinor: 5 }).totalMinor, legacy, String(amount));
  }
  assert.deepEqual(resellerMarginFor('x', null), { percentMinor: 0, fixedMinor: 0, totalMinor: 0 });
});

test('resellerRateLine: plain words, p for GBP and c for USD or EUR', () => {
  assert.equal(resellerRateLine({ percent: 0.1, fixedMinor: 3 }, 'GBP'), '0.10% + 3p');
  assert.equal(resellerRateLine({ percent: 0.1, fixedMinor: 5 }, 'USD'), '0.10% + 5c');
  assert.equal(resellerRateLine({ percent: 0.1, fixedMinor: 5 }, 'EUR'), '0.10% + 5c');
  assert.equal(resellerRateLine({ percent: 0.125, fixedMinor: 4 }, 'gbp'), '0.125% + 4p');
  assert.equal(resellerRateLine({ percent: 1, fixedMinor: 0 }, 'GBP'), '1.00% + 0p');
  for (const s of [resellerRateLine({ percent: 0.1, fixedMinor: 3 }, 'GBP'), resellerRateLine(null, 'USD')]) assert.doesNotMatch(s, /[–—]| - /);
});

test('resellerRateSummary: the one line the FranPOS screen shows', () => {
  assert.equal(resellerRateSummary(0.1, { GBP: 3, USD: 5, EUR: 5 }), 'Interchange + 0.10% + 3p (GBP), 5c (USD), 5c (EUR)');
  assert.equal(resellerRateSummary(0.1, { GBP: 3 }), 'Interchange + 0.10% + 3p (GBP)');
  assert.equal(resellerRateSummary(0.1, null), 'Interchange + 0.10%');
});

test('resellerFixedTable: every editor currency for a month', () => {
  const history = [{ percent: 0.10, fixed_minor: 5, fixed_minor_by_currency: { GBP: 3 }, from_month: '2026-09' }];
  assert.deepEqual(resellerFixedTable({ history }, '2026-09'), { GBP: 3, USD: 5, EUR: 5 });
  assert.deepEqual(resellerFixedTable({ history }, '2026-08'), { GBP: 5, USD: 5, EUR: 5 });
});

test('parseFixedByCurrency: whole numbers 0 to 100, GBP USD EUR only, one plain sentence', () => {
  assert.deepEqual(parseFixedByCurrency({ GBP: 3, USD: '5', EUR: 5 }), { fixed: { GBP: 3, USD: 5, EUR: 5 }, error: null });
  assert.deepEqual(parseFixedByCurrency({ gbp: 0 }), { fixed: { GBP: 0 }, error: null });
  assert.deepEqual(parseFixedByCurrency({ GBP: '', USD: null }), { fixed: null, error: null });
  assert.deepEqual(parseFixedByCurrency(undefined), { fixed: null, error: null });
  assert.equal(parseFixedByCurrency({ GBP: 2.5 }).error, 'The fixed fee for GBP must be a whole number of pence, 0 to 100.');
  assert.equal(parseFixedByCurrency({ USD: 101 }).error, 'The fixed fee for USD must be a whole number of cents, 0 to 100.');
  assert.equal(parseFixedByCurrency({ JPY: 5 }).error, 'The fixed fee can only be set for GBP, USD, EUR.');
  assert.equal(parseFixedByCurrency([3]).error, 'The fixed fee per payment must be given per currency.');
  for (const r of [{ GBP: 2.5 }, { USD: 101 }, { JPY: 5 }, 'x']) {
    const e = parseFixedByCurrency(r).error;
    assert.ok(e.length < 120);
    assert.doesNotMatch(e, /[–—]| - /);
  }
});

test('parseFixedByCurrency requireAll: the setter needs every currency, so GBP pence never stand in for cents', () => {
  const all = { requireAll: true };
  assert.deepEqual(parseFixedByCurrency({ GBP: 3, USD: 5, EUR: 5 }, all), { fixed: { GBP: 3, USD: 5, EUR: 5 }, error: null });
  assert.deepEqual(parseFixedByCurrency({ GBP: 3 }, all), { fixed: null, error: 'Type the fixed fee for USD.' });
  assert.deepEqual(parseFixedByCurrency({ GBP: 3, USD: '', EUR: null }, all), { fixed: null, error: 'Type the fixed fee for USD.' });
  assert.deepEqual(parseFixedByCurrency({ GBP: 3, USD: 5 }, all), { fixed: null, error: 'Type the fixed fee for EUR.' });
  assert.deepEqual(parseFixedByCurrency({}, all), { fixed: null, error: 'Type the fixed fee for GBP.' });
  // not given at all is not a map: the old single fee path still works
  assert.deepEqual(parseFixedByCurrency(undefined, all), { fixed: null, error: null });
  assert.deepEqual(parseFixedByCurrency(null, all), { fixed: null, error: null });
  // a wrong value is still named before a missing one
  assert.equal(parseFixedByCurrency({ GBP: 2.5 }, all).error, 'The fixed fee for GBP must be a whole number of pence, 0 to 100.');
});

// ── THE TWO COPIES AGREE ─────────────────────────────────────────────────────
const TS_MIRROR = '../../../supabase/functions/_shared/resellerRate.ts';
test('TS mirror: every export answers exactly as the JS copy', async (t) => {
  // Skip ONLY when this node cannot strip types at all. Any other import
  // error (a syntax break in the mirror) fails the test.
  if (!process.features?.typescript) { t.skip('this node cannot strip TypeScript types'); return; }
  const ts = await import(TS_MIRROR);
  const jsNames = Object.keys(jsModule).sort();
  const tsNames = Object.keys(ts).filter((k) => typeof ts[k] !== 'undefined').sort();
  assert.deepEqual(tsNames, jsNames, 'the two copies export the same names');
  for (const k of jsNames) {
    if (typeof jsModule[k] !== 'function') assert.deepEqual(ts[k], jsModule[k], `constant ${k}`);
  }
  const history = [
    { percent: 0.10, fixed_minor: 5, from_month: '2026-08' },
    { percent: 0.12, fixed_minor: 5, fixed_minor_by_currency: { GBP: 3, USD: 5, EUR: 'x' }, from_month: '2026-09' },
  ];
  const settings = [{}, null, { buyPercent: 0.2, buyFixedMinor: 7 }, { history, buyPercent: 0.12, buyFixedMinor: 5 }, { history: 'x' }];
  for (const s of settings) {
    for (const month of ['2026-07', '2026-08', '2026-09', '']) {
      assert.deepEqual(ts.resellerFixedTable(s, month), resellerFixedTable(s, month));
      for (const cur of ['GBP', 'usd', 'EUR', 'CAD', null]) {
        const rate = resellerRateFor(s, cur, month);
        assert.deepEqual(ts.resellerRateFor(s, cur, month), rate);
        assert.equal(ts.resellerRateLine(rate, cur), resellerRateLine(rate, cur));
        for (const amount of [0, 100, 500, 12345, 'x']) assert.deepEqual(ts.resellerMarginFor(amount, rate), resellerMarginFor(amount, rate));
      }
    }
  }
  for (const f of [{ GBP: 3, USD: 5, EUR: 5 }, { GBP: 3 }, null, 'x']) assert.equal(ts.resellerRateSummary(0.1, f), resellerRateSummary(0.1, f));
  for (const r of [{ GBP: 3, USD: '5' }, { GBP: 2.5 }, { JPY: 1 }, [1], null, { EUR: '' }, { GBP: 3, USD: 5, EUR: 5 }, {}]) {
    assert.deepEqual(ts.parseFixedByCurrency(r), parseFixedByCurrency(r));
    assert.deepEqual(ts.parseFixedByCurrency(r, { requireAll: true }), parseFixedByCurrency(r, { requireAll: true }));
  }
});
