/**
 * optimiser.test.js — the table-combination engine, tested against the nine
 * cases in the handoff's OPTIMISER.md test table plus interval/pacing edges.
 * Run: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  suggestTables, isTableFree, paceAt, turnFor, bandLabel,
  toMin, toHM, toOptimiserBooking, WEIGHTS, DEFAULT_TURN_BANDS,
} from './optimiser.js';

// A small venue: a window run of 2-tops, one 4-top, one 8-top, a bar run.
const T = (id, covers, section = 'main') => ({ id, label: id.toUpperCase(), covers, section });
const VENUE = [
  T('t1', 2), T('t2', 2), T('t3', 2),      // win run — consecutive 2-tops
  T('t4', 4),                               // a real 4-top
  T('t8', 8),                               // the big table
  T('b1', 1, 'bar'), T('b2', 1, 'bar'),     // stools
];
const GROUPS = [
  { id: 'win', label: 'Window', tableIds: ['t1', 't2', 't3'] },
  { id: 'four', label: 'Mid', tableIds: ['t4'] },
  { id: 'big', label: 'Back', tableIds: ['t8'] },
  { id: 'bar', label: 'Bar', tableIds: ['b1', 'b2'], kind: 'bar' },
];
const bk = (id, tables, start, turn, status = 'confirmed', covers = 2) =>
  ({ id, tables, startMin: toMin(start), turnMinutes: turn, status, covers });
const ask = (over = {}) => suggestTables({ party: 4, time: '19:00', tables: VENUE, joinGroups: GROUPS, ...over });

test('exact single: a free 4-top wins with waste 0 and no join', () => {
  const [best] = ask({ party: 4 });
  assert.deepEqual(best.set, ['t4']);
  assert.equal(best.waste, 0);
  assert.equal(best.n, 1);
  assert.equal(best.reasons[0], 'Exact fit — no seat left empty');
});

test('THE headline: two 2-tops join when no 4-top is free', () => {
  const bookings = [bk('x', ['t4'], '19:00', 105)];
  const [best] = ask({ party: 4, bookings });
  assert.equal(best.n, 2);
  assert.equal(best.cap, 4);
  assert.ok(best.reasons.some(r => r.startsWith('Joins ')));
});

test('protection ON: the 8-top scores +10 and ranks below the join', () => {
  // Tolerance 4 so the 8-top (waste 4) is a legal candidate at all — the point
  // of this case is the +10 ORDERING, not the tolerance filter.
  const bookings = [bk('x', ['t4'], '19:00', 105)];
  const out = ask({ party: 4, bookings, limit: 10, rules: { maxJoin: 3, tolerance: 4, protectLargeTables: true } });
  const big = out.find(c => c.set[0] === 't8');
  const join = out.find(c => c.n === 2);
  assert.ok(big && join);
  assert.ok(big.score > join.score, '8-top must rank below the 2-top join');
  assert.ok(big.reasons.some(r => r.includes('held back')));
});

test('protection OFF: the 8-top ranks on waste alone', () => {
  const bookings = [bk('x', ['t4'], '19:00', 105)];
  const out = ask({ party: 4, bookings, rules: { maxJoin: 3, tolerance: 4, protectLargeTables: false } });
  const big = out.find(c => c.set[0] === 't8');
  assert.ok(big);
  assert.equal(big.score, 4 * WEIGHTS.WASTE); // waste 4, no penalty
  assert.ok(!big.reasons.some(r => r.includes('held back')));
});

test('tolerance 0: nothing from a 6+ top for a 5; joins only when exactly 5', () => {
  const venue = [T('a', 3), T('b', 2), T('six', 6)];
  const groups = [{ id: 'run', tableIds: ['a', 'b'] }, { id: 's', tableIds: ['six'] }];
  const out = suggestTables({ party: 5, time: '19:00', tables: venue, joinGroups: groups, rules: { maxJoin: 3, tolerance: 0, protectLargeTables: true } });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].set, ['a', 'b']); // 3+2 = exactly 5; the 6-top wastes 1 > 0
});

test('maxJoin 1: joins disappear; only single tables ≥ party', () => {
  const out = ask({ party: 6, rules: { maxJoin: 1, tolerance: 2, protectLargeTables: true } });
  assert.ok(out.length > 0);
  assert.ok(out.every(c => c.n === 1 && c.cap >= 6));
});

test('non-adjacent members are never offered', () => {
  // t2 busy: t1+t3 are not consecutive once t2 is unavailable — no 3-table slice
  // can skip over it, and [t1,t3] is not a slice of the group at all.
  const bookings = [bk('x', ['t2'], '19:00', 105), bk('y', ['t4'], '19:00', 105)];
  const out = ask({ party: 4, bookings, rules: { maxJoin: 3, tolerance: 2, protectLargeTables: false } });
  assert.ok(!out.some(c => c.set.includes('t1') && c.set.includes('t3')), 't1+t3 must never appear');
});

test('fully booked returns an empty list', () => {
  const bookings = VENUE.map((t, i) => bk(`b${i}`, [t.id], '17:00', 6 * 60));
  assert.deepEqual(ask({ party: 2, bookings }), []);
});

test('bar overflow: the stool pair ranks below any real table for a party of 2', () => {
  const out = ask({ party: 2, rules: { maxJoin: 3, tolerance: 0, protectLargeTables: true } });
  const bar = out.find(c => c.set[0] === 'b1');
  const real = out.find(c => c.set[0] === 't1');
  assert.ok(real, 'a real 2-top is offered');
  if (bar) assert.ok(bar.score > real.score, 'bar pair must rank below');
});

test('every candidate carries the downstream-cost reason', () => {
  const out = ask({ party: 2 });
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.ok(c.reasons.at(-1).includes('free at 19:00'), 'last reason states what is left for walk-ins');
  }
});

test('isTableFree: half-open — a booking ending exactly at the start does not conflict', () => {
  const bookings = [bk('x', ['t1'], '18:00', 60)]; // 18:00–19:00
  assert.equal(isTableFree('t1', toMin('19:00'), toMin('20:00'), bookings), true);
  assert.equal(isTableFree('t1', toMin('18:59'), toMin('20:00'), bookings), false);
  assert.equal(isTableFree('t1', toMin('17:00'), toMin('18:01'), bookings), false);
});

test('isTableFree: departed/cancelled/no_show never block; skipId ignores own footprint', () => {
  const bookings = [
    bk('gone', ['t1'], '19:00', 90, 'departed'),
    bk('cx', ['t1'], '19:00', 90, 'cancelled'),
    bk('me', ['t1'], '19:00', 90, 'confirmed'),
  ];
  assert.equal(isTableFree('t1', toMin('19:00'), toMin('20:00'), bookings), false);
  assert.equal(isTableFree('t1', toMin('19:00'), toMin('20:00'), bookings, { skipId: 'me' }), true);
});

test('paceAt: covers within ±7 minutes inclusive, dead bookings excluded', () => {
  const bookings = [
    bk('a', ['t1'], '19:00', 90, 'confirmed', 4),
    bk('b', ['t2'], '19:07', 90, 'confirmed', 2),   // inclusive edge
    bk('c', ['t3'], '19:08', 90, 'confirmed', 6),   // outside
    bk('d', ['t4'], '18:53', 90, 'cancelled', 8),   // dead
  ];
  assert.equal(paceAt(toMin('19:00'), bookings), 6);
});

test('turn bands and the package override', () => {
  assert.equal(bandLabel(2), '1-2');
  assert.equal(turnFor(2), 90);
  assert.equal(turnFor(4), 105);
  assert.equal(turnFor(6), 120);
  assert.equal(turnFor(9), 150);
  // A package turn overrides the band entirely.
  const [best] = ask({ party: 2, turnMinutes: 240, bookings: [bk('x', ['t1'], '21:30', 60)] });
  assert.ok(!best.set.includes('t1'), '240-min window must collide with the 21:30 booking on t1');
});

test('toOptimiserBooking normalises store rows', () => {
  const b = toOptimiserBooking({ id: 'b1', startTime: '19:15:00', turnMinutes: 105, covers: 4, status: 'confirmed', tables: ['t1', 't2'] });
  assert.equal(b.startMin, toMin('19:15'));
  assert.equal(b.turnMinutes, 105);
  const solo = toOptimiserBooking({ id: 'b2', start: '18:00', turn: 90, primaryTableId: 't9' });
  assert.deepEqual(solo.tables, ['t9']);
});

test('time helpers round-trip', () => {
  assert.equal(toMin('19:15'), 1155);
  assert.equal(toHM(1155), '19:15');
  assert.equal(toHM(toMin('09:05')), '09:05');
});
