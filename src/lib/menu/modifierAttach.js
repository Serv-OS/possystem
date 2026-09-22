// src/lib/menu/modifierAttach.js
//
// ATTACH ONE MODIFIER GROUP TO MANY PRODUCTS, FROM THE GROUP.
//
// Peter, 22 Sep 2026, looking at the Modifier groups screen: "no way to search
// modifiers... I would like it so within the modifier group you can attach them
// to products multiple products at once. normally you would connect 1 modifier
// groups to multiple products."
//
// He is describing the way this actually gets used. "Milk" belongs on every hot
// drink. Until now the only route was the other way round: open a product, open
// its Modifiers tab, tick the group, save, then do it again for the next
// eighteen products. For a venue with 223 items that is an afternoon, and Mike
// is programming four empty venues tonight.
//
// The rules below are pure so they can be tested without a browser, because a
// mistake here edits dozens of products at once.
//
// WHAT AN ITEM CARRIES (unchanged, we only edit it):
//   item.assignedModifierGroups  [{ groupId, ...per item settings }]
//   item.optionGroupOrder        the combined modifier + instruction order
// A group that is added must join BOTH, or the item's flow silently forgets it
// (v5.5.948 put the order in its own field; see lib/optionFlow.js).

/** The groups an item already carries, as plain ids. */
export function groupIdsOf(item) {
  const list = Array.isArray(item?.assignedModifierGroups) ? item.assignedModifierGroups : [];
  return list.map((a) => String(a?.groupId ?? '')).filter(Boolean);
}

/** Does this item already carry the group? */
export function itemHasGroup(item, groupId) {
  return groupIdsOf(item).includes(String(groupId ?? ''));
}

/** Every item carrying this group, in the order given. */
export function itemsCarrying(items, groupId) {
  return (Array.isArray(items) ? items : []).filter((i) => itemHasGroup(i, groupId));
}

/** Is this item one of the option-only records, which are never a product? */
function isSubItem(item) {
  const type = String(item?.type ?? '');
  return type === 'sub' || type === 'subitem' || type === 'sub_item';
}

/** The sizes (variant children) of a product. */
export function sizesOf(items, parentId) {
  const pid = String(parentId ?? '');
  if (!pid) return [];
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && !i.archived && String(i.parentId ?? '') === pid);
}

/**
 * The name to show, which for a size MUST carry its product.
 *
 * Peter, 22 Sep 2026: the list read "Small, Small, Small, Medium, Large" with no
 * hint of what they were sizes OF. A size's own name is just "Small".
 */
export function displayNameOf(item, items) {
  const own = String(item?.name ?? '').trim() || 'Unnamed';
  const pid = String(item?.parentId ?? '');
  if (!pid) return own;
  const parent = (Array.isArray(items) ? items : []).find((i) => String(i?.id) === pid);
  const parentName = String(parent?.name ?? '').trim();
  return parentName ? parentName + ' — ' + own : own;
}

/**
 * The products a person can sensibly attach a group to.
 *
 * Sub items are excluded: a sub item IS an option, and attaching a group to one
 * makes an option that opens another option.
 *
 * SIZES ARE INCLUDED, and that is the important part. A product with sizes never
 * shows its own modifiers at the till: POSSurface opens the variants modal and
 * configures the CHILD (`_childItem`), so a group attached to the parent alone is
 * never seen by anybody. Ticking the parent therefore means "all of its sizes"
 * (see expandPicks), and each size can also be picked on its own.
 */
export function attachableItems(items) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((i) => {
    if (!i || i.archived) return false;
    if (isSubItem(i)) return false;
    const pid = String(i.parentId ?? '');
    if (!pid) return true;
    // a size, but only while its product is still real
    const parent = list.find((p) => String(p?.id) === pid);
    return !!parent && !parent.archived && !isSubItem(parent);
  });
}

/**
 * Turn what was ticked into what is actually written.
 * A product WITH sizes resolves to its sizes, because that is where every
 * surface reads modifiers from. Anything else stands for itself.
 */
export function expandPicks(items, pickedIds) {
  const list = Array.isArray(items) ? items : [];
  const out = new Set();
  for (const id of Array.isArray(pickedIds) ? pickedIds : []) {
    const item = list.find((i) => String(i?.id) === String(id));
    if (!item) continue;
    const sizes = sizesOf(list, item.id);
    if (sizes.length && !item.parentId) {
      for (const s of sizes) out.add(String(s.id));
    } else {
      out.add(String(item.id));
    }
  }
  return [...out];
}

/** How many products a tick list will really change, once sizes are expanded. */
export function pickedRealCount(items, pickedIds) {
  return expandPicks(items, pickedIds).length;
}

/** Narrow a list by a typed search and an optional category. */
export function matchItems(items, { search = '', categoryId = '', all = null } = {}) {
  const q = String(search || '').trim().toLowerCase();
  const cat = String(categoryId || '').trim();
  const list = Array.isArray(items) ? items : [];
  // Names are matched on what the person SEES, so typing "americano" finds
  // "Americano — Large" even though that row's own name is only "Large".
  const universe = Array.isArray(all) ? all : list;
  return list.filter((i) => {
    if (cat) {
      const parent = i?.parentId ? universe.find((p) => String(p?.id) === String(i.parentId)) : null;
      const from = parent || i;   // a size belongs to its product's categories
      const cats = [from?.cat, ...(Array.isArray(from?.cats) ? from.cats : [])].filter(Boolean).map(String);
      if (!cats.includes(cat)) return false;
    }
    if (!q) return true;
    return displayNameOf(i, universe).toLowerCase().includes(q);
  });
}

/** Search the groups themselves, by their name OR by an option inside them. */
export function matchGroups(groups, search) {
  const q = String(search || '').trim().toLowerCase();
  if (!q) return Array.isArray(groups) ? groups : [];
  return (Array.isArray(groups) ? groups : []).filter((g) => {
    if (String(g?.name ?? '').toLowerCase().includes(q)) return true;
    // Finding "oat" should find the Milk group. That is how somebody looks for
    // a modifier they remember by its option, not by the group's name.
    return (Array.isArray(g?.options) ? g.options : [])
      .some((o) => String(o?.name ?? '').toLowerCase().includes(q));
  });
}

/**
 * The patches that ADD a group to the given items.
 * Items that already carry it are skipped, so pressing the button twice is safe.
 * @returns {Array<{ id: string, patch: object, name: string }>}
 */
export function attachPatches(items, groupId, itemIds) {
  const gid = String(groupId ?? '');
  if (!gid) return [];
  const wanted = new Set((Array.isArray(itemIds) ? itemIds : []).map(String));
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !wanted.has(String(item.id))) continue;
    if (itemHasGroup(item, gid)) continue;
    const assigned = Array.isArray(item.assignedModifierGroups) ? item.assignedModifierGroups : [];
    const patch = { assignedModifierGroups: [...assigned, { groupId: gid }] };
    // Only touch the order when the item already keeps one: an absent order
    // means "use the default", and inventing one here would freeze today's
    // order into a field nobody asked for.
    const order = Array.isArray(item.optionGroupOrder) ? item.optionGroupOrder : null;
    if (order && !order.includes(gid)) patch.optionGroupOrder = [...order, gid];
    out.push({ id: String(item.id), patch, name: String(item.name ?? '') });
  }
  return out;
}

/** The patches that REMOVE a group from the given items. */
export function detachPatches(items, groupId, itemIds) {
  const gid = String(groupId ?? '');
  if (!gid) return [];
  const wanted = new Set((Array.isArray(itemIds) ? itemIds : []).map(String));
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !wanted.has(String(item.id))) continue;
    if (!itemHasGroup(item, gid)) continue;
    const assigned = Array.isArray(item.assignedModifierGroups) ? item.assignedModifierGroups : [];
    const patch = { assignedModifierGroups: assigned.filter((a) => String(a?.groupId) !== gid) };
    const order = Array.isArray(item.optionGroupOrder) ? item.optionGroupOrder : null;
    if (order && order.includes(gid)) patch.optionGroupOrder = order.filter((x) => String(x) !== gid);
    out.push({ id: String(item.id), patch, name: String(item.name ?? '') });
  }
  return out;
}

/** What the button should say, so nobody presses it not knowing the scale. */
export function attachButtonLabel(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n < 1) return 'Pick some products first';
  return n === 1 ? 'Add to 1 product' : 'Add to ' + n + ' products';
}

/** What to say after the change, naming the number that actually moved. */
export function attachResultLine(changed, alreadyHad) {
  const c = Math.max(0, Math.floor(Number(changed) || 0));
  const a = Math.max(0, Math.floor(Number(alreadyHad) || 0));
  if (c < 1 && a < 1) return 'Nothing to change.';
  if (c < 1) return a === 1 ? 'That product already had it.' : 'All ' + a + ' already had it.';
  const first = c === 1 ? 'Added to 1 product.' : 'Added to ' + c + ' products.';
  if (a < 1) return first;
  return first + ' ' + (a === 1 ? '1 already had it.' : a + ' already had it.');
}
