// src/lib/shiftClockTarget.test.js: staff app clock in follows the shift (5.12.54).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickClockTarget, shiftSpan } from '../../supabase/functions/_shared/shiftClockTarget.js';

const recs = [
  { id: 'provo', location_id: 'LP', site: 'Provo', tz: 'America/Denver' },
  { id: 'day', location_id: 'LD', site: 'Daybreak', tz: 'America/Denver' },
];
// 3 Nov 2026 in Denver (UTC-7): 11:00 local = 18:00Z.
const at = (iso) => Date.parse(iso);
const dayShift = { id: 'sh1', staff_id: 'day', location_id: 'LD', shift_date: '2026-11-03', start_time: '11:00', finish_time: '19:00' };

test('a shift at another site: clock in there', () => {
  const r = pickClockTarget({ now: at('2026-11-03T17:58:00Z'), records: recs, shifts: [dayShift] });
  assert.deepEqual(r, { target: { staff_id: 'day', location_id: 'LD', site: 'Daybreak', shift_id: 'sh1' } });
});

test('the window: 60 minutes before the start to the finish', () => {
  assert.ok(pickClockTarget({ now: at('2026-11-03T17:00:00Z'), records: recs, shifts: [dayShift] }).target, '60 minutes early');
  assert.ok(pickClockTarget({ now: at('2026-11-03T16:59:00Z'), records: recs, shifts: [dayShift] }).askSite, '61 minutes early: no match');
  assert.ok(pickClockTarget({ now: at('2026-11-04T02:00:00Z'), records: recs, shifts: [dayShift] }).target, 'at the finish');
  assert.ok(pickClockTarget({ now: at('2026-11-04T02:01:00Z'), records: recs, shifts: [dayShift] }).askSite, 'after the finish');
});

test('back to back: the shift starting soonest', () => {
  const provo = { id: 'sh0', staff_id: 'provo', location_id: 'LP', shift_date: '2026-11-03', start_time: '07:00', finish_time: '11:00' };
  const r = pickClockTarget({ now: at('2026-11-03T17:30:00Z'), records: recs, shifts: [dayShift, provo] });
  assert.equal(r.target.site, 'Provo');
});

test('no shift: ask which site, a refusing site is not offered, a picked site is used', () => {
  assert.deepEqual(pickClockTarget({ now: at('2026-11-03T15:00:00Z'), records: recs }).askSite.map((x) => x.site), ['Provo', 'Daybreak']);
  const refuseDay = [recs[0], { ...recs[1], noShift: 'refuse' }];
  assert.deepEqual(pickClockTarget({ now: 0, records: refuseDay }).askSite.map((x) => x.site), ['Provo']);
  assert.equal(pickClockTarget({ now: 0, records: recs, chosenSite: 'LD' }).target.site, 'Daybreak');
  assert.ok(pickClockTarget({ now: 0, records: refuseDay, chosenSite: 'LD' }).askSite, 'cannot pick a refusing site');
  assert.deepEqual(pickClockTarget({ now: 0, records: [{ ...recs[0], noShift: 'refuse' }] }), { refused: 'no_shift' });
});

test('one site only: exactly as before (no question)', () => {
  assert.equal(pickClockTarget({ now: 0, records: [recs[0]] }).target.site, 'Provo');
});

test('one open shift at a time, wherever it is', () => {
  const r = pickClockTarget({ now: at('2026-11-03T21:00:00Z'), records: recs, shifts: [dayShift], open: [{ id: 't1', staff_id: 'provo', location_id: 'LP', clock_in: '2026-11-03T16:00:00Z' }] });
  assert.deepEqual(r, { openElsewhere: { staff_id: 'provo', location_id: 'LP', site: 'Provo', since: '2026-11-03T16:00:00Z' } });
});

test('an overnight shift ends the next morning, in the site time zone (UK too)', () => {
  const sp = shiftSpan({ shift_date: '2026-11-03', start_time: '22:00', finish_time: '02:00' }, 'Europe/London');
  assert.equal(new Date(sp.start).toISOString(), '2026-11-03T22:00:00.000Z');
  assert.equal(new Date(sp.finish).toISOString(), '2026-11-04T02:00:00.000Z');
});
