/**
 * kioskBasket.js: basket rules for the new kiosk design.
 *
 * Pure: imports only menuPricing.js (itself import free), so node:test can load it
 * (kioskBasket.test.js).
 *
 *   kioskLineKeyV2     the basket merge key the new design uses (F15)
 *   repriceKioskCart   reprice every line when eat in / take away or the menu changes
 *
 * The current kiosk keeps kioskLineKey (lib/kioskLine.js) unchanged: KioskApp's addToCart
 * picks this key only while the new design is on.
 */
import { resolveItemPrice } from './menuPricing.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Two adds merge into one basket line only when they are the same item, the same size, and
 * the same picks, including the note. Picks are compared as a sorted list of
 * (group, label, price, note flag, linked item), so the order they were tapped in does not
 * matter, and two options with the same name and price that deplete different items never
 * merge (a merged line keeps the first add's picks, so stock would come off the wrong item).
 * A quick add with no picks merges with a sheet add with no picks. The old key (item id plus the raw
 * selections object) ignored the note, so a second add with a different note merged into
 * the first line and lost its note.
 *
 * mods: the line's modsArray, with the Note entry already added.
 */
export function kioskLineKeyV2({ item, variant, mods } = {}) {
  const id = variant?.id || item?.id;
  const picks = (Array.isArray(mods) ? mods : [])
    .filter(Boolean)
    .map(m => [String(m.groupLabel ?? ''), String(m.label ?? ''), num(m.price), m._instruction ? 1 : 0, String(m.itemId ?? m.item_id ?? '')])
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
      }
      return 0;
    });
  return `v2:${id}:${JSON.stringify(picks)}`;
}

/**
 * The key KioskApp's addToCart gives a line added in the new design with these arguments: the
 * picks plus the Note entry addToCart appends for a typed note, and the chosen size row's id.
 */
export function kioskAddedLineKey({ item, variantItem = null, mods = [], instructions = '' } = {}) {
  const list = Array.isArray(mods) ? [...mods] : [];
  const note = typeof instructions === 'string' ? instructions.trim() : '';
  if (note) list.push({ label: note, price: 0, groupLabel: 'Note', _instruction: true });
  const variant = item && variantItem && variantItem.id ? { id: variantItem.id } : null;
  return kioskLineKeyV2({ item, variant, mods: list });
}

/**
 * The basket with every line priced for the order type and menu now in force: the item's
 * price (or the chosen size's price) from the shared resolver, plus the picked options'
 * prices, which do not depend on the order type. This is how KioskProductModal priced the
 * line when it was added.
 *
 * A line whose item (or size) row is no longer loaded is left as it was. When nothing
 * changes, the SAME array is returned, so setCart(c => repriceKioskCart(c, ...)) does not
 * re-render.
 */
export function repriceKioskCart(cart, items, orderType, menuId = null) {
  const list = Array.isArray(cart) ? cart : [];
  const byId = new Map();
  for (const row of (Array.isArray(items) ? items : [])) {
    if (row && row.id != null) byId.set(row.id, row);
  }
  let changed = false;
  const next = list.map(line => {
    if (!line || !line.item) return line;
    const src = line.variant?.id ? byId.get(line.variant.id) : byId.get(line.item.id);
    if (!src) return line;
    const extras = (Array.isArray(line.modsArray) ? line.modsArray : []).reduce((s, m) => s + num(m?.price), 0);
    const linePrice = resolveItemPrice(src, orderType, menuId) + extras;
    if (Math.abs(linePrice - num(line.linePrice)) < 1e-9) return line;
    changed = true;
    return { ...line, linePrice, lineTotal: (Number(line.qty) || 0) * linePrice };
  });
  return changed ? next : list;
}
