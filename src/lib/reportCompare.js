// src/lib/reportCompare.js
//
// THE ONE PERCENT RULE: what a report's percent compares to, and the words that say so.
//
// WHY (Peter, 5 Oct 2026): "same day last week, then for the week the week before and the
// month view the month before." Until now Back Office set every period against the same
// length of time immediately before it, so Today was measured against ALL of yesterday
// (every morning read deep red, and a Monday was judged against a Sunday), and the chip
// never said what it was comparing to.
//
// The rule:
//   Today              the same weekday last week, cut at the same time of day.
//   Today's <service>  the same service on the same weekday last week (cut while it runs).
//   This week          the same days of the week before (Mon to the same weekday), cut at
//                      the same time of day on the last one.
//   This month         the same days of the month before (the 1st to the same day number),
//                      cut the same way. A shorter month stops on its last day, whole.
//   Yesterday          the same weekday the week before, the whole day. A single custom day too.
//   Last week          the whole week before it.
//   Last month         the whole calendar month before it.
//   Last 7 / 30 days,  the same number of days immediately before, cut at the same time of
//   a custom range     day when the range ends today. A custom range that runs PAST today
//                      counts only its days so far (1 to 8 Oct seen on the 5th is 1 to 5 Oct).
//
// Everything is on the VENUE's clock and BUSINESS day (the venue clock invariant): days
// are business days ('YYYY-MM-DD') and "the same time of day" is the same wall clock time
// there, so a daylight saving change in between does not move the cut by an hour.
//
// Pure, no imports beyond the accounting day helpers, so node:test loads it as is.

import {
  venueZone, businessDayOf, businessDayStartMs, wallTimeToInstant, wallClock, addDays, isYmd,
} from '../../supabase/functions/_shared/businessDay.js';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 0 = Monday … 6 = Sunday, for a calendar date (no clock involved).
function mondayIndex(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// Whole calendar days from a to b (b minus a).
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// 'Mon 28 Sep' for a calendar date, with no clock or zone involved.
function shortDay(ymd) {
  return `${WEEKDAYS[mondayIndex(ymd)].slice(0, 3)} ${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
}

/** Minutes after midnight as the words on a chip: 840 = '2pm', 845 = '2:05pm', 0 = '12am'. */
export function clockWords(minutes) {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mi = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mi ? `:${String(mi).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** Instants of whole business days fromDay..toDay (to is the last ms before the next day). */
export function dayWindow(fromDay, toDay, tz, bds) {
  return [businessDayStartMs(fromDay, tz, bds), businessDayStartMs(addDays(toDay, 1), tz, bds) - 1];
}

/**
 * Instants of one service on `day`'s wall clock. The end minute is included (15:00 means
 * up to 15:00:59.999), and a service that ends before it starts runs past midnight.
 */
export function serviceWindow(day, sMin, eMin, tz) {
  const from = wallTimeToInstant(day, sMin, tz);
  let to = wallTimeToInstant(day, eMin, tz) + 59999;
  if (to <= from) to = wallTimeToInstant(addDays(day, 1), eMin, tz) + 59999;
  return [from, to];
}

// The last day of the month before the one `ymd` is in.
function lastDayOfMonthBefore(ymd) {
  return addDays(`${ymd.slice(0, 7)}-01`, -1);
}

/**
 * What a period is compared to.
 *
 *   periodId  the period picker's choice ('today', 'this-week', 'custom', 'service:today:…')
 *   range     the period itself: { fromDay, toDay, timeZone, dayStart } and, for a service,
 *             { kind:'service', serviceStart, serviceEnd, shiftName, from, to }
 *             (what getPeriodRange in reports/_filters.js builds)
 *   nowMs     for tests
 *
 * Returns null when the range has no days, else:
 *   { from, to }        real instants, both inclusive (to is the last ms compared)
 *   { fromDay, toDay }  the venue business days compared
 *   label               the words on the chip: 'vs last Monday by 2pm'
 *   nothing             the words when that time had no sales: 'Nothing last Monday by 2pm to compare with'
 *   detail              the exact days, for a tooltip: 'Mon 28 Sep, up to 2pm'
 *   yet                 'today' | 'this week' | 'this month' | 'so far' while the period is
 *                       still trading, null once it is finished
 *   cut                 true when the comparison stops part way through its last day
 */
export function compareRange(periodId, range, nowMs = Date.now()) {
  if (!isYmd(range?.fromDay) || !isYmd(range?.toDay) || range.toDay < range.fromDay) return null;
  const tz  = venueZone(range.timeZone);
  const bds = range.dayStart || '00:00';
  const today = businessDayOf(nowMs, tz, bds);
  const wall  = wallClock(nowMs, tz);
  const { fromDay } = range;
  // A custom range that runs past today has only traded up to today, so it is compared as
  // the days so far: 1 to 8 Oct seen on the 5th is 1 to 5 Oct against the 5 days before,
  // cut at the same time. Set against 8 whole days it read about minus 45% for a flat week,
  // the unfair morning all over again. (A range wholly in the future is left as it is.)
  const toDay = range.toDay > today && fromDay <= today ? today : range.toDay;
  const nDays = daysBetween(fromDay, toDay) + 1;
  const id = typeof periodId === 'string' ? periodId : 'today';

  // The same wall clock time as now, `back` days earlier than the day it falls on, e.g.
  // 02:00 on the calendar Tuesday that still belongs to Monday's business day becomes
  // 02:00 on the Tuesday of the compared week. Seconds carry over so 14:00:30 stays 14:00:30.
  const sameClockOn = (day, anchorDay) =>
    wallTimeToInstant(addDays(day, daysBetween(anchorDay, wall.ymd)), wall.minutes, tz) + (nowMs % 60000);
  const by = ` by ${clockWords(wall.minutes)}`;
  const upTo = `, up to ${clockWords(wall.minutes)}`;

  // ── Today's <service> ────────────────────────────────────────────────────────────
  if (range.kind === 'service' && range.serviceStart != null && range.serviceEnd != null) {
    const day = addDays(fromDay, -7);
    const [from, end] = serviceWindow(day, range.serviceStart, range.serviceEnd, tz);
    const fromMs = range.from instanceof Date ? range.from.getTime() : NaN;
    const toMs   = range.to   instanceof Date ? range.to.getTime()   : NaN;
    const running = nowMs >= fromMs && nowMs <= toMs;
    const to = running ? Math.min(end, Math.max(from, sameClockOn(day, fromDay))) : end;
    const cut = running && to < end;
    // A service that has not started yet today is YESTERDAY's (getPeriodRange moves it back),
    // and on a Tuesday "last Monday" is the day on screen, so say "the Monday before" then.
    const name  = WEEKDAYS[mondayIndex(day)];
    const shift = range.shiftName || 'service';
    const what  = fromDay === today ? `last ${name}'s ${shift}${cut ? by : ''}` : `${shift} the ${name} before`;
    return {
      from: new Date(from), to: new Date(to), fromDay: day, toDay: day,
      label: `vs ${what}`, nothing: `Nothing ${what} to compare with`,
      detail: `${shortDay(day)}${cut ? upTo : ''}`, yet: running ? 'today' : null, cut,
    };
  }

  // Whole business days cFrom..cTo, stopped at the same time of day when the period is
  // still trading today AND the compared last day is a like for like one (`canCut`).
  const build = (cFrom, cTo, canCut, words, yet) => {
    const [from, end] = dayWindow(cFrom, cTo, tz, bds);
    const live = toDay === today;
    let to = end;
    if (live && canCut) to = Math.min(end, Math.max(from, sameClockOn(cTo, toDay)));
    const cut = to < end;
    const what = typeof words === 'function' ? words(cut) : words;
    return {
      from: new Date(from), to: new Date(to), fromDay: cFrom, toDay: cTo,
      label: `vs ${what}`, nothing: `Nothing ${what} to compare with`,
      detail: `${cFrom === cTo ? shortDay(cFrom) : `${shortDay(cFrom)} to ${shortDay(cTo)}`}${cut ? upTo : ''}`,
      // Not started yet (a custom range wholly in the future) is "so far" too, never "in this period".
      yet: live ? yet : toDay > today ? 'so far' : null, cut,
    };
  };
  // One day against the same weekday a week earlier. While that day is still trading the
  // words are "last Monday by 2pm"; once it is over, "the Monday before".
  const sameWeekday = () => {
    const day = addDays(fromDay, -7);
    const name = WEEKDAYS[mondayIndex(day)];
    return build(day, day, true, (cut) => (toDay === today ? `last ${name}${cut ? by : ''}` : `the ${name} before`), 'today');
  };
  const daysBefore = (yet) => build(addDays(fromDay, -nDays), addDays(fromDay, -1), true,
    nDays === 7 && mondayIndex(fromDay) === 0 ? 'the week before' : `the ${nDays} days before`, yet);

  switch (id) {
    case 'yesterday':
      return sameWeekday();
    case 'this-week':
      return build(addDays(fromDay, -7), addDays(toDay, -7), true, 'same days last week', 'this week');
    case 'last-week':
      return build(addDays(fromDay, -7), addDays(toDay, -7), true, 'the week before', 'this week');
    case 'this-month': {
      // The 1st to the same day number of the month before. A shorter month stops on its
      // last day and is taken whole (31 March is set against all of February).
      const last  = lastDayOfMonthBefore(fromDay);
      const want  = Number(toDay.slice(8, 10));
      const fits  = want <= Number(last.slice(8, 10));
      const cTo   = fits ? `${last.slice(0, 7)}-${toDay.slice(8, 10)}` : last;
      return build(`${last.slice(0, 7)}-01`, cTo, fits, 'same days last month', 'this month');
    }
    case 'last-month': {
      const last = lastDayOfMonthBefore(fromDay);
      return build(`${last.slice(0, 7)}-01`, last, false, 'the month before', 'this month');
    }
    case 'last-7':
    case 'last-30':
      return build(addDays(fromDay, -nDays), addDays(fromDay, -1), true, `the ${nDays} days before`, 'so far');
    case 'custom':
      return nDays === 1 ? sameWeekday() : daysBefore('so far');
    case 'today':
    default:
      return nDays === 1 ? sameWeekday() : daysBefore('so far');
  }
}

/**
 * What a chip shows for one figure against its comparison. THE RULE: no comparison sales
 * at all means no percent. A percent off a zero base is meaningless (and a new site or a
 * new channel is not "up infinity"), and a zero so far is not a red minus 100%.
 *
 *   current, previous  the two figures (money, covers, an average…)
 *   compare            compareRange's answer (may be null: the chip still works, without words)
 *   noun               what the figure counts, for the grey wording ('sales', 'tips', 'covers')
 *
 * Returns { kind, pct, text, words, title }:
 *   kind 'pct'      a real percent: text '+2.0%', words 'vs last Monday by 2pm'
 *   kind 'new'      sales now, none to compare with: text 'New'
 *   kind 'quiet'    nothing now (text 'No sales yet today'), or nothing on either side
 *   kind 'unknown'  the comparison figures did not LOAD (notLoaded below): no percent and
 *                   never "New", which would say an established site had no sales then
 */
export function compareChip(current, previous, compare, noun = 'sales') {
  if (compare?.loaded === false) {
    return {
      kind: 'unknown', pct: null, text: 'Comparison did not load', short: 'Not loaded', words: '',
      title: 'The figures to compare with could not be loaded. Open the report again to retry.',
    };
  }
  const cur  = Number(current), prev = Number(previous);
  const hasCur  = Number.isFinite(cur)  && cur  > 0;
  const hasPrev = Number.isFinite(prev) && prev > 0;
  const words = compare?.label || '';
  const detail = compare?.detail ? `Compared to ${compare.detail}` : '';
  if (hasPrev && hasCur) {
    const pct = ((cur - prev) / prev) * 100;
    return { kind: 'pct', pct, text: pctWords(pct), words, title: detail };
  }
  if (hasPrev) {
    const text = compare?.yet === 'so far' ? `No ${noun} so far`
      : compare?.yet ? `No ${noun} yet ${compare.yet}`
      : `No ${noun} in this period`;
    return { kind: 'quiet', pct: null, text, words, title: detail };
  }
  const title = [compare?.nothing, compare?.detail ? `(${compare.detail})` : ''].filter(Boolean).join(' ');
  if (hasCur) return { kind: 'new', pct: null, text: 'New', words: '', title };
  return { kind: 'quiet', pct: null, text: `No ${noun} in either period`, words: '', title };
}

/** '+2.0%', '-12.5%', '0.0%'. */
export function pctWords(pct) {
  const shown = pct.toFixed(1);
  return `${pct > 0 && Number(shown) !== 0 ? '+' : ''}${shown === '-0.0' ? '0.0' : shown}%`;
}

/**
 * The compare for a previous period that did not LOAD (the query failed, or there is no
 * site to ask). Empty and not loaded are different things: only a query that came back
 * with no sales may read "New". The range and its days stay, so a chart axis still works.
 */
export function notLoaded(compare) {
  return { ...(compare || {}), loaded: false };
}

// How often an open report moves its comparison on.
export const COMPARE_STEP_MS = 5 * 60 * 1000;

/**
 * True while a comparison moves with the clock: it is cut at "the same time of day" or its
 * period is still trading. An open report must then rebuild it as time passes (the current
 * side keeps growing from live sales), or by close "today so far" is set against
 * "last Monday by 9am" and reads +200%.
 */
export function compareMoves(compare) {
  return !!compare && (compare.cut === true || !!compare.yet);
}

/**
 * What an open report has to fetch to bring its previous period up to `compare`.
 *   loaded   { from, to } in ms, the window already held (null = nothing held)
 * Returns null when nothing is needed, { from, to, append:true } for just the extra
 * minutes when only the end has moved on (cheap: no need to read a whole month again every
 * few minutes), else { from, to, append:false } for the whole window.
 */
export function prevTopUp(loaded, compare) {
  if (!compare?.from || !compare?.to) return null;
  const from = compare.from.getTime(), to = compare.to.getTime();
  if (loaded && loaded.from === from && loaded.to === to) return null;
  if (loaded && loaded.from === from && to > loaded.to) return { from: loaded.to + 1, to, append: true };
  return { from, to, append: false };
}
