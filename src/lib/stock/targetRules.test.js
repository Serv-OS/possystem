/**
 * targetRules.test.js: the red, amber, green rule of the head office reports (v5.11.92, multi site
 * stock Drop 4a, contract 1.4 and 2.1). Run: npm test.
 *
 * Pinned: the seven metrics and their labels; the defaults block (the mockup's colours); gp_pct is
 * better high and every other metric better low; a null value has no colour; the words under a
 * target; the checks before a save (ranges, the order rule, at most 100 rows).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_METRICS, TARGET_METRIC_KEYS, TARGET_DEFAULTS, BETTER_HIGH, TARGET_ORDER_WORDS,
  isTargetMetric, targetFor, ragOf, ragTone, targetWords, targetMax, validTargets,
} from './targetRules.js';

test('seven metrics, in the panel order, with plain labels', () => {
  assert.deepEqual(TARGET_METRIC_KEYS, ['gp_pct', 'gap_pct', 'waste_pct', 'comps_pct', 'days_on_hand', 'budget_pct', 'no_recipe_pct']);
  assert.deepEqual(TARGET_METRICS.map((m) => m.label), ['GP %', 'Gap %', 'Waste %', 'Loyalty, staff and comps %', 'Days on hand', 'Purchases against budget %', 'Sales with no recipe %']);
  assert.ok(Object.isFrozen(TARGET_METRICS) && Object.isFrozen(TARGET_DEFAULTS) && Object.isFrozen(BETTER_HIGH));
  for (const m of TARGET_METRICS) assert.ok(isTargetMetric(m.key), m.key);
  for (const bad of ['gp', '', null, undefined, 3, {}]) assert.equal(isTargetMetric(bad), false, String(bad));
  assert.deepEqual([...BETTER_HIGH], ['gp_pct']);
});

test('the defaults are the mockup\'s colours (gap over 2.5 red, over 1.8 amber; waste over 2.5 amber)', () => {
  assert.deepEqual(TARGET_DEFAULTS, {
    gp_pct: { green_to: 70, amber_to: 65 },
    gap_pct: { green_to: 1.8, amber_to: 2.5 },
    waste_pct: { green_to: 2.5, amber_to: 3.5 },
    comps_pct: { green_to: 1.5, amber_to: 2.5 },
    days_on_hand: { green_to: 7, amber_to: 10 },
    budget_pct: { green_to: 100, amber_to: 105 },
    no_recipe_pct: { green_to: 3, amber_to: 6 },
  });
  assert.deepEqual(Object.keys(TARGET_DEFAULTS), TARGET_METRIC_KEYS, 'one default per metric');
  // every default is on the right side of itself
  for (const k of TARGET_METRIC_KEYS) {
    const d = TARGET_DEFAULTS[k];
    assert.ok(BETTER_HIGH.includes(k) ? d.green_to >= d.amber_to : d.green_to <= d.amber_to, k);
  }
});

test('ragOf: the SQL rule word for word', () => {
  // gp_pct: higher is better
  assert.equal(ragOf('gp_pct', 74.1), 'green');
  assert.equal(ragOf('gp_pct', 70), 'green');
  assert.equal(ragOf('gp_pct', 69.9), 'amber');
  assert.equal(ragOf('gp_pct', 65), 'amber');
  assert.equal(ragOf('gp_pct', 64.9), 'red');
  // gap_pct: lower is better (the mockup's league)
  assert.equal(ragOf('gap_pct', 1.3), 'green');
  assert.equal(ragOf('gap_pct', 1.8), 'green');
  assert.equal(ragOf('gap_pct', 1.9), 'amber');
  assert.equal(ragOf('gap_pct', 2.5), 'amber');
  assert.equal(ragOf('gap_pct', 3.1), 'red');
  assert.equal(ragOf('waste_pct', 1.9), 'green');
  assert.equal(ragOf('waste_pct', 2.8), 'amber');
  assert.equal(ragOf('waste_pct', 3.6), 'red');
  assert.equal(ragOf('days_on_hand', 6.2), 'green');
  assert.equal(ragOf('days_on_hand', 8.4), 'amber');
  assert.equal(ragOf('days_on_hand', 10.5), 'red');
  assert.equal(ragOf('budget_pct', 95.7), 'green');
  assert.equal(ragOf('budget_pct', 105.6), 'red');
  assert.equal(ragOf('no_recipe_pct', 2.1), 'green');
  assert.equal(ragOf('no_recipe_pct', 6.5), 'red');
  // a site or company target wins over the default
  assert.equal(ragOf('gap_pct', 1.9, { green_to: 2, amber_to: 3 }), 'green');
  assert.equal(ragOf('gp_pct', 66, { green_to: 75, amber_to: 68 }), 'red');
  // strings from a form read as numbers
  assert.equal(ragOf('gap_pct', '1.3', { green_to: '1.8', amber_to: '2.5' }), 'green');
  // nothing to colour
  for (const v of [null, undefined, '', 'abc', NaN]) assert.equal(ragOf('gp_pct', v), null, String(v));
  assert.equal(ragOf('not_a_metric', 5), null);
  // a half filled target falls back to the default
  assert.equal(ragOf('gap_pct', 1.9, { green_to: 5 }), 'amber');
  assert.deepEqual(targetFor('gap_pct', { green_to: 5 }), { green_to: 1.8, amber_to: 2.5 });
  assert.equal(targetFor('nope'), null);
});

test('ragTone maps to the Pill tones; nothing for no colour', () => {
  assert.equal(ragTone('green'), 'good');
  assert.equal(ragTone('amber'), 'warn');
  assert.equal(ragTone('red'), 'bad');
  assert.equal(ragTone(null), null);
  assert.equal(ragTone('blue'), null);
});

test('targetWords say which side is green in plain words', () => {
  assert.equal(targetWords('gp_pct'), 'Green from 70%, amber from 65%');
  assert.equal(targetWords('gap_pct'), 'Green up to 1.8%, amber up to 2.5%');
  assert.equal(targetWords('days_on_hand'), 'Green up to 7 days, amber up to 10 days');
  assert.equal(targetWords('days_on_hand', { green_to: 1, amber_to: 2 }), 'Green up to 1 day, amber up to 2 days');
  assert.equal(targetWords('budget_pct', { green_to: 98.5, amber_to: 102 }), 'Green up to 98.5%, amber up to 102%');
  assert.equal(targetWords('nope'), '');
  assert.doesNotMatch(targetWords('gp_pct'), /[\u2013\u2014]/, 'no dashes');
});

test('validTargets: ranges, the order rule and the 100 row cap', () => {
  assert.equal(targetMax('days_on_hand'), 365);
  assert.equal(targetMax('gp_pct'), 100);
  const ok = validTargets([
    { location_id: null, metric: 'gp_pct', green_to: 72, amber_to: 66 },
    { location_id: 'a', metric: 'gap_pct', green_to: 1.5, amber_to: 2.5 },
    { location_id: 'a', metric: 'waste_pct', delete: true },
    { location_id: null, metric: 'days_on_hand', green_to: 7, amber_to: 7 },
  ]);
  assert.deepEqual(ok, { ok: true, errors: [] });
  const bad = validTargets([
    { metric: 'gp_pct', green_to: 60, amber_to: 70 },
    { metric: 'gap_pct', green_to: 3, amber_to: 2 },
    { metric: 'waste_pct', green_to: 101, amber_to: 102 },
    { metric: 'days_on_hand', green_to: 400, amber_to: 401 },
    { metric: 'comps_pct', green_to: '', amber_to: 2 },
    { metric: 'made_up', green_to: 1, amber_to: 2 },
    { metric: 'gap_pct', green_to: -1, amber_to: 2 },
  ]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, [
    { index: 0, words: TARGET_ORDER_WORDS },
    { index: 1, words: TARGET_ORDER_WORDS },
    { index: 2, words: 'Each number is 0 to 100.' },
    { index: 3, words: 'Each number is 0 to 365.' },
    { index: 4, words: 'Type both numbers.' },
    { index: 5, words: 'Pick a metric.' },
    { index: 6, words: 'Each number is 0 to 100.' },
  ]);
  assert.equal(TARGET_ORDER_WORDS, 'Green must be the better side of amber.');
  const many = validTargets(Array.from({ length: 101 }, () => ({ metric: 'gp_pct', green_to: 70, amber_to: 65 })));
  assert.equal(many.ok, false);
  assert.deepEqual(many.errors[0], { index: -1, words: 'Save up to 100 targets at once.' });
  assert.deepEqual(validTargets(null), { ok: true, errors: [] });
});
