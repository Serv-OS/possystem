/** team.test.js — Manager Team live (on-shift / no-show / break-due / labour). Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onShiftNow, noShows, breaksDue, liveLabourMinor } from './team.js';

const NOW = 1_800_000_000_000;
const min = (n) => NOW - n * 60000;

test('onShiftNow = open punches', () => {
  const r = onShiftNow([{ staffId: 'a', inMs: min(120) }, { staffId: 'b', inMs: min(60), outMs: min(5) }], NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].staffId, 'a');
  assert.equal(r[0].onForMins, 120);
});
test('no-show: scheduled start past grace + never clocked in', () => {
  const shifts = [{ staffId: 'x', name: 'X', role: 'Bar', startMs: min(30), endMs: min(-180) }];
  assert.equal(noShows(shifts, [], {}, NOW).length, 1);
  // clocked in → not a no-show
  assert.equal(noShows(shifts, [{ staffId: 'x', inMs: min(25) }], {}, NOW).length, 0);
  // within grace → not yet a no-show
  assert.equal(noShows([{ staffId: 'y', startMs: min(5), endMs: min(-180) }], [], {}, NOW).length, 0);
});
test('break-due: open punch worked past threshold, no break logged', () => {
  const r = breaksDue([{ staffId: 'a', inMs: min(420), breakMins: 0, breakOpen: false }], {}, NOW);
  assert.equal(r.length, 1);
  // already took a break → not due
  assert.equal(breaksDue([{ staffId: 'a', inMs: min(420), breakMins: 30 }], {}, NOW).length, 0);
  // under threshold → not due
  assert.equal(breaksDue([{ staffId: 'a', inMs: min(120), breakMins: 0 }], {}, NOW).length, 0);
});
test('liveLabourMinor: pennies, pro-rata, minus break', () => {
  // 2h worked at £12/h (1200p) = £24 = 2400p
  const r = liveLabourMinor([{ staffId: 'a', inMs: min(150), breakMins: 30 }], { a: 1200 }, NOW);
  assert.equal(r, 2400);
});
