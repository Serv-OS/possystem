/**
 * reportRules.test.js: the words and small sums the head office report screens share (v5.11.92,
 * multi site stock Drop 4a, contract 2.1 and 1.11). Run: npm test.
 *
 * Pinned: the lines the web shows from meta, word for word (1.11); "Counted" or "Estimated
 * (ledger)"; currency blocks never add two currencies; side by side and company total layouts;
 * the compare delta per column with the one percent rule; the CSV over meta.columns with money as
 * plain numbers and days as YYYY-MM-DD; no dashes anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES_LINE, CAP_LINE, dayWords, countedWords, windowWords, windowFlags, takesFromLine, windowOf, siteOf, siteNameOf,
  pctWordsOf, gpWords, notPostedLine, demoLine, currencyLine, metaLines, currencyBlocks, pct, layoutRows, companyRowOf,
  matchingRow, compareCells, cellWords, withSiteColumns, columnsToCsv, exportFileName,
} from './reportRules.js';

const A = 'a1000000-0000-4000-8000-000000000001';
const B = 'a1000000-0000-4000-8000-000000000002';
const C = 'a1000000-0000-4000-8000-000000000003';

const META = {
  report: 'cogs', from: '2026-10-05', to: '2026-10-11',
  sites: [{ id: A, name: 'North Street', currency: 'GBP' }, { id: B, name: 'River Side', currency: 'GBP' }, { id: C, name: 'Harbour', currency: 'USD' }],
  currencies: ['GBP', 'USD'], mixed_currency: true, demo_left_out: true,
  windows: [
    { location_id: A, from_day: '2026-10-05', to_day: '2026-10-11', opening_counted: true, closing_counted: false, window_missing: false, snapshot: false, part_locked: false, takes_from: '2026-10-01' },
    { location_id: B, from_day: '2026-10-06', to_day: '2026-10-11', opening_counted: false, closing_counted: true, window_missing: false, snapshot: true, part_locked: false, takes_from: '2026-10-08' },
    { location_id: C, from_day: null, to_day: null, window_missing: true, snapshot: false, part_locked: true, takes_from: null },
  ],
  not_posted: { count: 3, value: 41.5 },
  notes: ['Purchases at delivery value until the purchasing update', ' '],
};

test('dayWords: a business day as words, whatever the browser zone', () => {
  assert.equal(dayWords('2026-10-06'), 'Tue 6 Oct');
  assert.equal(dayWords('2026-10-12'), 'Mon 12 Oct');
  assert.equal(dayWords('2026-01-01'), 'Thu 1 Jan');
  assert.equal(dayWords('2026-13-01'), '');   // not a real month: Date.UTC rolls, so we only pin a string comes back
  assert.equal(dayWords('nope'), '');
  assert.equal(dayWords(null), '');
});

test('counted or estimated on every opening and closing figure', () => {
  assert.equal(countedWords(true), 'Counted');
  assert.equal(countedWords(false), 'Estimated (ledger)');
  assert.equal(countedWords(null), 'Estimated (ledger)');
  assert.equal(countedWords(undefined), 'Estimated (ledger)');
});

test('window words and flags', () => {
  assert.equal(windowWords(META.windows[0]), 'Mon 5 Oct to Sun 11 Oct');
  assert.equal(windowWords({ from_day: '2026-10-05', to_day: '2026-10-05' }), 'Mon 5 Oct');
  assert.equal(windowWords(META.windows[2]), 'Needs two full counts');
  assert.equal(windowWords(null), '');
  assert.equal(windowWords({}), '');
  assert.deepEqual(windowFlags(META.windows[0]), []);
  assert.deepEqual(windowFlags(META.windows[1]), ['Locked period: from the snapshot']);
  assert.deepEqual(windowFlags(META.windows[2]), ['Needs two full counts', 'Part of a locked period: read live']);
  assert.deepEqual(windowFlags(null), []);
});

test('plate cost not known before the first takes day', () => {
  assert.equal(takesFromLine(META.windows[0]), null, 'takes from before the window: known throughout');
  assert.equal(takesFromLine(META.windows[1]), 'Plate cost not known before Thu 8 Oct');
  assert.equal(takesFromLine(META.windows[2]), 'Plate cost not known yet');
  assert.equal(takesFromLine(null), null);
  assert.equal(windowOf(META, B).takes_from, '2026-10-08');
  assert.equal(windowOf(META, 'nope'), null);
  assert.equal(siteOf(META, C).name, 'Harbour');
  assert.equal(siteNameOf(META, A), 'North Street');
  assert.equal(siteNameOf(META, null), 'Company');
  assert.equal(siteNameOf(META, 'nope'), '');
});

test('gpWords: No sales when there are none, else one decimal, with the takes note for theo', () => {
  assert.deepEqual(gpWords(META, { location_id: A, sales_net: 1000, gp_pct_actual: 72.84 }), { text: '72.8%', note: null });
  assert.deepEqual(gpWords(META, { location_id: A, sales_net: 0, gp_pct_actual: null }), { text: 'No sales', note: null });
  assert.deepEqual(gpWords(META, { location_id: B, sales_net: 500, gp_pct_theo: 74.1 }, 'gp_pct_theo'), { text: '74.1%', note: 'Plate cost not known before Thu 8 Oct' });
  assert.deepEqual(gpWords(META, { location_id: A, sales_net: 500, gp_pct_theo: 74.1 }, 'gp_pct_theo'), { text: '74.1%', note: null });
  assert.deepEqual(gpWords(META, { location_id: null, sales_net: 500, gp_pct_theo: null }, 'gp_pct_theo'), { text: 'No sales', note: null });
  assert.equal(pctWordsOf(1.25), '1.3%');
  assert.equal(pctWordsOf(null), '');
  assert.equal(pctWordsOf('abc'), '');
});

test('the lines from meta, word for word (1.11)', () => {
  assert.equal(notPostedLine(META), '3 sales not yet posted to stock (£41.50)', 'two currencies: the first site\'s');
  assert.equal(notPostedLine({ ...META, currencies: ['GBP'] }), '3 sales not yet posted to stock (£41.50)');
  assert.equal(notPostedLine({ not_posted: { count: 1, value: 9 }, currencies: ['GBP'] }), '1 sale not yet posted to stock (£9.00)');
  assert.equal(notPostedLine({ not_posted: { count: 0, value: 0 } }), null);
  assert.equal(notPostedLine(null), null);
  assert.equal(demoLine(META), 'Demo history left out');
  assert.equal(demoLine({ demo_left_out: false }), null);
  assert.equal(currencyLine(META), 'Shown per currency');
  assert.equal(currencyLine({ mixed_currency: false }), null);
  assert.deepEqual(metaLines(META), [
    'North Street: Mon 5 Oct to Sun 11 Oct',
    'River Side: Tue 6 Oct to Sun 11 Oct',
    'River Side: Locked period: from the snapshot',
    'Harbour: Needs two full counts',
    'Harbour: Part of a locked period: read live',
    'Demo history left out',
    'Shown per currency',
    '3 sales not yet posted to stock (£41.50)',
    'Purchases at delivery value until the purchasing update',
  ]);
  // one site over exactly the period: no window line at all
  const one = { from: '2026-10-05', to: '2026-10-11', sites: [META.sites[0]], windows: [META.windows[0]], not_posted: { count: 0 }, demo_left_out: false, mixed_currency: false };
  assert.deepEqual(metaLines(one), []);
  assert.deepEqual(metaLines(null), []);
  assert.equal(RULES_LINE, 'The rules behind every number. Product GP adds up to site GP. Loyalty, staff and comps sit on their own line. Each venue uses its own business day. A locked month never changes. Two currencies are never added together.');
  assert.equal(CAP_LINE, 'Showing the first 1,000 rows. Export for all.');
});

const TOTALS = [
  { location_id: A, site: 'North Street', currency: 'GBP', sales_net: 1000, theo_cost: 260, gp_pct_theo: 74, opening_value: 500, opening_counted: true },
  { location_id: B, site: 'River Side', currency: 'GBP', sales_net: 500, theo_cost: 140, gp_pct_theo: 72, opening_value: 300, opening_counted: false },
  { location_id: C, site: 'Harbour', currency: 'USD', sales_net: 800, theo_cost: 200, gp_pct_theo: 75 },
  { location_id: null, site: 'Company', currency: 'GBP', sales_net: 1500, theo_cost: 400, gp_pct_theo: 73.3 },
  { location_id: null, site: 'Company', currency: 'USD', sales_net: 800, theo_cost: 200, gp_pct_theo: 75 },
];

test('currency blocks: one block per currency, never a sum across', () => {
  const blocks = currencyBlocks(TOTALS);
  assert.deepEqual(blocks.map((b) => b.currency), ['GBP', 'USD']);
  assert.deepEqual(blocks[0].sites.map((r) => r.location_id), [A, B]);
  assert.equal(blocks[0].company.sales_net, 1500);
  assert.deepEqual(blocks[1].sites.map((r) => r.location_id), [C]);
  assert.equal(blocks[1].company.sales_net, 800);
  assert.equal(blocks.reduce((s, b) => s + b.sites.length, 0), 3, 'every site row in exactly one block');
  // a site with no currency is its own block, never folded into another
  const odd = currencyBlocks([{ location_id: A, currency: null, sales_net: 1 }, { location_id: B, currency: 'GBP', sales_net: 2 }]);
  assert.deepEqual(odd.map((b) => b.currency), [null, 'GBP']);
  assert.deepEqual(currencyBlocks(null), []);
  assert.equal(companyRowOf(TOTALS, 'USD').sales_net, 800);
  assert.equal(companyRowOf(TOTALS).currency, 'GBP', 'no currency asked: the first company row');
  assert.equal(companyRowOf([{ location_id: A }]), null);
});

test('pct never divides by zero', () => {
  assert.equal(pct(260, 1000), 26);
  assert.equal(pct(0, 1000), 0);
  assert.equal(pct(10, 0), null);
  assert.equal(pct(10, null), null);
  assert.equal(pct(null, 10), null);
  assert.equal(pct('abc', 10), null);
});

test('layoutRows: side by side is sites then company; company total is the company rows only', () => {
  assert.deepEqual(layoutRows(TOTALS, 'side').map((r) => r.location_id), [A, B, C, null, null]);
  assert.deepEqual(layoutRows(TOTALS, 'total').map((r) => r.site), ['Company', 'Company']);
  assert.deepEqual(layoutRows(TOTALS, 'anything').map((r) => r.location_id), [A, B, C, null, null]);
  assert.deepEqual(layoutRows(null, 'side'), []);
  // the compare row for a site is the same site; for a company row the same currency's company row
  const then = [{ location_id: A, currency: 'GBP', sales_net: 900 }, { location_id: null, currency: 'USD', sales_net: 700 }, { location_id: null, currency: 'GBP', sales_net: 1400 }];
  assert.equal(matchingRow(TOTALS[0], then).sales_net, 900);
  assert.equal(matchingRow(TOTALS[3], then).sales_net, 1400);
  assert.equal(matchingRow(TOTALS[4], then).sales_net, 700);
  assert.equal(matchingRow(TOTALS[1], then), null);
  assert.equal(matchingRow(null, then), null);
});

test('compareCells: the one percent rule per money column, points for a percent, nothing for text', () => {
  const columns = [
    { key: 'site', label: 'Site', kind: 'text' },
    { key: 'sales_net', label: 'Sales', kind: 'money', noun: 'sales' },
    { key: 'theo_cost', label: 'Theoretical cost', kind: 'money' },
    { key: 'gp_pct_theo', label: 'GP % theo', kind: 'pct' },
    { key: 'sold_qty', label: 'Sold', kind: 'qty' },
    { key: 'opening_day', label: 'Opening', kind: 'day' },
    { key: 'rag', label: 'Rag', kind: 'rag' },
  ];
  const compare = { label: 'vs the week before', detail: 'Mon 28 Sep to Sun 4 Oct' };
  const now = { site: 'North Street', sales_net: 1100, theo_cost: 260, gp_pct_theo: 76.4, sold_qty: 120, opening_day: '2026-10-05', rag: 'green' };
  const then = { site: 'North Street', sales_net: 1000, theo_cost: 300, gp_pct_theo: 70, sold_qty: 0 };
  const cells = compareCells(now, then, { columns, compare });
  assert.deepEqual(Object.keys(cells), ['sales_net', 'theo_cost', 'gp_pct_theo', 'sold_qty']);
  assert.equal(cells.sales_net.chip.kind, 'pct');
  assert.equal(cells.sales_net.chip.text, '+10.0%');
  assert.equal(cells.sales_net.chip.words, 'vs the week before');
  assert.equal(cells.sales_net.delta, 100);
  assert.equal(cells.theo_cost.chip.text, '-13.3%');
  assert.deepEqual([cells.gp_pct_theo.delta.toFixed(1), cells.gp_pct_theo.chip.text, cells.gp_pct_theo.kind], ['6.4', '+6.4 pts', 'pct']);
  assert.equal(cells.sold_qty.chip.kind, 'new', 'sold now, none then: New, never up infinity');
  // the compare period did not load: unknown, never "New"
  const unknown = compareCells(now, null, { columns, compare });
  assert.equal(unknown.sales_net.chip.kind, 'unknown');
  assert.equal(unknown.gp_pct_theo.delta, null);
  assert.equal(unknown.gp_pct_theo.chip.text, '');
  // a percent with no compare figure
  assert.equal(compareCells(now, { gp_pct_theo: null }, { columns, compare }).gp_pct_theo.chip.text, 'No figure to compare with');
  // no columns given: every numeric key reads as money
  const bare = compareCells({ a: 10, b: 'x' }, { a: 5 });
  assert.deepEqual(Object.keys(bare), ['a']);
  assert.equal(bare.a.chip.text, '+100.0%');
  assert.deepEqual(compareCells(null, then), {});
});

test('cellWords: money in the row\'s currency, one decimal percents, days as words, No sales for a null GP', () => {
  assert.equal(cellWords({ kind: 'money' }, 1234.5, 'GBP'), '£1234.50');
  assert.equal(cellWords({ kind: 'money' }, -19.63, 'USD'), '-$19.63', 'the sign before the symbol');
  assert.equal(cellWords({ kind: 'pct' }, 72.84), '72.8%');
  assert.equal(cellWords({ kind: 'pct', key: 'gp_pct_actual' }, null), 'No sales');
  assert.equal(cellWords({ kind: 'pct', key: 'gap_pct' }, null), '');
  assert.equal(cellWords({ kind: 'qty' }, 1234.567), '1,234.57');
  assert.equal(cellWords({ kind: 'qty' }, 12), '12');
  assert.equal(cellWords({ kind: 'day' }, '2026-10-06'), 'Tue 6 Oct');
  assert.equal(cellWords({ kind: 'day' }, '2026-10-06T10:00:00Z'), 'Tue 6 Oct');
  assert.equal(cellWords({ kind: 'rag' }, 'amber'), 'Amber');
  assert.equal(cellWords({ kind: 'text' }, 'North Street'), 'North Street');
  assert.equal(cellWords({ kind: 'money' }, null, 'GBP'), '');
  assert.equal(cellWords(null, 'x'), 'x');
});

test('the CSV runs over meta.columns: money as plain numbers, days as YYYY-MM-DD, totals first', () => {
  const columns = [
    { key: 'sales_net', label: 'Sales', kind: 'money' },
    { key: 'gp_pct_theo', label: 'GP % theo', kind: 'pct' },
    { key: 'opening_day', label: 'Opening day', kind: 'day' },
    { key: 'note', label: 'Note', kind: 'text' },
    { key: 'rag', label: 'Colours', kind: 'rag' },
  ];
  const cols = withSiteColumns(columns);
  assert.deepEqual(cols.slice(0, 2).map((c) => c.key), ['site', 'currency']);
  assert.equal(cols.length, 7);
  assert.equal(withSiteColumns([{ key: 'site', label: 'Site', kind: 'text' }, { key: 'currency', label: 'Currency', kind: 'text' }]).length, 2, 'never doubled');
  const rows = [
    { site: 'North Street', currency: 'GBP', sales_net: 1000.456, gp_pct_theo: 74.123, opening_day: '2026-10-05', note: 'a, b', rag: { gp_pct: 'green' } },
    { site: 'Company', currency: 'GBP', sales_net: 1500, gp_pct_theo: null, opening_day: new Date(Date.UTC(2026, 9, 5, 12)), note: null, rag: 'green' },
  ];
  const csv = columnsToCsv(cols, rows);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Site,Currency,Sales,GP % theo,Opening day,Note,Colours');
  assert.equal(lines[1], 'North Street,GBP,1000.46,74.123,2026-10-05,"a, b","{""gp_pct"":""green""}"');
  assert.equal(lines[2], 'Company,GBP,1500,,2026-10-05,,green');
  assert.doesNotMatch(csv, /£|\$/, 'money as plain numbers');
  assert.equal(columnsToCsv(columns, null).split('\r\n').length, 1, 'headers alone for no rows');
});

test('the export file name is the one the edge function gives', () => {
  assert.equal(exportFileName('gap', '2026-10-05', '2026-10-11'), 'gap-2026-10-05-2026-10-11.csv');
  assert.equal(exportFileName('product gp/x', '2026-10-05', '2026-10-11'), 'product_gp_x-2026-10-05-2026-10-11.csv');
  assert.equal(exportFileName(null, null, null), 'report--.csv');
});

test('no dashes in any words this file writes', () => {
  const words = [RULES_LINE, CAP_LINE, countedWords(false), windowWords(META.windows[2]), ...windowFlags(META.windows[2]), takesFromLine(META.windows[2]),
    notPostedLine(META), demoLine(META), currencyLine(META), ...metaLines(META), gpWords(META, {}).text];
  for (const w of words) assert.doesNotMatch(String(w), /[\u2013\u2014]/, w);
});
