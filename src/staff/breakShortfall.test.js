/**
 * breakShortfall.test.js — the shared "was the break shorter than expected"
 * rule. Run: `npm test` (Node's built-in runner).
 *
 * Before v5.5.990 there were THREE different answers to "was that break long
 * enough": the Back Office compared against the WTR minimum using NET hours,
 * the clock-out function inlined the same rule against GROSS hours, and the
 * Manager app hardcoded 360 minutes and ignored age entirely. None of them
 * compared against what the shift was actually ROSTERED with, so "took 10
 * minutes of a planned 30" was invisible everywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { breakShortfall, venueBreakPolicy, DEFAULT_BREAK_MINS } from './breaks.js';

const policy30 = venueBreakPolicy({ defaultBreakMins: 30, autoBreakHours: 6 });

// A dob that is comfortably an adult / comfortably under 18, relative to now.
const y = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
const ADULT = y(30);
const MINOR = y(16);

test('a full break against plan and law is clean', () => {
  const r = breakShortfall({ grossHours: 8, breakMins: 30, plannedBreakMins: 30, policy: policy30 });
  assert.equal(r.level, 'none');
  assert.equal(r.shortStatutory, 0);
  assert.equal(r.shortExpected, 0);
});

test('short against the ROSTERED break but still legal is a policy flag, not a legal one', () => {
  // Rostered 30, took 25, worked 8h. WTR wants 20 and they had 25, so lawful.
  const r = breakShortfall({ grossHours: 8, breakMins: 25, plannedBreakMins: 30, policy: policy30 });
  assert.equal(r.level, 'policy');
  assert.equal(r.shortExpected, 5);
  assert.equal(r.shortStatutory, 0);
  assert.equal(r.expected, 30);
  assert.equal(r.expectedFrom, 'shift');
});

test('short against the law reports as statutory even though it is also short of plan', () => {
  const r = breakShortfall({ grossHours: 8, breakMins: 10, plannedBreakMins: 30, policy: policy30 });
  assert.equal(r.level, 'statutory');
  assert.equal(r.shortStatutory, 10);   // 20 due, took 10
  assert.equal(r.shortExpected, 20);    // 30 planned, took 10
});

test('the 5-minute break that used to defeat every check is now caught', () => {
  // Clock-out auto-deduct only fires on breakMins === 0, and the Manager app
  // only warned on "no break logged". Five minutes slipped through both.
  const r = breakShortfall({ grossHours: 10, breakMins: 5, plannedBreakMins: 30, policy: policy30 });
  assert.equal(r.level, 'statutory');
  assert.equal(r.shortStatutory, 15);
  assert.equal(r.shortExpected, 25);
});

test('no rostered break falls back to the venue default, but only on a long enough shift', () => {
  const long = breakShortfall({ grossHours: 8, breakMins: 0, policy: policy30 });
  assert.equal(long.expected, 30);
  assert.equal(long.expectedFrom, 'venue');
  assert.equal(long.level, 'statutory');   // 20 due as well

  const short = breakShortfall({ grossHours: 4, breakMins: 0, policy: policy30 });
  assert.equal(short.expected, 0);          // below the 6h threshold, none expected
  assert.equal(short.expectedFrom, 'none');
  assert.equal(short.level, 'none');
});

test('a shift deliberately rostered with no break is not flagged for policy', () => {
  // Planned 0 on a 4-hour shift is a real choice, not an omission.
  const r = breakShortfall({ grossHours: 4, breakMins: 0, plannedBreakMins: 0, policy: policy30 });
  assert.equal(r.level, 'none');
  assert.equal(r.expected, 0);
});

test('a shift rostered with no break that runs long is still caught by the law', () => {
  const r = breakShortfall({ grossHours: 9, breakMins: 0, plannedBreakMins: 0, policy: policy30 });
  assert.equal(r.level, 'statutory');
  assert.equal(r.shortStatutory, 20);
  assert.equal(r.shortExpected, 0);   // they got exactly what was rostered
});

test('under-18s get the 30-minute rule at 4.5 hours when a dob is on file', () => {
  const minor = breakShortfall({ grossHours: 5, breakMins: 0, dob: MINOR, policy: policy30 });
  assert.equal(minor.statutory, 30);
  assert.equal(minor.level, 'statutory');

  const adult = breakShortfall({ grossHours: 5, breakMins: 0, dob: ADULT, policy: policy30 });
  assert.equal(adult.statutory, 0);   // adults only owe a break over 6h
});

test('a missing dob falls back to the adult rule — the known blind spot', () => {
  // Auto-created staff records carry no dob, so an under-18 reads as an adult.
  // Locked in deliberately so the limitation is visible rather than assumed away.
  const r = breakShortfall({ grossHours: 5, breakMins: 0, dob: null, policy: policy30 });
  assert.equal(r.statutory, 0);
});

test('GROSS hours drive the legal test, not net worked hours', () => {
  // 6h15m on shift, 20-minute break => 5h55m worked. The old Back Office code
  // passed the NET 5.92 and reported nothing due; the clock passed GROSS 6.25
  // and reported 20 due. Gross is the WTR basis, so 20 is correct.
  // Rostered at 20 too, so the policy side is satisfied and this isolates the
  // statutory question.
  const r = breakShortfall({ grossHours: 6.25, breakMins: 20, plannedBreakMins: 20, policy: policy30 });
  assert.equal(r.statutory, 20);
  assert.equal(r.shortStatutory, 0);
  assert.equal(r.level, 'none');

  const stingy = breakShortfall({ grossHours: 6.25, breakMins: 10, plannedBreakMins: 20, policy: policy30 });
  assert.equal(stingy.shortStatutory, 10);
});

test('meeting the law but missing the venue default is still a policy flag', () => {
  // 6h15m, venue policy is 30 over 6h, they took the legal 20. Lawful, but
  // 10 minutes short of what this venue expects — which is exactly the case
  // nothing in the product surfaced before v5.5.990.
  const r = breakShortfall({ grossHours: 6.25, breakMins: 20, policy: policy30 });
  assert.equal(r.shortStatutory, 0);
  assert.equal(r.expected, 30);
  assert.equal(r.expectedFrom, 'venue');
  assert.equal(r.shortExpected, 10);
  assert.equal(r.level, 'policy');
});

test('an over-long break is never a shortfall', () => {
  const r = breakShortfall({ grossHours: 8, breakMins: 45, plannedBreakMins: 30, policy: policy30 });
  assert.equal(r.level, 'none');
  assert.equal(r.shortExpected, 0);
});

test('venueBreakPolicy: unset venue lands on the shared fallback, and says so', () => {
  const unset = venueBreakPolicy({});
  assert.equal(unset.defaultMins, DEFAULT_BREAK_MINS);
  assert.equal(unset.thresholdHrs, 6);
  assert.equal(unset.isSet, false);      // lets the UI say "not configured"
  assert.equal(unset.autoDeduct, false);
  assert.equal(unset.paid, false);

  const set = venueBreakPolicy({ defaultBreakMins: 20, autoBreakHours: 5, autoBreak: true, paidBreaks: true });
  assert.equal(set.defaultMins, 20);
  assert.equal(set.thresholdHrs, 5);
  assert.equal(set.isSet, true);
  assert.equal(set.autoDeduct, true);
  assert.equal(set.paid, true);
});

test('venueBreakPolicy: an explicit zero default is honoured, not treated as unset', () => {
  const zero = venueBreakPolicy({ defaultBreakMins: 0 });
  assert.equal(zero.defaultMins, 0);
  assert.equal(zero.isSet, true);
  // …and therefore expects nothing, even on a long shift.
  assert.equal(breakShortfall({ grossHours: 10, breakMins: 0, policy: zero }).shortExpected, 0);
});

test('missing everything degrades to zero rather than throwing', () => {
  const r = breakShortfall();
  assert.equal(r.level, 'none');
  assert.equal(r.statutory, 0);
  assert.equal(r.expected, 0);
});
