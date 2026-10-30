// paymentProofRules.test.js: what the payment-proof edge function accepts as proof that money
// was taken (database fence stage 1, contract C0). The amount always comes from the processor's
// record, never the request; the payment must belong to this venue and be in the right state.
// 29 Oct 2026 (Drop D): ServOS works with Adyen only. 'stripe' and 'ryft' are refused at parse.
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PROOF_PROCESSORS, parseProofRequest, adyenProof, giftProof, loyaltyProof, allowProofRequest,
  processorOrderRef, loyaltyRewardValueMinor, loyaltyRewardMeta,
} from '../../supabase/functions/_shared/paymentProofRules.js';

const OPS = '7218c716-eeb4-4f96-b284-f3500823595c';

test('the request is checked before anything is looked up', () => {
  assert.deepEqual(PROOF_PROCESSORS, ['adyen', 'gift', 'loyalty'], 'Drop D: Adyen is the only card processor');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'adyen', kind: 'card', payment_ref: 'PSP1' }).ok, true);
  assert.equal(parseProofRequest({ ops_location_id: 'loc-demo', processor: 'adyen', kind: 'card', payment_ref: 'PSP1' }).reason, 'venue');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'paypal', kind: 'card', payment_ref: 'x' }).reason, 'processor');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'stripe', kind: 'card', payment_ref: 'pi_1' }).reason, 'processor', 'Stripe is gone');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'ryft', kind: 'card', payment_ref: 'ps_1' }).reason, 'processor', 'Ryft is gone');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'adyen', kind: 'refund', payment_ref: 'x' }).reason, 'kind');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'adyen', kind: 'card', payment_ref: '' }).reason, 'payment_ref');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'adyen', kind: 'gift', payment_ref: 'x' }).reason, 'kind', 'a gift proof comes from the gift ledger only');
  assert.equal(parseProofRequest({ ops_location_id: OPS, processor: 'gift', kind: 'card', payment_ref: 'x' }).reason, 'kind');
  assert.equal(parseProofRequest(null).reason, 'venue');
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

// ── Fix round (19 Sep 2026), contract C18: a payment is bound to its order ────────

test('C18: the processor\'s own order reference is recorded, from the processor record only', () => {
  assert.equal(processorOrderRef('adyen', { merchant_reference: 'OL-AB12C' }), 'OL-AB12C');
  assert.equal(processorOrderRef('adyen', { merchant_reference: null, raw: {} }), null, 'no ref: the proof counts for the order it is attached to');
  assert.equal(processorOrderRef('adyen', { merchant_reference: 'QR-ZZ9Y8' }), 'QR-ZZ9Y8');
  assert.equal(processorOrderRef('adyen', { merchant_reference: null, raw: { merchantReference: 'CA-11AA2' } }), 'CA-11AA2');
  assert.equal(processorOrderRef('adyen', { merchant_reference: 'tj-5d2c' }), null, 'a terminal job is not an order ref');
  assert.equal(processorOrderRef('adyen', { merchant_reference: 'tab-capture:psp123' }), null);
  assert.equal(processorOrderRef('adyen', { merchant_reference: 'not a ref!' }), null, 'only the order ref shape place_public_order accepts');
  assert.equal(processorOrderRef('stripe', { metadata: { ref: 'OL-AB12C' } }), null, 'Drop D: a Stripe record is not read');
  assert.equal(processorOrderRef('ryft', { metadata: { order_ref: 'OL-RY123' } }), null, 'Drop D: a Ryft record is not read');
  assert.equal(processorOrderRef('gift', { metadata: { ref: 'OL-AB12C' } }), null);
});

test('C18: a loyalty reward with a fixed money value is proven at that value, else the marker 1', () => {
  assert.equal(loyaltyRewardValueMinor({ reward_value: { amount_minor: 350 } }), 350);
  assert.equal(loyaltyRewardValueMinor({ reward_value: { percent: 10 } }), 0);
  assert.equal(loyaltyRewardValueMinor({ reward_value: null }), 0);
  assert.equal(loyaltyRewardValueMinor(null), 0);
  const row = { type: 'redeem', company_id: 'c1' };
  assert.equal(loyaltyProof(row, { companyId: 'c1', rewardValueMinor: loyaltyRewardValueMinor({ reward_value: { amount_minor: 350 } }) }).amount_minor, 350);
  assert.equal(loyaltyProof(row, { companyId: 'c1', rewardValueMinor: 0 }).amount_minor, 1);
});

test('C25: a reward with no money value records WHAT it is, so the server never guesses', () => {
  // free item: the items it can make free (the server prices the cheapest one on the order)
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_value: { eligible_items: [{ id: 'mi-1', name: 'Latte' }] } }),
    { type: 'free_item', items: [{ id: 'mi-1', name: 'Latte' }] });
  // a stamp card programme keeps its items on reward_config
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_config: { eligible_items: [{ name: 'Coffee' }] } }),
    { type: 'free_item', items: [{ id: null, name: 'Coffee' }] });
  // percent: the percentage only
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'discount_percent', reward_value: { percent: 10 } }), { type: 'discount_percent', percent: 10 });
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'discount_percent', reward_value: { percent: 500 } }), { type: 'discount_percent', percent: 100 });
  // fix round 6: a free item reward that names NOTHING is still recorded, with an empty list.
  // It is the stamp card default, and the storefront gives the cheapest line in the basket
  // away (OnlineCheckout.jsx:911-913), so the server has to be told it is a free item at all.
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_value: { eligible_items: [] } }),
    { type: 'free_item', items: [] });
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_value: {} }), { type: 'free_item', items: [] });
  // fix round 7: the programme's own ceiling rides with it, so the server can bound a reward
  // that names nothing (it caps at 15.00 when there is none).
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_value: { eligible_items: [], max_value_minor: 450 } }),
    { type: 'free_item', items: [], max_minor: 450 });
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_config: { max_value: 3.5 } }),
    { type: 'free_item', items: [], max_minor: 350 });
  assert.deepEqual(loyaltyRewardMeta({ reward_type: 'free_item', reward_value: { max_value_minor: 0 } }),
    { type: 'free_item', items: [] }, 'a zero ceiling is no ceiling, not a free nothing');
  // nothing the server could use: null, which values the reward at zero and the order is short
  assert.equal(loyaltyRewardMeta({ reward_type: 'discount_percent', reward_value: { percent: 0 } }), null);
  assert.equal(loyaltyRewardMeta({ reward_type: 'discount_fixed', reward_value: { amount_minor: 350 } }), null, 'a fixed reward is already the proof amount');
  assert.equal(loyaltyRewardMeta(null), null);
  // a long list is trimmed, so one proof can never carry a whole menu
  const many = { reward_type: 'free_item', reward_value: { eligible_items: Array.from({ length: 80 }, (_, i) => ({ id: `mi-${i}` })) } };
  assert.equal(loyaltyRewardMeta(many).items.length, 50);
});

test('C25: payment-proof writes meta.reward for points rewards and stamp cards', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../../supabase/functions/payment-proof/index.ts', import.meta.url)), 'utf8');
  assert.ok(src.includes('rewardMeta = loyaltyRewardMeta(reward);'), 'points reward');
  assert.ok(src.includes("from('stamp_card_programs')") && src.includes('reward_type, reward_config'), 'stamp card programme');
  assert.ok(src.includes('if (rewardMeta) meta.reward = rewardMeta;'));
  assert.ok(src.includes("select('type, location_id, program_id')"), 'the stamp ledger read carries the programme');
});

test('C18: payment-proof records meta.order_ref for the Adyen ledger row and the reward value', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../../supabase/functions/payment-proof/index.ts', import.meta.url)), 'utf8');
  assert.ok(src.includes("meta.order_ref = processorOrderRef('adyen', row);"));
  assert.ok(!src.includes("processor === 'stripe'") && !src.includes("processor === 'ryft'"), 'Drop D: no Stripe or Ryft branch');
  assert.ok(!/esm\.sh\/stripe|_shared\/ryft\.ts/.test(src), 'Drop D: no Stripe SDK, no Ryft helper');
  assert.ok(src.includes('merchant_reference, raw'), 'the Adyen ledger read includes the merchant reference');
  assert.ok(src.includes('verdict = loyaltyProof(row, { companyId, opsLocationId: opsId, rewardValueMinor });'));
});

test('C18: the customer pages mint ONE order ref per checkout, so the payment\'s ref is the order\'s', () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const oc = read('../surfaces/online/OnlineCheckout.jsx');
  assert.ok(oc.includes('if (!orderIdsRef.current) {') && oc.includes('const { ref } = orderIdsRef.current;'), 'online: the payment is made before the step moves to pay');
  assert.ok(!/const ref = `OL-/.test(oc), 'no ref minted per step');
  const qc = read('../surfaces/qr/QrCheckout.jsx');
  assert.ok(qc.includes('const ref = orderRefRef.current;'));
  assert.ok(!/const ref = `QR-/.test(qc));
  assert.ok(read('../surfaces/catering/CateringCheckout.jsx').includes("const ref = useMemo(() => `CA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, []);"), 'catering was already stable');
});

test('C24 (Drop D): the overage parent ref went with the Stripe and Ryft overage paths', () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  // processorParentRef read Stripe payment_intent metadata and Ryft previousPayment only; with those
  // processors gone the helper is gone too, and payment-proof writes no meta.parent_ref.
  const rules = read('../../supabase/functions/_shared/paymentProofRules.js');
  assert.ok(!rules.includes('processorParentRef'));
  const src = read('../../supabase/functions/payment-proof/index.ts');
  assert.ok(!src.includes('parent_ref'));
});
