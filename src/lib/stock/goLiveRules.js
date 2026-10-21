// src/lib/stock/goLiveRules.js
//
// MULTI SITE STOCK, Drop 1 (migration 20261024a): the pure rules behind Inventory > Overview in a
// multi site company. No data, no React: the screens hand in what the database answered.
//
//   The go live plan of one site (map 4.21, design 2.4 and A19): five steps in order. 'Copy a site'
//   and 'Opening count' tick themselves from stock_golive_plan's facts; company editors set the
//   days and tick the other three (stock_save_golive_step).
//   The All sites cards (map 4.21, contract 3.5 and 4.4): Needs attention, Set up health, Go live.
//   The company cost rule card: the company rule and the owner only site override.
//
// A one site company never reaches any of this: overviewMode answers 'one_site' and Overview is
// today's screen. Unit tested in goLiveRules.test.js.

import { normCostRule } from './phase0Rules.js';

// -- the go live plan ----------------------------------------------------------------------------

/** The five steps, in order, with the words the card shows. auto: ticks itself from the facts. */
export const GOLIVE_STEPS = Object.freeze([
  Object.freeze({ step: 'copy_site', label: 'Copy a site', auto: true }),
  Object.freeze({ step: 'opening_count', label: 'Opening count', auto: true }),
  Object.freeze({ step: 'train_the_trainer', label: 'Train the trainer', auto: false }),
  Object.freeze({ step: 'side_by_side', label: 'Two weeks side by side', auto: false }),
  Object.freeze({ step: 'switch_off', label: 'Switch the old system off', auto: false }),
]);
export const GOLIVE_STEP_KEYS = Object.freeze(GOLIVE_STEPS.map((s) => s.step));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** A real calendar day as 'YYYY-MM-DD', or null. Timestamps give their first ten letters. */
export function isoDay(v) {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  const m = ISO_DAY.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : null;
}

/** '2026-11-03' as '3 Nov' (en-GB, no year), '' for no day. */
export function dayWords(iso) {
  const d = isoDay(iso);
  if (!d) return '';
  const [, , m, day] = ISO_DAY.exec(d);
  return `${Number(day)} ${MONTHS[Number(m) - 1]}`;
}

/** A day plus n days, as 'YYYY-MM-DD' (null for no day). */
export function addDays(iso, n) {
  const d = isoDay(iso);
  if (!d) return null;
  const [, y, m, day] = ISO_DAY.exec(d);
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(day) + Math.trunc(num(n)))).toISOString().slice(0, 10);
}

/**
 * Today as 'YYYY-MM-DD' on a venue's clock (its time zone), or the browser's when the zone is not
 * known or not real. The plan's days are venue days.
 */
export function todayIn(timeZone = null, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  try { return fmt(timeZone); } catch { return fmt(null); }
}

/** Has this step ticked itself? 'Copy a site': an item is on here. 'Opening count': a count is approved. */
export function autoDone(step, facts) {
  const f = facts || {};
  if (step === 'copy_site') return num(f.items_on) > 0;
  if (step === 'opening_count') return num(f.approved_counts) > 0;
  return false;
}

/**
 * One step's state on a day: 'done' (ticked, or ticked itself), 'late' (its day has gone), 'due'
 * (its day is within the coming week, or no day is set yet) or 'later'.
 * step: a stock_golive_plan step row { step, due_day, done_at }, or just the step key.
 */
export function stepState(step, facts, todayIso) {
  const row = step && typeof step === 'object' ? step : { step };
  if (row.done_at || autoDone(row.step, facts)) return 'done';
  const due = isoDay(row.due_day);
  const today = isoDay(todayIso);
  if (!due || !today) return 'due';
  if (due < today) return 'late';
  if (due <= addDays(today, 6)) return 'due';
  return 'later';
}

/** The plain words beside one step. */
export function stepWords(line) {
  if (!line) return '';
  if (line.state === 'done') {
    if (line.doneAt) {
      const when = dayWords(line.doneAt);
      return `Done${when ? ` ${when}` : ''}${line.doneByName ? ` by ${line.doneByName}` : ''}`;
    }
    return 'Done';
  }
  if (!line.dueDay) return 'No day set';
  return `Due ${dayWords(line.dueDay)}`;
}

/**
 * The card's lines, one per step in order, from stock_golive_plan's answer { steps, facts }.
 * A step with no row yet is open with no day. rowVersion is what stock_save_golive_step checks
 * (null: no row yet, so no version is sent).
 */
export function planLines(plan, todayIso = todayIn()) {
  const rows = new Map();
  for (const r of (plan && Array.isArray(plan.steps) ? plan.steps : [])) if (r && GOLIVE_STEP_KEYS.includes(r.step)) rows.set(r.step, r);
  const facts = (plan && plan.facts) || {};
  return GOLIVE_STEPS.map((def) => {
    const row = rows.get(def.step) || null;
    const state = stepState({ ...(row || {}), step: def.step }, facts, todayIso);
    const line = {
      step: def.step, label: def.label, auto: def.auto, state,
      // ticked by the facts, not by a person (the card then shows no tick box to undo it)
      tickedItself: state === 'done' && !row?.done_at,
      dueDay: isoDay(row?.due_day), doneAt: row?.done_at || null, doneByName: row?.done_by_name || null,
      note: row?.note || '', rowVersion: row && row.row_version != null ? Number(row.row_version) : null, exists: !!row,
    };
    return { ...line, words: stepWords(line), late: state === 'late' };
  });
}

/** How many steps are not done yet. */
export function stepsLeft(plan, todayIso = todayIn()) {
  return planLines(plan, todayIso).filter((l) => l.state !== 'done').length;
}

/** Does the site's Overview show the plan? When it has steps, or nothing is on there yet. */
export function planShows(plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (Array.isArray(plan.steps) && plan.steps.length > 0) return true;
  return !!plan.facts && plan.facts.items_on != null && num(plan.facts.items_on) === 0;
}

/**
 * The p_step a save sends (stock_save_golive_step): { step, due_day, done, note }, only the keys
 * being changed. A day of '' clears it (null).
 */
export function goLiveStepPatch(step, change = {}) {
  const out = { step };
  if ('dueDay' in change) out.due_day = isoDay(change.dueDay);
  if ('done' in change) out.done = !!change.done;
  if ('note' in change) out.note = change.note == null ? null : String(change.note).trim().slice(0, 500) || null;
  return out;
}

// -- the Overview: which view ------------------------------------------------------------------

/**
 * Which Overview to draw, from useStockScope():
 *   'loading'  the scope has not answered (today's Loading line)
 *   'one_site' a one site company (also a scope that failed): today's screen exactly
 *   'all'      a multi site company on All sites or a group
 *   'site'     a multi site company with one site picked
 */
export function overviewMode(sc) {
  if (!sc || !sc.ready) return 'loading';
  if (!sc.multi) return 'one_site';
  return sc.oneSite && sc.oneSite.id ? 'site' : 'all';
}

/**
 * Does the one site view need that site's own menu (not the signed in venue's store copy)?
 * Only in a multi site company, for a site that is not the venue signed in to.
 */
export function siteMenuNeeded({ multi, siteId, signedInId } = {}) {
  return !!(multi && siteId && siteId !== signedInId);
}

// -- All sites: Needs attention, Set up health, Go live ------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const ATTENTION_PARTS = Object.freeze([
  ['below_zero', (n) => `${n} below zero`],
  ['no_price', (n) => `${n} with no price`],
  ['counts_ready', (n) => `${plural(n, 'count', 'counts')} ready to approve`],
  ['orders_overdue', (n) => `${plural(n, 'order', 'orders')} overdue`],
  ['below_reorder', (n) => `${n} below reorder`],
  ['queue_failed', (n) => `${plural(n, 'save', 'saves')} did not finish`],
]);

/** One site's Needs attention line: '3 below zero, 1 count ready to approve', '' for nothing. */
export function attentionWords(row) {
  if (!row) return '';
  return ATTENTION_PARTS.filter(([k]) => num(row[k]) > 0).map(([k, w]) => w(num(row[k]))).join(', ');
}

/** The sites with something to see, in the order the database gave (by name). */
export function attentionRows(rows) {
  return (rows || []).filter(Boolean).map((r) => ({
    locationId: r.location_id, name: r.name || '', words: attentionWords(r),
    total: ATTENTION_PARTS.reduce((s, [k]) => s + Math.max(0, num(r[k])), 0), countsReady: Math.max(0, num(r.counts_ready)),
  })).filter((r) => r.words);
}

/**
 * Set up health: the sites the nightly check found out of step with the company list.
 * Answer { checked: bool (any site checked yet), out: [{ locationId, name, count, words, lines, checkedAt }] }.
 */
export function healthRows(rows) {
  const list = (rows || []).filter(Boolean);
  const out = [];
  for (const r of list) {
    const h = r.health;
    if (!h) continue;
    const count = Math.max(0, num(h.planned_writes)) + Math.max(0, num(h.recipe_planned_writes));
    if (count <= 0) continue;
    out.push({
      locationId: r.location_id, name: r.name || '', count,
      words: `${r.name || 'A site'}: ${plural(count, 'thing', 'things')} out of step.`,
      lines: (Array.isArray(h.lines) ? h.lines : []).filter((l) => typeof l === 'string' && l).slice(0, 3),
      checkedAt: h.checked_at || null,
    });
  }
  return { checked: list.some((r) => r.health && r.health.checked_at), out };
}

/** Go live (All sites): the sites with steps still open, '<site>: 2 steps left'. */
export function goLiveRows(rows) {
  return (rows || []).filter((r) => r && num(r.golive_open) > 0).map((r) => ({
    locationId: r.location_id, name: r.name || '', left: num(r.golive_open),
    words: `${r.name || 'A site'}: ${plural(num(r.golive_open), 'step', 'steps')} left`,
  }));
}

/** stock_needs_attention takes at most 50 sites a call: the ids in calls of 50 (or fewer). */
export function siteChunks(ids, size = 50) {
  const list = [...new Set((ids || []).filter(Boolean))];
  const n = Math.max(1, Math.min(50, Math.trunc(num(size)) || 50));
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// -- the cost rule card ----------------------------------------------------------------------------

/**
 * stockApi.settings(orgId) answer to { companyRule, overrides: { [locationId]: rule }, rowVersion }.
 * The answer is { settings: <stock_co_settings row or null>, sites: [<stock_co_site_settings rows>] };
 * a company with no row yet uses the price list (the database's default).
 */
export function settingsOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  const row = d.settings || d.company || null;
  const sites = Array.isArray(d.sites) ? d.sites : Array.isArray(d.site_settings) ? d.site_settings : [];
  const overrides = {};
  for (const s of sites) {
    if (s && s.location_id && (s.cost_rule_override === 'price_list' || s.cost_rule_override === 'deliveries')) overrides[s.location_id] = s.cost_rule_override;
  }
  return { companyRule: normCostRule(row?.cost_rule), overrides, rowVersion: row && row.row_version != null ? Number(row.row_version) : null };
}

/** The rule that applies at one site: { rule, own } (own: the site's override, not the company's). */
export function ruleAt(settings, siteId) {
  const s = settings || { companyRule: normCostRule(null), overrides: {} };
  const own = siteId && s.overrides ? s.overrides[siteId] : undefined;
  return own ? { rule: own, own: true } : { rule: s.companyRule, own: false };
}
