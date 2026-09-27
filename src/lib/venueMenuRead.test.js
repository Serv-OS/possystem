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
  menuSnapshotFromRead, parentsFirst,
} from './venueMenuRead.js';
import { mapTaxRateRow, venueTaxRates, mapMenuItemRow, srvTimeOf, srvNewer } from './rowMapping.js';
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
  // offered: saving it would copy another venue's product into this one.
  const mixed = { ...store, menuItems: [...store.menuItems, { id: 'm-ts-flat-white', name: 'Flat white', location_id: TRAIN_STATION }] };
  assert.deepEqual(unsavedMenuRows(mixed, read, LEEDS).menuItems.map((i) => i.id), ['m-1790517373916']);
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
