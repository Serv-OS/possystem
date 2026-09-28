// src/lib/scopedPropagation.test.js
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". A Shared or
// Global product's edit is copied to its other venues. That copy used to be scheduled whatever
// became of the save, and made from the tab's memory, so an edit refused as "changed in another
// window" still reached every venue, and a stale window spread its old values (Global carries
// archived) organisation wide. Two Back Office tabs on one venue, one fake database holding a
// Global product and its copy at a second venue:
//   * an edit refused as changed elsewhere never reaches the copy
//   * an accepted edit reaches it, copied from the DATABASE row: the copy keeps another
//     window's archive and rename, never this tab's old memory of them
//   * a failed save, a missing row or a failed read copies nothing

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScopedPropagator, savedForPropagation, PROPAGATING_OUTCOMES } from './scopedPropagation.js';
import { createMenuWriters, changedElsewhereMessage } from './menuWriters.js';
import { readVenueMenu, menuPatchFromRead } from './venueMenuRead.js';
import { carryVerbatim, nameColumnsFor, propagatedFields, isMasterRow } from './shareCopy.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';

const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
const LOC2 = 'a0c1d2e3-0000-4000-8000-00000000beef';
const LATTE = 'm-latte';
const COPY = `${LATTE}_${LOC2.slice(-8)}`;
const T0 = '2026-09-27T13:52:21.000+00:00';

const row = (id, loc, over = {}) => ({
  id, location_id: loc, name: 'Latte', menu_name: 'Latte', receipt_name: 'Latte', kitchen_name: 'Latte',
  description: '', type: 'simple', cat: null, cats: [], parent_id: null, sort_order: 1, pricing: { base: 3.1 },
  allergens: [], tags: [], assigned_modifier_groups: [], assigned_instruction_groups: [],
  visibility: { pos: true, kiosk: true, online: true }, sold_alone: true, archived: false,
  centre_id: null, tax_rate_id: null, tax_overrides: {}, tax_profile_id: null, image: null,
  scope: 'global', org_id: 'org-1', master_id: LATTE, lock_pricing: false, locked_fields: [],
  updated_at: T0, ...over,
});

const world = () => ({
  menus: [], menu_categories: [], modifier_groups: [], tax_rates: [], tax_profiles: [], tax_profile_lines: [],
  locations: [{ id: PROVO, default_tax_profile_id: null }],
  menu_items: [row(LATTE, PROVO), row(COPY, LOC2)],
});

// db.propagateScopedEdit, reduced to what matters here: every follow field of the row it is
// GIVEN (Global: archived too) onto every copy, checked like the real one.
const fakePropagate = (db, seen) => async (src, keys) => {
  seen.push({ row: src, keys });
  if (!isMasterRow(src)) return { ok: true, propagated: 0 };
  const fields = propagatedFields(src.scope, { lockPricing: !!src.lock_pricing });
  const patch = { ...carryVerbatim(src, fields), ...nameColumnsFor(src) };
  if (fields.includes('archived')) patch.archived = !!src.archived;
  let propagated = 0;
  for (const sib of db.rows('menu_items').filter((r) => r.master_id === src.id && r.id !== src.id)) {
    const { data } = await db.from('menu_items').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', sib.id).select('id');
    if (data?.length) propagated++;
  }
  return { ok: true, propagated, failed: [], unmapped: [] };
};

// One Back Office tab at Provo: the real writers and the real propagator, wired as the store
// wires them (updateMenuItem schedules the copy only once the save resolves as landed).
function tab(db) {
  const state = { menuItems: [], menuCategories: [], menus: [], modifierGroupDefs: [], taxRates: [] };
  const toasts = [];
  const seen = [];
  const errors = [];
  const SLICE = { items: 'menuItems', categories: 'menuCategories', menus: 'menus' };
  const writers = createMenuWriters({
    getClient: () => db,
    resolveLocation: async () => PROVO,
    getRow: (kind, id) => state[SLICE[kind]].find((r) => r.id === id),
    updateRow: (kind, id, fn) => { const k = SLICE[kind]; state[k] = state[k].map((r) => (r.id === id ? fn(r) : r)); },
    toast: (msg, type) => toasts.push({ msg, type }),
    wait: async () => {},
  });
  const prop = createScopedPropagator({
    readRow: async (id) => {
      const { data, error } = await db.from('menu_items').select('*').eq('id', id).eq('location_id', PROVO).maybeSingle();
      return { row: data || null, error: error || null };
    },
    propagate: fakePropagate(db, seen),
    onError: (e) => errors.push(e),
    delay: 0,
  });
  return {
    state, toasts, seen, errors, writers, prop,
    async load() {
      const read = await readVenueMenu(db, PROVO);
      assert.ok(read.ok);
      Object.assign(state, menuPatchFromRead(state, read, { locationId: PROVO }));
    },
    edit(id, patch) {
      const prev = state.menuItems.find((r) => r.id === id);
      const next = { ...prev, ...patch };
      state.menuItems = state.menuItems.map((r) => (r.id === id ? next : r));
      const p = writers.items.edit(id, patch, prev, next);
      p.then((r) => { if (savedForPropagation(r)) prop.schedule(id, Object.keys(patch), r.row || null); });
      return p;
    },
    // store archiveMenuItem: the narrow write, then (Global) the copy once it landed.
    async archive(id) {
      state.menuItems = state.menuItems.map((r) => (r.id === id ? { ...r, archived: true } : r));
      const { data } = await db.from('menu_items').update({ archived: true, parent_id: null, updated_at: new Date().toISOString() })
        .eq('id', id).eq('location_id', PROVO).select('id, updated_at');
      assert.equal(data.length, 1);
      writers.items.markLanded(id);
      state.menuItems = state.menuItems.map((r) => (r.id === id ? { ...r, srvAt: data[0].updated_at } : r));
      prop.schedule(id, ['archived']);
    },
  };
}

test('only a save the database accepted is copied to the other venues', () => {
  assert.deepEqual([...PROPAGATING_OUTCOMES], ['applied', 'merged', 'already']);
  for (const outcome of ['applied', 'merged', 'already']) assert.equal(savedForPropagation({ ok: true, outcome }), true, outcome);
  for (const r of [
    { ok: false, outcome: 'conflict' }, { ok: false, outcome: 'gone' }, { ok: false, outcome: 'error' },
    { ok: false, outcome: 'dropped' }, { ok: true, outcome: 'noop' }, { ok: false, outcome: 'blocked' }, null, undefined,
  ]) assert.equal(savedForPropagation(r), false, JSON.stringify(r));
});

for (const trigger of [false, true]) {
  const when = trigger ? 'after the migration' : 'before the migration';

  test(`a Global edit refused as "changed in another window" never reaches the copy, ${when}`, async () => {
    const db = fakeMenuDb(world(), { trigger });
    const A = tab(db);
    const B = tab(db);
    await A.load();
    await B.load();

    // A archives the Global product and renames it; both reach the copy at the other venue.
    await A.archive(LATTE);
    await A.prop.whenIdle();
    assert.equal(db.row('menu_items', COPY).archived, true, 'Global: retired everywhere');
    assert.equal((await A.edit(LATTE, { menuName: 'Latte grande' })).outcome, 'applied');
    await A.prop.whenIdle();
    assert.equal(db.row('menu_items', COPY).menu_name, 'Latte grande');

    // B, loaded before all that, renames it too: refused, and NOTHING is copied.
    const r = await B.edit(LATTE, { menuName: 'Latte tall' });
    assert.equal(r.outcome, 'conflict');
    assert.deepEqual(B.toasts, [{ msg: changedElsewhereMessage('Latte tall'), type: 'error' }]);
    await B.prop.whenIdle();
    assert.equal(B.seen.length, 0, 'a refused edit schedules no copy');
    const copy = db.row('menu_items', COPY);
    assert.equal(copy.menu_name, 'Latte grande', 'the copy keeps the saved name');
    assert.equal(copy.archived, true, 'and stays retired: B\'s memory of archived=false never travels');
  });

  test(`an accepted edit from a stale tab is copied from the DATABASE row, ${when}`, async () => {
    const db = fakeMenuDb(world(), { trigger });
    const A = tab(db);
    const C = tab(db);
    await A.load();
    await C.load();   // C loaded before A's archive and rename, and never reloads
    await A.archive(LATTE);
    await A.edit(LATTE, { menuName: 'Latte grande' });
    await A.prop.whenIdle();

    // C changes only the price: its save is sent again on the fresh row (merged) and lands.
    const cStale = C.state.menuItems.find((i) => i.id === LATTE);
    assert.equal(cStale.archived, false);
    assert.equal(cStale.menuName, 'Latte');
    const r = await C.edit(LATTE, { pricing: { base: 3.4 }, price: 3.4 });
    assert.equal(r.outcome, 'merged');
    await C.prop.whenIdle();
    assert.equal(C.seen.length, 1, 'one copy');
    const sent = C.seen[0].row;
    assert.equal(sent.menuName, undefined, 'a raw database row, not this tab\'s store copy');
    assert.equal(sent.srvAt, undefined);
    assert.equal(sent.archived, true, 'what travels is the database\'s row');
    assert.equal(sent.menu_name, 'Latte grande');
    assert.deepEqual(C.seen[0].keys, ['pricing', 'price']);
    const copy = db.row('menu_items', COPY);
    assert.deepEqual(copy.pricing, { base: 3.4 }, 'the price reaches the copy');
    assert.equal(copy.archived, true, 'the archive another window made survives');
    assert.equal(copy.menu_name, 'Latte grande', 'and so does its rename');
  });
}

test('a failed save, a missing row or a failed read copies nothing; a burst is one copy', async () => {
  // A save the database refused (row level security): nothing is scheduled.
  const db = fakeMenuDb(world(), { trigger: true });
  const A = tab(db);
  await A.load();
  db.hooks.refuse = (table, op) => table === 'menu_items' && op === 'update';
  const r = await A.edit(LATTE, { description: 'Double shot' });
  assert.equal(r.ok, false);
  await A.prop.whenIdle();
  assert.equal(A.seen.length, 0);
  db.hooks.refuse = null;

  // The propagator on its own: a burst of three edits is ONE copy, of the row read at copy time.
  const reads = [];
  const got = [];
  const errors = [];
  let answer = { row: { id: LATTE, scope: 'global', v: 1 }, error: null };
  const p = createScopedPropagator({
    readRow: async (id) => { reads.push(id); return answer; },
    propagate: async (rowIn, keys) => { got.push({ rowIn, keys }); return { ok: true }; },
    onError: (e) => errors.push(e),
    delay: 0,
  });
  p.schedule(LATTE, ['menuName']);
  p.schedule(LATTE, ['pricing']);
  p.schedule(LATTE, ['menuName']);
  await p.whenIdle();
  assert.deepEqual(reads, [LATTE]);
  assert.equal(got.length, 1);
  assert.equal(got[0].rowIn, answer.row, 'exactly the row the read returned');
  assert.deepEqual(got[0].keys.sort(), ['menuName', 'pricing']);

  // Gone from this venue: nothing copied. A read that fails: nothing copied, and said.
  answer = { row: null, error: null };
  p.schedule(LATTE, ['menuName']);
  await p.whenIdle();
  assert.equal(got.length, 1);
  answer = { row: null, error: new Error('read failed') };
  p.schedule(LATTE, ['menuName']);
  await p.whenIdle();
  assert.equal(got.length, 1);
  assert.equal(errors.length, 1);

  // The page closing: copies what is waiting from the row its SAVE returned, at once; one with
  // no saved row (the archive asks only for its id) is read and copied at once instead.
  const fired = [];
  const heldReads = [];
  const heldCopies = [];
  const held = createScopedPropagator({
    readRow: async (id) => { heldReads.push(id); return { row: { id, menu_name: 'From the database' }, error: null }; },
    propagate: async (rowIn) => { heldCopies.push(rowIn); return { ok: true }; },
    delay: 60000,
  });
  held.schedule(LATTE, ['menuName'], { id: LATTE, menu_name: 'Saved name' });
  held.schedule('m-other', ['archived']);
  held.flush((rowIn, keys) => fired.push({ rowIn, keys }));
  assert.deepEqual(fired, [{ rowIn: { id: LATTE, menu_name: 'Saved name' }, keys: ['menuName'] }]);
  assert.equal(held.isPending(LATTE), false);
  await held.whenIdle();
  assert.deepEqual(heldReads, ['m-other'], 'never this tab\'s copy: read from the database');
  assert.deepEqual(heldCopies, [{ id: 'm-other', menu_name: 'From the database' }]);
});
