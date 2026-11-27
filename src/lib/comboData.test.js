// comboData.test.js: where a Combo's steps live (menu_items.combo) and every door they pass.
//   read    lib/rowMapping.js mapMenuItemRow (the ONE mapper: boot, push, realtime, Back Office)
//   write   lib/menuItemWrite.js (only when the edit names it, never by a save of something else)
//   share   lib/shareCopy.js (never copied to another venue) and db.js (a steps Combo is not shared)
//   SQL     20261215a (one empty column; the app works before it has run)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapMenuItemRow } from './rowMapping.js';
import { menuItemRow, columnsForEdit, ITEM_COLUMNS, ITEM_EXTRA_KEYS } from './menuItemWrite.js';
import { NEVER_FIELDS, VERBATIM_FIELDS, REMAPPED_FIELDS, propagatedFields, resendFields, carryVerbatim } from './shareCopy.js';
import { comboSteps, comboHasSteps } from './combo.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const STEPS = { v: 1, steps: [{ id: 'st-1', name: 'Pick 5 pizzas', selectionType: 'quantity', min: 5, max: 5, pricing: 'set', products: [{ itemId: 'm-marg', bump: 0 }] }] };
const dbRow = (extra = {}) => ({ id: 'm-byo', location_id: 'L1', name: 'Build Your Own', menu_name: 'Build Your Own', type: 'combo', pricing: { base: 149 }, sold_alone: true, updated_at: '2026-11-27T10:00:00+00:00', ...extra });

test('the one mapper carries the steps, and a row from before the column carries no field', () => {
  const withSteps = mapMenuItemRow(dbRow({ combo: STEPS }));
  assert.deepEqual(withSteps.combo, STEPS);
  assert.equal(comboHasSteps(withSteps), true);
  assert.equal(comboSteps(withSteps)[0].name, 'Pick 5 pizzas');
  const empty = mapMenuItemRow(dbRow({ combo: null }));
  assert.equal('combo' in empty, true);
  assert.equal(empty.combo, null);
  assert.equal(comboHasSteps(empty), false);
  const before = mapMenuItemRow(dbRow());                                  // the column is not there yet
  assert.equal('combo' in before, false);
  assert.equal(comboHasSteps(before), false);
});

test('every loader goes through that one mapper (boot, the till\'s self heal, realtime, Back Office)', () => {
  assert.match(read('../sync/SyncBridge.jsx'), /patch\.menuItems = itemsRes\.data\.map\(mapMenuItemRow\)/);
  assert.match(read('./useSupabaseInit.js'), /items\.map\(mapMenuItemRow\)/);
  assert.match(read('./venueMenuRead.js'), /out\.menuItems = items\.rows\.map\(mapMenuItemRow\)/);
  assert.match(read('./realtime.js'), /import \{ mapMenuItemRow as mapItemRow/);
});

test('a save writes the steps only when the row carries the field', () => {
  assert.equal('combo' in menuItemRow({ id: 'a', name: 'Latte' }), false);
  assert.equal(menuItemRow({ id: 'a', name: 'X', combo: null }).combo, null);
  assert.deepEqual(menuItemRow({ id: 'a', name: 'X', type: 'combo', combo: STEPS }).combo, STEPS);
  // Whatever is in memory is written in the clean shape, and no steps is null (never an empty object).
  assert.equal(menuItemRow({ id: 'a', name: 'X', combo: { steps: [] } }).combo, null);
  assert.equal(menuItemRow({ id: 'a', name: 'X', combo: 'rubbish' }).combo, null);
  const messy = menuItemRow({ id: 'a', name: 'X', combo: { steps: [{ selectionType: 'quantity', max: 3, products: ['p1', 'p1', { itemId: 'p2', bump: -4 }] }] } }).combo;
  assert.deepEqual(messy, { v: 1, steps: [{ id: 'step-1', name: 'Step 1', selectionType: 'quantity', min: 3, max: 3, pricing: 'set', products: [{ itemId: 'p1', bump: 0 }, { itemId: 'p2', bump: 0 }] }] });
});

test('an edit of the steps writes the steps and nothing else; an edit of anything else never names them', () => {
  const prev = mapMenuItemRow(dbRow({ combo: null }));
  const next = { ...prev, combo: STEPS };
  assert.deepEqual(columnsForEdit({ combo: STEPS }, next, prev).cols, { combo: STEPS });
  const priced = { ...next, pricing: { base: 159 }, price: 159 };
  const cols = columnsForEdit({ pricing: { base: 159 } }, priced, next).cols;
  assert.deepEqual(Object.keys(cols), ['pricing']);
  // A row loaded before the column existed never writes it, even on an unrelated edit.
  const old = mapMenuItemRow(dbRow());
  assert.equal('combo' in columnsForEdit({ archived: true }, { ...old, archived: true }, old).cols, false);
  assert.deepEqual(ITEM_COLUMNS.combo, { keys: ['combo'] });
  assert.ok(!ITEM_EXTRA_KEYS.includes('combo'));                           // it is a real column, never a push only extra
});

test('clearing the steps saves null, so the product is exactly what it was', () => {
  const prev = mapMenuItemRow(dbRow({ combo: STEPS }));
  const next = { ...prev, combo: null };
  assert.deepEqual(columnsForEdit({ combo: null }, next, prev).cols, { combo: null });
});

test('the steps never travel to another venue by sharing', () => {
  assert.ok(NEVER_FIELDS.includes('combo'));
  assert.ok(!VERBATIM_FIELDS.includes('combo') && !REMAPPED_FIELDS.includes('combo'));
  for (const scope of ['shared', 'global']) {
    assert.ok(!propagatedFields(scope).includes('combo'), scope);
    assert.ok(!resendFields(scope, { exists: false }).includes('combo'), scope);
  }
  assert.equal('combo' in carryVerbatim({ name: 'X', combo: STEPS }), false);
});

test('a Combo with steps is not shared: the database row is checked before any copy is made', () => {
  const db = read('./db.js');
  const scope = db.slice(db.indexOf('export const setMenuItemScope'), db.indexOf('// ── PROMOTE / RE-SCOPE among shared/global ──'));
  assert.match(scope, /if \(comboHasSteps\(freshRow\)\) return \{ ok: false, error: COMBO_WORDS\.share \};/);
  assert.ok(scope.indexOf('comboHasSteps(freshRow)') < scope.indexOf('item = freshRow;'), 'checked on the row the database holds, before it is used');
});

test('the SQL: one empty column, a check that refuses rubbish, and a rollback that keeps the steps', () => {
  const up = read('../../supabase/migrations/20261215a_OPS_menu_item_combo_steps.sql');
  const down = read('../../supabase/migrations/20261215a_OPS_menu_item_combo_steps_ROLLBACK.sql');
  assert.match(up, /alter table public\.menu_items add column if not exists combo jsonb;/);
  assert.match(up, /coalesce\(jsonb_typeof\(combo -> 'steps'\), ''\) = 'array'/);          // a missing list is refused (a null check passes)
  assert.match(up, /notify pgrst, 'reload schema';/);
  assert.match(up, /set lock_timeout = '3s';/);
  assert.ok(!/\bdrop (table|column)\b/i.test(up.replace(/--.*$/gm, '')), 'the forward file takes nothing away');
  assert.ok(!/\bupdate public\.menu_items\b/i.test(up.replace(/--.*$/gm, '')), 'and changes no row');
  assert.match(down, /create table if not exists public\.menu_items_combo_keep_20261215/);
  assert.ok(down.indexOf('insert into public.menu_items_combo_keep_20261215') < down.indexOf('drop column if exists combo'), 'the steps are kept before the column goes');
  // The local rehearsal exists and names both files.
  const rig = read('../../supabase/tests/combo_steps/run.sh');
  assert.match(rig, /20261215a_OPS_menu_item_combo_steps\.sql/);
  assert.match(rig, /20261215a_OPS_menu_item_combo_steps_ROLLBACK\.sql/);
});
