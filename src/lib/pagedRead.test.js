// pagedRead.test.js: the browser's page reader for reports (5 Oct 2026).
// The reports under counted because one request can never carry more than 1,000 rows. These
// tests hold the reader to: every row once, at the 1,000 and 2,000 boundaries, with a row
// arriving mid read, a clear stop at the ceiling, a thrown error on a failed page, and at
// most 3 requests in flight. The last block pins the report loaders' source to the reader.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  readAllPages, readAllPagesResult, progressSum, loadingText,
  TooManyRowsError, isTooManyRows, isReadStopped, PAGE, MAX_PAGES, MAX_IN_FLIGHT, reportGate,
  rowBudget, isPageTimeout, faultText, TOO_LONG_TEXT, LOAD_FAILED_TEXT,
  CHECK_MAX_PAGES, CHECK_ROWS_ON_SCREEN, TICKET_MAX_PAGES, PAGE_TIMEOUT_MS,
} from './pagedRead.js';
import { limiter } from '../../supabase/functions/_shared/pagedRows.js';

// A stand in for PostgREST over one table held newest first: .range() answers a slice of the
// table AS IT IS when the request lands, and the first request carries the exact count.
function fakeTable(n, { withCount = true, delay = 0 } = {}) {
  const t = {
    rows: Array.from({ length: n }, (_, i) => ({ id: `c${n - i}`, at: n - i })), // newest first
    calls: [],
    inFlight: 0,
    peak: 0,
    onCall: null,   // (callNumber, from) => void, runs before the slice is taken
    failAt: null,   // call number that answers an error
  };
  t.build = (first) => ({
    range: async (from, to) => {
      t.inFlight += 1; t.peak = Math.max(t.peak, t.inFlight);
      const callNo = t.calls.length + 1;
      t.calls.push({ from, to, first });
      try {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        t.onCall?.(callNo, from);
        if (t.failAt === callNo) return { data: null, error: { message: 'upstream timeout' } };
        return { data: t.rows.slice(from, to + 1), error: null, count: first && withCount ? t.rows.length : null };
      } finally { t.inFlight -= 1; }
    },
  });
  return t;
}
const ids = (rows) => rows.map((r) => r.id);
const unique = (rows) => new Set(ids(rows)).size;

test('a short read is one request and every row', async () => {
  const t = fakeTable(137);
  const rows = await readAllPages('checks', t.build, { gate: null });
  assert.equal(rows.length, 137);
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], { from: 0, to: 999, first: true });
  assert.equal(rows[0].id, 'c137');            // the query's order is kept
});

test('no rows at all is an empty list, not an error', async () => {
  const t = fakeTable(0);
  assert.deepEqual(await readAllPages('checks', t.build, { gate: null }), []);
});

test('exactly 1,000 rows: all 1,000, once (the old loader stopped here and could not tell)', async () => {
  const t = fakeTable(1000);
  const rows = await readAllPages('checks', t.build, { gate: null });
  assert.equal(rows.length, 1000);
  assert.equal(unique(rows), 1000);
  // a full last page is always followed by one more look, which finds nothing
  assert.deepEqual(t.calls.map((c) => c.from), [0, 1000]);
});

test('1,001 rows: the row past the cap is read', async () => {
  const t = fakeTable(1001);
  const rows = await readAllPages('checks', t.build, { gate: null });
  assert.equal(rows.length, 1001);
  assert.equal(rows.at(-1).id, 'c1');          // the OLDEST row, the one the cap dropped
});

test('exactly 2,000 rows: all 2,000, once', async () => {
  const t = fakeTable(2000);
  const rows = await readAllPages('checks', t.build, { gate: null });
  assert.equal(rows.length, 2000);
  assert.equal(unique(rows), 2000);
  assert.deepEqual(t.calls.map((c) => c.from).sort((a, b) => a - b), [0, 1000, 2000]);
  // only the first request asks for the count: a counted request past the last row is refused
  assert.deepEqual(t.calls.map((c) => c.first), [true, false, false]);
});

test('1,861 rows (Huddersfield, 7 days): every check, in order', async () => {
  const t = fakeTable(1861);
  const rows = await readAllPages('checks', t.build, { gate: limiter(3) });
  assert.equal(rows.length, 1861);
  assert.deepEqual(ids(rows), ids(t.rows));
});

test('without a count the pages are read one after another until a short one', async () => {
  const t = fakeTable(2500, { withCount: false });
  const rows = await readAllPages('checks', t.build, { gate: null });
  assert.equal(rows.length, 2500);
  assert.deepEqual(t.calls.map((c) => c.from), [0, 1000, 2000]);
});

test('a row arriving mid read: nothing that was there is skipped, nothing is doubled', async () => {
  // 2,000 rows when the read starts. After the first page a new sale lands on top, which
  // pushes every older row down one place: page 2 starts with a row page 1 already gave, and
  // the oldest row falls off the end of page 2 onto a third page.
  const t = fakeTable(2000);
  const before = ids(t.rows);
  t.onCall = (callNo) => { if (callNo === 2) t.rows.unshift({ id: 'new-sale', at: 99999 }); };
  const rows = await readAllPages('checks', t.build, { gate: null });
  assert.equal(unique(rows), rows.length, 'no row twice');
  const got = new Set(ids(rows));
  for (const id of before) assert.ok(got.has(id), `row ${id} was skipped`);
  assert.ok(got.has('c1'), 'the oldest row, pushed onto a third page, is still read');
  assert.equal(rows.length, 2000);
});

test('rows arriving mid read with pages in flight together: still every original row once', async () => {
  const t = fakeTable(4500, { delay: 1 });
  const before = ids(t.rows);
  let n = 0;
  t.onCall = (callNo) => { if (callNo > 1) t.rows.unshift({ id: `late${n += 1}`, at: 99999 + n }); };
  const rows = await readAllPages('checks', t.build, { gate: limiter(3) });
  assert.equal(unique(rows), rows.length);
  const got = new Set(ids(rows));
  for (const id of before) assert.ok(got.has(id), `row ${id} was skipped`);
});

test('rows with no id are all kept (nothing to tell doubles by)', async () => {
  const build = () => ({ range: async (from) => ({ data: from === 0 ? [{ v: 1 }, { v: 1 }] : [], error: null, count: 2 }) });
  assert.equal((await readAllPages('things', build, { gate: null })).length, 2);
});

test('the ceiling: the count says too many, so it stops after ONE request and says so', async () => {
  const t = fakeTable(5001);
  await assert.rejects(
    readAllPages('closed checks', t.build, { gate: null, maxPages: 5 }),
    (err) => {
      assert.ok(err instanceof TooManyRowsError);
      assert.ok(isTooManyRows(err));
      assert.equal(err.rows, 5001);
      assert.equal(err.maxRows, 5000);
      assert.match(err.message, /shorter period/);
      return true;
    },
  );
  assert.equal(t.calls.length, 1, 'the other pages are never asked for');
});

test('the ceiling: exactly at it is fine', async () => {
  const t = fakeTable(5000);
  const rows = await readAllPages('checks', t.build, { gate: null, maxPages: 5 });
  assert.equal(rows.length, 5000);
});

test('the ceiling without a count: stops at maxPages, never hands back a cut list', async () => {
  const t = fakeTable(9000, { withCount: false });
  await assert.rejects(readAllPages('checks', t.build, { gate: null, maxPages: 3 }), isTooManyRows);
  assert.equal(t.calls.length, 4, '3 pages and one look past them, then it stops');
});

test('the default ceiling is 60 pages of 1,000', () => {
  assert.equal(PAGE, 1000);
  assert.equal(MAX_PAGES, 60);
});

test('an error on page 3 throws; it is never read as "no more rows"', async () => {
  const t = fakeTable(4200);
  t.failAt = 3;
  await assert.rejects(
    readAllPages('closed checks', t.build, { gate: null }),
    /Could not read closed checks: upstream timeout/,
  );
});

test('an error on page 3 with pages queued: the ones still waiting are not sent', async () => {
  const t = fakeTable(20000, { delay: 1 });
  t.failAt = 3;
  await assert.rejects(readAllPages('checks', t.build, { gate: limiter(2) }), /upstream timeout/);
  assert.ok(t.calls.length < 20, `sent ${t.calls.length} of 20 pages after a failure`);
});

test('an error on the first page throws', async () => {
  const t = fakeTable(10);
  t.failAt = 1;
  await assert.rejects(readAllPages('checks', t.build, { gate: null }), /upstream timeout/);
});

test('readAllPagesResult: { data, error } and the tooMany flag, never a throw', async () => {
  const ok = await readAllPagesResult('checks', fakeTable(1500).build, { gate: null });
  assert.equal(ok.error, null);
  assert.equal(ok.data.length, 1500);

  const long = await readAllPagesResult('checks', fakeTable(3001).build, { gate: null, maxPages: 3 });
  assert.equal(long.data, null);
  assert.equal(long.tooMany, true);

  const t = fakeTable(2500); t.failAt = 2;
  const bad = await readAllPagesResult('checks', t.build, { gate: null });
  assert.equal(bad.data, null);
  assert.equal(bad.tooMany, false);
  assert.match(bad.error.message, /upstream timeout/);
  assert.equal(bad.error.cause.message, 'upstream timeout');
});

test('progress: one call a page, ending done = total', async () => {
  const t = fakeTable(8200);
  const seen = [];
  await readAllPages('checks', t.build, { gate: limiter(3), onProgress: (p) => seen.push({ ...p }) });
  assert.equal(seen.length, 9);
  assert.deepEqual(seen[0], { done: 1, total: 9 });
  assert.deepEqual(seen.at(-1), { done: 9, total: 9 });
  assert.ok(seen.every((p) => p.done <= p.total));
});

test('progress: an extra page found past the count grows the total', async () => {
  const t = fakeTable(2000);
  const seen = [];
  await readAllPages('checks', t.build, { gate: null, onProgress: (p) => seen.push({ ...p }) });
  assert.deepEqual(seen.at(-1), { done: 3, total: 3 });
});

test('progress: a callback that throws does not break the read', async () => {
  const rows = await readAllPages('checks', fakeTable(1200).build, { gate: null, onProgress: () => { throw new Error('screen gone'); } });
  assert.equal(rows.length, 1200);
});

test('at most 3 requests in flight, however many pages', async () => {
  const t = fakeTable(12000, { delay: 2 });
  await readAllPages('checks', t.build, { gate: limiter(MAX_IN_FLIGHT) });
  assert.equal(MAX_IN_FLIGHT, 3);
  assert.ok(t.peak <= 3, `peak ${t.peak}`);
  assert.ok(t.peak >= 2, 'and it does run pages side by side');
});

test('three reads at once (this period, last period, kitchen tickets) share the 3 slots', async () => {
  const gate = limiter(3);
  let inFlight = 0; let peak = 0;
  const mk = (n) => {
    const t = fakeTable(n);
    return (first) => {
      const q = t.build(first);
      return { range: async (a, b) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        try { return await q.range(a, b); } finally { inFlight -= 1; }
      } };
    };
  };
  const [a, b, c] = await Promise.all([
    readAllPages('cur', mk(5200), { gate }), readAllPages('prev', mk(4100), { gate }), readAllPages('kds', mk(6300), { gate }),
  ]);
  assert.deepEqual([a.length, b.length, c.length], [5200, 4100, 6300]);
  assert.ok(peak <= 3, `peak ${peak}`);
});

test('the default gate is the shared report gate', async () => {
  assert.equal(typeof reportGate, 'function');
  const rows = await readAllPages('checks', fakeTable(2300).build);
  assert.equal(rows.length, 2300);
});

test('stop: a read the screen has moved on from asks for no more pages', async () => {
  const t = fakeTable(9000, { delay: 1 });
  let stale = false;
  t.onCall = (callNo) => { if (callNo === 1) stale = true; };
  await assert.rejects(readAllPages('checks', t.build, { gate: limiter(2), stop: () => stale }), isReadStopped);
  assert.equal(t.calls.length, 1);
  const r = await readAllPagesResult('checks', fakeTable(10).build, { gate: null, stop: () => true });
  assert.equal(r.stopped, true);
});

test('progressSum adds the reads into one "3 of 9"', () => {
  let last = null;
  const slot = progressSum((p) => { last = p; });
  slot('cur')({ done: 1, total: 2 });
  slot('prev')({ done: 1, total: 2 });
  slot('kds')({ done: 1, total: 5 });
  assert.deepEqual(last, { done: 3, total: 9 });
  slot('kds')({ done: 2, total: 5 });
  assert.deepEqual(last, { done: 4, total: 9 });
});

test('loadingText: plain until there is more than one page, then "Loading 3 of 9"', () => {
  assert.equal(loadingText(null), 'Loading…');
  assert.equal(loadingText({ done: 0, total: 1 }), 'Loading…');
  assert.equal(loadingText({ done: 2, total: 9 }), 'Loading 3 of 9');
  assert.equal(loadingText({ done: 9, total: 9 }), 'Loading 9 of 9');
});

// ── A PAGE THAT NEVER ANSWERS ────────────────────────────────────────────────
// The 3 slots are shared by every report in the tab. A request that hung (lid closed, wifi
// roamed) used to hold its slot for ever; three of them and no report loaded until a reload.
test('a page that never answers fails after the deadline, and is told to abort', async () => {
  let aborted = false;
  const build = () => ({ range: () => ({
    abortSignal(signal) { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); },
  }) });
  await assert.rejects(
    readAllPages('closed checks', build, { gate: null, pageTimeoutMs: 20 }),
    (err) => { assert.ok(isPageTimeout(err)); assert.match(err.message, /Could not read closed checks: no answer after/); return true; },
  );
  assert.equal(aborted, true);
  assert.equal(PAGE_TIMEOUT_MS, 30000);
});

test('hung pages give their slots back: the gate serves the next read', async () => {
  const gate = limiter(3);
  const hung = fakeTable(5000);
  const hangBuild = (first) => (first ? hung.build(first) : { range: () => new Promise(() => {}) });   // a client that ignores the abort
  const r = await readAllPagesResult('checks', hangBuild, { gate, pageTimeoutMs: 20 });
  assert.ok(isPageTimeout(r.error), 'the read fails, it does not spin');
  assert.equal(r.data, null);
  // all 3 slots were held by requests that will never settle; the next read still runs
  const rows = await readAllPages('checks', fakeTable(2300).build, { gate, pageTimeoutMs: 1000 });
  assert.equal(rows.length, 2300);
});

test('a page that answers in time is not touched by the deadline', async () => {
  const t = fakeTable(2500, { delay: 2 });
  const rows = await readAllPages('checks', t.build, { gate: limiter(3), pageTimeoutMs: 500 });
  assert.equal(rows.length, 2500);
});

// ── THE ROW BUDGET ───────────────────────────────────────────────────────────
// The ceiling protects the tab's memory, so reads that land on one screen share one.
test('budget: two reads each under their own ceiling, too many together, both stop', async () => {
  const budget = rowBudget(6000);
  const a = fakeTable(4000, { delay: 3 });
  const b = fakeTable(4000, { delay: 3 });
  const gate = limiter(3);
  const [ra, rb] = await Promise.all([
    readAllPagesResult('this period', a.build, { gate, budget }),
    readAllPagesResult('last period', b.build, { gate, budget }),
  ]);
  assert.equal(ra.tooMany, true);
  assert.equal(rb.tooMany, true);
  assert.equal(ra.data, null);
  assert.equal(rb.data, null);
  assert.ok(a.calls.length + b.calls.length < 8, `sent ${a.calls.length + b.calls.length} of 8 pages`);
});

test('budget: under it together, both read in full', async () => {
  const budget = rowBudget(6000);
  const [a, b] = await Promise.all([
    readAllPages('this period', fakeTable(3000).build, { gate: null, budget }),
    readAllPages('last period', fakeTable(3000).build, { gate: null, budget }),
  ]);
  assert.deepEqual([a.length, b.length], [3000, 3000]);
  assert.equal(budget.used, 6000);
  assert.equal(budget.over, false);
});

test('budget without a count: charged page by page, still stops', async () => {
  const budget = rowBudget(2500);
  const t = fakeTable(9000, { withCount: false });
  await assert.rejects(readAllPages('checks', t.build, { gate: null, budget }), isTooManyRows);
  assert.equal(t.calls.length, 3);
});

test('the ceilings fit the weight of the row', () => {
  assert.equal(CHECK_MAX_PAGES, 20);          // a check is about 3.1 KB: 20,000 is about 62 MB
  assert.equal(CHECK_ROWS_ON_SCREEN, 24000);  // this period + the previous one, or every venue
  assert.equal(TICKET_MAX_PAGES, 30);
  assert.ok(CHECK_ROWS_ON_SCREEN < 2 * CHECK_MAX_PAGES * PAGE, 'two full reads must not fit');
  assert.ok(TICKET_MAX_PAGES > CHECK_MAX_PAGES, 'tickets outnumber checks; Kitchen performance must not fail first');
});

test('faultText: the two plain lines', () => {
  assert.equal(faultText('too_long'), TOO_LONG_TEXT);
  assert.equal(faultText('failed'), LOAD_FAILED_TEXT);
  assert.doesNotMatch(TOO_LONG_TEXT + LOAD_FAILED_TEXT, /[\u2013\u2014]/);
});

// ── SOURCE PIN ────────────────────────────────────────────────────────────────
// No report loader may go back to one request with a .limit() above 1,000: the API answers
// 1,000 at most and the report would be short again with nothing on screen to say so.
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const fnBody = (src, name) => {
  const a = src.indexOf(`export const ${name} = `);
  assert.ok(a >= 0, `${name} not found`);
  const b = src.indexOf('\nexport ', a + 1);
  return src.slice(a, b < 0 ? undefined : b);
};
const bigLimits = (src) => [...src.matchAll(/\.limit\(\s*([\d_]+)\s*\)/g)]
  .map((m) => Number(m[1].replace(/_/g, ''))).filter((n) => n > PAGE);

test('pin: the shared report loaders read through the pager, with a unique order, and no .limit()', () => {
  const db = read('./db.js');
  for (const [name, col] of [['fetchClosedChecksRange', 'closed_at'], ['fetchKDSTicketsRange', 'sent_at']]) {
    const body = fnBody(db, name);
    assert.match(body, /readAllPagesResult\(/, `${name} must page`);
    assert.doesNotMatch(body, /\.limit\(/, `${name} must not cap the read`);
    assert.match(body, new RegExp(`\\.order\\('${col}'[^)]*\\)\\s*\\.order\\('id'`), `${name} orders ${col} then id`);
    assert.match(body, /count: 'exact'/, `${name} asks the first page for the count`);
  }
  const multi = fnBody(db, 'fetchClosedChecksMultiRange');
  assert.match(multi, /fetchClosedChecksRange\(/);
  assert.match(multi, /if \(r\.error\) \{ failed = true; throw r\.error; \}/, 'a venue that failed must fail the compare, not read as quiet');
  assert.match(multi, /const stop = \(\) => failed \|\| !!o\.stop\?\.\(\)/, 'and the other venues stop asking for pages');
  assert.match(multi, /rowBudget\(CHECK_ROWS_ON_SCREEN\)/, 'all the venues share one row budget');
  assert.doesNotMatch(multi, /\.limit\(/);
  // the heavy reads carry the lower ceilings
  assert.match(fnBody(db, 'fetchClosedChecksRange'), /maxPages: CHECK_MAX_PAGES, budget: o\.budget \|\| null/);
  assert.match(fnBody(db, 'fetchKDSTicketsRange'), /maxPages: TICKET_MAX_PAGES/);

  const stock = fnBody(read('./stock/data.js'), 'fetchMovementsRange');
  assert.match(stock, /readAllPagesResult\(/);
  assert.doesNotMatch(stock, /\.limit\(/);
});

test('pin: no report screen keeps a bare .limit above 1,000 or passes a row cap to the loaders', () => {
  const dir = new URL('../backoffice/sections/reports/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => /\.jsx?$/.test(f) && !f.includes('.test.'))
    .map((f) => `../backoffice/sections/reports/${f}`)
    .concat([
      '../backoffice/sections/BOReports.jsx', '../backoffice/sections/StockReports.jsx',
      '../backoffice/sections/Transactions.jsx', '../backoffice/sections/WaitlistInsights.jsx',
      '../backoffice/sections/PriceChanges.jsx', '../backoffice/sections/Challenge21Report.jsx',
    ]);
  assert.ok(files.length > 25, 'the reports folder was found');
  for (const f of files) {
    const src = read(f);
    assert.deepEqual(bigLimits(src), [], `${f} has a .limit above ${PAGE}`);
    // the old call shape: fetchClosedChecksRange(loc, from, to, 5000)
    assert.doesNotMatch(src, /fetch(ClosedChecksRange|KDSTicketsRange|ClosedChecksMultiRange|MovementsRange)\([^;]*,\s*\d{3,}\s*\)/, `${f} still passes a row cap`);
  }
});

test('pin: the reports shell loads this period AND the previous one in full, and shows the fault', () => {
  const shell = read('../backoffice/sections/BOReports.jsx');
  assert.match(shell, /fetchClosedChecksRange\(locId, range\.from,\s+range\.to,\s+\{ onProgress/);
  assert.match(shell, /fetchClosedChecksRange\(locId, range\.prevFrom, range\.prevTo, \{ onProgress/);
  assert.match(shell, /loadingText\(loadProgress\)/);
  assert.match(shell, /TOO_LONG_TEXT/);
  assert.match(shell, /return \(\) => \{ stale = true; \};/);
});

test('pin: the shell shares one row budget between this period and the previous one', () => {
  const shell = read('../backoffice/sections/BOReports.jsx');
  assert.match(shell, /const budget = rowBudget\(CHECK_ROWS_ON_SCREEN\)/);
  assert.match(shell, /slot\('cur'\),\s+stop, budget \}/);
  assert.match(shell, /slot\('prev'\), stop, budget \}/);
});

test('pin: the shell\'s comparison top up pages too, on the same budget, and a failed comparison is not a quiet one', () => {
  // 5 Oct 2026: the previous period is topped up as the clock moves on (the one percent rule).
  // That read asked for 5,000 rows in one request; it now pages and spends from the budget
  // the first load used, counting the rows already on screen.
  const shell = read('../backoffice/sections/BOReports.jsx');
  assert.match(shell, /budget\.used = \(rangeChecks \|\| \[\]\)\.length \+ \(need\.append \? \(prevChecks \|\| \[\]\)\.length : 0\);/);
  assert.match(shell, /fetchClosedChecksRange\(activeLocId, new Date\(need\.from\), new Date\(need\.to\), \{ stop: \(\) => seq !== prevSeq\.current, budget \}\)/);
  assert.match(shell, /if \(res\.tooMany\) \{\s+prevHeld\.current = null;\s+setLoadFault\('too_long'\);/);
  // too many rows on either period is the too long line; this period failing blanks the report;
  // the previous one failing alone leaves this period standing with "Comparison did not load".
  assert.match(shell, /const tooLong = cur\.tooMany \|\| prev\.tooMany;\s+if \(cur\.error \|\| tooLong\) \{/);
  assert.match(shell, /const prevOk = !prev\.error && Array\.isArray\(prev\.data\);\s+setPrevLoaded\(prevOk\);/);
  assert.match(shell, /compare \? \(prevLoaded \? compare : notLoaded\(compare\)\) : null/);
});

test('pin: Stock reports: each read has its own run number, load and fault', () => {
  const src = read('../backoffice/sections/StockReports.jsx');
  for (const name of ['moves', 'checks']) {
    assert.match(src, new RegExp(`const run = ${name}Run\\.current \\+= 1;`), `${name}: a run number per read`);
    assert.match(src, new RegExp(`const live = \\(\\) => run === ${name}Run\\.current;`));
  }
  assert.equal((src.match(/if \(!live\(\)\) return;/g) || []).length, 2, 'a read that is no longer the newest paints nothing');
  assert.equal((src.match(/stop: \(\) => !live\(\)/g) || []).length, 2, 'and stops asking for pages');
  assert.doesNotMatch(src, /setRangeLoad|setRangeFault/, 'no load or fault state shared by the two reads');
  assert.match(src, /tab === 'By supplier' \? checksLoad\s+: movesLoad/);
  assert.match(src, /tab === 'By supplier' \? checksFault : movesFault/);
});

test('pin: no report throws the pager\'s error away', () => {
  // A failed page or the ceiling must show as a line, never as an empty or part report.
  const cash = read('../backoffice/sections/reports/CashDrawer.jsx');
  assert.match(cash, /if \(sRes\.error\) throw sRes\.error;/);
  assert.match(cash, /if \(mRes\.error\) throw mRes\.error;/);
  assert.match(cash, /setFault\(isTooManyRows\(err\) \? 'too_long' : 'failed'\)/);
  assert.match(cash, /if \(fault\) \{\s+return <EmptyState icon="⚠" message=\{faultText\(fault\)\}\/>;/);

  const price = read('../backoffice/sections/PriceChanges.jsx');
  assert.match(price, /\{ data: hist, error: histErr, tooMany \}/);
  assert.match(price, /setFault\(tooMany \? 'too_long' : 'failed'\)/);
  assert.match(price, /rows != null && !fault && view\.length === 0/, 'a fault is not "no price movements"');

  const wait = read('../backoffice/sections/WaitlistInsights.jsx');
  assert.match(wait, /\[eRes, aRes\]\.find\(\(r\) => r\.error && !missing\(r\)\)/);
  assert.match(wait, /\{fault \? \(<div style=\{S\.empty\}>\{faultText\(fault\)\}<\/div>\)/);

  const bookings = read('./bookings/bookingsData.js');
  assert.match(bookings, /return \{ data: \[\], error, tooMany: !!tooMany \};/);
  const report = read('../backoffice/sections/reports/BookingsReport.jsx');
  assert.match(report, /if \(error\) setFault\(tooMany \? 'too_long' : 'failed'\)/);
  assert.match(report, /if \(fault\) \{\s+return <EmptyState icon="⚠" message=\{faultText\(fault\)\}\/>;/);

  // every screen that calls the pager directly looks at its error
  const dir = new URL('../backoffice/sections/', import.meta.url);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? walk(new URL(`${e.name}/`, d)) : (/\.jsx$/.test(e.name) ? [new URL(e.name, d)] : [])));
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    if (!/readAllPagesResult\(/.test(src)) continue;
    assert.doesNotMatch(src, /const \{ data: \w+ \} = await readAllPagesResult/, `${f.pathname} drops the error of a paged read`);
    assert.match(src, /\.error|error:/, `${f.pathname} never reads the error of a paged read`);
  }
});
