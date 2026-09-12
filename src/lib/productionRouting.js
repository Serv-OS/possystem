// src/lib/productionRouting.js
//
// Production centres: the ONE rule that decides which centre an item goes to.
// Category routing AND order type routing live here together, because the printed
// kitchen docket and the KDS ticket are built from the SAME per centre bucket. Apply
// the rule here and paper and screen can never disagree.
//
// Before this file the same walk existed three times in src/store/index.js (the shared
// helper, addRoundToTab's local copy and routeKioskOrderPrints' local copy). All three
// now call resolveCentresForItem.
//
// ⚠ EMPTY MEANS ALL ORDER TYPES HERE.
// A centre whose `orderTypes` key is absent, empty, or unreadable takes EVERY order
// type, which is exactly what every existing centre keeps with nothing saved. This is
// the OPPOSITE convention to `orderTypes` in src/lib/orderScreen/orderScreenStatus.js,
// where an empty list matches nothing and is a validation error. Do NOT unify the two:
// making empty mean "nothing" here would stop every existing production centre from
// printing. Both files carry this note.
//
// The setting is stored inside the existing jsonb column print_routing.routing:
//   routing[<centreId>] = { assignedCategories: [], excludedItems: [], orderTypes: [] }
// No DDL is needed, and a routing blob written before this feature reads as "all".

import { ORDER_TYPES, orderTypeKey } from './orderScreen/orderScreenStatus.js';

/** The four order types anything in this codebase writes: dine-in, takeaway, collection, delivery. */
export const ORDER_TYPE_KEYS = ORDER_TYPES.map(t => t.key);

const LABEL_BY_KEY = ORDER_TYPES.reduce((acc, t) => { acc[t.key] = t.label; return acc; }, {});

/** 'dine-in' → 'Eat in'. Unknown gives null. */
export function orderTypeLabelOf(key) {
  return LABEL_BY_KEY[key] || null;
}

/**
 * Clean a centre's saved order types.
 * Anything that is not an array of known keys becomes [], which means ALL order types.
 * All four ticked also collapses to [], so "every box ticked" and "All" are one state.
 */
export function normaliseCentreOrderTypes(value) {
  if (!Array.isArray(value)) return [];
  // Each entry goes through orderTypeKey first, so a value written by hand in the SQL
  // editor ('eat_in', 'TAKEAWAY', 'takeout') is honoured rather than silently dropped.
  // Dropping it would widen the centre back to ALL order types with nothing on screen
  // to say so, which is the one failure this rule must not have.
  const kept = ORDER_TYPE_KEYS.filter(k => value.some(v => orderTypeKey(v) === k));
  if (kept.length === ORDER_TYPE_KEYS.length) return [];
  return kept;
}

/**
 * Does this centre serve this order type?
 * Absent or empty list takes everything. An unknown or missing order type also matches
 * every centre, so the rule is never narrower than the behaviour before this feature.
 */
export function centreTakesOrderType(routingEntry, typeKey) {
  const list = normaliseCentreOrderTypes(routingEntry?.orderTypes);
  if (!list.length) return true;
  if (!typeKey || !ORDER_TYPE_KEYS.includes(typeKey)) return true;
  return list.includes(typeKey);
}

/**
 * The order type of a queue order, for routing.
 * order.type (order_queue.type) FIRST, customer.serviceType only as a fallback.
 * The precedence matters: ezCater writes serviceType 'TAKEOUT' on an order whose queue
 * type is 'collection', so preferring serviceType would miss a Collection only centre.
 */
export function resolveOrderTypeKey(order) {
  return orderTypeKey(order?.type) || orderTypeKey(order?.customer?.serviceType) || null;
}

// Is catId, or any ancestor of it, in the assigned set? Depth capped at 5.
function catOrAncestorMatches(catId, assignedSet, parentMap, depth = 0) {
  if (!catId || depth > 5) return false;
  if (assignedSet.has(catId)) return true;
  const parentId = parentMap?.[catId];
  if (!parentId) return false;
  return catOrAncestorMatches(parentId, assignedSet, parentMap, depth + 1);
}

/**
 * Stage one: the category rule, unchanged from what shipped before order types.
 *   ctx = { menuItems: [], catParents: { catId: parentCatId } }
 * A centre with no categories ticked receives nothing, ever.
 */
export function centresForItemByCategory(item, config, ctx) {
  const centres = config?.centres;
  const routing = config?.routing;
  if (!centres?.length || !routing) return [];

  // Order lines only reliably carry itemId, so look the menu item up for cat / parentId.
  const allItems = ctx?.menuItems || [];
  const menuItem = allItems.find(i => i.id === (item?.itemId || item?.id));

  const itemCat = item?.cat || item?.cats?.[0] || menuItem?.cat || menuItem?.cats?.[0] || null;

  // Variants (Small Latte) inherit the parent product's category.
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
    const catMatches = (itemCat && catOrAncestorMatches(itemCat, assignedSet, parentMap)) ||
                       (parentCat && catOrAncestorMatches(parentCat, assignedSet, parentMap));
    if (catMatches) matched.push(centre.id);
  });
  return matched;
}

/**
 * The whole decision: category first, then order type.
 *   ctx = { menuItems, catParents, orderType }   orderType may be a raw string or a key
 * Returns { centreIds, byCategory, usedTypeFallback, typeKey }.
 *
 * SAFETY RULE: if the category stage matched centres but none of them takes this order
 * type, the food still goes to every centre the category matched, and usedTypeFallback
 * is true so the operator can be told. Food is never lost to a tick box.
 */
export function resolveCentresForItem(item, config, ctx) {
  const typeKey = orderTypeKey(ctx?.orderType);
  const byCategory = centresForItemByCategory(item, config, ctx);
  const routing = config?.routing || {};
  const narrowed = byCategory.filter(id => centreTakesOrderType(routing[id], typeKey));
  if (!narrowed.length && byCategory.length) {
    return { centreIds: byCategory, byCategory, usedTypeFallback: true, typeKey };
  }
  return { centreIds: narrowed, byCategory, usedTypeFallback: false, typeKey };
}

/**
 * The Back Office tick boxes, as a pure rule.
 * While All order types is on the four boxes show unticked, so one tick narrows to that
 * type. Unticking the last remaining type returns to [], so All comes back on and a
 * centre can never be saved serving nothing. Ticking all four also returns to [].
 */
export function nextCentreOrderTypes(current, key, ticked) {
  const list = normaliseCentreOrderTypes(current);
  if (!ORDER_TYPE_KEYS.includes(key)) return list;
  if (!list.length) return ticked ? [key] : [];          // All was on
  return normaliseCentreOrderTypes(ticked ? [...list, key] : list.filter(k => k !== key));
}

/**
 * The one sentence shown when the safety rule above fired.
 * Scoped to the items being sent, NOT to the venue: other centres may well take this
 * order type, they just do not serve this item's category. Saying "no centre takes Eat
 * in" while Back Office shows a centre set to All order types reads as a contradiction.
 * Also says "order" not "food", because a centre can be a Bar or an Expo / pass.
 */
export function orderTypeFallbackMessage(typeKey) {
  const label = orderTypeLabelOf(typeKey) || 'this order type';
  return `No center for these items takes ${label}. They went to every center that matches the category.`;
}

/** ['Eat in'] -> 'Eat in'; two -> 'Eat in and Takeaway'; three -> 'Eat in, Takeaway and Delivery'. */
export function joinList(labels) {
  const parts = (labels || []).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** 'All order types', or 'Eat in, Takeaway'. Comma joined, for the compact rail pill. */
export function describeCentreOrderTypes(routingEntry) {
  const list = normaliseCentreOrderTypes(routingEntry?.orderTypes);
  if (!list.length) return 'All order types';
  return list.map(orderTypeLabelOf).join(', ');
}

/**
 * Order types that will hit the safety fallback for at least one category THIS centre
 * serves, for the Back Office warning.
 *
 * Asked per category, not per venue. A venue wide question ("does some centre take
 * Takeaway?") answers yes as soon as one coffee bar does, and then says nothing about a
 * takeaway pizza whose only centre is Eat in only. That is the case that actually bites,
 * so this asks: for each category ticked here, does any centre serving that category
 * take the type? If none does, items in it land on the fallback.
 *
 *   centres   = [{ id }]
 *   routing   = print_routing.routing
 *   parentMap = { catId: parentCatId }, so a centre assigned a PARENT category counts
 *               as serving its children (optional, defaults to no hierarchy)
 * A centre with no categories ticked returns []: it receives nothing anyway, and the
 * screen says so separately.
 */
export function fallbackOrderTypesForCentre(centreId, centres, routing, parentMap) {
  const cats = routing?.[centreId]?.assignedCategories || [];
  if (!cats.length) return [];
  const configured = (centres || []).filter(c => routing?.[c?.id]?.assignedCategories?.length);
  const serves = (centre, catId) =>
    catOrAncestorMatches(catId, new Set(routing[centre.id].assignedCategories), parentMap || {});
  return ORDER_TYPE_KEYS.filter(key => cats.some(catId =>
    !configured.some(c => serves(c, catId) && centreTakesOrderType(routing[c.id], key))
  ));
}
