// Multi site menu: the push a publish sends (supabase/functions/_shared/msmSnapshot.js) and the
// server's copy of the Push to POS core (supabase/functions/_shared/venueMenuCore.js).
//
// The copy exists because src/lib/rowMapping.js and src/lib/venueMenuRead.js are pinned by source
// tests and must not move this release. THESE TESTS KEEP THE TWO COPIES EQUAL: change a mapper in
// src/lib and one of them fails until venueMenuCore.js says the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../../supabase/functions/_shared/venueMenuCore.js';
import * as srcMap from '../rowMapping.js';
import { readVenueMenu, menuSnapshotFromRead as srcSnapshot, withItemExtras as srcExtras } from '../venueMenuRead.js';
import { ITEM_EXTRA_KEYS as SRC_EXTRA_KEYS } from '../menuItemWrite.js';
import { taggedVenueRows as srcTagged } from '../venueTaxRates.js';
import { buildMsmSnapshot, appliedRaw, CARRY_KEYS, LEFT_OUT_KEYS } from '../../../supabase/functions/_shared/msmSnapshot.js';
import { fakeClient } from './fakeClient.js';
import { venues, A } from './msmFixture.js';

const odd = [
  null, {}, { id: 'x' }, { id: 'snake', is_default: true, sort_order: 3, menu_name: 'M', receipt_name: null, pricing: { base: 1 }, item_code: null, tags: 'no' },
  { id: 'camel', isDefault: false, isActive: false, sortOrder: 2, menuName: 'Camel', price: 4, parentId: 'p', taxRateId: 't', srvAt: 'when' },
  { id: 'mixed', is_default: true, isDefault: false, item_code: 'AB1', updated_at: '2026-10-01T10:00:00+00:00', assigned_modifier_groups: [{ groupId: 'g' }] },
  { id: 'g1', name: 'Milk', selection_type: 'multi', options: [{ id: 'o' }], location_id: 'L', min: 1 },
  { id: 'r1', name: 'VAT', rate: '20.000', applies_to: null, is_default: true, active: true, location_id: 'L' },
];

test('every mapper in the server copy gives the same answer as src/lib/rowMapping.js', () => {
  const v = venues();
  const rows = [...odd, ...v[A].items, ...v[A].categories, ...v[A].menus, ...v[A].groups, ...v[A].taxRates];
  for (const name of ['normaliseMenuRow', 'mapMenuItemRow', 'mapCategoryRow', 'mapMenuRow', 'mapModifierGroupRow', 'mapTaxRateRow', 'normaliseTaxProfileLineRow']) {
    for (const r of rows) assert.deepEqual(core[name](r), srcMap[name](r), `${name} differs for ${JSON.stringify(r)}`);
  }
  const profiles = [{ id: 'p1', name: 'US', sort_order: 1 }, { id: 'p2', sortOrder: 0, lines: [{ id: 'l0', rate: 1 }] }];
  const lines = [{ id: 'l1', profile_id: 'p1', rate: '8.25', mode: 'inclusive', order_types: [], tax_service_charge: true }];
  assert.deepEqual(core.assembleTaxProfiles(profiles, lines), srcMap.assembleTaxProfiles(profiles, lines));
});

test('ITEM_EXTRA_KEYS, withItemExtras and taggedVenueRows are the same in both copies', () => {
  assert.deepEqual([...core.ITEM_EXTRA_KEYS], [...SRC_EXTRA_KEYS]);
  const rows = [{ id: 'a' }, { id: 'b', variantLabel: 'Own' }, { id: 'c' }];
  const from = [{ id: 'a', variantLabel: 'Regular', hidden: true }, { id: 'b', variantLabel: 'Theirs' }];
  assert.deepEqual(core.withItemExtras(rows, from), srcExtras(rows, from));
  const tagged = [{ id: 1, location_id: 'L' }, { id: 2, locationId: 'M' }, { id: 3 }];
  assert.deepEqual(core.taggedVenueRows(tagged, 'L'), srcTagged(tagged, 'L'));
});

test('BYTE EQUAL: the menu part for the same rows is what Push to POS builds from readVenueMenu', async () => {
  const v = venues()[A];
  const archived = { ...v.items[0], id: 'm-old', archived: true };
  const client = fakeClient({
    menus: v.menus, menu_categories: v.categories, menu_items: [...v.items, archived], modifier_groups: v.groups,
    tax_rates: v.taxRates, tax_profiles: [], tax_profile_lines: [], locations: [{ id: A, default_tax_profile_id: null, org_id: 'o', name: 'Site A', timezone: 'Europe/London' }],
    menu_category_links: v.links, print_routing: [v.printRouting], printers: v.printers,
  });
  const srcRead = await readVenueMenu(client, A);
  assert.equal(srcRead.ok, true, srcRead.failed.join());
  const raw = await core.readVenueRaw(client, A);
  assert.equal(raw.ok, true, raw.failed.join());
  assert.equal(raw.items.length, v.items.length + 1, 'publish reads archived products too (it may turn one back on)');
  const extras = [{ id: 'm-latte', variantLabel: 'Regular' }];
  const a = JSON.stringify(srcSnapshot(srcRead, { extrasFrom: extras }));
  const b = JSON.stringify(core.menuSnapshotFromRead(core.menuReadFromRaw(raw), { extrasFrom: extras }));
  assert.equal(b, a);
});

test('the push: menu from the applied rows, routing and printers from the database, browser owned keys carried, risky keys left out', () => {
  const raw = { ...venues()[A], location: { default_tax_profile_id: null } };
  const last = {
    locationId: A, instructionGroupDefs: [{ id: 'ig' }], locationSections: ['Bar'], profiles: [{ id: 'p' }], discountPresets: [{ id: 'd', locationId: A }],
    packages: [], bookingRules: { x: 1 }, takeawayCustomerDetails: 'name',
    tables: [{ id: 't1' }], tableTombstones: {}, tablePlan: { v: 2 }, quickScreenIds: ['m-latte'], quickScreenMode: 'auto', quickScreenAuto: {}, changeCount: 4,
    printRouting: { centres: [{ id: 'OLD' }], routing: {} }, printers: [{ id: 'OLD' }],
    menuItems: [{ id: 'm-latte', variantLabel: 'Regular' }],
  };
  const snap = buildMsmSnapshot({ raw, last, pushSource: { versionId: 'v1', title: 'Rise', applyWhenIdle: true }, pushedBy: 'Multi site menu: Editor', now: 1790000000000 });
  for (const k of CARRY_KEYS) assert.deepEqual(snap[k], last[k], `${k} carried`);
  for (const k of LEFT_OUT_KEYS) assert.equal(k in snap, false, `${k} left out (absent is a no-op on a till)`);
  assert.equal(snap.printRouting.centres[0].id, 'pc-k', 'routing from the database wins over the last push');
  assert.equal(snap.printers[0].id, 'prn-1');
  assert.equal(snap.printers[0].connectionType, 'network');
  assert.deepEqual(snap.pushSource, { kind: 'msm', versionId: 'v1', title: 'Rise', applyWhenIdle: true });
  assert.equal(snap.locationId, A);
  assert.equal(snap.version, 1790000000000);
  assert.equal(snap.menuItems.find((i) => i.id === 'm-latte').variantLabel, 'Regular', 'fields with no column come from the last push');
  assert.ok(snap.taxRates.every((r) => r.locationId === A), 'this venue\'s own rates only');
});

test('a failed routing read keeps the last push\'s routing; a venue with no push gets a menu only push', () => {
  const raw = { ...venues()[A] };
  const s1 = buildMsmSnapshot({ raw, last: { printRouting: { centres: [{ id: 'LAST' }] }, printers: [{ id: 'LASTP' }] }, routingRead: false, printersRead: false });
  assert.equal(s1.printRouting.centres[0].id, 'LAST');
  assert.equal(s1.printers[0].id, 'LASTP');
  const s2 = buildMsmSnapshot({ raw: { ...raw, printRouting: null, printers: [] }, last: null });
  for (const k of [...CARRY_KEYS, ...LEFT_OUT_KEYS, 'printRouting']) assert.equal(k in s2, false, `${k} absent`);
  assert.ok(Array.isArray(s2.menuItems) && s2.menuItems.length > 0);
});

test('appliedRaw lays a plan\'s rows over the read, keeping tax and printers', () => {
  const raw = venues()[A];
  const plan = { applied: { items: [{ id: 'only', archived: false }], menus: raw.menus, categories: raw.categories, links: raw.links, groups: [], printRouting: null } };
  const out = appliedRaw(raw, plan);
  assert.deepEqual(out.items, [{ id: 'only', archived: false }]);
  assert.equal(out.taxRates, raw.taxRates);
  assert.equal(out.printRouting, null);
});
