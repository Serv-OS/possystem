/**
 * stock/targetRules.js: the red, amber, green rule for the head office reports (v5.11.92, multi
 * site stock Drop 4a, contract 1.4 and 2.1). Pure: no React, no Supabase, so node --test drives it
 * (targetRules.test.js).
 *
 * The database decides the colour on every report row (stock_rp__rag reads stock_targets: the site
 * row, else the company row, else the defaults below). This file holds the SAME rule in JavaScript
 * for the Targets panel's preview and words, and TARGET_DEFAULTS is pinned against the SQL by
 * stockNative4aMigration.test.js so the two can never drift.
 *
 * The rule: for gp_pct a higher number is better (green from green_to, amber from amber_to, else
 * red). For every other metric a lower number is better (green up to green_to, amber up to
 * amber_to, else red). A null value has no colour.
 */

/** The seven metrics a target can be set for, in the order the Targets panel shows them. */
export const TARGET_METRICS = Object.freeze([
  Object.freeze({ key: 'gp_pct', label: 'GP %', unit: '%' }),
  Object.freeze({ key: 'gap_pct', label: 'Gap %', unit: '%' }),
  Object.freeze({ key: 'waste_pct', label: 'Waste %', unit: '%' }),
  Object.freeze({ key: 'comps_pct', label: 'Loyalty, staff and comps %', unit: '%' }),
  Object.freeze({ key: 'days_on_hand', label: 'Days on hand', unit: 'days' }),
  Object.freeze({ key: 'budget_pct', label: 'Purchases against budget %', unit: '%' }),
  Object.freeze({ key: 'no_recipe_pct', label: 'Sales with no recipe %', unit: '%' }),
]);

/** The metric keys alone. */
export const TARGET_METRIC_KEYS = Object.freeze(TARGET_METRICS.map((m) => m.key));

/**
 * The built in targets (the mockup's colours: a gap over 2.5 is red, over 1.8 amber; waste over
 * 2.5 amber). One literal block, the same numbers as stock_rp__rag in the 4a migration.
 */
export const TARGET_DEFAULTS = Object.freeze({
  gp_pct: Object.freeze({ green_to: 70, amber_to: 65 }),
  gap_pct: Object.freeze({ green_to: 1.8, amber_to: 2.5 }),
  waste_pct: Object.freeze({ green_to: 2.5, amber_to: 3.5 }),
  comps_pct: Object.freeze({ green_to: 1.5, amber_to: 2.5 }),
  days_on_hand: Object.freeze({ green_to: 7, amber_to: 10 }),
  budget_pct: Object.freeze({ green_to: 100, amber_to: 105 }),
  no_recipe_pct: Object.freeze({ green_to: 3, amber_to: 6 }),
});

/** The metrics where a HIGHER number is the better side. */
export const BETTER_HIGH = Object.freeze(['gp_pct']);

/** Is this a metric the targets know? */
export function isTargetMetric(metric) {
  return typeof metric === 'string' && TARGET_METRIC_KEYS.includes(metric);
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const finite = (v) => v != null && Number.isFinite(v);

/**
 * The target that applies: the one given when it has both numbers, else the default for the
 * metric, else null (an unknown metric).
 */
export function targetFor(metric, target = null) {
  const g = num(target?.green_to), a = num(target?.amber_to);
  if (finite(g) && finite(a)) return { green_to: g, amber_to: a };
  return TARGET_DEFAULTS[metric] ? { ...TARGET_DEFAULTS[metric] } : null;
}

/**
 * 'green' | 'amber' | 'red' | null. The SQL rule word for word (stock_rp__rag):
 *   gp_pct: green when value >= green_to, amber when value >= amber_to, else red;
 *   others: green when value <= green_to, amber when value <= amber_to, else red.
 * A null or unreadable value, or an unknown metric, has no colour.
 */
export function ragOf(metric, value, target = null) {
  const v = num(value);
  if (!finite(v)) return null;
  const t = targetFor(metric, target);
  if (!t) return null;
  if (BETTER_HIGH.includes(metric)) {
    if (v >= t.green_to) return 'green';
    if (v >= t.amber_to) return 'amber';
    return 'red';
  }
  if (v <= t.green_to) return 'green';
  if (v <= t.amber_to) return 'amber';
  return 'red';
}

/** The Pill tone for a rag word: good, warn, bad; null for none. */
export function ragTone(rag) {
  if (rag === 'green') return 'good';
  if (rag === 'amber') return 'warn';
  if (rag === 'red') return 'bad';
  return null;
}

const fmt = (v, unit) => {
  const n = Number(v);
  const text = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return unit === 'days' ? `${text} day${n === 1 ? '' : 's'}` : `${text}%`;
};

/**
 * The words under a target: 'Green from 70%, amber from 65%' for gp_pct; 'Green up to 1.8%,
 * amber up to 2.5%' for the others; 'Green up to 7 days, amber up to 10 days' for days on hand.
 * '' for an unknown metric.
 */
export function targetWords(metric, target = null) {
  const t = targetFor(metric, target);
  const m = TARGET_METRICS.find((x) => x.key === metric);
  if (!t || !m) return '';
  const word = BETTER_HIGH.includes(metric) ? 'from' : 'up to';
  return `Green ${word} ${fmt(t.green_to, m.unit)}, amber ${word} ${fmt(t.amber_to, m.unit)}`;
}

export const TARGET_ORDER_WORDS = 'Green must be the better side of amber.';

/** The largest value a metric may take: percents 0 to 100, days on hand 0 to 365. */
export function targetMax(metric) {
  return metric === 'days_on_hand' ? 365 : 100;
}

/**
 * Check rows for stock_save_targets before they are sent: [{ location_id, metric, green_to,
 * amber_to, delete }]. Answers { ok, errors: [{ index, words }] }. A row being deleted needs only
 * its metric. The database checks the same things again (1.5).
 */
export function validTargets(rows) {
  const errors = [];
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > 100) errors.push({ index: -1, words: 'Save up to 100 targets at once.' });
  list.forEach((r, index) => {
    if (!isTargetMetric(r?.metric)) { errors.push({ index, words: 'Pick a metric.' }); return; }
    if (r.delete === true) return;
    const g = num(r.green_to), a = num(r.amber_to);
    const max = targetMax(r.metric);
    if (!finite(g) || !finite(a)) { errors.push({ index, words: 'Type both numbers.' }); return; }
    if (g < 0 || a < 0 || g > max || a > max) { errors.push({ index, words: `Each number is 0 to ${max}.` }); return; }
    const ordered = BETTER_HIGH.includes(r.metric) ? g >= a : g <= a;
    if (!ordered) errors.push({ index, words: TARGET_ORDER_WORDS });
  });
  return { ok: errors.length === 0, errors };
}
