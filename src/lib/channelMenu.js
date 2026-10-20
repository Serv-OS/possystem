// src/lib/channelMenu.js: what each channel shows from the venue's menu, ONE rule for all of them
// (v5.11.81, channel parity round 2: Peter 19 Oct 2026, "fix it all please, we need to be bullet
// proof"; the POS is central, every channel follows the till).
//
//   channelVisible       the Back Office "Visible on" switches (item.visibility), read the same way
//                        on every channel: POS (the till, a bar tab, the handheld), Kiosk, Online
//                        (the venue's online page, QR at the table and catering, which are all
//                        online ordering pages) and Delivery (a delivery order on those pages and
//                        the delivery platforms through HubRise). QR has no switch of its own, so
//                        it follows Online. A row with no visibility set shows everywhere.
//   storefrontMenuId     the menu the online and QR pages are on: the till's resolver
//                        (lib/menus/resolveActiveMenu.js) with Back Office's pinned online menu as
//                        the pin, exactly as a till or kiosk pinned to a menu (a pin that is off
//                        schedule falls to the default menu). It bypassed the resolver before.
//   categoriesOnMenu     the categories on that menu (home menu, links), never blank
//   storefrontPriceType  the order type an online page prices its cards for: the one picked, else
//                        the first one the venue offers, never the dine in fallback
//   kioskLineSlot        THE LINE KEEPS ITS PRICE: adding more of an item already in the kiosk
//                        basket at another price (a timed menu came on between the two taps) makes
//                        a line of its own, as the till appends one. The kiosk repriced the earlier
//                        units before.
//
// THE MENU FLIP RULE, the till's: a line keeps the price it was added at. A timed menu starting or
// ending, or a Back Office price change arriving, never moves a line already in a basket or on a
// table. Only switching the order type reprices the open lines, at the menu on now (the till's
// setOrderType, the kiosk's eat in / take away switch, the online Collection / Delivery switch).
// Online and QR lines carry the menu they were priced on (line.menuId), so the server values each
// line on its own menu (_public_order_value, migration 20261020a).
//
// PURE: only lib/menus/resolveActiveMenu.js (itself pure), so node --test can load it.

import { resolveActiveMenu } from './menus/resolveActiveMenu.js';

const vis = (item) => (item && typeof item.visibility === 'object' && item.visibility) ? item.visibility : null;

// Which switch each channel reads. Online ordering pages and QR read 'online'; a delivery order on
// them, and the delivery platforms, also read 'onlineDelivery'.
const CHANNEL_SWITCH = {
  pos: 'pos', till: 'pos', bar: 'pos', 'bar-tab': 'pos', mpos: 'pos', handheld: 'pos',
  kiosk: 'kiosk',
  online: 'online', qr: 'online', catering: 'online',
  hubrise: 'online', delivery: 'online',
};

/**
 * Is this row shown on this channel?
 * @param {object} item       a menu row (snake from the database or camel from the store)
 * @param {string} channel    'pos' | 'bar' | 'mpos' | 'kiosk' | 'online' | 'qr' | 'catering' | 'hubrise'
 * @param {string} [fulfilment] the order type on an online page ('delivery' reads the Delivery switch)
 */
export function channelVisible(item, channel, fulfilment = null) {
  const v = vis(item);
  if (!v) return true;
  const key = CHANNEL_SWITCH[channel];
  if (!key) return true;
  if (v[key] === false) return false;
  if (key === 'online') {
    const delivery = channel === 'hubrise' || channel === 'delivery' || fulfilment === 'delivery';
    if (delivery && v.onlineDelivery === false) return false;
  }
  return true;
}

/**
 * The menu an online or QR page is on now. `pinnedMenuId` is Back Office's Online ordering menu
 * (locations.online_menu_id), null for "Use whichever menu is active". When the venue's menus could
 * not be read at all, a pin still holds (the page filtered to it before this rule existed).
 */
export function storefrontMenuId({ menus, categories, links, pinnedMenuId = null, timezone, now } = {}) {
  const list = Array.isArray(menus) ? menus : [];
  if (!list.length) return pinnedMenuId || null;
  return resolveActiveMenu({ menus: list, categories, links, pinnedMenuId: pinnedMenuId || null, timezone, now }) || null;
}

/**
 * The categories on `menuId`: its home categories, the ones linked to it, and the sub categories
 * of a linked one (the storefront's rule since v4.7.6; a home category's sub categories show inside
 * its section, lib/onlineMenuTree.js). No menu: every category. Never blank: a menu with none of the venue's categories
 * shows every category rather than an empty page (the storefront's rule since v5.8.31).
 */
export function categoriesOnMenu(categories, links, menuId) {
  const all = Array.isArray(categories) ? categories : [];
  if (!menuId) return all;
  const linked = new Set((Array.isArray(links) ? links : []).filter((l) => l && l.menu_id === menuId).map((l) => l.category_id));
  const inMenu = all.filter((c) => c && ((c.menu_id ?? c.menuId) === menuId || linked.has(c.id)
    || ((c.parent_id ?? c.parentId) && linked.has(c.parent_id ?? c.parentId))));
  return inMenu.length ? inMenu : all;
}

/**
 * The order type an online page prices with. QR is always dine in. Online: the one the guest
 * picked, else the first the venue offers (Collection), so a price is never shown for an order
 * type the page does not sell (resolveItemPrice reads dine in for a missing one).
 */
export function storefrontPriceType(orderType, { isQr = false, orderTypes = null } = {}) {
  if (isQr) return 'dine-in';
  if (orderType) return orderType;
  const first = Array.isArray(orderTypes) && orderTypes.length ? orderTypes[0] : null;
  return (first && (first.id || first)) || 'collection';
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Where an add lands in the kiosk basket. key: the line key the kiosk built for this item, size
 * and picks (lib/kioskLine.js kioskLineKey or lib/kioskBasket.js kioskLineKeyV2).
 *   { merge: true, key }            a line with the same key AT THE SAME PRICE: add to it
 *   { merge: false, key, baseKey }  a new line. Its key is the plain key, or, when a line with the
 *                                   same key is in the basket at another price, the key plus the
 *                                   price in pence, so every line keeps its own price and key.
 * Lines added before this rule (no baseKey) match on their key, as before.
 */
export function kioskLineSlot(cart, key, linePrice) {
  const list = Array.isArray(cart) ? cart : [];
  const baseOf = (l) => (l && (l.baseKey || l.key)) || null;
  const samePrice = (l) => Math.abs(num(l.linePrice) - num(linePrice)) < 1e-9;
  const hit = list.find((l) => l && baseOf(l) === key && samePrice(l));
  if (hit) return { merge: true, key: hit.key };
  const taken = list.some((l) => l && baseOf(l) === key);
  return { merge: false, key: taken ? `${key}@${Math.round(num(linePrice) * 100)}` : key, baseKey: key };
}
