// Cards on file for a signed in member (19 Nov 2026, the customer app opens the web ordering
// page signed in): the lookup names the shopper, the member's cards come back, the payment
// carries the shopper, and the card is kept only when asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPaymentMethodsRequest, resolvePaymentMethods } from './adyenWallets.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the methods lookup names the shopper only when given, trimmed to 80', () => {
  const base = { locationId: 'loc', amountMinor: 500, currency: 'gbp' };
  assert.equal('shopper_reference' in buildPaymentMethodsRequest(base), false);
  assert.equal('shopper_reference' in buildPaymentMethodsRequest({ ...base, shopperReference: '  ' }), false);
  assert.equal(buildPaymentMethodsRequest({ ...base, shopperReference: ' c1 ' }).shopper_reference, 'c1');
  assert.equal(buildPaymentMethodsRequest({ ...base, shopperReference: 'x'.repeat(100) }).shopper_reference.length, 80);
});

test('the member\'s cards on file reach Drop-in, cards with an id only, nothing else of the answer', () => {
  const scheme = { type: 'scheme', name: 'Cards' };
  const data = { ok: true, paymentMethods: [scheme], storedPaymentMethods: [
    { type: 'scheme', id: 'st1', brand: 'visa', lastFour: '4242' },
    { type: 'scheme', brand: 'mc' },
    { type: 'paypal', id: 'st2' },
  ] };
  const r = resolvePaymentMethods({ data });
  assert.deepEqual(r.response.storedPaymentMethods, [{ type: 'scheme', id: 'st1', brand: 'visa', lastFour: '4242' }]);
  assert.equal('storedPaymentMethods' in resolvePaymentMethods({ data: { ok: true, paymentMethods: [scheme] } }).response, false);
  assert.equal('storedPaymentMethods' in resolvePaymentMethods({ data: { ok: true, paymentMethods: [scheme], storedPaymentMethods: 'no' } }).response, false);
});

test('the form, the checkout and the function are wired for a member\'s cards', () => {
  const form = read('../../components/AdyenPaymentForm.jsx');
  assert.match(form, /shopperReference: shopperReference \|\| undefined,/);
  assert.match(form, /if \(shopperReference && !storeCard\) \{\s*paymentMethodsConfiguration\.card = \{ \.\.\.\(paymentMethodsConfiguration\.card \|\| \{\}\), enableStoreDetails: true \};/);
  assert.match(form, /\.\.\.\(shopperReference \? \{ shopper_reference: shopperReference, \.\.\.\(\(storeCard \|\| state\.data\.storePaymentMethod === true\) \? \{ store_card: true \} : \{\}\) \} : \{\}\),/);
  const checkout = read('../../surfaces/online/OnlineCheckout.jsx');
  assert.match(checkout, /shopperReference=\{memberCustomerId \|\| undefined\}/);
  const fn = read('../../../supabase/functions/adyen-checkout/index.ts');
  assert.match(fn, /if \(shopperRef\) request\.shopperReference = shopperRef;/);
  assert.match(fn, /const stored = shopperRef && Array\.isArray\(j\.storedPaymentMethods\)/);
  assert.match(fn, /if \(shopperRef\) payment\.shopperReference = shopperRef;/);
  assert.match(fn, /payment\.recurringProcessingModel = 'CardOnFile';/);
  // The card is never kept without the member's id or without being asked.
  assert.match(fn, /if \(body\.store_card && shopperRef\) \{\s*payment\.storePaymentMethod = true;/);
});
