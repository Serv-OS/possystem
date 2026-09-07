import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveItemPrice, menuTierPrice, resolveBoardPrice, cartUnitPrice, channelKey, repriceCartLines } from './menuPricing.js';

const LUNCH = 'menu-lunch';
const burger = (pricing, extra = {}) => ({ id: 'burger', name: 'Burger', price: 10.5, pricing, ...extra });

// ── channelKey ──────────────────────────────────────────────────────────────
test('channelKey: canonical keys pass through, aliases map to dineIn, unknown falls back to dineIn', () => {
  assert.equal(channelKey('dineIn'), 'dineIn');
  assert.equal(channelKey('takeaway'), 'takeaway');
  assert.equal(channelKey('collection'), 'collection');
  assert.equal(channelKey('delivery'), 'delivery');
  assert.equal(channelKey('dine-in'), 'dineIn');
  assert.equal(channelKey('dine_in'), 'dineIn');
  assert.equal(channelKey(null), 'dineIn');
  assert.equal(channelKey(undefined), 'dineIn');
  assert.equal(channelKey('bar'), 'dineIn');
});

// ── resolveItemPrice: tier per channel ──────────────────────────────────────
test('tier per channel: menus[menuId][channel] beats everything', () => {
  const it = burger({ base: 10.5, dineIn: 11, takeaway: 9, menus: { [LUNCH]: { all: 8.5, takeaway: 7.5 } } });
  assert.equal(resolveItemPrice(it, 'takeaway', LUNCH), 7.5);
  assert.equal(resolveItemPrice(it, 'dine-in', LUNCH), 8.5);   // no dineIn tier, falls to tier.all
});

test('tier all: menus[menuId].all applies to every channel for that menu', () => {
  const it = burger({ base: 10.5, dineIn: 11, delivery: 12, menus: { [LUNCH]: { all: 8.5 } } });
  for (const ch of ['dineIn', 'dine-in', 'takeaway', 'collection', 'delivery']) {
    assert.equal(resolveItemPrice(it, ch, LUNCH), 8.5, ch);
  }
});

test('no tier for that menu: channel default, then base', () => {
  const it = burger({ base: 10.5, dineIn: null, takeaway: null, collection: null, delivery: 12 });
  assert.equal(resolveItemPrice(it, 'delivery', LUNCH), 12);
  assert.equal(resolveItemPrice(it, 'collection', LUNCH), 10.5);
  assert.equal(resolveItemPrice(it, 'dine-in', LUNCH), 10.5);
  assert.equal(resolveItemPrice(it, 'delivery', null), 12);
  assert.equal(resolveItemPrice(it, 'dineIn'), 10.5);
});

test('unknown menu id is ignored: falls through to channel then base', () => {
  const it = burger({ base: 10.5, takeaway: 9, menus: { [LUNCH]: { all: 8.5 } } });
  assert.equal(resolveItemPrice(it, 'takeaway', 'menu-does-not-exist'), 9);
  assert.equal(resolveItemPrice(it, 'dineIn', 'menu-does-not-exist'), 10.5);
  assert.equal(resolveItemPrice(it, 'dineIn', 'menu-1'), 10.5);   // the store's phantom default id
});

test('menuId null or undefined never reads a tier', () => {
  const it = burger({ base: 10.5, menus: { [LUNCH]: { all: 8.5 } } });
  assert.equal(resolveItemPrice(it, 'dineIn', null), 10.5);
  assert.equal(resolveItemPrice(it, 'dineIn', undefined), 10.5);
  assert.equal(resolveItemPrice(it, 'dineIn'), 10.5);
});

test('legacy scalar: item.price only when pricing is absent', () => {
  assert.equal(resolveItemPrice({ price: 4.25 }, 'dineIn', LUNCH), 4.25);
  assert.equal(resolveItemPrice({ price: 4.25, pricing: null }, 'takeaway'), 4.25);
  assert.equal(resolveItemPrice({ price: 4.25, pricing: undefined }), 4.25);
  // pricing present: the scalar is NOT consulted even when base is unset
  assert.equal(resolveItemPrice({ price: 4.25, pricing: { dineIn: null } }, 'dineIn'), 0);
});

test('alias channel keys: dine-in and dine_in read the dineIn price at every level', () => {
  const it = burger({ base: 10.5, dineIn: 9.75, menus: { [LUNCH]: { dineIn: 8 } } });
  assert.equal(resolveItemPrice(it, 'dine-in', LUNCH), 8);
  assert.equal(resolveItemPrice(it, 'dine_in', LUNCH), 8);
  assert.equal(resolveItemPrice(it, 'dineIn', LUNCH), 8);
  assert.equal(resolveItemPrice(it, 'dine-in', null), 9.75);
  assert.equal(resolveItemPrice(it, 'dine_in', null), 9.75);
});

test('unknown or missing channel falls back to dineIn', () => {
  const it = burger({ base: 10.5, dineIn: 9.75, takeaway: 9 });
  assert.equal(resolveItemPrice(it, 'bar'), 9.75);
  assert.equal(resolveItemPrice(it, null), 9.75);
  assert.equal(resolveItemPrice(it, undefined), 9.75);
});

test('null and undefined tier values are "not set", explicit 0 is a price', () => {
  const it = burger({ base: 3.5, dineIn: 0, menus: { [LUNCH]: { dineIn: null, all: undefined }, 'menu-free': { dineIn: 0 } } });
  assert.equal(resolveItemPrice(it, 'dineIn', LUNCH), 0);          // tier unset, channel dineIn = 0 is real
  assert.equal(resolveItemPrice(it, 'takeaway', LUNCH), 3.5);      // tier unset, no takeaway, base
  assert.equal(resolveItemPrice(it, 'takeaway', 'menu-free'), 3.5);// tier has dineIn only
  assert.equal(resolveItemPrice(it, 'dineIn', 'menu-free'), 0);    // explicit tier zero
  assert.equal(menuTierPrice(it, 'dineIn', LUNCH), null);
  assert.equal(menuTierPrice(it, 'dineIn', 'menu-free'), 0);
  assert.equal(menuTierPrice(it, 'dineIn', null), null);
});

// ── tier.base: the tier editor's Base field ─────────────────────────────────
// PerMenuPricingTiers has written pricing.menus[menuId].base since v4.7.8 and
// no resolver read it, so a Base typed into a tier changed nothing. It now sits
// at step 3: tier[channel] > tier.all > tier.base > pricing[channel] > pricing.base.
test('tier.base is read after tier.all and before the channel default and base', () => {
  const it = burger({ base: 10.5, takeaway: 9, menus: { [LUNCH]: { base: 8 } } });
  assert.equal(menuTierPrice(it, 'dineIn', LUNCH), 8);
  assert.equal(resolveItemPrice(it, 'dineIn', LUNCH), 8);          // beats pricing.base
  assert.equal(resolveItemPrice(it, 'takeaway', LUNCH), 8);        // beats pricing.takeaway 9
  assert.equal(resolveItemPrice(it, 'collection', LUNCH), 8);
  assert.equal(resolveItemPrice(it, 'delivery', LUNCH), 8);
  // only for that menu
  assert.equal(resolveItemPrice(it, 'dineIn', 'menu-other'), 10.5);
  assert.equal(resolveItemPrice(it, 'takeaway', null), 9);
});

test('tier.base loses to tier.all and to tier[channel]', () => {
  const allWins = burger({ base: 10.5, menus: { [LUNCH]: { all: 7, base: 8 } } });
  assert.equal(resolveItemPrice(allWins, 'dineIn', LUNCH), 7);
  assert.equal(resolveItemPrice(allWins, 'delivery', LUNCH), 7);
  const chanWins = burger({ base: 10.5, menus: { [LUNCH]: { takeaway: 6, all: 7, base: 8 } } });
  assert.equal(resolveItemPrice(chanWins, 'takeaway', LUNCH), 6);
  assert.equal(resolveItemPrice(chanWins, 'dineIn', LUNCH), 7);
  const chanOverBase = burger({ base: 10.5, menus: { [LUNCH]: { dineIn: 6.5, base: 8 } } });
  assert.equal(resolveItemPrice(chanOverBase, 'dine-in', LUNCH), 6.5);
  assert.equal(resolveItemPrice(chanOverBase, 'takeaway', LUNCH), 8);   // no takeaway tier, no all: tier.base
});

test('tier.base: null and undefined are "not set", explicit 0 is a price, strings coerce', () => {
  assert.equal(resolveItemPrice(burger({ base: 10.5, menus: { [LUNCH]: { base: null } } }), 'dineIn', LUNCH), 10.5);
  assert.equal(resolveItemPrice(burger({ base: 10.5, menus: { [LUNCH]: { base: undefined } } }), 'dineIn', LUNCH), 10.5);
  assert.equal(resolveItemPrice(burger({ base: 10.5, takeaway: 9, menus: { [LUNCH]: { base: 0 } } }), 'takeaway', LUNCH), 0);
  assert.equal(menuTierPrice(burger({ base: 10.5, menus: { [LUNCH]: { base: 0 } } }), 'dineIn', LUNCH), 0);
  assert.equal(resolveItemPrice(burger({ base: 10.5, menus: { [LUNCH]: { base: '8.25' } } }), 'dineIn', LUNCH), 8.25);
  // a tier that only carries an unset base is the same as no tier
  assert.equal(menuTierPrice(burger({ base: 10.5, menus: { [LUNCH]: { base: null } } }), 'dineIn', LUNCH), null);
});

test('tier.base applies to a variant child on that menu like any other tier field', () => {
  const child = { id: 'hk-half', parent_id: 'hk', pricing: { base: 2.85, collection: 3.02, menus: { [LUNCH]: { base: 2.5 } } } };
  assert.equal(resolveItemPrice(child, 'collection', LUNCH), 2.5);
  assert.equal(resolveItemPrice(child, 'collection', null), 3.02);
  assert.equal(resolveBoardPrice(child, LUNCH), 2.5);
  assert.equal(cartUnitPrice(child, 'dine-in', LUNCH), 2.5);
  assert.equal(cartUnitPrice(child, 'dine-in', LUNCH, 2.85, 1), 2.5);   // quick add passes base, the tier is charged
});

test('always returns a Number: numeric strings coerce, junk and empty become 0', () => {
  assert.equal(resolveItemPrice(burger({ base: '10.50' })), 10.5);
  assert.equal(resolveItemPrice(burger({ base: 10.5, menus: { [LUNCH]: { all: '8.50' } } }), 'dineIn', LUNCH), 8.5);
  assert.equal(resolveItemPrice(burger({ base: 'abc' })), 0);
  assert.equal(resolveItemPrice(burger({ base: '' })), 0);
  assert.equal(resolveItemPrice({}), 0);
  assert.equal(resolveItemPrice(null), 0);
  assert.equal(resolveItemPrice(undefined), 0);
  assert.equal(resolveItemPrice({ pricing: {} }), 0);
  assert.equal(resolveItemPrice({ price: '4.25' }), 4.25);
});

test('malformed menus container (non-object tier) is skipped like the store did', () => {
  const it = burger({ base: 10.5, menus: { [LUNCH]: 7 } });
  assert.equal(resolveItemPrice(it, 'dineIn', LUNCH), 10.5);
  assert.equal(resolveItemPrice(burger({ base: 10.5, menus: null }), 'dineIn', LUNCH), 10.5);
});

// ── parity with the store's original getItemPrice (copied verbatim) ─────────
// store/index.js is not importable in node (it pulls supabase at module load),
// so the pre-refactor function body is reproduced here and the shared resolver
// is compared against it over a grid of inputs. The only intended delta is that
// the shared resolver returns Number(), so the legacy result is coerced too.
function legacyStoreGetItemPrice(item, orderType = 'dineIn', menuId = null) {
  const p = item?.pricing;
  if (!p) return item?.price || 0;
  const MAP = { 'dine-in':'dineIn', 'takeaway':'takeaway', 'collection':'collection', 'delivery':'delivery', 'dineIn':'dineIn' };
  const key = MAP[orderType] || 'dineIn';
  if (menuId && p.menus && p.menus[menuId]) {
    const tier = p.menus[menuId];
    if (tier[key] !== null && tier[key] !== undefined) return tier[key];
    if (tier.all  !== null && tier.all  !== undefined) return tier.all;
  }
  return (p[key] !== null && p[key] !== undefined) ? p[key] : (p.base || 0);
}

test('parity: shared resolver equals the original store precedence over an input grid', () => {
  const vals = [undefined, null, 0, 2.5];
  const pricings = [undefined, null];
  for (const base of [undefined, 0, 10.5]) for (const dineIn of vals) for (const takeaway of vals)
    for (const tierAll of vals) for (const tierDine of vals) for (const withMenus of [false, true]) {
      const pricing = { base, dineIn, takeaway, collection: null, delivery: 12 };
      if (withMenus) pricing.menus = { [LUNCH]: { all: tierAll, dineIn: tierDine, takeaway: null } };
      pricings.push(pricing);
    }
  const items = [];
  for (const pricing of pricings) for (const price of [undefined, 0, 4.25]) items.push({ price, pricing });
  let checked = 0;
  for (const item of items) for (const ch of ['dine-in', 'dineIn', 'takeaway', 'collection', 'delivery', 'bar', undefined])
    for (const menuId of [null, undefined, LUNCH, 'menu-other']) {
      const legacy = Number(legacyStoreGetItemPrice(item, ch, menuId)) || 0;
      assert.equal(resolveItemPrice(item, ch, menuId), legacy, JSON.stringify({ item, ch, menuId }));
      checked++;
    }
  assert.ok(checked > 10000, `grid too small: ${checked}`);
});

// ── resolveBoardPrice ───────────────────────────────────────────────────────
test('board: the active menu tier wins (dineIn, then all)', () => {
  const it = burger({ base: 10.5, dineIn: 11, menus: { [LUNCH]: { all: 8.5, dineIn: 8 } } });
  assert.equal(resolveBoardPrice(it, LUNCH), 8);
  assert.equal(resolveBoardPrice(burger({ base: 10.5, dineIn: 11, menus: { [LUNCH]: { all: 8.5 } } }), LUNCH), 8.5);
  assert.equal(resolveBoardPrice(it, LUNCH), resolveItemPrice(it, 'dineIn', LUNCH));
});

test('board: an explicit tier zero comes back as 0 (call sites hide it)', () => {
  const it = burger({ base: 10.5, menus: { [LUNCH]: { all: 0 } } });
  assert.equal(resolveBoardPrice(it, LUNCH), 0);
});

test('board: no tier (or no active menu) keeps the legacy display chain', () => {
  // prefer dineIn, then all, then base, skipping zeros and nulls
  assert.equal(resolveBoardPrice(burger({ base: 10.5, dineIn: 11 }), null), 11);
  assert.equal(resolveBoardPrice(burger({ base: 10.5, dineIn: 11 }), 'menu-other'), 11);
  assert.equal(resolveBoardPrice(burger({ base: 10.5, dineIn: 0 }), null), 10.5);   // zero dineIn skipped (board rule, not the till's)
  assert.equal(resolveBoardPrice(burger({ base: 10.5, dineIn: null, all: 9 }), null), 9);
  assert.equal(resolveBoardPrice(burger({ base: 0 }), null), 0);
  assert.equal(resolveBoardPrice(burger({ base: null }), null), 10.5);   // base unset: legacy scalar (the fixture's price), as before
  assert.equal(resolveBoardPrice({ price: 4.25 }, LUNCH), 4.25);
  assert.equal(resolveBoardPrice({ price: 'x' }, null), 0);
  assert.equal(resolveBoardPrice({ price: 4.25, pricing: 'junk' }, null), 4.25);   // non-object pricing ignored, as before
});

test('board: tier applies to variant children exactly like parents', () => {
  const child = { id: 'pepsi-large', parent_id: 'pepsi', price: 2.5, pricing: { base: 2.5, menus: { [LUNCH]: { all: 2 } } } };
  assert.equal(resolveBoardPrice(child, LUNCH), 2);
  assert.equal(resolveBoardPrice(child, null), 2.5);
});

// ── storefront (online + QR): prices like the till ──────────────────────────
// OnlineSurface.priceFor is resolveItemPrice(item, orderType, effectiveMenuId)
// with orderType 'collection' or 'delivery' online and 'dine-in' at a QR table.
// The cart line (l.price), the checkout totals and the order_queue line price
// all read that one number. There is no separate storefront rule any more: a
// channel price set for the till is charged online too.
const storefront = (it, orderType, menuId) => resolveItemPrice(it, orderType, menuId);

test('storefront: the active menu tier applies (channel, then all, then tier base)', () => {
  const it = burger({ base: 10.5, delivery: 12, menus: { [LUNCH]: { all: 8.5, delivery: 9 } } });
  assert.equal(storefront(it, 'delivery', LUNCH), 9);
  assert.equal(storefront(it, 'collection', LUNCH), 8.5);
  assert.equal(storefront(it, 'dine-in', LUNCH), 8.5);   // QR table
  const tb = burger({ base: 10.5, delivery: 12, menus: { [LUNCH]: { base: 8 } } });
  assert.equal(storefront(tb, 'delivery', LUNCH), 8);
  assert.equal(storefront(tb, 'dine-in', LUNCH), 8);
});

test('storefront: no tier means the channel price, then base, exactly as the till charges', () => {
  // A venue that set Delivery 12.00 and Dine-in 11.00 for the till charges those online and at the QR table.
  const it = burger({ base: 10.5, dineIn: 11, delivery: 12 });
  assert.equal(storefront(it, 'delivery', null), 12);
  assert.equal(storefront(it, 'delivery', LUNCH), 12);          // menu with no tier for this item
  assert.equal(storefront(it, 'collection', null), 10.5);       // no collection price: base
  assert.equal(storefront(it, 'collection', 'menu-other'), 10.5);
  assert.equal(storefront(it, 'dine-in', null), 11);            // QR table reads the dineIn price
  // tier for a different channel only: the channel price still applies for this one
  const tiered = burger({ base: 10.5, delivery: 12, menus: { [LUNCH]: { takeaway: 7 } } });
  assert.equal(storefront(tiered, 'delivery', LUNCH), 12);
  assert.equal(storefront(tiered, 'collection', LUNCH), 10.5);
  // parity with the till's cart for the same channel and menu (quick add and
  // the base * qty shortcut), and with the board for dine-in
  for (const ch of ['collection', 'delivery', 'dine-in']) for (const menu of [null, LUNCH, 'menu-other']) {
    for (const row of [it, tiered]) {
      assert.equal(storefront(row, ch, menu), cartUnitPrice(row, ch, menu), `${ch} ${menu} quick add`);
      assert.equal(storefront(row, ch, menu), cartUnitPrice(row, ch, menu, 10.5 * 2, 2), `${ch} ${menu} base * qty`);
      if (ch === 'dine-in') assert.equal(storefront(row, ch, menu), resolveBoardPrice(row, menu), `board ${menu}`);
    }
  }
});

test('storefront: legacy rows and junk resolve like the till', () => {
  // [row, expected]: what the till charges on a quick add is what the storefront shows
  const rows = [
    [{ price: 4.25 }, 4.25], [{ price: 4.25, pricing: null }, 4.25], [{ price: 4.25, pricing: { base: null } }, 0],
    [{ pricing: { base: '3.10' } }, 3.1], [{ pricing: {} }, 0], [{}, 0], [null, 0],
  ];
  for (const [it, want] of rows) {
    for (const ch of ['delivery', 'collection', 'dine-in', null]) {
      assert.equal(storefront(it, ch, null), want, JSON.stringify({ it, ch }));
      assert.equal(storefront(it, ch, null), cartUnitPrice(it, ch, null), JSON.stringify({ it, ch, path: 'cart' }));
    }
  }
  assert.equal(storefront({ price: 4.25 }, 'delivery', LUNCH), 4.25);
  assert.equal(storefront({ price: 4.25, pricing: { base: null } }, 'delivery', null), 0);   // pricing present, base unset: 0, as the till
  // explicit tier zero is a real price
  assert.equal(storefront(burger({ base: 3.5, menus: { [LUNCH]: { all: 0 } } }), 'delivery', LUNCH), 0);
});

// ── cartUnitPrice (the till's addItem branch) ───────────────────────────────
test('cart: a tier is charged when the active menu is set, at every entry path', () => {
  // Burger base 10.50, lunch tier all 8.50, lunch live on the till.
  const it = burger({ base: 10.5, menus: { [LUNCH]: { all: 8.5 } } });
  assert.equal(cartUnitPrice(it, 'dine-in', LUNCH), 8.5);                       // quick add with no linePrice
  assert.equal(cartUnitPrice(it, 'dine-in', LUNCH, 10.5, 1), 8.5);              // POS quick add passes base
  assert.equal(cartUnitPrice(it, 'dine-in', LUNCH, 21, 2), 8.5);                // base * qty
  assert.equal(cartUnitPrice(it, 'dine-in', LUNCH, 12.5, 1), 8.5 + 2);              // ProductModal: base + 2.00 mod, the mod stacks on the tier
  assert.equal(cartUnitPrice(it, 'dine-in', LUNCH, 25, 2), 8.5 + 2);                // (base + 2.00) * 2
  // no active menu: base is charged, as before
  assert.equal(cartUnitPrice(it, 'dine-in', null), 10.5);
  assert.equal(cartUnitPrice(it, 'dine-in', null, 10.5, 1), 10.5);
  assert.equal(cartUnitPrice(it, 'dine-in', 'menu-1'), 10.5);                   // the old phantom default id never reads a tier
});

test('cart: channel price still applies with no tier, and base == resolved passes the line through', () => {
  const it = burger({ base: 10.5, takeaway: 9 });
  assert.equal(cartUnitPrice(it, 'takeaway', null), 9);
  assert.equal(cartUnitPrice(it, 'takeaway', null, 10.5, 1), 9);               // dumb-base shortcut swapped
  assert.equal(cartUnitPrice(it, 'takeaway', null, 13.5, 1), 9 + 3);              // base + 3.00 mod: the mod stacks on the channel price
  assert.equal(cartUnitPrice(it, 'dine-in', null, 13.5, 1), 13.5);                // base == resolved: line as given
  assert.equal(cartUnitPrice(it, 'dine-in', null, 27, 2), 13.5);
  // no base at all (legacy scalar 0): the line is taken as given
  assert.equal(cartUnitPrice({ price: 0 }, 'dine-in', LUNCH, 5, 1), 5);
  assert.equal(cartUnitPrice({ price: 0 }, 'dine-in', LUNCH), 0);
});

test('cart: a zero base row with a tier or channel price is charged that price, never 0.00', () => {
  // A menu-only item: base 0, Bar tier all 5.00. Quick add passes linePrice base * qty = 0.
  const menuOnly = { id: 'mo', pricing: { base: 0, menus: { [LUNCH]: { all: 5 } } } };
  assert.equal(cartUnitPrice(menuOnly, 'dine-in', LUNCH), 5);
  assert.equal(cartUnitPrice(menuOnly, 'dine-in', LUNCH, 0, 1), 5);              // POS quick add: pricing.base (0) * 1
  assert.equal(cartUnitPrice(menuOnly, 'dine-in', LUNCH, 0, 3), 5);              // a size pick with no mods: 0 * qty
  assert.equal(cartUnitPrice(menuOnly, 'dine-in', LUNCH, 0.5, 1), 5.5);          // (0 + 0.50 mod) * 1: the mod stacks on the tier
  assert.equal(cartUnitPrice(menuOnly, 'dine-in', null), 0);                     // no tier live: the row really is 0
  // A child with base 0 and a takeaway price
  const child = { id: 'tk', parent_id: 'p', pricing: { base: 0, takeaway: 3 } };
  assert.equal(cartUnitPrice(child, 'takeaway', null, 0, 2), 3);
  assert.equal(cartUnitPrice(child, 'dine-in', null, 0, 2), 0);
});

test('cart: an explicit tier of 0 is a real price, and a surcharge on it is charged as the surcharge alone', () => {
  const free = burger({ base: 10.5, menus: { [LUNCH]: { all: 0 } } });
  assert.equal(cartUnitPrice(free, 'dine-in', LUNCH), 0);
  assert.equal(cartUnitPrice(free, 'dine-in', LUNCH, 10.5, 1), 0);               // quick add passes base
  assert.equal(cartUnitPrice(free, 'dine-in', LUNCH, 12.5, 1), 2);               // base + 2.00 mod: the item is free, the mod is not
});

// The store's original addItem price branch (copied verbatim from
// src/store/index.js before it moved here). It scaled a modifier-laden line by
// resolved / base and never swapped a zero base, so it is kept only to prove
// that the new rule agrees with it wherever base == resolved (no tier, no
// channel price): the common case on the till is unchanged.
function legacyAddItemPrice(item, orderType, menuId, linePrice, qty) {
  const _channelPrice = Number(legacyStoreGetItemPrice(item, orderType, menuId)) || 0;
  let price;
  const _basePrice = item?.pricing?.base ?? item?.price ?? 0;
  if (linePrice == null) {
    price = _channelPrice;
  } else if (_basePrice && Math.abs(linePrice / qty - _basePrice) < 0.001) {
    price = _channelPrice;
  } else if (_basePrice && _channelPrice && _basePrice !== _channelPrice) {
    const ratio = _channelPrice / _basePrice;
    price = (linePrice / qty) * ratio;
  } else {
    price = linePrice / qty;
  }
  return price;
}

test('cart rule over an input grid: resolved price, shortcut swap, surcharge preserved, legacy agrees when base == resolved', () => {
  const items = [];
  for (const base of [undefined, 0, 10.5]) for (const takeaway of [undefined, null, 0, 9])
    for (const tierAll of [undefined, null, 0, 8.5]) for (const withMenus of [false, true]) {
      const pricing = { base, takeaway, dineIn: null };
      if (withMenus) pricing.menus = { [LUNCH]: { all: tierAll } };
      items.push({ price: 4.25, pricing });
    }
  items.push({ price: 4.25 }, { price: 0 }, {});
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  let checked = 0;
  for (const item of items) for (const ch of ['dine-in', 'takeaway']) for (const menuId of [null, LUNCH, 'menu-1']) {
    const resolved = resolveItemPrice(item, ch, menuId);
    const base = Number(item?.pricing?.base ?? item?.price ?? 0) || 0;
    const tag = JSON.stringify({ item, ch, menuId });
    // no linePrice: the resolved price
    assert.equal(cartUnitPrice(item, ch, menuId), resolved, tag);
    for (const qty of [1, 2, 3]) {
      // the quick add shortcut (base * qty) is swapped for the resolved price, base 0 included
      assert.ok(close(cartUnitPrice(item, ch, menuId, base * qty, qty), resolved), `${tag} shortcut qty ${qty}`);
      // a surcharge stacked on base by the caller is charged on top of the resolved price, unscaled
      for (const s of [0.5, 2, 4.25]) {
        assert.ok(close(cartUnitPrice(item, ch, menuId, (base + s) * qty, qty), resolved + s), `${tag} surcharge ${s} qty ${qty}`);
      }
      // where base == resolved the old branch gives the same answer at every entry path
      if (base === resolved) {
        for (const linePrice of [null, base * qty, (base + 2) * qty, 5 * qty]) {
          assert.ok(close(cartUnitPrice(item, ch, menuId, linePrice, qty), legacyAddItemPrice(item, ch, menuId, linePrice, qty)), `${tag} legacy ${linePrice} qty ${qty}`);
        }
      }
      checked++;
    }
  }
  assert.ok(checked > 1000, `grid too small: ${checked}`);
});

// ── size variants: variantChildren + variantFromPrice ───────────────────────
// Live example at Provo: parent Heineken base 0; child Half base 2.85, takeaway
// 3.01, collection 3.02, Bar menu tier all 1.23; child Pint base 3.85.
import { variantChildren, variantFromPrice, planCartLine } from './menuPricing.js';

const BAR = 'menu-1786127970008';
const heineken = { id: 'hk', name: 'Heineken', type: 'variants', price: 0, pricing: { base: 0 } };
const half = { id: 'hk-half', name: 'Half', parent_id: 'hk', sort_order: 0, price: 2.85,
  pricing: { base: 2.85, takeaway: 3.01, collection: 3.02, menus: { [BAR]: { all: 1.23 } } } };
const pint = { id: 'hk-pint', name: 'Pint', parent_id: 'hk', sort_order: 1, price: 3.85,
  pricing: { base: 3.85 } };
const lager = { id: 'lg', name: 'Lager', price: 4.5, pricing: { base: 4.5 } };
const gone = { id: 'hk-old', name: 'Schooner', parent_id: 'hk', sort_order: 2, archived: true, pricing: { base: 0.5 } };
const ALL = [heineken, pint, half, lager, gone];

test('variantChildren: live children of the parent in sort order, archived rows dropped', () => {
  assert.deepEqual(variantChildren(heineken, ALL).map(c => c.id), ['hk-half', 'hk-pint']);
  assert.deepEqual(variantChildren(lager, ALL), []);
  assert.deepEqual(variantChildren(null, ALL), []);
  assert.deepEqual(variantChildren(heineken, null), []);
});

test('variantFromPrice: cheapest size for the live channel, dine in and no menu', () => {
  assert.equal(variantFromPrice(heineken, ALL, 'dineIn', null), 2.85);
  assert.equal(resolveItemPrice(half, 'dineIn', null), 2.85);
  assert.equal(resolveItemPrice(pint, 'dineIn', null), 3.85);
});

test('variantFromPrice: Bar menu active, Half reads its 1.23 tier and Pint keeps base', () => {
  assert.equal(variantFromPrice(heineken, ALL, 'dineIn', BAR), 1.23);
  assert.equal(resolveItemPrice(half, 'dineIn', BAR), 1.23);
  assert.equal(resolveItemPrice(pint, 'dineIn', BAR), 3.85);
});

test('variantFromPrice: takeaway channel reads the child takeaway price', () => {
  assert.equal(variantFromPrice(heineken, ALL, 'takeaway', null), 3.01);
  assert.equal(variantFromPrice(heineken, ALL, 'collection', null), 3.02);
  // a Bar tier of all still wins on takeaway, exactly as the till charges it
  assert.equal(variantFromPrice(heineken, ALL, 'takeaway', BAR), 1.23);
});

test('variantFromPrice: sizes at 0 are ignored for the minimum, all unpriced gives 0, no sizes gives null', () => {
  const free = { id: 'hk-taster', parent_id: 'hk', pricing: { base: 0 } };
  assert.equal(variantFromPrice(heineken, [...ALL, free], 'dineIn', null), 2.85);
  const zeroParent = { id: 'zp', type: 'variants' };
  const zeroKids = [{ id: 'z1', parent_id: 'zp', pricing: { base: 0 } }, { id: 'z2', parent_id: 'zp', price: 0 }];
  assert.equal(variantFromPrice(zeroParent, zeroKids, 'dineIn', null), 0);
  assert.equal(variantFromPrice(lager, ALL, 'dineIn', null), null);
  assert.equal(variantFromPrice({ id: 'lonely', type: 'variants' }, ALL, 'dineIn', null), null);
});

test('variantFromPrice: parent with children but no type flag still counts as a variant parent', () => {
  const untyped = { id: 'ut', price: 0 };
  const kids = [{ id: 'ut-s', parent_id: 'ut', pricing: { base: 2 } }, { id: 'ut-l', parent_id: 'ut', pricing: { base: 3 } }];
  assert.equal(variantFromPrice(untyped, kids, 'dineIn', null), 2);
});

// ── MPOS: store rows are camel (parentId, sortOrder) ────────────────────────
// SyncBridge and useSupabaseInit spread the raw row and add parentId, so a store
// row carries both spellings; a row created in Back Office carries only camel.
test('variantChildren: camel store rows (parentId, sortOrder) are read like snake ones', () => {
  const camelHalf = { id: 'c-half', parentId: 'hk', sortOrder: 1, pricing: { base: 2.85, menus: { [BAR]: { all: 1.23 } } } };
  const camelPint = { id: 'c-pint', parentId: 'hk', sortOrder: 0, pricing: { base: 3.85 } };
  const camelGone = { id: 'c-old', parentId: 'hk', sortOrder: 2, archived: true, pricing: { base: 0.5 } };
  const rows = [heineken, camelHalf, lager, camelPint, camelGone];
  assert.deepEqual(variantChildren(heineken, rows).map(c => c.id), ['c-pint', 'c-half']);
  assert.equal(variantFromPrice(heineken, rows, 'dineIn', null), 2.85);
  assert.equal(variantFromPrice(heineken, rows, 'dineIn', BAR), 1.23);
  // a mixed list (kiosk snake rows next to store camel rows) still finds every child
  assert.deepEqual(variantChildren(heineken, [half, camelPint]).map(c => c.id).sort(), ['c-pint', 'hk-half']);
});

// ── MPOS add path: planCartLine ─────────────────────────────────────────────
// The unit price it reports MUST equal what store.addItem charges for the same
// linePrice, because addItem runs the very same cartUnitPrice branch.
const chargedByAddItem = (item, channel, menuId, plan, qty) => cartUnitPrice(item, channel, menuId, plan.linePrice, qty);

test('planCartLine: no surcharge passes nothing and charges the resolved price (tier, channel, base)', () => {
  const noMods = planCartLine(half, 'dine-in', null);
  assert.equal(noMods.linePrice, null);
  assert.equal(noMods.unitPrice, 2.85);
  assert.equal(noMods.lineTotal, 2.85);
  const bar = planCartLine(half, 'dine-in', BAR, { qty: 2 });
  assert.equal(bar.linePrice, null);
  assert.equal(bar.unitPrice, 1.23);
  assert.equal(bar.lineTotal, 2.46);
  assert.equal(planCartLine(half, 'takeaway', null).unitPrice, 3.01);
  assert.equal(planCartLine(half, 'collection', null).unitPrice, 3.02);
  assert.equal(planCartLine(pint, 'dine-in', BAR).unitPrice, 3.85);
  for (const [ch, menu] of [['dine-in', null], ['dine-in', BAR], ['takeaway', null], ['collection', BAR]]) {
    const plan = planCartLine(half, ch, menu, { qty: 3 });
    assert.equal(chargedByAddItem(half, ch, menu, plan, 3), plan.unitPrice, `${ch} ${menu}`);
  }
});

test('planCartLine: a surcharge takes the till shape, (base + surcharge) * qty, and the cart charges what the button showed', () => {
  // Half with a 0.50 mod, qty 2, no tier: base == resolved, so the line passes through as 3.35 each.
  const plain = planCartLine(half, 'dine-in', null, { modSurcharge: 0.5, qty: 2 });
  assert.equal(plain.linePrice, 6.7);
  assert.equal(plain.unitPrice, 3.35);
  assert.equal(plain.lineTotal, 6.7);
  // Bar tier live: the 0.50 mod stacks on the 1.23 tier, 1.73 each, the number
  // the kiosk and online charge for the same size, tier and mod. (The old rule
  // scaled the whole line by 1.23 / 2.85 and charged 1.45.)
  const bar = planCartLine(half, 'dine-in', BAR, { modSurcharge: 0.5, qty: 2 });
  assert.equal(bar.linePrice, 6.7);
  assert.ok(Math.abs(bar.unitPrice - 1.73) < 1e-9);
  assert.ok(Math.abs(bar.lineTotal - 3.46) < 1e-9);
  // takeaway channel price: 3.01 + 0.50 = 3.51, not 3.54
  const tk = planCartLine(half, 'takeaway', null, { modSurcharge: 0.5 });
  assert.ok(Math.abs(tk.unitPrice - 3.51) < 1e-9);
  for (const [ch, menu] of [['dine-in', null], ['dine-in', BAR], ['takeaway', null]]) {
    const plan = planCartLine(half, ch, menu, { modSurcharge: 0.5, qty: 2 });
    assert.equal(chargedByAddItem(half, ch, menu, plan, 2), plan.unitPrice, `${ch} ${menu}`);
  }
});

test('planCartLine: a zero base row keeps its tier under a surcharge (the till shape, base 0 + surcharge)', () => {
  const zeroBase = { id: 'zb', pricing: { base: 0, menus: { [BAR]: { all: 1.23 } } } };
  const plan = planCartLine(zeroBase, 'dine-in', BAR, { modSurcharge: 0.5 });
  assert.equal(plan.linePrice, 0.5);
  assert.equal(plan.unitPrice, 1.73);
  assert.equal(chargedByAddItem(zeroBase, 'dine-in', BAR, plan, 1), 1.73);
  // and the till's own InlineItemFlow passes the same (0 + 0.50) * qty shape for this row
  assert.equal(cartUnitPrice(zeroBase, 'dine-in', BAR, 0.5 * 2, 2), 1.73);
  // and with no surcharge the tier is charged as-is
  assert.equal(planCartLine(zeroBase, 'dine-in', BAR).unitPrice, 1.23);
  // legacy scalar row, no pricing object
  const legacy = { id: 'lg', price: 4.25 };
  assert.equal(planCartLine(legacy, 'takeaway', BAR).unitPrice, 4.25);
  assert.equal(planCartLine(legacy, 'takeaway', BAR, { modSurcharge: 1 }).unitPrice, 5.25);
});


// ── Variant children with tiers: the Provo Heineken example on every surface ─
// Parent Heineken (type 'variants') base 0. Child Half base 2.85, takeaway
// 3.01, collection 3.02, Bar menu tier all 1.23. Child Pint base 3.85, no
// tiers. Every surface prices a size by running resolveItemPrice on the CHILD
// for its own channel and the active menu, so this table is what the till,
// kiosk, phone, online and QR must all show and charge.
const PROVO = {
  // [channel]: { noMenu: [half, pint], bar: [half, pint] }
  dineIn:     { noMenu: [2.85, 3.85], bar: [1.23, 3.85] },
  takeaway:   { noMenu: [3.01, 3.85], bar: [1.23, 3.85] },
  collection: { noMenu: [3.02, 3.85], bar: [1.23, 3.85] },
  delivery:   { noMenu: [2.85, 3.85], bar: [1.23, 3.85] },   // no delivery price on Half: base
};
const ALIASES = { dineIn: ['dineIn', 'dine-in', 'dine_in'], takeaway: ['takeaway'], collection: ['collection'], delivery: ['delivery'] };

test('Provo Heineken: Half and Pint on all four channels, with and without the Bar tier', () => {
  for (const [channel, want] of Object.entries(PROVO)) {
    for (const alias of ALIASES[channel]) {
      assert.equal(resolveItemPrice(half, alias, null), want.noMenu[0], `Half ${alias} no menu`);
      assert.equal(resolveItemPrice(pint, alias, null), want.noMenu[1], `Pint ${alias} no menu`);
      assert.equal(resolveItemPrice(half, alias, BAR), want.bar[0], `Half ${alias} Bar`);
      assert.equal(resolveItemPrice(pint, alias, BAR), want.bar[1], `Pint ${alias} Bar`);
      // a menu with no tier on these rows prices like no menu
      assert.equal(resolveItemPrice(half, alias, 'menu-lunch'), want.noMenu[0], `Half ${alias} other menu`);
      assert.equal(resolveItemPrice(pint, alias, 'menu-lunch'), want.noMenu[1], `Pint ${alias} other menu`);
      // the parent is never a price: base 0 on every channel and menu
      assert.equal(resolveItemPrice(heineken, alias, null), 0);
      assert.equal(resolveItemPrice(heineken, alias, BAR), 0);
    }
  }
});

test('Provo Heineken: the "from" price follows the same table', () => {
  for (const [channel, want] of Object.entries(PROVO)) {
    assert.equal(variantFromPrice(heineken, ALL, channel, null), Math.min(...want.noMenu), `${channel} no menu`);
    assert.equal(variantFromPrice(heineken, ALL, channel, BAR), Math.min(...want.bar), `${channel} Bar`);
  }
});

test('Provo Heineken: online collection charges 3.02 with no tier and 1.23 under the Bar tier, QR dine-in 2.85 / 1.23', () => {
  // OnlineSurface.priceFor = resolveItemPrice(item, orderType, effectiveMenuId); addToCart writes it as l.price.
  const onlinePriceFor = (orderType, menuId) => (it) => resolveItemPrice(it, orderType, menuId);
  assert.equal(onlinePriceFor('collection', null)(half), 3.02);
  assert.equal(onlinePriceFor('collection', BAR)(half), 1.23);
  assert.equal(onlinePriceFor('collection', null)(pint), 3.85);
  assert.equal(onlinePriceFor('collection', BAR)(pint), 3.85);
  assert.equal(onlinePriceFor('delivery', null)(half), 2.85);
  assert.equal(onlinePriceFor('delivery', BAR)(half), 1.23);
  assert.equal(onlinePriceFor('dine-in', null)(half), 2.85);   // QR at a table
  assert.equal(onlinePriceFor('dine-in', BAR)(half), 1.23);
  // the card's "from" for the parent through the same priceFor (OnlineSurface.variantInfo)
  const from = (priceFor) => { const ps = [half, pint].map(priceFor).filter(p => p > 0); return Math.min(...ps); };
  assert.equal(from(onlinePriceFor('collection', null)), 3.02);
  assert.equal(from(onlinePriceFor('collection', BAR)), 1.23);
});

test('Provo Heineken: the till cart charges the same numbers at every entry path', () => {
  for (const [channel, want] of Object.entries(PROVO)) {
    for (const [menu, idx] of [[null, 'noMenu'], [BAR, 'bar']]) {
      const [h, p] = want[idx];
      assert.equal(cartUnitPrice(half, channel, menu), h, `Half ${channel} ${menu} quick add`);
      assert.equal(cartUnitPrice(half, channel, menu, 2.85, 1), h, `Half ${channel} ${menu} base passed`);
      assert.equal(cartUnitPrice(half, channel, menu, 5.7, 2), h, `Half ${channel} ${menu} base * 2`);
      assert.equal(cartUnitPrice(pint, channel, menu), p, `Pint ${channel} ${menu}`);
      assert.equal(planCartLine(half, channel, menu).unitPrice, h, `Half ${channel} ${menu} phone`);
      assert.equal(planCartLine(pint, channel, menu, { qty: 2 }).lineTotal, p * 2, `Pint ${channel} ${menu} phone`);
    }
  }
  // the board (a dine-in display) reads the dineIn column of the table
  assert.equal(resolveBoardPrice(half, null), 2.85);
  assert.equal(resolveBoardPrice(half, BAR), 1.23);
  assert.equal(resolveBoardPrice(pint, BAR), 3.85);
});

test('Provo Heineken: a tier on the parent never leaks to a child, and a child tier never leaks to its sibling', () => {
  const tieredParent = { ...heineken, pricing: { base: 0, menus: { [BAR]: { all: 9.99 } } } };
  assert.equal(resolveItemPrice(tieredParent, 'dineIn', BAR), 9.99);   // the parent row itself
  assert.equal(resolveItemPrice(half, 'dineIn', BAR), 1.23);           // children carry their own tiers
  assert.equal(resolveItemPrice(pint, 'dineIn', BAR), 3.85);
  assert.equal(variantFromPrice(tieredParent, [half, pint], 'dineIn', BAR), 1.23);
  // Bar tier with a channel field and a base field on Half: channel > all > base
  const halfFull = { ...half, pricing: { ...half.pricing, menus: { [BAR]: { takeaway: 1.5, all: 1.23, base: 1.1 } } } };
  assert.equal(resolveItemPrice(halfFull, 'takeaway', BAR), 1.5);
  assert.equal(resolveItemPrice(halfFull, 'collection', BAR), 1.23);
  const halfBaseOnly = { ...half, pricing: { ...half.pricing, menus: { [BAR]: { base: 1.1 } } } };
  assert.equal(resolveItemPrice(halfBaseOnly, 'collection', BAR), 1.1);
  assert.equal(resolveItemPrice(halfBaseOnly, 'collection', null), 3.02);
});

// ── storefront reprice: repriceCartLines (OnlineSurface) ────────────────────
// Online cart lines snapshot l.price at add time and keep modifiers in l.mods
// with their own prices. When the order type or the timed menu changes the
// surface maps the cart through this helper, the till's setOrderType reprice
// for a cart outside the store.
test('repriceCartLines: Half added at collection 3.02 reprices to delivery 2.85 and to the Bar tier 1.23', () => {
  const cart = [
    { uid: 'a', itemId: 'hk-half', name: 'Heineken Half', price: 3.02, qty: 2, mods: [{ label: 'Lime', price: 0.5 }] },
    { uid: 'b', itemId: 'hk-pint', name: 'Heineken Pint', price: 3.85, qty: 1, mods: [] },
  ];
  const toDelivery = repriceCartLines(cart, ALL, 'delivery', null);
  assert.equal(toDelivery[0].price, 2.85);
  assert.equal(toDelivery[1].price, 3.85);
  assert.deepEqual(toDelivery[0].mods, [{ label: 'Lime', price: 0.5 }]);   // mods untouched
  assert.equal(toDelivery[0].qty, 2);
  const toBar = repriceCartLines(cart, ALL, 'delivery', BAR);
  assert.equal(toBar[0].price, 1.23);
  assert.equal(toBar[1].price, 3.85);
  const qr = repriceCartLines(cart, ALL, 'dine-in', null);
  assert.equal(qr[0].price, 2.85);
  const back = repriceCartLines(toBar, ALL, 'collection', null);
  assert.equal(back[0].price, 3.02);
});

test('repriceCartLines: a line whose item is no longer in items is left unchanged, and untouched lines keep identity', () => {
  const orphan = { uid: 'x', itemId: 'gone-forever', price: 9.99, qty: 1, mods: [] };
  const same = { uid: 'y', itemId: 'hk-pint', price: 3.85, qty: 1, mods: [] };
  const out = repriceCartLines([orphan, same], ALL, 'delivery', BAR);
  assert.equal(out[0], orphan);
  assert.equal(out[1], same);
  assert.deepEqual(repriceCartLines([], ALL, 'delivery', null), []);
  assert.deepEqual(repriceCartLines(null, ALL, 'delivery', null), []);
  assert.equal(repriceCartLines([orphan], null, 'delivery', null)[0], orphan);
});
