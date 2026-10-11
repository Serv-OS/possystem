// channelMoney.test.js: the money fields a delivery partner (HubRise) sale books.
// Run: `npm test`, or `node --test src/lib/channelMoney.test.js`.
//
// 8 Oct 2026 (the VAT audit, D4): a line whose ref is not one of our products used to book ZERO
// VAT on purpose; 17 HubRise sales at Provo carried £0 VAT on £692.71. Now it takes the venue
// default rate and the record names the line. A till holding no rates used to book 0.00; now it
// books null (not recorded). The rest of the money model is unchanged and pinned here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelCloseFields, channelOrderTypeForTax, modsTotal, lineGross } from './channelMoney.js';
import { toStoreRate } from './venueTaxRates.js';
import { taxFallbacksOf } from './taxRule.js';

const std = toStoreRate({ id: 'std', name: 'VAT', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'provo' });
const zero = toStoreRate({ id: 'zero', name: 'Zero Rate', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'provo' });
const RATES = [std, zero];
const MENU = [
  { id: 'wings', name: 'Og Wings', taxRateId: 'std', taxOverrides: {} },
  { id: 'slaw', name: 'Slaw', taxRateId: null, taxOverrides: { delivery: 'zero', takeaway: 'zero' } },
];
const order = (items, extra = {}) => ({ channel: 'delivery', total: items.reduce((s, i) => s + lineGross(i), 0), items, customer: { payments: [] }, ...extra });

test('channel service types map onto our order types; collection is takeaway for VAT (as the rule says)', () => {
  assert.equal(channelOrderTypeForTax('collection'), 'takeaway');
  assert.equal(channelOrderTypeForTax('dine-in'), 'dine-in');
  assert.equal(channelOrderTypeForTax('eat_in'), 'dine-in');
  assert.equal(channelOrderTypeForTax('delivery'), 'delivery');
  assert.equal(channelOrderTypeForTax(undefined), 'delivery');
});

test('matched lines follow their own Back Office rule, overrides included', () => {
  const f = buildChannelCloseFields(order([
    { id: 'l1', itemId: 'wings', name: 'Og Wings', price: 19.99, qty: 1, mods: [] },
    { id: 'l2', itemId: 'slaw', name: 'Slaw', price: 6.50, qty: 1, mods: [] },
  ]), { menuItems: MENU, taxRates: RATES });
  assert.equal(f.taxAmount, 3.33);
  assert.equal(f.taxBreakdown.breakdown.find((b) => b.rate.id === 'zero').gross, 6.5, 'the delivery override: zero rated');
  assert.equal('fallbacks' in f.taxBreakdown, false);
  // collected: the same slaw reads its takeaway override through the mapping
  const c = buildChannelCloseFields(order([{ id: 'l2', itemId: 'slaw', name: 'Slaw', price: 6.50, qty: 1, mods: [] }], { channel: 'collection' }), { menuItems: MENU, taxRates: RATES });
  assert.equal(c.taxAmount, 0);
  assert.equal(c.taxBreakdown.taxV2.orderType, 'takeaway');
});

test('a line not on our menu takes the venue default and is named in the record, never silently 0', () => {
  const f = buildChannelCloseFields(order([
    { id: 'l1', itemId: '33', name: 'Double Smash Burger', price: 15.90, qty: 1, mods: [] },
    { id: 'l2', itemId: 'wings', name: 'Og Wings', price: 19.99, qty: 1, mods: [] },
  ]), { menuItems: MENU, taxRates: RATES });
  assert.equal(f.subtotal, 35.89);
  assert.equal(f.taxAmount, 5.98, '35.89 at 20% inside the price, both lines');
  assert.deepEqual(taxFallbacksOf(f.taxBreakdown), [{ source: 'fallback', reason: 'item-not-on-menu', lineId: 'l1', itemId: null, name: 'Double Smash Burger', rateId: '__not_in_menu__' }]);
  assert.equal(f.taxBreakdown.breakdown.length, 1, 'one bucket, the default');
  assert.equal(f.taxBreakdown.breakdown[0].items, 2);
  // the same through a full tax context (what the till passes)
  const g = buildChannelCloseFields(order([{ id: 'l1', itemId: '33', name: 'Mystery', price: 12, qty: 1, mods: [] }]), { menuItems: MENU, taxCtx: { taxRates: RATES } });
  assert.equal(g.taxAmount, 2);
  assert.equal(taxFallbacksOf(g.taxBreakdown).length, 1);
});

test('no tax set up at all: tax_amount null (not recorded), never 0.00', () => {
  const items = [{ id: 'l1', itemId: 'wings', name: 'Og Wings', price: 19.99, qty: 1, mods: [] }];
  for (const opts of [{ menuItems: MENU, taxRates: [] }, { menuItems: MENU }, { menuItems: MENU, taxCtx: { taxRates: [] } }]) {
    const f = buildChannelCloseFields(order(items), opts);
    assert.equal(f.taxAmount, null);
    assert.equal(f.taxBreakdown, null);
  }
});

test('the VAT figure is rounded once with the one rule, and modifiers fold into the line price', () => {
  // 5.85 with a 0.00 modifier list: exactly 0.975 of VAT, half up to 0.98
  const f = buildChannelCloseFields(order([{ id: 'l1', itemId: 'wings', name: 'Og Wings', price: 5.85, qty: 1, mods: [] }]), { menuItems: MENU, taxRates: RATES });
  assert.equal(f.taxAmount, 0.98);
  // a base price with priced modifiers: the line price carries them, each mod is zeroed with its decoded price kept
  const g = buildChannelCloseFields(order([{ id: 'l1', itemId: 'wings', name: 'Og Wings', price: 10, qty: 2, mods: [{ name: 'Sauce', price: 1 }, { name: 'Extra', price: 0.5, qty: 2 }] }]), { menuItems: MENU, taxRates: RATES });
  assert.equal(modsTotal([{ price: 1 }, { price: 0.5, qty: 2 }]), 2);
  assert.equal(g.items[0].price, 12);
  assert.deepEqual(g.items[0].mods.map((m) => [m.price, m._channelPrice]), [[0, 1], [0, 0.5]]);
  assert.equal(g.subtotal, 24);
  assert.equal(g.taxAmount, 4);
  assert.equal(g.taxBreakdown.breakdown[0].items, 1);
});

test('the paid and due split comes from the decoded payments, as before', () => {
  const f = buildChannelCloseFields({ channel: 'delivery', total: 20, items: [{ id: 'l1', itemId: 'wings', price: 20, qty: 1, mods: [] }],
    customer: { payments: [{ amount: 15 }], charges: [{ type: 'delivery', amount: 2.5 }, { type: 'tip', amount: 1 }, { type: 'other', name: 'Bag fee', amount: 0.3 }], discounts: [{ name: 'Promo', amount: 1 }] } },
  { menuItems: MENU, taxRates: RATES });
  assert.equal(f.paidAmount, 15);
  assert.equal(f.due, 5);
  assert.equal(f.channelPaid, false);
  assert.equal(f.deliveryFee, 2.5);
  assert.equal(f.tip, 1);
  assert.equal(f.service, 0.3);
  assert.equal(f.discountTotal, 1);
  assert.equal(f.discounts[0].source, 'channel');
});
