/** reportView.test.js: Drop 4a (web-reports). The display helpers the 15 Stock report screens share. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATER_WORDS, PAGE_CAP, metaSite, siteNameOf, currencyOf, withSites, fmtPct, fmtQty, fmtInt,
  dayWords, weekWords, whenWords, rangeDaysCount, overrideValue, toggleSort, sortLoaded, documentWords, transferWords, fixWords,
  groupRows, sumKey, maxAbs, crumbsFor, KINDS, col, keysOf, notesOf, allRowsLoaded,
  siteLabel, whenAt, unitMoney, initialPick, initialSite,
} from './reportView.js';

const META = {
  sites: [
    { id: 'uk-1', name: 'Leeds', currency: 'GBP', timezone: 'Europe/London' },
    { id: 'us-1', name: 'Cabin', currency: 'USD', timezone: 'America/New_York' },
  ],
  currencies: ['GBP', 'USD'],
};
const BY_ID = { 'uk-1': { id: 'uk-1', name: 'Leeds (scope)', currency: 'GBP' }, 'x-9': { id: 'x-9', name: 'Closed one' } };

test('the fixed words carry no long dashes', () => {
  for (const w of [LATER_WORDS.recipes, LATER_WORDS.purchasing]) assert.doesNotMatch(w, /[\u2013\u2014]/);
  assert.equal(LATER_WORDS.recipes, 'Comes with the recipes update');
  assert.equal(LATER_WORDS.purchasing, 'Comes with the purchasing update');
  assert.equal(PAGE_CAP, 1000);
});

test('site names: the scope first, then the guard, then a short id; null is the company', () => {
  assert.equal(metaSite(META, 'us-1').name, 'Cabin');
  assert.equal(metaSite(META, 'nope'), null);
  assert.equal(metaSite(null, 'uk-1'), null);
  assert.equal(siteNameOf(META, BY_ID, 'uk-1'), 'Leeds (scope)');
  assert.equal(siteNameOf(META, BY_ID, 'us-1'), 'Cabin');
  assert.equal(siteNameOf(META, BY_ID, 'x-9'), 'Closed one');
  assert.equal(siteNameOf(META, BY_ID, 'abcdefgh-1234'), 'abcdefgh');
  assert.equal(siteNameOf(META, BY_ID, null), 'Company');
});

test('currency: the guard row, then the scope, then the one company currency, never a guess across two', () => {
  assert.equal(currencyOf(META, BY_ID, 'us-1'), 'USD');
  assert.equal(currencyOf({ sites: [] }, BY_ID, 'uk-1'), 'GBP');
  assert.equal(currencyOf({ currencies: ['GBP'] }, {}, 'zz'), 'GBP');
  assert.equal(currencyOf(META, {}, 'zz'), undefined, 'two currencies: no guess');
  assert.equal(currencyOf(null, null, null), undefined);
});

test('withSites fills site and currency by location_id and leaves given values alone', () => {
  const rows = withSites([{ location_id: 'us-1', v: 1 }, { location_id: 'uk-1', site: 'Given', currency: 'EUR' }, { v: 2 }, null], META, BY_ID);
  assert.equal(rows[0].site, 'Cabin');
  assert.equal(rows[0].currency, 'USD');
  assert.equal(rows[1].site, 'Given');
  assert.equal(rows[1].currency, 'EUR');
  assert.equal(rows[2].site, undefined);
  assert.equal(rows[2].currency, undefined, 'a company row in a two currency company names no currency');
  assert.equal(rows[3], null);
  assert.deepEqual(withSites(null, META, BY_ID), []);
});

test('number words: one decimal percents, thousands, blanks for null', () => {
  assert.equal(fmtPct(12.345), '12.3%');
  assert.equal(fmtPct('7'), '7.0%');
  assert.equal(fmtPct(null), '');
  assert.equal(fmtPct(0.5, 2), '0.50%');
  assert.equal(fmtQty(1234.5), '1,234.5');
  assert.equal(fmtQty(1234.567, 'ml'), '1,234.57 ml');
  assert.equal(fmtQty(null, 'g'), '');
  assert.equal(fmtInt(1999.6), '2,000');
  assert.equal(fmtInt(null), '');
  assert.equal(fmtInt('x'), '');
});

test('day words read the business day, never the device clock', () => {
  assert.equal(dayWords('2026-10-12'), 'Mon 12 Oct');
  assert.equal(dayWords('2026-10-13'), 'Tue 13 Oct');
  assert.equal(dayWords('2026-10-13T00:00:00'), 'Tue 13 Oct');
  assert.equal(dayWords('nope'), '');
  assert.equal(dayWords(null), '');
  assert.equal(weekWords('2026-10-12'), 'Week of Mon 12 Oct');
  assert.equal(weekWords(null), '');
  assert.match(whenWords('2026-10-13T13:05:00Z', 'Europe/London'), /Tue 13 Oct, 14:05/);
  assert.match(whenWords('2026-10-13T13:05:00Z', 'America/New_York'), /Tue 13 Oct, 09:05/);
  assert.equal(whenWords('garbage'), '');
  assert.equal(whenWords(null), '');
});

test('rangeDaysCount counts both ends, across the clock change', () => {
  assert.equal(rangeDaysCount('2026-10-01', '2026-10-01'), 1);
  assert.equal(rangeDaysCount('2026-10-19', '2026-10-25'), 7);
  assert.equal(rangeDaysCount('2026-10-24', '2026-10-26'), 3);
  assert.equal(rangeDaysCount('2026-01-01', '2026-12-31'), 365);
  assert.equal(rangeDaysCount(null, '2026-01-01'), 0);
});

test('overrideValue: the local choice while its key matches, else the prop', () => {
  assert.equal(overrideValue({ key: 'a', value: true }, 'a', false), true);
  assert.equal(overrideValue({ key: 'a', value: true }, 'b', false), false);
  assert.equal(overrideValue({ key: 'a', value: null }, 'a', 'p'), 'p');
  assert.equal(overrideValue(null, 'a', 'p'), 'p');
  assert.equal(overrideValue({ key: 'a', value: 0 }, 'a', 5), 0, 'zero is a choice');
});

test('sort: a header click flips the same key and starts a new one on its default', () => {
  assert.deepEqual(toggleSort(null, 'value'), { key: 'value', dir: 'desc' });
  assert.deepEqual(toggleSort({ key: 'value', dir: 'desc' }, 'value'), { key: 'value', dir: 'asc' });
  assert.deepEqual(toggleSort({ key: 'value', dir: 'asc' }, 'name', 'asc'), { key: 'name', dir: 'asc' });
});

test('sortLoaded sorts the rows on screen: numbers as numbers, words as words, nulls last, ties kept', () => {
  const rows = [
    { id: 'a', value: 10, name: 'Oat milk' }, { id: 'b', value: null, name: 'Beans' }, { id: 'c', value: '9.5', name: 'cups' },
    { id: 'd', value: 10, name: 'Buns' }, { id: 'e', value: -2, name: '' },
  ];
  assert.deepEqual(sortLoaded(rows, { key: 'value', dir: 'desc' }).map((r) => r.id), ['a', 'd', 'c', 'e', 'b']);
  assert.deepEqual(sortLoaded(rows, { key: 'value', dir: 'asc' }).map((r) => r.id), ['e', 'c', 'a', 'd', 'b']);
  assert.deepEqual(sortLoaded(rows, { key: 'name', dir: 'asc' }).map((r) => r.id), ['b', 'd', 'c', 'a', 'e']);
  assert.deepEqual(sortLoaded(rows, null).map((r) => r.id), ['a', 'b', 'c', 'd', 'e'], 'no sort keeps the database order');
  assert.deepEqual(sortLoaded([{ id: 1, at: '2026-10-02T08:00:00Z', _when: 'Fri 2 Oct' }, { id: 2, at: '2026-10-01T08:00:00Z', _when: 'Thu 1 Oct' }], { key: '_when', dir: 'asc' }, { _when: 'at' }).map((r) => r.id), [2, 1]);
  assert.deepEqual(sortLoaded(null, { key: 'x' }), []);
  const before = rows.map((r) => r.id);
  sortLoaded(rows, { key: 'value', dir: 'asc' });
  assert.deepEqual(rows.map((r) => r.id), before, 'the given rows are never reordered in place');
});

test('siteLabel: an id says the site name, a name stays as it is, never a cut id', () => {
  assert.equal(siteLabel(META, BY_ID, 'uk-1'), 'Leeds (scope)');
  assert.equal(siteLabel(META, BY_ID, 'us-1'), 'Cabin');
  assert.equal(siteLabel(META, BY_ID, 'North Street Kitchen'), 'North Street Kitchen');
  assert.equal(siteLabel(META, BY_ID, null), '');
  assert.equal(siteLabel(null, null, 'Harbour Road'), 'Harbour Road');
});

test('whenAt reads a timestamp on the site own clock', () => {
  const ts = '2026-10-21T04:30:00Z';
  assert.match(whenAt(META, 'uk-1', ts), /05:30/);
  assert.match(whenAt(META, 'us-1', ts), /00:30/);
  assert.equal(whenAt(META, 'uk-1', null), '');
});

test('unitMoney keeps four places under one so a price per ml never reads 0.00', () => {
  assert.equal(unitMoney(0.00342, 'GBP'), '£0.0034');
  assert.equal(unitMoney(1.5, 'USD'), '$1.50');
  assert.equal(unitMoney(-0.25, 'GBP'), '-£0.2500');
  assert.equal(unitMoney(null, 'GBP'), '');
});

test('initialPick and initialSite read a link or a drill only inside what the screen allows', () => {
  assert.equal(initialPick({ level: 'reason' }, 'level', ['site', 'reason'], 'site'), 'reason');
  assert.equal(initialPick({ level: 'drop table' }, 'level', ['site', 'reason'], 'site'), 'site');
  assert.equal(initialPick({ idle_days: '60' }, 'idle_days', [14, 30, 60], 30), 60);
  assert.equal(initialPick({ at: '2026-10-20' }, 'at', null, null), '2026-10-20');
  assert.equal(initialPick(null, 'level', null, 'site'), 'site');
  assert.equal(initialPick({ level: '' }, 'level', null, 'site'), 'site');
  assert.equal(initialSite({ site: 'uk-1' }, ['uk-1', 'us-1']), 'uk-1');
  assert.equal(initialSite({ site: 'other-co' }, ['uk-1']), null, 'a site outside the ones asked for is dropped');
  assert.equal(initialSite({}, ['uk-1']), null);
  assert.equal(initialSite({ site: 'uk-1' }, null), null);
});

test('document and transfer words', () => {
  assert.equal(documentWords({ kind: 'Invoice', ref: 'INV-1203', who: 'Jane' }), 'Invoice INV-1203 (Jane)');
  assert.equal(documentWords({ kind: 'Count', ref: null, who: null }), 'Count');
  assert.equal(documentWords({ who: 'Till' }), 'Till');
  assert.equal(documentWords(null), '');
  const nameOf = (id) => ({ 'uk-1': 'Leeds', 'uk-2': 'Hull' }[id]);
  assert.equal(transferWords([{ location_id: 'uk-1', use_28d: 12 }, { location_id: 'uk-2', site: 'Hull', use_28d: 4.5 }], nameOf), 'Transfer to Leeds (used 12 in 28 days), Hull (used 4.5 in 28 days)');
  assert.equal(transferWords([{ location_id: 'zz' }], nameOf), 'Transfer to another site');
  assert.equal(transferWords([{ location_id: 'uk-1', use_28d: 42 }], nameOf, (v) => `£${v.toFixed(2)}`), 'Transfer to Leeds (used £42.00 in 28 days)');
  assert.equal(transferWords([], nameOf), '');
  assert.equal(transferWords(null, nameOf), '');
  assert.equal(fixWords('Leeds'), 'Leeds catching up');
  assert.equal(fixWords(''), 'Site catching up');
});

test('groupRows keeps first seen order; sumKey and maxAbs skip nulls', () => {
  const rows = [{ k: 'b', v: 2 }, { k: 'a', v: null }, { k: 'b', v: -5 }, { k: null, v: 1 }];
  const g = groupRows(rows, 'k');
  assert.deepEqual(g.map((x) => x.key), ['b', 'a', '']);
  assert.equal(g[0].rows.length, 2);
  assert.equal(sumKey(rows, 'v'), -2);
  assert.equal(sumKey([{ v: null }], 'v'), null);
  assert.equal(sumKey([], 'v'), null);
  assert.equal(maxAbs(rows, 'v'), 5);
  assert.equal(maxAbs([], 'v'), 0);
});

test('crumbs follow the drill: company, site, category, item', () => {
  const nameOf = (id) => (id === 'uk-1' ? 'Leeds' : '?');
  assert.deepEqual(crumbsFor(null, nameOf), [{ id: 'company', label: 'All sites' }]);
  assert.deepEqual(crumbsFor({ site: 'uk-1' }, nameOf).map((c) => c.label), ['All sites', 'Leeds']);
  assert.deepEqual(crumbsFor({ site: 'uk-1', category_id: 'c1', category_name: 'Dairy' }, nameOf).map((c) => c.id), ['company', 'site', 'category']);
  assert.deepEqual(crumbsFor({ site: 'uk-1', category_id: 'c1', category_name: 'Dairy', item_id: 'i1', item_name: 'Milk' }, nameOf).map((c) => c.label), ['All sites', 'Leeds', 'Dairy', 'Milk']);
  assert.equal(crumbsFor(null, nameOf, { company: 'Company' })[0].label, 'Company');
});

test('column specs: a known kind, numbers right aligned, keysOf lists them', () => {
  assert.ok(KINDS.includes('money') && KINDS.includes('rag'));
  const c = col('sales_net', 'Sales', 'money', { hint: 'after discounts' });
  assert.deepEqual(c, { key: 'sales_net', label: 'Sales', kind: 'money', align: 'right', hint: 'after discounts' });
  assert.equal(col('name', 'Item').align, 'left');
  assert.equal(col('business_day', 'Day', 'day').align, 'left');
  assert.throws(() => col('x', 'X', 'banana'), /unknown kind/);
  assert.deepEqual(col('events', 'Entries', 'int'), { key: 'events', label: 'Entries', kind: 'qty', align: 'right', as: 'int' }, 'a whole number is a right aligned qty for the kit');
  assert.equal(col('_when', 'When', 'when').kind, 'text');
  assert.equal(col('_when', 'When', 'when').align, 'left');
  assert.deepEqual(keysOf([col('a', 'A'), col('b', 'B', 'pct')]), ['a', 'b']);
  assert.deepEqual(keysOf(null), []);
});

test('notes and allRowsLoaded', () => {
  assert.deepEqual(notesOf({ notes: 'One line' }), ['One line']);
  assert.deepEqual(notesOf({ notes: ['a', null, 'b'] }), ['a', 'b']);
  assert.deepEqual(notesOf({}), []);
  assert.deepEqual(notesOf(null), []);
  assert.deepEqual(notesOf({ notes: ['Plate cost not known before Mon 6 Oct at Leeds', 'Purchases at delivery value until the purchasing update'] }, ['Plate cost not known before']),
    ['Purchases at delivery value until the purchasing update'], 'a line the screen prints itself is not said twice');
  assert.deepEqual(notesOf({ notes: ['Stock outs cover up to 93 days.'] }, ['Stock outs cover up to 93 days.']), []);
  assert.equal(allRowsLoaded([{}, {}], null), true);
  assert.equal(allRowsLoaded([{}], { a: 1 }), false);
  assert.equal(allRowsLoaded(Array.from({ length: 1000 }, () => ({})), null), false, 'a full page may be the cap');
});
