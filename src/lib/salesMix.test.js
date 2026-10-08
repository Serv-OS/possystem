/**
 * salesMix.test.js: the Sales mix maths (supabase/functions/_shared/salesMix.js).
 * Run: `npm test`, or `node --test src/lib/salesMix.test.js`.
 *
 * 8 Oct 2026, Peter: "the ability to report on bigger categories like say what is
 * Food/drink/other split". One file carries the roll up, the shares, the series, the daypart
 * split, the setup list and the owner view, and every surface (the Back Office report, the
 * Business summary strip, the Z report block, the owner app, the owner snapshot function)
 * calls it over the same inputs. These tests pin the rules:
 *   D2  one resolver: makeGroupResolver over the SITE's own categories plus its Xero mapping
 *   D3  item sales = till price times qty, the line's own discount NOT taken off, mods never added
 *   D6  nothing set up = everything in "Other sales", never an error
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIX_BASIS, OTHER_NAME, OTHER_TEXT, SUGGESTED_GROUPS, SETUP_OPTIONS, BASIS_NOTE, GROUP_TONES, TONE_CYCLE, TONE_SPARE,
  DAY_BANDS, BANDS_NOTE, OUTSIDE_ID, OUTSIDE_NAME, NO_CAT_LABEL, UNKNOWN_CAT_LABEL, r2,
  isLiveCheck, isLiveLine, closedMsOf, lineQty, lineSales,
  toResolverCategories, categoriesOfSite, fallbackName, makeMixResolver, nameAcross, catFamilyKey,
  newMix, addLineToMix, addCheckToMix, mixFromChecks,
  wholeShares, ptsText, tonesFor, mixView, mixRollup, barSegments, mixWords, needsSetup, allOther,
  mixSeriesLines, shareSeries, clockMinutes, shiftOf, bandOf, daypartSplit, reconcile, setupRows, optionFor,
} from '../../supabase/functions/_shared/salesMix.js';
import { OTHER_GROUP, groupKeyOf, makeGroupResolver } from '../../supabase/functions/_shared/accountingGroups.js';
import { CATEGORIES, mapping as xeroMapping, generatedCheck, rng } from './accounting/xeroInvoiceFixtures.js';
import { sharedDepsOf } from '../../scripts/edgeFnDeps.mjs';

// ── fixtures ─────────────────────────────────────────────────────────────────
// One site's categories as the resolver wants them (ids with the site suffix, bare master ids).
const MIX_CATS = [
  { id: 'c-food_aaaa1111', parent_id: null, label: 'Food', accounting_group: 'Food', master_id: 'c-food', local: true },
  { id: 'c-cakes_aaaa1111', parent_id: 'c-food_aaaa1111', label: 'Cakes', accounting_group: '', master_id: 'c-cakes', local: true },
  { id: 'c-vegan_aaaa1111', parent_id: 'c-food_aaaa1111', label: 'Vegan', accounting_group: 'Vegan', master_id: 'c-vegan', local: true },
  { id: 'c-drinks_aaaa1111', parent_id: null, label: 'Drinks', accounting_group: 'Drinks', master_id: 'c-drinks', local: true },
  { id: 'c-coffee_aaaa1111', parent_id: 'c-drinks_aaaa1111', label: 'Coffee', accounting_group: '', master_id: 'c-coffee', local: true },
  { id: 'c-tea_aaaa1111', parent_id: 'c-drinks_aaaa1111', label: 'Tea', accounting_group: 'drinks', master_id: 'c-tea', local: true },
  { id: 'c-sweets_aaaa1111', parent_id: null, label: 'Sweets', accounting_group: 'Other', master_id: 'c-sweets', local: true },
  { id: 'c-misc_aaaa1111', parent_id: null, label: 'Misc', accounting_group: '', master_id: 'c-misc', local: true },
];
const XERO_MAP = {
  groups: { 'hot-drinks': { name: 'Hot drinks', account: '201' } },
  categoryGroups: { 'c-coffee_aaaa1111': 'hot-drinks' },
  itemGroups: { 'm-beans': 'retail' },
};
const L = {
  latte:    { uid: 'l1', name: 'Latte', itemId: 'm-latte', cat: 'c-coffee_aaaa1111', qty: 1, price: 3.65, mods: [{ name: 'Oat milk', price: 0.5 }] },
  cake:     { uid: 'l2', name: 'Cake', itemId: 'm-cake', cat: 'c-cakes_aaaa1111', qty: 2, price: 2.55 },
  cakeDisc: { uid: 'l3', name: 'Cake', itemId: 'm-cake', cat: 'c-cakes_aaaa1111', qty: 1, price: 2.55, discount: { id: 'disc-l3', type: 'percent', label: 'Custom 10%', value: 10 } },
  voided:   { uid: 'l4', name: 'Mistake', itemId: 'm-oops', cat: 'c-food_aaaa1111', qty: 1, price: 99, voided: true },
  water:    { uid: 'l5', name: 'Water', itemId: 'm-water', cat: 'c-drinks_aaaa1111', qty: 1, price: 0 },
  sweet:    { uid: 'l6', name: 'Sweet', itemId: 'm-sweet', cat: 'c-sweets_aaaa1111', qty: 1, price: 1.2 },
  misc:     { uid: 'l7', name: 'Misc', itemId: 'm-misc', cat: 'c-misc_aaaa1111', qty: 1, price: 4 },
  nocat:    { uid: 'l8', name: 'Loose', itemId: 'm-loose', qty: 1, price: 2 },
  foreign:  { uid: 'l9', name: 'Cake', itemId: 'm-cake_bbbb2222', cat: 'c-cakes_bbbb2222', qty: 1, price: 2.55 },
  beans:    { uid: 'l10', name: 'Beans', itemId: 'm-beans', cat: 'c-drinks_aaaa1111', qty: 1, price: 7 },
  pizza:    { uid: 'l11', name: 'Pizza', itemId: 'm-pizza', cat: 'c-food_aaaa1111', qty: 1, price: 12, pizzaConfig: { size: 'large' } },
  gift:     { uid: 'l12', name: 'Gift card', itemId: 'm-gift', qty: 1, price: 20, isGiftCard: true },
};
const NOON = Date.parse('2026-10-02T12:30:00Z');
const PAID = { id: 'P1', status: 'paid', closedAt: NOON, subtotal: 60.05, items: [L.latte, L.cake, L.cakeDisc, L.voided, L.water, L.sweet, L.misc, L.nocat, L.foreign, L.beans, L.pizza, L.gift] };
const VOIDED = { id: 'V1', status: 'void', closedAt: NOON, subtotal: 100, items: [{ uid: 'v1', name: 'Big', itemId: 'm-big', cat: 'c-food_aaaa1111', qty: 1, price: 100 }] };
const REFUNDED = { id: 'R1', status: 'refunded', closedAt: NOON + 1800000, subtotal: 3.65, items: [L.latte], refunds: [{ amount: 3.65 }] };
const RAW_VOID = { id: 'D1', voided: true, status: 'paid', closed_at: '2026-10-02T14:00:00Z', items: [{ cat: 'c-food_aaaa1111', price: 50, qty: 1 }] };
const ALL = [PAID, VOIDED, REFUNDED, RAW_VOID];

const XR = () => makeMixResolver(XERO_MAP, MIX_CATS);
const PLAIN = () => makeMixResolver({}, MIX_CATS);
const sum = (xs) => xs.reduce((s, v) => s + v, 0);
const chk = (items, extra = {}) => ({ id: `c${Math.random()}`, status: 'paid', closedAt: NOON, items, ...extra });
const line = (cat, price, extra = {}) => ({ cat, price, qty: 1, itemId: `m-${cat}-${price}`, name: `${cat} ${price}`, ...extra });
const LONDON = { timeZone: 'Europe/London', dayStart: '06:00' };

// ── 1 the basis ───────────────────────────────────────────────────────────────

test('lineSales is till price times qty: mods never added, the line discount ignored, zero and bad prices read 0', () => {
  assert.equal(lineSales(L.latte), 3.65, 'the paid extra is already inside price');
  assert.equal(lineSales(L.cake), 5.10);
  assert.equal(lineSales(L.cakeDisc), 2.55, "the line's own discount is not taken off (D3)");
  assert.equal(lineSales(L.water), 0);
  assert.equal(lineSales(L.pizza), 12);
  assert.equal(lineSales(L.gift), 20);
  assert.equal(lineSales({ price: 'abc', qty: 2 }), 0);
  assert.equal(lineSales({ price: 3, qty: 'x' }), 3, 'a qty that is not a number counts as 1');
  assert.equal(lineQty({ qty: 'x' }), 1);
  assert.equal(lineQty({}), 1);
  assert.equal(lineQty({ qty: 3 }), 3);
  assert.equal(lineSales({ price: -2, qty: 1 }), -2, 'a negative price stays negative, as Product mix');
  assert.equal(MIX_BASIS, 'item_sales');
  assert.equal(BASIS_NOTE, 'Item sales before check discounts and refunds, as Product mix. Share is the figure that matters.');
});

// ── 2 liveness ────────────────────────────────────────────────────────────────

test('isLiveCheck, isLiveLine and closedMsOf read both row shapes', () => {
  assert.equal(isLiveCheck({ status: 'void' }), false);
  assert.equal(isLiveCheck({ status: 'voided' }), false);
  assert.equal(isLiveCheck({ status: 'paid', voided: true }), false);
  assert.equal(isLiveCheck(null), false);
  for (const s of ['paid', 'refunded', 'partial_refund']) assert.equal(isLiveCheck({ status: s }), true, s);
  assert.equal(isLiveCheck({}), true, 'no status at all is a live row');
  assert.equal(isLiveLine({ price: 1, status: 'voided' }), false);
  assert.equal(isLiveLine({ price: 1, voided: true }), false);
  assert.equal(isLiveLine({ price: 1 }), true);
  assert.equal(isLiveLine(null), false);
  assert.equal(closedMsOf({ closedAt: NOON }), NOON);
  assert.equal(closedMsOf({ closed_at: '2026-10-02T12:30:00Z' }), NOON);
  assert.equal(closedMsOf({ closedAt: '2026-10-02T12:30:00Z' }), NOON, 'an ISO string under the camel key still reads');
  assert.equal(closedMsOf({}), null);
  assert.equal(closedMsOf({ closed_at: 'nonsense' }), null);
  assert.equal(closedMsOf(null), null);
});

// ── 3 the category adapter ────────────────────────────────────────────────────

test('toResolverCategories is camel first and keeps master_id from either spelling', () => {
  const store = [{ id: 1, parentId: null, parent_id: 'stale', label: 'Food', accounting_group: 'Food', accountingGroup: 'Drinks', master_id: 'c-food' }];
  const [c] = toResolverCategories(store);
  assert.deepEqual(c, { id: '1', parent_id: null, label: 'Food', accounting_group: 'Drinks', master_id: 'c-food', local: true });
  assert.equal(makeMixResolver({}, store).itemGroup({ cat: 1 }).key, 'drinks', 'the optimistic camel patch wins over the stale raw column');
  const raw = [{ id: 'c-a', parent_id: 'c-p', label: 'Raw', accounting_group: 'Food', master_id: null, location_id: 'L' }];
  assert.deepEqual(toResolverCategories(raw), [{ id: 'c-a', parent_id: 'c-p', label: 'Raw', accounting_group: 'Food', master_id: null, local: true }]);
  assert.equal(toResolverCategories([{ id: 'x', masterId: 'm-x' }])[0].master_id, 'm-x');
  assert.equal(toResolverCategories([{ id: 'x', name: 'Named' }])[0].label, 'Named');
  assert.equal(toResolverCategories([{ id: 'x' }])[0].accounting_group, '');
  assert.deepEqual(toResolverCategories([null, { id: null }, { id: 'ok' }]).map((c) => c.id), ['ok']);
  assert.deepEqual(toResolverCategories('nope'), []);
  const two = [{ id: 'a', location_id: 'L1' }, { id: 'b', location_id: 'L2' }, { id: 'c', locationId: 'L1' }];
  assert.deepEqual(categoriesOfSite(two, 'L1').map((c) => c.id), ['a', 'c']);
});

// ── 4 the resolver ────────────────────────────────────────────────────────────

test('makeMixResolver: text, parent text, Xero category override, Xero item override, missing and unknown categories', () => {
  const plain = PLAIN();
  assert.equal(plain.itemGroup(L.pizza).key, 'food', 'the category text');
  assert.equal(plain.itemGroup(L.cake).key, 'food', 'from the parent only');
  assert.equal(plain.itemGroup(L.latte).key, 'drinks', 'coffee follows Drinks with no Xero mapping');
  assert.equal(plain.itemGroup(L.beans).key, 'drinks');
  const x = XR();
  assert.equal(x.itemGroup(L.latte).key, 'hot-drinks', 'Xero categoryGroups beats the parent text');
  assert.equal(x.groupName('hot-drinks'), 'Hot drinks');
  assert.equal(x.itemGroup(L.beans).key, 'retail', 'Xero itemGroups beats both');
  assert.deepEqual(x.itemGroup(L.nocat), { key: OTHER_GROUP, catId: null, resolved: false });
  assert.deepEqual(x.itemGroup({ cats: ['c-food_aaaa1111'], price: 1 }).key, 'food', 'a cats list resolves by its first entry');
  assert.deepEqual(x.itemGroup({ cat: 'c-nobody', price: 1 }), { key: OTHER_GROUP, catId: null, resolved: false }, 'an unknown id');
  assert.equal(x.itemGroup(L.foreign).key, 'food', "another site's copy resolves through its stem");
  assert.equal(x.itemGroup(L.foreign).catId, 'c-cakes_aaaa1111', 'and names the local copy');
  const sweet = x.itemGroup(L.sweet);
  assert.deepEqual(sweet, { key: OTHER_GROUP, catId: 'c-sweets_aaaa1111', resolved: true }, "a chosen 'Other' is key other, resolved");
  assert.equal(x.groupName(OTHER_GROUP), OTHER_NAME, "other is always 'Other sales' even though Sweets says 'Other'");
  assert.equal(makeGroupResolver({}, MIX_CATS).groupName(OTHER_GROUP), 'Other sales', 'before any line is seen the base agrees');
  assert.equal(groupKeyOf(OTHER_TEXT), OTHER_GROUP, 'the dropdown writes a text whose key is other');
  assert.equal(x.categoryLabel('c-cakes_aaaa1111'), 'Cakes');
  // A mapping that is not an object is as good as none.
  assert.equal(makeMixResolver('nope', MIX_CATS).itemGroup(L.latte).key, 'drinks');
  assert.equal(makeMixResolver(null, MIX_CATS).itemGroup(L.latte).key, 'drinks');
});

test('nameAcross prefers a resolver that names the key; fallbackName gives the words when none does', () => {
  const named = makeMixResolver({ groups: { 'hot-drinks': { name: 'Hot beverages' } } }, MIX_CATS);
  assert.equal(nameAcross([PLAIN(), named], 'hot-drinks'), 'Hot beverages');
  assert.equal(nameAcross([PLAIN(), XR()], 'hot-drinks'), 'Hot drinks', "the Xero name 'Hot drinks' is the fallback words, so the key's own words come back");
  assert.equal(nameAcross([PLAIN()], 'cold-drinks'), 'Cold drinks');
  assert.equal(nameAcross([], 'retail'), 'Retail');
  assert.equal(nameAcross([XR()], OTHER_GROUP), OTHER_NAME);
  assert.equal(fallbackName(OTHER_GROUP), OTHER_NAME);
  assert.equal(fallbackName('hot-drinks'), 'Hot drinks');
  assert.equal(fallbackName(''), '');
  const fam = catFamilyKey(XR());
  assert.equal(fam('c-cakes_aaaa1111'), 'c-cakes', 'a local copy by its master id');
  assert.equal(fam('c-cakes_bbbb2222'), 'c-cakes', "another site's copy by its stem");
  assert.equal(fam('c-nobody_cccc3333'), 'c-nobody', 'an unknown id by its stem');
});

// ── 5 the accumulator ─────────────────────────────────────────────────────────

test('mixFromChecks: voided checks and lines add nothing, refunds count in full, unresolved is by the resolved flag', () => {
  const one = mixFromChecks([PAID], XR());
  assert.equal(r2(one.total), 60.05);
  assert.equal(one.checks, 1);
  const all = mixFromChecks(ALL, XR());
  assert.equal(r2(all.total), 63.70, 'the refunded latte counts in full');
  assert.equal(all.checks, 2, 'only live checks are counted');
  assert.equal(all.lines, 12);
  assert.equal(all.qty, 13);
  assert.equal(r2(all.unresolved), 26, 'misc 4 + no category 2 + gift card 20; the chosen Other (sweet) is resolved');
  const money = Object.fromEntries([...all.groups.values()].map((g) => [g.key, r2(g.money)]));
  assert.deepEqual(money, { 'hot-drinks': 7.30, food: 22.20, drinks: 0, other: 27.20, retail: 7 });
  assert.equal(all.groups.get('food').items.size, 3, 'm-cake, the foreign copy, m-pizza');
  assert.equal(all.groups.get('hot-drinks').lines, 2);
  assert.deepEqual([...all.groups.get('food').cats.values()].map((c) => [c.id, c.label, r2(c.money)]).sort(), [['c-cakes_aaaa1111', 'Cakes', 10.20], ['c-food_aaaa1111', 'Food', 12]]);
  assert.deepEqual([...all.groups.get('other').cats.values()].map((c) => [c.id, c.label]).sort((a, b) => a[1].localeCompare(b[1])), [['c-misc_aaaa1111', 'Misc'], [null, NO_CAT_LABEL], ['c-sweets_aaaa1111', 'Sweets']]);
  // A check with no items list, or a line that is not an object, is harmless.
  const m = newMix();
  addCheckToMix(m, { status: 'paid', items: 'nope' }, XR());
  addCheckToMix(m, { status: 'paid', items: [null, undefined, 7] }, XR());
  assert.equal(m.checks, 1);
  assert.equal(m.total, 0);
  // Items are distinct by itemId, then id, then the lower cased name.
  const n = newMix();
  addLineToMix(n, { name: 'Scone', price: 1 }, XR());
  addLineToMix(n, { name: 'scone', price: 1 }, XR());
  addLineToMix(n, { id: 'row-1', name: 'Scone', price: 1 }, XR());
  assert.equal(n.groups.get(OTHER_GROUP).items.size, 2);
  // An unknown category id is kept as its own bucket, labelled so.
  const u = newMix();
  addLineToMix(u, { cat: 'c-ghost', price: 2 }, XR());
  assert.deepEqual([...u.groups.get(OTHER_GROUP).cats.values()], [{ id: 'c-ghost', label: UNKNOWN_CAT_LABEL, money: 2, qty: 1 }]);
  // catKeyOf merges two venues' copies of one category.
  const fam = newMix();
  addLineToMix(fam, L.cake, XR(), catFamilyKey(XR()));
  addLineToMix(fam, L.foreign, XR(), catFamilyKey(XR()));
  assert.equal(fam.groups.get('food').cats.size, 1);
  assert.equal(r2([...fam.groups.get('food').cats.values()][0].money), 7.65);
});

// ── 6 shares ──────────────────────────────────────────────────────────────────

test('wholeShares adds to exactly 100 by largest remainder', () => {
  assert.deepEqual(wholeShares([62.4, 30.6, 7.0]), [62, 31, 7]);
  assert.deepEqual(wholeShares([1, 1, 1]), [34, 33, 33], 'the earlier index wins a tie');
  assert.deepEqual(wholeShares([50, 50]), [50, 50]);
  assert.deepEqual(wholeShares([0, 0]), [0, 0], 'a zero total is all zeros');
  assert.deepEqual(wholeShares([]), []);
  assert.deepEqual(wholeShares([5, -3, 5]), [50, 0, 50], 'a negative counts as 0');
  assert.deepEqual(wholeShares([0.1, 99.9]), [0, 100]);
  assert.deepEqual(wholeShares([1, 0, 0]), [100, 0, 0]);
  const r = rng(7);
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(r() * 7);
    const vals = Array.from({ length: n }, () => Math.round(r() * 10000) / 100);
    const out = wholeShares(vals);
    if (sum(vals) > 0) assert.equal(sum(out), 100, `vector ${i}: ${vals.join(',')}`);
    assert.ok(out.every((v) => Number.isInteger(v) && v >= 0));
  }
  assert.equal(ptsText(3), '+3 pts');
  assert.equal(ptsText(-2), '-2 pts');
  assert.equal(ptsText(0), '0 pts');
  assert.equal(ptsText(null), '');
  assert.equal(ptsText(undefined), '');
});

// ── 7 mixView ─────────────────────────────────────────────────────────────────

test('mixView: money desc with Other sales last even when biggest, whole shares, tones by key', () => {
  const v = mixView(mixFromChecks(ALL, XR()), null, XR());
  assert.equal(v.basis, 'item_sales');
  assert.equal(v.total, 63.70);
  assert.equal(v.cmp_total, null);
  assert.deepEqual(v.groups.map((g) => g.key), ['food', 'hot-drinks', 'retail', 'drinks', 'other']);
  assert.deepEqual(v.groups.map((g) => g.name), ['Food', 'Hot drinks', 'Retail', 'Drinks', 'Other sales']);
  assert.deepEqual(v.groups.map((g) => g.share), [35, 11, 11, 0, 43]);
  assert.equal(sum(v.groups.map((g) => g.share)), 100);
  assert.deepEqual(v.groups.map((g) => g.pts), [null, null, null, null, null], 'no comparison, no points');
  assert.deepEqual(v.groups.map((g) => g.cmp_share), [null, null, null, null, null]);
  assert.deepEqual(v.groups.map((g) => g.tone), ['acc', 'red', 'orn', 'blu', 't3'], 'fixed tones by key; hot-drinks takes the first cycle tone no fixed key holds');
  assert.equal(v.unresolved, 26);
  assert.equal(v.unresolved_share, 41);
  assert.equal(v.items, 10);
  assert.equal(v.qty, 13);
  assert.equal(v.lines, 12);
  assert.equal(v.checks, 2);
  const food = v.groups[0];
  assert.equal(food.money, 22.20);
  assert.equal(food.qty, 5);
  assert.equal(food.items, 3);
  assert.equal(food.avg_price, 4.44);
  assert.equal(food.unresolved, 0);
  assert.deepEqual(food.categories, [{ id: 'c-food_aaaa1111', label: 'Food', money: 12, qty: 1, share: 54 }, { id: 'c-cakes_aaaa1111', label: 'Cakes', money: 10.20, qty: 4, share: 46 }]);
  const drinks = v.groups[3];
  assert.equal(drinks.money, 0);
  assert.equal(drinks.avg_price, 0, 'water at 0 over one unit');
  const other = v.groups[4];
  assert.equal(other.unresolved, 26);
  assert.equal(other.money, 27.20);
  // An empty mix is a sound, empty block.
  const empty = mixView(newMix(), null, XR());
  assert.deepEqual(empty, { basis: 'item_sales', total: 0, cmp_total: null, qty: 0, lines: 0, checks: 0, items: 0, unresolved: 0, unresolved_share: 0, groups: [] });
  assert.deepEqual(mixView(null, null, XR()).groups, []);
});

test('mixView comparison: shares against the comparison period, points, a group only in the comparison, cmp_total 0', () => {
  const r = PLAIN();
  const cur = mixFromChecks([chk([line('c-food_aaaa1111', 62), line('c-drinks_aaaa1111', 38)])], r);
  const cmp = mixFromChecks([chk([line('c-food_aaaa1111', 59), line('c-drinks_aaaa1111', 41)])], r);
  const v = mixView(cur, cmp, r);
  assert.equal(v.cmp_total, 100);
  assert.deepEqual(v.groups.map((g) => [g.key, g.share, g.cmp_share, g.pts]), [['food', 62, 59, 3], ['drinks', 38, 41, -3]]);
  assert.deepEqual(v.groups.map((g) => g.cmp_money), [59, 41]);
  // A group only in the comparison appears with money 0 and negative points, and no average price.
  const cmp2 = mixFromChecks([chk([line('c-food_aaaa1111', 50), line('c-drinks_aaaa1111', 40), line('c-sweets_aaaa1111', 10, { accounting_group: 'x' })])], r);
  const v2 = mixView(cur, cmp2, r);
  const other = v2.groups.find((g) => g.key === OTHER_GROUP);
  assert.deepEqual([other.money, other.share, other.cmp_money, other.cmp_share, other.pts, other.avg_price, other.qty, other.categories], [0, 0, 10, 10, -10, null, 0, []]);
  assert.equal(v2.groups[v2.groups.length - 1].key, OTHER_GROUP);
  // An empty comparison: cmp_total 0, every cmp_share 0 and no points.
  const v3 = mixView(cur, newMix(), r);
  assert.equal(v3.cmp_total, 0);
  assert.deepEqual(v3.groups.map((g) => [g.cmp_share, g.pts]), [[0, null], [0, null]]);
  // Points are whole percent minus whole percent.
  assert.ok(v.groups.every((g) => Number.isInteger(g.pts)));
  // Categories inside a group: top 3 of 4 by money, share of the GROUP over all four.
  const r4 = makeMixResolver({}, [
    { id: 'f', parent_id: null, label: 'Food', accounting_group: 'Food' },
    { id: 'f1', parent_id: 'f', label: 'Mains' }, { id: 'f2', parent_id: 'f', label: 'Sides' }, { id: 'f3', parent_id: 'f', label: 'Soups' }, { id: 'f4', parent_id: 'f', label: 'Breads' },
  ]);
  const v4 = mixView(mixFromChecks([chk([line('f1', 10), line('f2', 5), line('f3', 3), line('f4', 2)])], r4), null, r4);
  assert.deepEqual(v4.groups[0].categories.map((c) => [c.label, c.money, c.share]), [['Mains', 10, 50], ['Sides', 5, 25], ['Soups', 3, 15]]);
  assert.deepEqual(mixView(mixFromChecks([chk([line('f1', 10), line('f2', 5)])], r4), null, r4, { topCats: 1 }).groups[0].categories.map((c) => c.label), ['Mains']);
  // nameOf replaces the resolver's names, except for Other sales.
  const v5 = mixView(cur, null, r, { nameOf: (k) => `X ${k}` });
  assert.deepEqual(v5.groups.map((g) => g.name), ['X food', 'X drinks']);
  assert.equal(mixView(mixFromChecks([chk([line(null, 1)])], r), null, r, { nameOf: () => 'nope' }).groups[0].name, OTHER_NAME);
});

test('tonesFor: fixed by key, custom keys take the first free cycle tone, then the spare', () => {
  assert.deepEqual(GROUP_TONES, { food: 'acc', drinks: 'blu', alcohol: 'red', retail: 'orn', other: 't3' });
  assert.deepEqual(tonesFor(['food', 'drinks', 'other']), { food: 'acc', drinks: 'blu', other: 't3' });
  assert.deepEqual(tonesFor(['food', 'hot-drinks', 'other']), { food: 'acc', 'hot-drinks': 'blu', other: 't3' });
  assert.deepEqual(tonesFor(['a', 'b', 'c', 'd', 'e']), { a: 'acc', b: 'blu', c: 'orn', d: 'red', e: TONE_SPARE });
  assert.deepEqual(tonesFor(['hot-drinks', 'alcohol', 'cold-drinks']), { 'hot-drinks': 'acc', alcohol: 'red', 'cold-drinks': 'blu' });
  assert.deepEqual(tonesFor([]), {});
  assert.deepEqual(TONE_CYCLE, ['acc', 'blu', 'orn', 'red']);
});

// ── 8 the Product mix invariant ───────────────────────────────────────────────

test('groups, categories and lines add up to one total, to the penny (generated checks)', () => {
  const r = rng(42);
  const checks = Array.from({ length: 50 }, (_, i) => generatedCheck(r, `g${i}`, 1 + (i % 12)));
  const resolver = makeMixResolver(xeroMapping(), CATEGORIES);
  const mix = mixFromChecks(checks, resolver);
  const v = mixView(mix, null, resolver);
  const lines = checks.flatMap((c) => c.items).filter(isLiveLine).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 1), 0);
  assert.ok(lines > 0);
  assert.equal(v.total, r2(lines), 'the block total is the sum of price times qty');
  assert.equal(r2(sum(v.groups.map((g) => g.money))), r2(lines), 'the groups add to it');
  assert.equal(r2(sum([...mix.groups.values()].flatMap((g) => [...g.cats.values()].map((c) => c.money)))), r2(lines), 'and so do the categories');
  assert.equal(sum(v.groups.map((g) => g.share)), 100);
  assert.equal(v.checks, checks.length);
  assert.equal(sum(v.groups.map((g) => g.qty)), v.qty);
  assert.equal(sum(v.groups.map((g) => g.lines)), v.lines);
  // The Xero override on the Drinks root puts coffee in hot-drinks; Food comes from its text.
  assert.deepEqual(v.groups.map((g) => g.key).sort(), ['food', 'hot-drinks', 'other']);
  assert.equal(v.groups.find((g) => g.key === 'hot-drinks').name, 'Hot drinks');
});

// Product mix (reports/ProductMix.jsx) does not export its maths, so its rule is repeated here
// as it is written there (the items pass and the categories pass): a check counts unless its
// status is 'voided', a line counts unless i.voided, and a line is (i.price || 0) * (i.qty || 1).
// Over the same Back Office rows, Product mix's items, Product mix's categories, the groups and
// the groups' categories must all add to ONE total (D3). The source pins at the end keep the two
// rules in step: a change to Product mix's basis fails this test, not a customer's reconciliation.
test('Product mix and Sales mix add to one total for the same checks: its rule repeated, its source pinned', () => {
  const productMixItems = (checks) => {
    let totalRev = 0;
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const qty = i.qty || 1;
        const rev = (i.price || 0) * qty;
        totalRev += rev;
      });
    });
    return totalRev;
  };
  const productMixCategories = (checks) => {
    const map = {};
    checks.filter(c => c.status !== 'voided').forEach(c => {
      (c.items || []).forEach(i => {
        if (i.voided) return;
        const key = i.cat || '__uncat';
        const qty = i.qty || 1;
        map[key] = (map[key] || 0) + (i.price || 0) * qty;
      });
    });
    return map;
  };
  // Back Office rows: a voided check carries status 'voided' (the shell normalises the Deno row).
  const r = rng(7);
  const generated = Array.from({ length: 60 }, (_, i) => generatedCheck(r, `p${i}`, 1 + (i % 12)));
  const checks = [...generated, { ...generated[0], id: 'void-1', status: 'voided' }];
  const resolver = makeMixResolver(xeroMapping(), CATEGORIES);
  const pmTotal = productMixItems(checks);
  const pmCats = productMixCategories(checks);
  assert.ok(pmTotal > 0);
  assert.equal(r2(sum(Object.values(pmCats))), r2(pmTotal), 'Product mix: its items and its categories agree');
  const v = mixView(mixFromChecks(checks, resolver), null, resolver, { topCats: Infinity });
  assert.equal(v.total, r2(pmTotal), 'the Sales mix total is the Product mix total');
  assert.equal(r2(sum(v.groups.map((g) => g.money))), r2(pmTotal), 'the groups add to it');
  assert.equal(r2(sum(v.groups.flatMap((g) => g.categories.map((c) => c.money)))), r2(pmTotal), 'the categories inside the groups add to it');
  // Category by category too: Product mix's '__uncat' is the mix's "No category" (id null); every
  // other id is the same id (no foreign copy in this set, so the local id IS the raw id).
  const mixByCat = new Map();
  for (const g of v.groups) for (const c of g.categories) { const k = c.id ?? '__uncat'; mixByCat.set(k, (mixByCat.get(k) || 0) + c.money); }
  assert.deepEqual([...mixByCat.keys()].sort(), Object.keys(pmCats).sort());
  for (const [k, rev] of Object.entries(pmCats)) assert.equal(r2(mixByCat.get(k)), r2(rev), `category ${k}`);
  // This file's own fixture rows too (a priced mod, a line discount, a voided line, a zero price,
  // a foreign copy, a gift card, a refunded check): one total under both rules.
  const bo = [PAID, { ...VOIDED, status: 'voided' }, REFUNDED];
  const plain = PLAIN();
  const vb = mixView(mixFromChecks(bo, plain), null, plain, { topCats: Infinity });
  assert.equal(vb.total, r2(productMixItems(bo)));
  assert.equal(r2(sum(Object.values(productMixCategories(bo)))), vb.total);
  assert.equal(r2(sum(vb.groups.flatMap((g) => g.categories.map((c) => c.money)))), vb.total);
  // Source pins: Product mix still works to the rule repeated above, in its items pass and its categories pass.
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../backoffice/sections/reports/ProductMix.jsx'), 'utf8');
  const count = (re) => (src.match(re) || []).length;
  assert.ok(count(/checks\.filter\(c => c\.status !== 'voided'\)/g) >= 2, 'a check counts unless its status is voided');
  assert.ok(count(/if \(i\.voided\) return;/g) >= 2, 'a voided line adds nothing');
  assert.ok(count(/const qty = i\.qty \|\| 1;/g) >= 2, 'qty defaults to 1');
  assert.equal(count(/const rev = \(i\.price \|\| 0\) \* qty;/g), 2, 'rev is price times qty, nothing taken off, mods never added (items and categories)');
  assert.ok(src.includes("const key = i.cat || '__uncat';"), 'categories are keyed by the raw cat id');
});

// ── 9 mixRollup ───────────────────────────────────────────────────────────────

test('mixRollup adds venues of one currency per key, keeps the first proper name, recomputes shares and points', () => {
  const named = makeMixResolver({ groups: { 'hot-drinks': { name: 'Hot beverages' } }, categoryGroups: { 'c-coffee_aaaa1111': 'hot-drinks' } }, MIX_CATS);
  const plain = PLAIN();
  const a = mixView(
    mixFromChecks([chk([line('c-food_aaaa1111', 60), line('c-coffee_aaaa1111', 40), line(null, 10)])], named),
    mixFromChecks([chk([line('c-food_aaaa1111', 50), line('c-coffee_aaaa1111', 50)])], named), named,
  );
  const b = mixView(
    mixFromChecks([chk([line('c-food_aaaa1111', 30), line('c-drinks_aaaa1111', 10)])], plain),
    mixFromChecks([chk([line('c-food_aaaa1111', 20), line('c-drinks_aaaa1111', 20)])], plain), plain,
  );
  const r = mixRollup([b, a]);
  assert.equal(r.total, 150);
  assert.equal(r.cmp_total, 140);
  assert.equal(r.qty, 5);
  assert.equal(r.lines, 5);
  assert.equal(r.checks, 2);
  assert.equal(r.unresolved, 10);
  assert.equal(r.unresolved_share, 7);
  assert.deepEqual(r.groups.map((g) => [g.key, g.name, g.money, g.cmp_money]), [['food', 'Food', 90, 70], ['hot-drinks', 'Hot beverages', 40, 50], ['drinks', 'Drinks', 10, 20], ['other', OTHER_NAME, 10, 0]]);
  assert.equal(sum(r.groups.map((g) => g.share)), 100);
  assert.deepEqual(r.groups.map((g) => g.share), [60, 27, 7, 6]);
  assert.deepEqual(r.groups.map((g) => g.cmp_share), [50, 36, 14, 0]);
  assert.deepEqual(r.groups.map((g) => g.pts), [10, -9, -7, 6]);
  assert.ok(r.groups.every((g) => g.categories.length === 0), 'venue ids differ, so no categories');
  assert.deepEqual(r.groups.map((g) => g.tone), ['acc', 'orn', 'blu', 't3']);
  assert.equal(r.groups.find((g) => g.key === 'food').avg_price, 45);
  // nameOf wins over the blocks' names; other stays Other sales.
  assert.deepEqual(mixRollup([a, b], { nameOf: (k) => k.toUpperCase() }).groups.map((g) => g.name), ['FOOD', 'HOT-DRINKS', 'DRINKS', OTHER_NAME]);
  // cmp_total is null only when no block has one; a block without a comparison still adds its money.
  const noCmp = mixView(mixFromChecks([chk([line('c-food_aaaa1111', 5)])], plain), null, plain);
  assert.equal(mixRollup([noCmp]).cmp_total, null);
  assert.equal(mixRollup([noCmp]).groups[0].pts, null);
  assert.equal(mixRollup([noCmp, b]).cmp_total, 40);
  assert.equal(mixRollup([]), null);
  assert.equal(mixRollup([null, undefined]), null);
  assert.equal(mixRollup(null), null);
  const one = mixRollup([a]);
  assert.deepEqual(one.groups.map((g) => [g.key, g.money, g.share]), a.groups.map((g) => [g.key, g.money, g.share]), 'one block rolls up to itself');
});

// ── 10 the owner bar ──────────────────────────────────────────────────────────

test('barSegments folds everything past the top two into one segment; mixWords and ptsText give the card its words', () => {
  const r = makeMixResolver({}, [
    { id: 'f', label: 'Food', accounting_group: 'Food' }, { id: 'd', label: 'Drinks', accounting_group: 'Drinks' },
    { id: 'a', label: 'Bar', accounting_group: 'Alcohol' }, { id: 'r', label: 'Shop', accounting_group: 'Retail' },
  ]);
  const five = mixView(
    mixFromChecks([chk([line('f', 50), line('d', 30), line('a', 10), line('r', 5), line(null, 5)])], r),
    mixFromChecks([chk([line('f', 45), line('d', 30), line('a', 15), line('r', 5), line(null, 5)])], r), r,
  );
  const segs = barSegments(five);
  assert.deepEqual(segs, [
    { key: 'food', name: 'Food', share: 50, pts: 5, tone: 'acc' },
    { key: 'drinks', name: 'Drinks', share: 30, pts: 0, tone: 'blu' },
    { key: 'rest', name: 'Other', share: 20, pts: -5, tone: 't3' },
  ]);
  assert.equal(sum(segs.map((s) => s.share)), 100);
  assert.equal(mixWords(segs), 'Food 50%  Drinks 30%  Other 20%');
  // One named group plus Other sales: the fold is that single group, with its own name and tone.
  const two = mixView(mixFromChecks([chk([line('f', 60), line(null, 40)])], r), null, r);
  assert.deepEqual(barSegments(two), [{ key: 'food', name: 'Food', share: 60, pts: null, tone: 'acc' }, { key: 'other', name: OTHER_NAME, share: 40, pts: null, tone: 't3' }]);
  // Two named groups and no Other sales.
  const twoNamed = mixView(mixFromChecks([chk([line('f', 62), line('d', 38)])], r), null, r);
  assert.deepEqual(barSegments(twoNamed).map((s) => [s.name, s.share]), [['Food', 62], ['Drinks', 38]]);
  // Three named, the third alone in the fold keeps its name.
  const three = mixView(mixFromChecks([chk([line('f', 62), line('d', 31), line('a', 7)])], r), null, r);
  assert.deepEqual(barSegments(three).map((s) => [s.key, s.name, s.share, s.tone]), [['food', 'Food', 62, 'acc'], ['drinks', 'Drinks', 31, 'blu'], ['alcohol', 'Alcohol', 7, 'red']], 'the group is named by its text, not the category label');
  // Four: the fold is 'Other' in grey.
  const four = mixView(mixFromChecks([chk([line('f', 62), line('d', 31), line('a', 4), line('r', 3)])], r), null, r);
  assert.equal(mixWords(barSegments(four)), 'Food 62%  Drinks 31%  Other 7%');
  // Nothing named: one Other sales segment.
  const none = mixView(mixFromChecks([chk([line(null, 9)])], r), null, r);
  assert.deepEqual(barSegments(none), [{ key: 'other', name: OTHER_NAME, share: 100, pts: null, tone: 't3' }]);
  // A group with no money this period (only in the comparison) is dropped from the bar.
  const zero = mixView(mixFromChecks([chk([line('f', 60), line(null, 40)])], r), mixFromChecks([chk([line('d', 10)])], r), r);
  assert.deepEqual(barSegments(zero).map((s) => s.key), ['food', 'other']);
  assert.deepEqual(barSegments(mixView(newMix(), null, r)), []);
  assert.deepEqual(barSegments(null), []);
  assert.equal(mixWords([{ name: 'Food', share: 62 }, { name: 'Drinks', share: 31 }, { name: 'Other', share: 7 }]), 'Food 62%  Drinks 31%  Other 7%');
  assert.equal(mixWords([]), '');
  // max 2: one head group plus the fold.
  assert.deepEqual(barSegments(five, 2).map((s) => [s.name, s.share]), [['Food', 50], ['Other', 50]]);
});

// ── 11 the nudges ─────────────────────────────────────────────────────────────

test('needsSetup above half unresolved; allOther only when every live penny is unresolved', () => {
  const block = (total, unresolved, unresolved_share) => ({ total, unresolved, unresolved_share });
  assert.equal(needsSetup(block(100, 50, 50)), false);
  assert.equal(needsSetup(block(100, 51, 51)), true);
  assert.equal(needsSetup(block(0, 0, 0)), false);
  assert.equal(needsSetup(null), false);
  assert.equal(allOther(block(100, 100, 100)), true);
  assert.equal(allOther(block(100, 99.996, 100)), true, 'rounding noise does not hide an all other block');
  assert.equal(allOther(block(100, 99, 99)), false);
  assert.equal(allOther(block(0, 0, 0)), false);
  assert.equal(allOther(undefined), false);
  const r = PLAIN();
  assert.equal(allOther(mixView(mixFromChecks([chk([line(null, 3), line('c-misc_aaaa1111', 2)])], r), null, r)), true);
  assert.equal(allOther(mixView(mixFromChecks([chk([line(null, 3), line('c-sweets_aaaa1111', 2)])], r), null, r)), false, "a chosen 'Other' is set up, not missing");
});

// ── 12 the series ─────────────────────────────────────────────────────────────

test('mixSeriesLines: business days on the venue clock, hours from the day start on one day, line level groups', () => {
  const r = PLAIN();
  const at = (iso, items) => chk(items, { closedAt: Date.parse(iso) });
  const days = mixSeriesLines([
    at('2026-10-01T10:00:00Z', [line('c-food_aaaa1111', 10)]),
    at('2026-10-02T00:00:00Z', [line('c-drinks_aaaa1111', 5)]),           // 01:00 London: still 1 Oct's business day
    at('2026-10-02T12:00:00Z', [line('c-food_aaaa1111', 20), line('c-drinks_aaaa1111', 7), line(null, 3)]),
    { status: 'paid', items: [line('c-food_aaaa1111', 99)] },             // no close time: skipped
    { status: 'voided', closedAt: Date.parse('2026-10-02T12:00:00Z'), items: [line('c-food_aaaa1111', 99)] },
  ], r, LONDON);
  assert.equal(days.isHourly, false);
  assert.deepEqual(days.xKeys, ['2026-10-01', '2026-10-02']);
  assert.deepEqual(days.keys, ['food', 'drinks', 'other']);
  assert.deepEqual(days.series['2026-10-01'], { key: '2026-10-01', total: 15, food: 10, drinks: 5, other: 0 });
  assert.deepEqual(days.series['2026-10-02'], { key: '2026-10-02', total: 30, food: 20, drinks: 7, other: 3 }, 'one check feeds three groups in one bucket');
  // One business day: hourly keys ordered from the day start (06:00 first, 05:00 last).
  const hours = mixSeriesLines([
    at('2026-10-02T05:30:00Z', [line('c-food_aaaa1111', 4)]),   // 06:30 London
    at('2026-10-02T23:30:00Z', [line('c-drinks_aaaa1111', 2)]), // 00:30 London on 3 Oct, still 2 Oct's day
    at('2026-10-03T03:00:00Z', [line('c-food_aaaa1111', 1)]),   // 04:00 London
    at('2026-10-03T04:30:00Z', [line('c-food_aaaa1111', 1)]),   // 05:30 London
    at('2026-10-02T11:00:00Z', [line('c-drinks_aaaa1111', 0)]), // 12:00, a free water: an empty bucket
  ], r, LONDON);
  assert.equal(hours.isHourly, true);
  assert.deepEqual(hours.xKeys, ['6', '12', '0', '4', '5']);
  assert.equal(hours.series['6'].food, 4);
  assert.equal(hours.series['12'].total, 0);
  // Forced days on one day, and forced hours over two days.
  assert.equal(mixSeriesLines([at('2026-10-02T11:00:00Z', [line('c-food_aaaa1111', 1)])], r, LONDON, { hourly: false }).isHourly, false);
  assert.deepEqual(mixSeriesLines([at('2026-10-02T11:00:00Z', [line('c-food_aaaa1111', 1)])], r, LONDON, { hourly: false }).xKeys, ['2026-10-02']);
  const forced = mixSeriesLines([at('2026-10-01T10:00:00Z', [line('c-food_aaaa1111', 1)]), at('2026-10-02T10:00:00Z', [line('c-food_aaaa1111', 1)])], r, LONDON, { hourly: true });
  assert.equal(forced.isHourly, true);
  assert.deepEqual(forced.xKeys, ['11']);
  assert.equal(forced.series['11'].food, 2);
  // Nothing: empty and daily.
  assert.deepEqual(mixSeriesLines([], r, LONDON), { series: {}, xKeys: [], isHourly: false, keys: [] });
  // A midnight day start reads hours from 0; no clock at all is London midnight.
  const mid = mixSeriesLines([at('2026-10-02T22:30:00Z', [line('c-food_aaaa1111', 1)]), at('2026-10-02T08:00:00Z', [line('c-food_aaaa1111', 1)])], r, { timeZone: 'Europe/London', dayStart: '00:00' });
  assert.deepEqual(mid.xKeys, ['9', '23']);
  // Shares per bucket: 100 in a bucket with sales, 0 in an empty one.
  const sh = shareSeries(hours);
  assert.equal(sh.isHourly, true);
  assert.deepEqual(sh.xKeys, hours.xKeys);
  assert.deepEqual(sh.keys, hours.keys);
  assert.deepEqual(sh.series['6'], { key: '6', total: 100, food: 100, drinks: 0 });
  assert.deepEqual(sh.series['12'], { key: '12', total: 0, food: 0, drinks: 0 });
  const shDays = shareSeries(days);
  assert.deepEqual(shDays.series['2026-10-02'], { key: '2026-10-02', total: 100, food: 67, drinks: 23, other: 10 });
  assert.deepEqual(shareSeries(null), { series: {}, xKeys: [], isHourly: false, keys: [] });
});

// ── 13 and 14 the clock helpers ───────────────────────────────────────────────

test('bandOf: Morning from the day start to 10:59, Midday, Afternoon, Evening from 17:00 and before the day start', () => {
  const name = (h, start) => bandOf(h, start).id;
  assert.deepEqual([6, 10].map((h) => name(h, 6)), ['morning', 'morning']);
  assert.deepEqual([11, 13].map((h) => name(h, 6)), ['midday', 'midday']);
  assert.deepEqual([14, 16].map((h) => name(h, 6)), ['afternoon', 'afternoon']);
  assert.deepEqual([17, 23, 2].map((h) => name(h, 6)), ['evening', 'evening', 'evening']);
  assert.equal(name(0, 0), 'morning', 'a midnight day start has no hours before it');
  assert.equal(name(5, 0), 'morning');
  assert.equal(name(10, 11), 'evening', 'a day that starts at 11 never has a Morning');
  assert.deepEqual(DAY_BANDS.map((b) => b.name), ['Morning', 'Midday', 'Afternoon', 'Evening']);
  assert.deepEqual(DAY_BANDS.map((b) => b.sub), ['before 11:00', '11:00 to 14:00', '14:00 to 17:00', 'from 17:00']);
  assert.equal(BANDS_NOTE, 'Morning before 11:00, Midday 11:00 to 14:00, Afternoon 14:00 to 17:00, Evening from 17:00.');
});

test('shiftOf: start inclusive, end exclusive, overnight honoured, bad times skipped; clockMinutes', () => {
  const shifts = [{ id: 'b', name: 'Breakfast', start: '06:00', end: '11:30' }, { name: 'Lunch', start: '11:30', end: '15:00' }, { name: 'Late', start: '18:00', end: '02:00' }, { name: 'Broken', start: 'x', end: '09:00' }];
  const london = (hhmm) => Date.parse(`2026-10-02T${hhmm}:00+01:00`); // BST
  assert.equal(shiftOf(london('11:29'), shifts, 'Europe/London')?.name, 'Breakfast');
  assert.equal(shiftOf(london('11:30'), shifts, 'Europe/London')?.name, 'Lunch', 'the end is exclusive, the next start inclusive');
  assert.equal(shiftOf(london('06:00'), shifts, 'Europe/London')?.name, 'Breakfast');
  assert.equal(shiftOf(london('01:30'), shifts, 'Europe/London')?.name, 'Late', 'an overnight period holds the small hours');
  assert.equal(shiftOf(london('16:00'), shifts, 'Europe/London'), null, 'outside every period');
  assert.equal(shiftOf(london('08:00'), [shifts[3]], 'Europe/London'), null, 'a broken time never matches');
  assert.equal(shiftOf(NaN, shifts, 'Europe/London'), null);
  assert.equal(shiftOf(london('08:00'), [], 'Europe/London'), null);
  assert.equal(shiftOf(london('08:00'), null, 'Europe/London'), null);
  assert.equal(clockMinutes('06:30'), 390);
  assert.equal(clockMinutes('23:59:30'), 1439);
  assert.equal(clockMinutes('24:00'), null);
  assert.equal(clockMinutes('6'), null);
  assert.equal(clockMinutes(null), null);
});

// ── 15 dayparts ───────────────────────────────────────────────────────────────

test('daypartSplit: by service period with an Outside row only when needed, else the four bands', () => {
  const r = PLAIN();
  const london = (hhmm, items) => chk(items, { closedAt: Date.parse(`2026-10-02T${hhmm}:00+01:00`) });
  const shifts = [{ id: 'bf', name: 'Breakfast', start: '06:00', end: '11:30' }, { name: 'Lunch', start: '11:30', end: '15:00' }];
  const checks = [
    london('11:29', [line('c-food_aaaa1111', 10), line('c-drinks_aaaa1111', 10)]),
    london('11:30', [line('c-food_aaaa1111', 30), line(null, 10)]),
    london('20:00', [line('c-drinks_aaaa1111', 40)]),
    { status: 'voided', closedAt: Date.parse('2026-10-02T10:00:00Z'), items: [line('c-food_aaaa1111', 99)] },
    { status: 'paid', items: [line('c-food_aaaa1111', 99)] },
  ];
  const s = daypartSplit(checks, r, LONDON, shifts);
  assert.equal(s.mode, 'shifts');
  assert.deepEqual(s.keys, ['drinks', 'food', 'other']);
  assert.deepEqual(s.rows.map((x) => [x.id, x.name, x.sub]), [['bf', 'Breakfast', '06:00 to 11:30'], ['Lunch', 'Lunch', '11:30 to 15:00'], [OUTSIDE_ID, OUTSIDE_NAME, '']]);
  assert.deepEqual(s.rows.map((x) => x.total), [20, 40, 40]);
  assert.deepEqual(s.rows.map((x) => x.share), [20, 40, 40]);
  assert.deepEqual(s.rows[0].groups, { drinks: 10, food: 10, other: 0 });
  assert.deepEqual(s.rows[0].shares, { drinks: 50, food: 50, other: 0 });
  assert.deepEqual(s.rows[1].shares, { drinks: 0, food: 75, other: 25 });
  assert.deepEqual(s.outside, { count: 1, money: 40 });
  for (const row of s.rows) assert.equal(sum(Object.values(row.shares)), 100);
  assert.equal(sum(s.rows.map((x) => x.share)), 100);
  // No check outside the periods: no Outside row.
  const inside = daypartSplit(checks.slice(0, 2), r, LONDON, shifts);
  assert.deepEqual(inside.rows.map((x) => x.id), ['bf', 'Lunch']);
  assert.deepEqual(inside.outside, { count: 0, money: 0 });
  // A period with no sales still has its row, with zeros.
  assert.deepEqual(daypartSplit(checks.slice(0, 1), r, LONDON, shifts).rows.map((x) => [x.id, x.total, x.share]), [['bf', 20, 100], ['Lunch', 0, 0]]);
  // Bands: always four rows, outside stays empty; a 20:00 and a 02:00 sale are both Evening.
  const b = daypartSplit([...checks, london('02:00', [line('c-food_aaaa1111', 5)])], r, LONDON, []);
  assert.equal(b.mode, 'bands');
  assert.deepEqual(b.rows.map((x) => [x.id, x.name, x.sub, x.total]), [['morning', 'Morning', 'before 11:00', 0], ['midday', 'Midday', '11:00 to 14:00', 60], ['afternoon', 'Afternoon', '14:00 to 17:00', 0], ['evening', 'Evening', 'from 17:00', 45]]);
  assert.deepEqual(b.outside, { count: 0, money: 0 });
  assert.equal(sum(b.rows.map((x) => x.share)), 100);
  // Only broken shifts count as none; a null shifts list is bands.
  assert.equal(daypartSplit(checks, r, LONDON, [{ start: 'x', end: 'y' }]).mode, 'bands');
  assert.equal(daypartSplit(checks, r, LONDON, null).mode, 'bands');
  // Nothing sold: bands rows at zero, shares zero.
  const none = daypartSplit([], r, LONDON, []);
  assert.deepEqual(none.rows.map((x) => [x.total, x.share]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(none.keys, []);
});

// ── 16 reconcile ──────────────────────────────────────────────────────────────

test('reconcile: the stored subtotals against the lines', () => {
  const r = PLAIN();
  const even = [chk([line('c-food_aaaa1111', 6.65)], { subtotal: 6.65 }), chk([line('c-food_aaaa1111', 2), line('c-food_aaaa1111', 3)], { subtotal: 5 })];
  const mix = mixView(mixFromChecks(even, r), null, r);
  assert.deepEqual(reconcile(even, mix.total), { subtotal: 11.65, off: 0, diff: 0 });
  const off = [chk([line('c-food_aaaa1111', 6.65)], { subtotal: 14.65 })];
  assert.deepEqual(reconcile(off, mixView(mixFromChecks(off, r), null, r).total), { subtotal: 14.65, off: 1, diff: 8 });
  // Voided checks and lines play no part; a missing subtotal reads 0.
  const mixed = [...off, { status: 'void', subtotal: 50, items: [line('c-food_aaaa1111', 50)] }, chk([line('c-food_aaaa1111', 1, { voided: true })], { subtotal: 0 })];
  assert.deepEqual(reconcile(mixed, 6.65), { subtotal: 14.65, off: 1, diff: 8 });
  assert.deepEqual(reconcile([], 0), { subtotal: 0, off: 0, diff: 0 });
});

// ── 17 the setup list ─────────────────────────────────────────────────────────

test('setupRows: top level categories with their text, sales, sub categories and Xero overrides', () => {
  const x = XR();
  const mix = mixFromChecks(ALL, x);
  const s = setupRows(MIX_CATS, XERO_MAP, mix, x);
  assert.equal(s.total, 4);
  assert.equal(s.unset, 1, "Misc has no group; Sweets' 'Other' counts as set");
  assert.equal(s.itemOverrides, 1);
  assert.deepEqual(s.rows.map((r) => [r.id, r.label, r.text, r.key, r.set, r.money]), [
    ['c-food_aaaa1111', 'Food', 'Food', 'food', true, 22.20],
    ['c-drinks_aaaa1111', 'Drinks', 'Drinks', 'drinks', true, 14.30],
    ['c-misc_aaaa1111', 'Misc', '', '', false, 4],
    ['c-sweets_aaaa1111', 'Sweets', 'Other', 'other', true, 1.2],
  ]);
  assert.equal(sum(s.rows.map((r) => r.share)), 100);
  assert.deepEqual(s.rows.map((r) => r.share), [53, 34, 10, 3]);
  assert.deepEqual(s.rows.map((r) => [r.subCount, r.subOwn]), [[2, 1], [2, 0], [0, 0], [0, 0]], "Vegan has its own group; Tea's 'drinks' is its parent's key");
  assert.deepEqual(s.rows.map((r) => r.xero), [null, null, null, null], 'the Xero override on Coffee is on a sub category, not a row');
  // A Xero override on a top level row is flagged with the mapping's name for that group.
  const top = { groups: { 'hot-drinks': { name: 'Hot beverages' } }, categoryGroups: { 'c-drinks_aaaa1111': 'hot-drinks' } };
  const tr = makeMixResolver(top, MIX_CATS);
  const s2 = setupRows(MIX_CATS, top, mixFromChecks(ALL, tr), tr);
  assert.deepEqual(s2.rows.find((r) => r.id === 'c-drinks_aaaa1111').xero, { key: 'hot-drinks', name: 'Hot beverages' });
  assert.equal(s2.itemOverrides, 0);
  // Ties in money sort by label; an empty mix gives zero money and shares.
  const s3 = setupRows(MIX_CATS, {}, newMix(), PLAIN());
  assert.deepEqual(s3.rows.map((r) => r.label), ['Drinks', 'Food', 'Misc', 'Sweets']);
  assert.deepEqual(s3.rows.map((r) => [r.money, r.share]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
  // Store shaped rows (camel keys) work the same.
  const storeRows = MIX_CATS.map((c) => ({ id: c.id, parentId: c.parent_id, label: c.label, accountingGroup: c.accounting_group, master_id: c.master_id }));
  assert.equal(setupRows(storeRows, {}, newMix(), PLAIN()).unset, 1);
  assert.deepEqual(setupRows([], {}, newMix(), PLAIN()), { rows: [], total: 0, unset: 0, itemOverrides: 0 });
  // A cycle in parent ids does not hang.
  const loop = [{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }, { id: 't', parent_id: null, label: 'Top' }];
  assert.equal(setupRows(loop, {}, newMix(), makeMixResolver({}, loop)).total, 1);
  // The dropdown options and the texts they write.
  assert.deepEqual(SUGGESTED_GROUPS, ['Food', 'Drinks', 'Alcohol', 'Retail', 'Other']);
  assert.deepEqual(SETUP_OPTIONS.map((o) => o.value), ['', 'Food', 'Drinks', 'Alcohol', 'Retail', 'Other']);
  assert.equal(SETUP_OPTIONS[SETUP_OPTIONS.length - 1].label, 'Other sales');
  assert.equal(optionFor(''), '');
  assert.equal(optionFor('   '), '');
  assert.equal(optionFor('food'), 'Food');
  assert.equal(optionFor('FOOD '), 'Food');
  assert.equal(optionFor('Other'), 'Other');
  assert.equal(optionFor('Hot drinks'), 'custom');
  assert.equal(optionFor('Beverages'), 'custom');
});

// ── 18 words ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The two long dashes, built from their codes so this file carries neither of them itself.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const NOT_APPLICABLE = new RegExp('N' + String.fromCharCode(0x2f) + 'A');

test('words: no long dash and no shorthand for not applicable anywhere in salesMix.js', () => {
  const src = read('supabase/functions/_shared/salesMix.js');
  assert.doesNotMatch(src, LONG_DASHES, 'no long dashes (Peter reads with commas and full stops)');
  assert.doesNotMatch(src, NOT_APPLICABLE, 'never the shorthand for not applicable');
  for (const w of [OTHER_NAME, BASIS_NOTE, BANDS_NOTE, OUTSIDE_NAME, NO_CAT_LABEL, UNKNOWN_CAT_LABEL, ...DAY_BANDS.map((b) => b.sub), ...SETUP_OPTIONS.map((o) => o.label)]) {
    assert.doesNotMatch(w, LONG_DASHES, w);
  }
  // And none of the Sales mix library files written for this build.
  for (const f of ['src/lib/salesGroupsMapping.js', 'src/backoffice/sections/reports/_siteMappings.js', 'src/backoffice/sections/reports/_salesMixData.js', 'src/lib/salesMix.test.js', 'src/lib/salesGroupsMapping.test.js']) {
    assert.doesNotMatch(read(f), LONG_DASHES, `${f} has no long dashes`);
  }
});

// ── 19 deploy ─────────────────────────────────────────────────────────────────

const repoIo = {
  read,
  exists: (p) => { try { return fs.statSync(path.join(ROOT, p)).isFile(); } catch { return false; } },
  list: (d) => { try { return fs.readdirSync(path.join(ROOT, d)); } catch { return []; } },
};

test('deploy: salesMix.js and accountingGroups.js import nothing outside _shared, so npm test loads what ships', () => {
  for (const f of ['salesMix.js', 'accountingGroups.js', 'businessDay.js']) {
    const src = read(`supabase/functions/_shared/${f}`);
    assert.doesNotMatch(src, /from\s+['"](?!\.\/)/, `${f} has no outside imports`);
  }
  assert.ok(sharedDepsOf('owner-snapshot', repoIo).includes('supabase/functions/_shared/ownerSnapshot.js'));
});

// _shared/ownerSnapshot.js imports './salesMix.js' (8 Oct 2026, the owner app's mix), so the
// owner-snapshot bundle carries it, and accountingGroups.js with it (scripts/edgeFnDeps.mjs).
test('deploy: owner-snapshot ships salesMix.js and accountingGroups.js', () => {
  const deps = sharedDepsOf('owner-snapshot', repoIo);
  for (const f of ['salesMix.js', 'accountingGroups.js', 'ownerSnapshot.js', 'businessDay.js']) {
    assert.ok(deps.includes(`supabase/functions/_shared/${f}`), `owner-snapshot ships ${f}`);
  }
});
