/** timesheets.test.js — Manager approvals anomaly flags. Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timesheetAnomalies, timesheetWorkedMins } from './timesheets.js';

const NOW = 1_800_000_000_000;
const min = (n) => NOW - n * 60000;

test('worked mins = span minus break', () => {
  assert.equal(timesheetWorkedMins({ inMs: min(180), outMs: min(0), breakMins: 30 }, NOW), 150);
});
test('clean shift → no flags', () => {
  assert.deepEqual(timesheetAnomalies({ inMs: min(300), outMs: min(0), breakMins: 30, scheduledMins: 270 }, {}, NOW), []);
});
test('clock_out_missing when not clocked out', () => {
  assert.ok(timesheetAnomalies({ inMs: min(60), outMs: null, breakMins: 0 }, {}, NOW).includes('clock_out_missing'));
});
test('short_break when the statutory minimum was not reached', () => {
  // 7h on shift, no break at all — 20 minutes were due.
  assert.ok(timesheetAnomalies({ inMs: min(420), outMs: min(0), breakMins: 0 }, {}, NOW).includes('short_break'));
});
test('short_break catches a PARTIAL break, which the old zero-break rule missed', () => {
  // v5.5.990: 5 minutes on a 10-hour shift used to raise nothing at all.
  assert.ok(timesheetAnomalies({ inMs: min(600), outMs: min(0), breakMins: 5 }, {}, NOW).includes('short_break'));
});
test('short_break does not fire when the break was long enough', () => {
  assert.equal(timesheetAnomalies({ inMs: min(420), outMs: min(0), breakMins: 20 }, {}, NOW).includes('short_break'), false);
});
test('short_break fires against the ROSTERED break even when the law is satisfied', () => {
  // 7h, rostered 45, took the legal 20. Lawful, but 25 short of the plan.
  const f = timesheetAnomalies({ inMs: min(420), outMs: min(0), breakMins: 20, plannedBreakMins: 45 }, {}, NOW);
  assert.ok(f.includes('short_break'));
});
test('overtime when worked exceeds scheduled + buffer', () => {
  assert.ok(timesheetAnomalies({ inMs: min(300), outMs: min(0), breakMins: 0, scheduledMins: 240 }, {}, NOW).includes('overtime'));
});
test('edited flag passes through', () => {
  assert.ok(timesheetAnomalies({ inMs: min(60), outMs: min(0), breakMins: 0, edited: true }, {}, NOW).includes('edited'));
});
