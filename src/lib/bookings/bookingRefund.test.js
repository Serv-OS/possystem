/**
 * bookingRefund.test.js: the database half of a table booking refund
 * (supabase/functions/_shared/bookingRefund.ts, 16 Oct 2026, v5.11.70 host
 * tools), shared by adyen-modify and adyen-webhook. Node strips the types, so
 * the Deno file is imported directly and driven with a small fake PostgREST
 * client (the same shape as bookingPromote.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recomputeRefunded, settleBookingRefundEvent, partRefundFromAdyen } from '../../../supabase/functions/_shared/bookingRefund.ts';

function fakeDb({ tables = {}, errors = {} } = {}) {
  const db = {
    tables,
    from(table) {
      const st = { table, op: 'select', cols: '', filters: [], patch: null, rows: null, single: false, limitN: null };
      const run = () => {
        const errSpec = errors[`${table}.${st.op}`];
        const err = typeof errSpec === 'function' ? errSpec(st) : errSpec;
        if (err) return { data: null, error: err };
        const list = tables[table] || (tables[table] = []);
        if (st.op === 'insert') {
          list.push(...st.rows.map((r) => ({ id: `ins-${list.length + 1}`, ...r })));
          return { data: st.rows.map((r) => ({ ...r })), error: null };
        }
        let hits = list.filter((row) => st.filters.every((f) => f(row)));
        if (st.op === 'update') hits.forEach((row) => Object.assign(row, st.patch));
        if (st.limitN != null) hits = hits.slice(0, st.limitN);
        if (st.single) return { data: hits[0] ? { ...hits[0] } : null, error: null };
        return { data: hits.map((r) => ({ ...r })), error: null };
      };
      const b = {
        select(cols = '') { if (st.op === 'select') st.cols = cols; return b; },
        update(p) { st.op = 'update'; st.patch = p; return b; },
        insert(r) { st.op = 'insert'; st.rows = Array.isArray(r) ? r : [r]; return b; },
        eq(c, v) { st.filters.push((row) => String(row[c]) === String(v)); return b; },
        in(c, vs) { const set = (vs || []).map(String); st.filters.push((row) => set.includes(String(row[c]))); return b; },
        order() { return b; },
        limit(n) { st.limitN = n; return b; },
        maybeSingle() { st.single = true; return b; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
      };
      return b;
    },
  };
  return db;
}

const PID = '3f2b8c1e-1d2a-4b5c-8d9e-0a1b2c3d4e5f';
const parent = (over = {}) => ({ id: PID, booking_id: 'bk-1', location_id: 'L', kind: 'prepay', status: 'captured', amount: 76, currency: 'gbp', psp_reference: 'PSP-PAY', amount_refunded_minor: 0, ...over });
const refundRow = (over = {}) => ({ id: 'r1', booking_id: 'bk-1', kind: 'refund', status: 'pending', amount: 20, merchant_reference: `bkrf-${PID}-1`, psp_reference: 'PSP-REF-1', ...over });
// Before migration 20261016d: these columns are not there.
const noNewColumns = (st) => (/amount_refunded_minor|refund_of/.test(st.cols || '') || (st.patch && 'amount_refunded_minor' in st.patch)
  || (st.rows && st.rows.some((r) => 'refund_of' in r)))
  ? { code: '42703', message: 'column does not exist' } : null;

test('a pending part refund lowers the credit at once and keeps the payment captured', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent(), refundRow()] } });
  const r = await recomputeRefunded(db, PID);
  assert.deepEqual(r, { ok: true, refundedMinor: 2000, status: 'captured' });
  assert.equal(db.tables.booking_payments[0].amount_refunded_minor, 2000);
  assert.equal(db.tables.booking_payments[0].status, 'captured');
});

test('REFUND success settles the row; a full refund marks the payment refunded', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent(), refundRow({ amount: 76 })] } });
  const handled = await settleBookingRefundEvent(db, { eventCode: 'REFUND', success: 'true', merchantReference: `bkrf-${PID}-1`, pspReference: 'PSP-REF-1' });
  assert.equal(handled, true);
  assert.equal(db.tables.booking_payments[1].status, 'refunded');
  assert.equal(db.tables.booking_payments[0].status, 'refunded');
  assert.equal(db.tables.booking_payments[0].amount_refunded_minor, 7600);
});

test('REFUND_FAILED fails the row and gives the credit back', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent({ amount_refunded_minor: 2000 }), refundRow()] } });
  // matched by the refund's own psp even when Adyen echoes the payment reference
  const handled = await settleBookingRefundEvent(db, { eventCode: 'REFUND_FAILED', success: 'true', merchantReference: 'bkpay-bk-1-prepay-a1', pspReference: 'PSP-REF-1', reason: 'Insufficient balance' });
  assert.equal(handled, true);
  assert.equal(db.tables.booking_payments[1].status, 'failed');
  assert.match(db.tables.booking_payments[1].refusal_reason, /Refund failed: Insufficient balance/);
  assert.equal(db.tables.booking_payments[0].amount_refunded_minor, 0);
  assert.equal(db.tables.booking_payments[0].status, 'captured');
});

test('events that are not a booking refund are left to the caller', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent()] } });
  assert.equal(await settleBookingRefundEvent(db, { eventCode: 'CAPTURE', merchantReference: `bkrf-${PID}-1` }), false);
  assert.equal(await settleBookingRefundEvent(db, { eventCode: 'REFUND', success: 'true', merchantReference: 'bkpay-bk-1-prepay-a1', pspReference: 'PSP-UNKNOWN' }), false);
});

test('before the migration: no column writes, a full refund still marks the payment refunded', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent({ amount_refunded_minor: undefined }), refundRow({ amount: 76, status: 'refunded' })] }, errors: { 'booking_payments.select': noNewColumns, 'booking_payments.update': noNewColumns } });
  const r = await recomputeRefunded(db, PID);
  assert.equal(r.ok, true);
  assert.equal(db.tables.booking_payments[0].status, 'refunded');
});

test('a part refund made in Adyen becomes a refund row, never wipes the whole payment, and counts once', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent()] } });
  const item = { eventCode: 'REFUND', success: 'true', originalReference: 'PSP-PAY', pspReference: 'PSP-CA-1', amount: { value: 1000, currency: 'GBP' } };
  assert.equal(await partRefundFromAdyen(db, item), 'part');
  assert.equal(await partRefundFromAdyen(db, item), 'part'); // an Adyen retry
  const refunds = db.tables.booking_payments.filter((r) => r.kind === 'refund');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].merchant_reference, `bkrf-${PID}-0`);
  assert.equal(db.tables.booking_payments[0].amount_refunded_minor, 1000);
  assert.equal(db.tables.booking_payments[0].status, 'captured');
  // a full refund in Adyen keeps the old rule
  assert.equal(await partRefundFromAdyen(db, { ...item, pspReference: 'PSP-CA-2', amount: { value: 7600 } }), 'full');
  assert.equal(await partRefundFromAdyen(db, { ...item, originalReference: 'NOPE' }), 'none');
});

test('an Adyen answer that beats the stored psp settles the pending stand refund, never a second row', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent(), refundRow({ psp_reference: null })] } });
  const r = await partRefundFromAdyen(db, { eventCode: 'REFUND', success: 'true', originalReference: 'PSP-PAY', pspReference: 'PSP-REF-9', amount: { value: 2000 } });
  assert.equal(r, 'part');
  const refunds = db.tables.booking_payments.filter((x) => x.kind === 'refund');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].status, 'refunded');
  assert.equal(refunds[0].psp_reference, 'PSP-REF-9');
  assert.equal(db.tables.booking_payments[0].amount_refunded_minor, 2000);
});

test('REFUND ok, then REFUND_FAILED: the payment goes back to captured with nothing refunded', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent(), refundRow({ amount: 76 })] } });
  await settleBookingRefundEvent(db, { eventCode: 'REFUND', success: 'true', merchantReference: `bkrf-${PID}-1`, pspReference: 'PSP-REF-1' });
  assert.equal(db.tables.booking_payments[0].status, 'refunded');
  await settleBookingRefundEvent(db, { eventCode: 'REFUND_FAILED', success: 'true', merchantReference: `bkrf-${PID}-1`, pspReference: 'PSP-REF-1', reason: 'Refund failed at the bank' });
  assert.equal(db.tables.booking_payments[1].status, 'failed');
  assert.equal(db.tables.booking_payments[0].status, 'captured');
  assert.equal(db.tables.booking_payments[0].amount_refunded_minor, 0);
});

test('a payment fully refunded in Adyen with no refund rows stays refunded', async () => {
  const db = fakeDb({ tables: { booking_payments: [parent({ status: 'refunded' })] } });
  const r = await recomputeRefunded(db, PID);
  assert.equal(r.ok, true);
  assert.equal(db.tables.booking_payments[0].status, 'refunded');
});

test('refunding the unused part of a payment the bill used lowers what is owed back', async () => {
  const p = parent({ amount: 100, applied_to_check: true, applied_minor: 8000, refund_due_minor: 2000, refund_reason: 'give back 20.00' });
  const db = fakeDb({ tables: { booking_payments: [p, refundRow({ amount: 20 })] } });
  const r = await recomputeRefunded(db, PID);
  assert.equal(r.ok, true);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, null);
  assert.equal(db.tables.booking_payments[0].refund_reason, null);
  assert.equal(db.tables.booking_payments[0].status, 'captured');
  // the refund fails: the 20.00 is owed back again
  db.tables.booking_payments[1].status = 'failed';
  await recomputeRefunded(db, PID);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, 2000);
});

test('refunding money a guest party change flagged as owed back clears the flag, once', async () => {
  // 6 to 4 online flagged 20.00 on a payment not used on a bill (16 Oct 2026 release review).
  const p = parent({ amount: 60, applied_to_check: false, refund_due_minor: 2000, refund_reason: 'The guest changed the party online from 6 to 4' });
  const db = fakeDb({ tables: { booking_payments: [p, refundRow({ amount: 20 })] } });
  await recomputeRefunded(db, PID);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, null);
  assert.equal(db.tables.booking_payments[0].refund_reason, null);
  // Adyen confirms it: counted again, nothing changes
  db.tables.booking_payments[1].status = 'refunded';
  await recomputeRefunded(db, PID);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, null);
});

test('a part refund of money owed back lowers the figure; a failed one puts it back', async () => {
  const p = parent({ amount: 60, applied_to_check: false, refund_due_minor: 2000, refund_reason: 'owed back' });
  const db = fakeDb({ tables: { booking_payments: [p, refundRow({ amount: 5 })] } });
  await recomputeRefunded(db, PID);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, 1500);
  assert.equal(db.tables.booking_payments[0].refund_reason, 'owed back');
  db.tables.booking_payments[1].status = 'failed';
  await recomputeRefunded(db, PID);
  assert.equal(db.tables.booking_payments[0].refund_due_minor, 2000);
});
