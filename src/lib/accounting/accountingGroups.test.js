/**
 * accountingGroups.test.js: the day by sales group and tax rate, for the daily sales invoice
 * (30 Sep 2026). Run: `npm test`, or `node --test src/lib/accounting/accountingGroups.test.js`.
 *
 * Pinned:
 *   1. Which group an item is in: item choice, then category, then a parent's category choice,
 *      then Menu Manager's accounting_group (own, then a parent's), else Other sales. A category
 *      id from another venue resolves through master_id to this venue's copy.
 *   2. Per rate, exactly: groups + gift cards sold - discounts - credits = the day's money sales
 *      (buildAccountingDay), on the fixture day and on 300 generated checks.
 *   3. Discounts split to the rate of the items they were taken off, placed as the till charged
 *      them: an item's own discount (items[].discount, POSSurface's "Selected items" and category
 *      presets) on that item, an auto discount on its appliedItems, the rest of a check discount
 *      by value. Each group shows its full sales; the discount lines show what was taken off.
 *   4. Refunds weigh groups by the refund's own items, and by the check's at a rate those miss.
 *   5. Discount labels seen live at Leeds and Huddersfield fall into the right discount group.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGroupedDay, makeGroupResolver, discountGroupOf, creditGroupOf, groupKeyOf, OTHER_GROUP,
} from '../../../supabase/functions/_shared/accountingGroups.js';
import { buildAccountingDay } from '../../../supabase/functions/_shared/accountingDay.js';
import {
  UK, DAY, UK_TAX, CATEGORIES, saleRows, refundRows, mapping, generatedCheck, rng, at, breakdown, atMs,
} from './xeroInvoiceFixtures.js';

const sum = (o) => Object.values(o || {}).reduce((s, v) => s + v, 0);

// The invariant, per rate and side, against the neutral summary.
// Sales tie per rate. Refunds tie in total (their goods follow the refund's own items' rates
// when every item names one; the VAT per rate is the summary's in the plan).
function assertTies(g, label = '') {
  const { summary, groups } = g;
  const t = summary.sales.totals;
  const keys = new Set([...Object.keys(t.byRate || {}), ...Object.keys(groups.sales)]);
  for (const r of keys) {
    const b = groups.sales[r] || { goods: {}, discounts: {}, credits: {}, gift: 0 };
    const got = sum(b.goods) + (b.gift || 0) - sum(b.discounts) - sum(b.credits);
    assert.equal(got, t.byRate?.[r]?.sales || 0, `${label} sales ${r}: groups + gift - discounts - credits`);
    assert.equal(sum(b.credits), summary.sales.credits.byRate?.[r]?.sales || 0, `${label} sales ${r}: credits`);
  }
  let refunds = 0;
  for (const b of Object.values(groups.refunds)) refunds += sum(b.goods) + (b.gift || 0) - sum(b.credits);
  assert.equal(refunds, summary.refunds.totals.sales, `${label} refunds: groups + gift - credits`);
}

test('resolver: item, category, parent category, accounting_group, parent accounting_group, other', () => {
  const cats = [
    { id: 'c-top_aaaa1111', parent_id: null, label: 'Top', accounting_group: 'Beverages', master_id: 'c-top', local: true },
    { id: 'c-mid_aaaa1111', parent_id: 'c-top_aaaa1111', label: 'Mid', accounting_group: '', master_id: 'c-mid', local: true },
    { id: 'c-leaf_aaaa1111', parent_id: 'c-mid_aaaa1111', label: 'Leaf', accounting_group: 'Leafy', master_id: 'c-leaf', local: true },
    { id: 'c-lone_aaaa1111', parent_id: null, label: 'Lone', accounting_group: '', master_id: 'c-lone', local: true },
    { id: 'c-leaf_bbbb2222', parent_id: 'c-mid_bbbb2222', label: 'Leaf', accounting_group: '', master_id: 'c-leaf', local: false },
  ];
  const base = makeGroupResolver({}, cats);
  assert.equal(base.itemGroup({ cat: 'c-leaf_aaaa1111' }).key, 'leafy', 'own accounting_group');
  assert.equal(base.groupName('leafy'), 'Leafy');
  assert.equal(base.itemGroup({ cat: 'c-mid_aaaa1111' }).key, 'beverages', "a parent's accounting_group");
  assert.deepEqual(base.itemGroup({ cat: 'c-lone_aaaa1111' }), { key: OTHER_GROUP, catId: 'c-lone_aaaa1111', resolved: false });
  assert.equal(base.itemGroup({ cat: null }).key, OTHER_GROUP);
  assert.equal(base.groupName(OTHER_GROUP), 'Other sales');

  const withParent = makeGroupResolver({ categoryGroups: { 'c-mid_aaaa1111': 'hot' } }, cats);
  assert.equal(withParent.itemGroup({ cat: 'c-leaf_aaaa1111' }).key, 'hot', "a parent's category choice beats the category's own accounting_group");
  const withCat = makeGroupResolver({ categoryGroups: { 'c-mid_aaaa1111': 'hot', 'c-leaf_aaaa1111': 'cold' } }, cats);
  assert.equal(withCat.itemGroup({ cat: 'c-leaf_aaaa1111' }).key, 'cold', 'the category choice beats its parent');
  const withItem = makeGroupResolver({ categoryGroups: { 'c-leaf_aaaa1111': 'cold' }, itemGroups: { 'm-beans': 'retail' } }, cats);
  assert.equal(withItem.itemGroup({ cat: 'c-leaf_aaaa1111', itemId: 'm-beans' }).key, 'retail', 'the item choice wins');

  // Another venue's category id (a shared menu): through master_id to the local copy.
  assert.equal(withCat.itemGroup({ cat: 'c-leaf_bbbb2222' }).key, 'cold');
  assert.equal(withCat.itemGroup({ cat: 'c-leaf_bbbb2222' }).catId, 'c-leaf_aaaa1111');
  // Not loaded at all: the id's stem (the id less its venue suffix) still finds the local copy.
  assert.equal(withCat.itemGroup({ cat: 'c-leaf_cccc3333' }).key, 'cold');
  // A multi category item with no cat uses its first category.
  assert.equal(withCat.itemGroup({ cats: ['c-leaf_aaaa1111'] }).key, 'cold');
});

test('group keys, discount groups and credit groups', () => {
  assert.equal(groupKeyOf('Hot drinks'), 'hot-drinks');
  assert.equal(groupKeyOf('  Food & Snacks (takeaway) '), 'food-snacks-takeaway');
  assert.equal(groupKeyOf(''), '');
  assert.ok(groupKeyOf('x'.repeat(80)).length <= 40);
  // Labels seen live at Leeds and Huddersfield (Sep 2026).
  const want = {
    'Staff Drinks': 'staff', 'Staff drinks': 'staff', 'Staff meal': 'staff', 'Staff Discount 50%': 'staff', 'Off Shift': 'staff',
    'Comp (100%)': 'comp', 'Custom 100%': 'comp', 'Loyalty 10%': 'loyalty',
    'Blue light': 'customer', 'NHS / Blue Light': 'customer', 'Gym': 'customer', 'Custom 10%': 'customer', 'Custom £0.30': 'customer',
    'Promo code SUMMER': 'promo',
  };
  for (const [label, g] of Object.entries(want)) assert.equal(discountGroupOf(label), g, label);
  const r = makeGroupResolver({ discounts: { labels: { Gym: 'promo', 'Blue light': 'nonsense' } } }, []);
  assert.equal(r.discountGroup('Gym'), 'promo', 'the mapping names the group');
  assert.equal(r.discountGroup('Blue light'), 'customer', 'an unknown group in the mapping is ignored');
  assert.equal(creditGroupOf('loyalty'), 'loyalty');
  assert.equal(creditGroupOf('promo'), 'promo');
});

test('the fixture day: groups by rate tie to the neutral summary to the penny', () => {
  const resolver = makeGroupResolver(mapping(), CATEGORIES);
  const g = buildGroupedDay({ day: DAY, saleRows: saleRows(), refundRows: refundRows(), venue: UK, taxRates: UK_TAX, resolver });
  assertTies(g, 'fixture');
  const s = g.groups.sales;
  // Hot drinks: A latte 3.80, C flat white 3.75, D latte 3.80 (1.00 of it loyalty credit), E 4 x 2.00.
  assert.equal(s['rate:r20'].goods['hot-drinks'], 380 + 375 + 380 + 800);
  // The takeaway sandwich follows its order type override to 0%.
  assert.equal(s['rate:r0'].goods.food, 400);
  // B's cake 2.95 less 10% (0.30, rounded from 0.295) and C's muffin 3.00 less the staff 1.50.
  assert.equal(s['rate:r20'].goods.food, 296 + 300);
  assert.deepEqual(s['rate:r20'].discounts, { customer: 30, staff: 150 });
  assert.deepEqual(s['rate:r20'].credits, { loyalty: 100 });
  assert.equal(g.groups.names['hot-drinks'], 'Hot drinks');
  assert.deepEqual(g.groups.discountLabels['Staff Discount 50%'], { group: 'staff', amount: 150, count: 1 });
  assert.equal(g.groups.categories['cat-hot_1e945c26'].goods, 1935);
  assert.equal(g.groups.unresolved.goods, 0);
  assert.deepEqual(g.groups.flags, []);
  // The summary is buildAccountingDay's own.
  assert.deepEqual(g.summary, buildAccountingDay({ day: DAY, saleRows: saleRows(), refundRows: refundRows(), venue: UK, taxRates: UK_TAX }));
});

test("refunds: the refund's own items weigh the groups; the check's items at a rate they miss", () => {
  const resolver = makeGroupResolver(mapping(), CATEGORIES);
  const g = buildGroupedDay({ day: DAY, saleRows: [], refundRows: refundRows(), venue: UK, taxRates: UK_TAX, resolver });
  assertTies(g, 'refund');
  // A's refund is the 3.80 latte at 20%. The neutral summary spreads it over A's rates pro rata
  // (1.85 at 20%, 1.95 at 0%, with all 0.63 VAT at 20%); the refund's own item puts it back at 20%.
  assert.deepEqual(g.summary.refunds.totals.byRate, { 'rate:r20': { sales: 185, tax: 63 }, 'rate:r0': { sales: 195, tax: 0 } });
  assert.deepEqual(g.groups.refunds['rate:r20'].goods, { 'hot-drinks': 380 });
  assert.equal(g.groups.refunds['rate:r0'], undefined);
  assert.equal(g.summary.refunds.totals.gross, 380);

  // A refund whose item names no rate keeps the summary's split, its item spread over both
  // rates (flagged as an estimate).
  const vague = refundRows().map((r) => ({ ...r, refunds: r.refunds.map((e) => ({ ...e, items: e.items.map((it) => { const c = { ...it }; delete c.taxRateId; return c; }) })) }));
  const g2 = buildGroupedDay({ day: DAY, saleRows: [], refundRows: vague, venue: UK, taxRates: UK_TAX, resolver });
  assertTies(g2, 'vague refund');
  assert.deepEqual(g2.groups.refunds['rate:r20'].goods, { 'hot-drinks': 185 });
  assert.deepEqual(g2.groups.refunds['rate:r0'].goods, { 'hot-drinks': 195 });
  assert.equal(g2.groups.flags[0].code, 'group_rate_estimated');
  // A refund with no items of its own: the check's items weigh each rate (never Other sales).
  const bare = refundRows().map((r) => ({ ...r, refunds: r.refunds.map((e) => { const c = { ...e }; delete c.items; return c; }) }));
  const g3 = buildGroupedDay({ day: DAY, saleRows: [], refundRows: bare, venue: UK, taxRates: UK_TAX, resolver });
  assertTies(g3, 'bare refund');
  assert.deepEqual(g3.groups.refunds['rate:r20'].goods, { 'hot-drinks': 185 });
  assert.deepEqual(g3.groups.refunds['rate:r0'].goods, { food: 195 });
});

test('a check scope discount splits over rates by the items it was taken off', () => {
  const row = {
    id: 'X', closed_at: at(2), total: 9.0, tip: 0, service: 0, tax_amount: 1.0,
    tax_breakdown: breakdown([{ id: 'r20', gross: 6.0, tax: 1.0 }, { id: 'r0', gross: 3.0, tax: 0 }], 'takeaway'),
    items: [
      { uid: 'x1', cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 6.0, taxRateId: 'r20' },
      { uid: 'x2', cat: 'cat-food_1e945c26', itemId: 'm2', qty: 1, price: 4.0, taxRateId: 'r20', taxOverrides: { takeaway: 'r0' } },
      { uid: 'x3', cat: 'cat-hot_1e945c26', itemId: 'm3', qty: 1, price: 0.67, taxRateId: 'r20' },
    ],
    discounts: [{ label: 'Custom 15%', scope: 'check', amount: 1.67, itemUids: null }],
    tenders: [{ method: 'card', amount: 9.0, tip: 0, processor: 'adyen' }],
  };
  const g = buildGroupedDay({ day: DAY, saleRows: [row], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'check scope');
  const d20 = g.groups.sales['rate:r20'].discounts.customer;
  const d0 = g.groups.sales['rate:r0'].discounts.customer;
  assert.equal(d20 + d0, 167);
  assert.equal(d0, Math.round(167 * 400 / 1067), 'the 0% part in proportion to the 0% item');
  // An item's own discount (as POSSurface saves it, on the item) stays on its own item's rate.
  const items2 = row.items.map((it) => (it.uid === 'x2' ? { ...it, discount: { id: 'disc-x2', label: 'Staff meal', type: 'amount', value: 2.0 } } : it));
  const row2 = { ...row, id: 'Y', items: items2, discounts: [], total: 8.67, tax_breakdown: breakdown([{ id: 'r20', gross: 6.67, tax: 1.11 }, { id: 'r0', gross: 2.0, tax: 0 }], 'takeaway'), tax_amount: 1.11, tenders: [{ method: 'card', amount: 8.67, tip: 0, processor: 'adyen' }] };
  const g2 = buildGroupedDay({ day: DAY, saleRows: [row2], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g2, 'item discount');
  assert.deepEqual(g2.groups.sales['rate:r0'].discounts, { staff: 200 });
  assert.deepEqual(g2.groups.sales['rate:r0'].goods, { food: 400 }, 'the food group shows its full price');
  assert.equal(g2.groups.sales['rate:r20'].discounts.staff, undefined);
  assert.deepEqual(g2.groups.discountLabels['Staff meal'], { group: 'staff', amount: 200, count: 1 });
});

test('8 Oct 2026 (D2): a collection sale places an item with a Takeaway override in its override\'s bucket, as the till booked it', () => {
  // The till books a collected Leeds donut (Standard base, takeaway Zero Rate) at the Zero Rate
  // since 8 Oct 2026 (src/lib/taxRule.js: collection reads Takeaway). The Xero split must read the
  // override the same way, or the donut's goods land in the 20% bucket and the invoice no longer
  // matches the VAT the till booked.
  const row = {
    id: 'C1', closed_at: at(2), total: 8.2, tip: 0, service: 0, tax_amount: 0.62,
    tax_breakdown: breakdown([{ id: 'r20', gross: 3.7, tax: 0.62 }, { id: 'r0', gross: 4.5, tax: 0 }], 'collection'),
    items: [
      { uid: 'c1', cat: 'cat-food_1e945c26', itemId: 'donut', qty: 1, price: 4.5, taxRateId: 'r20', taxOverrides: { takeaway: 'r0', delivery: 'r0' } },
      { uid: 'c2', cat: 'cat-hot_1e945c26', itemId: 'latte', qty: 1, price: 3.7, taxRateId: 'r20' },
    ],
    discounts: [],
    tenders: [{ method: 'card', amount: 8.2, tip: 0, processor: 'adyen' }],
  };
  const g = buildGroupedDay({ day: DAY, saleRows: [row], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'collection');
  assert.deepEqual(g.groups.sales['rate:r0'].goods, { food: 450 }, 'the donut sits in the Zero Rate bucket, not estimated');
  assert.deepEqual(g.groups.sales['rate:r20'].goods, { 'hot-drinks': 370 });
  const estimated = (x) => x.groups.flags.some((f) => f.code === 'group_rate_estimated');
  assert.equal(estimated(g), false);
  // a bar tab reads the Bar override; an order type with no alias reads only its own key
  const tab = { ...row, id: 'C2', tax_breakdown: breakdown([{ id: 'r20', gross: 3.7, tax: 0.62 }, { id: 'r0', gross: 4.5, tax: 0 }], 'bar-tab'),
    items: [{ ...row.items[0], taxOverrides: { bar: 'r0' } }, row.items[1]] };
  const gt = buildGroupedDay({ day: DAY, saleRows: [tab], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assert.deepEqual(gt.groups.sales['rate:r0'].goods, { food: 450 });
  assert.equal(estimated(gt), false);
});

test("an item's own discount (items[].discount) is a discount line, and each group keeps its full sales", () => {
  // Reviewer's case, 30 Sep: a latte 3.80 (Hot drinks) and a muffin 3.00 (Food) with the staff
  // 50% on the muffin, paid 5.30 by card. Before, the muffin's discount was never seen: Hot
  // drinks 2.96, Food 2.34 and no staff line.
  const row = {
    id: 'SD', closed_at: at(2), total: 5.3, tip: 0, service: 0, tax_amount: 0.88,
    tax_breakdown: breakdown([{ id: 'r20', gross: 5.3, tax: 0.8833 }]),
    items: [
      { uid: 's1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' },
      { uid: 's2', cat: 'cat-cake_1e945c26', itemId: 'm-muffin', qty: 1, price: 3.0, taxRateId: 'r20', discount: { id: 'disc-s2', label: 'Staff Discount 50%', type: 'percent', value: 50 } },
    ],
    discounts: [],
    tenders: [{ method: 'card', amount: 5.3, tip: 0, processor: 'adyen' }],
  };
  const g = buildGroupedDay({ day: DAY, saleRows: [row], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'staff item discount');
  assert.deepEqual(g.groups.sales['rate:r20'].goods, { 'hot-drinks': 380, food: 300 });
  assert.deepEqual(g.groups.sales['rate:r20'].discounts, { staff: 150 });
  assert.deepEqual(g.groups.discountLabels, { 'Staff Discount 50%': { group: 'staff', amount: 150, count: 1 } });
  // An amount off a line of two: off the whole line (taxBasis.lineAfterItemDiscount).
  const two = { ...row, id: 'SD2', total: 6.8, tax_breakdown: breakdown([{ id: 'r20', gross: 6.8, tax: 1.1333 }]), tax_amount: 1.13,
    items: [{ uid: 't1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 2, price: 3.8, taxRateId: 'r20', discount: { label: 'Custom £0.80', type: 'amount', value: 0.8 } }],
    tenders: [{ method: 'cash', amount: 6.8, tip: 0 }] };
  const g2 = buildGroupedDay({ day: DAY, saleRows: [two], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g2, 'amount off a line');
  assert.deepEqual(g2.groups.sales['rate:r20'].goods, { 'hot-drinks': 760 });
  assert.deepEqual(g2.groups.sales['rate:r20'].discounts, { customer: 80 });
});

test('an auto discount lands on the items it names (appliedItems), at their own rate', () => {
  // A coffee (20%) and a takeaway cookie (0%) with "Cookie with a coffee" taking the 2.00 cookie
  // off. The till charged 3.00 at 20% and nothing at 0%.
  const items = [
    { uid: 'k1', cat: 'cat-hot_1e945c26', itemId: 'm-coffee', qty: 1, price: 3.0, taxRateId: 'r20' },
    { uid: 'k2', cat: 'cat-cake_1e945c26', itemId: 'm-cookie', qty: 1, price: 2.0, taxRateId: 'r20', taxOverrides: { takeaway: 'r0' } },
  ];
  const auto = { id: 'rule-7', label: 'Cookie with a coffee', type: 'amount', value: 2, amount: 2, scope: 'check', isAuto: true, appliedItems: [{ uid: 'k2', name: 'Cookie', saving: 2 }], ruleKind: 'free' };
  const row = {
    id: 'AU', closed_at: at(2), total: 3.0, tip: 0, service: 0, tax_amount: 0.5,
    tax_breakdown: breakdown([{ id: 'r20', gross: 3.0, tax: 0.5 }, { id: 'r0', gross: 0, tax: 0 }], 'takeaway'),
    items, discounts: [auto], tenders: [{ method: 'card', amount: 3.0, tip: 0, processor: 'adyen' }],
  };
  const g = buildGroupedDay({ day: DAY, saleRows: [row], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'auto discount');
  assert.deepEqual(g.groups.sales['rate:r20'].goods, { 'hot-drinks': 300 });
  assert.deepEqual(g.groups.sales['rate:r20'].discounts, {}, 'nothing of it on the coffee');
  assert.deepEqual(g.groups.sales['rate:r0'].goods, { food: 200 });
  assert.deepEqual(g.groups.sales['rate:r0'].discounts, { customer: 200 });
  assert.deepEqual(g.groups.flags, []);
  // Both at one rate: each group keeps its full price, the deal is one discount line.
  const one = { ...row, id: 'AU2', tax_breakdown: breakdown([{ id: 'r20', gross: 3.0, tax: 0.5 }]), items: items.map((i) => ({ ...i, taxOverrides: {} })) };
  const g2 = buildGroupedDay({ day: DAY, saleRows: [one], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g2, 'auto discount one rate');
  assert.deepEqual(g2.groups.sales['rate:r20'].goods, { 'hot-drinks': 300, food: 200 });
  assert.deepEqual(g2.groups.sales['rate:r20'].discounts, { customer: 200 });
});

test('gift cards sold are carved out of the groups; one at a VAT rate is flagged', () => {
  const row = {
    id: 'G', closed_at: at(2), total: 23.8, tip: 0, service: 0, tax_amount: 0.63,
    tax_breakdown: breakdown([{ id: 'r20', gross: 3.8, tax: 0.6333 }, { id: 'rnv', gross: 20, tax: 0 }]),
    items: [
      { uid: 'g1', cat: 'cat-hot_1e945c26', itemId: 'm-latte', qty: 1, price: 3.8, taxRateId: 'r20' },
      { uid: 'g2', cat: 'cat-gift_1e945c26', itemId: 'gift', qty: 1, price: 20, taxRateId: 'rnv', isGiftCard: true },
    ],
    tenders: [{ method: 'card', amount: 23.8, tip: 0, processor: 'adyen' }],
  };
  const g = buildGroupedDay({ day: DAY, saleRows: [row], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'gift');
  assert.equal(g.groups.sales['rate:rnv'].gift, 2000);
  assert.deepEqual(g.groups.sales['rate:rnv'].goods, {});
  assert.equal(g.groups.categories['cat-gift_1e945c26'], undefined, 'gift cards are not sales of a category');
  assert.deepEqual(g.groups.flags, []);
  const vat = { ...row, id: 'G2', tax_breakdown: breakdown([{ id: 'r20', gross: 23.8, tax: 3.97 }]), tax_amount: 3.97, items: row.items.map((i) => ({ ...i, taxRateId: 'r20' })) };
  const g2 = buildGroupedDay({ day: DAY, saleRows: [vat], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g2, 'gift at 20%');
  assert.equal(g2.groups.flags[0].code, 'gift_card_vat_charged');
});

test('checks with no items, or items the rates cannot place, still tie (Other sales, flagged estimate)', () => {
  const noItems = { id: 'N', closed_at: at(2), total: 5, tip: 0, service: 0, tax_amount: 0.83, tax_breakdown: breakdown([{ id: 'r20', gross: 5, tax: 0.8333 }]), tenders: [{ method: 'cash', amount: 5, tip: 0 }] };
  const unplaced = {
    id: 'U', closed_at: at(3), total: 10, tip: 0, service: 0, tax_amount: 1.0,
    tax_breakdown: breakdown([{ id: 'r20', gross: 6, tax: 1.0 }, { id: 'r0', gross: 4, tax: 0 }]),
    items: [{ uid: 'u1', cat: 'cat-hot_1e945c26', itemId: 'm1', qty: 1, price: 6 }, { uid: 'u2', cat: 'cat-food_1e945c26', itemId: 'm2', qty: 1, price: 4, taxRateId: 'someone-elses-rate' }],
    tenders: [{ method: 'card', amount: 10, tip: 0, processor: 'adyen' }],
  };
  const g = buildGroupedDay({ day: DAY, saleRows: [noItems, unplaced], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'odd');
  assert.equal(g.groups.sales['rate:r20'].goods.other, 500);
  assert.equal(g.groups.unresolved.goods, 500);
  assert.equal(g.groups.flags.find((f) => f.code === 'group_rate_estimated').checkIds[0], 'U');
});

test('300 generated checks with refunds: every rate ties, sales and refunds', () => {
  const r = rng(20260930);
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(generatedCheck(r, `gen-${i}`, (i % 20) / 1.1));
  // Refund a third of them later in the day: part refunds by item, full refunds, cash refunds.
  const refunded = rows.filter((_, i) => i % 3 === 0).map((row, i) => {
    const it = row.items[0];
    const full = i % 4 === 0;
    const amount = full ? row.total : Math.min(row.total, Math.round(it.price * 100) / 100);
    return { ...row, refunds: [{ id: `rf-${row.id}`, amount, isFullRefund: full, tipAmount: full ? row.tip : 0, serviceAmount: full ? row.service : 0,
      taxAmount: full ? row.tax_amount : null, tenderMethod: i % 5 === 0 ? 'cash' : 'card', cardStatus: 'accepted', timestamp: atMs(21),
      items: full ? undefined : [{ ...it, refundQty: 1 }] }] };
  });
  const g = buildGroupedDay({ day: DAY, saleRows: rows, refundRows: refunded, venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'generated');
  assert.ok(g.summary.sales.totals.count > 250);
  assert.ok(g.summary.refunds.totals.count > 50);
  assert.ok(Object.keys(g.groups.sales).length >= 2, 'two rates');
  // Without the venue's rates every figure sits under 'default', and still ties.
  const plain = buildGroupedDay({ day: DAY, saleRows: rows, refundRows: refunded, venue: UK, taxRates: null, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  const got = sum(plain.groups.sales.default.goods) + plain.groups.sales.default.gift - sum(plain.groups.sales.default.discounts) - sum(plain.groups.sales.default.credits);
  assert.equal(got, plain.summary.sales.totals.sales);
});

test('voided checks, checks outside the day and duplicates are left out, as in buildAccountingDay', () => {
  const rows = saleRows();
  const extra = [
    { ...rows[0], id: 'V', voided: true },
    { ...rows[1], id: 'LATE', closed_at: new Date(DAY.toMs + 1000).toISOString() },
    rows[2],
  ];
  const g = buildGroupedDay({ day: DAY, saleRows: [...rows, ...extra], venue: UK, taxRates: UK_TAX, resolver: makeGroupResolver(mapping(), CATEGORIES) });
  assertTies(g, 'filters');
  assert.equal(g.summary.sales.totals.count, 5);
});
