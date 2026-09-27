/**
 * tradingSales.test.js: the Daily trading (P&L) report's gross, VAT and net per check.
 * Run: `npm test`, or `node --test src/lib/tradingSales.test.js`.
 *
 * 27 Sep 2026: trading-report made gross = subtotal + tax_amount. A UK subtotal already
 * includes VAT, so gross takings were overstated by the VAT and net sales with them.
 * 27 Sep 2026: the subtotal is shelf prices before discounts, so a 50% staff discount or a
 * 100% comp showed as full price sales. Sales are now the goods the customer paid for, per
 * tender, read like the accounting day layer. Several rows below are real Coffee Boy Leeds
 * checks (26 and 27 Sep), trimmed to the columns the report reads.
 * 28 Sep 2026: refunds come off on the day of the refund, days are the venue BUSINESS day
 * (business_day_start, 06:30 at Coffee Boy), and a timesheet counts on the business day most
 * of the shift falls in (Peter's calls). tradingDays must agree with the accounting day layer
 * (what Xero is posted from) on every business day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkSalesParts, chargedNothing, recordedDiscountMinor, refundSalesParts, tradingDays, timesheetDayMs, timesheetDays,
} from '../../supabase/functions/_shared/tradingSales.js';
import { businessDayOf, businessDayWindow } from '../../supabase/functions/_shared/businessDay.js';
import { buildAccountingDay } from '../../supabase/functions/_shared/accountingDay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const parts = (row, gross, vat, net) => {
  const p = checkSalesParts(row);
  near(p.gross, gross);
  near(p.vat, vat);
  near(p.net, net);
  return p;
};
const card = (amount, tip = 0) => ({ method: 'card', amount, tip, processor: 'adyen' });
const pct100 = (amount) => ({ type: 'percent', label: 'Custom 100%', scope: 'check', value: 100, amount });

test('UK, no discount: gross is what was paid, net takes the VAT out', () => {
  // £12 of shelf prices at 20%: £2 VAT inside it.
  parts({ subtotal: 12, total: 12, tax_amount: 2, service: 0, tip: 0, tenders: [card(12)] }, 12, 2, 10);
});

test('UK staff 50% (v5.9.98 VAT on what was charged): half the sales, half the VAT', () => {
  // The shelf subtotal said £8.40 gross and £7.70 net. The customer paid £4.20.
  parts({
    subtotal: 8.4, total: 4.2, tax_amount: 0.7, service: 0, tip: 0,
    discounts: [{ type: 'percent', label: 'Staff Discount 50%', scope: 'check', value: 50, amount: 4.2 }],
    tenders: [card(4.2)],
  }, 4.2, 0.7, 3.5);
});

test('UK staff 50% closed before v5.9.98: VAT is read as booked, never recomputed', () => {
  // Leeds chk-1790503354909-a7ffb6: VAT was booked on the full £11.20. The tip is not sales.
  parts({
    subtotal: 11.2, total: 6.16, tax_amount: 1.87, service: 0, tip: 0.56,
    discounts: [{ type: 'percent', label: 'Staff Discount 50%', scope: 'check', value: 50, amount: 5.6 }],
    tenders: [card(5.6, 0.56)],
  }, 5.6, 1.87, 3.73);
});

test('100% comp from before v5.9.97 (phantom cash) sells nothing', () => {
  // Leeds chk-1790408579352-a20a98: total = subtotal and a cash tender for money never taken.
  const row = { subtotal: 4.1, total: 4.1, tax_amount: 0.68, service: 0, tip: 0, discounts: [pct100(4.1)], tenders: [{ method: 'cash', amount: 4.1, tip: 0 }] };
  assert.equal(chargedNothing(row), true);
  parts(row, 0, 0, 0);
});

test('100% comp from v5.9.97 on (£0 taken, no VAT) sells nothing', () => {
  parts({ subtotal: 4.1, total: 0, tax_amount: 0, service: 0, tip: 0, discounts: [pct100(4.1)], tenders: [{ method: 'cash', amount: 0, tip: 0 }] }, 0, 0, 0);
});

test('discounts that add up to the whole bill are a comp; anything less is not', () => {
  const two = { subtotal: 10, discounts: [{ amount: 6 }, { amount: 4 }] };
  assert.equal(chargedNothing(two), true);
  assert.equal(recordedDiscountMinor(two), 1000);
  assert.equal(chargedNothing({ subtotal: 10, discounts: [{ amount: 9.99 }] }), false);
  assert.equal(chargedNothing({ subtotal: 10, discounts: null }), false);
  assert.equal(chargedNothing({ subtotal: 10, discounts: [null, { amount: 'x' }, { amount: -20 }] }), false);
  assert.equal(chargedNothing({ subtotal: 0, discounts: [] }), false);
  // A 99p discount on a £10 bill is still £9.01 of sales.
  parts({ subtotal: 10, total: 9.01, tax_amount: 1.5, service: 0, tip: 0, discounts: [{ amount: 0.99 }], tenders: [card(9.01)] }, 9.01, 1.5, 7.51);
});

test('a drink paid in full by a loyalty reward is a discount, not takings', () => {
  // Leeds chk-1790501999278-037bf2 (method loyalty+cash, the only tender a loyalty one).
  parts({ subtotal: 2.95, total: 2.95, tax_amount: 0.49, service: 0, tip: 0, method: 'loyalty+cash', tenders: [{ method: 'loyalty', amount: 2.95, tip: 0 }] }, 0, 0, 0);
});

test('part loyalty, part card: only the card is takings, with its share of the VAT', () => {
  // The till books the gross bill; VAT is spread over the tenders (loyalty 20p of every £1).
  parts({ subtotal: 10, total: 10, tax_amount: 1.67, service: 0, tip: 0, tenders: [{ method: 'loyalty', amount: 2, tip: 0 }, card(8)] }, 8, 1.34, 6.66);
});

test('a promo code credit is a discount too', () => {
  parts({ subtotal: 20, total: 20, tax_amount: 3.33, service: 0, tip: 0, tenders: [{ method: 'promo', amount: 5, tip: 0 }, { method: 'cash', amount: 15, tip: 0 }] }, 15, 2.5, 12.5);
});

test('a reader sale whose discount the row never recorded: what the card took', () => {
  // Leeds chk-1790416675425-b72ce3: shelf £4.10, card £3.69, discounts [].
  parts({ subtotal: 4.1, total: 3.69, tax_amount: 0.62, service: 0, tip: 0, discounts: [], source: 'pos_send_to_terminal', tenders: [card(3.69)] }, 3.69, 0.62, 3.07);
});

test('a gift card spend is takings (the card was sold before)', () => {
  parts({ subtotal: 10, total: 10, tax_amount: 1.67, service: 0, tip: 0, tenders: [{ method: 'gift_card', amount: 5, tip: 0 }, card(5)] }, 10, 1.67, 8.33);
});

test('a split bill: every money tender counts, the VAT once', () => {
  parts({ subtotal: 10, total: 10, tax_amount: 1.67, service: 0, tip: 0, tenders: [card(6), { method: 'cash', amount: 4, tip: 0 }] }, 10, 1.67, 8.33);
});

test('service charge and tips are not sales', () => {
  // UK: £40 of food, £5 service, £3 tip on the card.
  parts({ subtotal: 40, total: 48, tax_amount: 6.67, service: 5, tip: 3, tenders: [card(45, 3)] }, 40, 6.67, 33.33);
});

test('US added-on tax with a discount: net is the discounted goods, gross adds the tax', () => {
  // $100 shelf, $20 off, 8.875% on $80 = $7.10. The shelf subtotal said net $100.
  parts({
    subtotal: 100, total: 87.1, tax_amount: 7.1, service: 0, tip: 0,
    tax_breakdown: { hasExclusiveTax: true, exclusiveTax: 7.1 },
    discounts: [{ amount: 20 }], tenders: [card(87.1)],
  }, 87.1, 7.1, 80);
});

test('US added-on tax, no discount, a row from before tenders: as before', () => {
  parts({ subtotal: 100, total: 108.88, tax_amount: 8.88, tax_breakdown: { hasExclusiveTax: true, exclusiveTax: 8.88 }, service: 0, tip: 0, method: 'card' }, 108.88, 8.88, 100);
});

test('no stored tax_amount keeps the old fallback', () => {
  // total - subtotal - service - tip = 5 of tax; the rest of the bill is goods.
  parts({ subtotal: 50, total: 60, tax_amount: null, service: 3, tip: 2, method: 'card' }, 55, 5, 50);
  // A UK reader close from before v5.9.97 (tax null): nothing on top, no VAT found.
  parts({ subtotal: 9.5, total: 9.5, tax_amount: null, tax_breakdown: null, service: 0, tip: 0, method: 'card' }, 9.5, 0, 9.5);
});

test('kiosk rows (no tenders, total is the card net of credits) read their credits', () => {
  // £10 order: £3 gift card, £7 card plus a £1 tip on the card.
  parts({ source: 'kiosk', subtotal: 10, total: 8, tax_amount: 1.67, service: 0, tip: 1, method: 'card', gift_card: { applied: 300 } }, 10, 1.67, 8.33);
  // £10 order, £2 loyalty reward (minor units on the kiosk's loyalty field), £8 card.
  parts({ source: 'kiosk', subtotal: 10, total: 8, tax_amount: 1.67, service: 0, tip: 0, method: 'card', loyalty: { discount_value: 200 } }, 8, 1.34, 6.66);
});

test('a delivery fee the customer paid counts, as in the accounting layer', () => {
  parts({ source: 'online', subtotal: 30, total: 38.05, tax_amount: 5, service: 0, tip: 0, method: 'card', order_type: 'delivery' }, 38.05, 5, 33.05);
});

test('figures are whole pence', () => {
  const p = checkSalesParts({ subtotal: 10, total: 10, tax_amount: 1.67, service: 0, tip: 0, tenders: [card(3.33), card(3.33), card(3.34)] });
  for (const v of [p.gross, p.vat, p.net]) near(Math.round(v * 100) / 100, v);
  near(p.vat, 1.67);
});

test('trading-report reads sales and refunds per business day, paged, with the tender columns', () => {
  const src = fs.readFileSync(path.join(here, '../../supabase/functions/trading-report/index.ts'), 'utf8');
  assert.match(src, /import \{ tradingDays, timesheetDays \} from '\.\.\/_shared\/tradingSales\.js';/);
  assert.match(src, /import \{ businessDayOf, businessDayWindow \} from '\.\.\/_shared\/businessDay\.js';/);
  assert.match(src, /import \{ venueClock \} from '\.\.\/_shared\/accountingData\.ts';/);
  const cols = /const CHECK_COLS = '([^']+)'/.exec(src)?.[1] ?? '';
  for (const c of ['id', 'subtotal', 'total', 'tax_amount', 'service', 'tip', 'discounts', 'tenders', 'method', 'payment_method', 'source', 'processor', 'gift_card', 'loyalty', 'promo', 'payment_intents', 'voided', 'status', 'closed_at']) {
    assert.ok(cols.split(',').map((s) => s.trim()).includes(c), `CHECK_COLS is missing ${c}`);
  }
  // Sales in the business day window; refunds from checks that closed up to 400 days before it.
  assert.match(src, /pagedRows\('closed checks', \(\) => opsAdmin\.from\('closed_checks'\)\.select\(CHECK_COLS\)\s*\.eq\('location_id', ops\)\.gte\('closed_at', fromIso\)\.lt\('closed_at', toIso\)/);
  assert.match(src, /pagedRows\('refunds', \(\) => opsAdmin\.from\('closed_checks'\)\.select\(`\$\{CHECK_COLS\}, refunds`\)\s*\.eq\('location_id', ops\)\.gte\('closed_at', since\)\.lt\('closed_at', toIso\)\.neq\('refunds', '\[\]'\)/);
  assert.match(src, /const REFUND_LOOKBACK_DAYS = 400;/);
  assert.match(src, /return tradingDays\(\{ saleRows, refundRows, dayOf: \(ms: number\) => businessDayOf\(ms, clock\.timezone, clock\.dayStart\) \}\);/);
  assert.match(src, /const clock = await venueClock\(platformAdmin, ops\);/);
  assert.match(src, /const labAct = timesheetDays\(\{ timesheets: ts, dayOf \}\);/);
  assert.match(src, /select\('id, clock_in, clock_out, pay_amount, status'\)/);
  // The rota stays on the day the manager planned it for.
  assert.match(src, /labTheo\[s\.shift_date\]/);
  assert.match(src, /const actualSales = s\?\.net \?\? 0;/);
  assert.match(src, /const refunds = s\?\.refunds \?\? 0;/);
  // No calendar midnight day left, no guessed clock.
  assert.doesNotMatch(src, /Intl\.DateTimeFormat/);
  assert.doesNotMatch(src, /\|\| 'Europe\/London'/);
  // PostgREST returns at most 1000 rows a request: no single capped read may remain.
  assert.doesNotMatch(src, /\)\s*\.limit\(/);
  assert.match(src, /pagedRows\('timesheets'/);
  assert.match(src, /pagedRows\('stock movements'/);
  assert.match(src, /\.range\(from, from \+ PAGE - 1\)/);
});

// ── refunds ───────────────────────────────────────────────────────────────────

const TZ = 'Europe/London';
const CB_START = '06:30';   // Coffee Boy's business_day_start
const bizDay = (dayStart = CB_START) => (ms) => businessDayOf(ms, TZ, dayStart);
const at = (iso) => Date.parse(iso);
const refundParts = (entry, row, gross, vat, net) => {
  const p = refundSalesParts(entry, row);
  assert.equal(p.skipped, false);
  near(p.gross, gross); near(p.vat, vat); near(p.net, net);
  return p;
};

// Leeds chk-1790412367197-f0d756 (26 Sep): a reader sale refunded in full two minutes later.
const leedsRefunded = () => ({
  id: 'chk-1790412367197-f0d756', closed_at: '2026-09-26T08:46:36.048Z',
  subtotal: 6.15, total: 6.15, tax_amount: 1.03, service: 0, tip: 0, status: 'refunded', voided: false, discounts: [],
  tenders: [{ method: 'card', amount: 6.15, tip: 0, processor: 'adyen' }], source: 'pos_send_to_terminal', processor: 'adyen',
  refunds: [{
    id: 'ref-1790412500684', amount: 6.15, taxAmount: 1.03, tipAmount: 0, serviceAmount: 0, timestamp: 1790412500686,
    cardStatus: 'accepted', isFullRefund: false, tenderMethod: 'card',
    legs: [{ id: 'dDxw001790412370016.PK64G676VH8BWGP9', status: 'accepted', processor: 'adyen', amountMinor: 615 }],
    items: [{ name: 'Spiced Maple & Pecan Iced Latte', price: 6.15, qty: 1, refundQty: 1 }],
  }],
});

test('a refund takes its goods and VAT off, on the day it was made', () => {
  const row = leedsRefunded();
  const p = refundParts(row.refunds[0], row, 6.15, 1.03, 5.12);
  assert.equal(businessDayOf(p.atMs, TZ, CB_START), '2026-09-26');
});

test('a refund gives back tip and service too, but only the goods come off sales', () => {
  // UK: £40 of food, £5 service, £3 tip on the card, all refunded.
  const row = { id: 'c1', closed_at: '2026-09-26T19:00:00Z', subtotal: 40, total: 48, tax_amount: 6.67, service: 5, tip: 3, tenders: [card(45, 3)] };
  refundParts({ amount: 48, tipAmount: 3, serviceAmount: 5, taxAmount: 6.67, timestamp: at('2026-09-27T12:00:00Z'), cardStatus: 'accepted', isFullRefund: true, tenderMethod: 'card', legs: [{ id: 'pi', status: 'accepted', amountMinor: 4800 }] }, row, 40, 6.67, 33.33);
});

test('a refund with no money moved takes nothing off', () => {
  const row = leedsRefunded();
  const base = row.refunds[0];
  for (const entry of [
    { ...base, failed: true },                                                     // the Adyen failure webhook
    { ...base, cardStatus: 'failed', legs: [{ ...base.legs[0], status: 'failed' }] },
    { ...base, cardStatus: 'pending', legs: [] },                                  // the till stopped mid refund
    { ...base, amount: 0 },
  ]) {
    const p = refundSalesParts(entry, row);
    assert.equal(p.skipped, true);
    near(p.gross, 0); near(p.vat, 0); near(p.net, 0);
  }
});

test('a cash refund still pending is money handed back', () => {
  const row = { id: 'c2', closed_at: '2026-09-26T10:00:00Z', subtotal: 12, total: 12, tax_amount: 2, service: 0, tip: 0, tenders: [{ method: 'cash', amount: 12, tip: 0 }] };
  refundParts({ amount: 12, taxAmount: 2, tipAmount: 0, serviceAmount: 0, timestamp: at('2026-09-26T11:00:00Z'), cardStatus: 'pending', tenderMethod: 'cash', isFullRefund: true }, row, 12, 2, 10);
});

test('a refund where one of two cards failed takes off only what went back', () => {
  const row = { id: 'c3', closed_at: '2026-09-26T10:00:00Z', subtotal: 20, total: 20, tax_amount: 3.33, service: 0, tip: 0, tenders: [card(10), card(10)] };
  // £20 refunded over two card legs, the second failed: £10 went back, with half the VAT.
  const p = refundParts({
    amount: 20, taxAmount: 3.33, tipAmount: 0, serviceAmount: 0, timestamp: at('2026-09-26T12:00:00Z'), cardStatus: 'partial', tenderMethod: 'card', isFullRefund: true,
    legs: [{ id: 'a', status: 'accepted', amountMinor: 1000 }, { id: 'b', status: 'failed', amountMinor: 1000 }],
  }, row, 10, 3.33, 6.67);
  assert.ok(p.gross <= 10);
});

test('a full refund puts a loyalty reward back, but only the card money comes off sales', () => {
  // The sale counted the card £8 (VAT 1.34); the loyalty £2 was a discount, never takings.
  const row = { id: 'c4', closed_at: '2026-09-26T10:00:00Z', subtotal: 10, total: 10, tax_amount: 1.67, service: 0, tip: 0, tenders: [{ method: 'loyalty', amount: 2, tip: 0 }, card(8)] };
  parts(row, 8, 1.34, 6.66);
  refundParts({ amount: 10, taxAmount: 1.67, tipAmount: 0, serviceAmount: 0, timestamp: at('2026-09-26T11:00:00Z'), cardStatus: 'accepted', tenderMethod: 'card', isFullRefund: true, legs: [{ id: 'pi', status: 'accepted', amountMinor: 800 }] }, row, 8, 1.34, 6.66);
});

test('a refund on a check that sold nothing (a phantom comp) takes nothing off', () => {
  const row = { id: 'c5', closed_at: '2026-09-26T10:00:00Z', subtotal: 4.1, total: 4.1, tax_amount: 0.68, service: 0, tip: 0, discounts: [pct100(4.1)], tenders: [{ method: 'cash', amount: 4.1, tip: 0 }] };
  const p = refundSalesParts({ amount: 4.1, tenderMethod: 'cash', timestamp: at('2026-09-26T11:00:00Z') }, row);
  assert.equal(p.skipped, true);
  near(p.gross, 0);
});

test('a refund with no time recorded is dated by the check close', () => {
  const row = leedsRefunded();
  const { timestamp, ...entry } = row.refunds[0];   // its legs carry no time either
  assert.equal(timestamp > 0, true);
  assert.ok(entry.legs.every((l) => l.at == null));
  const p = refundSalesParts(entry, row);
  assert.equal(p.atMs, at(row.closed_at));
});

// ── days ──────────────────────────────────────────────────────────────────────

const sale = (id, closedAt, amount, tax, extra = {}) => ({ id, closed_at: closedAt, subtotal: amount, total: amount, tax_amount: tax, service: 0, tip: 0, discounts: [], tenders: [card(amount)], ...extra });

test('a day: gross less refunds less VAT owed is net sales, and VAT owed is net of refund VAT', () => {
  const r = leedsRefunded();
  const days = tradingDays({ saleRows: [r, sale('s1', '2026-09-26T12:00:00Z', 12, 2)], refundRows: [r], dayOf: bizDay() });
  const d = days['2026-09-26'];
  near(d.gross, 18.15); near(d.refunds, 6.15);
  near(d.sales_vat, 3.03); near(d.refund_vat, 1.03); near(d.vat, 2);
  near(d.net, 10);
  near(d.net, d.gross - d.refunds - d.vat);
  assert.equal(d.checks, 2); assert.equal(d.refund_count, 1);
});

test('a sale counts on the day it closed, its refund on the day of the refund', () => {
  // Sold Friday, refunded Monday: Friday keeps the sale, Monday loses it.
  const r = sale('s2', '2026-09-25T13:00:00Z', 12, 2, {
    refunds: [{ amount: 12, taxAmount: 2, tipAmount: 0, serviceAmount: 0, timestamp: at('2026-09-28T09:00:00Z'), cardStatus: 'accepted', tenderMethod: 'card', isFullRefund: true, legs: [{ id: 'pi', status: 'accepted', amountMinor: 1200 }] }],
  });
  const days = tradingDays({ saleRows: [r], refundRows: [r], dayOf: bizDay() });
  near(days['2026-09-25'].net, 10); near(days['2026-09-25'].refunds, 0);
  near(days['2026-09-28'].gross, 0); near(days['2026-09-28'].refunds, 12); near(days['2026-09-28'].vat, -2); near(days['2026-09-28'].net, -10);
});

test('business day: a sale at 00:40 and a refund at 05:00 belong to the night before', () => {
  // UK summer time. Coffee Boy's day starts 06:30; midnight would have put both on Saturday.
  const late = sale('s3', '2026-09-25T23:40:00Z', 6, 1, {   // 00:40 BST Saturday
    refunds: [{ amount: 6, taxAmount: 1, tipAmount: 0, serviceAmount: 0, timestamp: at('2026-09-26T04:00:00Z'), cardStatus: 'accepted', tenderMethod: 'card', legs: [{ id: 'pi', status: 'accepted', amountMinor: 600 }] }],   // 05:00 BST
  });
  const early = sale('s4', '2026-09-26T05:45:00Z', 3, 0.5);   // 06:45 BST Saturday: Saturday's first sale
  const biz = tradingDays({ saleRows: [late, early], refundRows: [late], dayOf: bizDay() });
  near(biz['2026-09-25'].gross, 6); near(biz['2026-09-25'].refunds, 6);
  near(biz['2026-09-26'].gross, 3); near(biz['2026-09-26'].refunds, 0);
  const midnight = tradingDays({ saleRows: [late, early], refundRows: [late], dayOf: bizDay('00:00') });
  near(midnight['2026-09-26'].gross, 9); near(midnight['2026-09-26'].refunds, 6);
  assert.equal(midnight['2026-09-25'], undefined);
});

test('voided checks count for neither sales nor refunds; a row read twice counts once', () => {
  const r = leedsRefunded();
  const voided = { ...sale('v1', '2026-09-26T12:00:00Z', 50, 8.33), voided: true, refunds: [{ amount: 50, tenderMethod: 'cash', timestamp: at('2026-09-26T13:00:00Z') }] };
  const days = tradingDays({ saleRows: [r, r, voided], refundRows: [r, r, voided], dayOf: bizDay() });
  near(days['2026-09-26'].gross, 6.15); near(days['2026-09-26'].refunds, 6.15); near(days['2026-09-26'].net, 0);
  assert.equal(days['2026-09-26'].checks, 1); assert.equal(days['2026-09-26'].refund_count, 1);
});

test('every business day agrees with the accounting day layer (what Xero is posted from)', () => {
  // Real Leeds refunds (25 to 27 Sep) plus sales around the 06:30 start and a refund days later.
  const r25 = {
    id: 'chk-1790363369460-12d9fe', closed_at: '2026-09-25T19:09:57.989Z', subtotal: 1, total: 1, tax_amount: null, service: 0, tip: 0, discounts: [],
    tenders: [{ method: 'card', amount: 1, tip: 0, processor: 'adyen' }], processor: 'adyen', method: 'card',
    refunds: [{ id: 'ref-1790363415493', amount: 1, taxAmount: null, tipAmount: 0, serviceAmount: 0, timestamp: 1790363415493, cardStatus: 'accepted', isFullRefund: false, tenderMethod: 'card', legs: [{ id: 'x', status: 'accepted', processor: 'adyen', amountMinor: 100 }], items: [{ name: 'Test', price: 1 }] }],
  };
  const r27 = {
    id: 'chk-1790514704775-51d46e', closed_at: '2026-09-27T13:11:58.72Z', subtotal: 9.9, total: 9.9, tax_amount: 1.65, service: 0, tip: 0, discounts: [],
    tenders: [{ method: 'card', amount: 9.9, tip: 0, processor: 'adyen' }], processor: 'adyen', source: 'pos_send_to_terminal',
    refunds: [{ id: 'ref-1790515683747', amount: 3.8, taxAmount: 0.63, tipAmount: 0, serviceAmount: 0, timestamp: 1790515683748, cardStatus: 'none', isFullRefund: false, tenderMethod: 'card', legs: [], items: [{ name: 'Americano', price: 3.8 }] }],
  };
  const later = sale('s5', '2026-09-26T16:00:00Z', 20, 3.33, {
    tenders: [{ method: 'gift_card', amount: 5, tip: 0 }, card(15, 1.5)], tip: 1.5, total: 21.5,
    refunds: [{ amount: 21.5, taxAmount: 3.33, tipAmount: 1.5, serviceAmount: 0, timestamp: at('2026-09-29T10:00:00Z'), cardStatus: 'accepted', tenderMethod: 'card', isFullRefund: true, legs: [{ id: 'pi', status: 'accepted', amountMinor: 1650 }] }],
  });
  const saleRows = [r25, leedsRefunded(), r27, later, sale('s6', '2026-09-27T05:10:00Z', 4, 0.67), sale('s7', '2026-09-27T05:40:00Z', 5, 0.83)];
  const refundRows = saleRows.filter((r) => r.refunds?.length);
  const days = tradingDays({ saleRows, refundRows, dayOf: bizDay() });
  for (const ymd of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29']) {
    const win = businessDayWindow(ymd, TZ, CB_START);
    const acct = buildAccountingDay({ day: win, saleRows, refundRows, venue: { timezone: TZ, dayStart: CB_START } });
    const d = days[ymd] || { gross: 0, refunds: 0, sales_vat: 0, refund_vat: 0 };
    near(Math.round(d.gross * 100), acct.sales.totals.sales);
    near(Math.round(d.sales_vat * 100), acct.sales.totals.tax);
    near(Math.round(d.refunds * 100), acct.refunds.totals.sales);
    near(Math.round(d.refund_vat * 100), acct.refunds.totals.tax);
  }
  // The gift card spend came back on the full refund: the whole £20 of goods left on Tuesday.
  near(days['2026-09-29'].refunds, 20);
});

test('sales less refunds over any days add up to every check less every refund (fuzz)', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pence = (n) => Math.round(n * 100) / 100;
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const amount = pence(1 + rnd() * 60);
    const tax = pence(amount / 6);
    const closed = Date.parse('2026-03-20T00:00:00Z') + Math.floor(rnd() * 20 * 86400000);   // across the spring DST change
    const row = sale(`f${i}`, new Date(closed).toISOString(), amount, tax);
    if (rnd() < 0.3) {
      const part = pence(amount * (rnd() < 0.5 ? 1 : rnd()));
      row.refunds = [{ amount: part, taxAmount: pence(tax * part / amount), tipAmount: 0, serviceAmount: 0, timestamp: closed + Math.floor(rnd() * 3 * 86400000), cardStatus: rnd() < 0.1 ? 'failed' : 'accepted', tenderMethod: 'card', legs: [{ id: 'pi', status: 'accepted', amountMinor: Math.round(part * 100) }] }];
      if (row.refunds[0].cardStatus === 'failed') row.refunds[0].legs[0].status = 'failed';
    }
    rows.push(row);
  }
  const days = tradingDays({ saleRows: rows, refundRows: rows.filter((r) => r.refunds), dayOf: bizDay() });
  let net = 0, expect = 0;
  for (const d of Object.values(days)) {
    net += Math.round(d.net * 100);
    near(Math.round(d.net * 100), Math.round(d.gross * 100) - Math.round(d.refunds * 100) - Math.round(d.vat * 100));
    for (const v of [d.gross, d.refunds, d.vat, d.net]) near(Math.round(v * 100) / 100, v);
  }
  for (const r of rows) {
    const s = checkSalesParts(r);
    expect += Math.round(s.net * 100);
    for (const e of r.refunds || []) expect -= Math.round(refundSalesParts(e, r).net * 100);
  }
  assert.equal(net, expect);
});

// ── labour ────────────────────────────────────────────────────────────────────

test('a timesheet counts on the business day most of the shift falls in', () => {
  const day = (clockIn, clockOut) => businessDayOf(timesheetDayMs({ clock_in: clockIn, clock_out: clockOut }), TZ, CB_START);
  // Opener: clocks in 06:00 BST for a 06:30 day, out 14:00. Clock in alone would say Friday.
  assert.equal(day('2026-09-26T05:00:00Z', '2026-09-26T13:00:00Z'), '2026-09-26');
  assert.equal(businessDayOf(Date.parse('2026-09-26T05:00:00Z'), TZ, CB_START), '2026-09-25');
  // Closer: 18:00 to 02:00 BST stays on the night.
  assert.equal(day('2026-09-26T17:00:00Z', '2026-09-27T01:00:00Z'), '2026-09-26');
  // A late shift that starts after midnight belongs to the night before.
  assert.equal(day('2026-09-26T23:30:00Z', '2026-09-27T03:00:00Z'), '2026-09-26');
  // No clock out, or one before the clock in: the clock in.
  assert.equal(timesheetDayMs({ clock_in: '2026-09-26T09:00:00Z' }), Date.parse('2026-09-26T09:00:00Z'));
  assert.equal(timesheetDayMs({ clock_in: '2026-09-26T09:00:00Z', clock_out: '2026-09-26T08:00:00Z' }), Date.parse('2026-09-26T09:00:00Z'));
  assert.equal(timesheetDayMs({ clock_in: null }), null);
});

test('actual labour is approved and paid timesheets only, in whole pence, each once', () => {
  const ts = [
    { id: 1, status: 'approved', clock_in: '2026-09-26T05:00:00Z', clock_out: '2026-09-26T13:00:00Z', pay_amount: '96.10' },
    { id: 2, status: 'paid', clock_in: '2026-09-26T17:00:00Z', clock_out: '2026-09-27T01:00:00Z', pay_amount: 88.05 },
    { id: 2, status: 'paid', clock_in: '2026-09-26T17:00:00Z', clock_out: '2026-09-27T01:00:00Z', pay_amount: 88.05 },
    { id: 3, status: 'draft', clock_in: '2026-09-26T09:00:00Z', clock_out: '2026-09-26T12:00:00Z', pay_amount: 30 },
    { id: 4, status: 'open', clock_in: '2026-09-26T09:00:00Z', clock_out: null, pay_amount: null },
    { id: 5, status: 'approved', clock_in: null, pay_amount: 10 },
  ];
  const days = timesheetDays({ timesheets: ts, dayOf: bizDay() });
  assert.deepEqual(Object.keys(days), ['2026-09-26']);
  near(days['2026-09-26'], 184.15);
});
