/**
 * preorderRows.test.js — booking_preorders mapping (10 Sep 2026 review).
 * A host stand save deletes then inserts every row: if the mapping drops the
 * guest's size or options, the save wipes them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rowToPreorder, preorderInsertRows, withoutChoiceColumns, missingColumn } from './preorderRows.js';

const DB_ROW = {
  id: 'po-1', booking_id: 'bk-1', seat: 2, guest_name: 'Ana', item_id: 'm-ribeye', display_name: 'Ribeye', course: 2, notes: 'No salt',
  mods: [{ id: 'o-pep', name: 'Peppercorn', price: 2.5 }], variant_item_id: 'm-ribeye-12', variant_name: '12oz',
};

test('rowToPreorder carries the size and options', () => {
  const p = rowToPreorder(DB_ROW);
  assert.deepEqual(p.mods, DB_ROW.mods);
  assert.equal(p.variantItemId, 'm-ribeye-12');
  assert.equal(p.variantName, '12oz');
  assert.equal(p.guestName, 'Ana');
  assert.equal(p.course, 2);
});

test('before the migration the absent columns read as no size and no options', () => {
  const p = rowToPreorder({ id: 'po-2', booking_id: 'bk-1', seat: null, display_name: 'Soup' });
  assert.deepEqual(p.mods, []);
  assert.equal(p.variantItemId, null);
  assert.equal(p.variantName, null);
  assert.equal(p.course, 0);
  assert.equal(rowToPreorder(null), null);
});

test('a staff save writes the guest choices back (round trip), and drops empty rows', () => {
  const rows = preorderInsertRows('bk-1', 'loc-1', [rowToPreorder(DB_ROW), { seat: 3 }, null]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].mods, DB_ROW.mods);
  assert.equal(rows[0].variant_item_id, 'm-ribeye-12');
  assert.equal(rows[0].variant_name, '12oz');
  assert.equal(rows[0].location_id, 'loc-1');
  const bare = withoutChoiceColumns(rows);
  assert.equal('mods' in bare[0], false);
  assert.equal('variant_name' in bare[0], false);
  assert.equal(bare[0].display_name, 'Ribeye');
});

test('missingColumn reads both shapes', () => {
  assert.equal(missingColumn({ code: 'PGRST204', message: "Could not find the 'mods' column" }), true);
  assert.equal(missingColumn({ code: '42703' }), true);
  assert.equal(missingColumn({ message: 'column booking_preorders.mods does not exist' }), true);
  assert.equal(missingColumn({ code: '23505', message: 'duplicate' }), false);
});
