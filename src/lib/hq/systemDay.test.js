/**
 * systemDay.test.js: the system's figures beside every Daily numbers box.
 * Run: `node --test src/lib/hq/systemDay.test.js`.
 *
 * Pinned:
 *   1. The dayparts are the venue's own service periods (Location settings), keyed by id, in day order;
 *      a period may wrap midnight; a venue with none gets the day as one part and words that say so.
 *   2. A forecast splits by saved hours first, else by the site's own pattern, else stays blank. Pennies add up.
 *   3. Labour is null, not zero, while timesheets wait for approval. COGS follows the venue's basis.
 *   4. Turnover: leavers in the window over average headcount; rows with no start date are left out.
 *   5. resolveDay: a typed box wins, a blank box takes the system figure, sources name each one, the
 *      three older columns fill from the parts named lunch, dinner and late.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  servicePeriods, periodOf, patternFromHours, patternFromChecks, splitForecast, legacyParts, reviewsForDay, turnoverPct,
  systemFields, resolveDay, typedBoxes, partsOf, SYSTEM_KEYS, forecastParts, WHOLE_DAY_KEY,
} from './systemDay.js';

const SHIFTS = [
  { id: 'sh-b', name: 'Breakfast', start: '07:00', end: '11:00' },
  { id: 'sh-l', name: 'Lunch', start: '11:00', end: '17:00' },
  { id: 'sh-d', name: 'Dinner', start: '17:00', end: '23:00' },
  { id: 'sh-n', name: 'Late night', start: '23:00', end: '02:00' },
  { name: 'Broken', start: 'x' },
];

test('servicePeriods and periodOf: the venue\'s own periods, wrap at midnight, nothing outside', () => {
  const p = servicePeriods(SHIFTS);
  assert.deepEqual(p.map((x) => [x.key, x.name, x.startMin, x.endMin]), [['sh-b', 'Breakfast', 420, 660], ['sh-l', 'Lunch', 660, 1020], ['sh-d', 'Dinner', 1020, 1380], ['sh-n', 'Late night', 1380, 120]]);
  assert.equal(periodOf(8 * 60, p), 'sh-b');
  assert.equal(periodOf(12 * 60, p), 'sh-l');
  assert.equal(periodOf(23 * 60 + 30, p), 'sh-n');
  assert.equal(periodOf(1 * 60, p), 'sh-n');
  assert.equal(periodOf(3 * 60, p), null);
  assert.deepEqual(servicePeriods([]), []);
  assert.deepEqual(servicePeriods([{ name: 'Lunch', start: '11:00', end: '15:00' }]).map((x) => x.key), ['lunch']);
});

test('patterns and the split add up to the penny', () => {
  const p = servicePeriods(SHIFTS);
  assert.deepEqual(patternFromHours([{ hour: 12, amount: 300 }, { hour: 19, amount: 600 }, { hour: 23, amount: 100 }], p), { 'sh-b': 0, 'sh-l': 0.3, 'sh-d': 0.6, 'sh-n': 0.1 });
  assert.equal(patternFromHours([], p), null);
  assert.equal(patternFromHours([{ hour: 12, amount: 300 }], []), null);
  const checks = [
    { minutes: 12 * 60, total: 50 }, { minutes: 13 * 60, total: 50, voided: true }, { minutes: 19 * 60, total: 40 }, { minutes: 0, total: 10 }, { minutes: 20 * 60, total: 10, status: 'void' }, { minutes: 4 * 60, total: 999 },
  ];
  assert.deepEqual(patternFromChecks(checks, p), { 'sh-b': 0, 'sh-l': 0.5, 'sh-d': 0.4, 'sh-n': 0.1 });
  const three = servicePeriods(SHIFTS.slice(1, 4));
  assert.deepEqual(splitForecast(1000.01, { 'sh-l': 1 / 3, 'sh-d': 1 / 3, 'sh-n': 1 / 3 }, three), { 'sh-l': 333.34, 'sh-d': 333.34, 'sh-n': 333.33 });
  assert.equal(splitForecast(null, { 'sh-l': 1 }, three), null);
  assert.equal(splitForecast(500, null, three), null);
  assert.deepEqual(splitForecast(0.01, { 'sh-l': 0.5, 'sh-d': 0.5, 'sh-n': 0 }, three), { 'sh-l': 0.01, 'sh-d': 0.01, 'sh-n': 0 });
  assert.deepEqual(legacyParts({ a: { name: 'Lunch', amount: 100 }, b: { name: 'Evening service', amount: 50 }, c: { name: 'Brunch', amount: 7 } }), { lunch: 100, dinner: 50, late: null });
});

test('reviewsForDay and turnoverPct', () => {
  assert.deepEqual(reviewsForDay([{ rating: 5 }, { rating: 4 }, { rating: 'x' }]), { count: 2, avg: 4.5 });
  assert.deepEqual(reviewsForDay([]), { count: 0, avg: null });
  const staff = [
    { status: 'active', start_date: '2025-01-01' },
    { status: 'active', start_date: '2025-01-01' },
    { status: 'active', start_date: '2025-01-01' },
    { status: 'leaver', start_date: '2025-01-01', leaver_date: '2026-10-20' },
    { status: 'leaver', start_date: '2025-01-01', leaver_date: '2026-05-01' },
    { status: 'leaver', start_date: null, leaver_date: '2026-11-01' },
    { status: 'onboarding', start_date: '2026-11-10' },
    { status: 'active', start_date: '2026-11-10' },
  ];
  assert.equal(turnoverPct(staff, '2026-11-16'), 25);
  assert.equal(turnoverPct([], '2026-11-16'), null);
  assert.equal(turnoverPct(staff, null), null);
});

const money = (n) => `£${Number(n).toFixed(2)}`;

test('systemFields: till, labour, COGS, the forecast across the periods, reviews, turnover, typed only', () => {
  const trading = { actual_sales: 4453.9, labour_actual: 1200.5, labour_theo: 1100, cogs_actual: 1336.17, cogs_recipe: 1290, forecast: 4000 };
  const s = systemFields({ trading, settings: { cogs_basis: 'estimate', cogs_pct: 30 }, shifts: SHIFTS.slice(1, 4), patternChecks: [{ minutes: 12 * 60, total: 60 }, { minutes: 19 * 60, total: 40 }], reviews: [{ rating: 5 }, { rating: 4 }], cardCount: 1, staff: [], ymd: '2026-11-01', today: '2026-11-17', money });
  assert.equal(s.net_sales.value, 4453.9); assert.equal(s.net_sales.source, 'till');
  assert.equal(s.labour.value, 1200.5); assert.equal(s.labour.source, 'workforce'); assert.equal(s.labour.hint, 'Rota planned £1100.00.');
  assert.equal(s.cogs.value, 1336.17); assert.equal(s.cogs.source, 'estimate'); assert.match(s.cogs.hint, /£1290.00/);
  assert.deepEqual(s.projected_parts.value, { 'sh-l': { name: 'Lunch', amount: 2400 }, 'sh-d': { name: 'Dinner', amount: 1600 }, 'sh-n': { name: 'Late night', amount: 0 } });
  assert.equal(s.projected_parts.source, 'forecast'); assert.match(s.projected_parts.words, /last four same weekdays/);
  assert.equal(s.projected_parts.periods.length, 3); assert.equal(s.projected_parts.total, 4000);
  assert.equal(s.reviews_count.value, 2); assert.equal(s.review_rating.value, 4.5); assert.match(s.reviews_count.words, /1 feedback card/);
  assert.equal(s.turnover_pct.value, null); assert.equal(s.turnover_pct.source, null);
  assert.equal(s.morale_score.value, null); assert.equal(s.hires_needed.value, null);
  for (const k of SYSTEM_KEYS) assert.ok(k in s, k);
});

test('systemFields: the honest blanks and the one part day', () => {
  const waiting = systemFields({ trading: { actual_sales: 900, labour_actual: 0, labour_theo: 400, forecast: 0 }, settings: { cogs_basis: 'estimate', cogs_pct: 0 }, shifts: SHIFTS, ymd: '2026-11-16', today: '2026-11-17', money });
  assert.equal(waiting.labour.value, null); assert.match(waiting.labour.words, /No approved timesheets yet/);
  assert.equal(waiting.cogs.value, null); assert.match(waiting.cogs.words, /No COGS basis/);
  assert.equal(waiting.projected_parts.value, null); assert.match(waiting.projected_parts.words, /No sales forecast saved/);
  const noFn = systemFields({ trading: null, ymd: '2026-11-20', today: '2026-11-17' });
  assert.equal(noFn.net_sales.value, null); assert.match(noFn.net_sales.words, /not happened yet/);
  const noPeriods = systemFields({ trading: { actual_sales: 100, labour_actual: 10, forecast: 120 }, settings: {}, shifts: [], ymd: '2026-11-16', today: '2026-11-17', money });
  assert.deepEqual(noPeriods.projected_parts.value, { day: { name: 'Whole day', amount: 120 } });
  assert.match(noPeriods.projected_parts.words, /no service periods/);
  const noPattern = systemFields({ trading: { actual_sales: 100, labour_actual: 10, forecast: 120 }, settings: {}, shifts: SHIFTS, ymd: '2026-11-16', today: '2026-11-17', money });
  assert.equal(noPattern.projected_parts.value, null); assert.match(noPattern.projected_parts.words, /no sales pattern yet/);
  const recipe = systemFields({ trading: { actual_sales: 100, labour_actual: 10, cogs_actual: 28, cogs_recipe: 28, forecast: 120 }, settings: { cogs_basis: 'recipe' }, shifts: SHIFTS.slice(1, 3), forecastHours: [{ hour: 12, amount: 60 }, { hour: 18, amount: 60 }], ymd: '2026-11-16', today: '2026-11-17', money });
  assert.equal(recipe.cogs.source, 'stock');
  assert.deepEqual(Object.values(recipe.projected_parts.value).map((p) => p.amount), [60, 60]);
  assert.match(recipe.projected_parts.words, /hours saved/);
  const today = systemFields({ trading: { actual_sales: 250, labour_actual: 0, labour_theo: 0, forecast: 0 }, settings: {}, ymd: '2026-11-17', today: '2026-11-17', money });
  assert.match(today.net_sales.words, /so far today/);
  assert.equal(today.labour.value, null);
});

test('resolveDay, typedBoxes and partsOf', () => {
  const system = systemFields({ trading: { actual_sales: 500, labour_actual: 100, labour_theo: 0, cogs_actual: 150, forecast: 1000 }, settings: { cogs_basis: 'estimate', cogs_pct: 30 }, shifts: SHIFTS.slice(1, 4), patternChecks: [{ minutes: 12 * 60, total: 50 }, { minutes: 19 * 60, total: 50 }], reviews: [{ rating: 4 }], ymd: '2026-11-16', today: '2026-11-17' });
  const row = resolveDay({ cogs: '£160', morale_score: '8.1', 'part:sh-d': '700', notes: ' Busy night ' }, system, 'loc', '2026-11-16');
  assert.equal(row.net_sales, 500); assert.equal(row.sources.net_sales, 'till');
  assert.equal(row.cogs, 160); assert.equal(row.sources.cogs, 'typed');
  assert.equal(row.morale_score, 8.1); assert.equal(row.sources.morale_score, 'typed');
  assert.equal(row.hires_needed, null); assert.equal('hires_needed' in row.sources, false);
  assert.equal(row.reviews_count, 1); assert.equal(row.sources.reviews_count, 'reviews');
  assert.deepEqual(row.projected_parts, { 'sh-l': { name: 'Lunch', amount: 500 }, 'sh-d': { name: 'Dinner', amount: 700 }, 'sh-n': { name: 'Late night', amount: 0 } });
  assert.deepEqual(row.sources.parts, { 'sh-l': 'forecast', 'sh-d': 'typed', 'sh-n': 'forecast' });
  assert.equal(row.projected_lunch, 500); assert.equal(row.projected_dinner, 700); assert.equal(row.projected_late, 0);
  assert.equal(row.sources.projected_dinner, 'typed');
  assert.equal(row.source, 'typed'); assert.equal(row.notes, 'Busy night');
  const clean = resolveDay({}, system, 'loc', '2026-11-16');
  assert.equal(clean.source, 'system'); assert.equal(clean.cogs, 150); assert.equal(clean.sources.projected_lunch, 'forecast');
  const bare = resolveDay({ net_sales: '10' }, {}, 'loc', '2026-11-16');
  assert.deepEqual(bare.projected_parts, {}); assert.equal(bare.projected_lunch, null); assert.equal('parts' in bare.sources, false);
  const boxes = typedBoxes(row);
  assert.equal(boxes.cogs, '160'); assert.equal(boxes.net_sales, ''); assert.equal(boxes.morale_score, '8.1'); assert.equal(boxes.notes, 'Busy night');
  assert.equal(boxes['part:sh-d'], '700'); assert.equal('part:sh-l' in boxes, false);
  assert.deepEqual(partsOf(row).map((p) => [p.key, p.name, p.amount]), [['sh-l', 'Lunch', 500], ['sh-d', 'Dinner', 700], ['sh-n', 'Late night', 0]]);
  assert.deepEqual(partsOf({ projected_lunch: 10, projected_late: 5 }).map((p) => [p.key, p.amount]), [['lunch', 10], ['late', 5]]);
  assert.deepEqual(partsOf({}), []);
});

test('rows from before slice 3: an empty sources map reads as typed, never as blank', () => {
  const old = { net_sales: 10, morale_score: 7, source: 'typed', sources: {} };
  assert.equal(typedBoxes(old).net_sales, '10');
  assert.equal(typedBoxes(old).morale_score, '7');
  assert.equal(typedBoxes({ net_sales: 10, source: 'csv', sources: {} }).net_sales, '10');
  assert.equal(typedBoxes({ net_sales: 10, source: 'system', sources: { net_sales: 'till' } }).net_sales, '');
});

test('forecastParts (slice 4): the Scorecard splits today\'s forecast by saved hours, else the whole day, never a guess', () => {
  // Hours saved against the forecast: split by them across the site's own periods, pennies on the last.
  const hours = [{ hour: 8, amount: 100 }, { hour: 12, amount: 200 }, { hour: 19, amount: 100 }];
  const split = forecastParts(1000, hours, SHIFTS);
  assert.deepEqual(split.map((p) => [p.key, p.name, p.amount]), [['sh-b', 'Breakfast', 250], ['sh-l', 'Lunch', 500], ['sh-d', 'Dinner', 250], ['sh-n', 'Late night', 0]]);
  // Periods but no hours: one Whole day part, not an even split.
  assert.deepEqual(forecastParts(1000, [], SHIFTS), [{ key: WHOLE_DAY_KEY, name: 'Whole day', amount: 1000 }]);
  // No periods at all: the same whole day.
  assert.deepEqual(forecastParts('640.5', hours, []), [{ key: WHOLE_DAY_KEY, name: 'Whole day', amount: 640.5 }]);
  // No forecast: nothing, so the Scorecard falls back to the last logged day.
  assert.deepEqual(forecastParts(0, hours, SHIFTS), []);
  assert.deepEqual(forecastParts(null, hours, SHIFTS), []);
  assert.deepEqual(forecastParts(undefined, null, null), []);
});
