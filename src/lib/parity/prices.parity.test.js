// prices.parity.test.js: every channel charges the till's price for the same item (v5.11.78).
// Run: node --test src/lib/parity/prices.parity.test.js
//
// The POS reference is pos.js (the till's own code). Each channel's figure comes from the code
// that channel runs. Rules that live inside a screen are checked by the exact call the screen
// makes (src.js). New shared modules are imported inside the test that needs them, so on a branch
// without them (origin/main) exactly those tests fail and the rest still run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU, STORE_MENU, raw, storeRow, extraOf } from './fixtures.js';
import { posUnit, posLine, posLines } from './pos.js';
import { resolveItemPrice, planCartLine, repriceCartLines } from '../menuPricing.js';
import { packageItemsFor } from '../bookings/packagePricing.js';
import { choicePriceFor } from '../bookings/guestChoicePricing.js';
import { readRepo, between } from './src.js';

const ITEMS = ['latte', 'beer-half', 'beer-pint', 'baby-l', 'toastie', 'sarnie', 'shot', 'platter'];
const MENUS = [null, 'lunch', 'bar'];

// ── The channels that already priced like the till (regression guards) ─────────────────────────
test('kiosk, online, QR and MPOS: the unit price is the till\'s for every item, order type and menu', () => {
  const lanes = [['dine-in', 'dineIn'], ['takeaway', 'takeaway'], ['collection', 'collection'], ['delivery', 'delivery'], ['drive-thru', 'drive-thru']];
  for (const id of ITEMS) for (const m of MENUS) for (const [till, other] of lanes) {
    const pos = posUnit(id, till, m);
    assert.equal(resolveItemPrice(raw(id), other, m), pos, `${id} ${till} ${m}: kiosk/online/QR read the raw row`);
    assert.equal(planCartLine(storeRow(id), till, m).unitPrice, pos, `${id} ${till} ${m}: MPOS`);
  }
});

test('an option surcharge stacks on the resolved price on every channel (0.50 oat on a 1.23 Half is 1.73)', () => {
  const half = storeRow('beer-half');
  const pos = posLine({ orderType: 'dine-in', menuId: 'bar' }, { itemId: 'beer-half', qty: 1, opts: ['o-oat'] }).price;
  assert.equal(+pos.toFixed(2), 1.73);
  assert.equal(+planCartLine(half, 'dine-in', 'bar', { modSurcharge: 0.5 }).unitPrice.toFixed(2), 1.73, 'MPOS');
  assert.equal(+(resolveItemPrice(raw('beer-half'), 'dineIn', 'bar') + 0.5).toFixed(2), 1.73, 'kiosk, online, QR: size price plus option');
});

// ── Bar tabs (confirmed major: charged base only) ────────────────────────────────────────────────
test('bar tab: every round line is priced exactly as the counter rings eat in (tiers, eat in prices, menu only items, options)', async () => {
  const { tillLineUnitPrice } = await import('../tillLine.js');
  for (const id of ITEMS) for (const m of MENUS) for (const opts of [[], ['o-oat']]) {
    const l = { itemId: id, qty: 2, opts };
    const row = storeRow(id);
    const base = Number(row.pricing?.base ?? row.price ?? 0);
    const linePrice = opts.length ? (base + extraOf(l)) * 2 : null;   // InlineItemFlow / ProductModal shape
    const bar = tillLineUnitPrice(row, 'bar-tab', m, linePrice, 2);
    const pos = posLine({ orderType: 'dine-in', menuId: m }, l).price;
    assert.equal(+bar.toFixed(6), +pos.toFixed(6), `${id} on ${m || 'no menu'} ${opts.join('+')}`);
  }
  // The audit's cases: Half on the Bar menu 1.23 (was 2.85), a menu only shot 5.00 (was 0.00).
  assert.equal(tillLineUnitPrice(storeRow('beer-half'), 'bar-tab', 'bar', null, 1), 1.23);
  assert.equal(tillLineUnitPrice(storeRow('shot'), 'bar-tab', 'bar', null, 1), 5);
});

test('bar tab: BarSurface books, shows and resolves its menu through the till\'s own calls', () => {
  const bar = readRepo('src/surfaces/BarSurface.jsx');
  const add = between(bar, 'const addToRound = (item, mods=[], opts={}) => {', 'showToast(`${name} added to round`');
  assert.match(add, /const price = tillLineUnitPrice\(item, 'bar-tab', barMenuId, opts\.linePrice \?\? null, opts\.qty \|\| 1\);/);
  assert.doesNotMatch(add, /item\.price \?\? item\.pricing\?\.base/, 'no base only price');
  assert.match(bar, /const fromPrice = variantFromPrice\(item, storeMenuItems \|\| MENU_ITEMS, 'bar-tab', barMenuId\) \?\? resolveItemPrice\(item, 'bar-tab', barMenuId\);/);
  assert.match(bar, /const barMenuId = useMemo\(\(\) => resolveActiveMenu\(\{\n\s+menus,\n\s+categories: menuCategories,\n\s+links: _categoryLinks,\n\s+pinnedMenuId: deviceConfig\?\.menuId,/);
  assert.match(bar, /if \(_setActiveMenuId\) _setActiveMenuId\(barMenuId\);/, 'the size buttons show the same menu');
});

// ── Catering (confirmed major: priced from base, fulfilment and tiers ignored) ────────────────────
test('bar tab: picking a quantity of a drink already in the round adds that many, as the counter appends a line of that many', async () => {
  const { addToRoundLines } = await import('../tillLine.js');
  const pint = (qty, extra = {}) => ({ uid: `r${qty}`, itemId: 'beer-pint', name: 'Pint', price: 5, qty, mods: [], notes: '', ...extra });
  const charge = (lines) => lines.reduce((s0, l) => s0 + l.price * l.qty, 0);
  // A Pint in the round, then 3 more picked on the quantity stepper (InlineItemFlow): 4 Pints, 20.00.
  const round = addToRoundLines([pint(1)], pint(3));
  assert.equal(round.length, 1);
  assert.equal(round[0].qty, 4);
  // The counter: a line of 1 then a line of 3 (store.addItem always appends), the same money.
  const counter = posLines({ orderType: 'bar-tab', menuId: null, lines: [{ itemId: 'beer-pint', qty: 1 }, { itemId: 'beer-pint', qty: 3 }] });
  assert.equal(charge(round), charge(counter));
  // One tap with no stepper adds one, as before.
  assert.equal(addToRoundLines([pint(1)], pint(1))[0].qty, 2);
  // A note, or another price (a timed menu turned over between taps), stays its own line.
  assert.equal(addToRoundLines([pint(1)], pint(2, { notes: 'no head' })).length, 2);
  assert.equal(addToRoundLines([pint(1, { notes: 'no head' })], pint(2)).length, 2);
  assert.equal(addToRoundLines([pint(1)], pint(2, { price: 4 })).length, 2);
  const prev = [pint(1)];
  addToRoundLines(prev, pint(3));
  assert.equal(prev[0].qty, 1, 'the round it was given is never changed');
  const bar = readRepo('src/surfaces/BarSurface.jsx');
  assert.match(bar, /setRoundItems\(prev => addToRoundLines\(prev, line\)\);/);
  assert.doesNotMatch(bar, /qty:r\.qty\+1/, 'never one whatever the stepper said');
});

test('catering: Collection, Delivery and the catering menu\'s tier are the till\'s and the online page\'s prices', async () => {
  const { cateringMenuIdFor, cateringOrderMenuId } = await import('../cateringPricing.js');
  const one = { menuIds: ['bar'], items: MENU, categories: [] };
  const price = (id, ch, ctx) => resolveItemPrice(raw(id), ch, cateringMenuIdFor(raw(id), ctx));
  // Half: collection 3.02 on the online page and the till (catering charged 2.85).
  assert.equal(price('beer-half', 'collection', { menuIds: [], items: MENU }), posUnit('beer-half', 'collection'));
  assert.equal(price('beer-half', 'collection', { menuIds: [], items: MENU }), 3.02);
  // A 90.00 platter with a 50.00 delivery price: 50 (catering charged 90).
  assert.equal(price('platter', 'delivery', { menuIds: [], items: MENU }), posUnit('platter', 'delivery'));
  assert.equal(price('platter', 'delivery', { menuIds: [], items: MENU }), 50);
  // An item priced only on the catering menu's tier: 5.00 (catering charged 0.00).
  assert.equal(price('shot', 'collection', one), 5);
  assert.equal(cateringOrderMenuId(['bar']), 'bar');
  assert.equal(cateringOrderMenuId(['bar', 'lunch']), null, 'several menus: the server floors without one');
  // Several menus: an item takes its own category's menu (a size its product's).
  const cats = [{ id: 'beer', menu_id: 'bar' }, { id: 'coffee', menu_id: 'lunch' }];
  assert.equal(cateringMenuIdFor(raw('beer-half'), { menuIds: ['bar', 'lunch'], items: MENU, categories: cats }), 'bar');
  assert.equal(cateringMenuIdFor(raw('latte'), { menuIds: ['bar', 'lunch'], items: MENU, categories: cats }), 'lunch');
  assert.equal(cateringMenuIdFor(raw('platter'), { menuIds: ['bar', 'lunch'], items: MENU, categories: cats }), null);
  // Collection <-> Delivery reprices the basket (repriceCartLines with the per row menu).
  const cart = [{ itemId: 'platter', price: 90, qty: 1 }];
  assert.equal(repriceCartLines(cart, MENU, 'delivery', (r) => cateringMenuIdFor(r, { menuIds: [], items: MENU }))[0].price, 50);
});

test('catering: the page charges, shows and sends the till\'s price (CateringSurface, CateringCheckout)', () => {
  const s = readRepo('src/surfaces/catering/CateringSurface.jsx');
  assert.match(s, /const priceFor = \(it\) => resolveItemPrice\(it, priceChannel, menuIdOf\(it\)\);/);
  assert.match(s, /const menuIdOf = \(it\) => cateringMenuIdFor\(it, \{ menuIds: cfg\?\.menu_ids \|\| \[\], items, categories: taxCatRows \}\);/);
  assert.match(between(s, 'const addToCart = (item, mods, qty', 'setCart((c)'), /const price = priceFor\(item\);/);
  assert.match(s, /money\(cardPrice\(item\), cur\)/);
  assert.match(s, /stockLevels=\{stockLevels\} cart=\{cart\} priceFor=\{priceFor\}/);
  assert.match(s, /repriceCartLines\(c, items, priceChannel, menuIdOf\)/);
  assert.doesNotMatch(s, /Number\(item\.pricing\?\.base \?\? item\.price \?\? 0\)/, 'no base only price left');
  const c = readRepo('src/surfaces/catering/CateringCheckout.jsx');
  assert.equal((c.match(/menu_id: menuId \|\| null/g) || []).length, 2, 'pay now and pay later send the menu');
});

test('catering: the server values catering like every other source (migration 20261019a)', () => {
  const sql = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  const fn = between(sql, 'CREATE OR REPLACE FUNCTION public._public_order_value(', '$function$;');
  assert.ok(fn.length > 1000, 'the whole function is replaced');
  assert.match(fn, /v_base {5}boolean := false;/);
  assert.match(fn, /v_menu_id {2}text := nullif\(left\(btrim\(coalesce\(p_menu_id, ''\)\), 80\), ''\);/);
  assert.doesNotMatch(fn, /p_source = 'catering'/);
});

// ── Booking pre orders (confirmed major: base price, menu tier ignored) ──────────────────────────
const depositPkg = {
  id: 'p1', name: 'Dinner', paymentModel: 'deposit', priceUnit: 'per_cover', price: 0,
  lines: [{ id: 'l1', itemId: 'latte', qtyPerCover: 1, course: 1 }, { id: 'l2', itemId: 'beer', isPreorderChoice: true, displayName: 'Beer', course: 1 }],
};

test('booking pre orders: a seated line is the counter\'s eat in price on the menu at the booking time', () => {
  const priceOf = (row) => resolveItemPrice(row, 'dine-in', 'lunch');
  const items = packageItemsFor({ pkg: depositPkg, covers: 1, menuItems: STORE_MENU, preorders: [{ id: 'po1', itemId: 'beer', variantItemId: 'beer-pint', displayName: 'Beer', course: 1 }], priceOf });
  const latte = items.find((i) => i.itemId === 'latte');
  assert.equal(latte.price, posUnit('latte', 'dine-in', 'lunch'), 'the fixed latte under Lunch is 2.50, not its 3.00 base');
  const pint = items.find((i) => i.itemId === 'beer');
  assert.equal(pint.price, posUnit('beer-pint', 'dine-in', 'lunch'), 'the chosen Pint is the counter price');
  assert.equal(pint.variantItemId, 'beer-pint', 'the size rides the line');
});

test('booking guest page: a bigger size shows the difference the till rings on the booking\'s menu', () => {
  const rows = MENU;
  const extra = choicePriceFor('deposit', null, raw('beer'), rows, 'bar')(raw('beer-pint'));
  const till = +(posUnit('beer-pint', 'dine-in', 'bar') - posUnit('beer-half', 'dine-in', 'bar')).toFixed(2);
  assert.equal(extra, till, 'Pint over Half on the Bar menu is 3.77 (5.00 - 1.23), not 2.15 on base');
});

test('booking pre orders: the store prices them on the menu at the booking slot, and keeps them on a table tap', () => {
  const slice = readRepo('src/store/bookingsSlice.js');
  assert.match(slice, /priceOf: \(row\) => resolveItemPrice\(row, 'dine-in', menuId\),/);
  assert.match(slice, /menuId = resolveActiveMenu\(\{\n\s+menus: st\.menus, categories: st\.menuCategories, links: st\.categoryLinks, timezone: tz,/);
  assert.match(slice, /\{ prepayCaptured, at: \{ date: b\.date, time: b\.startTime \} \}/);
  const store = readRepo('src/store/index.js');
  assert.match(between(store, 'setOrderType: t => set(s => {', 'customer: null,'), /if \(it\.fromPreorder\) return it;/, 'a package line keeps its seated price');
  const widget = readRepo('src/surfaces/online/BookingWidget.jsx');
  assert.match(widget, /priceFor=\{choicePriceFor\(model, sheet\.option\.priceOverride, sheet\.row, rows, menu\?\.menuId \|\| null\)\}/);
  assert.match(widget, /useGuestMenu\(opsId, optionItemIds\.length > 0, optionItemIds, \{ date, time, timezone: cfg\?\.timezone \|\| null \}\)/);
});

// ── Allowed differences (a platform prices on its own side), each stated ─────────────────────────
test('allowed: a HubRise or ezCater order is booked at the price the platform charged, never repriced from our menu', () => {
  const hub = readRepo('src/surfaces/OrdersHub.jsx');
  // HubRise: the till's copy of a channel order strips itemId so no rule reprices it; the sale is
  // booked from the queue row (channelMoney.buildChannelCloseFields), the channel's own prices.
  assert.match(hub, /const lock = \{ itemId: null, status: 'sent', fired: true, voided: false \};/);
  // ezCater: line totals are ezCater's (ezcaterCatering.js ezcaterClosedCheck copies them).
  const ez = readRepo('supabase/functions/_shared/ezcaterCatering.js');
  assert.match(ez, /export function ezcaterClosedCheck\(row/);
  // HubRise's catalog carries ONE price per product, the delivery price (hubrise-catalog-push), so a
  // Deliveroo collection order is priced at the delivery price: the platform's rule, not ours.
  // (v5.11.81: the push lives in _shared/hubrise-catalog.ts, shared with the reconcile run.)
  assert.match(readRepo('supabase/functions/_shared/hubrise-catalog.ts'), /channel: 'delivery'/);
  assert.match(readRepo('supabase/functions/hubrise-catalog-push/index.ts'), /import \{ pushCatalog \} from '\.\.\/_shared\/hubrise-catalog\.ts';/);
});

// ── A row with no price set never sells for 0.00 (v5.11.81, confirmed minor) ──────────────────────
test('no price: a row whose base is null, with no price for the order type or menu, is refused on every channel; a real 0.00 and a row priced by its options still sell', async () => {
  const { hasNoSellPrice, refusesNoPriceLine, resolveItemPrice } = await import('../menuPricing.js');
  const tea = { id: 'tea', name: 'Tea', pricing: { base: null } };
  assert.equal(resolveItemPrice(tea, 'takeaway'), 0, 'it resolved to 0.00 on every channel');
  assert.equal(hasNoSellPrice(tea, 'takeaway'), true);
  assert.equal(refusesNoPriceLine(tea, 'takeaway', null, 0), true, 'refused at 0.00');
  assert.equal(refusesNoPriceLine(tea, 'takeaway', null, 1.2), false, 'a paid option prices it: sold');
  assert.equal(hasNoSellPrice({ pricing: { base: 0 } }, 'dine-in'), false, 'tap water at 0.00 is a price');
  assert.equal(hasNoSellPrice({ pricing: { base: null, takeaway: 2 } }, 'takeaway'), false, 'a price for this order type');
  assert.equal(hasNoSellPrice({ pricing: { base: null, takeaway: 2 } }, 'drive-thru'), false, 'drive thru falls to takeaway');
  assert.equal(hasNoSellPrice({ pricing: { base: null, takeaway: 2 } }, 'dine-in'), true);
  assert.equal(hasNoSellPrice({ pricing: { base: null, menus: { bar: { all: 4 } } } }, 'dine-in', 'bar'), false, 'a tier on this menu');
  assert.equal(hasNoSellPrice({ pricing: { base: '' } }, 'dine-in'), true, 'a blank base is no price');
  assert.equal(hasNoSellPrice({ price: 3 }, 'dine-in'), false, 'a legacy row keeps its scalar rule');
  // Every add path refuses the line (till, bar tab, kiosk, online and QR, catering).
  assert.match(readRepo('src/store/index.js'), /if \(refusesNoPriceLine\(item, _currentOrderType, get\(\)\.activeMenuId, price\)\) \{/);
  assert.match(readRepo('src/surfaces/BarSurface.jsx'), /if \(refusesNoPriceLine\(item, 'bar-tab', barMenuId, price\)\)/);
  assert.match(readRepo('src/surfaces/KioskApp.jsx'), /if \(refusesNoPriceLine\(variantItem \|\| item, orderType, activeMenuId, linePrice\)\)/);
  assert.match(readRepo('src/surfaces/online/OnlineSurface.jsx'), /if \(refusesNoPriceLine\(item, priceType, effectiveMenuId, price \+ optionsEach\)\)/);
  assert.match(readRepo('src/surfaces/catering/CateringSurface.jsx'), /if \(refusesNoPriceLine\(item, priceChannel, menuIdOf\(item\), price \+ optionsEach\)\)/);
});

// ── v5.11.81, channel parity round 2: THE LINE KEEPS ITS PRICE when a timed menu flips ───────────
// The rule the till already uses for a placed line (store.setOrderType is its only reprice; a menu
// flip at the minute tick never moves a line). Every channel now follows it: kiosk, online, QR.
// Only switching the order type reprices the open lines, at the menu on now.

test('menu flip: the till keeps a line\'s price; switching the order type is the only reprice (the reference)', () => {
  const store = readRepo('src/store/index.js');
  const pos = readRepo('src/surfaces/POSSurface.jsx');
  // The menu is mirrored into the store and nothing reprices on it.
  assert.match(pos, /if \(_setActiveMenuId\) _setActiveMenuId\(deviceMenuId\);/);
  assert.match(store, /setActiveMenuId: id => set\(\{ activeMenuId: id \}\),/, 'a menu change prices nothing');
  assert.match(between(store, 'setOrderType: t => set(s => {', 'customer: null,'), /const newUnitPrice = fn\(src, t, s\.activeMenuId\);/);
});

test('menu flip: online and QR keep each line\'s price and menu; only Collection / Delivery reprices', async () => {
  const { repriceCartLines, resolveItemPrice } = await import('../menuPricing.js');
  // Half added at Collection on no menu (3.02); at 16:00 the Bar menu (1.23) comes on.
  const half = raw('beer-half');
  const line = { uid: 'a', itemId: 'beer-half', price: resolveItemPrice(half, 'collection', null), qty: 1, mods: [], menuId: null };
  assert.equal(line.price, 3.02);
  // The page no longer calls the reprice on a menu flip, so the line stays 3.02 (as the till's).
  const online = readRepo('src/surfaces/online/OnlineSurface.jsx');
  const effect = between(online, 'const pricedTypeRef = useRef(orderType);', '}, [orderType]);');
  assert.match(effect, /if \(!orderType \|\| pricedTypeRef\.current === orderType\) return;/);
  assert.match(effect, /repriceCartLines\(kept, items, orderType, effectiveMenuId, \{ stampMenu: true \}\)/);
  assert.doesNotMatch(online, /\}, \[orderType, effectiveMenuId, items\]\);/, 'the old reprice on every menu flip is gone');
  // Switching to Delivery reprices at the menu on now and records it on the line.
  const moved = repriceCartLines([line], MENU, 'delivery', 'bar', { stampMenu: true })[0];
  assert.equal(moved.price, 1.23);
  assert.equal(moved.menuId, 'bar');
  // A line already on that price and menu is the same object (React keeps it).
  assert.equal(repriceCartLines([moved], MENU, 'delivery', 'bar', { stampMenu: true })[0], moved);
  // Catering (menu per row, no timed menus) is unchanged: no menu stamped.
  const plain = { uid: 'c', itemId: 'beer-half', price: 3.02, qty: 1, mods: [] };
  assert.equal('menuId' in repriceCartLines([plain], MENU, 'delivery', () => 'bar', { stampMenu: true })[0], false);
  // Each line carries its menu to the server, from the online page and QR (pay now and tab rounds).
  assert.match(between(online, 'setCart(c => [...c, {', '}]);'), /menuId: effectiveMenuId \|\| null,/);
  for (const f of ['src/surfaces/online/OnlineCheckout.jsx', 'src/surfaces/qr/QrCheckout.jsx']) {
    assert.match(readRepo(f), /menuId: l\.menuId \|\| null,/, f);
  }
  // The server values each line on its own menu when it is one of the venue's menus (20261020a).
  const sql = readRepo('supabase/migrations/20261020a_OPS_channel_parity_2.sql');
  const fn = between(sql, 'CREATE OR REPLACE FUNCTION public._public_order_value(', '$function$;');
  assert.match(fn, /v_line_menu := nullif\(left\(btrim\(coalesce\(it ->> 'menuId', ''\)\), 80\), ''\);/);
  assert.match(fn, /if v_line_menu is null or not \(v_line_menu = any\(v_menus\)\) then\s+v_line_menu := v_menu_id;/);
  assert.match(fn, /v_floor := public\._menu_item_floor_minor\(r\.pricing, v_channel, v_base, v_line_menu\);/);
  assert.match(fn, /v_noprice := not public\._menu_item_has_price\(r\.pricing, v_channel, v_line_menu\);/);
});

test('menu flip: the kiosk keeps a line\'s price; a later add at another price is a line of its own (as the till appends)', async () => {
  const { kioskLineSlot } = await import('../channelMenu.js');
  const cart = [{ key: 'k', linePrice: 2.85, qty: 1 }];
  assert.deepEqual(kioskLineSlot(cart, 'k', 2.85), { merge: true, key: 'k' }, 'same price: one line');
  const slot = kioskLineSlot(cart, 'k', 1.23);
  assert.deepEqual(slot, { merge: false, key: 'k@123', baseKey: 'k' }, 'the Bar menu came on: its own line');
  const cart2 = [...cart, { key: slot.key, baseKey: 'k', linePrice: 1.23, qty: 1 }];
  assert.deepEqual(kioskLineSlot(cart2, 'k', 1.23), { merge: true, key: 'k@123' });
  assert.deepEqual(kioskLineSlot(cart2, 'k', 2.85), { merge: true, key: 'k' });
  assert.deepEqual(kioskLineSlot([], 'k', 2.85), { merge: false, key: 'k', baseKey: 'k' });
  // The till's money for the same taps: 2.85 + 1.23, never 2 x 1.23.
  const charged = cart2.reduce((s, l) => s + l.linePrice * l.qty, 0);
  assert.equal(+charged.toFixed(2), 4.08);
  const app = readRepo('src/surfaces/KioskApp.jsx');
  const add = between(app, 'const addToCart = useCallback(', 'resetIdle();');
  assert.match(add, /const slot = kioskLineSlot\(prev, key, linePrice\);/);
  assert.match(add, /\? \{ \.\.\.l, qty: l\.qty \+ qty, lineTotal: \(l\.qty \+ qty\) \* l\.linePrice \}/, 'a merge keeps the line\'s own price');
  assert.doesNotMatch(add, /qty: l\.qty \+ qty, linePrice,/, 'the earlier units are never repriced');
  // The new design's eat in / take away switch still reprices the basket (the till's order type rule).
  assert.match(readRepo('src/surfaces/kiosk/KioskFlowV2.jsx'), /setCart\(c => repriceKioskCart\(c, items, orderType, activeMenuId\)\);/);
  // A split line keeps the allergens noted for its item and picks.
  const { basketAllergens } = await import('../kioskAllergens.js');
  const split = [{ key: 'k@123', baseKey: 'k', name: 'Latte', item: { id: 'latte' }, modsArray: [] }];
  assert.deepEqual(basketAllergens(split, [], new Map([['k', ['milk']]])), [{ id: 'milk', names: ['Latte'] }]);
});

test('online cards: the price shown first is the price charged (never the dine in fallback before the pick)', async () => {
  const { storefrontPriceType } = await import('../channelMenu.js');
  const types = [{ id: 'collection' }, { id: 'delivery' }];
  assert.equal(storefrontPriceType(null, { orderTypes: types }), 'collection');
  assert.equal(storefrontPriceType('delivery', { orderTypes: types }), 'delivery');
  assert.equal(storefrontPriceType(null, { isQr: true }), 'dine-in');
  assert.equal(storefrontPriceType(null, { orderTypes: [] }), 'collection');
  // Half: the card before the pick shows Collection 3.02 (it showed the 2.85 base).
  assert.equal(resolveItemPrice(raw('beer-half'), storefrontPriceType(null, { orderTypes: types }), null), 3.02);
  const online = readRepo('src/surfaces/online/OnlineSurface.jsx');
  assert.match(online, /const priceType = storefrontPriceType\(orderType, \{ isQr, orderTypes: allOrderTypes \}\);/);
  assert.match(online, /const priceFor = \(it\) => resolveItemPrice\(it, priceType, effectiveMenuId\);/);
});
