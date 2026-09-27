/** team.test.js — Manager Team live (on-shift / no-show / break-due / labour). Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onShiftNow, noShows, breaksDue, liveLabourMinor, canClockOut } from './team.js';
import { roleFlags } from './access.js';

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

// v5.10.2: Clock out on the Team tab. The punch carries its timesheet id (manager-snapshot from
// v5.10.2), and only people manager-approve lets clock someone out see the button.
test('onShiftNow carries the timesheet id; a punch without one has none', () => {
  const r = onShiftNow([{ id: 'ts-1', staffId: 'a', inMs: min(90) }, { staffId: 'b', inMs: min(30) }], NOW);
  assert.equal(r[0].id, 'ts-1');
  assert.equal(r[1].id, null);
});
test('canClockOut: needs the timesheet id AND approval rights (Manager, Owner, manager_approvals)', () => {
  const row = { id: 'ts-1', staffId: 'a' };
  assert.equal(canClockOut(row, roleFlags('manager')), true);
  assert.equal(canClockOut(row, roleFlags('Owner')), true);
  assert.equal(canClockOut(row, roleFlags('supervisor')), false);
  assert.equal(canClockOut(row, roleFlags('supervisor', ['manager_approvals'])), true);
  assert.equal(canClockOut(row, roleFlags('staff')), false);
  // Before v5.10.2 every punch came without an id: no button, whoever is signed in.
  assert.equal(canClockOut({ id: null, staffId: 'a' }, roleFlags('manager')), false);
  assert.equal(canClockOut(row, undefined), false);
});
