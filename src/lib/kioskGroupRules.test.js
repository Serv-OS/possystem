// Modifier group rules shared by the kiosk item screen and the new kiosk design's one tap
// add rule (lib/kioskGroupRules.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  normalizeGroup, groupRequired, modifierAssignments, instructionAssignmentRequired, instructionAssignmentId,
  kioskSheetGroupHint,
} from './kioskGroupRules.js';
import { tf } from './i18n.js';

test('item sheet guidance names the first unsatisfied group in words, never "Pick a <group>"', () => {
  const g = (id, name, min, max, type = 'multiple') => normalizeGroup({ id, name, selection_type: type, min, max, options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const extras = g('x', 'Add anything?', 1, 3);
  const base = g('b', 'Base', 1, 1, 'single');
  const box = g('q', 'Box', 3, 3, 'quantity');
  assert.deepEqual(kioskSheetGroupHint([extras], {}), { key: 'k2.sheet.pickAtLeast', vars: { group: 'Add anything?', n: 1 } });
  assert.equal(tf('k2.sheet.pickAtLeast', { group: 'Add anything?', n: 1 }), 'Choose at least 1 from Add anything?');
  assert.deepEqual(kioskSheetGroupHint([base, extras], { x: ['a'] }), { key: 'k2.sheet.pickOne', vars: { group: 'Base' } });
  assert.equal(tf('k2.sheet.pickOne', { group: 'Base' }), 'Choose 1 from Base');
  assert.deepEqual(kioskSheetGroupHint([box], { q: ['a'] }), { key: 'k2.sheet.pickExactly', vars: { group: 'Box', n: 3 } });
  assert.deepEqual(kioskSheetGroupHint([extras], { x: ['a', 'b', 'c', 'a'] }), { key: 'k2.sheet.pickTooMany', vars: { group: 'Add anything?', n: 3 } });
  // First group in order, like validateSelections; every group fine gives null.
  assert.equal(kioskSheetGroupHint([base, extras], { b: ['a'], x: ['a'] }), null);
  assert.equal(kioskSheetGroupHint([], {}), null);
  assert.equal(kioskSheetGroupHint(null, null), null);
  for (const k of ['k2.sheet.pickOne', 'k2.sheet.pickExactly', 'k2.sheet.pickAtLeast', 'k2.sheet.pickTooMany']) {
    assert.ok(!/Pick a /.test(tf(k, { group: 'G', n: 2 })), k);
  }
});

test('normalizeGroup is the word for word copy from KioskProductModal at v5.8.65', () => {
  const src = fs.readFileSync(new URL('./kioskGroupRules.js', import.meta.url), 'utf8');
  const i = src.indexOf('function normalizeGroup(group) {');
  const j = src.indexOf('\n}\n', i) + 2;
  const block = src.slice(i, j);
  assert.equal(block.length, 1876);
  assert.equal(crypto.createHash('sha256').update(block).digest('hex'), '182bc5d852b0275a8b662251bc02ca03902dcebe30f91427b7754d08023e09eb');
  const modal = fs.readFileSync(new URL('../surfaces/KioskProductModal.jsx', import.meta.url), 'utf8');
  assert.ok(!modal.includes('function normalizeGroup('), 'the modal must import it, not keep a second copy');
  assert.ok(modal.includes("import { normalizeGroup, kioskSheetGroupHint } from '../lib/kioskGroupRules';"));
});

test('single choice defaults to max 1 and min 0', () => {
  const g = normalizeGroup({ selection_type: 'single' });
  assert.equal(g._max, 1);
  assert.equal(g._min, 0);
  assert.equal(g._isSingle, true);
  assert.equal(normalizeGroup({})._selectionType, 'single');
});

test('a quantity group with no min gets min equal to max', () => {
  assert.equal(normalizeGroup({ selection_type: 'quantity', max: 3 })._min, 3);
  assert.equal(normalizeGroup({ selection_type: 'quantity', min: 0, max: 6 })._min, 6);
  assert.equal(normalizeGroup({ selection_type: 'quantity', min: 2, max: 6 })._min, 2);
  // max from the option count when no max is stored
  assert.equal(normalizeGroup({ selection_type: 'quantity', options: [{}, {}, {}] })._min, 3);
});

test('min is clamped to max, and never below 0', () => {
  assert.equal(normalizeGroup({ selection_type: 'multiple', min: 5, max: 2 })._min, 2);
  assert.equal(normalizeGroup({ selection_type: 'multiple', min: -3, max: 2 })._min, 0);
});

test('every alias field is read', () => {
  const a = normalizeGroup({ selectionType: 'multiple', min_select: 1, max_select: 4 });
  assert.deepEqual([a._min, a._max, a._isSingle], [1, 4, false]);
  const b = normalizeGroup({ selection_type: 'multiple', minSelect: 2, maxSelect: 3 });
  assert.deepEqual([b._min, b._max], [2, 3]);
  assert.equal(normalizeGroup({ selection_type: 'multiple' })._max, 99);
});

test('modifierAssignments reads ids and overrides like the modal', () => {
  assert.deepEqual(modifierAssignments(['a', { groupId: 'b', min: 1 }, { id: 'c', max: 2 }, { min: 1 }, null]), [
    { id: 'a', min: null, max: null },
    { id: 'b', min: 1, max: null },
    { id: 'c', min: null, max: 2 },
  ]);
  assert.deepEqual(modifierAssignments(undefined), []);
});

test('groupRequired reads the group only; a copy saved on the item is ignored, like the till', () => {
  assert.equal(groupRequired({ selection_type: 'single', min: 0, max: 1 }), false);
  assert.equal(groupRequired({ selection_type: 'single', min: 1, max: 1 }), true);
  // Milk (live): min 1 on the group, "min 0" on the Latte sizes. Required.
  assert.equal(groupRequired({ selection_type: 'single', min: 1, max: 1, min_select: 0, max_select: 1 }, { min: 0 }), true);
  assert.equal(groupRequired({ selection_type: 'multiple', min: 0, max: 3 }, { min: 2 }), false);
  assert.equal(groupRequired({ selection_type: 'quantity', max: 3 }), true);
  assert.equal(groupRequired({ selection_type: 'multiple', min: 2, max: 3 }, { max: 0 }), true);
  assert.equal(groupRequired(null), false);
});

test('instruction groups are required only when the item or the group sets a min, like the till', () => {
  assert.equal(instructionAssignmentRequired('ig1'), false);
  assert.equal(instructionAssignmentRequired({ groupId: 'ig1' }), false);
  assert.equal(instructionAssignmentRequired({ groupId: 'ig1', min: null }), false);
  assert.equal(instructionAssignmentRequired({ groupId: 'ig1', min: 0 }), false);
  assert.equal(instructionAssignmentRequired({ groupId: 'ig1', min: 1 }), true);
  assert.equal(instructionAssignmentRequired('ig1', { id: 'ig1', min: 1 }), true);
  assert.equal(instructionAssignmentRequired({ groupId: 'ig1', min: 0 }, { id: 'ig1', min: 1 }), false);
  assert.equal(instructionAssignmentId('ig1'), 'ig1');
  assert.equal(instructionAssignmentId({ id: 'ig2' }), 'ig2');
  assert.equal(instructionAssignmentId({ groupId: 'ig3', id: 'x' }), 'ig3');
  assert.equal(instructionAssignmentId(null), null);
});
