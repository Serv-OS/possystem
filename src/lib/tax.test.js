/**
 * tax.test.js — net (ex-VAT) price extraction used by gross-profit maths.
 * Run: `npm test` (Node's built-in runner — no third-party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { netOf, resolveTaxRate, resolveLineTaxRate, purchaseNet, calculateOrderTax, taxOverrideFor, taxOrderTypeKey } from './tax.js';

import { roundVat } from './taxRule.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const VAT20 = { id: 'r20', rate: 0.2, type: 'inclusive' };
const VAT0 = { id: 'r0', rate: 0, type: 'inclusive' };
const US = { id: 'us', rate: 0.08875, type: 'exclusive' };

test('netOf strips inclusive UK VAT', () => {
  near(netOf(6.0, VAT20), 5.0);          // £6 inc 20% → £5 net
  near(netOf(3.6, VAT20), 3.0);
});

test('netOf leaves zero-rated and exclusive prices unchanged', () => {
  near(netOf(6.0, VAT0), 6.0);           // 0% → price is already net
  near(netOf(6.0, US), 6.0);             // exclusive → shelf price IS the net
  near(netOf(6.0, null), 6.0);           // no rate → unchanged
});

test('netOf is null for a non-numeric price', () => {
  assert.equal(netOf(null, VAT20), null);
  assert.equal(netOf(undefined, VAT20), null);
});

test('resolveTaxRate honours order-type overrides then the item default', () => {
  const rates = [VAT20, VAT0];
  const item = { taxRateId: 'r20', taxOverrides: { takeaway: 'r0' } };
  assert.equal(resolveTaxRate(item, rates, 'dine-in').id, 'r20');
  assert.equal(resolveTaxRate(item, rates, 'takeaway').id, 'r0');   // zero-rated takeaway
});

test('purchaseNet keeps ex-VAT prices and strips inc-VAT prices', () => {
  near(purchaseNet(10, false, 0.2), 10);   // entered ex-VAT → already net
  near(purchaseNet(12, true, 0.2), 10);    // entered inc-VAT → strip 20% → £10 net
  near(purchaseNet(10, true, 0), 10);      // inc-VAT but 0% rate → unchanged
  near(purchaseNet(10, false, 0), 10);
});

// ── v5.5.857: the "Use default" contract ─────────────────────────────────────
// The item editor has always offered "Use default" (taxRateId null) but the engine
// returned null and booked £0 VAT (live repro: a £36 ribeye on "Use default" booked
// zero). These pin the fix and its two deliberate opt-outs.
const DEFAULTED = [
  { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, isDefault: true },
  { id: 'zero',  rate: 0,    type: 'inclusive', active: true, isDefault: false },
];

test('null taxRateId resolves the venue default rate ("Use default")', () => {
  assert.equal(resolveTaxRate({ taxRateId: null }, DEFAULTED, 'dine-in').id, 'vat20');
});

test('8 Oct 2026 (D4): an unmatched rate id takes the venue default, and the line is flagged, never silently 0', () => {
  // Until 8 Oct 2026 this resolved NOTHING on purpose (the channel unknown-ref opt out), which
  // is how 17 HubRise sales booked £0 VAT on £692.71. Now: the default, with a note the sale keeps.
  assert.equal(resolveTaxRate({ taxRateId: '__not_in_menu__' }, DEFAULTED, 'delivery').id, 'vat20');
  const r = resolveLineTaxRate({ id: 'hr-1', name: 'Double Smash Burger', taxRateId: '__not_in_menu__' }, DEFAULTED, 'delivery');
  assert.equal(r.rate.id, 'vat20');
  assert.deepEqual(r.fallback, { source: 'fallback', reason: 'item-not-on-menu', lineId: 'hr-1', itemId: 'hr-1', name: 'Double Smash Burger', rateId: '__not_in_menu__' });
  // Another venue's (or a deleted) rate id: the default, flagged 'rate-not-found'.
  const f = resolveLineTaxRate({ uid: 'u1', id: 'latte', taxRateId: 'train-station-std' }, DEFAULTED, 'dine-in');
  assert.equal(f.rate.id, 'vat20');
  assert.equal(f.fallback.reason, 'rate-not-found');
  assert.equal(f.fallback.lineId, 'u1');
  assert.equal(f.fallback.rateId, 'train-station-std');
  // An inactive rate is not a rate this venue has: the same.
  const inactive = [...DEFAULTED, { id: 'old', rate: 0.175, type: 'inclusive', active: false }];
  assert.equal(resolveLineTaxRate({ taxRateId: 'old' }, inactive, 'dine-in').fallback.reason, 'rate-not-found');
  // An override naming a rate this venue does not have: the item's OWN rate, flagged.
  const ov = resolveLineTaxRate({ taxRateId: 'zero', taxOverrides: { takeaway: 'elsewhere' } }, DEFAULTED, 'takeaway');
  assert.equal(ov.rate.id, 'zero');
  assert.equal(ov.fallback.reason, 'override-rate-not-found');
  assert.equal(ov.fallback.rateId, 'elsewhere');
  // The item's own rule followed: no note at all.
  assert.equal(resolveLineTaxRate({ taxRateId: 'vat20' }, DEFAULTED, 'dine-in').fallback, null);
  assert.equal(resolveLineTaxRate({ taxRateId: null }, DEFAULTED, 'dine-in').fallback, null, '"Use default" is the item rule');
  assert.equal(resolveLineTaxRate({ taxRateId: 'vat20', taxOverrides: { takeaway: null } }, DEFAULTED, 'takeaway').fallback, null, 'an explicit default override is the item rule');
  // An open price item typed at the till has no Back Office rule: the default, flagged.
  const custom = resolveLineTaxRate({ uid: 'c1', itemId: 'custom', name: 'Coffee beans', price: 7.95 }, DEFAULTED, 'dine-in');
  assert.equal(custom.rate.id, 'vat20');
  assert.equal(custom.fallback.reason, 'custom-item');
  // A line the till already cleaned (venueTaxRates.lineTaxRefs stamped taxFallback) keeps its reason.
  const cleaned = resolveLineTaxRate({ taxRateId: null, taxFallback: { reason: 'rate-not-found', rateId: 'ts-std' } }, DEFAULTED, 'dine-in');
  assert.equal(cleaned.rate.id, 'vat20');
  assert.deepEqual([cleaned.fallback.reason, cleaned.fallback.rateId], ['rate-not-found', 'ts-std']);
  // No rates at all: nothing, unflagged (no tax set up is not a fallback; the close paths guard it).
  assert.deepEqual(resolveLineTaxRate({ taxRateId: 'x' }, [], 'dine-in'), { rate: null, fallback: null });
});

test('8 Oct 2026: a venue with rates but no default resolves nothing for a line with no rate, and says so', () => {
  const noDefault = DEFAULTED.map(r => ({ ...r, isDefault: false }));
  const r = resolveLineTaxRate({ id: 'a', taxRateId: null }, noDefault, 'dine-in');
  assert.equal(r.rate, null);
  assert.equal(r.fallback.reason, 'no-default-rate');
  const t = calculateOrderTax([{ id: 'a', price: 6, qty: 1, taxRateId: null }, { id: 'b', price: 6, qty: 1, taxRateId: 'zero' }], noDefault, 'dine-in');
  assert.equal(t.totalTax, 0);
  assert.deepEqual(t.fallbacks.map(f => [f.reason, f.lineId]), [['no-default-rate', 'a']]);
});

test('8 Oct 2026: calculateOrderTax carries `fallbacks` only when a line fell to the default; an ordinary sale keeps its old keys', () => {
  const plain = calculateOrderTax([{ id: 'a', price: 6, qty: 1, taxRateId: 'vat20' }, { id: 'b', price: 6, qty: 1, taxRateId: null }], DEFAULTED, 'dine-in');
  assert.deepEqual(Object.keys(plain).sort(), ['breakdown', 'exclusiveTax', 'hasExclusiveTax', 'subtotal', 'total', 'totalTax']);
  const fell = calculateOrderTax([
    { uid: 'l1', id: 'a', name: 'Latte', price: 6, qty: 1, taxRateId: 'vat20' },
    { uid: 'l2', id: 'b', name: 'Mystery', price: 6, qty: 1, taxRateId: 'gone' },
    { uid: 'l3', id: 'c', name: 'Voided', price: 6, qty: 1, taxRateId: 'gone', voided: true },
  ], DEFAULTED, 'dine-in');
  assert.equal(Math.round(fell.totalTax * 100), 200, 'both live lines at 20%: the default applied to the unmatched one');
  assert.deepEqual(fell.fallbacks, [{ source: 'fallback', reason: 'rate-not-found', lineId: 'l2', itemId: 'b', name: 'Mystery', rateId: 'gone' }]);
  assert.equal(fell.breakdown.length, 1, 'one rate bucket: the default');
  assert.equal(fell.breakdown[0].items, 2);
});

test('no default configured keeps the old behaviour (null)', () => {
  const noDefault = DEFAULTED.map(r => ({ ...r, isDefault: false }));
  assert.equal(resolveTaxRate({ taxRateId: null }, noDefault, 'dine-in'), null);
});

test('explicit Zero Rate still beats the default (deliberate zero-tax)', () => {
  const item = { taxRateId: null, taxOverrides: { takeaway: 'zero' } };
  assert.equal(resolveTaxRate(item, DEFAULTED, 'takeaway').id, 'zero');
  assert.equal(resolveTaxRate(item, DEFAULTED, 'dine-in').id, 'vat20'); // dine-in falls to default
});

test('purchaseNet returns null for a non-numeric price', () => {
  assert.equal(purchaseNet(null, true, 0.2), null);
  assert.equal(purchaseNet('', false, 0.2), null);
});

test('alcohol GP correct end-to-end on net buy and net sell', () => {
  const grossBuy = 12.0, grossSell = 18.0;            // both inc 20% VAT
  const netCost = purchaseNet(grossBuy, true, 0.2);   // £10
  const netSell = netOf(grossSell, VAT20);            // £15
  near(netCost, 10); near(netSell, 15);
  near(((netSell - netCost) / netSell) * 100, 100 / 3); // 33.3% GP on net/net
});

test('GP on a VAT-inclusive price uses the net, not the shelf price', () => {
  const shelf = 6.0, cost = 1.5;
  const net = netOf(shelf, VAT20);                 // £5
  near(((net - cost) / net) * 100, 70);            // 70% GP on net…
  // …vs the wrong answer if you used the gross price:
  near(((shelf - cost) / shelf) * 100, 75);        // 75% — overstated
});

// ── v5.7.31: exclusiveTax — the ADDED-ON share a surface must charge ─────────
// The UK lock: any all-inclusive configuration yields exclusiveTax of EXACTLY 0
// (not a rounding artefact), so UK payables cannot move by a penny.

test('exclusiveTax is exactly 0 for a UK standard-rate check (all VAT20 inclusive)', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  ];
  const items = [
    { price: 36.00, qty: 1, taxRateId: 'vat20' },
    { price: 6.50,  qty: 2, taxRateId: 'vat20' },
  ];
  const r = calculateOrderTax(items, rates, 'dine-in');
  assert.equal(r.exclusiveTax, 0);
  assert.ok(r.totalTax > 0);                        // VAT is still extracted for display/records
});

test('exclusiveTax is exactly 0 for a mixed UK rate card (standard + reduced + zero)', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
    { id: 'vat5',  rate: 0.05, type: 'inclusive', active: true, is_default: false },
    { id: 'zero',  rate: 0,    type: 'inclusive', active: true, is_default: false },
  ];
  const items = [
    { price: 12.00, qty: 1, taxRateId: 'vat20' },
    { price: 4.00,  qty: 2, taxRateId: 'vat5' },
    { price: 2.50,  qty: 1, taxRateId: 'zero' },
  ];
  assert.equal(calculateOrderTax(items, rates, 'dine-in').exclusiveTax, 0);
});

test('exclusiveTax is exactly 0 for UK items on "Use default" (null rate id resolves the inclusive default)', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
  ];
  const items = [
    { price: 9.95, qty: 3, taxRateId: null },
    { price: 5.00, qty: 1 },                          // no tax fields at all
  ];
  const r = calculateOrderTax(items, rates, 'takeaway');
  assert.equal(r.exclusiveTax, 0);
  assert.ok(r.totalTax > 0);                          // the default rate DID apply
});

test('exclusive 8.875% on 47.20 charges 4.19 on top (half-up cents)', () => {
  const rates = [
    { id: 'us', rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  ];
  const items = [{ price: 47.20, qty: 1, taxRateId: 'us' }];
  const r = calculateOrderTax(items, rates, 'dine-in');
  assert.equal(r.exclusiveTax, 4.19);                 // 4.189 → half-up → 4.19
  assert.ok(r.hasExclusiveTax);
});

test('a mixed inclusive+exclusive check charges ONLY the exclusive share on top', () => {
  const rates = [
    { id: 'vat20', rate: 0.20,    type: 'inclusive', active: true, is_default: false },
    { id: 'us',    rate: 0.08875, type: 'exclusive', active: true, is_default: true },
  ];
  const items = [
    { price: 12.00, qty: 1, taxRateId: 'vat20' },     // VAT already inside the price
    { price: 10.00, qty: 1, taxRateId: 'us' },        // tax added on top
  ];
  const r = calculateOrderTax(items, rates, 'dine-in');
  assert.equal(r.exclusiveTax, 0.89);                 // 0.8875 → half-up → 0.89, NEVER + the £2 VAT
  near(r.totalTax, 2 + 0.8875, 1e-9);                 // records still carry the full tax picture
});

// ── Drive thru (16 Sep 2026): takeaway by another door ───────────────────────
// An explicit taxOverrides['drive-thru'] wins; else the takeaway override applies to a
// drive-thru sale; else the item's own rate (then the venue default). Every other order
// type reads exactly its own key, so a venue that never enables drive thru sees no change.

const DT_RATES = [
  { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, isDefault: true },
  { id: 'vat5',  rate: 0.05, type: 'inclusive', active: true, isDefault: false },
  { id: 'zero',  rate: 0,    type: 'inclusive', active: true, isDefault: false },
];
const OTHER_TYPES = ['dine-in', 'takeaway', 'collection', 'delivery', 'bar', 'counter', 'bar-tab'];

test('drive-thru: an explicit drive-thru override beats the takeaway override', () => {
  const item = { taxRateId: 'vat20', taxOverrides: { takeaway: 'zero', 'drive-thru': 'vat5' } };
  assert.equal(taxOverrideFor(item, 'drive-thru'), 'vat5');
  assert.equal(resolveTaxRate(item, DT_RATES, 'drive-thru').id, 'vat5');
  assert.equal(resolveTaxRate(item, DT_RATES, 'takeaway').id, 'zero');   // takeaway keeps its own
});

test('drive-thru: with no override of its own it takes the takeaway override', () => {
  const item = { taxRateId: 'vat20', taxOverrides: { takeaway: 'zero' } };
  assert.equal(taxOverrideFor(item, 'drive-thru'), 'zero');
  assert.equal(resolveTaxRate(item, DT_RATES, 'drive-thru').id, 'zero');
  assert.equal(resolveTaxRate(item, DT_RATES, 'dine-in').id, 'vat20');
});

test('drive-thru: with neither override it takes the item rate, then the venue default', () => {
  assert.equal(taxOverrideFor({ taxRateId: 'vat5', taxOverrides: {} }, 'drive-thru'), undefined);
  assert.equal(taxOverrideFor({ taxRateId: 'vat5' }, 'drive-thru'), undefined);
  assert.equal(resolveTaxRate({ taxRateId: 'vat5', taxOverrides: { delivery: 'zero' } }, DT_RATES, 'drive-thru').id, 'vat5');
  assert.equal(resolveTaxRate({ taxRateId: null }, DT_RATES, 'drive-thru').id, 'vat20');            // "Use default"
  // 8 Oct 2026 (D4): a channel line not on our menu takes the venue default too, flagged (it used to resolve nothing).
  assert.equal(resolveTaxRate({ taxRateId: '__not_in_menu__' }, DT_RATES, 'drive-thru').id, 'vat20');
});

test('drive-thru: an explicit null drive-thru override means the venue default, like any other null override', () => {
  // The item editor writes null for "Use default" on an override. It is a real override.
  const item = { taxRateId: 'vat5', taxOverrides: { takeaway: 'zero', 'drive-thru': null } };
  assert.equal(taxOverrideFor(item, 'drive-thru'), null);
  assert.equal(resolveTaxRate(item, DT_RATES, 'drive-thru').id, 'vat20');
  // the same null semantics takeaway has always had, and a null takeaway override reaches drive-thru the same way
  assert.equal(resolveTaxRate({ taxRateId: 'vat5', taxOverrides: { takeaway: null } }, DT_RATES, 'takeaway').id, 'vat20');
  assert.equal(resolveTaxRate({ taxRateId: 'vat5', taxOverrides: { takeaway: null } }, DT_RATES, 'drive-thru').id, 'vat20');
});

test('drive-thru: no other order type reads the drive-thru key, and nothing else changes', () => {
  const withDt = { taxRateId: 'vat20', taxOverrides: { takeaway: 'zero', 'drive-thru': 'vat5', delivery: 'vat5' } };
  const without = { taxRateId: 'vat20', taxOverrides: { takeaway: 'zero', delivery: 'vat5' } };
  for (const ot of OTHER_TYPES) {
    assert.equal(taxOverrideFor(withDt, ot), taxOverrideFor(without, ot), ot);
    assert.equal(resolveTaxRate(withDt, DT_RATES, ot)?.id, resolveTaxRate(without, DT_RATES, ot)?.id, ot);
  }
  assert.equal(resolveTaxRate(withDt, DT_RATES, 'dine-in').id, 'vat20');
  // 8 Oct 2026 (Peter, D2): a Collect sale follows the item's TAKEAWAY override (food taken away is
  // takeaway for VAT). Until then it read only its own key and booked the base rate.
  assert.equal(resolveTaxRate(withDt, DT_RATES, 'collection').id, 'zero');
  assert.equal(resolveTaxRate(withDt, DT_RATES, 'delivery').id, 'vat5');
  // a drive-thru only override never leaks to takeaway
  assert.equal(resolveTaxRate({ taxRateId: 'vat20', taxOverrides: { 'drive-thru': 'zero' } }, DT_RATES, 'takeaway').id, 'vat20');
  // the shapes with no overrides at all still give undefined
  assert.equal(taxOverrideFor({ taxRateId: 'vat20', taxOverrides: null }, 'drive-thru'), undefined);
  assert.equal(taxOverrideFor({ taxRateId: 'vat20' }, 'takeaway'), undefined);
  assert.equal(taxOverrideFor(null, 'drive-thru'), undefined);
});

// ── 8 Oct 2026 (Peter, D2): collection follows Takeaway, a bar tab follows Bar ────────────────
// "VAT despite the order type should follow the Tax rules set on the back office per menu item."
// The editor offers dine-in, takeaway, delivery, bar, counter and drive-thru; sales also arrive as
// collection (Collect button, online, catering, ezCater TAKEOUT) and bar-tab. One alias table in
// taxRule.js says which editor key each of those reads.

test('collection and online collection read the Takeaway override; a bar tab reads the Bar override', () => {
  assert.equal(taxOrderTypeKey('collection'), 'takeaway');
  assert.equal(taxOrderTypeKey('drive-thru'), 'takeaway');
  assert.equal(taxOrderTypeKey('bar-tab'), 'bar');
  for (const own of ['dine-in', 'takeaway', 'delivery', 'bar', 'counter', 'catering']) assert.equal(taxOrderTypeKey(own), own);
  // The Leeds Bueno Filled Donut: Standard 20% base, Zero Rate on takeaway and delivery (live rows).
  const donut = { taxRateId: 'vat20', taxOverrides: { takeaway: 'zero', delivery: 'zero' } };
  assert.equal(resolveTaxRate(donut, DT_RATES, 'takeaway').id, 'zero');
  assert.equal(resolveTaxRate(donut, DT_RATES, 'collection').id, 'zero', 'collected: the takeaway rule, £0.00 not £0.75');
  assert.equal(resolveTaxRate(donut, DT_RATES, 'drive-thru').id, 'zero');
  assert.equal(resolveTaxRate(donut, DT_RATES, 'delivery').id, 'zero');
  assert.equal(resolveTaxRate(donut, DT_RATES, 'dine-in').id, 'vat20');
  assert.equal(calculateOrderTax([{ price: 4.5, qty: 1, ...donut }], DT_RATES, 'collection').totalTax, 0);
  // An override under the sale's OWN key still wins over the alias.
  const ownKey = { taxRateId: 'vat20', taxOverrides: { takeaway: 'zero', collection: 'vat5' } };
  assert.equal(resolveTaxRate(ownKey, DT_RATES, 'collection').id, 'vat5');
  assert.equal(resolveTaxRate(ownKey, DT_RATES, 'takeaway').id, 'zero');
  // Bar tab: the Bar override, else the item's rate. 'bar' itself and 'counter' read their own key only.
  const barItem = { taxRateId: 'vat20', taxOverrides: { bar: 'vat5' } };
  assert.equal(resolveTaxRate(barItem, DT_RATES, 'bar-tab').id, 'vat5');
  assert.equal(resolveTaxRate(barItem, DT_RATES, 'bar').id, 'vat5');
  assert.equal(resolveTaxRate(barItem, DT_RATES, 'counter').id, 'vat20');
  assert.equal(resolveTaxRate(barItem, DT_RATES, 'dine-in').id, 'vat20');
  assert.equal(taxOverrideFor({ taxOverrides: { bar: null } }, 'bar-tab'), null, 'an explicit default Bar override reaches the tab');
  // The alias never runs the other way: a bar-tab or collection key never reaches bar or takeaway.
  assert.equal(resolveTaxRate({ taxRateId: 'vat20', taxOverrides: { 'bar-tab': 'zero' } }, DT_RATES, 'bar').id, 'vat20');
  assert.equal(resolveTaxRate({ taxRateId: 'vat20', taxOverrides: { collection: 'zero' } }, DT_RATES, 'takeaway').id, 'vat20');
  // No overrides at all: nothing changes for any order type.
  for (const ot of [...OTHER_TYPES, 'drive-thru']) assert.equal(resolveTaxRate({ taxRateId: 'vat5' }, DT_RATES, ot).id, 'vat5', ot);
});

test('8 Oct 2026 (D3): one rounding rule, half up to the penny on the true value; £10.05 at 20% is £1.68', () => {
  const rates = [{ id: 'vat20', rate: 0.20, type: 'inclusive', active: true, isDefault: true }];
  const t = calculateOrderTax([{ price: 10.05, qty: 1, taxRateId: 'vat20' }], rates, 'dine-in');
  // The engine keeps the raw figure in the record (1.6749999999999998 in floating point)...
  assert.ok(Math.abs(t.totalTax - 1.675) < 1e-9);
  // ...and the one rule books 1.68, never 1.67 (the numeric(10,2) column rounded the raw float DOWN).
  assert.equal(roundVat(t.totalTax), 1.68);
  assert.equal(roundVat(5.85 - 5.85 / 1.2), 0.98, '5.85 at 20% is exactly 0.975');
  assert.equal(roundVat(3.75 - 3.75 / 1.2), 0.63, '3.75 at 20% is exactly 0.625');
  // The added-on (US) share rounds with the same rule as the profiles engine (parity to the penny).
  assert.equal(calculateOrderTax([{ price: 47.20, qty: 1, taxRateId: 'us' }], [{ id: 'us', rate: 0.08875, type: 'exclusive', active: true, is_default: true }], 'dine-in').exclusiveTax, 4.19);
});

test('drive-thru: an order with only takeaway overrides taxes exactly like the same takeaway order', () => {
  const rates = [
    { id: 'vat20', rate: 0.20, type: 'inclusive', active: true, is_default: true },
    { id: 'zero',  rate: 0,    type: 'inclusive', active: true, is_default: false },
  ];
  const items = [
    { price: 4.50, qty: 2, taxRateId: 'vat20', taxOverrides: { takeaway: 'zero' } },   // cold food: zero rated to go
    { price: 3.20, qty: 1, taxRateId: 'vat20' },                                        // hot drink: 20% however it leaves
    { price: 9.95, qty: 1, taxRateId: null },                                           // "Use default"
  ];
  assert.deepEqual(calculateOrderTax(items, rates, 'drive-thru'), calculateOrderTax(items, rates, 'takeaway'));
  assert.notDeepEqual(calculateOrderTax(items, rates, 'drive-thru'), calculateOrderTax(items, rates, 'dine-in'));
  assert.equal(calculateOrderTax(items, rates, 'drive-thru').exclusiveTax, 0);   // the UK lock holds
  // a drive-thru override of its own moves only drive-thru
  const own = items.map(i => (i.taxOverrides ? { ...i, taxOverrides: { ...i.taxOverrides, 'drive-thru': 'vat20' } } : i));
  assert.deepEqual(calculateOrderTax(own, rates, 'takeaway'), calculateOrderTax(items, rates, 'takeaway'));
  assert.deepEqual(calculateOrderTax(own, rates, 'drive-thru'), calculateOrderTax(items, rates, 'dine-in'));
});
