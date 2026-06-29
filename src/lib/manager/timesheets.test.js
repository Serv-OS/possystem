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
test('no_break when worked past threshold with zero break', () => {
  assert.ok(timesheetAnomalies({ inMs: min(420), outMs: min(0), breakMins: 0 }, {}, NOW).includes('no_break'));
});
test('overtime when worked exceeds scheduled + buffer', () => {
  assert.ok(timesheetAnomalies({ inMs: min(300), outMs: min(0), breakMins: 0, scheduledMins: 240 }, {}, NOW).includes('overtime'));
});
test('edited flag passes through', () => {
  assert.ok(timesheetAnomalies({ inMs: min(60), outMs: min(0), breakMins: 0, edited: true }, {}, NOW).includes('edited'));
});
