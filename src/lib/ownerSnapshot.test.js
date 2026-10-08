/**
 * ownerSnapshot.test.js: the Owner app's numbers, built end to end (owner-snapshot).
 * Run: `npm test`, or `node --test src/lib/ownerSnapshot.test.js`.
 *
 * 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for today, this
 * week, this month." The function's reads and sums are supabase/functions/_shared/
 * ownerSnapshot.js, with the database client handed in. Here it is handed a stand in that
 * behaves like PostgREST where it matters: it answers AT MOST 1000 rows a request whatever is
 * asked for, returns only the columns selected, and logs every request, so the tests can see
 * what was read as well as what was answered.
 *
 * What must hold:
 *   * Today answers exactly what the function answered before the filters.
 *   * A week or a month is every check in its dates once: none lost to the 1000 row cap, none
 *     counted twice where the ranges that are read overlap.
 *   * Each venue is on its own clock.
 *   * Items (the heavy column) are read for the period's own days only.
 *   * A read that fails is an error, never a quiet zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerSnapshot, buildOwnerDetail, detailScope, venueMeta, cmpCut, firstTradingDay, hasOpeningDay, MAX_READS, OWNER_FEATURES, OPENING_MIN_SALES } from '../../supabase/functions/_shared/ownerSnapshot.js';
import { pagedEach, limiter } from '../../supabase/functions/_shared/pagedRows.js';
import { periodRange, addDays } from '../../supabase/functions/_shared/ownerPeriod.js';

// ── a PostgREST stand in ─────────────────────────────────────────────────────

const isTime = (v) => typeof v === 'string' && v.includes('T');
const cmp = (a, b) => {
  const [x, y] = isTime(a) && isTime(b) ? [Date.parse(a), Date.parse(b)] : [a, b];
  return x < y ? -1 : x > y ? 1 : 0;
};

function fakeOps(tables, { cap = 1000, failWhen = null, wait = 0 } = {}) {
  const log = [];
  const state = { inFlight: 0, peak: 0 };
  const run = async (q) => {
    state.inFlight += 1; state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((r) => setTimeout(r, wait));
    state.inFlight -= 1;
    log.push(q);
    if (failWhen?.(q)) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
    if (!(q.table in tables)) return { data: null, error: { message: `relation "${q.table}" does not exist` } };
    let rows = tables[q.table].filter((row) => q.tests.every((t) => t(row)));
    rows = [...rows].sort((a, b) => { for (const c of q.orders) { const d = cmp(a[c], b[c]); if (d) return d; } return 0; });
    const [from, to] = q.range ?? [0, Infinity];
    rows = rows.slice(from, to + 1).slice(0, Math.min(cap, q.limit ?? Infinity));
    const cols = q.select.split(',').map((c) => c.trim());
    return { data: rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c]]))), error: null };
  };
  const from = (table) => {
    const q = { table, select: '*', tests: [], filters: [], orders: [], range: null };
    const where = (op, col, val, t) => { q.filters.push({ op, col, val }); q.tests.push(t); return b; };
    const b = {
      select: (cols) => { q.select = cols; return b; },
      eq: (c, v) => where('eq', c, v, (r) => r[c] === v),
      in: (c, vs) => where('in', c, vs, (r) => vs.includes(r[c])),
      gte: (c, v) => where('gte', c, v, (r) => cmp(r[c], v) >= 0),
      lte: (c, v) => where('lte', c, v, (r) => cmp(r[c], v) <= 0),
      lt: (c, v) => where('lt', c, v, (r) => cmp(r[c], v) < 0),
      // PostgREST compares a jsonb column with the text it is given: '[]' is the empty list.
      // .not(col, 'is', true): every row where the column is not true, null included.
      not: (c, op, v) => where(`not.${op}`, c, v, (r) => r[c] !== v),
      neq: (c, v) => where('neq', c, v, (r) => r[c] != null && JSON.stringify(r[c]) !== v),
      limit: (n) => { q.limit = n; return b; },
      order: (c) => { q.orders.push(c); return b; },
      range: (a, z) => { q.range = [a, z]; return b; },
      then: (ok, bad) => run(q).then(ok, bad),
    };
    return b;
  };
  return { from, log, state };
}

// ── rows ─────────────────────────────────────────────────────────────────────

let seq = 0;
/** A UK card sale of £12 (£10 net, £2 VAT) unless told otherwise. */
const chk = (loc, closedAt, { gross = 12, items = [{ name: 'Latte', qty: 1, price: 12 }], ...rest } = {}) => ({
  id: `chk-${String(seq += 1).padStart(6, '0')}`, location_id: loc, closed_at: closedAt,
  subtotal: gross, total: gross, tax_amount: gross / 6, service: 0, tip: 0, status: 'closed', voided: false,
  discounts: [], tenders: [{ method: 'card', amount: gross, tip: 0, processor: 'adyen' }],
  method: 'card', payment_method: null, source: 'pos', processor: 'adyen', gift_card: null, loyalty: null, promo: null, payment_intents: null,
  items, ...rest,
});
const many = (n, loc, at, extra) => Array.from({ length: n }, () => chk(loc, at, extra));
const tables = (t) => ({ closed_checks: [], wf_sales_forecast: [], wf_timesheets: [], order_queue: [], active_sessions: [], menu_categories: [], wf_venue_settings: [], ...t });
// A day that starts at midnight (Barnsley Train Station's does). The 06:30 venues are further down.
const LEEDS = { name: 'Leeds', tz: 'Europe/London', currency: 'GBP', dayStart: '00:00' };
const PROVO = { name: 'Provo', tz: 'America/Denver', currency: 'USD', dayStart: '00:00' };
// The sales and items reads. The one small "first ever sale" read per venue is its own thing.
const isFirstSaleRead = (q) => q.table === 'closed_checks' && q.select === 'id, closed_at, status, voided';
const firstSaleReads = (ops) => ops.log.filter(isFirstSaleRead);
const checkReads = (ops, cols) => ops.log.filter((q) => q.table === 'closed_checks' && !isFirstSaleRead(q) && (cols === 'items' ? q.select.includes('items') : !q.select.includes('items')));
const bound = (q, op) => q.filters.find((f) => f.col === 'closed_at' && f.op === op)?.val;

// Friday 2 Oct 2026, 12:00 in Leeds (BST, UTC+1). The week began Monday 28 Sep.
const NOW = new Date('2026-10-02T11:00:00Z');
function leeds() {
  seq = 0;
  return tables({
    closed_checks: [
      // Today: three sales and a voided one.
      ...many(3, 'L', '2026-10-02T08:30:00Z', { items: [{ name: 'Latte', qty: 2, price: 3.5 }, { name: 'Brownie', qty: 1, price: 5 }] }),
      chk('L', '2026-10-02T09:00:00Z', { voided: true }),
      // 1 Oct, one of them at 00:30 on the venue's clock, which is still 30 Sep in UTC.
      chk('L', '2026-09-30T23:30:00Z', { items: [{ name: 'Flat White', qty: 4, price: 3 }] }),
      // 22:30 on 30 Sep on the venue's clock: September.
      chk('L', '2026-09-30T21:30:00Z'),
      chk('L', '2026-09-29T10:00:00Z'), chk('L', '2026-09-28T10:00:00Z'),
      // Last week: Monday, Tuesday, and two on the Friday (the same weekday as today).
      chk('L', '2026-09-21T10:00:00Z'), chk('L', '2026-09-22T10:00:00Z'), ...many(2, 'L', '2026-09-25T10:00:00Z'),
      // Saturday of last week: after the span that week to date compares with.
      chk('L', '2026-09-26T10:00:00Z'),
      // September's first days: five on the 1st, one on the 2nd, four on the 3rd.
      ...many(5, 'L', '2026-09-01T10:00:00Z'), chk('L', '2026-09-02T10:00:00Z'), ...many(4, 'L', '2026-09-03T10:00:00Z'),
      // Another venue entirely.
      ...many(7, 'ELSEWHERE', '2026-10-02T08:00:00Z'),
    ],
    wf_sales_forecast: [
      { id: 'f1', location_id: 'L', forecast_date: '2026-10-02', amount: 100 },
      { id: 'f2', location_id: 'L', forecast_date: '2026-10-01', amount: 50 },
      { id: 'f3', location_id: 'L', forecast_date: '2026-09-30', amount: 40 },
      { id: 'f4', location_id: 'L', forecast_date: '2026-09-28', amount: 40 },
      { id: 'f5', location_id: 'L', forecast_date: '2026-09-27', amount: 999 },
      { id: 'f6', location_id: 'L', forecast_date: '2026-10-03', amount: 999 },
    ],
    wf_timesheets: [
      { id: 't1', location_id: 'L', clock_in: '2026-10-02T06:00:00Z', pay_amount: 6, status: 'approved' },
      { id: 't2', location_id: 'L', clock_in: '2026-10-02T06:00:00Z', pay_amount: 99, status: 'pending' },
      { id: 't3', location_id: 'L', clock_in: '2026-10-01T06:00:00Z', pay_amount: 9, status: 'paid' },
      { id: 't4', location_id: 'L', clock_in: '2026-09-29T06:00:00Z', pay_amount: 5, status: 'approved' },
    ],
    order_queue: [
      { ref: 'R1', location_id: 'L', status: 'preparing' }, { ref: 'R2', location_id: 'L', status: 'Collected' }, { ref: 'R3', location_id: 'L', status: 'ready' },
    ],
    active_sessions: [{ id: 's1', location_id: 'L' }],
  });
}
const build = (ops, period, extra = {}) => buildOwnerSnapshot({ ops, opsIds: ['L'], meta: { L: LEEDS }, now: NOW, period, ...extra });

// ── Today ────────────────────────────────────────────────────────────────────

const TODAY_AS_BEFORE = {
  ops_location_id: 'L', name: 'Leeds', currency: 'GBP', tz: 'Europe/London',
  today: {
    net_sales: 30, vat: 6, gross_sales: 36, orders: 3, tips: 0, avg_check: 10,
    forecast: 100, forecast_pct: 30, labour: 6, labour_pct: 20, last_week_sales: 20,
    // Both of last Friday's sales were before 12:00, the time it is now.
    last_week_sales_by_now: 20,
  },
  // Mon 28 Sep to today: 10 + 10 + 10 + 10 + 30. Last week Mon to Fri: 10 + 10 + 20.
  wtd: { net_sales: 70, last_week_net_sales: 40, vs_last_week_pct: 75 },
  live: { orders: 2, tables: 1 },
  top_items: [{ name: 'Latte', qty: 6, rev: 21 }, { name: 'Brownie', qty: 3, rev: 15 }],
};
// What 5 Oct 2026 added to a venue: taken off before the old shape is compared.
const split = ({ day_start, first_sale_date, compare, week_compare, week_range, ...old }) => ({ old, added: { day_start, first_sale_date, compare, week_compare, week_range } });
const splitRollup = ({ compare, week_compare, currency, currencies, by_currency, ...old }) => ({ old, added: { compare, week_compare, currency, currencies, by_currency } });

test('Today (and an older app that sends no period) answers what the function always answered', async () => {
  for (const period of [undefined, 'today', 'nonsense']) {
    const snap = await build(fakeOps(leeds()), period);
    assert.equal(snap.period, 'today');
    assert.equal(snap.locations.length, 1);
    const { range, period_totals, period_top_items, ...before } = split(snap.locations[0]).old;
    assert.deepEqual(before, TODAY_AS_BEFORE);
    // The new fields say the same thing as the old ones. The comparison stops at 12:00 last Friday.
    assert.deepEqual(range, { from: '2026-10-02', to: '2026-10-02', cmp_from: '2026-09-25', cmp_to: '2026-09-25', days: 1, cmp_days: 1, cmp_until: '2026-09-25T11:00:00.000Z', cmp_time: '12:00' });
    assert.deepEqual(period_totals, {
      net_sales: 30, vat: 6, gross_sales: 36, orders: 3, tips: 0, avg_check: 10,
      forecast: 100, forecast_pct: 30, labour: 6, labour_pct: 20, cmp_net_sales: 20, vs_cmp_pct: 50,
    });
    assert.deepEqual(period_top_items, before.top_items);
    const { period_totals: group, ...rollup } = splitRollup(snap.rollup).old;
    assert.deepEqual(rollup, {
      locations: 1, net_sales: 30, forecast: 100, orders: 3, tips: 0, labour: 6, live_orders: 2, open_tables: 1,
      wtd_net: 70, wtd_last_week: 40, forecast_pct: 30, labour_pct: 20, wtd_vs_last_week_pct: 75,
    });
    assert.deepEqual(group, { net_sales: 30, forecast: 100, orders: 3, tips: 0, labour: 6, cmp_net_sales: 20, forecast_pct: 30, labour_pct: 20, like_net_sales: 30, cmp_locations: 1, vs_cmp_pct: 50 });
  }
});

test('Today reads one sales window and one items window for the venue, as before the filters', async () => {
  const ops = fakeOps(leeds());
  await build(ops, 'today');
  const sales = checkReads(ops, 'sales'), items = checkReads(ops, 'items');
  assert.equal(sales.length, 1);
  // Monday of last week to the end of today, midnight to midnight on the venue's clock (BST).
  assert.equal(bound(sales[0], 'gte'), '2026-09-20T23:00:00.000Z');
  assert.equal(bound(sales[0], 'lt'), '2026-10-02T23:00:00.000Z');
  // Items are today's only: they are the heavy column.
  assert.equal(items.length, 1);
  assert.equal(bound(items[0], 'gte'), '2026-10-01T23:00:00.000Z');
  assert.equal(bound(items[0], 'lt'), '2026-10-02T23:00:00.000Z');
  // Every check read is fenced to the venue and ordered on a unique key.
  for (const q of [...sales, ...items]) {
    assert.deepEqual(q.filters.find((f) => f.col === 'location_id'), { op: 'eq', col: 'location_id', val: 'L' });
    assert.deepEqual(q.orders, ['closed_at', 'id']);
    assert.deepEqual(q.range, [0, 999]);
  }
});

// ── This week ────────────────────────────────────────────────────────────────

test('This week: Monday to today against the same days last week, and today is still there for an older app', async () => {
  const ops = fakeOps(leeds());
  const snap = await build(ops, 'week');
  assert.equal(snap.period, 'week');
  const { range, period_totals, period_top_items, ...before } = split(snap.locations[0]).old;
  assert.deepEqual(before, TODAY_AS_BEFORE);
  assert.deepEqual(range, { from: '2026-09-28', to: '2026-10-02', cmp_from: '2026-09-21', cmp_to: '2026-09-25', days: 5, cmp_days: 5, cmp_until: '2026-09-25T11:00:00.000Z', cmp_time: '12:00' });
  assert.deepEqual(period_totals, {
    // The same figure as the old week to date, with its VAT, orders and average.
    net_sales: 70, vat: 14, gross_sales: 84, orders: 7, tips: 0, avg_check: 10,
    // Forecast for 28 Sep, 30 Sep, 1 Oct and today (27 Sep and 3 Oct are outside the week).
    forecast: 230, forecast_pct: 30,
    // Approved and paid timesheets from Monday: 5 + 9 + 6. The pending one never counts.
    labour: 20, labour_pct: 28.57,
    cmp_net_sales: 40, vs_cmp_pct: 75,
  });
  // The week's sellers: today's lattes and brownies, the flat whites from 1 Oct, three plain lattes.
  assert.deepEqual(period_top_items, [{ name: 'Latte', qty: 9, rev: 57 }, { name: 'Flat White', qty: 4, rev: 12 }, { name: 'Brownie', qty: 3, rev: 15 }]);
  assert.equal(period_totals.net_sales, before.wtd.net_sales);
  // Items were read from Monday, not from last week.
  const items = checkReads(ops, 'items');
  assert.equal(items.length, 1);
  assert.equal(bound(items[0], 'gte'), '2026-09-27T23:00:00.000Z');
  assert.equal(checkReads(ops, 'sales').length, 1);
});

// ── This month ───────────────────────────────────────────────────────────────

test('This month: the 1st to today against the same number of days into last month', async () => {
  const ops = fakeOps(leeds());
  const snap = await build(ops, 'month');
  assert.equal(snap.period, 'month');
  const { range, period_totals, period_top_items, ...before } = split(snap.locations[0]).old;
  assert.deepEqual(before, TODAY_AS_BEFORE);
  assert.deepEqual(range, { from: '2026-10-01', to: '2026-10-02', cmp_from: '2026-09-01', cmp_to: '2026-09-02', days: 2, cmp_days: 2, cmp_until: '2026-09-02T11:00:00.000Z', cmp_time: '12:00' });
  assert.deepEqual(period_totals, {
    // 1 Oct is the 00:30 sale only (the 22:30 one the night before is September), plus today.
    net_sales: 40, vat: 8, gross_sales: 48, orders: 4, tips: 0, avg_check: 10,
    forecast: 150, forecast_pct: 27, labour: 15, labour_pct: 37.5,
    // 1 and 2 Sep: six sales. The four on 3 Sep are a day too far.
    cmp_net_sales: 60, vs_cmp_pct: -33,
  });
  assert.deepEqual(period_top_items, [{ name: 'Latte', qty: 6, rev: 21 }, { name: 'Flat White', qty: 4, rev: 12 }, { name: 'Brownie', qty: 3, rev: 15 }]);
  assert.deepEqual(snap.rollup.period_totals, { net_sales: 40, forecast: 150, orders: 4, tips: 0, labour: 15, cmp_net_sales: 60, forecast_pct: 27, labour_pct: 37.5, like_net_sales: 40, cmp_locations: 1, vs_cmp_pct: -33 });
});

test('This month reads only the days it needs: the comparison span, not the whole of last month; items never for the comparison', async () => {
  const ops = fakeOps(leeds());
  await build(ops, 'month');
  const sales = checkReads(ops, 'sales').map((q) => [bound(q, 'gte'), bound(q, 'lt')]).sort();
  assert.deepEqual(sales, [
    ['2026-08-31T23:00:00.000Z', '2026-09-02T23:00:00.000Z'],   // 1 and 2 Sep
    ['2026-09-20T23:00:00.000Z', '2026-09-27T23:00:00.000Z'],   // week to date's own days, a week at a time
    ['2026-09-27T23:00:00.000Z', '2026-10-02T23:00:00.000Z'],
  ]);
  // No two windows share an instant: a check cannot be read twice.
  for (let i = 1; i < sales.length; i += 1) assert.ok(sales[i][0] >= sales[i - 1][1]);
  const items = checkReads(ops, 'items').map((q) => [bound(q, 'gte'), bound(q, 'lt')]);
  assert.deepEqual(items, [['2026-09-30T23:00:00.000Z', '2026-10-02T23:00:00.000Z']]);
  // The sales read never drags the heavy column along.
  for (const q of checkReads(ops, 'sales')) assert.ok(!q.select.includes('items'));
});

test('a busy month is every check once: nothing lost to the 1000 row cap, nothing counted twice', async () => {
  // 31 Oct 2026, 20:00 in Leeds (GMT by then). 260 sales a day from 1 Sep, like Barnsley.
  seq = 0;
  const now = new Date('2026-10-31T20:00:00Z');
  const rows = [];
  for (let d = '2026-09-01'; d <= '2026-10-31'; d = addDays(d, 1)) {
    for (let i = 0; i < 260; i += 1) {
      const hh = String(8 + (i % 10)).padStart(2, '0'), mm = String(i % 60).padStart(2, '0');
      rows.push(chk('L', `${d}T${hh}:${mm}:00Z`, { items: [{ name: i % 4 ? 'Latte' : 'Mocha', qty: 1, price: 12 }] }));
    }
  }
  const ops = fakeOps(tables({ closed_checks: rows }));
  const snap = await buildOwnerSnapshot({ ops, opsIds: ['L'], meta: { L: LEEDS }, now, period: 'month' });
  const l = snap.locations[0];
  // 31 days against a 30 day September: no matching day, so whole days and no cut.
  assert.deepEqual(l.range, { from: '2026-10-01', to: '2026-10-31', cmp_from: '2026-09-01', cmp_to: '2026-09-30', days: 31, cmp_days: 30, cmp_until: null, cmp_time: null });
  assert.equal(l.period_totals.orders, 31 * 260);
  assert.equal(l.period_totals.net_sales, 31 * 260 * 10);
  assert.equal(l.period_totals.cmp_net_sales, 30 * 260 * 10);
  assert.equal(l.period_totals.vs_cmp_pct, 3);
  assert.equal(l.today.orders, 260);
  // Saturday 31 Oct: the week began Monday 26 Oct (six days), against 19 to 24 Oct.
  assert.deepEqual(l.wtd, { net_sales: 6 * 2600, last_week_net_sales: 6 * 2600, vs_last_week_pct: 0 });
  assert.deepEqual(l.period_top_items, [{ name: 'Latte', qty: 31 * 195, rev: 31 * 195 * 12 }, { name: 'Mocha', qty: 31 * 65, rev: 31 * 65 * 12 }]);
  assert.deepEqual(l.top_items, [{ name: 'Latte', qty: 195, rev: 2340 }, { name: 'Mocha', qty: 65, rev: 780 }]);
  // It really did page: no request came back with more than 1000 rows, and weeks of 1,820
  // checks took a second request each.
  assert.ok(checkReads(ops, 'sales').some((q) => q.range[0] === 1000));
  assert.ok(checkReads(ops, 'items').some((q) => q.range[0] === 1000));
  // Items were read for October only: half the checks, never September's.
  for (const q of checkReads(ops, 'items')) assert.ok(bound(q, 'gte') >= '2026-09-30T23:00:00.000Z');
  // Never more than MAX_READS requests in flight.
  assert.ok(ops.state.peak <= MAX_READS, `peak ${ops.state.peak}`);
  assert.ok(ops.state.peak > 1, 'the weeks are read side by side');
});

test('whatever the day and the period, the answer matches a plain count of the same rows', async () => {
  // 70 days of sales at a UK and a US venue, three a day at awkward local times.
  seq = 0;
  const rows = [];
  for (let d = '2026-01-20'; d <= '2026-03-31'; d = addDays(d, 1)) {
    for (const t of ['00:10:00Z', '06:55:00Z', '23:50:00Z']) { rows.push(chk('L', `${d}T${t}`)); rows.push(chk('P', `${d}T${t}`)); }
  }
  const dayIn = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const count = (loc, tz, from, to) => rows.filter((r) => r.location_id === loc && dayIn(r.closed_at, tz) >= from && dayIn(r.closed_at, tz) <= to).length;
  // The comparison: whole days, then its last day up to the same clock time as now (when the
  // two spans are the same length; a month against a shorter month is whole days).
  const clockIn = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const countCmp = (loc, tz, want, at) => (want.cmpDays !== want.days ? count(loc, tz, want.cmpFrom, want.cmpTo)
    : rows.filter((r) => r.location_id === loc && dayIn(r.closed_at, tz) >= want.cmpFrom
      && (dayIn(r.closed_at, tz) < want.cmpTo || (dayIn(r.closed_at, tz) === want.cmpTo && clockIn(r.closed_at, tz) < clockIn(at, tz)))).length);
  const meta = { L: LEEDS, P: PROVO };
  // 3 Mar (week to date and month to date overlap), 10 Feb, a Monday, a 1st, a month end, and
  // 29 Mar 2026 01:30 UTC, half an hour after the UK clocks go forward.
  for (const at of ['2026-03-03T12:00:00Z', '2026-02-10T03:00:00Z', '2026-03-02T09:00:00Z', '2026-03-01T15:00:00Z', '2026-03-31T22:00:00Z', '2026-03-29T01:30:00Z']) {
    for (const period of ['today', 'week', 'month']) {
      const ops = fakeOps(tables({ closed_checks: rows }));
      const snap = await buildOwnerSnapshot({ ops, opsIds: ['L', 'P'], meta, now: new Date(at), period });
      for (const l of snap.locations) {
        const tz = meta[l.ops_location_id].tz;
        const today = dayIn(at, tz);
        const want = periodRange(period, today);
        assert.equal(l.range.to, today, `${at} ${period}`);
        assert.equal(l.period_totals.orders, count(l.ops_location_id, tz, want.from, want.to), `${at} ${period} ${l.name} orders`);
        assert.equal(l.period_totals.cmp_net_sales, 10 * countCmp(l.ops_location_id, tz, want, at), `${at} ${period} ${l.name} comparison`);
        assert.equal(l.today.orders, count(l.ops_location_id, tz, today, today), `${at} ${period} ${l.name} today`);
        assert.equal(l.period_top_items[0]?.qty ?? 0, l.period_totals.orders, `${at} ${period} ${l.name} items`);
      }
    }
  }
});

// ── each venue on its own clock ──────────────────────────────────────────────

test('a UK venue already in October and a US venue still in September each get their own month', async () => {
  seq = 0;
  const now = new Date('2026-10-01T03:00:00Z'); // 04:00 Thursday in Leeds, 21:00 Wednesday in Provo
  const ops = fakeOps(tables({
    closed_checks: [
      chk('L', '2026-10-01T02:00:00Z'),                                    // Leeds, 1 Oct
      ...many(2, 'L', '2026-09-30T12:00:00Z'),                             // Leeds, September
      ...many(3, 'P', '2026-10-01T02:00:00Z'),                             // Provo, 20:00 on 30 Sep
      ...many(4, 'P', '2026-09-01T06:30:00Z'),                             // Provo, 00:30 on 1 Sep
      chk('P', '2026-09-01T05:30:00Z'),                                    // Provo, 23:30 on 31 Aug
    ],
    wf_sales_forecast: [
      { id: 'f1', location_id: 'P', forecast_date: '2026-09-15', amount: 500 },
      { id: 'f2', location_id: 'L', forecast_date: '2026-09-15', amount: 500 },
      { id: 'f3', location_id: 'L', forecast_date: '2026-10-01', amount: 20 },
    ],
  }));
  const snap = await buildOwnerSnapshot({ ops, opsIds: ['L', 'P'], meta: { L: LEEDS, P: PROVO }, now, period: 'month' });
  const [provo, leedsV] = snap.locations;
  // Sorted by the period's sales: Provo's September first.
  assert.equal(provo.name, 'Provo');
  assert.deepEqual(provo.range, { from: '2026-09-01', to: '2026-09-30', cmp_from: '2026-08-01', cmp_to: '2026-08-30', days: 30, cmp_days: 30, cmp_until: '2026-08-31T03:00:00.000Z', cmp_time: '21:00' });
  assert.equal(provo.period_totals.orders, 7);
  assert.equal(provo.period_totals.forecast, 500);
  assert.equal(provo.today.orders, 3);
  // 23:30 on 31 Aug is the 31st: outside September, and outside the first 30 days of August.
  assert.equal(provo.period_totals.cmp_net_sales, 0);
  assert.deepEqual(leedsV.range, { from: '2026-10-01', to: '2026-10-01', cmp_from: '2026-09-01', cmp_to: '2026-09-01', days: 1, cmp_days: 1, cmp_until: '2026-09-01T03:00:00.000Z', cmp_time: '04:00' });
  assert.equal(leedsV.period_totals.orders, 1);
  // Leeds' September forecast is not this month's.
  assert.equal(leedsV.period_totals.forecast, 20);
  // Provo's month starts at ITS midnight: 06:00 UTC on 1 Sep (MDT).
  const provoItems = checkReads(ops, 'items').filter((q) => q.filters.some((f) => f.val === 'P')).map((q) => bound(q, 'gte')).sort();
  assert.equal(provoItems[0], '2026-09-01T06:00:00.000Z');
});

test('a venue with a time zone nobody recognises is read on UK time, not a crash', async () => {
  const snap = await buildOwnerSnapshot({ ops: fakeOps(leeds()), opsIds: ['L'], meta: { L: { ...LEEDS, tz: 'Mars/Olympus' } }, now: NOW, period: 'week' });
  assert.equal(snap.locations[0].period_totals.net_sales, 70);
  assert.equal(snap.locations[0].tz, 'Mars/Olympus');
});

// ── failing safe ─────────────────────────────────────────────────────────────

test('a read that fails is an error, never a period of zero sales', async () => {
  // The second page of a month's sales.
  seq = 0;
  const rows = many(1500, 'L', '2026-10-02T08:00:00Z');
  const ops = fakeOps(tables({ closed_checks: rows }), { failWhen: (q) => q.table === 'closed_checks' && q.range?.[0] === 1000 });
  await assert.rejects(build(ops, 'month'), /Could not read (closed checks|items sold): canceling statement/);
  await assert.rejects(build(fakeOps(leeds(), { failWhen: (q) => q.table === 'wf_sales_forecast' }), 'week'), /Could not read forecasts/);
  await assert.rejects(build(fakeOps(leeds(), { failWhen: (q) => q.table === 'wf_timesheets' }), 'month'), /Could not read timesheets/);
});

test('a login with no venues gets an empty answer that still names the period', async () => {
  const snap = await buildOwnerSnapshot({ ops: fakeOps(tables({})), opsIds: [], meta: {}, period: 'month' });
  assert.equal(snap.period, 'month');
  assert.deepEqual(snap.locations, []);
  assert.equal(snap.rollup.locations, 0);
  assert.equal(snap.rollup.period_totals.net_sales, 0);
});

test('the group totals add every venue\'s period; live counts are now', async () => {
  seq = 0;
  const t = leeds();
  t.closed_checks.push(...many(2, 'M', '2026-10-01T10:00:00Z'), ...many(1, 'M', '2026-09-01T10:00:00Z'));
  t.order_queue.push({ ref: 'M1', location_id: 'M', status: 'new' });
  const snap = await buildOwnerSnapshot({ ops: fakeOps(t), opsIds: ['M', 'L'], meta: { L: LEEDS, M: { ...LEEDS, name: 'Morley' } }, now: NOW, period: 'month' });
  assert.deepEqual(snap.locations.map((l) => l.name), ['Leeds', 'Morley']);
  assert.equal(snap.rollup.locations, 2);
  assert.equal(snap.rollup.net_sales, 30);               // today, for an older app
  assert.equal(snap.rollup.live_orders, 3);
  assert.deepEqual(snap.rollup.period_totals, { net_sales: 60, forecast: 150, orders: 6, tips: 0, labour: 15, cmp_net_sales: 70, forecast_pct: 40, labour_pct: 25, like_net_sales: 60, cmp_locations: 2, vs_cmp_pct: -14 });
});

test('the group comparison leaves out a venue that sold nothing in the comparison span', async () => {
  // 2 Oct 2026: four of five Coffee Boy venues opened this week. All five against the one that
  // traded last week read "+300000%". Leeds and Morley traded last month; Newtown is new.
  seq = 0;
  const t = leeds();
  t.closed_checks.push(...many(2, 'M', '2026-10-01T10:00:00Z'), ...many(1, 'M', '2026-09-01T10:00:00Z'), ...many(50, 'N', '2026-10-02T08:00:00Z'));
  const meta = { L: LEEDS, M: { ...LEEDS, name: 'Morley' }, N: { ...LEEDS, name: 'Newtown' } };
  const snap = await buildOwnerSnapshot({ ops: fakeOps(t), opsIds: ['M', 'L', 'N'], meta, now: NOW, period: 'month' });
  const [newtown] = snap.locations;
  assert.equal(newtown.name, 'Newtown');
  assert.equal(newtown.period_totals.net_sales, 500);
  assert.equal(newtown.period_totals.vs_cmp_pct, null);   // its own card shows no percent
  const g = snap.rollup.period_totals;
  assert.equal(g.net_sales, 560);                          // the headline is every venue
  assert.equal(g.cmp_net_sales, 70);
  assert.equal(g.like_net_sales, 60);                      // Leeds 40 + Morley 20
  assert.equal(g.cmp_locations, 2);
  assert.equal(g.vs_cmp_pct, -14);                         // the same as without Newtown, not +700%
  // 5 Oct 2026: the week to date an older app reads is like for like too. Only Leeds traded
  // last week (70 against 40). It was every venue's week against that 40: +1375%.
  assert.equal(snap.rollup.wtd_net, 590);
  assert.equal(snap.rollup.wtd_last_week, 40);
  assert.equal(snap.rollup.wtd_vs_last_week_pct, 75);
});

// ── the pager and the limiter ────────────────────────────────────────────────

test('pagedEach hands over each page as it arrives and keeps none of it', async () => {
  const rows = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  const ops = fakeOps({ t: rows });
  const sizes = [];
  const seen = await pagedEach('rows', () => ops.from('t').select('id').order('id'), (page) => sizes.push(page.length));
  assert.equal(seen, 2300);
  assert.deepEqual(sizes, [1000, 1000, 300]);
  assert.deepEqual(ops.log.map((q) => q.range), [[0, 999], [1000, 1999], [2000, 2999]]);
  // Exactly a page full asks once more and hands nothing over for the empty page.
  const exact = fakeOps({ t: rows.slice(0, 1000) });
  const calls = [];
  assert.equal(await pagedEach('rows', () => exact.from('t').select('id').order('id'), (page) => calls.push(page.length)), 1000);
  assert.deepEqual(calls, [1000]);
  assert.equal(exact.log.length, 2);
  await assert.rejects(pagedEach('closed checks', () => fakeOps({}).from('nope').select('id'), () => {}), /Could not read closed checks: relation "nope" does not exist/);
});

test('the limiter never lets more than its cap run at once, and one failure does not jam the queue', async () => {
  const gate = limiter(3);
  let running = 0, peak = 0;
  const job = (ms, fail) => gate(async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running -= 1;
    if (fail) throw new Error('boom');
    return ms;
  });
  const results = await Promise.allSettled([job(5), job(1, true), job(3), job(2), job(1), job(4), job(1, true), job(2)]);
  assert.equal(peak, 3);
  assert.deepEqual(results.map((r) => r.status === 'fulfilled' ? r.value : r.reason.message), [5, 'boom', 3, 2, 1, 4, 'boom', 2]);
  // A gate hands a lazy query (a thenable, like the PostgREST builder) on to be run.
  let asked = 0;
  const lazy = { then: (ok) => { asked += 1; return Promise.resolve({ data: [1] }).then(ok); } };
  assert.deepEqual(await limiter(1)(() => lazy), { data: [1] });
  assert.equal(asked, 1);
});

// ── 5 Oct 2026: the business day, the fair comparison, the reason word ───────
//
// Peter's decisions on multi site reporting. What every percent compares to: "same day last
// week, then for the week the week before and the month view the month before." The Owner app
// day: "the BUSINESS day, same as Back Office, Daily trading and Xero."

const CB = { name: 'Coffee Boy Leeds', tz: 'Europe/London', currency: 'GBP', dayStart: '06:30' };
const one = (ops, meta, now, period = 'today') => buildOwnerSnapshot({ ops, opsIds: Object.keys(meta), meta, now: new Date(now), period });

test('a day is the venue business day: a sale after midnight belongs to the night before', async () => {
  seq = 0;
  const rows = [
    chk('L', '2026-10-01T23:40:00Z'),              // 00:40 on Friday's clock: still Thursday's business
    chk('L', '2026-10-02T05:40:00Z'),              // 06:40 Friday: Friday
    ...many(2, 'L', '2026-10-02T23:10:00Z'),       // 00:10 Saturday: still Friday
    chk('L', '2026-09-24T23:40:00Z'),              // last week's Thursday night
    chk('L', '2026-08-01T10:00:00Z'),
  ];
  // 01:00 on Saturday 3 Oct on the clock. Friday's day is still running until 06:30.
  const snap = await one(fakeOps(tables({ closed_checks: rows })), { L: CB }, '2026-10-03T00:00:00Z');
  const l = snap.locations[0];
  assert.equal(l.day_start, '06:30');
  assert.equal(l.range.to, '2026-10-02');                    // Today is the day still finishing
  assert.equal(l.today.orders, 3);                           // 06:40, and the two after midnight
  assert.equal(l.wtd.net_sales, 40);                         // Thursday night's sale is in the week too
  const mid = await one(fakeOps(tables({ closed_checks: rows })), { L: { ...CB, dayStart: '00:00' } }, '2026-10-03T00:00:00Z');
  // Midnight to midnight said Saturday, an hour old, with only the two sales since midnight.
  assert.equal(mid.locations[0].range.to, '2026-10-03');
  assert.equal(mid.locations[0].today.orders, 2);
  // No day start handed in reads as 06:00, the Back Office default.
  const dflt = await one(fakeOps(tables({ closed_checks: rows })), { L: { name: 'Leeds', tz: 'Europe/London', currency: 'GBP' } }, '2026-10-03T00:00:00Z');
  assert.equal(dflt.locations[0].day_start, '06:00');
  assert.equal(dflt.locations[0].range.to, '2026-10-02');
});

test('the reads run from day start to day start on the venue clock', async () => {
  const ops = fakeOps(leeds());
  await one(ops, { L: CB }, NOW);
  const [sales] = checkReads(ops, 'sales'), [items] = checkReads(ops, 'items');
  // Monday of last week 06:30 BST to tomorrow 06:30 BST.
  assert.equal(bound(sales, 'gte'), '2026-09-21T05:30:00.000Z');
  assert.equal(bound(sales, 'lt'), '2026-10-03T05:30:00.000Z');
  assert.equal(bound(items, 'gte'), '2026-10-02T05:30:00.000Z');
  // One small read for the first ever sale, the oldest rows of that venue only.
  const [first] = firstSaleReads(ops);
  assert.equal(firstSaleReads(ops).length, 1);
  assert.deepEqual(first.range, [0, 59]);
  assert.deepEqual(first.orders, ['closed_at', 'id']);
  assert.deepEqual(first.filters, [{ op: 'eq', col: 'location_id', val: 'L' }, { op: 'not.is', col: 'voided', val: true }]);
});

test('a day start that is not on a quarter hour still puts every sale on the right day', async () => {
  seq = 0;
  const rows = [chk('L', '2026-10-02T05:09:30Z'), chk('L', '2026-10-02T05:10:00Z'), chk('L', '2026-10-02T05:14:59Z'), chk('L', '2026-09-01T10:00:00Z')];
  // The day starts at 06:10 BST, which is 05:10 UTC.
  const snap = await one(fakeOps(tables({ closed_checks: rows })), { L: { ...CB, dayStart: '06:10' } }, '2026-10-02T11:00:00Z');
  assert.equal(snap.locations[0].today.orders, 2);
});

test('mornings are fair: the comparison stops at the same time of day last week', async () => {
  seq = 0;
  // Monday 5 Oct 2026, 10:00 in Leeds. Last Monday took 3 sales by 10:00 and 20 more after.
  const rows = [
    ...many(4, 'L', '2026-10-05T07:30:00Z'),
    ...many(3, 'L', '2026-09-28T07:30:00Z'), chk('L', '2026-09-28T09:00:00Z'), ...many(19, 'L', '2026-09-28T12:00:00Z'),
    chk('L', '2026-09-01T10:00:00Z'),
  ];
  const now = '2026-10-05T09:00:00Z';
  const today = (await one(fakeOps(tables({ closed_checks: rows })), { L: CB }, now)).locations[0];
  assert.equal(today.range.cmp_time, '10:00');
  assert.equal(today.range.cmp_until, '2026-09-28T09:00:00.000Z');
  // 40 against the 30 taken by 10:00 last Monday: +33%. It was 40 against 230: -83%, every morning.
  // (One stray check on 1 Sep is not an opening: the first day with ten sales or more is.)
  assert.deepEqual(today.compare, { period: 'today', reason: 'ok', pct: 33, net_sales: 40, cmp_net_sales: 30, first_sale_date: '2026-09-28' });
  assert.equal(today.period_totals.cmp_net_sales, 30);
  assert.equal(today.period_totals.vs_cmp_pct, 33);
  assert.equal(today.today.last_week_sales, 230);             // the whole day, as it always was
  assert.equal(today.today.last_week_sales_by_now, 30);
  // BUG 1: on a Monday, Today and This week are the same day. They now give the same answer,
  // on the venue card and on the group card, and so does the week to date chip an older app shows.
  const snapT = await one(fakeOps(tables({ closed_checks: rows })), { L: CB }, now, 'today');
  const snapW = await one(fakeOps(tables({ closed_checks: rows })), { L: CB }, now, 'week');
  for (const s of [snapT, snapW]) {
    assert.equal(s.locations[0].wtd.vs_last_week_pct, 33);
    assert.equal(s.locations[0].period_totals.vs_cmp_pct, 33);
    assert.equal(s.rollup.wtd_vs_last_week_pct, 33);
    assert.equal(s.rollup.period_totals.vs_cmp_pct, 33);
    assert.equal(s.rollup.compare.pct, 33);
    // BUG 3: the group line's pounds are always the comparison period's.
    assert.equal(s.rollup.period_totals.cmp_net_sales, 30);
    assert.equal(s.rollup.compare.cmp_net_sales, 30);
  }
  // BUG 2: under Today the period totals are sent as well, and they are Today's own.
  assert.equal(snapT.locations[0].compare.period, 'today');
  assert.equal(snapT.locations[0].week_compare.period, 'week');
  assert.deepEqual(snapT.locations[0].week_range, snapW.locations[0].range);
});

test('the cut follows the clock after midnight on a late venue, and a shorter last month is not cut', () => {
  const late = { tz: 'Europe/London', dayStart: '06:30' };
  // 01:15 on Saturday 3 Oct: business day Friday 2 Oct. Last week's cut is 01:15 on Saturday 26 Sep.
  const range = { from: '2026-10-02', to: '2026-10-02', cmpFrom: '2026-09-25', cmpTo: '2026-09-25', days: 1, cmpDays: 1 };
  const cut = cmpCut({ range, today: '2026-10-02', nowMs: Date.parse('2026-10-03T00:15:20Z'), ...late });
  assert.deepEqual(cut, { day: '2026-09-25', untilMs: Date.parse('2026-09-26T00:15:20Z'), time: '01:15' });
  // 31 Oct against a 30 day September: the comparison stopped early, so whole days.
  const month = periodRange('month', '2026-10-31');
  assert.equal(cmpCut({ range: month, today: '2026-10-31', nowMs: Date.parse('2026-10-31T12:00:00Z'), ...late }), null);
  // The clocks went back on 25 Oct 2026: 10:00 on Mon 26 Oct (GMT) against 10:00 on Mon 19 Oct (BST).
  const wk = periodRange('today', '2026-10-26');
  assert.equal(cmpCut({ range: wk, today: '2026-10-26', nowMs: Date.parse('2026-10-26T10:00:00Z'), ...late }).untilMs, Date.parse('2026-10-19T09:00:00Z'));
});

test('the reason word: new, no sales yet, nothing then, ok, and what the group percent covers', async () => {
  seq = 0;
  // Monday 5 Oct 2026, 14:00. Last Monday was 28 Sep.
  const rows = [
    // OLD traded both Mondays.
    ...many(6, 'OLD', '2026-10-05T09:00:00Z'), ...many(5, 'OLD', '2026-09-28T09:00:00Z'), chk('OLD', '2026-09-01T09:00:00Z'),
    // NEW opened on Thursday 1 Oct. A voided test check from 20 Sep is not its first sale.
    chk('NEW', '2026-09-20T09:00:00Z', { voided: true }), ...many(50, 'NEW', '2026-10-01T09:00:00Z'), ...many(40, 'NEW', '2026-10-05T09:00:00Z'),
    // PART opened on Monday 28 Sep at 13:00, so it does have sales last Monday: a full day to compare.
    ...many(2, 'PART', '2026-09-28T12:00:00Z'), ...many(3, 'PART', '2026-10-05T09:00:00Z'),
    // QUIET has traded for weeks, sold last Monday, and nothing yet today.
    ...many(4, 'QUIET', '2026-09-28T09:00:00Z'), chk('QUIET', '2026-09-01T09:00:00Z'),
    // SHUT has traded for weeks but was closed last Monday.
    ...many(2, 'SHUT', '2026-10-05T09:00:00Z'), chk('SHUT', '2026-09-01T09:00:00Z'),
  ];
  const meta = Object.fromEntries(['OLD', 'NEW', 'PART', 'QUIET', 'SHUT'].map((id) => [id, { ...CB, name: id }]));
  const snap = await one(fakeOps(tables({ closed_checks: rows })), meta, '2026-10-05T13:00:00Z');
  const by = Object.fromEntries(snap.locations.map((l) => [l.name, l]));
  assert.deepEqual(by.OLD.compare, { period: 'today', reason: 'ok', pct: 20, net_sales: 60, cmp_net_sales: 50, first_sale_date: '2026-09-01' });
  assert.deepEqual(by.NEW.compare, { period: 'today', reason: 'new', pct: null, net_sales: 400, cmp_net_sales: 0, first_sale_date: '2026-10-01' });
  assert.deepEqual(by.PART.compare, { period: 'today', reason: 'ok', pct: 50, net_sales: 30, cmp_net_sales: 20, first_sale_date: '2026-09-28' });
  // Never a red -100%: no percent, and the word says why.
  assert.deepEqual(by.QUIET.compare, { period: 'today', reason: 'no_sales_now', pct: null, net_sales: 0, cmp_net_sales: 40, first_sale_date: '2026-09-01' });
  assert.equal(by.QUIET.period_totals.vs_cmp_pct, null);
  assert.deepEqual(by.SHUT.compare, { period: 'today', reason: 'no_sales_then', pct: null, net_sales: 20, cmp_net_sales: 0, first_sale_date: '2026-09-01' });
  // The group: every venue in the headline; OLD, PART and QUIET in the percent, on both sides.
  assert.deepEqual(snap.rollup.compare, {
    reason: 'ok', pct: -18, net_sales: 510, like_net_sales: 90, cmp_net_sales: 110,
    venues: 5, venues_compared: 3, venues_new: 1, venues_no_sales_then: 1, venues_no_sales_now: 1,
  });
  assert.equal(snap.rollup.period_totals.vs_cmp_pct, -18);
  assert.equal(snap.rollup.period_totals.cmp_locations, 3);
  assert.equal(snap.rollup.period_totals.cmp_net_sales, 110);
  assert.equal(snap.rollup.period_totals.net_sales, 510);
  // This week (Monday only so far) says the same. PART opened ON the first day of the span, so it counts.
  const week = await one(fakeOps(tables({ closed_checks: rows })), meta, '2026-10-05T13:00:00Z', 'week');
  assert.deepEqual(week.rollup.compare, snap.rollup.compare);
  // This month: 1 to 5 Oct against 1 to 5 Sep. PART opened on 28 Sep, after that span began: New.
  const month = await one(fakeOps(tables({ closed_checks: rows })), meta, '2026-10-05T13:00:00Z', 'month');
  const m = Object.fromEntries(month.locations.map((l) => [l.name, l.compare.reason]));
  assert.deepEqual(m, { OLD: 'ok', NEW: 'new', PART: 'new', QUIET: 'no_sales_now', SHUT: 'ok' });
});

test('training tickets rung and voided before opening never hide the opening day', async () => {
  // 5 Oct 2026: the first sale read took the oldest 60 checks, voided ones included. Sixty voided
  // training tickets ahead of the opening day left no first day at all: "New" for ever.
  seq = 0;
  const voids = many(60, 'V', '2026-08-30T10:00:00Z', { voided: true, status: 'void' });
  const trading = [...many(40, 'V', '2026-09-01T10:00:00Z'), ...many(30, 'V', '2026-09-28T10:00:00Z'), ...many(33, 'V', '2026-10-05T10:00:00Z')];
  const ops = fakeOps(tables({ closed_checks: [...voids, ...trading] }));
  const snap = await one(ops, { V: LEEDS }, '2026-10-05T16:00:00Z');
  assert.equal(snap.locations[0].first_sale_date, '2026-09-01');
  assert.equal(snap.locations[0].compare.reason, 'ok');
  assert.equal(snap.locations[0].compare.pct, 10);
  // The database is asked to leave the voided ones out, and one read was enough.
  assert.equal(firstSaleReads(ops).length, 1);
  assert.ok(firstSaleReads(ops)[0].filters.some((f) => f.op === 'not.is' && f.col === 'voided' && f.val === true));
});

test('more test sales than one read holds: the next checks are read until a real day shows', async () => {
  // 70 small test sales over two weeks (5 a day, never 10), then the doors open on 28 Sep.
  seq = 0;
  const tests = [];
  for (let i = 0; i < 14; i += 1) tests.push(...many(5, 'T', `${addDays('2026-09-10', i)}T10:00:00Z`, { gross: 1.2 }));
  const ops = fakeOps(tables({ closed_checks: [...tests, ...many(200, 'T', '2026-09-29T10:00:00Z'), ...many(100, 'T', '2026-10-05T10:00:00Z')] }));
  const snap = await one(ops, { T: LEEDS }, '2026-10-05T16:00:00Z');
  assert.equal(snap.locations[0].first_sale_date, '2026-09-29');
  assert.equal(snap.locations[0].compare.reason, 'new');     // not a huge percent against £6 of tests
  assert.equal(firstSaleReads(ops).length, 2);
  // A venue that never has a ten sale day stops at the cap and opens on its first sale.
  seq = 0;
  const quiet = [];
  for (let i = 0; i < 80; i += 1) quiet.push(...many(5, 'Q', `${addDays('2026-06-01', i)}T10:00:00Z`));
  const qOps = fakeOps(tables({ closed_checks: quiet }));
  const q = await one(qOps, { Q: LEEDS }, '2026-10-05T16:00:00Z');
  assert.equal(q.locations[0].first_sale_date, '2026-06-01');
  assert.equal(firstSaleReads(qOps).length, 5);
  // The rule the loop stops on.
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const at = (d, n, extra = {}) => Array.from({ length: n }, () => ({ closed_at: `${d}T10:00:00Z`, ...extra }));
  assert.equal(hasOpeningDay([...at('2026-09-27', 9), ...at('2026-09-28', 10)], day), true);
  assert.equal(hasOpeningDay([...at('2026-09-27', 9), ...at('2026-09-28', 12, { voided: true })], day), false);
  assert.equal(hasOpeningDay([], day), false);
});

test('a few test sales before the doors open are not the opening day', async () => {
  // Huddersfield, live, Monday 5 Oct 2026: three £0 checks on 27 Sep, five worth £8 on Mon 28 Sep,
  // then 247 sales on the 29th. Today read about +22,000% against that £8.
  seq = 0;
  const rows = [
    ...many(3, 'H', '2026-09-27T11:00:00Z', { gross: 0 }), ...many(5, 'H', '2026-09-28T11:00:00Z', { gross: 1.6 }),
    ...many(247, 'H', '2026-09-29T09:00:00Z'), ...many(150, 'H', '2026-10-05T09:00:00Z'),
  ];
  const snap = await one(fakeOps(tables({ closed_checks: rows })), { H: { ...CB, name: 'Huddersfield' } }, '2026-10-05T16:00:00Z');
  const h = snap.locations[0];
  assert.equal(h.first_sale_date, '2026-09-29');
  assert.deepEqual(h.compare, { period: 'today', reason: 'new', pct: null, net_sales: 1500, cmp_net_sales: 6.65, first_sale_date: '2026-09-29' });
  assert.equal(h.period_totals.vs_cmp_pct, null);
  assert.equal(h.wtd.vs_last_week_pct, null);
  assert.equal(snap.rollup.compare.reason, 'new');
  assert.equal(snap.rollup.wtd_vs_last_week_pct, null);
  // The rule on its own.
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const at = (d, n, extra = {}) => Array.from({ length: n }, () => ({ closed_at: `${d}T10:00:00Z`, ...extra }));
  assert.equal(OPENING_MIN_SALES, 10);
  assert.equal(firstTradingDay([...at('2026-09-27', 3), ...at('2026-09-28', 9), ...at('2026-09-29', 10)], day), '2026-09-29');
  // Voided checks do not make a day.
  assert.equal(firstTradingDay([...at('2026-09-28', 12, { voided: true }), ...at('2026-09-29', 10)], day), '2026-09-29');
  // A quiet venue that has never had ten sales in a day opened on its first sale.
  assert.equal(firstTradingDay([...at('2026-09-27', 3), ...at('2026-09-28', 4)], day), '2026-09-27');
  assert.equal(firstTradingDay([...at('2026-09-27', 2, { status: 'voided' })], day), null);
  assert.equal(firstTradingDay([], day), null);
});

test('a venue that opened part way through the comparison span is New even though it sold in it', async () => {
  seq = 0;
  // Friday 9 Oct. This week Mon 5 to Fri 9 against Mon 28 Sep to Fri 2 Oct. N opened Thu 1 Oct.
  const rows = [
    ...many(10, 'N', '2026-10-01T09:00:00Z'), ...many(10, 'N', '2026-10-02T09:00:00Z'), ...many(100, 'N', '2026-10-06T09:00:00Z'),
    ...many(10, 'O', '2026-09-29T09:00:00Z'), ...many(11, 'O', '2026-10-06T09:00:00Z'), ...many(10, 'O', '2026-08-01T09:00:00Z'),
  ];
  const meta = { N: { ...CB, name: 'N' }, O: { ...CB, name: 'O' } };
  const snap = await one(fakeOps(tables({ closed_checks: rows })), meta, '2026-10-09T13:00:00Z', 'week');
  const n = snap.locations.find((l) => l.name === 'N');
  assert.equal(n.compare.reason, 'new');
  assert.equal(n.compare.cmp_net_sales, 200);              // sent, but not a fair week to set against
  assert.equal(n.period_totals.vs_cmp_pct, null);          // it was +400%
  // The group percent is O's alone: +10%, with N's pounds on neither side.
  assert.equal(snap.rollup.compare.pct, 10);
  assert.equal(snap.rollup.compare.cmp_net_sales, 100);
  assert.equal(snap.rollup.period_totals.cmp_net_sales, 100);
  assert.equal(snap.rollup.period_totals.like_net_sales, 110);
  assert.equal(snap.rollup.compare.venues_new, 1);
});

test('pounds and dollars are never one total: one group per currency', async () => {
  seq = 0;
  const rows = [...many(3, 'L', '2026-10-02T09:00:00Z'), ...many(2, 'P', '2026-10-02T16:00:00Z'), chk('L', '2026-09-25T09:00:00Z'), chk('L', '2026-08-01T09:00:00Z')];
  const snap = await one(fakeOps(tables({ closed_checks: rows })), { L: LEEDS, P: PROVO }, '2026-10-02T18:00:00Z');
  assert.equal(snap.rollup.currency, null);
  assert.deepEqual(snap.rollup.currencies, ['GBP', 'USD']);
  assert.deepEqual(snap.rollup.by_currency.map((g) => [g.currency, g.locations, g.net_sales, g.period_totals.net_sales, g.compare.reason]),
    [['GBP', 1, 30, 30, 'ok'], ['USD', 1, 20, 20, 'new']]);
  // The plain fields are what the live app reads: every venue added up, as before.
  assert.equal(snap.rollup.net_sales, 50);
  // One currency: it is named, and the one group is the whole rollup.
  const uk = await one(fakeOps(tables({ closed_checks: rows })), { L: LEEDS }, '2026-10-02T18:00:00Z');
  assert.equal(uk.rollup.currency, 'GBP');
  const { old } = splitRollup(uk.rollup);
  const { currency, compare, week_compare, ...group } = uk.rollup.by_currency[0];
  assert.equal(currency, 'GBP');
  assert.deepEqual(group, old);
  assert.deepEqual(compare, uk.rollup.compare);
  assert.deepEqual(week_compare, uk.rollup.week_compare);
});

test('the currency and the day start come from the Platform locations row', () => {
  const platform = [
    // The Cabin: a dollar venue with no workforce settings row. It was labelled GBP.
    { id: 'p-cabin', ops_location_id: 'cabin', name: 'The Cabin', timezone: 'America/New_York', currency: 'usd', business_day_start: '06:00' },
    { id: 'p-leeds', ops_location_id: 'leeds', name: 'Coffee Boy Leeds', timezone: 'Europe/London', currency: 'GBP', business_day_start: '06:30' },
    // A legacy row whose id is the ops id.
    { id: 'legacy', ops_location_id: null, name: 'Huddersfield', timezone: 'Europe/London', currency: null, business_day_start: null },
    // Somebody else's row that happens to come back: ignored.
    { id: 'other', ops_location_id: 'not-asked-for', name: 'Other', timezone: 'Asia/Tokyo', currency: 'JPY', business_day_start: '04:00' },
  ];
  const settings = [{ location_id: 'legacy', currency: 'EUR' }, { location_id: 'leeds', currency: 'GBP' }, { location_id: 'orphan', currency: 'USD' }];
  const meta = venueMeta(['cabin', 'leeds', 'legacy', 'orphan', 'nothing'], platform, settings);
  assert.deepEqual(meta.cabin, { name: 'The Cabin', tz: 'America/New_York', currency: 'USD', dayStart: '06:00', found: true });
  assert.deepEqual(meta.leeds, { name: 'Coffee Boy Leeds', tz: 'Europe/London', currency: 'GBP', dayStart: '06:30', found: true });
  // No currency on the Platform row: the workforce one. No day start: 06:00, as Back Office.
  assert.deepEqual(meta.legacy, { name: 'Huddersfield', tz: 'Europe/London', currency: 'EUR', dayStart: '06:00', found: true });
  // No Platform row at all: London, 06:00, and the workforce currency when there is one.
  assert.deepEqual(meta.orphan, { name: 'Location', tz: 'Europe/London', currency: 'USD', dayStart: '06:00', found: false });
  assert.deepEqual(meta.nothing, { name: 'Location', tz: 'Europe/London', currency: 'GBP', dayStart: '06:00', found: false });
  assert.deepEqual(Object.keys(meta).sort(), ['cabin', 'leeds', 'legacy', 'nothing', 'orphan']);
});

test('top items by pounds never add the extras twice: the line price already holds them', async () => {
  seq = 0;
  const latte = { name: 'Latte', qty: 2, price: 4.4, cat: 'c1', mods: [{ name: 'Caramel Syrup', price: 0.7 }, { name: 'Oat Milk', price: 0.5 }, { name: 'Decaf', price: 0 }] };
  const rows = [chk('L', '2026-10-02T09:00:00Z', { items: [latte, { name: 'Brownie', qty: 1, price: 3 }] })];
  const snap = await one(fakeOps(tables({ closed_checks: rows })), { L: LEEDS }, '2026-10-02T11:00:00Z');
  // 4.40 x 2 = 8.80, the same as the check's subtotal. Adding the mods made it 11.20.
  assert.deepEqual(snap.locations[0].top_items, [{ name: 'Latte', qty: 2, rev: 8.8 }, { name: 'Brownie', qty: 1, rev: 3 }]);
  assert.deepEqual(snap.locations[0].period_top_items, snap.locations[0].top_items);
});

// ── the detail call ──────────────────────────────────────────────────────────

const mod = (name, price) => ({ name, price });
function detailTables() {
  seq = 0;
  const latte = (qty, mods = []) => ({ name: 'Latte', qty, price: 4, cat: 'cat-hot_L', mods });
  const bagel = (qty) => ({ name: 'Bagel', qty, price: 6, cat: 'cat-food_L' });
  const manager = { id: 'm1', name: 'Bryony', role: 'Manager' };
  return tables({
    closed_checks: [
      // Friday 2 Oct (today). 08:10: card, takeaway, a latte with a syrup. £5.40.
      chk('L', '2026-10-02T07:10:00Z', { gross: 5.4, order_type: 'takeaway', items: [latte(1, [mod('Caramel Syrup', 0.7), mod('Oat Milk', 0.7)])] }),
      // 08:40: cash, dine in, two bagels. £12.
      chk('L', '2026-10-02T07:40:00Z', { gross: 12, order_type: 'dine-in', items: [bagel(2)], tenders: [{ method: 'cash', amount: 12, tip: 0 }], method: 'cash' }),
      // 11:20: kiosk, half gift card half card, with a 10% staff discount of £1.20 on £12 of goods.
      chk('L', '2026-10-02T10:20:00Z', {
        gross: 10.8, subtotal: 12, order_type: 'takeaway', source: 'kiosk', items: [latte(3)],
        discounts: [{ label: 'Staff 10%', amount: 1.2, manager }],
        tenders: [{ method: 'gift_card', amount: 5.4, tip: 0 }, { method: 'card', amount: 5.4, tip: 0, processor: 'adyen' }],
      }),
      // 11:30: drive thru sent to the card reader (a till sale, not its own channel), part paid by a loyalty reward.
      chk('L', '2026-10-02T10:30:00Z', {
        gross: 6, subtotal: 10, order_type: 'drive-thru', source: 'pos_send_to_terminal', items: [latte(1), bagel(1)],
        tenders: [{ method: 'loyalty', amount: 4, tip: 0 }, { method: 'card', amount: 6, tip: 0, processor: 'adyen' }],
      }),
      // A void tombstone: total 0, its lines say what it was worth.
      chk('L', '2026-10-02T09:00:00Z', { gross: 0, voided: true, status: 'voided', items: [{ name: 'Latte', qty: 2, price: 4, voided: true, status: 'voided' }] }),
      // A 100% comp: an order at £0, and its phantom cash tender is not takings.
      chk('L', '2026-10-02T09:30:00Z', { gross: 6, subtotal: 6, order_type: 'dine-in', items: [bagel(1)], discounts: [{ label: 'Manager comp', amount: 6, manager: 'Lucy' }], tenders: [{ method: 'cash', amount: 6, tip: 0 }], method: 'cash' }),
      // Earlier this week: Tuesday, with a refund made TODAY, and one that failed.
      chk('L', '2026-09-29T08:00:00Z', {
        gross: 24, order_type: 'dine-in', items: [bagel(4)],
        refunds: [
          { id: 'r1', amount: 6, reason: 'Wrong item served', manager: 'Bryony', timestamp: Date.parse('2026-10-02T08:00:00Z'), tenderMethod: 'cash', cardStatus: 'none', taxAmount: 1 },
          { id: 'r2', amount: 6, reason: 'Card declined', manager: 'Bryony', timestamp: Date.parse('2026-10-02T08:05:00Z'), tenderMethod: 'card', failed: true },
        ],
      }),
      // An old check whose refund was made last week: not this period's.
      chk('L', '2026-08-10T08:00:00Z', { refunds: [{ id: 'r3', amount: 12, reason: 'Old', manager: 'Bryony', timestamp: Date.parse('2026-09-24T08:00:00Z'), tenderMethod: 'cash', cardStatus: 'none' }] }),
      // Last Friday: 08:30 (before now) and 15:00 (after now).
      ...many(2, 'L', '2026-09-25T07:30:00Z'), ...many(3, 'L', '2026-09-25T14:00:00Z'),
      // Last Tuesday.
      chk('L', '2026-09-22T08:00:00Z'),
    ],
    menu_categories: [{ id: 'cat-hot_L', location_id: 'L', label: 'Hot drinks' }, { id: 'cat-food_L', location_id: 'L', label: 'Food' }, { id: 'cat-x', location_id: 'ELSEWHERE', label: 'Not ours' }],
    wf_venue_settings: [{ location_id: 'L', labour_target_pct: '0.2800' }],
  });
}
const NOON = '2026-10-02T11:00:00Z';   // 12:00 Friday in Leeds
const detailOf = (ops, extra = {}) => buildOwnerDetail({ ops, opsIds: ['L'], meta: { L: CB }, target: 'L', now: new Date(NOON), period: 'today', ...extra });

test('detail, one venue, Today: the seven reports', async () => {
  const ops = fakeOps(detailTables());
  const { period, detail: d } = await detailOf(ops);
  assert.equal(period, 'today');
  assert.deepEqual(d.scope, {
    kind: 'venue', currency: 'GBP', other_currencies: [],
    locations: [{
      ops_location_id: 'L', name: 'Coffee Boy Leeds',
      range: { from: '2026-10-02', to: '2026-10-02', cmp_from: '2026-09-25', cmp_to: '2026-09-25', days: 1, cmp_days: 1, cmp_until: '2026-09-25T11:00:00.000Z', cmp_time: '12:00' },
      // 8 Oct 2026: today's refund (5.00 of net sales) comes off net sales and the comparison.
      compare: { period: 'today', reason: 'ok', pct: 19, net_sales: 23.9, cmp_net_sales: 20, first_sale_date: '2026-08-10' },
    }],
  });
  assert.deepEqual(d.range, d.scope.locations[0].range);
  assert.deepEqual(d.compare, d.scope.locations[0].compare);
  // Gross 5.40 + 12 + 10.80 + 6 = 34.20; five orders (the comp is one, at £0); the void is none.
  // 8 Oct 2026: the refund made today (6.00 with 1.00 of VAT) comes off today's sales and VAT, as
  // Daily trading and Xero take it; the sales with no VAT recorded are counted and named (none here).
  assert.deepEqual(d.totals, { net_sales: 23.9, vat: 4.3, gross_sales: 28.2, orders: 5, tips: 0, avg_check: 4.78, refunds: 6, refund_vat: 1, vat_missing: 0, vat_missing_refs: [] });
  // 1. By hour, on the venue's clock, with last Friday's whole day beside it (not cut at now).
  // 8 Oct 2026: the refund made at 09:00 (5.00 of net sales) comes off that hour, as its sale added at its own.
  assert.deepEqual(d.hours, [
    { hour: 8, net: 14.5, orders: 2, cmp_net: 20 },
    { hour: 9, net: -5, orders: 0, cmp_net: 0 },
    { hour: 10, net: 0, orders: 1, cmp_net: 0 },
    { hour: 11, net: 14.4, orders: 2, cmp_net: 0 },
    { hour: 12, net: 0, orders: 0, cmp_net: 0 }, { hour: 13, net: 0, orders: 0, cmp_net: 0 }, { hour: 14, net: 0, orders: 0, cmp_net: 0 },
    { hour: 15, net: 0, orders: 0, cmp_net: 30 },
  ]);
  // 2. Monday to Sunday against last week. Saturday and Sunday have not happened: null, not £0.
  assert.deepEqual(d.week.map((w) => [w.dow, w.date, w.net, w.last_date, w.last_net]), [
    ['Mon', '2026-09-28', 0, '2026-09-21', 0], ['Tue', '2026-09-29', 20, '2026-09-22', 10], ['Wed', '2026-09-30', 0, '2026-09-23', 0],
    // last Thursday: the 12.00 refund made that day (10.00 of net sales) comes off it, as a sale would add (8 Oct 2026)
    ['Thu', '2026-10-01', 0, '2026-09-24', -10], ['Fri', '2026-10-02', 23.9, '2026-09-25', 50], ['Sat', '2026-10-03', null, '2026-09-26', 0], ['Sun', '2026-10-04', null, '2026-09-27', 0],
  ]);
  // 3. Payment mix: the money kinds add up to gross sales; the loyalty reward is listed apart.
  assert.deepEqual(d.payments, [
    { kind: 'card', amount: 16.8, checks: 3, money: true },
    { kind: 'cash', amount: 12, checks: 1, money: true },
    { kind: 'gift_card', amount: 5.4, checks: 1, money: true },
    { kind: 'loyalty', amount: 4, checks: 1, money: false },
  ]);
  // The money kinds are what the tenders TOOK; the refund went back after, so they add up to gross sales plus refunds (8 Oct 2026).
  assert.equal(r2sum(d.payments.filter((p) => p.money).map((p) => p.amount)), r2sum([d.totals.gross_sales, d.totals.refunds]));
  // 4. Order types and channels. The reader's payment stamp is a till sale.
  assert.deepEqual(d.order_types, [{ type: 'takeaway', net: 13.5, orders: 2 }, { type: 'dine-in', net: 10, orders: 2 }, { type: 'drive-thru', net: 5.4, orders: 1 }]);
  assert.deepEqual(d.channels, [{ channel: 'pos', net: 19.9, orders: 4 }, { channel: 'kiosk', net: 9, orders: 1 }]);
  // 5. Discounts, voids and refunds.
  assert.deepEqual(d.exceptions.discounts, {
    count: 2, amount: 7.2,
    reasons: [{ reason: 'Manager comp', count: 1, amount: 6 }, { reason: 'Staff 10%', count: 1, amount: 1.2 }],
    approved_by: [{ name: 'Lucy', count: 1, amount: 6 }, { name: 'Bryony', count: 1, amount: 1.2 }],
  });
  // The database keeps no reason for a void: null, never a made up one.
  assert.deepEqual(d.exceptions.voids, { count: 1, amount: 8, reasons: null, approved_by: null });
  // The refund made today on Tuesday's check counts today. The failed one and last week's do not.
  assert.deepEqual(d.exceptions.refunds, { count: 1, amount: 6, reasons: [{ reason: 'Wrong item served', count: 1, amount: 6 }], approved_by: [{ name: 'Bryony', count: 1, amount: 6 }] });
  // 6. Top items, by quantity and by pounds (the line price, extras never added twice), with their categories.
  assert.deepEqual(d.items.by_qty, [{ name: 'Latte', qty: 5, rev: 20, category: 'Hot drinks' }, { name: 'Bagel', qty: 4, rev: 24, category: 'Food' }]);
  assert.deepEqual(d.items.by_rev, [{ name: 'Bagel', qty: 4, rev: 24, category: 'Food' }, { name: 'Latte', qty: 5, rev: 20, category: 'Hot drinks' }]);
  assert.deepEqual(d.items.categories, [{ name: 'Food', qty: 4, rev: 24 }, { name: 'Hot drinks', qty: 5, rev: 20 }]);
  // 7. No timesheets: hidden.
  assert.equal(d.labour, null);
});
const r2sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

test('detail reads the period with the heavy columns once, and every other day with the sales columns', async () => {
  const ops = fakeOps(detailTables());
  await detailOf(ops);
  const reads = ops.log.filter((q) => q.table === 'closed_checks' && !isFirstSaleRead(q));
  const heavy = reads.filter((q) => q.select.includes('items'));
  const refunds = reads.filter((q) => q.filters.some((f) => f.op === 'neq'));
  const light = reads.filter((q) => !q.select.includes('items') && !refunds.includes(q));
  // Today, 06:30 to 06:30.
  assert.deepEqual(heavy.map((q) => [bound(q, 'gte'), bound(q, 'lt')]), [['2026-10-02T05:30:00.000Z', '2026-10-03T05:30:00.000Z']]);
  // Monday of last week up to today's start: never today again.
  assert.deepEqual(light.map((q) => [bound(q, 'gte'), bound(q, 'lt')]), [['2026-09-21T05:30:00.000Z', '2026-10-02T05:30:00.000Z']]);
  // Older checks only where they carry a refund, and only before the period (its own days bring theirs).
  assert.equal(refunds.length, 1);
  assert.equal(bound(refunds[0], 'lt'), '2026-10-02T05:30:00.000Z');
  assert.deepEqual(refunds[0].filters.find((f) => f.op === 'neq'), { op: 'neq', col: 'refunds', val: '[]' });
  for (const q of reads) {
    assert.deepEqual(q.filters.find((f) => f.col === 'location_id'), { op: 'eq', col: 'location_id', val: 'L' });
    assert.deepEqual(q.orders, ['closed_at', 'id']);
  }
  // Nothing about orders or tables: the detail is not the snapshot.
  assert.ok(!ops.log.some((q) => q.table === 'order_queue' || q.table === 'active_sessions'));
});

test('detail, This week: every day of the week, hours added up, labour against the target', async () => {
  const t = detailTables();
  t.wf_timesheets = [
    { id: 't1', location_id: 'L', clock_in: '2026-10-02T05:00:00Z', clock_out: '2026-10-02T13:00:00Z', pay_amount: 6, actual_hours: 8, status: 'approved' },
    { id: 't2', location_id: 'L', clock_in: '2026-09-29T06:00:00Z', clock_out: '2026-09-29T10:00:00Z', pay_amount: 4.5, actual_hours: 4, status: 'paid' },
    { id: 't3', location_id: 'L', clock_in: '2026-10-01T06:00:00Z', clock_out: null, pay_amount: 99, actual_hours: 0, status: 'pending' },
    // Sunday's close: last week's.
    { id: 't4', location_id: 'L', clock_in: '2026-09-27T12:00:00Z', clock_out: '2026-09-27T18:00:00Z', pay_amount: 50, actual_hours: 6, status: 'approved' },
  ];
  const { detail: d } = await detailOf(fakeOps(t), { period: 'week' });
  assert.equal(d.range.from, '2026-09-28');
  assert.equal(d.totals.net_sales, 43.9);                     // Tuesday's 20 and today's 28.90, less today's refund of 5.00 net (8 Oct 2026)
  // Last week Monday to Friday by 12:00: Tuesday's 10 and the two before noon on Friday, less the
  // 12.00 refund made last Thursday (10.00 of net sales): a refund comes off the week it was made in (8 Oct 2026).
  assert.deepEqual(d.compare, { period: 'week', reason: 'ok', pct: 119, net_sales: 43.9, cmp_net_sales: 20, first_sale_date: '2026-08-10' });
  // 09:00 is Tuesday's sale this week less Friday's 09:00 refund, and last Tuesday's sale less last Thursday's 09:00 refund beside it.
  assert.deepEqual(d.hours.find((h) => h.hour === 9), { hour: 9, net: 15, orders: 1, cmp_net: 0 });
  // The refund made on Friday on Tuesday's check is counted once, though Tuesday is in the period too.
  assert.equal(d.exceptions.refunds.count, 1);
  assert.equal(d.items.by_qty[0].name, 'Bagel');
  // The opener who clocked in at 06:00 for a 06:30 day is on that day (the middle of the shift).
  assert.deepEqual(d.labour, { cost: 10.5, hours: 12, shifts: 2, net_sales: 43.9, pct: 23.92, target_pct: 28 });
});

test('detail for the group: one currency added up, each venue on its own day, never a venue that is not yours', async () => {
  seq = 0;
  const rows = [
    ...many(3, 'L', '2026-10-02T09:00:00Z', { order_type: 'takeaway' }), ...many(2, 'L', '2026-09-25T09:00:00Z'), chk('L', '2026-08-01T09:00:00Z'),
    ...many(4, 'M', '2026-10-02T09:30:00Z', { order_type: 'dine-in' }),
    ...many(5, 'P', '2026-10-02T16:00:00Z'),
    ...many(9, 'ELSEWHERE', '2026-10-02T09:00:00Z'),
  ];
  const meta = { L: CB, M: { ...CB, name: 'Morley' }, P: PROVO };
  const call = (extra) => buildOwnerDetail({ ops: fakeOps(tables({ closed_checks: rows, wf_venue_settings: [{ location_id: 'L', labour_target_pct: 0.3 }] })), opsIds: ['L', 'M', 'P'], meta, now: new Date('2026-10-02T18:00:00Z'), period: 'today', ...extra });
  const { detail: g } = await call({ target: 'group' });
  // Pounds: the currency most venues use. Dollars are named, never added in.
  assert.equal(g.scope.kind, 'group');
  assert.equal(g.scope.currency, 'GBP');
  assert.deepEqual(g.scope.other_currencies, ['USD']);
  assert.deepEqual(g.scope.locations.map((l) => [l.name, l.compare.reason]), [['Coffee Boy Leeds', 'ok'], ['Morley', 'new']]);
  assert.equal(g.totals.orders, 7);
  assert.equal(g.totals.net_sales, 70);
  // Like for like: Leeds 30 against 20. Morley is new.
  assert.deepEqual(g.compare, { period: 'today', reason: 'ok', pct: 50, net_sales: 70, like_net_sales: 30, cmp_net_sales: 20, venues: 2, venues_compared: 1, venues_new: 1, venues_no_sales_then: 0, venues_no_sales_now: 0 });
  assert.deepEqual(g.order_types, [{ type: 'dine-in', net: 40, orders: 4 }, { type: 'takeaway', net: 30, orders: 3 }]);
  assert.deepEqual(g.hours, [{ hour: 10, net: 70, orders: 7, cmp_net: 20 }]);
  // The dollar group on its own.
  const { detail: usd } = await call({ target: 'group', currency: 'usd' });
  assert.equal(usd.scope.currency, 'USD');
  assert.deepEqual(usd.scope.other_currencies, ['GBP']);
  assert.equal(usd.totals.orders, 5);
  assert.equal(usd.range.to, '2026-10-02');
  // A venue this login cannot see: nothing at all (index.ts answers 403).
  assert.equal(await call({ target: 'ELSEWHERE' }), null);
  assert.equal(detailScope({ target: 'group', opsIds: [], meta: {} }), null);
});

test('detail pages like the snapshot: a busy week is every check once, and a failed read is an error', async () => {
  seq = 0;
  const rows = [];
  for (let d = '2026-09-21'; d <= '2026-10-02'; d = addDays(d, 1)) rows.push(...many(400, 'L', `${d}T10:00:00Z`, { items: [{ name: 'Latte', qty: 1, price: 12, mods: [] }] }));
  const ops = fakeOps(tables({ closed_checks: rows }));
  const { detail: d } = await detailOf(ops, { period: 'week' });
  assert.equal(d.totals.orders, 5 * 400);
  assert.equal(d.items.by_qty[0].qty, 5 * 400);
  assert.equal(d.week[4].net, 4000);
  assert.equal(d.week[0].last_net, 4000);
  assert.equal(d.compare.cmp_net_sales, 5 * 4000);
  assert.ok(ops.log.some((q) => q.table === 'closed_checks' && q.range?.[0] === 1000));
  assert.ok(ops.state.peak <= MAX_READS);
  await assert.rejects(detailOf(fakeOps(tables({ closed_checks: rows }), { failWhen: (q) => q.table === 'closed_checks' && q.range?.[0] === 1000 }), { period: 'week' }), /Could not read closed checks: canceling statement/);
  await assert.rejects(detailOf(fakeOps(detailTables(), { failWhen: (q) => q.table === 'menu_categories' })), /Could not read menu categories/);
});

test('the function says what it can do, so an app can tell an old one', () => {
  // An owner-snapshot from before 5 Oct 2026 sends no `features`, no `compare` and ignores
  // `detail`. The app looks for these names before it shows the screens that need them.
  for (const f of ['period', 'business_day', 'compare', 'by_currency', 'detail']) assert.ok(OWNER_FEATURES.includes(f), f);
});
