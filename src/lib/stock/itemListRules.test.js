// Multi site stock Drop 1: the company Stock items list rules (src/lib/stock/itemListRules.js) and
// the house rules of the item screens in src/backoffice/sections/stock/items/ (web-items files).
// Synthetic names and amounts only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as R from './itemListRules.js';
import { sitesText } from './siteScope.js';
import { pauseWords } from './pauseRules.js';
import { toCsv } from '../../backoffice/sections/reports/_csv.js';

const S = [
  { id: 'a', name: 'Northgate', status: 'active', currency: 'GBP' },
  { id: 'b', name: 'Eastfield', status: 'active', currency: 'GBP' },
  { id: 'c', name: 'Southbank', status: 'active', currency: 'GBP' },
];
const scope = { sites: S, siteName: (id) => S.find((s) => s.id === id)?.name || '' };
const link = (location_id, extra = {}) => ({ location_id, site_item_id: `si-${location_id}`, on: true, paused: false, paused_until: null, stop_ordering_at: null,
  price_here: null, unit_price: 0.00069, unit_cost: 0.00069, on_hand: 4000, par_level: 12000, reorder_point: 6000, min_level: 2000, row_version: 3, ...extra });
const row = (extra = {}) => ({
  id: 'it-1', name: 'Test milk 2L', name_suffix: null, category: 'Dairy', category_id: 'cat-1', type: 'drink', base_unit: 'ml', sku: 'TM-1', barcode: null,
  local_location_id: null, archived_at: null, row_version: 7, paused: null,
  main: { supplier_item_id: 'sp-1', supplier_id: 'sup-1', supplier_name: 'Test Dairy Co', pack_description: '6 x 2 l', pack_price: 8.28, currency: 'GBP', unit_price: 0.00069 },
  count_pack: { id: 'p-1', name: 'bottle', qty_in_base: 2000 },
  sites: [link('a'), link('b')], sites_on: 2, stock_value: 5.52, ...extra,
});

// ── sites ──
test('siteList takes site objects or bare ids, once each, named', () => {
  assert.deepEqual(R.siteList(['a', { id: 'b', name: 'Eastfield' }, 'a', null, { id: '' }], (id) => (id === 'a' ? 'Northgate' : '')),
    [{ id: 'a', name: 'Northgate' }, { id: 'b', name: 'Eastfield' }]);
  assert.deepEqual(R.siteList(null), []);
  assert.deepEqual(R.siteList([{ id: 'x', status: 'closed' }], () => 'Old site'), [{ id: 'x', status: 'closed', name: 'Old site' }]);
});

test('sortSites: open first, then by name with numbers in order, never changes the list it is given', () => {
  const list = [{ id: '3', name: 'Site 10' }, { id: '1', name: 'site 2' }, { id: '2', name: 'Annex', status: 'closed' }, { id: '0', name: 'Site 2' }];
  const copy = structuredClone(list);
  assert.deepEqual(R.sortSites(list).map((s) => s.id), ['0', '1', '3', '2']);
  assert.deepEqual(list, copy);
  assert.deepEqual(R.sortSites(null), []);
});

test('pageSites: All sites asks for every open site (null); a group, a site or closed sites shown send their ids', () => {
  assert.equal(R.pageSites({ isAll: true, scopeIds: ['a', 'b'] }), null);
  assert.deepEqual(R.pageSites({ isAll: true, showClosed: true, scopeIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(R.pageSites({ isAll: false, scopeIds: ['b'] }), ['b']);
  assert.deepEqual(R.pageSites(), []);
});

test('checklistGroups: groups for the site ticks, only their sites in this list, empty groups dropped', () => {
  const groups = [{ id: 'g1', name: 'North', locationIds: ['a', 'z'] }, { id: 'g2', name: 'Gone', locationIds: ['z'] }, { id: 'g3', name: 'Old shape', location_ids: ['b', 'c'] }];
  assert.deepEqual(R.checklistGroups(groups, ['a', 'b', 'c']), [
    { id: 'g1', name: 'North', location_ids: ['a'] },
    { id: 'g3', name: 'Old shape', location_ids: ['b', 'c'] },
  ]);
  assert.deepEqual(R.checklistGroups(null, ['a']), []);
});

test('linkAt and onAt: a link off is not on; a site with no link is "Not here"', () => {
  const r = row({ sites: [link('a'), link('b', { on: false })] });
  assert.equal(R.onAt(r, 'a'), true);
  assert.equal(R.onAt(r, 'b'), false);
  assert.equal(R.linkAt(r, 'c'), null);
  assert.equal(R.onAt(null, 'a'), false);
});

test('rowSitesText: the mockup words (All n, k of n, a name, Local to, None here)', () => {
  const all = row({ sites: [link('a'), link('b'), link('c')] });
  assert.equal(R.rowSitesText(all, scope), 'All 3');
  assert.equal(R.rowSitesText(row(), scope), '2 of 3');
  assert.equal(R.rowSitesText(row({ sites: [link('b')] }), scope), 'Eastfield');
  assert.equal(R.rowSitesText(row({ local_location_id: 'c', sites: [link('c')] }), scope), 'Local to Southbank');
  assert.equal(R.rowSitesText(row({ sites: [link('a', { on: false })] }), scope), 'None here');
  assert.equal(R.rowSitesText(row({ sites: [] }), scope), 'None here');
  assert.equal(R.rowSitesText(row({ sites: [link('a')] }), { sites: [S[0]] }), 'Northgate', 'a scope of one site says its name');
  assert.equal(R.rowSitesText(row({ sites: [link('a'), link('x')] }), { sites: [S[0], S[1]] }), 'Northgate', 'a site outside the scope never counts');
});

test('rowSitesText says exactly what siteScope.sitesText says, for random rows (seeded)', () => {
  let seed = 20261020;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, name: `Site ${i}` }));
  const byId = new Map(many.map((s) => [s.id, s]));
  for (let run = 0; run < 400; run++) {
    const inScope = many.filter(() => rnd() < 0.7);
    if (!inScope.length) continue;
    const links = many.filter(() => rnd() < 0.5).map((s) => link(s.id, { on: rnd() < 0.8 }));
    const local = rnd() < 0.2 && links[0] ? links[0].location_id : null;
    const r = row({ sites: links, local_location_id: local });
    const theirs = sitesText({ onIds: links.filter((l) => l.on).map((l) => l.location_id), scopeIds: inScope.map((s) => s.id), siteById: byId, localId: local });
    assert.equal(R.rowSitesText(r, { sites: inScope, siteName: (id) => byId.get(id)?.name || '' }), theirs, `run ${run}`);
  }
});

test('rowPause: paused everywhere wins; one site; several sites; only an until every one of them shares', () => {
  assert.deepEqual(R.rowPause(row({ paused: { from: '2026-10-20', until: '2026-11-03' } }), scope), { everywhere: true, siteName: null, until: '2026-11-03' });
  const one = row({ sites: [link('a', { paused: true, paused_until: '2026-11-03' }), link('b')] });
  assert.deepEqual(R.rowPause(one, scope), { everywhere: false, siteName: 'Northgate', until: '2026-11-03' });
  assert.equal(pauseWords(R.rowPause(one, scope)), 'Paused at Northgate until 3 Nov');
  const two = row({ sites: [link('a', { paused: true, paused_until: '2026-11-03' }), link('b', { paused: true, paused_until: null })] });
  assert.deepEqual(R.rowPause(two, scope), { everywhere: false, siteName: '2 sites', until: null });
  assert.equal(pauseWords(R.rowPause(two, scope)), 'Paused at 2 sites');
  assert.equal(R.rowPause(row({ sites: [link('a', { paused: true, on: false })] }), scope), null, 'a site it is off at is not a pause');
  assert.equal(R.rowPause(row(), scope), null);
  assert.equal(pauseWords(R.rowPause(row({ paused: { from: null, until: null } }), scope)), 'Paused everywhere');
});

test('runningOut and isLow (on hand BELOW the reorder point, the server\'s low rule)', () => {
  const r = row({ sites: [link('a', { stop_ordering_at: '2026-10-19T10:00:00Z' }), link('b')] });
  assert.equal(R.runningOut(r, scope), true);
  assert.equal(R.runningOut(r, scope, 'b'), false);
  assert.equal(R.runningOut(row(), scope), false);
  assert.equal(R.isLow(link('a', { on_hand: 5999, reorder_point: 6000 })), true);
  assert.equal(R.isLow(link('a', { on_hand: 6000, reorder_point: 6000 })), false);
  assert.equal(R.isLow(link('a', { on_hand: 1, reorder_point: null })), false);
  assert.equal(R.isLow(link('a', { on: false, on_hand: 0, reorder_point: 5 })), false);
  assert.equal(R.isLow(null), false);
});

// ── columns and filters ──
test('listColumns: the contract words for the company view and the one site view', () => {
  assert.deepEqual(R.listColumns({ oneSite: null, multi: true }).map((c) => c.label), ['Name', 'Category', 'Type', 'Main supplier', 'Price', 'Sites', 'Stock value']);
  assert.deepEqual(R.listColumns({ oneSite: 'a', multi: true }).map((c) => c.label), ['Name', 'Category', 'Supplier here', 'Price here', 'Cost here', 'On hand', 'Par', 'Stock value']);
  assert.ok(!R.listColumns({ oneSite: null, multi: false }).some((c) => c.label === 'Sites'), 'no Sites column when not multi');
  assert.deepEqual(R.listColumns({ oneSite: 'a' }).filter((c) => c.right).map((c) => c.key), ['price_here', 'cost_here', 'on_hand', 'par', 'stock_value']);
});

test('filtersToServer: only the keys stock_items_page knows, nothing set is null', () => {
  const KNOWN = ['category_id', 'no_category', 'type', 'supplier_id', 'not_at', 'on_at', 'paused', 'running_out', 'local', 'low', 'archived'];
  assert.equal(R.filtersToServer(R.BLANK_FILTERS), null);
  assert.equal(R.filtersToServer(null), null);
  assert.deepEqual(R.filtersToServer({ category: 'cat-1', type: 'food', supplier: 'sup-1', notAt: 'b', paused: true, runningOut: true, local: true, archived: true }),
    { category_id: 'cat-1', type: 'food', supplier_id: 'sup-1', not_at: 'b', paused: true, running_out: true, local: true, archived: true });
  assert.deepEqual(R.filtersToServer({ category: 'none' }), { no_category: true });
  assert.deepEqual(R.filtersToServer({ onAt: 'a', low: true }), { on_at: 'a', low: true });
  assert.equal(R.filtersToServer({ type: 'fish' }), null, 'a type the database does not store is not sent');
  const every = R.filtersToServer({ category: 'x', type: 'drink', supplier: 'y', notAt: 'b', onAt: 'a', paused: true, runningOut: true, local: true, low: true, archived: true });
  for (const k of Object.keys(every)) assert.ok(KNOWN.includes(k), k);
});

test('filtersActive and the filter chips in the mockup order', () => {
  assert.equal(R.filtersActive(R.BLANK_FILTERS), false);
  assert.equal(R.filtersActive({ local: true }), true);
  assert.equal(R.filtersActive({ category: 'none' }), true);
  assert.deepEqual(R.FILTER_CHIPS.map((c) => c.label), ['Paused', 'Running out', 'Local', 'Archived']);
  assert.deepEqual(R.ITEM_TYPES.map((t) => t.label), ['Food', 'Drink', 'Other']);
  assert.equal(R.typeLabel('drink'), 'Drink');
  assert.equal(R.typeLabel(null), '');
});

// ── numbers in words ──
test('onHandText: in the pack people count in', () => {
  const bottle = { name: 'bottle', qty_in_base: 2000 };
  assert.equal(R.onHandText(6000, bottle), '3 bottles');
  assert.equal(R.onHandText(2000, bottle), '1 bottle');
  assert.equal(R.onHandText(3000, bottle), '1.5 bottles');
  assert.equal(R.onHandText(2.5, { name: 'kg', qty_in_base: 1 }), '2.5 kg');
  assert.equal(R.onHandText(12, { name: 'Each', qty_in_base: 1 }), '12');
  assert.equal(R.onHandText(4, { name: 'boxes', qty_in_base: 1 }), '4 boxes');
  assert.equal(R.onHandText(0, bottle), '0 bottles');
  assert.equal(R.onHandText(null, bottle), '');
  assert.equal(R.onHandText(5, null), '5');
});

test('priceInput: empty follows the company price, junk and below 0 are refused', () => {
  assert.equal(R.priceInput(''), null);
  assert.equal(R.priceInput(null), null);
  assert.equal(R.priceInput('  '), null);
  assert.equal(R.priceInput('1.45'), 1.45);
  assert.equal(R.priceInput(1.45), 1.45);
  assert.equal(R.priceInput('£1.45'), 1.45);
  assert.equal(R.priceInput('.5'), 0.5);
  assert.equal(R.priceInput('1,000.5'), 1000.5);
  assert.equal(R.priceInput('0'), 0);
  assert.ok(Number.isNaN(R.priceInput('-1')));
  assert.ok(Number.isNaN(R.priceInput('abc')));
  assert.ok(Number.isNaN(R.priceInput('1.2.3')));
});

test('amountInput and pctInput', () => {
  assert.equal(R.amountInput(''), undefined);
  assert.equal(R.amountInput(undefined), undefined);
  assert.equal(R.amountInput('6'), 6);
  assert.equal(R.amountInput(0), 0);
  assert.ok(Number.isNaN(R.amountInput('-2')));
  assert.ok(Number.isNaN(R.amountInput('six')));
  assert.equal(R.pctInput(''), null);
  assert.equal(R.pctInput('68%'), 68);
  assert.equal(R.pctInput(100), 100);
  assert.ok(Number.isNaN(R.pctInput('101')));
  assert.ok(Number.isNaN(R.pctInput('-1')));
});

// ── export ──
test('exportRows: the item, its company price and Sites words, then On, Price here, On hand and Par per site', () => {
  const rows = [row({ sites: [link('a', { price_here: 8.7 }), link('b', { on: false })] })];
  const { headers, rows: out } = R.exportRows(rows, scope);
  const labels = headers.map((h) => h.label);
  assert.deepEqual(labels.slice(0, 14), ['Name', 'Category', 'Type', 'Base unit', 'SKU', 'Barcode', 'Main supplier', 'Supplier pack', 'Company price', 'Currency', 'Local', 'Archived', 'Sites', 'Stock value']);
  assert.deepEqual(labels.slice(14, 18), ['Northgate: on', 'Northgate: price here', 'Northgate: on hand', 'Northgate: par']);
  assert.equal(labels.length, 14 + 3 * 4);
  const csv = toCsv(out, headers).split('\r\n');
  assert.equal(csv.length, 2);
  const cells = csv[1].split(',');
  assert.equal(cells[0], 'Test milk 2L');
  assert.equal(cells[8], '8.28');
  assert.equal(cells[12], 'Northgate');
  assert.deepEqual(cells.slice(14, 18), ['Yes', '8.7', '4000', '12000']);
  assert.deepEqual(cells.slice(18, 22), ['No', '', '', ''], 'off at a site: no numbers');
  assert.deepEqual(cells.slice(22, 26), ['Not here', '', '', '']);
  const big = Array.from({ length: 1200 }, (_, i) => row({ id: `x${i}` }));
  assert.equal(R.exportRows(big, scope).rows.length, R.MAX_ROWS, 'at most 1,000 rows');
  assert.equal(R.exportFileName('2026-10-20'), 'stock-items-2026-10-20.csv');
  assert.equal(R.exportFileName(''), 'stock-items-export.csv');
});

// ── bulk tools ──
test('the bulk bar buttons, in the contract words and order; site tools only for a multi site company', () => {
  assert.deepEqual(R.BULK_ACTIONS.map((a) => a.label), ['Add to sites', 'Remove from sites', 'Stop ordering, run out', 'Set par at sites', 'Change category', 'Pause', 'Change prices', 'Archive', 'Export']);
  assert.deepEqual(R.BULK_ACTIONS.map((a) => a.kind), ['add_sites', 'remove_sites', 'run_out', 'set_par', 'category', 'pause', 'prices', 'archive', 'export']);
  assert.deepEqual(R.bulkActions(false).map((a) => a.kind), ['category', 'pause', 'prices', 'archive', 'export']);
  assert.equal(R.bulkActions(true).length, 9);
});

test('itemIdsOf and itemsWords', () => {
  assert.deepEqual(R.itemIdsOf([{ id: 'x' }, 'y', { id: 'x' }, null, {}]), ['x', 'y']);
  assert.equal(R.itemsWords([{ id: 'x', name: 'Test milk' }]), 'Test milk');
  assert.equal(R.itemsWords([{ id: 'x' }, { id: 'y' }]), '2 items');
  assert.equal(R.itemsWords([]), '0 items');
});

test('parPlan: typed in count packs, saved in base units, only where stocked, an empty box keeps the site\'s value', () => {
  const rows = [row(), row({ id: 'it-2', count_pack: null, sites: [link('c')] })];
  const one = R.parPlan(rows, ['a', 'c'], { par: '6', reorder: '', min: '1' });
  assert.equal(one.error, null);
  assert.deepEqual(one.calls, [
    { itemId: 'it-1', locationId: 'a', patch: { par_level: 12000, min_level: 2000 } },
    { itemId: 'it-2', locationId: 'c', patch: { par_level: 6, min_level: 1 } },
  ]);
  const per = R.parPlan(rows, ['a', 'b'], { a: { par: '2' }, b: { reorder: '1' } }, { perSite: true });
  assert.deepEqual(per.calls, [
    { itemId: 'it-1', locationId: 'a', patch: { par_level: 4000 } },
    { itemId: 'it-1', locationId: 'b', patch: { reorder_point: 2000 } },
  ]);
  assert.match(R.parPlan(rows, ['a'], { par: '-1' }).error, /0 or more/);
  assert.match(R.parPlan(rows, ['a'], { par: '' }).error, /Type a par/);
  assert.match(R.parPlan(rows, ['b'], { par: '3' }, { packOf: () => null }).error || '', /^$/, 'b holds it-1: one call');
  assert.deepEqual(R.parPlan([row()], ['c'], { par: '3' }).calls, [], 'not stocked there: nothing');
});

test('pausePlan: everywhere sends no sites; sites need one; until never before from; unpause clears the days', () => {
  assert.deepEqual(R.pausePlan({ items: [{ id: 'x' }], where: 'everywhere', from: '2026-11-01', until: '2026-11-03' }).args,
    { items: ['x'], sites: null, from: '2026-11-01', until: '2026-11-03', paused: true, section: 'inventory' });
  assert.deepEqual(R.pausePlan({ items: ['x'], siteIds: ['a'], section: 'purchasing' }).args,
    { items: ['x'], sites: ['a'], from: null, until: null, paused: true, section: 'purchasing' });
  assert.match(R.pausePlan({ items: ['x'], siteIds: [] }).error, /Tick at least one site/);
  assert.match(R.pausePlan({ items: [], siteIds: ['a'] }).error, /Tick at least one item/);
  assert.match(R.pausePlan({ items: ['x'], siteIds: ['a'], from: '2026-11-05', until: '2026-11-03' }).error, /on or after/);
  assert.match(R.pausePlan({ items: ['x'], siteIds: ['a'], from: '3/11/2026' }).error, /Pick a day/);
  assert.deepEqual(R.pausePlan({ items: ['x'], siteIds: ['a'], from: '2026-11-05', until: '2026-11-03', paused: false }).args,
    { items: ['x'], sites: ['a'], from: null, until: null, paused: false, section: 'inventory' });
});

test('priceSpecBase: exactly one target key, as the server names it', () => {
  assert.deepEqual(R.priceSpecBase({ itemIds: [{ id: 'x' }, 'y'] }), { item_ids: ['x', 'y'] });
  assert.deepEqual(R.priceSpecBase({ supplierItemIds: ['s1'] }), { supplier_item_ids: ['s1'] });
  assert.deepEqual(R.priceSpecBase({ supplierId: 'sup' }), { supplier_id: 'sup' });
  assert.deepEqual(R.priceSpecBase({ categoryId: 'cat' }), { category_id: 'cat' });
  assert.equal(R.priceSpecBase({ itemIds: ['x'], supplierId: 'sup' }), null);
  assert.equal(R.priceSpecBase({ itemIds: [] }), null);
  assert.equal(R.priceSpecBase(null), null);
});

test('priceSpec: the stock_change_prices p_spec, or plain words', () => {
  assert.deepEqual(R.priceSpec({ target: { supplierId: 'sup' }, how: 'percent', value: '3', fromDay: '2026-10-26', sites: ['b'] }).spec,
    { supplier_id: 'sup', sites: ['b'], how: 'percent', value: 3, from_day: '2026-10-26' });
  assert.deepEqual(R.priceSpec({ target: { itemIds: ['x'] }, how: 'set', value: '1.45' }).spec,
    { item_ids: ['x'], sites: null, how: 'set', value: 1.45, from_day: null });
  assert.equal(R.priceSpec({ target: { itemIds: ['x'] }, how: 'amount', value: '-0.10' }).spec.value, -0.1);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'set', value: '-1' }).error, /below 0/);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'percent', value: '-100' }).error, /above -100/);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'amount', value: '0' }).error, /how much/);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'percent', value: '' }).error, /Type a number/);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'percent', value: '2', fromDay: 'next week' }).error, /Pick a day/);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'percent', value: '2', sites: [] }).error, /Tick at least one site/);
  assert.match(R.priceSpec({ target: {}, how: 'percent', value: '2' }).error, /Pick what/);
  assert.match(R.priceSpec({ target: { itemIds: ['x'] }, how: 'double', value: '2' }).error, /how to change/);
  assert.deepEqual(R.PRICE_HOW.map((h) => h.label), ['Up or down by %', 'By an amount', 'Set a price']);
});

test('dateBoxWords: a picked day in words, else the empty words (an empty box never looks set)', () => {
  assert.equal(R.dateBoxWords('2026-11-03', { set: 'Until', empty: 'Empty = until you unpause.' }), 'Until 3 Nov');
  assert.equal(R.dateBoxWords('', { set: 'Until', empty: 'Empty = until you unpause.' }), 'Empty = until you unpause.');
  assert.equal(R.dateBoxWords(null, { set: 'From' }), 'No day picked yet.');
  assert.equal(R.dateBoxWords('2026-13-40', { set: 'From', empty: 'x' }), 'x', 'not a real day is not set');
  assert.equal(R.dateBoxWords('2026-01-09'), '9 Jan', 'no lead word');
  assert.doesNotMatch(R.dateBoxWords('2026-11-03', { set: 'From' }), /2026|11-03/, 'never the raw date');
});

test('copySiteCheck', () => {
  assert.equal(R.copySiteCheck('a', 'b'), null);
  assert.match(R.copySiteCheck('a', 'a'), /two different/);
  assert.match(R.copySiteCheck('', 'b'), /Pick the new site/);
});

test('untickFacts: what the site holds in count packs, and the recipes there that use it', () => {
  const detail = { item: { base_unit: 'ml' }, count_pack: { name: 'bottle', qty_in_base: 2000 },
    sites: [{ location_id: 'a', on_hand: 6000, recipes_here: 5, recipe_names_here: ['Latte', 'Flat white', 'Mocha'] }, { location_id: 'b', on_hand: -200, recipes_here: 0, recipe_names_here: [] }, { location_id: 'c', on_hand: 0 }] };
  assert.deepEqual(R.untickFacts(detail, 'a'), { holds: '3 bottles', usedBy: ['Latte', 'Flat white', 'Mocha', '2 other recipes'] });
  assert.deepEqual(R.untickFacts(detail, 'b'), { holds: null, usedBy: [] }, 'below zero is not held');
  assert.deepEqual(R.untickFacts(detail, 'c'), { holds: null, usedBy: [] });
  assert.deepEqual(R.untickFacts(detail, 'zz'), { holds: null, usedBy: [] });
  assert.deepEqual(R.untickFacts({ item: { base_unit: 'kg' }, sites: [{ location_id: 'a', on_hand: 2.5 }] }, 'a'), { holds: '2.5 kg', usedBy: [] });
});

// ── the save queue ──
test('jobsProgress: "<done> of <total> sites done", "Done.", and the failed site in words', () => {
  const name = (id) => ({ a: 'Northgate', b: 'Eastfield' }[id] || '');
  assert.deepEqual(R.jobsProgress([{ id: 1, location_id: 'a', status: 'done' }, { id: 2, location_id: 'b', status: 'running' }], [1, 2, 3], name),
    { line: '1 of 3 sites done', failed: [], finished: false });
  assert.deepEqual(R.jobsProgress([{ id: 1, status: 'done' }, { id: 2, status: 'done' }], ['1', '2'], name), { line: 'Done.', failed: [], finished: true });
  const f = R.jobsProgress([{ id: 1, status: 'done' }, { id: 2, location_id: 'b', status: 'failed', last_error: 'canceling statement due to lock timeout.' }], [1, 2], name);
  assert.deepEqual(f, { line: '1 of 2 sites done', failed: [{ id: 2, words: 'Eastfield did not finish: canceling statement due to lock timeout.' }], finished: true });
  assert.deepEqual(R.jobsProgress([], [], name), { line: '', failed: [], finished: false });
});

test('jobIdsOf and queuedWords (contract 4.5)', () => {
  assert.deepEqual(R.jobIdsOf([{ location_id: 'a', job_id: 11 }, { location_id: 'b', job_id: 12 }, {}]), [11, 12]);
  assert.equal(R.queuedWords([]), '');
  assert.equal(R.queuedWords([{ location_id: 'a', job_id: 11 }]), 'Saved. 1 site catches up within a minute.');
  assert.equal(R.queuedWords([{ location_id: 'a', job_id: 11 }, { location_id: 'b', job_id: 12 }]), 'Saved. 2 sites catch up within a minute.');
});

test('runLimited: never more than the limit at once, results in task order, a throw is caught', async () => {
  let running = 0;
  let most = 0;
  const seen = [];
  const tasks = Array.from({ length: 11 }, (_, i) => async () => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, (i * 7) % 5));
    running--;
    if (i === 4) throw new Error('four');
    return i * 10;
  });
  const out = await R.runLimited(tasks, 4, (d, t) => seen.push([d, t]));
  assert.ok(most <= 4 && most >= 2, `at most 4 at once (${most})`);
  assert.equal(out.length, 11);
  assert.equal(out[3].value, 30);
  assert.equal(out[4].error.message, 'four');
  assert.deepEqual(seen.at(-1), [11, 11]);
  assert.deepEqual(await R.runLimited([], 4), []);
});

test('bulkOutcome counts the answers that carry an error and keeps the first words', () => {
  const out = R.bulkOutcome([{ value: { data: {} } }, { value: { error: new Error('Not allowed: this is set by head office.') } }, { error: new Error('offline') }]);
  assert.deepEqual(out, { ok: 1, failed: 2, first: 'Not allowed: this is set by head office.' });
  assert.deepEqual(R.bulkOutcome([]), { ok: 0, failed: 0, first: null });
});

// ── add item ──
test('addItemPlan: the item with its sites, the pack people use, the supplier pack; plain words when something is missing', () => {
  const form = { name: ' Test oat 1L ', categoryId: 'cat-1', type: 'drink', baseUnit: 'ml', packName: 'carton', packSize: '1000',
    supplierId: 'sup-1', packQty: '6', innerQty: '1', innerUnit: 'l', price: '11.70', allergens: ['gluten'] };
  const p = R.addItemPlan(form, { siteIds: ['a', 'b', 'a'] });
  assert.equal(p.error, null);
  assert.deepEqual(p.item, { location_id: 'a', name: 'Test oat 1L', base_unit: 'ml', category_id: 'cat-1', type: 'drink', allergens: ['gluten'] });
  assert.deepEqual(p.sites, [{ location_id: 'a', on: true }, { location_id: 'b', on: true }]);
  assert.deepEqual(p.pack, { name: 'carton', qty_in_base: 1000, is_count_default: true, is_purchase_default: true });
  assert.deepEqual(p.si, { supplier_id: 'sup-1', pack_description: '6 x 1 l', pack_qty: 6, inner_qty: 1, inner_unit: 'l', pack_price: 11.7 });
  const local = R.addItemPlan({ name: 'Test eggs', baseUnit: 'each' }, { local: true, localSiteId: 'c' });
  assert.deepEqual(local, { item: { location_id: 'c', name: 'Test eggs', base_unit: 'each' }, sites: null, pack: null, si: null, error: null });
  assert.match(R.addItemPlan({ name: '' }).error, /name/);
  assert.match(R.addItemPlan({ name: 'x', baseUnit: 'bucket' }, { siteIds: ['a'] }).error, /base unit/);
  assert.match(R.addItemPlan({ name: 'x', baseUnit: 'g' }, { siteIds: [] }).error, /Tick at least one site/);
  assert.match(R.addItemPlan({ name: 'x', baseUnit: 'g' }, { local: true }).error, /Pick the site/);
  assert.match(R.addItemPlan({ name: 'x', baseUnit: 'g', packName: 'bag' }, { siteIds: ['a'] }).error, /name and a size/);
  assert.match(R.addItemPlan({ name: 'x', baseUnit: 'g', supplierId: 's', price: '' }, { siteIds: ['a'] }).error, /price/);
  assert.match(R.addItemPlan({ name: 'x', baseUnit: 'g', supplierId: 's', price: '2', innerQty: '' }, { siteIds: ['a'] }).error, /6 x 2 l/);
});

test('addItemSavedWords (contract 4.2)', () => {
  assert.equal(R.addItemSavedWords('Test oat 1L', 2), "Test oat 1L saved. It is on 2 sites' count sheets and Order pads now.");
  assert.equal(R.addItemSavedWords('Test eggs', 1), "Test eggs saved. It is on 1 site's count sheet and Order pad now.");
});

// ── import ──
test('import kinds: the staged kind and the importMappers CSV key, both ways', () => {
  assert.deepEqual(R.IMPORT_KINDS.map((k) => [k.kind, k.key]), [['item', 'items'], ['supplier', 'suppliers'], ['supplier_item', 'supplier_items'], ['par', 'pars']]);
  assert.equal(R.importKey('supplier_item'), 'supplier_items');
  assert.equal(R.importKey('pars'), 'pars');
  assert.equal(R.importKind('items'), 'item');
  assert.equal(R.importKind('supplier_item'), 'supplier_item');
  assert.equal(R.importKind('recipe'), null);
  assert.equal(R.importKey(null), null);
});

test('importCountWords: "<n> new items, <n> price changes, <n> problems" from any of the count shapes', () => {
  assert.equal(R.importCountWords({ item: { new: 142, change: 3 }, supplier_item: { change: 18 }, problem: 0 }), '142 new items, 18 price changes, 0 problems');
  assert.equal(R.importCountWords({ 'item:new': 1, 'supplier_item:new': 2, 'par:problem': 1 }), '1 new item, 2 price changes, 1 problem');
  assert.equal(R.importCountWords({ item_new: 2, supplier_item_change: 1, item_problem: 2, supplier_problem: 1 }), '2 new items, 1 price change, 3 problems');
  assert.equal(R.importCountWords(null), '0 new items, 0 price changes, 0 problems');
  assert.equal(R.importProblems({ problem: 4 }), 4);
  assert.equal(R.importProblems({ item: { problem: 1 }, par: { problem: 2 } }), 3);
  assert.equal(R.importRecipeRows({ recipe: { skip: 9 } }), 9);
  assert.equal(R.importRecipeRows({ recipe: 4 }), 4);
  assert.equal(R.importRecipeRows({ 'recipe:skip': 2 }), 2);
  assert.equal(R.importRecipeRows({}), 0);
});

test('importCountWords: the exact counts stock_import_stage answers (20261024a)', () => {
  const db = { rows: 30, new: 12, change: 6, same: 4, skip: 5, problem: 3, new_items: 9, price_changes: 6 };
  assert.equal(R.importCountWords(db), '9 new items, 6 price changes, 3 problems');
  assert.equal(R.importProblems(db), 3);
  assert.equal(R.importCountWords({ rows: 1, new: 1, change: 0, same: 0, skip: 0, problem: 0, new_items: 1, price_changes: 0 }), '1 new item, 0 price changes, 0 problems');
});

test('importKindsWords: what the file holds, in words', () => {
  assert.equal(R.importKindsWords(['items']), 'stock items');
  assert.equal(R.importKindsWords(['items', 'supplier_items']), 'stock items and supplier items and prices');
  assert.equal(R.importKindsWords(['items', 'suppliers', 'pars']), 'stock items, suppliers and pars');
  assert.equal(R.importKindsWords(['recipes']), 'recipes (skipped)');
  assert.equal(R.importKindsWords([]), '');
});

test('importProgressWords: "<done> of <total> rows done", then "Done."', () => {
  assert.equal(R.importProgressWords({ status: 'running', progress: { done: 300, total: 2000 } }), '300 of 2000 rows done');
  assert.equal(R.importProgressWords({ status: 'waiting', progress: {} }), '0 rows done');
  assert.equal(R.importProgressWords({ status: 'done', progress: { done: 2000, total: 2000 } }), 'Done.');
  assert.equal(R.importProgressWords(null), '');
});

test('stageWithSupplier: a price list row with no supplier is that supplier\'s', () => {
  const rows = [
    { row_no: 1, kind: 'supplier_item', data: { item: 'Test milk', supplier: '' }, sites: null },
    { row_no: 2, kind: 'supplier_item', data: { item: 'Test oat', supplier: 'Other Co' }, sites: null },
    { row_no: 3, kind: 'item', data: { name: 'Test bun' }, sites: null },
  ];
  const out = R.stageWithSupplier(rows, { id: 'sup-1', name: 'Test Dairy Co' });
  assert.equal(out[0].data.supplier, 'Test Dairy Co');
  assert.equal(out[1].data.supplier, 'Other Co', 'a row that names its supplier keeps it');
  assert.equal(out[2], rows[2]);
  assert.equal(rows[0].data.supplier, '', 'the rows given are not changed');
  assert.equal(R.stageWithSupplier(rows, null)[0], rows[0]);
});

// ── the screens (source: node cannot render these without the browser pieces) ──
const dir = new URL('../../backoffice/sections/stock/items/', import.meta.url);
const MINE = ['CompanyItemList.jsx', 'SitesGrid.jsx', 'SitesPopover.jsx', 'BulkBar.jsx', 'AddToSitesModal.jsx', 'RemoveFromSitesModal.jsx', 'RunOutModal.jsx',
  'SetParModal.jsx', 'ChangeCategoryModal.jsx', 'PauseModal.jsx', 'ChangePricesModal.jsx', 'CategoriesModal.jsx', 'AddItemModal.jsx', 'ImportModal.jsx', 'CopySiteModal.jsx'];
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const rules = fs.readFileSync(new URL('./itemListRules.js', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../../backoffice/sections/StockItems.jsx', import.meta.url), 'utf8');

test('house rules in every item screen: no long dash, no window.confirm, no direct database call, no browser storage, never that word', () => {
  for (const [f, src] of [...MINE.map((f) => [f, read(f)]), ['itemListRules.js', rules], ['StockItems.jsx', router]]) {
    assert.doesNotMatch(src, /[\u2013\u2014]/, `${f}: no em or en dash`);
    assert.doesNotMatch(src, /window\.confirm|\bconfirm\(\s*['"`]/, `${f}: the in app ConfirmDialog only`);
    assert.doesNotMatch(src, new RegExp(['str', 'ipe'].join(''), 'i'), f);
    const c = code(src);
    assert.doesNotMatch(c, /\.rpc\(|\.from\(\s*['"]/, `${f}: every read and save goes through stockApi`);
    assert.doesNotMatch(c, /from '[./]*lib\/supabase'|lib\/supabase'/, `${f}: no database client in the screen`);
    assert.doesNotMatch(c, /localStorage|sessionStorage|rpos-/, `${f}: no browser storage`);
    assert.doesNotMatch(c, /\boffset\b/i, `${f}: keyset pages, never an offset`);
  }
  for (const f of MINE.filter((x) => /Modal\.jsx$/.test(x))) assert.match(read(f), /import \{[^}]*\bModal\b[^}]*\} from '\.\.\/stockUi';/, `${f} uses the Back Office Modal`);
});

test('the company list: the contract words, the one site view filter, Start a count and the row link', () => {
  const src = read('CompanyItemList.jsx');
  for (const words of [
    'One company list. The Sites column shows where each item is stocked. Click it to change.',
    'What ${oneName} stocks, at its own price, cost and par.',
    '>Start a count<', '>Categories<', "label: 'Import CSV'", "label: 'Import from Nory or MarketMan'", '>Export<', '>Copy a site<',
    "'+ Add item'", "'+ Add a local item'", 'placeholder="Search name, SKU or barcode"', "label: 'List'", "label: 'Sites grid'",
    'No stock items here yet. Press ${', ' to add one.',
    'Grey price = follows the company price. Type a price to set the price here.',
    ' is now stocked at ${site}: on its count sheet and Order pad at once.',
    'Stop ordering, run out at ${site}. It stays on the count until it reaches zero.',
    'Removed from ${site}. The row is archived, never deleted.',
    'Back to the company price at ${site}.', "Only ${site}'s cost moved.",
    "words: 'Only when no site holds it. Archived items keep their history.'",
  ]) assert.ok(src.includes(words), words);
  assert.match(src, /filtersToServer\(\{ \.\.\.filt, notAt: oneId \? '' : filt\.notAt, onAt: oneId \}\)/, 'the one site view sends on_at = that site');
  assert.match(src, /const id = await sc\.askWhichSite\('Start a count'\);\s*if \(id\) sc\.go\('stock-counts', \{ openNew: true \}\);/);
  assert.match(src, /onOpen\(row\.id, \{ tab: 'sites', siteId: oneId \}\)/);
  assert.match(src, /stockApi\.itemsPage\(\{ orgId, sites: sitesArg, search: q \|\| null, filters, after: null, limit: PAGE \}\)/, 'pages of 100 from the server');
  assert.match(src, /const PAGE = 100;/);
  assert.match(src, /<ShowMore next=\{page\.next\}/);
  assert.match(src, /canEditCompany\('inventory'\)/);
  assert.match(src, /canEditSite\(siteId, 'site_price'\)/, 'ticks and prices only where the login may change them');
  assert.match(src, /stockApi\.saveItemSite\(row\.id, siteId, \{ price_here: v \}, link\.row_version \?\? null\)/, 'the price carries the link version');
  assert.match(src, /toCsv\(out, headers\)/);
  assert.match(src, /getVenueClock\(clockSite\)/, 'the export file is named by the venue\'s day');
  assert.match(src, /exportFileName\(ymdInTz\(new Date\(\), tz \|\| 'Europe\/London'\)\)/);
  assert.doesNotMatch(code(src), /toLocaleDateString|new Date\(\)\.toISOString\(\)\.slice/, 'never the device\'s date');
  assert.match(src, /<NewSiteBanner \/>/);
});

test('grid, pop up and bulk bar: the words and the reads', () => {
  const grid = read('SitesGrid.jsx');
  for (const w of ['<Th sticky>Item</Th>', '<Th>Company price</Th>', 'Not here', '<Td sticky strong>']) assert.ok(grid.includes(w), w);
  const pop = read('SitesPopover.jsx');
  for (const w of ['Sites for {row.name}', 'Open the Sites tab', '>Done<', "'Not here'"]) assert.ok(pop.includes(w), w);
  const flow = pop.slice(pop.indexOf('export function UntickFlow'), pop.indexOf('export default function SitesPopover'));
  assert.match(flow, /stockApi\.itemDetail\(row\.id\)/, 'one read for what the site holds and its recipes');
  assert.match(flow, /<UntickChoiceModal /);
  assert.match(grid, /<UntickFlow /, 'the grid asks the same two choices');
  const bar = read('BulkBar.jsx');
  for (const w of ['{count} ticked', '>Clear<', 'pollJobs(stockApi, ids,', 'Try again']) assert.ok(bar.includes(w), w);
});

test('the modals: the contract words and the calls', () => {
  const has = (f, list) => { const src = read(f); for (const w of list) assert.ok(src.includes(w), `${f}: ${w}`); return src; };
  has('AddToSitesModal.jsx', ['Add ${n} ${n === 1 ? \'item\' : \'items\'} to sites', 'Each site gets its row at once, on hand 0. Nothing else moves.', '>Cancel<', "'Add'", 'Added to ${k} ${k === 1 ? \'site\' : \'sites\'}. On hand starts at 0.', 'stockApi.setItemSites({ items: ids, add: chosen })']);
  has('RemoveFromSitesModal.jsx', ['Remove ${n} ${n === 1 ? \'item\' : \'items\'} from sites', "label: 'Stop ordering, run out'", "label: 'Remove now'", 'stockApi.setItemSites({ items: ids, remove })', 'These were not removed:']);
  has('RunOutModal.jsx', ['title="Stop ordering, run out"', "mode: 'runout'"]);
  const par = has('SetParModal.jsx', ['title="Set par at sites"', 'sub="Type one par, or one per site."', 'Leave a box empty to keep what each site has.']);
  assert.match(par, /runLimited\([^\n]*stockApi\.saveItemSite\(c\.itemId, c\.locationId, c\.patch, null\)\), 4,/, 'at most 4 calls at a time');
  has('ChangeCategoryModal.jsx', ['title="Change category"', 'version: it.row_version ?? null', 'category_id: pick']);
  const pause = has('PauseModal.jsx', ["label: 'At chosen sites'", "label: 'Everywhere'", 'label="From"', 'label="Until"', 'Empty = until you unpause.', '>Unpause<', "'Pause'", 'stockApi.pauseItems(plan.args)']);
  // Safari draws today in grey in an empty date box: each box says in words whether a day is set.
  assert.match(pause, /dateBoxWords\(value, \{ set, empty \}\)/);
  assert.match(pause, /<DateBox label="From" [^\n]*empty="Empty = from now\." \/>/);
  assert.match(pause, /<DateBox label="Until" [^\n]*empty="Empty = until you unpause\." \/>/);
  const prices = has('ChangePricesModal.jsx', ['title="Change prices"', "label: 'From today'", "label: 'From a date'", "label: 'The company price (every site that follows it)'", "label: 'Chosen sites'", '<Th right>Before</Th>', '<Th right>After</Th>', "'Apply'"]);
  assert.ok(prices.indexOf('preview: true') < prices.indexOf('preview: false'), 'the preview comes before the save');
  assert.match(prices, /disabled=\{busy \|\| !rows\.length\} onClick=\{apply\}/, 'Apply only after a preview with rows');
  assert.match(prices, /dateBoxWords\(fromDay, \{ set: 'From', empty: 'No day picked yet\.' \}\)/, 'the From a date box says whether a day is set');
  has('CategoriesModal.jsx', ['title="Categories"', 'sub="One list for every site. Each category can carry an accounting code and a GP target."', '<Th>Category</Th>', '<Th>Accounting code</Th>', '<Th right>GP target</Th>', '<Th right>Items</Th>', '+ Add a category', '>Archive<', 'stockApi.archiveCategory(']);
  const imp = has('ImportModal.jsx', ["label: 'Import CSV'", "label: 'Import from Nory or MarketMan'", 'Recipes come in with the recipe update.', '{unusedWords(unknown)}', "'Import'", 'stockApi.importCommit(jobId, chosen)', 'stockApi.importCancel(', 'stageFile(mapped, { siteIdByName: sc.sites })']);
  assert.match(imp, /const STAGE_ROWS = 2000;/);
  assert.ok(imp.indexOf('stockApi.importStage(') < imp.indexOf('stockApi.importCheck(') || imp.indexOf('readCheck(id)') > imp.indexOf('stockApi.importStage('), 'stage, then the check screen');
  assert.ok(imp.indexOf('const commit = async') > imp.indexOf('const start = async'), 'Import only from the check screen');
  assert.match(imp, /for \(const part of chunk\(rows, STAGE_ROWS\)\)/, 'staged in chunks of 2,000');
  assert.match(imp, /if \(closed\.current\) \{ if \(made\) stockApi\.importCancel\(made\); return; \}/, 'closed while checking: no more rows go up and the job is thrown away');
  assert.match(imp, /closed\.current = false;\s*return \(\) => \{\s*closed\.current = true;/, 'the flag is set back on mount (StrictMode runs the cleanup once)');
  has('CopySiteModal.jsx', ['title="Copy a site"', 'label="New site"', 'label="Site to copy"', 'Every item, supplier link and par of the site you copy from is ticked at the new site. On hand starts at 0.', "'Copy'", 'stockApi.copySite(from, to)']);
  const add = has('AddItemModal.jsx', ["'Add item'", 'Add a local item (${localName || \'this site\'} only)', 'label="Name"', 'label="Category"', 'label="Type"', 'label="Base unit"', 'label="Pack people use"', 'label="Supplier"', 'label="Supplier pack"', 'label="Price"', 'label="Allergens"', 'label="Sites" hint="Pre ticked from the picker.', '`Item saved. ${missed.join(\' \')}`']);
  const a = add.indexOf('stockApi.saveItem('); const b = add.indexOf('stockApi.savePack('); const c = add.indexOf('stockApi.saveSupplierItem(');
  assert.ok(a > 0 && a < b && b < c, 'the item first, then its pack, then its supplier item');
});

test('the item rules file is pure: no React, no database (it imports only the units table and the pause words)', () => {
  const imports = [...rules.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./units.js', './pauseRules.js']);
  const pause = fs.readFileSync(new URL('./pauseRules.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pause, /from '(react|[./]*supabase|[./]*lib\/supabase)'|stockApi/, 'pauseRules.js is pure too, so this file stays pure');
  assert.doesNotMatch(code(rules), /supabase|stockApi\.|\.rpc\(/);
});

test('replaceRows: a saved cell reads only its row again; the other loaded rows stay as they are', () => {
  const a = { id: 'a', name: 'Apples', v: 1 };
  const b = { id: 'b', name: 'Butter', v: 1 };
  const c = { id: 'c', name: 'Cream', v: 1 };
  const page = { rows: [a, b, c], total: 250, next: { k: 'cream', id: 'c' } };
  const fresh = R.replaceRows(page, ['b'], [{ ...b, v: 2 }]);
  assert.deepEqual(fresh.rows.map((x) => [x.id, x.v]), [['a', 1], ['b', 2], ['c', 1]]);
  assert.equal(fresh.rows[0], a, 'a row not asked for is the same object');
  assert.equal(fresh.total, 250);
  // asked, but no longer fits the list (unticked in the one site view, archived, filtered out): it goes
  const gone = R.replaceRows(page, ['a', 'c'], [{ ...a, v: 3 }]);
  assert.deepEqual(gone.rows.map((x) => [x.id, x.v]), [['a', 3], ['b', 1]]);
  assert.equal(gone.total, 249);
  // an answer row that was not on screen is never added; an empty page stays empty
  assert.deepEqual(R.replaceRows(page, ['z'], [{ id: 'z' }]).rows.map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(R.replaceRows({ rows: [], total: null }, ['a'], []), { rows: [], total: null });
});

test('addItemPlan: Purchased or made (Made here makes it a made item at every site it starts at)', () => {
  const base = { name: 'House stock', baseUnit: 'l' };
  assert.equal(R.addItemPlan(base, { siteIds: ['a', 'b'] }).item.site, undefined, 'Purchased: nothing extra sent');
  const made = R.addItemPlan({ ...base, kind: 'MADE' }, { siteIds: ['a', 'b'] });
  assert.deepEqual(made.item.site, { kind: 'MADE' });
  assert.deepEqual(made.sites, [{ location_id: 'a', on: true }, { location_id: 'b', on: true }]);
  assert.deepEqual(R.addItemPlan({ ...base, kind: 'MADE' }, { local: true, localSiteId: 'a' }).item.site, { kind: 'MADE' });
});
