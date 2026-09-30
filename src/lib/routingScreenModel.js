// src/lib/routingScreenModel.js
//
// The Back Office Production centres screen (backoffice/sections/PrintRouting.jsx,
// CategoryRouter) as pure data, so node:test can prove the screen shows what routes.
//
// 30 Sep 2026, Peter at Coffee Boy:
//   1. The item list showed sizes by their own name only ("Small Boy / Big Boy / XL Boy /
//      Matcha"): "unsure which ones are which". Sizes are now grouped under their product
//      and read "Matcha, Small Boy".
//   2. "also need the sub categories been able to be chose where they go". Only top level
//      categories were listed. The whole tree is listed now, each sub category with its own
//      box.
//
// Every box here is built on the functions in lib/productionRouting.js that the till, the
// bar tab, reprint, fire course, table transfer and every channel order route with
// (routingCategoryOf, centresForCategory, centresForItemByCategory). A box is ticked
// exactly when that category or item reaches this centre. Before this file the screen
// listed items its own way (cat OR cats) and disagreed with what actually printed.
//
// Pure, no React. The only import besides the routing rule is menuRules.js (also pure).

import {
  buildCatParentMap,
  isInsideCategory,
  routingCategoryOf,
  centresForCategory,
  centresForItemByCategory,
  categoryStateForCentre,
  channelFallbackCentre,
  nextCentreCategories,
  nextExcludedItems,
  joinList,
} from './productionRouting.js';
import { isOptionOnlyItem } from './menuRules.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The name an item shows under in Menu (the old screen's order, unchanged). */
export function itemLabel(item) {
  return item?.menuName || item?.menu_name || item?.name || 'Item';
}

/** The price shown next to an item or size row. */
export function itemPrice(item) {
  return item?.pricing?.base ?? item?.price ?? 0;
}

/** A category's name, for rows and sentences. */
export function categoryLabel(cat) {
  return cat?.label || cat?.name || 'Category';
}

const bySortThenLabel = (labelOf) => (a, b) =>
  ((a?.sortOrder ?? a?.sort_order ?? 0) - (b?.sortOrder ?? b?.sort_order ?? 0))
  || String(labelOf(a)).localeCompare(String(labelOf(b)));

/** "1 item", "3 items". */
export function countOf(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The number on the left rail: ticks that still point at a category on the menu. Provo
 * has two ticks for categories deleted long ago; they route nothing, so they are not
 * counted. While the categories have not loaded (an empty map) every tick is counted,
 * as before.
 */
export function liveTickCount(routingEntry, parentMap) {
  const ticks = listOf(routingEntry?.assignedCategories);
  if (!parentMap || !Object.keys(parentMap).length) return ticks.length;
  return ticks.filter(id => Object.prototype.hasOwnProperty.call(parentMap, id)).length;
}

/**
 * The whole screen for one centre. Entries are sorted by the item's sortOrder, then name.
 *   centreId    the centre being edited
 *   centres     print_routing.centres
 *   routing     print_routing.routing
 *   categories  the venue's menu categories (store shape)
 *   menuItems   the venue's menu items (store shape)
 * Returns {
 *   parentMap,
 *   roots        category nodes (below), nested
 *   uncategorised entries whose routing category is not a category on the menu
 *   nowhereCount listed items and sizes that no centre takes
 *   nowhereNames the first few of them, for the sentence
 *   optionOnlyCount option only items (never listed: they print with their item)
 *   fallbackCentre where kiosk, online, QR, HubRise and catering orders send them
 * }
 * A category node is {
 *   id, cat, label, icon, depth,
 *   state      categoryStateForCentre: { comesHere, how, via, otherCentreIds, notHereAt }
 *   children   category nodes
 *   entries    products and items whose routing category is exactly this one
 *   alsoIn     [{ id, label, catLabel }] items shown here in Menu that route elsewhere
 *   offCount   items and sizes in this category that do not come here while it does
 *   differs    anything inside differs from this row (the screen opens it by itself)
 * }
 * An entry is one of
 *   { kind: 'item', id, productId, sizeIds: [], label, price, comesHere }
 *   { kind: 'product', id, productId, sizeIds, label, sizeCount, box: 'all'|'some'|'none', sizes }
 * and a size is { kind: 'size', id, productId, sizeIds, label: 'Matcha, Small Boy', price, comesHere }.
 */
export function buildRoutingScreen({ centreId, centres, routing, categories, menuItems }) {
  const config = { centres: listOf(centres).filter(Boolean), routing: routing || {} };
  const cats = listOf(categories).filter(c => c && c.id != null);
  const parentMap = buildCatParentMap(cats);
  const items = listOf(menuItems).filter(Boolean);
  const ctx = { menuItems: items, catParents: parentMap };
  const catById = new Map(cats.map(c => [c.id, c]));
  const itemById = new Map(items.map(i => [i.id, i]));

  const live = items.filter(i => !i.archived);
  const optionOnly = live.filter(isOptionOnlyItem);
  const sellable = live.filter(i => !isOptionOnlyItem(i));
  const liveById = new Map(sellable.map(i => [i.id, i]));

  // Sizes grouped under their product. A size whose product is not a live, sellable item
  // on this menu is listed on its own row, placed where routingCategoryOf puts it (still
  // its product's category while the product row is known, archived say). parentId is
  // the field the routing rule reads, so grouping can never disagree with it.
  const sizesOf = new Map();
  const standalone = [];
  sellable.forEach(i => {
    const pid = i.parentId || null;
    if (pid && liveById.has(pid)) {
      if (!sizesOf.has(pid)) sizesOf.set(pid, []);
      sizesOf.get(pid).push(i);
    } else {
      standalone.push(i);
    }
  });

  // The category stage for one menu item, as a line that carries only its id: the shape
  // HubRise and ezCater send, which looks everything up in the menu. A till line and a
  // kiosk line stamp the same category (the product's, for a size), so they agree.
  let nowhereCount = 0;
  const nowhereNames = [];
  const routeOf = (item, label) => {
    const all = centresForItemByCategory({ itemId: item.id }, config, ctx);
    if (!all.length) {
      nowhereCount += 1;
      if (nowhereNames.length < 5) nowhereNames.push(label);
    }
    return all.includes(centreId);
  };

  const entriesByCat = new Map();
  const uncategorised = [];
  const place = (catId, entry) => {
    if (catId && catById.has(catId)) {
      if (!entriesByCat.has(catId)) entriesByCat.set(catId, []);
      entriesByCat.get(catId).push(entry);
    } else {
      uncategorised.push(entry);
    }
  };
  const routedCatOf = new Map();
  const sortOf = (item) => Number(item?.sortOrder ?? item?.sort_order ?? 0) || 0;

  standalone.forEach(item => {
    const name = itemLabel(item);
    const { catId } = routingCategoryOf({ itemId: item.id }, ctx);
    routedCatOf.set(item.id, catId);
    const sizes = (sizesOf.get(item.id) || []).slice().sort(bySortThenLabel(itemLabel));
    const productLike = item.parentId || null;
    if (!sizes.length) {
      // A size whose product is not on sale keeps "Product, Size" while the product row is
      // still known (archived, say), so it is never a bare "Small".
      const product = productLike ? itemById.get(productLike) : null;
      const label = product ? `${itemLabel(product)}, ${name}` : name;
      place(catId, {
        kind: 'item', id: item.id, productId: item.id, sizeIds: [],
        label, price: itemPrice(item), comesHere: routeOf(item, label), sort: sortOf(item),
      });
      return;
    }
    const sizeIds = sizes.map(s => s.id);
    const sizeRows = sizes.map(s => {
      const label = `${name}, ${itemLabel(s)}`;
      routedCatOf.set(s.id, routingCategoryOf({ itemId: s.id }, ctx).catId);
      return {
        kind: 'size', id: s.id, productId: item.id, sizeIds,
        label, price: itemPrice(s), comesHere: routeOf(s, label),
      };
    });
    const on = sizeRows.filter(s => s.comesHere).length;
    place(catId, {
      kind: 'product', id: item.id, productId: item.id, sizeIds,
      label: name, sizeCount: sizes.length,
      box: on === sizeRows.length ? 'all' : on === 0 ? 'none' : 'some',
      sizes: sizeRows, sort: sortOf(item),
    });
  });

  const sortEntries = (list) => list.sort((a, b) => (a.sort - b.sort) || a.label.localeCompare(b.label));

  // "Also in" items: shown in this category in Menu, but routed by a category that is
  // neither this one nor inside it. They are listed where they route; here they get one
  // muted line so nobody hunts for them.
  const alsoInByCat = new Map();
  standalone.forEach(item => {
    const routed = routedCatOf.get(item.id);
    const shownIn = new Set([item.cat, ...listOf(item.cats)].filter(Boolean));
    shownIn.forEach(cid => {
      if (!catById.has(cid) || cid === routed) return;
      if (routed && isInsideCategory(routed, cid, parentMap)) return;
      if (!alsoInByCat.has(cid)) alsoInByCat.set(cid, []);
      alsoInByCat.get(cid).push({
        id: item.id,
        label: itemLabel(item),
        catLabel: routed && catById.has(routed) ? categoryLabel(catById.get(routed)) : null,
      });
    });
  });

  const entryDiffers = (e, comesHere) => (e.kind === 'product'
    ? e.box !== (comesHere ? 'all' : 'none')
    : e.comesHere !== comesHere);

  const buildNode = (cat, depth, seen) => {
    const state = categoryStateForCentre(centreId, cat.id, config, parentMap);
    const nextSeen = new Set([...seen, cat.id]);
    const kids = cats
      .filter(c => parentMap[c.id] === cat.id && !nextSeen.has(c.id))
      .sort(bySortThenLabel(categoryLabel));
    const children = depth < 8 ? kids.map(k => buildNode(k, depth + 1, nextSeen)) : [];
    const entries = sortEntries(entriesByCat.get(cat.id) || []);
    const offCount = state.comesHere
      ? entries.reduce((n, e) => n + (e.kind === 'product'
        ? e.sizes.filter(s => !s.comesHere).length
        : (e.comesHere ? 0 : 1)), 0)
      : 0;
    const differs = children.some(ch => ch.state.comesHere !== state.comesHere || ch.differs)
      || entries.some(e => entryDiffers(e, state.comesHere));
    return {
      id: cat.id, cat, label: categoryLabel(cat), icon: cat.icon || null, depth,
      state, children, entries,
      alsoIn: (alsoInByCat.get(cat.id) || []).sort((a, b) => a.label.localeCompare(b.label)),
      offCount, differs,
    };
  };

  // Roots: no parent, or a parent that is not on this menu (never lose a category). They
  // keep the order the venue's categories arrive in, as the old top level list did;
  // sub categories are sorted as Menu sorts them. A parent loop has no root at all, so
  // anything not reached is added as a root too.
  const roots = [];
  const reached = new Set();
  const walk = (n) => { reached.add(n.id); n.children.forEach(walk); };
  cats
    .filter(c => !parentMap[c.id] || !catById.has(parentMap[c.id]))
    .forEach(c => { const n = buildNode(c, 0, new Set()); walk(n); roots.push(n); });
  cats.forEach(c => {
    if (reached.has(c.id)) return;
    const n = buildNode(c, 0, new Set());
    walk(n);
    roots.push(n);
  });

  return {
    parentMap,
    roots,
    uncategorised: sortEntries(uncategorised),
    nowhereCount,
    nowhereNames,
    optionOnlyCount: optionOnly.length,
    fallbackCentre: config.centres.length ? channelFallbackCentre(config) : null,
  };
}

/** Every node in the tree, depth first. */
export function flattenNodes(roots) {
  const out = [];
  const walk = (n) => { out.push(n); listOf(n.children).forEach(walk); };
  listOf(roots).forEach(walk);
  return out;
}

/** Every item and size row in the tree plus the uncategorised ones, flat. */
export function flattenItemRows(screen) {
  const out = [];
  const add = (e) => {
    if (e.kind === 'product') e.sizes.forEach(s => out.push(s));
    else out.push(e);
  };
  flattenNodes(screen?.roots).forEach(n => n.entries.forEach(add));
  listOf(screen?.uncategorised).forEach(add);
  return out;
}

/**
 * The note on a category row.
 *   ticked      'Also at Bar' when another centre ticks it too, else null
 *   withParent  'With Food'
 *   notHere     'Not sent here'
 *   elsewhere   'Goes to Bakery'
 *   none        'No center'
 * nameOfCentre(id) and nameOfCategory(id) give the names.
 */
export function categoryRowNote(state, nameOfCentre, nameOfCategory) {
  const centres = (ids) => joinList(listOf(ids).map(id => nameOfCentre(id) || 'another center'));
  switch (state?.how) {
    case 'ticked': return state.otherCentreIds?.length ? `Also at ${centres(state.otherCentreIds)}` : null;
    case 'withParent': return `With ${nameOfCategory(state.via) || 'its parent'}`;
    case 'notHere': return 'Not sent here';
    case 'elsewhere': return `Goes to ${centres(state.otherCentreIds)}`;
    default: return 'No center';
  }
}

/**
 * One click on a category box. Returns { routing, notice, expect }: the next routing map (the
 * same object when nothing changes), the sentence to show or null, and the centre ids the
 * sentence describes (sorted), for noticeHolds.
 *   "Donuts now comes here, not to Kitchen. Tick Donuts at Kitchen too to send it to both."
 *   "Donuts now goes to Kitchen with Food."
 * `want` is what the box asks for: true to bring the category here, false to stop it.
 */
export function clickCategory({ centreId, catId, want, centres, routing, parentMap, menuItems, nameOfCentre, nameOfCategory }) {
  const config = { centres: listOf(centres), routing: routing || {} };
  const nextRouting = nextCentreCategories(config, centreId, catId, want, parentMap, { menuItems });
  if (nextRouting === config.routing) return { routing: config.routing, notice: null, expect: null };
  const before = centresForCategory(catId, config, parentMap).centreIds;
  const afterRes = centresForCategory(catId, { centres: config.centres, routing: nextRouting }, parentMap);
  const after = afterRes.centreIds;
  const cat = nameOfCategory(catId) || 'This category';
  const names = (ids) => joinList(ids.map(id => nameOfCentre(id) || 'another center'));
  let notice = null;
  if (want) {
    const lost = before.filter(id => id !== centreId && !after.includes(id));
    if (lost.length) {
      notice = `${cat} now comes here, not to ${names(lost)}. `
        + `Tick ${cat} at ${names(lost)} too to send it to ${lost.length === 1 ? 'both' : 'all of them'}.`;
    }
  } else {
    const gained = after.filter(id => id !== centreId && !before.includes(id));
    if (gained.length) {
      notice = `${cat} now goes to ${names(gained)} with ${nameOfCategory(afterRes.via) || 'its parent'}.`;
    }
  }
  return { routing: nextRouting, notice, expect: [...after].sort() };
}

/** The centre ids a category row goes to right now, sorted. */
export function nodeCentreIds(node, centreId) {
  const st = node?.state || {};
  return [...(st.comesHere ? [centreId] : []), ...listOf(st.otherCentreIds)].sort();
}

/**
 * Is the sentence from a category click still true of the row? A failed save puts the old
 * routing back, and a save can bring back another window's change; either way the sentence
 * would describe a move that did not happen, so the screen hides it.
 *   notice = { catId, text, expect } as the screen stored it from clickCategory
 */
export function noticeHolds(notice, node, centreId) {
  if (!notice || !node || notice.catId !== node.id || !Array.isArray(notice.expect)) return false;
  return sameList(nodeCentreIds(node, centreId), notice.expect);
}

/**
 * One click on an item, product or size box. Returns the next routing map, the same
 * object when nothing changes. The exclusion rule is nextExcludedItems (productionRouting.js).
 */
export function clickItem({ centreId, routing, productId, sizeIds, targetId, want }) {
  const map = routing || {};
  const cur = map[centreId] || {};
  const before = listOf(cur.excludedItems);
  const next = nextExcludedItems(before, productId, sizeIds, targetId, want);
  if (sameList(next, before)) return map;
  return { ...map, [centreId]: { ...cur, excludedItems: next } };
}

/**
 * The once per page sentence when something goes to no center, or null. Names the first few,
 * so the owner can find them:
 *   "3 items do not print or show at any center when rung up on a till: Gift Card, Chai Latte
 *    and Tote Bag. Kiosk, online, QR, HubRise and catering orders send them to KDS drinks."
 * A till sends such an item nowhere; kiosk, online, QR, HubRise and catering orders send it
 * to channelFallbackCentre (routeKioskOrderPrints in store/index.js).
 */
export function nowhereNotice(screen, nameOfCentre) {
  const n = screen?.nowhereCount || 0;
  if (!n) return null;
  const names = listOf(screen.nowhereNames).slice(0, 5);
  const more = n - names.length;
  const list = names.length ? `: ${joinList([...names, ...(more > 0 ? [`${more} more`] : [])])}` : '';
  const lead = `${countOf(n, 'item does', 'items do')} not print or show at any center when rung up on a till${list}.`;
  const fb = screen.fallbackCentre;
  if (!fb) return lead;
  return `${lead} Kiosk, online, QR, HubRise and catering orders send ${n === 1 ? 'it' : 'them'} to ${nameOfCentre(fb.id) || fb.name || 'the first center'}.`;
}

