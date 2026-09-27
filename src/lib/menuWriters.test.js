// src/lib/menuWriters.test.js
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board".
// A replay of the incident at Coffee Boy Leeds with TWO Back Office tabs on one (fake) database:
//   13:52  both tabs have the menu loaded
//   13:56  tab A (Safari) archives Choc Babyccino
//   13:58  tab A sets a tax rate on every product with none ("Apply to all")
//   13:59  tab B (Chrome, loaded before all that) edits a price and presses Push to POS
// Before the fix B's price edit wrote its WHOLE row (archived=false, no tax rate) and its push
// wrote all 435 rows from memory. Here A's tax and A's archive must survive, B's price must
// save, the push must write nothing, and the tills' snapshot must be what the database holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMenuWriters, changedElsewhereMessage, categoryMenuLinkRetry, categoryInsertRetry } from './menuWriters.js';
import { readVenueMenu, menuPatchFromRead, menuSnapshotFromRead, unsavedMenuRows } from './venueMenuRead.js';
import { runBulkEdits, bulkSummaryWords } from './menuBulk.js';
import { insertRowOnce } from './menuRowWrite.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';
import { categoryFormOf, categoryFormPatch } from './categoryForm.js';

const LOC = '1e252e7c-c875-4971-b91d-1e945c26956b';            // Coffee Boy Leeds
const BABYCCINO = 'm-1790002933030_5c26956b';
const LATTE = 'm-latte';
const TEA = 'm-1790501864145';
const LEEDS_20 = '6368f6fb-leeds-standard';
const T0 = '2026-09-27T13:52:21.000+00:00';

const item = (id, name, over = {}) => ({
  id, location_id: LOC, name, menu_name: name, receipt_name: name, kitchen_name: name, description: '',
  type: 'simple', cat: 'cat-hot', cats: [], parent_id: null, sort_order: 1, pricing: { base: 2.2 },
  allergens: [], tags: [], assigned_modifier_groups: [], assigned_instruction_groups: [],
  visibility: { pos: true, kiosk: true, online: true }, sold_alone: true, archived: false,
  centre_id: null, tax_rate_id: null, tax_overrides: {}, tax_profile_id: null, image: null,
  scope: 'local', org_id: null, master_id: null, lock_pricing: false, locked_fields: [],
  updated_at: T0, ...over,
});

const leeds = () => ({
  menus: [{ id: 'menu-main', location_id: LOC, name: 'Main', is_default: true, is_active: true, sort_order: 0, updated_at: T0 }],
  menu_categories: [{ id: 'cat-hot', location_id: LOC, menu_id: 'menu-main', label: 'Hot drinks', sort_order: 0, updated_at: T0 }],
  menu_items: [
    item(BABYCCINO, 'Choc Babyccino'),
    item(LATTE, 'Latte', { pricing: { base: 3.1 } }),
    item(TEA, 'Tea', { pricing: { base: 2 } }),
  ],
  modifier_groups: [],
  tax_rates: [{ id: LEEDS_20, location_id: LOC, name: 'Standard 20%', code: 'S', rate: 0.2, type: 'inclusive', applies_to: ['all'], is_default: true, active: true }],
  tax_profiles: [],
  tax_profile_lines: [],
  locations: [{ id: LOC, default_tax_profile_id: null }],
});

const SLICE = { items: 'menuItems', categories: 'menuCategories', menus: 'menus' };

// One Back Office tab: a plain store and the real writers, wired the way store/index.js wires them.
function backOfficeTab(db) {
  const state = { menuItems: [], menuCategories: [], menus: [], modifierGroupDefs: [], taxRates: [] };
  const toasts = [];
  const reports = [];
  const writers = createMenuWriters({
    getClient: () => db,
    resolveLocation: async () => LOC,
    getRow: (kind, id) => state[SLICE[kind]].find((r) => r.id === id),
    updateRow: (kind, id, fn) => { const k = SLICE[kind]; state[k] = state[k].map((r) => (r.id === id ? fn(r) : r)); },
    reportSave: (entity, err) => reports.push({ entity, err }),
    toast: (msg, type) => toasts.push({ msg, type }),
    wait: async () => {},
  });
  return {
    state, toasts, reports, writers,
    async load() {
      const mark = writers.mark();
      const read = await readVenueMenu(db, LOC);
      assert.ok(read.ok, `read failed: ${read.failed}`);
      const keep = new Set([...writers.items.pendingIds(), ...writers.items.landedSince(mark)]);
      Object.assign(state, menuPatchFromRead(state, read, { keep: { items: keep }, locationId: LOC }));
      return read;
    },
    // store updateMenuItem, reduced to what matters here: show the edit, save only the patch.
    edit(id, patch, opts = {}) {
      const prev = state.menuItems.find((r) => r.id === id);
      const next = { ...prev, ...patch };
      state.menuItems = state.menuItems.map((r) => (r.id === id ? next : r));
      return writers.items.edit(id, patch, prev, next, opts);
    },
    // store updateCategory: show the edit, save only the patch. opts.opened: the category as the
    // editor had it when it OPENED (MenuManager CatModal), which the edit is checked against.
    editCategory(id, patch, opts = {}) {
      const prev = state.menuCategories.find((r) => r.id === id);
      const next = { ...prev, ...patch };
      state.menuCategories = state.menuCategories.map((r) => (r.id === id ? next : r));
      return writers.categories.edit(id, patch, prev, next, { liveRow: next, opened: opts.opened || null });
    },
    // store archiveMenuItem: the narrow write, 0 rows is a failure, the new updated_at kept.
    async archive(id) {
      state.menuItems = state.menuItems.map((r) => (r.id === id ? { ...r, archived: true } : r));
      const { data, error } = await writers.items.task(id, () => db.from('menu_items')
        .update({ archived: true, parent_id: null, updated_at: new Date().toISOString() })
        .eq('id', id).eq('location_id', LOC).select('id, updated_at'));
      assert.equal(error, null);
      assert.equal(data.length, 1, 'the archive changed a row');
      writers.items.markLanded(id);
      state.menuItems = state.menuItems.map((r) => (r.id === id ? { ...r, srvAt: data[0].updated_at, updated_at: data[0].updated_at } : r));
    },
    // BackOfficeApp handlePush, reduced to the menu: wait for saves, read, snapshot. No writes.
    async push() {
      await writers.items.whenIdle();
      const read = await readVenueMenu(db, LOC);
      assert.ok(read.ok);
      const unsaved = unsavedMenuRows(state, read);
      assert.equal(unsaved.total, 0, 'nothing on this screen is missing from the database');
      Object.assign(state, menuPatchFromRead(state, read, { locationId: LOC }));
      return menuSnapshotFromRead(read);
    },
  };
}

const rowsWritten = (db) => db.log.filter((l) => /^menu_items\.(update|upsert)$/.test(l)).length;

for (const trigger of [false, true]) {
  const when = trigger ? 'after the migration (database clock)' : 'before the migration (writer stamps)';

  test(`the incident, replayed with two tabs, ${when}: A's tax and archive survive B's price edit and push`, async () => {
    const db = fakeMenuDb(leeds(), { trigger });
    const A = backOfficeTab(db);
    const B = backOfficeTab(db);
    await A.load();
    await B.load();

    // 13:56 A archives Choc Babyccino.
    await A.archive(BABYCCINO);
    // 13:58 A: "Apply to all" with Leeds' own rate, bounded and awaited.
    const out = await runBulkEdits(
      A.state.menuItems.filter((i) => !i.archived && !i.taxRateId).map((i) => ({ id: i.id, patch: { taxRateId: LEEDS_20 }, onlyIf: (r) => !r.taxRateId })),
      { getRow: (id) => A.state.menuItems.find((r) => r.id === id), update: (id, patch) => A.edit(id, patch, { quiet: true }) });
    assert.deepEqual({ saved: out.saved, skipped: out.skipped, failed: out.failed }, { saved: 2, skipped: 0, failed: 0 });
    assert.equal(bulkSummaryWords(out, 'Standard 20%'), 'Standard 20% set on 2');

    // 13:59 B, still holding the 13:52 menu, changes the Choc Babyccino price...
    assert.equal(B.state.menuItems.find((i) => i.id === BABYCCINO).archived, false, 'B is stale');
    const r = await B.edit(BABYCCINO, { pricing: { base: 2.5 }, price: 2.5 });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, 'merged', 'refused on the old updated_at, re-read, sent once more');
    assert.equal(B.toasts.length, 0, 'nothing to tell: only the price was B\'s change');

    // ...and presses Push to POS.
    const before = rowsWritten(db);
    const snap = await B.push();
    assert.equal(rowsWritten(db), before, 'the push wrote NO menu row');

    const dbRow = db.row('menu_items', BABYCCINO);
    assert.equal(dbRow.archived, true, 'A\'s archive survives');
    assert.equal(dbRow.pricing.base, 2.5, 'B\'s price saved');
    assert.equal(db.row('menu_items', LATTE).tax_rate_id, LEEDS_20, 'A\'s tax survives');
    assert.equal(db.row('menu_items', TEA).tax_rate_id, LEEDS_20);

    // The tills get what the database holds: Babyccino gone (so the board and the tills agree),
    // every product on Leeds' own rate, and B's screen now shows the same.
    assert.ok(!snap.menuItems.some((i) => i.id === BABYCCINO), 'an archived product is not sent');
    assert.ok(snap.menuItems.every((i) => i.taxRateId === LEEDS_20));
    assert.deepEqual(snap.taxRates.map((t) => [t.id, t.locationId]), [[LEEDS_20, LOC]], 'Leeds\' rates, carrying their venue');
    assert.ok(snap.menuItems.every((i) => i.srvAt), 'each row carries its database time');
    assert.ok(B.state.menuItems.every((i) => i.taxRateId === LEEDS_20 || i.archived));
  });

  test(`the same field changed in another tab is refused, said plainly, and the screen shows the database, ${when}`, async () => {
    const db = fakeMenuDb(leeds(), { trigger });
    const A = backOfficeTab(db);
    const B = backOfficeTab(db);
    await A.load();
    await B.load();
    assert.equal((await A.edit(LATTE, { taxRateId: LEEDS_20 })).outcome, 'applied');
    const r = await B.edit(LATTE, { taxRateId: 'r-zero' });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, 'conflict');
    assert.deepEqual(r.changed, ['tax_rate_id']);
    assert.equal(db.row('menu_items', LATTE).tax_rate_id, LEEDS_20, 'the database keeps A\'s value');
    assert.equal(B.state.menuItems.find((i) => i.id === LATTE).taxRateId, LEEDS_20, 'B now shows the latest');
    assert.deepEqual(B.toasts, [{ msg: changedElsewhereMessage('Latte'), type: 'error' }]);
    assert.equal(B.toasts[0].msg, 'Latte was changed in another window since this page loaded. Your change was NOT saved; the latest is showing now. Make it again if it is still needed.');
    assert.ok(B.reports.some((x) => x.entity === 'item' && /changed in another window/.test(String(x.err?.message))), 'the red bar records it');
    // Made again on the fresh copy, it saves.
    assert.equal((await B.edit(LATTE, { taxRateId: 'r-zero' })).outcome, 'applied');
    assert.equal(db.row('menu_items', LATTE).tax_rate_id, 'r-zero');
  });
}

test('another tab\'s change to OTHER columns is shown after the retry, and never written back', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const A = backOfficeTab(db);
  const B = backOfficeTab(db);
  await A.load();
  await B.load();
  await A.edit(TEA, { menuName: 'English breakfast tea' });
  const r = await B.edit(TEA, { allergens: ['milk'] });
  assert.equal(r.outcome, 'merged');
  const row = db.row('menu_items', TEA);
  assert.equal(row.menu_name, 'English breakfast tea');
  assert.deepEqual(row.allergens, ['milk']);
  const shown = B.state.menuItems.find((i) => i.id === TEA);
  assert.equal(shown.menuName, 'English breakfast tea', 'B takes in A\'s rename');
  assert.equal(shown.srvAt, row.updated_at, 'and the next compare and set token');
});

test('a bulk strip counts what a refusal skipped: "set on 1, 1 skipped: changed elsewhere"', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const A = backOfficeTab(db);
  const B = backOfficeTab(db);
  await A.load();
  await B.load();
  await A.edit(LATTE, { taxRateId: 'r-reduced' });   // A gives Latte a rate first
  const out = await runBulkEdits(
    B.state.menuItems.filter((i) => !i.taxRateId && !i.archived).map((i) => ({ id: i.id, patch: { taxRateId: LEEDS_20 } })).filter((e) => e.id !== BABYCCINO),
    { getRow: (id) => B.state.menuItems.find((r) => r.id === id), update: (id, patch) => B.edit(id, patch, { quiet: true }), concurrency: 2 });
  assert.equal(out.saved, 1);
  assert.equal(out.skipped, 1);
  assert.equal(bulkSummaryWords(out, 'Standard 20%'), 'Standard 20% set on 1, 1 skipped: changed elsewhere');
  assert.equal(B.toasts.length, 0, 'a bulk action says it once, not per product');
  assert.equal(db.row('menu_items', LATTE).tax_rate_id, 'r-reduced');
});

test('a reload keeps a row whose save is still on its way, and one that landed after the read began', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const A = backOfficeTab(db);
  await A.load();
  let release;
  const gate = new Promise((r) => { release = r; });
  db.hooks.beforeWrite = async (table, op) => { if (table === 'menu_items' && op === 'update') await gate; };
  const saving = A.edit(LATTE, { pricing: { base: 3.4 } });
  await A.load();   // the tab comes back to the front while the save is on its way
  assert.equal(A.state.menuItems.find((i) => i.id === LATTE).pricing.base, 3.4, 'the person\'s edit does not flicker back');
  release();
  assert.equal((await saving).outcome, 'applied');
  db.hooks.beforeWrite = null;
  await A.load();
  assert.equal(A.state.menuItems.find((i) => i.id === LATTE).pricing.base, 3.4);

  // A read that took its rows BEFORE a save landed, and answers after it: the older answer
  // must not put the old price back (the read cannot have seen the save).
  let answer;
  const slow = new Promise((r) => { answer = r; });
  db.hooks.afterRead = async (table) => { if (table === 'menu_items') await slow; };
  const loading = A.load();
  await new Promise((r) => setTimeout(r, 5));
  db.hooks.afterRead = null;
  assert.equal((await A.edit(LATTE, { pricing: { base: 3.6 } })).outcome, 'applied');
  answer();
  await loading;
  assert.equal(A.state.menuItems.find((i) => i.id === LATTE).pricing.base, 3.6, 'kept: it landed after the read began');
  assert.equal(A.state.menuItems.find((i) => i.id === LATTE).srvAt, db.row('menu_items', LATTE).updated_at, 'with the token its save returned');
});

test('creations are inserts that never overwrite; a new category keeps itself over a missing menu', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const A = backOfficeTab(db);
  await A.load();
  // An id the database already has is left exactly as it is.
  const again = await A.writers.items.create(LATTE, { name: 'Latte', archived: false, tax_rate_id: null, pricing: { base: 0 } });
  assert.equal(again.outcome, 'exists');
  assert.deepEqual(db.row('menu_items', LATTE).pricing, { base: 3.1 });
  // v5.9.22 (Huddersfield): a category naming a menu the database lacks is kept, link dropped.
  const fkError = { code: '23503', message: 'insert or update on table "menu_categories" violates foreign key constraint "menu_categories_menu_id_fkey"' };
  assert.deepEqual(categoryMenuLinkRetry(fkError, { id: 'c', label: 'Beer', menu_id: 'menu-lost' }).cols, { id: 'c', label: 'Beer' });
  assert.equal(categoryMenuLinkRetry({ code: '23503', message: 'menu_categories_parent_id_fkey' }, { menu_id: 'm' }), null, 'only THIS foreign key');
  const client = {
    from: (t) => {
      const b = db.from(t);
      const up = b.upsert.bind(b);
      b.upsert = (rows, o) => ((Array.isArray(rows) ? rows : [rows]).some((r) => r.menu_id === 'menu-lost')
        ? { select: async () => ({ data: null, error: fkError }) } : up(rows, o));
      return b;
    },
  };
  const r = await insertRowOnce({ client, table: 'menu_categories', row: { id: 'cat-beer', location_id: LOC, label: 'Beer', menu_id: 'menu-lost' }, retryWithout: categoryInsertRetry });
  assert.equal(r.outcome, 'created');
  assert.equal(db.row('menu_categories', 'cat-beer').label, 'Beer');
  assert.equal(db.row('menu_categories', 'cat-beer').menu_id, undefined);
});

// ── The category editor (review round 2, 27 Sep 2026) ───────────────────────────────────────
// The editor copies seven fields into its form when it opens and used to save all seven. With
// the reload on returning to a tab, the store row (and its token) was fresh but the open form
// was not, so a rename put back the tax profile another window had set: the Leeds tax incident
// again, for categories, with no message. The editor now saves only what changed in the form,
// checked against the category as the form OPENED with it.
for (const trigger of [false, true]) {
  const when = trigger ? 'after the migration' : 'before the migration';

  test(`category editor, two tabs: a rename after another tab set the tax profile keeps that profile, ${when}`, async () => {
    const db = fakeMenuDb(leeds(), { trigger });
    db.touch('menu_categories', 'cat-hot', { tax_profile_id: 'prof-X' });
    const A = backOfficeTab(db);
    const B = backOfficeTab(db);
    await A.load();
    await B.load();

    // Tab A opens the category editor.
    const opened = A.state.menuCategories.find((c) => c.id === 'cat-hot');
    const form = categoryFormOf(opened);
    assert.equal(form.taxProfileId, 'prof-X');

    // Tab B sets the tax profile.
    assert.equal((await B.editCategory('cat-hot', { taxProfileId: 'prof-Y' })).outcome, 'applied');

    // Tab A goes away and comes back (the reload refreshes its store row, not its open form),
    // renames the category in the form and saves.
    await A.load();
    assert.equal(A.state.menuCategories.find((c) => c.id === 'cat-hot').taxProfileId, 'prof-Y');
    const patch = categoryFormPatch(categoryFormOf(opened), { ...form, label: 'Hot drinks & tea' });
    assert.deepEqual(patch, { label: 'Hot drinks & tea' }, 'only the field the person changed');
    const r = await A.editCategory('cat-hot', patch, { opened });
    assert.equal(r.ok, true);
    assert.ok(['applied', 'merged'].includes(r.outcome), r.outcome);

    const dbRow = db.row('menu_categories', 'cat-hot');
    assert.equal(dbRow.label, 'Hot drinks & tea', 'the rename saved');
    assert.equal(dbRow.tax_profile_id, 'prof-Y', 'B\'s tax profile survives');
    assert.equal(A.toasts.length, 0, 'nothing to tell: only the name was A\'s change');
    const shown = A.state.menuCategories.find((c) => c.id === 'cat-hot');
    assert.equal(shown.taxProfileId, 'prof-Y');
    assert.equal(shown.label, 'Hot drinks & tea');
  });

  test(`category editor, two tabs: the same field changed since the form opened is refused and said, ${when}`, async () => {
    const db = fakeMenuDb(leeds(), { trigger });
    db.touch('menu_categories', 'cat-hot', { tax_profile_id: 'prof-X' });
    const A = backOfficeTab(db);
    const B = backOfficeTab(db);
    await A.load();
    await B.load();
    const opened = A.state.menuCategories.find((c) => c.id === 'cat-hot');
    const form = categoryFormOf(opened);
    await B.editCategory('cat-hot', { taxProfileId: 'prof-Y' });
    await A.load();   // even after a reload: the FORM still shows prof-X
    const r = await A.editCategory('cat-hot', categoryFormPatch(categoryFormOf(opened), { ...form, taxProfileId: 'prof-Z' }), { opened });
    assert.equal(r.outcome, 'conflict');
    assert.deepEqual(r.changed, ['tax_profile_id']);
    assert.equal(db.row('menu_categories', 'cat-hot').tax_profile_id, 'prof-Y', 'never silently overwritten');
    assert.deepEqual(A.toasts, [{ msg: changedElsewhereMessage('Hot drinks'), type: 'error' }]);
    assert.equal(A.state.menuCategories.find((c) => c.id === 'cat-hot').taxProfileId, 'prof-Y', 'the screen shows the latest');
  });
}

test('category editor: without a reload, a rename saves and another tab\'s profile stands', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const A = backOfficeTab(db);
  const B = backOfficeTab(db);
  await A.load();
  await B.load();
  const opened = A.state.menuCategories.find((c) => c.id === 'cat-hot');
  await B.editCategory('cat-hot', { taxProfileId: 'prof-Y', icon: '☕' });
  const r = await A.editCategory('cat-hot', categoryFormPatch(categoryFormOf(opened), { ...categoryFormOf(opened), label: 'Coffee' }), { opened });
  assert.equal(r.outcome, 'merged', 'refused on the old token, re-read, sent once more (only the name)');
  const dbRow = db.row('menu_categories', 'cat-hot');
  assert.deepEqual([dbRow.label, dbRow.tax_profile_id, dbRow.icon], ['Coffee', 'prof-Y', '☕']);
  // Saving the form unchanged writes nothing at all.
  assert.deepEqual(categoryFormPatch(categoryFormOf(opened), categoryFormOf(opened)), {});
  const before = db.log.length;
  assert.equal((await A.editCategory('cat-hot', {}, { opened })).outcome, 'noop');
  assert.equal(db.log.length, before);
});
