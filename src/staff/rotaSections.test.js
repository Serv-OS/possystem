/**
 * rotaSections.test.js — the "By section" rota grid must show EVERY shift the
 * "By staff" view shows. Run: `npm test`.
 *
 * The regression: the grid filtered on `shift.sectionId === section.id`, so a
 * shift with no section assigned appeared nowhere at all. A real week with 12
 * shifts rendered 3, and nothing on screen said the other 9 existed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sectionIdForShift, bucketShiftsBySection, UNASSIGNED } from './rotaSections.js';

const SECTIONS = [
  { id: 'sec-runner', name: 'Runner' },
  { id: 'sec-bar', name: 'Bar' },
  { id: 'sec-kitchen', name: 'Kitchen' },
];
// Chefs are in the 'kitchen' role group, servers in 'floor'.
const groupNameOf = (sh) => ({ chef: 'Kitchen', server: 'Floor', bartender: 'Bar' }[sh.roleKey] || null);

test('an explicit section wins', () => {
  assert.equal(sectionIdForShift({ sectionId: 'sec-bar', roleKey: 'chef' }, SECTIONS, groupNameOf), 'sec-bar');
});

test('a stale section id does not swallow the shift', () => {
  // The section was deleted. Before, `some(x => x.id === …)` failed and the
  // shift matched no row at all; now it falls through to the role group.
  assert.equal(sectionIdForShift({ sectionId: 'sec-deleted', roleKey: 'chef' }, SECTIONS, groupNameOf), 'sec-kitchen');
});

test('no section falls back to a section named after the role group', () => {
  assert.equal(sectionIdForShift({ roleKey: 'chef' }, SECTIONS, groupNameOf), 'sec-kitchen');
  assert.equal(sectionIdForShift({ roleKey: 'bartender' }, SECTIONS, groupNameOf), 'sec-bar');
});

test('a role group with no matching section becomes UNASSIGNED, not invisible', () => {
  // A Server is in the 'Floor' group and this venue has no Floor section.
  assert.equal(sectionIdForShift({ roleKey: 'server' }, SECTIONS, groupNameOf), UNASSIGNED);
});

test('name matching is case-insensitive', () => {
  assert.equal(sectionIdForShift({ roleKey: 'chef' }, [{ id: 's1', name: 'KITCHEN' }], groupNameOf), 's1');
});

test('a venue with no sections at all puts everything in UNASSIGNED', () => {
  assert.equal(sectionIdForShift({ roleKey: 'chef' }, [], groupNameOf), UNASSIGNED);
});

test('THE INVARIANT: every shift lands in exactly one bucket', () => {
  // The real week from the screenshots: Jane (server) 3, Peter (chef) 5,
  // Tom (chef) 4. Twelve shifts, only three of which carry a section.
  const shifts = [
    { id: 1, staffId: 'jane', roleKey: 'server', date: '2026-08-04', start: '09:00' },
    { id: 2, staffId: 'jane', roleKey: 'server', date: '2026-08-05', start: '09:00' },
    { id: 3, staffId: 'jane', roleKey: 'server', date: '2026-08-07', start: '09:00', sectionId: 'sec-runner' },
    { id: 4, staffId: 'peter', roleKey: 'chef', date: '2026-08-04', start: '09:00' },
    { id: 5, staffId: 'peter', roleKey: 'chef', date: '2026-08-05', start: '09:00', sectionId: 'sec-kitchen' },
    { id: 6, staffId: 'peter', roleKey: 'chef', date: '2026-08-06', start: '09:00' },
    { id: 7, staffId: 'peter', roleKey: 'chef', date: '2026-08-07', start: '09:00', sectionId: 'sec-runner' },
    { id: 8, staffId: 'peter', roleKey: 'chef', date: '2026-08-08', start: '12:00' },
    { id: 9, staffId: 'tom', roleKey: 'chef', date: '2026-08-03', start: '12:00' },
    { id: 10, staffId: 'tom', roleKey: 'chef', date: '2026-08-05', start: '09:00' },
    { id: 11, staffId: 'tom', roleKey: 'chef', date: '2026-08-07', start: '12:00' },
    { id: 12, staffId: 'tom', roleKey: 'chef', date: '2026-08-09', start: '12:00' },
  ];
  const { map, unassigned, bucketedCount } = bucketShiftsBySection(shifts, SECTIONS, groupNameOf);

  // Nothing may be dropped. The old grid rendered 3 of these 12.
  assert.equal(bucketedCount, shifts.length);
  // Jane's two unsectioned Server shifts have nowhere else to go.
  assert.equal(unassigned, 2);
  // Chefs without a section land in Kitchen alongside the explicitly-set one.
  assert.deepEqual((map.get('sec-kitchen|2026-08-05') || []).map(s => s.id).sort((a, b) => a - b), [5, 10]);
  // And the explicitly-sectioned Friday pair is intact.
  assert.deepEqual((map.get('sec-runner|2026-08-07') || []).map(s => s.id).sort((a, b) => a - b), [3, 7]);
});

test('buckets are sorted by start time', () => {
  const { map } = bucketShiftsBySection([
    { id: 'late', roleKey: 'chef', date: 'd', start: '17:00' },
    { id: 'early', roleKey: 'chef', date: 'd', start: '09:00' },
  ], SECTIONS, groupNameOf);
  assert.deepEqual(map.get('sec-kitchen|d').map(s => s.id), ['early', 'late']);
});

test('an empty week buckets to nothing without throwing', () => {
  const { bucketedCount, unassigned } = bucketShiftsBySection([], SECTIONS, groupNameOf);
  assert.equal(bucketedCount, 0);
  assert.equal(unassigned, 0);
});
