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
import { readFileSync } from 'node:fs';
import {
  createMenuWriters, changedElsewhereMessage, categoryMenuLinkRetry, categoryInsertRetry,
  runItemEditWrites, putBackFollowers, itemSaveLanded,
  categoryParentRetry, isMissingParentRow, toTopLevelWords,
} from './menuWriters.js';
import { readVenueMenu, menuPatchFromRead, menuSnapshotFromRead, unsavedMenuRows, readIdsOf } from './venueMenuRead.js';
import { runBulkEdits, bulkSummaryWords } from './menuBulk.js';
import { insertRowOnce } from './menuRowWrite.js';
import { categoryRow } from './menuItemWrite.js';
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
// opts.client: the client the WRITES go through (reads use db); opts.timeoutMs: each write's time
// limit; opts.chain: the categories and menus serial chain (store runInMenuWriteQueue).
function backOfficeTab(db, { client = db, timeoutMs = undefined, chain = null } = {}) {
  const state = { menuItems: [], menuCategories: [], menus: [], modifierGroupDefs: [], taxRates: [] };
  const toasts = [];
  const reports = [];
  const writers = createMenuWriters({
    getClient: () => client,
    resolveLocation: async () => LOC,
    getRow: (kind, id) => state[SLICE[kind]].find((r) => r.id === id),
    updateRow: (kind, id, fn) => { const k = SLICE[kind]; state[k] = state[k].map((r) => (r.id === id ? fn(r) : r)); },
    reportSave: (entity, err) => reports.push({ entity, err }),
    toast: (msg, type) => toasts.push({ msg, type }),
    wait: async () => {},
    chain,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const failed = () => ({
    items: writers.items.failedCreateIds(), categories: writers.categories.failedCreateIds(), menus: writers.menus.failedCreateIds(),
  });
  return {
    state, toasts, reports, writers,
    // store applyVenueMenuRead: rows with a save on its way, landed since the read began, or
    // whose first save FAILED here stay; a failed one the read has is no longer offered.
    async load() {
      const mark = writers.mark();
      const read = await readVenueMenu(db, LOC);
      assert.ok(read.ok, `read failed: ${read.failed}`);
      const keep = {};
      for (const kind of ['items', 'categories', 'menus']) {
        const inRead = readIdsOf(read, kind);
        for (const id of writers[kind].failedCreateIds()) if (inRead.has(id)) writers[kind].forgetCreate(id);
        keep[kind] = new Set([...writers[kind].pendingIds(), ...writers[kind].landedSince(mark), ...writers[kind].failedCreateIds()]);
      }
      Object.assign(state, menuPatchFromRead(state, read, { keep, locationId: LOC }));
      return read;
    },
    // What Push to POS would offer to save now (BackOfficeApp handlePush, step 3).
    async offered() {
      await Promise.all([writers.items.whenIdle(), writers.categories.whenIdle(), writers.menus.whenIdle()]);
      return unsavedMenuRows(state, await readVenueMenu(db, LOC), LOC, { failed: failed() });
    },
    // store updateMenuItem, reduced to what matters here: show the edit, save only the patch.
    edit(id, patch, opts = {}) {
      const prev = state.menuItems.find((r) => r.id === id);
      const next = { ...prev, ...patch };
      state.menuItems = state.menuItems.map((r) => (r.id === id ? next : r));
      return writers.items.edit(id, patch, prev, next, opts);
    },
    // store updateMenuItem's variant cascade, reduced (27 Sep 2026, review round 3): the product's
    // own save first, its sizes only once it landed (runItemEditWrites), and the sizes put back on
    // screen when it did not (putBackFollowers).
    editWithSizes(id, patch) {
      const before = state.menuItems;
      const writes = [{ id, patch, main: true }];
      const after = state.menuItems.map((r) => {
        if (r.id === id) return { ...r, ...patch };
        if (r.parentId !== id) return r;
        writes.push({ id: r.id, patch, cascade: true });
        return { ...r, ...patch };
      });
      state.menuItems = after;
      const followed = [];
      const skipped = [];
      const main = runItemEditWrites(writes, {
        editRow: (w) => {
          if (!w.main) followed.push(w.id);
          return writers.items.edit(w.id, w.patch, before.find((r) => r.id === w.id), after.find((r) => r.id === w.id));
        },
        onSkipped: (r) => {
          skipped.push(r.outcome);
          state.menuItems = putBackFollowers(state.menuItems, writes.filter((w) => !w.main), before, after);
        },
      });
      return { main, followed, skipped };
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
      const unsaved = unsavedMenuRows(state, read, LOC, { failed: failed() });
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

// ── Review round 3 (27 Sep 2026) ────────────────────────────────────────────────────────────

// A product with one size: the size takes the product's category (the variant cascade).
const withSizes = () => {
  const d = leeds();
  d.menu_items.push(
    item('m-coffee', 'Coffee', { type: 'variants' }),
    item('m-coffee-reg', 'Regular', { parent_id: 'm-coffee', sold_alone: false }),
  );
  return d;
};

test('the variant cascade follows ONLY a product save that landed; a refusal leaves the sizes alone', async () => {
  const db = fakeMenuDb(withSizes(), { trigger: true });
  const A = backOfficeTab(db);
  const B = backOfficeTab(db);
  await A.load();
  await B.load();
  // A moves Coffee to Cold drinks: it lands, and its size follows.
  const a = A.editWithSizes('m-coffee', { cat: 'cat-cold' });
  assert.equal((await a.main).outcome, 'applied');
  await A.writers.items.whenIdle();
  assert.deepEqual(a.followed, ['m-coffee-reg']);
  assert.equal(db.row('menu_items', 'm-coffee-reg').cat, 'cat-cold');
  // B, still holding the old menu, moves Coffee to Kids: refused as changed in another window.
  const sizeWrites = db.log.filter((l) => l === 'menu_items.update').length;
  const b = B.editWithSizes('m-coffee', { cat: 'cat-kids' });
  assert.equal((await b.main).outcome, 'conflict');
  await B.writers.items.whenIdle();
  assert.deepEqual(b.followed, [], 'the size is not written');
  assert.deepEqual(b.skipped, ['conflict']);
  assert.equal(db.log.filter((l) => l === 'menu_items.update').length, sizeWrites + 1, 'only the refused product write');
  assert.equal(db.row('menu_items', 'm-coffee-reg').cat, 'cat-cold', 'A\'s cascade stands');
  assert.notEqual(B.state.menuItems.find((i) => i.id === 'm-coffee-reg').cat, 'cat-kids', 'B\'s screen no longer shows the size moved');
  assert.equal(B.state.menuItems.find((i) => i.id === 'm-coffee').cat, 'cat-cold', 'and shows the product as the database has it');
  // After a reload B's move lands, and the size follows.
  await B.load();
  const b2 = B.editWithSizes('m-coffee', { cat: 'cat-kids' });
  assert.equal((await b2.main).outcome, 'applied');
  await B.writers.items.whenIdle();
  assert.equal(db.row('menu_items', 'm-coffee-reg').cat, 'cat-kids');
  // The case that used to split a product from its sizes: another window changed ONLY the
  // product (the size row did not move, so the size's own compare and set would have let the
  // cascade through). B's refused move must not reach the size.
  db.touch('menu_items', 'm-coffee', { cat: 'cat-hot' });
  const b3 = B.editWithSizes('m-coffee', { cat: 'cat-cold' });
  assert.equal((await b3.main).outcome, 'conflict');
  await B.writers.items.whenIdle();
  assert.equal(db.row('menu_items', 'm-coffee-reg').cat, 'cat-kids', 'the size stays with the product\'s saved category');
  assert.equal(B.state.menuItems.find((i) => i.id === 'm-coffee-reg').cat, 'cat-kids', 'and the screen shows it there');
});

test('what follows an item save: which outcomes let it run, and the screen put back', async () => {
  for (const o of ['applied', 'merged', 'already', 'noop']) assert.equal(itemSaveLanded({ outcome: o }), true, o);
  for (const o of ['conflict', 'gone', 'error', 'dropped', 'blocked', undefined]) assert.equal(itemSaveLanded({ outcome: o }), false, String(o));
  const run = async (mainResult) => {
    const started = [];
    const calls = [];
    const writes = [{ id: 'p', patch: { cat: 'x' }, main: true }, { id: 's', patch: { cat: 'x' }, cascade: true }];
    const main = runItemEditWrites(writes, {
      editRow: (w) => { started.push(w.id); return w.main ? mainResult() : Promise.resolve({ ok: true, outcome: 'applied' }); },
      onLanded: () => calls.push('landed'),
      onSkipped: (r) => calls.push(`skipped:${r.outcome}`),
    });
    try { await main; } catch { /* a rejected save */ }
    await new Promise((r) => setTimeout(r, 0));
    return { started, calls };
  };
  assert.deepEqual(await run(async () => ({ ok: true, outcome: 'merged' })), { started: ['p', 's'], calls: ['landed'] });
  assert.deepEqual(await run(async () => ({ ok: false, outcome: 'conflict' })), { started: ['p'], calls: ['skipped:conflict'] });
  assert.deepEqual(await run(async () => { throw new Error('socket'); }), { started: ['p'], calls: ['skipped:error'] });
  // The screen: only fields still showing this edit's value go back.
  const before = [{ id: 's', cat: 'hot', allergens: [] }, { id: 't', cat: 'hot' }];
  const after = [{ id: 's', cat: 'cold', allergens: ['milk'] }, { id: 't', cat: 'cold' }];
  const now = [{ id: 's', cat: 'cold', allergens: ['milk', 'soya'] }, { id: 't', cat: 'cold' }, { id: 'u', cat: 'cold' }];
  const out = putBackFollowers(now, [{ id: 's', patch: { cat: 'cold', allergens: ['milk'] } }], before, after);
  assert.deepEqual(out, [{ id: 's', cat: 'hot', allergens: ['milk', 'soya'] }, { id: 't', cat: 'cold' }, { id: 'u', cat: 'cold' }], 'an allergen added since stays; rows not written are untouched');
  assert.equal(putBackFollowers(now, [], before, after), now, 'nothing followed: the same list');
});

test('a row made at one venue is never inserted at another (a venue switch while its first save waited)', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const OTHER = '3f915972-7107-4f70-9b3d-de80ba9ab0c2';
  const state = { menuItems: [], menuCategories: [], menus: [] };
  const writers = createMenuWriters({
    getClient: () => db,
    resolveLocation: async () => OTHER,   // the Back Office is now on the other venue
    getRow: (kind, id) => state[SLICE[kind]].find((r) => r.id === id),
    updateRow: () => {},
    wait: async () => {},
  });
  const r = await writers.items.create('m-new', { name: 'Milk', menu_name: 'Milk', pricing: { base: 1 } }, { locationId: LOC });
  assert.equal(r.ok, false);
  assert.match(String(r.error?.message), /made at venue/);
  assert.equal(db.row('menu_items', 'm-new'), undefined, 'nothing inserted anywhere');
  const c = await writers.categories.create('cat-new', { label: 'Cold' }, { locationId: LOC });
  assert.equal(c.ok, false);
  assert.equal(db.row('menu_categories', 'cat-new'), undefined);
  // Made at the venue the Back Office is on: inserted there.
  const ok = await writers.items.create('m-new', { name: 'Milk', menu_name: 'Milk', pricing: { base: 1 } }, { locationId: OTHER });
  assert.equal(ok.outcome, 'created');
  assert.equal(db.row('menu_items', 'm-new').location_id, OTHER);
});

// ── Review round 4 (27 Sep 2026) ────────────────────────────────────────────────────────────

// Writes through this client fail (a network error) while `failing.on` is true.
const flakyClient = (db, failing) => ({
  from: (t) => {
    const q = db.from(t);
    const upsert = q.upsert.bind(q);
    const update = q.update.bind(q);
    q.upsert = (rows, o) => (failing.on ? { select: async () => ({ data: null, error: { message: 'Failed to fetch' } }) } : upsert(rows, o));
    q.update = (patch) => (failing.on ? { eq() { return this; }, is() { return this; }, select: async () => ({ data: null, error: { message: 'Failed to fetch' } }) } : update(patch));
    return q;
  },
});

test('Push to POS never offers back a category or menu deleted in another window; only a first save that FAILED here', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const failing = { on: false };
  const A = backOfficeTab(db, { client: flakyClient(db, failing) });
  await A.load();
  // Another window deletes the category and the menu. A still shows both.
  await db.from('menu_categories').delete().eq('id', 'cat-hot').eq('location_id', LOC).select('id');
  await db.from('menus').delete().eq('id', 'menu-main').eq('location_id', LOC).select('id');
  assert.ok(A.state.menuCategories.some((c) => c.id === 'cat-hot'), 'A is stale');
  let u = await A.offered();
  assert.equal(u.total, 0, 'a row deleted elsewhere is not "unsaved": it stays deleted');

  // A makes a menu and a category, and both first saves fail.
  failing.on = true;
  A.state.menus.push({ id: 'menu-brunch', name: 'Brunch', location_id: LOC });
  A.state.menuCategories.push({ id: 'cat-cold', label: 'Cold drinks', location_id: LOC });
  A.state.menuItems.push({ id: 'm-milk', menuName: 'Milk', name: 'Milk', location_id: LOC });
  assert.equal((await A.writers.menus.create('menu-brunch', { name: 'Brunch' }, { locationId: LOC })).outcome, 'error');
  assert.equal((await A.writers.categories.create('cat-cold', { label: 'Cold drinks' }, { locationId: LOC })).outcome, 'error');
  assert.equal((await A.writers.items.create('m-milk', { name: 'Milk', menu_name: 'Milk', pricing: { base: 1 } }, { locationId: LOC })).outcome, 'error');
  assert.deepEqual([...A.writers.categories.failedCreateIds()], ['cat-cold']);
  failing.on = false;

  // A reload keeps them on screen (the read cannot have them) and drops the deleted ones.
  await A.load();
  assert.deepEqual(A.state.menuCategories.map((c) => c.id), ['cat-cold']);
  assert.deepEqual(A.state.menus.map((m) => m.id), ['menu-brunch']);
  assert.ok(A.state.menuItems.some((i) => i.id === 'm-milk'), 'a product whose first save failed survives a reload');

  // Push to POS offers exactly those three.
  u = await A.offered();
  assert.deepEqual([u.menus.map((m) => m.id), u.menuCategories.map((c) => c.id), u.menuItems.map((i) => i.id)], [['menu-brunch'], ['cat-cold'], ['m-milk']]);

  // Saved insert only: created, so no longer offered.
  assert.equal((await A.writers.categories.create('cat-cold', { label: 'Cold drinks' }, { locationId: LOC })).outcome, 'created');
  assert.deepEqual([...A.writers.categories.failedCreateIds()], []);
  // Deleted here before it was ever saved: not offered either.
  A.writers.menus.forgetCreate('menu-brunch');
  // An insert that "failed" but landed after all (it answered too late): the next read has it,
  // so it is no longer offered and the screen takes the database's row.
  await db.from('menu_items').upsert({ id: 'm-milk', location_id: LOC, name: 'Milk', menu_name: 'Milk', archived: false, sort_order: 9 }, { onConflict: 'id', ignoreDuplicates: true }).select('*');
  await A.load();
  assert.deepEqual([...A.writers.items.failedCreateIds()], []);
  assert.ok(A.state.menuItems.find((i) => i.id === 'm-milk').srvAt, 'the database copy, with its time');
  u = await A.offered();
  assert.equal(u.total, 0);
  // An insert that finds the row there ('exists') clears it too.
  failing.on = true;
  await A.writers.items.create('m-latte-2', { name: 'Latte 2' }, { locationId: LOC });
  failing.on = false;
  assert.ok(A.writers.items.failedCreateIds().has('m-latte-2'));
  await db.from('menu_items').upsert({ id: 'm-latte-2', location_id: LOC, name: 'Latte 2', archived: false }, { onConflict: 'id', ignoreDuplicates: true }).select('*');
  assert.equal((await A.writers.items.create('m-latte-2', { name: 'Latte 2' }, { locationId: LOC })).outcome, 'exists');
  assert.ok(!A.writers.items.failedCreateIds().has('m-latte-2'));
});

test('a write that never answers is a failed save with a time limit, and the queue behind it moves on', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const A = backOfficeTab(db, { timeoutMs: 25 });
  await A.load();
  let release;
  const gate = new Promise((r) => { release = r; });
  let held = 0;
  db.hooks.beforeWrite = async (table, op) => { if (table === 'menu_items' && op === 'update' && held++ === 0) await gate; };
  const r = await A.edit(LATTE, { pricing: { base: 3.4 }, price: 3.4 });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'error');
  assert.equal(r.error?.name, 'TimeoutError');
  assert.ok(A.reports.some((x) => x.entity === 'item' && x.err?.name === 'TimeoutError'), 'the red bar says it failed');
  await A.writers.items.whenIdle();   // never hangs: the queue moved on
  // The next save of the same row goes out.
  assert.equal((await A.edit(LATTE, { allergens: ['milk'] })).outcome, 'applied');
  assert.deepEqual(db.row('menu_items', LATTE).allergens, ['milk']);
  // The first write lands late: compare and set, so it carries only the price the person set,
  // over the row as it is now. Nothing else is put back.
  release();
  await new Promise((res) => setTimeout(res, 10));
  const row = db.row('menu_items', LATTE);
  assert.deepEqual([row.pricing.base, row.allergens], [3.4, ['milk']]);
  db.hooks.beforeWrite = null;
  // The next edit re-reads (its token is out of date) and saves.
  assert.ok(['applied', 'merged'].includes((await A.edit(LATTE, { tags: ['hot'] })).outcome));
  assert.deepEqual(db.row('menu_items', LATTE).allergens, ['milk']);
});

test('a hung first save in the categories and menus chain holds nothing behind it past the time limit', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  let chainP = Promise.resolve();
  const chain = (fn) => { const run = chainP.then(fn); chainP = run.catch(() => {}); return run; };
  const A = backOfficeTab(db, { timeoutMs: 25, chain });
  await A.load();
  let release;
  const gate = new Promise((r) => { release = r; });
  db.hooks.beforeWrite = async (table, op) => { if (table === 'menu_categories' && op === 'upsert') await gate; };
  A.state.menuCategories.push({ id: 'cat-cold', label: 'Cold drinks', location_id: LOC });
  const created = A.writers.categories.create('cat-cold', { label: 'Cold drinks' }, { locationId: LOC });
  // A menu edit queued behind it in the chain.
  const edited = A.writers.menus.edit('menu-main', { name: 'All day' }, A.state.menus[0], { ...A.state.menus[0], name: 'All day' });
  assert.equal((await created).outcome, 'error');
  assert.equal((await edited).outcome, 'applied', 'the chain moved on');
  assert.equal(db.row('menus', 'menu-main').name, 'All day');
  assert.ok(A.writers.categories.failedCreateIds().has('cat-cold'), 'offered by the next Push to POS');
  await chain(() => null);   // the chain is free (whenMenuWritesIdle waits on this)
  release();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(db.row('menu_categories', 'cat-cold').label, 'Cold drinks', 'landed late, insert only');
  await A.load();
  assert.ok(!A.writers.categories.failedCreateIds().has('cat-cold'), 'the read has it: no longer offered');
});

// ── The tab's own venue (27 Sep 2026) ───────────────────────────────────────────────────────
// rpos-bo-location is ONE key for every tab of the browser. A Back Office tab on Leeds while
// another tab switched to Train Station used to insert its new products at Train Station and
// have its edits refused ("belongs to venue ..."). The venue function below is the REAL code:
// the store's tabVenue and venueAtBirth lines, over lib/supabase.js getActiveLocationSync and
// getResolvedLocationIdSync, evaluated with a fake localStorage.
const TRAIN_STATION = '3f915972-7107-4f70-9b3d-de80ba9ab0c2';
const srcOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const cutSrc = (s, a, b) => {
  const i = s.indexOf(a);
  assert.ok(i >= 0, `found ${a}`);
  const j = s.indexOf(b, i + a.length);
  assert.ok(j > i, `found the end of ${a}`);
  return s.slice(i, j + b.length).replace(/^export /, '');
};
function realVenueFns({ backOffice, resolved, storage }) {
  const supa = srcOf('./supabase.js');
  const store = srcOf('../store/index.js');
  const body = [
    cutSrc(supa, 'export function getActiveLocationSync() {', '\n}\n'),
    cutSrc(supa, 'export const getResolvedLocationIdSync = ', ';\n'),
    cutSrc(store, 'export const tabVenue = ', ';\n'),
    cutSrc(store, 'const venueAtBirth = () => {', '\n};\n'),
    'return { getActiveLocationSync, tabVenue, venueAtBirth };',
  ].join('\n');
  return new Function('localStorage', 'isBackOfficeMode', '_resolvedLocationId', body)(storage, () => backOffice, resolved);
}
const browserStorage = (values) => ({ getItem: (k) => (k in values ? values[k] : null) });

test('a Back Office tab whose own venue is Leeds writes to Leeds while localStorage says Train Station', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  // Another Back Office tab of this browser switched to Train Station: the shared key says so.
  const storage = browserStorage({ 'rpos-bo-location': JSON.stringify(TRAIN_STATION) });
  const venue = realVenueFns({ backOffice: true, resolved: LOC, storage });
  assert.equal(venue.getActiveLocationSync(), TRAIN_STATION, 'the shared key names the other venue');
  assert.equal(venue.tabVenue(), LOC, 'this tab keeps the venue it resolved');
  assert.deepEqual(venue.venueAtBirth(), { location_id: LOC }, 'a row made here is born at Leeds');

  const state = { menuItems: [], menuCategories: [], menus: [] };
  const wire = (resolveLocation) => createMenuWriters({
    getClient: () => db,
    resolveLocation,
    getRow: (kind, id) => state[SLICE[kind]].find((r) => r.id === id),
    updateRow: (kind, id, fn) => { const k = SLICE[kind]; state[k] = state[k].map((r) => (r.id === id ? fn(r) : r)); },
    wait: async () => {},
  });
  // store/index.js: resolveLocation: async () => tabVenue() || await getLocationId()
  const writers = wire(async () => venue.tabVenue());
  Object.assign(state, menuPatchFromRead(state, await readVenueMenu(db, LOC), { locationId: LOC }));

  const milk = { id: 'm-milk', name: 'Milk', menu_name: 'Milk', pricing: { base: 1 }, ...venue.venueAtBirth() };
  state.menuItems.push(milk);
  const made = await writers.items.create(milk.id, { name: 'Milk', menu_name: 'Milk', pricing: { base: 1 } }, { locationId: milk.location_id });
  assert.equal(made.outcome, 'created');
  assert.equal(db.row('menu_items', 'm-milk').location_id, LOC, 'inserted at Leeds, never at Train Station');

  const latte = state.menuItems.find((i) => i.id === LATTE);
  const next = { ...latte, pricing: { base: 3.5 } };
  state.menuItems = state.menuItems.map((i) => (i.id === LATTE ? next : i));
  assert.equal((await writers.items.edit(LATTE, { pricing: { base: 3.5 } }, latte, next)).outcome, 'applied', 'an edit of a Leeds row saves');
  assert.equal(db.row('menu_items', LATTE).pricing.base, 3.5);

  // The old wiring, for the record: the shared key sent this tab's edit to Train Station, where
  // the row does not belong, so it was refused.
  const before = await wire(async () => venue.getActiveLocationSync()).items.edit(LATTE, { pricing: { base: 3.9 } }, next, { ...next, pricing: { base: 3.9 } });
  assert.equal(before.outcome, 'error');
  assert.match(String(before.error?.message), /belongs to venue/);
  assert.equal(db.row('menu_items', LATTE).pricing.base, 3.5);
});

test('tills keep their paired venue; a Back Office tab not yet resolved uses the shared key as before', () => {
  const storage = browserStorage({
    'rpos-bo-location': JSON.stringify(TRAIN_STATION),
    'rpos-device': JSON.stringify({ locationId: LOC }),
  });
  const till = realVenueFns({ backOffice: false, resolved: TRAIN_STATION, storage });
  assert.equal(till.tabVenue(), LOC, 'a till: its paired venue (getActiveLocationSync), the Back Office key ignored');
  assert.equal(till.tabVenue(), till.getActiveLocationSync());
  const early = realVenueFns({ backOffice: true, resolved: null, storage });
  assert.equal(early.tabVenue(), TRAIN_STATION, 'before this tab resolved a venue: the stored choice');
  const demo = realVenueFns({ backOffice: true, resolved: 'loc-demo', storage });
  assert.deepEqual(demo.venueAtBirth(), {}, 'the demo venue is never stamped on a row');
});

// ── A sub category whose parent was deleted in another window (27 Sep 2026) ──────────────────
// Its insert was refused on menu_categories_parent_id_fkey every time, and Push to POS, which
// offers it again, stopped on it for good. Push now saves it at the top level and says so.
const parentFk = (parentId) => ({
  code: '23503',
  message: 'insert or update on table "menu_categories" violates foreign key constraint "menu_categories_parent_id_fkey"',
  details: `Key (parent_id)=(${parentId}) is not present in table "menu_categories".`,
});
// Writes through this client get the database's foreign key check on the parent category, and
// fail on the network for ids in `down`.
const fkClient = (db, down = new Set()) => ({
  from: (t) => {
    const q = db.from(t);
    const upsert = q.upsert.bind(q);
    q.upsert = (rows, o) => {
      const list = Array.isArray(rows) ? rows : [rows];
      if (t === 'menu_categories' && list.some((r) => down.has(r.id))) return { select: async () => ({ data: null, error: { message: 'Failed to fetch' } }) };
      const orphan = t === 'menu_categories' && list.find((r) => r.parent_id && !db.row('menu_categories', r.parent_id));
      if (orphan) return { select: async () => ({ data: null, error: parentFk(orphan.parent_id) }) };
      return upsert(rows, o);
    };
    return q;
  },
});

test('the parent retry drops only a missing parent category, and only on its own foreign key', () => {
  assert.ok(isMissingParentRow(parentFk('cat-beer')));
  assert.ok(!isMissingParentRow({ code: '23503', message: 'violates foreign key constraint "menu_categories_menu_id_fkey"' }));
  assert.ok(!isMissingParentRow({ code: '23505', message: 'duplicate key parent_id' }), 'only a foreign key violation');
  assert.deepEqual(categoryParentRetry(parentFk('cat-beer'), { id: 'c', label: 'Draught', parent_id: 'cat-beer' }), { cols: { id: 'c', label: 'Draught' }, note: 'parent-dropped' });
  assert.equal(categoryParentRetry(parentFk('cat-beer'), { id: 'c', label: 'Draught' }), null, 'nothing to drop');
  assert.equal(categoryParentRetry({ code: '23503', message: 'menu_categories_menu_id_fkey' }, { parent_id: 'p', menu_id: 'm' }), null);
  assert.deepEqual(categoryInsertRetry(parentFk('cat-beer'), { id: 'c', parent_id: 'cat-beer', menu_id: 'menu-main' }).cols, { id: 'c', menu_id: 'menu-main' }, 'Push to POS uses it');
  assert.equal(toTopLevelWords([]), '');
  assert.match(toTopLevelWords(['Draught']), /^"Draught" was saved as a TOP LEVEL category: the category it sat under is not in the database any more \(deleted in another window\)\./);
  assert.match(toTopLevelWords(['A', 'B', 'C', 'D']), /^"A", "B", "C" and 1 more were saved as TOP LEVEL categories/);
});

test('Push to POS saves a sub category whose parent was deleted elsewhere at the TOP level, and says so', async () => {
  const init = leeds();
  init.menu_categories.push({ id: 'cat-beer', location_id: LOC, menu_id: 'menu-main', label: 'Beer', sort_order: 1, updated_at: T0 });
  const db = fakeMenuDb(init, { trigger: true });
  const A = backOfficeTab(db, { client: fkClient(db) });
  await A.load();
  // Another window deletes Beer; this one, loaded before, adds Draught under it.
  db.rows('menu_categories').splice(db.rows('menu_categories').findIndex((c) => c.id === 'cat-beer'), 1);
  const draught = { id: 'cat-draught', label: 'Draught', parentId: 'cat-beer', menuId: 'menu-main', location_id: LOC };
  A.state.menuCategories.push(draught);
  const live = () => A.state.menuCategories.find((c) => c.id === 'cat-draught');
  // The editor's save (store sbCreateCategory: no parent drop) is refused, and remembered.
  const first = await A.writers.categories.create(draught.id, () => categoryRow(live(), live()), { label: 'Draught', locationId: LOC });
  assert.equal(first.outcome, 'error');
  assert.equal(db.row('menu_categories', 'cat-draught'), undefined);
  const offered = await A.offered();
  assert.deepEqual(offered.menuCategories.map((c) => c.id), ['cat-draught'], 'Push to POS offers it');
  // Push to POS (store saveUnsavedMenuRows): insert only, with categoryInsertRetry.
  const pushed = await A.writers.categories.create(draught.id, () => categoryRow(live(), live()),
    { label: 'Draught', quiet: true, retryWithout: categoryInsertRetry, locationId: LOC });
  assert.equal(pushed.outcome, 'created', 'saved, so the push is not stopped by it again');
  assert.equal(pushed.parentDropped, true, 'the push says so (toTopLevelWords)');
  const row = db.row('menu_categories', 'cat-draught');
  assert.equal(row.label, 'Draught');
  assert.equal(row.parent_id ?? null, null, 'at the top level');
  assert.equal(row.menu_id, 'menu-main', 'nothing else dropped');
  assert.equal(live().parentId, null, 'this screen shows it at the top level');
  assert.equal((await A.offered()).total, 0, 'nothing left to offer');
});

test('a parent this window still means to create is never dropped: the child waits for it', async () => {
  const db = fakeMenuDb(leeds(), { trigger: true });
  const down = new Set(['cat-wine']);
  const A = backOfficeTab(db, { client: fkClient(db, down) });
  await A.load();
  A.state.menuCategories.push({ id: 'cat-wine', label: 'Wine', menuId: 'menu-main', location_id: LOC });
  A.state.menuCategories.push({ id: 'cat-red', label: 'Red', parentId: 'cat-wine', menuId: 'menu-main', location_id: LOC });
  const liveOf = (id) => A.state.menuCategories.find((c) => c.id === id);
  const push = (id, label) => A.writers.categories.create(id, () => categoryRow(liveOf(id), liveOf(id)),
    { label, quiet: true, retryWithout: categoryInsertRetry, locationId: LOC });
  // The parent's own first save fails (the network), so the child's parent is missing too.
  assert.equal((await push('cat-wine', 'Wine')).outcome, 'error');
  const child = await push('cat-red', 'Red');
  assert.equal(child.outcome, 'error', 'not flattened: its parent is still to be saved');
  assert.equal(db.row('menu_categories', 'cat-red'), undefined);
  // The next Push to POS: the parent first, then the child, under it.
  down.clear();
  assert.equal((await push('cat-wine', 'Wine')).outcome, 'created');
  const again = await push('cat-red', 'Red');
  assert.equal(again.outcome, 'created');
  assert.equal(again.parentDropped, undefined);
  assert.equal(db.row('menu_categories', 'cat-red').parent_id, 'cat-wine');
});
