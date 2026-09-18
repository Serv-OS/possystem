// Stamp cards are per COMPANY (Peter, 18 Sep 2026); menus are per SITE. A card saved with one
// site's category ids must earn at every site whose category has the same name.
// Tests supabase/functions/_shared/stampQualify.ts (used by loyalty-earn) and its Back Office
// twin src/lib/stampCategoryGroups.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normStampName, countQualifyingStamps, loadStampNameIndex, stampLookupNeeded,
  pathCovers as serverPathCovers, categoryPathKey, PATH_SEP as SERVER_PATH_SEP, MAX_IDS,
} from '../../supabase/functions/_shared/stampQualify.ts';
import {
  normCategoryName, groupCategoriesByName, groupCategoriesByPath, selectedGroupCount, isGroupSelected,
  isGroupCovered, toggleGroup, pathKeyOf, pathCovers, PATH_SEP, categoryQualifies, missingCategoryState,
} from './stampCategoryGroups.js';

// Coffee Boy shape: the same three categories at Leeds and Barnsley under different ids.
const CATS = [
  { id: 'leeds-hot', label: 'Hot Coffee', location_id: 'leeds' },
  { id: 'leeds-iced', label: 'Iced Coffee', location_id: 'leeds' },
  { id: 'leeds-food', label: 'Food', location_id: 'leeds' },
  { id: 'barn-hot', label: 'Hot Coffee', location_id: 'barnsley' },
  { id: 'barn-hot-spaced', label: '  hot   COFFEE ', location_id: 'york' },
  { id: 'barn-iced', label: 'Iced Coffee', location_id: 'barnsley' },
  { id: 'barn-food', label: 'Food', location_id: 'barnsley' },
];
const ITEMS = [
  { id: 'leeds-latte', name: 'Latte' },
  { id: 'barn-latte', name: 'Latte' },
  { id: 'barn-muffin', name: 'Muffin' },
];

// Minimal fake of the supabase-js query chain used by loadStampNameIndex.
function fakeOps({ fail = null, hang = false, throwSync = false, cats = CATS, items = ITEMS } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      if (throwSync) throw new Error('boom');
      return {
        select() { return this; },
        in(_col, ids) {
          calls.push({ table, ids });
          if (hang) return new Promise(() => {});
          if (fail === table || fail === 'all') return Promise.resolve({ data: null, error: { message: 'down' } });
          const rows = table === 'menu_categories'
            ? cats.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, label: c.label, parent_id: c.parent_id || null }))
            : items.filter(i => ids.includes(i.id)).map(i => ({ id: i.id, name: i.name }));
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
  };
}

const hotCard = { id: 'p1', qualifying_category_ids: ['leeds-hot'], qualifying_item_ids: [] };

test('normStampName trims, lower-cases and collapses spaces', () => {
  assert.equal(normStampName('  Hot   Coffee '), 'hot coffee');
  assert.equal(normStampName('HOT\tcoffee'), 'hot coffee');
  assert.equal(normStampName(null), '');
  assert.equal(normStampName(42), '');
});

test('a card saved with Leeds Hot Coffee id earns for Barnsley Hot Coffee', async () => {
  const order = [{ id: 'barn-latte', cat: 'barn-hot', qty: 2 }, { id: 'barn-muffin', cat: 'barn-food', qty: 1 }];
  const index = await loadStampNameIndex(fakeOps(), [hotCard], order);
  assert.equal(countQualifyingStamps(order, hotCard, index), 2);
});

test('the site the card was saved at still earns by id', async () => {
  const order = [{ id: 'leeds-latte', cat: 'leeds-hot', qty: 1 }];
  const index = await loadStampNameIndex(fakeOps(), [hotCard], order);
  assert.equal(countQualifyingStamps(order, hotCard, index), 1);
  assert.equal(countQualifyingStamps(order, hotCard, null), 1);
});

test('a name that differs only in case or spacing matches', async () => {
  const order = [{ id: 'x', cat: 'barn-hot-spaced', qty: 1 }];
  const index = await loadStampNameIndex(fakeOps(), [hotCard], order);
  assert.equal(countQualifyingStamps(order, hotCard, index), 1);
});

test('a category with a different name does not earn', async () => {
  const order = [{ id: 'barn-muffin', cat: 'barn-food', qty: 3 }, { id: 'y', cat: 'barn-iced', qty: 1 }];
  const index = await loadStampNameIndex(fakeOps(), [hotCard], order);
  assert.equal(countQualifyingStamps(order, hotCard, index), 0);
});

test('an order that sends the category LABEL instead of its id still matches by name', async () => {
  const order = [{ id: 'z', cat: 'Hot Coffee', qty: 1 }];
  const index = await loadStampNameIndex(fakeOps(), [hotCard], order);
  assert.equal(countQualifyingStamps(order, hotCard, index), 1);
});

test('qualifying ITEMS match by name across sites too', async () => {
  const card = { id: 'p2', qualifying_category_ids: [], qualifying_item_ids: ['leeds-latte'] };
  const order = [{ id: 'barn-latte', cat: 'barn-hot', qty: 1 }, { id: 'barn-muffin', cat: 'barn-food', qty: 1 }];
  const index = await loadStampNameIndex(fakeOps(), [card], order);
  assert.equal(countQualifyingStamps(order, card, index), 1);
});

test('no qualifying categories or items: every item earns, with no lookups, exactly as before', async () => {
  const card = { id: 'p3', qualifying_category_ids: [], qualifying_item_ids: null };
  const order = [
    { id: 'a', cat: 'barn-food', qty: 2 },
    { id: 'b', cat: null },
    { id: 'c', cat: 'barn-hot', qty: 1, isComp: true },
    { id: 'd', qty: 1, isGiftCard: true },
  ];
  const ops = fakeOps();
  const index = await loadStampNameIndex(ops, [card], order);
  assert.equal(index, null);
  assert.equal(ops.calls.length, 0);
  assert.equal(countQualifyingStamps(order, card, index), 3);
  assert.equal(countQualifyingStamps(order, card, null), 3);
});

test('comp and gift card lines never earn, even by name', async () => {
  const order = [{ id: 'barn-latte', cat: 'barn-hot', qty: 1, isComp: true }, { id: 'g', cat: 'barn-hot', isGiftCard: true }];
  const index = await loadStampNameIndex(fakeOps(), [hotCard], order);
  assert.equal(countQualifyingStamps(order, hotCard, index), 0);
});

test('a failed name lookup falls back to the id match and never throws', async () => {
  const order = [{ id: 'leeds-latte', cat: 'leeds-hot', qty: 1 }, { id: 'barn-latte', cat: 'barn-hot', qty: 1 }];
  for (const ops of [fakeOps({ fail: 'all' }), fakeOps({ throwSync: true }), null]) {
    const index = await loadStampNameIndex(ops, [hotCard], order);
    // Leeds (saved id) still earns; Barnsley needs the names, which are unavailable.
    assert.equal(countQualifyingStamps(order, hotCard, index), 1);
  }
});

test('a hung name lookup gives up after the timeout and falls back to the id match', async () => {
  const order = [{ id: 'leeds-latte', cat: 'leeds-hot', qty: 1 }, { id: 'barn-latte', cat: 'barn-hot', qty: 1 }];
  const t0 = Date.now();
  const index = await loadStampNameIndex(fakeOps({ hang: true }), [hotCard], order, 50);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(countQualifyingStamps(order, hotCard, index), 1);
});

test('lookup asks only for ids the programmes and the order mention', async () => {
  const ops = fakeOps();
  const order = [{ id: 'barn-latte', cat: 'barn-hot', qty: 1 }];
  await loadStampNameIndex(ops, [hotCard], order);
  // The order's own ids come first (3b), then the saved ones.
  assert.deepEqual(ops.calls, [{ table: 'menu_categories', ids: ['barn-hot', 'leeds-hot'] }]);
});

test('bad input never throws', () => {
  assert.equal(countQualifyingStamps(null, hotCard, null), 0);
  assert.equal(countQualifyingStamps([null, { cat: 'leeds-hot' }], hotCard, null), 1);
  assert.equal(countQualifyingStamps([{ cat: 'leeds-hot', qty: 'x' }], {}, null), 1);
});

// ── Back Office picker twin ─────────────────────────────────────────────
test('the Back Office normaliser agrees with the earn normaliser', () => {
  for (const s of ['Hot Coffee', '  hot   COFFEE ', 'Iced\tCoffee', '', null, 7]) {
    assert.equal(normCategoryName(s), normStampName(s));
  }
});

test('groupCategoriesByName shows one Hot Coffee with its site count and every id', () => {
  const groups = groupCategoriesByName(CATS);
  const hot = groups.find(g => g.key === 'hot coffee');
  assert.equal(hot.label, 'Hot Coffee');
  assert.equal(hot.siteCount, 3);
  assert.deepEqual([...hot.ids].sort(), ['barn-hot', 'barn-hot-spaced', 'leeds-hot']);
  assert.equal(groups.filter(g => !g.parentKey).length, 3);
});

test('subcategories group under their parent path', () => {
  const groups = groupCategoriesByName([
    { id: 'l-drinks', label: 'Drinks', location_id: 'l' },
    { id: 'b-drinks', label: 'Drinks', location_id: 'b' },
    { id: 'l-hot', label: 'Hot', parent_id: 'l-drinks', location_id: 'l' },
    { id: 'b-hot', label: 'hot', parent_id: 'b-drinks', location_id: 'b' },
  ]);
  const sub = groups.find(g => g.key === pathKeyOf(['Drinks', 'Hot']));
  assert.equal(sub.parentKey, 'drinks');
  assert.equal(sub.label, 'Hot');
  assert.equal(sub.siteCount, 2);
});

test('selectedGroupCount counts names, not per-site ids', () => {
  const groups = groupCategoriesByName(CATS);
  assert.equal(selectedGroupCount(['leeds-hot', 'barn-hot', 'barn-iced'], groups), 2);
  assert.equal(selectedGroupCount(['gone-id'], groups), 1);
  assert.equal(selectedGroupCount([], groups), 0);
});

test('an existing card saved with only the Leeds id shows Hot Coffee as selected', () => {
  const groups = groupCategoriesByName(CATS);
  const hot = groups.find(g => g.key === 'hot coffee');
  const iced = groups.find(g => g.key === 'iced coffee');
  assert.equal(isGroupSelected(hot, ['leeds-hot'], groups), true);
  assert.equal(isGroupSelected(iced, ['leeds-hot'], groups), false);
});

test('toggleGroup on saves every site id; off removes every id with that name', () => {
  const groups = groupCategoriesByName(CATS);
  const hot = groups.find(g => g.key === 'hot coffee');
  const on = toggleGroup(hot, ['leeds-iced'], groups);
  assert.deepEqual(on, ['leeds-iced', 'leeds-hot', 'barn-hot', 'barn-hot-spaced']);
  assert.deepEqual(toggleGroup(hot, on, groups), ['leeds-iced']);
  assert.deepEqual(toggleGroup(hot, ['leeds-hot', 'gone-id'], groups), ['gone-id']);
});

// ── Parent categories and paths (item 2 of the 18 Sep brief) ─────────────
// Coffee Boy's shape: 'Coffee' is a parent of 'Hot Coffee' and 'Iced Coffee' at every site,
// and a site can also sell 'Coffee' (bags of beans) under 'Retail' as well as under 'Drinks'.
const TREE = [
  { id: 'L-coffee', label: 'Coffee', location_id: 'leeds' },
  { id: 'L-hot', label: 'Hot Coffee', parent_id: 'L-coffee', location_id: 'leeds' },
  { id: 'L-iced', label: 'Iced Coffee', parent_id: 'L-coffee', location_id: 'leeds' },
  { id: 'B-coffee', label: ' coffee ', location_id: 'barnsley' },
  { id: 'B-hot', label: 'Hot Coffee', parent_id: 'B-coffee', location_id: 'barnsley' },
  { id: 'B-iced', label: 'Iced  Coffee', parent_id: 'B-coffee', location_id: 'barnsley' },
  { id: 'P-coffee', label: 'Coffee', location_id: 'preston' },
  { id: 'P-hot', label: 'Hot Coffee', parent_id: 'P-coffee', location_id: 'preston' },
  { id: 'S-coffee', label: 'COFFEE', location_id: 'station' },
  { id: 'S-iced', label: 'Iced Coffee', parent_id: 'S-coffee', location_id: 'station' },
  { id: 'L-drinks', label: 'Drinks', location_id: 'leeds' },
  { id: 'L-dcoffee', label: 'Coffee', parent_id: 'L-drinks', location_id: 'leeds' },
  { id: 'L-retail', label: 'Retail', location_id: 'leeds' },
  { id: 'L-rcoffee', label: 'Coffee', parent_id: 'L-retail', location_id: 'leeds' },
  { id: 'B-drinks', label: 'Drinks', location_id: 'barnsley' },
  { id: 'B-dcoffee', label: 'Coffee', parent_id: 'B-drinks', location_id: 'barnsley' },
  { id: 'B-esp', label: 'Espresso', parent_id: 'B-dcoffee', location_id: 'barnsley' },
  { id: 'B-retail', label: 'Retail', location_id: 'barnsley' },
  { id: 'B-rcoffee', label: 'Coffee', parent_id: 'B-retail', location_id: 'barnsley' },
];
const treeOps = (opts = {}) => fakeOps({ cats: TREE, ...opts });
const card = (ids) => ({ id: 'free-drink', qualifying_category_ids: ids, qualifying_item_ids: [] });
async function earn(prog, order, ops = treeOps()) {
  const index = await loadStampNameIndex(ops, [prog], order);
  return countQualifyingStamps(order, prog, index);
}

test('ticking the parent Coffee earns for Hot Coffee and Iced Coffee at every site', async () => {
  const prog = card(['L-coffee']);   // saved at Leeds
  const order = [
    { id: 'b1', cat: 'B-hot', qty: 2 },
    { id: 'b2', cat: 'B-iced', qty: 1 },
    { id: 'p1', cat: 'P-hot', qty: 1 },
    { id: 's1', cat: 'S-iced', qty: 1 },
    { id: 'l1', cat: 'L-hot', qty: 1 },
    { id: 'l2', cat: 'L-coffee', qty: 1 },
  ];
  assert.equal(await earn(prog, order), 7);
});

test('ticking a parent at its own site covers its subcategories by id', async () => {
  assert.equal(await earn(card(['L-coffee']), [{ id: 'x', cat: 'L-iced', qty: 3 }]), 3);
});

test('Drinks > Coffee does not earn for Retail > Coffee (beans), at any site', async () => {
  const prog = card(['L-dcoffee']);
  const order = [
    { id: 'beans1', cat: 'B-rcoffee', qty: 1 },
    { id: 'beans2', cat: 'L-rcoffee', qty: 1 },
    { id: 'latte', cat: 'B-dcoffee', qty: 1 },
    { id: 'esp', cat: 'B-esp', qty: 1 },   // Drinks > Coffee > Espresso, a level deeper
  ];
  assert.equal(await earn(prog, order), 2);
  assert.equal(await earn(card(['B-rcoffee']), order), 2);   // beans at both sites, no drinks
});

test('a top level Coffee does not cover Drinks > Coffee, and a child does not cover its parent', async () => {
  assert.equal(await earn(card(['L-coffee']), [{ id: 'x', cat: 'B-dcoffee', qty: 1 }]), 0);
  assert.equal(await earn(card(['L-hot']), [{ id: 'x', cat: 'B-coffee', qty: 1 }]), 0);
  assert.equal(await earn(card(['L-hot']), [{ id: 'x', cat: 'B-iced', qty: 1 }]), 0);
});

test('a failed lookup falls back to the id match for parents and paths, never throws', async () => {
  const prog = card(['L-dcoffee']);
  const order = [{ id: 'a', cat: 'L-dcoffee', qty: 1 }, { id: 'b', cat: 'B-dcoffee', qty: 1 }, { id: 'c', cat: 'B-esp', qty: 1 }];
  for (const ops of [treeOps({ fail: 'all' }), treeOps({ throwSync: true }), treeOps({ hang: true }), null]) {
    const index = await loadStampNameIndex(ops, [prog], order, 40);
    assert.equal(countQualifyingStamps(order, prog, index), 1);
  }
});

test('a half known category chain never matches by path (can only earn less)', async () => {
  // The parent rows are missing: Barnsley's Hot Coffee must NOT look like a top level category.
  const noParents = TREE.filter(c => c.id !== 'B-coffee');
  const prog = card(['L-hot']);
  assert.equal(await earn(prog, [{ id: 'x', cat: 'B-hot', qty: 1 }], treeOps({ cats: noParents })), 0);
  // A loop in the data never hangs or throws.
  const loop = [{ id: 'a', label: 'A', parent_id: 'b' }, { id: 'b', label: 'B', parent_id: 'a' }];
  assert.equal(await earn(card(['a']), [{ id: 'x', cat: 'b', qty: 1 }], treeOps({ cats: loop })), 1);   // ancestor id
  assert.equal(await earn(card(['zz']), [{ id: 'x', cat: 'b', qty: 1 }], treeOps({ cats: loop })), 0);
});

test('3a: the lookup is skipped when every line already matches by saved id', async () => {
  const prog = card(['L-hot', 'L-iced']);
  const order = [{ id: 'a', cat: 'L-hot', qty: 2 }, { id: 'b', cat: 'L-iced', qty: 1 }, { id: 'c', cat: 'L-hot', isComp: true }];
  const ops = treeOps();
  assert.equal(stampLookupNeeded([prog], order), false);
  const index = await loadStampNameIndex(ops, [prog], order);
  assert.equal(index, null);
  assert.equal(ops.calls.length, 0);
  assert.equal(countQualifyingStamps(order, prog, index), 3);
  // One line that does not match by id is enough to need the lookup.
  assert.equal(stampLookupNeeded([prog], [...order, { id: 'd', cat: 'B-hot' }]), true);
});

test('3b: the id cap never drops the order\'s own ids, and each request is chunked', async () => {
  const saved = ['L-hot', ...Array.from({ length: 700 }, (_, i) => `gone-${i}`)];
  const prog = card(saved);
  const order = [{ id: 'x', cat: 'B-hot', qty: 1 }, { id: 'y', cat: 'P-hot', qty: 1 }];
  const ops = treeOps();
  const index = await loadStampNameIndex(ops, [prog], order);
  const first = ops.calls.filter(c => c.table === 'menu_categories').slice(0, 5).flatMap(c => c.ids);
  assert.deepEqual(first.slice(0, 3), ['B-hot', 'P-hot', 'L-hot']);
  assert.equal(new Set(first).size, MAX_IDS);
  assert.ok(ops.calls.every(c => c.ids.length <= 100));
  assert.equal(countQualifyingStamps(order, prog, index), 2);
});

test('the Back Office rule and the till rule agree on every saved category and every line', async () => {
  assert.equal(PATH_SEP, SERVER_PATH_SEP);
  for (const [a, b] of [['coffee', 'coffee'], ['coffee', pathKeyOf(['Coffee', 'Hot'])], [pathKeyOf(['Coffee', 'Hot']), 'coffee'], ['coffee', 'coffeehouse'], ['', 'x'], [null, 'x']]) {
    assert.equal(pathCovers(a, b), serverPathCovers(a, b), `${a} / ${b}`);
  }
  const ids = TREE.map(c => c.id);
  for (const saved of ids) {
    const prog = card([saved]);
    for (const line of ids) {
      const order = [{ id: 'i', cat: line, qty: 1 }];
      const server = await earn(prog, order);
      assert.equal(server, categoryQualifies(line, [saved], TREE) ? 1 : 0, `saved ${saved}, line ${line}`);
    }
  }
});

test('categoryPathKey needs every level and normalises each one', () => {
  const names = Object.fromEntries(TREE.map(c => [c.id, c.label]));
  const parents = Object.fromEntries(TREE.map(c => [c.id, c.parent_id || null]));
  assert.equal(categoryPathKey('B-iced', names, parents), pathKeyOf(['Coffee', 'Iced Coffee']));
  assert.equal(categoryPathKey('B-esp', names, parents), pathKeyOf(['Drinks', 'Coffee', 'Espresso']));
  assert.equal(categoryPathKey('nope', names, parents), null);
});

test('the picker groups by path: Drinks > Coffee and Retail > Coffee are two chips', () => {
  const groups = groupCategoriesByPath(TREE);
  const drinksCoffee = groups.find(g => g.key === pathKeyOf(['Drinks', 'Coffee']));
  const retailCoffee = groups.find(g => g.key === pathKeyOf(['Retail', 'Coffee']));
  const topCoffee = groups.find(g => g.key === pathKeyOf(['Coffee']));
  assert.deepEqual(drinksCoffee.ids.sort(), ['B-dcoffee', 'L-dcoffee']);
  assert.deepEqual(retailCoffee.ids.sort(), ['B-rcoffee', 'L-rcoffee']);
  assert.equal(topCoffee.siteCount, 4);
  assert.equal(groupCategoriesByName, groupCategoriesByPath);
  // Ticking Drinks > Coffee does not tick Retail > Coffee.
  const on = toggleGroup(drinksCoffee, [], groups);
  assert.equal(isGroupSelected(retailCoffee, on, groups), false);
});

test('the picker shows subcategories of a ticked parent as included (same rule as the till)', () => {
  const groups = groupCategoriesByPath(TREE);
  const top = groups.find(g => g.key === pathKeyOf(['Coffee']));
  const hot = groups.find(g => g.key === pathKeyOf(['Coffee', 'Hot Coffee']));
  const esp = groups.find(g => g.key === pathKeyOf(['Drinks', 'Coffee', 'Espresso']));
  const dc = groups.find(g => g.key === pathKeyOf(['Drinks', 'Coffee']));
  const sel = toggleGroup(top, [], groups);
  assert.equal(isGroupCovered(hot, sel, groups), true);
  assert.equal(isGroupCovered(top, sel, groups), false);
  assert.equal(isGroupCovered(esp, sel, groups), false);
  assert.equal(isGroupCovered(esp, toggleGroup(dc, [], groups), groups), true);
});

test('3c: a card whose saved categories no longer exist is flagged, never while loading', () => {
  assert.deepEqual(missingCategoryState(['gone-1', 'gone-2'], TREE, true), { saved: 2, missing: 2, allMissing: true });
  assert.deepEqual(missingCategoryState(['gone-1', 'L-hot'], TREE, true), { saved: 2, missing: 1, allMissing: false });
  assert.equal(missingCategoryState(['gone-1'], [], false).allMissing, false);
  assert.equal(missingCategoryState([], TREE, true).allMissing, false);
});
