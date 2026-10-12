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
//   routing[<centreId>] = { assignedCategories: [], excludedItems: [], orderTypes: [],
//                           excludedCategories: [] }
// No DDL is needed, and a routing blob written before this feature reads as "all".
//
// SUB CATEGORIES AND SIZES (30 Sep 2026, Peter at Coffee Boy: "also need the sub categories
// been able to be chose where they go", and sizes listed as "Small Boy / Big Boy" with no
// product). The category rule is now:
//   1. The category an item routes by (routingCategoryOf): a size uses its PRODUCT's Primary
//      category, anything else its own Primary category. If one of its "Also in" categories
//      sits INSIDE the Primary one, the deepest of those is used instead (Provo files steaks
//      as Primary Mains, Also in Steaks). Any other "Also in" never routes, so a menu display
//      choice can never print an item twice.
//   2. The nearest ticked category wins (centresForCategory): walk up from that category;
//      the first category ANY centre ticks decides, and every centre ticking it takes the
//      item. So ticking Donuts at Bakery moves donuts off the Kitchen that ticks Food; tick
//      Donuts at Kitchen too to send them to both.
//   3. `excludedCategories` ("Not here", optional, absent means []): a taker drops out when
//      it marked Not here on any category between the item's category and the deciding tick.
//      A Not here on the deciding tick itself, or above it, is ignored.
//   4. `excludedItems`: the line id or its itemId, exactly as it always was. A product id
//      in it stops only a line for that product itself, never its sizes, because that is
//      what the screen live before this change saved when a product row ("Matcha") was
//      unticked, and old tills never read it as covering the sizes. The Back Office product
//      box (nextExcludedItems) writes the product id AND every size id instead, so each id
//      it saves means the same thing to a till that has not reloaded.
// With only top level ticks and no Not here (every live venue on 30 Sep 2026), this routes
// every item exactly as before, whatever item exclusions are saved. A till that has not
// reloaded reads the new keys as absent and sends a superset, except an item routed by an
// "Also in" sub category whose Primary category is not ticked anywhere: every till must
// reload before a venue relies on sub category ticks.
// The Back Office screen (routingScreenModel.js) is built on these same functions, so the
// tick boxes always show what actually routes.

import { ORDER_TYPES, orderTypeKey } from './orderScreen/orderScreenStatus.js';

/**
 * The order types anything in this codebase writes: dine-in, takeaway, collection, delivery
 * and drive-thru. The list is ORDER_TYPES in orderScreenStatus.js; nothing here counts them.
 */
export const ORDER_TYPE_KEYS = ORDER_TYPES.map(t => t.key);

const LABEL_BY_KEY = ORDER_TYPES.reduce((acc, t) => { acc[t.key] = t.label; return acc; }, {});

/** 'dine-in' → 'Eat in'. Unknown gives null. */
export function orderTypeLabelOf(key) {
  return LABEL_BY_KEY[key] || null;
}

/**
 * Clean a centre's saved order types.
 * Anything that is not an array of known keys becomes [], which means ALL order types.
 * Every type ticked also collapses to [], so "every box ticked" and "All" are one state.
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

const listOf = (v) => (Array.isArray(v) ? v : []);

// The category walk reads a category and at most 5 ancestors, exactly as it always has.
const MAX_LEVELS = 6;

/**
 * catId -> parentId for a list of categories. A category with no parent maps to null.
 * The store shape (parentId) wins whenever the key is there, exactly as the till always
 * read it: Menu's "Move to root" sets parentId null and leaves the row's old parent_id
 * behind in memory, so falling through to parent_id would put it back under its old
 * parent. A raw database row (parent_id only) is read too. The till and the Back Office
 * screen both build their map here, so they can never disagree about the tree.
 */
export function buildCatParentMap(categories) {
  const map = {};
  listOf(categories).forEach(c => {
    if (!c || c.id == null) return;
    const p = c.parentId !== undefined ? c.parentId : c.parent_id;
    map[c.id] = p || null;
  });
  return map;
}

/**
 * [catId, parent, grandparent, ...], at most 6 long. Stops at a loop, so a bad parent
 * link can never hang a till.
 */
export function categoryChain(catId, parentMap) {
  const out = [];
  let c = catId || null;
  while (c && out.length < MAX_LEVELS && !out.includes(c)) {
    out.push(c);
    c = parentMap?.[c] || null;
  }
  return out;
}

/** Is catId strictly inside ancestorId? */
export function isInsideCategory(catId, ancestorId, parentMap) {
  return !!catId && !!ancestorId && catId !== ancestorId
    && categoryChain(catId, parentMap).includes(ancestorId);
}

// One id -> menu item Map per menuItems array. The array is replaced, never edited in
// place, whenever the menu changes, so the cache follows it. Before this every line did
// a linear find over the whole menu, twice.
const menuIndex = new WeakMap();
function menuById(menuItems) {
  if (!Array.isArray(menuItems)) return new Map();
  let m = menuIndex.get(menuItems);
  if (!m) {
    m = new Map();
    menuItems.forEach(i => { if (i && i.id != null && !m.has(i.id)) m.set(i.id, i); });
    menuIndex.set(menuItems, m);
  }
  return m;
}

/**
 * The ONE category a line routes by.
 *   ctx = { menuItems: [], catParents: { catId: parentCatId } }
 * Returns { catId, primaryId, productId }. catId null means no centre.
 *   Size: its product's Primary category (product.cat, else product.cats[0]), when the
 *         product is in the menu with one. Also in = the product's cats.
 *   Else: line.cat, line.cats[0], menuItem.cat, menuItem.cats[0], in that order.
 *         Also in = menuItem.cats, else line.cats.
 *   Then: an Also in category INSIDE the Primary one is used instead (the deepest).
 */
export function routingCategoryOf(line, ctx) {
  const byId = menuById(ctx?.menuItems);
  const parentMap = ctx?.catParents || {};
  const mi = byId.get(line?.itemId || line?.id) || null;
  const productId = line?.parentId || mi?.parentId || null;
  const product = productId ? (byId.get(productId) || null) : null;
  const productPrimary = product ? (product.cat || listOf(product.cats)[0] || null) : null;
  let primary;
  let alsoIn;
  if (productPrimary) {
    primary = productPrimary;
    alsoIn = listOf(product.cats);
  } else {
    primary = line?.cat || listOf(line?.cats)[0] || mi?.cat || listOf(mi?.cats)[0] || null;
    alsoIn = Array.isArray(mi?.cats) ? mi.cats : listOf(line?.cats);
  }
  if (!primary) return { catId: null, primaryId: null, productId };
  const inside = alsoIn.filter(c => isInsideCategory(c, primary, parentMap));
  inside.sort((a, b) => categoryChain(b, parentMap).length - categoryChain(a, parentMap).length);
  return { catId: inside[0] || primary, primaryId: primary, productId };
}

/**
 * Which centres a CATEGORY goes to: the nearest ticked category wins.
 * Returns { centreIds, via, takerIds, chain }:
 *   via       the deciding tick (the category itself or an ancestor), null when none
 *   takerIds  every centre ticking `via`
 *   centreIds the takers left after Not here on a category below `via`
 */
export function centresForCategory(catId, config, parentMap) {
  const centres = listOf(config?.centres).filter(Boolean);
  const routing = config?.routing || {};
  const chain = categoryChain(catId, parentMap);
  for (let k = 0; k < chain.length; k++) {
    const takers = centres.filter(c => listOf(routing[c.id]?.assignedCategories).includes(chain[k]));
    if (!takers.length) continue;
    const below = chain.slice(0, k);
    const kept = takers.filter(c => {
      const notHere = listOf(routing[c.id]?.excludedCategories);
      return !below.some(b => notHere.includes(b));
    });
    return { centreIds: kept.map(c => c.id), via: chain[k], takerIds: takers.map(c => c.id), chain };
  }
  return { centreIds: [], via: null, takerIds: [], chain };
}

/**
 * Stage one: the category rule (see the note at the top of this file).
 *   ctx = { menuItems: [], catParents: { catId: parentCatId } }
 * A centre with no categories ticked receives nothing, ever.
 */
export function centresForItemByCategory(item, config, ctx) {
  const centres = config?.centres;
  const routing = config?.routing;
  if (!centres?.length || !routing) return [];
  const { catId } = routingCategoryOf(item, ctx);
  if (!catId) return [];
  const { centreIds } = centresForCategory(catId, config, ctx?.catParents || {});
  // The line's own ids only, never its product id: see rule 4 at the top of this file.
  const ids = [item?.id, item?.itemId].filter(Boolean);
  return centreIds.filter(cid => {
    const excluded = listOf(routing[cid]?.excludedItems);
    return !ids.some(id => excluded.includes(id));
  });
}

/**
 * Kiosk, online, QR, HubRise and catering orders only: where an item that no centre takes
 * still goes (routeKioskOrderPrints). The first centre with a printer, else the first
 * centre, else null. A till has no such fallback.
 */
export function channelFallbackCentre(config) {
  const centres = listOf(config?.centres).filter(Boolean);
  return centres.find(c => c.printer?.id) || centres[0] || null;
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
 * While All order types is on the boxes show unticked, so one tick narrows to that
 * type. Unticking the last remaining type returns to [], so All comes back on and a
 * centre can never be saved serving nothing. Ticking every type also returns to [].
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
 * so this asks: for each category this centre actually receives, do the centres it goes
 * to take the type? If none does, items in it land on the fallback.
 *
 *   centres   = [{ id }]
 *   routing   = print_routing.routing
 *   parentMap = { catId: parentCatId }, so the sub categories a centre receives with a
 *               ticked parent count, and a sub category ticked at another centre does not
 *               (optional, defaults to no hierarchy)
 * The categories asked about are every id in parentMap plus every tick at any centre,
 * each routed by centresForCategory, the same rule a till uses.
 * A centre with no categories ticked returns []: it receives nothing anyway, and the
 * screen says so separately.
 *
 * Drive thru (16 Sep 2026) is named only once some centre's saved order types name it.
 * A venue that never ticked it on a till has no drive thru orders to fall back, and its
 * warning must read "Takeaway, Collection or Delivery" exactly as it did before.
 */
export function fallbackOrderTypesForCentre(centreId, centres, routing, parentMap) {
  if (!listOf(routing?.[centreId]?.assignedCategories).length) return [];
  const list = listOf(centres).filter(Boolean);
  const config = { centres: list, routing: routing || {} };
  const pm = parentMap || {};
  const universe = new Set([
    ...Object.keys(pm),
    ...list.flatMap(c => listOf(routing?.[c.id]?.assignedCategories)),
  ]);
  const served = [...universe]
    .map(catId => centresForCategory(catId, config, pm))
    .filter(r => r.centreIds.includes(centreId));
  const namesDriveThru = list.some(c =>
    normaliseCentreOrderTypes(routing?.[c.id]?.orderTypes).includes('drive-thru'));
  const keys = namesDriveThru ? ORDER_TYPE_KEYS : ORDER_TYPE_KEYS.filter(k => k !== 'drive-thru');
  return keys.filter(key => served.some(r =>
    !r.centreIds.some(id => centreTakesOrderType(routing[id], key))
  ));
}

// ─── The Back Office tick boxes for categories and items ─────────────────────
// Pure, and built on centresForCategory, so a box can never show something other than
// what routes. routingScreenModel.js lays these out as the nested list.

/**
 * One category's row at one centre.
 * Returns { comesHere, how, via, otherCentreIds, notHereAt }:
 *   how 'ticked'      ticked here (otherCentreIds: the other centres it also goes to)
 *       'withParent'  comes here with a ticked parent (via)
 *       'notHere'     would come with `via` but Not here is set (notHereAt: on which one)
 *       'elsewhere'   goes to otherCentreIds instead
 *       'none'        goes to no centre
 */
export function categoryStateForCentre(centreId, catId, config, parentMap) {
  const res = centresForCategory(catId, config, parentMap);
  const r = config?.routing?.[centreId] || {};
  const comesHere = res.centreIds.includes(centreId);
  const otherCentreIds = res.centreIds.filter(id => id !== centreId);
  if (comesHere) {
    const how = res.via === catId && listOf(r.assignedCategories).includes(catId) ? 'ticked' : 'withParent';
    return { comesHere, how, via: res.via, otherCentreIds, notHereAt: null };
  }
  if (res.takerIds.includes(centreId)) {
    const notHere = listOf(r.excludedCategories);
    const below = res.chain.slice(0, res.chain.indexOf(res.via));
    const notHereAt = below.find(c => notHere.includes(c)) || null;
    return { comesHere, how: 'notHere', via: res.via, otherCentreIds, notHereAt };
  }
  if (otherCentreIds.length) return { comesHere, how: 'elsewhere', via: res.via, otherCentreIds, notHereAt: null };
  return { comesHere, how: 'none', via: res.via, otherCentreIds, notHereAt: null };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * One click on a category box at one centre. Returns the next routing map (the same
 * object when nothing changes, so a no op click never saves).
 *   want true:  clear Not here on it; if it still does not come here, tick it here.
 *   want false: untick it here; if it still comes here with a parent ticked here, set
 *               Not here on it.
 * Afterwards it comes here exactly when `want`, and it is never both ticked and Not here.
 * When it stops coming here, Not here marks inside it that no longer change anything are
 * cleared, and so are item exclusions for items inside it that no longer come here
 * (needs ctx.menuItems), so ticking it again later brings everything back, as unticking
 * a category always has.
 */
export function nextCentreCategories(config, centreId, catId, want, parentMap, ctx) {
  const routing = config?.routing || {};
  if (!centreId || !catId) return routing;
  const pm = parentMap || {};
  const centres = listOf(config?.centres);
  const cur = routing[centreId] || {};
  const at = (r) => centresForCategory(catId, { centres, routing: r }, pm).centreIds.includes(centreId);
  const build = (assigned, notHere, excludedItems) => {
    const entry = { ...cur, assignedCategories: assigned };
    if (notHere.length || Array.isArray(cur.excludedCategories)) entry.excludedCategories = notHere;
    if (excludedItems) entry.excludedItems = excludedItems;
    return { ...routing, [centreId]: entry };
  };
  const before = at(routing);
  let assigned = listOf(cur.assignedCategories);
  let notHere = listOf(cur.excludedCategories);
  let next;
  if (want) {
    notHere = notHere.filter(c => c !== catId);
    next = build(assigned, notHere);
    if (!at(next)) {
      assigned = [...assigned.filter(c => c !== catId), catId];
      next = build(assigned, notHere);
    }
  } else {
    assigned = assigned.filter(c => c !== catId);
    next = build(assigned, notHere);
    if (at(next)) {
      notHere = [...notHere.filter(c => c !== catId), catId];
      next = build(assigned, notHere);
    }
  }

  let excludedItems = null;
  if (before && !want) {
    // Clear what no longer does anything inside it. A Not here mark is dropped only when,
    // without it, its category still would not come here, so no routing changes.
    const inside = (c) => c === catId || isInsideCategory(c, catId, pm);
    for (const x of [...notHere]) {
      if (!inside(x)) continue;
      const without = notHere.filter(c => c !== x);
      const trial = build(assigned, without);
      if (!centresForCategory(x, { centres, routing: trial }, pm).centreIds.includes(centreId)) {
        notHere = without;
      }
    }
    next = build(assigned, notHere);
    const menuItems = ctx?.menuItems;
    const items = listOf(cur.excludedItems);
    if (Array.isArray(menuItems) && items.length) {
      const byId = menuById(menuItems);
      const ictx = { menuItems, catParents: pm };
      const kept = items.filter(id => {
        if (!byId.has(id)) return true;
        const rc = routingCategoryOf({ itemId: id }, ictx).catId;
        if (!rc || !inside(rc)) return true;
        return centresForCategory(rc, { centres, routing: next }, pm).centreIds.includes(centreId);
      });
      if (kept.length !== items.length) excludedItems = kept;
    }
    next = build(assigned, notHere, excludedItems);
  }

  const unchanged = sameList(assigned, listOf(cur.assignedCategories))
    && sameList(notHere, listOf(cur.excludedCategories))
    && !excludedItems;
  return unchanged ? routing : next;
}

/**
 * One click on an item box. Returns the next excludedItems.
 *   excluded   the centre's excludedItems
 *   productId  the product (for an item without sizes, the item itself)
 *   sizeIds    every size of that product ([] for an item without sizes)
 *   targetId   the box clicked: the product, or one size
 * Every id written means exactly what it meant before sub categories, so a till that has
 * not reloaded routes the same (see rule 4 at the top of this file):
 *   Product box off: the product id and every size id. On: all of them cleared, which also
 *                    clears a product id the old screen saved.
 *   Size box: that size id. Turning a size back on also clears the product id, since
 *             the product is no longer off here.
 *   An item without sizes: its own id.
 * Returns the same array when nothing changes.
 */
export function nextExcludedItems(excluded, productId, sizeIds, targetId, want) {
  const list = listOf(excluded);
  const sizes = listOf(sizeIds).filter(Boolean);
  if (!targetId) return list;
  let next;
  if (productId && targetId === productId && sizes.length) {
    const all = [productId, ...sizes];
    const rest = list.filter(id => !all.includes(id));
    next = want ? rest : [...list, ...all.filter(id => !list.includes(id))];
  } else if (productId && sizes.includes(targetId)) {
    next = want
      ? list.filter(id => id !== targetId && id !== productId)
      : (list.includes(targetId) ? list : [...list, targetId]);
  } else {
    const rest = list.filter(id => id !== targetId);
    next = want ? rest : [...rest, targetId];
  }
  return sameList(next, list) ? list : next;
}
