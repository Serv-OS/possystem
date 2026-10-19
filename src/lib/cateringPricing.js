// cateringPricing.js: which menu a catering item is priced on (v5.11.78, channel parity).
//
// 19 Oct 2026: catering priced every item from its base price, whatever the order type and
// whatever the catering menu said (its own rule since v5.5.528, written in four places, never a
// decision: Back Office labels the Collection and Delivery prices plainly, and a tier typed on the
// catering menu was ignored). Catering now prices exactly as the till and the online page do
// (lib/menuPricing.js resolveItemPrice): the price for its order type (Collection or Delivery),
// then the catering menu's tier, then base. Timed menus stay out (Peter, 7 Sep): an event days
// ahead is not on today's schedule, so the menu is the one chosen in Catering settings.
//
//   one menu chosen        every item is priced on it
//   several menus chosen   an item is priced on its own category's menu when that menu is one of
//                          them (a size takes its product's category), else on no menu (its
//                          order type price, then base)
//   no menu chosen         no menu (order type price, then base)
//
// The server prices the same basket the same way (migration 20261019a, _public_order_value no
// longer floors catering at base): it is sent the one menu when one is chosen, else none, and with
// none it floors each line at the lowest price above zero, never above what this page charged.
// PURE: no imports.

/** The menu an item is priced on, or null. */
export function cateringMenuIdFor(item, { menuIds = [], items = [], categories = [] } = {}) {
  const chosen = Array.isArray(menuIds) ? menuIds.filter(Boolean) : [];
  if (chosen.length === 1) return chosen[0];
  if (!chosen.length || !item) return null;
  const pid = item.parent_id ?? item.parentId ?? null;
  const parent = pid != null ? (Array.isArray(items) ? items : []).find((r) => r && r.id === pid) : null;
  const catId = (parent && parent.cat) || item.cat || null;
  if (catId == null) return null;
  const cat = (Array.isArray(categories) ? categories : []).find((c) => c && c.id === catId);
  const home = cat ? (cat.menu_id ?? cat.menuId ?? null) : null;
  return home && chosen.includes(home) ? home : null;
}

/** The one menu id a catering order is sent with (place_public_order): the chosen menu, when one. */
export function cateringOrderMenuId(menuIds = []) {
  const chosen = Array.isArray(menuIds) ? menuIds.filter(Boolean) : [];
  return chosen.length === 1 ? chosen[0] : null;
}
