// 5.12.119: AN OPTION CAN BE HIDDEN PER SCREEN, A SUB ITEM CAN BE 86'D, AND THE ASSISTANT TELLS THE TRUTH.
//
// Peter, 27 Nov 2026 (Mozz, the first US group, setting up Beverage options):
//   1. "I cannot hide a subitem from options for example the beverage options they have dine in
//      soda which needs to not show on ordering online etc but does need to show on the POS"
//   2. "I also cant find a way to 86 a sub item!"
//   3. "and the Ai said its done it but doesnt"
//
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  optionHiddenOn, optionLinkId, groupsShownOn, notShownOn, withNotShownOn, applyNotShownOn, holdsNotShownOn, toggleShownOn,
} from './soldAs.js';
import { itemOptionGroups } from './menuRules.js';
import { find86Target, propose86, confirm86 } from './ai86.js';
import { buildCatalog } from '../../supabase/functions/_shared/hubrise-map.ts';
import { proposeImport, buildCentral } from '../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords } from '../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../supabase/functions/_shared/msmDiff.js';
import { productUpdate } from './msm/msmEdit.js';
import { A, B, ORG, idGen } from './msm/msmFixture.js';
import { groupVenues, groupSites } from './msm/msmGroupFixture.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OFF = { pos: false, kiosk: false, online: false, onlineDelivery: false };

// The Mozz shape: a drinks group whose options are sub items that are only options (every switch off).
const soda = { id: 'sub-soda', name: 'Dine in soda', type: 'subitem', soldAlone: false, visibility: { ...OFF, notShownOn: ['online', 'onlineDelivery'] } };
const water = { id: 'sub-water', name: 'Bottled water', type: 'subitem', soldAlone: false, visibility: { ...OFF } };
const kioskOnly = { id: 'sub-cup', name: 'Kiosk cup', type: 'subitem', soldAlone: false, visibility: { ...OFF, notShownOn: ['pos'] } };
const items = [soda, water, kioskOnly, { id: 'p-meal', name: 'Meal deal', type: 'modifiable', assignedModifierGroups: [{ groupId: 'g-bev' }] }];
const bev = { id: 'g-bev', name: 'Beverage options', min: 1, max: 1, options: [
  { id: 'o1', name: 'Dine in soda', itemId: 'sub-soda' },
  { id: 'o2', name: 'Bottled water', item_id: 'sub-water' },
  { id: 'o3', name: 'No drink' },
] };

test('the rule: only head office\'s list hides an option, never the plain switches', () => {
  // Every switch is off on a sub item that is only an option (303 of them live on 27 Nov 2026).
  // That must NOT hide it as an option.
  for (const screen of ['pos', 'bar', 'mpos', 'kiosk', 'online', 'qr', 'catering', 'hubrise']) assert.equal(optionHiddenOn(water, screen), false, screen);
  assert.equal(optionHiddenOn(null, 'online'), false, 'a plain option with no product behind it is never hidden');
  // Dine in soda: off Online (and QR and catering, which read Online) and Delivery, on the POS and kiosk.
  assert.equal(optionHiddenOn(soda, 'pos'), false);
  assert.equal(optionHiddenOn(soda, 'mpos'), false);
  assert.equal(optionHiddenOn(soda, 'kiosk'), false);
  assert.equal(optionHiddenOn(soda, 'online'), true);
  assert.equal(optionHiddenOn(soda, 'qr'), true);
  assert.equal(optionHiddenOn(soda, 'catering'), true);
  assert.equal(optionHiddenOn(soda, 'hubrise'), true);
  // Delivery alone: shown for collection online, left out for a delivery order and on the platforms.
  const del = { id: 'x', visibility: { ...OFF, notShownOn: ['onlineDelivery'] } };
  assert.equal(optionHiddenOn(del, 'online', 'collection'), false);
  assert.equal(optionHiddenOn(del, 'online', 'delivery'), true);
  assert.equal(optionHiddenOn(del, 'hubrise'), true);
  assert.equal(optionHiddenOn(del, 'pos'), false);
  assert.equal(optionHiddenOn(kioskOnly, 'pos'), true);
  assert.equal(optionLinkId({ itemId: 'a' }), 'a');
  assert.equal(optionLinkId({ item_id: 'b' }), 'b');
  assert.equal(optionLinkId({ name: 'plain' }), null);
});

test('the groups a screen asks: the hidden option is gone, the rest untouched, an empty group is not asked', () => {
  const groups = [bev, { id: 'g-other', name: 'Sauce', options: [{ id: 's1', name: 'Ketchup' }] }];
  assert.equal(groupsShownOn(groups, items, 'pos').find((g) => g.id === 'g-bev').options.length, 3, 'the POS still offers Dine in soda');
  assert.equal(groupsShownOn(groups, items, 'kiosk'), groups, 'nothing hidden: the same list comes back (a screen\'s memo stays still)');
  const online = groupsShownOn(groups, items, 'online');
  assert.deepEqual(online.find((g) => g.id === 'g-bev').options.map((o) => o.name), ['Bottled water', 'No drink']);
  assert.equal(online.find((g) => g.id === 'g-other'), groups[1], 'a group nothing was taken from is the same object');
  assert.equal(bev.options.length, 3, 'the venue\'s own group is never changed');
  // A Map of rows reads the same as a list.
  assert.deepEqual(groupsShownOn(groups, new Map(items.map((i) => [i.id, i])), 'qr').find((g) => g.id === 'g-bev').options.length, 2);
  // Every option hidden: the group is not asked at all.
  const only = [{ id: 'g1', name: 'Soda', min: 1, options: [{ id: 'o', name: 'Dine in soda', itemId: 'sub-soda' }] }];
  assert.deepEqual(groupsShownOn(only, items, 'online'), []);
  assert.equal(groupsShownOn(only, [], 'online'), only, 'no menu rows loaded: nothing is hidden by mistake');
  assert.equal(groupsShownOn(null, items, 'online'), null);
});

test('the delivery platforms: a hidden option never goes into the catalogue, and a group never asks for more picks than it has left', () => {
  const cat = [{ id: 'c1', name: 'Meals' }];
  const rows = [
    { id: 'p-meal', name: 'Meal deal', cat: 'c1', type: 'modifiable', pricing: { base: 10 }, assigned_modifier_groups: [{ groupId: 'g-bev' }] },
    { ...soda, pricing: { base: 0 } }, { ...water, pricing: { base: 0 } },
  ];
  const out = buildCatalog({ categories: cat, items: rows, modifierGroups: [bev], currency: 'USD' });
  const list = out.option_lists.find((l) => l.ref === 'g-bev');
  assert.ok(list, 'the group is still published');
  assert.deepEqual(list.options.map((o) => o.name), ['Bottled water', 'No drink']);
  const one = buildCatalog({ categories: cat, items: rows, modifierGroups: [{ ...bev, min: 3 }], currency: 'USD' }).option_lists.find((l) => l.ref === 'g-bev');
  assert.equal(one.min_selections, 2);
  // Every switch off and no list: still an option on the platforms, as before.
  const before = buildCatalog({ categories: cat, items: [rows[0], { ...soda, visibility: { ...OFF }, pricing: { base: 0 } }, rows[2]], modifierGroups: [bev], currency: 'USD' }).option_lists.find((l) => l.ref === 'g-bev');
  assert.equal(before.options.length, 3);
});

test('a publish from the group menu writes ONLY the list on a sub item that is only an option', () => {
  assert.deepEqual(applyNotShownOn({ ...OFF }, ['online'], { listOnly: true }), { ...OFF, notShownOn: ['online'] });
  // Taking it off the list never turns a switch ON (it is still never a product on a screen).
  assert.deepEqual(applyNotShownOn({ ...OFF, notShownOn: ['online'] }, [], { listOnly: true }), { ...OFF });
  assert.equal(holdsNotShownOn({ visibility: { ...OFF, notShownOn: ['online'] } }, ['online'], { listOnly: true }), true);
  assert.equal(holdsNotShownOn({ visibility: { ...OFF } }, ['online'], { listOnly: true }), false);
  // A normal product is as it was in 5.12.116: the switches follow the list.
  assert.deepEqual(applyNotShownOn({ pos: true, kiosk: true, online: true, onlineDelivery: true }, ['online']), { pos: true, kiosk: true, online: false, onlineDelivery: true, notShownOn: ['online'] });
  assert.deepEqual(applyNotShownOn({ pos: true, kiosk: true, online: false, onlineDelivery: true, notShownOn: ['online'] }, []), { pos: true, kiosk: true, online: true, onlineDelivery: true });

  // End to end on the fixture group menu: Oat milk is a sub item that is only an option.
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  const oat = central.products.find((p) => p.type === 'subitem' && p.sold_alone !== true && !p.archived && [A, B].every((loc) => central.productSites.some((s) => s.product_id === p.id && s.location_id === loc)));
  assert.ok(oat, 'the fixture has an option only sub item at both sites');
  const ctx = { live: central, eff: central };
  const r = productUpdate(ctx, oat.id, { visibility: toggleShownOn(toggleShownOn(oat.visibility ?? null, 'online', false), 'onlineDelivery', false) });
  assert.ok(r.change, r.words);
  assert.deepEqual(notShownOn({ visibility: r.change.after.visibility }), ['online', 'onlineDelivery']);
  for (const loc of [A, B]) {
    const plan = planSite({ central: applyChanges(central, [r.change]).central, touched: touchedFromChanges([r.change]), locationId: loc, orgId: ORG, venue: v[loc] });
    assert.equal(plan.problems.filter((x) => x.level === 'block').length, 0, JSON.stringify(plan.problems));
    const writes = plan.lines.filter((l) => l.column === 'visibility');
    assert.equal(plan.lines.length, 1, `one write at the site, nothing else: ${JSON.stringify(plan.lines.map((l) => [l.table, l.column]))}`);
    assert.equal(writes.length, 1);
    const venueRow = v[loc].items.find((i) => i.id === central.productSites.find((s) => s.product_id === oat.id && s.location_id === loc).venue_item_id);
    const before = venueRow.visibility || {};
    for (const k of ['pos', 'kiosk', 'online', 'onlineDelivery']) assert.equal(writes[0].after[k], before[k], `the ${k} switch is left as the site has it`);
    assert.deepEqual(writes[0].after.notShownOn, ['online', 'onlineDelivery']);
    assert.match(lineWords(writes[0], {}), /now hidden on Online and Delivery as an option/);
  }
});

test('86: a product\'s options are listed for the POS long press panel, each with the sub item to 86', () => {
  const defs = [
    { ...bev, options: [...bev.options, { id: 'o4', name: 'Coffee', itemId: 'sub-coffee', subGroupId: 'g-milk' }] },
    { id: 'g-milk', name: 'Milk', options: [{ id: 'm1', name: 'Oat', itemId: 'sub-oat' }, { id: 'm2', name: 'Gone', itemId: 'sub-archived' }] },
    { id: 'g-size-only', name: 'Extras', options: [{ id: 'e1', name: 'Shot', itemId: 'sub-shot' }] },
  ];
  const rows = [...items,
    { id: 'sub-coffee', name: 'Coffee', type: 'subitem' }, { id: 'sub-oat', name: 'Oat milk', type: 'subitem' }, { id: 'sub-archived', name: 'Gone', type: 'subitem', archived: true },
    { id: 'sub-shot', name: 'Shot', type: 'subitem' },
    { id: 'p-meal-large', name: 'Large', parentId: 'p-meal', assignedModifierGroups: ['g-size-only'] },
  ];
  const out = itemOptionGroups(rows.find((r) => r.id === 'p-meal'), rows, defs);
  assert.deepEqual(out.map((g) => [g.name, g.options.map((o) => o.itemId)]), [
    ['Beverage options', ['sub-soda', 'sub-water', 'sub-coffee']],        // "No drink" has no product behind it: nothing to 86
    ['Extras', ['sub-shot']],                                             // a group one of its sizes asks
    ['Milk', ['sub-oat']],                                                // a group an option opens; an archived row is left out
  ]);
  assert.deepEqual(itemOptionGroups({ id: 'p-none', name: 'Plain' }, rows, defs), []);
  // An older option with no link: the sub item of the same name (how every screen greys an 86'd option).
  const byName = itemOptionGroups({ id: 'p-x', assignedModifierGroups: ['g-old'] }, rows, [{ id: 'g-old', name: 'Sides', options: [{ id: 'x1', name: 'shot' }, { id: 'x2', name: 'Meal deal' }] }]);
  assert.deepEqual(byName, [{ id: 'g-old', name: 'Sides', options: [{ itemId: 'sub-shot', name: 'shot' }] }], 'a product of that name is not an option row');
  const panel = read('../components/ItemInfoModal.jsx');
  assert.match(panel, /itemOptionGroups\(item, menuItems, modifierGroupDefs\)/);
  assert.match(panel, /data-testid="item-info-option-86" onClick=\{\(\) => \{ toggle86\(o\.itemId\);/);
});

test('86: the Back Office Daily counts screen lists sub items, with an Options filter', () => {
  const inv = read('../backoffice/sections/Inventory.jsx');
  assert.match(inv, /\.filter\(i => !i\.archived && i\.type !== 'spacer' && !meta\.parents\.has\(String\(i\.id\)\)\)\n\s+\.map\(i => \(\{/, 'sub items are no longer left out of the 86 list');
  assert.match(inv, /isOption: i\.type === 'subitem'/);
  assert.match(inv, /\{id:OPTIONS_FILTER,label:'Options \(sub items\)'\}/);
});

test('the assistant finds the real row for an 86, options included, and never guesses between two', () => {
  const menu = [...items, { id: 'p-water', name: 'Bottled water', type: 'simple', cat: 'c-drinks' }, { id: 'gone', name: 'Old soda', archived: true }];
  const ctx = { menuCategories: [{ id: 'c-drinks', label: 'Drinks' }], modifierGroupDefs: [bev] };
  // A sub item by name (the case that failed: the model had no id for it and made one up).
  assert.deepEqual([find86Target(menu, { item_name: 'dine in soda' }, ctx).item.id, find86Target(menu, { item_name: 'dine in soda' }, ctx).kind], ['sub-soda', 'option']);
  // A made up id is ignored and the name is used.
  assert.equal(find86Target(menu, { item_id: 'item-12345', item_name: 'Dine in soda' }, ctx).item.id, 'sub-soda');
  assert.equal(find86Target(menu, { item_id: 'sub-water' }, ctx).item.id, 'sub-water', 'a real id is taken as it is');
  assert.equal(find86Target(menu, { item_name: 'kiosk' }, ctx).item.id, 'sub-cup', 'one row holds the words');
  // Two rows with the name (a product and an option): never guessed, both offered with their ids.
  const two = find86Target(menu, { item_name: 'Bottled water' }, ctx);
  assert.equal(two.item, null);
  assert.deepEqual(two.choices.map((c) => [c.item_id, c.what]), [['sub-water', 'an option in Beverage options'], ['p-water', 'a product in Drinks']]);
  assert.match(two.words, /Nothing was changed/);
  assert.match(find86Target(menu, { item_name: 'Old soda' }, ctx).words, /Nothing on the menu is called "Old soda"/);
  assert.match(find86Target(menu, {}, ctx).words, /Nothing was changed/);
});

test('the assistant only says "86\'d" when the 86 list holds the row afterwards', () => {
  const state = { menuItems: items, menuCategories: [], modifierGroupDefs: [bev], eightySixIds: [] };
  // Proposing: the real id goes into the action, never the model's guess.
  const proposed = propose86({ item_id: 'made-up', item_name: 'Dine in soda' }, state);
  assert.deepEqual(proposed.pendingAction.payload, { item_id: 'sub-soda', item_name: 'Dine in soda' });
  assert.match(proposed.result.message, /NOT 86'd yet/);
  const none = propose86({ item_id: 'made-up', item_name: 'Lemonade' }, state);
  assert.equal(none.pendingAction, undefined, 'nothing to confirm when nothing was found');
  assert.equal(none.result.nothing_changed, true);
  const already = propose86({ item_name: 'Dine in soda' }, { ...state, eightySixIds: ['sub-soda'] });
  assert.equal(already.pendingAction, undefined, 'already 86\'d: never proposed (the switch would turn it back ON)');
  assert.match(already.result.message, /already 86'd/);

  // Confirming, against a small store.
  const store = { ids: [], flips: 0 };
  const actions = (over = {}) => ({
    toggle86: (id) => { store.flips += 1; store.ids = store.ids.includes(id) ? store.ids.filter((x) => x !== id) : [...store.ids, id]; },
    getMenuItems: () => items, getEightySixIds: () => store.ids, ...over,
  });
  const ok = confirm86(proposed.pendingAction.payload, actions());
  assert.deepEqual([ok.ok, store.ids, ok.message], [true, ['sub-soda'], '"Dine in soda" has been 86\'d']);
  // Confirmed twice: left 86'd, never flipped back on.
  const again = confirm86(proposed.pendingAction.payload, actions());
  assert.deepEqual([again.ok, store.ids, store.flips], [true, ['sub-soda'], 1]);
  assert.match(again.message, /already 86'd/);
  // An id that is not on the menu: refused in words, nothing flipped.
  const bad = confirm86({ item_id: 'made-up', item_name: 'Lemonade' }, actions());
  assert.deepEqual([bad.ok, store.flips], [false, 1]);
  assert.match(bad.error, /Could not find "Lemonade" on the menu\. Nothing was changed\./);
  // The 86 did not take (the list does not hold it afterwards): it says so, it does not say done.
  store.ids = [];
  const failed = confirm86(proposed.pendingAction.payload, actions({ toggle86: () => {} }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /did not take/);
  assert.match(confirm86({}, actions()).error, /Nothing was changed/);

  // The model is told the same: a name is enough, never make an id up, never say done unless it is.
  const api = read('../../api/ai.js');
  assert.match(api, /required: \['item_name'\],\n    \},\n  \},\n\n  add_menu_item:/);
  assert.match(api, /Never make one up/);
  assert.match(api, /Never say it is done unless the result says it has been 86\\'d/);
  // The assistant's tool runner hands both steps to these two functions.
  const tools = read('./aiTools.js');
  assert.match(tools, /return propose86\(toolInput, storeState\);/);
  assert.match(tools, /return confirm86\(payload, storeActions\);/);
  assert.ok(!/toggle86\(payload\.item_id\)/.test(tools), 'never a blind flip again');
  assert.match(read('../components/AIChat.jsx'), /getEightySixIds:\s+\(\) => useStore\.getState\(\)\.eightySixIds/);
});

test('every screen that offers options asks the one rule', () => {
  const uses = {
    '../components/InlineItemFlow.jsx': /groupsShownOn\(allGroupDefs, optionRows, 'pos'\)/,                // POS and bar
    '../surfaces/mpos/MItemDetail.jsx': /groupsShownOn\(allGroupDefs, menuItems, 'pos'\)/,                  // phone POS
    '../surfaces/online/OnlineItemSheet.jsx': /groupsShownOn\(\[\.\.\.fetched\.values\(\)\], shownOnRef\.current\.allItems, 'online', shownOnRef\.current\.fulfilment\)/,   // online, QR, catering
  };
  for (const [file, re] of Object.entries(uses)) assert.match(read(file), re, file);
  // Seen on the screen, 27 Nov 2026: the POS hands its picker a product list WITHOUT the sub items
  // that are only options, so an option's row was never found. The picker reads the store's rows.
  const flow = read('../components/InlineItemFlow.jsx');
  assert.match(flow, /const optionRows = \(Array\.isArray\(storeRows\) && storeRows\.length\) \? storeRows : menuItems;/);
  assert.ok(!/(?<!function )resolveOptItemId\((opt|m), menuItems\)/.test(flow), 'an option is never looked up in the product list');
  // The kiosk (both designs share this loader): the groups and the groups an option opens.
  assert.equal((read('../surfaces/KioskProductModal.jsx').match(/groupsShownOn\(data \|\| \[\], allItems, 'kiosk'\)/g) || []).length, 2);
  // The online page and catering say which order type the sheet is for (Delivery has its own tick).
  assert.match(read('../surfaces/online/OnlineSurface.jsx'), /fulfilment=\{priceType\}/);
  assert.match(read('../surfaces/catering/CateringSurface.jsx'), /fulfilment=\{fulfilment\}/);
  // The Multi site menu shows the ticks on a sub item that is only an option.
  const sheet = read('../backoffice/sections/msm/MsmProductSheet.jsx');
  assert.match(sheet, /data-testid=\{optionOnly \? 'msm-option-shown-on' : 'msm-shown-on'\}/);
  assert.match(sheet, /label=\{optionOnly \? 'This option shows on' : 'Shows on'\}/);
  // And right on the option's row in the Option groups tab, where a person looks for it.
  const groupSheet = read('../backoffice/sections/msm/MsmGroupSheet.jsx');
  assert.match(groupSheet, /data-testid="msm-option-row-shown-on"/);
  assert.match(groupSheet, /productUpdate\(ctx, prod\.id, \{ visibility \}\)/);
  assert.deepEqual(withNotShownOn({ ...OFF }, ['kiosk']), { ...OFF, notShownOn: ['kiosk'] });
});
