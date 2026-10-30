// src/lib/openShiftsHidden.test.js
// 5.11.122: the staff app's empty open shifts words come from the server's hidden counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countHidden, openShiftsEmptyWords } from '../../supabase/functions/_shared/openShiftsHidden.js';

test('no hidden shifts: the old sentence', () => {
  assert.equal(openShiftsEmptyWords(null), 'Nothing up for grabs in the next three weeks.');
  assert.equal(openShiftsEmptyWords({ role: {}, past: 0, other: 0 }), 'Nothing up for grabs in the next three weeks.');
});

test('Provo on 28 Oct: two bartender shifts and one already started', () => {
  const hidden = countHidden([{ code: 'role', role: 'Bartender' }, { code: 'role', role: 'Bartender' }, { code: 'past' }]);
  assert.deepEqual(hidden, { role: { Bartender: 2 }, past: 1, other: 0 });
  assert.equal(openShiftsEmptyWords(hidden), '2 open shifts need a bartender, not your position. 1 open shift has already started.');
});

test('one shift, one role', () => {
  assert.equal(openShiftsEmptyWords(countHidden([{ code: 'role', role: 'Chef' }])), '1 open shift needs a chef, not your position.');
});

test('two roles are listed with counts, most first', () => {
  const h = countHidden([{ code: 'role', role: 'Bartender' }, { code: 'role', role: 'Server' }, { code: 'role', role: 'Bartender' }]);
  assert.equal(openShiftsEmptyWords(h), '3 open shifts need 2 bartender and 1 server, not your position.');
});

test('only past shifts', () => {
  assert.equal(openShiftsEmptyWords(countHidden([{ code: 'past' }, { code: 'past' }])), '2 open shifts have already started.');
});

test('other hidden reasons never leak into the words; a missing role label gets a stand in', () => {
  const h = countHidden([{ code: 'not_on_team' }, { code: 'role', role: '' }]);
  assert.equal(h.other, 1);
  assert.equal(openShiftsEmptyWords(h), '1 open shift needs someone in another position, not your position.');
});

test('wired: the server counts and the staff app renders them', () => {
  const srv = readFileSync(new URL('../../supabase/functions/staff-portal/openShifts.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../staff/StaffShiftSwaps.jsx', import.meta.url), 'utf8');
  assert.match(srv, /countHidden\(/);
  assert.match(srv, /hidden: countHidden\(hiddenOpen\)/);
  assert.match(app, /openShiftsEmptyWords\(swaps\.hidden\)/);
  assert.ok(!app.includes("'Nothing up for grabs"), 'the fixed sentence left the component');
});
