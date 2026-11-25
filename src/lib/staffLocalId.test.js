// A team member added in Back Office takes their real id as soon as the save answers
// (lib/staffLocalId.js). Peter, 25 Nov 2026: "invalid input syntax for type uuid: s-1795625033657".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLocalStaffId, resolveStaffId, swapStaffId, NOT_SAVED_YET } from './staffLocalId.js';

const REAL = '8c71908b-94eb-4e20-8c5b-8f00852c9263';

test('a stand in id is told apart from a real one', () => {
  assert.equal(isLocalStaffId('s-1795625033657'), true);
  assert.equal(isLocalStaffId(REAL), false);
  assert.equal(isLocalStaffId('s1'), false, 'the demo staff ids are not stand ins');
  assert.equal(isLocalStaffId(null), false);
  assert.equal(isLocalStaffId(42), false);
});

test('a box still holding the stand in is given the real id once the save answered', () => {
  const saved = { 's-1': REAL };
  assert.equal(resolveStaffId('s-1', saved), REAL);
  assert.equal(resolveStaffId('s-2', saved), 's-2', 'not saved yet: unchanged, and still a stand in');
  assert.equal(resolveStaffId(REAL, saved), REAL);
  assert.equal(resolveStaffId('s-1', null), 's-1');
});

test('the list swaps the one id and nothing else', () => {
  const a = { id: 's-1', name: 'Gina', pin: '1234' }; const b = { id: REAL.replace('8c', '9d'), name: 'Tom' };
  const out = swapStaffId([a, b], 's-1', REAL);
  assert.deepEqual(out[0], { id: REAL, name: 'Gina', pin: '1234' });
  assert.equal(out[1], b);
  assert.deepEqual(swapStaffId([a, b], REAL, 'x'), [a, b], 'only a stand in is ever swapped');
  assert.deepEqual(swapStaffId([a, b], 's-1', null), [a, b], 'no real id, no swap');
  assert.deepEqual(swapStaffId(null, 's-1', REAL), []);
  assert.ok(!/[–—]/.test(NOT_SAVED_YET));
});

test('Staff page: the add reads the real id back, and nothing is asked of the database on a stand in', () => {
  const src = readFileSync(new URL('../backoffice/sections/StaffManager.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes("active: true,\n      }).select('id').single();"), 'the insert reads the row back');
  assert.ok(src.includes('adoptSavedId(localId, saved?.id);'), 'and the real id takes the stand in\'s place');
  const grant = src.indexOf('const grantBOAccess = async (askedId) => {');
  const guard = src.indexOf('if (isLocalStaffId(staffId)) { setGrantError(NOT_SAVED_YET); return; }', grant);
  const makes = src.indexOf("functions/v1/create-user", grant);
  assert.ok(grant > 0 && guard > grant && guard < makes, 'no login is made for a person who is not saved');
  assert.ok(src.includes('const id = realId(askedId);   // 25 Nov 2026: a just added person\'s real id'), 'an edit uses the real id');
  assert.ok(src.includes("if (!isMock && isLocalStaffId(id)) { showToast(NOT_SAVED_YET, 'error'); return; }"), 'a remove never leaves the row behind');
});
