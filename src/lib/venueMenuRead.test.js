// src/lib/venueMenuRead.test.js
//
// 27 Sep 2026, Peter: "I archived choc babychino but its still on the menu board". Push to POS
// and the Back Office load now share ONE fresh read of the venue's menu. These pin:
//   * a read that fails in any part is not ok (the push then sends nothing)
//   * an EMPTY tax read clears the rates (Leeds had none; the Back Office kept Train Station's)
//   * rows on screen that the database lacks are found (listed for the person, never sent silently)
//   * the tills' snapshot is the read, and tax rates carry their venue

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readVenueMenu, readAllRows, mergeReadRows, menuPatchFromRead, unsavedMenuRows, unsavedWords,
  menuSnapshotFromRead, parentsFirst, emptyItemsReadSuspect, venueItemCount, suspectReadWords,
} from './venueMenuRead.js';
import { mapTaxRateRow, venueTaxRates, mapMenuItemRow, mapModifierGroupRow, srvTimeOf, srvNewer } from './rowMapping.js';
import { insertModifierGroupOnce } from './modifierGroupWrite.js';
import { fakeMenuDb } from './fixtures/fakeMenuDb.js';

const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const TRAIN_STATION = '3f915972-7107-4f70-9b3d-de80ba9ab0c2';
const T0 = '2026-09-27T14:04:21.000+00:00';

const venue = (over = {}) => ({
  menus: [{ id: 'menu-main', location_id: LEEDS, name: 'Main', is_default: true, sort_order: 0, updated_at: T0 }],
  menu_categories: [{ id: 'cat-hot', location_id: LEEDS, menu_id: 'menu-main', label: 'Hot drinks', sort_order: 0, updated_at: T0 }],
  menu_items: [
    { id: 'm-latte', location_id: LEEDS, name: 'Latte', menu_name: 'Latte', pricing: { base: 3.1 }, archived: false, tax_rate_id: '6368f6fb', sort_order: 1, updated_at: T0 },
    { id: 'm-1790002933030_5c26956b', location_id: LEEDS, name: 'Choc Babyccino', menu_name: 'Choc Babyccino', pricing: { base: 2.2 }, archived: true, tax_rate_id: '6368f6fb', sort_order: 2, updated_at: T0 },
    { id: 'm-other-venue', location_id: TRAIN_STATION, name: 'Flat white', archived: false, sort_order: 1, updated_at: T0 },
  ],
  modifier_groups: [{ id: 'mgd-milk', location_id: LEEDS, name: 'Milk', min: 0, max: 1, selection_type: 'single', options: [{ id: 'o1', name: 'Oat', price: 0.4 }], sort_order: 0 }],
  tax_rates: [
    { id: '6368f6fb', location_id: LEEDS, name: 'Standard 20%', rate: '0.2', type: 'inclusive', is_default: true, active: true },
    { id: '6a159b5e', location_id: TRAIN_STATION, name: 'Standard 20%', rate: '0.2', type: 'inclusive', is_default: true, active: true },
  ],
  tax_profiles: [],
  tax_profile_lines: [],
  locations: [{ id: LEEDS, default_tax_profile_id: null }],
  ...over,
});

test('one read of the venue: this venue only, live products, every id, each row with its database time', async () => {
  const db = fakeMenuDb(venue());
  const r = await readVenueMenu(db, LEEDS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.menuItems.map((i) => i.id), ['m-latte'], 'live products of THIS venue only');
  assert.ok(r.itemIds.has('m-1790002933030_5c26956b'), 'an archived product is known to exist (never "unsaved")');
  assert.equal(r.menuItems[0].srvAt, T0);
  assert.equal(r.menuItems[0].taxRateId, '6368f6fb');
  assert.equal(r.menuCategories[0].menuId, 'menu-main');
  assert.equal(r.menus[0].isDefault, true);
  assert.equal(r.modifierGroupDefs[0].selectionType, 'single');
  assert.deepEqual(r.taxRates.map((t) => [t.id, t.locationId, t.rate]), [['6368f6fb', LEEDS, 0.2]]);
  assert.deepEqual(r.taxProfiles, []);
  assert.equal(r.venueDefaultTaxProfileId, null);
});

test('a read that fails in any part is not ok, and says which part (the push then sends nothing)', async () => {
  for (const table of ['menus', 'menu_categories', 'menu_items', 'modifier_groups', 'tax_rates']) {
    const db = fakeMenuDb(venue());
    db.hooks.readFail = (t) => t === table;
    const r = await readVenueMenu(db, LEEDS);
    assert.equal(r.ok, false, `${table} failing must fail the read`);
    assert.ok(r.failed.length >= 1);
    assert.ok(r.error);
  }
  // Tax profiles are optional: a failed profile read leaves them out, it never sends a guess.
  const db = fakeMenuDb(venue());
  db.hooks.readFail = (t) => t === 'tax_profiles';
  const r = await readVenueMenu(db, LEEDS);
  assert.equal(r.ok, true);
  assert.equal(r.taxProfiles, null);
  assert.ok(!('taxProfiles' in menuSnapshotFromRead(r)), 'absent is a no-op on a till');
  assert.equal((await readVenueMenu(null, LEEDS)).ok, false, 'no database, no read');
  assert.equal((await readVenueMenu(db, 'loc-demo')).ok, false, 'never the demo venue');
});

test('big menus are read page by page', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }));
  const make = () => ({ range: async (a, z) => ({ data: rows.slice(a, z + 1), error: null }) });
  const r = await readAllRows(make, { page: 2 });
  assert.deepEqual(r.rows.map((x) => x.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  const broken = () => ({ range: async (a) => (a >= 2 ? { data: null, error: { message: 'timeout' } } : { data: rows.slice(0, 2), error: null }) });
  const b = await readAllRows(broken, { page: 2 });
  assert.equal(b.rows, null, 'a failed page is a failed read, never a short menu');
});

test('an empty tax read CLEARS the rates: never "keep the last venue\'s"', () => {
  const state = { taxRates: [mapTaxRateRow({ id: '6a159b5e', location_id: TRAIN_STATION, name: 'Standard 20%', rate: '0.2', active: true })] };
  assert.deepEqual(menuPatchFromRead(state, { ok: true, taxRates: [] }).taxRates, []);
  // A FAILED tax read (null) leaves them alone.
  assert.ok(!('taxRates' in menuPatchFromRead(state, { ok: false, taxRates: null })));
});

test('the read wins on screen, except rows with a save of this tab on its way, and archived rows the Archived view loaded', () => {
  const local = [
    { id: 'a', name: 'mine', srvAt: 'x' },
    { id: 'b', name: 'stale' },
    { id: 'c', name: 'deleted elsewhere' },
    { id: 'd', name: 'archived', archived: true },
    { id: 'e', name: 'new, saving' },
  ];
  const read = [{ id: 'a', name: 'db a' }, { id: 'b', name: 'db b' }];
  const out = mergeReadRows(local, read, { keep: new Set(['a', 'e']), keepArchived: true });
  assert.deepEqual(out.map((r) => `${r.id}:${r.name}`), ['a:mine', 'b:db b', 'd:archived', 'e:new, saving']);
  const patch = menuPatchFromRead({ menuItems: local, menus: [], menuCategories: [] },
    { ok: true, menuItems: read, menus: null, menuCategories: [] }, { keep: { items: new Set(['a']) }, locationId: 'L' });
  assert.ok(!('menus' in patch), 'a part that did not read is left alone');
  assert.deepEqual(patch.menuCategories, [], 'a part that read as empty is empty');
  assert.equal(patch.menuReadLocationId, 'L');
});

test('rows on this screen the database lacks are listed, never mistaken for archived ones', async () => {
  const db = fakeMenuDb(venue());
  const read = await readVenueMenu(db, LEEDS);
  const store = {
    menus: [{ id: 'menu-main', name: 'Main' }, { id: 'menu-new', name: 'Brunch' }],
    menuCategories: [{ id: 'cat-hot', label: 'Hot drinks' }, { id: 'cat-new', label: 'Cold drinks' }],
    menuItems: [
      { id: 'm-latte', name: 'Latte' },
      { id: 'm-1790002933030_5c26956b', name: 'Choc Babyccino', archived: false },   // archived in the database
      { id: 'm-1790517373916', menuName: 'Milk' },                                   // never saved
      { id: 'm-gone', name: 'Old', archived: true },                                  // archived here: nothing to sell
    ],
  };
  const u = unsavedMenuRows(store, read);
  assert.deepEqual(u.menuItems.map((i) => i.id), ['m-1790517373916']);
  assert.deepEqual(u.menuCategories.map((c) => c.id), ['cat-new']);
  assert.deepEqual(u.menus.map((m) => m.id), ['menu-new']);
  assert.equal(u.total, 3);
  const words = unsavedWords(u);
  assert.match(words, /1 product \(Milk\)/);
  assert.match(words, /1 category \(Cold drinks\)/);
  assert.match(words, /Cancel stops the push: nothing is sent/);
  // A row that says it belongs to another venue (left in memory from an old push) is never
  // offered: saving it would copy another venue's product into this one. 27 Sep 2026 (review
  // round 3): nor is one that does not say; rows made in this tab carry their venue from birth.
  const mixed = {
    ...store,
    menuItems: [
      ...store.menuItems.map((i) => (i.id === 'm-1790517373916' ? { ...i, location_id: LEEDS } : i)),
      { id: 'm-ts-flat-white', name: 'Flat white', location_id: TRAIN_STATION },
    ],
  };
  assert.deepEqual(unsavedMenuRows(mixed, read, LEEDS).menuItems.map((i) => i.id), ['m-1790517373916']);
  assert.deepEqual(unsavedMenuRows(store, read, LEEDS).menuItems, [], 'a row with no venue is not offered to a venue');
});

test('the tills\' snapshot is the read: live products with their database time, this venue\'s rates', async () => {
  const db = fakeMenuDb(venue());
  const snap = menuSnapshotFromRead(await readVenueMenu(db, LEEDS));
  assert.deepEqual(Object.keys(snap).sort(), ['menuCategories', 'menuItems', 'menus', 'modifierGroupDefs', 'taxProfiles', 'taxRates', 'venueDefaultTaxProfileId'].sort());
  assert.ok(!snap.menuItems.some((i) => i.archived), 'Choc Babyccino, archived, is not sent');
  assert.ok(snap.taxRates.every((t) => t.locationId === LEEDS));
});

test('tax rates carry their venue; screens offer only the active venue\'s', () => {
  const rates = [
    mapTaxRateRow({ id: 'l20', location_id: LEEDS, rate: '0.2' }),
    mapTaxRateRow({ id: 't20', location_id: TRAIN_STATION, rate: '0.2' }),
    { id: 'old', name: 'from an old push', rate: 0.2 },   // no venue on it: nobody can tell whose
  ];
  assert.deepEqual(venueTaxRates(rates, LEEDS).map((r) => r.id), ['l20']);
  assert.deepEqual(venueTaxRates(rates, 'nowhere'), []);
  assert.deepEqual(venueTaxRates(null, LEEDS), []);
});

test('the database time is kept exactly as read, and compared across its two spellings', () => {
  const m = mapMenuItemRow({ id: 'x', updated_at: '2026-09-27T14:05:44.964123+00:00' });
  assert.equal(m.srvAt, '2026-09-27T14:05:44.964123+00:00', 'the raw string, never a Date');
  assert.equal(srvTimeOf('2026-09-27 14:05:44.964+00'), srvTimeOf('2026-09-27T14:05:44.964+00:00'), 'realtime and Data API spellings');
  assert.ok(Number.isNaN(srvTimeOf(null)));
  assert.equal(srvNewer({ srvAt: '2026-09-27T14:05:45Z' }, { srvAt: '2026-09-27T14:05:44Z' }), true);
  assert.equal(srvNewer({ srvAt: null }, { srvAt: '2026-09-27T14:05:44Z' }), false, 'unknown is never newer');
});

test('parents first, so a sub category never lands before its parent', () => {
  const out = parentsFirst([{ id: 'draught', parentId: 'beer' }, { id: 'beer' }, { id: 'wine' }]);
  assert.deepEqual(out.map((c) => c.id), ['beer', 'draught', 'wine']);
});

// ── Review round 3 (27 Sep 2026) ────────────────────────────────────────────────────────────

test('an EMPTY product read while this screen holds this venue\'s products is suspect: nothing is applied', async () => {
  const onScreen = (await readVenueMenu(fakeMenuDb(venue()), LEEDS));
  const state = { menuItems: onScreen.menuItems, menuCategories: onScreen.menuCategories, menus: onScreen.menus, taxRates: onScreen.taxRates };
  // Row level security narrowed: every read answers with no rows and no error.
  const narrowed = await readVenueMenu(fakeMenuDb(venue({ menus: [], menu_categories: [], menu_items: [], tax_rates: [] })), LEEDS);
  assert.equal(narrowed.ok, true, 'no error: that is the trap');
  assert.equal(emptyItemsReadSuspect(state, narrowed, LEEDS), true);
  assert.deepEqual(menuPatchFromRead(state, narrowed, { locationId: LEEDS }), {}, 'the menu on screen stays, categories and menus too');
  assert.equal(venueItemCount(state, LEEDS), 1);
  assert.match(suspectReadWords(1), /NO products for this venue, but this screen has 1/);
});

test('an empty product read is NOT suspect for a new venue, a failed first save, or products all archived elsewhere', async () => {
  const empty = await readVenueMenu(fakeMenuDb(venue({ menu_items: [] })), LEEDS);
  // A new venue: this screen holds only another venue's products (or none).
  const other = { menuItems: [mapMenuItemRow({ id: 'm-ts', location_id: TRAIN_STATION, updated_at: T0 })] };
  assert.equal(emptyItemsReadSuspect(other, empty, LEEDS), false);
  assert.deepEqual(menuPatchFromRead(other, empty, { locationId: LEEDS }).menuItems, [], 'applied: the new venue shows no products');
  assert.equal(emptyItemsReadSuspect({ menuItems: [] }, empty, LEEDS), false);
  // A product made here whose first save failed has no database time.
  const unsaved = { menuItems: [{ id: 'm-new', name: 'Milk', location_id: LEEDS }] };
  assert.equal(emptyItemsReadSuspect(unsaved, empty, LEEDS), false);
  // The venue's first product, saved after the read began: the read cannot have seen it.
  const first = { menuItems: [{ id: 'm-new', name: 'Milk', location_id: LEEDS, srvAt: T0 }] };
  assert.equal(emptyItemsReadSuspect(first, empty, LEEDS), true, 'without the write clock it looks suspect');
  assert.equal(emptyItemsReadSuspect(first, empty, LEEDS, { keep: new Set(['m-new']) }), false);
  assert.deepEqual(menuPatchFromRead(first, empty, { keep: { items: new Set(['m-new']) }, locationId: LEEDS }).menuItems.map((i) => i.id), ['m-new']);
  // Every product archived in another window: the live read is empty, the id read is not.
  const archivedAll = await readVenueMenu(fakeMenuDb(venue({ menu_items: [
    { id: 'm-latte', location_id: LEEDS, name: 'Latte', archived: true, sort_order: 1, updated_at: T0 },
  ] })), LEEDS);
  const held = { menuItems: [mapMenuItemRow({ id: 'm-latte', location_id: LEEDS, name: 'Latte', archived: false, updated_at: T0 })] };
  assert.equal(emptyItemsReadSuspect(held, archivedAll, LEEDS), false);
  assert.deepEqual(menuPatchFromRead(held, archivedAll, { locationId: LEEDS }).menuItems, [], 'the archive made elsewhere shows');
  // A non empty read is never suspect.
  const full = await readVenueMenu(fakeMenuDb(venue()), LEEDS);
  assert.equal(emptyItemsReadSuspect(held, full, LEEDS), false);
});

test('a venue switch: rows kept for a save on its way never follow the person into another venue', () => {
  const local = [
    { id: 'a', name: 'Leeds, saving', location_id: LEEDS },
    { id: 'b', name: 'Train Station, saving', location_id: TRAIN_STATION },
    { id: 'c', name: 'Train Station, archived', location_id: TRAIN_STATION, archived: true },
    { id: 'd', name: 'no venue on it, saving' },
  ];
  const keep = new Set(['a', 'b', 'd']);
  const out = mergeReadRows(local, [], { keep, keepArchived: true, locationId: LEEDS });
  assert.deepEqual(out.map((r) => r.id), ['a', 'd'], 'another venue\'s kept and archived rows are dropped');
  // Without a venue the old rule stands.
  assert.deepEqual(mergeReadRows(local, [], { keep, keepArchived: true }).map((r) => r.id), ['a', 'b', 'c', 'd']);
  // The whole patch: menus, categories, products and modifier groups all follow the rule.
  const state = {
    menus: [{ id: 'menu-ts', location_id: TRAIN_STATION }],
    menuCategories: [{ id: 'cat-ts', location_id: TRAIN_STATION }],
    menuItems: [{ id: 'm-ts', location_id: TRAIN_STATION, srvAt: T0 }],
    modifierGroupDefs: [mapModifierGroupRow({ id: 'mgd-ts', location_id: TRAIN_STATION, name: 'Syrups' })],
  };
  const keepAll = { menus: new Set(['menu-ts']), categories: new Set(['cat-ts']), items: new Set(['m-ts']), groups: new Set(['mgd-ts']) };
  const patch = menuPatchFromRead(state, { ok: true, menus: [], menuCategories: [], menuItems: [], itemIds: new Set(), modifierGroupDefs: [] }, { keep: keepAll, locationId: LEEDS });
  assert.deepEqual([patch.menus, patch.menuCategories, patch.menuItems, patch.modifierGroupDefs], [[], [], [], []]);
  assert.equal(patch.menuReadLocationId, LEEDS);
});

test('Push to POS offers only this venue\'s rows, and modifier groups only when their own first save failed', async () => {
  const read = await readVenueMenu(fakeMenuDb(venue()), LEEDS);
  const store = {
    menus: [{ id: 'menu-ts-new', name: 'TS brunch', location_id: TRAIN_STATION }, { id: 'menu-new', name: 'Brunch', location_id: LEEDS }],
    menuCategories: [{ id: 'cat-ts-new', label: 'TS cold', location_id: TRAIN_STATION }, { id: 'cat-new', label: 'Cold drinks', location_id: LEEDS }],
    menuItems: [],
    modifierGroupDefs: [
      mapModifierGroupRow({ id: 'mgd-milk', location_id: LEEDS, name: 'Milk' }),        // in the database
      { id: 'mgd-syrups', name: 'Syrups', location_id: LEEDS },                         // first save failed
      { id: 'mgd-deleted', name: 'Deleted elsewhere', location_id: LEEDS },              // not in the read, never failed here
      { id: 'mgd-ts', name: 'TS sauces', location_id: TRAIN_STATION },                  // another venue's
    ],
  };
  const failedGroupIds = new Set(['mgd-syrups', 'mgd-ts']);
  const u = unsavedMenuRows(store, read, LEEDS, { failedGroupIds });
  assert.deepEqual(u.menus.map((m) => m.id), ['menu-new']);
  assert.deepEqual(u.menuCategories.map((c) => c.id), ['cat-new']);
  assert.deepEqual(u.modifierGroupDefs.map((g) => g.id), ['mgd-syrups'], 'a group deleted in another window never comes back');
  assert.equal(u.total, 3);
  assert.match(unsavedWords(u), /1 modifier group \(Syrups\)/);
  assert.deepEqual(unsavedMenuRows(store, read, LEEDS).modifierGroupDefs, [], 'no failed first saves: no groups offered');
});

test('a modifier group whose first save failed is saved insert only, before and after the migration', async () => {
  const group = { id: 'mgd-syrups', name: 'Syrups', min: 0, max: 2, selectionType: 'multi', options: [{ id: 'o1', name: 'Vanilla', price: 0.5 }], sortOrder: 3, location_id: LEEDS };
  // After the migration the table has updated_at.
  const db = fakeMenuDb(venue());
  const r = await insertModifierGroupOnce({ client: db, locationId: LEEDS, group });
  assert.equal(r.outcome, 'created');
  assert.equal(db.row('modifier_groups', 'mgd-syrups').selection_type, 'multi');
  assert.equal(db.row('modifier_groups', 'mgd-syrups').location_id, LEEDS);
  // Never overwrites a group that is there.
  const again = await insertModifierGroupOnce({ client: db, locationId: LEEDS, group: { ...group, name: 'Changed' } });
  assert.equal(again.outcome, 'exists');
  assert.equal(db.row('modifier_groups', 'mgd-syrups').name, 'Syrups');
  // Before the migration: no updated_at column, so the stamp is dropped and the rest saved.
  const old = fakeMenuDb(venue());
  const client = { from: (t) => {
    const q = old.from(t);
    const upsert = q.upsert;
    q.upsert = (row, o) => ('updated_at' in row
      ? { select: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'updated_at' column of 'modifier_groups' in the schema cache" } }) }
      : upsert(row, o));
    return q;
  } };
  const r2 = await insertModifierGroupOnce({ client, locationId: LEEDS, group });
  assert.equal(r2.outcome, 'created');
  assert.equal(r2.note, 'no-updated-at-column');
  // A group made at another venue is never saved here.
  const wrong = await insertModifierGroupOnce({ client: db, locationId: TRAIN_STATION, group: { ...group, id: 'mgd-x' } });
  assert.equal(wrong.ok, false);
  assert.equal(db.row('modifier_groups', 'mgd-x'), undefined);
});
