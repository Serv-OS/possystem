// Production centres by order type: the pure rule.
// Peter's case: a takeaway coffee goes to a different centre than a dine in coffee,
// same product, split by order type.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_TYPE_KEYS,
  orderTypeLabelOf,
  normaliseCentreOrderTypes,
  centreTakesOrderType,
  resolveOrderTypeKey,
  centresForItemByCategory,
  resolveCentresForItem,
  nextCentreOrderTypes,
  orderTypeFallbackMessage,
  describeCentreOrderTypes,
  fallbackOrderTypesForCentre,
  joinList,
} from './productionRouting.js';

// ── normaliseCentreOrderTypes ────────────────────────────────────────────────

test('normaliseCentreOrderTypes: absent, null and [] all mean all order types', () => {
  assert.deepEqual(normaliseCentreOrderTypes(undefined), []);
  assert.deepEqual(normaliseCentreOrderTypes(null), []);
  assert.deepEqual(normaliseCentreOrderTypes([]), []);
});

test('normaliseCentreOrderTypes: keeps valid keys and drops garbage', () => {
  assert.deepEqual(normaliseCentreOrderTypes(['takeaway']), ['takeaway']);
  assert.deepEqual(normaliseCentreOrderTypes(['takeaway', 'takeaway']), ['takeaway']);
  assert.deepEqual(normaliseCentreOrderTypes(['takeaway', null, 7, {}]), ['takeaway']);
  assert.deepEqual(normaliseCentreOrderTypes(['nonsense']), []);
});

// A value typed into the Ops SQL editor by hand, or written by a future importer, must
// not silently widen the centre back to ALL order types with nothing on screen to say so.
test('normaliseCentreOrderTypes: a differently spelled type is honoured, not dropped', () => {
  assert.deepEqual(normaliseCentreOrderTypes(['TAKEAWAY']), ['takeaway']);
  assert.deepEqual(normaliseCentreOrderTypes(['eat_in']), ['dine-in']);
  assert.deepEqual(normaliseCentreOrderTypes(['eat in']), ['dine-in']);
  assert.deepEqual(normaliseCentreOrderTypes(['takeout']), ['takeaway']);
  assert.deepEqual(normaliseCentreOrderTypes(['pickup']), ['collection']);
  assert.equal(centreTakesOrderType({ orderTypes: ['TAKEAWAY'] }, 'dine-in'), false);
});

test('normaliseCentreOrderTypes: returns the canonical order, not the saved order', () => {
  assert.deepEqual(normaliseCentreOrderTypes(['collection', 'dine-in']), ['dine-in', 'collection']);
});

test('normaliseCentreOrderTypes: all four ticked collapses back to All', () => {
  assert.deepEqual(normaliseCentreOrderTypes([...ORDER_TYPE_KEYS]), []);
});

test('normaliseCentreOrderTypes: a non array means all order types', () => {
  assert.deepEqual(normaliseCentreOrderTypes('takeaway'), []);
  assert.deepEqual(normaliseCentreOrderTypes({ takeaway: true }), []);
});

// ── centreTakesOrderType ─────────────────────────────────────────────────────

test('centreTakesOrderType: a centre with nothing saved takes every order type', () => {
  const entry = { assignedCategories: ['c1'] };
  for (const key of ORDER_TYPE_KEYS) assert.equal(centreTakesOrderType(entry, key), true);
  assert.equal(centreTakesOrderType(undefined, 'takeaway'), true);
  assert.equal(centreTakesOrderType({ orderTypes: [] }, 'takeaway'), true);
});

test('centreTakesOrderType: one type ticked rejects the others', () => {
  const entry = { orderTypes: ['takeaway'] };
  assert.equal(centreTakesOrderType(entry, 'takeaway'), true);
  assert.equal(centreTakesOrderType(entry, 'dine-in'), false);
  assert.equal(centreTakesOrderType(entry, 'collection'), false);
  assert.equal(centreTakesOrderType(entry, 'delivery'), false);
});

test('centreTakesOrderType: an unknown or missing order type matches every centre', () => {
  const entry = { orderTypes: ['takeaway'] };
  assert.equal(centreTakesOrderType(entry, null), true);
  assert.equal(centreTakesOrderType(entry, undefined), true);
  assert.equal(centreTakesOrderType(entry, 'bar-tab'), true);
});

test('centreTakesOrderType: unreadable orderTypes takes everything', () => {
  assert.equal(centreTakesOrderType({ orderTypes: 'takeaway' }, 'dine-in'), true);
  assert.equal(centreTakesOrderType({ orderTypes: ['nonsense'] }, 'dine-in'), true);
  assert.equal(centreTakesOrderType({ orderTypes: [7, {}] }, 'dine-in'), true);
});

// ── resolveOrderTypeKey ──────────────────────────────────────────────────────

test('resolveOrderTypeKey: the queue type wins', () => {
  assert.equal(resolveOrderTypeKey({ type: 'dine-in' }), 'dine-in');
  assert.equal(resolveOrderTypeKey({ type: 'takeaway' }), 'takeaway');
  assert.equal(resolveOrderTypeKey({ type: 'collection' }), 'collection');
  assert.equal(resolveOrderTypeKey({ type: 'delivery' }), 'delivery');
});

test('resolveOrderTypeKey: HubRise eat_in resolves to dine-in', () => {
  assert.equal(resolveOrderTypeKey({ type: 'dine-in', customer: { serviceType: 'eat_in' } }), 'dine-in');
  assert.equal(resolveOrderTypeKey({ customer: { serviceType: 'eat_in' } }), 'dine-in');
});

test('resolveOrderTypeKey: ezCater TAKEOUT never beats the collection queue type', () => {
  assert.equal(resolveOrderTypeKey({ type: 'collection', customer: { serviceType: 'TAKEOUT' } }), 'collection');
});

test('resolveOrderTypeKey: an unknown service type and an empty order give null', () => {
  assert.equal(resolveOrderTypeKey({ customer: { serviceType: 'THIRD_PARTY_DELIVERY' } }), null);
  assert.equal(resolveOrderTypeKey({}), null);
  assert.equal(resolveOrderTypeKey(null), null);
});

// ── centresForItemByCategory ─────────────────────────────────────────────────

const CTX = { menuItems: [], catParents: {} };

test('centresForItemByCategory: no centres gives nothing', () => {
  assert.deepEqual(centresForItemByCategory({ id: 'i1' }, { centres: [], routing: {} }, CTX), []);
  assert.deepEqual(centresForItemByCategory({ id: 'i1' }, null, CTX), []);
});

test('centresForItemByCategory: a centre with no categories ticked receives nothing', () => {
  const config = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: [] } } };
  assert.deepEqual(centresForItemByCategory({ id: 'i1', cat: 'coffee' }, config, CTX), []);
});

test('centresForItemByCategory: a direct category match', () => {
  const config = { centres: [{ id: 'k' }, { id: 'b' }], routing: {
    k: { assignedCategories: ['coffee'] },
    b: { assignedCategories: ['beer'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'i1', cat: 'coffee' }, config, CTX), ['k']);
});

test('centresForItemByCategory: a variant matches through its parent product', () => {
  const config = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['coffee'] } } };
  const ctx = { catParents: {}, menuItems: [
    { id: 'latte-s', parentId: 'latte' },
    { id: 'latte', cat: 'coffee' },
  ] };
  assert.deepEqual(centresForItemByCategory({ itemId: 'latte-s' }, config, ctx), ['k']);
});

test('centresForItemByCategory: matches an ancestor category two levels up', () => {
  const config = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['drinks'] } } };
  const ctx = { menuItems: [], catParents: { coffee: 'hot', hot: 'drinks' } };
  assert.deepEqual(centresForItemByCategory({ id: 'i1', cat: 'coffee' }, config, ctx), ['k']);
});

test('centresForItemByCategory: the ancestor walk stops after 5 levels', () => {
  const config = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['c8'] } } };
  const catParents = {};
  for (let i = 1; i < 9; i++) catParents[`c${i}`] = `c${i + 1}`;
  assert.deepEqual(centresForItemByCategory({ id: 'i1', cat: 'c1' }, config, { menuItems: [], catParents }), []);
});

test('centresForItemByCategory: excludedItems wins, by id and by itemId', () => {
  const config = { centres: [{ id: 'k' }], routing: {
    k: { assignedCategories: ['coffee'], excludedItems: ['latte'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'latte', cat: 'coffee' }, config, CTX), []);
  assert.deepEqual(centresForItemByCategory({ itemId: 'latte', cat: 'coffee' }, config, CTX), []);
  assert.deepEqual(centresForItemByCategory({ id: 'flatwhite', cat: 'coffee' }, config, CTX), ['k']);
});

// ── resolveCentresForItem ────────────────────────────────────────────────────

// Peter's case: the same coffee, split by order type.
const COFFEE_CONFIG = {
  centres: [{ id: 'dine' }, { id: 'togo' }],
  routing: {
    dine: { assignedCategories: ['coffee'], orderTypes: ['dine-in'] },
    togo: { assignedCategories: ['coffee'], orderTypes: ['takeaway'] },
  },
};
const COFFEE = { id: 'latte', cat: 'coffee' };

test('resolveCentresForItem: a dine in coffee goes only to the dine in centre', () => {
  const out = resolveCentresForItem(COFFEE, COFFEE_CONFIG, { ...CTX, orderType: 'dine-in' });
  assert.deepEqual(out.centreIds, ['dine']);
  assert.equal(out.usedTypeFallback, false);
  assert.equal(out.typeKey, 'dine-in');
});

test('resolveCentresForItem: a takeaway coffee goes only to the takeaway centre', () => {
  const out = resolveCentresForItem(COFFEE, COFFEE_CONFIG, { ...CTX, orderType: 'takeaway' });
  assert.deepEqual(out.centreIds, ['togo']);
  assert.equal(out.usedTypeFallback, false);
});

test('resolveCentresForItem: an existing venue with no orderTypes saved is unchanged', () => {
  const config = { centres: [{ id: 'k' }, { id: 'b' }], routing: {
    k: { assignedCategories: ['coffee'] },
    b: { assignedCategories: ['coffee'] },
  } };
  for (const orderType of [...ORDER_TYPE_KEYS, null, 'bar-tab']) {
    const out = resolveCentresForItem(COFFEE, config, { ...CTX, orderType });
    assert.deepEqual(out.centreIds, ['k', 'b']);
    assert.equal(out.usedTypeFallback, false);
  }
});

test('resolveCentresForItem: food is never lost when no centre takes the type', () => {
  const out = resolveCentresForItem(COFFEE, COFFEE_CONFIG, { ...CTX, orderType: 'delivery' });
  assert.deepEqual(out.centreIds, ['dine', 'togo']);
  assert.deepEqual(out.byCategory, ['dine', 'togo']);
  assert.equal(out.usedTypeFallback, true);
  assert.equal(out.typeKey, 'delivery');
});

test('resolveCentresForItem: an unknown order type reaches every matching centre', () => {
  const out = resolveCentresForItem(COFFEE, COFFEE_CONFIG, { ...CTX, orderType: 'bar-tab' });
  assert.deepEqual(out.centreIds, ['dine', 'togo']);
  assert.equal(out.usedTypeFallback, false);
  assert.equal(out.typeKey, null);
});

test('resolveCentresForItem: a centre with no categories stays out even when the type matches', () => {
  const config = { centres: [{ id: 'empty' }, { id: 'togo' }], routing: {
    empty: { assignedCategories: [], orderTypes: ['takeaway'] },
    togo: { assignedCategories: ['coffee'], orderTypes: ['takeaway'] },
  } };
  const out = resolveCentresForItem(COFFEE, config, { ...CTX, orderType: 'takeaway' });
  assert.deepEqual(out.centreIds, ['togo']);
});

test('resolveCentresForItem: nothing matched the category stays nothing, with no fallback', () => {
  const out = resolveCentresForItem({ id: 'i1', cat: 'pizza' }, COFFEE_CONFIG, { ...CTX, orderType: 'takeaway' });
  assert.deepEqual(out.centreIds, []);
  assert.equal(out.usedTypeFallback, false);
});

test('resolveCentresForItem: a raw till order type string normalises', () => {
  const out = resolveCentresForItem(COFFEE, COFFEE_CONFIG, { ...CTX, orderType: 'Dine In' });
  assert.deepEqual(out.centreIds, ['dine']);
});

// ── screen copy helpers ──────────────────────────────────────────────────────

test('describeCentreOrderTypes: All, one type, two types', () => {
  assert.equal(describeCentreOrderTypes(undefined), 'All order types');
  assert.equal(describeCentreOrderTypes({ orderTypes: [] }), 'All order types');
  assert.equal(describeCentreOrderTypes({ orderTypes: ['dine-in'] }), 'Eat in');
  assert.equal(describeCentreOrderTypes({ orderTypes: ['takeaway', 'dine-in'] }), 'Eat in, Takeaway');
});

test('orderTypeLabelOf: known keys only', () => {
  assert.equal(orderTypeLabelOf('dine-in'), 'Eat in');
  assert.equal(orderTypeLabelOf('bar-tab'), null);
});

test('orderTypeFallbackMessage: names the order type and stays short', () => {
  const msg = orderTypeFallbackMessage('takeaway');
  assert.match(msg, /Takeaway/);
  assert.ok(msg.length < 120, msg);
  assert.ok(!msg.includes('—') && !msg.includes('–'), msg);
  assert.match(orderTypeFallbackMessage(null), /this order type/);
});

// It is a per item result, not a statement about the venue: other centres may take this
// order type and simply not serve this category. It also says order, not food, because a
// centre can be a Bar or an Expo / pass.
test('orderTypeFallbackMessage: scoped to these items, and never says food', () => {
  const msg = orderTypeFallbackMessage('dine-in');
  assert.match(msg, /these items/);
  assert.ok(!/\bfood\b/.test(msg), msg);
  assert.ok(!/No cent(er|re) takes/.test(msg), msg);
});

test('joinList: one, two and three labels read as a sentence', () => {
  assert.equal(joinList([]), '');
  assert.equal(joinList(['Eat in']), 'Eat in');
  assert.equal(joinList(['Eat in', 'Collection']), 'Eat in and Collection');
  assert.equal(joinList(['Eat in', 'Takeaway', 'Delivery']), 'Eat in, Takeaway and Delivery');
  assert.equal(joinList(null), '');
});

// ── fallbackOrderTypesForCentre: the Back Office warning ─────────────────────
// Asked per category, not per venue. The venue wide question ("does SOME centre take
// Takeaway?") answers yes as soon as one coffee bar does, and then says nothing about the
// takeaway pizza whose only centre is Eat in only. That is the case that actually bites.

test('fallbackOrderTypesForCentre: every centre on All warns about nothing', () => {
  const centres = [{ id: 'k' }, { id: 'b' }];
  const routing = { k: { assignedCategories: ['c1'] }, b: { assignedCategories: ['c2'], orderTypes: [] } };
  assert.deepEqual(fallbackOrderTypesForCentre('k', centres, routing), []);
});

test('fallbackOrderTypesForCentre: one Eat in centre leaves the other three to the fallback', () => {
  const centres = [{ id: 'k' }];
  const routing = { k: { assignedCategories: ['c1'], orderTypes: ['dine-in'] } };
  assert.deepEqual(fallbackOrderTypesForCentre('k', centres, routing), ['takeaway', 'collection', 'delivery']);
});

// Peter's brief, exactly: only the coffee is split out. The burger still has nowhere to go
// for a takeaway, even though the Bar takes every order type.
test('fallbackOrderTypesForCentre: a drinks centre on All does not cover the food categories', () => {
  const centres = [{ id: 'kitchen' }, { id: 'bar' }];
  const routing = {
    kitchen: { assignedCategories: ['food', 'drinks'], orderTypes: ['dine-in'] },
    bar: { assignedCategories: ['drinks'] },
  };
  // food is Eat in only, so the other three types fall back for it
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', centres, routing), ['takeaway', 'collection', 'delivery']);
  // the bar's own category is covered by the bar itself
  assert.deepEqual(fallbackOrderTypesForCentre('bar', centres, routing), []);
});

test('fallbackOrderTypesForCentre: a second centre on the same category closes the gap', () => {
  const centres = [{ id: 'dine' }, { id: 'togo' }];
  const routing = {
    dine: { assignedCategories: ['coffee'], orderTypes: ['dine-in'] },
    togo: { assignedCategories: ['coffee'], orderTypes: ['takeaway'] },
  };
  // collection and delivery are still nobody's, which is honest: they do fall back
  assert.deepEqual(fallbackOrderTypesForCentre('dine', centres, routing), ['collection', 'delivery']);
});

test('fallbackOrderTypesForCentre: a centre assigned the parent category covers its children', () => {
  const centres = [{ id: 'kitchen' }, { id: 'togo' }];
  const routing = {
    kitchen: { assignedCategories: ['coffee'], orderTypes: ['dine-in'] },
    togo: { assignedCategories: ['drinks'], orderTypes: ['takeaway', 'collection', 'delivery'] },
  };
  const catParents = { coffee: 'hot', hot: 'drinks' };
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', centres, routing, catParents), []);
  // with no hierarchy passed the same config reads as a gap, so the map matters
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', centres, routing), ['takeaway', 'collection', 'delivery']);
});

test('fallbackOrderTypesForCentre: a centre with no categories warns about nothing', () => {
  const centres = [{ id: 'k' }, { id: 'empty' }];
  const routing = {
    k: { assignedCategories: ['c1'], orderTypes: ['dine-in'] },
    empty: { assignedCategories: [], orderTypes: ['takeaway'] },
  };
  assert.deepEqual(fallbackOrderTypesForCentre('empty', centres, routing), []);
  assert.deepEqual(fallbackOrderTypesForCentre('missing', centres, routing), []);
});

// A centre that receives nothing must not be counted as covering a type either.
test('fallbackOrderTypesForCentre: a centre with no categories covers nothing', () => {
  const centres = [{ id: 'k' }, { id: 'empty' }];
  const routing = {
    k: { assignedCategories: ['c1'], orderTypes: ['dine-in'] },
    empty: { assignedCategories: [], orderTypes: ['takeaway', 'collection', 'delivery'] },
  };
  assert.deepEqual(fallbackOrderTypesForCentre('k', centres, routing), ['takeaway', 'collection', 'delivery']);
});

// ── nextCentreOrderTypes: the Back Office tick boxes ─────────────────────────

test('nextCentreOrderTypes: ticking one type while All is on narrows to that type', () => {
  assert.deepEqual(nextCentreOrderTypes([], 'takeaway', true), ['takeaway']);
  assert.deepEqual(nextCentreOrderTypes(undefined, 'delivery', true), ['delivery']);
});

test('nextCentreOrderTypes: adding a second type keeps both, in canonical order', () => {
  assert.deepEqual(nextCentreOrderTypes(['takeaway'], 'dine-in', true), ['dine-in', 'takeaway']);
});

test('nextCentreOrderTypes: unticking the last type brings All back', () => {
  assert.deepEqual(nextCentreOrderTypes(['takeaway'], 'takeaway', false), []);
});

test('nextCentreOrderTypes: ticking all four normalises back to All', () => {
  let list = [];
  for (const key of ORDER_TYPE_KEYS) list = nextCentreOrderTypes(list, key, true);
  assert.deepEqual(list, []);
});

test('nextCentreOrderTypes: unticking while All is on changes nothing', () => {
  assert.deepEqual(nextCentreOrderTypes([], 'takeaway', false), []);
});

test('nextCentreOrderTypes: an unknown key is ignored', () => {
  assert.deepEqual(nextCentreOrderTypes(['takeaway'], 'bar-tab', true), ['takeaway']);
});
