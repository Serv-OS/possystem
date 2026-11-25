// Where the money was taken: the till, online and app, the kiosk, QR (25 Nov 2026, Castleford).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offTillChecksSince } from './eodPayments.js';
import { salesBreakdown, tendersByPlace, placeSplit, placeOf, PLACE_WORDS } from './salesBreakdown.js';
import { summariseShift, buildShiftReportDoc } from './shiftReport.js';

const at = (hhmm) => Date.parse(`2026-11-09T${hhmm}:00Z`);
const item = (price) => ({ uid: `i${price}`, name: 'Latte', qty: 1, price });
const check = (id, source, total, method = 'card', extra = {}) => ({ id, ref: id, status: 'paid', source, method, total, subtotal: total, items: [item(total)], closedAt: at('10:00'), ...extra });

test('a check is put in one place by its source', () => {
  assert.equal(placeOf({ source: null }), 'till');
  assert.equal(placeOf({}), 'till');
  assert.equal(placeOf({ source: 'pos' }), 'till');
  assert.equal(placeOf({ source: 'pos_send_to_terminal' }), 'till');
  assert.equal(placeOf({ source: 'online' }), 'online');
  assert.equal(placeOf({ source: 'ONLINE ' }), 'online');
  assert.equal(placeOf({ source: 'kiosk' }), 'kiosk');
  assert.equal(placeOf({ source: 'qr' }), 'qr');
  assert.equal(placeOf({ source: 'hubrise' }), 'partner');
  assert.equal(placeOf({ source: 'something new' }), 'other');
  assert.equal(PLACE_WORDS.online, 'Online and app');
});

test('the places of one kind of money add up to its total, refunds and part payments included', () => {
  const checks = [
    check('a', null, 10),
    check('b', 'online', 9.4),
    check('c', 'pos', 4, 'cash'),
    check('d', 'kiosk', 6),
    check('e', null, 16.15, 'loyalty+card', { tenders: [{ method: 'loyalty', amount: 4.7, rewards: [{ name: 'Free Drink' }] }, { method: 'card', amount: 11.45 }] }),
    check('f', 'online', 5, 'card', { refunds: [{ amount: 5, at: at('11:00'), method: 'card' }] }),
  ];
  const by = tendersByPlace(checks);
  const b = salesBreakdown(checks);
  const card = Object.values(by).reduce((s, p) => s + p.card, 0);
  assert.equal(Math.round(card * 100), Math.round(b.tender_card * 100), 'card by place adds up to Card');
  assert.equal(by.till.card, 21.45, 'the till: 10.00 plus the 11.45 card part of the loyalty order');
  assert.equal(by.till.cash, 4);
  assert.equal(by.kiosk.card, 6);
  assert.equal(by.till.checks, 3);
  const split = placeSplit(by, 'card');
  assert.deepEqual(split.map((r) => r.label), ['At the till', 'Online and app', 'Kiosk']);
  assert.deepEqual(placeSplit(by, 'cash'), [], 'cash was one place: no split to show');
  assert.deepEqual(placeSplit(by, 'cash', { always: true }).map((r) => r.amount), [4]);
  assert.deepEqual(placeSplit({}, 'card'), []);
});

test('the X and Z report names where card was taken, only when it was more than one place', () => {
  const both = summariseShift([check('a', null, 10), check('b', 'online', 9.4)]);
  const card = both.payments.find((p) => p.kind === 'card');
  assert.deepEqual(card.split.map((r) => [r.label, r.amount]), [['At the till', 10], ['Online and app', 9.4]]);
  const text = Buffer.from(buildShiftReportDoc({ kind: 'Z', venueName: 'Test', sales: both.sales, payments: both.payments, currency: 'GBP' }).bytes?.() ?? []).toString('latin1');
  const one = summariseShift([check('a', null, 10)]);
  assert.deepEqual(one.payments.find((p) => p.kind === 'card').split, [], 'all at the till: the line is not repeated');
  const src = readFileSync(new URL('./shiftReport.js', import.meta.url), 'utf8');
  assert.ok(src.includes("for (const part of (Array.isArray(p.split) ? p.split : [])) b.twoColTrunc(`  ${part.label}`, m(part.amount));"), 'the slip prints each place under its payment');
  assert.equal(typeof text, 'string');
});

test('Close day reads in the orders taken away from the tills since the shift opened', () => {
  const checks = [
    { id: 'till', shiftId: 'sh1', closedAt: at('10:00') },
    { id: 'online-in', shiftId: null, source: 'online', closedAt: at('10:00') },
    { id: 'kiosk-in', source: 'kiosk', closedAt: at('09:00') },
    { id: 'online-before', shiftId: null, source: 'online', closedAt: at('07:59') },
    { id: 'online-voided', shiftId: null, source: 'online', closedAt: at('10:00'), status: 'voided' },
    { id: 'row-shape', shiftId: null, closed_at: '2026-11-09T12:00:00Z' },
    null,
  ];
  assert.deepEqual(offTillChecksSince(checks, at('08:00')).map((c) => c.id), ['online-in', 'kiosk-in', 'row-shape']);
  assert.deepEqual(offTillChecksSince(checks, '2026-11-09T08:00:00Z').map((c) => c.id), ['online-in', 'kiosk-in', 'row-shape'], 'a text start reads the same');
  assert.deepEqual(offTillChecksSince(checks, null), [], 'no shift start, nothing read in');
  assert.deepEqual(offTillChecksSince(null, at('08:00')), []);
});

test('the pages use the one rule', () => {
  const eod = readFileSync(new URL('../backoffice/sections/EODClose.jsx', import.meta.url), 'utf8');
  assert.ok(eod.includes('const paymentMethods = useMemo(() => paymentRows(salesBreakdown(payChecks)).rows'), 'Close day splits by what paid');
  assert.ok(eod.includes('{placeSplit(payPlaces, pm.method).map(part => ('), 'and names where it was taken');
  assert.ok(!eod.includes("const m = c.method || 'other';"), 'the method word is not the row any more');
  const rep = readFileSync(new URL('../backoffice/sections/reports/Payments.jsx', import.meta.url), 'utf8');
  assert.ok(rep.includes("placeSplit(places, 'card', { always: true })"), 'the Payment methods report shows card by place');
});
