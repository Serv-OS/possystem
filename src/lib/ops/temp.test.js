/**
 * temp.test.js — the Operations temperature & scheduling engine.
 * Run: `npm test` (Node's built-in runner). Covers the brief's required cases:
 * out-of-range, missed-check, escalation, and °C/°F conversion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cToF, fToC, displayTemp, toStoredC, inRange, breach, breachSeverity, autoRaises,
  hhmmToMin, runsOnDay, windowStatus, summarize, escalationStepsDue, typeDefault,
} from './temp.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('°C/°F conversion round-trips and displays', () => {
  near(cToF(0), 32); near(cToF(100), 212); near(cToF(-18), -0.4);
  near(fToC(32), 0); near(fToC(cToF(5.8)), 5.8);
  assert.deepEqual(displayTemp(5, 'C'), { value: 5, unit: 'C', label: '5°C' });
  assert.equal(displayTemp(5, 'F').label, '41°F');
  assert.equal(displayTemp(null, 'F').label, '—');
});

test('toStoredC reads operator input back to °C', () => {
  near(toStoredC('5', 'C'), 5);
  near(toStoredC('41', 'F'), 5);
  assert.equal(toStoredC('', 'C'), null);
});

test('inRange honours bounds and open ends', () => {
  assert.equal(inRange(3, 1, 5), true);
  assert.equal(inRange(5.8, 1, 5), false);   // the hero breach
  assert.equal(inRange(1, 1, 5), true);       // inclusive
  assert.equal(inRange(-20, null, -18), true); // open lower bound (freezer)
  assert.equal(inRange(NaN, 1, 5), false);
});

test('breach reports direction and how far out', () => {
  assert.deepEqual(breach(5.8, 1, 5), { inRange: false, direction: 'over', deltaC: 0.8 });
  assert.deepEqual(breach(-12, -25, -18), { inRange: false, direction: 'over', deltaC: 6 }); // warmer than max
  assert.deepEqual(breach(0.5, 1, 5), { inRange: false, direction: 'under', deltaC: 0.5 });
  assert.equal(breach(3, 1, 5).inRange, true);
});

test('breachSeverity + autoRaises: minor stays manual, major/critical auto-raise', () => {
  assert.equal(breachSeverity(5.8, 'fridge', 1, 5), 'minor');     // 0.8° over → minor
  assert.equal(autoRaises('minor'), false);
  assert.equal(breachSeverity(8, 'fridge', 1, 5), 'major');       // 3° over → major
  assert.equal(autoRaises('major'), true);
  assert.equal(breachSeverity(-10, 'freezer', -25, -18), 'critical'); // food thawing
  assert.equal(breachSeverity(55, 'hot_hold', 63, 90), 'critical');   // danger zone
  assert.equal(breachSeverity(3, 'fridge', 1, 5), 'none');
});

test('schedule helpers: hhmm + day matching', () => {
  assert.equal(hhmmToMin('06:00'), 360);
  assert.equal(hhmmToMin('18:30'), 1110);
  assert.equal(hhmmToMin('25:00'), null);
  assert.equal(runsOnDay([], '2026-06-22'), true);                 // every day
  const monday = new Date('2026-06-22T09:00:00'); // 2026-06-22 is a Monday (getDay()=1)
  assert.equal(runsOnDay([1, 3, 5], monday), true);
  assert.equal(runsOnDay([0, 6], monday), false);
});

test('windowStatus: done / upcoming / due / missed', () => {
  assert.equal(windowStatus({ windowMin: 360, graceMin: 60, nowMin: 800, satisfied: true }), 'done');
  assert.equal(windowStatus({ windowMin: 1080, graceMin: 60, nowMin: 600, satisfied: false }), 'upcoming'); // 18:00 win, 10:00 now
  assert.equal(windowStatus({ windowMin: 360, graceMin: 60, nowMin: 400, satisfied: false }), 'due');       // within grace
  assert.equal(windowStatus({ windowMin: 360, graceMin: 60, nowMin: 500, satisfied: false }), 'missed');    // past grace
});

test('summarize: compliance % and headline state', () => {
  const s = summarize(['done', 'done', 'due', 'missed', 'upcoming']);
  assert.equal(s.done, 2); assert.equal(s.due, 1); assert.equal(s.missed, 1); assert.equal(s.upcoming, 1);
  assert.equal(s.compliancePct, Math.round((2 / 4) * 100)); // upcoming excluded from required
  assert.equal(s.state, 'over');  // any missed → coral
  assert.equal(summarize(['done', 'due']).state, 'due');
  assert.equal(summarize(['done', 'done']).state, 'done');
  assert.equal(summarize([]).compliancePct, 100);
});

test('escalation ladder: steps fire over time, ack stops it', () => {
  const L = [0, 15, 30];
  assert.equal(escalationStepsDue({ createdAtMin: 100, nowMin: 100, acknowledged: false, ladder: L }), 1); // immediate
  assert.equal(escalationStepsDue({ createdAtMin: 100, nowMin: 118, acknowledged: false, ladder: L }), 2); // +18m
  assert.equal(escalationStepsDue({ createdAtMin: 100, nowMin: 140, acknowledged: false, ladder: L }), 3); // +40m
  assert.equal(escalationStepsDue({ createdAtMin: 100, nowMin: 140, acknowledged: true, ladder: L }), 0);  // acked → none
});

test('typeDefault carries FSA guidance', () => {
  assert.equal(typeDefault('freezer').max, -18);
  assert.ok(typeDefault('hot_hold').guidance.includes('63'));
});
