// lineCategories.js: the categories a sold line counts under, on every channel (v5.11.78 round 1).
// PURE, no imports: the public storefront (online, QR, catering) loads it as well as the till.

/**
 * The categories a sold line counts under, { cat, cats }, on EVERY channel: the till (store.addItem,
 * a bar tab round), the online and QR page, catering, and the server's own deal check
 * (_public_order_value, 20261019a). A size takes its product's (v5.5.259: a size row can carry a
 * stale category from creation or a move), the product's "Also in" list with it; anything else
 * its own. Reads store rows (parentId) and raw rows (parent_id). `cats` is null when there are none.
 *
 * Round 1 fix (19 Oct 2026): the till built its lines with `cat` only, so an automatic deal that
 * reaches an item through its "Also in" category (discountEngine itemMatchesCategories reads
 * cats) never fired at the counter or on a bar tab while the kiosk, online, QR and the server gave
 * it (a wrap in Cold, also in Mains: a meal deal took 2.00 off online and 0.00 at the till). And a
 * size counted under its own row's category online and on the server but its product's on the
 * till and the kiosk. One rule now, the till's.
 */
export function lineCategories(item, menuItems) {
  const pid = item?.parentId ?? item?.parent_id ?? null;
  const product = pid ? (Array.isArray(menuItems) ? menuItems : []).find((m) => m && m.id === pid) || null : null;
  const src = product?.cat ? product : item;
  const list = Array.isArray(src?.cats) ? src.cats.filter((c) => c != null && c !== '') : [];
  return { cat: src?.cat || null, cats: list.length ? list : null };
}
