// 28 Sep 2026: the till's X and Z report (lib/shiftReport.js). 16 Oct 2026: on the one sales rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checksForBusinessDay, businessDayRange, summariseShift, buildShiftReportDoc } from './shiftReport.js';
import { salesBreakdown } from './salesBreakdown.js';
import { computeSalesStats } from './salesStats.js';
import { checkSalesParts, tradingDays } from '../../supabase/functions/_shared/tradingSales.js';
import { toAccountingRow } from '../../supabase/functions/_shared/saleVat.js';

const LON = 'Europe/London';
const at = (iso) => Date.parse(iso);

test('only the business day that now falls in, on the venue clock and day start', () => {
  const checks = [
    { id: 'a', closedAt: at('2026-09-28T05:10:00Z') },   // 06:10 BST, after a 06:00 start: today
    { id: 'b', closedAt: at('2026-09-28T04:50:00Z') },   // 05:50 BST: still yesterday's day
    { id: 'c', closed_at: '2026-09-28T11:00:00Z' },      // snake case row: today
    { id: 'd' },                                         // no close time: left out
  ];
  const got = checksForBusinessDay(checks, { now: at('2026-09-28T12:00:00Z'), timezone: LON, dayStart: '06:00' }).map((c) => c.id);
  assert.deepEqual(got, ['a', 'c']);
});

// 16 Oct 2026: the slip reads THE ONE SALES RULE (lib/salesBreakdown.js over _shared/tradingSales.js).
// The day below is Coffee Boy shaped, camelCase as the till holds closedChecks (lib/db.js
// mapClosedCheckRow): VAT inside the prices, free drinks paid with a loyalty reward, a staff
// discount, a cash sale with a tip, a voided check.
const DAY_FROM = Date.parse('2026-10-16T05:30:00Z');   // 06:30 BST business day start
const DAY_RANGE = { fromMs: DAY_FROM, toMs: Date.parse('2026-10-17T05:30:00Z') - 1 };
const card = (amount, tip = 0) => ({ method: 'card', amount, tip, processor: 'adyen' });
const cash = (amount, tip = 0) => ({ method: 'cash', amount, tip });
const loyalty = (amount) => ({ method: 'loyalty', amount, tip: 0, rewards: [{ name: 'Free Drink', item: 'Latte', amount }] });
const line = (price, qty = 1, extra = {}) => ({ name: 'Item', price, qty, ...extra });
let n = 0;
const sale = (o) => ({ id: `c${++n}`, ref: `R${100 + n}`, closedAt: DAY_FROM + n * 600000, status: 'paid', service: 0, tip: 0, covers: 1, discounts: [], refunds: [], method: 'card', ...o });
function theDay() {
  n = 0;
  return [
    sale({ items: [line(3.6), line(2.25, 2)], subtotal: 8.1, taxAmount: 1.35, tip: 0.5, total: 8.6, tenders: [card(8.1, 0.5)] }),
    sale({ items: [line(4.8)], subtotal: 4.8, taxAmount: 0.8, total: 4.8, tenders: [loyalty(4.8)], method: 'loyalty' }),
    sale({ items: [line(4.8), line(3.6)], subtotal: 8.4, taxAmount: 1.4, total: 8.4, tenders: [loyalty(4.8), card(3.6)] }),
    sale({ items: [line(10)], subtotal: 10, discounts: [{ type: 'percent', value: 20, amount: 2 }], taxAmount: 1.33, total: 8, tenders: [card(8)] }),
    sale({ items: [line(6)], subtotal: 6, taxAmount: 1, tip: 1, total: 7, tenders: [cash(6, 1)], method: 'cash' }),
    sale({ status: 'voided', items: [line(5, 1, { voided: true })], subtotal: 0, taxAmount: 0, total: 0, tenders: [] }),
  ];
}
const ownerNet = (rows) => rows.filter((r) => r.status !== 'voided').reduce((t, r) => t + Math.round(checkSalesParts(toAccountingRow(r)).net * 100), 0) / 100;

test('the slip figures are the Business summary, Daily trading and Owner app ones, to the penny', () => {
  const rows = theDay();
  const { sales, payments } = summariseShift(rows, { range: DAY_RANGE, currency: 'GBP' });
  assert.deepEqual(sales, salesBreakdown(rows, { range: DAY_RANGE, currency: 'GBP' }), 'the Business summary reading itself');
  // Money sales 8.10 + 3.60 + 8.00 + 6.00 = 25.70 including VAT; the two free Lattes are not sales.
  assert.equal(sales.sales, 25.7);
  assert.equal(sales.rewards, 9.6);
  assert.equal(sales.net, ownerNet(rows), 'the Owner app (checkSalesParts)');
  const td = tradingDays({ saleRows: rows.map(toAccountingRow), dayOf: () => 'D' }).D;
  assert.equal(sales.net, td.net, 'Daily trading');
  assert.equal(sales.tax, td.vat);
  assert.equal(sales.count, 5);
  assert.equal(sales.voidCount, 1);
  // Payments are the money tenders and add up to Money collected; a loyalty reward is never money.
  assert.deepEqual(payments.map((p) => [p.label, p.count, p.amount, p.tips]), [['Card', 3, 20.2, 0.5], ['Cash', 1, 7, 1], ['Gift card', 0, 0, 0]]);
  assert.equal(Math.round(payments.reduce((t, p) => t + p.amount, 0) * 100) / 100, sales.collected);
  assert.equal(sales.collected, 27.2);
});

test('before and after: the old slip printed subtotal less discounts as Net sales', () => {
  const rows = theDay();
  const old = computeSalesStats(rows);
  assert.equal(old.net, 35.3, 'before: VAT inside and the free Lattes counted');
  assert.equal(old.total, 36.8, 'before: the old total counted 9.60 of rewards as money');
  const { sales } = summariseShift(rows, { range: DAY_RANGE });
  assert.equal(sales.net, 21.42, 'after: net sales excluding VAT');
});

test('a refund made today on an older sale comes off today; a check in both lists counts once', () => {
  const rows = theDay();
  const older = {
    ...sale({ items: [line(6)], subtotal: 6, taxAmount: 1, total: 6, tenders: [card(6)] }), id: 'old', closedAt: DAY_FROM - 86400000,
    refunds: [{ id: 'r1', amount: 6, taxAmount: 1, tipAmount: 0, serviceAmount: 0, tenderMethod: 'card', cardStatus: 'accepted', timestamp: DAY_FROM + 3600000, legs: [{ status: 'succeeded', amountMinor: 600 }] }],
  };
  const { sales, payments } = summariseShift(rows, { range: DAY_RANGE, refundRows: [older, ...rows] });
  assert.equal(sales.refunds, 6);
  assert.equal(sales.refundCount, 1);
  assert.equal(sales.net, 16.42);
  assert.equal(payments[0].amount, 14.2, 'the card refund comes off Card');
  // The till passes ALL its checks as refundRows: today's sales are not read twice.
  assert.equal(summariseShift(rows, { range: DAY_RANGE, refundRows: rows }).sales.net, 21.42);
  // A refund made after the day does not come off this day.
  const later = { ...older, refunds: [{ ...older.refunds[0], timestamp: DAY_RANGE.toMs + 1 }] };
  assert.equal(summariseShift(rows, { range: DAY_RANGE, refundRows: [later] }).sales.refunds, 0);
});

test('businessDayRange is the venue business day that now falls in', () => {
  assert.deepEqual(businessDayRange({ now: at('2026-10-16T12:00:00Z'), timezone: LON, dayStart: '06:30' }), DAY_RANGE);
  assert.deepEqual(businessDayRange({ now: at('2026-10-17T05:00:00Z'), timezone: LON, dayStart: '06:30' }), DAY_RANGE, '06:00 next morning is still the 16th');
  assert.equal(businessDayRange({ now: NaN, timezone: LON, dayStart: '06:30' }), null);
});

test('a Z report prints the drawer; an X report says nothing is reset', () => {
  const { sales, payments } = summariseShift(theDay(), { range: DAY_RANGE });
  const base = { venueName: 'Coffee Boy Leeds', dayLabel: '2026-10-16', sales, payments, currency: 'GBP' };
  const z = JSON.stringify(buildShiftReportDoc({ ...base, kind: 'Z', drawer: { expected: 100, declared: 98.5, variance: -1.5 } }));
  assert.match(z, /Z REPORT/);
  assert.match(z, /Expected cash/);
  assert.match(z, /Variance \(short\)/);
  const x = JSON.stringify(buildShiftReportDoc({ ...base, kind: 'X' }));
  assert.match(x, /X REPORT/);
  assert.match(x, /nothing is reset/);
  assert.doesNotMatch(x, /Expected cash/);
});

// The printed text, one string per line, from the doc ops.
const textOf = (doc) => doc.ops.filter((o) => o.t === 'twoCol' || o.t === 'twoColTrunc' || o.t === 'text').map((o) => (o.t === 'text' ? o.s : `${o.l} | ${o.r}`));

test('the slip prints the Business summary ladder, VAT inside, payments adding up to Money collected', () => {
  const { sales, payments } = summariseShift(theDay(), { range: DAY_RANGE });
  const t = textOf(buildShiftReportDoc({ kind: 'X', sales, payments, currency: 'GBP' }));
  for (const want of [
    'Item sales (including VAT) | £42.30', 'less Voids | -£5.00', 'less Discounts | -£2.00', 'less Loyalty rewards | -£9.60',
    'less Refunds | £0.00', 'Sales including VAT | £25.70', '  of which VAT | £4.28', '  Net sales excluding VAT | £21.42',
    'plus Service | £0.00', 'plus Tips | £1.50', 'Money collected | £27.20',
    'Card (3) | £20.20', '  of which tips | £0.50', 'Cash (1) | £7.00', 'Gift card (0) | £0.00',
    'Checks | 5', 'Average check (excluding VAT) | £4.28',
  ]) assert.ok(t.includes(want), `missing "${want}" in\n${t.join('\n')}`);
  assert.ok(!t.some((l) => /Sales \(gross\)|VAT included|plus Tax/.test(l)), 'no old wording');
  // VAT on the two free Lattes is outside the VAT above, and the slip says so.
  assert.equal(sales.rewardsTax, 1.6);
  assert.ok(t.join(' ').includes('VAT on loyalty rewards £1.60 is not in the VAT above'));
});

test('a 58 mm slip (32 columns) says inc and ex so every label fits beside its amount', () => {
  const { sales, payments } = summariseShift(theDay(), { range: DAY_RANGE });
  const doc = buildShiftReportDoc({ kind: 'X', sales, payments, currency: 'GBP' }, { cols: 32 });
  const t = textOf(doc);
  assert.ok(t.includes('Item sales (inc VAT) | £42.30'));
  assert.ok(t.includes('  Net sales ex VAT | £21.42'));
  for (const o of doc.ops) {
    if (o.t === 'twoColTrunc') assert.ok(o.l.length + 1 + o.r.length <= 32, `"${o.l}" does not fit beside ${o.r}`);
  }
});

test('an empty day prints zeros, never a crash', () => {
  const { sales, payments } = summariseShift([], { range: DAY_RANGE });
  const t = textOf(buildShiftReportDoc({ kind: 'X', sales, payments, currency: 'GBP' }));
  assert.ok(t.includes('Money collected | £0.00'));
  assert.ok(t.includes('Card (0) | £0.00'));
  assert.ok(textOf(buildShiftReportDoc({ kind: 'X' })).includes('Money collected | £0.00'), 'no figures at all');
});

test('wiring: X report button in the drawer menu, Z report at a successful cash up', () => {
  const pos = fs.readFileSync(new URL('../surfaces/POSSurface.jsx', import.meta.url), 'utf8');
  assert.match(pos, /onClick=\{\(\) => \{ if \(!requirePerm\(\)\) return; setShowDrawerMenu\(false\); printShiftReportNow\('X'\); \}\}/);
  assert.match(pos, /if \(result\) \{\n\s*printShiftReportNow\('Z', \{ expected: result\.expected, declared: result\.declared, variance: result\.variance \}\);\n\s*signOutAfterCashUp\?\.\(\);/);
  // 16 Oct 2026: the one sales rule over the business day, with the till's older checks for refunds.
  assert.match(pos, /const \{ sales, payments \} = summariseShift\(checks, \{ range: businessDayRange\(\{ now, timezone, dayStart \}\), refundRows: st\.closedChecks, currency: cfg\.currency \}\);/);
  assert.match(pos, /printedBy: st\.staff\?\.name \|\| '', sales, payments, drawer, currency: cfg\.currency,/);
  const pr = fs.readFileSync(new URL('./printer.js', import.meta.url), 'utf8');
  assert.match(pr, /async printShiftReport\(report, printerId = null, opts = \{\}\)/);
});

test('28 Sep 2026: a dine-in order is never held back as a scheduled pre-order', () => {
  const store = fs.readFileSync(new URL('../store/index.js', import.meta.url), 'utf8');
  assert.match(store, /if \(!bypassSchedule && orderType !== 'dine-in' && customer\?\.collectionTime && !customer\?\.isASAP\) \{/);
});

test('16 Oct 2026: the Back Office Z report reads the same figures as the till slip', () => {
  const z = fs.readFileSync(new URL('../backoffice/sections/reports/ZReport.jsx', import.meta.url), 'utf8');
  assert.match(z, /const \{ sales, payments \} = useMemo\(\(\) => summariseShift\(checks, \{ range, refundRows, currency \}\), \[checks, range, refundRows, currency\]\);/);
  assert.match(z, /const lines = useMemo\(\(\) => breakdownLines\(sales\), \[sales\]\);/);
  assert.match(z, /<span>MONEY COLLECTED<\/span><span>\{fmt\(sales\.collected\)\}<\/span>/);
  assert.match(z, /const cash = payments\.find\(p => p\.kind === 'cash'\);/);
  // The old subtotal based figures are gone from the sales, total and payment lines.
  assert.doesNotMatch(z, /<span>GRAND TOTAL|stats\.total|stats\.net|stats\.gross|byMethod/);
  // Older sales' refunds made in the range are read for the same site as the Business summary.
  assert.match(z, /const siteId = one && !one\.isHome \? String\(one\.id\) : \(locationId \? String\(locationId\) : null\);/);
  const bo = fs.readFileSync(new URL('../backoffice/sections/BOReports.jsx', import.meta.url), 'utf8');
  assert.match(bo, /<ZReport [^>]*locationId=\{activeLocId\} filters=\{reportFilters\} locationConfig=\{locationConfig\}/);
});
