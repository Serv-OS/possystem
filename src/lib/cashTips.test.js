// src/lib/cashTips.test.js: declared cash tips at clock out, US venues only (5.12.49).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asksCashTips, parseCashTips, CASH_TIPS_MAX } from '../../supabase/functions/_shared/cashTips.js';
import { tipCreditTopUps } from '../../supabase/functions/_shared/tipCredit.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('only a US venue asks, and the setting can switch it off', () => {
  assert.equal(asksCashTips({ country: 'US', settings: {} }), true, 'on by default');
  assert.equal(asksCashTips({ country: 'US', settings: null }), true);
  assert.equal(asksCashTips({ country: 'US', settings: { askCashTips: false } }), false);
  assert.equal(asksCashTips({ country: 'GB', settings: { askCashTips: true } }), false, 'never a UK venue');
  assert.equal(asksCashTips({ country: 'GB', settings: {} }), false);
  assert.equal(asksCashTips({}), false);
});

test('amounts: dollars and cents, 0 allowed, blank means not declared', () => {
  assert.deepEqual(parseCashTips('24.50'), { value: 24.5 });
  assert.deepEqual(parseCashTips('$1,200'), { value: 1200 });
  assert.deepEqual(parseCashTips(0), { value: 0 });
  assert.deepEqual(parseCashTips('0'), { value: 0 });
  assert.deepEqual(parseCashTips(' 7 '), { value: 7 });
  assert.deepEqual(parseCashTips(''), { value: null });
  assert.deepEqual(parseCashTips(null), { value: null });
  assert.deepEqual(parseCashTips(undefined), { value: null });
  assert.ok(parseCashTips('12.345').error, 'three decimals refused');
  assert.ok(parseCashTips('-5').error, 'negative refused');
  assert.ok(parseCashTips('abc').error);
  assert.ok(parseCashTips(String(CASH_TIPS_MAX + 1)).error, 'over the cap refused');
  assert.deepEqual(parseCashTips(String(CASH_TIPS_MAX)), { value: CASH_TIPS_MAX });
});

test('declared cash tips count toward the tip credit week', () => {
  const sheets = [{ staff_id: 's1', day: '2026-11-03', hours: 30, rate: 2.13, pay: 63.9 }];
  const card = [{ staff_id: 's1', amount: 60, day: '2026-11-05' }];
  const opts = { minWage: 7.25, weekStartDow: 1, from: '2026-11-01', to: '2026-11-15' };
  assert.equal(tipCreditTopUps(sheets, card, opts).s1.topUp, 93.6, 'card tips only');
  const withCash = [...card, { staff_id: 's1', amount: 50, day: '2026-11-03' }];
  assert.equal(tipCreditTopUps(sheets, withCash, opts).s1.topUp, 43.6, 'cash tips lower the top up');
  const plenty = [...card, { staff_id: 's1', amount: 120, day: '2026-11-03' }];
  assert.equal(tipCreditTopUps(sheets, plenty, opts).s1.topUp, 0);
});

test('the clock keeps cash tips only where the venue asks, and a bad amount is refused in words', () => {
  const fn = read('supabase/functions/workforce-clock/index.ts');
  assert.match(fn, /const asks = asksCashTips\(\{ country: regionPack\(\{ currency: await currencyOf\(location_id\) \}\)\.country, settings: vs \}\);\s+if \(asks\) \{/);
  assert.match(fn, /if \(ct\.error\) return json\(\{ error: ct\.error, field: 'cash_tips' \}, 400\);/);
  assert.match(fn, /askCashTips = asksCashTips\(/, 'status tells the tablet whether to ask');
  // An older database (before 20261117a) still clocks out.
  assert.match(fn, /if \(error && 'declared_cash_tips' in update && \/declared_cash_tips\/\.test\(error\.message \|\| ''\)\)/);
  const sp = read('supabase/functions/staff-portal/index.ts');
  assert.match(sp, /ask_cash_tips: askCashTips,/);
  assert.match(sp, /\.\.\.\(kind === 'out' && body\.cash_tips !== undefined \? \{ cash_tips: body\.cash_tips \} : \{\}\)/);
});

test('UK venues never see it: settings, payroll and timesheets are US only', () => {
  const settings = read('src/backoffice/sections/workforce/WfSettings.jsx');
  assert.match(settings, /\{pack\.country === 'US' \? \(\s+<label[^>]*>\s+<input type="checkbox" checked=\{askCashTips\}/);
  assert.match(settings, /\.\.\.\(pack\.country === 'US' \? \{ askCashTips \} : \{\}\),/, 'a UK save never writes the setting');
  const compute = read('supabase/functions/workforce-compute/index.ts');
  assert.match(compute, /\$\{pack\.country === 'US' \? ', declared_cash_tips' : ''\}/, 'a UK payroll never reads the column');
  assert.match(compute, /if \(pack\.country === 'US'\) \(tss \?\? \[\]\)\.forEach/);
  const payroll = read('src/backoffice/sections/workforce/WfPayroll.jsx');
  assert.match(payroll, /const withCashTips = usExport && run\?\.totals\?\.tips_cash_declared != null;/);
  const ts = read('src/backoffice/sections/workforce/WfTimesheets.jsx');
  assert.match(ts, /const isUS = activeCountry\(\) === 'US';/);
  assert.match(ts, /\{isUS && <div><label style=\{labelStyle\}>Cash tips \(\$\)<\/label>/);
  const data = read('src/staff/wfData.js');
  assert.match(data, /if \(ts\.cashTipsSet === true\) row\.declared_cash_tips = ts\.declaredCashTips \?\? null;/, 'only the US editor writes it');
});

test('declared cash tips are reported, never added to what the venue pays', () => {
  const compute = read('supabase/functions/workforce-compute/index.ts');
  assert.match(compute, /if \(anyCashDeclared\) line\.tips_cash_declared = cashDeclared\[id\] \?\? 0;/);
  assert.doesNotMatch(compute, /line\.total = round2\([^)]*tips_cash_declared/);
});

test('the migration adds a bounded column and is ASCII', () => {
  const sql = read('supabase/migrations/20261117a_OPS_declared_cash_tips.sql');
  assert.match(sql, /add column if not exists declared_cash_tips numeric\(10,2\)/);
  assert.match(sql, /check \(declared_cash_tips is null or \(declared_cash_tips >= 0 and declared_cash_tips <= 10000\)\)/);
  assert.ok([...sql].every((c) => c.charCodeAt(0) < 128));
});
