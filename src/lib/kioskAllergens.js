/**
 * kioskAllergens.js: allergen rules for the new kiosk design (decision 11: MARK matching
 * items, dimmed with an Unsafe badge, never hide them; the chip uses the 14 UK allergens
 * from the menu editor so matching is exact).
 *
 * Pure: its one import is the shared alias table, so node:test can load it (kioskAllergens.test.js).
 *
 * The menu editor stores the ids from src/data/seed.js ALLERGENS (gluten, milk, eggs ...).
 * Older rows and imports can hold other spellings ('dairy', 'Soya', 'tree nuts'), so every
 * value is read through normaliseAllergenId before it is compared. A value that is not one
 * of the 14 stays as its own lower case id: it is still listed on the item, it just can
 * never be picked on the allergen sheet.
 *
 * v5.11.93 (multi site stock Drop 2): the 14 ids, the alias table, normaliseAllergenId and
 * isUkAllergen moved word for word to supabase/functions/_shared/allergenIds.js, so the till, the
 * edge functions and the SQL twin (stock_co__allergen_ids) share one list. Re exported here.
 */

import { UK_ALLERGENS, normaliseAllergenId } from '../../supabase/functions/_shared/allergenIds.js';

export { UK_ALLERGENS, ALIASES, normaliseAllergenId, isUkAllergen, allergenIds } from '../../supabase/functions/_shared/allergenIds.js';

const UK_SET = new Set(UK_ALLERGENS);

/** The item's allergens as normalised ids, without repeats. */
export function itemAllergenIds(item) {
  const list = Array.isArray(item?.allergens) ? item.allergens : [];
  const out = [];
  for (const a of list) {
    const id = normaliseAllergenId(a);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function filterIds(filter) {
  if (!filter) return [];
  const list = filter instanceof Set ? Array.from(filter) : (Array.isArray(filter) ? filter : []);
  const out = [];
  for (const a of list) {
    const id = normaliseAllergenId(a);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The ids the customer asked to avoid that this item contains, in the sheet's order.
 * filter: the kiosk's allergenFilter (a Set or an array).
 * sizes: the item's size rows (variant children), when it has any. An allergen on any size
 * counts, so a sized item whose sizes carry milk is still marked on its card.
 */
export function unsafeAllergenIds(item, filter, sizes = null) {
  const want = filterIds(filter);
  if (!want.length) return [];
  const has = new Set(itemAllergenIds(item));
  for (const row of (Array.isArray(sizes) ? sizes : [])) {
    for (const id of itemAllergenIds(row)) has.add(id);
  }
  return orderIds(want.filter(id => has.has(id)));
}

/** True when the item (or any of its sizes) contains an allergen the customer asked to avoid. */
export function isUnsafe(item, filter, sizes = null) {
  return unsafeAllergenIds(item, filter, sizes).length > 0;
}

/**
 * The ids for a list of allergen value lists (for example every picked option's allergens),
 * normalised, without repeats, in the sheet's order.
 */
export function allergenIdsOfLists(lists) {
  const out = [];
  for (const list of (Array.isArray(lists) ? lists : [])) {
    for (const id of itemAllergenIds({ allergens: list })) if (!out.includes(id)) out.push(id);
  }
  return orderIds(out);
}

/**
 * v5.11.108: the kiosk item sheet's picked options, as their allergen ids (options and nested
 * picks, the size group left out), resolved the way the kiosk modal resolves them. Moved here
 * from KioskItemSheet word for word so both kiosk designs read the same list.
 *   resolveOpt(opt) -> { allergens }: the option's own list, else its sub item's
 */
export function kioskPickedOptionIds({ groups, selections, nestedSelections, subGroupsCache, resolveOpt } = {}) {
  const lists = [];
  const resolve = typeof resolveOpt === 'function' ? resolveOpt : (o) => ({ allergens: o?.allergens });
  for (const g of (Array.isArray(groups) ? groups : [])) {
    if (!g || g.__isVariantGroup) continue;
    const picked = selections?.[g.id] || [];
    const seen = {};
    for (const optId of picked) {
      const opt = (g.options || []).find(o => o.id === optId);
      if (!opt) continue;
      lists.push(resolve(opt).allergens);
      const occ = seen[optId] || 0;
      seen[optId] = occ + 1;
      const sub = opt.subGroupId ? subGroupsCache?.[opt.subGroupId] : null;
      if (!sub) continue;
      const subSel = nestedSelections?.[g.id + ':' + optId + ':' + occ]?.[sub.id] || [];
      for (const subId of subSel) {
        const subOpt = (sub.options || []).find(o => o.id === subId);
        if (subOpt) lists.push(resolve(subOpt).allergens);
      }
    }
  }
  return allergenIdsOfLists(lists);
}

/**
 * v5.11.108: one picked option's allergens: its own list when it has one, else the menu item it
 * is linked to or named after (the kiosk's resolveOpt rule). A list of values, not yet normalised.
 */
export function optionAllergenList(opt, linked = null) {
  if (Array.isArray(opt?.allergens) && opt.allergens.length > 0) return opt.allergens;
  return Array.isArray(linked?.allergens) ? linked.allergens : [];
}

/**
 * v5.11.108: what a guest is shown for an item as it is being built, on every channel: the
 * item, its picked size and every picked option (oat milk, a nut topping), as one list of ids
 * without repeats, in the sheet's order. optionLists: allergen value lists (optionAllergenList)
 * or ids (kioskPickedOptionIds), one per pick.
 */
export function shownAllergenIds({ item = null, size = null, optionLists = [] } = {}) {
  const lists = [item?.allergens, size?.allergens];
  for (const l of (Array.isArray(optionLists) ? optionLists : [])) lists.push(l);
  return allergenIdsOfLists(lists);
}

/**
 * What the item sheet warns about: the avoided allergens in the item, its size (the picked
 * size, or every size before one is picked) and the picked options.
 *   { item, pickedSize, sizes, optionIds, filter } -> ids in the sheet's order
 */
export function sheetUnsafeIds({ item, pickedSize = null, sizes = [], optionIds = [], filter } = {}) {
  const want = filterIds(filter);
  if (!want.length) return [];
  const has = new Set(itemAllergenIds(item));
  const sizeRows = pickedSize ? [pickedSize] : (Array.isArray(sizes) ? sizes : []);
  for (const row of sizeRows) for (const id of itemAllergenIds(row)) has.add(id);
  for (const id of (Array.isArray(optionIds) ? optionIds : [])) has.add(normaliseAllergenId(id));
  return orderIds(want.filter(id => has.has(id)));
}

/** Ids in the sheet's order: the 14 first, then anything else in the order given. */
export function orderIds(ids) {
  const list = Array.isArray(ids) ? ids : [];
  const known = UK_ALLERGENS.filter(id => list.includes(id));
  const other = list.filter(id => !UK_SET.has(id));
  return [...known, ...other.filter((id, i) => other.indexOf(id) === i)];
}

/**
 * The allergens in a kiosk basket: [{ id, names }] in the sheet's order, where names are
 * the basket line names that contain it. A line counts its item, its chosen size row, every
 * picked modifier that is linked to a menu item (mod.itemId), and the allergens stored on
 * the picked options themselves (lineExtras: a Map of line key to allergen ids, recorded by
 * the item sheet when the line was added, because modsArray does not carry them).
 */
export function basketAllergens(cart, items, lineExtras = null) {
  const byId = new Map();
  for (const row of (Array.isArray(items) ? items : [])) {
    if (row && row.id != null) byId.set(row.id, row);
  }
  const found = new Map();   // id -> names[]
  for (const line of (Array.isArray(cart) ? cart : [])) {
    if (!line) continue;
    const name = line.name || line.item?.name || '';
    const ids = new Set(itemAllergenIds(line.item));
    if (line.variant?.id && byId.has(line.variant.id)) {
      for (const id of itemAllergenIds(byId.get(line.variant.id))) ids.add(id);
    }
    for (const m of (Array.isArray(line.modsArray) ? line.modsArray : [])) {
      if (m && m.itemId && byId.has(m.itemId)) {
        for (const id of itemAllergenIds(byId.get(m.itemId))) ids.add(id);
      }
    }
    // v5.11.81: a line kept at its own price has its own key (lib/channelMenu.js kioskLineSlot);
    // the allergens noted for the item and picks ride its base key.
    const extra = lineExtras instanceof Map ? (lineExtras.get(line.key) || (line.baseKey ? lineExtras.get(line.baseKey) : null)) : null;
    for (const id of (Array.isArray(extra) ? extra : [])) {
      const norm = normaliseAllergenId(id);
      if (norm) ids.add(norm);
    }
    for (const id of ids) {
      if (!found.has(id)) found.set(id, []);
      const names = found.get(id);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return orderIds(Array.from(found.keys())).map(id => ({ id, names: found.get(id) }));
}

/** The i18n key for a UK allergen id, or null for any other id. */
export function kioskAllergenKey(id) {
  return UK_SET.has(id) ? `k2.allergen.${id}` : null;
}

/**
 * Display labels for allergen ids. translate is the i18n t function. A UK allergen uses
 * its k2.allergen key; any other value shows as stored, with a capital first letter.
 */
export function kioskAllergenLabels(ids, translate) {
  const tr = typeof translate === 'function' ? translate : (k) => k;
  return (Array.isArray(ids) ? ids : []).map(id => {
    const key = kioskAllergenKey(id);
    if (key) return tr(key);
    const s = String(id || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }).filter(Boolean);
}

/** A new filter Set with the id added or taken away. */
export function toggleAllergen(filter, id) {
  const next = new Set(filterIds(filter));
  const norm = normaliseAllergenId(id);
  if (!norm) return next;
  if (next.has(norm)) next.delete(norm); else next.add(norm);
  return next;
}
