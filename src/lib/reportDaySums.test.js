// Server day sums for the Back Office reports (src/lib/reportDaySums.js, 5 Oct 2026).
// The rules under test: "not available" before Peter runs the SQL (so the caller falls back),
// all or nothing across calls, every site on its own clock, currencies never added together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_SUMS_RPC, DAY_SUMS_MAX_ROWS, DAY_SUMS_MAX_SITES, TENDER_KEYS,
  normaliseDayStart, daySumsClocks, planDaySumCalls, daySumsFailure, fetchReportDaySums,
  daySumRow, addDaySums, daySumDays, shapeDaySums, loadReportDaySums,
} from './reportDaySums.js';
import { computeSalesStats } from './salesStats.js';
import { normaliseCheckStatus } from './voidRules.js';
import { readFileSync } from 'node:fs';

const LEEDS = { id: '1e252e7c-c875-4971-b91d-1e945c26956b', name: 'Coffee Boy Leeds', timezone: 'Europe/London', businessDayStart: '06:30', currency: 'GBP' };
const STATION = { id: '3f915972-7107-4f70-9b3d-de80ba9ab0c2', name: 'Barnsley Train Station', timezone: 'Europe/London', businessDayStart: '00:00', currency: 'GBP' };
const CABIN = { id: '5e870949-add5-42e7-924b-8018e212b91a', name: 'The Cabin', timezone: 'America/New_York', businessDayStart: '06:00', currency: 'USD' };

// One row as the database answers it (numbers as PostgREST sends them).
const dbRow = (site, day, over = {}) => ({
  location_id: site.id, business_day: day, currency: site.currency, timezone: site.timezone,
  day_start: site.businessDayStart, stored_timezone: site.timezone,
  checks: 10, voided_checks: 1, covers: 12, gross: 100, discounts: 5, voids: 0, refunds: 3, refunds_items: 2,
  refunds_tip: 1, refunds_service: 0, refunds_tax: 0.5, net_sales: 93, tax: 15.5, service: 0, tips: 4,
  delivery_fees: 0, total: 99,
  by_tender: { card: 80, cash: 19, gift_card: 0, loyalty: 0, other: 0 },
  by_method: { card: { checks: 8, revenue: 80, tips: 4 }, cash: { checks: 2, revenue: 19, tips: 0 } },
  by_order_type: { 'dine-in': { checks: 7, revenue: 70 }, takeaway: { checks: 3, revenue: 29 } },
  by_source: { pos: { checks: 10, revenue: 99 } },
  refunds_made: 3, refunds_made_tip: 1, refunds_made_service: 0, refunds_made_tax: 0.5, refunds_made_count: 1,
  ...over,
});

// A stand in for the Supabase client: records every call, answers from `reply`.
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return reply(args, calls.length); },
  };
}

// ── the clock ────────────────────────────────────────────────────────────────

test('a day start is HH:MM; anything else is no day start, never a default', () => {
  assert.equal(normaliseDayStart('06:30'), '06:30');
  assert.equal(normaliseDayStart('6:30'), '06:30');
  assert.equal(normaliseDayStart('06:30:00'), '06:30');
  assert.equal(normaliseDayStart('00:00'), '00:00');
  for (const bad of ['', null, undefined, '24:00', '06:60', 'six', '0630', 630]) assert.equal(normaliseDayStart(bad), null, String(bad));
});

test('each site is sent with its own clock, keyed by its Ops id', () => {
  const { ids, clocks, problems } = daySumsClocks([LEEDS, STATION, CABIN]);
  assert.deepEqual(problems, []);
  assert.deepEqual(ids, [LEEDS.id, STATION.id, CABIN.id]);
  assert.deepEqual(clocks[LEEDS.id], { tz: 'Europe/London', day_start: '06:30' });
  assert.deepEqual(clocks[STATION.id], { tz: 'Europe/London', day_start: '00:00' });
  assert.deepEqual(clocks[CABIN.id], { tz: 'America/New_York', day_start: '06:00' });
});

test('a site with no clock is a problem, never London 06:00 by default', () => {
  const noZone = daySumsClocks([{ id: 'a', businessDayStart: '06:00' }]);
  assert.equal(noZone.ids.length, 0);
  assert.match(noZone.problems[0], /time zone/);
  const noStart = daySumsClocks([{ id: 'a', name: 'Preston', timezone: 'Europe/London' }]);
  assert.match(noStart.problems[0], /business day start for site Preston/);
  assert.match(daySumsClocks([{ id: 'a', timezone: 'Mars/Olympus', businessDayStart: '06:00' }]).problems[0], /time zone/);
  assert.match(daySumsClocks([{ id: 'a', timezone: 'GMT+1', businessDayStart: '06:00' }]).problems[0], /time zone/);
  assert.match(daySumsClocks([{ timezone: 'Europe/London', businessDayStart: '06:00' }]).problems[0], /no id/);
  assert.match(daySumsClocks([{ id: 'loc-demo', timezone: 'Europe/London', businessDayStart: '06:00' }]).problems[0], /no id/);
});

test('a site listed twice is asked once', () => {
  assert.deepEqual(daySumsClocks([LEEDS, LEEDS]).ids, [LEEDS.id]);
});

// ── the calls ────────────────────────────────────────────────────────────────

test('6 sites for 90 days is one call; 13 sites is two, each under the 1,000 row cap', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(planDaySumCalls(six, '2026-07-08', '2026-10-05'), [{ ids: six, from: '2026-07-08', to: '2026-10-05' }]);
  const thirteen = Array.from({ length: 13 }, (_, i) => `s${i}`);
  const calls = planDaySumCalls(thirteen, '2026-07-08', '2026-10-05');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].from, '2026-07-08');
  assert.equal(calls[1].to, '2026-10-05');
  // No day asked twice and none missed.
  assert.equal(Date.parse(calls[1].from) - Date.parse(calls[0].to), 86400000);
  for (const c of calls) {
    const days = (Date.parse(c.to) - Date.parse(c.from)) / 86400000 + 1;
    assert.ok(days * c.ids.length < DAY_SUMS_MAX_ROWS);
  }
});

test('more sites than one call may carry are split, and a bad range plans nothing', () => {
  const many = Array.from({ length: DAY_SUMS_MAX_SITES + 20 }, (_, i) => `s${i}`);
  const calls = planDaySumCalls(many, '2026-10-01', '2026-10-02');
  assert.ok(calls.every((c) => c.ids.length <= DAY_SUMS_MAX_SITES));
  assert.deepEqual([...new Set(calls.flatMap((c) => c.ids))].length, many.length);
  assert.deepEqual(planDaySumCalls(['a'], '2026-10-05', '2026-10-01'), []);
  assert.deepEqual(planDaySumCalls(['a'], 'yesterday', '2026-10-01'), []);
  assert.deepEqual(planDaySumCalls([], '2026-10-01', '2026-10-05'), []);
});

test('a long range for one site stays inside the function\'s 400 day limit', () => {
  const calls = planDaySumCalls(['a'], '2025-01-01', '2026-10-05');
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.ok((Date.parse(c.to) - Date.parse(c.from)) / 86400000 <= 400);
  assert.equal(calls.at(-1).to, '2026-10-05');
});

// ── before the SQL has run, and other refusals ───────────────────────────────

test('the function not being there is "not installed", whichever way the database says it', () => {
  assert.equal(daySumsFailure({ code: 'PGRST202', message: 'Could not find the function public.report_day_sums(p_clocks, p_from, p_location_ids, p_to) in the schema cache' }, 404), 'not_installed');
  assert.equal(daySumsFailure({ code: '42883', message: 'function public.report_day_sums(text[], date, date, jsonb) does not exist' }, 404), 'not_installed');
  assert.equal(daySumsFailure({ message: 'Could not find the function public.report_day_sums' }, 400), 'not_installed');
  assert.equal(daySumsFailure({ message: 'Not Found' }, 404), 'not_installed');
});

test('a paired till is refused, a bad clock is a bad request, the rest is an error', () => {
  assert.equal(daySumsFailure({ code: '42501', message: 'Reports need a Back Office sign in.' }, 403), 'refused');
  assert.equal(daySumsFailure({ code: '42501', message: 'permission denied for function report_day_sums' }, 401), 'refused');
  assert.equal(daySumsFailure({ code: '22023', message: 'report_day_sums: no usable time zone for site x.' }, 400), 'bad_request');
  assert.equal(daySumsFailure({ code: '57014', message: 'canceling statement due to statement timeout' }, 500), 'error');
  assert.equal(daySumsFailure({ message: 'Failed to fetch' }, 0), 'error');
  assert.equal(daySumsFailure(null, 500), 'error');
});

test('before Peter runs the SQL the answer is "not available", so the caller falls back', async () => {
  const client = fakeClient(() => ({ data: null, status: 404, error: { code: 'PGRST202', message: 'Could not find the function public.report_day_sums in the schema cache' } }));
  const res = await loadReportDaySums({ client, sites: [LEEDS], fromDay: '2026-10-01', toDay: '2026-10-05' });
  assert.equal(res.available, false);
  assert.equal(res.reason, 'not_installed');
  assert.deepEqual(res.rows, []);
  assert.equal(res.total, undefined);   // no totals of any kind to mistake for zero sales
});

test('no client, no dates or a site with no clock never reaches the database', async () => {
  assert.equal((await fetchReportDaySums({ sites: [LEEDS], fromDay: '2026-10-01', toDay: '2026-10-05' })).reason, 'no_client');
  const client = fakeClient(() => ({ data: [], error: null }));
  assert.equal((await fetchReportDaySums({ client, sites: [LEEDS], fromDay: '', toDay: '2026-10-05' })).reason, 'bad_request');
  assert.equal((await fetchReportDaySums({ client, sites: [LEEDS], fromDay: '2026-10-05', toDay: '2026-10-01' })).reason, 'bad_request');
  const res = await fetchReportDaySums({ client, sites: [LEEDS, { id: 'x', name: 'New site' }], fromDay: '2026-10-01', toDay: '2026-10-05' });
  assert.equal(res.available, false);
  assert.equal(res.reason, 'bad_request');
  assert.match(res.message, /New site/);
  assert.equal(client.calls.length, 0);
});

test('no sites is an empty answer, not a failure, and asks nothing', async () => {
  const client = fakeClient(() => ({ data: [], error: null }));
  const res = await fetchReportDaySums({ client, sites: [], fromDay: '2026-10-01', toDay: '2026-10-05' });
  assert.deepEqual(res, { available: true, rows: [], calls: 0 });
  assert.equal(client.calls.length, 0);
});

// ── asking ───────────────────────────────────────────────────────────────────

test('the call carries Ops ids, business dates and each site\'s own clock', async () => {
  const client = fakeClient(() => ({ data: [dbRow(LEEDS, '2026-10-01')], error: null, status: 200 }));
  const res = await fetchReportDaySums({ client, sites: [LEEDS, STATION], fromDay: '2026-10-01', toDay: '2026-10-05' });
  assert.equal(res.available, true);
  assert.equal(res.calls, 1);
  assert.equal(client.calls[0].name, DAY_SUMS_RPC);
  assert.deepEqual(client.calls[0].args, {
    p_location_ids: [LEEDS.id, STATION.id], p_from: '2026-10-01', p_to: '2026-10-05',
    p_clocks: { [LEEDS.id]: { tz: 'Europe/London', day_start: '06:30' }, [STATION.id]: { tz: 'Europe/London', day_start: '00:00' } },
  });
  assert.equal(res.rows[0].stats.net, 93);
});

test('all or nothing: one failed call of several makes the whole answer not available', async () => {
  const sites = Array.from({ length: 13 }, (_, i) => ({ ...LEEDS, id: `site-${i}`, name: `Site ${i}` }));
  const client = fakeClient((args, n) => (n === 2
    ? { data: null, status: 500, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    : { data: [dbRow({ ...LEEDS, id: 'site-0' }, args.p_from)], error: null, status: 200 }));
  const res = await fetchReportDaySums({ client, sites, fromDay: '2026-07-08', toDay: '2026-10-05', concurrency: 1 });
  assert.equal(client.calls.length, 2);
  assert.equal(res.available, false);
  assert.equal(res.reason, 'error');
  assert.deepEqual(res.rows, []);
});

test('several calls are joined into one answer', async () => {
  const sites = Array.from({ length: 13 }, (_, i) => ({ ...LEEDS, id: `site-${i}`, name: `Site ${i}` }));
  const client = fakeClient((args) => ({ data: [dbRow({ ...LEEDS, id: 'site-0' }, args.p_from), dbRow({ ...LEEDS, id: 'site-1' }, args.p_to)], error: null, status: 200 }));
  const res = await loadReportDaySums({ client, sites, fromDay: '2026-07-08', toDay: '2026-10-05' });
  assert.equal(res.available, true);
  assert.equal(res.calls, 2);
  assert.equal(res.rows.length, 4);
  assert.equal(res.total.totals.stats.net, 4 * 93);
});

test('a full page from the database is treated as cut short, never shown as a total', async () => {
  const client = fakeClient(() => ({ data: Array.from({ length: DAY_SUMS_MAX_ROWS }, () => dbRow(LEEDS, '2026-10-01')), error: null, status: 200 }));
  const res = await fetchReportDaySums({ client, sites: [LEEDS], fromDay: '2026-10-01', toDay: '2026-10-05' });
  assert.equal(res.available, false);
  assert.equal(res.reason, 'capped');
});

test('a network failure or an answer that is not a list is an error, never zeros', async () => {
  const thrown = await fetchReportDaySums({ client: { rpc: async () => { throw new Error('Failed to fetch'); } }, sites: [LEEDS], fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.deepEqual([thrown.available, thrown.reason, thrown.message], [false, 'error', 'Failed to fetch']);
  const odd = await fetchReportDaySums({ client: fakeClient(() => ({ data: null, error: null })), sites: [LEEDS], fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.deepEqual([odd.available, odd.reason], [false, 'error']);
});

// ── one row ──────────────────────────────────────────────────────────────────

test('a row is read into the Business summary\'s own shape', () => {
  const r = daySumRow(dbRow(LEEDS, '2026-10-01'));
  assert.equal(r.locationId, LEEDS.id);
  assert.equal(r.day, '2026-10-01');
  assert.equal(r.currency, 'GBP');
  assert.deepEqual(r.stats, {
    gross: 100, discounts: 5, voids: 0, refunds: 3, refundsItems: 2, refundsTip: 1, refundsService: 0, refundsTax: 0.5,
    service: 0, tips: 4, deliveryFees: 0, tax: 15.5, total: 99, covers: 12, count: 10, net: 93,
  });
  // Every figure is one computeSalesStats also gives, so Sales summary can draw from either.
  const report = computeSalesStats([]);
  for (const k of Object.keys(r.stats)) assert.ok(k in report, `${k} is not a Business summary figure`);
  assert.deepEqual(r.refundsMade, { amount: 3, tip: 1, service: 0, tax: 0.5, count: 1 });
  assert.deepEqual(Object.keys(r.byTender), TENDER_KEYS);
  assert.deepEqual(r.byMethod.card, { checks: 8, revenue: 80, tips: 4 });
  assert.deepEqual(r.byOrderType.takeaway, { checks: 3, revenue: 29 });
});

test('numbers sent as text, a timestamp for the day and missing parts all read safely', () => {
  const r = daySumRow({ location_id: 'a', business_day: '2026-10-01T00:00:00', gross: '12.50', checks: '3', net_sales: null, by_tender: null, by_method: 'x', currency: 'gbp' });
  assert.equal(r.day, '2026-10-01');
  assert.equal(r.currency, 'GBP');
  assert.equal(r.stats.gross, 12.5);
  assert.equal(r.stats.count, 3);
  assert.equal(r.stats.net, 0);
  assert.deepEqual(r.byTender, { card: 0, cash: 0, gift_card: 0, loyalty: 0, other: 0 });
  assert.deepEqual(r.byMethod, {});
  assert.equal(daySumRow(null).locationId, '');
});

// ── adding up ────────────────────────────────────────────────────────────────

test('every day of the range is listed, in order', () => {
  assert.deepEqual(daySumDays('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(daySumDays('2026-10-02', '2026-09-29'), []);
  assert.deepEqual(daySumDays('x', '2026-09-29'), []);
});

test('rows add up key by key, mixes included', () => {
  const sum = addDaySums(addDaySums({ stats: daySumRow({}).stats, voidedChecks: 0, byTender: daySumRow({}).byTender, byMethod: {}, byOrderType: {}, bySource: {}, refundsMade: daySumRow({}).refundsMade },
    daySumRow(dbRow(LEEDS, '2026-10-01'))), daySumRow(dbRow(LEEDS, '2026-10-02', { by_method: { cash: { checks: 1, revenue: 5, tips: 0 }, split: { checks: 1, revenue: 9, tips: 1 } } })));
  assert.equal(sum.stats.net, 186);
  assert.equal(sum.stats.count, 20);
  assert.equal(sum.voidedChecks, 2);
  assert.equal(sum.byTender.card, 160);
  assert.deepEqual(sum.byMethod.cash, { checks: 3, revenue: 24, tips: 0 });
  assert.deepEqual(sum.byMethod.split, { checks: 1, revenue: 9, tips: 1 });
  assert.deepEqual(sum.byMethod.card, { checks: 8, revenue: 80, tips: 4 });
  assert.equal(sum.refundsMade.count, 2);
});

test('one group total when every site shares a currency, with a row per site under it', () => {
  const rows = [dbRow(LEEDS, '2026-10-01'), dbRow(LEEDS, '2026-10-02', { net_sales: 7, checks: 1 }), dbRow(STATION, '2026-10-02', { net_sales: 50, checks: 4 })].map(daySumRow);
  const out = shapeDaySums(rows, [LEEDS, STATION], { fromDay: '2026-10-01', toDay: '2026-10-03' });
  assert.equal(out.singleCurrency, 'GBP');
  assert.equal(out.total.totals.stats.net, 150);
  assert.deepEqual(out.sites.map((s) => [s.name, s.totals.stats.net, s.hasRows]), [['Coffee Boy Leeds', 100, true], ['Barnsley Train Station', 50, true]]);
  // The whole axis, zeros where nothing sold.
  assert.deepEqual(out.days, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(out.total.days.map((d) => d.stats.net), [93, 57, 0]);
  assert.deepEqual(out.sites[1].days.map((d) => d.stats.count), [0, 4, 0]);
  assert.deepEqual(out.warnings, []);
});

test('pounds and dollars are never added together: one total each, no combined total', () => {
  const rows = [dbRow(LEEDS, '2026-10-01'), dbRow(CABIN, '2026-10-01', { net_sales: 1000 })].map(daySumRow);
  const out = shapeDaySums(rows, [LEEDS, CABIN], { fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(out.singleCurrency, null);
  assert.equal(out.total, null);
  assert.deepEqual(out.currencies.map((c) => [c.currency, c.siteIds, c.totals.stats.net]), [['GBP', [LEEDS.id], 93], ['USD', [CABIN.id], 1000]]);
});

test('a site with no sales, or one this login may not read, is there with zeros and says so', () => {
  const out = shapeDaySums([dbRow(LEEDS, '2026-10-01')].map(daySumRow), [LEEDS, STATION], { fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(out.sites[1].hasRows, false);
  assert.equal(out.sites[1].totals.stats.net, 0);
  assert.equal(out.total.totals.stats.net, 93);
});

test('a row for a site nobody asked for is never counted', () => {
  const out = shapeDaySums([dbRow(LEEDS, '2026-10-01'), dbRow(CABIN, '2026-10-01')].map(daySumRow), [LEEDS], { fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(out.sites.length, 1);
  assert.equal(out.total.totals.stats.net, 93);
});

test('a site whose currency nobody knows stands alone, and the answer says why', () => {
  const noCur = { ...STATION, currency: undefined };
  const rows = [dbRow(LEEDS, '2026-10-01'), dbRow(noCur, '2026-10-01', { currency: null, net_sales: 40 })].map(daySumRow);
  const out = shapeDaySums(rows, [LEEDS, noCur], { fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(out.total, null);
  assert.equal(out.currencies.length, 2);
  assert.equal(out.currencies[1].currency, null);
  assert.equal(out.currencies[1].totals.stats.net, 40);
  assert.match(out.warnings[0], /no currency on record/);
});

test('a site with no sales and no known currency blocks no total', () => {
  const quiet = { ...STATION, currency: undefined };
  const out = shapeDaySums([dbRow(LEEDS, '2026-10-01')].map(daySumRow), [LEEDS, quiet], { fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(out.singleCurrency, 'GBP');
  assert.equal(out.total.totals.stats.net, 93);
  assert.deepEqual(out.currencies.map((c) => c.siteIds), [[LEEDS.id]]);
  assert.equal(out.sites.length, 2);
  assert.deepEqual(out.warnings, []);
});

test('the currency comes from the database row when the caller has none', () => {
  const out = shapeDaySums([dbRow(LEEDS, '2026-10-01')].map(daySumRow), [{ ...LEEDS, currency: undefined }], { fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(out.singleCurrency, 'GBP');
});

test('the two databases disagreeing on a zone or a currency is said once per site', () => {
  const rows = [dbRow(LEEDS, '2026-10-01', { stored_timezone: 'America/New_York', currency: 'USD' }), dbRow(LEEDS, '2026-10-02', { stored_timezone: 'America/New_York', currency: 'USD' })].map(daySumRow);
  const out = shapeDaySums(rows, [LEEDS], { fromDay: '2026-10-01', toDay: '2026-10-02' });
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings.join(' '), /time zone \(Europe\/London and America\/New_York\)/);
  assert.match(out.warnings.join(' '), /currency \(GBP and USD\)/);
  // The caller's currency wins: it is the one the rest of the Back Office shows.
  assert.equal(out.singleCurrency, 'GBP');
});

test('loadReportDaySums gives the shaped answer when the function is there', async () => {
  const client = fakeClient(() => ({ data: [dbRow(LEEDS, '2026-10-01'), dbRow(STATION, '2026-10-01')], error: null, status: 200 }));
  const res = await loadReportDaySums({ client, sites: [LEEDS, STATION], fromDay: '2026-10-01', toDay: '2026-10-01' });
  assert.equal(res.available, true);
  assert.equal(res.total.currency, 'GBP');
  assert.equal(res.total.totals.stats.net, 186);
  assert.equal(res.total.totals.byTender.card, 160);
  assert.equal(res.sites.length, 2);
});

// 5 Oct 2026 (review of 20261005b): closed_checks.status may be empty. In SQL "empty in
// ('void', 'voided')" is neither yes nor no, so a check with no status counted as neither a
// sale nor a void (0 checks, 0 covers, its refunds dropped) while its money still summed. The
// reports count it as a sale. SQL cannot run in node, so this pins both halves of the rule:
// what the browser does, and that the function's void test can never be "unknown".
test('a check with no status is a sale in the reports, and the SQL void test is never unknown', () => {
  const rows = [
    { subtotal: 10, total: 10, covers: 2, status: normaliseCheckStatus(null, false) },
    { subtotal: 5, total: 5, covers: 1, status: normaliseCheckStatus(null, null) },
    { subtotal: 7, total: 7, covers: 1, status: normaliseCheckStatus(null, true) },
    { subtotal: 3, total: 3, covers: 1, status: normaliseCheckStatus('void', null) },
  ];
  const s = computeSalesStats(rows);
  assert.equal(s.count, 2);
  assert.equal(s.covers, 3);
  assert.equal(s.voids, 10);

  const sql = readFileSync(new URL('../../supabase/migrations/20261005b_OPS_report_day_sums.sql', import.meta.url), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const tests = sql.match(/c\.voided is true or .*?'voided'\)/g) || [];
  assert.equal(tests.length, 2, 'the sales of the day and the refunds made both test for a void');
  for (const t of tests) assert.equal(t, "c.voided is true or coalesce(c.status, '') in ('void', 'voided')");
  assert.equal(/[^(]c\.status in \(/.test(sql), false, 'no void test on a bare, possibly empty, status');
});
