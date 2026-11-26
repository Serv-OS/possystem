// Sales by order source on the X and Z report (5.12.107, 26 Nov 2026).
// Peter: "can we break down the Z report and X reports into order source too like kiosk, online,
// QR etc ?". The payments were already split by place (25 Nov); the sales were one figure.
// The rule under test: every check sits in ONE source, and the sources add up, to the penny, to
// the report's own Checks, Net sales and Money collected. Nothing is estimated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { salesBreakdown, salesByPlace, PLACE_WORDS } from './salesBreakdown.js';
import { summariseShift, buildShiftReportDoc } from './shiftReport.js';

const DAY_FROM = Date.parse('2026-11-09T06:00:00Z');
const RANGE = { fromMs: DAY_FROM, toMs: DAY_FROM + 86400000 - 1 };
const card = (amount, tip = 0) => ({ method: 'card', amount, tip, processor: 'adyen' });
const cash = (amount, tip = 0) => ({ method: 'cash', amount, tip });
const loyalty = (amount) => ({ method: 'loyalty', amount, tip: 0, rewards: [{ name: 'Free Drink', item: 'Latte', amount }] });
const line = (price, qty = 1) => ({ name: 'Item', price, qty });
let n = 0;
const sale = (source, o) => ({ id: `c${++n}`, ref: `R${100 + n}`, source, closedAt: DAY_FROM + n * 600000, status: 'paid', service: 0, tip: 0, covers: 1, discounts: [], refunds: [], method: 'card', ...o });
// A UK day (VAT inside the prices) taken in five places, with a tip, a loyalty reward, a cash
// sale, a voided check, a refund made today on today's sale and one on an older sale.
function theDay() {
  n = 0;
  return [
    sale(null, { items: [line(3.6), line(2.4)], subtotal: 6, taxAmount: 1, total: 6, tenders: [card(6)] }),
    sale('pos', { items: [line(4.8)], subtotal: 4.8, taxAmount: 0.8, tip: 0.5, total: 5.3, method: 'cash', tenders: [cash(4.8, 0.5)] }),
    sale('pos', { items: [line(3.6), line(6)], subtotal: 9.6, taxAmount: 1, total: 9.6, method: 'loyalty+card', tenders: [loyalty(3.6), card(6)] }),
    sale('online', { items: [line(9.6)], subtotal: 9.6, taxAmount: 1.6, total: 9.6, tenders: [card(9.6)] }),
    sale('online', { items: [line(6)], subtotal: 6, taxAmount: 1, total: 6, tenders: [card(6)], refunds: [{ amount: 6, at: DAY_FROM + 3600000, method: 'card' }] }),
    sale('kiosk', { items: [line(12)], subtotal: 12, taxAmount: 2, total: 12, tenders: [card(12)] }),
    sale('qr', { items: [line(7.2)], subtotal: 7.2, taxAmount: 1.2, total: 7.2, tenders: [card(7.2)] }),
    sale('hubrise', { items: [line(18)], subtotal: 18, taxAmount: 3, total: 18, method: 'other', tenders: [{ method: 'other', amount: 18, tip: 0 }] }),
    sale('kiosk', { items: [line(5)], subtotal: 5, taxAmount: 0.83, total: 5, status: 'voided', voided: true, tenders: [] }),
  ];
}
// Yesterday's kiosk sale, refunded today: it comes off today's Kiosk figure.
const older = () => [{ id: 'old1', ref: 'R001', source: 'kiosk', closedAt: DAY_FROM - 7200000, status: 'paid', service: 0, tip: 0, covers: 1, discounts: [], method: 'card', items: [line(2.4)], subtotal: 2.4, taxAmount: 0.4, total: 2.4, tenders: [card(2.4)], refunds: [{ amount: 2.4, at: DAY_FROM + 7200000, method: 'card' }] }];
const pence = (x) => Math.round(x * 100);
const sum = (rows, k) => rows.reduce((s, r) => s + pence(r[k]), 0);

test('the sources add up to the report\'s own Checks, Net sales and Money collected, to the penny', () => {
  const checks = theDay(); const refundRows = older();
  const b = salesBreakdown(checks, { range: RANGE, refundRows });
  const rows = salesByPlace(checks, { range: RANGE, refundRows });
  assert.deepEqual(rows.map((r) => r.place), ['till', 'online', 'kiosk', 'qr', 'partner']);
  assert.equal(rows.reduce((s, r) => s + r.checks, 0), b.count, 'checks');
  assert.equal(sum(rows, 'net'), pence(b.net), 'net sales');
  assert.equal(sum(rows, 'collected'), pence(b.collected), 'money collected');
  // without the refunds on older sales too
  const b2 = salesBreakdown(checks, { range: RANGE });
  const rows2 = salesByPlace(checks, { range: RANGE });
  assert.equal(sum(rows2, 'net'), pence(b2.net));
  assert.equal(sum(rows2, 'collected'), pence(b2.collected));
});

test('each source holds its own sales: a reward is not a sale, a void is not counted, a refund comes off its own source', () => {
  const by = Object.fromEntries(salesByPlace(theDay(), { range: RANGE, refundRows: older() }).map((r) => [r.place, r]));
  // till: 6.00 + 4.80 + the 6.00 paid by card on the loyalty order (the free 3.60 drink is not a sale)
  assert.equal(by.till.checks, 3);
  assert.equal(pence(by.till.collected), 1730, '6.00 + 4.80 + 0.50 tip + 6.00');
  assert.ok(pence(by.till.net) < pence(by.till.collected), 'net is without the VAT and the tip');
  // online: two orders, one refunded in full today
  assert.equal(by.online.checks, 2);
  assert.equal(pence(by.online.collected), 960);
  assert.equal(pence(by.online.net), 800);
  // kiosk: one sale of 12.00 (the void is not counted), less today's refund of yesterday's 2.40
  assert.equal(by.kiosk.checks, 1);
  assert.equal(pence(by.kiosk.collected), 960);
  assert.equal(pence(by.kiosk.net), 800);
  assert.equal(pence(by.qr.net), 600);
  assert.equal(pence(by.partner.net), 1500);
  assert.equal(by.partner.label, PLACE_WORDS.partner);
});

test('a source with nothing is left out; a day with no sales has no rows; odd input is safe', () => {
  assert.deepEqual(salesByPlace([]), []);
  assert.deepEqual(salesByPlace(null), []);
  n = 0;
  const till = salesByPlace([sale(null, { items: [line(6)], subtotal: 6, taxAmount: 1, total: 6, tenders: [card(6)] })]);
  assert.deepEqual(till.map((r) => [r.place, r.label, r.checks]), [['till', 'At the till', 1]]);
  // a refund today on an older sale, with no sale today in that place: the place still shows, negative
  const only = salesByPlace([], { range: RANGE, refundRows: older() });
  assert.deepEqual(only.map((r) => [r.place, r.checks, pence(r.net)]), [['kiosk', 0, -200]]);
});

const textOf = (doc) => doc.ops.filter((o) => o.t === 'twoCol' || o.t === 'twoColTrunc' || o.t === 'text').map((o) => (o.t === 'text' ? o.s : `${o.l} | ${o.r}`));

test('the X and the Z slip print Sales by source, between the sales and the payments', () => {
  const { sales, payments, sources } = summariseShift(theDay(), { range: RANGE, refundRows: older(), currency: 'GBP' });
  assert.equal(sum(sources, 'net'), pence(sales.net));
  for (const kind of ['X', 'Z']) {
    const t = textOf(buildShiftReportDoc({ kind, sales, payments, sources, currency: 'GBP' }));
    const head = t.indexOf('Sales by source (excluding VAT)');
    assert.ok(head > 0, `${kind}: the heading`);
    assert.ok(head < t.indexOf('Payments'), 'above the payments');
    assert.ok(head > t.findIndex((l) => l.startsWith('Checks |')), 'below the sales');
    // the till: 16.80 of money sales less 2.42 VAT (1.00 + 0.80 + the money share of the loyalty order's VAT, 0.62)
    assert.deepEqual(t.slice(head + 1, head + 6), ['At the till (3) | £14.38', 'Online and app (2) | £8.00', 'Kiosk (1) | £8.00', 'QR at the table (1) | £6.00', 'Delivery apps (1) | £15.00']);
  }
  // a US venue words it "tax"; a narrow slip shortens the heading to fit one line
  const us = summariseShift(theDay(), { range: RANGE, currency: 'USD' });
  assert.ok(textOf(buildShiftReportDoc({ kind: 'X', sales: us.sales, payments: us.payments, sources: us.sources, currency: 'USD' })).includes('Sales by source (excluding tax)'));
  assert.ok(textOf(buildShiftReportDoc({ kind: 'X', sales, payments, sources, currency: 'GBP' }, { cols: 32 })).includes('Sales by source (ex VAT)'));
  // an older caller that hands no sources prints the slip as before
  assert.ok(!textOf(buildShiftReportDoc({ kind: 'X', sales, payments, currency: 'GBP' })).some((l) => l.startsWith('Sales by source')));
});

test('the till and Back Office both hand the sources to the report', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const pos = read('../surfaces/POSSurface.jsx');
  assert.ok(pos.includes('const { sales, payments, sources } = summariseShift(checks,'), 'the till reads them');
  assert.ok(pos.includes('sales, payments, sources, drawer, currency: cfg.currency,'), 'and prints them');
  const z = read('../backoffice/sections/reports/ZReport.jsx');
  assert.ok(z.includes('const { sales, payments, sources } = useMemo(() => summariseShift(checks,'));
  assert.ok(z.includes('data-testid="z-sales-by-source"'));
  assert.ok(z.includes('{(p.split || []).map(part =>'), 'Back Office now names where each payment was taken, as the slip does');
});
