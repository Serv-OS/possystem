// The menu item detail sheet's model (blocks/itemSheet.js): what the sheet shows for an item, and
// where its order button goes. Pure, so it runs here without React DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemSheetModel, isActivationKey, orderGoesDirect, venuePageLocation } from './blocks/itemSheet.js';
import { menuLocation } from './resolveHref.js';

const LEEDS = { id: 'loc-leeds', name: 'Mozz Pizza Leeds', online_slug: 'mozz-leeds', ops_location_id: 'ops-leeds' };
const HUDDS = { id: 'loc-hudds', name: 'Mozz Pizza Huddersfield', online_slug: 'mozz-huddersfield', ops_location_id: 'ops-hudds' };
const multi = (extra = {}) => ({
  customerRoot: 'serv-os.app', path: '/menu', settings: { default_location_id: 'loc-leeds' },
  pages: [{ id: 'p-home', slug: '' }, { id: 'p-menu', slug: 'menu' }, { id: 'p-leeds', slug: 'leeds', kind: 'location', location_id: 'loc-leeds' }],
  locations: [LEEDS, HUDDS], menuVenue: null, ...extra,
});
const single = (extra = {}) => ({ ...multi(), locations: [LEEDS], ...extra });
const ITEM = { id: 'i1', name: 'Margherita', description: 'Tomato and mozzarella', price: 9.5, currency: 'GBP', image: 'https://x/m.jpg', dietary: ['V', 'GF'], allergens: ['gluten', 'milk'], sold_out: false, from: false };

test('itemSheetModel: the words, badges, allergens, price and photo of an item', () => {
  const ctx = single();
  const m = itemSheetModel(ITEM, { ctx, loc: menuLocation(ctx, 'default') });
  assert.equal(m.title, 'Margherita');
  assert.equal(m.description, 'Tomato and mozzarella');
  assert.equal(m.priceText, '£9.50');
  assert.equal(m.soldOut, false);
  assert.deepEqual(m.badges, [{ code: 'V', label: 'Vegetarian' }, { code: 'GF', label: 'Gluten free' }]);
  assert.equal(m.allergenText, 'Contains: gluten, milk');
  assert.equal(m.image, 'https://x/m.jpg');
});

test('itemSheetModel: "from" prices, USD, sold out, and a missing field renders nothing (never throws)', () => {
  const ctx = single();
  const loc = menuLocation(ctx, 'default');
  assert.equal(itemSheetModel({ ...ITEM, from: true }, { ctx, loc }).priceText, 'from £9.50');
  assert.equal(itemSheetModel({ ...ITEM, currency: 'USD', price: 12 }, { ctx, loc }).priceText, '$12.00');
  const sold = itemSheetModel({ ...ITEM, sold_out: true }, { ctx, loc });
  assert.equal(sold.soldOut, true);
  assert.equal(sold.orderHref, '', 'a sold out item has no order button');
  assert.equal(sold.orderLabel, '');
  const bare = itemSheetModel({ id: 'x' }, { ctx, loc });
  assert.deepEqual(bare, { title: '', description: '', priceText: '', soldOut: false, badges: [], allergenText: '', orderHref: 'https://mozz-leeds.serv-os.app/', orderLabel: 'Order at Mozz Pizza Leeds', image: '' });
  assert.deepEqual(itemSheetModel(null, {}), { title: '', description: '', priceText: '', soldOut: false, badges: [], allergenText: '', orderHref: '', orderLabel: '', image: '' });
  assert.deepEqual(itemSheetModel({ ...ITEM, price: 'free', dietary: 'V', allergens: null, image: 7 }, {}).badges, []);
  assert.equal(itemSheetModel(ITEM).priceText, '£9.50', 'no options at all');
  assert.equal(itemSheetModel({ ...ITEM, dietary: ['XX'] }, {}).badges[0].label, 'XX', 'an unknown badge keeps its code as the label');
});

test('order button: straight to the venue on a one venue site, a pinned block, a picked venue or a venue page', () => {
  const one = single();
  const a = itemSheetModel(ITEM, { ctx: one, loc: menuLocation(one, 'default') });
  assert.equal(a.orderHref, 'https://mozz-leeds.serv-os.app/');
  assert.equal(a.orderLabel, 'Order at Mozz Pizza Leeds');

  const pinned = multi();
  const b = itemSheetModel(ITEM, { ctx: pinned, loc: menuLocation(pinned, 'loc-hudds'), locationId: 'loc-hudds' });
  assert.equal(b.orderHref, 'https://mozz-huddersfield.serv-os.app/');
  assert.equal(b.orderLabel, 'Order at Mozz Pizza Huddersfield');

  const picked = multi({ menuVenue: 'mozz-huddersfield' });
  const c = itemSheetModel(ITEM, { ctx: picked, loc: menuLocation(picked, 'default'), menuVenue: 'mozz-huddersfield', locationId: 'default' });
  assert.equal(c.orderHref, 'https://mozz-huddersfield.serv-os.app/', 'the picked venue, not the default');
  assert.equal(c.orderLabel, 'Order at Mozz Pizza Huddersfield');

  const synthPage = multi({ path: '/locations/mozz-leeds' });
  const d = itemSheetModel(ITEM, { ctx: synthPage, loc: menuLocation(synthPage, 'default'), locationId: 'default' });
  assert.equal(d.orderHref, 'https://mozz-leeds.serv-os.app/');
  assert.equal(d.orderLabel, 'Order at Mozz Pizza Leeds');
  const madePage = multi({ path: '/leeds' });
  assert.equal(itemSheetModel(ITEM, { ctx: madePage, loc: menuLocation(madePage, 'default') }).orderLabel, 'Order at Mozz Pizza Leeds', 'a designer made location page');
});

test('order button: a group site with no venue picked goes to the choose your venue page and reads "Order"', () => {
  const ctx = multi();
  const m = itemSheetModel(ITEM, { ctx, loc: menuLocation(ctx, 'default'), locationId: 'default' });
  assert.equal(m.orderHref, '/order');
  assert.equal(m.orderLabel, 'Order');
  const nonsense = multi({ menuVenue: 'not-a-venue' });
  assert.equal(itemSheetModel(ITEM, { ctx: nonsense, loc: menuLocation(nonsense, 'default'), menuVenue: 'not-a-venue' }).orderHref, '/order', 'an unknown pick is no pick');
  const noVenue = { ...multi(), locations: [] };
  const none = itemSheetModel(ITEM, { ctx: noVenue, loc: null });
  assert.equal(none.orderHref, '', 'no venue at all: no button');
  assert.equal(none.orderLabel, '');
  const noName = single({ locations: [{ ...LEEDS, name: '' }] });
  assert.equal(itemSheetModel(ITEM, { ctx: noName, loc: menuLocation(noName, 'default') }).orderLabel, 'Order at mozz-leeds', 'a venue without a name shows its slug');
});

test('orderGoesDirect and venuePageLocation helpers', () => {
  assert.equal(orderGoesDirect(null), false);
  assert.equal(orderGoesDirect(single()), true);
  assert.equal(orderGoesDirect(multi()), false);
  assert.equal(orderGoesDirect(multi(), { locationId: 'loc-leeds' }), true);
  assert.equal(orderGoesDirect(multi(), { locationId: 'all' }), false);
  assert.equal(orderGoesDirect(multi({ menuVenue: 'MOZZ-LEEDS' }), {}), true, 'case does not matter');
  assert.equal(orderGoesDirect(multi(), { menuVenue: 'loc-hudds' }), true, 'an id names a venue too');
  assert.equal(venuePageLocation(multi({ path: '/locations/mozz-huddersfield' })).id, 'loc-hudds');
  assert.equal(venuePageLocation(multi({ path: '/locations/nowhere' })), null);
  assert.equal(venuePageLocation(multi({ path: '/leeds' })).id, 'loc-leeds');
  assert.equal(venuePageLocation(multi({ path: '/menu' })), null);
  assert.equal(venuePageLocation(null), null);
});

test('isActivationKey: Enter and Space open, anything else does not', () => {
  assert.equal(isActivationKey({ key: 'Enter' }), true);
  assert.equal(isActivationKey({ key: ' ' }), true);
  assert.equal(isActivationKey({ key: 'Spacebar' }), true);
  assert.equal(isActivationKey({ key: 'Tab' }), false);
  assert.equal(isActivationKey({ key: 'Escape' }), false);
  assert.equal(isActivationKey(null), false);
  assert.equal(isActivationKey({}), false);
});
