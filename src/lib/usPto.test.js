// src/lib/usPto.test.js: US paid time off accrual (5.12.51).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ptoRules, ptoAccruals } from '../../supabase/functions/_shared/usPto.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const sheet = (id, hours, extra = {}) => ({ id, staff_id: 's1', actual_hours: hours, effective_rate: 12, currency: 'USD', year: 2026, clock_in: `2026-11-0${id}T15:00:00Z`, ...extra });

test('off by default: nothing accrues until the venue switches it on', () => {
  assert.deepEqual(ptoRules({}), { on: false, every: 30, yearCap: null });
  assert.deepEqual(ptoAccruals([sheet(1, 30)], {}, ptoRules({})), []);
});

test('1 hour for every 30 worked, with the pay value at their rate', () => {
  const r = ptoAccruals([sheet(1, 30), sheet(2, 15)], {}, ptoRules({ ptoEnabled: true }));
  assert.deepEqual(r.map((x) => [x.source_timesheet_id, x.accrued_hours, x.accrued_pay]), [[1, 1, 12], [2, 0.5, 6]]);
});

test('a venue can set its own rate', () => {
  const r = ptoAccruals([sheet(1, 40)], {}, ptoRules({ ptoEnabled: true, ptoEvery: 40 }));
  assert.equal(r[0].accrued_hours, 1);
  assert.deepEqual(ptoRules({ ptoEnabled: true, ptoEvery: 0 }).every, 30, 'a bad rate falls back to 30');
  assert.deepEqual(ptoRules({ ptoEnabled: true, ptoEvery: 500 }).every, 30);
});

test('the yearly cap stops accrual, the sheet that reaches it earns only up to it', () => {
  const rules = ptoRules({ ptoEnabled: true, ptoYearCap: 40 });
  const r = ptoAccruals([sheet(1, 30), sheet(2, 30)], { 's1|2026': 39.5 }, rules);
  assert.deepEqual(r.map((x) => x.accrued_hours), [0.5]);
  assert.deepEqual(ptoAccruals([sheet(1, 30)], { 's1|2026': 40 }, rules), []);
  // A new year starts again.
  assert.equal(ptoAccruals([sheet(1, 30, { year: 2027 })], { 's1|2026': 40 }, rules)[0].accrued_hours, 1);
});

test('salaried staff and empty sheets earn nothing', () => {
  const rules = ptoRules({ ptoEnabled: true });
  assert.deepEqual(ptoAccruals([sheet(1, 30)], {}, rules, () => false), []);
  assert.deepEqual(ptoAccruals([sheet(1, 0)], {}, rules), []);
});

test('US only: the PTO settings never show at UK venues, and the UK run is unchanged', () => {
  const settings = read('src/backoffice/sections/workforce/WfSettings.jsx');
  assert.match(settings, /\{pack\.country === 'US' \? \(\s+<div[^>]*>\s+<label style=\{\{[^}]*\}\}>\s+<input type="checkbox" checked=\{ptoEnabled\}/);
  assert.match(settings, /\.\.\.\(pack\.country === 'US' \? \{ ptoEnabled, ptoEvery: [^}]*, ptoYearCap: [^}]* \} : \{\}\)/);
  const fn = read('supabase/functions/workforce-compute/index.ts');
  assert.match(fn, /if \(pack\.holidayRules === 'us'\) \{/, 'the US branch is its own');
  assert.match(fn, /const rate = Number\(settings\?\.accrual_rate \?\? 0\.1207\);/, 'the UK rate rule is untouched');
});
