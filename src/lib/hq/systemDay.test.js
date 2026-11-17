/**
 * systemDay.test.js: the system's figures beside every Daily numbers box.
 * Run: `node --test src/lib/hq/systemDay.test.js`.
 *
 * Pinned:
 *   1. Dayparts: venue service periods win over the 17:00 / 22:00 default; before the day start is late night.
 *   2. A forecast splits by saved hours first, else by the site's own pattern, else stays blank. Pennies add up.
 *   3. Labour is null, not zero, while timesheets wait for approval. COGS follows the venue's basis.
 *   4. Turnover: leavers in the window over average headcount; rows with no start date are left out.
 *   5. resolveDay: a typed box wins, a blank box takes the system figure, sources name each one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daypartBounds, daypartOf, patternFromHours, patternFromChecks, splitForecast, reviewsForDay, turnoverPct,
  systemFields, resolveDay, typedBoxes, SYSTEM_KEYS,
} from './systemDay.js';

test('daypartBounds and daypartOf', () => {
  assert.deepEqual(daypartBounds([]), { dinnerStart: 1020, lateStart: 1320, source: 'default' });
  const venue = daypartBounds([{ name: 'Lunch', start: '11:00', end: '16:00' }, { name: 'Dinner service', start: '16:00', end: '23:00' }, { name: 'Late night', start: '23:00', end: '02:00' }]);
  assert.deepEqual(venue, { dinnerStart: 960, lateStart: 1380, source: 'venue' });
  assert.equal(daypartBounds([{ name: 'Evening', start: '18:00' }]).lateStart, 1320);
  assert.equal(daypartOf(12 * 60), 'lunch');
  assert.equal(daypartOf(17 * 60), 'dinner');
  assert.equal(daypartOf(22 * 60), 'late');
  assert.equal(daypartOf(1 * 60), 'late');
  assert.equal(daypartOf(7 * 60), 'lunch');
  assert.equal(daypartOf(16 * 60 + 30, venue), 'dinner');
});

test('patterns and the split add up to the penny', () => {
  assert.deepEqual(patternFromHours([{ hour: 12, amount: 300 }, { hour: 19, amount: 600 }, { hour: 23, amount: 100 }]), { lunch: 0.3, dinner: 0.6, late: 0.1 });
  assert.equal(patternFromHours([]), null);
  const checks = [
    { minutes: 12 * 60, total: 50 }, { minutes: 13 * 60, total: 50, voided: true }, { minutes: 19 * 60, total: 40 }, { minutes: 0, total: 10 }, { minutes: 20 * 60, total: 10, status: 'void' },
  ];
  assert.deepEqual(patternFromChecks(checks), { lunch: 0.5, dinner: 0.4, late: 0.1 });
  assert.deepEqual(splitForecast(1000.01, { lunch: 1 / 3, dinner: 1 / 3, late: 1 / 3 }), { lunch: 333.34, dinner: 333.34, late: 333.33 });
  assert.deepEqual(splitForecast(null, { lunch: 1, dinner: 0, late: 0 }), { lunch: null, dinner: null, late: null });
  assert.deepEqual(splitForecast(500, null), { lunch: null, dinner: null, late: null });
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
  // As of 16 Nov: window 19 Aug to 16 Nov. Head at 18 Aug = 4 (three active plus the October leaver); head at 16 Nov = 4 (three plus the new starter). One leaver.
  assert.equal(turnoverPct(staff, '2026-11-16'), 25);
  assert.equal(turnoverPct([], '2026-11-16'), null);
  assert.equal(turnoverPct(staff, null), null);
});

const money = (n) => `£${Number(n).toFixed(2)}`;

test('systemFields: till, labour, COGS, forecast split, reviews, turnover, typed only', () => {
  const trading = { actual_sales: 4453.9, labour_actual: 1200.5, labour_theo: 1100, cogs_actual: 1336.17, cogs_recipe: 1290, forecast: 4000 };
  const s = systemFields({ trading, settings: { cogs_basis: 'estimate', cogs_pct: 30 }, patternChecks: [{ minutes: 12 * 60, total: 60 }, { minutes: 19 * 60, total: 40 }], reviews: [{ rating: 5 }, { rating: 4 }], cardCount: 1, staff: [], ymd: '2026-11-01', today: '2026-11-17', money });
  assert.equal(s.net_sales.value, 4453.9); assert.equal(s.net_sales.source, 'till');
  assert.equal(s.labour.value, 1200.5); assert.equal(s.labour.source, 'workforce'); assert.equal(s.labour.hint, 'Rota planned £1100.00.');
  assert.equal(s.cogs.value, 1336.17); assert.equal(s.cogs.source, 'estimate'); assert.match(s.cogs.hint, /£1290.00/);
  assert.equal(s.projected_lunch.value, 2400); assert.equal(s.projected_dinner.value, 1600); assert.equal(s.projected_late.value, 0);
  assert.equal(s.projected_lunch.source, 'forecast'); assert.match(s.projected_lunch.words, /last four same weekdays/);
  assert.equal(s.reviews_count.value, 2); assert.equal(s.review_rating.value, 4.5); assert.match(s.reviews_count.words, /1 feedback card/);
  assert.equal(s.turnover_pct.value, null); assert.equal(s.turnover_pct.source, null);
  assert.equal(s.morale_score.value, null); assert.equal(s.hires_needed.value, null);
  for (const k of SYSTEM_KEYS) assert.ok(k in s, k);
});

test('systemFields: the honest blanks', () => {
  const waiting = systemFields({ trading: { actual_sales: 900, labour_actual: 0, labour_theo: 400, forecast: 0 }, settings: { cogs_basis: 'estimate', cogs_pct: 0 }, ymd: '2026-11-16', today: '2026-11-17', money });
  assert.equal(waiting.labour.value, null); assert.match(waiting.labour.words, /No approved timesheets yet/);
  assert.equal(waiting.cogs.value, null); assert.match(waiting.cogs.words, /No COGS basis/);
  assert.equal(waiting.projected_lunch.value, null); assert.match(waiting.projected_lunch.words, /No sales forecast saved/);
  const noFn = systemFields({ trading: null, ymd: '2026-11-20', today: '2026-11-17' });
  assert.equal(noFn.net_sales.value, null); assert.match(noFn.net_sales.words, /not happened yet/);
  const recipe = systemFields({ trading: { actual_sales: 100, labour_actual: 10, cogs_actual: 28, cogs_recipe: 28, forecast: 120 }, settings: { cogs_basis: 'recipe' }, forecastHours: [{ hour: 12, amount: 60 }, { hour: 18, amount: 60 }], ymd: '2026-11-16', today: '2026-11-17', money });
  assert.equal(recipe.cogs.source, 'stock');
  assert.deepEqual([recipe.projected_lunch.value, recipe.projected_dinner.value, recipe.projected_late.value], [60, 60, 0]);
  assert.match(recipe.projected_lunch.words, /hours saved/);
  const today = systemFields({ trading: { actual_sales: 250, labour_actual: 0, labour_theo: 0, forecast: 0 }, settings: {}, ymd: '2026-11-17', today: '2026-11-17', money });
  assert.match(today.net_sales.words, /so far today/);
  assert.equal(today.labour.value, null);
});

test('resolveDay and typedBoxes', () => {
  const system = systemFields({ trading: { actual_sales: 500, labour_actual: 100, labour_theo: 0, cogs_actual: 150, forecast: 0 }, settings: { cogs_basis: 'estimate', cogs_pct: 30 }, reviews: [{ rating: 4 }], ymd: '2026-11-16', today: '2026-11-17' });
  const row = resolveDay({ cogs: '£160', morale_score: '8.1', notes: ' Busy night ' }, system, 'loc', '2026-11-16');
  assert.equal(row.net_sales, 500); assert.equal(row.sources.net_sales, 'till');
  assert.equal(row.cogs, 160); assert.equal(row.sources.cogs, 'typed');
  assert.equal(row.morale_score, 8.1); assert.equal(row.sources.morale_score, 'typed');
  assert.equal(row.hires_needed, null); assert.equal('hires_needed' in row.sources, false);
  assert.equal(row.reviews_count, 1); assert.equal(row.sources.reviews_count, 'reviews');
  assert.equal(row.source, 'typed'); assert.equal(row.notes, 'Busy night');
  const clean = resolveDay({}, system, 'loc', '2026-11-16');
  assert.equal(clean.source, 'system'); assert.equal(clean.cogs, 150);
  const boxes = typedBoxes(row);
  assert.equal(boxes.cogs, '160'); assert.equal(boxes.net_sales, ''); assert.equal(boxes.morale_score, '8.1'); assert.equal(boxes.notes, 'Busy night');
  // A slice 1 row (no sources map) shows every figure as typed, which it was.
  assert.equal(typedBoxes({ net_sales: 10, source: 'typed' }).net_sales, '10');
});

test('rows from before slice 3: an empty sources map reads as typed, never as blank', () => {
  const old = { net_sales: 10, morale_score: 7, source: 'typed', sources: {} };
  assert.equal(typedBoxes(old).net_sales, '10');
  assert.equal(typedBoxes(old).morale_score, '7');
  assert.equal(typedBoxes({ net_sales: 10, source: 'csv', sources: {} }).net_sales, '10');
  assert.equal(typedBoxes({ net_sales: 10, source: 'system', sources: { net_sales: 'till' } }).net_sales, '');
  assert.deepEqual(splitForecast(0.01, { lunch: 0.5, dinner: 0.5, late: 0 }), { lunch: 0.01, dinner: 0.01, late: 0 });
});
