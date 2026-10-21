/**
 * stock/orderRules.js: the supplier Order rules tab, as plain rules (multi site stock Drop 1).
 *
 * One rule = one delivery day of one supplier at one site, with the latest time the site can order
 * for it ("order by Sun 14:00"). Days are Postgres day numbers (extract(dow)): 0 Sunday, 1 Monday
 * ... 6 Saturday, the same as stock_order_rules.delivery_dow and stock_co_settings.week_start.
 *
 * deriveDays is the SQL rule of the Drop 1 contract 1.6, line for line (stock_co__derive_days): the
 * Order pad and every reader today still read suppliers.delivery_days and cutoff_time, which the
 * save writes from the rules in the same transaction. Pure: no imports, node --test drives it.
 */

/** 0 'sun' ... 6 'sat': the codes suppliers.delivery_days holds. */
export const DAY_CODES = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const SHORT = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const LONG = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
/** The grid columns, Monday first (mockup scrSupplier). */
export const WEEK_COLUMNS = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
/** The order delivery_days are written in: mon, tue, wed, thu, fri, sat, sun. */
const CODE_ORDER = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const isDow = (d) => Number.isInteger(d) && d >= 0 && d <= 6;
const toDow = (d) => (d === null || d === undefined || d === '' ? null : Number(d));

/** 'Mon' for 1; '' for anything that is not a day. */
export function dayLabel(dow) {
  const d = toDow(dow);
  return isDow(d) ? SHORT[d] : '';
}

/** 'Monday' for 1; '' for anything that is not a day. */
export function dayName(dow) {
  const d = toDow(dow);
  return isDow(d) ? LONG[d] : '';
}

/**
 * A time as 'HH:MM', from 'HH:MM', 'H:MM' or the 'HH:MM:SS' a Postgres time column reads back as.
 * null when it is not a time of day (00:00 to 23:59).
 */
export function timeText(t) {
  if (t === null || t === undefined) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** 'order by Sun 14:00', or '' when the rule has no order by. */
export function orderByWords(rule) {
  const day = dayLabel(rule?.order_by_dow);
  const time = timeText(rule?.order_by_time);
  return day && time ? `order by ${day} ${time}` : '';
}

/**
 * The derived columns of one site's rules (contract 1.6): delivery_days = the day codes in the
 * order mon..sun; cutoff_time = the order by time most rules use (ties: the earliest), 'HH:MM', or
 * null when no rule has one.
 */
export function deriveDays(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const codes = new Set();
  const uses = new Map();
  for (const r of list) {
    const d = toDow(r?.delivery_dow);
    if (!isDow(d)) continue;
    codes.add(DAY_CODES[d]);
    const t = timeText(r?.order_by_time);
    if (t) uses.set(t, (uses.get(t) || 0) + 1);
  }
  let cutoff = null;
  let most = 0;
  for (const [t, n] of [...uses.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (n > most) { most = n; cutoff = t; }
  }
  return { delivery_days: CODE_ORDER.filter((c) => codes.has(c)), cutoff_time: cutoff };
}

/**
 * The order by a new delivery day starts with: the day before, at the site's cut off (the Drop 1
 * seed rule), or none when there is no cut off.
 */
export function defaultOrderBy(deliveryDow, cutoff) {
  const d = toDow(deliveryDow);
  const t = timeText(cutoff);
  if (!isDow(d) || !t) return { order_by_dow: null, order_by_time: null };
  return { order_by_dow: (d + 6) % 7, order_by_time: t };
}

/**
 * Check one site's rules before they are sent: `{ ok: true, rules }` in the shape
 * stock_save_order_rules takes (one per day, Monday first, at most 7), or `{ ok: false, error }`
 * with the words to show.
 */
export function validRules(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: 'Something went wrong with these rules. Reload and try again.' };
  const seen = new Set();
  const out = [];
  for (const r of rules) {
    const d = toDow(r?.delivery_dow);
    if (!isDow(d)) return { ok: false, error: 'A delivery day must be Monday to Sunday.' };
    if (seen.has(d)) return { ok: false, error: 'Each day can have one delivery only.' };
    seen.add(d);
    const hasDay = !(r?.order_by_dow === null || r?.order_by_dow === undefined || r?.order_by_dow === '');
    const hasTime = !(r?.order_by_time === null || r?.order_by_time === undefined || r?.order_by_time === '');
    if (hasDay !== hasTime) return { ok: false, error: `Pick an order by day and a time for ${dayName(d)}, or tick No order by time.` };
    if (!hasDay) { out.push({ delivery_dow: d, order_by_dow: null, order_by_time: null }); continue; }
    const od = toDow(r.order_by_dow);
    if (!isDow(od)) return { ok: false, error: `Pick an order by day for ${dayName(d)}.` };
    const t = timeText(r.order_by_time);
    if (!t) return { ok: false, error: 'The order by time must be a time such as 14:00.' };
    out.push({ delivery_dow: d, order_by_dow: od, order_by_time: t });
  }
  out.sort((a, b) => WEEK_COLUMNS.indexOf(a.delivery_dow) - WEEK_COLUMNS.indexOf(b.delivery_dow));
  return { ok: true, rules: out };
}

/** The rule for one delivery day, or null. */
export function ruleFor(rules, dow) {
  const d = toDow(dow);
  return (Array.isArray(rules) ? rules : []).find((r) => toDow(r?.delivery_dow) === d) || null;
}

/**
 * A site's rules with one day changed: `rule` null takes the delivery off that day, otherwise it
 * sets that day's order by (order_by_dow and order_by_time, both null for no order by). The other
 * days are kept as they are. Answers the plain shape the save takes.
 */
export function withDay(rules, dow, rule) {
  const d = toDow(dow);
  const rest = (Array.isArray(rules) ? rules : [])
    .filter((r) => toDow(r?.delivery_dow) !== d)
    .map((r) => ({ delivery_dow: toDow(r.delivery_dow), order_by_dow: toDow(r.order_by_dow), order_by_time: timeText(r.order_by_time) }));
  if (rule) rest.push({ delivery_dow: d, order_by_dow: toDow(rule.order_by_dow), order_by_time: rule.order_by_time ? (timeText(rule.order_by_time) || rule.order_by_time) : null });
  return rest.sort((a, b) => WEEK_COLUMNS.indexOf(a.delivery_dow) - WEEK_COLUMNS.indexOf(b.delivery_dow));
}

/** One grid cell: `{ delivery: bool, orderBy: 'order by Sun 14:00' | '' }`. */
export function cellModel(rules, dow) {
  const r = ruleFor(rules, dow);
  return { delivery: !!r, orderBy: r ? orderByWords(r) : '' };
}

/** The sites a site's rules can be copied to: every other site that can order. */
export function copyTargets(sites, fromId) {
  return (Array.isArray(sites) ? sites : []).filter((s) => s && s.can_order && s.location_id !== fromId).map((s) => s.location_id);
}

/** Plain words for a rule set, for the change log: 'Mon (order by Sun 14:00), Thu'. '' for none. */
export function rulesWords(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return WEEK_COLUMNS
    .map((d) => ruleFor(list, d))
    .filter(Boolean)
    .map((r) => { const ob = orderByWords(r); return ob ? `${dayLabel(r.delivery_dow)} (${ob})` : dayLabel(r.delivery_dow); })
    .join(', ');
}

/**
 * Do two rule sets say the same thing (the same delivery days, each with the same order by)? The
 * Order rules editor saves nothing when they do. Times compare as 'HH:MM' ('14:00:00' is '14:00').
 */
export function sameRules(a, b) {
  const key = (rules) => WEEK_COLUMNS.map((d) => {
    const r = ruleFor(rules, d);
    if (!r) return '-';
    const od = toDow(r.order_by_dow);
    const t = timeText(r.order_by_time);
    return isDow(od) && t ? `${od}@${t}` : 'none';
  }).join('|');
  return key(a) === key(b);
}
