// src/lib/menuRowWrite.test.js
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". A Back
// Office window that had read the menu before another window's changes wrote its memory of
// every product back over them. These pin the two halves of the fix:
//   columnsForPatch   an edit writes only the columns the person changed; archived is never
//                     defaulted into a write
//   writeRowChecked   compare and set on updated_at: saved, merged after a re-read when only
//                     OTHER columns changed elsewhere, refused when the same one did

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnsForPatch, columnsForEdit, menuItemRow, columnConflicts, sameValue, categoryRow, columnsForCategoryPatch, columnsForMenuPatch } from './menuItemWrite.js';
import { writeRowChecked, insertRowOnce, createRowQueue, deleteRowChecked, updateScopeChecked } from './menuRowWrite.js';
import { mapMenuItemRow } from './rowMapping.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';

const LOC = '1e252e7c-c875-4971-b91d-1e945c26956b';
const BABYCCINO = 'm-1790002933030_5c26956b';

const dbRow = (over = {}) => ({
  id: BABYCCINO, location_id: LOC, name: 'Choc Babyccino', menu_name: 'Choc Babyccino',
  receipt_name: 'Choc Babyccino', kitchen_name: 'Choc Babyccino', description: '', type: 'simple',
  cat: 'cat-kids', cats: [], parent_id: null, sort_order: 4, pricing: { base: 2.2 }, allergens: ['milk'],
  tags: [], assigned_modifier_groups: [], assigned_instruction_groups: [], visibility: { pos: true, kiosk: true, online: true },
  sold_alone: true, archived: false, centre_id: null, tax_rate_id: '6368f6fb', tax_overrides: {}, tax_profile_id: null,
  image: null, scope: 'local', org_id: null, master_id: null, lock_pricing: false, locked_fields: [],
  updated_at: '2026-09-27T14:04:21.000+00:00',
  ...over,
});
const storeRow = (over = {}) => ({ ...mapMenuItemRow(dbRow()), ...over });
const edit = (row, patch) => ({ ...row, ...patch });

// ── columnsForPatch ─────────────────────────────────────────────────────────

test('an edit writes only the columns it touched', () => {
  const prev = storeRow();
  assert.deepEqual(columnsForPatch({ taxRateId: 'r2' }, edit(prev, { taxRateId: 'r2' }), prev), { tax_rate_id: 'r2' });
  assert.deepEqual(columnsForPatch({ pricing: { base: 2.5 } }, edit(prev, { pricing: { base: 2.5 } }), prev), { pricing: { base: 2.5 } });
  assert.deepEqual(columnsForPatch({ sortOrder: 9 }, edit(prev, { sortOrder: 9 }), prev), { sort_order: 9 });
  // A price typed on a size sends pricing and price; price is not a column.
  assert.deepEqual(columnsForPatch({ price: 3 }, edit(prev, { price: 3 }), prev), {});
  // Keys that are not columns (never saved before either) write nothing.
  assert.deepEqual(columnsForPatch({ variantLabel: 'Size', course: 2 }, edit(prev, { variantLabel: 'Size', course: 2 }), prev), {});
});

test('a rename writes the name columns, and receipt and kitchen names only where they follow it', () => {
  const prev = storeRow();
  const next = edit(prev, { menuName: 'Babyccino (chocolate)' });
  const cols = columnsForPatch({ menuName: 'Babyccino (chocolate)' }, next, prev);
  assert.deepEqual(Object.keys(cols).sort(), ['menu_name', 'name']);
  // With no receipt name of its own, the receipt name follows the rename.
  const bare = storeRow({ receiptName: '', receipt_name: '', kitchenName: '', kitchen_name: '' });
  const cols2 = columnsForPatch({ menuName: 'X' }, edit(bare, { menuName: 'X' }), bare);
  assert.deepEqual(Object.keys(cols2).sort(), ['kitchen_name', 'menu_name', 'name', 'receipt_name']);
  assert.equal(cols2.receipt_name, 'X');
});

test('archived is written ONLY when the edit sets it, never defaulted', () => {
  const prev = storeRow();
  for (const patch of [{ taxRateId: 'r2' }, { pricing: { base: 1 } }, { menuName: 'Y' }, { cats: ['a'] }, { assignedModifierGroups: [{ groupId: 'g' }] }, { soldAlone: false }, { type: 'subitem' }, { scope: 'shared' }]) {
    const cols = columnsForPatch(patch, edit(prev, patch), prev);
    assert.ok(!('archived' in cols), `${JSON.stringify(patch)} must not write archived`);
  }
  // Even an item that never had the field (a snapshot row) does not get archived=false.
  const noFlag = { ...storeRow() }; delete noFlag.archived;
  assert.ok(!('archived' in columnsForPatch({ description: 'd' }, edit(noFlag, { description: 'd' }), noFlag)));
  // The archive and the restore write it.
  assert.deepEqual(columnsForPatch({ archived: false }, edit(prev, { archived: false }), prev), { archived: false });
  const sizeOff = columnsForPatch({ archived: true, parentId: null }, edit(storeRow({ parentId: 'p', parent_id: 'p' }), { archived: true, parentId: null }), storeRow({ parentId: 'p', parent_id: 'p' }));
  assert.equal(sizeOff.archived, true);
  assert.equal(sizeOff.parent_id, null);
});

test('derived columns follow their inputs: the auto modifiable flip and Sold alone', () => {
  const prev = storeRow();
  const patch = { assignedModifierGroups: [{ groupId: 'mgd-milk' }] };
  const cols = columnsForPatch(patch, edit(prev, patch), prev);
  assert.equal(cols.type, 'modifiable', 'a product with groups is never saved as simple');
  assert.deepEqual(cols.assigned_modifier_groups, [{ groupId: 'mgd-milk' }]);
  // A type change into sub item: Sold alone follows (the store sets it, rule 7).
  const sub = edit(prev, { type: 'subitem', soldAlone: false });
  const cols2 = columnsForPatch({ type: 'subitem' }, sub, prev);
  assert.equal(cols2.type, 'subitem');
  assert.equal(cols2.sold_alone, false);
  // A legacy row saved as 'simple' with groups is corrected on its next save (as always),
  // but only as a SOFT column: a type another window changed is not a reason to refuse.
  const legacy = storeRow({ type: 'simple', assignedModifierGroups: [{ groupId: 'g' }] });
  const { cols: c3, soft } = columnsForEdit({ description: 'x' }, edit(legacy, { description: 'x' }), legacy);
  assert.equal(c3.type, 'modifiable');
  assert.ok(soft.has('type'));
  assert.ok(!soft.has('description'));
});

test('categories and menus: only the touched columns; the photo never through a plain save', () => {
  const cat = { id: 'c1', label: 'Hot drinks', menuId: 'menu-1', sortOrder: 1, image: 'https://x.supabase.co/storage/v1/object/public/product-images/loc-1/categories/c1-1790000000000.jpg' };
  assert.deepEqual(columnsForCategoryPatch({ sortOrder: 3 }, { ...cat, sortOrder: 3 }), { sort_order: 3 });
  assert.deepEqual(columnsForCategoryPatch({ label: 'Hot' }, { ...cat, label: 'Hot' }), { label: 'Hot' });
  assert.ok(!('image' in columnsForCategoryPatch({ image: null }, { ...cat, image: null })), 'a clear goes only through saveCategoryImage');
  assert.ok('image' in categoryRow(cat), 'a creation carries a real photo URL');
  assert.deepEqual(columnsForMenuPatch({ isDefault: true }, { id: 'm', name: 'Main', is_default: false, isDefault: true }), { is_default: true });
});

test('comparing values ignores jsonb key order and treats missing as null', () => {
  assert.ok(sameValue({ base: 2, dineIn: null }, { dineIn: null, base: 2 }));
  assert.ok(sameValue(undefined, null));
  assert.ok(!sameValue([1, 2], [2, 1]));
  const r = columnConflicts({ cols: { tax_rate_id: 'b', pricing: { base: 3 } }, base: { tax_rate_id: 'a', pricing: { base: 2 } }, fresh: { tax_rate_id: 'a', pricing: { base: 9 } } });
  assert.deepEqual(r, { changed: ['pricing'], pending: ['tax_rate_id'] });
});

// ── writeRowChecked ─────────────────────────────────────────────────────────

const fresh = (db) => db.row('menu_items', BABYCCINO);
const itemCols = (r) => menuItemRow(mapMenuItemRow(r));
const write = (db, over) => writeRowChecked({
  client: db, table: 'menu_items', id: BABYCCINO, locationId: LOC, freshCols: itemCols, ...over,
});

test('compare and set: saved on the first try, and the new updated_at comes back', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  const r = await write(db, { srvAt: dbRow().updated_at, cols: { pricing: { base: 2.5 } }, base: { pricing: { base: 2.2 } } });
  assert.equal(r.outcome, 'applied');
  assert.equal(fresh(db).pricing.base, 2.5);
  assert.notEqual(r.row.updated_at, dbRow().updated_at, 'the next write compares against the new time');
  assert.equal(fresh(db).tax_rate_id, '6368f6fb', 'nothing else was written');
});

test('compare and set: another window changed OTHER columns, so the edit is sent once more and theirs survive', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  db.touch('menu_items', BABYCCINO, { archived: true });           // the other window archives it
  const r = await write(db, { srvAt: dbRow().updated_at, cols: { pricing: { base: 2.5 } }, base: { pricing: { base: 2.2 } } });
  assert.equal(r.outcome, 'merged');
  assert.equal(fresh(db).pricing.base, 2.5);
  assert.equal(fresh(db).archived, true, 'the archive made elsewhere is NOT undone');
  assert.equal(db.log.filter((l) => l === 'menu_items.update').length, 2, 'one refused try, one retry');
});

test('compare and set: the SAME column changed elsewhere is refused, and the database row comes back', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  db.touch('menu_items', BABYCCINO, { tax_rate_id: '1913bd65' });
  const r = await write(db, { srvAt: dbRow().updated_at, cols: { tax_rate_id: '6a159b5e' }, base: { tax_rate_id: '6368f6fb' } });
  assert.equal(r.outcome, 'conflict');
  assert.deepEqual(r.changed, ['tax_rate_id']);
  assert.equal(r.fresh.tax_rate_id, '1913bd65');
  assert.equal(fresh(db).tax_rate_id, '1913bd65', 'the other window\'s value stands');
});

test('compare and set: a row with no srvAt is read before anything is written', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  const r = await write(db, { srvAt: null, cols: { description: 'hot chocolate' }, base: { description: '' } });
  assert.equal(r.outcome, 'merged');
  assert.equal(db.log[0], 'menu_items.select', 'read first');
  assert.equal(fresh(db).description, 'hot chocolate');
  // ...and a stale copy with no srvAt is refused on the field that moved.
  db.touch('menu_items', BABYCCINO, { archived: true });
  const r2 = await write(db, { srvAt: null, cols: { archived: false }, base: { archived: false } });
  assert.equal(r2.outcome, 'conflict');
  assert.equal(fresh(db).archived, true);
});

test('compare and set: gone, refused by row level security, already there, soft columns', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  const gone = await writeRowChecked({ client: db, table: 'menu_items', id: 'm-nope', locationId: LOC, srvAt: 'x', cols: { description: 'a' }, base: {} , freshCols: itemCols });
  assert.equal(gone.outcome, 'gone');
  assert.equal(gone.ok, false);
  const other = await writeRowChecked({ client: db, table: 'menu_items', id: BABYCCINO, locationId: 'another-venue', srvAt: dbRow().updated_at, cols: { description: 'a' }, base: {}, freshCols: itemCols });
  assert.equal(other.outcome, 'gone', 'a row of another venue is never written');

  db.hooks.refuse = () => true;
  const refused = await write(db, { srvAt: dbRow().updated_at, cols: { description: 'a' }, base: { description: '' } });
  assert.equal(refused.outcome, 'error');
  assert.equal(refused.refused, true);
  assert.match(String(refused.error.message), /0 rows/);
  db.hooks.refuse = null;

  db.touch('menu_items', BABYCCINO, { description: 'a' });
  const already = await write(db, { srvAt: dbRow().updated_at, cols: { description: 'a' }, base: { description: '' } });
  assert.equal(already.outcome, 'already');

  db.touch('menu_items', BABYCCINO, { type: 'variants' });
  const soft = await write(db, { srvAt: dbRow().updated_at, cols: { description: 'b', type: 'modifiable' }, base: { description: 'a', type: 'simple' }, soft: new Set(['type']) });
  assert.equal(soft.outcome, 'merged');
  assert.deepEqual(soft.dropped, ['type']);
  assert.equal(fresh(db).type, 'variants', 'the safety net never overwrites a type set elsewhere');
  assert.equal(fresh(db).description, 'b');
});

test('compare and set with the database clock (after the migration): same answers', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] }, { trigger: true });
  const r = await write(db, { srvAt: dbRow().updated_at, cols: { pricing: { base: 3 } }, base: { pricing: { base: 2.2 } } });
  assert.equal(r.outcome, 'applied');
  const r2 = await write(db, { srvAt: dbRow().updated_at, cols: { pricing: { base: 4 } }, base: { pricing: { base: 2.2 } } });
  assert.equal(r2.outcome, 'conflict', 'the old token no longer matches: our own first write moved it');
  const r3 = await write(db, { srvAt: r.row.updated_at, cols: { pricing: { base: 4 } }, base: { pricing: { base: 3 } } });
  assert.equal(r3.outcome, 'applied');
});

test('a column the database cannot take is dropped and the rest saved (item code)', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  // Another product at this venue holds the code: the database refuses any write carrying it.
  const client = {
    from: (t) => {
      const b = db.from(t);
      const upd = b.update.bind(b);
      b.update = (patch) => (patch.item_code ? { eq() { return this; }, is() { return this; }, select: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "menu_items_location_item_code_key"' } }) } : upd(patch));
      return b;
    },
  };
  const r = await writeRowChecked({
    client, table: 'menu_items', id: BABYCCINO, locationId: LOC, srvAt: dbRow().updated_at, freshCols: itemCols,
    cols: { menu_name: 'CB', name: 'CB', item_code: 'CHOC' }, base: { menu_name: 'Choc Babyccino', name: 'Choc Babyccino', item_code: null },
    retryWithout: (err, cols) => { const c = { ...cols }; delete c.item_code; return { cols: c, note: 'code' }; },
  });
  assert.equal(r.outcome, 'applied');
  assert.equal(r.note, 'code');
  assert.equal(fresh(db).menu_name, 'CB');
});

test('insertRowOnce never overwrites an existing row', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] });
  const r = await insertRowOnce({ client: db, table: 'menu_items', row: { ...dbRow(), archived: false, tax_rate_id: 'stale' } });
  assert.equal(r.outcome, 'exists');
  assert.equal(fresh(db).tax_rate_id, '6368f6fb');
  const n = await insertRowOnce({ client: db, table: 'menu_items', row: { id: 'm-new', location_id: LOC, name: 'Milk' } });
  assert.equal(n.outcome, 'created');
  assert.ok(n.row.updated_at, 'created rows carry a token');
});

test('a delete checks it removed the row: deleted, never there, or refused', async () => {
  const db = fakeMenuDb({ menu_categories: [{ id: 'c1', location_id: LOC, label: 'Hot drinks' }, { id: 'c2', location_id: LOC, label: 'Cold drinks' }] });
  const del = (id, locationId = LOC) => deleteRowChecked({ client: db, table: 'menu_categories', id, locationId });
  assert.equal((await del('c1')).outcome, 'deleted');
  assert.equal(db.row('menu_categories', 'c1'), undefined);
  assert.equal((await del('c-never')).outcome, 'absent', 'nothing to delete is not a failure');
  const other = await del('c2', 'another-venue');
  assert.equal(other.outcome, 'absent', 'another venue\'s row is never touched');
  assert.ok(db.row('menu_categories', 'c2'));
  db.hooks.refuse = () => true;
  const refused = await del('c2');
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true, 'a refused delete used to read exactly like one that worked');
  assert.match(String(refused.error.message), /0 rows/);
  assert.ok(db.row('menu_categories', 'c2'));
});

// ── createRowQueue ──────────────────────────────────────────────────────────

test('the row queue: one write at a time per row, waiting edits folded (latest value, oldest base)', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createRowQueue({
    run: async (job) => { seen.push({ cols: { ...job.cols }, base: { ...job.base } }); if (seen.length === 1) await gate; return { ok: true, outcome: 'applied', row: {} }; },
    onResult: () => {},
  });
  const a = q.update('i1', { cols: { pricing: 1 }, base: { pricing: 0 } });
  const b = q.update('i1', { cols: { pricing: 12 }, base: { pricing: 1 } });
  const c = q.update('i1', { cols: { pricing: 125, name: 'x' }, base: { pricing: 12, name: 'n' } });
  assert.ok(q.isPending('i1'));
  release();
  await Promise.all([a, b, c]);
  assert.equal(seen.length, 2, 'the two waiting edits went as one write');
  assert.deepEqual(seen[1], { cols: { pricing: 125, name: 'x' }, base: { pricing: 1, name: 'n' } });
  assert.ok(!q.isPending('i1'));
  await q.whenIdle();
});

test('the row queue: after a refusal, the edits waiting behind it for that row are dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const results = [];
  const q = createRowQueue({
    run: async () => { await gate; return { ok: false, outcome: 'conflict', fresh: {} }; },
    onResult: (id, job, r, ctx) => results.push({ outcome: r.outcome, dropped: ctx.dropped.length }),
  });
  const a = q.update('i1', { cols: { tax_rate_id: 'a' }, base: { tax_rate_id: null } });
  const b = q.update('i1', { cols: { pricing: 2 }, base: { pricing: 1 } });
  release();
  assert.equal((await a).outcome, 'conflict');
  assert.equal((await b).outcome, 'dropped');
  assert.deepEqual(results, [{ outcome: 'conflict', dropped: 1 }]);
});

test('the row queue: a form\'s edit keeps its own token and is never folded into another', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createRowQueue({
    run: async (job) => { seen.push({ cols: { ...job.cols }, srvAt: job.srvAt }); if (seen.length === 1) await gate; return { ok: true, outcome: 'applied', row: {} }; },
    onResult: () => {},
  });
  const a = q.update('c1', { cols: { sort_order: 3 }, base: { sort_order: 2 } });
  const b = q.update('c1', { cols: { label: 'Coffee' }, base: { label: 'Hot drinks' }, srvAt: 't-opened' });
  const c = q.update('c1', { cols: { sort_order: 4 }, base: { sort_order: 3 } });
  release();
  await Promise.all([a, b, c]);
  assert.deepEqual(seen, [
    { cols: { sort_order: 3 }, srvAt: undefined },
    { cols: { label: 'Coffee' }, srvAt: 't-opened' },
    { cols: { sort_order: 4 }, srvAt: undefined },
  ]);
});

// ── Sharing writes are checked (review round 2, 27 Sep 2026) ────────────────────────────────
test('a sharing change is scoped to the venue and checked: applied, already, refused, gone', async () => {
  const db = fakeMenuDb({ menu_items: [dbRow()] }, { trigger: true });
  const want = { scope: 'global', org_id: 'org-1', master_id: BABYCCINO };
  const patch = { ...want, updated_at: '2026-09-27T15:00:00.000Z' };
  const r1 = await updateScopeChecked({ client: db, table: 'menu_items', id: BABYCCINO, locationId: LOC, patch, want });
  assert.deepEqual([r1.ok, r1.outcome], [true, 'applied']);
  assert.equal(db.row('menu_items', BABYCCINO).scope, 'global');
  // Refused (row level security) but the row already holds the values: fine (a pull from
  // another venue re-sends from an owner row this Back Office may not write).
  db.hooks.refuse = () => true;
  const r2 = await updateScopeChecked({ client: db, table: 'menu_items', id: BABYCCINO, locationId: LOC, patch, want });
  assert.deepEqual([r2.ok, r2.outcome], [true, 'already']);
  // Refused and NOT holding them: a failure, said as one (it used to read as saved).
  const r3 = await updateScopeChecked({ client: db, table: 'menu_items', id: BABYCCINO, locationId: LOC,
    patch: { scope: 'local', org_id: null, master_id: null, updated_at: 'x' } });
  assert.deepEqual([r3.ok, r3.outcome, r3.refused], [false, 'error', true]);
  assert.match(r3.error.message, /matched 0 rows/);
  db.hooks.refuse = null;
  // Another venue's row, or none: gone, never written.
  const r4 = await updateScopeChecked({ client: db, table: 'menu_items', id: BABYCCINO, locationId: 'another-venue', patch, want });
  assert.deepEqual([r4.ok, r4.outcome], [false, 'gone']);
  assert.equal((await updateScopeChecked({ client: db, table: 'menu_items', id: BABYCCINO, locationId: 'loc-demo', patch })).ok, false);
});
