// src/lib/menuPricing.js
//
// ONE item price resolver for every surface: till, kiosk, MPOS, menu board,
// online storefront and QR. Every surface reads menu_items.pricing jsonb raw
// (they all select('*')), so this is the single place that turns that jsonb
// into the number a customer sees and is charged.
//
// Stored shape (written by MenuManager + PerMenuPricingTiers):
//   pricing = {
//     base, dineIn, takeaway, collection, delivery,
//     menus?: { [menuId]: { all?, base?, dineIn?, takeaway?, collection?, delivery? } }
//   }
// MenuManager mirrors pricing.base onto the legacy scalar item.price.
//
// Precedence is the till's (store.getItemPrice, v4.7.7) plus the tier's Base:
//   1. pricing.menus[menuId][channel]   menu-specific channel price
//   2. pricing.menus[menuId].all        menu-wide flat price for that menu
//   3. pricing.menus[menuId].base       the tier editor's Base field (it was
//                                       written since v4.7.8 but never read)
//   4. pricing[channel]                 channel default
//   5. pricing.base                     base
//   6. item.price                       legacy scalar, only when pricing is absent
// null and undefined mean "not set". An explicit 0 is a real price at 1 to 5.
// Results are always a Number; 0 when nothing is set or the value is not numeric.
//
// Every surface prices like the till: the storefront (online, QR at a table),
// the kiosk, the phone and the boards all call resolveItemPrice with their own
// channel and the active menu, so the same item, size, channel and menu give
// the same number everywhere. Catering is the one deliberate exception (its own
// base rule, see CateringSurface).
//
// Channel keys are dineIn, takeaway, collection, delivery. The till passes
// 'dine-in', the kiosk passes 'dineIn'; both (and 'dine_in') map to dineIn.
// Anything unknown (including null before an online customer picks a type)
// falls back to dineIn, exactly as the store always has.

const CHANNEL_MAP = {
  dineIn: 'dineIn',
  'dine-in': 'dineIn',
  dine_in: 'dineIn',
  takeaway: 'takeaway',
  collection: 'collection',
  delivery: 'delivery',
};

export const channelKey = (channel) => CHANNEL_MAP[channel] || 'dineIn';

const isSet = (v) => v !== null && v !== undefined;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Steps 1 to 3 only. Returns the tier price for this menu, or null when the
// menu has no tier for this channel (so callers can keep their own fallback).
// tier.base is the "Base" field of PerMenuPricingTiers. It sits under tier.all
// so a menu-wide flat price still wins, and above the item's channel defaults
// so a Base typed into a tier is honoured on that menu.
export function menuTierPrice(item, channel, menuId) {
  const p = item?.pricing;
  if (!p || !menuId || !p.menus) return null;
  const tier = p.menus[menuId];
  if (!tier) return null;
  const key = channelKey(channel);
  if (isSet(tier[key])) return num(tier[key]);
  if (isSet(tier.all)) return num(tier.all);
  if (isSet(tier.base)) return num(tier.base);
  return null;
}

// The reference resolver. store.getItemPrice and the kiosk's resolvePrice
// delegate here; online, QR and the boards call it directly.
export function resolveItemPrice(item, channel = 'dineIn', menuId = null) {
  const p = item?.pricing;
  if (!p) return num(item?.price);
  const tier = menuTierPrice(item, channel, menuId);
  if (tier !== null) return tier;
  const key = channelKey(channel);
  if (isSet(p[key])) return num(p[key]);
  return num(p.base);
}

// Cart line unit price for the till (store.addItem). Every caller that passes
// a linePrice builds it the same way: (base + modifier surcharge) * qty, where
// base is pricing.base (the legacy scalar for rows with no pricing). Quick add
// and a plain size pick pass base * qty, a surcharge of 0. So the surcharge is
// linePrice / qty minus base, and the unit price is that surcharge stacked on
// the RESOLVED price (tier, channel, base):
//   no linePrice from the caller -> the resolved price
//   otherwise                    -> resolved + (linePrice / qty - base)
// The surcharge is never scaled. The old branch multiplied the whole line by
// resolved / base, so a 0.50 topping cost 0.22 under a 1.23 tier on a 2.85
// size while the kiosk and online charged 0.50; and it skipped the swap when
// base was 0, so a menu-only item (base 0, tier 5.00) was charged 0.00 on
// the till. A zero base stacks on the resolved price the same way, which is
// also what a legacy open-price row needs (resolved 0, so the line is taken
// as given). menuId is the store's activeMenuId (mirrored from the till's
// resolver), so the tier the tile shows is the tier the cart charges.
export function cartUnitPrice(item, channel, menuId, linePrice = null, qty = 1) {
  const q = Number(qty) || 1;
  const resolved = resolveItemPrice(item, channel, menuId);
  if (linePrice == null) return resolved;
  const base = num(item?.pricing?.base ?? item?.price ?? 0);
  const surcharge = (Number(linePrice) || 0) / q - base;
  return resolved + surcharge;
}

// Menu board price. A board is a dine-in display, so the active menu's tier
// (dineIn, then all) wins when one exists. When no tier applies the board keeps
// the display fallback it has always had: prefer dineIn, then any-channel,
// then base, skipping zeros, then base as-is, then the legacy scalar. The
// "> 0 hides the price" rule stays at the call sites (hidePriceless).
export function resolveBoardPrice(item, menuId = null) {
  const tier = menuTierPrice(item, 'dineIn', menuId);
  if (tier !== null) return tier;
  const p = item?.pricing;
  if (p && typeof p === 'object') {
    for (const k of ['dineIn', 'all', 'base']) if (p[k] != null && Number(p[k]) > 0) return Number(p[k]);
    if (p.base != null) return Number(p.base) || 0;
  }
  return Number(item?.price) || 0;
}

// Size variants. A variant parent (type 'variants', or any item that has child
// rows through parent_id) carries base 0 and is never charged itself. Each
// child (Half, Pint) carries its own pricing, including its own menu tiers, so
// every surface prices a size by running resolveItemPrice on the CHILD row for
// the live channel and menu. The card's "from" price, the sheet header, the
// Size buttons and the cart line all read these two helpers and so agree.

// The live (non archived) children of a parent, in Back Office order. Rows
// arrive snake (parent_id, sort_order) on the kiosk and online, and camel
// (parentId, sortOrder) from the store on the till and the phone; both are read.
const parentOf = (i) => i.parent_id ?? i.parentId ?? null;
const orderOf = (i) => i.sort_order ?? i.sortOrder ?? 0;
export function variantChildren(item, allItems) {
  if (!item?.id) return [];
  return (allItems || [])
    .filter(i => i && parentOf(i) === item.id && i.archived !== true)
    .sort((a, b) => (orderOf(a) || 0) - (orderOf(b) || 0));
}

// Cheapest size for the card and for the sheet header before a size is picked.
// Sizes at 0 are ignored for the minimum, as online does, so an unpriced size
// never drags "from" down to 0. Returns null when the item has no sizes (the
// caller falls back to the item's own price) and 0 when every size is unpriced.
export function variantFromPrice(item, allItems, channel = 'dineIn', menuId = null) {
  const kids = variantChildren(item, allItems);
  if (!kids.length) return null;
  const prices = kids.map(k => resolveItemPrice(k, channel, menuId)).filter(p => p > 0);
  return prices.length ? Math.min(...prices) : 0;
}

// The phone's add path (MItemDetail, MVoiceOrder). The till's ProductModal
// stacks modifier surcharges on BASE and hands addItem linePrice = (base +
// surcharge) * qty; cartUnitPrice reads the surcharge back off base and stacks
// it on the resolved price. The phone used to pass nothing, which charged the
// resolved unit price and silently dropped every surcharge. This helper builds
// the exact opts.linePrice the till would pass and reads the unit price back
// through cartUnitPrice itself, so what the Add button shows is, by
// construction, what the cart line charges.
//   no surcharge -> linePrice null; addItem resolves (tier, channel, base)
//   surcharge    -> linePrice = (base + surcharge) * qty, the till's shape,
//                   base 0 included (a zero base row stacks on its tier)
export function planCartLine(item, channel, menuId, { modSurcharge = 0, qty = 1 } = {}) {
  const q = Number(qty) || 1;
  const extra = Number(modSurcharge) || 0;
  const base = num(item?.pricing?.base ?? item?.price ?? 0);
  const linePrice = extra !== 0 ? (base + extra) * q : null;
  const unitPrice = cartUnitPrice(item, channel, menuId, linePrice, q);
  return { unitPrice, lineTotal: unitPrice * q, linePrice };
}

// The storefront's reprice (online and QR). Online cart lines snapshot the
// unit price at add time (l.price = resolveItemPrice for the channel and menu
// in force) and keep modifiers separately in l.mods with their own prices, so
// when the customer switches Collection to Delivery, or a timed menu flips at
// the minute tick, every line's l.price is swapped for the price of the same
// row on the new channel and menu. This is the till's setOrderType reprice
// for a cart that lives outside the store. A line whose row is no longer in
// the item list is left exactly as it was.
export function repriceCartLines(cart, items, channel, menuId = null) {
  const rows = Array.isArray(items) ? items : [];
  return (cart || []).map(l => {
    if (!l || l.itemId == null) return l;
    const src = rows.find(i => i && i.id === l.itemId);
    if (!src) return l;
    const price = resolveItemPrice(src, channel, menuId);
    return price === l.price ? l : { ...l, price };
  });
}
