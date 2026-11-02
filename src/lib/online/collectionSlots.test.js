/**
 * collectionSlots.test.js: the one slot rule the checkout and the menu page share (5.12.34).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionSlots, nextIsoDate } from './collectionSlots.js';

const window = [{ open: '12:00', close: '14:00' }];
const location = { opening_hours: { weekly: { sun: window, mon: window, tue: window, wed: window, thu: window, fri: window, sat: window } } };
const tz = 'Europe/London';
// Mon 2 Nov 2026 11:00 London (GMT in November)
const now = new Date('2026-11-02T11:00:00Z');

test('nextIsoDate steps a calendar day, through month ends', () => {
  assert.equal(nextIsoDate('2026-11-30'), '2026-12-01');
  assert.equal(nextIsoDate('2026-02-28'), '2026-03-01');
});

test('slots start at the first quarter hour after now plus the lead, inside the window, 15 minutes apart', () => {
  const slots = buildCollectionSlots(location, tz, 25, 0, now);
  assert.equal(slots[0].label, '12:00');
  assert.equal(slots[0].day, 'Today');
  assert.equal(slots[1].label, '12:15');
  assert.equal(slots[slots.length - 1].label, '13:45');
  assert.equal(slots.length, 8);
  const late = buildCollectionSlots(location, tz, 70, 0, now);   // 12:10 rounds up to 12:15
  assert.equal(late[0].label, '12:15');
});

test('maxDaysAhead 0 is today only; 1 adds Tomorrow; no opening hours gives []', () => {
  assert.ok(buildCollectionSlots(location, tz, 25, 0, now).every((s) => s.day === 'Today'));
  const two = buildCollectionSlots(location, tz, 25, 1, now);
  assert.ok(two.some((s) => s.day === 'Tomorrow'));
  assert.deepEqual(buildCollectionSlots({}, tz, 25, 1, now), []);
  assert.deepEqual(buildCollectionSlots(null, tz, 25, 1, now), []);
});

test('a window that closes after midnight still yields slots', () => {
  const night = [{ open: '22:00', close: '01:00' }];
  const loc = { opening_hours: { weekly: { sun: night, mon: night, tue: night, wed: night, thu: night, fri: night, sat: night } } };
  const slots = buildCollectionSlots(loc, tz, 10, 0, new Date('2026-11-02T21:00:00Z'));
  assert.equal(slots[0].label, '22:00');
  assert.ok(slots.some((s) => s.label === '00:45'));
});
