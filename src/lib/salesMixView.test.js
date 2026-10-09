/**
 * salesMixView.test.js: the Sales mix screens' view maths (src/lib/salesMixView.js), tested
 * without React. The money maths itself is pinned in src/lib/salesMix.test.js; here it is the
 * shaping: tiles, table rows, CSV rows, the strip, the slip, the setup panel's words and the
 * rules for the callout and the auto opening panel.
 * Run: `npm test`, or `node --test src/lib/salesMixView.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeMixResolver, mixView, mixFromChecks, mixSeriesLines, setupRows, NEGATIVE_NOTE } from '../../supabase/functions/_shared/salesMix.js';
import {
  BASIS_CSV, STRIP_NOTE, SUMS_NOTE, CUSTOM_OPTION, KPI_MAX_GROUPS,
  toneVar, csvDate, seenKey, isOneDay, joinNames, cutName, changePct, compareUsable, negativeNote,
  kpiTiles, groupTableRows, groupTotals, allGroupKeys, reconcileWords,
  calloutFor, mappingHasOverrides, shouldAutoOpen, needsSetupNames,
  mergeSeries, siteMatrixRows,
  GROUPS_CSV_COLUMNS, groupsCsvRows, CATEGORIES_CSV_COLUMNS, categoriesCsvRows, GROUPS_BY_SITE_CSV_COLUMNS, groupsBySiteCsvRows,
  stripModel, slipModel, SLIP_VOID_NOTE,
  setupOptionList, setupRowsAsShown, setupValueFor, stagedChanges, saveLabel, savedToast, notSavedToast, saveFailure, setupStatus, subWords, subOwnWords,
} from './salesMixView.js';
import { toCsv } from '../backoffice/sections/reports/_csv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(HERE, p), 'utf8');

// ── fixtures ──────────────────────────────────────────────────────────────────

const CATS = [
  { id: 'c-food', parent_id: null, label: 'Food', accounting_group: 'Food', master_id: null },
  { id: 'c-cakes', parent_id: 'c-food', label: 'Cakes', accounting_group: '', master_id: null },
  { id: 'c-drinks', parent_id: null, label: 'Drinks', accounting_group: 'Drinks', master_id: null },
  { id: 'c-coffee', parent_id: 'c-drinks', label: 'Coffee', accounting_group: '', master_id: null },
  { id: 'c-misc', parent_id: null, label: 'Misc', accounting_group: '', master_id: null },
];
const line = (cat, price, qty = 1, extra = {}) => ({ itemId: `m-${cat}-${price}`, name: `${cat} ${price}`, cat, price, qty, ...extra });
const check = (closedAt, items, extra = {}) => ({ id: `k${closedAt}`, status: 'paid', closedAt, subtotal: items.reduce((s, i) => s + i.price * (i.qty || 1), 0), items, ...extra });
const T0 = Date.parse('2026-10-02T12:30:00Z');

const resolver = makeMixResolver({}, CATS);
// Food 62 (cakes 12 + food 50), Drinks 31 (coffee 21 + drinks 10), Misc 7 unresolved: 100 in all.
const CHECKS = [
  check(T0, [line('c-food', 50), line('c-cakes', 6, 2), line('c-coffee', 7, 3)]),
  check(T0 + 3600e3, [line('c-drinks', 10), line('c-misc', 7)]),
];
const PREV = [check(T0 - 7 * 86400e3, [line('c-food', 59), line('c-coffee', 41)])];
const view = () => mixView(mixFromChecks(CHECKS, resolver), mixFromChecks(PREV, resolver), resolver, { topCats: Infinity });
const fmt = (n) => `£${(Number(n) || 0).toFixed(2)}`;

// ── small helpers ─────────────────────────────────────────────────────────────

test('words and keys: tone vars, csv date, session key, one day range, joined names, cut names', () => {
  assert.equal(toneVar('acc'), 'var(--acc)');
  assert.equal(toneVar(null), 'var(--t3)', 'a tone nobody set draws grey, like Other sales (the one toneVar in salesMix.js)');
  assert.equal(csvDate(new Date('2026-10-08T23:30:00Z')), '2026-10-08');
  assert.equal(seenKey('leeds'), 'salesmix.setup.seen.leeds');
  assert.equal(isOneDay({ fromDay: '2026-10-02', toDay: '2026-10-02' }), true);
  assert.equal(isOneDay({ fromDay: '2026-10-01', toDay: '2026-10-02' }), false);
  assert.equal(isOneDay(null), false);
  assert.equal(joinNames(['Leeds']), 'Leeds');
  assert.equal(joinNames(['Leeds', 'Preston']), 'Leeds and Preston');
  assert.equal(joinNames(['Leeds', 'Preston', 'Barnsley']), 'Leeds, Preston and Barnsley');
  assert.equal(cutName('Smoothies | Shakes | Coolers'), 'Smoothies | Shakes |…');
  assert.ok(cutName('Smoothies | Shakes | Coolers').length <= 22);
  assert.equal(cutName('Food'), 'Food');
  assert.equal(changePct(110, 100), 10);
  assert.equal(changePct(90, 100), -10);
  assert.equal(changePct(50, 0), null);
  assert.equal(changePct(50, null), null);
});

// ── the band ──────────────────────────────────────────────────────────────────

test('kpiTiles: Item sales first, then the groups in view order, Other sales last and warn when most sales have no group', () => {
  const v = view();
  const tiles = kpiTiles(v);
  assert.equal(tiles[0].kind, 'total');
  assert.equal(tiles[0].label, 'Item sales');
  assert.equal(tiles[0].money, 100);
  assert.equal(tiles[0].cmp_money, 100);
  assert.deepEqual(tiles.slice(1).map((t) => t.key), ['food', 'drinks', 'other']);
  assert.deepEqual(tiles.slice(1).map((t) => t.share), [62, 31, 7]);
  assert.equal(tiles[1].pts, 3);        // Food 62 vs 59
  assert.equal(tiles[2].pts, -10);      // Drinks 31 vs 41
  assert.equal(tiles[3].warn, false);   // 7% unresolved is not "most"
  assert.equal(tiles[3].label, 'Other sales');
  // many groups: the top five by money plus Other sales, never more than six group tiles
  const many = { total: 100, unresolved_share: 60, groups: [...Array.from({ length: 8 }, (_, i) => ({ key: `g${i}`, name: `G${i}`, share: 10, money: 10 })), { key: 'other', name: 'Other sales', share: 20, money: 20 }] };
  const t2 = kpiTiles(many);
  assert.equal(t2.length, 1 + KPI_MAX_GROUPS);
  assert.deepEqual(t2.slice(1).map((t) => t.key), ['g0', 'g1', 'g2', 'g3', 'g4', 'other']);
  assert.equal(t2[6].warn, true);
  assert.deepEqual(kpiTiles(null), []);
});

// ── the table ─────────────────────────────────────────────────────────────────

test('groupTableRows: groups in order, categories only under an open group, shares of the total and of the group', () => {
  const v = view();
  const closed = groupTableRows(v, new Set());
  assert.deepEqual(closed.map((r) => r.kind), ['group', 'group', 'group']);
  assert.deepEqual(closed.map((r) => r.name), ['Food', 'Drinks', 'Other sales']);
  assert.equal(closed[0].open, false);
  assert.equal(closed[0].catCount, 2);
  assert.equal(closed[2].unresolved, 7);
  const open = groupTableRows(v, new Set(['food']));
  assert.deepEqual(open.map((r) => r.kind), ['group', 'cat', 'cat', 'group', 'group']);
  assert.equal(open[0].open, true);
  assert.equal(open[1].label, 'Food');          // 50 before Cakes 12
  assert.equal(open[1].money, 50);
  assert.equal(open[1].shareOfTotal, 50);
  assert.equal(open[1].shareOfGroup, 81);       // 50 of 62
  assert.equal(open[2].label, 'Cakes');
  assert.equal(open[2].shareOfGroup, 19);
  assert.equal(open[2].avg, 6);                 // 12 over 2
  assert.equal(open[1].groupName, 'Food');
  assert.ok(open.every((r) => typeof r.id === 'string' && r.id));
  assert.deepEqual(allGroupKeys(v), ['food', 'drinks', 'other']);
  const all = groupTableRows(v, new Set(allGroupKeys(v)));
  assert.equal(all.filter((r) => r.kind === 'cat').length, 5);
  assert.deepEqual(groupTableRows(null), []);
  // 8 Oct 2026 (review finding 4): a group's categories take the group's whole share between them,
  // so a group with one category shows it at the group's own share (Drinks 16, Coffee 16: not
  // 7.30 of 44.50 rounded on its own), and every group's categories add up to the group.
  const siteA = mixView(mixFromChecks([check(T0, [line('c-food', 37.2), line('c-coffee', 7.3)])], resolver), null, resolver, { topCats: Infinity });
  const rowsA = groupTableRows(siteA, new Set(allGroupKeys(siteA)));
  const drinksA = rowsA.find((r) => r.kind === 'group' && r.key === 'drinks');
  const coffeeA = rowsA.find((r) => r.kind === 'cat' && r.label === 'Coffee');
  assert.equal(coffeeA.shareOfTotal, drinksA.share);
  assert.equal(coffeeA.shareOfGroup, 100);
  for (const g of rowsA.filter((r) => r.kind === 'group')) {
    const cats = rowsA.filter((r) => r.kind === 'cat' && r.groupKey === g.key);
    assert.equal(cats.reduce((t, c) => t + c.shareOfTotal, 0), g.share, `${g.key}: the categories add up to the group`);
  }
  // Three equal categories under a group at 10: 4, 3, 3 (never 3, 3, 3 against a group that reads 10).
  const r3 = makeMixResolver({}, [{ id: 'f', parent_id: null, label: 'Food', accounting_group: 'Food' }, { id: 'a', parent_id: 'f', label: 'A' }, { id: 'b', parent_id: 'f', label: 'B' }, { id: 'c', parent_id: 'f', label: 'C' }, { id: 'd', parent_id: null, label: 'Drinks', accounting_group: 'Drinks' }]);
  const v3 = mixView(mixFromChecks([check(T0, [line('a', 1), line('b', 1), line('c', 1), line('d', 27)])], r3), null, r3, { topCats: Infinity });
  assert.equal(v3.groups.find((g) => g.key === 'food').share, 10);
  const food3 = groupTableRows(v3, new Set(['food'])).filter((r) => r.kind === 'cat');
  assert.deepEqual(food3.map((r) => r.shareOfTotal), [4, 3, 3]);
});

test('groupTotals and the reconcile words', () => {
  const v = view();
  assert.deepEqual(groupTotals(v), { total: 100, qty: 8, avg: 12.5, items: 5 });   // 5 distinct items
  assert.deepEqual(groupTotals({ total: 0, qty: 0, items: 0 }), { total: 0, qty: 0, avg: null, items: 0 });
  const rec = (o) => ({ gross: o.subtotal, voided: 0, voidedSubtotal: 0, ...o });
  assert.equal(reconcileWords(rec({ subtotal: 100, off: 0, diff: 0 }), fmt), 'Equals Gross sales on the Z report: £100.00.');
  assert.equal(reconcileWords(rec({ subtotal: 108, off: 1, diff: 8 }), fmt), 'Gross sales on the Z report is £108.00; the lines differ by £8.00 (1 check whose stored subtotal is not the sum of their lines).');
  assert.equal(reconcileWords(rec({ subtotal: 108, off: 2, diff: 8 }), fmt), 'Gross sales on the Z report is £108.00; the lines differ by £8.00 (2 checks whose stored subtotal is not the sum of their lines).');
  assert.equal(reconcileWords(null, fmt), '');
  // 8 Oct 2026 (review finding 2): with a void in the period the Z report's Gross sales holds it and the
  // groups do not, so the line names the voided checks as the known difference, never a false "Equals".
  const oneVoid = { gross: 144.5, voided: 1, voidedSubtotal: 100, subtotal: 44.5, off: 0, diff: 0 };
  assert.equal(reconcileWords(oneVoid, fmt), 'Gross sales on the Z report is £144.50; less 1 voided check (£100.00), the lines equal £44.50.');
  assert.equal(reconcileWords({ gross: 164.5, voided: 2, voidedSubtotal: 120, subtotal: 44.5, off: 0, diff: 0 }, fmt),
    'Gross sales on the Z report is £164.50; less 2 voided checks (£120.00), the lines equal £44.50.');
  assert.equal(reconcileWords({ gross: 152.5, voided: 1, voidedSubtotal: 100, subtotal: 52.5, off: 1, diff: 8 }, fmt),
    'Gross sales on the Z report is £152.50; less 1 voided check (£100.00) it is £52.50, and the lines differ by £8.00 (1 check whose stored subtotal is not the sum of their lines).');
  assert.doesNotMatch(reconcileWords(oneVoid, fmt), /^Equals/, 'no "Equals" when a void is in the period');
});

test('compareUsable and negativeNote: no comparison when the previous period did not load; the negative line only when needed', () => {
  // 8 Oct 2026 (review finding 5): the chips say "Not loaded", so the mix must have no comparison at all.
  assert.equal(compareUsable({ label: 'vs last week', loaded: false }), false);
  assert.equal(compareUsable({ label: 'vs last week' }), true);
  assert.equal(compareUsable({ label: 'vs last week', loaded: true }), true);
  assert.equal(compareUsable(null), false);
  assert.equal(compareUsable(undefined), false);
  // A view built with no comparison writes blank previous cells (the CSV test above pins the columns).
  const noCmp = mixView(mixFromChecks(CHECKS, resolver), null, resolver);
  assert.ok(groupsCsvRows(noCmp, {}).every((r) => r.hasCmp === false && r.pts === null));
  // (review finding 9): wholeShares counts a negative line as 0, and the footnote says so only then.
  assert.equal(negativeNote(view()), null);
  const neg = mixView(mixFromChecks([check(T0, [line('c-food', 100), line('c-drinks', -40)])], resolver), null, resolver);
  assert.deepEqual(neg.groups.map((g) => [g.key, g.money, g.share]), [['food', 100, 100], ['drinks', -40, 0]]);
  assert.equal(negativeNote(neg), NEGATIVE_NOTE);
  assert.equal(NEGATIVE_NOTE, 'Lines with a negative price count in the money, not in the shares.');
  assert.equal(negativeNote(null), null);
});

// ── callout, notes, auto open ─────────────────────────────────────────────────

test('calloutFor: most / some / other site / none', () => {
  assert.deepEqual(calloutFor({ total: 100, unresolved_share: 7 }, { isHome: true, siteName: 'Leeds' }), { kind: 'some', n: 7, siteName: 'Leeds' });
  assert.deepEqual(calloutFor({ total: 100, unresolved_share: 51 }, { isHome: true, siteName: 'Leeds' }), { kind: 'most', n: 51, siteName: 'Leeds' });
  assert.deepEqual(calloutFor({ total: 100, unresolved_share: 50 }, { isHome: true }).kind, 'some');
  assert.deepEqual(calloutFor({ total: 100, unresolved_share: 100 }, { isHome: false, siteName: 'Preston' }), { kind: 'other', n: 100, siteName: 'Preston' });
  assert.equal(calloutFor({ total: 100, unresolved_share: 0 }, { isHome: true }), null);
  assert.equal(calloutFor({ total: 0, unresolved_share: 0 }, { isHome: true }), null);
  assert.equal(calloutFor(null), null);
});

test('mappingHasOverrides: a category or an item set in Xero step 3', () => {
  assert.equal(mappingHasOverrides({}), false);
  assert.equal(mappingHasOverrides(null), false);
  assert.equal(mappingHasOverrides({ categoryGroups: {}, itemGroups: {} }), false);
  assert.equal(mappingHasOverrides({ categoryGroups: { 'c-coffee': 'hot-drinks' } }), true);
  assert.equal(mappingHasOverrides({ itemGroups: { 'm-beans': 'retail' } }), true);
});

test('shouldAutoOpen: home site, menu loaded, categories, more than half unresolved, not seen', () => {
  const most = { total: 100, unresolved_share: 60 };
  const ok = { isHome: true, menuLoading: false, hasCategories: true, view: most, seen: false };
  assert.equal(shouldAutoOpen(ok), true);
  assert.equal(shouldAutoOpen({ ...ok, isHome: false }), false);
  assert.equal(shouldAutoOpen({ ...ok, menuLoading: true }), false);
  assert.equal(shouldAutoOpen({ ...ok, hasCategories: false }), false);
  assert.equal(shouldAutoOpen({ ...ok, seen: true }), false);
  assert.equal(shouldAutoOpen({ ...ok, view: { total: 100, unresolved_share: 50 } }), false);
  assert.equal(shouldAutoOpen({ ...ok, view: { total: 0, unresolved_share: 0 } }), false);
  assert.deepEqual(needsSetupNames([{ name: 'Leeds' }, { name: 'Preston' }], (p) => (p.name === 'Leeds' ? most : { total: 100, unresolved_share: 0 })), ['Leeds']);
});

// ── several sites ─────────────────────────────────────────────────────────────

test('mergeSeries: buckets added across sites, days ascending, keys by money with Other sales last', () => {
  const clock = { timeZone: 'Europe/London', dayStart: '06:00' };
  const a = mixSeriesLines(CHECKS, resolver, clock, { hourly: false });
  const b = mixSeriesLines([check(T0 + 86400e3, [line('c-misc', 40), line('c-food', 1)])], resolver, clock, { hourly: false });
  const m = mergeSeries([a, b]);
  assert.equal(m.isHourly, false);
  assert.deepEqual(m.xKeys, ['2026-10-02', '2026-10-03']);
  assert.equal(m.series['2026-10-02'].total, 100);
  assert.equal(m.series['2026-10-03'].total, 41);
  assert.equal(m.series['2026-10-03'].other, 40);
  assert.equal(m.series['2026-10-02'].drinks, 31);
  assert.equal(m.series['2026-10-03'].drinks, 0);        // every key on every bucket
  assert.deepEqual(m.keys, ['food', 'drinks', 'other']);  // food 63, other 47, drinks 31: other still last
  // hourly: the first list's order of hours is kept
  const h1 = mixSeriesLines(CHECKS, resolver, clock, { hourly: true });
  const h2 = mixSeriesLines([check(T0 - 5 * 3600e3, [line('c-food', 3)])], resolver, clock, { hourly: true });
  const mh = mergeSeries([h1, h2]);
  assert.equal(mh.isHourly, true);
  assert.deepEqual(mh.xKeys, ['13', '14', '8']);
  assert.deepEqual(mergeSeries([]), { series: {}, xKeys: [], isHourly: false, keys: [] });
});

test('siteMatrixRows: item sales per group per site with an Item sales total row, and each group share per site', () => {
  const leeds = view();
  const preston = mixView(mixFromChecks([check(T0, [line('c-drinks', 30), line('c-food', 10)])], resolver), null, resolver);
  const block = { total: 140, groups: [
    { key: 'food', name: 'Food', money: 72, share: 51 }, { key: 'drinks', name: 'Drinks', money: 61, share: 44 }, { key: 'other', name: 'Other sales', money: 7, share: 5 },
  ] };
  const m = siteMatrixRows(block, [{ id: 'L', view: leeds }, { id: 'P', view: preston }]);
  assert.deepEqual(m.money.map((r) => r.key), ['food', 'drinks', 'other', '__total']);
  assert.deepEqual(m.money[0].bySite, { L: 62, P: 10 });
  assert.deepEqual(m.money[1].bySite, { L: 31, P: 30 });
  assert.deepEqual(m.money[2].bySite, { L: 7, P: 0 });
  assert.equal(m.money[3].label, 'Item sales');
  assert.equal(m.money[3].strong, true);
  assert.deepEqual(m.money[3].bySite, { L: 100, P: 40 });
  assert.equal(m.money[3].total, 140);
  assert.deepEqual(m.share.map((r) => r.total), [51, 44, 5]);
  assert.deepEqual(m.share[0].bySite, { L: 62, P: 25 });
  assert.deepEqual(m.share[1].bySite, { L: 31, P: 75 });
  assert.deepEqual(m.share[2].bySite, { L: 7, P: 0 });
});

// ── CSV ───────────────────────────────────────────────────────────────────────

test('groups CSV: the spec columns in order, a row per group, Total last, money to 2dp, blanks where there is no comparison', () => {
  assert.deepEqual(GROUPS_CSV_COLUMNS.map((c) => c.label), ['Group', 'Group key', 'Item sales', 'Share %', 'Previous item sales', 'Change %', 'Share change pts', 'Qty', 'Avg price', 'Items', 'Unresolved item sales', 'Basis', 'Period from', 'Period to', 'Currency']);
  const rows = groupsCsvRows(view(), { from: '2026-10-02', to: '2026-10-02', currency: 'GBP' });
  const csv = toCsv(rows, GROUPS_CSV_COLUMNS).split('\r\n');
  assert.equal(csv.length, 5);
  assert.equal(csv[1], `Food,food,62.00,62,59.00,5.08,3,3,20.67,2,0.00,${BASIS_CSV},2026-10-02,2026-10-02,GBP`);   // qty 3: food 1 + cakes 2
  assert.equal(csv[2], `Drinks,drinks,31.00,31,41.00,-24.39,-10,4,7.75,2,0.00,${BASIS_CSV},2026-10-02,2026-10-02,GBP`);
  assert.equal(csv[3], `Other sales,other,7.00,7,0.00,,7,1,7.00,1,7.00,${BASIS_CSV},2026-10-02,2026-10-02,GBP`);   // 7% now, 0% before: +7 pts
  assert.equal(csv[4], `Total,,100.00,100,100.00,0.00,,8,12.50,5,7.00,${BASIS_CSV},2026-10-02,2026-10-02,GBP`);
  // no comparison at all: the previous, change and points cells are blank
  const noCmp = mixView(mixFromChecks(CHECKS, resolver), null, resolver);
  const r2 = toCsv(groupsCsvRows(noCmp, {}), GROUPS_CSV_COLUMNS).split('\r\n');
  assert.equal(r2[1], `Food,food,62.00,62,,,,3,20.67,2,0.00,${BASIS_CSV},,,`);
  assert.deepEqual(groupsCsvRows(null), []);
});

test('categories CSV: every category of every group with its share of the total and of the group', () => {
  assert.deepEqual(CATEGORIES_CSV_COLUMNS.map((c) => c.label), ['Group', 'Category', 'Category id', 'Item sales', 'Share of total %', 'Share of group %', 'Qty', 'Avg price', 'Basis', 'Period from', 'Period to', 'Currency']);
  const csv = toCsv(categoriesCsvRows(view(), { from: 'a', to: 'b', currency: 'GBP' }), CATEGORIES_CSV_COLUMNS).split('\r\n');
  assert.equal(csv.length, 6);
  assert.equal(csv[1], `Food,Food,c-food,50.00,50,81,1,50.00,${BASIS_CSV},a,b,GBP`);
  assert.equal(csv[2], `Food,Cakes,c-cakes,12.00,12,19,2,6.00,${BASIS_CSV},a,b,GBP`);
  assert.equal(csv[3], `Drinks,Coffee,c-coffee,21.00,21,68,3,7.00,${BASIS_CSV},a,b,GBP`);
  assert.equal(csv[5], `Other sales,Misc,c-misc,7.00,7,100,1,7.00,${BASIS_CSV},a,b,GBP`);
});

test('groups by site CSV: rows tagged with the site for exportSites, the site range as the period', () => {
  assert.deepEqual(GROUPS_BY_SITE_CSV_COLUMNS.map((c) => c.label), ['Currency', 'Group', 'Group key', 'Item sales', 'Share %', 'Qty', 'Avg price', 'Items', 'Unresolved item sales', 'Basis', 'Period from', 'Period to']);
  const part = { id: 'L', name: 'Coffee Boy Leeds', currency: 'GBP', site: { range: { fromDay: '2026-10-01', toDay: '2026-10-02' } } };
  const rows = groupsBySiteCsvRows(part, view());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].siteName, 'Coffee Boy Leeds');
  assert.equal(rows[0].siteId, 'L');
  const csv = toCsv(rows, GROUPS_BY_SITE_CSV_COLUMNS).split('\r\n');
  assert.equal(csv[1], `GBP,Food,food,62.00,62,3,20.67,2,0.00,${BASIS_CSV},2026-10-01,2026-10-02`);
  assert.deepEqual(groupsBySiteCsvRows(part, null), []);
});

// ── the strip and the slip ────────────────────────────────────────────────────

test('stripModel: every group as a segment, the aria words, the hint per state, nothing for an empty period', () => {
  const m = stripModel(view());
  assert.deepEqual(m.segments.map((s) => [s.key, s.share, s.money, s.tone]), [['food', 62, 62, 'acc'], ['drinks', 31, 31, 'blu'], ['other', 7, 7, 't3']]);
  assert.equal(m.words, 'Food 62%  Drinks 31%  Other sales 7%');
  assert.equal(m.hint, null);
  assert.equal(m.allOther, false);
  // most unresolved
  const most = mixView(mixFromChecks([check(T0, [line('c-misc', 60), line('c-food', 40)])], resolver), null, resolver);
  assert.equal(stripModel(most).hint, 'most');
  // nothing set up at all
  const all = mixView(mixFromChecks([check(T0, [line('c-misc', 60)])], resolver), null, resolver);
  const am = stripModel(all);
  assert.equal(am.hint, 'all');
  assert.equal(am.allOther, true);
  assert.deepEqual(am.segments.map((s) => s.name), ['Other sales']);
  // the menu could not be read: one grey segment with its own hint
  const f = stripModel(view(), { failed: true });
  assert.equal(f.hint, 'failed');
  assert.deepEqual(f.segments.map((s) => [s.name, s.share, s.money, s.tone]), [['Other sales', 100, 100, 't3']]);
  assert.equal(f.words, 'Other sales 100%');
  // an empty period is nothing, even when the menu failed
  assert.equal(stripModel(mixView(mixFromChecks([], resolver), null, resolver)), null);
  assert.equal(stripModel(mixView(mixFromChecks([], resolver), null, resolver), { failed: true }), null);
  assert.equal(stripModel(null), null);
  assert.equal(STRIP_NOTE, 'Item sales before check discounts and refunds.');
  assert.equal(SUMS_NOTE, 'Pick 7 days or fewer to see the sales mix across sites.');
});

test('slipModel: a row per group with the name cut to the slip, the total, and the all other flag', () => {
  const s = slipModel(view());
  assert.deepEqual(s.rows, [{ key: 'food', name: 'Food', share: 62, money: 62 }, { key: 'drinks', name: 'Drinks', share: 31, money: 31 }, { key: 'other', name: 'Other sales', share: 7, money: 7 }]);
  assert.equal(s.total, 100);
  assert.equal(s.allOther, false);
  const longCats = [{ id: 'c-long', parent_id: null, label: 'Long', accounting_group: 'Smoothies Shakes And Coolers Group', master_id: null }];
  const r = makeMixResolver({}, longCats);
  const v = mixView(mixFromChecks([check(T0, [line('c-long', 5)])], r), null, r);
  assert.ok(slipModel(v).rows[0].name.length <= 22);
  assert.ok(slipModel(v).rows[0].name.endsWith('…'));
  assert.equal(slipModel(mixView(mixFromChecks([], resolver), null, resolver)), null);
  assert.equal(slipModel(null), null);
  const all = mixView(mixFromChecks([check(T0, [line('c-misc', 60)])], resolver), null, resolver);
  assert.equal(slipModel(all).allOther, true);
  // 8 Oct 2026 (review finding 2): the slip's Gross sales above holds voided checks; one fine print line says why these lines do not.
  assert.equal(s.voidNote, null);
  assert.equal(slipModel(view(), { voided: 0 }).voidNote, null);
  assert.equal(slipModel(view(), { voided: 2 }).voidNote, SLIP_VOID_NOTE);
  assert.equal(SLIP_VOID_NOTE, 'voided checks are not in these lines');
});

// ── the setup panel ───────────────────────────────────────────────────────────

test('setupOptionList: the suggested words, Other sales (writes Other), the custom texts already stored, then Custom', () => {
  const rows = [{ text: 'Hot drinks' }, { text: 'hot drinks' }, { text: 'Food' }, { text: '' }, { text: 'Retail' }];
  const opts = setupOptionList(rows);
  assert.deepEqual(opts.map((o) => o.value), ['', 'Food', 'Drinks', 'Alcohol', 'Retail', 'Other', 'Hot drinks', CUSTOM_OPTION]);
  assert.equal(opts.find((o) => o.value === 'Other').label, 'Other sales');
  assert.equal(opts[opts.length - 1].label, 'Custom…');
  assert.equal(setupValueFor(''), '');
  assert.equal(setupValueFor('food'), 'Food');
  assert.equal(setupValueFor('Other'), 'Other');
  assert.equal(setupValueFor('Hot drinks'), 'Hot drinks');
  // 8 Oct 2026 (review finding 10): the options come from the rows AS SHOWN, staged texts in, so a
  // custom name typed a moment ago is an option at once (else the controlled select falls back to
  // "No group yet") and can be picked on another row before Save.
  const stored = [{ id: 'c-hot', label: 'Hot', text: '' }, { id: 'c-cold', label: 'Cold', text: 'Drinks' }];
  const shown = setupRowsAsShown(stored, { 'c-hot': 'Hot drinks' });
  assert.deepEqual(shown.map((r) => [r.id, r.text]), [['c-hot', 'Hot drinks'], ['c-cold', 'Drinks']]);
  assert.equal(stored[0].text, '', 'the stored rows are not changed');
  assert.ok(setupOptionList(shown).some((o) => o.value === 'Hot drinks'), 'the staged word is an option');
  assert.ok(!setupOptionList(stored).some((o) => o.value === 'Hot drinks'), 'it was not before');
  assert.equal(setupValueFor('Hot drinks'), 'Hot drinks', 'and the select shows it');
  assert.deepEqual(setupRowsAsShown(stored, {}), stored);
  assert.deepEqual(setupRowsAsShown(stored, null), stored);
  assert.deepEqual(setupRowsAsShown(null, { x: 'y' }), []);
  // The staged word still saves as typed.
  assert.deepEqual(stagedChanges(stored, { 'c-hot': 'Hot drinks' }), [{ id: 'c-hot', label: 'Hot', text: 'Hot drinks' }]);
});

test('stagedChanges, the save button words and the toasts', () => {
  const rows = [{ id: 'a', label: 'A', text: 'Food' }, { id: 'b', label: 'B', text: '' }, { id: 'c', label: 'C', text: 'Drinks' }];
  assert.deepEqual(stagedChanges(rows, {}), []);
  assert.deepEqual(stagedChanges(rows, { a: 'Food' }), []);                       // back to what is stored
  assert.deepEqual(stagedChanges(rows, { b: 'Drinks', c: '' }), [{ id: 'b', label: 'B', text: 'Drinks' }, { id: 'c', label: 'C', text: '' }]);
  assert.equal(saveLabel(0), 'Save');
  assert.equal(saveLabel(1), 'Save 1 change');
  assert.equal(saveLabel(3), 'Save 3 changes');
  assert.equal(saveLabel(3, true), 'Saving…');
  assert.equal(savedToast(1), 'Saved 1 group');
  assert.equal(savedToast(4), 'Saved 4 groups');
  assert.equal(notSavedToast(2, 5), '2 of 5 not saved');
});

test('saveFailure: null when the write landed, plain words for conflict, refused, gone and anything else', () => {
  for (const o of ['applied', 'merged', 'already', 'noop']) assert.equal(saveFailure({ ok: true, outcome: o }), null, o);
  assert.equal(saveFailure({ ok: true }), null);
  assert.equal(saveFailure({ ok: false, outcome: 'conflict' }), 'Not saved: changed in another window. Close and reopen to see it.');
  assert.equal(saveFailure({ ok: false, outcome: 'error', refused: true }), 'Not saved: not allowed for this sign in. Finish the second step first.');
  assert.equal(saveFailure({ ok: false, outcome: 'gone' }), 'Not saved: this category is no longer at this site.');
  assert.equal(saveFailure({ ok: false, outcome: 'error' }), 'Not saved: the database did not answer. Try again.');
  assert.equal(saveFailure(undefined), 'Not saved: the database did not answer. Try again.');
});

test('setupStatus and the sub category words', () => {
  const setup = setupRows(CATS, {}, mixFromChecks(CHECKS, resolver), resolver);
  assert.deepEqual(setupStatus(setup), { ok: false, strong: '1 of 3', rest: ' top level categories have no group yet, so their sales show as Other sales.' });
  assert.deepEqual(setupStatus({ total: 3, unset: 0 }), { ok: true, strong: 'Every', rest: ' top level category has a group.' });
  assert.equal(subWords({ subCount: 0 }), 'No sub categories');
  assert.equal(subWords({ subCount: 2 }), '2 sub categories follow');
  assert.equal(subOwnWords({ subOwn: 0 }), '');
  assert.equal(subOwnWords({ subOwn: 1 }), '1 of them have their own group, set in Menu Manager.');
});

// ── words ─────────────────────────────────────────────────────────────────────

// The two long dashes, built from their codes so this file carries neither of them itself.
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('no long dashes and no "N/A" in the Sales mix screens or their view maths', () => {
  const files = [
    './salesMixView.js',
    '../backoffice/sections/reports/SalesMix.jsx',
    '../backoffice/sections/reports/SalesMixChart.jsx',
    '../backoffice/sections/reports/SalesMixSetup.jsx',
    '../backoffice/sections/reports/SalesMixStrip.jsx',
    '../backoffice/sections/reports/ZReportGroups.jsx',
  ];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, LONG_DASHES, `${f} has a long dash`);
    assert.doesNotMatch(src, /\bN\/A\b/, `${f} says N/A`);
  }
});
