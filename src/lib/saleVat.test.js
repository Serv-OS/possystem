// saleVat.test.js: the ONE rule for "the VAT of a sale" in every report (8 Oct 2026).
// Run: `npm test`, or `node --test src/lib/saleVat.test.js`.
//
// The VAT audit of 8 Oct 2026 reconciled the released reports over live Coffee Boy rows and
// found them apart: Leeds Sun 4 Oct, records 195.77 (sum of tax_amount less refund VAT made that
// day); Tax summary tile 198.19 (refunds never taken off, +2.42); Daily trading 194.97 (refunds
// off, loyalty VAT share 0.80 dropped); Owner app 197.39 (loyalty dropped, refunds kept). The
// one sale with no VAT (Preston QR-4OGI7) read as 0 everywhere and nothing said so.
//
// These tests type a day in that shape (the audit's rows, trimmed to the columns the rule reads)
// and pin that every report now reads the same VAT: the shared ledger (Tax summary), the Sales
// summary stats, Daily trading's tradingDays, the Owner and Manager apps' addCheckSales with
// addRefundSales, and the accounting day Xero posts from. Where two figures differ on purpose
// (the loyalty VAT, D1) the difference is exactly the credit VAT the accounting layer names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSale, saleVatAmount, saleVatRecorded, saleVatFlags, saleVatLedger, refundVatOf, refundInRange, refundTaxBasis,
  noVatLine, noRecordLine, flaggedLines, toAccountingRow, roundPence, isUsableRecord, hasRateLines, SALE_VAT_FLAGS, LOYALTY_VAT_LINE,
} from '../../supabase/functions/_shared/saleVat.js';
import { buildAccountingDay, creditTaxMinor, checkTaxRecorded } from '../../supabase/functions/_shared/accountingDay.js';
import { tradingDays } from '../../supabase/functions/_shared/tradingSales.js';
import { emptySales, addCheckSales, addRefundSales, refundMadeAt } from '../../supabase/functions/_shared/snapshotSales.js';
import { businessDayWindow, businessDayOf } from '../../supabase/functions/_shared/businessDay.js';
import { computeSalesStats, vatMissingLine } from './salesStats.js';
import { taxAnalysisOf } from './reportSiteMenu.js';
import { refundTaxAmount } from './payments/refundMath.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);
const STD = { id: 'r20', code: 'VAT20', name: 'Standard Rate', rate: 0.2, type: 'inclusive', active: true, isDefault: true };
const RATES = [{ id: 'r20', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true }];
const record = (gross, tax, extra = {}) => ({ subtotal: gross - tax, totalTax: tax, total: gross, exclusiveTax: 0, hasExclusiveTax: false, source: 'legacy', breakdown: [{ rate: STD, tax, net: gross - tax, gross, items: 1 }], ...extra });
const card = (amount, tip = 0) => ({ method: 'card', amount, tip, processor: 'adyen' });

// ── Leeds, Sun 4 Oct 2026, in the audit's shape (06:30 business day) ───────────────────────────
const UK = { timezone: 'Europe/London', dayStart: '06:30' };
const DAY = '2026-10-04';
const T = (hhmm) => `2026-10-04T${hhmm}:00Z`;
const rows = [
  // ordinary card sales: 6.00 at 20% books 1.00
  { id: 'c1', ref: 'R1', closed_at: T('08:00'), subtotal: 6, total: 6, tip: 0, service: 0, tax_amount: 1, tax_breakdown: record(6, 1), tenders: [card(6)], items: [{ price: 6, qty: 1 }], refunds: [] },
  { id: 'c2', ref: 'R2', closed_at: T('09:00'), subtotal: 12, total: 12, tip: 0, service: 0, tax_amount: 2, tax_breakdown: record(12, 2), tenders: [card(12)], items: [{ price: 12, qty: 1 }], refunds: [] },
  // a free stamp card drink: the till books full price and full VAT, the tender is loyalty (D1)
  { id: 'c3', ref: 'R3', closed_at: T('10:00'), subtotal: 4.8, total: 4.8, tip: 0, service: 0, tax_amount: 0.8, tax_breakdown: record(4.8, 0.8), tenders: [{ method: 'loyalty', amount: 4.8, tip: 0 }], items: [{ price: 4.8, qty: 1 }], refunds: [] },
  // a sale refunded the same day, the till saved the refund's VAT: 14.52 at 20% = 2.42
  { id: 'c4', ref: 'R4', closed_at: T('11:00'), subtotal: 14.52, total: 14.52, tip: 0, service: 0, tax_amount: 2.42, tax_breakdown: record(14.52, 2.42), tenders: [card(14.52)],
    items: [{ price: 14.52, qty: 1 }], refunds: [{ id: 'f1', amount: 14.52, taxAmount: 2.42, tipAmount: 0, serviceAmount: 0, timestamp: T('12:00'), tenderMethod: 'card', cardStatus: 'succeeded', isFullRefund: true, legs: [{ status: 'succeeded', amountMinor: 1452 }] }] },
  // QR-4OGI7: goods sold, NO VAT recorded, no record
  { id: 'c5', ref: 'QR-4OGI7', closed_at: T('12:18'), subtotal: 4.85, total: 4.85, tip: 0, service: 0, tax_amount: null, tax_breakdown: [], tenders: [card(4.85)], source: 'qr', items: [{ itemId: 'm1', price: 4.85, qty: 1 }], refunds: [] },
  // a voided sale: counts for nothing
  { id: 'c6', ref: 'R6', closed_at: T('13:00'), subtotal: 9, total: 9, tip: 0, service: 0, tax_amount: null, status: 'voided', voided: true, tenders: [], items: [{ price: 9, qty: 1 }], refunds: [] },
];
// The figures the audit called "records": sum of tax_amount (6.22) less refund VAT made that day (2.42).
const SALES_VAT = 1 + 2 + 0.8 + 2.42;
const REFUND_VAT = 2.42;
const RECORDS = SALES_VAT - REFUND_VAT;
const LOYALTY_VAT = 0.8;

// The store's copy of a row (camelCase, db.js fetchClosedChecks).
const camel = (r) => ({
  id: r.id, ref: r.ref, closedAt: Date.parse(r.closed_at), subtotal: r.subtotal, total: r.total, tip: r.tip, service: r.service,
  taxAmount: r.tax_amount, ...(r.tax_breakdown && !Array.isArray(r.tax_breakdown) ? { taxBreakdown: r.tax_breakdown } : {}),
  status: r.status || 'paid', voided: r.voided, items: r.items, refunds: r.refunds, tenders: r.tenders, method: 'card', source: r.source || 'pos', orderType: 'dine-in',
});

test('reading a row: either shape, the figure booked, never 0 for null', () => {
  for (const row of [rows[4], camel(rows[4])]) {
    assert.equal(saleVatAmount(row), null);
    assert.equal(saleVatRecorded(row), false);
    assert.equal(readSale(row).goods, 4.85);
  }
  for (const row of [rows[0], camel(rows[0])]) {
    assert.equal(saleVatAmount(row), 1);
    assert.equal(saleVatRecorded(row), true);
  }
  // a zero rated sale is recorded (0 is a figure)
  assert.equal(saleVatRecorded({ tax_amount: 0, items: [{ price: 2, qty: 1 }] }), true);
  assert.equal(isUsableRecord(record(6, 1)), true);
  assert.equal(isUsableRecord([]), false);
  assert.equal(hasRateLines({ totalTax: 1, breakdown: [] }), false);
  assert.equal(roundPence(1.6749999999999998), 1.68);
  assert.equal(roundPence(-0.975), -0.98);
});

test('flags: no VAT, no record, a fallback line, a repaired record, a server figure, a record that does not add up', () => {
  assert.deepEqual(saleVatFlags(rows[4]).map((f) => f.code), [SALE_VAT_FLAGS.NO_VAT]);
  assert.deepEqual(saleVatFlags(rows[4], { hasRates: false }), [], 'a venue with no tax set up books nothing: not a fault');
  assert.deepEqual(saleVatFlags(rows[0]), []);
  assert.deepEqual(saleVatFlags(rows[5]), [], 'voided: never flagged');
  // Barnsley kiosk: the right figure with no split by rate
  assert.deepEqual(saleVatFlags({ tax_amount: 1.67, tax_breakdown: [], items: [{ price: 10, qty: 1 }] }).map((f) => f.code), [SALE_VAT_FLAGS.NO_RECORD]);
  // a D4 fallback, as Lane A records it
  const fb = saleVatFlags({ tax_amount: 1.33, items: [{ itemId: 'custom', name: 'Coffee beans', price: 7.95, qty: 1 }], tax_breakdown: record(7.95, 1.33, { fallbacks: [{ source: 'fallback', reason: 'custom-item', lineId: 'u1', itemId: 'custom', name: 'Coffee beans', rateId: null }] }) });
  assert.deepEqual(fb.map((f) => [f.code, f.reason, f.name]), [[SALE_VAT_FLAGS.FALLBACK, 'custom-item', 'Coffee beans']]);
  // the save time guard's repair (Lane C) and the server's figure (Lane B)
  assert.deepEqual(saleVatFlags({ tax_amount: 0.81, items: [{ price: 4.85, qty: 1 }], tax_breakdown: record(4.85, 0.81, { source: 'repair', repair: { reason: 'tax-missing' } }) }).map((f) => [f.code, f.reason]), [[SALE_VAT_FLAGS.REPAIR, 'tax-missing']]);
  assert.deepEqual(saleVatFlags({ tax_amount: 0.81, items: [{ price: 4.85, qty: 1 }], tax_breakdown: record(4.85, 0.81, { source: 'server', booked: 'server', reason: 'page-sent-none' }) }).map((f) => [f.code, f.reason]), [[SALE_VAT_FLAGS.SERVER, 'page-sent-none']]);
  // a record more than 1p from the figure booked
  assert.deepEqual(saleVatFlags({ tax_amount: 0.5, items: [{ price: 4.85, qty: 1 }], tax_breakdown: record(4.85, 0.81) }).map((f) => f.code), [SALE_VAT_FLAGS.MISMATCH]);
  // a half penny apart is not a mismatch
  assert.deepEqual(saleVatFlags({ tax_amount: 1.67, items: [{ price: 10.05, qty: 1 }], tax_breakdown: record(10.05, 1.675) }), []);
});

test('refund VAT: the entry\'s own figure, else the sale\'s VAT pro rata (the app\'s rule), 0 and named when the sale has none', () => {
  assert.deepEqual(refundVatOf(rows[3].refunds[0], rows[3]), { amount: 2.42, estimated: false, noVat: false });
  // Huddersfield R5654: 4.15 of 20.10 refunded on another till, no taxAmount saved; the check's VAT 3.35 -> 0.69
  const hudds = { total: 20.1, tax_amount: 3.35, tenders: [card(20.1)], items: [{ price: 20.1, qty: 1 }] };
  assert.deepEqual(refundVatOf({ amount: 4.15, legs: [{ status: 'succeeded', amountMinor: 415 }] }, hudds), { amount: 0.69, estimated: true, noVat: false });
  // the same rule the till writes (payments/refundMath.refundTaxAmount), on the camel copy
  near(refundTaxAmount({ total: 20.1, taxAmount: 3.35, tenders: [card(20.1)] }, { amount: 4.15 }), 0.69);
  // a kiosk check whose total is net of a gift card: the basis is what the tenders settled
  assert.equal(refundTaxBasis({ total: 8, tip: 1, tenders: [{ method: 'gift_card', amount: 3 }, card(5, 1)] }), 8);
  assert.equal(refundTaxBasis({ total: 8, tip: 0, tenders: [{ method: 'gift_card', amount: 3 }, card(8)] }), 11);
  // the sale booked no VAT: the refund gives back 0 and says so
  assert.deepEqual(refundVatOf({ amount: 4.85 }, rows[4]), { amount: 0, estimated: true, noVat: true });
  // a refund that moved no money gives back nothing
  assert.deepEqual(refundVatOf({ amount: 5, taxAmount: 0.83, failed: true }, rows[0]), { amount: 0, estimated: false, noVat: false });
  assert.deepEqual(refundVatOf({ amount: 5, cardStatus: 'pending', tenderMethod: 'card' }, rows[0]), { amount: 0, estimated: false, noVat: false });
  // the refund's day: by the time it was made, else the sale's close
  const w = businessDayWindow(DAY, UK.timezone, UK.dayStart);
  assert.equal(refundInRange(rows[3].refunds[0], rows[3], w), true);
  assert.equal(refundInRange({ amount: 1, timestamp: '2026-10-05T12:00:00Z' }, rows[3], w), false);
  assert.equal(refundInRange({ amount: 1 }, rows[3], w), true);
  assert.equal(refundInRange({ amount: 1 }, rows[3], null), true);
});

test('the ledger: VAT on sales, refunds off on their day, VAT due, and the no VAT sale named in red', () => {
  const w = businessDayWindow(DAY, UK.timezone, UK.dayStart);
  for (const list of [rows, rows.map(camel)]) {
    const l = saleVatLedger(list, { range: w });
    assert.equal(l.count, 5, 'the voided sale counts for nothing');
    near(l.salesVat, SALES_VAT);
    near(l.refundVat, REFUND_VAT);
    near(l.vatDue, RECORDS);
    assert.deepEqual(l.noVat, [{ id: 'c5', ref: 'QR-4OGI7', total: 4.85 }]);
    assert.equal(l.noVatCount, 1);
    assert.equal(noVatLine(l), '1 sale has no VAT recorded: QR-4OGI7');
    assert.equal(noRecordLine(l), '');
    assert.deepEqual(flaggedLines(l), []);
  }
  // a refund made the next day is not this day's
  const later = rows.map((r) => (r.id === 'c4' ? { ...r, refunds: [{ ...r.refunds[0], timestamp: '2026-10-05T12:00:00Z' }] } : r));
  near(saleVatLedger(later, { range: w }).refundVat, 0);
  near(saleVatLedger(later).refundVat, REFUND_VAT, 'with no range every refund belongs');
  assert.equal(noVatLine({ noVatCount: 3, noVat: [{ ref: 'A' }, { ref: 'B' }] }), '3 sales have no VAT recorded: A, B and 1 more');
  assert.equal(LOYALTY_VAT_LINE.includes('loyalty rewards'), true);
  assert.ok(!/[–—]/.test(LOYALTY_VAT_LINE + noVatLine({ noVatCount: 1, noVat: [{ ref: 'A' }] })), 'no dashes');
});

test('the audit\'s reconciliation: every report reads the same VAT, and the only planned difference is the loyalty VAT it names', () => {
  const w = businessDayWindow(DAY, UK.timezone, UK.dayStart);
  const dayOf = (ms) => businessDayOf(ms, UK.timezone, UK.dayStart);

  // 1. The Tax summary (the shared ledger): records.
  const tax = taxAnalysisOf(rows.map(camel), (c) => (c.taxBreakdown ? { ...c.taxBreakdown, source: 'booked' } : { totalTax: 0, subtotal: c.total, breakdown: [], source: 'rates' }), { range: w, hasRates: true });
  near(tax.salesVat, SALES_VAT, 'Tax summary VAT on sales');
  near(tax.refundVat, REFUND_VAT, 'Tax summary VAT refunded');
  near(tax.vatDue, RECORDS, 'Tax summary VAT due');
  near(tax.displayTax, RECORDS);
  assert.equal(tax.ledger.noVatCount, 1);
  assert.deepEqual(tax.rateRows.map((r) => r.label), ['Standard Rate'], 'rates are named, never "Unrated"');
  assert.equal(tax.sources.booked, 4, 'four sales stored their split by rate');
  assert.deepEqual(tax.varianceSales, [{ id: 'c5', ref: 'QR-4OGI7', diff: 0 }].filter(() => false), 'a sale with no VAT is named in red, not as a variance');

  // 2. The Business summary (computeSalesStats): the same, and the no VAT sale named.
  const stats = computeSalesStats(rows.map(camel));
  near(stats.tax, RECORDS, 'Business summary tax');
  assert.equal(vatMissingLine(stats), '1 sale has no VAT recorded: QR-4OGI7');

  // 3. Daily trading (tradingDays): money tenders only, so the loyalty VAT is off; the day names the no VAT sale.
  const td = tradingDays({ saleRows: rows, refundRows: rows.filter((r) => r.refunds.length), dayOf })[DAY];
  near(td.vat, RECORDS - LOYALTY_VAT, 'Daily trading VAT');
  assert.equal(td.no_vat, 1);
  assert.deepEqual(td.no_vat_refs, ['QR-4OGI7']);

  // 4. The Owner and Manager apps (addCheckSales + addRefundSales): the same as Daily trading, to the penny.
  const app = emptySales();
  for (const r of rows) {
    addCheckSales(app, r);
    for (const e of r.refunds) if (dayOf(refundMadeAt(e, r)) === DAY) addRefundSales(app, e, r);
  }
  near(app.vat, td.vat, 'Owner app VAT equals Daily trading');
  near(app.net, td.net, 'Owner app net sales equal Daily trading');
  near(app.refunds, td.refunds);
  near(app.refund_vat, td.refund_vat);
  assert.equal(app.vat_missing, 1);
  assert.deepEqual(app.vat_missing_refs, ['QR-4OGI7']);

  // 5. The accounting day Xero posts from: the same VAT as Daily trading, and the day is HELD for the no VAT sale.
  const acc = buildAccountingDay({ day: w, saleRows: rows, refundRows: rows.filter((r) => r.refunds.length), venue: UK, taxRates: RATES });
  near((acc.sales.totals.tax - acc.refunds.totals.tax) / 100, td.vat, 'Xero VAT equals Daily trading');
  assert.deepEqual(acc.holds.map((h) => h.code), ['vat_not_recorded']);
  assert.match(acc.holds[0].message, /1 sale has no VAT recorded: QR-4OGI7/);
  assert.ok(acc.warnings.some((x) => x.code === 'tax_not_recorded' && x.count === 1 && x.checkIds.includes('c5')));

  // 6. The planned difference, named: the VAT the till booked on goods paid with rewards.
  near(RECORDS - td.vat, LOYALTY_VAT);
  near(rows.reduce((s, r) => s + creditTaxMinor(r), 0) / 100, LOYALTY_VAT, 'creditTaxMinor names it');
  near(rows.map(camel).reduce((s, c) => s + creditTaxMinor(toAccountingRow(c)), 0) / 100, LOYALTY_VAT, 'from the store copy too');
  assert.equal(checkTaxRecorded(rows[4]), false);
});

test('toAccountingRow: a store copy reads as a database row for the accounting layer', () => {
  const r = toAccountingRow(camel(rows[2]));
  assert.equal(r.tax_amount, 0.8);
  assert.deepEqual(r.tenders, [{ method: 'loyalty', amount: 4.8, tip: 0 }]);
  assert.equal(r.closed_at, '2026-10-04T10:00:00.000Z');
  assert.equal(toAccountingRow(rows[2]), rows[2], 'a database row is returned as it is');
});
