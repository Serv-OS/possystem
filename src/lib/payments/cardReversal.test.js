// Tests for the per-leg card reversal router (v5.6.79, task #107).
//
// The three processors disagree about everything — the endpoint, the id field,
// the success key, and even whether HTTP 200 means success. These lock the
// translation down so a refund can never be reported as done when it was not.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFUND_ENDPOINT, normaliseProcessor, buildRefundBody, readRefundResponse,
} from './cardReversal.js';

// ── routing ─────────────────────────────────────────────────────────────────

test('each processor has its own endpoint', () => {
  assert.equal(REFUND_ENDPOINT.stripe, 'stripe-refund');
  assert.equal(REFUND_ENDPOINT.ryft, 'ryft-refund');
  assert.equal(REFUND_ENDPOINT.adyen, 'adyen-modify');
});

test('an UNKNOWN processor is not silently treated as Stripe', () => {
  // The old rule was `processor === 'ryft' ? ryft : stripe`, which sent every
  // Adyen refund to Stripe. Unknown must now stay unknown so the caller refuses.
  assert.equal(normaliseProcessor('adyen'), 'adyen');
  assert.equal(normaliseProcessor('ADYEN'), 'adyen');
  assert.equal(normaliseProcessor('worldpay'), null);
  assert.equal(normaliseProcessor(''), null);
  assert.equal(normaliseProcessor(undefined), null);
});

// ── request shapes ──────────────────────────────────────────────────────────

const base = {
  legId: 'LEG1', amountMinor: 1500, locationId: 'loc-1',
  checkId: 'chk-1', refundId: 'ref-1', staffId: 'staff-1',
};

test('Stripe refunds by payment_intent_id', () => {
  const b = buildRefundBody({ ...base, processor: 'stripe' });
  assert.equal(b.payment_intent_id, 'LEG1');
  assert.equal(b.amount_minor, 1500);
  assert.ok(b.idempotency_key);
});

test('Ryft refunds by payment_session_id', () => {
  const b = buildRefundBody({ ...base, processor: 'ryft' });
  assert.equal(b.payment_session_id, 'LEG1');
  assert.equal(b.payment_intent_id, undefined);
});

test('Adyen sends action:refund plus a reference that makes the key deterministic', () => {
  const b = buildRefundBody({ ...base, processor: 'adyen' });
  assert.equal(b.action, 'refund');
  assert.equal(b.psp_reference, 'LEG1');
  assert.equal(b.amount_minor, 1500);
  assert.equal(b.currency, 'GBP');
  // Without a caller reference adyen-modify mints a random UUID key, and a
  // retry would then refund the card a second time.
  assert.ok(b.reference && b.reference.length <= 58);
  assert.ok(`mod:${b.reference}`.length <= 64);
});

test('the same refund+leg always builds the same key; a different refund does not', () => {
  const a = buildRefundBody({ ...base, processor: 'adyen' }).reference;
  const b = buildRefundBody({ ...base, processor: 'adyen' }).reference;
  const c = buildRefundBody({ ...base, processor: 'adyen', refundId: 'ref-2' }).reference;
  assert.equal(a, b);      // retry-safe
  assert.notEqual(a, c);   // two genuine refunds do not collapse into one
});

// ── response shapes: the trap ───────────────────────────────────────────────

test('ADYEN: HTTP 200 with ok:false is a FAILURE, not a success', () => {
  // adyen-modify's graceful-fallback contract hands scheme refusals back as a
  // 200 body. Checking res.ok alone would book every refusal as a completed
  // refund — the exact lie this rebuild exists to stop.
  const v = readRefundResponse('adyen', true, 200, { ok: false, error: 'adyen 422', detail: {} });
  assert.equal(v.status, 'failed');
  assert.ok(v.error);
});

test('ADYEN: a good answer is ACCEPTED, never succeeded', () => {
  // 'received' means Adyen took the request; the truth lands later by webhook.
  const v = readRefundResponse('adyen', true, 200, { ok: true, status: 'received', modification_psp: 'MOD1' });
  assert.equal(v.status, 'accepted');
  assert.equal(v.ref, 'MOD1');
});

test('RYFT: the success key is `success`, and the id is nested under `refund`', () => {
  const v = readRefundResponse('ryft', true, 200, { success: true, refund: { id: 'rf_1' } });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.ref, 'rf_1');
  const bad = readRefundResponse('ryft', false, 400, { error: 'ryft says no' });
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error, 'ryft says no');
});

test('STRIPE: confirmed synchronously, id in refund_id', () => {
  const v = readRefundResponse('stripe', true, 200, { ok: true, refund_id: 're_1', status: 'succeeded' });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.ref, 're_1');
  const bad = readRefundResponse('stripe', false, 502, { error: 'Stripe refund failed: no such pi' });
  assert.equal(bad.status, 'failed');
  assert.ok(bad.error.includes('no such pi'));
});

test('an empty or unparseable body is a failure, never an assumed success', () => {
  for (const p of ['stripe', 'ryft', 'adyen']) {
    assert.equal(readRefundResponse(p, false, 500, {}).status, 'failed');
    assert.equal(readRefundResponse(p, false, 403, null).status, 'failed');
  }
});
