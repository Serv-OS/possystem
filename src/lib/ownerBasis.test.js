/**
 * ownerBasis.test.js: the Owner app's Net / Gross switch.
 * Run: `npm test`, or `node --test src/lib/ownerBasis.test.js`.
 *
 * 16 Oct 2026, Peter: "the owner app needs a switch to show net or gross sales". The figures are
 * the function's (gross beside net, src/lib/ownerSnapshot.test.js); this is the app's side: the
 * remembered switch, which figure each card draws, the words under it, and an older function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OWNER_BASIS_KEY, OWNER_BASES, DEFAULT_BASIS, BASIS_CHIPS, grossNeedsUpdate, ownerBasis, readStoredBasis, storeBasis,
  canGross, shownBasis, taxWord, basisLabel, salesLabel, cardLines, topItemsNote, reportNotes, salesWord, salesHeading,
  basisCompare, basisHours, basisWeek, basisRows, detailBasis, detailTotals, venueSales, rollupSales,
} from './ownerBasis.js';
import { venueView, rollupView } from './ownerPeriod.js';
import { compareLine, groupLine } from './ownerCompare.js';

const read = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const memory = (seed = {}) => { const m = new Map(Object.entries(seed)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

// ── the switch ───────────────────────────────────────────────────────────────

test('the switch: Net and Gross, Net by default (what every figure showed before)', () => {
  assert.deepEqual(OWNER_BASES, ['net', 'gross']);
  assert.equal(DEFAULT_BASIS, 'net');
  assert.deepEqual(BASIS_CHIPS.map((c) => [c.id, c.label]), [['net', 'Net'], ['gross', 'Gross']]);
  for (const v of [undefined, null, '', 'GROSS', 'total', 42]) assert.equal(ownerBasis(v), 'net');
  assert.equal(ownerBasis('gross'), 'gross');
});

test('the switch is remembered on this phone, and a phone that will not store it starts on Net', () => {
  const s = memory();
  assert.equal(readStoredBasis(s), 'net');
  assert.equal(storeBasis(s, 'gross'), true);
  assert.equal(s.m.get(OWNER_BASIS_KEY), 'gross');
  assert.equal(readStoredBasis(s), 'gross');
  // Rubbish in storage reads as the default; rubbish handed in is stored as the default.
  assert.equal(readStoredBasis(memory({ [OWNER_BASIS_KEY]: 'sideways' })), 'net');
  storeBasis(s, 'nonsense');
  assert.equal(s.m.get(OWNER_BASIS_KEY), 'net');
  // Private browsing: storage that throws on every touch, or none at all.
  const closed = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(readStoredBasis(closed), 'net');
  assert.equal(storeBasis(closed, 'gross'), false);
  assert.equal(readStoredBasis(null), 'net');
  assert.equal(storeBasis(undefined, 'gross'), false);
});

// ── an older function ────────────────────────────────────────────────────────

test('Gross only from a function that sends it: otherwise net, under net words, with one line', () => {
  const now = { features: ['period', 'compare', 'gross'] }, old = { features: ['period', 'compare'] };
  assert.equal(canGross(now), true);
  assert.equal(canGross(old), false);
  assert.equal(canGross({}), false);
  assert.deepEqual(shownBasis(now, 'gross'), { basis: 'gross', needsUpdate: false });
  assert.deepEqual(shownBasis(old, 'gross'), { basis: 'net', needsUpdate: true });
  assert.deepEqual(shownBasis(old, 'net'), { basis: 'net', needsUpdate: false });
  // Before the first answer lands nothing is drawn, so nothing needs saying yet.
  assert.deepEqual(shownBasis(null, 'gross'), { basis: 'gross', needsUpdate: false });
  // The line says VAT at a pound venue and tax at a dollar one, as every other line does.
  assert.equal(grossNeedsUpdate('GBP'), 'Gross sales need a ServOS update. These figures exclude VAT.');
  assert.equal(grossNeedsUpdate('USD'), 'Gross sales need a ServOS update. These figures exclude tax.');
  assert.equal(grossNeedsUpdate(null), 'Gross sales need a ServOS update. These figures exclude VAT.');
});

// ── the words ────────────────────────────────────────────────────────────────

test('the line under a figure says which it is, so a screenshot is never ambiguous', () => {
  assert.equal(basisLabel('gross'), 'Including VAT');
  assert.equal(basisLabel('net'), 'Excluding VAT');
  assert.equal(basisLabel('gross', 'GBP'), 'Including VAT');
  assert.equal(basisLabel('net', 'EUR'), 'Excluding VAT');
  // A dollar venue charges sales tax, not VAT.
  assert.equal(taxWord('usd'), 'tax');
  assert.equal(basisLabel('gross', 'USD'), 'Including tax');
  // A headline figure is after refunds both ways. Daily trading's Gross column is BEFORE
  // refunds, so the words say it, and nobody reads the Owner app's Gross as that column.
  assert.equal(salesLabel('gross'), 'Including VAT, after refunds');
  assert.equal(salesLabel('net'), 'Excluding VAT, after refunds');
  assert.equal(salesLabel('gross', 'USD'), 'Including tax, after refunds');
  assert.equal(salesWord('gross'), 'Gross sales');
  assert.equal(salesWord('net'), 'Net sales');
  assert.equal(salesHeading('gross', 'today'), 'Gross sales today');
  assert.equal(salesHeading('net', 'week'), 'Net sales this week');
  assert.equal(salesHeading('gross', 'month'), 'Gross sales this month');
  // No long dashes anywhere in what the screen says.
  assert.doesNotMatch(read('./ownerBasis.js'), /[\u2013\u2014]/);
});

// ── every figure ─────────────────────────────────────────────────────────────

const venue = {
  ops_location_id: 'L', name: 'Leeds', currency: 'GBP',
  today: { net_sales: 26, vat: 4, gross_sales: 30, orders: 4, tips: 1, avg_check: 6.5, avg_check_gross: 7.5, forecast: 100, forecast_pct: 26, labour: 6, labour_pct: 23.08 },
  wtd: { net_sales: 70, last_week_net_sales: 40, vs_last_week_pct: 75, gross_sales: 84, last_week_gross_sales: 48, vs_last_week_pct_gross: 75 },
  top_items: [], period_top_items: [],
  period_totals: {
    net_sales: 66, vat: 12, gross_sales: 78, orders: 7, tips: 1, avg_check: 9.43, avg_check_gross: 11.14,
    forecast: 230, forecast_pct: 29, labour: 20, labour_pct: 30.3, cmp_net_sales: 40, vs_cmp_pct: 65, cmp_gross_sales: 48, vs_cmp_pct_gross: 63,
  },
};

test('a venue card: the sales, the average check and the old chip follow the switch; forecast and labour do not', () => {
  for (const period of ['today', 'week']) {
    const v = venueView(venue, period);
    const net = venueSales(venue, v, 'net'), gross = venueSales(venue, v, 'gross');
    if (period === 'today') {
      assert.deepEqual(net, { sales: 26, avg: 6.5, vs_pct: 75 });
      assert.deepEqual(gross, { sales: 30, avg: 7.5, vs_pct: 75 });
    } else {
      assert.deepEqual(net, { sales: 66, avg: 9.43, vs_pct: 65 });
      assert.deepEqual(gross, { sales: 78, avg: 11.14, vs_pct: 63 });
    }
    // The view itself (forecast, labour, orders) is the same either way.
    assert.equal(v.forecast_pct, period === 'today' ? 26 : 29);
  }
});

test('the group card: the sales, the old line figure and its percent follow the switch', () => {
  const r = {
    locations: 2, net_sales: 26, gross_sales: 30, vat: 4, forecast: 100, forecast_pct: 26, orders: 4, labour_pct: 23.08,
    live_orders: 1, open_tables: 0, wtd_net: 70, wtd_gross: 84, wtd_vs_last_week_pct: 75, wtd_vs_last_week_pct_gross: 74,
    period_totals: { net_sales: 66, gross_sales: 78, cmp_net_sales: 40, cmp_gross_sales: 48, vs_cmp_pct: 65, vs_cmp_pct_gross: 63, forecast: 230, forecast_pct: 29, orders: 7, labour_pct: 30.3, cmp_locations: 2 },
  };
  assert.deepEqual(rollupSales(r, rollupView(r, 'today'), 'net'), { sales: 26, before: 70, vs_pct: 75 });
  assert.deepEqual(rollupSales(r, rollupView(r, 'today'), 'gross'), { sales: 30, before: 84, vs_pct: 74 });
  assert.deepEqual(rollupSales(r, rollupView(r, 'month'), 'net'), { sales: 66, before: 40, vs_pct: 65 });
  assert.deepEqual(rollupSales(r, rollupView(r, 'month'), 'gross'), { sales: 78, before: 48, vs_pct: 63 });
});

test('the comparison line: the gross percent and pounds under Gross, through the same words', () => {
  const range = { cmp_to: '2026-09-25', cmp_time: '12:00' };
  const c = { period: 'today', reason: 'ok', pct: 30, net_sales: 26, cmp_net_sales: 20, gross_sales: 30, cmp_gross_sales: 24, pct_gross: 25 };
  assert.equal(compareLine(basisCompare(c, 'net'), range, 'today').text, '+30% vs last Friday by 12pm');
  assert.equal(compareLine(basisCompare(c, 'gross'), range, 'today').text, '+25% vs last Friday by 12pm');
  // The group line shows the comparison's pounds: gross under Gross.
  const g = { reason: 'ok', pct: -18, net_sales: 510, like_net_sales: 90, cmp_net_sales: 110, venues: 5, venues_compared: 3, venues_new: 1, gross_sales: 612, like_gross_sales: 108, cmp_gross_sales: 132, pct_gross: -18 };
  const gl = groupLine(basisCompare(g, 'gross'), range, 'today');
  assert.deepEqual([gl.amount, gl.pct], [132, '-18%']);
  assert.equal(groupLine(basisCompare(g, 'net'), range, 'today').amount, 110);
  // A grey reason stays grey both ways.
  const fresh = { period: 'today', reason: 'new', pct: null, net_sales: 400, cmp_net_sales: 0, gross_sales: 480, cmp_gross_sales: 0, pct_gross: null };
  assert.equal(compareLine(basisCompare(fresh, 'gross'), range, 'today').text, 'New this week');
  // A block with no gross figures draws no line under Gross (never a net percent under gross words).
  assert.equal(basisCompare({ period: 'today', reason: 'ok', pct: 30, net_sales: 26, cmp_net_sales: 20 }, 'gross'), null);
  assert.equal(basisCompare(null, 'gross'), null);
  // The block handed in is never changed.
  basisCompare(c, 'gross');
  assert.equal(c.pct, 30);
});

test('the detail screen: hours, week, order types and channels in the chosen basis, the shapes the charts read', () => {
  const hours = [{ hour: 8, net: 14.5, orders: 2, cmp_net: 20, gross: 17.4, cmp_gross: 24 }, { hour: 9, net: -5, orders: 0, cmp_net: 0, gross: -6, cmp_gross: 0 }];
  assert.equal(basisHours(hours, 'net'), hours);
  assert.deepEqual(basisHours(hours, 'gross').map((h) => [h.hour, h.net, h.cmp_net, h.orders]), [[8, 17.4, 24, 2], [9, -6, 0, 0]]);
  const week = [{ dow: 'Fri', net: 23.9, last_net: 50, gross: 28.2, last_gross: 60 }, { dow: 'Sat', net: null, last_net: 0, gross: null, last_gross: 0 }];
  assert.deepEqual(basisWeek(week, 'gross').map((w) => [w.dow, w.net, w.last_net]), [['Fri', 28.2, 60], ['Sat', null, 0]]);
  assert.equal(basisWeek(week, 'net'), week);
  // Biggest first under Gross too (VAT can reorder two close rows).
  const types = [{ type: 'takeaway', net: 13.5, gross: 13.5 }, { type: 'dine-in', net: 13, gross: 15.6 }];
  assert.deepEqual(basisRows(types, 'gross').map((r) => [r.type, r.net]), [['dine-in', 15.6], ['takeaway', 13.5]]);
  assert.equal(basisRows(types, 'net'), types);
  assert.deepEqual(basisRows(null, 'gross'), []);
});

test('the detail headline: Gross only when the answer carries it', () => {
  const totals = { net_sales: 23.9, vat: 4.3, gross_sales: 28.2, orders: 5, tips: 0, avg_check: 4.78, avg_check_gross: 5.64 };
  assert.equal(detailBasis({ totals }, 'gross'), 'gross');
  assert.equal(detailBasis({ totals }, 'net'), 'net');
  // A function from before the switch: no gross average, so net under net words.
  const { avg_check_gross: _gone, ...old } = totals;
  assert.equal(detailBasis({ totals: old }, 'gross'), 'net');
  assert.equal(detailBasis(null, 'gross'), 'net');
  assert.deepEqual(detailTotals(totals, 'gross'), { sales: 28.2, avg: 5.64, orders: 5, tips: 0 });
  assert.deepEqual(detailTotals(totals, 'net'), { sales: 23.9, avg: 4.78, orders: 5, tips: 0 });
});

test('a card never changes height on a tap: the line under the figure is one length both ways; the net note sits on the forecast', () => {
  const net = cardLines('net', 'GBP'), gross = cardLines('gross', 'GBP');
  assert.deepEqual(net, { line: 'Excluding VAT, after refunds', forecastSuffix: '', groupForecast: '' });
  assert.deepEqual(gross, { line: 'Including VAT, after refunds', forecastSuffix: ' net', groupForecast: ' on net' });
  assert.equal(net.line.length, gross.line.length);
  assert.equal(cardLines('net', 'USD').line.length, cardLines('gross', 'USD').line.length);
  // Short enough for one line at 11px in a 375px phone's venue card (about 250px across).
  assert.ok(gross.line.length <= 30);
  // Top items on a card are till prices: VAT in at a pound venue, so a screenshot under
  // 'Excluding VAT' never reads as ex VAT item money.
  assert.equal(topItemsNote('GBP'), ' · till prices, including VAT');
  assert.equal(topItemsNote('EUR'), ' · till prices, including VAT');
  assert.equal(topItemsNote('USD'), ' · till prices');
});

test('the report notes: which cards follow the switch, and the ones that do not say so', () => {
  const g = reportNotes('gross', 'GBP'), n = reportNotes('net', 'GBP'), us = reportNotes('gross', 'USD');
  assert.equal(g.sales, 'Including VAT, after refunds');
  assert.equal(n.sales, 'Excluding VAT, after refunds');
  // Order types are booked from sales only, so they are before refunds.
  assert.equal(g.types, 'Gross sales, including VAT, before refunds.');
  assert.equal(n.types, 'Net sales, excluding VAT, before refunds.');
  assert.equal(us.types, 'Gross sales, including tax, before refunds.');
  // Payment mix and the exceptions card are the same whatever the switch, and say it.
  for (const b of ['net', 'gross']) {
    assert.equal(reportNotes(b, 'GBP').payments, 'What each kind took for goods, including VAT, tips out. The Net / Gross switch does not change these.');
    assert.equal(reportNotes(b, 'GBP').exceptions, 'Including VAT. The Net / Gross switch does not change these.');
  }
  assert.equal(us.payments, 'What each kind took for goods, including tax, tips out. The Net / Gross switch does not change these.');
  assert.equal(us.exceptions, 'As rung up on the till. The Net / Gross switch does not change these.');
  for (const v of [...Object.values(g), ...Object.values(us)]) assert.doesNotMatch(v, /[\u2013\u2014]/);
});

// The JSX is not loaded by node:test, so these read the source, one card at a time: each card's
// own function body must draw its line from cardLines, so dropping it from one card fails here.
const body = (src, name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is in the file`);
  const next = src.indexOf('\nfunction ', at + 1);
  return src.slice(at, next < 0 ? undefined : next);
};

test('the screens use the switch: remembered, labelled on every card, and handed to the reports', () => {
  const surface = read('../surfaces/OwnerSurface.jsx');
  assert.match(surface, /readStoredBasis\(phoneStorage\(\)\)/);
  assert.match(surface, /storeBasis\(phoneStorage\(\), id\)/);
  assert.match(surface, /aria-label="Net or gross sales"/);
  // The switch is a full size tap target (44 points), not smaller than the period chips.
  assert.match(surface, /\.\.\.periodChip, minHeight: 44,/);
  assert.match(surface, /grossNeedsUpdate\(r\?\.currency \|\| 'GBP'\)/);
  // Two cards draw a sales figure, and each draws the one length line under it.
  assert.equal((surface.match(/<BasisLine /g) || []).length, 2);
  for (const card of ['GroupCard', 'VenueCard']) {
    const b = body(surface, card);
    assert.match(b, /const words = cardLines\(basis, /, card);
    assert.match(b, /<BasisLine text=\{words\.line\} \/>/, card);
  }
  assert.match(body(surface, 'GroupCard'), /% of forecast\{words\.groupForecast\}/);
  assert.match(body(surface, 'VenueCard'), /\{words\.forecastSuffix\}/);
  assert.match(body(surface, 'VenueCard'), /\{topItemsNote\(l\.currency\)\}/);
  assert.match(surface, /basis=\{basis\}/);
  const detail = read('../surfaces/owner/OwnerDetail.jsx');
  assert.match(detail, /detailBasis\(detail, basisAsked\)/);
  assert.match(body(detail, 'Summary'), /\{salesLabel\(basis, cur\)\}/);
  const reports = read('../surfaces/owner/OwnerReports.jsx');
  for (const f of ['basisHours', 'basisWeek', 'basisRows']) assert.match(reports, new RegExp(`${f}\\(`));
  assert.match(reports, /const notes = reportNotes\(basis, currency\)/);
  for (const n of ['notes.sales', 'notes.types', 'notes.payments', 'notes.exceptions']) assert.ok(reports.includes(n), n);
  assert.match(body(reports, 'PaymentsCard'), /note=\{note\}/);
  assert.match(body(reports, 'ExceptionsCard'), /note=\{note\}/);
});
