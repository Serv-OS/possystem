/**
 * ownerPeriod.test.js: the Owner app's quick filters (Today, This week, This month).
 * Run: `npm test`, or `node --test src/lib/ownerPeriod.test.js`.
 *
 * 2 Oct 2026, Peter: "On the owner app I want to be able to have quick filters for today, this
 * week, this month." Two files are under test:
 *   supabase/functions/_shared/ownerPeriod.js  the date rules owner-snapshot works to
 *   src/lib/ownerPeriod.js                     the app's side: the remembered chip, the words,
 *                                              and what to show when the function is older
 *                                              than the app (it ships first)
 * src/lib/ownerSnapshot.test.js runs the whole snapshot build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OWNER_PERIODS, ownerPeriod, periodRange, addDays, weekStartOf, dayCount, inDays, mergeDayRanges,
  sliceDayRange, addCheckItems, topItems, vsPct, periodTotals, rollupTotals,
} from '../../supabase/functions/_shared/ownerPeriod.js';
import {
  OWNER_PERIOD_KEY, PERIOD_CHIPS, PERIOD_COPY, NEEDS_UPDATE, readStoredPeriod, storePeriod,
  shownPeriod, venueView, rollupView, likeForLikeNote, rangeLabel, sharedRange, signedPct,
} from './ownerPeriod.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const range = (period, today) => { const { from, to, cmpFrom, cmpTo } = periodRange(period, today); return { from, to, cmpFrom, cmpTo }; };

// ── the dates ────────────────────────────────────────────────────────────────

test('an older app sends no period: that is today, and so is anything unknown', () => {
  assert.deepEqual(OWNER_PERIODS, ['today', 'week', 'month']);
  for (const v of [undefined, null, '', 'year', 'TODAY', 7, {}]) assert.equal(ownerPeriod(v), 'today');
  for (const v of OWNER_PERIODS) assert.equal(ownerPeriod(v), v);
  assert.equal(periodRange('nonsense', '2026-10-02').period, 'today');
});

test('today: the day itself, against the same weekday last week', () => {
  assert.deepEqual(periodRange('today', '2026-10-02'), {
    period: 'today', from: '2026-10-02', to: '2026-10-02', cmpFrom: '2026-09-25', cmpTo: '2026-09-25', days: 1, cmpDays: 1,
  });
  // Across a month end and a year end.
  assert.deepEqual(range('today', '2026-03-03'), { from: '2026-03-03', to: '2026-03-03', cmpFrom: '2026-02-24', cmpTo: '2026-02-24' });
  assert.deepEqual(range('today', '2026-01-02'), { from: '2026-01-02', to: '2026-01-02', cmpFrom: '2025-12-26', cmpTo: '2025-12-26' });
});

test('this week: Monday to today, against the same span last week', () => {
  // Friday 2 Oct 2026: the week began Monday 28 Sep.
  assert.deepEqual(periodRange('week', '2026-10-02'), {
    period: 'week', from: '2026-09-28', to: '2026-10-02', cmpFrom: '2026-09-21', cmpTo: '2026-09-25', days: 5, cmpDays: 5,
  });
});

test('this week on a Monday is that one day, against last Monday', () => {
  assert.equal(new Date('2026-09-28T00:00:00Z').getUTCDay(), 1);
  assert.deepEqual(periodRange('week', '2026-09-28'), {
    period: 'week', from: '2026-09-28', to: '2026-09-28', cmpFrom: '2026-09-21', cmpTo: '2026-09-21', days: 1, cmpDays: 1,
  });
});

test('this week on a Sunday is the whole week: Sunday ends a week, it never starts one', () => {
  assert.equal(new Date('2026-10-04T00:00:00Z').getUTCDay(), 0);
  assert.deepEqual(periodRange('week', '2026-10-04'), {
    period: 'week', from: '2026-09-28', to: '2026-10-04', cmpFrom: '2026-09-21', cmpTo: '2026-09-27', days: 7, cmpDays: 7,
  });
  assert.equal(weekStartOf('2026-10-04'), '2026-09-28');
  assert.equal(weekStartOf('2026-10-05'), '2026-10-05');
});

test('this week across a year end', () => {
  // Thursday 1 Jan 2026: the week began Monday 29 Dec 2025.
  assert.deepEqual(range('week', '2026-01-01'), { from: '2025-12-29', to: '2026-01-01', cmpFrom: '2025-12-22', cmpTo: '2025-12-25' });
});

test('this month: the 1st to today, against the same number of days into last month', () => {
  assert.deepEqual(periodRange('month', '2026-10-02'), {
    period: 'month', from: '2026-10-01', to: '2026-10-02', cmpFrom: '2026-09-01', cmpTo: '2026-09-02', days: 2, cmpDays: 2,
  });
  assert.deepEqual(range('month', '2026-10-15'), { from: '2026-10-01', to: '2026-10-15', cmpFrom: '2026-09-01', cmpTo: '2026-09-15' });
});

test('this month on the 1st is that one day, against the 1st of last month', () => {
  assert.deepEqual(periodRange('month', '2026-10-01'), {
    period: 'month', from: '2026-10-01', to: '2026-10-01', cmpFrom: '2026-09-01', cmpTo: '2026-09-01', days: 1, cmpDays: 1,
  });
  // 1 January looks back to 1 December of the year before.
  assert.deepEqual(range('month', '2027-01-01'), { from: '2027-01-01', to: '2027-01-01', cmpFrom: '2026-12-01', cmpTo: '2026-12-01' });
});

test('a 31 day month against a 30 day month: the comparison stops on the 30th, it never runs into this month', () => {
  // 31 Oct against September (30 days).
  assert.deepEqual(periodRange('month', '2026-10-31'), {
    period: 'month', from: '2026-10-01', to: '2026-10-31', cmpFrom: '2026-09-01', cmpTo: '2026-09-30', days: 31, cmpDays: 30,
  });
  // The 30th still lines up day for day.
  assert.deepEqual(range('month', '2026-10-30'), { from: '2026-10-01', to: '2026-10-30', cmpFrom: '2026-09-01', cmpTo: '2026-09-30' });
});

test('month ends: March against February, leap year or not; a short month against a long one', () => {
  assert.deepEqual(periodRange('month', '2026-03-31'), {
    period: 'month', from: '2026-03-01', to: '2026-03-31', cmpFrom: '2026-02-01', cmpTo: '2026-02-28', days: 31, cmpDays: 28,
  });
  assert.deepEqual(range('month', '2026-03-29'), { from: '2026-03-01', to: '2026-03-29', cmpFrom: '2026-02-01', cmpTo: '2026-02-28' });
  assert.deepEqual(range('month', '2028-03-31'), { from: '2028-03-01', to: '2028-03-31', cmpFrom: '2028-02-01', cmpTo: '2028-02-29' });
  // 30 Sep (a whole 30 day month) against August: the first 30 days of August, not all 31.
  assert.deepEqual(periodRange('month', '2026-09-30'), {
    period: 'month', from: '2026-09-01', to: '2026-09-30', cmpFrom: '2026-08-01', cmpTo: '2026-08-30', days: 30, cmpDays: 30,
  });
  // 28 Feb against January.
  assert.deepEqual(range('month', '2026-02-28'), { from: '2026-02-01', to: '2026-02-28', cmpFrom: '2026-01-01', cmpTo: '2026-01-28' });
});

test('every period ends today and its comparison ends before it starts, every day for two years', () => {
  for (let d = '2026-01-01'; d <= '2027-12-31'; d = addDays(d, 1)) {
    for (const p of OWNER_PERIODS) {
      const r = periodRange(p, d);
      assert.equal(r.to, d);
      assert.ok(r.from <= r.to && r.cmpFrom <= r.cmpTo, `${p} ${d}`);
      assert.ok(r.cmpTo < r.from, `${p} ${d}: the comparison overlaps the period`);
      assert.ok(r.cmpDays <= r.days && r.cmpDays >= 1, `${p} ${d}`);
      if (p !== 'month') assert.equal(r.cmpDays, r.days);
    }
  }
});

test('a date that is not a date is refused, never guessed', () => {
  for (const bad of ['2026-02-30', '2026-13-01', 'today', '', null, undefined, '2026-1-1']) {
    assert.throws(() => periodRange('month', bad), /Not a date/);
  }
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(dayCount('2026-09-28', '2026-10-02'), 5);
  assert.equal(dayCount('2026-10-02', '2026-10-01'), 0);
  assert.ok(inDays('2026-10-01', '2026-10-01', '2026-10-02') && !inDays('2026-09-30', '2026-10-01', '2026-10-02'));
});

// ── what is read ─────────────────────────────────────────────────────────────

test('ranges that overlap or touch become one, so no day is read twice', () => {
  // Friday 2 Oct, This month: the week to date (from Mon 21 Sep) swallows the month to date.
  assert.deepEqual(mergeDayRanges([
    { from: '2026-09-21', to: '2026-10-02' }, { from: '2026-10-01', to: '2026-10-02' }, { from: '2026-09-01', to: '2026-09-02' },
  ]), [{ from: '2026-09-01', to: '2026-09-02' }, { from: '2026-09-21', to: '2026-10-02' }]);
  // Touching (the 14th then the 15th) is one range; a day apart stays two.
  assert.deepEqual(mergeDayRanges([{ from: '2026-09-15', to: '2026-09-20' }, { from: '2026-09-01', to: '2026-09-14' }]), [{ from: '2026-09-01', to: '2026-09-20' }]);
  assert.deepEqual(mergeDayRanges([{ from: '2026-09-16', to: '2026-09-20' }, { from: '2026-09-01', to: '2026-09-14' }]).length, 2);
  // One inside another, the same one twice, an empty one.
  assert.deepEqual(mergeDayRanges([{ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-09-10', to: '2026-09-12' }, { from: '2026-09-01', to: '2026-09-30' }, { from: '2026-10-05', to: '2026-10-01' }]), [{ from: '2026-09-01', to: '2026-09-30' }]);
  assert.deepEqual(mergeDayRanges([]), []);
});

test('a range is cut into weeks back to back: every day once, none missing', () => {
  const pieces = sliceDayRange('2026-09-01', '2026-10-02', 7);
  assert.deepEqual(pieces, [
    { from: '2026-09-01', to: '2026-09-07' }, { from: '2026-09-08', to: '2026-09-14' }, { from: '2026-09-15', to: '2026-09-21' },
    { from: '2026-09-22', to: '2026-09-28' }, { from: '2026-09-29', to: '2026-10-02' },
  ]);
  assert.equal(pieces.reduce((n, p) => n + dayCount(p.from, p.to), 0), dayCount('2026-09-01', '2026-10-02'));
  for (let i = 1; i < pieces.length; i += 1) assert.equal(pieces[i].from, addDays(pieces[i - 1].to, 1));
  // Today and This week fit one piece (at most 14 days), as before the filters.
  assert.deepEqual(sliceDayRange('2026-09-21', '2026-10-04', 14), [{ from: '2026-09-21', to: '2026-10-04' }]);
  assert.deepEqual(sliceDayRange('2026-10-02', '2026-10-02', 7), [{ from: '2026-10-02', to: '2026-10-02' }]);
  assert.deepEqual(sliceDayRange('2026-10-02', '2026-10-01', 7), []);
});

// ── the sums ─────────────────────────────────────────────────────────────────

test('top items add up as checks stream past: voided lines out, a missing qty is one', () => {
  const m = new Map();
  addCheckItems(m, [{ name: 'Latte', qty: 2, price: 3.5 }, { name: 'Flat White', price: 3.2 }, { name: 'Latte', qty: 1, price: 3.5, voided: true }]);
  addCheckItems(m, [{ name: 'Latte', qty: 1, price: 3.5 }, { qty: 1, price: 1 }]);
  addCheckItems(m, null);
  assert.deepEqual(topItems(m), [{ name: 'Latte', qty: 3, rev: 10.5 }, { name: 'Flat White', qty: 1, rev: 3.2 }, { name: 'Item', qty: 1, rev: 1 }]);
  assert.deepEqual(topItems(m, 1), [{ name: 'Latte', qty: 3, rev: 10.5 }]);
  assert.deepEqual(topItems(new Map()), []);
  // An item called like an object key is still just an item.
  const odd = new Map();
  addCheckItems(odd, [{ name: '__proto__', qty: 1, price: 2 }, { name: 'constructor', qty: 2, price: 1 }]);
  assert.deepEqual(topItems(odd).map((x) => x.name), ['constructor', '__proto__']);
});

test('period totals: forecast %, labour %, average check and the comparison', () => {
  const t = periodTotals({ sales: { net: 1000, vat: 200, gross: 1200, orders: 250, tips: 31.5 }, cmpNet: 800, forecast: 1250, labour: 285.5 });
  assert.deepEqual(t, {
    net_sales: 1000, vat: 200, gross_sales: 1200, orders: 250, tips: 31.5, avg_check: 4,
    forecast: 1250, forecast_pct: 80, labour: 285.5, labour_pct: 28.55, cmp_net_sales: 800, vs_cmp_pct: 25,
  });
  // Nothing sold, no forecast, nothing last time: dashes, never a divide by zero.
  const none = periodTotals({ sales: { net: 0, vat: 0, gross: 0, orders: 0, tips: 0 } });
  assert.deepEqual([none.avg_check, none.forecast_pct, none.labour_pct, none.vs_cmp_pct], [0, null, null, null]);
  assert.equal(vsPct(90, 100), -10);
  assert.equal(vsPct(90, 0), null);
});

test('the group totals are the venues added up, with the percentages worked out on the totals', () => {
  const a = periodTotals({ sales: { net: 1000, vat: 200, gross: 1200, orders: 250, tips: 10 }, cmpNet: 800, forecast: 1000, labour: 300 });
  const b = periodTotals({ sales: { net: 500, vat: 100, gross: 600, orders: 100, tips: 5 }, cmpNet: 700, forecast: 1000, labour: 100 });
  assert.deepEqual(rollupTotals([a, b]), {
    net_sales: 1500, forecast: 2000, orders: 350, tips: 15, labour: 400, cmp_net_sales: 1500,
    forecast_pct: 75, labour_pct: 26.67, like_net_sales: 1500, cmp_locations: 2, vs_cmp_pct: 0,
  });
  assert.deepEqual(rollupTotals([]), {
    net_sales: 0, forecast: 0, orders: 0, tips: 0, labour: 0, cmp_net_sales: 0,
    forecast_pct: null, labour_pct: null, like_net_sales: 0, cmp_locations: 0, vs_cmp_pct: null,
  });
});

test('the group comparison is like for like: a venue with nothing last time is left out of the percent', () => {
  // 2 Oct 2026: five Coffee Boy venues this week against the one that traded last week
  // (1 check) read "+300000%". The percent is only for the venues that traded both times.
  const old = periodTotals({ sales: { net: 1100, vat: 0, gross: 1100, orders: 200, tips: 0 }, cmpNet: 1000 });
  const fresh = periodTotals({ sales: { net: 5000, vat: 0, gross: 5000, orders: 900, tips: 0 }, cmpNet: 0 });
  const g = rollupTotals([old, fresh]);
  // The headline is still every venue.
  assert.equal(g.net_sales, 6100);
  assert.equal(g.orders, 1100);
  assert.equal(g.cmp_net_sales, 1000);
  // The percent is the old venue's own: +10%, not +510%.
  assert.equal(old.vs_cmp_pct, 10);
  assert.equal(g.vs_cmp_pct, old.vs_cmp_pct);
  assert.equal(g.like_net_sales, 1100);
  assert.equal(g.cmp_locations, 1);
  // The order the venues come in does not matter.
  assert.equal(rollupTotals([fresh, old]).vs_cmp_pct, 10);
  // Nobody traded last time: no percent at all, as on a venue card.
  const none = rollupTotals([fresh, fresh]);
  assert.deepEqual([none.vs_cmp_pct, none.cmp_locations, none.like_net_sales, none.net_sales], [null, 0, 0, 10000]);
  // A venue that traded last time and has sold nothing yet this time still counts (a real drop).
  const shut = periodTotals({ sales: { net: 0, vat: 0, gross: 0, orders: 0, tips: 0 }, cmpNet: 1000 });
  assert.equal(rollupTotals([old, shut]).vs_cmp_pct, -45);
  assert.equal(rollupTotals([old, shut]).cmp_locations, 2);
});

// ── the app's side ───────────────────────────────────────────────────────────

const box = (start = {}) => { const m = { ...start }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
const closed = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };

test('the chip is remembered on the phone; a phone that will not store it starts on Today', () => {
  const s = box();
  assert.equal(readStoredPeriod(s), 'today');
  assert.equal(storePeriod(s, 'month'), true);
  assert.equal(s.m[OWNER_PERIOD_KEY], 'month');
  assert.equal(readStoredPeriod(s), 'month');
  // Rubbish in storage, storage that throws, no storage at all.
  assert.equal(readStoredPeriod(box({ [OWNER_PERIOD_KEY]: 'fortnight' })), 'today');
  assert.equal(readStoredPeriod(closed), 'today');
  assert.equal(storePeriod(closed, 'week'), false);
  assert.equal(readStoredPeriod(null), 'today');
  assert.equal(storePeriod(undefined, 'week'), true);
});

const oldAnswer = { ok: true, locations: [{ ops_location_id: 'a', today: { net_sales: 120 }, wtd: {}, live: {}, top_items: [] }], rollup: { net_sales: 120 } };
const newAnswer = (period) => ({
  ok: true, period,
  locations: [{ ops_location_id: 'a', today: { net_sales: 120 }, wtd: {}, live: {}, top_items: [], range: {}, period_totals: { net_sales: 900 }, period_top_items: [] }],
  rollup: { net_sales: 120, period_totals: { net_sales: 900 } },
});

test('a function from before the filters: today\'s numbers are shown as today\'s, with the update line', () => {
  for (const asked of ['week', 'month']) {
    assert.deepEqual(shownPeriod(oldAnswer, asked), { period: 'today', needsUpdate: true });
  }
  // Asking for today from the old function is just today.
  assert.deepEqual(shownPeriod(oldAnswer, 'today'), { period: 'today', needsUpdate: false });
  assert.equal(NEEDS_UPDATE, 'This week and This month need a ServOS update.');
});

test('the label follows the function\'s echo, never the chip', () => {
  assert.deepEqual(shownPeriod(newAnswer('month'), 'month'), { period: 'month', needsUpdate: false });
  assert.deepEqual(shownPeriod(newAnswer('week'), 'week'), { period: 'week', needsUpdate: false });
  // The chip moved on while a week was still on screen: it is still a week.
  assert.deepEqual(shownPeriod(newAnswer('week'), 'month'), { period: 'week', needsUpdate: false });
  assert.deepEqual(shownPeriod(newAnswer('week'), 'today'), { period: 'week', needsUpdate: false });
  // Nothing loaded yet.
  assert.deepEqual(shownPeriod(null, 'month'), { period: 'today', needsUpdate: false });
  // An echo the app does not know, or an echo without the period's totals, is not trusted.
  assert.deepEqual(shownPeriod({ ...newAnswer('week'), period: 'year' }, 'week'), { period: 'today', needsUpdate: true });
  const half = newAnswer('month'); delete half.locations[0].period_totals;
  assert.deepEqual(shownPeriod(half, 'month'), { period: 'today', needsUpdate: true });
  const noGroup = newAnswer('month'); delete noGroup.rollup.period_totals;
  assert.deepEqual(shownPeriod(noGroup, 'month'), { period: 'today', needsUpdate: true });
});

const venue = {
  ops_location_id: 'a', name: 'Leeds', currency: 'GBP',
  today: { net_sales: 120, forecast: 200, forecast_pct: 60, orders: 30, avg_check: 4, labour_pct: 25, tips: 3 },
  wtd: { net_sales: 700, last_week_net_sales: 500, vs_last_week_pct: 40 },
  live: { orders: 2, tables: 1 },
  top_items: [{ name: 'Latte', qty: 9, rev: 31.5 }],
  range: { from: '2026-10-01', to: '2026-10-02' },
  period_totals: { net_sales: 900, forecast: 1000, forecast_pct: 90, orders: 220, avg_check: 4.09, labour_pct: 28.5, tips: 21, cmp_net_sales: 1000, vs_cmp_pct: -10 },
  period_top_items: [{ name: 'Flat White', qty: 80, rev: 256 }],
};

test('a venue card under Today reads exactly the fields it always read', () => {
  const v = venueView(venue, 'today');
  assert.deepEqual(v, {
    period: 'today', net_sales: 120, forecast: 200, forecast_pct: 60, orders: 30, avg_check: 4, labour_pct: 25, tips: 3,
    top_items: venue.top_items, vs_pct: 40,
  });
  // And from a function that predates the filters (no period fields at all).
  const { range: _r, period_totals: _p, period_top_items: _t, ...old } = venue;
  assert.deepEqual(venueView(old, 'today'), v);
});

test('a venue card under This month reads the period, and never today\'s figures', () => {
  const v = venueView(venue, 'month');
  assert.deepEqual(v, {
    period: 'month', net_sales: 900, forecast: 1000, forecast_pct: 90, orders: 220, avg_check: 4.09, labour_pct: 28.5, tips: 21,
    top_items: venue.period_top_items, vs_pct: -10,
  });
  // A venue with no period totals says it is today (its label follows `period`), not a month.
  const { period_totals: _p, ...bare } = venue;
  assert.equal(venueView(bare, 'month').period, 'today');
  assert.equal(venueView(bare, 'month').net_sales, 120);
});

test('the group card follows the period; live orders and tables are always now', () => {
  const r = {
    locations: 2, net_sales: 300, forecast: 400, forecast_pct: 75, orders: 70, labour_pct: 24, live_orders: 5, open_tables: 3,
    wtd_net: 1500, wtd_last_week: 1200, wtd_vs_last_week_pct: 25,
    period_totals: { net_sales: 4000, forecast: 5000, forecast_pct: 80, orders: 900, labour_pct: 27, cmp_net_sales: 3200, like_net_sales: 4000, cmp_locations: 2, vs_cmp_pct: 25 },
  };
  assert.deepEqual(rollupView(r, 'today'), {
    period: 'today', live_orders: 5, open_tables: 3, net_sales: 300, forecast: 400, forecast_pct: 75, orders: 70, labour_pct: 24, before: 1500, vs_pct: 25,
  });
  assert.deepEqual(rollupView(r, 'week'), {
    period: 'week', live_orders: 5, open_tables: 3, net_sales: 4000, forecast: 5000, forecast_pct: 80, orders: 900, labour_pct: 27, before: 3200, vs_pct: 25,
    cmp_locations: 2,
  });
  // Every venue is in the percent: nothing to add. Fewer: the line says how many.
  assert.equal(likeForLikeNote(rollupView(r, 'week'), 2), '');
  assert.equal(likeForLikeNote({ cmp_locations: 1 }, 5), ' (1 of 5 venues)');
  assert.equal(likeForLikeNote({ cmp_locations: 0 }, 5), '');      // no percent is shown at all
  assert.equal(likeForLikeNote({ cmp_locations: null }, 5), '');
  assert.equal(likeForLikeNote(rollupView(r, 'today'), 2), '');    // Today's line is the week to date, as before
  assert.equal(likeForLikeNote(undefined, 5), '');
  const { period_totals: _p, ...old } = r;
  assert.equal(rollupView(old, 'month').period, 'today');
  assert.equal(rollupView(undefined, 'today').live_orders, 0);
});

test('the words change with the period; plain English, no dashes', () => {
  assert.deepEqual(PERIOD_CHIPS.map((c) => [c.id, c.label]), [['today', 'Today'], ['week', 'This week'], ['month', 'This month']]);
  assert.deepEqual(PERIOD_CHIPS.map((c) => c.id), OWNER_PERIODS);
  // Today's words are the ones the app has always used.
  assert.equal(PERIOD_COPY.today.heading, 'Today');
  assert.equal(PERIOD_COPY.today.sales, 'Net sales today');
  assert.equal(PERIOD_COPY.today.top, 'Top sellers today');
  assert.equal(PERIOD_COPY.week.sales, 'Net sales this week');
  assert.equal(PERIOD_COPY.week.versus, 'vs same days last week');
  assert.equal(PERIOD_COPY.week.top, 'Top items this week');
  assert.equal(PERIOD_COPY.month.sales, 'Net sales this month');
  assert.equal(PERIOD_COPY.month.versus, 'vs same days last month');
  assert.equal(PERIOD_COPY.month.top, 'Top items this month');
  const words = [NEEDS_UPDATE, ...PERIOD_CHIPS.map((c) => c.label), ...Object.values(PERIOD_COPY).flatMap((c) => Object.values(c))];
  for (const w of words) assert.doesNotMatch(w, /[‒–—―]/, w);
  assert.equal(signedPct(12), '+12%');
  assert.equal(signedPct(0), '+0%');
  assert.equal(signedPct(-3), '-3%');
  assert.equal(signedPct(null), '');
});

test('the dates a period covers, in words', () => {
  assert.equal(rangeLabel({ from: '2026-09-28', to: '2026-10-02' }), '28 Sep to 2 Oct');
  assert.equal(rangeLabel({ from: '2026-10-01', to: '2026-10-01' }), '1 Oct');
  assert.equal(rangeLabel(null), '');
  assert.equal(rangeLabel({ from: 'x', to: '2026-10-01' }), '');
  const uk = { range: { from: '2026-10-01', to: '2026-10-01' } };
  const us = { range: { from: '2026-09-01', to: '2026-09-30' } };
  assert.deepEqual(sharedRange([uk, { range: { ...uk.range } }]), uk.range);
  // A UK venue already in October and a US venue still in September: each card says its own.
  assert.equal(sharedRange([uk, us]), null);
  assert.equal(sharedRange([uk, {}]), null);
  assert.equal(sharedRange([]), null);
});

test('the Owner screen: three chips, labels from the answer, the update line, the remembered choice', () => {
  const src = read('../surfaces/OwnerSurface.jsx');
  // The chips, and the choice goes to the function and to the phone.
  assert.ok(src.includes('{PERIOD_CHIPS.map((c) => ('), 'the three chips are drawn');
  assert.ok(src.includes('onClick={() => pick(c.id)} aria-pressed={period === c.id}'));
  assert.ok(src.includes('useState(() => readStoredPeriod(phoneStorage()))'), 'the phone starts on the chip it last chose');
  assert.ok(src.includes('storePeriod(phoneStorage(), id);'), 'a tap is remembered');
  assert.ok(src.includes("supabase.functions.invoke('owner-snapshot', { body: { period: want } })"));
  // What the cards say comes from the answer, never from the chip.
  assert.ok(src.includes('const shown = shownPeriod(data, period).period;'));
  assert.ok(src.includes('const copy = PERIOD_COPY[shown];'));
  assert.ok(src.includes('period={shown}'), 'every venue card is handed the period of the numbers');
  assert.ok(src.includes('const t = venueView(l, period);') && src.includes('const copy = PERIOD_COPY[t.period];'));
  assert.doesNotMatch(src, /PERIOD_COPY\[period\]/, 'a label keyed off the chip could sit over another period\'s numbers');
  // An old function: back to Today, with the one line.
  assert.ok(src.includes('if (shownPeriod(d, want).needsUpdate) {'));
  assert.match(src, /setNeedsUpdate\(true\);\s*setPeriod\('today'\);\s*storePeriod\(phoneStorage\(\), 'today'\);/);
  assert.ok(src.includes('{needsUpdate && <div') && src.includes('{NEEDS_UPDATE}</div>'));
  // A slow answer to an earlier chip never lands over a later one.
  assert.ok(src.includes('if (mine !== seq.current) return;'));
  // Numbers for another period than the lit chip stay dimmed until the chip's own answer
  // lands, a failed call included (busy is false by then, so it must not be part of the rule).
  assert.ok(src.includes('const waiting = !!data && shown !== period;'));
  assert.ok(src.includes('opacity: waiting ? 0.5 : 1'));
  // The group percent is like for like, and says so when it is for fewer venues.
  assert.ok(src.includes('likeForLikeNote(rv, r.locations)'));
  // Storage that throws on sight (private browsing) is not a crash.
  assert.ok(src.includes('const phoneStorage = () => { try { return window.localStorage; } catch { return null; } };'));
});
