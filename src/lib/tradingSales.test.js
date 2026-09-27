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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSalesParts, chargedNothing, recordedDiscountMinor } from '../../supabase/functions/_shared/tradingSales.js';

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

test('trading-report reads every check through checkSalesParts, paged, with the tender columns', () => {
  const src = fs.readFileSync(path.join(here, '../../supabase/functions/trading-report/index.ts'), 'utf8');
  assert.match(src, /import \{ checkSalesParts \} from '\.\.\/_shared\/tradingSales\.js';/);
  assert.match(src, /import \{ isVoidedCheck \} from '\.\.\/_shared\/accountingDay\.js';/);
  assert.match(src, /const p = checkSalesParts\(c\);/);
  assert.match(src, /if \(isVoidedCheck\(c\)\) continue;/);
  const cols = /const CHECK_COLS = '([^']+)'/.exec(src)?.[1] ?? '';
  for (const c of ['subtotal', 'total', 'tax_amount', 'service', 'tip', 'discounts', 'tenders', 'method', 'payment_method', 'source', 'gift_card', 'loyalty', 'promo', 'payment_intents', 'voided', 'status', 'closed_at']) {
    assert.ok(cols.split(',').map((s) => s.trim()).includes(c), `CHECK_COLS is missing ${c}`);
  }
  assert.match(src, /const grossSales = s\.gross;/);
  assert.match(src, /const actualSales = s\.net;/);
  // PostgREST returns at most 1000 rows a request: no single capped read may remain.
  assert.doesNotMatch(src, /\)\s*\.limit\(/);
  assert.match(src, /pagedRows\('closed checks'/);
  assert.match(src, /pagedRows\('timesheets'/);
  assert.match(src, /pagedRows\('stock movements'/);
  assert.match(src, /\.range\(from, from \+ PAGE - 1\)/);
});
