// src/lib/stock/salesForecast.test.js
//
// Multi site stock Drop 3 (v5.11.96, contract 2.3): one forecast for staff and stock. suggestForecast
// moved word for word from src/staff/rotaRules.js (the rota re exports it), plus historyFromRows,
// forecastUseScale and baselineFor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggestForecast, historyFromRows, forecastUseScale, baselineFor } from '../../../supabase/functions/_shared/salesForecast.js';
import { suggestForecast as fromRota } from '../../staff/rotaRules.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('the rota and stock read the same suggestForecast', () => {
  assert.equal(fromRota, suggestForecast, 'rotaRules re exports the shared function');
  const rota = read('../../staff/rotaRules.js');
  assert.match(rota, /export \{ suggestForecast \} from '\.\.\/\.\.\/supabase\/functions\/_shared\/salesForecast\.js';/);
  assert.doesNotMatch(rota, /export function suggestForecast/, 'no second copy');
  assert.doesNotMatch(read('../../../supabase/functions/_shared/salesForecast.js'), /^import /m, 'pure: no imports');
});

test('suggestForecast: the weekday pattern, recent weeks weighted, closed days ignored', () => {
  const history = {};
  // four Mondays at 100 and four Tuesdays at 300, a closed Wednesday
  for (const [d, v] of [['2026-09-28', 100], ['2026-10-05', 100], ['2026-10-12', 100], ['2026-10-19', 100],
    ['2026-09-29', 300], ['2026-10-06', 300], ['2026-10-13', 300], ['2026-10-20', 300], ['2026-10-21', 0]]) history[d] = v;
  const f = suggestForecast(history, ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(f['2026-10-26'], { amount: 100, samples: 4 });
  assert.deepEqual(f['2026-10-27'], { amount: 300, samples: 4 });
  assert.equal(f['2026-10-28'], undefined, 'no history for a closed weekday');
  assert.deepEqual(suggestForecast({}, ['2026-10-26']), {});
});

test('historyFromRows: stock_sales_history rows to { day: net }, same days added', () => {
  assert.deepEqual(historyFromRows([
    { business_day: '2026-10-20', net: 120.5 },
    { business_day: '2026-10-20', net: '30.25' },
    { business_day: '2026-10-21T00:00:00', net: 80 },
    { business_day: null, net: 5 },
    { business_day: '2026-10-22', net: 'x' },
  ]), { '2026-10-20': 150.75, '2026-10-21': 80 });
  assert.deepEqual(historyFromRows(null), {});
});

test('forecastUseScale: forecast over the usual day, between 0.25 and 4, 1 when either is 0', () => {
  assert.equal(forecastUseScale({ forecastDay: 1500, baselineDay: 1000 }), 1.5);
  assert.equal(forecastUseScale({ forecastDay: 100, baselineDay: 1000 }), 0.25);
  assert.equal(forecastUseScale({ forecastDay: 9000, baselineDay: 1000 }), 4);
  assert.equal(forecastUseScale({ forecastDay: 0, baselineDay: 1000 }), 1);
  assert.equal(forecastUseScale({ forecastDay: 500, baselineDay: 0 }), 1);
  assert.equal(forecastUseScale({}), 1);
  assert.equal(forecastUseScale(), 1);
});

test('baselineFor: the same weekday of the last 4 weeks, closed days left out', () => {
  const h = { '2026-10-15': 100, '2026-10-08': 200, '2026-10-01': 0, '2026-09-24': 300, '2026-09-17': 999 };
  assert.equal(baselineFor(h, '2026-10-22'), 200, '(100 + 200 + 300) / 3; five weeks back is not read');
  assert.equal(baselineFor({}, '2026-10-22'), 0);
  assert.equal(baselineFor(h, 'bad'), 0);
});
