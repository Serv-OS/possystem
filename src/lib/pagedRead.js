// pagedRead.js: every row of a report read in the browser, 1,000 a page.
//
// 5 Oct 2026 (Peter: "improve our reports"): the Back Office reports under counted. The shared
// loader asked for up to 5,000 closed checks in ONE request, but PostgREST answers at most
// 1,000 rows a request on this project whatever .limit() asks for, and says nothing about the
// rest (supabase/functions/_shared/pagedRows.js found the same on 27 Sep in the owner and
// manager snapshots). Rows come newest first, so the OLDEST days of the period silently
// dropped: Huddersfield closed 1,861 checks in 7 days and the screen added up the newest 1,000.
//
// What this does:
//   - the first page asks for the exact row count, so the reader knows how many pages there
//     are ("Loading 3 of 9") and whether the period is too long BEFORE it reads the rest;
//   - the remaining pages go through `gate` (see reportGate) so at most 3 requests are in
//     flight for the whole reports screen: the tills read through the same PostgREST;
//   - `build` must order on a UNIQUE key (closed_at then id). Rows arriving during the read
//     push older rows down a place, so a row can show on two pages: rows are kept once, by
//     id. While the last page read is full there may be more, so the next page is read too;
//   - ONLY the first page asks for the count. PostgREST refuses a counted request that starts
//     past the last row (416), and answers an uncounted one with an empty list, which is
//     what the look past a full last page needs;
//   - past `maxPages` it throws TooManyRowsError. It never hands back a cut list;
//   - a failed page throws. It is never read as "no rows";
//   - a page with no answer after 30 seconds is a failed page (PageTimeoutError) and gives its
//     slot back. The slots are shared by every report in the tab, so three requests that hung
//     when the wifi roamed would otherwise have held every later report for ever;
//   - reads that land on one screen together can share a `budget` of rows (rowBudget): the
//     ceiling is there to protect the tab's memory, and two reads each under their own
//     ceiling can still be too much between them.
//
// PURE: no imports but the edge functions' limiter (itself import free); runs under node --test.

import { limiter } from '../../supabase/functions/_shared/pagedRows.js';

export const PAGE = 1000;
// 60 pages = 60,000 rows: the ceiling for LIGHT rows (a stock movement is 6 short columns).
export const MAX_PAGES = 60;
export const MAX_IN_FLIGHT = 3;
// The ceiling has to fit the weight of the row, not only the count. A closed check is read
// whole (select *) and is about 3.1 KB of JSON at Huddersfield (measured 5 Oct 2026: 1,861
// checks in 7 days, 2,057 kitchen tickets at about 0.8 KB each). 60,000 of them would be
// about 185 MB, and the shell reads two periods: the tab would die before the "too long"
// line could show. So one read of checks stops at 20 pages (about 62 MB, roughly 75 days at
// the busiest site), and all the checks ONE screen holds at once (this period with the
// previous one, or every venue of Location compare) stop at 24,000 rows (about 74 MB).
// Longer ranges want a server side rollup, not row reads.
export const CHECK_MAX_PAGES = 20;
export const CHECK_ROWS_ON_SCREEN = 24000;
// Kitchen tickets run a little above the checks, so their ceiling sits above the checks' one:
// whenever the sales reports can load, Kitchen performance can too (30 pages, about 23 MB).
export const TICKET_MAX_PAGES = 30;
// A page with no answer after this long has failed. The signed in role's statement_timeout
// is 8 seconds, so nothing that is still working runs anywhere near this.
export const PAGE_TIMEOUT_MS = 30000;

// ONE gate for every report read on the page: this period, the previous period and the
// kitchen tickets share the same 3 slots, and so do the venues of Location compare.
export const reportGate = limiter(MAX_IN_FLIGHT);

export class TooManyRowsError extends Error {
  constructor(what, rows, maxRows) {
    super(`Too many ${what} for one report (${rows == null ? 'over ' + maxRows : rows} rows, the most is ${maxRows}). Choose a shorter period.`);
    this.name = 'TooManyRowsError';
    this.code = 'too_many_rows';
    this.rows = rows ?? null;
    this.maxRows = maxRows;
  }
}

export class ReadStoppedError extends Error {
  constructor(what) {
    super(`Stopped reading ${what}`);
    this.name = 'ReadStoppedError';
    this.code = 'read_stopped';
  }
}

export class PageTimeoutError extends Error {
  constructor(what, ms) {
    super(`Could not read ${what}: no answer after ${Math.round(ms / 1000)} seconds`);
    this.name = 'PageTimeoutError';
    this.code = 'page_timeout';
  }
}

export const isTooManyRows = (err) => err?.code === 'too_many_rows';
export const isReadStopped = (err) => err?.code === 'read_stopped';
export const isPageTimeout = (err) => err?.code === 'page_timeout';

/**
 * The end of a window that is still trading, pinned to the moment the read started.
 *
 * 6 Oct 2026 (multi site review): the pages are read by offset on a newest first order, and
 * pages 1..n go out together. A sale closing between two pages pushes every older row down a
 * place. When the earlier page is answered first the row shows on both pages and is kept once
 * (keyOf). When the LATER page is answered first (page 2 back 80 ms before page 1), the row
 * that sat last on the earlier page falls between them and is on neither: one check quietly
 * missing from a month that is still trading, a different one on each reload. With the end
 * pinned, a sale closing during the read falls outside every page's window, so the offsets
 * cannot shift. A window that ended in the past is left exactly as it is. The signed in
 * site's live sales are merged in by the reports shell, so Today still fills in as it trades;
 * another site is a picture as of its load, as it always was.
 */
export function pinnedEnd(toDate, nowMs = Date.now()) {
  if (!(toDate instanceof Date) || Number.isNaN(toDate.getTime())) return toDate;
  return toDate.getTime() > nowMs ? new Date(nowMs) : toDate;
}

/**
 * A count of rows several reads share. Hand the SAME budget to each read that lands on one
 * screen together: once their rows pass `maxRows` between them, every one of them stops with
 * TooManyRowsError (the one that tipped it at once, the others at their next page).
 */
export function rowBudget(maxRows) {
  return { max: maxRows, used: 0, over: false };
}

// One request with a deadline. The request is told to abort (when the client can), and the
// promise settles on the timer whatever the client does, so the gate's slot always comes back.
function withDeadline(what, q, ms) {
  if (!(ms > 0)) return q;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const req = (ctl && typeof q?.abortSignal === 'function') ? q.abortSignal(ctl.signal) : q;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ctl?.abort(); } catch { /* the request is given up on either way */ }
      reject(new PageTimeoutError(what, ms));
    }, ms);
    Promise.resolve(req).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * @param {string} what  what is being read, for the error message ("closed checks")
 * @param {(first: boolean) => any} build  a NEW PostgREST query each call, ordered on a unique
 *        key. When `first` is true it should ask for the count: .select(cols, { count: 'exact' }).
 *        Without a count the pages are read one after another until a short one.
 * @param {{
 *   page?: number, maxPages?: number,
 *   gate?: ((ask: () => any) => Promise<any>) | null,
 *   onProgress?: ((p: { done: number, total: number }) => void) | null,
 *   keyOf?: ((row: any) => any) | null,
 *   stop?: (() => boolean) | null,
 *   budget?: { max: number, used: number, over: boolean } | null,
 *   pageTimeoutMs?: number,
 * }} [opts]
 * @returns {Promise<any[]>} every row, once, in the query's order
 */
export async function readAllPages(what, build, opts = {}) {
  const {
    page = PAGE, maxPages = MAX_PAGES, gate = reportGate,
    onProgress = null, keyOf = (r) => r?.id, stop = null,
    budget = null, pageTimeoutMs = PAGE_TIMEOUT_MS,
  } = opts;
  const maxRows = page * maxPages;
  const pages = [];          // pages[i] = the rows of page i
  let done = 0;
  let total = 1;
  let failed = null;
  let counted = false;       // the first page came back with the exact count

  const overBudget = () => new TooManyRowsError(what, budget.used, budget.max);
  const spend = (rows) => {
    if (!budget) return;
    budget.used += rows;
    if (budget.used > budget.max) { budget.over = true; throw overBudget(); }
  };

  const tell = () => { try { onProgress?.({ done, total: Math.max(total, done) }); } catch { /* the screen's problem */ } };

  const readPage = async (i) => {
    const ask = () => {
      // A page that waited its turn behind a failure, or after the screen moved on, is not sent.
      if (failed) throw failed;
      if (stop?.()) throw new ReadStoppedError(what);
      // Another read on the same screen has already tipped the shared budget.
      if (budget?.over) throw overBudget();
      const q = build(i === 0);
      return withDeadline(what, q.range(i * page, i * page + page - 1), pageTimeoutMs);
    };
    try {
      const res = await (gate ? gate(ask) : ask());
      if (res?.error) {
        // The API's own message stays in the text (screens match on it, "relation does not exist").
        const err = new Error(`Could not read ${what}: ${res.error.message || res.error}`);
        err.cause = res.error;
        throw err;
      }
      pages[i] = res?.data ?? [];
      done += 1;
      if (i === 0 && Number.isFinite(res?.count)) counted = true;
      // With a count the whole read is charged to the budget at once (below); without one,
      // page by page as the rows arrive.
      if (!counted) spend(pages[i].length);
      return res;
    } catch (err) {
      failed = failed || err;
      throw failed;
    }
  };

  const first = await readPage(0);
  const count = Number.isFinite(first?.count) ? first.count : null;
  if (count != null && count > maxRows) throw new TooManyRowsError(what, count, maxRows);
  if (count != null) {
    try { spend(count); } catch (err) { failed = failed || err; throw err; }
  }
  if (count != null) total = Math.max(1, Math.ceil(count / page));
  tell();

  // The pages the count promised, a few at a time (the gate decides how many).
  if (total > 1) {
    const rest = [];
    for (let i = 1; i < total; i += 1) rest.push(readPage(i).then(tell));
    const settled = await Promise.allSettled(rest);
    if (failed) throw failed;
    const bad = settled.find((s) => s.status === 'rejected');
    if (bad) throw bad.reason;
  }

  // A full last page means there may be more: no count came back, the rows are an exact
  // multiple of the page, or rows arrived during the read and pushed older ones down.
  // At the ceiling exactly, the one look past it must find nothing.
  while ((pages[pages.length - 1]?.length ?? 0) >= page) {
    total = Math.max(total, pages.length + 1);
    await readPage(pages.length);
    if (pages.length > maxPages && pages[pages.length - 1].length > 0) throw new TooManyRowsError(what, null, maxRows);
    tell();
  }

  const out = [];
  const seen = new Set();
  for (const rows of pages) {
    for (const row of rows || []) {
      const k = keyOf ? keyOf(row) : undefined;
      if (k != null) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(row);
    }
  }
  return out;
}

/**
 * readAllPages in the { data, error } shape the loaders in db.js hand back. `tooMany` is set
 * when the ceiling stopped the read, so a report can say "choose a shorter period" and not
 * show totals from part of it.
 */
export async function readAllPagesResult(what, build, opts = {}) {
  try {
    return { data: await readAllPages(what, build, opts), error: null };
  } catch (error) {
    return { data: null, error, tooMany: isTooManyRows(error), stopped: isReadStopped(error) };
  }
}

/**
 * Adds up the progress of several reads into one "Loading 3 of 9".
 * `slot(name)` gives the onProgress for one read; `onChange` hears the sum each time.
 */
export function progressSum(onChange) {
  const parts = new Map();
  return (name) => (p) => {
    parts.set(name, p);
    let done = 0;
    let total = 0;
    for (const v of parts.values()) { done += v.done; total += v.total; }
    onChange({ done, total });
  };
}

/** "Loading 3 of 9", or plain "Loading" before the first page has said how many there are. */
export function loadingText(progress) {
  if (!progress || !(progress.total > 1)) return 'Loading…';
  return `Loading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`;
}

/** The line a report shows when a page failed: never rows from part of a read. */
export const LOAD_FAILED_TEXT = 'This report could not be loaded. Check the connection and choose the period again.';
/** The line for a fault: 'too_long' or anything else. */
export const faultText = (fault) => (fault === 'too_long' ? TOO_LONG_TEXT : LOAD_FAILED_TEXT);

/** The line a report shows when the ceiling stopped the read. */
export const TOO_LONG_TEXT = 'This period is too long for this report. Choose a shorter period and try again.';
