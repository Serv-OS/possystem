// paymentProofRules.test.js: what the payment-proof edge function accepts as proof that money
// was taken (database fence stage 1, contract C0). The amount always comes from the processor's
// record, never the request; the payment must belong to this venue and be in the right state.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProofRequest, stripeProof, ryftProof, adyenProof, giftProof, loyaltyProof, allowProofRequest,
} from '../../supabase/functions/_shared/paymentProofRules.js';

const OPS = '7218c716-eeb4-4f96-b284-f3500823595c';

test('the request is checked before anything is looked up', () => {
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'stripe', kind: 'card', payment_ref: 'pi_1' }).ok, true);
  assert.equal(parseProofRequest({ ops_location_id: 'loc-demo', processor: 'stripe', kind: 'card', payment_ref: 'pi' }).reason, 'venue');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'paypal', kind: 'card', payment_ref: 'x' }).reason, 'processor');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'stripe', kind: 'refund', payment_ref: 'x' }).reason, 'kind');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'stripe', kind: 'card', payment_ref: '' }).reason, 'payment_ref');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'stripe', kind: 'gift', payment_ref: 'x' }).reason, 'kind', 'a gift proof comes from the gift ledger only');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'gift', kind: 'card', payment_ref: 'x' }).reason, 'kind');
  assert.equal(parseProofRequest(null).reason, 'venue');
});

test('Stripe: amount_received for a card or capture, amount_capturable for a hold, venue from metadata', () => {
  const pi = (o) => ({ status: 'succeeded', amount_received: 1250, amount_capturable: 0, currency: 'gbp', metadata: { ops_location_id: OPS }, ...o });
  assert.deepEqual(stripeProof(pi(), 'card', OPS), { ok: true, amount_minor: 1250, currency: 'GBP' });
  assert.deepEqual(stripeProof(pi(), 'capture', OPS), { ok: true, amount_minor: 1250, currency: 'GBP' });
  assert.equal(stripeProof(pi({ metadata: { ops_location_id: 'other' } }), 'card', OPS).reason, 'other_venue');
  assert.equal(stripeProof(pi({ metadata: {} }), 'card', OPS).reason, 'other_venue', 'no venue on the intent is no proof');
  assert.equal(stripeProof(pi({ status: 'requires_payment_method' }), 'card', OPS).reason, 'not_paid');
  assert.deepEqual(stripeProof(pi({ status: 'requires_capture', amount_capturable: 2500, amount_received: 0 }), 'preauth', OPS), { ok: true, amount_minor: 2500, currency: 'GBP' });
  assert.equal(stripeProof(pi(), 'preauth', OPS).reason, 'captured', 'a captured hold is not an open tab');
  assert.equal(stripeProof(pi({ status: 'requires_capture', amount_received: 0 }), 'card', OPS).reason, 'not_paid', 'a hold is not money taken');
  assert.equal(stripeProof(null, 'card', OPS).reason, 'not_seen');
});

test('Ryft: Approved automatic or Captured is a card; Approved manual is a hold; Captured is a capture', () => {
  const s = (o) => ({ status: 'Approved', amount: 900, captureFlow: 'Automatic', currency: 'GBP', ...o });
  assert.deepEqual(ryftProof(s(), 'card'), { ok: true, amount_minor: 900, currency: 'GBP' });
  assert.equal(ryftProof(s({ captureFlow: 'Manual' }), 'card').reason, 'not_paid');
  assert.deepEqual(ryftProof(s({ captureFlow: 'Manual' }), 'preauth'), { ok: true, amount_minor: 900, currency: 'GBP' });
  assert.deepEqual(ryftProof(s({ status: 'Captured', capturedAmount: 700 }), 'capture'), { ok: true, amount_minor: 700, currency: 'GBP' });
  assert.equal(ryftProof(s(), 'capture').reason, 'not_captured');
  assert.equal(ryftProof(s({ paymentSettings: { platform: { paymentFees: { combined: { bookTo: 'acc_other' } } } } }), 'card', { venueAccountId: 'acc_mine' }).reason, 'other_venue');
  assert.equal(ryftProof(s({ status: 'PendingPayment' }), 'card').reason, 'not_paid');
});

test('Adyen: the webhook ledger row, for this venue, in the right state', () => {
  const row = (o) => ({ location_id: 'P1', success: true, amount_minor: 1500, currency: 'GBP', capture_required: false, captured_at: null, last_event_code: 'AUTHORISATION', raw: {}, ...o });
  assert.deepEqual(adyenProof(row(), 'card', { venuePlatformIds: ['P1'] }), { ok: true, amount_minor: 1500, currency: 'GBP' });
  assert.equal(adyenProof(row({ location_id: 'P2' }), 'card', { venuePlatformIds: ['P1'] }).reason, 'other_venue');
  assert.equal(adyenProof(row({ success: false }), 'card', { venuePlatformIds: ['P1'] }).reason, 'not_paid');
  assert.equal(adyenProof(row({ last_event_code: 'CANCELLATION' }), 'card', { venuePlatformIds: ['P1'] }).reason, 'cancelled');
  assert.equal(adyenProof(row({ capture_required: true }), 'card', { venuePlatformIds: ['P1'] }).reason, 'not_paid', 'an open hold is not money taken');
  assert.deepEqual(adyenProof(row({ capture_required: true }), 'preauth', { venuePlatformIds: ['P1'] }), { ok: true, amount_minor: 1500, currency: 'GBP' });
  assert.equal(adyenProof(row({ capture_required: null }), 'preauth', { venuePlatformIds: ['P1'] }).ok, true, 'an online hold whose notification did not echo PreAuth');
  assert.equal(adyenProof(row({ capture_required: false }), 'preauth', { venuePlatformIds: ['P1'] }).reason, 'not_held');
  assert.equal(adyenProof(row({ capture_required: null, captured_at: 'x' }), 'preauth', { venuePlatformIds: ['P1'] }).reason, 'captured');
  assert.deepEqual(adyenProof(row({ capture_required: true, captured_at: 'x', raw: { captured_minor: 1200 } }), 'capture', { venuePlatformIds: ['P1'] }), { ok: true, amount_minor: 1200, currency: 'GBP' });
  assert.equal(adyenProof(row({ capture_required: true }), 'capture', { venuePlatformIds: ['P1'] }).reason, 'not_captured');
  assert.equal(adyenProof(null, 'card', { venuePlatformIds: ['P1'] }).reason, 'not_seen', 'a webhook that has not landed yet');
});

test('gift and loyalty proofs come from the ledgers of this company or venue', () => {
  assert.deepEqual(giftProof({ type: 'redeem', company_id: 'C1', amount_minor: -800 }, { companyId: 'C1' }), { ok: true, amount_minor: 800, currency: null });
  assert.equal(giftProof({ type: 'redeem', company_id: 'C2', amount_minor: -800 }, { companyId: 'C1' }).reason, 'other_venue');
  assert.equal(giftProof({ type: 'issue', company_id: 'C1', amount_minor: 800 }, { companyId: 'C1' }).reason, 'not_redeem');
  assert.equal(giftProof(null, { companyId: 'C1' }).reason, 'not_seen');
  assert.deepEqual(loyaltyProof({ type: 'redeem', company_id: 'C1' }, { companyId: 'C1' }), { ok: true, amount_minor: 1, currency: null });
  assert.deepEqual(loyaltyProof({ type: 'redeem', location_id: OPS }, { opsLocationId: OPS, rewardValueMinor: 450 }), { ok: true, amount_minor: 450, currency: null });
  assert.equal(loyaltyProof({ type: 'redeem', company_id: 'C9', location_id: 'x' }, { companyId: 'C1', opsLocationId: OPS }).reason, 'other_venue');
  assert.equal(loyaltyProof({ type: 'earn', company_id: 'C1' }, { companyId: 'C1' }).reason, 'not_redeem');
});

test('about 30 proofs per caller in 10 minutes', () => {
  let h = [];
  for (let i = 0; i < 30; i++) { const r = allowProofRequest(h, 1000 + i); assert.equal(r.ok, true); h = r.history; }
  assert.equal(allowProofRequest(h, 2000).ok, false);
  assert.equal(allowProofRequest(h, 1000 + 10 * 60 * 1000 + 1).ok, true, 'the window moves on');
});
