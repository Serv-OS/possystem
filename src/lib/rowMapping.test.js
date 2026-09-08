import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMenuRow } from './rowMapping.js';

// The camelCase view the app actually reads (MenuManager, menu resolvers).
const camelView = (r) => ({ isDefault: r.isDefault, isActive: r.isActive, sortOrder: r.sortOrder });

test('snake-only, camel-only and mixed rows normalise identically', () => {
  const snake = { id: 'menu-1', name: 'Main', is_default: true, is_active: false, sort_order: 3 };
  const camel = { id: 'menu-1', name: 'Main', isDefault: true, isActive: false, sortOrder: 3 };
  const mixed = { id: 'menu-1', name: 'Main', is_default: true, isActive: false, sort_order: 3 };
  const expected = { isDefault: true, isActive: false, sortOrder: 3 };
  assert.deepEqual(camelView(normaliseMenuRow(snake)), expected);
  assert.deepEqual(camelView(normaliseMenuRow(camel)), expected);
  assert.deepEqual(camelView(normaliseMenuRow(mixed)), expected);
});

test('defaults when neither spelling is present: not default, active, sort 0', () => {
  const out = normaliseMenuRow({ id: 'menu-2', name: 'Bar' });
  assert.deepEqual(camelView(out), { isDefault: false, isActive: true, sortOrder: 0 });
});

test('camel spelling wins over a stale snake field on the same row', () => {
  // An already-normalised store row (isDefault: false) must never be
  // resurrected to true by a snake original riding along via spread.
  const out = normaliseMenuRow({ id: 'menu-3', isDefault: false, is_default: true, isActive: true, is_active: false, sortOrder: 2, sort_order: 9 });
  assert.deepEqual(camelView(out), { isDefault: false, isActive: true, sortOrder: 2 });
});

test('falsy camel values survive: false and 0 are real values, not gaps', () => {
  const out = normaliseMenuRow({ id: 'menu-4', isDefault: false, isActive: false, sortOrder: 0 });
  assert.deepEqual(camelView(out), { isDefault: false, isActive: false, sortOrder: 0 });
});

test('snake originals are kept on the row (spread, not projection)', () => {
  const out = normaliseMenuRow({ id: 'menu-5', is_default: true, is_active: true, sort_order: 4 });
  assert.equal(out.is_default, true);
  assert.equal(out.is_active, true);
  assert.equal(out.sort_order, 4);
});

test('unrelated fields pass through untouched', () => {
  const schedule = { days: [1, 2, 3], start: '11:00', end: '15:00' };
  const out = normaliseMenuRow({ id: 'menu-6', name: 'Lunch', description: 'Midday', schedule, priority: 5, scope: 'local', org_id: null });
  assert.equal(out.name, 'Lunch');
  assert.equal(out.description, 'Midday');
  assert.deepEqual(out.schedule, schedule);
  assert.equal(out.priority, 5);
  assert.equal(out.scope, 'local');
  assert.equal(out.org_id, null);
});

test('null and undefined pass through without throwing', () => {
  assert.equal(normaliseMenuRow(null), null);
  assert.equal(normaliseMenuRow(undefined), undefined);
});
