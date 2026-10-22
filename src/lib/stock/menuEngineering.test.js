/** menuEngineering.test.js: Drop 4a (web-reports). The Star, Plowhorse, Puzzle, Dog rule. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  CLASSES, POPULARITY_FACTOR, CLASS_WORDS, gpOf, isKnown, engineeringThresholds, classOf, classifyProducts,
  engineeringSummary, gpPctOf, spreadPct, pivotBySite, plateCostNotes,
} from './menuEngineering.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');

// Four products, one of each class, plus one with no plate cost.
// Shares: 40, 40, 10, 10 of 100 units. Average share 25%, floor 17.5%. GP per unit: 4, 1, 4, 1; average 2.5.
const ROWS = [
  { menu_item_id: 'p-star', name: 'Flat white', sold_qty: 40, sales_net: 200, theo_cost: 40 },
  { menu_item_id: 'p-plow', name: 'Filter', sold_qty: 40, sales_net: 100, theo_cost: 60 },
  { menu_item_id: 'p-puzzle', name: 'Cortado', sold_qty: 10, sales_net: 60, theo_cost: 20 },
  { menu_item_id: 'p-dog', name: 'Tea', sold_qty: 10, sales_net: 20, theo_cost: 10 },
  { menu_item_id: 'p-none', name: 'Bun', sold_qty: 30, sales_net: 90, theo_cost: null },
];

test('the four classes and their words carry no long dashes', () => {
  assert.deepEqual([...CLASSES], ['Star', 'Plowhorse', 'Puzzle', 'Dog']);
  for (const c of [...CLASSES, 'Unknown']) {
    assert.ok(CLASS_WORDS[c].label, c);
    assert.doesNotMatch(`${CLASS_WORDS[c].label} ${CLASS_WORDS[c].blurb} ${CLASS_WORDS[c].action}`, /[\u2013\u2014]/, c);
  }
  assert.equal(POPULARITY_FACTOR, 0.7);
});

test('gpOf: the row gp, else net minus plate cost, else null', () => {
  assert.equal(gpOf({ gp: 12.5 }), 12.5);
  assert.equal(gpOf({ sales_net: 10, theo_cost: 4 }), 6);
  assert.equal(gpOf({ sales_net: 10, theo_cost: null }), null);
  assert.equal(gpOf({ sales_net: '10', theo_cost: '2.5' }), 7.5);
  assert.equal(gpOf(null), null);
});

test('isKnown: something sold and a plate cost', () => {
  assert.equal(isKnown({ sold_qty: 1, theo_cost: 0 }), true);
  assert.equal(isKnown({ sold_qty: 0, theo_cost: 1 }), false);
  assert.equal(isKnown({ sold_qty: 5, theo_cost: null }), false);
});

test('thresholds are weighted: average share over known products, GP per unit over all units', () => {
  const t = engineeringThresholds(ROWS);
  assert.equal(t.products, 4);
  assert.equal(t.total_qty, 100);
  assert.equal(t.avg_share, 25);
  assert.equal(t.popularity_floor, 17.5);
  // GP: 160 + 40 + 40 + 10 = 250 over 100 units
  assert.equal(t.avg_gp_per_unit, 2.5);
  const none = engineeringThresholds([]);
  assert.equal(none.avg_share, null);
  assert.equal(none.avg_gp_per_unit, null);
});

test('classOf: popular and earns = Star, popular only = Plowhorse, earns only = Puzzle, neither = Dog', () => {
  const t = engineeringThresholds(ROWS);
  assert.equal(classOf(ROWS[0], t), 'Star');
  assert.equal(classOf(ROWS[1], t), 'Plowhorse');
  assert.equal(classOf(ROWS[2], t), 'Puzzle');
  assert.equal(classOf(ROWS[3], t), 'Dog');
  assert.equal(classOf(ROWS[4], t), 'Unknown');
  assert.equal(classOf(ROWS[0], null), 'Unknown');
});

test('at the line itself a product is not above it (above, never at or above)', () => {
  // Two equal products: share 50 each, floor 35: both popular. GP per unit equal: nobody earns above average.
  const rows = [
    { menu_item_id: 'a', sold_qty: 10, sales_net: 50, theo_cost: 20 },
    { menu_item_id: 'b', sold_qty: 10, sales_net: 50, theo_cost: 20 },
  ];
  const out = classifyProducts(rows);
  assert.deepEqual(out.map((r) => r.class), ['Plowhorse', 'Plowhorse']);
});

test('classifyProducts fills gp, gp per unit, share and class; keeps a class the database gave', () => {
  const out = classifyProducts(ROWS);
  const star = out.find((r) => r.menu_item_id === 'p-star');
  assert.equal(star.gp, 160);
  assert.equal(star.gp_per_unit, 4);
  assert.equal(star.popularity_share, 40);
  assert.equal(star.class, 'Star');
  const none = out.find((r) => r.menu_item_id === 'p-none');
  assert.equal(none.gp, null);
  assert.equal(none.class, 'Unknown');
  // the unknown product is left out of the shares
  assert.equal(out.find((r) => r.menu_item_id === 'p-dog').popularity_share, 10);
  const kept = classifyProducts([{ ...ROWS[3], class: 'Star' }, ROWS[0]]);
  assert.equal(kept[0].class, 'Star', 'the database judged the whole set; one page of it does not re-judge');
  const bad = classifyProducts([{ ...ROWS[3], class: 'Cat' }, ROWS[0]]);
  assert.notEqual(bad[0].class, 'Cat');
});

test('engineeringSummary counts every class, zeros when empty', () => {
  const s = engineeringSummary(ROWS);
  assert.equal(s.Star.count, 1);
  assert.equal(s.Star.gp, 160);
  assert.equal(s.Plowhorse.sold_qty, 40);
  assert.equal(s.Puzzle.sales_net, 60);
  assert.equal(s.Dog.count, 1);
  assert.equal(s.Unknown.count, 1);
  assert.equal(s.Unknown.gp, 0);
  const empty = engineeringSummary([]);
  for (const c of [...CLASSES, 'Unknown']) assert.deepEqual(empty[c], { count: 0, sold_qty: 0, sales_net: 0, gp: 0 });
});

test('gpPctOf never divides by zero; spreadPct needs a low cost above zero', () => {
  assert.equal(gpPctOf(200, 150), 75);
  assert.equal(gpPctOf(0, 10), null);
  assert.equal(gpPctOf(100, null), null);
  assert.equal(spreadPct(1, 1.25), 25);
  assert.equal(spreadPct(0, 2), null);
  assert.equal(spreadPct(null, 2), null);
  assert.equal(spreadPct(2, 2), 0);
});

test('pivotBySite: the master id joins one product across sites; two currencies stay two rows', () => {
  const rows = [
    { location_id: 's1', menu_item_id: 'm-a1', product_key: 'master-1', currency: 'GBP', name: 'Flat white', sold_qty: 10, sales_net: 50, theo_cost: 10, gp_pct: 80 },
    { location_id: 's2', menu_item_id: 'm-b7', product_key: 'master-1', currency: 'GBP', name: 'Flat white', sold_qty: 10, sales_net: 40, theo_cost: 10, gp_pct: 75 },
    { location_id: 's3', menu_item_id: 'm-c2', product_key: 'master-1', currency: 'USD', name: 'Flat white', sold_qty: 5, sales_net: 30, theo_cost: 6, gp_pct: 80 },
  ];
  const { rows: out } = pivotBySite(rows, ['s1', 's2', 's3']);
  assert.equal(out.length, 2);
  const gbp = out.find((r) => r.currency === 'GBP');
  const usd = out.find((r) => r.currency === 'USD');
  assert.equal(gbp.sales_net, 90);
  assert.equal(gbp['site:s1'], 80);
  assert.equal(gbp['site:s2'], 75);
  assert.equal(gbp['site:s3'], null);
  assert.equal(usd.sales_net, 30);
  assert.equal(usd['site:s3'], 80);
});

test('pivotBySite: one row per product, a cell per site, the sums per product, sorted by net sales', () => {
  const rows = [
    { location_id: 's1', menu_item_id: 'p1', name: 'Flat white', type: 'drink', sold_qty: 10, sales_net: 50, theo_cost: 10, gp_pct: 80 },
    { location_id: 's2', menu_item_id: 'p1', name: 'Flat white', type: 'drink', sold_qty: 20, sales_net: 100, theo_cost: 30, gp_pct: 70 },
    { location_id: 's1', menu_item_id: 'p2', name: 'Tea', type: 'drink', sold_qty: 5, sales_net: 10, theo_cost: null, gp_pct: null },
    { location_id: 's2', menu_item_id: 'p3', name: 'Bun', type: 'food', sold_qty: 50, sales_net: 200, theo_cost: 80, gp_pct: 60 },
  ];
  const { rows: out, sites } = pivotBySite(rows, ['s1', 's2', 's3']);
  assert.deepEqual(sites, ['s1', 's2', 's3']);
  assert.deepEqual(out.map((r) => r.menu_item_id), ['p3', 'p1', 'p2']);
  const p1 = out[1];
  assert.equal(p1.sold_qty, 30);
  assert.equal(p1.sales_net, 150);
  assert.equal(p1.theo_cost, 40);
  assert.equal(p1.gp, 110);
  assert.ok(Math.abs(p1.gp_pct - 73.3333) < 0.001);
  assert.equal(p1['site:s1'], 80);
  assert.equal(p1['site:s2'], 70);
  assert.equal(p1['site:s3'], null, 'a site with no sale of it shows nothing');
  const p2 = out[2];
  assert.equal(p2.theo_cost, null, 'one site with no plate cost makes the sum unknown');
  assert.equal(p2.gp, null);
  assert.equal(p2.gp_pct, null);
  assert.equal(p2['site:s1'], null);
  const classes = pivotBySite([{ ...rows[0], class: 'Star' }], ['s1'], 'class').rows[0];
  assert.equal(classes['site:s1'], 'Star');
  assert.deepEqual(pivotBySite([], []).rows, []);
});

test('plateCostNotes: a takes_from day after the window start needs the line', () => {
  const windows = [
    { location_id: 'a', from_day: '2026-10-01', takes_from: '2026-10-08' },
    { location_id: 'b', from_day: '2026-10-01', takes_from: '2026-09-01' },
    { location_id: 'c', from_day: '2026-10-01', takes_from: null },
    { location_id: 'd', from_day: null, takes_from: '2026-10-03' },
  ];
  assert.deepEqual(plateCostNotes(windows), [{ location_id: 'a', day: '2026-10-08' }, { location_id: 'd', day: '2026-10-03' }]);
  assert.deepEqual(plateCostNotes(null), []);
  assert.deepEqual(plateCostNotes(windows, { withNone: true }), [{ location_id: 'a', day: '2026-10-08' }, { location_id: 'c', day: null }, { location_id: 'd', day: '2026-10-03' }],
    'a site with no takes yet says so when asked');
});

test('the till Menu engineering report is untouched by this Drop', () => {
  const src = read('../../backoffice/sections/reports/MenuEngineering.jsx');
  assert.match(src, /function classify\(item, popMed, contribMed\)/, 'its median rule stays');
  assert.doesNotMatch(src, /menuEngineering\.js/, 'it does not import the stock rule');
});
