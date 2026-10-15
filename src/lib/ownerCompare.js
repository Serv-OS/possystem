// src/lib/ownerCompare.js: the words on the Owner app's comparison line.
//
// 5 Oct 2026, Peter, on what every percent compares to: "same day last week, then for the week
// the week before and the month view the month before." And the rule that goes with it: the
// line is ALWAYS drawn, and it always says what it compares to.
//   "+2% vs last Monday by 2pm"     Today, cut at the same time of day
//   "+2% vs same days last week"    This week
//   "+2% vs same days last month"   This month
//   "New this week"                 grey: the venue has no full comparison yet
//   "No sales yet today"            grey, never a red minus 100%
//   "Same days last week £881 · +177% (2 of 6 venues, 4 new)"   the group card
//
// The sums and the reason word (ok, new, no_sales_now, no_sales_then) are the function's
// (supabase/functions/_shared/ownerPeriod.js compareOf, groupCompare). This file only turns
// them into words. It never works out a percent of its own: a function from before the reason
// word sends no `compare` block, compareBlock answers null, and the screen keeps the line it
// has always drawn (src/lib/ownerPeriod.js venueView, rollupView).
//
// PURE: node:test loads it.

import { COMPARE_REASONS, ownerPeriod } from '../../supabase/functions/_shared/ownerPeriod.js';
import { signedPct } from './ownerPeriod.js';

/** True when the function's answer says it can do `name` (an older function sends no list). */
export function hasFeature(data, name) {
  return Array.isArray(data?.features) && data.features.includes(name);
}

/**
 * The comparison block for the period on screen, or null. Null when the function is from
 * before the reason word, and null when the block is for ANOTHER period than the numbers
 * beside it: a line is never drawn over figures it was not worked out from.
 */
export function compareBlock(holder, period) {
  const c = holder?.compare;
  if (!c || c.period !== ownerPeriod(period) || !COMPARE_REASONS.includes(c.reason)) return null;
  return c;
}

/**
 * The group's block. The function does not stamp a period on rollup.compare (it stamps each
 * venue's): it is always for the period the answer echoes, the one the screen is showing. So
 * a block with no period is taken, one stamped with another period is refused, and it must
 * carry the venue counts the note is written from.
 */
export function groupCompareBlock(rollup, period) {
  const c = rollup?.compare;
  if (!c || !COMPARE_REASONS.includes(c.reason) || !Number.isInteger(c.venues)) return null;
  if (c.period != null && c.period !== ownerPeriod(period)) return null;
  return c;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 'Monday' for '2026-09-28'. '' when the date is missing or is not one. */
export function weekdayOf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? DAYS[new Date(t).getUTCDay()] : '';
}

/** '2pm' for '14:00', '2:30pm' for '14:30', '12am' for '00:00'. '' when it is not a time. */
export function clockLabel(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return '';
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${min ? `:${m[2]}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * What the period is compared with, in words: 'last Monday by 2pm', 'same days last week',
 * 'same days last month'. `range` is the function's (cmp_to is the day, cmp_time the cut).
 * `withTime: false` leaves the clock out ("No sales last Monday").
 */
export function thenWords(period, range, { withTime = true } = {}) {
  const p = ownerPeriod(period);
  if (p === 'week') return 'same days last week';
  if (p === 'month') return 'same days last month';
  const day = weekdayOf(range?.cmp_to);
  const base = day ? `last ${day}` : 'the same day last week';
  const at = withTime ? clockLabel(range?.cmp_time) : '';
  return at ? `${base} by ${at}` : base;
}

const NOW_WORDS = { today: 'today', week: 'this week', month: 'this month' };
// A venue under Today is new against last week, so it is "New this week" there too.
const NEW_WORDS = { today: 'New this week', week: 'New this week', month: 'New this month' };

/** The grey line for a reason that has no percent. */
function greyWords(reason, period, range) {
  const p = ownerPeriod(period);
  if (reason === 'new') return NEW_WORDS[p];
  if (reason === 'no_sales_now') return `No sales yet ${NOW_WORDS[p]}`;
  return p === 'today' ? `No sales ${thenWords(p, range, { withTime: false })}` : `No sales in the ${thenWords(p, range)}`;
}

/**
 * One venue's comparison line. Always a line, never nothing.
 * @param {{ reason: string, pct: number|null }} compare  a compareBlock answer
 * @param {object|null} range  the venue's range
 * @returns {{ text: string, tone: 'up'|'down'|'grey', reason: string }}
 */
export function compareLine(compare, range, period) {
  const reason = compare?.reason;
  if (reason === 'ok' && Number.isFinite(compare.pct)) {
    return { text: `${signedPct(compare.pct)} vs ${thenWords(period, range)}`, tone: compare.pct >= 0 ? 'up' : 'down', reason };
  }
  // 'ok' with no percent cannot happen (ok means both sides sold); it reads as no sales then.
  const why = reason === 'new' || reason === 'no_sales_now' ? reason : 'no_sales_then';
  return { text: greyWords(why, period, range), tone: 'grey', reason: why };
}

/**
 * ' (2 of 6 venues, 4 new)': how many venues the group percent is for, when it is for fewer
 * than the headline. '' when every venue is compared.
 */
export function groupNote(g) {
  const all = Number(g?.venues) || 0, n = Number(g?.venues_compared) || 0;
  if (!(n > 0) || n >= all) return '';
  const fresh = Math.min(Number(g?.venues_new) || 0, all - n);
  const rest = all - n - fresh;
  const bits = [`${n} of ${all} venues`];
  if (fresh > 0) bits.push(`${fresh} new`);
  if (rest > 0) bits.push(`${rest} with no sales then`);
  return ` (${bits.join(', ')})`;
}

/**
 * The comparison dates a set of venues share, for the group line's words. The day is named
 * only when every venue compares with the same one, and the clock only when they all stop at
 * the same time (a UK and a US venue do not): otherwise the words fall back to
 * 'the same day last week' with no time, never one venue's day said for all of them.
 */
export function sharedCompareRange(locations) {
  const list = (locations || []).map((l) => l?.range).filter(Boolean);
  if (!list.length || list.length !== (locations || []).length) return null;
  const first = list[0];
  if (!list.every((r) => r.cmp_to === first.cmp_to)) return null;
  return { cmp_to: first.cmp_to, cmp_time: list.every((r) => r.cmp_time === first.cmp_time) ? first.cmp_time ?? null : null };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The group card's line, in parts so the screen can colour the percent:
 *   label   'Same days last week' | 'Last Monday by 2pm'
 *   amount  the comparison pounds at the venues that are compared (ALWAYS the comparison's,
 *           it was this week's under Today and last week's under the others)
 *   pct, tone, note
 * or, when there is no fair percent, { grey: 'New this week' }.
 * `range` is the dates the venues share, or null when they sit on different ones.
 */
export function groupLine(compare, range, period) {
  if (compare?.reason === 'ok' && Number.isFinite(compare.pct)) {
    return {
      label: cap(thenWords(period, range)), amount: Number(compare.cmp_net_sales) || 0,
      pct: signedPct(compare.pct), tone: compare.pct >= 0 ? 'up' : 'down', note: groupNote(compare), grey: null,
    };
  }
  return { label: '', amount: null, pct: '', tone: 'grey', note: '', grey: compareLine(compare, range, period).text };
}
