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

/**
 * The products a person can sensibly attach a group to.
 *
 * Excludes: archived items, sub items (they ARE the options, attaching a group
 * to one makes an option that opens another option), and size children, whose
 * modifiers come from the parent.
 */
export function attachableItems(items) {
  return (Array.isArray(items) ? items : []).filter((i) => {
    if (!i || i.archived) return false;
    const type = String(i.type ?? '');
    if (type === 'sub' || type === 'subitem' || type === 'sub_item') return false;
    if (i.parentId) return false;
    return true;
  });
}

/** Narrow a list by a typed search and an optional category. */
export function matchItems(items, { search = '', categoryId = '' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  const cat = String(categoryId || '').trim();
  return (Array.isArray(items) ? items : []).filter((i) => {
    if (cat) {
      const cats = [i?.cat, ...(Array.isArray(i?.cats) ? i.cats : [])].filter(Boolean).map(String);
      if (!cats.includes(cat)) return false;
    }
    if (!q) return true;
    return String(i?.name ?? '').toLowerCase().includes(q);
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
