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
import { posUnit, posLine } from './pos.js';
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
  assert.match(readRepo('supabase/functions/hubrise-catalog-push/index.ts'), /channel: 'delivery'/);
});
