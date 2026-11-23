/**
 * targets.test.js: the head office red, amber, green rule.
 * Run: `node --test src/lib/hq/targets.test.js`.
 *
 * Pinned:
 *   1. A site row beats the company row beats the default; money metrics have no default.
 *   2. Lower is better for costs, higher for morale, rating and checks; null has no colour.
 *   3. A band the wrong way round is refused with words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HQ_METRICS, HQ_METRIC_KEYS, HQ_TARGET_DEFAULTS, resolveTargets, ragOf, bandProblem, bandWords, metricsForDepartment } from './targets.js';

test('every metric has a label, a direction and a department; defaults obey their own ordering rule', () => {
  for (const m of HQ_METRICS) {
    assert.ok(m.label && typeof m.higherIsBetter === 'boolean' && m.department, m.key);
    const d = HQ_TARGET_DEFAULTS[m.key];
    if (d) assert.equal(bandProblem(m.key, d.green_to, d.amber_to), null, m.key);
  }
  assert.equal(HQ_TARGET_DEFAULTS.cash_held, undefined);
  assert.equal(HQ_TARGET_DEFAULTS.net_sales_day, undefined);
});

test('resolveTargets: site over company over default, money metrics only when set', () => {
  const rows = [
    { metric: 'prime_cost_pct', location_id: null, green_to: 58, amber_to: 63 },
    { metric: 'prime_cost_pct', location_id: 'a2', green_to: 62, amber_to: 66 },
    { metric: 'cash_held', location_id: null, green_to: 2000, amber_to: 4000 },
  ];
  const a1 = resolveTargets(rows, 'a1');
  assert.deepEqual(a1.prime_cost_pct, { green_to: 58, amber_to: 63, source: 'company' });
  assert.deepEqual(a1.cash_held, { green_to: 2000, amber_to: 4000, source: 'company' });
  assert.deepEqual(a1.labour_pct, { green_to: 30, amber_to: 33, source: 'default' });
  assert.equal(a1.net_sales_day, undefined);
  const a2 = resolveTargets(rows, 'a2');
  assert.deepEqual(a2.prime_cost_pct, { green_to: 62, amber_to: 66, source: 'site' });
  const none = resolveTargets([], null);
  assert.equal(none.prime_cost_pct.source, 'default');
  assert.equal(Object.keys(none).length, Object.keys(HQ_TARGET_DEFAULTS).length);
});

test('ragOf: both directions, the edges, and null', () => {
  const low = { green_to: 60, amber_to: 65 };
  assert.equal(ragOf('prime_cost_pct', 59.9, low), 'grn');
  assert.equal(ragOf('prime_cost_pct', 60, low), 'grn');
  assert.equal(ragOf('prime_cost_pct', 64, low), 'orn');
  assert.equal(ragOf('prime_cost_pct', 65.01, low), 'red');
  const high = { green_to: 95, amber_to: 85 };
  assert.equal(ragOf('checks_pct', 100, high), 'grn');
  assert.equal(ragOf('checks_pct', 90, high), 'orn');
  assert.equal(ragOf('checks_pct', 84, high), 'red');
  assert.equal(ragOf('checks_pct', null, high), null);
  assert.equal(ragOf('checks_pct', 90, null), null);
  assert.equal(ragOf('nope', 90, high), null);
});

test('bandProblem: words for a bad band, null for a good one', () => {
  assert.equal(bandProblem('prime_cost_pct', 60, 65), null);
  assert.match(bandProblem('prime_cost_pct', 65, 60), /at or below/);
  assert.match(bandProblem('checks_pct', 85, 95), /at or above/);
  assert.match(bandProblem('prime_cost_pct', '', 65), /Both numbers/);
  assert.match(bandProblem('prime_cost_pct', 101, 102), /0 to 100/);
  assert.match(bandProblem('review_rating', 6, 5), /0 to 5/);
  assert.match(bandProblem('cash_held', -1, 5), /negative/);
  assert.equal(bandProblem('cash_held', 2000, 4000), null);
});

test('bandWords and metricsForDepartment', () => {
  assert.deepEqual(bandWords('prime_cost_pct', { green_to: 60, amber_to: 65 }, (n) => `${n}%`), { grn: 'up to 60%', orn: '60% to 65%', red: 'over 65%' });
  assert.deepEqual(bandWords('morale_score', { green_to: 8, amber_to: 6.5 }), { grn: '8 and up', orn: '6.5 to 8', red: 'under 6.5' });
  assert.deepEqual(metricsForDepartment('operations').map((m) => m.key), ['checks_pct']);
  assert.ok(HQ_METRIC_KEYS.includes('safe_variance'));
});
