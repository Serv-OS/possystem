// src/lib/hq/targets.js
//
// Head office targets: the red, amber, green rule for every figure the scorecard colours.
// The same shape as the stock targets (src/lib/stock/targetRules.js): a company row per metric
// (location_id null), a site row that overrides it, and a built in default when neither exists.
// Pure: no React, no Supabase, so node --test drives it (targets.test.js).
//
// The rule per metric: when a higher number is better, green from green_to up, amber from
// amber_to up, red below. When a lower number is better, green up to green_to, amber up to
// amber_to, red above. A null value has no colour. Money metrics have no default, because a
// sensible cash ceiling is a per company decision in that company's currency.

export const HQ_METRICS = Object.freeze([
  Object.freeze({ key: 'prime_cost_pct', label: 'Prime cost %', unit: '%', higherIsBetter: false, department: 'finance',
    hint: 'COGS plus labour against net sales. The one number the ladder ranks by.' }),
  Object.freeze({ key: 'labour_pct', label: 'Labour %', unit: '%', higherIsBetter: false, department: 'hr',
    hint: 'Labour cost against net sales. Workforce settings hold a labour target too; this one colours the scorecard.' }),
  Object.freeze({ key: 'cogs_pct', label: 'COGS %', unit: '%', higherIsBetter: false, department: 'finance',
    hint: 'Cost of goods against net sales, from stock where it runs.' }),
  Object.freeze({ key: 'checks_pct', label: 'Checks completed %', unit: '%', higherIsBetter: true, department: 'operations',
    hint: 'Checklists and temperature checks done on time, out of those due.' }),
  Object.freeze({ key: 'morale_score', label: 'Morale score', unit: '/10', higherIsBetter: true, department: 'hr',
    hint: 'The typed morale score on Daily numbers.' }),
  Object.freeze({ key: 'review_rating', label: 'Review rating', unit: '/5', higherIsBetter: true, department: 'marketing',
    hint: 'Average rating in the period.' }),
  Object.freeze({ key: 'cash_held', label: 'Cash held in the safe', unit: 'money', higherIsBetter: false, department: 'finance',
    hint: 'The safe balance a site may hold before it should bank. No default: set it in your currency.' }),
  Object.freeze({ key: 'unbanked_days', label: 'Days since last banking', unit: 'days', higherIsBetter: false, department: 'finance',
    hint: 'Days since a deposit was prepared at the site.' }),
  Object.freeze({ key: 'safe_variance', label: 'Safe count variance', unit: 'money', higherIsBetter: false, department: 'finance',
    hint: 'The size of the last count variance, either way. No default: set it in your currency.' }),
  Object.freeze({ key: 'net_sales_day', label: 'Net sales a day', unit: 'money', higherIsBetter: true, department: 'store_leadership',
    hint: 'A daily sales floor per site. No default: set it per site.' }),
]);

export const HQ_METRIC_KEYS = Object.freeze(HQ_METRICS.map((m) => m.key));
const BY_KEY = Object.fromEntries(HQ_METRICS.map((m) => [m.key, m]));
export const metricDef = (key) => BY_KEY[key] || null;

/** Built in bands. A metric missing here has no colour until a target is set. */
export const HQ_TARGET_DEFAULTS = Object.freeze({
  prime_cost_pct: Object.freeze({ green_to: 60, amber_to: 65 }),
  labour_pct: Object.freeze({ green_to: 30, amber_to: 33 }),
  cogs_pct: Object.freeze({ green_to: 30, amber_to: 34 }),
  checks_pct: Object.freeze({ green_to: 95, amber_to: 85 }),
  morale_score: Object.freeze({ green_to: 8, amber_to: 6.5 }),
  review_rating: Object.freeze({ green_to: 4.5, amber_to: 4 }),
  unbanked_days: Object.freeze({ green_to: 2, amber_to: 4 }),
});

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** Are these two numbers a legal band for the metric? Returns null when fine, else the words to show. */
export function bandProblem(metricKey, greenTo, amberTo) {
  const m = metricDef(metricKey);
  if (!m) return 'Unknown metric.';
  const g = num(greenTo); const a = num(amberTo);
  if (g === null || a === null) return 'Both numbers are needed.';
  if (m.unit === '%' && (g < 0 || g > 100 || a < 0 || a > 100)) return 'A percentage runs 0 to 100.';
  if (m.key === 'morale_score' && (g > 10 || a > 10)) return 'Morale runs 0 to 10.';
  if (m.key === 'review_rating' && (g > 5 || a > 5)) return 'A rating runs 0 to 5.';
  if (g < 0 || a < 0) return 'No negative targets.';
  if (m.higherIsBetter && g < a) return 'Green must be at or above amber when higher is better.';
  if (!m.higherIsBetter && g > a) return 'Green must be at or below amber when lower is better.';
  return null;
}

/**
 * resolveTargets(rows, locationId) where rows are hq_targets rows for the company.
 * Returns { metric: { green_to, amber_to, source: 'site' | 'company' | 'default' } } for every metric
 * that has a band (site row, else company row, else default). Metrics with none are left out.
 */
export function resolveTargets(rows = [], locationId = null) {
  const out = {};
  for (const key of HQ_METRIC_KEYS) {
    const site = locationId ? (rows || []).find((r) => r?.metric === key && r.location_id === locationId) : null;
    const company = (rows || []).find((r) => r?.metric === key && !r.location_id);
    const pick = site || company;
    if (pick) out[key] = { green_to: num(pick.green_to), amber_to: num(pick.amber_to), source: site ? 'site' : 'company' };
    else if (HQ_TARGET_DEFAULTS[key]) out[key] = { ...HQ_TARGET_DEFAULTS[key], source: 'default' };
  }
  return out;
}

/** 'grn' | 'orn' | 'red' | null for a value against a band ({ green_to, amber_to }) of a metric. */
export function ragOf(metricKey, value, band) {
  const m = metricDef(metricKey);
  const v = num(value);
  if (!m || v === null || !band) return null;
  const g = num(band.green_to); const a = num(band.amber_to);
  if (g === null || a === null) return null;
  if (m.higherIsBetter) return v >= g ? 'grn' : (v >= a ? 'orn' : 'red');
  return v <= g ? 'grn' : (v <= a ? 'orn' : 'red');
}

/** Short words for a band: "under 60%" / "60 to 65%" / "over 65%" in the metric's direction. */
export function bandWords(metricKey, band, fmt = (n) => String(n)) {
  const m = metricDef(metricKey);
  if (!m || !band) return null;
  const g = fmt(band.green_to); const a = fmt(band.amber_to);
  return m.higherIsBetter
    ? { grn: `${g} and up`, orn: `${a} to ${g}`, red: `under ${a}` }
    : { grn: `up to ${g}`, orn: `${g} to ${a}`, red: `over ${a}` };
}

/** The metrics that belong to one department's tiles. */
export const metricsForDepartment = (department) => HQ_METRICS.filter((m) => m.department === department);
