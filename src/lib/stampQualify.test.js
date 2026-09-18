// Stamp cards are per COMPANY (Peter, 18 Sep 2026); menus are per SITE. A card saved with one
// site's category ids must earn at every site whose category has the same name.
// Tests supabase/functions/_shared/stampQualify.ts (used by loyalty-earn) and its Back Office
// twin src/lib/stampCategoryGroups.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normStampName, countQualifyingStamps, loadStampNameIndex,
} from '../../supabase/functions/_shared/stampQualify.ts';
import {
  normCategoryName, groupCategoriesByName, selectedGroupCount, isGroupSelected, toggleGroup,
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
function fakeOps({ fail = null, hang = false, throwSync = false } = {}) {
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
            ? CATS.filter(c => ids.includes(c.id)).map(c => ({ id: c.id, label: c.label }))
            : ITEMS.filter(i => ids.includes(i.id)).map(i => ({ id: i.id, name: i.name }));
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
  assert.deepEqual(ops.calls, [{ table: 'menu_categories', ids: ['leeds-hot', 'barn-hot'] }]);
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

test('subcategories group under their parent name', () => {
  const groups = groupCategoriesByName([
    { id: 'l-drinks', label: 'Drinks', location_id: 'l' },
    { id: 'b-drinks', label: 'Drinks', location_id: 'b' },
    { id: 'l-hot', label: 'Hot', parent_id: 'l-drinks', location_id: 'l' },
    { id: 'b-hot', label: 'hot', parent_id: 'b-drinks', location_id: 'b' },
  ]);
  const sub = groups.find(g => g.key === 'hot');
  assert.equal(sub.parentKey, 'drinks');
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
