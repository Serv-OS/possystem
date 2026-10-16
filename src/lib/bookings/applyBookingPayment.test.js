// applyBookingPayment.test.js: the check stamps the booking money it used (16 Oct 2026, audit item 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBookingPayment, isMissingFunction } from './applyBookingPayment.js';

const recorder = (answers) => {
  const calls = [];
  const rpc = async (name, args) => { calls.push({ name, args }); return answers.shift() || { data: 1, error: null }; };
  return { rpc, calls };
};

test('sends the applied amount when it is known', async () => {
  const { rpc, calls } = recorder([{ data: 2, error: null }]);
  const r = await applyBookingPayment(rpc, { bookingId: 'bk1', checkId: 'chk-1', appliedMinor: 9000 });
  assert.deepEqual(r, { ok: true, rows: 2, fallback: false });
  assert.deepEqual(calls, [{ name: 'apply_booking_payment', args: { p_booking_id: 'bk1', p_closed_check_id: 'chk-1', p_applied_minor: 9000 } }]);
});

test('BEFORE THE MIGRATION: a missing 3 argument function falls back to the old 2 argument call', async () => {
  const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.apply_booking_payment(p_applied_minor, p_booking_id, p_closed_check_id)' } };
  const { rpc, calls } = recorder([missing, { data: 2, error: null }]);
  const r = await applyBookingPayment(rpc, { bookingId: 'bk1', checkId: 'chk-1', appliedMinor: 9000 });
  assert.deepEqual(r, { ok: true, rows: 2, fallback: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, { p_booking_id: 'bk1', p_closed_check_id: 'chk-1' });
});

test('a real refusal is NOT retried without the amount (it would stamp the whole row)', async () => {
  const { rpc, calls } = recorder([{ data: null, error: { code: 'P0001', message: 'no access to this booking' } }]);
  const r = await applyBookingPayment(rpc, { bookingId: 'bk1', checkId: 'chk-1', appliedMinor: 100 });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

test('no amount (an old draft): the old call exactly', async () => {
  const { rpc, calls } = recorder([{ data: 1, error: null }]);
  const r = await applyBookingPayment(rpc, { bookingId: 'bk1', checkId: 'chk-1' });
  assert.deepEqual(r, { ok: true, rows: 1, fallback: false });
  assert.deepEqual(calls[0].args, { p_booking_id: 'bk1', p_closed_check_id: 'chk-1' });
});

test('nothing to apply without a booking id or an rpc', async () => {
  assert.equal((await applyBookingPayment(null, { bookingId: 'bk1' })).ok, false);
  assert.equal((await applyBookingPayment(async () => ({}), {})).ok, false);
});

test('isMissingFunction knows the PostgREST and Postgres shapes, and nothing else', () => {
  assert.equal(isMissingFunction({ code: 'PGRST202' }), true);
  assert.equal(isMissingFunction({ code: '42883', message: 'function public.edit_booking(...) does not exist' }), true);
  assert.equal(isMissingFunction({ message: 'Could not find the function public.edit_booking' }), true);
  assert.equal(isMissingFunction({ code: 'P0001', message: 'no access to this booking' }), false);
  assert.equal(isMissingFunction(null), false);
});
