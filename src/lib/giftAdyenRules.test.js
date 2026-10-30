// src/lib/giftAdyenRules.test.js (29 Oct 2026, v5.11.115): online gift cards sell at an Adyen venue.
// The purchase id travels as Adyen's merchantReference (`gift:<id>`); the webhook issues the card
// and gift-fulfill proves the money against the ledger row for that reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  giftReference, giftPurchaseIdFromReference, adyenLedgerProvesPurchase, adyenGiftAmountOk,
} from '../../supabase/functions/_shared/giftAdyenRules.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const ID = '0b4f1c2e-7d3a-4e8b-9c1d-2a3b4c5d6e7f';

test('the reference carries the purchase id both ways and nothing else parses', () => {
  assert.equal(giftReference(ID), `gift:${ID}`);
  assert.equal(giftPurchaseIdFromReference(`gift:${ID}`), ID);
  assert.equal(giftPurchaseIdFromReference(`gift:${ID.toUpperCase()}`), ID);
  assert.equal(giftPurchaseIdFromReference('SV-1007'), null);
  assert.equal(giftPurchaseIdFromReference('gift:not-a-uuid'), null);
  assert.equal(giftPurchaseIdFromReference('tj-abc'), null);
  assert.equal(giftPurchaseIdFromReference(null), null);
  assert.ok(giftReference(ID).length <= 80, 'Adyen merchantReference limit');
});

test('the ledger row proves the purchase only when paid, for this purchase, at least the amount, in the currency', () => {
  const p = { id: ID, amount_minor: 2500, currency: 'gbp' };
  const good = { merchant_reference: `gift:${ID}`, success: true, last_event_code: 'AUTHORISATION', amount_minor: 2500, currency: 'GBP' };
  assert.deepEqual(adyenLedgerProvesPurchase(good, p), { ok: true });
  assert.deepEqual(adyenLedgerProvesPurchase({ ...good, last_event_code: 'CAPTURE' }, p), { ok: true });
  assert.deepEqual(adyenLedgerProvesPurchase(null, p), { ok: false, reason: 'no_session' });
  assert.deepEqual(adyenLedgerProvesPurchase({ ...good, success: false }, p), { ok: false, reason: 'not_paid' });
  assert.deepEqual(adyenLedgerProvesPurchase({ ...good, last_event_code: 'CANCELLATION' }, p), { ok: false, reason: 'not_paid' });
  assert.deepEqual(adyenLedgerProvesPurchase({ ...good, merchant_reference: 'gift:11111111-2222-4333-8444-555555555555' }, p), { ok: false, reason: 'session_not_for_purchase' });
  assert.deepEqual(adyenLedgerProvesPurchase({ ...good, amount_minor: 2499 }, p), { ok: false, reason: 'amount_short' });
  assert.deepEqual(adyenLedgerProvesPurchase({ ...good, currency: 'USD' }, p), { ok: false, reason: 'currency_mismatch' });
  assert.deepEqual(adyenLedgerProvesPurchase(good, { ...p, amount_minor: 0 }), { ok: false, reason: 'purchase_amount_invalid' });
});

test('the webhook amount fence: never a card worth more than Adyen authorised', () => {
  assert.equal(adyenGiftAmountOk(2500, 2500), true);
  assert.equal(adyenGiftAmountOk(3000, 2500), true);
  assert.equal(adyenGiftAmountOk(2499, 2500), false);
  assert.equal(adyenGiftAmountOk(undefined, 2500), false);
  assert.equal(adyenGiftAmountOk(2500, 0), false);
});

test('gift-checkout-session sells through the venue\'s own Adyen store, in page, and nothing else', () => {
  const src = read('supabase/functions/gift-checkout-session/index.ts');
  // Drop D (29 Oct 2026): no processor gate, no Stripe Checkout Session, no Ryft session.
  assert.ok(!src.includes('payment_processor'), 'Adyen is the only processor: nothing to look up');
  assert.ok(!/esm\.sh\/stripe|merchant_stripe_accounts|merchant_ryft_accounts|ryft-create-payment-session/.test(src));
  const i = src.indexOf("// ── Adyen (29 Oct 2026, Drop D: the only processor)");
  assert.ok(i > 0);
  const block = src.slice(i);
  assert.ok(block.includes("from('merchant_adyen_accounts')") && block.includes('receive_payments_ok'), 'the venue must be able to take money');
  assert.ok(block.includes("processor: 'adyen'") && block.includes('reference: giftReference(aPurchase.id)'), 'the row and its reference');
  assert.ok(!block.includes('checkout_url'), 'no hosted page: the customer pays in page');
  assert.ok(!src.includes("if (!success_url || !cancel_url)"), 'the old hosted page urls are no longer required');
});

test('adyen-webhook issues the card on a verified AUTHORISATION for a gift reference, fenced on amount', () => {
  const src = read('supabase/functions/adyen-webhook/index.ts');
  assert.ok(src.includes("import { giftPurchaseIdFromReference, adyenGiftAmountOk } from '../_shared/giftAdyenRules.js';"));
  const hook = src.indexOf("if (!isModification && code === 'AUTHORISATION' && okEvent) {\n      const giftId = giftPurchaseIdFromReference(merchantReference);");
  const upsert = src.indexOf("let { error: upErr } = await platformAdmin.from('adyen_payments')");
  assert.ok(upsert > 0 && hook > upsert, 'after the ledger row is written, so the proof can read it');
  const fn = src.slice(src.indexOf('async function maybeFulfilGift('));
  assert.ok(fn.includes("if (!adyenGiftAmountOk(authorised, p.amount_minor))"), 'amount fence');
  assert.ok(fn.includes(".update({ status: 'paid' })") && fn.includes(".eq('status', 'pending')"), 'pending to paid only');
  assert.ok(fn.includes("functions/v1/gift-fulfill") && fn.includes("SUPABASE_SERVICE_ROLE_KEY"), 'issues through gift-fulfill as the service role');
});

test('gift-fulfill proves an Adyen purchase against the ledger row at its own venue', () => {
  const proof = read('supabase/functions/_shared/giftPurchaseProof.ts');
  assert.ok(proof.includes("if (v === 'adyen') return 'adyen';"));
  const src = read('supabase/functions/gift-fulfill/index.ts');
  assert.ok(src.includes("import { giftReference, adyenLedgerProvesPurchase } from '../_shared/giftAdyenRules.js';"));
  const i = src.indexOf("if (processor === 'adyen') {");
  const block = src.slice(i, src.indexOf("return { ok: false, reason: 'processor_unverifiable' };"));
  assert.ok(block.includes(".from('adyen_payments')") && block.includes(".eq('merchant_reference', giftReference(purchase.id))"));
  assert.ok(block.includes("String(led.location_id || '') !== String(purchase.location_id || '')"), 'the row must belong to the purchase venue');
  assert.ok(block.includes('return adyenLedgerProvesPurchase(led, purchase);'));
});

test('the gift page pays in page on Adyen with the server reference and only navigates on success', () => {
  const src = read('src/surfaces/gift/GiftPurchaseSurface.jsx');
  assert.ok(src.includes("import AdyenPaymentForm from '../../components/AdyenPaymentForm';"));
  assert.ok(src.includes("if (data.processor === 'adyen' && data.reference) {"));
  assert.ok(!/checkout_url|RyftPaymentForm|ryftSession/.test(src), 'no redirect and no other processor: Adyen in page is the only way to pay');
  assert.ok(src.includes('signInAnonymously()'), 'adyen-checkout needs a session; the page signs in anonymously first');
  const form = src.slice(src.indexOf('<AdyenPaymentForm'), src.indexOf('/>', src.indexOf('<AdyenPaymentForm')));
  assert.ok(form.includes('reference={adyenSession.reference}') && form.includes('amountMinor={adyenSession.amount_minor || amountMinor}'));
  assert.ok(form.includes("purchase_id=${encodeURIComponent(adyenSession.purchase_id)}"), 'success page polls by purchase id');
  assert.ok(src.includes('{!adyenSession && amountMinor > 0 && ('), 'the buy button gives way to the form');
});
