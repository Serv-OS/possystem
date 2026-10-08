/**
 * reportSplit.test.js — the site split every multi site report shares.
 * Run: `npm test`, or `node --test src/lib/reportSplit.test.js`.
 *
 * Peter, 5 Oct 2026: "make every report we have multi site when sites are connected
 * together, and you can filter them down to just one site."
 *
 * Pinned:
 *   1. ONE SITE IS LEFT ALONE: the same array comes back, and every report's one site
 *      view is the function it was (the default export only chooses between the two).
 *   2. Rows go to their own site; a quiet site is still there; a row nobody asked for is
 *      never counted.
 *   3. Every site on its OWN clock and business day: the same instant is two different
 *      business days at a 06:30 site and a 00:00 site.
 *   4. Currencies are never added together: one block per currency, unknown on its own.
 *   5. The group total is the sites added up, and equals the figures over all the rows.
 *   6. Two people with one name at two sites never merge.
 *   7. Every multi site CSV has Site first.
 *   8. The server day sums mean what the browser figures mean (Daily trend, Payments,
 *      Order types), and a comparison cut part way through a day shows no percent.
 *   9. Refunds, receipts and writes are locked to the signed in site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isSplit, splitBySite, siteParts, currencyBlocks, blockTitle, sumFields, keyedMatrix, withSiteColumn,
  tagPartRows, siteNameKey, shortSiteNames, trendFromSums, orderTypesFromSums, methodsFromSums, actionLock,
} from './reportSplit.js';
import { buildReportScope, siteRange, sitesForView, figuresFrom, REPORT_SITE_MODE, DAY_SUMS_REPORTS } from './reportScope.js';
import { computeSalesStats } from './salesStats.js';
import { daySumRow, shapeDaySums } from './reportDaySums.js';
import { getPeriodRange, dayOfCheck, daypartGrid } from '../backoffice/sections/reports/_filters.js';
import { toCsv } from '../backoffice/sections/reports/_csv.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const at = (iso) => Date.parse(iso);

const CB = 'org-coffee-boy';
const LOCS = [
  { id: 'leeds',   name: 'Coffee Boy Leeds',                  org_id: CB, currency: 'GBP' },
  { id: 'station', name: 'Coffee Boy Barnsley Train Station', org_id: CB, currency: 'GBP' },
  { id: 'cabin',   name: 'The Cabin',                         org_id: CB, currency: 'USD' },
];
const CLOCKS = {
  leeds:   { timezone: 'Europe/London', businessDayStart: '06:30' },
  station: { timezone: 'Europe/London', businessDayStart: '00:00' },
  cabin:   { timezone: 'America/Denver', businessDayStart: '06:00' },
};
const LEEDS_CFG = { timezone: 'Europe/London', businessDayStart: '06:30', shifts: [], currency: 'GBP' };
const NOW = at('2026-10-05T13:00:00Z');   // Mon 5 Oct, 14:00 in Leeds

function shellSites(tickedIds, period = 'last-7') {
  const scope = buildReportScope({ homeId: 'leeds', userId: 'u1', locations: LOCS, readableIds: LOCS.map((l) => l.id), clocks: CLOCKS, homeConfig: LEEDS_CFG, tickedIds });
  const range = { ...getPeriodRange(period, null, LEEDS_CFG, NOW), builtAt: NOW };
  const sites = scope.ticked.map((s) => ({ ...s, range: s.isHome ? range : siteRange(period, range, s, NOW) }));
  return { scope, range, sites };
}
const check = (siteId, closedAt, total, extra = {}) => ({
  id: `${siteId}-${closedAt}-${total}`, siteId, siteName: LOCS.find((l) => l.id === siteId)?.name, locationId: siteId,
  closedAt: at(closedAt), total, subtotal: total, tip: 0, service: 0, covers: 1, status: 'paid', ...extra,
});

// ── 1: one site is left alone ────────────────────────────────────────────────

test('one site, or none: the very same array comes back', () => {
  const rows = [check('leeds', '2026-10-05T09:00:00Z', 5)];
  assert.equal(isSplit([{ id: 'leeds' }]), false);
  assert.equal(isSplit(null), false);
  assert.equal(isSplit([{ id: 'a' }, { id: 'b' }]), true);
  assert.equal(splitBySite(rows, [{ id: 'leeds' }])[0].rows, rows);
  assert.equal(splitBySite(rows, [])[0].rows, rows);
  assert.equal(splitBySite(rows, null)[0].rows, rows);
  // even a row tagged with another site stays: one site is never filtered
  const odd = [check('station', '2026-10-05T09:00:00Z', 5)];
  assert.equal(splitBySite(odd, [{ id: 'leeds' }])[0].rows, odd);
});

test('pin: every flipped report renders its one site view untouched when one site is on screen', () => {
  const dir = '../backoffice/sections/reports/';
  for (const [file, one] of [
    ['SalesSummary.jsx', 'SalesSummaryOne'], ['DailyTrend.jsx', 'DailyTrendOne'], ['Payments.jsx', 'PaymentsOne'],
    ['Daypart.jsx', 'DaypartOne'], ['Servers.jsx', 'ServersOne'], ['Exceptions.jsx', 'ExceptionsOne'], ['Tables.jsx', 'TablesOne'],
  ]) {
    const src = read(dir + file);
    assert.match(src, new RegExp(`return isSplit\\(props\\.sites\\) \\? <\\w+Sites \\{\\.\\.\\.props\\}/> : <${one} \\{\\.\\.\\.props\\}/>;`), file);
  }
  assert.match(read(dir + 'OrderTypes.jsx'), /if \(!isSplit\(props\.sites\)\) return <OrderTypesOne \{\.\.\.props\}\/>;/);
  assert.match(read(dir + 'OrderSources.jsx'), /if \(!isSplit\(props\.sites\)\) return <OrderSourcesOne \{\.\.\.props\}\/>;/);
  assert.match(read(dir + 'Shifts.jsx'), /if \(isSplit\(props\.sites\)\) return <ShiftsSites \{\.\.\.props\}\/>;/);
  // the one site views take the props they always took: nothing new reaches them
  assert.match(read(dir + 'SalesSummary.jsx'), /function SalesSummaryOne\(\{ checks, prevChecks, fmt, fmtN, locationConfig, compare \}\) \{/);
  assert.match(read(dir + 'DailyTrend.jsx'), /function DailyTrendOne\(\{ checks, prevChecks = \[\], fmt, fmtN, range \}\) \{/);
  assert.match(read(dir + 'Payments.jsx'), /function PaymentsOne\(\{ checks, fmt, fmtN \}\) \{/);
  assert.match(read(dir + 'Tables.jsx'), /function TablesOne\(\{ checks, fmt, fmtN \}\) \{/);
});

test('the eleven easy reports and (step 4) the menu, tax, tips and kitchen reports are flagged multi; the rest are not', () => {
  for (const v of ['summary', 'daily_trend', 'order_types', 'order_sources', 'daypart', 'servers', 'shifts', 'exceptions', 'payments', 'tables', 'transactions',
    'items', 'item_trend', 'menu_eng', 'tax', 'tips', 'kds_perf']) {
    assert.equal(REPORT_SITE_MODE[v], 'multi', v);
  }
  for (const v of ['payroll', 'daily_trading', 'bookings', 'zreport', 'cash_drawer', 'open']) assert.equal(REPORT_SITE_MODE[v], 'home', v);
  const { scope } = shellSites(['leeds', 'station']);
  assert.deepEqual(sitesForView('summary', scope).sites.map((s) => s.id).sort(), ['leeds', 'station']);
  assert.equal(sitesForView('summary', scope).note, null);
  // one site ticked: that one site, as before
  assert.deepEqual(sitesForView('payments', shellSites(['leeds']).scope).sites.map((s) => s.id), ['leeds']);
});

// ── 2: rows go to their own site ─────────────────────────────────────────────

test('several sites: rows by site in the sites\' order, a quiet site is there, a stray row is dropped', () => {
  const sites = [{ id: 'leeds' }, { id: 'station' }, { id: 'cabin' }];
  const rows = [
    check('station', '2026-10-05T09:00:00Z', 3), check('leeds', '2026-10-05T09:00:00Z', 5),
    check('leeds', '2026-10-05T10:00:00Z', 7), check('elsewhere', '2026-10-05T10:00:00Z', 999),
    { id: 'untagged', locationId: 'station', total: 1 },
  ];
  const got = splitBySite(rows, sites);
  assert.deepEqual(got.map((g) => g.site.id), ['leeds', 'station', 'cabin']);
  assert.deepEqual(got.map((g) => g.rows.length), [2, 2, 0]);
  assert.equal(got.flatMap((g) => g.rows).some((r) => r.total === 999), false, 'a row from a site nobody asked for is never counted');
});

// ── 3: own clock, own business day ───────────────────────────────────────────

test('the same instant is a different business day at a 06:30 site and a 00:00 site', () => {
  const { scope, sites } = shellSites(['leeds', 'station']);
  const parts = siteParts({ sites, scope, checks: [], prevChecks: [] });
  const leeds = parts.find((p) => p.id === 'leeds'), station = parts.find((p) => p.id === 'station');
  assert.deepEqual(leeds.clock, { timeZone: 'Europe/London', dayStart: '06:30' });
  assert.deepEqual(station.clock, { timeZone: 'Europe/London', dayStart: '00:00' });
  const twoAm = at('2026-10-04T01:00:00Z');   // 02:00 Sunday in both (BST)
  assert.equal(dayOfCheck(twoAm, leeds.clock), '2026-10-03', 'Leeds: still Saturday\'s trade');
  assert.equal(dayOfCheck(twoAm, station.clock), '2026-10-04', 'the station: Sunday has started');
  // and each part's config can stand in for locationConfig
  assert.equal(leeds.config.businessDayStart, '06:30');
  assert.equal(station.config.businessDayStart, '00:00');
});

test('hours are each site\'s own wall clock: noon in Leeds and noon in Utah are both 12:00', () => {
  const { scope, sites } = shellSites(['leeds', 'cabin']);
  const rows = [check('leeds', '2026-10-02T11:00:00Z', 10), check('cabin', '2026-10-02T18:00:00Z', 20)];
  const parts = siteParts({ sites, scope, checks: rows });
  for (const p of parts) {
    const { byHour } = daypartGrid(p.rows, p.clock);
    assert.equal(byHour.findIndex((v) => v > 0), 12, p.name);
  }
  // on ONE clock (the old way) the Utah sale would have been 19:00
  assert.equal(daypartGrid(rows, parts[0].clock).byHour[19], 20);
});

test('each site keeps its own comparison, and a previous period that did not load is never "New"', () => {
  const { scope, sites } = shellSites(['leeds', 'cabin'], 'today');
  const ok = siteParts({ sites, scope, checks: [], compare: sites[0].range.compare });
  assert.equal(ok[0].compare, sites[0].range.compare);
  assert.equal(ok[1].compare, sites[1].range.compare);
  assert.notEqual(ok[0].compare.from.getTime(), ok[1].compare.from.getTime(), 'cut on each site\'s own clock');
  const bad = siteParts({ sites, scope, checks: [], compare: { ...sites[0].range.compare, loaded: false } });
  assert.equal(bad[0].compare.loaded, false);
  assert.equal(bad[1].compare.loaded, false);
});

// ── 4: currencies ────────────────────────────────────────────────────────────

test('one block per currency; a site with no currency is a block of its own', () => {
  const { scope, sites } = shellSites(['leeds', 'station', 'cabin']);
  const parts = siteParts({ sites, scope, checks: [] });
  const blocks = currencyBlocks(parts);
  assert.deepEqual(Object.fromEntries(blocks.map((b) => [b.currency, b.parts.map((p) => p.id).sort()])), { GBP: ['leeds', 'station'], USD: ['cabin'] });
  assert.equal(blocks.find((b) => b.currency === 'GBP').fmt(1234.5), '£1234.50');
  assert.equal(blocks.find((b) => b.currency === 'USD').fmt(80), '$80.00');
  assert.equal(scope.canShowCombinedTotal, false);
  // nobody knows two sites' currency: they are never added to each other either
  const unknown = currencyBlocks([{ id: 'a', name: 'A', currency: null }, { id: 'b', name: 'B', currency: null }, { id: 'c', name: 'C', currency: 'GBP' }]);
  assert.equal(unknown.length, 3);
  assert.equal(blockTitle(unknown[0]), 'Currency not set: A');
  assert.equal(blockTitle(unknown[2]), 'GBP sites');
});

// ── 5: the group total ───────────────────────────────────────────────────────

test('the group total is the sites added up, and matches the figures over every row', () => {
  const { scope, sites } = shellSites(['leeds', 'station']);
  const rows = [
    check('leeds', '2026-10-02T09:00:00Z', 12.5, { tip: 1, covers: 2, discounts: [{ amount: 1.25 }] }),
    check('leeds', '2026-10-03T09:00:00Z', 8, { refunds: [{ amount: 3, tipAmount: 1 }] }),
    check('station', '2026-10-02T09:00:00Z', 4.75),
    check('station', '2026-10-03T09:00:00Z', 20, { status: 'voided' }),
  ];
  const parts = siteParts({ sites, scope, checks: rows });
  const per = parts.map((p) => computeSalesStats(p.rows));
  const fields = ['gross', 'discounts', 'voids', 'refunds', 'refundsItems', 'tips', 'total', 'covers', 'count', 'net'];
  const group = sumFields(per, fields);
  const whole = computeSalesStats(rows);
  for (const f of fields) assert.ok(Math.abs(group[f] - whole[f]) < 1e-9, f);
  assert.equal(group.count, 3);
  // and one site's figures are exactly its own rows' figures
  assert.deepEqual(per[0], computeSalesStats(rows.filter((r) => r.siteId === parts[0].id)));
});

test('keyedMatrix: a column per site, the total first seen biggest, nothing lost', () => {
  const parts = [{ id: 'a' }, { id: 'b' }];
  const cells = { a: { card: 10, cash: 5 }, b: { card: 1, voucher: 30 } };
  const m = keyedMatrix(parts, (p) => cells[p.id]);
  assert.deepEqual(m.rows.map((r) => r.key), ['voucher', 'card', 'cash']);
  assert.deepEqual(m.rows.find((r) => r.key === 'card'), { key: 'card', bySite: { a: 10, b: 1 }, total: 11 });
  assert.deepEqual(m.bySite, { a: 15, b: 31 });
  assert.equal(m.total, 46);
  // a fixed key order (hours, days) is kept, and a missing cell is zero
  assert.deepEqual(keyedMatrix(parts, (p) => cells[p.id], { keys: ['cash', 'card'] }).rows.map((r) => [r.key, r.total]), [['cash', 5], ['card', 11]]);
});

// ── 6: two people, one name ──────────────────────────────────────────────────

test('the same name at two sites is two keys, two rows', () => {
  assert.notEqual(siteNameKey('leeds', 'Sam'), siteNameKey('station', 'Sam'));
  assert.equal(siteNameKey('leeds', 'Sam'), siteNameKey('leeds', 'Sam'));
  const a = tagPartRows({ id: 'leeds', name: 'Leeds' }, [{ server: 'Sam', revenue: 10 }]);
  const b = tagPartRows({ id: 'station', name: 'Station' }, [{ server: 'Sam', revenue: 4 }]);
  const all = [...a, ...b];
  assert.equal(new Set(all.map((r) => r.siteKey)).size, 2);
  assert.deepEqual(all.map((r) => [r.siteName, r.server, r.revenue]), [['Leeds', 'Sam', 10], ['Station', 'Sam', 4]]);
  // the Servers report rolls people up once per site, on that site's clock
  const src = read('../backoffice/sections/reports/Servers.jsx');
  assert.match(src, /tagPartRows\(p, rollUp\(p\.rows, p\.clock\)\)/);
  assert.match(src, /key=\{r\.siteKey\}/);
});

test('column headings drop the words every site name starts with, never a whole name', () => {
  assert.deepEqual(shortSiteNames(['Coffee Boy Leeds', 'Coffee Boy Barnsley Train Station', 'coffee boy Preston']), ['Leeds', 'Barnsley Train Station', 'Preston']);
  assert.deepEqual(shortSiteNames(['Coffee Boy', 'Coffee Boy Leeds']), ['Boy', 'Boy Leeds']);
  assert.deepEqual(shortSiteNames(['Leeds', 'The Cabin']), ['Leeds', 'The Cabin']);
  assert.deepEqual(shortSiteNames(['Leeds', 'Leeds']), ['Leeds', 'Leeds'], 'two sites with one name keep it');
  assert.deepEqual(shortSiteNames(['Coffee Boy Leeds']), ['Coffee Boy Leeds'], 'one site: nothing to shorten against');
  const { scope, sites } = shellSites(['leeds', 'station']);
  assert.deepEqual(siteParts({ sites, scope }).map((p) => [p.name, p.short]), [
    ['Coffee Boy Barnsley Train Station', 'Barnsley Train Station'], ['Coffee Boy Leeds', 'Leeds'],
  ]);
});

// ── 7: the Site column ───────────────────────────────────────────────────────

test('every multi site CSV has Site as its first column', () => {
  const csv = toCsv([{ siteName: 'Leeds', method: 'card' }], withSiteColumn([{ label: 'Method', key: 'method' }]));
  assert.equal(csv, 'Site,Method\r\nLeeds,card');
  assert.match(read('../backoffice/sections/reports/_siteSplit.js'), /toCsv\(rows, withSiteColumn\(columns\)\)/);
  const dir = '../backoffice/sections/reports/';
  for (const f of ['SalesSummary', 'DailyTrend', 'OrderTypes', 'Payments', 'Daypart', 'Servers', 'Shifts', 'Exceptions', 'Tables']) {
    assert.match(read(`${dir}${f}.jsx`), /exportSites\(/, f);
  }
});

// ── 8: the server day sums ───────────────────────────────────────────────────

const sumRow = (o) => daySumRow({ currency: 'GBP', timezone: 'Europe/London', day_start: '06:30', ...o });

test('day sums mean what the browser figures mean: trend, order types, payments', () => {
  // Leeds, 2 Oct: 3 live checks (10 card dine in tip 1, 6 cash takeaway, 4 "Card " dine in) and a void
  const row = sumRow({
    location_id: 'leeds', business_day: '2026-10-02', checks: 3, voided_checks: 1, covers: 5, total: 20, tips: 0.5,
    by_order_type: { 'dine-in': { checks: 2, revenue: 14 }, takeaway: { checks: 1, revenue: 6 } },
    by_method: { card: { checks: 1, revenue: 10, tips: 1 }, cash: { checks: 1, revenue: 6, tips: 0 }, stripe_terminal: { checks: 1, revenue: 4, tips: 0 } },
  });
  const shaped = shapeDaySums([row], [{ id: 'leeds', name: 'Leeds', currency: 'GBP' }], { fromDay: '2026-10-02', toDay: '2026-10-03' });
  const day = shaped.sites[0].days[0];
  // Daily trend: revenue = every live check's total; tips as taken (not net of refunds)
  assert.deepEqual(trendFromSums(day), { revenue: 20, covers: 5, checks: 3, tips: 1, voids: 1 });
  assert.deepEqual(trendFromSums(shaped.sites[0].days[1]), { revenue: 0, covers: 0, checks: 0, tips: 0, voids: 0 }, 'a day with no sale is zeros, not missing');
  assert.deepEqual(trendFromSums(null), { revenue: 0, covers: 0, checks: 0, tips: 0, voids: 0 });
  assert.deepEqual(orderTypesFromSums(shaped.sites[0].totals), {
    'dine-in': { type: 'dine-in', checks: 2, revenue: 14 }, takeaway: { type: 'takeaway', checks: 1, revenue: 6 },
  });
  // Payments folds spellings the way the report's own bucket does
  const bucket = (m) => (m === 'cash' ? 'cash' : (m === 'card' || m.includes('stripe') || m.includes('terminal')) ? 'card' : m || 'other');
  assert.deepEqual(methodsFromSums(shaped.sites[0].totals, bucket), {
    card: { method: 'card', revenue: 14, count: 2, tips: 1 }, cash: { method: 'cash', revenue: 6, count: 1, tips: 0 },
  });
});

test('day sums: each part gets its own site\'s sums; a comparison cut part way through a day shows no percent', () => {
  const { scope, sites, range } = shellSites(['leeds', 'station'], 'this-month');
  const rows = [
    sumRow({ location_id: 'leeds', business_day: '2026-10-02', checks: 2, total: 30, net_sales: 30 }),
    sumRow({ location_id: 'station', business_day: '2026-10-02', day_start: '00:00', checks: 1, total: 7, net_sales: 7 }),
  ];
  const current = shapeDaySums(rows, sites, { fromDay: range.fromDay, toDay: range.toDay });
  const previous = shapeDaySums([sumRow({ location_id: 'leeds', business_day: '2026-09-02', checks: 1, total: 10, net_sales: 10 })], sites, { fromDay: '2026-09-01', toDay: '2026-09-05' });
  const whole = siteParts({ sites, scope, daySums: { available: true, current, previous, compareCut: false } });
  assert.equal(whole.find((p) => p.id === 'leeds').sums.totals.stats.net, 30);
  assert.equal(whole.find((p) => p.id === 'station').sums.totals.stats.net, 7);
  assert.equal(whole.find((p) => p.id === 'leeds').prevSums.totals.stats.net, 10);
  assert.ok(whole.every((p) => p.compare && p.compare.loaded !== false));
  assert.deepEqual(whole.map((p) => p.rows.length), [0, 0], 'one source per screen: no rows beside the sums');
  // cut ("by 2pm"): the sums are whole days, so no previous figure and no percent at all
  const cut = siteParts({ sites, scope, daySums: { available: true, current, previous, compareCut: true } });
  assert.ok(cut.every((p) => p.compare === null && p.prevSums === null));
  // the comparison sums did not load: say so, never "New"
  const none = siteParts({ sites, scope, daySums: { available: true, current, previous: null, compareCut: false } });
  assert.ok(none.every((p) => p.compare.loaded === false));
});

test('the four money reports draw from the day sums for several sites over more than 7 days, and only then', () => {
  assert.deepEqual([...DAY_SUMS_REPORTS].sort(), ['daily_trend', 'order_types', 'payments', 'summary']);
  const two = [{ id: 'a' }, { id: 'b' }];
  const month = { fromDay: '2026-09-06', toDay: '2026-10-05' }, week = { fromDay: '2026-09-29', toDay: '2026-10-05' };
  for (const v of DAY_SUMS_REPORTS) {
    assert.equal(figuresFrom(v, two, month, { available: true }), 'sums', v);
    assert.equal(figuresFrom(v, two, week, { available: true }), 'rows', v);
    assert.equal(figuresFrom(v, [{ id: 'a' }], month, { available: true }), 'rows', v);
    // Peter has not run the SQL yet: the browser read, under the row budget
    assert.equal(figuresFrom(v, two, month, { available: false, reason: 'not_installed' }), 'rows', v);
    assert.equal(figuresFrom(v, two, month, { available: null }), 'rows', v);
  }
  for (const v of ['servers', 'shifts', 'exceptions', 'tables', 'daypart', 'order_sources', 'transactions']) {
    assert.equal(figuresFrom(v, two, month, { available: true }), 'rows', v);
  }
  // the sums cannot be cut down to one server or order type: the shell clears those filters
  assert.match(read('../backoffice/sections/BOReports.jsx'), /setServerFilter\('all'\); setOrderTypeFilter\('all'\); setSourceFilter\('all'\);\s+setDaySums\(sums\);/);
});

// ── 9: the lock ──────────────────────────────────────────────────────────────

test('refunds, receipts and writes are locked to the signed in site', () => {
  const { scope } = shellSites(['leeds', 'station']);
  assert.equal(actionLock({ id: 'c1', siteId: 'leeds', siteName: 'Coffee Boy Leeds' }, scope), null);
  const lock = actionLock({ id: 'c2', siteId: 'station', siteName: 'Coffee Boy Barnsley Train Station' }, scope);
  assert.equal(lock.siteId, 'station');
  assert.equal(lock.text, 'This sale belongs to Coffee Boy Barnsley Train Station. Refunds and receipts are only done from the site you are signed in to. Sign in to Coffee Boy Barnsley Train Station to refund it or send its receipt.');
  // a row with no tag but another site's location id is locked too; the name comes from the scope
  assert.equal(actionLock({ id: 'c3', locationId: 'station' }, scope).siteName, 'Coffee Boy Barnsley Train Station');
  // the till's own live sale (no site on it) and a screen with no scope: as it always was
  assert.equal(actionLock({ id: 'c4' }, scope), null);
  assert.equal(actionLock({ id: 'c5', siteId: 'station' }, null), null);
  assert.equal(actionLock(undefined, scope), null);
  // ONE other site ticked is still another site
  const other = shellSites(['station']).scope;
  assert.ok(actionLock({ id: 'c6', siteId: 'station' }, other));
});

test('pin: Transactions checks the lock before every action, and shows the line in place of the buttons', () => {
  const src = read('../backoffice/sections/Transactions.jsx');
  for (const fn of ['openEmailForm', 'sendReceipt', 'openRefund']) {
    assert.match(src, new RegExp(`const ${fn} = (async )?\\(check\\) => \\{\\s+if \\(actionLock\\(check, scope\\)\\) return;`), fn);
  }
  assert.match(src, /if \(actionLock\(refundTarget, scope\)\) return;/);
  assert.match(src, /if \(actionLock\(parentChecks\.find\(c => c\.id === checkId\), scope\)\) return;/);
  assert.match(src, /\{canRefund && !lock && \(/);
  assert.match(src, /\{canRetry && !lock && \(/);
  assert.match(src, /\{!lock && <div style=\{\{ marginBottom: 12 \}\}>/);
  assert.match(src, /\{lock\.text\}/);
  assert.match(src, /\{multi && <th style=\{thStyle\}>Site<\/th>\}/);
});
