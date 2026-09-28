// src/lib/categoryForm.test.js
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". The category
// editor used to save its whole seven field form, putting back values another window had saved
// since it opened (a tax profile, a course). It now saves only the fields changed in the form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryFormOf, categoryFormPatch } from './categoryForm.js';

const cat = {
  id: 'cat-hot', label: 'Hot drinks', icon: '☕', color: '#15C26A', parentId: null,
  accountingGroup: 'Beverages', defaultCourse: 0, taxProfileId: 'prof-X', image: 'https://x/y.jpg', srvAt: 't1',
};

test('the form opens with the seven editable fields, never the photo', () => {
  assert.deepEqual(categoryFormOf(cat), {
    label: 'Hot drinks', icon: '☕', color: '#15C26A', parentId: '', accountingGroup: 'Beverages', defaultCourse: 0, taxProfileId: 'prof-X',
  });
  // The same defaults the editor always used.
  assert.deepEqual(categoryFormOf({ label: 'New' }), {
    label: 'New', icon: '🍽', color: '#3b82f6', parentId: '', accountingGroup: '', defaultCourse: 1, taxProfileId: '',
  });
});

test('Save sends only what changed in the form, in the row\'s shape', () => {
  const opened = categoryFormOf(cat);
  assert.deepEqual(categoryFormPatch(opened, opened), {}, 'nothing changed: nothing to save');
  assert.deepEqual(categoryFormPatch(opened, { ...opened, label: 'Hot drinks & tea' }), { label: 'Hot drinks & tea' });
  assert.deepEqual(categoryFormPatch(opened, { ...opened, defaultCourse: 2, icon: '🍵' }), { icon: '🍵', defaultCourse: 2 });
  // "None" in a picker is '' on the form and null in the row.
  assert.deepEqual(categoryFormPatch(opened, { ...opened, taxProfileId: '' }), { taxProfileId: null });
  assert.deepEqual(categoryFormPatch(opened, { ...opened, parentId: 'cat-drinks' }), { parentId: 'cat-drinks' });
  const root = categoryFormOf({ ...cat, parentId: 'cat-drinks' });
  assert.deepEqual(categoryFormPatch(root, { ...root, parentId: '' }), { parentId: null });
  // A null and an empty choice are the same "none": not a change.
  assert.deepEqual(categoryFormPatch({ ...opened, taxProfileId: null }, { ...opened, taxProfileId: '' }), {});
});
