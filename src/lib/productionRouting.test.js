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
  buildCatParentMap,
  categoryChain,
  routingCategoryOf,
  centresForCategory,
  categoryStateForCentre,
  nextCentreCategories,
  nextExcludedItems,
  channelFallbackCentre,
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

test('normaliseCentreOrderTypes: every type ticked collapses back to All', () => {
  assert.deepEqual(normaliseCentreOrderTypes([...ORDER_TYPE_KEYS]), []);
  assert.equal(ORDER_TYPE_KEYS.length, 5);
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

// 30 Sep 2026: this test used to tick coffee at Kitchen AND drinks (coffee's ancestor) at
// To go, and expect To go to cover coffee. That is exactly the case sub category routing
// redefines: the nearest tick wins, so coffee ticked at Kitchen MOVES coffee to Kitchen.
// Replaced by the two tests below.
test('fallbackOrderTypesForCentre: a child ticked nowhere is covered by its parent\'s centre', () => {
  const centres = [{ id: 'kitchen' }, { id: 'togo' }];
  const routing = {
    kitchen: { assignedCategories: ['food'], orderTypes: ['dine-in'] },
    togo: { assignedCategories: ['drinks'], orderTypes: ['takeaway', 'collection', 'delivery'] },
  };
  const catParents = { coffee: 'hot', hot: 'drinks', food: null, drinks: null };
  // To go receives coffee with drinks and takes every type but Eat in: no gap there
  assert.deepEqual(fallbackOrderTypesForCentre('togo', centres, routing, catParents), ['dine-in']);
  // Kitchen serves food only, and nobody else does
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', centres, routing, catParents), ['takeaway', 'collection', 'delivery']);
});

test('fallbackOrderTypesForCentre: a child ticked at another centre moves there, and so does its gap', () => {
  const centres = [{ id: 'kitchen' }, { id: 'togo' }];
  const routing = {
    kitchen: { assignedCategories: ['coffee'], orderTypes: ['dine-in'] },
    togo: { assignedCategories: ['drinks'], orderTypes: ['takeaway', 'collection', 'delivery'] },
  };
  const catParents = { coffee: 'hot', hot: 'drinks' };
  // coffee goes to Kitchen only now, which is Eat in only
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', centres, routing, catParents), ['takeaway', 'collection', 'delivery']);
  // To go no longer receives coffee; what it does receive (drinks, hot) it takes
  assert.deepEqual(fallbackOrderTypesForCentre('togo', centres, routing, catParents), ['dine-in']);
  assert.deepEqual(centresForItemByCategory({ id: 'latte', cat: 'coffee' }, { centres, routing }, { menuItems: [], catParents }), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ id: 'tea', cat: 'hot' }, { centres, routing }, { menuItems: [], catParents }), ['togo']);
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

test('nextCentreOrderTypes: ticking every type normalises back to All', () => {
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

// ── Drive thru (16 Sep 2026): the fifth key ─────────────────────────────────

test('drive-thru: a fifth key, honoured in every spelling, with its own label', () => {
  assert.deepEqual(ORDER_TYPE_KEYS, ['dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru']);
  assert.equal(orderTypeLabelOf('drive-thru'), 'Drive thru');
  assert.deepEqual(normaliseCentreOrderTypes(['drive-thru']), ['drive-thru']);
  assert.deepEqual(normaliseCentreOrderTypes(['drive_thru', 'Drive Thru', 'drive-through']), ['drive-thru']);
  assert.deepEqual(normaliseCentreOrderTypes(['drive-thru', 'dine-in']), ['dine-in', 'drive-thru']);
  assert.equal(describeCentreOrderTypes({ orderTypes: ['drive-thru', 'takeaway'] }), 'Takeaway, Drive thru');
  assert.equal(resolveOrderTypeKey({ type: 'drive-thru' }), 'drive-thru');
  assert.equal(resolveOrderTypeKey({ type: 'Drive thru' }), 'drive-thru');
  assert.match(orderTypeFallbackMessage('drive-thru'), /Drive thru/);
  assert.deepEqual(nextCentreOrderTypes([], 'drive-thru', true), ['drive-thru']);
  assert.deepEqual(nextCentreOrderTypes(['takeaway'], 'drive-thru', true), ['takeaway', 'drive-thru']);
});

// A centre saved with the old four explicit ticks is no longer "every type", so it does not take
// drive thru; the safety rule below still routes the order. Back Office always collapsed four
// ticks to [] (All), and live routing rows are all null, so no existing centre is in this state.
test('drive-thru: a centre narrowed to other types does not take it; All and the old four ticks behave as pinned', () => {
  assert.equal(centreTakesOrderType({ orderTypes: ['takeaway'] }, 'drive-thru'), false);
  assert.equal(centreTakesOrderType({ orderTypes: ['drive-thru'] }, 'drive-thru'), true);
  assert.equal(centreTakesOrderType({ orderTypes: ['drive-thru'] }, 'takeaway'), false);
  assert.equal(centreTakesOrderType({ orderTypes: [] }, 'drive-thru'), true);
  assert.equal(centreTakesOrderType(undefined, 'drive-thru'), true);
  const oldFour = ['dine-in', 'takeaway', 'collection', 'delivery'];
  assert.deepEqual(normaliseCentreOrderTypes(oldFour), oldFour);
  assert.equal(centreTakesOrderType({ orderTypes: oldFour }, 'drive-thru'), false);
  for (const key of oldFour) assert.equal(centreTakesOrderType({ orderTypes: oldFour }, key), true, key);
});

test('drive-thru: routes to a drive thru centre, and to the safety fallback when no centre takes it', () => {
  const config = { centres: [{ id: 'dine' }, { id: 'window' }], routing: {
    dine: { assignedCategories: ['coffee'], orderTypes: ['dine-in'] },
    window: { assignedCategories: ['coffee'], orderTypes: ['drive-thru', 'takeaway'] },
  } };
  const out = resolveCentresForItem(COFFEE, config, { ...CTX, orderType: 'drive-thru' });
  assert.deepEqual(out.centreIds, ['window']);
  assert.equal(out.usedTypeFallback, false);
  assert.equal(out.typeKey, 'drive-thru');
  assert.deepEqual(resolveCentresForItem(COFFEE, config, { ...CTX, orderType: 'dine-in' }).centreIds, ['dine']);
  // no centre takes drive thru: the food still goes to every centre the category matched
  const fb = resolveCentresForItem(COFFEE, COFFEE_CONFIG, { ...CTX, orderType: 'drive-thru' });
  assert.deepEqual(fb.centreIds, ['dine', 'togo']);
  assert.equal(fb.usedTypeFallback, true);
  assert.equal(fb.typeKey, 'drive-thru');
  // the window takes drive thru for the coffee, so the Back Office warning has no drive thru gap
  assert.deepEqual(fallbackOrderTypesForCentre('dine', config.centres, config.routing), ['collection', 'delivery']);
});

// The Back Office gap warning names drive thru only once some centre's saved order types do.
// A venue that never ticked drive thru on a till reads "No center takes Takeaway, Collection
// or Delivery ..." exactly as it did before the type existed.
test('drive-thru: the gap warning stays silent on drive thru until a centre names it', () => {
  // no centre names it: byte identical to the pre drive thru list
  assert.deepEqual(fallbackOrderTypesForCentre('dine', COFFEE_CONFIG.centres, COFFEE_CONFIG.routing), ['collection', 'delivery']);
  // a centre names it but serves a different category: the gap is real and is named
  const elsewhere = { centres: [{ id: 'dine' }, { id: 'window' }], routing: {
    dine: { assignedCategories: ['coffee'], orderTypes: ['dine-in'] },
    window: { assignedCategories: ['drinks'], orderTypes: ['drive-thru'] },
  } };
  assert.deepEqual(fallbackOrderTypesForCentre('dine', elsewhere.centres, elsewhere.routing), ['takeaway', 'collection', 'delivery', 'drive-thru']);
  // the naming centre may have no categories at all: it still says the venue runs drive thru
  const empty = { centres: [{ id: 'k' }, { id: 'empty' }], routing: {
    k: { assignedCategories: ['c1'], orderTypes: ['dine-in'] },
    empty: { assignedCategories: [], orderTypes: ['drive-thru'] },
  } };
  assert.deepEqual(fallbackOrderTypesForCentre('k', empty.centres, empty.routing), ['takeaway', 'collection', 'delivery', 'drive-thru']);
  // a hand typed spelling counts as naming it
  const spelled = { centres: [{ id: 'k' }, { id: 'w' }], routing: {
    k: { assignedCategories: ['c1'], orderTypes: ['dine-in'] },
    w: { assignedCategories: ['c2'], orderTypes: ['drive_thru'] },
  } };
  assert.deepEqual(fallbackOrderTypesForCentre('k', spelled.centres, spelled.routing), ['takeaway', 'collection', 'delivery', 'drive-thru']);
  // All order types on every centre still warns about nothing
  const all = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['c1'], orderTypes: [] } } };
  assert.deepEqual(fallbackOrderTypesForCentre('k', all.centres, all.routing), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 30 Sep 2026: sub categories and sizes (Peter at Coffee Boy: "also need the sub
// categories been able to be chose where they go").
// ═════════════════════════════════════════════════════════════════════════════

// The category stage exactly as it shipped before sub category routing, frozen here so
// every venue's existing routing can be compared against it. Do not "fix" this copy.
function legacyCatOrAncestorMatches(catId, assignedSet, parentMap, depth = 0) {
  if (!catId || depth > 5) return false;
  if (assignedSet.has(catId)) return true;
  const parentId = parentMap?.[catId];
  if (!parentId) return false;
  return legacyCatOrAncestorMatches(parentId, assignedSet, parentMap, depth + 1);
}
function legacyCentresForItemByCategory(item, config, ctx) {
  const centres = config?.centres;
  const routing = config?.routing;
  if (!centres?.length || !routing) return [];
  const allItems = ctx?.menuItems || [];
  const menuItem = allItems.find(i => i.id === (item?.itemId || item?.id));
  const itemCat = item?.cat || item?.cats?.[0] || menuItem?.cat || menuItem?.cats?.[0] || null;
  const parentId = item?.parentId || menuItem?.parentId || null;
  const parentMenuItem = parentId ? allItems.find(i => i.id === parentId) : null;
  const parentCat = parentMenuItem?.cat || parentMenuItem?.cats?.[0] || null;
  const parentMap = ctx?.catParents || {};
  const matched = [];
  centres.forEach(centre => {
    const r = routing[centre.id];
    if (!r?.assignedCategories?.length) return;
    if (r.excludedItems?.includes(item?.id) || r.excludedItems?.includes(item?.itemId)) return;
    const assignedSet = new Set(r.assignedCategories);
    const catMatches = (itemCat && legacyCatOrAncestorMatches(itemCat, assignedSet, parentMap)) ||
                       (parentCat && legacyCatOrAncestorMatches(parentCat, assignedSet, parentMap));
    if (catMatches) matched.push(centre.id);
  });
  return matched;
}
function legacyResolve(item, config, ctx) {
  const typeKey = resolveOrderTypeKey({ type: ctx?.orderType });
  const byCategory = legacyCentresForItemByCategory(item, config, ctx);
  const narrowed = byCategory.filter(id => centreTakesOrderType(config?.routing?.[id], typeKey));
  if (!narrowed.length && byCategory.length) return { centreIds: byCategory, usedTypeFallback: true };
  return { centreIds: narrowed, usedTypeFallback: false };
}
function legacyFallbackOrderTypesForCentre(centreId, centres, routing, parentMap) {
  const cats = routing?.[centreId]?.assignedCategories || [];
  if (!cats.length) return [];
  const configured = (centres || []).filter(c => routing?.[c?.id]?.assignedCategories?.length);
  const serves = (centre, catId) =>
    legacyCatOrAncestorMatches(catId, new Set(routing[centre.id].assignedCategories), parentMap || {});
  const namesDriveThru = (centres || []).some(c =>
    normaliseCentreOrderTypes(routing?.[c?.id]?.orderTypes).includes('drive-thru'));
  const keys = namesDriveThru ? ORDER_TYPE_KEYS : ORDER_TYPE_KEYS.filter(k => k !== 'drive-thru');
  return keys.filter(key => cats.some(catId =>
    !configured.some(c => serves(c, catId) && centreTakesOrderType(routing[c.id], key))
  ));
}

const TYPES = [null, ...ORDER_TYPE_KEYS];
const sortIds = (a) => [...a].sort();

// The three shapes a line arrives in: the till (stamps the product's category on a size),
// an online line (the item's own cat and cats), and HubRise / ezCater (itemId only).
function lineShapes(mi, menuItems) {
  const product = mi.parentId ? menuItems.find(p => p.id === mi.parentId) : null;
  return {
    till: { uid: 'u1', itemId: mi.id, cat: product?.cat || mi.cat || null, parentId: mi.parentId || null },
    online: { itemId: mi.id, cat: mi.cat || null, cats: mi.cats, parentId: mi.parentId || null },
    hubrise: { itemId: mi.id },
  };
}

function assertSameAsLegacy(config, categories, menuItems, label) {
  const catParents = buildCatParentMap(categories);
  let checks = 0;
  for (const mi of menuItems) {
    for (const [shape, line] of Object.entries(lineShapes(mi, menuItems))) {
      for (const orderType of TYPES) {
        const ctx = { menuItems, catParents, orderType };
        const a = legacyResolve(line, config, ctx);
        const b = resolveCentresForItem(line, config, ctx);
        assert.deepEqual(sortIds(b.centreIds), sortIds(a.centreIds), `${label}: ${mi.id} ${shape} ${orderType}`);
        assert.equal(b.usedTypeFallback, a.usedTypeFallback, `${label}: ${mi.id} ${shape} ${orderType} fallback`);
        checks++;
      }
    }
  }
  for (const c of config.centres) {
    assert.deepEqual(
      fallbackOrderTypesForCentre(c.id, config.centres, config.routing, catParents),
      legacyFallbackOrderTypesForCentre(c.id, config.centres, config.routing, catParents),
      `${label}: warning for ${c.id}`,
    );
  }
  return checks;
}

// Coffee Boy Barnsley's shape: cat is the sub category, cats holds its parent ("Also in"),
// sizes carry their product's cat, Match | Iced Matcha is ticked at BOTH centres, a
// three level tree (Hot/Iced Coffee > Coffee > Hot Coffee), and every tick top level.
const BARNSLEY_CATS = [
  { id: 'hic', parentId: null, label: 'Hot/Iced Coffee' },
  { id: 'coffee', parentId: 'hic', label: 'Coffee' },
  { id: 'hot', parentId: 'coffee', label: 'Hot Coffee' },
  { id: 'iced', parentId: 'coffee', label: 'Iced Coffee' },
  { id: 'bc', parentId: null, label: 'Bottles & Cans' },
  { id: 'bottles', parentId: 'bc', label: 'Bottles' },
  { id: 'food', parentId: null, label: 'Food' },
  { id: 'pastries', parentId: 'food', label: 'Pastries' },
  { id: 'toasties', parentId: 'food', label: 'Toasties' },
  { id: 'breakfast', parentId: 'food', label: 'Breakfast Menu' },
  { id: 'matcha', parentId: null, label: 'Match | Iced Matcha' },
  { id: 'donuts', parentId: null, label: 'Donuts' },
];
const BARNSLEY_ITEMS = [
  { id: 'latte', name: 'Latte', cat: 'hot', cats: ['coffee'] },
  { id: 'latte-s', name: 'Small Boy', cat: 'hot', cats: [], parentId: 'latte' },
  { id: 'latte-b', name: 'Big Boy', cat: 'hot', cats: [], parentId: 'latte' },
  { id: 'iced-latte', name: 'Iced Latte', cat: 'iced', cats: ['coffee'] },
  { id: 'water', name: 'Water', cat: 'bottles', cats: ['bc'] },
  { id: 'roll', name: 'Cinnamon Roll', cat: 'pastries', cats: ['food'] },
  { id: 'toastie', name: 'BBQ Toastie', cat: 'toasties', cats: [] },
  { id: 'porridge', name: 'Porridge', cat: 'breakfast', cats: ['food'] },
  { id: 'soup', name: 'Soup', cat: 'food', cats: [] },
  { id: 'matcha', name: 'Matcha', cat: 'matcha', cats: [] },
  { id: 'matcha-s', name: 'Small Boy', cat: 'matcha', cats: [], parentId: 'matcha' },
  { id: 'matcha-b', name: 'Big Boy', cat: 'matcha', cats: [], parentId: 'matcha' },
  { id: 'matcha-xl', name: 'XL Boy', cat: 'matcha', cats: [], parentId: 'matcha' },
  { id: 'jam', name: 'Jam Donut', cat: 'donuts', cats: ['donuts'] },
  { id: 'loose', name: 'No category', cat: '', cats: [] },
];
const BARNSLEY = {
  centres: [{ id: 'drinks', name: 'KDS drinks' }, { id: 'kfood', name: 'kds food' }],
  routing: {
    drinks: { assignedCategories: ['hic', 'bc', 'matcha'], excludedItems: [], orderTypes: [] },
    kfood: { assignedCategories: ['food', 'matcha'], excludedItems: [], orderTypes: ['dine-in'] },
  },
};

test('legacy: a Barnsley shaped venue routes every item exactly as before', () => {
  const checks = assertSameAsLegacy(BARNSLEY, BARNSLEY_CATS, BARNSLEY_ITEMS, 'barnsley');
  assert.ok(checks >= BARNSLEY_ITEMS.length * 3 * TYPES.length);
});

// Provo's shape is the reverse: cat is the PARENT, cats the sub (Mains + Steaks), and two
// ticks point at categories deleted long ago.
const PROVO_CATS = [
  { id: 'mains', parentId: null, label: 'Mains' },
  { id: 'steaks', parentId: 'mains', label: 'Steaks' },
  { id: 'chicken', parentId: 'mains', label: 'Chicken' },
  { id: 'alcohol', parentId: null, label: 'Alcohol' },
  { id: 'cocktails', parentId: 'alcohol', label: 'Coktails' },
  { id: 'hotdrinks', parentId: null, label: 'Hot Drinks' },
  { id: 'coffee', parentId: 'hotdrinks', label: 'Coffee' },
  { id: 'sides', parentId: null, label: 'Sides' },
];
const PROVO_ITEMS = [
  { id: 'ribeye', name: '16oz Ribeye', cat: 'mains', cats: ['steaks'] },
  { id: 'bird', name: 'Half Bird', cat: 'mains', cats: ['chicken'] },
  { id: 'burger', name: 'Burger', cat: 'mains', cats: [] },
  { id: 'mojito', name: 'Mojito', cat: 'alcohol', cats: ['cocktails'] },
  { id: 'flat', name: 'Flat White', cat: 'hotdrinks', cats: ['coffee'] },
  { id: 'fries', name: 'Truffle Fries', cat: 'sides', cats: ['mains'] },
  { id: 'dead', name: 'Old item', cat: 'cat-gone', cats: [] },
];
const PROVO = {
  centres: [{ id: 'bar', name: 'KDS Bar' }, { id: 'kitchen', name: 'Kitchen' }],
  routing: {
    bar: { assignedCategories: ['alcohol', 'hotdrinks', 'cat-deleted-1'], excludedItems: [] },
    kitchen: { assignedCategories: ['mains', 'sides', 'cat-deleted-2'], excludedItems: [] },
  },
};

test('legacy: a Provo shaped venue (cat is the parent, deleted ids ticked) routes exactly as before', () => {
  assertSameAsLegacy(PROVO, PROVO_CATS, PROVO_ITEMS, 'provo');
});

// A small seeded generator, so a failure always reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

// A random tree up to 3 deep, items using every "Also in" pattern seen live, and sizes
// whose own cat is their product's or another category under the same top level one (the
// shape every live size has except the two demo donut boxes).
function randomVenue(seed, { subTicks = false, itemExclusions = false } = {}) {
  const r = rng(seed);
  const cats = [];
  const tops = 2 + Math.floor(r() * 3);
  for (let t = 0; t < tops; t++) {
    const top = `t${t}`;
    cats.push({ id: top, parentId: null });
    const kids = Math.floor(r() * 3);
    for (let k = 0; k < kids; k++) {
      const kid = `${top}k${k}`;
      cats.push({ id: kid, parentId: top });
      const grand = Math.floor(r() * 2);
      for (let g = 0; g < grand; g++) cats.push({ id: `${kid}g${g}`, parentId: kid });
    }
  }
  const pm = buildCatParentMap(cats);
  const topOf = (id) => { const ch = categoryChain(id, pm); return ch[ch.length - 1]; };
  const sameTop = (id) => cats.filter(c => topOf(c.id) === topOf(id));
  const items = [];
  const n = 6 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const cat = pick(r, cats).id;
    const pattern = Math.floor(r() * 6);
    let cats2 = [];
    if (pattern === 1 && pm[cat]) cats2 = [pm[cat]];                   // Coffee Boy: Also in the parent
    if (pattern === 2) cats2 = [cat];                                   // repeats cat
    if (pattern === 3) cats2 = [pick(r, cats).id];                      // anything
    if (pattern === 4) cats2 = ['cat-dead'];                            // a dead id
    if (pattern === 5) cats2 = sameTop(cat).filter(c => categoryChain(c.id, pm).includes(cat)).map(c => c.id).slice(0, 2); // Provo: inside
    const emptyCat = r() < 0.1;
    const item = { id: `i${i}`, name: `Item ${i}`, cat: emptyCat ? '' : cat, cats: cats2 };
    items.push(item);
    const sizes = r() < 0.3 ? 1 + Math.floor(r() * 3) : 0;
    const productCat = item.cat || cats2[0];
    for (let s = 0; s < sizes; s++) {
      const own = productCat && productCat !== 'cat-dead' && r() < 0.3 ? pick(r, sameTop(productCat)).id : productCat;
      items.push({ id: `i${i}s${s}`, name: `Size ${s}`, cat: own || '', cats: [], parentId: item.id });
    }
    if (r() < 0.1) items.push({ id: `i${i}o`, name: 'Orphan size', cat, cats: [], parentId: 'missing-product' });
  }
  const centres = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const routing = {};
  const tickable = subTicks ? cats : cats.filter(c => !c.parentId);
  const orderTypeChoices = [[], ['dine-in'], ['takeaway'], ['dine-in', 'takeaway'], ['collection', 'delivery']];
  centres.forEach(c => {
    const ticks = tickable.filter(() => r() < 0.4).map(x => x.id);
    if (r() < 0.2) ticks.push('cat-dead-tick');
    routing[c.id] = { assignedCategories: ticks, excludedItems: [], orderTypes: pick(r, orderTypeChoices) };
    if (subTicks) {
      routing[c.id].excludedCategories = cats.filter(() => r() < 0.15).map(x => x.id);
      routing[c.id].excludedItems = items.filter(() => r() < 0.1).map(x => x.id);
    }
    // Products with sizes are picked too: the screen live before this change saved a
    // product id when its row was unticked.
    if (itemExclusions) routing[c.id].excludedItems = items.filter(() => r() < 0.25).map(x => x.id);
  });
  return { cats, items, config: { centres, routing } };
}

test('legacy: 300 random venues with only top level ticks route exactly as before', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const v = randomVenue(seed);
    assertSameAsLegacy(v.config, v.cats, v.items, `seed ${seed}`);
  }
});

test('legacy: 300 random venues with top level ticks and saved item exclusions (product ids too) route exactly as before', () => {
  let products = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const v = randomVenue(seed, { itemExclusions: true });
    const withSizes = new Set(v.items.filter(i => i.parentId).map(i => i.parentId));
    products += Object.values(v.config.routing).reduce((n, e) => n + e.excludedItems.filter(id => withSizes.has(id)).length, 0);
    assertSameAsLegacy(v.config, v.cats, v.items, `seed ${seed}`);
  }
  assert.ok(products > 50, `product ids excluded ${products}`);
});

// With sub category ticks, Not here and item exclusions, a till that has not reloaded
// (the legacy rule) sends a SUPERSET: food still arrives, maybe at one centre too many.
// The one exception is an item routed by an "Also in" sub category (Provo's steaks),
// asserted separately below.
test('legacy: with sub ticks and Not here, an old till sends a superset of the new rule', () => {
  let compared = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const v = randomVenue(seed, { subTicks: true });
    const catParents = buildCatParentMap(v.cats);
    for (const mi of v.items) {
      for (const line of Object.values(lineShapes(mi, v.items))) {
        const ctx = { menuItems: v.items, catParents };
        const rc = routingCategoryOf(line, ctx);
        if (rc.catId !== rc.primaryId) continue;
        const next = centresForItemByCategory(line, v.config, ctx);
        const old = legacyCentresForItemByCategory(line, v.config, ctx);
        for (const id of next) assert.ok(old.includes(id), `seed ${seed} ${mi.id}: ${id} not in ${old}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 1000, `compared ${compared}`);
});

test('legacy: the exception, an old till routes Provo\'s ribeye by Mains and misses a Steaks only tick', () => {
  const config = { centres: [{ id: 'grill' }], routing: { grill: { assignedCategories: ['steaks'] } } };
  const ctx = { menuItems: PROVO_ITEMS, catParents: buildCatParentMap(PROVO_CATS) };
  assert.deepEqual(centresForItemByCategory({ itemId: 'ribeye' }, config, ctx), ['grill']);
  assert.deepEqual(legacyCentresForItemByCategory({ itemId: 'ribeye' }, config, ctx), []);
});

// ── the sub category rule ────────────────────────────────────────────────────

const FOOD_CATS = { food: null, donuts: 'food', pastries: 'food', toasties: 'food', glazed: 'donuts', drinks: null };
const fctx = (menuItems = []) => ({ menuItems, catParents: FOOD_CATS });

test('sub categories: Food to Kitchen, Donuts to Bakery', () => {
  const config = { centres: [{ id: 'kitchen' }, { id: 'bakery' }], routing: {
    kitchen: { assignedCategories: ['food'] },
    bakery: { assignedCategories: ['donuts'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'jam', cat: 'donuts' }, config, fctx()), ['bakery']);
  assert.deepEqual(centresForItemByCategory({ id: 'glazed', cat: 'glazed' }, config, fctx()), ['bakery']);
  assert.deepEqual(centresForItemByCategory({ id: 'toastie', cat: 'toasties' }, config, fctx()), ['kitchen']);
  // an item sitting directly in Food
  assert.deepEqual(centresForItemByCategory({ id: 'soup', cat: 'food' }, config, fctx()), ['kitchen']);
});

test('sub categories: Donuts ticked at both centres goes to both', () => {
  const config = { centres: [{ id: 'kitchen' }, { id: 'bakery' }], routing: {
    kitchen: { assignedCategories: ['food', 'donuts'] },
    bakery: { assignedCategories: ['donuts'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'jam', cat: 'donuts' }, config, fctx()), ['kitchen', 'bakery']);
  // shared at the same level: both centres tick Food
  const shared = { centres: [{ id: 'kitchen' }, { id: 'bar' }], routing: {
    kitchen: { assignedCategories: ['food'] }, bar: { assignedCategories: ['food'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'roll', cat: 'pastries' }, shared, fctx()), ['kitchen', 'bar']);
});

test('sub categories: Not here stops a sub category, only at that centre', () => {
  const config = { centres: [{ id: 'kitchen' }, { id: 'bar' }], routing: {
    kitchen: { assignedCategories: ['food'], excludedCategories: ['pastries'] },
    bar: { assignedCategories: ['drinks'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'roll', cat: 'pastries' }, config, fctx()), []);
  assert.deepEqual(centresForItemByCategory({ id: 'toastie', cat: 'toasties' }, config, fctx()), ['kitchen']);
  // a second centre ticking Food still gets pastries
  const two = { ...config, routing: { ...config.routing, bar: { assignedCategories: ['food'] } } };
  assert.deepEqual(centresForItemByCategory({ id: 'roll', cat: 'pastries' }, two, fctx()), ['bar']);
});

test('sub categories: a sub category under a Not here comes back when it is ticked', () => {
  const config = { centres: [{ id: 'kitchen' }], routing: {
    kitchen: { assignedCategories: ['food', 'glazed'], excludedCategories: ['donuts'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'jam', cat: 'donuts' }, config, fctx()), []);
  assert.deepEqual(centresForItemByCategory({ id: 'g', cat: 'glazed' }, config, fctx()), ['kitchen']);
});

test('sub categories: the nearest tick wins at depth 3', () => {
  const catParents = { a: null, b: 'a', c: 'b' };
  const config = { centres: [{ id: 'x' }, { id: 'y' }, { id: 'z' }], routing: {
    x: { assignedCategories: ['a'] }, y: { assignedCategories: ['b'] }, z: { assignedCategories: ['c'] },
  } };
  const ctx = { menuItems: [], catParents };
  assert.deepEqual(centresForItemByCategory({ id: '1', cat: 'c' }, config, ctx), ['z']);
  assert.deepEqual(centresForItemByCategory({ id: '2', cat: 'b' }, config, ctx), ['y']);
  assert.deepEqual(centresForItemByCategory({ id: '3', cat: 'a' }, config, ctx), ['x']);
  assert.equal(centresForCategory('c', config, catParents).via, 'c');
});

test('sub categories: a Not here on the deciding tick itself, or above it, is ignored', () => {
  const config = { centres: [{ id: 'kitchen' }], routing: {
    kitchen: { assignedCategories: ['donuts'], excludedCategories: ['donuts', 'food'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'jam', cat: 'donuts' }, config, fctx()), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ id: 'g', cat: 'glazed' }, config, fctx()), ['kitchen']);
});

test('sub categories: the walk stops at 6 levels and at a parent loop', () => {
  const chain = {};
  for (let i = 1; i < 9; i++) chain[`c${i}`] = `c${i + 1}`;
  assert.equal(categoryChain('c1', chain).length, 6);
  const six = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['c6'] } } };
  assert.deepEqual(centresForItemByCategory({ id: 'i', cat: 'c1' }, six, { menuItems: [], catParents: chain }), ['k']);
  const seven = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['c7'] } } };
  assert.deepEqual(centresForItemByCategory({ id: 'i', cat: 'c1' }, seven, { menuItems: [], catParents: chain }), []);
  const loop = { a: 'b', b: 'a' };
  assert.deepEqual(categoryChain('a', loop), ['a', 'b']);
  const cfg = { centres: [{ id: 'k' }], routing: { k: { assignedCategories: ['z'] } } };
  assert.deepEqual(centresForItemByCategory({ id: 'i', cat: 'a' }, cfg, { menuItems: [], catParents: loop }), []);
  assert.deepEqual(categoryChain('self', { self: 'self' }), ['self']);
});

test('sub categories: a tick on a deleted category changes nothing', () => {
  const config = { centres: [{ id: 'kitchen' }, { id: 'bar' }], routing: {
    kitchen: { assignedCategories: ['food', 'cat-deleted'] }, bar: { assignedCategories: ['cat-other-deleted'] },
  } };
  assert.deepEqual(centresForItemByCategory({ id: 'roll', cat: 'pastries' }, config, fctx()), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ id: 'x', cat: 'drinks' }, config, fctx()), []);
});

test('buildCatParentMap: the store shape wins, a raw row is read, "Move to root" is honoured', () => {
  assert.deepEqual(buildCatParentMap([
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parent_id: 'a' },
    { id: 'd', parentId: null, parent_id: 'a' },   // moved to root in Menu this session
    null, { name: 'no id' },
  ]), { a: null, b: 'a', c: 'a', d: null });
  assert.deepEqual(buildCatParentMap(null), {});
});

// ── items ────────────────────────────────────────────────────────────────────

// The demo Huddersfield venue: "Box Of 3" is in Donuts, its sizes were saved with Cold
// Drinks. The till always routed them by the product; online and HubRise lines also reached
// the Cold Drinks centre. Now every channel agrees with the till.
test('items: a size follows its product, with or without a category on the line', () => {
  const catParents = { donuts: null, cold: null };
  const menuItems = [
    { id: 'box', cat: 'donuts', cats: [] },
    { id: 'box-3', cat: 'cold', cats: [], parentId: 'box' },
  ];
  const config = { centres: [{ id: 'kitchen' }, { id: 'bar' }], routing: {
    kitchen: { assignedCategories: ['donuts'] }, bar: { assignedCategories: ['cold'] },
  } };
  const ctx = { menuItems, catParents };
  assert.deepEqual(centresForItemByCategory({ itemId: 'box-3' }, config, ctx), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ itemId: 'box-3', cat: 'cold', parentId: 'box' }, config, ctx), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ itemId: 'box-3', cat: 'donuts', parentId: 'box' }, config, ctx), ['kitchen']);
  // the legacy rule reached both for the online shape
  assert.deepEqual(legacyCentresForItemByCategory({ itemId: 'box-3', cat: 'cold', parentId: 'box' }, config, ctx), ['kitchen', 'bar']);
  // a size whose product has no category routes by its own
  const bare = [{ id: 'p', cat: '', cats: [] }, { id: 'p-s', cat: 'cold', parentId: 'p' }];
  assert.deepEqual(centresForItemByCategory({ itemId: 'p-s' }, config, { menuItems: bare, catParents }), ['bar']);
});

test('items: a saved product id stops no size, exactly as before; a size id stops only that size', () => {
  const menuItems = [
    { id: 'matcha', cat: 'matcha', cats: [] },
    { id: 'matcha-s', cat: 'matcha', parentId: 'matcha' },
    { id: 'matcha-b', cat: 'matcha', parentId: 'matcha' },
  ];
  const config = { centres: [{ id: 'drinks' }, { id: 'food' }], routing: {
    drinks: { assignedCategories: ['matcha'], excludedItems: ['matcha'] },
    food: { assignedCategories: ['matcha'] },
  } };
  const ctx = { menuItems, catParents: { matcha: null } };
  // kiosk: itemId is the size, parentId the product
  const kiosk = { id: 'matcha-s', itemId: 'matcha-s', parentId: 'matcha', cat: 'matcha' };
  assert.deepEqual(centresForItemByCategory(kiosk, config, ctx), ['drinks', 'food']);
  assert.deepEqual(legacyCentresForItemByCategory(kiosk, config, ctx), ['drinks', 'food']);
  // till with only itemId
  assert.deepEqual(centresForItemByCategory({ itemId: 'matcha-b' }, config, ctx), ['drinks', 'food']);
  // a line for the product itself is stopped, as it always was
  assert.deepEqual(centresForItemByCategory({ itemId: 'matcha' }, config, ctx), ['food']);
  // a single size exclusion drops only that size
  const one = { ...config, routing: { ...config.routing, drinks: { assignedCategories: ['matcha'], excludedItems: ['matcha-b'] } } };
  assert.deepEqual(centresForItemByCategory({ itemId: 'matcha-b' }, one, ctx), ['food']);
  assert.deepEqual(centresForItemByCategory({ itemId: 'matcha-s' }, one, ctx), ['drinks', 'food']);
});

test('items: an Also in sub category inside the Primary one routes; any other Also in never does', () => {
  const ctx = { menuItems: PROVO_ITEMS, catParents: buildCatParentMap(PROVO_CATS) };
  assert.equal(routingCategoryOf({ itemId: 'ribeye' }, ctx).catId, 'steaks');
  assert.equal(routingCategoryOf({ itemId: 'ribeye' }, ctx).primaryId, 'mains');
  // Truffle Fries: Primary Sides, Also in Mains. Mains is not inside Sides.
  assert.equal(routingCategoryOf({ itemId: 'fries' }, ctx).catId, 'sides');
  const config = { centres: [{ id: 'kitchen' }, { id: 'grill' }], routing: {
    kitchen: { assignedCategories: ['sides'] }, grill: { assignedCategories: ['mains'] },
  } };
  // so the fries never print twice because of a menu display choice
  assert.deepEqual(centresForItemByCategory({ itemId: 'fries' }, config, ctx), ['kitchen']);
  // the deepest Also in wins
  const deep = { menuItems: [{ id: 'x', cat: 'food', cats: ['donuts', 'glazed'] }], catParents: FOOD_CATS };
  assert.equal(routingCategoryOf({ itemId: 'x' }, deep).catId, 'glazed');
});

test('items: an empty cat with cats [X] routes by X; a line not in the menu uses its own category', () => {
  const config = { centres: [{ id: 'kitchen' }], routing: { kitchen: { assignedCategories: ['food'] } } };
  const menuItems = [{ id: 'm1', cat: '', cats: ['pastries'] }];
  assert.equal(routingCategoryOf({ itemId: 'm1' }, fctx(menuItems)).catId, 'pastries');
  assert.deepEqual(centresForItemByCategory({ itemId: 'm1' }, config, fctx(menuItems)), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ itemId: 'hubrise-sku', cat: 'toasties' }, config, fctx()), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ itemId: 'hubrise-sku', cats: ['toasties'] }, config, fctx()), ['kitchen']);
  assert.deepEqual(centresForItemByCategory({ itemId: 'hubrise-sku' }, config, fctx()), []);
});

// ── order types ──────────────────────────────────────────────────────────────

test('order types: with Donuts at an Eat in only Bakery, a takeaway donut falls back to Bakery, not Kitchen', () => {
  const config = { centres: [{ id: 'kitchen' }, { id: 'bakery' }], routing: {
    kitchen: { assignedCategories: ['food'] },
    bakery: { assignedCategories: ['donuts'], orderTypes: ['dine-in'] },
  } };
  const out = resolveCentresForItem({ id: 'jam', cat: 'donuts' }, config, { ...fctx(), orderType: 'takeaway' });
  assert.deepEqual(out.centreIds, ['bakery']);
  assert.equal(out.usedTypeFallback, true);
  // the warning names the gap at Bakery, and Kitchen (which takes everything) has none
  assert.deepEqual(fallbackOrderTypesForCentre('bakery', config.centres, config.routing, FOOD_CATS), ['takeaway', 'collection', 'delivery']);
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', config.centres, config.routing, FOOD_CATS), []);
});

test('order types: the warning no longer counts a sub category that moved away', () => {
  const routing = {
    kitchen: { assignedCategories: ['food'], orderTypes: ['dine-in'] },
    bakery: { assignedCategories: ['donuts'] },
  };
  const centres = [{ id: 'kitchen' }, { id: 'bakery' }];
  // Kitchen still has its own gap for food, pastries and toasties
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', centres, routing, FOOD_CATS), ['takeaway', 'collection', 'delivery']);
  // with Food itself covered for takeaway elsewhere, the donuts that moved do not keep a gap alive
  const covered = { ...routing, togo: { assignedCategories: ['food'], orderTypes: ['takeaway', 'collection', 'delivery'] } };
  const withTogo = [...centres, { id: 'togo' }];
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', withTogo, covered, FOOD_CATS), []);
  // and a Not here at To go reopens the gap for pastries
  const notHere = { ...covered, togo: { ...covered.togo, excludedCategories: ['pastries'] } };
  assert.deepEqual(fallbackOrderTypesForCentre('kitchen', withTogo, notHere, FOOD_CATS), ['takeaway', 'collection', 'delivery']);
});

// ── the screen's rules ───────────────────────────────────────────────────────

const SCREEN = { centres: [{ id: 'kitchen' }, { id: 'bakery' }, { id: 'bar' }], routing: {
  kitchen: { assignedCategories: ['food'], excludedCategories: ['pastries'] },
  bakery: { assignedCategories: ['donuts'] },
  bar: { assignedCategories: ['drinks'] },
} };

test('categoryStateForCentre: every row state', () => {
  const st = (centre, cat, cfg = SCREEN) => categoryStateForCentre(centre, cat, cfg, FOOD_CATS);
  assert.equal(st('kitchen', 'food').how, 'ticked');
  assert.deepEqual(st('kitchen', 'food').otherCentreIds, []);
  assert.equal(st('kitchen', 'toasties').how, 'withParent');
  assert.equal(st('kitchen', 'toasties').via, 'food');
  assert.equal(st('kitchen', 'pastries').how, 'notHere');
  assert.equal(st('kitchen', 'pastries').notHereAt, 'pastries');
  assert.equal(st('kitchen', 'donuts').how, 'elsewhere');
  assert.deepEqual(st('kitchen', 'donuts').otherCentreIds, ['bakery']);
  assert.equal(st('bakery', 'pastries').how, 'none');
  const shared = { ...SCREEN, routing: { ...SCREEN.routing, bar: { assignedCategories: ['donuts'] } } };
  assert.equal(st('bakery', 'donuts', shared).how, 'ticked');
  assert.deepEqual(st('bakery', 'donuts', shared).otherCentreIds, ['bar']);
  for (const c of ['kitchen', 'bakery', 'bar']) {
    for (const cat of Object.keys(FOOD_CATS)) {
      const s = st(c, cat);
      assert.equal(s.comesHere, centresForCategory(cat, SCREEN, FOOD_CATS).centreIds.includes(c), `${c} ${cat}`);
    }
  }
});

test('nextCentreCategories: every state and want ends with the box saying what routes', () => {
  const configs = [SCREEN, BARNSLEY, { centres: [{ id: 'kitchen' }], routing: {} }];
  for (let seed = 1; seed <= 60; seed++) configs.push(randomVenue(seed, { subTicks: true }).config);
  let clicks = 0;
  configs.forEach((cfg, ci) => {
    const pm = ci === 1 ? buildCatParentMap(BARNSLEY_CATS) : ci < 3 ? FOOD_CATS : buildCatParentMap(randomVenue(ci - 2, { subTicks: true }).cats);
    const catIds = Object.keys(pm);
    for (const centre of cfg.centres) {
      for (const cat of catIds) {
        for (const want of [true, false]) {
          const next = nextCentreCategories(cfg, centre.id, cat, want, pm);
          const after = categoryStateForCentre(centre.id, cat, { centres: cfg.centres, routing: next }, pm);
          assert.equal(after.comesHere, want, `config ${ci} ${centre.id} ${cat} want ${want}`);
          // the clicked category is never left both ticked and Not here (random configs may
          // start with other categories in that state; a click only answers for its own)
          const e = next[centre.id] || {};
          const both = (e.assignedCategories || []).includes(cat) && (e.excludedCategories || []).includes(cat);
          assert.equal(both, false, `never both ticked and Not here: ${ci} ${centre.id} ${cat}`);
          // the Not here marks a click clears are only ones that had stopped doing anything:
          // putting every one of them back changes no category at all
          const was = cfg.routing?.[centre.id]?.excludedCategories || [];
          const restored = { ...next, [centre.id]: { ...e, excludedCategories: [...new Set([
            ...(e.excludedCategories || []), ...was.filter(x => x !== cat),
          ])] } };
          for (const other of catIds) {
            assert.equal(
              centresForCategory(other, { centres: cfg.centres, routing: restored }, pm).centreIds.includes(centre.id),
              centresForCategory(other, { centres: cfg.centres, routing: next }, pm).centreIds.includes(centre.id),
              `config ${ci}: clearing Not here moved ${other} when ${cat} was clicked at ${centre.id}`,
            );
          }
          // nothing outside the clicked category and its subtree moves at THIS centre
          for (const other of catIds) {
            if (other === cat || categoryChain(other, pm).includes(cat)) continue;
            const b0 = centresForCategory(other, cfg, pm).centreIds.includes(centre.id);
            const b1 = centresForCategory(other, { centres: cfg.centres, routing: next }, pm).centreIds.includes(centre.id);
            assert.equal(b1, b0, `config ${ci}: ${other} moved when ${cat} was clicked at ${centre.id}`);
          }
          clicks++;
        }
      }
    }
  });
  assert.ok(clicks > 500);
});

test('nextCentreCategories: the clicks Peter will make', () => {
  const base = { centres: [{ id: 'kitchen' }, { id: 'bakery' }], routing: {
    kitchen: { assignedCategories: ['food'], excludedItems: [], orderTypes: ['dine-in'] },
    bakery: { assignedCategories: [], excludedItems: [], orderTypes: [] },
  } };
  // tick Donuts at Bakery: a plain tick, and Kitchen's entry is untouched
  const r1 = nextCentreCategories(base, 'bakery', 'donuts', true, FOOD_CATS);
  assert.deepEqual(r1.bakery.assignedCategories, ['donuts']);
  assert.equal(r1.kitchen, base.routing.kitchen);
  assert.equal(r1.bakery.excludedCategories, undefined, 'no new key written unless used');
  // untick Pastries at Kitchen: it comes with Food, so it becomes Not here
  const r2 = nextCentreCategories(base, 'kitchen', 'pastries', false, FOOD_CATS);
  assert.deepEqual(r2.kitchen.assignedCategories, ['food']);
  assert.deepEqual(r2.kitchen.excludedCategories, ['pastries']);
  assert.deepEqual(r2.kitchen.orderTypes, ['dine-in'], 'order types survive');
  // tick it again: the Not here goes, nothing is ticked
  const r3 = nextCentreCategories({ ...base, routing: r2 }, 'kitchen', 'pastries', true, FOOD_CATS);
  assert.deepEqual(r3.kitchen.assignedCategories, ['food']);
  assert.deepEqual(r3.kitchen.excludedCategories, []);
  // untick Food: Pastries' Not here and Food's item exclusions are cleared with it
  const withItems = { ...base, routing: { ...r2, kitchen: { ...r2.kitchen, excludedItems: ['roll', 'other-venue-id'] } } };
  const r4 = nextCentreCategories(withItems, 'kitchen', 'food', false, FOOD_CATS, {
    menuItems: [{ id: 'roll', cat: 'pastries' }],
  });
  assert.deepEqual(r4.kitchen.assignedCategories, []);
  assert.deepEqual(r4.kitchen.excludedCategories, []);
  assert.deepEqual(r4.kitchen.excludedItems, ['other-venue-id']);
  // a click that changes nothing returns the same object, so it never saves
  assert.equal(nextCentreCategories(base, 'kitchen', 'food', true, FOOD_CATS), base.routing);
  assert.equal(nextCentreCategories(base, 'bakery', 'drinks', false, FOOD_CATS), base.routing);
});

test('nextExcludedItems: product, size and plain item boxes', () => {
  const sizes = ['s', 'b', 'xl'];
  // product box off: the product id and every size id, each meaning what it always meant
  assert.deepEqual(nextExcludedItems(['b', 'other'], 'm', sizes, 'm', false), ['b', 'other', 'm', 's', 'xl']);
  // product box on: everything for it cleared, including a product id the old screen saved
  assert.deepEqual(nextExcludedItems(['m', 'b', 'other'], 'm', sizes, 'm', true), ['other']);
  assert.deepEqual(nextExcludedItems(['m', 's', 'b', 'xl'], 'm', sizes, 'm', true), []);
  // a size box while the whole product is off: only that size comes back, and the product
  // id goes, since the product is no longer off here
  assert.deepEqual(nextExcludedItems(['m', 's', 'b', 'xl'], 'm', sizes, 'b', true), ['s', 'xl']);
  // a size box off while it is already off changes nothing
  const off = ['m', 's', 'b', 'xl'];
  assert.equal(nextExcludedItems(off, 'm', sizes, 'b', false), off);
  // single sizes toggle on their own
  assert.deepEqual(nextExcludedItems([], 'm', sizes, 'b', false), ['b']);
  assert.deepEqual(nextExcludedItems(['b'], 'm', sizes, 'b', true), []);
  // a plain item is its own product
  assert.deepEqual(nextExcludedItems([], 'toastie', [], 'toastie', false), ['toastie']);
  assert.deepEqual(nextExcludedItems(['toastie'], 'toastie', [], 'toastie', true), []);
  const same = ['x'];
  assert.equal(nextExcludedItems(same, 'toastie', [], 'toastie', true), same);
  assert.equal(nextExcludedItems(same, 'm', sizes, 'm', true), same);
});

// Review 30 Sep 2026: the screen live before this change listed "Matcha" (a product with
// sizes) as its own row, and unticking it saved the product id. Old tills never read that
// id as covering the sizes. Whatever the product box writes now must route the same on a
// till that has not reloaded, and a product id already saved must keep its old meaning.
test('items: what the product box writes routes the same on an old till and a new one', () => {
  const ctx = { menuItems: BARNSLEY_ITEMS, catParents: buildCatParentMap(BARNSLEY_CATS) };
  const sizes = ['matcha-s', 'matcha-b', 'matcha-xl'];
  const excl = nextExcludedItems([], 'matcha', sizes, 'matcha', false);
  const config = { ...BARNSLEY, routing: { ...BARNSLEY.routing, drinks: { ...BARNSLEY.routing.drinks, excludedItems: excl } } };
  for (const id of ['matcha', ...sizes]) {
    for (const line of Object.values(lineShapes(BARNSLEY_ITEMS.find(i => i.id === id), BARNSLEY_ITEMS))) {
      const next = centresForItemByCategory(line, config, ctx);
      assert.deepEqual(next, legacyCentresForItemByCategory(line, config, ctx), id);
      assert.deepEqual(next, ['kfood'], id);
    }
  }
});

test('channelFallbackCentre: the first centre with a printer, else the first centre', () => {
  assert.equal(channelFallbackCentre({ centres: [] }), null);
  assert.equal(channelFallbackCentre(null), null);
  assert.equal(channelFallbackCentre({ centres: [{ id: 'a' }, { id: 'b' }] }).id, 'a');
  assert.equal(channelFallbackCentre({ centres: [{ id: 'a', printer: null }, { id: 'b', printer: { id: 'p' } }] }).id, 'b');
});
