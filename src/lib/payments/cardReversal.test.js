// Tests for the per-leg card reversal router (v5.6.79, task #107; Adyen only since Drop D,
// 29 Oct 2026).
//
// Adyen's contract has one trap: HTTP 200 does not mean success. These lock the translation
// down so a refund can never be reported as done when it was not, and pin the plain refusal
// for a sale taken on a processor ServOS no longer works with.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFUND_ENDPOINT, RETIRED_PROCESSORS, RETIRED_PROCESSOR_MESSAGE, isRetiredProcessor,
  normaliseProcessor, buildRefundBody, readRefundResponse, reverseCardLeg,
} from './cardReversal.js';

// ── routing ─────────────────────────────────────────────────────────────────

test('Adyen is the only endpoint', () => {
  assert.deepEqual({ ...REFUND_ENDPOINT }, { adyen: 'adyen-modify' });
  assert.deepEqual([...RETIRED_PROCESSORS], ['stripe', 'ryft']);
});

test('an UNKNOWN processor is never routed anywhere', () => {
  assert.equal(normaliseProcessor('adyen'), 'adyen');
  assert.equal(normaliseProcessor('ADYEN'), 'adyen');
  assert.equal(normaliseProcessor('stripe'), null);
  assert.equal(normaliseProcessor('ryft'), null);
  assert.equal(normaliseProcessor('worldpay'), null);
  assert.equal(normaliseProcessor(''), null);
  assert.equal(normaliseProcessor(undefined), null);
});

test('a sale on a processor ServOS no longer works with is refused in plain words, with no call made', async () => {
  assert.equal(isRetiredProcessor('stripe'), true);
  assert.equal(isRetiredProcessor('RYFT'), true);
  assert.equal(isRetiredProcessor('adyen'), false);
  assert.equal(RETIRED_PROCESSOR_MESSAGE, "This payment was taken on a processor ServOS no longer works with; refund it in that processor's own dashboard");
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  try {
    for (const processor of ['stripe', 'ryft']) {
      const v = await reverseCardLeg({ processor, legId: 'pi_1', amountMinor: 500, locationId: 'loc', refundId: 'r1', functionsUrl: 'https://x', token: 't' });
      assert.deepEqual(v, { status: 'failed', ref: null, error: RETIRED_PROCESSOR_MESSAGE });
    }
    const unknown = await reverseCardLeg({ processor: 'worldpay', legId: 'x', amountMinor: 500, locationId: 'loc', refundId: 'r1', functionsUrl: 'https://x', token: 't' });
    assert.equal(unknown.status, 'failed');
    assert.match(unknown.error, /unknown processor/);
    assert.equal(called, 0, 'nothing was sent anywhere');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── request shape ───────────────────────────────────────────────────────────

const base = {
  legId: 'LEG1', amountMinor: 1500, locationId: 'loc-1',
  checkId: 'chk-1', refundId: 'ref-1', staffId: 'staff-1',
};

test('Adyen sends action:refund plus a reference that makes the key deterministic', () => {
  const b = buildRefundBody({ ...base, processor: 'adyen' });
  assert.equal(b.action, 'refund');
  assert.equal(b.psp_reference, 'LEG1');
  assert.equal(b.amount_minor, 1500);
  assert.equal(b.location_id, 'loc-1');
  assert.equal(b.currency, 'GBP');
  // Without a caller reference adyen-modify mints a random UUID key, and a
  // retry would then refund the card a second time.
  assert.ok(b.reference && b.reference.length <= 58);
  assert.ok(`mod:${b.reference}`.length <= 64);
  assert.deepEqual(Object.keys(b).sort(), ['action', 'amount_minor', 'currency', 'location_id', 'psp_reference', 'reference']);
});

test('the same refund+leg always builds the same key; a different refund does not', () => {
  const a = buildRefundBody({ ...base, processor: 'adyen' }).reference;
  const b = buildRefundBody({ ...base, processor: 'adyen' }).reference;
  const c = buildRefundBody({ ...base, processor: 'adyen', refundId: 'ref-2' }).reference;
  assert.equal(a, b);      // retry-safe
  assert.notEqual(a, c);   // two genuine refunds do not collapse into one
});

// ── response shape: the trap ────────────────────────────────────────────────

test('ADYEN: HTTP 200 with ok:false is a FAILURE, not a success', () => {
  // adyen-modify's graceful-fallback contract hands scheme refusals back as a
  // 200 body. Checking res.ok alone would book every refusal as a completed
  // refund — the exact lie this rebuild exists to stop.
  const v = readRefundResponse('adyen', true, 200, { ok: false, error: 'adyen 422', detail: {} });
  assert.equal(v.status, 'failed');
  assert.ok(v.error);
  const d = readRefundResponse('adyen', true, 200, { ok: false, detail: { message: 'refused by scheme' } });
  assert.equal(d.error, 'refused by scheme');
});

test('ADYEN: a good answer is ACCEPTED, never succeeded', () => {
  // 'received' means Adyen took the request; the truth lands later by webhook.
  const v = readRefundResponse('adyen', true, 200, { ok: true, status: 'received', modification_psp: 'MOD1' });
  assert.equal(v.status, 'accepted');
  assert.equal(v.ref, 'MOD1');
});

test('an empty or unparseable body is a failure, never an assumed success', () => {
  assert.equal(readRefundResponse('adyen', false, 500, {}).status, 'failed');
  assert.equal(readRefundResponse('adyen', false, 403, null).status, 'failed');
  assert.match(readRefundResponse('adyen', false, 500, {}).error, /HTTP 500/);
});
