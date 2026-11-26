// supabase/functions/_shared/soldAs.js (the same file as src/lib/soldAs.js below this line; src/lib/soldAsCopies.test.js)
//
// "SOLD AS": WHICH ORDER TYPES A PRODUCT CAN BE SOLD ON (5.12.115).
//
// Peter, 26 Nov 2026 (Mozz): "we also need to be able to say if a product can be sold as that
// order type... a prime example is Wine: they only serve this on dine in orders, never online or
// to be taken away." And on how the POS shows it: "grey it out and say not available for X order
// type when clicked".
//
// THE RULE, one for every way of ordering (the POS, the bar, the phone POS, the kiosk, online, QR,
// catering, the booking widget and the delivery platforms):
//   * A product is sold on every order type unless it says otherwise.
//   * It says otherwise with a list of the order types it is NOT sold on, kept beside its
//     "Visible on" switches: item.visibility.notSoldAs = ['takeaway', 'collection', ...].
//     A deny list, so a product nobody has touched, and any order type added later, is sold.
//   * A size follows its product: Large Wine is not sold where Wine is not.
//   * An order type nobody named (a walk in order before one is picked) blocks nothing.
//
// WHERE IT LIVES: menu_items.visibility and msm_products.visibility are both jsonb and both already
// travel through the store, the import and a publish, so this needs no new column.
// "Visible on" is WHERE a product shows (which screen). This is HOW it may be taken (the order
// type). They sit in the same field and never touch each other's keys.
//
// PURE: no imports, so node --test and the edge functions can load it.

/** The order types, in the app's own spelling (lib/tillOrderType.js ORDER_TYPE_KEYS). */
export const SOLD_AS_TYPES = Object.freeze(['dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru']);

/** Plain words for each, as a venue reads them. */
export const SOLD_AS_WORDS = Object.freeze({
  'dine-in': 'Dine in', takeaway: 'Takeaway', collection: 'Collection', delivery: 'Delivery', 'drive-thru': 'Drive thru',
});

// Every spelling the screens use for an order type, to the one key. A bar tab, a table and a QR
// order at a table are all eaten in.
const ALIAS = {
  'dine-in': 'dine-in', dinein: 'dine-in', dine_in: 'dine-in', 'eat-in': 'dine-in', eatin: 'dine-in', eat_in: 'dine-in',
  table: 'dine-in', qr: 'dine-in', 'bar-tab': 'dine-in', bar: 'dine-in', bartab: 'dine-in', here: 'dine-in',
  takeaway: 'takeaway', 'take-away': 'takeaway', take_away: 'takeaway', takeout: 'takeaway', 'take-out': 'takeaway', togo: 'takeaway', 'to-go': 'takeaway',
  collection: 'collection', collect: 'collection', pickup: 'collection', 'pick-up': 'collection', 'click-collect': 'collection',
  delivery: 'delivery', deliver: 'delivery',
  'drive-thru': 'drive-thru', drivethru: 'drive-thru', drive_thru: 'drive-thru', 'drive-through': 'drive-thru',
};

/** The one key for an order type in any spelling, or null when it is not one we know. */
export function soldAsKey(orderType) {
  if (orderType == null) return null;
  const k = String(orderType).trim();
  if (!k) return null;
  if (ALIAS[k]) return ALIAS[k];
  // camelCase price keys (dineIn, driveThru) and anything in capitals.
  const flat = k.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return ALIAS[flat] || ALIAS[flat.replace(/[-_ ]/g, '')] || null;
}

const visOf = (item) => (item && typeof item.visibility === 'object' && item.visibility && !Array.isArray(item.visibility)) ? item.visibility : null;

/** The order types this row is NOT sold on: known keys only, each once, in the app's order. */
export function notSoldAs(item) {
  const raw = visOf(item)?.notSoldAs;
  if (!Array.isArray(raw) || !raw.length) return [];
  const got = new Set(raw.map(soldAsKey).filter(Boolean));
  return SOLD_AS_TYPES.filter((k) => got.has(k));
}

/** The order types this row IS sold on. */
export const soldAsList = (item) => { const no = new Set(notSoldAs(item)); return SOLD_AS_TYPES.filter((k) => !no.has(k)); };

const parentOf = (item, items) => {
  const pid = item && (item.parentId ?? item.parent_id);
  if (!pid || !items) return null;
  if (typeof items.get === 'function') return items.get(pid) || null;
  return (Array.isArray(items) ? items : []).find((r) => r && r.id === pid) || null;
};

/**
 * Can this product be sold on this order type?
 *   item       a menu row (store shape or a raw database row)
 *   orderType  the order type in any spelling; none (or an unknown one) blocks nothing
 *   items      optional: the venue's rows (an array, or a Map by id), so a size follows its product
 */
export function isSoldAs(item, orderType, items = null) {
  const key = soldAsKey(orderType);
  if (!item || !key) return true;
  if (notSoldAs(item).includes(key)) return false;
  const parent = parentOf(item, items);
  return parent ? !notSoldAs(parent).includes(key) : true;
}

/** What the POS says when a greyed out product is tapped: "Wine is not available for Takeaway." */
export function notSoldAsWords(item, orderType) {
  const key = soldAsKey(orderType);
  const name = (item && (item.menuName || item.menu_name || item.name)) || 'This product';
  return `${name} is not available for ${key ? SOLD_AS_WORDS[key] : 'this order type'}.`;
}

/** A short line for a product card or sheet: "Dine in only", "Not for Delivery", or '' when sold on all. */
export function soldAsSummary(item) {
  const no = notSoldAs(item);
  if (!no.length) return '';
  const yes = SOLD_AS_TYPES.filter((k) => !no.includes(k));
  if (!yes.length) return 'Not sold on any order type';
  if (yes.length === 1) return `${SOLD_AS_WORDS[yes[0]]} only`;
  if (no.length === 1) return `Not for ${SOLD_AS_WORDS[no[0]]}`;
  return `${yes.map((k) => SOLD_AS_WORDS[k]).join(', ')} only`;
}

/**
 * The visibility object with the list set (or taken off when it is empty), every other key kept.
 * A product with no visibility at all and nothing to block stays as it is (null in, null out).
 */
export function withNotSoldAs(visibility, list) {
  const base = (visibility && typeof visibility === 'object' && !Array.isArray(visibility)) ? { ...visibility } : {};
  const got = new Set((Array.isArray(list) ? list : []).map(soldAsKey).filter(Boolean));
  const clean = SOLD_AS_TYPES.filter((k) => got.has(k));
  delete base.notSoldAs;
  if (clean.length) base.notSoldAs = clean;
  if (!Object.keys(base).length) return visibility == null ? visibility : {};
  return base;
}

/** Tick or untick one order type on a visibility object. */
export function toggleSoldAs(visibility, orderType, sold) {
  const key = soldAsKey(orderType);
  if (!key) return visibility;
  const no = new Set(notSoldAs({ visibility }));
  if (sold) no.delete(key); else no.add(key);
  return withNotSoldAs(visibility, [...no]);
}

/** True when two rows block the same order types (what "sold as changed" means). */
export const sameSoldAs = (a, b) => notSoldAs(a).join('|') === notSoldAs(b).join('|');

/**
 * The lines of an order that cannot stay when it becomes `orderType` (the POS order type switch,
 * the kiosk's eat in or take away, online's Collection or Delivery).
 *   lines   the basket lines; each names its product by itemId, item_id, menuItemId or id
 *   items   the venue's rows (array or Map by id)
 * Returns the lines that are not sold on that order type.
 */
export function linesNotSoldAs(lines, orderType, items) {
  const key = soldAsKey(orderType);
  if (!key) return [];
  const byId = (items && typeof items.get === 'function') ? items : new Map((Array.isArray(items) ? items : []).filter(Boolean).map((r) => [r.id, r]));
  return (Array.isArray(lines) ? lines : []).filter((l) => {
    if (!l) return false;
    const row = byId.get(l.itemId ?? l.item_id ?? l.menuItemId ?? l.menu_item_id ?? l.id);
    return row ? !isSoldAs(row, key, byId) : false;
  });
}

/** "Wine and Prosecco are not available for Takeaway. Take them off the order first." */
export function switchBlockedWords(lines, orderType) {
  const key = soldAsKey(orderType);
  const names = [...new Set((Array.isArray(lines) ? lines : []).map((l) => (l && (l.name || l.menuName || l.label)) || 'An item'))];
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const verb = names.length === 1 ? 'is' : 'are';
  const it = names.length === 1 ? 'it' : 'them';
  return `${list} ${verb} not available for ${key ? SOLD_AS_WORDS[key] : 'that order type'}. Take ${it} off the order first.`;
}
