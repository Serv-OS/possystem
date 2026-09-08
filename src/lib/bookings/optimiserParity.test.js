/**
 * optimiserParity.test.js — the edge-fn copy of the optimiser
 * (supabase/functions/_shared/bookingOptimiser.js) must never drift from the
 * source (src/lib/bookings/optimiser.js). The widget quotes availability with
 * the copy; the host stand quotes with the source — if they disagree, a guest
 * can book a table the host stand would never have offered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as src from './optimiser.js';
import * as copy from '../../../supabase/functions/_shared/bookingOptimiser.js';

const T = (id, covers, section = 'main') => ({ id, label: id.toUpperCase(), covers, section });
const VENUE = [T('t1', 2), T('t2', 2), T('t3', 4), T('t8', 8), T('b1', 1, 'bar'), T('b2', 1, 'bar')];
const GROUPS = [
  { id: 'win', tableIds: ['t1', 't2', 't3'] },
  { id: 'big', tableIds: ['t8'] },
  { id: 'bar', tableIds: ['b1', 'b2'], kind: 'bar' },
];
const BOOKINGS = [
  { id: 'a', tables: ['t3'], startMin: src.toMin('19:00'), turnMinutes: 105, status: 'confirmed', covers: 4 },
  { id: 'b', tables: ['t1'], startMin: src.toMin('18:00'), turnMinutes: 60, status: 'dining', covers: 2 },
];

test('PARITY: suggestTables identical between source and edge copy', () => {
  for (const party of [1, 2, 4, 5, 8]) {
    for (const time of ['18:30', '19:00', '20:45']) {
      const args = { party, time, tables: VENUE, bookings: BOOKINGS, joinGroups: GROUPS, limit: 10 };
      assert.deepEqual(copy.suggestTables(args), src.suggestTables(args), `party ${party} @ ${time}`);
    }
  }
});

test('PARITY: paceAt, turnFor, isTableFree identical', () => {
  assert.equal(copy.paceAt(src.toMin('19:00'), BOOKINGS), src.paceAt(src.toMin('19:00'), BOOKINGS));
  for (const p of [1, 3, 5, 9]) assert.equal(copy.turnFor(p), src.turnFor(p));
  assert.equal(
    copy.isTableFree('t3', src.toMin('19:30'), src.toMin('21:00'), BOOKINGS),
    src.isTableFree('t3', src.toMin('19:30'), src.toMin('21:00'), BOOKINGS),
  );
});

test('PARITY: weights and defaults identical', () => {
  assert.deepEqual(copy.WEIGHTS, src.WEIGHTS);
  assert.deepEqual(copy.DEFAULT_TURN_BANDS, src.DEFAULT_TURN_BANDS);
  assert.deepEqual(copy.DEFAULT_RULES, src.DEFAULT_RULES);
});
