// src/lib/menuSetPrice.js
//
// v5.11.109 (Peter, 28 Oct 2026): Back Office, Menu manager, a menu's settings: "Set every item on
// this menu to one price". It writes the MENU price of each product, item.pricing.menus[menuId].all,
// the "Default for this menu" field of the product's Per menu pricing box (PerMenuPricingTiers). The
// product's own prices (base and order types) are never touched, so the menu's schedule decides
// when the price applies, and taking the menu price off brings the normal prices back.
// Pure, tested by menuSetPrice.test.js. The save goes through the store's normal save path
// (bulkUpdateMenuItems, one product at a time, compare and set).

import { allowedCategoryIds, itemInAllowedCats } from './menuMembership.js';
import { isOptionOnlyItem } from './menuRules.js';

/**
 * What "every item on this menu" means: the products the tills show on it (live, sold on their
 * own, in a category on the menu or a sub category of one). A product with sizes is priced on
 * each size, so its sizes are written instead of it.
 * Returns { targets, products, withSizes, sizes, ownPrices }:
 *   targets    the rows to write (products without sizes, and every size of the others)
 *   products   how many products are on the menu
 *   withSizes  how many of them have sizes
 *   sizes      how many sizes that is
 *   ownPrices  how many targets already have order type prices of their own on this menu
 *              (they are replaced, so the menu shows one price everywhere)
 */
export function menuPriceTargets({ menuId, categories, links, items }) {
  const empty = { targets: [], products: 0, withSizes: 0, sizes: 0, ownPrices: 0 };
  if (!menuId) return empty;
  const allowed = allowedCategoryIds(categories || [], menuId, links || []);
  const live = (items || []).filter((i) => i && !i.archived);
  const products = live.filter((i) => !(i.parentId || i.parent_id) && !isOptionOnlyItem(i) && itemInAllowedCats(i, allowed));
  const ids = new Set(products.map((p) => p.id));
  const sizesOf = new Map();
  for (const s of live) {
    const parent = s.parentId || s.parent_id;
    if (parent && ids.has(parent)) sizesOf.set(parent, [...(sizesOf.get(parent) || []), s]);
  }
  const targets = [];
  let withSizes = 0, sizes = 0;
  for (const p of products) {
    const kids = sizesOf.get(p.id);
    if (kids?.length) { withSizes += 1; sizes += kids.length; targets.push(...kids); } else targets.push(p);
  }
  const ownPrices = targets.filter((t) => hasOwnMenuPrices(t, menuId)).length;
  return { targets, products: products.length, withSizes, sizes, ownPrices };
}

/** Does this row carry prices other than the menu wide one for this menu (an order type, Base)? */
export function hasOwnMenuPrices(item, menuId) {
  const tier = item?.pricing?.menus?.[menuId];
  return !!tier && typeof tier === 'object' && Object.keys(tier).some((k) => k !== 'all' && tier[k] != null);
}

/** The pricing jsonb with this menu's price set to `amount` (menus[menuId] = { all }). Nothing else changes. */
export function pricingWithMenuPrice(pricing, menuId, amount) {
  const p = pricing && typeof pricing === 'object' ? pricing : {};
  const menus = p.menus && typeof p.menus === 'object' ? p.menus : {};
  return { ...p, menus: { ...menus, [menuId]: { all: amount } } };
}

/** A typed amount as money: 2 places, never negative, null when it is not a number. */
export function readAmount(text) {
  const t = String(text ?? '').trim().replace(/^[£$€]/, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100) / 100;
}

/** The preview line before anything is written. */
export function previewWords({ products, withSizes, sizes, ownPrices, targets }, menuName, priceText) {
  if (!products) return `No products are on ${menuName} yet.`;
  const parts = [`This sets ${targets.length} ${targets.length === 1 ? 'item' : 'items'} on ${menuName} to ${priceText}.`];
  if (withSizes) parts.push(`${withSizes} ${withSizes === 1 ? 'product has' : 'products have'} sizes: all ${sizes} sizes get ${priceText}.`);
  if (ownPrices) parts.push(`${ownPrices} had their own order type prices on this menu; those are replaced too.`);
  parts.push('Base prices are not changed.');
  return parts.join(' ');
}
