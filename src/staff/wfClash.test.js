/**
 * wfClash.test.js — rota clash/warning logic (shift overlap, approved leave,
 * weekly availability). Run: `npm test` (Node's built-in runner).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findClash, approvedLeaveOn, availabilityOn, clashWarnings, dayIdx, spanOf } from './wfClash.js';

// 2026-07-14 is a Tuesday
const TUE = '2026-07-14';

test('dayIdx maps Mon=0 … Sun=6', () => {
  assert.equal(dayIdx('2026-07-13'), 0); // Monday
  assert.equal(dayIdx(TUE), 1);          // Tuesday
  assert.equal(dayIdx('2026-07-19'), 6); // Sunday
});

test('spanOf rolls overnight finishes past midnight', () => {
  assert.deepEqual(spanOf('22:00', '02:00'), [22 * 60, 26 * 60]);
  assert.deepEqual(spanOf('09:00', '17:00'), [9 * 60, 17 * 60]);
});

test('findClash: overlap blocks, touching endpoints are fine, edits ignore themselves', () => {
  const list = [{ id: 'a', staffId: 's1', date: TUE, start: '09:00', finish: '17:00' }];
  assert.ok(findClash(list, 's1', TUE, '16:00', '20:00'));            // overlaps
  assert.equal(findClash(list, 's1', TUE, '17:00', '22:00'), undefined); // touches — OK
  assert.equal(findClash(list, 's2', TUE, '10:00', '12:00'), undefined); // other person
  assert.equal(findClash(list, 's1', '2026-07-15', '10:00', '12:00'), undefined); // other day
  assert.equal(findClash(list, 's1', TUE, '10:00', '12:00', 'a'), undefined); // editing itself
});

test('approvedLeaveOn: only approved rows, inclusive date range', () => {
  const leave = [
    { staffId: 's1', status: 'approved', type: 'holiday', startDate: '2026-07-13', endDate: '2026-07-15' },
    { staffId: 's1', status: 'pending', type: 'holiday', startDate: '2026-07-20', endDate: '2026-07-21' },
  ];
  assert.ok(approvedLeaveOn(leave, 's1', TUE));
  assert.ok(approvedLeaveOn(leave, 's1', '2026-07-15'));       // end date inclusive
  assert.equal(approvedLeaveOn(leave, 's1', '2026-07-16'), null);
  assert.equal(approvedLeaveOn(leave, 's1', '2026-07-20'), null); // pending doesn't count
  assert.equal(approvedLeaveOn(leave, 's2', TUE), null);
});

test('availabilityOn reads the weekday state, defaulting to available', () => {
  const avail = [{ staffId: 's1', perDay: [{ day: 1, state: 'unavailable' }, { day: 2, state: 'preferred' }] }];
  assert.equal(availabilityOn(avail, 's1', TUE), 'unavailable');          // Tue
  assert.equal(availabilityOn(avail, 's1', '2026-07-15'), 'preferred');   // Wed
  assert.equal(availabilityOn(avail, 's1', '2026-07-16'), 'available');   // no entry
  assert.equal(availabilityOn([], 's1', TUE), 'available');
});

test('clashWarnings: holiday + unavailable produce short first-name messages', () => {
  const timeOff = [{ staffId: 's1', status: 'approved', type: 'holiday', startDate: TUE, endDate: TUE }];
  const availability = [{ staffId: 's1', perDay: [{ day: 1, state: 'unavailable' }] }];
  const w = clashWarnings({ staffName: 'Jane Smith', staffId: 's1', dateIso: TUE, timeOff, availability });
  assert.deepEqual(w, ['Jane is on holiday that day', 'Jane is marked unavailable on Tuesdays']);
  assert.deepEqual(clashWarnings({ staffName: 'Jane Smith', staffId: 's1', dateIso: '2026-07-16', timeOff, availability }), []);
});
