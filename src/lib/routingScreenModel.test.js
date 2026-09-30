// The Back Office Production centres screen as data (lib/routingScreenModel.js).
// 30 Sep 2026, Peter at Coffee Boy: sizes showed as "Small Boy / Big Boy" with no product,
// and sub categories could not be chosen. The one rule this file pins above all others:
// the screen shows exactly what routes.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoutingScreen,
  flattenNodes,
  flattenItemRows,
  categoryRowNote,
  clickCategory,
  clickItem,
  nowhereNotice,
  noticeHolds,
  nodeCentreIds,
  liveTickCount,
  countOf,
} from './routingScreenModel.js';
import {
  buildCatParentMap,
  centresForItemByCategory,
  centresForCategory,
  categoryStateForCentre,
} from './productionRouting.js';

// Coffee Boy Barnsley, in miniature.
const CATS = [
  { id: 'hic', parentId: null, label: 'Hot/Iced Coffee', sortOrder: 1 },
  { id: 'coffee', parentId: 'hic', label: 'Coffee' },
  { id: 'hot', parentId: 'coffee', label: 'Hot Coffee' },
  { id: 'specialty', parentId: null, label: 'Specialty', sortOrder: 2 },
  { id: 'food', parentId: null, label: 'Food', sortOrder: 3 },
  { id: 'pastries', parentId: 'food', label: 'Pastries' },
  { id: 'donuts', parentId: 'food', label: 'Donuts' },
  { id: 'matcha', parentId: null, label: 'Match | Iced Matcha', sortOrder: 4 },
];
const ITEMS = [
  { id: 'latte', name: 'Latte', cat: 'hot', cats: ['coffee'] },
  { id: 'latte-s', name: 'Small Boy', cat: 'hot', parentId: 'latte', price: 3, sortOrder: 1 },
  { id: 'latte-b', name: 'Big Boy', cat: 'hot', parentId: 'latte', price: 3.5, sortOrder: 2 },
  { id: 'chai', name: 'Chai Latte', cat: 'specialty', cats: ['hic'] },
  { id: 'matcha', name: 'Matcha', cat: 'matcha', cats: [] },
  { id: 'matcha-s', name: 'Small Boy', cat: 'matcha', parentId: 'matcha', sortOrder: 1 },
  { id: 'matcha-b', name: 'Big Boy', cat: 'matcha', parentId: 'matcha', sortOrder: 2 },
  { id: 'matcha-xl', name: 'XL Boy', cat: 'matcha', parentId: 'matcha', sortOrder: 3 },
  { id: 'roll', name: 'Cinnamon Roll', cat: 'pastries', cats: ['food'] },
  { id: 'jam', name: 'Jam Donut', cat: 'donuts', cats: [] },
  { id: 'soup', name: 'Soup', cat: 'food', cats: [] },
  { id: 'no-ice', name: 'No Ice', type: 'subitem', soldAlone: false, cat: 'hot' },
  { id: 'old', name: 'Old Latte', cat: 'hot', archived: true },
  { id: 'loose', name: 'Gift Card', cat: '', cats: [] },
];
const CENTRES = [{ id: 'drinks', name: 'KDS drinks' }, { id: 'kfood', name: 'kds food', printer: { id: 'p1' } }];
const ROUTING = {
  drinks: { assignedCategories: ['hic', 'matcha'], excludedItems: [], orderTypes: [] },
  kfood: { assignedCategories: ['food', 'matcha'], excludedItems: [], orderTypes: [] },
};
const screenFor = (centreId, routing = ROUTING, items = ITEMS, cats = CATS, centres = CENTRES) =>
  buildRoutingScreen({ centreId, centres, routing, categories: cats, menuItems: items });
const node = (screen, id) => flattenNodes(screen.roots).find(n => n.id === id);
const nameOfCentre = (id) => CENTRES.find(c => c.id === id)?.name || null;
const nameOfCategory = (id) => CATS.find(c => c.id === id)?.label || null;

test('tree: every category is listed once, sub categories under their parent', () => {
  const s = screenFor('drinks');
  assert.deepEqual(s.roots.map(n => n.id), ['hic', 'specialty', 'food', 'matcha']);
  assert.deepEqual(node(s, 'hic').children.map(n => n.id), ['coffee']);
  assert.deepEqual(node(s, 'coffee').children.map(n => n.id), ['hot']);
  assert.equal(node(s, 'hot').depth, 2);
  assert.equal(flattenNodes(s.roots).length, CATS.length);
  // a category whose parent is gone, and a parent loop, are still listed
  const odd = [...CATS, { id: 'orphan', parentId: 'deleted' }, { id: 'l1', parentId: 'l2' }, { id: 'l2', parentId: 'l1' }];
  const ids = flattenNodes(screenFor('drinks', ROUTING, ITEMS, odd).roots).map(n => n.id);
  assert.deepEqual([...ids].sort(), odd.map(c => c.id).sort());
});

test('items: sizes grouped under their product, read "Product, Size", each product once', () => {
  const s = screenFor('drinks');
  const hot = node(s, 'hot');
  assert.equal(hot.entries.length, 1);
  const latte = hot.entries[0];
  assert.equal(latte.kind, 'product');
  assert.equal(latte.label, 'Latte');
  assert.equal(latte.sizeCount, 2);
  assert.deepEqual(latte.sizes.map(x => x.label), ['Latte, Small Boy', 'Latte, Big Boy']);
  assert.deepEqual(latte.sizes.map(x => x.price), [3, 3.5]);
  const matcha = node(s, 'matcha').entries[0];
  assert.deepEqual(matcha.sizes.map(x => x.label), ['Matcha, Small Boy', 'Matcha, Big Boy', 'Matcha, XL Boy']);
  // each product and size once across the whole screen
  const rows = flattenItemRows(s);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  // a size whose own cat differs is still listed under its product
  const odd = ITEMS.map(i => (i.id === 'latte-b' ? { ...i, cat: 'food' } : i));
  assert.deepEqual(node(screenFor('drinks', ROUTING, odd), 'hot').entries[0].sizes.map(x => x.id), ['latte-s', 'latte-b']);
  assert.deepEqual(node(screenFor('drinks', ROUTING, odd), 'food').entries.map(e => e.id), ['soup']);
});

test('items: option only and archived items are not listed; options get one note', () => {
  const s = screenFor('drinks');
  const ids = flattenItemRows(s).map(r => r.id);
  assert.ok(!ids.includes('no-ice'));
  assert.ok(!ids.includes('old'));
  assert.equal(s.optionOnlyCount, 1);
});

test('items: Also in items are a muted line where they are shown, listed where they route', () => {
  const s = screenFor('drinks');
  // Chai Latte routes by Specialty, and is Also in Hot/Iced Coffee
  assert.deepEqual(node(s, 'hic').alsoIn, [{ id: 'chai', label: 'Chai Latte', catLabel: 'Specialty' }]);
  assert.deepEqual(node(s, 'specialty').entries.map(e => e.id), ['chai']);
  // Coffee Boy's usual pattern (Also in the parent) is not repeated: Latte sits in Hot
  // Coffee, which is inside Coffee already
  assert.deepEqual(node(s, 'coffee').alsoIn, []);
  assert.deepEqual(node(s, 'food').alsoIn, []);
});

test('items: an item with no category is listed apart, and counted as going nowhere', () => {
  const s = screenFor('drinks');
  assert.deepEqual(s.uncategorised.map(r => r.id), ['loose']);
  assert.ok(s.nowhereNames.includes('Gift Card'));
});

test('rows: every state, with its note', () => {
  const routing = {
    drinks: { assignedCategories: ['hic', 'matcha', 'donuts'], excludedCategories: ['coffee'] },
    kfood: { assignedCategories: ['food', 'matcha'] },
  };
  const s = screenFor('drinks', routing);
  const note = (id) => categoryRowNote(node(s, id).state, nameOfCentre, nameOfCategory);
  assert.equal(node(s, 'hic').state.how, 'ticked');
  assert.equal(note('hic'), null);
  assert.equal(node(s, 'matcha').state.how, 'ticked');
  assert.equal(note('matcha'), 'Also at kds food');
  assert.equal(node(s, 'coffee').state.how, 'notHere');
  assert.equal(note('coffee'), 'Not sent here');
  assert.equal(node(s, 'hot').state.how, 'notHere');
  assert.equal(node(s, 'food').state.how, 'elsewhere');
  assert.equal(note('food'), 'Goes to kds food');
  assert.equal(node(s, 'donuts').state.how, 'ticked');
  assert.equal(node(s, 'specialty').state.how, 'none');
  assert.equal(note('specialty'), 'No center');
  const k = screenFor('kfood', routing);
  assert.equal(node(k, 'pastries').state.how, 'withParent');
  assert.equal(categoryRowNote(node(k, 'pastries').state, nameOfCentre, nameOfCategory), 'With Food');
  assert.equal(node(k, 'donuts').state.how, 'elsewhere');
  assert.equal(categoryRowNote(node(k, 'donuts').state, nameOfCentre, nameOfCategory), 'Goes to KDS drinks');
});

test('rows: a parent opens by itself only when something inside it differs', () => {
  const s = screenFor('drinks');
  assert.equal(node(s, 'hic').differs, false);
  assert.equal(node(s, 'food').differs, false);
  const moved = screenFor('kfood', { ...ROUTING, drinks: { ...ROUTING.drinks, assignedCategories: ['hic', 'matcha', 'donuts'] } });
  assert.equal(node(moved, 'food').differs, true);
  const oneSize = screenFor('drinks', { ...ROUTING, drinks: { ...ROUTING.drinks, excludedItems: ['latte-b'] } });
  assert.equal(node(oneSize, 'hot').differs, true);
  assert.equal(node(oneSize, 'hot').offCount, 1);
  assert.equal(node(oneSize, 'hot').entries[0].box, 'some');
  assert.equal(node(oneSize, 'hic').differs, true);
});

test('the screen equals routing: every item box is ticked exactly when the item reaches the centre', () => {
  const variants = [
    ROUTING,
    { drinks: { assignedCategories: ['hic', 'matcha', 'donuts'], excludedItems: ['matcha', 'latte-s'] },
      kfood: { assignedCategories: ['food', 'matcha', 'coffee'], excludedCategories: ['pastries'] } },
    { drinks: { assignedCategories: ['hot'] }, kfood: { assignedCategories: [] } },
    {},
  ];
  const catParents = buildCatParentMap(CATS);
  for (const routing of variants) {
    const config = { centres: CENTRES, routing };
    for (const c of CENTRES) {
      const s = screenFor(c.id, routing);
      for (const row of flattenItemRows(s)) {
        const truth = centresForItemByCategory({ itemId: row.id }, config, { menuItems: ITEMS, catParents }).includes(c.id);
        assert.equal(row.comesHere, truth, `${c.id} ${row.label}`);
        // the till's line shape for the same item agrees
        const mi = ITEMS.find(i => i.id === row.id);
        const product = mi.parentId ? ITEMS.find(i => i.id === mi.parentId) : null;
        const tillLine = { uid: 'u', itemId: mi.id, cat: product?.cat || mi.cat || null, parentId: mi.parentId || null };
        assert.equal(centresForItemByCategory(tillLine, config, { menuItems: ITEMS, catParents }).includes(c.id), truth, `till ${row.label}`);
      }
      for (const n of flattenNodes(s.roots)) {
        assert.equal(n.state.comesHere, centresForCategory(n.id, config, catParents).centreIds.includes(c.id), `${c.id} ${n.id}`);
        for (const e of n.entries.filter(x => x.kind === 'product')) {
          const on = e.sizes.filter(x => x.comesHere).length;
          assert.equal(e.box, on === e.sizes.length ? 'all' : on ? 'some' : 'none');
        }
      }
    }
  }
});

test('clickCategory: moving Donuts says where it came from, and moving it back says where it went', () => {
  const tick = clickCategory({
    centreId: 'drinks', catId: 'donuts', want: true, centres: CENTRES, routing: ROUTING,
    parentMap: buildCatParentMap(CATS), menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  assert.equal(tick.notice, 'Donuts now comes here, not to kds food. Tick Donuts at kds food too to send it to both.');
  assert.deepEqual(tick.routing.drinks.assignedCategories, ['hic', 'matcha', 'donuts']);
  const back = clickCategory({
    centreId: 'drinks', catId: 'donuts', want: false, centres: CENTRES, routing: tick.routing,
    parentMap: buildCatParentMap(CATS), menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  assert.equal(back.notice, 'Donuts now goes to kds food with Food.');
  assert.deepEqual(back.routing.drinks.assignedCategories, ['hic', 'matcha']);
  // Not here says nothing: nothing moved anywhere else
  const notHere = clickCategory({
    centreId: 'kfood', catId: 'pastries', want: false, centres: CENTRES, routing: ROUTING,
    parentMap: buildCatParentMap(CATS), menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  assert.equal(notHere.notice, null);
  assert.deepEqual(notHere.routing.kfood.excludedCategories, ['pastries']);
  // a click that changes nothing returns the same routing
  const same = clickCategory({
    centreId: 'drinks', catId: 'hic', want: true, centres: CENTRES, routing: ROUTING,
    parentMap: buildCatParentMap(CATS), menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  assert.equal(same.routing, ROUTING);
  assert.equal(same.notice, null);
  // two centres lose it
  const both = { drinks: { assignedCategories: [] }, kfood: { assignedCategories: ['food'] }, bar: { assignedCategories: ['food'] } };
  const three = [...CENTRES, { id: 'bar', name: 'Bar' }];
  const moved = clickCategory({
    centreId: 'drinks', catId: 'donuts', want: true, centres: three, routing: both,
    parentMap: buildCatParentMap(CATS), menuItems: ITEMS,
    nameOfCentre: (id) => three.find(c => c.id === id)?.name, nameOfCategory,
  });
  assert.equal(moved.notice, 'Donuts now comes here, not to kds food and Bar. Tick Donuts at kds food and Bar too to send it to all of them.');
});

test('clickCategory: every row, both ways, ends with the box showing what routes', () => {
  const pm = buildCatParentMap(CATS);
  const configs = [
    ROUTING,
    { drinks: { assignedCategories: ['hic', 'donuts'], excludedCategories: ['coffee'] }, kfood: { assignedCategories: ['food', 'hot'] } },
  ];
  for (const routing of configs) {
    for (const c of CENTRES) {
      for (const cat of CATS) {
        for (const want of [true, false]) {
          const out = clickCategory({ centreId: c.id, catId: cat.id, want, centres: CENTRES, routing, parentMap: pm, menuItems: ITEMS, nameOfCentre, nameOfCategory });
          assert.equal(categoryStateForCentre(c.id, cat.id, { centres: CENTRES, routing: out.routing }, pm).comesHere, want);
          assert.equal(node(screenFor(c.id, out.routing), cat.id).state.comesHere, want);
          if (out.notice) assert.ok(!/[—–]/.test(out.notice), out.notice);
        }
      }
    }
  }
});

test('clickItem: product, size and plain item boxes', () => {
  const r0 = ROUTING;
  // A product id the screen live before this change saved ("Matcha" unticked) stops no
  // size, so every size still shows here and the product box is fully on.
  const legacy = { ...r0, drinks: { ...r0.drinks, excludedItems: ['matcha'] } };
  const m0 = node(screenFor('drinks', legacy), 'matcha').entries[0];
  assert.equal(m0.box, 'all');
  assert.deepEqual(m0.sizes.map(x => x.comesHere), [true, true, true]);
  // product box off: every Matcha size stops here, each by its own id
  const r1 = clickItem({ centreId: 'drinks', routing: r0, productId: 'matcha', sizeIds: ['matcha-s', 'matcha-b', 'matcha-xl'], targetId: 'matcha', want: false });
  assert.deepEqual(r1.drinks.excludedItems, ['matcha', 'matcha-s', 'matcha-b', 'matcha-xl']);
  assert.deepEqual(r1.drinks.orderTypes, [], 'the rest of the entry is kept');
  assert.equal(r1.kfood, r0.kfood);
  const m1 = node(screenFor('drinks', r1), 'matcha').entries[0];
  assert.equal(m1.box, 'none');
  // one size back on
  const r2 = clickItem({ centreId: 'drinks', routing: r1, productId: 'matcha', sizeIds: ['matcha-s', 'matcha-b', 'matcha-xl'], targetId: 'matcha-b', want: true });
  assert.deepEqual(r2.drinks.excludedItems, ['matcha-s', 'matcha-xl']);
  const m2 = node(screenFor('drinks', r2), 'matcha').entries[0];
  assert.equal(m2.box, 'some');
  assert.deepEqual(m2.sizes.map(x => x.comesHere), [false, true, false]);
  // product box on clears it all
  const r3 = clickItem({ centreId: 'drinks', routing: r2, productId: 'matcha', sizeIds: ['matcha-s', 'matcha-b', 'matcha-xl'], targetId: 'matcha', want: true });
  assert.deepEqual(r3.drinks.excludedItems, []);
  // a plain item
  const r4 = clickItem({ centreId: 'kfood', routing: r0, productId: 'soup', sizeIds: [], targetId: 'soup', want: false });
  assert.deepEqual(r4.kfood.excludedItems, ['soup']);
  // no change, same object
  assert.equal(clickItem({ centreId: 'kfood', routing: r0, productId: 'soup', sizeIds: [], targetId: 'soup', want: true }), r0);
  // a centre with no entry yet
  const r5 = clickItem({ centreId: 'new', routing: {}, productId: 'soup', sizeIds: [], targetId: 'soup', want: false });
  assert.deepEqual(r5, { new: { excludedItems: ['soup'] } });
});

test('nowhereNotice: once, only when something goes to no center, naming the channel fallback', () => {
  const s = screenFor('drinks');
  // Specialty's Chai Latte and the uncategorised gift card go nowhere
  assert.equal(s.nowhereCount, 2);
  assert.equal(s.fallbackCentre.id, 'kfood');
  const text = nowhereNotice(s, nameOfCentre);
  // Review 30 Sep 2026: says what happens (nothing prints or shows) and names them
  assert.equal(text, '2 items do not print or show at any center when rung up on a till: Chai Latte and Gift Card. Kiosk, online, QR, HubRise and catering orders send them to kds food.');
  assert.ok(!/[—–]/.test(text));
  const all = { ...ROUTING, drinks: { ...ROUTING.drinks, assignedCategories: ['hic', 'matcha', 'specialty'] } };
  const noLoose = ITEMS.filter(i => i.id !== 'loose');
  assert.equal(nowhereNotice(screenFor('drinks', all, noLoose), nameOfCentre), null);
  const one = screenFor('drinks', all);
  assert.equal(nowhereNotice(one, nameOfCentre), '1 item does not print or show at any center when rung up on a till: Gift Card. Kiosk, online, QR, HubRise and catering orders send it to kds food.');
  // an item unticked at every center is named too, though no "No center" row holds it
  const offEverywhere = { ...all, drinks: { ...all.drinks, excludedItems: ['latte-b'] } };
  assert.ok(nowhereNotice(screenFor('drinks', offEverywhere, noLoose), nameOfCentre).includes(': Latte, Big Boy.'));
  // more than five: the first five and a count
  const many = [...ITEMS, ...Array.from({ length: 7 }, (_, i) => ({ id: `gc${i}`, name: `Card ${i}`, cat: '', cats: [] }))];
  const big = nowhereNotice(screenFor('drinks', ROUTING, many), nameOfCentre);
  assert.ok(big.startsWith('9 items do not print or show at any center when rung up on a till: Chai Latte, Gift Card, Card 0, Card 1, Card 2 and 4 more.'), big);
  // no centres at all: the lead alone
  const none = screenFor('drinks', {}, [ITEMS.find(i => i.id === 'loose')], CATS, []);
  assert.equal(nowhereNotice(none, nameOfCentre), '1 item does not print or show at any center when rung up on a till: Gift Card.');
});

// Review 30 Sep 2026: after a failed save the old routing comes back, and the sentence from
// the click must go with it rather than describe a move that did not happen.
test('noticeHolds: the click sentence shows only while the row still routes as it said', () => {
  const pm = buildCatParentMap(CATS);
  const tick = clickCategory({
    centreId: 'drinks', catId: 'donuts', want: true, centres: CENTRES, routing: ROUTING,
    parentMap: pm, menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  assert.deepEqual(tick.expect, ['drinks']);
  const notice = { catId: 'donuts', text: tick.notice, expect: tick.expect };
  // saved: the row now comes here only
  const after = node(screenFor('drinks', tick.routing), 'donuts');
  assert.deepEqual(nodeCentreIds(after, 'drinks'), ['drinks']);
  assert.equal(noticeHolds(notice, after, 'drinks'), true);
  // the save failed and the old routing came back: the row goes to kds food again
  const reverted = node(screenFor('drinks', ROUTING), 'donuts');
  assert.equal(noticeHolds(notice, reverted, 'drinks'), false);
  // another window also ticked Donuts at kds food: still not what the sentence said
  const other = { ...tick.routing, kfood: { ...tick.routing.kfood, assignedCategories: ['food', 'matcha', 'donuts'] } };
  assert.equal(noticeHolds(notice, node(screenFor('drinks', other), 'donuts'), 'drinks'), false);
  // moving it back: holds while it goes to kds food with Food
  const back = clickCategory({
    centreId: 'drinks', catId: 'donuts', want: false, centres: CENTRES, routing: tick.routing,
    parentMap: pm, menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  const backNotice = { catId: 'donuts', text: back.notice, expect: back.expect };
  assert.equal(noticeHolds(backNotice, node(screenFor('drinks', back.routing), 'donuts'), 'drinks'), true);
  assert.equal(noticeHolds(backNotice, node(screenFor('drinks', tick.routing), 'donuts'), 'drinks'), false);
  // never on another row, and never without a notice
  assert.equal(noticeHolds(notice, node(screenFor('drinks', tick.routing), 'food'), 'drinks'), false);
  assert.equal(noticeHolds(null, after, 'drinks'), false);
  // a click that changes nothing has nothing to hold
  const same = clickCategory({
    centreId: 'drinks', catId: 'hic', want: true, centres: CENTRES, routing: ROUTING,
    parentMap: pm, menuItems: ITEMS, nameOfCentre, nameOfCategory,
  });
  assert.equal(same.expect, null);
});

test('liveTickCount: deleted categories are not counted', () => {
  const pm = buildCatParentMap(CATS);
  assert.equal(liveTickCount({ assignedCategories: ['hic', 'cat-deleted', 'matcha'] }, pm), 2);
  assert.equal(liveTickCount({ assignedCategories: ['hic', 'cat-deleted'] }, {}), 2, 'categories not loaded yet: count them all');
  assert.equal(liveTickCount(undefined, pm), 0);
});

test('countOf: one and many', () => {
  assert.equal(countOf(1, 'size', 'sizes'), '1 size');
  assert.equal(countOf(3, 'size', 'sizes'), '3 sizes');
});
