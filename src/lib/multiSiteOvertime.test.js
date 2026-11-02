// src/lib/multiSiteOvertime.test.js
//
// 5.12.36: US overtime for one person across every site they work at (_shared/multiSiteOvertime.js).
// Peter, 2 Nov 2026: "they might work 20 hours at one site and 25 hours at another site. Then that is
// 5 hours over time."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overtimeAcrossSites } from '../../supabase/functions/_shared/multiSiteOvertime.js';
import { overtimeSplit } from '../../supabase/functions/_shared/payPremiums.js';

const TZ = 'America/Denver';
const PROVO = 'loc-provo', DAYBREAK = 'loc-daybreak';
// Mon 26 Oct to Sun 1 Nov 2026 is one Monday work week. 15:00Z is 09:00 in Denver (MDT, UTC-6).
const sheet = (staff, loc, day, hours, rate, extra = {}) => ({
  staff_id: staff, person: 'jane', location_id: loc, actual_hours: hours, effective_rate: rate,
  clock_in: `2026-${day}T15:00:00Z`, ...extra,
});

const peterWeek = () => [
  sheet('jane-provo', PROVO, '10-26', 8, 15), sheet('jane-provo', PROVO, '10-27', 8, 15), sheet('jane-provo', PROVO, '10-28', 4, 15),
  sheet('jane-day', DAYBREAK, '10-29', 8, 17), sheet('jane-day', DAYBREAK, '10-30', 8, 17), sheet('jane-day', DAYBREAK, '10-31', 9, 17),
];

test("Peter's week: 20 hours at Provo then 25 at Daybreak is 5 overtime hours, at Daybreak", () => {
  const opts = { tz: TZ, from: '2026-10-26', to: '2026-11-01' };
  const provo = overtimeAcrossSites(peterWeek(), 40, { ...opts, here: PROVO });
  const day = overtimeAcrossSites(peterWeek(), 40, { ...opts, here: DAYBREAK });
  assert.deepEqual(Object.keys(provo), ['jane-provo']);
  assert.equal(provo['jane-provo'].regular, 20);
  assert.equal(provo['jane-provo'].overtime, 0);
  assert.equal(provo['jane-provo'].otherSiteHours, 25);
  assert.equal(provo['jane-provo'].overtimePremium, 0);
  assert.equal(provo['jane-provo'].regularRate, null);
  assert.equal(day['jane-day'].regular, 20);
  assert.equal(day['jane-day'].overtime, 5);
  assert.equal(day['jane-day'].otherSiteHours, 20);
  // The blend: (20 x 15 + 25 x 17) / 45 = 725 / 45 = 16.1111. Half of it on 5 hours = 40.28.
  assert.equal(day['jane-day'].regularRate, 16.1111);
  assert.equal(day['jane-day'].overtimePremium, 40.28);
});

test('the site that crosses 40 pays: worked the other way round, the overtime is at Provo', () => {
  const swapped = [
    sheet('jane-day', DAYBREAK, '10-26', 8, 17), sheet('jane-day', DAYBREAK, '10-27', 8, 17), sheet('jane-day', DAYBREAK, '10-28', 9, 17),
    sheet('jane-provo', PROVO, '10-29', 8, 15), sheet('jane-provo', PROVO, '10-30', 8, 15), sheet('jane-provo', PROVO, '10-31', 4, 15),
  ];
  const all = overtimeAcrossSites(swapped, 40, { tz: TZ });
  assert.equal(all['jane-day'].overtime, 0);
  assert.equal(all['jane-provo'].overtime, 5);
  assert.equal(all['jane-provo'].regular, 15);
  // Same blend, same premium, whoever pays it.
  assert.equal(all['jane-provo'].overtimePremium, 40.28);
});

test('without the link the same hours are 0 overtime (what payroll did before 5.12.36)', () => {
  const unlinked = peterWeek().map((s) => ({ ...s, person: s.staff_id }));
  const all = overtimeAcrossSites(unlinked, 40, { tz: TZ });
  assert.equal(all['jane-provo'].overtime, 0);
  assert.equal(all['jane-day'].overtime, 0);
});

test('a record that is not linked reads exactly as overtimeSplit always did', () => {
  const sheets = [];
  for (const d of ['10-26', '10-27', '10-28', '10-29', '10-30', '10-31']) sheets.push({ staff_id: 'a', actual_hours: 9, clock_in: `2026-${d}T15:00:00Z`, effective_rate: 12 });
  sheets.push({ staff_id: 'b', actual_hours: 30, clock_in: '2026-10-27T15:00:00Z', effective_rate: 20 });
  const old = overtimeSplit(sheets, 40, TZ);
  const now = overtimeAcrossSites(sheets, 40, { tz: TZ });
  for (const id of ['a', 'b']) {
    assert.equal(now[id].regular, old[id].regular);
    assert.equal(now[id].overtime, old[id].overtime);
    assert.equal(now[id].otherSiteHours, 0);
  }
  // One rate: the regular rate is that rate, the premium half of it per overtime hour.
  assert.equal(now.a.overtime, 14);
  assert.equal(now.a.regularRate, 12);
  assert.equal(now.a.overtimePremium, 84);
});

test('a week split by the pay period edge: counted whole, each period keeps its own share', () => {
  // Pay period 16 to 31 Oct ends on Saturday 31 Oct; the work week runs to Sunday 1 Nov.
  const sheets = [...peterWeek(), sheet('jane-day', DAYBREAK, '11-01', 6, 17)];
  const oct = overtimeAcrossSites(sheets, 40, { tz: TZ, from: '2026-10-16', to: '2026-10-31', here: DAYBREAK });
  const nov = overtimeAcrossSites(sheets, 40, { tz: TZ, from: '2026-11-01', to: '2026-11-15', here: DAYBREAK });
  assert.equal(oct['jane-day'].overtime, 5);
  assert.equal(nov['jane-day'].overtime, 6);
  assert.equal(nov['jane-day'].regular, 0);
  assert.equal(nov['jane-day'].otherSiteHours, 0);
});

test('pay premiums are in the blend (shift differentials count toward the regular rate)', () => {
  const sheets = peterWeek();
  sheets[5] = { ...sheets[5], premium_pay: 45 };   // a night premium on the last Daybreak shift
  const day = overtimeAcrossSites(sheets, 40, { tz: TZ, here: DAYBREAK });
  // (725 + 45) / 45 = 17.1111; half on 5 hours = 42.78.
  assert.equal(day['jane-day'].regularRate, 17.1111);
  assert.equal(day['jane-day'].overtimePremium, 42.78);
});

test('paid breaks are paid hours in the blend but not hours worked toward 40', () => {
  const sheets = peterWeek().map((s) => ({ ...s, paid_break_mins: 15 }));
  const day = overtimeAcrossSites(sheets, 40, { tz: TZ, here: DAYBREAK });
  assert.equal(day['jane-day'].overtime, 5);
  // Pay: 20.75 x 15 + 25.75 x 17 = 311.25 + 437.75 = 749; hours 46.5; rate 16.1075.
  assert.equal(day['jane-day'].regularRate, 16.1075);
});

test('each sheet is placed in its own venue day: a site in another time zone', () => {
  // A late shift starting Sun 1 Nov 23:00 in Los Angeles is Mon 2 Nov 07:00Z: Sunday for LA, so the
  // week of 26 Oct; read as Denver it would be Monday 2 Nov (the next week).
  const sheets = [...peterWeek(), { staff_id: 'jane-la', person: 'jane', location_id: 'loc-la', actual_hours: 3, effective_rate: 20, clock_in: '2026-11-02T07:00:00Z', tz: 'America/Los_Angeles' }];
  const la = overtimeAcrossSites(sheets, 40, { tz: TZ, here: 'loc-la' });
  assert.equal(la['jane-la'].overtime, 3);
});

test('two people are never mixed, and no weekly rule (the UK) is null', () => {
  const sheets = [...peterWeek(), { staff_id: 'sam', person: 'sam', location_id: DAYBREAK, actual_hours: 39, effective_rate: 14, clock_in: '2026-10-27T15:00:00Z' }];
  const day = overtimeAcrossSites(sheets, 40, { tz: TZ, here: DAYBREAK });
  assert.equal(day.sam.overtime, 0);
  assert.equal(day.sam.otherSiteHours, 0);
  assert.equal(overtimeAcrossSites(sheets, null, { tz: TZ }), null);
  assert.equal(overtimeAcrossSites(sheets, 0, { tz: TZ }), null);
  assert.deepEqual(overtimeAcrossSites([], 40, { tz: TZ }), {});
  assert.deepEqual(overtimeAcrossSites(null, 40, { tz: TZ }), {});
});
