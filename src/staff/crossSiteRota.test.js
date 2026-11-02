// src/staff/crossSiteRota.test.js
//
// 5.12.38: the rota for a person who works at several linked sites (crossSiteRota.js), and pins that
// the Back Office rota uses it for every way a shift is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapLinkedShifts, otherSiteClash, otherSiteClashWords, weekHoursLine, asRuleShifts } from './crossSiteRota.js';
import { checkProposed, fillCoverage } from './rotaRules.js';

const hereStaff = [{ id: 'jane-provo', personId: 'p-jane' }, { id: 'sam-provo', personId: null }];
const records = [{ id: 'jane-day', person_id: 'p-jane', location_id: 'daybreak' }];
const siteNames = { daybreak: 'Daybreak' };
const away = (date, start, finish, status = 'published', breakMins = 0) => ({ id: `s-${date}-${start}`, staffId: 'jane-day', date, start, finish, breakMins, status });

test('their shifts at another site, in this site’s terms (only draft and published)', () => {
  const other = mapLinkedShifts({ records, hereStaff, siteNames, shifts: [away('2026-11-03', '12:00', '18:00'), away('2026-11-04', '09:00', '13:00', 'no_show'), { ...away('2026-11-05', '09:00', '13:00'), staffId: 'stranger' }] });
  assert.equal(other.length, 1);
  assert.deepEqual([other[0].staffId, other[0].site, other[0].otherSite], ['jane-provo', 'Daybreak', true]);
  assert.deepEqual(mapLinkedShifts({ records, shifts: [away('2026-11-03', '12:00', '18:00')], hereStaff: [{ id: 'x', personId: 'other' }], siteNames }), []);
  assert.deepEqual(mapLinkedShifts(), []);
});

test('a shift overlapping one at their other site is refused; touching ends are fine', () => {
  const other = mapLinkedShifts({ records, hereStaff, siteNames, shifts: [away('2026-11-03', '12:00', '18:00')] });
  const c = otherSiteClash(other, 'jane-provo', '2026-11-03', '17:00', '22:00');
  assert.equal(c.site, 'Daybreak');
  assert.equal(otherSiteClashWords(c, 'Tue'), 'Clashes with their 12:00 to 18:00 shift at Daybreak on Tue. Change the times, or move that shift first.');
  assert.equal(otherSiteClash(other, 'jane-provo', '2026-11-03', '18:00', '23:00'), null);   // split shift across sites
  assert.equal(otherSiteClash(other, 'jane-provo', '2026-11-04', '12:00', '18:00'), null);
  assert.equal(otherSiteClash(other, 'sam-provo', '2026-11-03', '12:00', '18:00'), null);
  // An overnight shift here running into one there.
  const late = mapLinkedShifts({ records, hereStaff, siteNames, shifts: [away('2026-11-03', '23:00', '02:00')] });
  assert.ok(otherSiteClash(late, 'jane-provo', '2026-11-03', '22:00', '23:30'));
});

test("the week line: Peter's 20 + 25 hours is 5 h overtime in the US, no overtime words in the UK", () => {
  const here = [
    { staffId: 'jane-provo', date: '2026-11-02', start: '09:00', finish: '17:00', status: 'published' },
    { staffId: 'jane-provo', date: '2026-11-03', start: '09:00', finish: '17:00', status: 'draft' },
    { staffId: 'jane-provo', date: '2026-11-04', start: '09:00', finish: '13:00', status: 'published' },
  ];
  const other = mapLinkedShifts({ records, hereStaff, siteNames, shifts: [
    away('2026-11-05', '09:00', '17:00'), away('2026-11-06', '09:00', '17:00'), away('2026-11-07', '08:00', '17:30', 'published', 30),
  ] });
  const week = { name: 'Jane Doe', staffId: 'jane-provo', hereShifts: here, otherShifts: other, fromIso: '2026-11-02', toIso: '2026-11-08' };
  assert.equal(weekHoursLine({ ...week, weekly: 40 }), 'Jane also has 25 h at Daybreak this week (45 h in all): 5 h overtime.');
  assert.equal(weekHoursLine({ ...week, weekly: null }), 'Jane also has 25 h at Daybreak this week (45 h in all).');
  assert.equal(weekHoursLine({ ...week, otherShifts: [] }), null);
  assert.equal(weekHoursLine({ ...week, fromIso: '2026-11-09', toIso: '2026-11-15' }), null);
});

test('the rota rules see their other site shifts for overlap and weekly hours, never as cover here', () => {
  const other = mapLinkedShifts({ records, hereStaff, siteNames, shifts: [away('2026-11-03', '12:00', '18:00')] });
  const existing = asRuleShifts(other);
  assert.equal(existing[0].section, '(at Daybreak)');
  const staff = [{ staffId: 'jane-provo', name: 'Jane', section: 'Floor', maxWeeklyHours: null }];
  const ctx = { dates: ['2026-11-03'], staff, openingHours: null, templates: [], availability: [], timeOff: [], rules: {} };
  const checked = checkProposed({ ...ctx, existing, proposed: [{ staffId: 'jane-provo', date: '2026-11-03', start: '14:00', finish: '20:00', section: 'Floor' }] });
  assert.equal(checked.accepted.length, 0, 'an overlap with Daybreak is refused');
  const filled = fillCoverage({ ...ctx, existing, accepted: [], sections: [{ name: 'Floor', minCoverage: 1 }], templates: [{ name: 'Lunch', start: '11:00', finish: '15:00', section: 'Floor' }] });
  assert.ok(!filled.added.some(a => a.staffId === 'jane-provo' && a.start === '11:00'), 'cover is not filled with someone at Daybreak then');
});

test('the Back Office rota uses the other site shifts for every way a shift is made', () => {
  const rota = fs.readFileSync(new URL('../backoffice/sections/workforce/WfRota.jsx', import.meta.url), 'utf8');
  assert.match(rota, /const away = otherSiteClash\(otherShifts, s\.id, day\.iso, payload\.start, payload\.finish\);/);       // add or edit
  assert.match(rota, /otherSiteClash\(otherShifts, target\.id, dateIso, copying\.start, copying\.finish\)/);                // copy a shift
  assert.match(rota, /findClash\(shifts, staffId, dateIso, source\.start, source\.finish\) \|\| otherSiteClash\(otherShifts/); // copy modal
  assert.match(rota, /const working = \[\.\.\.\(existing \|\| \[\]\), \.\.\.\(linked \? mapLinkedShifts/);                  // copy the week
  assert.match(rota, /\.\.\.asRuleShifts\(otherShifts\)\];/);                                                            // build with AI
  assert.match(rota, /wf\.loadLinkedShifts\(ctx\.locationId, ctx\.orgId, staff, wk\.startIso, wk\.endIso\)/);
});
