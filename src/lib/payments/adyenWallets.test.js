/**
 * adyenWallets.test.js: the contract for src/lib/payments/adyenWallets.js,
 * the pure half of Apple Pay and Google Pay in the online / QR / booking
 * checkouts. Pure functions only, no network and no @adyen/adyen-web.
 *
 * Run: `npm test` (Node's built-in runner, no third party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_ONLY_PAYMENT_METHODS, CHECKOUT_PAYMENT_TYPES, WALLET_TYPES, NO_NATIVE_3DS_TYPES,
  buildPaymentMethodsRequest, resolvePaymentMethods, paymentConfigFrom,
  offeredWalletTypes, walletConfiguration, missingWalletNote,
  usableWalletMethods, droppedWalletNote,
  walletLabel, isWalletType, wantsNativeThreeDS,
} from './adyenWallets.js';

const APPLE_CFG = { merchantName: 'Adyen Merchant Name', merchantId: 'merchant.com.adyen.servos' };
const GOOGLE_CFG = { gatewayMerchantId: 'ServOSECOM', merchantId: '1234567890', merchantName: 'Adyen Merchant Name' };

const fullResponse = () => ({
  paymentMethods: [
    { type: 'scheme', name: 'Cards', brands: ['visa', 'mc', 'amex'] },
    { type: 'applepay', name: 'Apple Pay', configuration: { ...APPLE_CFG } },
    { type: 'googlepay', name: 'Google Pay', brands: ['visa', 'mc'], configuration: { ...GOOGLE_CFG } },
  ],
});

// ── buildPaymentMethodsRequest ───────────────────────────────────────────────

test('buildPaymentMethodsRequest: builds the action from a real order', () => {
  const req = buildPaymentMethodsRequest({
    locationId: 'loc-1', amountMinor: 1250, currency: 'gbp', countryCode: 'gb', shopperLocale: 'en-GB',
  });
  assert.deepEqual(req, {
    action: 'payment_methods',
    location_id: 'loc-1',
    amount: { value: 1250, currency: 'GBP' },
    channel: 'Web',
    countryCode: 'GB',
    shopperLocale: 'en-GB',
    allowed_types: ['scheme', 'applepay', 'googlepay', 'paywithgoogle'],
  });
});

test('buildPaymentMethodsRequest: channel is always Web and the types default to what this checkout can mount', () => {
  const req = buildPaymentMethodsRequest({ locationId: 'loc-1', amountMinor: 1 });
  assert.equal(req.channel, 'Web');
  assert.deepEqual(req.allowed_types, [...CHECKOUT_PAYMENT_TYPES]);
  // The legacy type MUST be asked for: it is the one field that decides
  // whether an older account may answer with it at all.
  assert.ok(CHECKOUT_PAYMENT_TYPES.includes('paywithgoogle'));
});

test('buildPaymentMethodsRequest: omits country, locale and types rather than sending empties', () => {
  const req = buildPaymentMethodsRequest({
    locationId: 'loc-1', amountMinor: 500, countryCode: '  ', shopperLocale: '', allowedTypes: [],
  });
  assert.ok(!('countryCode' in req));
  assert.ok(!('shopperLocale' in req));
  assert.ok(!('allowed_types' in req));
});

test('buildPaymentMethodsRequest: a country that is not two letters is dropped, not passed on', () => {
  const req = buildPaymentMethodsRequest({ locationId: 'loc-1', amountMinor: 500, countryCode: 'GBR' });
  assert.ok(!('countryCode' in req));
});

test('buildPaymentMethodsRequest: rounds a float amount to minor units', () => {
  assert.equal(buildPaymentMethodsRequest({ locationId: 'l', amountMinor: 1250.4 }).amount.value, 1250);
});

test('buildPaymentMethodsRequest: refuses no venue, no amount and a bad currency', () => {
  assert.throws(() => buildPaymentMethodsRequest({ amountMinor: 100 }), /locationId required/);
  assert.throws(() => buildPaymentMethodsRequest({ locationId: 'l', amountMinor: 0 }), /positive integer/);
  assert.throws(() => buildPaymentMethodsRequest({ locationId: 'l', amountMinor: -5 }), /positive integer/);
  assert.throws(() => buildPaymentMethodsRequest({ locationId: 'l' }), /positive integer/);
  assert.throws(() => buildPaymentMethodsRequest({ locationId: 'l', amountMinor: 100, currency: 'POUNDS' }), /3 letter/);
});

// ── resolvePaymentMethods ────────────────────────────────────────────────────

test('resolvePaymentMethods: a good answer is used as is', () => {
  const data = { ok: true, ...fullResponse(), clientKey: 'test_KEY', environment: 'test', dropinEnvironment: 'test', region: 'UK' };
  const r = resolvePaymentMethods({ data });
  assert.equal(r.fallback, false);
  assert.equal(r.reason, null);
  assert.deepEqual(r.response.paymentMethods.map((p) => p.type), ['scheme', 'applepay', 'googlepay']);
  assert.deepEqual(r.config, { clientKey: 'test_KEY', environment: 'test', region: 'UK', dropinEnvironment: 'test' });
});

test('resolvePaymentMethods: stored methods are NEVER forwarded to Drop-in', () => {
  const stored = [{ type: 'scheme', storedPaymentMethodId: 'sp1' }];
  const withStored = resolvePaymentMethods({ data: { ok: true, ...fullResponse(), storedPaymentMethods: stored, clientKey: 'k' } });
  assert.ok(!('storedPaymentMethods' in withStored.response));
  const without = resolvePaymentMethods({ data: { ok: true, ...fullResponse(), clientKey: 'k' } });
  assert.ok(!('storedPaymentMethods' in without.response));
});

test('resolvePaymentMethods: a cardOnly refusal still mounts the card form and keeps the config', () => {
  const data = { ok: false, cardOnly: true, error: 'Adyen refused the payment methods lookup (403)', clientKey: 'live_KEY', environment: 'live', dropinEnvironment: 'live', region: 'UK' };
  const r = resolvePaymentMethods({ data });
  assert.equal(r.fallback, true);
  assert.equal(r.reason, 'Adyen refused the payment methods lookup (403)');
  assert.deepEqual(r.response, CARD_ONLY_PAYMENT_METHODS);
  assert.equal(r.config.clientKey, 'live_KEY');
  assert.equal(r.config.dropinEnvironment, 'live');
});

test('resolvePaymentMethods: a transport error falls back with the error message and no config', () => {
  const r = resolvePaymentMethods({ data: null, error: new Error('Failed to fetch') });
  assert.equal(r.fallback, true);
  assert.equal(r.reason, 'Failed to fetch');
  assert.equal(r.config, null);
  assert.deepEqual(r.response, CARD_ONLY_PAYMENT_METHODS);
});

test('resolvePaymentMethods: an ok answer with an empty list is still a fallback, and says so', () => {
  const r = resolvePaymentMethods({ data: { ok: true, paymentMethods: [], clientKey: 'k' } });
  assert.equal(r.fallback, true);
  assert.match(r.reason, /no payment methods/);
});

test('resolvePaymentMethods: nothing at all still yields a mountable card form', () => {
  const r = resolvePaymentMethods();
  assert.equal(r.fallback, true);
  assert.deepEqual(r.response, CARD_ONLY_PAYMENT_METHODS);
  assert.equal(typeof r.reason, 'string');
});

test('resolvePaymentMethods: entries with no type are dropped, and an all junk list falls back', () => {
  const r = resolvePaymentMethods({ data: { ok: true, paymentMethods: [null, {}, { type: 'scheme' }], clientKey: 'k' } });
  assert.equal(r.fallback, false);
  assert.deepEqual(r.response.paymentMethods.map((p) => p.type), ['scheme']);
  const junk = resolvePaymentMethods({ data: { ok: true, paymentMethods: [null, {}], clientKey: 'k' } });
  assert.equal(junk.fallback, true);
});

// ── usableWalletMethods: the entry that would kill the whole Drop-in ─────────

test('usableWalletMethods: a googlepay entry with no merchantId is dropped and the card survives', () => {
  const response = {
    paymentMethods: [
      { type: 'scheme', name: 'Cards' },
      { type: 'googlepay', configuration: { gatewayMerchantId: 'X' } },
    ],
  };
  const { paymentMethods, dropped } = usableWalletMethods(response);
  assert.deepEqual(paymentMethods.map((p) => p.type), ['scheme']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].type, 'googlepay');
  assert.match(dropped[0].reason, /merchantId/);
});

test('usableWalletMethods: an empty string identifier is as missing as no identifier', () => {
  const response = {
    paymentMethods: [
      { type: 'scheme' },
      { type: 'googlepay', configuration: { merchantId: '', gatewayMerchantId: 'X' } },
      { type: 'paywithgoogle', configuration: { merchantId: '123', gatewayMerchantId: '   ' } },
      { type: 'applepay', configuration: { merchantName: 'Adyen Merchant Name' } },
    ],
  };
  const { paymentMethods, dropped } = usableWalletMethods(response);
  assert.deepEqual(paymentMethods.map((p) => p.type), ['scheme']);
  assert.deepEqual(dropped.map((d) => d.type), ['googlepay', 'paywithgoogle', 'applepay']);
});

test('usableWalletMethods: a fully configured response is passed through untouched', () => {
  const response = fullResponse();
  const { paymentMethods, dropped } = usableWalletMethods(response);
  assert.deepEqual(paymentMethods.map((p) => p.type), ['scheme', 'applepay', 'googlepay']);
  assert.deepEqual(dropped, []);
  assert.equal(paymentMethods[1], response.paymentMethods[1]);
});

test('usableWalletMethods: nothing at all is an empty split, not a crash', () => {
  assert.deepEqual(usableWalletMethods(null), { paymentMethods: [], dropped: [] });
  assert.deepEqual(usableWalletMethods({ paymentMethods: [null, {}] }), { paymentMethods: [], dropped: [] });
});

test('droppedWalletNote: one console line, null when there is nothing to say', () => {
  assert.equal(droppedWalletNote([]), null);
  assert.equal(droppedWalletNote(undefined), null);
  assert.match(droppedWalletNote([{ type: 'googlepay', reason: 'no configuration.merchantId' }]), /googlepay: no configuration\.merchantId/);
});

test('resolvePaymentMethods: an unmountable wallet is filtered out, the card form still mounts', () => {
  const data = {
    ok: true,
    clientKey: 'test_KEY',
    paymentMethods: [
      { type: 'scheme', name: 'Cards' },
      { type: 'applepay', configuration: { ...APPLE_CFG } },
      { type: 'googlepay', configuration: { gatewayMerchantId: 'ServOSECOM' } },
    ],
  };
  const r = resolvePaymentMethods({ data });
  assert.equal(r.fallback, false);
  assert.deepEqual(r.response.paymentMethods.map((p) => p.type), ['scheme', 'applepay']);
  assert.deepEqual(r.dropped.map((d) => d.type), ['googlepay']);
  // And the note must not then blame the browser for a wallet WE removed.
  assert.deepEqual(offeredWalletTypes(r.response), ['applepay']);
  assert.equal(missingWalletNote(offeredWalletTypes(r.response), ['scheme', 'applepay']), null);
});

test('resolvePaymentMethods: when every method was unmountable the reason says so', () => {
  const data = { ok: true, clientKey: 'k', paymentMethods: [{ type: 'googlepay', configuration: {} }] };
  const r = resolvePaymentMethods({ data });
  assert.equal(r.fallback, true);
  assert.deepEqual(r.response, CARD_ONLY_PAYMENT_METHODS);
  assert.match(r.reason, /unmountable/);
  assert.deepEqual(r.dropped.map((d) => d.type), ['googlepay']);
});

test('resolvePaymentMethods: dropped is always an array, even on the refusal paths', () => {
  assert.deepEqual(resolvePaymentMethods().dropped, []);
  assert.deepEqual(resolvePaymentMethods({ data: null, error: new Error('x') }).dropped, []);
});

test('paymentConfigFrom: no client key is no config, and an old fn build maps environment to the Drop-in', () => {
  assert.equal(paymentConfigFrom({ environment: 'test' }), null);
  assert.equal(paymentConfigFrom({ clientKey: 'k', environment: 'live' }).dropinEnvironment, 'live');
  assert.equal(paymentConfigFrom({ clientKey: 'k', environment: 'test' }).dropinEnvironment, 'test');
  assert.equal(paymentConfigFrom({ clientKey: 'k', environment: 'live', dropinEnvironment: 'live-us' }).dropinEnvironment, 'live-us');
});

// ── offeredWalletTypes ───────────────────────────────────────────────────────

test('offeredWalletTypes: names the wallets, not the card', () => {
  assert.deepEqual(offeredWalletTypes(fullResponse()), ['applepay', 'googlepay']);
  assert.deepEqual(offeredWalletTypes(CARD_ONLY_PAYMENT_METHODS), []);
  assert.deepEqual(offeredWalletTypes(null), []);
});

test('offeredWalletTypes: the legacy paywithgoogle type counts, and duplicates collapse', () => {
  const r = { paymentMethods: [{ type: 'paywithgoogle' }, { type: 'paywithgoogle' }, { type: 'ideal' }] };
  assert.deepEqual(offeredWalletTypes(r), ['paywithgoogle']);
  assert.deepEqual(WALLET_TYPES, ['applepay', 'googlepay', 'paywithgoogle']);
});

// ── walletConfiguration ──────────────────────────────────────────────────────

test('walletConfiguration: every wallet gets the real amount and country', () => {
  const cfg = walletConfiguration({ response: fullResponse(), amountMinor: 1250, currency: 'gbp', countryCode: 'gb', merchantName: 'The Anchor' });
  assert.deepEqual(Object.keys(cfg), ['applepay', 'googlepay']);
  assert.deepEqual(cfg.applepay.amount, { value: 1250, currency: 'GBP' });
  assert.equal(cfg.applepay.countryCode, 'GB');
  assert.deepEqual(cfg.googlepay.amount, { value: 1250, currency: 'GBP' });
  assert.equal(cfg.googlepay.countryCode, 'GB');
});

test('walletConfiguration: the venue name is MERGED onto Adyen configuration, never replacing it', () => {
  const cfg = walletConfiguration({ response: fullResponse(), amountMinor: 1250, currency: 'GBP', countryCode: 'GB', merchantName: 'The Anchor' });
  assert.deepEqual(cfg.applepay.configuration, { merchantName: 'The Anchor', merchantId: 'merchant.com.adyen.servos' });
  assert.deepEqual(cfg.googlepay.configuration, { gatewayMerchantId: 'ServOSECOM', merchantId: '1234567890', merchantName: 'The Anchor' });
});

test('walletConfiguration: does not mutate the response it was handed', () => {
  const response = fullResponse();
  walletConfiguration({ response, amountMinor: 100, currency: 'GBP', countryCode: 'GB', merchantName: 'The Anchor' });
  assert.equal(response.paymentMethods[1].configuration.merchantName, 'Adyen Merchant Name');
  assert.equal(response.paymentMethods[2].configuration.merchantName, 'Adyen Merchant Name');
});

test('walletConfiguration: Apple Pay keeps Adyen name when merchantId is missing', () => {
  const response = { paymentMethods: [{ type: 'applepay', configuration: { merchantName: 'Adyen Merchant Name' } }] };
  const cfg = walletConfiguration({ response, amountMinor: 100, currency: 'GBP', countryCode: 'GB', merchantName: 'The Anchor' });
  assert.equal(cfg.applepay.configuration.merchantName, 'Adyen Merchant Name');
});

test('walletConfiguration: Google Pay keeps Adyen name unless gatewayMerchantId AND merchantId are both there', () => {
  const noMerchantId = { paymentMethods: [{ type: 'googlepay', configuration: { gatewayMerchantId: 'ServOSECOM', merchantName: 'Adyen Merchant Name' } }] };
  assert.equal(
    walletConfiguration({ response: noMerchantId, amountMinor: 100, currency: 'GBP', merchantName: 'The Anchor' }).googlepay.configuration.merchantName,
    'Adyen Merchant Name',
  );
  const noGateway = { paymentMethods: [{ type: 'googlepay', configuration: { merchantId: '1234567890', merchantName: 'Adyen Merchant Name' } }] };
  assert.equal(
    walletConfiguration({ response: noGateway, amountMinor: 100, currency: 'GBP', merchantName: 'The Anchor' }).googlepay.configuration.merchantName,
    'Adyen Merchant Name',
  );
});

test('walletConfiguration: no configuration in the response means no configuration key from us', () => {
  const response = { paymentMethods: [{ type: 'applepay' }] };
  const cfg = walletConfiguration({ response, amountMinor: 100, currency: 'GBP', countryCode: 'GB', merchantName: 'The Anchor' });
  assert.ok(!('configuration' in cfg.applepay));
  assert.deepEqual(cfg.applepay.amount, { value: 100, currency: 'GBP' });
});

test('walletConfiguration: no wallets in the response is an empty block, not a crash', () => {
  assert.deepEqual(walletConfiguration({ response: CARD_ONLY_PAYMENT_METHODS, amountMinor: 100, currency: 'GBP' }), {});
  assert.deepEqual(walletConfiguration(), {});
});

test('walletConfiguration: an unusable amount is omitted rather than sent as zero or NaN', () => {
  const cfg = walletConfiguration({ response: fullResponse(), amountMinor: 0, currency: 'GBP', countryCode: 'GB' });
  assert.ok(!('amount' in cfg.applepay));
  assert.equal(cfg.applepay.countryCode, 'GB');
});

test('walletConfiguration: the legacy paywithgoogle keeps its own key so Drop-in finds it', () => {
  const response = { paymentMethods: [{ type: 'paywithgoogle', configuration: { ...GOOGLE_CFG } }] };
  const cfg = walletConfiguration({ response, amountMinor: 100, currency: 'GBP', merchantName: 'The Anchor' });
  assert.deepEqual(Object.keys(cfg), ['paywithgoogle']);
  assert.equal(cfg.paywithgoogle.configuration.merchantName, 'The Anchor');
});

// ── missingWalletNote ────────────────────────────────────────────────────────

test('missingWalletNote: nothing to say when every offered wallet rendered', () => {
  assert.equal(missingWalletNote(['applepay', 'googlepay'], ['scheme', 'applepay', 'googlepay']), null);
  assert.equal(missingWalletNote([], ['scheme']), null);
  assert.equal(missingWalletNote(undefined, undefined), null);
});

test('missingWalletNote: names Apple Pay and points at Safari', () => {
  const note = missingWalletNote(['applepay'], ['scheme']);
  assert.match(note, /Apple Pay is set up here/);
  assert.match(note, /Safari/);
  assert.ok(!note.includes('Google Pay'));
});

test('missingWalletNote: names Google Pay and points at Chrome', () => {
  const note = missingWalletNote(['googlepay'], ['scheme', 'applepay']);
  assert.match(note, /Google Pay is set up here/);
  assert.match(note, /Chrome/);
});

test('missingWalletNote: one line, not two, when both are missing', () => {
  const note = missingWalletNote(['applepay', 'googlepay'], ['scheme']);
  assert.match(note, /Apple Pay and Google Pay/);
  assert.equal(note.split('.').filter((s) => s.trim()).length, 1);
});

test('missingWalletNote: paywithgoogle offered and googlepay rendered is the same wallet', () => {
  assert.equal(missingWalletNote(['paywithgoogle'], ['googlepay']), null);
  assert.equal(missingWalletNote(['googlepay'], ['paywithgoogle']), null);
});

test('missingWalletNote: the card is never reported as a missing wallet', () => {
  assert.equal(missingWalletNote(['scheme'], []), null);
});

// ── small helpers ────────────────────────────────────────────────────────────

test('walletLabel and isWalletType', () => {
  assert.equal(walletLabel('applepay'), 'Apple Pay');
  assert.equal(walletLabel('GOOGLEPAY'), 'Google Pay');
  assert.equal(walletLabel('paywithgoogle'), 'Google Pay');
  assert.equal(walletLabel('scheme'), null);
  assert.equal(isWalletType('applepay'), true);
  assert.equal(isWalletType('scheme'), false);
  assert.equal(isWalletType(undefined), false);
});

test('wantsNativeThreeDS: Apple Pay is the ONLY exemption', () => {
  assert.equal(wantsNativeThreeDS({ type: 'scheme' }), true);
  assert.equal(wantsNativeThreeDS({ type: 'applepay' }), false);
  assert.equal(wantsNativeThreeDS({ type: 'APPLEPAY' }), false);
  // Google Pay may hand us a PAN_ONLY (FPAN) token with no cryptogram, which
  // the issuer is entitled to challenge: without the flag Adyen answers
  // RedirectShopper and this checkout cannot complete a redirect.
  assert.equal(wantsNativeThreeDS({ type: 'googlepay' }), true);
  assert.equal(wantsNativeThreeDS({ type: 'paywithgoogle' }), true);
  assert.equal(wantsNativeThreeDS(undefined), true);
  // The edge function declares this list verbatim: keep the two in step.
  assert.deepEqual([...NO_NATIVE_3DS_TYPES], ['applepay']);
});
