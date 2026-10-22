/**
 * stock/countPlanRules.js: the words and small rules of count plans, templates, the due strip,
 * second approval and locked periods (v5.11.96, multi site stock Drop 3, contract 3.3 and 4.3).
 * Pure: no database, no React. One site companies never reach any of it.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The count types a plan may start (stock_count_plans.count_type). */
export const PLAN_COUNT_TYPES = Object.freeze([
  { id: 'FULL', label: 'Full count' }, { id: 'PARTIAL', label: 'Partial count' }, { id: 'SPOT', label: 'Spot check' },
  { id: 'AREA', label: 'By area' }, { id: 'SUPPLIER', label: 'By supplier' },
]);

/** How often (the plan form's words, contract 4.3). */
export const PLAN_EVERY = Object.freeze([
  { id: 'day', label: 'Every day' }, { id: 'week', label: 'Every week on' }, { id: 'month', label: 'Every month on day' },
]);

/** If an item is not counted (stock_count_plans.if_not_counted). */
export const IF_NOT_COUNTED = Object.freeze([{ id: 'estimate', label: 'Use the estimate' }, { id: 'zero', label: 'Use zero' }]);

/** '2026-10-21' -> '21 Oct' ('' when it is not a day). */
export function dayMonWords(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ''));
  if (!m) return '';
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return '';
  return `${Number(m[3])} ${MONTHS[mo - 1]}`;
}

/** '10:00:00' or '10:00' -> '10:00'; anything else ''. */
export function hmOf(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time ?? '').trim());
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * One stock_count_due row in words, with its pill tone:
 *   due   'Count due today: Full count by 10:00'  (warn)
 *   late  'Count late: Full count was due by 10:00' (warn)
 *   missed 'Count missed: Full count on 21 Oct'    (bad)
 *   done  'Done: Full count'                       (good)
 */
export function dueWords(row) {
  const plan = String(row?.plan_name || 'Count').trim() || 'Count';
  const by = hmOf(row?.due_by);
  switch (row?.status) {
    case 'due': return { text: `Count due today: ${plan}${by ? ` by ${by}` : ''}`, tone: 'warn', pill: 'Due today' };
    case 'late': return { text: `Count late: ${plan}${by ? ` was due by ${by}` : ''}`, tone: 'warn', pill: 'Late' };
    case 'missed': return { text: `Count missed: ${plan}${row?.due_day ? ` on ${dayMonWords(row.due_day)}` : ''}`, tone: 'bad', pill: 'Missed' };
    case 'done': return { text: `Done: ${plan}`, tone: 'good', pill: 'Done' };
    default: return { text: plan, tone: 'neutral', pill: '' };
  }
}

/**
 * The rows the due strip shows for one site: due, late and missed only (done rows say nothing),
 * missed first, then late, then due, each by its due time. At most `max` rows.
 */
export function dueStripRows(rows, siteId, max = 4) {
  const order = { missed: 0, late: 1, due: 2 };
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && (!siteId || String(r.location_id) === String(siteId)) && Object.prototype.hasOwnProperty.call(order, r.status))
    .sort((a, b) => (order[a.status] - order[b.status]) || String(a.due_by || '').localeCompare(String(b.due_by || '')) || String(a.plan_name || '').localeCompare(String(b.plan_name || '')))
    .slice(0, Math.max(0, max))
    .map((r) => ({ ...r, ...dueWords(r) }));
}

/** 'Every day by 10:00', 'Every week on Mon, Thu by 09:30', 'Every month on day 1 by 10:00'. */
export function everyWords(plan) {
  const by = hmOf(plan?.due_by) || '10:00';
  if (plan?.every === 'week') {
    const days = [...new Set((plan?.dows || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    return `Every week on ${days.length ? days.map((d) => DAYS[d]).join(', ') : 'no day yet'} by ${by}`;
  }
  if (plan?.every === 'month') return `Every month on day ${plan?.day_of_month || 1} by ${by}`;
  return `Every day by ${by}`;
}

/**
 * The one line under a plan's name: 'Full count · Every week on Mon by 10:00 · 3 sites · Use the
 * estimate'. siteName(id) names a site; groups(id) names a group.
 */
export function planSummary(plan, { siteName = () => '', groupName = () => '' } = {}) {
  const type = PLAN_COUNT_TYPES.find((t) => t.id === plan?.count_type)?.label || 'Count';
  const sites = Array.isArray(plan?.sites) ? plan.sites.filter(Boolean) : null;
  const groups = Array.isArray(plan?.group_ids) ? plan.group_ids.filter(Boolean) : [];
  let where;
  if ((!sites || !sites.length) && !groups.length) where = 'Every open site';
  else {
    const parts = [];
    if (groups.length) parts.push(groups.map((g) => groupName(g) || 'a group').join(', '));
    if (sites && sites.length) parts.push(sites.length === 1 ? (siteName(sites[0]) || '1 site') : `${sites.length} sites`);
    where = parts.join(' and ');
  }
  const ifNot = IF_NOT_COUNTED.find((x) => x.id === plan?.if_not_counted)?.label || 'Use the estimate';
  return [type, everyWords(plan), where, ifNot].join(' · ');
}

/** A new plan's form. */
export function blankPlan() {
  return { id: null, name: '', count_type: 'FULL', template_id: null, every: 'week', dows: [1], day_of_month: 1, due_by: '10:00', sites: null, group_ids: [], if_not_counted: 'estimate', active: true };
}

/** The plan form's refusal in words, or null when it can be saved. */
export function planProblem(plan) {
  if (!String(plan?.name ?? '').trim()) return 'Give the plan a name.';
  if (!PLAN_COUNT_TYPES.some((t) => t.id === plan?.count_type)) return 'Pick what is counted.';
  if (!PLAN_EVERY.some((e) => e.id === plan?.every)) return 'Pick how often.';
  if (plan.every === 'week' && !(plan.dows || []).some((d) => Number(d) >= 0 && Number(d) <= 6)) return 'Pick at least one day.';
  if (plan.every === 'month') {
    const d = Number(plan.day_of_month);
    if (!Number.isInteger(d) || d < 1 || d > 28) return 'Pick a day from 1 to 28.';
  }
  if (!hmOf(plan.due_by)) return 'Type the time it is due by, like 10:00.';
  return null;
}

/** The plan as stock_save_count_plan takes it (p_plan). */
export function planToSave(plan) {
  const sites = Array.isArray(plan?.sites) && plan.sites.length ? [...new Set(plan.sites.map(String))] : null;
  const groups = Array.isArray(plan?.group_ids) && plan.group_ids.length ? [...new Set(plan.group_ids.map(String))] : null;
  return {
    ...(plan?.id ? { id: plan.id } : {}),
    name: String(plan?.name ?? '').trim(),
    count_type: plan?.count_type || 'FULL',
    template_id: plan?.template_id || null,
    every: plan?.every || 'day',
    dows: plan?.every === 'week' ? [...new Set((plan.dows || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b) : null,
    day_of_month: plan?.every === 'month' ? Number(plan.day_of_month) : null,
    due_by: hmOf(plan?.due_by) || '10:00',
    sites,
    group_ids: groups,
    if_not_counted: plan?.if_not_counted === 'zero' ? 'zero' : 'estimate',
    active: plan?.active !== false,
    ...(plan?.archived ? { archived: true } : {}),
  };
}

/** Move one entry of a list from one place to another (the shelf order editor); a new list. */
export function moveItem(list, from, to) {
  if (!Array.isArray(list)) return [];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/**
 * A template count's lines in the site's shelf order: lines (from resolveCountScope, each with
 * itemId and sortOrder) ordered by where their item sits in `itemIds` (the shelf order), lines of
 * the same item keeping their order, items not in the list last in their old order; sortOrder is
 * renumbered from 0. A new array; the lines are copied.
 */
export function shelfSortLines(lines, itemIds) {
  const at = new Map();
  (itemIds || []).forEach((id, i) => { if (!at.has(String(id))) at.set(String(id), i); });
  const big = Number.MAX_SAFE_INTEGER;
  return (Array.isArray(lines) ? lines : [])
    .map((l, i) => ({ l, i, k: at.has(String(l?.itemId)) ? at.get(String(l.itemId)) : big }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map(({ l }, i) => ({ ...l, sortOrder: i }));
}

/**
 * The items of a template at one site (stock_template_for_site's answer) as the count starts
 * them: { itemIds (site item ids in shelf order, counted here only), missing: n }.
 */
export function templateItemsForCount(answer) {
  const rows = Array.isArray(answer?.items) ? answer.items : Array.isArray(answer) ? answer : [];
  const ids = [];
  const seen = new Set();
  for (const r of rows) {
    const id = r?.inventory_item_id || r?.site_item_id;
    if (!id || seen.has(String(id)) || r?.counted_here === false) continue;
    seen.add(String(id));
    ids.push(String(id));
  }
  return { itemIds: ids, missing: Array.isArray(answer?.missing) ? answer.missing.length : 0 };
}

/**
 * Second approval: does this count wait for one, and may this login give it?
 *   count: { status, secondApprovalNeededAt, firstApprovedBy, secondApprovedAt }
 *   who:   { userId, companyEditor (level 'all' in inventory), linkedHere (a login of that site) }
 * { waiting, canGive, why } where why is the reason in words when canGive is false.
 */
export function secondApprovalState(count, { userId = null, companyEditor = false, linkedHere = false } = {}) {
  const waiting = !!count && count.status !== 'APPROVED' && !!count.secondApprovalNeededAt && !count.secondApprovedAt;
  if (!waiting) return { waiting: false, canGive: false, why: null };
  if (userId && count.firstApprovedBy && String(count.firstApprovedBy) === String(userId)) {
    return { waiting, canGive: false, why: 'You gave the first approval. Someone else gives the second.' };
  }
  if (companyEditor || linkedHere) return { waiting, canGive: true, why: null };
  return { waiting, canGive: false, why: 'Head office or another manager of this site gives the second approval.' };
}

/** The words on a waiting count: 'Waiting for a second approval. Over £500.' */
export function secondApprovalWords(limit, symbol = '£') {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 'Waiting for a second approval.';
  const whole = Math.round(n) === n;
  return `Waiting for a second approval. Over ${symbol}${whole ? n.toLocaleString('en-GB') : n.toFixed(2)}.`;
}

/**
 * The lock form's refusal in words (or null): both days, to not before from, and to before the
 * venue's today (a period that has not ended cannot be locked).
 */
export function lockProblem(from, to, todayYmd) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(from ?? '')) || !re.test(String(to ?? ''))) return 'Pick the first and last day.';
  if (to < from) return 'The last day is before the first day.';
  if (todayYmd && re.test(todayYmd) && to >= todayYmd) return 'Lock a period that has ended: the last day must be before today.';
  return null;
}

/** 'Locked by Sam on 2 Nov' or 'Unlocked by Sam on 3 Nov' from a stock_periods row (names as stored). */
export function periodWords(p) {
  if (!p) return '';
  const day = (iso) => (iso ? dayMonWords(String(iso).slice(0, 10)) : '');
  if (p.unlocked_at) return `Unlocked${p.unlocked_by_name ? ` by ${p.unlocked_by_name}` : ''} on ${day(p.unlocked_at)}`;
  if (p.locked_at) return `Locked${p.locked_by_name ? ` by ${p.locked_by_name}` : ''} on ${day(p.locked_at)}`;
  return '';
}

/** The snapshot figures a locked period shows, in order, with their labels (missing ones left out). */
export function snapshotRows(metrics) {
  const m = metrics || {};
  const rows = [
    ['stock_value', 'Closing stock value'], ['purchases', 'Purchases'], ['waste', 'Waste'], ['cogs', 'Cost of sales'],
    ['transfers_in', 'Transfers in'], ['transfers_out', 'Transfers out'], ['count_variance', 'Count variance'],
    ['sales_net', 'Sales (net)'], ['gp_pct', 'GP %'],
  ];
  return rows.filter(([k]) => m[k] != null && Number.isFinite(Number(m[k]))).map(([k, label]) => ({ key: k, label, value: Number(m[k]), pct: k === 'gp_pct' }));
}

// ── the Drop 3 company settings (Stock settings card, contract 3.3 and 4.5) ─────────────────────

const moneyText = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : String(Number(v)));

/**
 * The form the settings card edits, from the stock_co_settings row: { sendUnapproved, wastePin,
 * countSecond, tolKind ('amount' | 'pct'), tol } (amounts as text, '' for none).
 */
export function companyLimitsForm(row) {
  const r = row || {};
  const pct = r.invoice_tolerance_pct;
  const amt = r.invoice_tolerance_amount;
  const tolKind = (pct != null && pct !== '') && (amt == null || amt === '') ? 'pct' : 'amount';
  return {
    sendUnapproved: r.send_unapproved_at_cutoff !== false,
    wastePin: moneyText(r.waste_pin_over_value),
    countSecond: moneyText(r.count_second_approval_over),
    tolKind,
    tol: tolKind === 'pct' ? moneyText(pct) : moneyText(amt),
  };
}

/**
 * The stock_save_settings patch from the form, or { error } in words. Empty boxes mean no limit
 * (null). Amounts are 0 or more; the tolerance % is at most 100. Exactly one tolerance kind is kept.
 */
export function companyLimitsPatch(form) {
  const f = form || {};
  const num = (t, what) => {
    const s = String(t ?? '').trim();
    if (!s) return { v: null };
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return { error: `${what} must be a number of 0 or more, or empty for none.` };
    return { v: Math.round(n * 100) / 100 };
  };
  const pin = num(f.wastePin, 'The waste PIN limit');
  if (pin.error) return { error: pin.error };
  const sec = num(f.countSecond, 'The count limit');
  if (sec.error) return { error: sec.error };
  const tol = num(f.tol, 'The invoice tolerance');
  if (tol.error) return { error: tol.error };
  if (f.tolKind === 'pct' && tol.v != null && tol.v > 100) return { error: 'The invoice tolerance % is at most 100.' };
  return {
    patch: {
      send_unapproved_at_cutoff: f.sendUnapproved !== false,
      waste_pin_over_value: pin.v,
      count_second_approval_over: sec.v,
      invoice_tolerance_pct: f.tolKind === 'pct' ? tol.v : null,
      invoice_tolerance_amount: f.tolKind === 'pct' ? null : tol.v,
    },
  };
}
