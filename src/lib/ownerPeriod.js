// src/lib/ownerPeriod.js: the Owner app's side of the quick filters (Today, This week, This month).
//
// 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for today, this
// week, this month." The dates and the sums are the function's job (owner-snapshot, with
// supabase/functions/_shared/ownerPeriod.js). This file is what the screen needs around them:
// which chip the phone last chose, what the answer actually holds, and the words for it.
//
// THE ONE RULE: a label always describes the numbers under it. The app ships before the
// function does, so an owner-snapshot from before the filters can answer a "This month" request
// with today's figures and no word that it did. The function now echoes the period it worked
// out; an answer with no echo is today's, is shown as today's, and the chip goes back to Today
// with one line saying why. Today's numbers are never shown under a This month label.
//
// PURE: imports only the shared period names; node:test loads it.

import { OWNER_PERIODS, ownerPeriod } from '../../supabase/functions/_shared/ownerPeriod.js';

export const OWNER_PERIOD_KEY = 'servos-owner-period';

export const PERIOD_CHIPS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
];

export const NEEDS_UPDATE = 'This week and This month need a ServOS update.';

// Today's words are the ones the app has always used.
export const PERIOD_COPY = {
  today: { heading: 'Today', sales: 'Net sales today', top: 'Top sellers today', before: '', versus: '' },
  week: { heading: 'This week', sales: 'Net sales this week', top: 'Top items this week', before: 'Same days last week', versus: 'vs same days last week' },
  month: { heading: 'This month', sales: 'Net sales this month', top: 'Top items this month', before: 'Same days last month', versus: 'vs same days last month' },
};

/** The chip this phone last chose. Today when nothing is stored or storage is closed to us. */
export function readStoredPeriod(storage) {
  try { return ownerPeriod(storage?.getItem(OWNER_PERIOD_KEY)); } catch { return 'today'; }
}

/** Remembers the chip on this phone. A phone that will not store it just starts on Today. */
export function storePeriod(storage, period) {
  try { storage?.setItem(OWNER_PERIOD_KEY, ownerPeriod(period)); return true; } catch { return false; }
}

/**
 * What an answer from owner-snapshot actually holds, and whether the chip asked for more.
 *   period       the period the numbers are for: the function's own echo, and only when every
 *                venue (and the group) came back with that period's totals. Otherwise today.
 *   needsUpdate  true when the chip asked for a week or a month and got today's numbers: the
 *                function is from before the filters.
 * @param {any} data   the function's answer (null before the first one)
 * @param {string} asked  the chip that asked
 */
export function shownPeriod(data, asked) {
  const want = ownerPeriod(asked);
  const echoed = data && OWNER_PERIODS.includes(data.period) ? data.period : 'today';
  const whole = echoed === 'today'
    || (!!data.rollup?.period_totals && (data.locations || []).every((l) => !!l?.period_totals));
  const period = whole ? echoed : 'today';
  return { period, needsUpdate: !!data && want !== 'today' && period === 'today' };
}

/**
 * One venue card's figures for the period shown. Today reads the fields the app has always
 * read (`today`, `top_items`, the week to date chip), so it looks exactly as it did.
 */
export function venueView(l, period) {
  if (period === 'today' || !l?.period_totals) {
    const t = l?.today || {};
    return {
      period: 'today', net_sales: t.net_sales, forecast: t.forecast, forecast_pct: t.forecast_pct, orders: t.orders,
      avg_check: t.avg_check, labour_pct: t.labour_pct, tips: t.tips, top_items: l?.top_items || [],
      vs_pct: l?.wtd?.vs_last_week_pct ?? null,
    };
  }
  const p = l.period_totals;
  return {
    period, net_sales: p.net_sales, forecast: p.forecast, forecast_pct: p.forecast_pct, orders: p.orders,
    avg_check: p.avg_check, labour_pct: p.labour_pct, tips: p.tips, top_items: l.period_top_items || [],
    vs_pct: p.vs_cmp_pct ?? null,
  };
}

/** The group card's figures for the period shown. Live orders and tables are always now. */
export function rollupView(r, period) {
  const live = { live_orders: r?.live_orders ?? 0, open_tables: r?.open_tables ?? 0 };
  if (period === 'today' || !r?.period_totals) {
    return {
      period: 'today', ...live, net_sales: r?.net_sales, forecast: r?.forecast, forecast_pct: r?.forecast_pct,
      orders: r?.orders, labour_pct: r?.labour_pct,
      // Today's comparison line is the week to date, as it always was.
      before: r?.wtd_net, vs_pct: r?.wtd_vs_last_week_pct ?? null,
    };
  }
  const p = r.period_totals;
  return {
    period, ...live, net_sales: p.net_sales, forecast: p.forecast, forecast_pct: p.forecast_pct,
    orders: p.orders, labour_pct: p.labour_pct, before: p.cmp_net_sales, vs_pct: p.vs_cmp_pct ?? null,
    // How many venues the percent is for (the ones that traded in the comparison span).
    cmp_locations: p.cmp_locations ?? null,
  };
}

/**
 * The group percent is like for like: it leaves out a venue that sold nothing in the comparison
 * span (a new venue against a week it was not open would read "+300000%"). When that makes it a
 * percent for fewer venues than the headline, the line says so: ' (1 of 5 venues)'. '' otherwise.
 */
export function likeForLikeNote(rv, venues) {
  const n = rv?.cmp_locations;
  return Number.isInteger(n) && n > 0 && n < Number(venues) ? ` (${n} of ${venues} venues)` : '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
};

/** "28 Sep to 2 Oct", or "2 Oct" for a single day. '' when the dates are missing. */
export function rangeLabel(range) {
  const a = dayMonth(range?.from), b = dayMonth(range?.to);
  if (!a || !b) return '';
  return a === b ? a : `${a} to ${b}`;
}

/**
 * The dates every venue shares, or null when venues sit on different dates (a UK and a US
 * venue around midnight): then each card says its own.
 */
export function sharedRange(locations) {
  const list = (locations || []).map((l) => l?.range).filter(Boolean);
  if (!list.length || list.length !== (locations || []).length) return null;
  const first = list[0];
  return list.every((r) => r.from === first.from && r.to === first.to) ? first : null;
}

/**
 * The group cards to draw: one, or ONE PER CURRENCY when the venues do not share one.
 * 5 Oct 2026: currencies are never added together. The function sends rollup.by_currency (one
 * total per currency); with two or more of them each gets its own card and its own venues.
 * A function from before that sends no by_currency: one card, in the first venue's currency,
 * exactly as the app has always drawn it.
 * @returns {{ rollup: any, currency: string, locations: any[] }[]}
 */
export function groupCards(data) {
  const r = data?.rollup, locs = data?.locations || [];
  if (!r || !locs.length) return [];
  const by = Array.isArray(r.by_currency) ? r.by_currency.filter((g) => g?.currency && g.locations > 0) : [];
  if (by.length > 1) return by.map((g) => ({ rollup: g, currency: g.currency, locations: locs.filter((l) => l.currency === g.currency) }));
  return [{ rollup: r, currency: r.currency || locs[0]?.currency || 'GBP', locations: locs }];
}

/** '+12%' or '-3%'; '' when there is nothing to compare with. */
export function signedPct(p) {
  return p == null ? '' : `${p >= 0 ? '+' : ''}${p}%`;
}
