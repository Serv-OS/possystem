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
import { buildOwnerSnapshot, MAX_READS } from '../../supabase/functions/_shared/ownerSnapshot.js';
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
    rows = rows.slice(from, to + 1).slice(0, cap);
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
const tables = (t) => ({ closed_checks: [], wf_sales_forecast: [], wf_timesheets: [], order_queue: [], active_sessions: [], ...t });
const LEEDS = { name: 'Leeds', tz: 'Europe/London', currency: 'GBP' };
const PROVO = { name: 'Provo', tz: 'America/Denver', currency: 'USD' };
const checkReads = (ops, cols) => ops.log.filter((q) => q.table === 'closed_checks' && (cols === 'items' ? q.select.includes('items') : !q.select.includes('items')));
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
  },
  // Mon 28 Sep to today: 10 + 10 + 10 + 10 + 30. Last week Mon to Fri: 10 + 10 + 20.
  wtd: { net_sales: 70, last_week_net_sales: 40, vs_last_week_pct: 75 },
  live: { orders: 2, tables: 1 },
  top_items: [{ name: 'Latte', qty: 6, rev: 21 }, { name: 'Brownie', qty: 3, rev: 15 }],
};

test('Today (and an older app that sends no period) answers what the function always answered', async () => {
  for (const period of [undefined, 'today', 'nonsense']) {
    const snap = await build(fakeOps(leeds()), period);
    assert.equal(snap.period, 'today');
    assert.equal(snap.locations.length, 1);
    const { range, period_totals, period_top_items, ...before } = snap.locations[0];
    assert.deepEqual(before, TODAY_AS_BEFORE);
    // The new fields say the same thing as the old ones.
    assert.deepEqual(range, { from: '2026-10-02', to: '2026-10-02', cmp_from: '2026-09-25', cmp_to: '2026-09-25', days: 1, cmp_days: 1 });
    assert.deepEqual(period_totals, {
      net_sales: 30, vat: 6, gross_sales: 36, orders: 3, tips: 0, avg_check: 10,
      forecast: 100, forecast_pct: 30, labour: 6, labour_pct: 20, cmp_net_sales: 20, vs_cmp_pct: 50,
    });
    assert.deepEqual(period_top_items, before.top_items);
    const { period_totals: group, ...rollup } = snap.rollup;
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
  const { range, period_totals, period_top_items, ...before } = snap.locations[0];
  assert.deepEqual(before, TODAY_AS_BEFORE);
  assert.deepEqual(range, { from: '2026-09-28', to: '2026-10-02', cmp_from: '2026-09-21', cmp_to: '2026-09-25', days: 5, cmp_days: 5 });
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
  const { range, period_totals, period_top_items, ...before } = snap.locations[0];
  assert.deepEqual(before, TODAY_AS_BEFORE);
  assert.deepEqual(range, { from: '2026-10-01', to: '2026-10-02', cmp_from: '2026-09-01', cmp_to: '2026-09-02', days: 2, cmp_days: 2 });
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
  assert.deepEqual(l.range, { from: '2026-10-01', to: '2026-10-31', cmp_from: '2026-09-01', cmp_to: '2026-09-30', days: 31, cmp_days: 30 });
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
        assert.equal(l.period_totals.cmp_net_sales, 10 * count(l.ops_location_id, tz, want.cmpFrom, want.cmpTo), `${at} ${period} ${l.name} comparison`);
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
  assert.deepEqual(provo.range, { from: '2026-09-01', to: '2026-09-30', cmp_from: '2026-08-01', cmp_to: '2026-08-30', days: 30, cmp_days: 30 });
  assert.equal(provo.period_totals.orders, 7);
  assert.equal(provo.period_totals.forecast, 500);
  assert.equal(provo.today.orders, 3);
  // 23:30 on 31 Aug is the 31st: outside September, and outside the first 30 days of August.
  assert.equal(provo.period_totals.cmp_net_sales, 0);
  assert.deepEqual(leedsV.range, { from: '2026-10-01', to: '2026-10-01', cmp_from: '2026-09-01', cmp_to: '2026-09-01', days: 1, cmp_days: 1 });
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
  const ops = fakeOps(tables({ closed_checks: rows }), { failWhen: (q) => q.table === 'closed_checks' && q.range[0] === 1000 });
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
  // The week to date an older app reads is worked out as it always was.
  assert.equal(snap.rollup.wtd_vs_last_week_pct, Math.round((snap.rollup.wtd_net - snap.rollup.wtd_last_week) / snap.rollup.wtd_last_week * 100));
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
