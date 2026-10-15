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
  isStoreId, storeForPaymentMethods, STORE_REFERENCE_MAX, STORE_REJECTED_ERROR_CODE,
  WALLET_START_WINDOW_MS, WALLET_ERROR_TEXT_MAX, QUIET_WALLET_ERRORS,
  walletErrorOutcome, walletStartFailedNote, walletErrorReport,
} from './adyenWallets.js';

import { readFileSync } from 'node:fs';

const EDGE = readFileSync(new URL('../../../supabase/functions/adyen-checkout/index.ts', import.meta.url), 'utf8');

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

/* ── The store on a /paymentMethods lookup (Peter, Provo, 20 Sep 2026) ────────
 * Live: "apple pay still not loading on the checkout", iPhone included. The
 * lookup was answering 910 "Invalid Store" to the venue's Management API store
 * id, so the form fell back to card only on EVERY device and no wallet could
 * ever render. /paymentMethods wants the store's REFERENCE (our venue code),
 * maxLength 16. /payments is untouched: the id has authorised on it for a
 * month, and the money path does not change to tidy up a lookup.
 */
test('a Management API store id is recognised as an id, not a reference', () => {
  assert.equal(isStoreId('ST32DDL22322BQ5PXJVN95JSM'), true, "Provo's own store id");
  assert.equal(isStoreId('st32ddl22322bq5pxjvn95jsm'), true, 'case does not matter');
  assert.equal(isStoreId('SV-1007'), false, 'the venue code is a reference');
  assert.equal(isStoreId(''), false);
  assert.equal(isStoreId(null), false);
});

test('the lookup sends the venue code when the row holds a store id', () => {
  // The live shape on 20 Sep: merchant_adyen_accounts.store_id is the ST id,
  // ops.locations.venue_code is SV-1007, which is the store's reference on
  // Adyen and what every payment webhook for this venue echoes back.
  assert.equal(
    storeForPaymentMethods({ store: 'ST32DDL22322BQ5PXJVN95JSM', venueCode: 'SV-1007' }),
    'SV-1007',
  );
  // A row that already holds a reference keeps working, untouched.
  assert.equal(storeForPaymentMethods({ store: 'SV-1007', venueCode: 'SV-9999' }), 'SV-1007');
  // Nothing usable = ask without a store: a method list for the account beats
  // no method list at all, which is what a 910 meant until today.
  assert.equal(storeForPaymentMethods({ store: 'ST32DDL22322BQ5PXJVN95JSM' }), null);
  assert.equal(storeForPaymentMethods({}), null);
  assert.equal(storeForPaymentMethods(), null);
  // Adyen's documented maximum. A longer venue code would be refused as well,
  // so it is never sent.
  assert.equal(STORE_REFERENCE_MAX, 16);
  assert.equal(storeForPaymentMethods({ venueCode: 'A'.repeat(17) }), null);
  assert.equal(storeForPaymentMethods({ venueCode: 'A'.repeat(16) }), 'A'.repeat(16));
  assert.equal(storeForPaymentMethods({ store: '  SV-1007  ' }), 'SV-1007', 'trimmed');
});

test('the edge function carries the same rule, and keeps the store off nothing else', () => {
  // The Deno function cannot import this file, so the copy is pinned here.
  assert.match(EDGE, /const STORE_REFERENCE_MAX = 16;/);
  assert.match(EDGE, new RegExp(`const STORE_REJECTED_ERROR_CODE = '${STORE_REJECTED_ERROR_CODE}';`));
  assert.match(EDGE, /const isStoreId = \(v: unknown\) => \/\^ST\[0-9A-Z\]\{10,\}\$\/i/);
  assert.match(EDGE, /function storeForPaymentMethods\(store: string \| null, venueCode: string \| null\)/);
  // Both lookups go through the retry helper...
  assert.match(EDGE, /async function lookupPaymentMethods\(/);
  assert.match(EDGE, /=== STORE_REJECTED_ERROR_CODE;/, 'a refused store is recognised by its Adyen error code');
  const methods = EDGE.slice(EDGE.indexOf("if (action === 'payment_methods')"), EDGE.indexOf("if (action === 'create_session')"));
  assert.match(methods, /await lookupPaymentMethods\(cfg, request,\s*\n\s*await storeReferenceFor\(platformLocationId, store, cfg, merchantAccount\), merchantAccount, store\)/);
  assert.doesNotMatch(methods, /request\.store = store;/, 'the raw store id never goes on a lookup again');
  // ...and the MONEY path still sends the store exactly as it did.
  const pay = EDGE.slice(EDGE.indexOf("if (action === 'make_payment')"), EDGE.indexOf("if (action === 'payment_details')"));
  assert.match(pay, /if \(store\) payment\.store = store;/, '/payments is untouched');
  const session = EDGE.slice(EDGE.indexOf("if (action === 'create_session')"), EDGE.indexOf("if (action === 'make_payment')"));
  assert.match(session, /if \(store\) session\.store = store;/, '/sessions is untouched');
});

/* ── A new venue's store names itself (21 Sep 2026) ───────────────────────────
 * Peter, with 20 sites about to go live: "how do we get it automatically on
 * everyone's new store as we add them". The venue code guess is right for a
 * store WE create; a store FranPOS creates by hand in the Customer Area can be
 * called anything. So a refused store is not the end of the chain: the lookup
 * asks Adyen's Management API what this store id is really called, uses that,
 * and remembers it. Nobody types a reference anywhere.
 */
test('a refused store asks Adyen for its real name before giving up on it', () => {
  const fn = EDGE.slice(EDGE.indexOf('async function referenceFromAdyen'), EDGE.indexOf('// One /paymentMethods call'));
  // it asks the venue's OWN merchant account for its stores, and matches by id
  assert.match(fn, /\/merchants\/\$\{encodeURIComponent\(merchantAccount\)\}\/stores\?pageSize=100/);
  assert.match(fn, /rows\.find\(\(s\) => String\(s\?\.id \?\? ''\) === storeId\)/);
  assert.match(fn, /if \(r && r\.length <= STORE_REFERENCE_MAX\) ref = r;/, 'a reference Adyen could not take is not used');
  assert.match(fn, /apiKey: cfg\.managementKey/, 'the Management credential, not the Checkout one');
  // never asked for something that is not a store id, and never asked twice
  assert.match(fn, /if \(!storeId \|\| !isStoreId\(storeId\)\) return null;/);
  assert.match(fn, /adyenRefCache\.set\(key, \{ at: Date\.now\(\), ref \}\);/);
  // a credential without the Management role is a warning and a null, never a throw
  assert.match(fn, /catch \(e\)/);

  // the three step chain, in order
  const chain = EDGE.slice(EDGE.indexOf('async function lookupPaymentMethods'), EDGE.indexOf('// Idempotency-Key for /payments'));
  const guess = chain.indexOf('const first = await ask(storeRef);');
  const correct = chain.indexOf('await referenceFromAdyen(');
  const noStore = chain.indexOf('return await ask(null);');
  assert.ok(guess > 0 && correct > guess && noStore > correct, 'guess, then ask Adyen, then no store');
  assert.match(chain, /if \(first\.ok \|\| !storeRef \|\| !refused\(first\)\) return first;/, 'a working store never costs an extra call');

  // and once Adyen has corrected us, the correction is used FIRST next time
  const resolve = EDGE.slice(EDGE.indexOf('async function storeReferenceFor'), EDGE.indexOf('// ── Asking ADYEN'));
  assert.match(resolve, /adyenRefCache\.get\(`\$\{cfg\.env\}:\$\{merchantAccount\}:\$\{store\}`\)/);
});

// ── A wallet that cannot start (29 Sep 2026, v5.11.17) ───────────────────────
// Coffee Boy: the Apple Pay sheet opened and closed at once and the shopper saw
// nothing. adyen-web raises ERROR (then CANCEL) when merchant validation fails.

const TAP = Date.parse('2026-09-29T11:56:51.000Z');
const outcome = (over) => walletErrorOutcome({ tappedAt: TAP, now: TAP + 800, submitted: false, ...over });

test('walletErrorOutcome: before any tap, a script or setup error stays silent', () => {
  assert.deepEqual([...QUIET_WALLET_ERRORS], ['CANCEL', 'SCRIPT_ERROR', 'IMPLEMENTATION_ERROR']);
  assert.equal(outcome({ name: 'SCRIPT_ERROR', tappedAt: undefined }), 'silent');
  assert.equal(outcome({ name: 'IMPLEMENTATION_ERROR', tappedAt: 0 }), 'silent');
  // an ERROR the shopper did not start (no tap) is not theirs to read
  assert.equal(outcome({ name: 'ERROR', tappedAt: undefined }), 'silent');
  assert.equal(outcome({ name: 'ERROR', tappedAt: null }), 'silent');
  assert.equal(outcome({ name: 'ERROR', tappedAt: 'soon' }), 'silent');
});

test('walletErrorOutcome: a tap then an ERROR or NETWORK_ERROR is a start that failed', () => {
  assert.equal(outcome({ name: 'ERROR' }), 'start_failed');
  assert.equal(outcome({ name: 'error' }), 'start_failed');
  assert.equal(outcome({ name: 'NETWORK_ERROR' }), 'start_failed');
  assert.equal(outcome({ name: '' }), 'start_failed');
  assert.equal(outcome({ name: 'ERROR', now: TAP + WALLET_START_WINDOW_MS }), 'start_failed');
  // a cancel is the shopper closing the sheet, never a failure
  assert.equal(outcome({ name: 'CANCEL' }), 'silent');
  // a script that failed after a tap is still not about this shop
  assert.equal(outcome({ name: 'SCRIPT_ERROR' }), 'silent');
});

test('walletErrorOutcome: a stale tap (over a minute) or a clock that went backwards is silent', () => {
  assert.equal(WALLET_START_WINDOW_MS, 60000);
  assert.equal(outcome({ name: 'ERROR', now: TAP + WALLET_START_WINDOW_MS + 1 }), 'silent');
  assert.equal(outcome({ name: 'ERROR', now: TAP - 1 }), 'silent');
  assert.equal(outcome({ name: 'ERROR', now: NaN }), 'silent');
});

test('walletErrorOutcome: once a payment is submitted an error is the payment error, a cancel is not', () => {
  assert.equal(outcome({ name: 'ERROR', submitted: true }), 'payment_error');
  assert.equal(outcome({ name: 'ERROR', submitted: true, tappedAt: undefined }), 'payment_error');
  assert.equal(outcome({ name: 'NETWORK_ERROR', submitted: true }), 'payment_error');
  assert.equal(outcome({ name: 'CANCEL', submitted: true }), 'silent');
  assert.equal(outcome({ name: 'SCRIPT_ERROR', submitted: true }), 'silent');
  assert.equal(walletErrorOutcome(), 'silent');
});

test('walletErrorOutcome: a submit only counts for the tap it followed (submittedAt)', () => {
  // A card refused BEFORE the tap: the shopper then taps Apple Pay and the
  // sheet dies at merchant validation. That is a start that failed, not a
  // payment error (29 Sep 2026 review: it showed the raw library text).
  assert.equal(outcome({ name: 'ERROR', submittedAt: TAP - 30000 }), 'start_failed');
  assert.equal(outcome({ name: 'ERROR', submittedAt: TAP - 1 }), 'start_failed');
  // submittedAt wins over the old boolean when both are given
  assert.equal(outcome({ name: 'ERROR', submitted: true, submittedAt: TAP - 30000 }), 'start_failed');
  // this tap's own payment went in (onSubmit after Face ID): a payment error
  assert.equal(outcome({ name: 'ERROR', submittedAt: TAP + 5000, now: TAP + 6000 }), 'payment_error');
  assert.equal(outcome({ name: 'ERROR', submittedAt: TAP }), 'payment_error');
  assert.equal(outcome({ name: 'CANCEL', submittedAt: TAP + 5000 }), 'silent');
  // no submit yet on this mount (0) is the pre submit path
  assert.equal(outcome({ name: 'ERROR', submittedAt: 0 }), 'start_failed');
  assert.equal(outcome({ name: 'SCRIPT_ERROR', submittedAt: 0, tappedAt: undefined }), 'silent');
  // no tap at all: any submit on this mount is a payment in flight, as before
  assert.equal(outcome({ name: 'ERROR', tappedAt: undefined, submittedAt: TAP - 30000 }), 'payment_error');
  assert.equal(outcome({ name: 'ERROR', tappedAt: undefined, submittedAt: 0 }), 'silent');
  // a stale tap with an older submit is still silent (outside the minute)
  assert.equal(outcome({ name: 'ERROR', submittedAt: TAP - 1, now: TAP + WALLET_START_WINDOW_MS + 1 }), 'silent');
  // null submittedAt falls back to the boolean
  assert.equal(outcome({ name: 'ERROR', submitted: true, submittedAt: null }), 'payment_error');
});

test('both forms pass submittedAt from onSubmit, never the old mount wide flag', () => {
  for (const file of ['../../components/AdyenPaymentForm.jsx', '../../surfaces/online/BookingWidget.jsx']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /walletErrorOutcome\(\{ name: e\?\.name, tappedAt: tap, now: Date\.now\(\), submittedAt: submittedAt(Ref)?\.current \}\)/, file);
    assert.match(src, /submittedAt(Ref)?\.current = Date\.now\(\);/, file);
    assert.doesNotMatch(src, /tappedAt\.current\[type\] = 0/, file);
  }
});

test('walletStartFailedNote says it could not start and points at the card', () => {
  assert.equal(walletStartFailedNote('applepay'), 'Apple Pay could not start for this shop. Please pay by card below.');
  assert.equal(walletStartFailedNote('ApplePay'), 'Apple Pay could not start for this shop. Please pay by card below.');
  assert.equal(walletStartFailedNote('googlepay'), 'Google Pay could not start for this shop. Please pay by card below.');
  assert.equal(walletStartFailedNote('paywithgoogle'), 'Google Pay could not start for this shop. Please pay by card below.');
  assert.equal(walletStartFailedNote('klarna'), 'This wallet could not start for this shop. Please pay by card below.');
  for (const t of ['applepay', 'googlepay', null]) assert.doesNotMatch(walletStartFailedNote(t), /[–—]/);
});

test('walletErrorReport: the shape wallet_error takes, capped, cleaned, no shopper data', () => {
  const e = new Error('ApplePay - Something went wrong on ApplePayService');
  e.name = 'ERROR';
  e.cause = new Error('Could not get Apple Pay session');
  assert.deepEqual(walletErrorReport({ locationId: ' 15559aa9 ', type: 'ApplePay', error: e, host: 'Coffee-Boy-Huddersfield.serv-os.app:443' }), {
    action: 'wallet_error',
    location_id: '15559aa9',
    wallet: 'applepay',
    name: 'ERROR',
    message: 'ApplePay - Something went wrong on ApplePayService',
    cause: 'Error: Could not get Apple Pay session',
    host: 'coffee-boy-huddersfield.serv-os.app',
  });
  const long = walletErrorReport({ locationId: 'L', type: 'applepay', error: { name: 'error', message: `line one\nline two\u0007${'m'.repeat(500)}`, cause: 'c'.repeat(500) }, host: `${'h'.repeat(300)}.serv-os.app` });
  assert.equal(WALLET_ERROR_TEXT_MAX, 200);
  for (const k of ['name', 'message', 'cause', 'host']) assert.ok(long[k].length <= WALLET_ERROR_TEXT_MAX, `${k}: ${long[k].length}`);
  assert.equal(long.name, 'ERROR');
  assert.match(long.message, /^line one line two m+$/);
  assert.equal(long.cause.length, WALLET_ERROR_TEXT_MAX);
  // a string cause, an object cause, no cause, and a host with junk in it
  assert.equal(walletErrorReport({ error: { name: 'ERROR', cause: 'plain' } }).cause, 'plain');
  assert.equal(walletErrorReport({ error: { name: 'ERROR', cause: { statusCode: 422 } } }).cause, '{"statusCode":422}');
  assert.equal(walletErrorReport({ error: { name: 'ERROR' } }).cause, '');
  assert.equal(walletErrorReport({ host: 'shop.example.com/<script>' }).host, 'shop.example.comscript');
  assert.deepEqual(Object.keys(walletErrorReport()).sort(), ['action', 'cause', 'host', 'location_id', 'message', 'name', 'wallet']);
});

test('the edge function logs wallet_error with the same cap, and writes nothing', () => {
  assert.match(EDGE, /action === 'wallet_error'/);
  assert.match(EDGE, new RegExp(`const WALLET_ERROR_TEXT_MAX = ${WALLET_ERROR_TEXT_MAX};`));
  const block = EDGE.slice(EDGE.indexOf("if (action === 'wallet_error')"), EDGE.indexOf("if (action === 'payment_methods')"));
  assert.ok(block.length > 0, 'wallet_error sits before payment_methods');
  assert.match(block, /console\.warn\(`\[adyen-checkout\] wallet_error /);
  assert.match(block, /\/\^\[A-Z_\]\{1,40\}\$\//);
  assert.doesNotMatch(block, /\.from\(|\.insert\(|\.upsert\(|\.update\(|fetch\(|lookupPaymentMethods|adyenFetch/, 'log only: no database write, no Adyen call');
  assert.ok(EDGE.indexOf("if (action === 'status')") < EDGE.indexOf("if (action === 'wallet_error')"), 'after status');
});

test('the edge function nudges Apple Pay registration from payment_methods, never awaited', () => {
  const methods = EDGE.slice(EDGE.indexOf("if (action === 'payment_methods')"), EDGE.indexOf("if (action === 'create_session')"));
  assert.match(methods, /if \(platformLocationId && offersApplePay\(methods\)\) nudgeApplePayDomains\(platformLocationId, cfg\.env\);/);
  assert.doesNotMatch(methods, /await nudgeApplePayDomains/);
  const nudge = EDGE.slice(EDGE.indexOf('function nudgeApplePayDomains'), EDGE.indexOf('Deno.serve('));
  assert.match(nudge, /action: 'ensure_apple_pay_domains'/);
  assert.match(nudge, /AbortSignal\.timeout\(APPLE_PAY_NUDGE_TIMEOUT_MS\)/);
  assert.match(nudge, /waitUntil/);
  assert.match(EDGE, /const APPLE_PAY_NUDGE_MS = 30 \* 60_000;/);
});
