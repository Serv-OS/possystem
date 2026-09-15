/**
 * kioskAllergens.js: allergen rules for the new kiosk design (decision 11: MARK matching
 * items, dimmed with an Unsafe badge, never hide them; the chip uses the 14 UK allergens
 * from the menu editor so matching is exact).
 *
 * Pure: NO imports, so node:test can load it (kioskAllergens.test.js).
 *
 * The menu editor stores the ids from src/data/seed.js ALLERGENS (gluten, milk, eggs ...).
 * Older rows and imports can hold other spellings ('dairy', 'Soya', 'tree nuts'), so every
 * value is read through normaliseAllergenId before it is compared. A value that is not one
 * of the 14 stays as its own lower case id: it is still listed on the item, it just can
 * never be picked on the allergen sheet.
 */

// The 14 UK allergens, in the order the design's allergen sheet shows them.
export const UK_ALLERGENS = Object.freeze([
  'gluten', 'milk', 'eggs', 'fish', 'crustaceans', 'nuts', 'peanuts',
  'soy', 'sesame', 'celery', 'mustard', 'sulphites', 'molluscs', 'lupin',
]);

const UK_SET = new Set(UK_ALLERGENS);

// Other spellings seen in menu data, mapped to the menu editor id.
const ALIASES = new Map(Object.entries({
  'cereals containing gluten': 'gluten',
  wheat: 'gluten',
  dairy: 'milk',
  lactose: 'milk',
  egg: 'eggs',
  soya: 'soy',
  soybean: 'soy',
  soybeans: 'soy',
  shellfish: 'crustaceans',
  crustacean: 'crustaceans',
  'tree nuts': 'nuts',
  'tree nut': 'nuts',
  treenuts: 'nuts',
  nut: 'nuts',
  peanut: 'peanuts',
  'sesame seeds': 'sesame',
  'sulphur dioxide': 'sulphites',
  'sulfur dioxide': 'sulphites',
  sulphite: 'sulphites',
  sulfites: 'sulphites',
  sulfite: 'sulphites',
  mollusc: 'molluscs',
  mollusk: 'molluscs',
  mollusks: 'molluscs',
  lupine: 'lupin',
}));

/** The menu editor id for an allergen value ('Dairy' gives 'milk'), or '' for nothing. */
export function normaliseAllergenId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!s) return '';
  if (UK_SET.has(s)) return s;
  return ALIASES.get(s) || s;
}

/** True when the id is one of the 14 UK allergens. */
export function isUkAllergen(id) {
  return UK_SET.has(id);
}

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
    const extra = lineExtras instanceof Map ? lineExtras.get(line.key) : null;
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
