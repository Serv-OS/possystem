// src/lib/tipCredit.test.js: the US tip credit top up (5.12.47).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tipCreditTopUps } from '../../supabase/functions/_shared/tipCredit.js';

// A Provo server on $2.13. Work week Monday to Sunday; 2 Nov 2026 is a Monday.
const sheet = (day, hours, rate = 2.13, extra = {}) => ({ staff_id: 's1', day, hours, rate, pay: hours * rate, ...extra });
const opts = { minWage: 7.25, weekStartDow: 1, from: '2026-11-01', to: '2026-11-15' };

test('tips that cover the minimum wage mean no top up', () => {
  const r = tipCreditTopUps([sheet('2026-11-03', 20)], [{ staff_id: 's1', amount: 120, day: '2026-11-04' }], opts);
  // owed 20 x 7.25 = 145; paid 42.60 + 120 = 162.60
  assert.equal(r.s1.topUp, 0);
  assert.equal(r.s1.weeks[0].owed, 145);
});

test('a slow week is topped up to the minimum wage', () => {
  const r = tipCreditTopUps([sheet('2026-11-03', 30)], [{ staff_id: 's1', amount: 60, day: '2026-11-05' }], opts);
  // owed 30 x 7.25 = 217.50; paid 63.90 + 60 = 123.90; top up 93.60
  assert.equal(r.s1.topUp, 93.6);
  assert.deepEqual(r.s1.weeks.map((w) => [w.week, w.topUp]), [['2026-11-02', 93.6]]);
});

test('weeks are never averaged', () => {
  const sheets = [sheet('2026-11-03', 20), sheet('2026-11-10', 20)];
  const tips = [{ staff_id: 's1', amount: 300, day: '2026-11-03' }, { staff_id: 's1', amount: 10, day: '2026-11-11' }];
  const r = tipCreditTopUps(sheets, tips, opts);
  // week 2: owed 145, paid 42.60 + 10 = 52.60, top up 92.40; week 1's spare tips do not help
  assert.equal(r.s1.topUp, 92.4);
  assert.equal(r.s1.weeks.length, 2);
});

test('staff on the minimum wage or above, or salaried, are left out', () => {
  assert.deepEqual(tipCreditTopUps([sheet('2026-11-03', 30, 7.25)], [], opts), {});
  assert.deepEqual(tipCreditTopUps([sheet('2026-11-03', 30, 15)], [], opts), {});
  assert.deepEqual(tipCreditTopUps([sheet('2026-11-03', 30, 2.13, { rate_source: 'salaried' })], [], opts), {});
});

test('a week belongs to the period holding its last day', () => {
  // Week of Mon 26 Oct to Sun 1 Nov ends inside 1 to 15 Nov: counted here.
  const r = tipCreditTopUps([sheet('2026-10-27', 10)], [], opts);
  assert.equal(r.s1.weeks[0].week, '2026-10-26');
  // Week of Mon 16 Nov ends after the 15th: not in this period.
  assert.deepEqual(tipCreditTopUps([sheet('2026-11-16', 10)], [], opts), {});
  // Week of Mon 9 Nov to Sun 15 Nov: in.
  assert.equal(tipCreditTopUps([sheet('2026-11-12', 10)], [], opts).s1.topUp, 51.2);
});

test("a site's own minimum wage is used", () => {
  // Owed at $10: 10 x 10 = 100; paid 21.30; top up 78.70
  const r = tipCreditTopUps([sheet('2026-11-03', 10, 2.13, { min_wage: 10 })], [], opts);
  assert.equal(r.s1.topUp, 78.7);
});

test('mixed weeks: a tipped sheet makes the whole week count at the minimum wage', () => {
  const sheets = [sheet('2026-11-03', 10), sheet('2026-11-04', 10, 9)];
  // owed 20 x 7.25 = 145; paid 21.30 + 90 = 111.30; top up 33.70
  assert.equal(tipCreditTopUps(sheets, [], opts).s1.topUp, 33.7);
});

test('half cents round the payroll way', () => {
  // owed 3 x 7.25 = 21.75; paid 6.39 + 0.005 = 6.395, which rounds half up to 6.40; top up 15.35
  const r = tipCreditTopUps([sheet('2026-11-03', 3)], [{ staff_id: 's1', amount: 0.005, day: '2026-11-03' }], opts);
  assert.equal(r.s1.topUp, 15.35);
});
