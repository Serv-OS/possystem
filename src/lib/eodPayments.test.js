// Where the money was taken: the till, online and app, the kiosk, QR (25 Nov 2026, Castleford).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shiftWindowChecks, awayFromTills, closeDayTotals } from './eodPayments.js';
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

test('the shift is a window: every sale closed since it opened counts, stamped or not, once', () => {
  const shift = { id: 'sh1', openedAt: '2026-11-09T08:00:00Z' };
  const read = [
    { id: 'till', shiftId: 'sh1', closedAt: at('10:00') },
    { id: 'online', shiftId: null, source: 'online', closedAt: at('10:00') },
    { id: 'reader', shiftId: null, source: 'pos', closedAt: at('09:00') },
    { id: 'before', shiftId: null, source: 'online', closedAt: at('07:59') },
    { id: 'other-shift-before', shiftId: 'sh0', closedAt: at('07:00') },
    { id: 'row-shape', shift_id: null, closed_at: '2026-11-09T12:00:00Z' },
    null,
  ];
  const live = [{ id: 'till', shiftId: 'sh1', closedAt: at('10:00'), stale: true }, { id: 'new', shiftId: 'sh1', closedAt: at('13:00') }];
  const got = shiftWindowChecks(shift, read, live);
  assert.deepEqual(got.map((c) => c.id), ['till', 'online', 'reader', 'row-shape', 'new']);
  assert.equal(got[0].stale, undefined, 'a check in both lists counts once, the database copy');
  assert.deepEqual(shiftWindowChecks(shift, null, live).map((c) => c.id), ['till', 'new'], 'the read failed: what the device holds');
  assert.deepEqual(shiftWindowChecks(null, read), []);
  // stamped with the shift but closed a moment before its recorded start still belongs to it
  assert.deepEqual(shiftWindowChecks(shift, [{ id: 'early', shiftId: 'sh1', closedAt: at('07:59') }]).map((c) => c.id), ['early']);
  assert.equal(awayFromTills(got), 1, 'one order was taken away from the tills');
  assert.equal(awayFromTills([{ id: 'v', source: 'online', status: 'voided' }]), 0);
});

test('Close day totals are the one sales rule: money by what paid it, adding up to revenue', () => {
  const shift = { id: 'sh1', openedAt: '2026-11-09T08:00:00Z' };
  const checks = [
    check('a', null, 10, 'card', { covers: 2 }),
    check('b', 'online', 9.4),
    check('c', 'pos', 4, 'cash'),
    check('e', null, 16.15, 'loyalty+card', { tenders: [{ method: 'loyalty', amount: 4.7, rewards: [{ name: 'Free Drink' }] }, { method: 'card', amount: 11.45 }] }),
    check('v', null, 8, 'card', { status: 'voided' }),
    check('r', null, 5, 'card', { refunds: [{ amount: 5, at: at('11:00'), method: 'card' }] }),
  ];
  const t = closeDayTotals(checks, shift, { now: at('18:00'), currency: 'GBP' });
  assert.equal(t.card, 30.85, 'card: 10.00 + 9.40 + the 11.45 card part; the refunded 5.00 is back out');
  assert.equal(t.cash, 4);
  assert.equal(t.other, 0);
  assert.equal(t.revenue, 34.85, 'revenue is the money: the 4.70 free drink is not in it');
  assert.equal(Math.round((t.cash + t.card + t.other) * 100), Math.round(t.revenue * 100), 'the money adds up to revenue');
  assert.equal(t.rewards, 4.7);
  assert.equal(t.refunds, 5);
  assert.equal(t.checks, 5, 'a voided check is not a check');
  assert.equal(t.voids, 1);
  const none = closeDayTotals([], shift);
  assert.equal(none.revenue, 0); assert.equal(none.checks, 0); assert.equal(none.taxMissing, 0);
});

test('the shift a sale was taken in is read back with the row', () => {
  const src = readFileSync(new URL('./closedCheckRefundFields.js', import.meta.url), 'utf8');
  assert.ok(src.includes('shiftId: row?.shift_id ?? null,'), 'shift_id comes back as shiftId on every copy');
});

test('the pages use the one rule', () => {
  const eod = readFileSync(new URL('../backoffice/sections/EODClose.jsx', import.meta.url), 'utf8');
  assert.ok(eod.includes('const shiftChecks = useMemo(() => shiftWindowChecks(currentShift, windowRows, closedChecks)'), 'Close day counts the window, from its own read');
  assert.ok(eod.includes('const totals = useMemo(() => closeDayTotals(shiftChecks, currentShift,'), 'and its totals are the one sales rule');
  assert.ok(eod.includes('fetchClosedChecksRange(locationId, new Date(currentShift.openedAt), new Date()'), 'the page reads the shift\'s sales itself');
  assert.ok(eod.includes('paymentRows(salesBreakdown(shiftChecks, { range: shiftRange })).rows'), 'Payment methods is the same sales');
  assert.ok(eod.includes('{placeSplit(payPlaces, pm.method).map(part => ('), 'and names where it was taken');
  assert.ok(!eod.includes("c.shiftId === currentShift.id"), 'no sale is asked for its stamp any more');
  assert.ok(!eod.includes("if (c.method === 'cash') t.cash += total;"), 'cash and card are not the method word any more');
  const shifts = readFileSync(new URL('../backoffice/sections/Shift.jsx', import.meta.url), 'utf8');
  assert.ok(shifts.includes('closeDayTotals(shiftWindowChecks(currentShift, closedChecks), currentShift)'), 'the Shifts page counts the same way');
  const rep = readFileSync(new URL('../backoffice/sections/reports/Payments.jsx', import.meta.url), 'utf8');
  assert.ok(rep.includes("placeSplit(places, 'card', { always: true })"), 'the Payment methods report shows card by place');
});
