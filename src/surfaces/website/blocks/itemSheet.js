// src/surfaces/website/blocks/itemSheet.js
//
// The menu item detail sheet's model, pure JS so node:test drives it without React DOM. The
// public site's menu cards (LiveMenu, Specials) open components/ItemSheet.jsx, which lays out
// exactly what itemSheetModel returns: words, badges, the price text and the one order button.
//
// Order button rule (5.12.9, Peter, 1 Nov): the button goes STRAIGHT to a venue only when the
// visitor already knows which one (the block is pinned to a venue, they picked one in the venue
// switch, they are on a venue page, or the site has one venue). Otherwise it reads "Order" and
// goes to the site's choose your venue page, never to a venue they did not pick.
//
// Customer facing never fails: a missing field renders nothing, nothing here throws.

import { resolveHref, explicitLocation, multiVenue, menuVenues, pagePath } from '../resolveHref.js';
import { formatPrice } from '../data/loadMenu.js';

export const DIET_WORDS = Object.freeze({ V: 'Vegetarian', VG: 'Vegan', GF: 'Gluten free', DF: 'Dairy free' });

const str = (v) => (v == null ? '' : String(v));

/** True for the keys that activate a button: Enter and Space. */
export function isActivationKey(e) {
  const k = e && e.key;
  return k === 'Enter' || k === ' ' || k === 'Spacebar';
}

/** The venue whose page the visitor is on (/locations/<slug> or a published location page), else null. */
export function venuePageLocation(ctx) {
  const path = str(ctx && ctx.path) || '/';
  const list = Array.isArray(ctx && ctx.locations) ? ctx.locations : [];
  const m = path.match(/^\/locations\/([^/?#]+)/);
  if (m) {
    let slug = m[1];
    try { slug = decodeURIComponent(slug); } catch { /* keep as typed */ }
    return list.find((l) => l && (l.online_slug === slug || l.id === slug)) || null;
  }
  const pages = Array.isArray(ctx && ctx.pages) ? ctx.pages : [];
  const page = pages.find((p) => p && p.kind === 'location' && pagePath(p) === path);
  if (page && page.location_id) return list.find((l) => l && l.id === page.location_id) || null;
  return null;
}

/**
 * True when the sheet's order button may go straight to one venue: the block is pinned to a venue,
 * the site has one venue, the visitor picked a venue (menuVenue names one of the site's venues),
 * or they are on a venue's own page.
 */
export function orderGoesDirect(ctx, { locationId, menuVenue } = {}) {
  if (!ctx) return false;
  if (explicitLocation(locationId)) return true;
  if (!multiVenue(ctx)) return true;
  const picked = str(menuVenue != null ? menuVenue : ctx.menuVenue).toLowerCase();
  if (picked && menuVenues(ctx).some((l) => str(l.online_slug).toLowerCase() === picked || l.id === picked)) return true;
  return !!venuePageLocation(ctx);
}

/**
 * itemSheetModel(item, { ctx, loc, menuVenue, locationId })
 *   → { title, description, priceText, soldOut, badges, allergenText, orderHref, orderLabel, image }
 * `loc` is menuLocation(ctx, locationId) of the block that opened the sheet (the venue whose menu is
 * on screen); `locationId` is that block's location_id prop. A sold out item gets no order button.
 */
export function itemSheetModel(item, { ctx = null, loc = null, menuVenue, locationId } = {}) {
  const it = item && typeof item === 'object' ? item : {};
  const title = str(it.name);
  const description = str(it.description);
  const price = Number(it.price);
  const priceText = Number.isFinite(price) && price > 0 ? `${it.from ? 'from ' : ''}${formatPrice(price, it.currency || 'GBP')}` : '';
  const badges = Array.isArray(it.dietary)
    ? it.dietary.filter((d) => d != null && d !== '').map((d) => ({ code: str(d), label: DIET_WORDS[d] || str(d) }))
    : [];
  const allergens = Array.isArray(it.allergens) ? it.allergens.map(str).filter(Boolean) : [];
  const allergenText = allergens.length ? `Contains: ${allergens.join(', ')}` : '';
  const image = typeof it.image === 'string' && it.image ? it.image : '';
  const soldOut = !!it.sold_out;

  let orderHref = '';
  let orderLabel = '';
  if (ctx && !soldOut) {
    try {
      if (orderGoesDirect(ctx, { locationId, menuVenue }) && loc && loc.id) {
        orderHref = resolveHref(ctx, `servos:order:${loc.id}`);
        const venueName = str(loc.name) || str(loc.online_slug);
        orderLabel = venueName ? `Order at ${venueName}` : 'Order';
      } else {
        orderHref = resolveHref(ctx, 'servos:order');
        orderLabel = 'Order';
      }
    } catch { orderHref = ''; }
    if (!orderHref) orderLabel = '';
  }
  return { title, description, priceText, soldOut, badges, allergenText, orderHref, orderLabel, image };
}
