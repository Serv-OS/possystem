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
test('break-due: open punch past the statutory threshold with no break', () => {
  const r = breaksDue([{ staffId: 'a', inMs: min(420), breakMins: 0, breakOpen: false }], {}, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].owedMins, 20);
  // already took enough → not due
  assert.equal(breaksDue([{ staffId: 'a', inMs: min(420), breakMins: 30 }], {}, NOW).length, 0);
  // under threshold → not due
  assert.equal(breaksDue([{ staffId: 'a', inMs: min(120), breakMins: 0 }], {}, NOW).length, 0);
});
test('break-due: a PARTIAL break still leaves them owed the difference', () => {
  // v5.5.990: the old rule required breakMins === 0, so 5 minutes at hour two
  // meant this person never appeared however long they then worked.
  const r = breaksDue([{ staffId: 'a', inMs: min(600), breakMins: 5, breakOpen: false }], {}, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].owedMins, 15);
});
test('break-due: someone currently ON a break is not chased', () => {
  assert.equal(breaksDue([{ staffId: 'a', inMs: min(420), breakMins: 0, breakOpen: true }], {}, NOW).length, 0);
});
test('liveLabourMinor: pennies, pro-rata, minus break', () => {
  // 2h worked at £12/h (1200p) = £24 = 2400p
  const r = liveLabourMinor([{ staffId: 'a', inMs: min(150), breakMins: 30 }], { a: 1200 }, NOW);
  assert.equal(r, 2400);
});
