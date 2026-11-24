// src/staff/reinstate.test.js (5.12.89): is the person being added already on the system?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existingMatches, hasMatch, reinstatedWords } from './reinstate.js';

const HERE = 'loc-h', THERE = 'loc-s';
const NAMES = { [HERE]: 'H Mall', [THERE]: 'Selfridges' };
const RECORDS = [
  { id: '1', name: 'Sam Jones', email: 'sam@example.com', mobile: '07931129015', location_id: HERE, status: 'leaver', leaver_date: '2026-10-03' },
  { id: '2', name: 'Priya Shah', email: 'priya@example.com', mobile: '07700900111', location_id: HERE, status: 'active' },
  { id: '3', name: 'Sam Jones', email: 'other.sam@example.com', mobile: null, location_id: THERE, status: 'active' },
  { id: '4', name: 'Lee Wong', email: 'lee@example.com', mobile: '07700900222', location_id: THERE, status: 'leaver', leaver_date: '2026-09-01' },
];

test('a leaver at this site is found by email, mobile or name', () => {
  const byEmail = existingMatches({ name: 'Samuel Jones', email: 'SAM@example.com' }, RECORDS, HERE, NAMES);
  assert.equal(byEmail.hereLeaver.id, '1');
  assert.equal(byEmail.hereLeaver.why, 'same email');
  assert.equal(byEmail.hereLeaver.leftOn, '2026-10-03');
  assert.equal(existingMatches({ name: 'S', mobile: '+44 7931 129015' }, RECORDS, HERE, NAMES).hereLeaver.id, '1');
  const byName = existingMatches({ name: 'sam jones' }, RECORDS, HERE, NAMES);
  assert.equal(byName.hereLeaver.id, '1');
  assert.deepEqual(byName.elsewhere.map((m) => [m.id, m.site, m.leaver]), [['3', 'Selfridges', false]]);
});

test('someone still on the team here is said so, not reinstated', () => {
  const found = existingMatches({ name: 'Priya S', email: 'priya@example.com' }, RECORDS, HERE, NAMES);
  assert.equal(found.hereActive.id, '2');
  assert.equal(found.hereLeaver, null);
  assert.ok(hasMatch(found));
});

test('a leaver at another site of the company is named with the site', () => {
  const found = existingMatches({ name: 'Lee Wong', email: 'lee@example.com' }, RECORDS, HERE, NAMES);
  assert.equal(found.hereLeaver, null);
  assert.deepEqual(found.elsewhere.map((m) => [m.id, m.site, m.leaver, m.leftOn]), [['4', 'Selfridges', true, '2026-09-01']]);
});

test('nobody like them: nothing to say', () => {
  const found = existingMatches({ name: 'New Person', email: 'new@example.com', mobile: '07700900999' }, RECORDS, HERE, NAMES);
  assert.equal(hasMatch(found), false);
  assert.equal(hasMatch(existingMatches(null, RECORDS, HERE)), false);
  // Editing a record never matches itself.
  assert.equal(hasMatch(existingMatches({ id: '2', name: 'Priya Shah', email: 'priya@example.com' }, RECORDS, HERE, NAMES)), false);
});

test('the strongest match wins when two leavers share a name', () => {
  const two = [
    { id: 'a', name: 'Sam Jones', email: 'old@example.com', location_id: HERE, status: 'leaver', leaver_date: '2026-11-01' },
    { id: 'b', name: 'Sam Jones', email: 'sam@example.com', location_id: HERE, status: 'leaver', leaver_date: '2025-01-01' },
  ];
  assert.equal(existingMatches({ name: 'Sam Jones', email: 'sam@example.com' }, two, HERE).hereLeaver.id, 'b');
});

test('the toast says what came back and what did not', () => {
  assert.match(reinstatedWords('Sam', { till: 'restored' }), /Sam is back on the team\. Their till PIN works again\./);
  assert.match(reinstatedWords('Sam', { till: 'pin_taken' }), /new one on the Team page/);
  assert.match(reinstatedWords('Sam', {}), /Back Office access is not given back/);
});
