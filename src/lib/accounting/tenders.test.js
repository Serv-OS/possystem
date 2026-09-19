/**
 * tenders.test.js — closed_checks.tenders as every checkout writes it (v5.9.11), and that
 * the accounting layer reads it back exactly.
 * Run: `npm test`, or `node --test src/lib/accounting/tenders.test.js`.
 *
 * Pinned:
 *   1. The till (CheckoutModal): gift card AS DEBITED, loyalty and promo credit, booking
 *      credit, card reader legs and the till's own leg add up to the booked gross + tips.
 *   2. A split bill: one tender per portion (this is the data the old row map dropped).
 *   3. Channel orders: the platform is the method; tab card legs carry the tab tip once.
 *   4. The fallback never uses a composite method ('gift_card+card') as a method.
 *   5. The row map sends tenders only when there are some; the safe writer drops a column
 *      the database does not have yet and still lands the sale.
 *   6. Parity: what a checkout writes is what _shared/accountingDay.js reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tender, finishTenders, singleTender, tillTenders, splitTenders,
  channelTenders, cardLegTenders, tendersFromPaymentInfo, tendersTotalMinor, tenderMethod,
} from './tenders.js';
import { closedCheckRow } from '../closedCheckRow.js';
import { writeClosedCheckRow, missingColumnOf, resetMissingColumns } from '../closedCheckWrite.js';
import { checkTenders, canonicalMethod } from '../../../supabase/functions/_shared/accountingDay.js';

test('one tender: rounded to the penny, empty ones dropped, extras only when set', () => {
  assert.deepEqual(tender('Card', 10.004, 1.006, { pspRef: 'P', processor: 'adyen' }), { method: 'card', amount: 10, tip: 1.01, psp_ref: 'P', processor: 'adyen' });
  assert.equal(tender('cash', 0, 0), null);
  assert.equal(tender('cash', -3), null);
  assert.deepEqual(tender('gift', 5, 0, { giftCardId: 'G' }), { method: 'gift_card', amount: 5, tip: 0, gift_card_id: 'G' });
  assert.equal(finishTenders([null, null]), null);
  assert.deepEqual(singleTender('card', 23, 3), [{ method: 'card', amount: 20, tip: 3 }]);
  assert.equal(tenderMethod(''), 'card');
});

test('the till: plain card and plain cash', () => {
  assert.deepEqual(tillTenders({ method: 'card', tillMoney: 22, tip: 2, pspRef: 'PI', processor: 'stripe' }),
    [{ method: 'card', amount: 20, tip: 2, psp_ref: 'PI', processor: 'stripe' }]);
  assert.deepEqual(tillTenders({ method: 'cash', tillMoney: 12.5, tip: 0 }), [{ method: 'cash', amount: 12.5, tip: 0 }]);
});

test('the till: every credit beside the card, adding up to bill + tip', () => {
  // bill 40, tip 3: booking deposit 5, gift card debited 10 (1000 minor), loyalty 2, promo 3,
  // so the card took 40 + 3 - 5 - 10 - 2 - 3 = 23 (dueAfterGift).
  const t = tillTenders({
    method: 'card', tillMoney: 23, tip: 3, pspRef: 'PI', processor: 'adyen',
    giftRecord: { card_id: 'G', applied: 1000 }, loyaltyCredit: 2, promoCredit: 3,
    bookingPayment: { legs: [{ method: 'booking_deposit', amountMinor: 500 }] },
  });
  assert.deepEqual(t.map((x) => [x.method, x.amount, x.tip]), [
    ['booking_deposit', 5, 0], ['gift_card', 10, 0], ['loyalty', 2, 0], ['promo', 3, 0], ['card', 20, 3],
  ]);
  assert.equal(tendersTotalMinor(t), 4300);
});

test('the till: a gift card that covers everything leaves no money leg; a short gift card is recorded as debited', () => {
  assert.deepEqual(tillTenders({ method: 'gift_card', tillMoney: 0, tip: 0, giftRecord: { card_id: 'G', applied: 1500 } }),
    [{ method: 'gift_card', amount: 15, tip: 0, gift_card_id: 'G' }]);
  // staged 10 but only 6 was left on the card: 6 is what the tender says
  const t = tillTenders({ method: 'cash', tillMoney: 20, tip: 0, giftRecord: { card_id: 'G', applied: 600, uncollected: 400 } });
  assert.deepEqual(t.map((x) => [x.method, x.amount]), [['gift_card', 6], ['cash', 20]]);
  // a failed commit took nothing
  assert.deepEqual(tillTenders({ method: 'card', tillMoney: 20, giftRecord: { card_id: 'G', applied: 0, commit_error: 'x' } }).map((x) => x.method), ['card']);
});

test('the till: a tip the gift card paid is still a tip', () => {
  // bill 20 + tip 2, gift card covered all 22: nothing taken at the till
  const t = tillTenders({ method: 'gift_card', tillMoney: 0, tip: 2, giftRecord: { card_id: 'G', applied: 2200 } });
  assert.deepEqual(t.map((x) => [x.method, x.amount, x.tip]), [['gift_card', 20, 2]]);
  // bill 20 + tip 2, gift card 21, card took the last 1: the card takes 1 of the tip, the gift card the other
  const u = tillTenders({ method: 'card', tillMoney: 1, tip: 2, giftRecord: { card_id: 'G', applied: 2100 } });
  assert.deepEqual(u.map((x) => [x.method, x.amount, x.tip]), [['gift_card', 20, 1], ['card', 0, 1]]);
  assert.equal(tendersTotalMinor(u), 2200);
});

test('the till: a table part paid on the card reader books every reader leg and the till leg', () => {
  const t = tillTenders({
    method: 'cash', tillMoney: 15, tip: 0,
    readerLegs: [{ chargeMinor: 2200, tipMinor: 200, transactionId: 'PSP-A' }, { chargeMinor: 0, tipMinor: 0 }, { chargeMinor: 1000, tipMinor: 0, transactionId: 'PSP-B' }],
  });
  assert.deepEqual(t.map((x) => [x.method, x.amount, x.tip, x.psp_ref || null]), [
    ['card', 20, 2, 'PSP-A'], ['card', 10, 0, 'PSP-B'], ['cash', 15, 0, null],
  ]);
  assert.equal(t[0].processor, 'adyen');
  assert.equal(tendersTotalMinor(t), 4700);   // booked grand = billDue 15 + tip 0 + legs 32
});

test('a split bill: one tender per portion, gift portions as debited, reader tips from the server', () => {
  const portions = [
    { id: 'p0', method: 'card', total: 20, paid: true, paymentIntentId: 'PI0', terminalJob: { jobId: 'J0' } },
    { id: 'p1', method: 'cash', total: 12, paid: true, tip: 0 },
    { id: 'p2', method: 'gift_card', total: 8, paid: true },
  ];
  const t = splitTenders(portions, {
    legTip: (p) => (p.id === 'p0' ? 2.5 : 0),
    giftLegs: [{ card_id: 'G', applied: 700, portion_id: 'p2', uncollected: 100 }],
    processor: 'adyen',
  });
  assert.deepEqual(t.map((x) => [x.method, x.amount, x.tip]), [['card', 20, 2.5], ['cash', 12, 0], ['gift_card', 7, 0]]);
  assert.equal(t[0].psp_ref, 'PI0');
  assert.equal(t[2].gift_card_id, 'G');
});

test('channel orders: the platform is the method, the channel tip on the platform payment', () => {
  const t = channelTenders([{ name: 'Online payment', ref: 'DR-1', amount: 30 }], { tip: 2, channel: 'Deliveroo' });
  assert.deepEqual(t, [{ method: 'deliveroo', amount: 28, tip: 2, psp_ref: 'DR-1' }]);
  const t2 = channelTenders([{ name: 'Uber Eats', amount: 20 }, { name: 'POS cash', amount: 5 }], { tip: 0, channel: null });
  assert.deepEqual(t2.map((x) => x.method), ['uber_eats', 'cash']);
});

test('tab card legs: the hold capture and the overage, the tab tip once', () => {
  const t = cardLegTenders([{ amount: 40, pspRef: 'HOLD', processor: 'stripe' }, { amount: 6, pspRef: null, processor: 'stripe' }, { amount: 0 }], { tip: 4 });
  assert.deepEqual(t.map((x) => [x.amount, x.tip, x.psp_ref || null]), [[36, 4, 'HOLD'], [6, 0, null]]);
});

test('the fallback: gift card and booking split out; a composite method is never used as a method', () => {
  const t = tendersFromPaymentInfo({ method: 'gift_card+card', giftCard: { card_id: 'G', applied: 1000 }, stripePaymentIntentId: 'PI', processor: 'ryft' }, { total: 32, tip: 2 });
  assert.deepEqual(t.map((x) => [x.method, x.amount, x.tip]), [['gift_card', 10, 0], ['card', 20, 2]]);
  assert.equal(t[1].psp_ref, 'PI');
  assert.equal(tendersFromPaymentInfo({ method: 'loyalty+split' }, { total: 10 }), null);
  assert.deepEqual(tendersFromPaymentInfo({}, { total: 5, tip: 0 }), [{ method: 'card', amount: 5, tip: 0 }]);
  const given = [{ method: 'cash', amount: 3, tip: 0 }];
  assert.deepEqual(tendersFromPaymentInfo({ tenders: given, method: 'split' }, { total: 99 }), given);
  const booking = tendersFromPaymentInfo({ method: 'booking+cash', bookingPayment: { legs: [{ method: 'booking_prepaid', amountMinor: 1500 }] } }, { total: 25 });
  assert.deepEqual(booking.map((x) => [x.method, x.amount]), [['booking_prepaid', 15], ['cash', 10]]);
});

test('parity: what a checkout writes is what the accounting layer reads, to the penny', () => {
  const written = tillTenders({
    method: 'card', tillMoney: 23, tip: 3, pspRef: 'PI', processor: 'adyen',
    giftRecord: { card_id: 'G', applied: 1000 }, loyaltyCredit: 2, promoCredit: 3,
    bookingPayment: { legs: [{ method: 'booking_deposit', amountMinor: 500 }] },
  });
  const read = checkTenders({ total: 43, tip: 3, tenders: written });
  assert.equal(read.legacy, false);
  assert.deepEqual(read.flags, []);
  assert.deepEqual(read.tenders.map((t) => [t.method, t.kind, t.amount, t.tip, t.pspRef, t.giftCardId]), [
    ['booking_deposit', 'deposit', 500, 0, null, null],
    ['gift_card', 'gift_card', 1000, 0, null, 'G'],
    ['loyalty', 'discount', 200, 0, null, null],
    ['promo', 'discount', 300, 0, null, null],
    ['card', 'card', 2000, 300, 'PI', null],
  ]);
  for (const m of ['Card', 'gift', 'Gift Card', 'booking_deposit', 'cash', 'Uber Eats']) assert.equal(tenderMethod(m), canonicalMethod(m), m);
});

test('the row map sends tenders only when there are some', () => {
  const base = { id: 'c1', total: 10, method: 'card', closedAt: Date.parse('2026-09-18T12:00:00Z') };
  assert.equal('tenders' in closedCheckRow(base, 'loc'), false);
  assert.equal('tenders' in closedCheckRow({ ...base, tenders: [] }, 'loc'), false);
  const row = closedCheckRow({ ...base, tenders: [{ method: 'card', amount: 10, tip: 0 }], taxBreakdown: { totalTax: 1 }, seatedAt: 1 }, 'loc');
  assert.deepEqual(row.tenders, [{ method: 'card', amount: 10, tip: 0 }]);
  assert.equal(row.location_id, 'loc');
  assert.equal(row.closed_at, '2026-09-18T12:00:00.000Z');
  // the offline replay used to drop these two; it uses this map now
  assert.deepEqual(row.tax_breakdown, { totalTax: 1 });
  assert.ok(row.seated_at);
});

// A fake supabase client: refuses any payload carrying a column in `missing`.
function fakeClient(missing = []) {
  const calls = [];
  const run = (op, payload, opts) => {
    const q = {
      _select: null,
      select(cols) { this._select = cols; return this; },
      then(res, rej) {
        calls.push({ op, payload: { ...payload }, opts, select: this._select });
        const bad = missing.find((c) => c in payload);
        const out = bad
          ? { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of 'closed_checks' in the schema cache` } }
          : { data: op === 'upsert' ? [{ id: payload.id }] : null, error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return { calls, from: (t) => { assert.equal(t, 'closed_checks'); return { insert: (p) => run('insert', p), upsert: (p, o) => run('upsert', p, o) }; } };
}

test('the safe writer: a database without the tenders column still records the sale', async () => {
  resetMissingColumns();
  const client = fakeClient(['tenders']);
  let t = 1000;
  const row = { id: 'c1', location_id: 'loc', total: 10, tenders: [{ method: 'card', amount: 10, tip: 0 }] };
  const r = await writeClosedCheckRow(client, row, { now: () => t });
  assert.equal(r.error, null);
  assert.deepEqual(r.dropped, ['tenders']);
  assert.equal(client.calls.length, 2);
  assert.equal('tenders' in client.calls[1].payload, false);
  assert.equal('tenders' in row, true, 'the caller\'s row is never changed');
  // Remembered: the next sale does not pay for a failing request...
  const r2 = await writeClosedCheckRow(client, { ...row, id: 'c2' }, { now: () => t + 60000 });
  assert.equal(r2.error, null);
  assert.equal(client.calls.length, 3);
  // ...and after 10 minutes it tries the column again (the migration may have run).
  const ok = fakeClient([]);
  const r3 = await writeClosedCheckRow(ok, { ...row, id: 'c3' }, { now: () => t + 11 * 60000 });
  assert.equal(r3.error, null);
  assert.deepEqual(ok.calls[0].payload.tenders, row.tenders);
  resetMissingColumns();
});

test('the safe writer: upsert keeps its single closer election; other errors come back untouched', async () => {
  resetMissingColumns();
  const client = fakeClient(['tenders', 'promo']);
  const r = await writeClosedCheckRow(client, { id: 'u1', location_id: 'loc', tenders: [1], promo: {} }, { upsert: true, select: 'id' });
  assert.equal(r.error, null);
  assert.deepEqual(r.data, [{ id: 'u1' }]);
  assert.deepEqual(r.dropped.sort(), ['promo', 'tenders']);
  assert.deepEqual(client.calls.at(-1).opts, { onConflict: 'id', ignoreDuplicates: true });
  assert.equal(client.calls.at(-1).select, 'id');
  resetMissingColumns();
  const other = { from: () => ({ insert: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) };
  const r2 = await writeClosedCheckRow(other, { id: 'x', location_id: 'loc' });
  assert.equal(r2.error.code, '23505');
  assert.deepEqual(r2.dropped, []);
  assert.equal(missingColumnOf({ code: '42703', message: 'column closed_checks.tenders does not exist' }), 'tenders');
  assert.equal(missingColumnOf({ code: 'PGRST204', message: "Could not find the 'tenders' column of 'closed_checks' in the schema cache" }), 'tenders');
  assert.equal(missingColumnOf({ code: '23505', message: 'dup' }), null);
  assert.equal(missingColumnOf(null), null);
});
