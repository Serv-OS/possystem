// src/lib/reportScopeLoad.js
//
// THE ONE LOADER for the report scope (src/lib/reportScope.js): closed checks, the previous
// period and the kitchen tickets for the sites a report is shown, every row read in pages
// (src/lib/pagedRead.js) and tagged with its site.
//
// WHY (Peter, 5 Oct 2026, multi site reports): the shell read ONE site inline. Six sites
// each with its own copy of that code would be six chances to forget the row budget, the
// stale guard or the "never a part total" rule. So the read is here, once.
//
// THE RULES THIS FILE KEEPS
//   1. EACH SITE OVER ITS OWN WINDOW. The caller hands each site's own instants (its clock,
//      its business day: reportScope.siteRange). Nothing here works out a time.
//   2. ONE ROW BUDGET for everything the screen will hold, across sites and across this
//      period and the previous one (rowBudget). Past it: fault 'too_long', no rows at all.
//   3. A FAILED PAGE IS NEVER "NO SALES". One site failing fails the read ('failed'); a
//      missing site would read as a quiet one.
//   4. ONE SITE READS EXACTLY AS IT DID BEFORE THE SCOPE: this period, the previous period
//      and the tickets together, and too many rows on either period blanks the report.
//   5. SEVERAL SITES: this period first, then the previous one on what is left of the
//      budget. The previous period only feeds the percent, so when it alone does not fit or
//      does not load, this period still shows and the percent says "Comparison did not
//      load" (prevLoaded false, prevSkipped says why). It is not tried again by itself.
//   6. ROWS ARE TAGGED siteId and siteName (and keep locationId), newest first.
//
// PURE: the fetchers are handed in (db.js fetchClosedChecksRange and fetchKDSTicketsRange in
// the app, fakes under node --test).

import { progressSum, rowBudget, CHECK_ROWS_ON_SCREEN } from './pagedRead.js';

/** Mark rows as one site's. In place: the rows are fresh from the loader and can be 24,000. */
export function tagRows(rows, site) {
  for (const r of rows || []) { r.siteId = site.id; r.siteName = site.name; }
  return rows || [];
}

const newestFirst = (key) => (a, b) => (b[key] || 0) - (a[key] || 0);

/**
 * @param {object} a
 * @param {Array<{ id: string, name: string, from: Date, to: Date, prevFrom: Date, prevTo: Date }>} a.sites
 * @param {Function} a.fetchChecks   (siteId, from, to, { onProgress, stop, budget }) => { data, error, tooMany }
 * @param {Function} [a.fetchTickets] (siteId, from, to, { onProgress, stop }) => { data, error, tooMany }
 * @param {boolean} [a.wantTickets]  read the kitchen tickets too (default true)
 * @param {boolean} [a.wantPrev]     read the previous period too (default true)
 * @param {(p: { done: number, total: number }) => void} [a.onProgress]
 * @param {() => boolean} [a.stop]   true once the screen has moved on
 * @param {number} [a.maxRows]
 * @returns {Promise<{
 *   checks: object[], prevChecks: object[], kdsTickets: object[],
 *   fault: null|'too_long'|'failed', kdsFault: null|'too_long'|'failed' (never null when fault is set),
 *   prevLoaded: boolean, prevSkipped: null|'too_long'|'failed',
 *   prevHeld: Record<string, { from: number, to: number }>, error: any,
 * }>}
 */
export async function loadScopeRows({
  sites, fetchChecks, fetchTickets = null, wantTickets = true, wantPrev = true,
  onProgress = null, stop = null, maxRows = CHECK_ROWS_ON_SCREEN,
} = {}) {
  const list = Array.isArray(sites) ? sites : [];
  // 6 Oct 2026 (review): when the checks blank the read, the tickets carry the SAME fault.
  // The tickets were halted (or thrown away) because of the checks, so handing them back as
  // an empty list made Kitchen performance say "No KDS tickets at these sites" for a period
  // that was simply too long.
  const blank = (fault, error = null) => ({
    checks: [], prevChecks: [], kdsTickets: [], fault, kdsFault: fault,
    prevLoaded: false, prevSkipped: null, prevHeld: {}, error,
  });
  if (!list.length) return { ...blank(null), prevLoaded: true };

  const one = list.length === 1;
  const slot = progressSum((p) => { try { onProgress?.(p); } catch { /* the screen's problem */ } });
  // The periods (and the sites) share one row budget: each could come in under its own
  // ceiling and the lot still be more than the tab can hold.
  const budget = rowBudget(maxRows);
  // Several sites: once one has failed the others stop asking for pages. Their answer is
  // thrown away anyway and their pages would sit in front of whatever is loaded next.
  let failed = false;
  const halt = () => failed || !!stop?.();
  const failFast = (r) => { if (r?.error && !one) failed = true; return r; };

  const readCur  = () => Promise.all(list.map((s) => fetchChecks(s.id, s.from, s.to, { onProgress: slot(`cur:${s.id}`), stop: halt, budget }).then(failFast)));
  const readPrev = () => (wantPrev
    ? Promise.all(list.map((s) => fetchChecks(s.id, s.prevFrom, s.prevTo, { onProgress: slot(`prev:${s.id}`), stop: halt, budget })))
    : Promise.resolve(null));
  const readKds  = () => (wantTickets && fetchTickets
    ? Promise.all(list.map((s) => fetchTickets(s.id, s.from, s.to, { onProgress: slot(`kds:${s.id}`), stop: halt })))
    : Promise.resolve(list.map(() => ({ data: [], error: null }))));

  let cur, prev, kds;
  if (one) {
    [cur, prev, kds] = await Promise.all([readCur(), readPrev(), readKds()]);
  } else {
    [cur, kds] = await Promise.all([readCur(), readKds()]);
    // Not worth asking for the comparison of a period that is not going to show.
    prev = cur.some((r) => r.error) ? list.map(() => ({ data: null, error: new Error('not read') })) : await readPrev();
  }

  const curBad  = cur.find((r) => r.error);
  const prevBad = prev ? prev.find((r) => r.error || !Array.isArray(r.data)) : null;
  const prevTooMany = !!prev && prev.some((r) => r.tooMany);
  // This period decides whether the reports can show at all. For one site, too many rows on
  // EITHER period is the too long line (rule 4).
  const tooLong = cur.some((r) => r.tooMany) || (one && prevTooMany);
  if (curBad || tooLong) return blank(tooLong ? 'too_long' : 'failed', curBad?.error || prevBad?.error || null);

  const kdsBad = kds.find((r) => r.error);
  const out = {
    checks: [], prevChecks: [], kdsTickets: [], fault: null,
    kdsFault: kdsBad ? (kds.some((r) => r.tooMany) ? 'too_long' : 'failed') : null,
    prevLoaded: false, prevSkipped: null, prevHeld: {}, error: prevBad?.error || kdsBad?.error || null,
  };
  list.forEach((s, i) => {
    out.checks.push(...tagRows(cur[i].data || [], s));
    out.kdsTickets.push(...tagRows(kdsBad ? [] : (kds[i].data || []), s));
  });
  if (!prev) {
    out.prevLoaded = true;
  } else if (prevBad) {
    out.prevSkipped = prevTooMany ? 'too_long' : 'failed';
  } else {
    out.prevLoaded = true;
    list.forEach((s, i) => {
      out.prevChecks.push(...tagRows(prev[i].data, s));
      out.prevHeld[s.id] = { from: s.prevFrom.getTime(), to: s.prevTo.getTime() };
    });
  }
  if (!one) {
    out.checks.sort(newestFirst('closedAt'));
    out.prevChecks.sort(newestFirst('closedAt'));
    out.kdsTickets.sort(newestFirst('sentAt'));
  }
  return out;
}

/**
 * The server day sums for the scope: this period and the days it is compared to. `load` is
 * reportDaySums.loadReportDaySums. Never throws; { available: false, reason } means "read
 * the rows instead" (or say it could not load), never zeros.
 *
 * The sums are whole business days. A comparison that is cut part way through its last day
 * ("by 2pm") cannot be cut here, so `compareCut` is handed back true and the report must not
 * print a percent off it as if it were like for like.
 */
export async function loadScopeDaySums({ load, client, sites, range } = {}) {
  const asked = (sites || []).filter((s) => s.clockKnown !== false);
  if (typeof load !== 'function') return { available: false, reason: 'no_loader', current: null, previous: null };
  if (asked.length !== (sites || []).length) {
    return { available: false, reason: 'no_clock', message: 'A site has no time zone or business day start on record.', current: null, previous: null };
  }
  const current = await load({ client, sites: asked, fromDay: range?.fromDay, toDay: range?.toDay });
  if (!current?.available) return { available: false, reason: current?.reason || 'error', message: current?.message || null, current: null, previous: null };
  const c = range?.compare;
  let previous = null;
  if (c?.fromDay && c?.toDay) {
    const p = await load({ client, sites: asked, fromDay: c.fromDay, toDay: c.toDay });
    previous = p?.available ? p : null;
  }
  return { available: true, reason: null, current, previous, compareCut: c?.cut === true };
}
