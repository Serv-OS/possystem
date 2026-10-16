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

// 16 Oct 2026: solo tables (no join group) and the party-aware pacing check.
test('PARITY: solo tables and no join groups identical', () => {
  const venue = [...VENUE, T('solo6', 6), T('solo2', 2)];
  for (const party of [1, 2, 5, 6]) {
    for (const joinGroups of [GROUPS, []]) {
      const args = { party, time: '19:00', tables: venue, bookings: BOOKINGS, joinGroups, limit: 20 };
      assert.deepEqual(copy.suggestTables(args), src.suggestTables(args), `party ${party} groups ${joinGroups.length}`);
    }
  }
});

test('PARITY: paceFull identical', () => {
  for (const [l, p, c] of [[10, 2, 12], [10, 3, 12], [0, 0, 0], [5, 8, 12]]) {
    assert.equal(copy.paceFull(l, p, c), src.paceFull(l, p, c));
  }
});

// 16 Oct 2026: service periods and booking rules. The widget sells from the copy's slot grid and
// the stand from the source's, so they must agree on every day and every refusal.
test('PARITY: service periods, slots, refusals and the diary greying identical', () => {
  const rules = {
    servicePeriods: [
      { id: 'l', name: 'Lunch', days: [2, 3, 4, 5, 6, 7], start: '12:00', end: '15:00', lastSeating: '13:30' },
      { id: 'd', name: 'Dinner', days: [5, 6], start: '18:00', end: '01:00', lastSeating: '00:15' },
    ],
    closedWeekdays: [1],
    dateBlocks: [
      { id: 'x', from: '2026-12-24', to: '2026-12-26', label: 'Christmas' },
      { id: 'p', from: '2026-10-17', label: 'Private hire', start: '18:00', end: '21:00' },
      { id: 'o', from: '2026-10-22', to: '2026-10-22', label: 'Walk ins only', onlineOnly: true },
    ],
    blockedDates: ['2026-10-23'],
    minNoticeMinutes: 60,
    widgetMaxDaysAhead: 60,
    slotMinutes: 15,
  };
  const now = { ymd: '2026-10-16', nowMinutes: 12 * 60 };
  for (let i = -1; i < 72; i++) {
    const d = src.addDaysISO('2026-10-16', i);
    for (const online of [false, true]) {
      assert.deepEqual(copy.serviceSlots(rules, d, { online }), src.serviceSlots(rules, d, { online }), `slots ${d} ${online}`);
      assert.deepEqual(copy.serviceWindows(rules, d, { online }), src.serviceWindows(rules, d, { online }), `windows ${d}`);
      for (const t of ['00:00', '00:15', '11:45', '12:00', '13:30', '13:45', '16:00', '18:00', '19:30', '23:45']) {
        assert.deepEqual(copy.bookingTimeRefusal(rules, d, t, { online, now }), src.bookingTimeRefusal(rules, d, t, { online, now }), `${d} ${t} ${online}`);
      }
    }
    assert.deepEqual(copy.closedRanges(rules, d, 0, 1440), src.closedRanges(rules, d, 0, 1440));
    assert.deepEqual(copy.diaryRange(rules, d), src.diaryRange(rules, d));
    assert.equal(copy.dayNotice(rules, d), src.dayNotice(rules, d));
  }
});
