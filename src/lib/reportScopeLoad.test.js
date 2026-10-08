/**
 * reportScopeLoad.test.js — the one loader behind every Back Office report.
 * Run: `npm test`, or `node --test src/lib/reportScopeLoad.test.js`.
 *
 * Pinned:
 *   1. ONE SITE is asked exactly what the shell asked before the scope: this period, the
 *      previous period and the tickets, each over that site's window, on one row budget, and
 *      the rows come back the same (same objects, same order) with the site tagged on.
 *   2. The fault rule for one site is unchanged: this period failing or too many rows on
 *      EITHER period blanks the report; the previous period failing alone leaves this period
 *      up with the comparison marked not loaded; tickets failing only fault the tickets.
 *   3. SEVERAL SITES: each over ITS OWN window, rows tagged, newest first, one shared budget.
 *      One site failing fails the read (a missing site is never a quiet one).
 *   4. Several sites: the comparison not fitting leaves this period up (never a part total,
 *      never a retry loop).
 *   5. Progress adds up across sites: "Loading 3 of 9".
 *   6. Day sums: asked for this period and its comparison; "not installed" is not zeros.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScopeRows, loadScopeDaySums, tagRows } from './reportScopeLoad.js';
import { loadingText, TooManyRowsError, CHECK_ROWS_ON_SCREEN } from './pagedRead.js';

const D = (iso) => new Date(iso);
const site = (id, name, day0 = '2026-10-05T05:30:00Z') => ({
  id, name,
  from: D(day0), to: D('2026-10-06T05:29:59.999Z'),
  prevFrom: D('2026-09-28T05:30:00Z'), prevTo: D('2026-09-28T13:00:00Z'),
});
const check = (id, closedAt, total = 10) => ({ id, closedAt: Date.parse(closedAt), total, locationId: 'x' });

/** A fake fetchClosedChecksRange: rows by `${siteId}|${from ISO}`; records every call. */
function fakeChecks(table, calls = []) {
  return async (siteId, from, to, opts) => {
    calls.push({ siteId, from, to, opts });
    const hit = table[`${siteId}|${from.toISOString()}`];
    if (hit instanceof Error) return { data: null, error: hit, tooMany: hit.code === 'too_many_rows' };
    const rows = hit || [];
    if (opts?.budget) {
      opts.budget.used += rows.length;
      if (opts.budget.used > opts.budget.max) { opts.budget.over = true; const e = new TooManyRowsError('closed checks', opts.budget.used, opts.budget.max); return { data: null, error: e, tooMany: true }; }
    }
    opts?.onProgress?.({ done: 1, total: 1 });
    return { data: rows, error: null };
  };
}

test('one site: asked what the shell always asked, and the rows come back the same', async () => {
  const leeds = site('leeds', 'Leeds');
  const cur = [check('c2', '2026-10-05T12:00:00Z', 7.5), check('c1', '2026-10-05T09:00:00Z', 4.2)];
  const prev = [check('p1', '2026-09-28T09:00:00Z', 3)];
  const tickets = [{ id: 't1', sentAt: 5 }];
  const calls = [], kcalls = [];
  const before = JSON.parse(JSON.stringify(cur));
  const res = await loadScopeRows({
    sites: [leeds],
    fetchChecks: fakeChecks({ [`leeds|${leeds.from.toISOString()}`]: cur, [`leeds|${leeds.prevFrom.toISOString()}`]: prev }, calls),
    fetchTickets: async (id, from, to, opts) => { kcalls.push({ id, from, to, opts }); return { data: tickets, error: null }; },
  });
  // the two check reads and the ticket read, over the site's own instants
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => [c.siteId, c.from, c.to]), [['leeds', leeds.from, leeds.to], ['leeds', leeds.prevFrom, leeds.prevTo]]);
  assert.equal(calls[0].opts.budget, calls[1].opts.budget, 'one budget for both periods');
  assert.equal(calls[0].opts.budget.max, CHECK_ROWS_ON_SCREEN);
  assert.deepEqual([kcalls[0].id, kcalls[0].from, kcalls[0].to], ['leeds', leeds.from, leeds.to]);
  assert.equal(kcalls[0].opts.budget, undefined, 'tickets are not charged to the checks budget, as before');
  // the same rows, in the same order, the same objects: only the site tag is new
  assert.equal(res.fault, null); assert.equal(res.kdsFault, null); assert.equal(res.prevLoaded, true);
  assert.equal(res.checks.length, 2);
  assert.equal(res.checks[0], cur[0]); assert.equal(res.checks[1], cur[1]);
  res.checks.forEach((c, i) => {
    const { siteId, siteName, ...rest } = c;
    assert.deepEqual(rest, before[i]);
    assert.equal(siteId, 'leeds'); assert.equal(siteName, 'Leeds');
  });
  assert.equal(res.prevChecks[0], prev[0]);
  assert.equal(res.kdsTickets[0], tickets[0]);
  assert.deepEqual(res.prevHeld, { leeds: { from: leeds.prevFrom.getTime(), to: leeds.prevTo.getTime() } });
  // the figures a report adds up are untouched
  assert.equal(res.checks.reduce((s, c) => s + c.total, 0), 11.7);
});

test('one site: the fault rule is the one the shell had', async () => {
  const leeds = site('leeds', 'Leeds');
  const kCur = `leeds|${leeds.from.toISOString()}`, kPrev = `leeds|${leeds.prevFrom.toISOString()}`;
  const ok = async () => ({ data: [], error: null });
  // this period failed: nothing shows
  let r = await loadScopeRows({ sites: [leeds], fetchChecks: fakeChecks({ [kCur]: new Error('offline'), [kPrev]: [check('p', '2026-09-28T09:00:00Z')] }), fetchTickets: ok });
  assert.equal(r.fault, 'failed'); assert.deepEqual(r.checks, []); assert.deepEqual(r.prevChecks, []); assert.equal(r.prevLoaded, false);
  // too many rows on the PREVIOUS period alone: the too long line (never part of a pair)
  r = await loadScopeRows({ sites: [leeds], fetchChecks: fakeChecks({ [kCur]: [check('c', '2026-10-05T09:00:00Z')], [kPrev]: new TooManyRowsError('closed checks', 30000, 24000) }), fetchTickets: ok });
  assert.equal(r.fault, 'too_long'); assert.deepEqual(r.checks, []);
  // the shared budget tips over between the two periods: too long
  r = await loadScopeRows({ sites: [leeds], maxRows: 2, fetchChecks: fakeChecks({ [kCur]: [check('a', '2026-10-05T09:00:00Z'), check('b', '2026-10-05T10:00:00Z')], [kPrev]: [check('p', '2026-09-28T09:00:00Z')] }), fetchTickets: ok });
  assert.equal(r.fault, 'too_long');
  // the previous period failed ALONE: this period stands, the comparison is not loaded (not "New")
  r = await loadScopeRows({ sites: [leeds], fetchChecks: fakeChecks({ [kCur]: [check('c', '2026-10-05T09:00:00Z')], [kPrev]: new Error('page 3 timed out') }), fetchTickets: ok });
  assert.equal(r.fault, null); assert.equal(r.checks.length, 1); assert.equal(r.prevLoaded, false); assert.deepEqual(r.prevChecks, []);
  assert.deepEqual(r.prevHeld, {}); assert.equal(r.prevSkipped, 'failed');
  // tickets failing only fault the tickets
  r = await loadScopeRows({ sites: [leeds], fetchChecks: fakeChecks({ [kCur]: [check('c', '2026-10-05T09:00:00Z')] }), fetchTickets: async () => ({ data: null, error: new Error('x'), tooMany: true }) });
  assert.equal(r.fault, null); assert.equal(r.kdsFault, 'too_long'); assert.deepEqual(r.kdsTickets, []); assert.equal(r.checks.length, 1);
});

// 6 Oct 2026 (review): the checks blanking the read blank the tickets WITH the same fault.
// Kitchen performance looked at kdsFault alone, so "too long" on the checks showed as an
// empty kitchen ("No KDS tickets at these sites") instead of the too long line.
test('the checks too long or failed: the kitchen tickets carry the same fault, never an empty list', async () => {
  const hudds = site('hudds', 'Huddersfield'), leeds = site('leeds', 'Leeds');
  const tickets = async () => ({ data: [{ id: 't', sentAt: 1 }], error: null });
  // several sites, this period over the budget
  let r = await loadScopeRows({
    sites: [hudds, leeds], maxRows: 1, fetchTickets: tickets,
    fetchChecks: fakeChecks({ [`hudds|${hudds.from.toISOString()}`]: [check('a', '2026-10-05T09:00:00Z')], [`leeds|${leeds.from.toISOString()}`]: [check('b', '2026-10-05T09:00:00Z')] }),
  });
  assert.equal(r.fault, 'too_long'); assert.equal(r.kdsFault, 'too_long'); assert.deepEqual(r.kdsTickets, []);
  // one site, this period failed
  r = await loadScopeRows({ sites: [leeds], fetchTickets: tickets, fetchChecks: fakeChecks({ [`leeds|${leeds.from.toISOString()}`]: new Error('offline') }) });
  assert.equal(r.fault, 'failed'); assert.equal(r.kdsFault, 'failed'); assert.deepEqual(r.kdsTickets, []);
  // and the shell shows it for Kitchen performance: kdsFault first, then the checks' fault
  const fs = await import('node:fs');
  const shell = fs.readFileSync(new URL('../backoffice/sections/BOReports.jsx', import.meta.url), 'utf8');
  assert.match(shell, /if \(view === 'kds_perf'\) return kdsFault \|\| loadFault \|\| null;/);
});

test('several sites: each over its OWN window, tagged, newest first, one budget', async () => {
  const hudds = site('hudds', 'Huddersfield');
  const station = { ...site('station', 'Barnsley Train Station', '2026-10-04T23:00:00Z'), to: D('2026-10-05T22:59:59.999Z') };
  const calls = [];
  const res = await loadScopeRows({
    sites: [hudds, station],
    fetchChecks: fakeChecks({
      [`hudds|${hudds.from.toISOString()}`]: [check('h2', '2026-10-05T15:00:00Z', 5), check('h1', '2026-10-05T08:00:00Z', 5)],
      [`station|${station.from.toISOString()}`]: [check('s2', '2026-10-05T16:00:00Z', 3), check('s1', '2026-10-04T23:30:00Z', 3)],
      [`hudds|${hudds.prevFrom.toISOString()}`]: [check('hp', '2026-09-28T08:00:00Z', 9)],
    }, calls),
    fetchTickets: async (id) => ({ data: [{ id: `k-${id}`, sentAt: id === 'hudds' ? 2 : 9 }], error: null }),
  });
  const cur = calls.filter((c) => c.from.getTime() >= Date.parse('2026-10-01'));
  assert.deepEqual(cur.map((c) => [c.siteId, c.from.toISOString(), c.to.toISOString()]), [
    ['hudds', '2026-10-05T05:30:00.000Z', '2026-10-06T05:29:59.999Z'],
    ['station', '2026-10-04T23:00:00.000Z', '2026-10-05T22:59:59.999Z'],
  ]);
  assert.equal(new Set(calls.map((c) => c.opts.budget)).size, 1, 'every read spends from one budget');
  assert.deepEqual(res.checks.map((c) => [c.id, c.siteId, c.siteName]), [
    ['s2', 'station', 'Barnsley Train Station'], ['h2', 'hudds', 'Huddersfield'], ['h1', 'hudds', 'Huddersfield'], ['s1', 'station', 'Barnsley Train Station'],
  ]);
  assert.deepEqual(res.prevChecks.map((c) => [c.id, c.siteId]), [['hp', 'hudds']]);
  assert.equal(res.prevLoaded, true);
  assert.deepEqual(Object.keys(res.prevHeld).sort(), ['hudds', 'station']);
  assert.deepEqual(res.kdsTickets.map((t) => [t.id, t.siteId]), [['k-station', 'station'], ['k-hudds', 'hudds']]);
  // the comparison is asked only after this period is in
  assert.ok(calls.findIndex((c) => c.from.getTime() < Date.parse('2026-10-01')) >= 2);
});

test('several sites: one site failing fails the read, and the comparison is not asked for', async () => {
  const a = site('a', 'A'), b = site('b', 'B');
  const calls = [];
  const r = await loadScopeRows({
    sites: [a, b], wantTickets: false,
    fetchChecks: fakeChecks({ [`a|${a.from.toISOString()}`]: [check('a1', '2026-10-05T09:00:00Z')], [`b|${b.from.toISOString()}`]: new Error('offline') }, calls),
  });
  assert.equal(r.fault, 'failed');
  assert.deepEqual(r.checks, [], 'never the sites that did load under the label of all of them');
  assert.equal(calls.length, 2, 'no previous period read');
  assert.equal(calls[0].opts.stop(), true, 'the other sites stop asking for pages');
});

test('several sites: too many rows this period is the too long line; the comparison not fitting is not', async () => {
  const a = site('a', 'A'), b = site('b', 'B');
  const rows = (p, n, iso) => Array.from({ length: n }, (_, i) => check(`${p}${i}`, iso));
  let r = await loadScopeRows({
    sites: [a, b], wantTickets: false, maxRows: 3,
    fetchChecks: fakeChecks({ [`a|${a.from.toISOString()}`]: rows('a', 2, '2026-10-05T09:00:00Z'), [`b|${b.from.toISOString()}`]: rows('b', 2, '2026-10-05T09:00:00Z') }),
  });
  assert.equal(r.fault, 'too_long'); assert.deepEqual(r.checks, []);
  r = await loadScopeRows({
    sites: [a, b], wantTickets: false, maxRows: 5,
    fetchChecks: fakeChecks({
      [`a|${a.from.toISOString()}`]: rows('a', 2, '2026-10-05T09:00:00Z'), [`b|${b.from.toISOString()}`]: rows('b', 2, '2026-10-05T09:00:00Z'),
      [`a|${a.prevFrom.toISOString()}`]: rows('pa', 2, '2026-09-28T09:00:00Z'),
    }),
  });
  assert.equal(r.fault, null);
  assert.equal(r.checks.length, 4, 'this period is whole');
  assert.equal(r.prevLoaded, false); assert.equal(r.prevSkipped, 'too_long');
  assert.deepEqual(r.prevChecks, [], 'never half a comparison');
});

test('progress adds up across sites and periods', async () => {
  const a = site('a', 'A'), b = site('b', 'B');
  const seen = [];
  const fetchChecks = async (id, from, to, opts) => { opts.onProgress({ done: 1, total: 3 }); opts.onProgress({ done: 3, total: 3 }); return { data: [], error: null }; };
  await loadScopeRows({ sites: [a, b], fetchChecks, wantTickets: false, wantPrev: false, onProgress: (p) => seen.push({ ...p }) });
  assert.deepEqual(seen[seen.length - 1], { done: 6, total: 6 });
  assert.ok(seen.some((p) => p.total === 6 && p.done < 6));
  assert.equal(loadingText({ done: 2, total: 9 }), 'Loading 3 of 9');
});

test('no sites: nothing asked, nothing to compare', async () => {
  let asked = 0;
  const r = await loadScopeRows({ sites: [], fetchChecks: async () => { asked += 1; return { data: [], error: null }; } });
  assert.equal(asked, 0); assert.deepEqual(r.checks, []); assert.equal(r.fault, null);
});

test('tagRows keeps every field and the location id', () => {
  const row = { id: 1, locationId: 'ops-1', total: 4 };
  assert.equal(tagRows([row], { id: 's', name: 'S' })[0], row);
  assert.deepEqual(row, { id: 1, locationId: 'ops-1', total: 4, siteId: 's', siteName: 'S' });
  assert.deepEqual(tagRows(null, { id: 's', name: 'S' }), []);
});

test('day sums: this period and its comparison; "not installed" is never zeros', async () => {
  const sites = [{ id: 'a', clockKnown: true }, { id: 'b', clockKnown: true }];
  const range = { fromDay: '2026-09-06', toDay: '2026-10-05', compare: { fromDay: '2026-08-07', toDay: '2026-09-05', cut: true } };
  const asked = [];
  const load = async (a) => { asked.push([a.fromDay, a.toDay, a.sites.length]); return { available: true, sites: [], total: null }; };
  const ok = await loadScopeDaySums({ load, client: {}, sites, range });
  assert.equal(ok.available, true);
  assert.deepEqual(asked, [['2026-09-06', '2026-10-05', 2], ['2026-08-07', '2026-09-05', 2]]);
  assert.equal(ok.compareCut, true, 'whole days cannot be cut at 2pm: the report is told');
  const missing = await loadScopeDaySums({ load: async () => ({ available: false, reason: 'not_installed', rows: [] }), client: {}, sites, range });
  assert.deepEqual([missing.available, missing.reason, missing.current], [false, 'not_installed', null]);
  // a site whose clock is a guess is refused before anything is asked
  let calls = 0;
  const guess = await loadScopeDaySums({ load: async () => { calls += 1; return { available: true }; }, client: {}, sites: [{ id: 'a', clockKnown: false }], range });
  assert.equal(guess.available, false); assert.equal(guess.reason, 'no_clock'); assert.equal(calls, 0);
  // the comparison failing leaves this period's sums standing, with no previous
  let n = 0;
  const half = await loadScopeDaySums({ load: async () => (n++ === 0 ? { available: true } : { available: false, reason: 'error' }), client: {}, sites, range });
  assert.equal(half.available, true); assert.equal(half.previous, null);
});
