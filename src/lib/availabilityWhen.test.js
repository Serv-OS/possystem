// src/lib/availabilityWhen.test.js (5.12.61): availability changes apply from the next rota period.
// node --test src/lib/availabilityWhen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityInEffect, pendingAvailability, availabilityChangesFrom, changesFromWords, availabilityRowsOf } from '../../supabase/functions/_shared/availabilityWhen.js';

const off = (day) => [{ day, state: 'unavailable' }];
const rows = [
  { id: 'base', staffId: 's1', weekStart: null, perDay: off(0) },
  { id: 'next', staffId: 's1', weekStart: '2026-11-16', perDay: off(1) },
  { id: 'other', staffId: 's2', weekStart: null, perDay: off(5) },
];

test('the row in effect: the base before the change date, the new one from it', () => {
  const mine = availabilityRowsOf(rows, 's1');
  assert.equal(mine.length, 2);
  assert.equal(availabilityInEffect(mine, '2026-11-10')?.id, 'base');
  assert.equal(availabilityInEffect(mine, '2026-11-15')?.id, 'base');
  assert.equal(availabilityInEffect(mine, '2026-11-16')?.id, 'next');
  assert.equal(availabilityInEffect(mine, '2027-03-01')?.id, 'next');
  assert.equal(availabilityInEffect(mine)?.id, 'next');
  assert.equal(availabilityInEffect([], '2026-11-10'), null);
});

test('database rows (staff_id, week_start, per_day) read the same way', () => {
  const db = [{ staff_id: 's1', week_start: null, per_day: off(0) }, { staff_id: 's1', week_start: '2026-11-16', per_day: off(1) }];
  assert.deepEqual(availabilityInEffect(db, '2026-11-20').perDay, off(1));
  assert.deepEqual(availabilityInEffect(db, '2026-11-01').perDay, off(0));
});

test('two base rows: the newer one wins (what the screens showed before)', () => {
  const two = [{ id: 'a', weekStart: null, perDay: off(0), updated_at: '2026-10-01' }, { id: 'b', weekStart: null, perDay: off(2), updated_at: '2026-10-20' }];
  assert.equal(availabilityInEffect(two, '2026-11-01').id, 'b');
});

test('pending rows are the ones after the date, soonest first', () => {
  const mine = availabilityRowsOf(rows, 's1');
  assert.deepEqual(pendingAvailability(mine, '2026-11-10').map((r) => r.id), ['next']);
  assert.deepEqual(pendingAvailability(mine, '2026-11-16'), []);
});

test('changes apply from the week after the later of this week and the last published week', () => {
  // Wednesday 4 Nov 2026, nothing published: next Monday.
  assert.equal(availabilityChangesFrom({ todayYmd: '2026-11-04' }), '2026-11-09');
  // Rota published to Sunday 22 Nov: Monday 23 Nov.
  assert.equal(availabilityChangesFrom({ todayYmd: '2026-11-04', lastPublishedYmd: '2026-11-22' }), '2026-11-23');
  // Published only in the past: still next week, never this one.
  assert.equal(availabilityChangesFrom({ todayYmd: '2026-11-04', lastPublishedYmd: '2026-10-01' }), '2026-11-09');
  // A US venue whose week starts on Sunday.
  assert.equal(availabilityChangesFrom({ todayYmd: '2026-11-04', workweekStart: 0 }), '2026-11-08');
  assert.equal(availabilityChangesFrom({ todayYmd: '2026-11-04', lastPublishedYmd: '2026-11-21', workweekStart: 0 }), '2026-11-22');
  assert.equal(availabilityChangesFrom({ todayYmd: 'soon' }), '');
});

test('the words follow the venue and carry no dashes', () => {
  assert.equal(changesFromWords('2026-11-23', 'GBP'), 'Changes apply from Mon, 23 Nov 2026, the next rota period. Weeks already on the rota keep your current availability.');
  assert.equal(changesFromWords('2026-11-23', { currency: 'USD' }), 'Changes apply from Mon, Nov 23, 2026, the next rota period. Weeks already on the rota keep your current availability.');
  assert.equal(changesFromWords(''), '');
  const dash = new RegExp(String.fromCharCode(0x2013) + '|' + String.fromCharCode(0x2014));
  assert.ok(!dash.test(changesFromWords('2026-11-23', 'USD')));
});
