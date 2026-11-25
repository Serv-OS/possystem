// The Back Office Payment methods report splits by what paid (lib/paymentMethodRows.js).
// Coffee Boy Castleford, 25 Nov 2026: Card read 591.86 when the card machine took 603.31.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paymentRows, paymentLabel } from './paymentMethodRows.js';
import { salesBreakdown } from './salesBreakdown.js';

const item = (price) => ({ uid: `i${price}`, name: 'Latte', qty: 1, price });
const check = (id, method, total, tenders) => ({ id, ref: id, status: 'paid', method, total, subtotal: total, items: [item(total)], closedAt: Date.parse('2026-11-09T10:00:00Z'), tenders });

test('a check paid by card and a free loyalty drink puts its card money in Card', () => {
  const checks = [
    check('a', 'card', 10, null),
    check('b', 'cash', 4, null),
    check('c', 'loyalty+card', 16.15, [{ method: 'loyalty', amount: 4.7, rewards: [{ name: 'Free Drink', amount: 4.7 }] }, { method: 'card', amount: 11.45 }]),
    check('d', 'loyalty+cash', 4.7, [{ method: 'loyalty', amount: 4.7, rewards: [{ name: 'Free Drink', amount: 4.7 }] }]),
  ];
  const r = paymentRows(salesBreakdown(checks));
  const by = Object.fromEntries(r.rows.map((x) => [x.method, x]));
  assert.equal(by.card.revenue, 21.45, 'card is 10.00 plus the 11.45 card part');
  assert.equal(by.card.count, 2);
  assert.equal(by.cash.revenue, 4);
  assert.equal(r.total, 25.45, 'the total is the money, never the free drinks');
  assert.equal(r.rewards, 9.4, 'the free drinks are named beside it');
  assert.equal(r.checks, 4);
  assert.ok(!r.rows.some((x) => x.method === 'loyalty' || x.method.includes('+')), 'no row for a mixed method word');
});

test('Card and Cash are always there; other kinds only when they took money', () => {
  const r = paymentRows(salesBreakdown([]));
  assert.deepEqual(r.rows.map((x) => x.method).sort(), ['card', 'cash']);
  assert.equal(r.total, 0);
  const g = paymentRows({ tender_card: 5, tender_cash: 0, tender_gift_card: 12, rewards: 0, count: 3 });
  assert.deepEqual(g.rows.map((x) => x.method), ['gift_card', 'card', 'cash'], 'biggest first');
  assert.equal(g.total, 17);
  assert.equal(g.rows[0].count, 0, 'the server sums hold no count per kind of money');
  assert.equal(paymentLabel('gift_card'), 'Gift card');
  assert.equal(paymentLabel('nonsense'), 'Other');
});

test('the report reads the one sales rule and no longer files a check under its method word', () => {
  const src = readFileSync(new URL('../backoffice/sections/reports/Payments.jsx', import.meta.url), 'utf8');
  assert.ok(src.includes('paymentRows(salesBreakdown(checks, { range, refundRows, currency }))'), 'one site');
  assert.ok(src.includes('breakdownFromDaySums(p.sums.totals.stats, p.sums.totals.byTender'), 'a long period reads by tender');
  assert.ok(!src.includes('bucket(c.method)'), 'the method word is not the bucket any more');
  const bo = readFileSync(new URL('../backoffice/sections/BOReports.jsx', import.meta.url), 'utf8');
  assert.ok(bo.includes('<Payments     checks={filtered} fmt={fmt} fmtN={fmtN} locationConfig={locationConfig} rangeFrom={range.from} rangeTo={range.to} locationId={activeLocId} filters={reportFilters} {...siteProps}/>'), 'the report is handed its range');
});
