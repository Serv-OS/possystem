/**
 * adyenEnv.test.js: the contract for BOTH copies of the per venue Adyen
 * config resolver, src/lib/payments/adyenEnv.js (this one) and
 * supabase/functions/_shared/adyen.ts (the Deno copy, which cannot import
 * from src/). When a test here changes, the Deno copy changes with it.
 *
 * Run: `npm test` (Node's built-in runner, no third party framework).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADYEN_SECRET_SUFFIXES, ADYEN_DEFAULT_BASES, ADYEN_LIVE_FAIL_CLOSED, ADYEN_LIVE_PREFIX_NAME, ADYEN_REGIONS, ADYEN_REGION_MIGRATION,
  normalizeAdyenEnv, adyenEnvFromRow, adyenSecretName, adyenSecretNames, adyenLivePrefixName, adyenLivePrefixNames, liveCheckoutBase,
  resolveAdyenConfig, assertAdyenConfigured, adyenNotConfiguredMessage, terminalEndpointFor,
  liveTerminalApiBase, terminalEndpointForConfig, webhookHmacPolicy, effectiveMerchantAccount,
  parseAdyenRegion, normaliseAdyenRegion, normalizeAdyenRegion, adyenRegionFromRow, dropinEnvironmentFor,
  resolveLiveRegionsConfigured, resolveWebhookKeys, resolveWebhookAuthPairs,
  isAdyenRegionCheckError, adyenRegionMigrationMessage,
  adyenAccountRowPatch, adyenRegionRetryWithoutColumn, resolveRegionByMerchantAccount,
} from './adyenEnv.js';

const FIELDS = Object.keys(ADYEN_SECRET_SUFFIXES);
const reader = (map) => (name) => map[name];

// A full test set and a full live set, every value distinct so a leak from
// one set into the other is visible in the assertions. LIVE_SET is the
// UNSUFFIXED live names (the UK fallback); UK_SET and US_SET carry the region.
const TEST_SET = Object.fromEntries(FIELDS.map((f) => [`ADYEN_${ADYEN_SECRET_SUFFIXES[f]}`, `test-${f}`]));
const LIVE_SET = Object.fromEntries(FIELDS.map((f) => [`ADYEN_LIVE_${ADYEN_SECRET_SUFFIXES[f]}`, `live-${f}`]));
const UK_SET = Object.fromEntries(FIELDS.map((f) => [`ADYEN_LIVE_UK_${ADYEN_SECRET_SUFFIXES[f]}`, `uk-${f}`]));
const US_SET = Object.fromEntries(FIELDS.map((f) => [`ADYEN_LIVE_US_${ADYEN_SECRET_SUFFIXES[f]}`, `us-${f}`]));
const BOTH = { ...TEST_SET, ...LIVE_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS' };
const REGIONS = { ...TEST_SET, ...UK_SET, ...US_SET, ADYEN_LIVE_UK_PREFIX: 'ukprefix-ServOS', ADYEN_LIVE_US_PREFIX: 'usprefix-ServOS' };

// The base overrides are hosts, not keys; drop them so defaults are exercised.
const withoutBases = (set, prefix) => Object.fromEntries(
  Object.entries(set).filter(([k]) => !/_(CHECKOUT_BASE|MGMT_BASE|LEM_BASE|BP_BASE|DEVICE_BASE)$/.test(k) || !k.startsWith(prefix)),
);
const KEY_FIELDS = ['apiKey', 'clientKey', 'hmacKey', 'merchantAccount', 'managementKey', 'lemKey', 'bpKey', 'bpHmacKey', 'reportApiKey', 'reportUser', 'reportPass'];

test('normalizeAdyenEnv: only live is live, case and whitespace tolerant', () => {
  assert.equal(normalizeAdyenEnv('live'), 'live');
  assert.equal(normalizeAdyenEnv(' LIVE '), 'live');
  assert.equal(normalizeAdyenEnv('test'), 'test');
  assert.equal(normalizeAdyenEnv('production'), 'test');
  assert.equal(normalizeAdyenEnv(''), 'test');
  assert.equal(normalizeAdyenEnv(undefined), 'test');
  assert.equal(normalizeAdyenEnv(null), 'test');
});

test('adyenEnvFromRow: the row decides, everything else is test', () => {
  assert.equal(adyenEnvFromRow({ environment: 'live' }), 'live');
  assert.equal(adyenEnvFromRow({ environment: 'test' }), 'test');
  assert.equal(adyenEnvFromRow({ environment: null }), 'test');
  assert.equal(adyenEnvFromRow({}), 'test');           // column missing (migration pending)
  assert.equal(adyenEnvFromRow(null), 'test');         // no row
  assert.equal(adyenEnvFromRow(undefined), 'test');
});

// ── Region ───────────────────────────────────────────────────────────────────

test('region codes are UK and US, in that order', () => {
  assert.deepEqual([...ADYEN_REGIONS], ['UK', 'US']);
});

test('normaliseAdyenRegion: EU, GB and GBP style inputs read as UK; US and USD as US; else by currency, else UK', () => {
  for (const v of ['UK', 'uk', ' Uk ', 'EU', 'eu', 'GB', 'GBR', 'GBP']) assert.equal(normaliseAdyenRegion(v), 'UK', v);
  for (const v of ['US', 'us', ' us ', 'USA', 'USD']) assert.equal(normaliseAdyenRegion(v), 'US', v);
  // unknown region: the currency decides
  assert.equal(normaliseAdyenRegion('', 'USD'), 'US');
  assert.equal(normaliseAdyenRegion(null, 'usd'), 'US');
  assert.equal(normaliseAdyenRegion(undefined, 'GBP'), 'UK');
  assert.equal(normaliseAdyenRegion('APAC', 'USD'), 'US');
  assert.equal(normaliseAdyenRegion('APAC', 'EUR'), 'UK');
  // nothing known at all: UK
  assert.equal(normaliseAdyenRegion(), 'UK');
  assert.equal(normaliseAdyenRegion(null, null), 'UK');
  assert.equal(normaliseAdyenRegion('', ''), 'UK');
  // the stored region wins over the currency
  assert.equal(normaliseAdyenRegion('EU', 'USD'), 'UK');
  assert.equal(normaliseAdyenRegion('US', 'GBP'), 'US');
  assert.equal(normalizeAdyenRegion, normaliseAdyenRegion);   // both spellings
});

test('parseAdyenRegion: null when the value says nothing', () => {
  assert.equal(parseAdyenRegion('EU'), 'UK');
  assert.equal(parseAdyenRegion('USD'), 'US');
  assert.equal(parseAdyenRegion(''), null);
  assert.equal(parseAdyenRegion(null), null);
  assert.equal(parseAdyenRegion('APAC'), null);
});

test('adyenRegionFromRow: the row first, then the platform location currency, then UK', () => {
  assert.equal(adyenRegionFromRow({ region: 'EU' }, { currency: 'USD' }), 'UK');   // legacy row
  assert.equal(adyenRegionFromRow({ region: 'US' }, { currency: 'GBP' }), 'US');
  assert.equal(adyenRegionFromRow({ region: 'UK' }, null), 'UK');
  assert.equal(adyenRegionFromRow(null, { currency: 'USD' }), 'US');            // no row: currency
  assert.equal(adyenRegionFromRow(null, { currency: 'GBP' }), 'UK');
  assert.equal(adyenRegionFromRow({}, { currency: 'USD' }), 'US');               // row silent: currency
  assert.equal(adyenRegionFromRow(null, null), 'UK');
  assert.equal(adyenRegionFromRow(undefined, undefined), 'UK');
});

test('dropinEnvironmentFor: test, live (UK, the EU data centre) and live-us', () => {
  assert.equal(dropinEnvironmentFor('test', 'UK'), 'test');
  assert.equal(dropinEnvironmentFor('test', 'US'), 'test');
  assert.equal(dropinEnvironmentFor('live', 'UK'), 'live');
  assert.equal(dropinEnvironmentFor('live', 'EU'), 'live');
  assert.equal(dropinEnvironmentFor('live', 'US'), 'live-us');
  assert.equal(dropinEnvironmentFor('live', undefined), 'live');
  assert.equal(resolveAdyenConfig('live', reader(REGIONS), { region: 'US' }).dropinEnvironment, 'live-us');
  assert.equal(resolveAdyenConfig('live', reader(REGIONS), { region: 'UK' }).dropinEnvironment, 'live');
  assert.equal(resolveAdyenConfig('test', reader(REGIONS), { region: 'US' }).dropinEnvironment, 'test');
});

// ── Secret names ─────────────────────────────────────────────────────────────

test('secret names: the test set is the twenty unprefixed names in use today', () => {
  const expected = [
    'ADYEN_API_KEY', 'ADYEN_CLIENT_KEY', 'ADYEN_HMAC_KEY', 'ADYEN_MERCHANT_ACCOUNT', 'ADYEN_DEVICE_BASE',
    'ADYEN_MANAGEMENT_KEY', 'ADYEN_LEM_KEY', 'ADYEN_BP_KEY', 'ADYEN_BP_HMAC_KEY',
    'ADYEN_EVENTS_USER', 'ADYEN_EVENTS_PASS', 'ADYEN_WEBHOOK_USER', 'ADYEN_WEBHOOK_PASS',
    'ADYEN_REPORT_API_KEY', 'ADYEN_REPORT_USER', 'ADYEN_REPORT_PASS',
    'ADYEN_CHECKOUT_BASE', 'ADYEN_MGMT_BASE', 'ADYEN_LEM_BASE', 'ADYEN_BP_BASE',
  ];
  const got = FIELDS.map((f) => adyenSecretName('test', f));
  assert.deepEqual(got.slice().sort(), expected.slice().sort());
  assert.equal(got.length, 20);
  // the test set is one set: the same names whatever the region
  for (const f of FIELDS) assert.equal(adyenSecretName('test', f, 'US'), adyenSecretName('test', f, 'UK'), f);
});

test('secret names: the live UK set is ADYEN_LIVE_UK_ plus the same suffixes, and the default region is UK', () => {
  for (const f of FIELDS) {
    const t = adyenSecretName('test', f);
    assert.equal(adyenSecretName('live', f, 'UK'), t.replace(/^ADYEN_/, 'ADYEN_LIVE_UK_'), f);
    assert.equal(adyenSecretName('live', f), adyenSecretName('live', f, 'UK'), `${f} default region`);
    assert.equal(adyenSecretName('live', f, 'EU'), adyenSecretName('live', f, 'UK'), `${f} EU reads UK`);
  }
  assert.equal(adyenSecretName('live', 'apiKey'), 'ADYEN_LIVE_UK_API_KEY');
  assert.equal(adyenSecretName('live', 'clientKey', 'UK'), 'ADYEN_LIVE_UK_CLIENT_KEY');
  assert.equal(adyenSecretName('live', 'merchantAccount', 'UK'), 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT');
  assert.equal(adyenSecretName('live', 'hmacKey', 'UK'), 'ADYEN_LIVE_UK_HMAC_KEY');
  assert.equal(adyenSecretName('live', 'managementBase'), 'ADYEN_LIVE_UK_MGMT_BASE');
  assert.equal(adyenSecretName('live', 'deviceBase'), 'ADYEN_LIVE_UK_DEVICE_BASE');
  assert.equal(adyenLivePrefixName('UK'), 'ADYEN_LIVE_UK_PREFIX');
  assert.equal(adyenLivePrefixName(), 'ADYEN_LIVE_UK_PREFIX');
  assert.throws(() => adyenSecretName('live', 'nope'), /unknown field/);
  assert.throws(() => adyenSecretNames('live', 'nope'), /unknown field/);
});

test('secret names: the live US set is ADYEN_LIVE_US_ plus the same suffixes', () => {
  for (const f of FIELDS) {
    const t = adyenSecretName('test', f);
    assert.equal(adyenSecretName('live', f, 'US'), t.replace(/^ADYEN_/, 'ADYEN_LIVE_US_'), f);
    assert.equal(adyenSecretName('live', f, 'USD'), adyenSecretName('live', f, 'US'), `${f} USD reads US`);
  }
  assert.equal(adyenSecretName('live', 'apiKey', 'US'), 'ADYEN_LIVE_US_API_KEY');
  assert.equal(adyenSecretName('live', 'clientKey', 'US'), 'ADYEN_LIVE_US_CLIENT_KEY');
  assert.equal(adyenSecretName('live', 'merchantAccount', 'US'), 'ADYEN_LIVE_US_MERCHANT_ACCOUNT');
  assert.equal(adyenSecretName('live', 'hmacKey', 'US'), 'ADYEN_LIVE_US_HMAC_KEY');
  assert.equal(adyenSecretName('live', 'bpHmacKey', 'US'), 'ADYEN_LIVE_US_BP_HMAC_KEY');
  assert.equal(adyenLivePrefixName('US'), 'ADYEN_LIVE_US_PREFIX');
});

test('secret names: read order per set (UK falls back to the unsuffixed live names, US never does, test US has an optional override)', () => {
  assert.deepEqual(adyenSecretNames('live', 'apiKey', 'UK'), ['ADYEN_LIVE_UK_API_KEY', 'ADYEN_LIVE_API_KEY']);
  assert.deepEqual(adyenSecretNames('live', 'apiKey'), ['ADYEN_LIVE_UK_API_KEY', 'ADYEN_LIVE_API_KEY']);
  assert.deepEqual(adyenSecretNames('live', 'apiKey', 'US'), ['ADYEN_LIVE_US_API_KEY']);
  assert.deepEqual(adyenSecretNames('test', 'apiKey', 'UK'), ['ADYEN_API_KEY']);
  assert.deepEqual(adyenSecretNames('test', 'apiKey', 'US'), ['ADYEN_TEST_US_API_KEY', 'ADYEN_API_KEY']);
  assert.deepEqual(adyenLivePrefixNames('UK'), ['ADYEN_LIVE_UK_PREFIX', 'ADYEN_LIVE_PREFIX']);
  assert.deepEqual(adyenLivePrefixNames('US'), ['ADYEN_LIVE_US_PREFIX']);
  assert.equal(ADYEN_LIVE_PREFIX_NAME, 'ADYEN_LIVE_PREFIX');
  for (const f of FIELDS) {
    for (const n of adyenSecretNames('live', f, 'US')) assert.ok(!/ADYEN_LIVE_UK_|^ADYEN_LIVE_[A-Z_]+$/.test(n) || n.startsWith('ADYEN_LIVE_US_'), `${f}: ${n}`);
  }
});

// ── Config resolution ────────────────────────────────────────────────────────

test('test config: reads the test set only, test defaults, configured with just the api key', () => {
  const cfg = resolveAdyenConfig('test', reader(withoutBases(BOTH, 'ADYEN_')));
  assert.equal(cfg.env, 'test');
  assert.equal(cfg.live, false);
  assert.equal(cfg.region, 'UK');
  assert.equal(cfg.dropinEnvironment, 'test');
  assert.equal(cfg.configured, true);
  assert.deepEqual(cfg.missing, []);
  assert.equal(cfg.apiKey, 'test-apiKey');
  assert.equal(cfg.clientKey, 'test-clientKey');
  assert.equal(cfg.hmacKey, 'test-hmacKey');
  assert.equal(cfg.merchantAccount, 'test-merchantAccount');
  assert.equal(cfg.prefix, '');                            // never used on test
  assert.equal(cfg.checkoutBase, 'https://checkout-test.adyen.com/v72');
  assert.equal(cfg.managementBase, 'https://management-test.adyen.com/v3');
  assert.equal(cfg.lemBase, 'https://kyc-test.adyen.com/lem/v4');
  assert.equal(cfg.balancePlatformBase, 'https://balanceplatform-api-test.adyen.com/bcl/v2');
  assert.equal(cfg.deviceBase, 'https://device-api-test.adyen.com');
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string') assert.ok(!v.startsWith('live-'), `${k} leaked a live value`);
  }
});

test('test config: a test US venue reads the same test set, with ADYEN_TEST_US_ overrides honoured when present', () => {
  const plain = resolveAdyenConfig('test', reader(withoutBases(REGIONS, 'ADYEN_')), { region: 'US' });
  assert.equal(plain.region, 'US');
  assert.equal(plain.live, false);
  assert.equal(plain.dropinEnvironment, 'test');
  assert.equal(plain.apiKey, 'test-apiKey');
  assert.equal(plain.merchantAccount, 'test-merchantAccount');
  assert.equal(plain.deviceBase, 'https://device-api-test.adyen.com');   // test host whatever the region
  assert.equal(plain.checkoutBase, 'https://checkout-test.adyen.com/v72');
  for (const [k, v] of Object.entries(plain)) {
    if (typeof v === 'string') assert.ok(!/^(uk|us)-/.test(v), `${k} leaked a live value into a test US config`);
  }
  const over = resolveAdyenConfig('test', reader({ ...TEST_SET, ADYEN_TEST_US_API_KEY: 'testus-apiKey', ADYEN_TEST_US_MERCHANT_ACCOUNT: 'testus-merchant' }), { region: 'US' });
  assert.equal(over.apiKey, 'testus-apiKey');
  assert.equal(over.merchantAccount, 'testus-merchant');
  assert.equal(over.clientKey, 'test-clientKey');           // no override: the shared test value
  // a test UK venue never reads the US override
  const uk = resolveAdyenConfig('test', reader({ ...TEST_SET, ADYEN_TEST_US_API_KEY: 'testus-apiKey' }), { region: 'UK' });
  assert.equal(uk.apiKey, 'test-apiKey');
});

test('live config (UK, unsuffixed fallback names): reads the live set only, live defaults, prefix URL shape', () => {
  const cfg = resolveAdyenConfig('live', reader(withoutBases(BOTH, 'ADYEN_LIVE_')));
  assert.equal(cfg.env, 'live');
  assert.equal(cfg.live, true);
  assert.equal(cfg.region, 'UK');
  assert.equal(cfg.dropinEnvironment, 'live');
  assert.equal(cfg.configured, true);
  assert.deepEqual(cfg.missing, []);
  assert.equal(cfg.apiKey, 'live-apiKey');
  assert.equal(cfg.clientKey, 'live-clientKey');
  assert.equal(cfg.hmacKey, 'live-hmacKey');
  assert.equal(cfg.merchantAccount, 'live-merchantAccount');
  assert.equal(cfg.bpHmacKey, 'live-bpHmacKey');
  assert.equal(cfg.prefix, 'abc123-ServOS');
  assert.equal(cfg.checkoutBase, 'https://abc123-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  assert.equal(cfg.checkoutBase, liveCheckoutBase('abc123-ServOS'));
  assert.equal(cfg.managementBase, 'https://management-live.adyen.com/v3');
  assert.equal(cfg.lemBase, 'https://kyc-live.adyen.com/lem/v4');
  assert.equal(cfg.balancePlatformBase, 'https://balanceplatform-api-live.adyen.com/bcl/v2');
  assert.equal(cfg.deviceBase, 'https://terminal-api-live.adyen.com');
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'string') assert.ok(!v.startsWith('test-'), `${k} leaked a test value`);
  }
});

test('live config: one argument (no region) equals region UK exactly', () => {
  for (const secrets of [BOTH, REGIONS, { ...REGIONS, ...LIVE_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS' }]) {
    assert.deepEqual(resolveAdyenConfig('live', reader(secrets)), resolveAdyenConfig('live', reader(secrets), { region: 'UK' }));
    assert.deepEqual(resolveAdyenConfig('live', reader(secrets), {}), resolveAdyenConfig('live', reader(secrets), { region: 'EU' }));
    assert.deepEqual(resolveAdyenConfig('test', reader(secrets)), resolveAdyenConfig('test', reader(secrets), { region: 'UK' }));
  }
});

test('live UK: the ADYEN_LIVE_UK_ names win, the unsuffixed ADYEN_LIVE_ names are the fallback', () => {
  const all = { ...REGIONS, ...LIVE_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS' };
  const cfg = resolveAdyenConfig('live', reader(withoutBases(all, 'ADYEN_LIVE_')), { region: 'UK' });
  assert.equal(cfg.region, 'UK');
  assert.equal(cfg.configured, true);
  assert.equal(cfg.apiKey, 'uk-apiKey');
  assert.equal(cfg.clientKey, 'uk-clientKey');
  assert.equal(cfg.hmacKey, 'uk-hmacKey');
  assert.equal(cfg.bpHmacKey, 'uk-bpHmacKey');
  assert.equal(cfg.merchantAccount, 'uk-merchantAccount');
  assert.equal(cfg.managementKey, 'uk-managementKey');
  assert.equal(cfg.reportApiKey, 'uk-reportApiKey');
  assert.equal(cfg.prefix, 'ukprefix-ServOS');
  assert.equal(cfg.checkoutBase, 'https://ukprefix-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'dropinEnvironment') continue;   // fixed vocabulary ('live'), not a secret value
    if (typeof v === 'string') assert.ok(!/^(us|test|live)-/.test(v), `${k} read the wrong set: ${v}`);
  }
  // field by field fallback: a UK name missing falls to the unsuffixed name, never to US or test
  const partial = resolveAdyenConfig('live', reader({ ...TEST_SET, ...US_SET, ...LIVE_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS', ADYEN_LIVE_UK_API_KEY: 'uk-apiKey', ADYEN_LIVE_US_PREFIX: 'usprefix' }), { region: 'UK' });
  assert.equal(partial.apiKey, 'uk-apiKey');
  assert.equal(partial.clientKey, 'live-clientKey');
  assert.equal(partial.hmacKey, 'live-hmacKey');
  assert.equal(partial.merchantAccount, 'live-merchantAccount');
  assert.equal(partial.prefix, 'abc123-ServOS');
  assert.equal(partial.configured, true);
});

test('live US: reads ONLY the ADYEN_LIVE_US_ names, never the UK names, never the unsuffixed live names, never test', () => {
  const cfg = resolveAdyenConfig('live', reader(withoutBases(REGIONS, 'ADYEN_LIVE_US_')), { region: 'US' });
  assert.equal(cfg.region, 'US');
  assert.equal(cfg.live, true);
  assert.equal(cfg.dropinEnvironment, 'live-us');
  assert.equal(cfg.configured, true);
  assert.deepEqual(cfg.missing, []);
  assert.equal(cfg.apiKey, 'us-apiKey');
  assert.equal(cfg.clientKey, 'us-clientKey');
  assert.equal(cfg.hmacKey, 'us-hmacKey');
  assert.equal(cfg.bpHmacKey, 'us-bpHmacKey');
  assert.equal(cfg.merchantAccount, 'us-merchantAccount');
  assert.equal(cfg.managementKey, 'us-managementKey');
  assert.equal(cfg.lemKey, 'us-lemKey');
  assert.equal(cfg.bpKey, 'us-bpKey');
  assert.equal(cfg.reportApiKey, 'us-reportApiKey');
  assert.equal(cfg.prefix, 'usprefix-ServOS');
  assert.equal(cfg.checkoutBase, 'https://usprefix-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  assert.equal(cfg.deviceBase, 'https://terminal-api-live-us.adyen.com');
  assert.equal(cfg.managementBase, 'https://management-live.adyen.com/v3');     // same host both regions
  assert.equal(cfg.lemBase, 'https://kyc-live.adyen.com/lem/v4');
  assert.equal(cfg.balancePlatformBase, 'https://balanceplatform-api-live.adyen.com/bcl/v2');
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'dropinEnvironment') continue;   // fixed vocabulary ('live-us'), not a secret value
    if (typeof v === 'string') assert.ok(!/^(uk|test|live)-/.test(v), `${k} read the wrong set: ${v}`);
  }

  // Every UK name, every unsuffixed live name and every test name set; NO US names: the US set is empty.
  const noUs = resolveAdyenConfig('live', reader({ ...TEST_SET, ...LIVE_SET, ...UK_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS', ADYEN_LIVE_UK_PREFIX: 'ukprefix' }), { region: 'US' });
  assert.equal(noUs.configured, false);
  assert.deepEqual(noUs.missing, ['ADYEN_LIVE_US_API_KEY', 'ADYEN_LIVE_US_PREFIX', 'ADYEN_LIVE_US_MERCHANT_ACCOUNT']);
  for (const f of KEY_FIELDS) assert.equal(noUs[f], '', `${f} fell back to another set`);
  assert.equal(noUs.prefix, '');
  assert.equal(noUs.checkoutBase, '');                     // no half built URL from the UK prefix
  assert.throws(() => assertAdyenConfigured(noUs), (err) => {
    assert.ok(err.message.startsWith(ADYEN_LIVE_FAIL_CLOSED));
    assert.equal(err.code, 'ADYEN_LIVE_NOT_CONFIGURED');
    assert.equal(err.region, 'US');
    return true;
  });
  // basic auth pairs are the one documented cross set fallback (live -> test), never UK or unsuffixed live
  assert.equal(noUs.eventsUser, 'test-eventsUser');
  assert.equal(noUs.webhookPass, 'test-webhookPass');
});

test('live checkout base is NEVER the unprefixed checkout-live host', () => {
  const cfg = resolveAdyenConfig('live', reader(withoutBases(BOTH, 'ADYEN_LIVE_')));
  assert.notEqual(cfg.checkoutBase, 'https://checkout-live.adyen.com');
  assert.notEqual(cfg.checkoutBase, 'https://checkout-live.adyen.com/v72');
  assert.match(cfg.checkoutBase, /^https:\/\/abc123-ServOS-checkout-live\.adyenpayments\.com\/checkout\/v72$/);
});

test('checkout host per region: each region builds its live checkout host from ITS prefix', () => {
  const uk = resolveAdyenConfig('live', reader(withoutBases(REGIONS, 'ADYEN_LIVE_')), { region: 'UK' });
  const us = resolveAdyenConfig('live', reader(withoutBases(REGIONS, 'ADYEN_LIVE_')), { region: 'US' });
  assert.equal(uk.checkoutBase, 'https://ukprefix-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  assert.equal(us.checkoutBase, 'https://usprefix-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  assert.equal(uk.checkoutBase, liveCheckoutBase(uk.prefix));
  assert.equal(us.checkoutBase, liveCheckoutBase(us.prefix));
  // a UK venue with only the legacy ADYEN_LIVE_PREFIX still builds its host; a US venue does not
  const legacy = { ...withoutBases(REGIONS, 'ADYEN_LIVE_'), ADYEN_LIVE_UK_PREFIX: undefined, ADYEN_LIVE_US_PREFIX: undefined, [ADYEN_LIVE_PREFIX_NAME]: 'legacy-ServOS' };
  assert.equal(resolveAdyenConfig('live', reader(legacy), { region: 'UK' }).checkoutBase, 'https://legacy-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  const usNoPrefix = resolveAdyenConfig('live', reader(legacy), { region: 'US' });
  assert.equal(usNoPrefix.checkoutBase, '');
  assert.deepEqual(usNoPrefix.missing, ['ADYEN_LIVE_US_PREFIX']);
});

test('terminal host per region: live UK is the classic EU data centre host, live US the -us host, an override wins', () => {
  const uk = resolveAdyenConfig('live', reader(withoutBases(REGIONS, 'ADYEN_LIVE_')), { region: 'UK' });
  const us = resolveAdyenConfig('live', reader(withoutBases(REGIONS, 'ADYEN_LIVE_')), { region: 'US' });
  assert.equal(uk.deviceBase, 'https://terminal-api-live.adyen.com');
  assert.equal(us.deviceBase, 'https://terminal-api-live-us.adyen.com');
  assert.equal(uk.deviceBaseOverride, false);
  assert.equal(us.deviceBaseOverride, false);
  // the endpoint derives from the config's OWN region when no region argument is given
  assert.equal(terminalEndpointForConfig(uk, 'M', 'AMS1-1', 'sync'), 'https://terminal-api-live.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(us, 'M', 'AMS1-1', 'sync'), 'https://terminal-api-live-us.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(us, 'M', 'AMS1-1', 'async', null), 'https://terminal-api-live-us.adyen.com/async');
  assert.equal(terminalEndpointForConfig(us, 'M', 'AMS1-1', 'sync', 'US'), 'https://terminal-api-live-us.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(uk, 'M', 'AMS1-1', 'sync', 'UK'), 'https://terminal-api-live.adyen.com/sync');
  // the region's OWN device base override is authoritative; the other region's override is ignored
  const withUs = resolveAdyenConfig('live', reader({ ...REGIONS, ADYEN_LIVE_US_DEVICE_BASE: 'https://device-api-live-us.adyen.com/', ADYEN_LIVE_UK_DEVICE_BASE: undefined, ADYEN_LIVE_DEVICE_BASE: undefined }), { region: 'US' });
  assert.equal(withUs.deviceBaseOverride, true);
  assert.equal(terminalEndpointForConfig(withUs, 'M', 'P', 'sync'), 'https://device-api-live-us.adyen.com/v1/merchants/M/devices/P/sync');
  const ukIgnoresUs = resolveAdyenConfig('live', reader({ ...REGIONS, ADYEN_LIVE_US_DEVICE_BASE: 'https://device-api-live-us.adyen.com/', ADYEN_LIVE_UK_DEVICE_BASE: undefined, ADYEN_LIVE_DEVICE_BASE: undefined }), { region: 'UK' });
  assert.equal(ukIgnoresUs.deviceBaseOverride, false);
  assert.equal(ukIgnoresUs.deviceBase, 'https://terminal-api-live.adyen.com');
});

test('live optional keys fall back to the LIVE api key, never the test one', () => {
  const cfg = resolveAdyenConfig('live', reader({
    ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey', [ADYEN_LIVE_PREFIX_NAME]: 'p',
  }));
  assert.equal(cfg.managementKey, 'live-apiKey');
  assert.equal(cfg.lemKey, 'live-apiKey');
  assert.equal(cfg.bpKey, 'live-apiKey');
  // and the explicit live keys win when set
  const cfg2 = resolveAdyenConfig('live', reader(BOTH));
  assert.equal(cfg2.managementKey, 'live-managementKey');
  assert.equal(cfg2.lemKey, 'live-lemKey');
  assert.equal(cfg2.bpKey, 'live-bpKey');
  // US: the US api key, never the UK one
  const us = resolveAdyenConfig('live', reader({ ...TEST_SET, ...UK_SET, ...LIVE_SET, ADYEN_LIVE_US_API_KEY: 'us-apiKey' }), { region: 'US' });
  assert.equal(us.managementKey, 'us-apiKey');
  assert.equal(us.lemKey, 'us-apiKey');
  assert.equal(us.bpKey, 'us-apiKey');
});

test('test optional keys fall back to the test api key (today\'s callers)', () => {
  const cfg = resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k' }));
  assert.equal(cfg.managementKey, 'k');
  assert.equal(cfg.lemKey, 'k');
  assert.equal(cfg.bpKey, 'k');
});

test('live events and webhook basic auth fall back to the test values when unset', () => {
  const cfg = resolveAdyenConfig('live', reader({
    ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey', [ADYEN_LIVE_PREFIX_NAME]: 'p',
  }));
  assert.equal(cfg.eventsUser, 'test-eventsUser');
  assert.equal(cfg.eventsPass, 'test-eventsPass');
  assert.equal(cfg.webhookUser, 'test-webhookUser');
  assert.equal(cfg.webhookPass, 'test-webhookPass');
  const cfg2 = resolveAdyenConfig('live', reader(BOTH));
  assert.equal(cfg2.eventsUser, 'live-eventsUser');
  assert.equal(cfg2.webhookPass, 'live-webhookPass');
  const uk = resolveAdyenConfig('live', reader(REGIONS), { region: 'UK' });
  assert.equal(uk.eventsUser, 'uk-eventsUser');
  const us = resolveAdyenConfig('live', reader(REGIONS), { region: 'US' });
  assert.equal(us.webhookUser, 'us-webhookUser');
});

test('live report credentials, hmac keys, client key and merchant account never fall back to test', () => {
  const cfg = resolveAdyenConfig('live', reader({
    ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey', [ADYEN_LIVE_PREFIX_NAME]: 'p',
  }));
  assert.equal(cfg.reportApiKey, '');
  assert.equal(cfg.reportUser, '');
  assert.equal(cfg.reportPass, '');
  assert.equal(cfg.hmacKey, '');
  assert.equal(cfg.bpHmacKey, '');
  assert.equal(cfg.clientKey, '');
  assert.equal(cfg.merchantAccount, '');
});

// ── Fail closed ──────────────────────────────────────────────────────────────

test('fail closed: live without the live api key', () => {
  const cfg = resolveAdyenConfig('live', reader({ ...TEST_SET, [ADYEN_LIVE_PREFIX_NAME]: 'p', ADYEN_LIVE_MERCHANT_ACCOUNT: 'm' }));
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, ['ADYEN_LIVE_UK_API_KEY']);
  assert.equal(cfg.apiKey, '');                            // NOT the test key
  assert.throws(() => assertAdyenConfigured(cfg), (err) => {
    assert.ok(err.message.startsWith(ADYEN_LIVE_FAIL_CLOSED));
    assert.ok(err.message.startsWith('Adyen live keys not configured for this venue'));
    assert.equal(err.message, 'Adyen live keys not configured for this venue (UK): set ADYEN_LIVE_UK_API_KEY');
    assert.equal(err.code, 'ADYEN_LIVE_NOT_CONFIGURED');
    assert.equal(err.region, 'UK');
    assert.deepEqual(err.missing, ['ADYEN_LIVE_UK_API_KEY']);
    return true;
  });
});

test('fail closed: live without the prefix, even with an explicit checkout base override', () => {
  const cfg = resolveAdyenConfig('live', reader({ ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey', ADYEN_LIVE_MERCHANT_ACCOUNT: 'm' }));
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, ['ADYEN_LIVE_UK_PREFIX']);
  assert.equal(cfg.checkoutBase, '');                     // no half built URL
  assert.throws(() => assertAdyenConfigured(cfg), (err) => err.message.startsWith(ADYEN_LIVE_FAIL_CLOSED));

  const cfg2 = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: 'k', ADYEN_LIVE_MERCHANT_ACCOUNT: 'm', ADYEN_LIVE_CHECKOUT_BASE: 'https://x.example/checkout/v72/' }));
  assert.equal(cfg2.checkoutBase, 'https://x.example/checkout/v72');
  assert.equal(cfg2.configured, false);
  assert.throws(() => assertAdyenConfigured(cfg2), (err) => err.message.startsWith(ADYEN_LIVE_FAIL_CLOSED));
});

test('fail closed: live without the merchant account (8 Sep 2026: the region set must name it)', () => {
  const cfg = resolveAdyenConfig('live', reader({ ...TEST_SET, ADYEN_LIVE_UK_API_KEY: 'k', ADYEN_LIVE_UK_PREFIX: 'p' }), { region: 'UK' });
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, ['ADYEN_LIVE_UK_MERCHANT_ACCOUNT']);
  assert.equal(cfg.merchantAccount, '');                   // NOT the test merchant account
  assert.throws(() => assertAdyenConfigured(cfg), { message: 'Adyen live keys not configured for this venue (UK): set ADYEN_LIVE_UK_MERCHANT_ACCOUNT' });
});

test('fail closed: all missing lists every name for the region, never a value', () => {
  const uk = resolveAdyenConfig('live', reader({ ...TEST_SET }));
  assert.deepEqual(uk.missing, ['ADYEN_LIVE_UK_API_KEY', 'ADYEN_LIVE_UK_PREFIX', 'ADYEN_LIVE_UK_MERCHANT_ACCOUNT']);
  const us = resolveAdyenConfig('live', reader({ ...TEST_SET, ...LIVE_SET, ...UK_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS' }), { region: 'US' });
  assert.deepEqual(us.missing, ['ADYEN_LIVE_US_API_KEY', 'ADYEN_LIVE_US_PREFIX', 'ADYEN_LIVE_US_MERCHANT_ACCOUNT']);
  for (const m of [...uk.missing, ...us.missing]) assert.ok(!/test-|live-|uk-|us-|abc123/.test(m));
});

test('fail closed message names the region specific secret names and never a value', () => {
  const secrets = { ...TEST_SET, ...LIVE_SET, ...UK_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS', ADYEN_LIVE_UK_PREFIX: 'ukprefix-ServOS' };
  const us = resolveAdyenConfig('live', reader(secrets), { region: 'US' });
  const msg = adyenNotConfiguredMessage(us);
  assert.equal(msg, 'Adyen live keys not configured for this venue (US): set ADYEN_LIVE_US_API_KEY, ADYEN_LIVE_US_PREFIX, ADYEN_LIVE_US_MERCHANT_ACCOUNT');
  assert.ok(msg.startsWith(ADYEN_LIVE_FAIL_CLOSED));
  for (const v of Object.values(secrets)) if (v) assert.ok(!msg.includes(v), `message leaked ${v}`);
  assert.ok(!/UK_/.test(msg), 'a US venue is never told to set UK names');
  // the same text is what assertAdyenConfigured throws
  assert.throws(() => assertAdyenConfigured(us), { message: msg });
  // a usable live config has nothing to say; a test config keeps the soft wording
  const uk = resolveAdyenConfig('live', reader(secrets), { region: 'UK' });
  assert.equal(uk.configured, true);
  assert.equal(adyenNotConfiguredMessage(uk), 'Adyen live keys not configured for this venue (UK)');
  assert.equal(adyenNotConfiguredMessage(resolveAdyenConfig('test', reader({}))), 'Adyen not configured, set ADYEN_API_KEY');
});

test('test without an api key is soft: not configured but assert does not throw', () => {
  const cfg = resolveAdyenConfig('test', reader({}));
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, ['ADYEN_API_KEY']);
  assert.doesNotThrow(() => assertAdyenConfigured(cfg));
  assert.equal(assertAdyenConfigured(cfg), cfg);
  const us = resolveAdyenConfig('test', reader({}), { region: 'US' });
  assert.deepEqual(us.missing, ['ADYEN_API_KEY']);        // the one test set, no US name to ask for
  assert.doesNotThrow(() => assertAdyenConfigured(us));
});

test('base overrides win and trailing slashes are trimmed', () => {
  const cfg = resolveAdyenConfig('test', reader({
    ADYEN_API_KEY: 'k',
    ADYEN_CHECKOUT_BASE: 'https://c.example/v72///',
    ADYEN_MGMT_BASE: 'https://m.example/v3/',
    ADYEN_LEM_BASE: 'https://l.example/lem/v4/',
    ADYEN_BP_BASE: 'https://b.example/bcl/v2/',
    ADYEN_DEVICE_BASE: 'https://terminal-api-test.adyen.com/',
  }));
  assert.equal(cfg.checkoutBase, 'https://c.example/v72');
  assert.equal(cfg.managementBase, 'https://m.example/v3');
  assert.equal(cfg.lemBase, 'https://l.example/lem/v4');
  assert.equal(cfg.balancePlatformBase, 'https://b.example/bcl/v2');
  assert.equal(cfg.deviceBase, 'https://terminal-api-test.adyen.com');
  // live overrides come from the live names, not the test ones
  const live = resolveAdyenConfig('live', reader({
    ADYEN_LIVE_API_KEY: 'k', [ADYEN_LIVE_PREFIX_NAME]: 'p',
    ADYEN_MGMT_BASE: 'https://wrong.example', ADYEN_LIVE_MGMT_BASE: 'https://right.example/v3',
    ADYEN_LIVE_DEVICE_BASE: 'https://device-api-live-us.adyen.com',
  }));
  assert.equal(live.managementBase, 'https://right.example/v3');
  assert.equal(live.deviceBase, 'https://device-api-live-us.adyen.com');
  // and the UK suffixed override beats the unsuffixed one
  const uk = resolveAdyenConfig('live', reader({ ADYEN_LIVE_MGMT_BASE: 'https://old.example/v3', ADYEN_LIVE_UK_MGMT_BASE: 'https://uk.example/v3/' }));
  assert.equal(uk.managementBase, 'https://uk.example/v3');
});

test('values are trimmed and blank secrets count as unset', () => {
  const cfg = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: '  k  ', [ADYEN_LIVE_PREFIX_NAME]: '   ' }));
  assert.equal(cfg.apiKey, 'k');
  assert.equal(cfg.prefix, '');
  assert.equal(cfg.configured, false);
  // a blank UK name falls through to the unsuffixed name
  const blankUk = resolveAdyenConfig('live', reader({ ADYEN_LIVE_UK_API_KEY: '   ', ADYEN_LIVE_API_KEY: 'k2' }));
  assert.equal(blankUk.apiKey, 'k2');
});

test('legacy zero argument mode: env from ADYEN_ENV, secrets from the TEST names', () => {
  // This is what the Deno helper's checkoutBase() / managementBase() etc. did
  // when called with no config: ADYEN_ENV decides the host shape, the
  // unprefixed names supply the values, exactly as before 7 Sep 2026.
  const get = reader({ ...BOTH, ADYEN_CHECKOUT_BASE: undefined, ADYEN_LIVE_CHECKOUT_BASE: undefined });
  const legacyLive = resolveAdyenConfig('live', get, { secretEnv: 'test' });
  assert.equal(legacyLive.live, true);
  assert.equal(legacyLive.apiKey, 'test-apiKey');
  assert.equal(legacyLive.prefix, 'abc123-ServOS');
  assert.equal(legacyLive.checkoutBase, 'https://abc123-ServOS-checkout-live.adyenpayments.com/checkout/v72');
  assert.equal(legacyLive.managementBase, 'test-managementBase'); // the unprefixed override
  const legacyTest = resolveAdyenConfig('test', get, { secretEnv: 'test' });
  assert.equal(legacyTest.apiKey, 'test-apiKey');
  assert.equal(legacyTest.live, false);
});

test('defaults table: every base has a value except live checkout', () => {
  for (const env of ['test', 'live']) {
    for (const [k, v] of Object.entries(ADYEN_DEFAULT_BASES[env])) {
      if (env === 'live' && k === 'checkoutBase') { assert.equal(v, ''); continue; }
      assert.match(v, /^https:\/\/[a-z0-9.-]+adyen\.com(\/|$)/, `${env}.${k}`);
      assert.ok(!v.endsWith('/'), `${env}.${k} has a trailing slash`);
    }
  }
});

// ── Terminal endpoints ───────────────────────────────────────────────────────

test('terminalEndpointFor: classic terminal-api hosts take the bare path, device-api hosts the per device path', () => {
  assert.equal(terminalEndpointFor('https://terminal-api-live.adyen.com', 'ServOSMerchant', 'AMS1-000168243358252', 'sync'),
    'https://terminal-api-live.adyen.com/sync');
  assert.equal(terminalEndpointFor('https://terminal-api-test.adyen.com/', 'M', 'P', 'async'),
    'https://terminal-api-test.adyen.com/async');
  assert.equal(terminalEndpointFor('https://device-api-test.adyen.com', 'Serv OS', 'AMS1-1', 'sync'),
    'https://device-api-test.adyen.com/v1/merchants/Serv%20OS/devices/AMS1-1/sync');
  assert.equal(terminalEndpointFor('https://device-api-live-us.adyen.com', 'M', 'P', 'sync'),
    'https://device-api-live-us.adyen.com/v1/merchants/M/devices/P/sync');
});

test('deviceBaseOverride: true only when the set names a device host explicitly', () => {
  assert.equal(resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k' })).deviceBaseOverride, false);
  assert.equal(resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k', ADYEN_DEVICE_BASE: 'https://terminal-api-test.adyen.com' })).deviceBaseOverride, true);
  const live = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: 'k', [ADYEN_LIVE_PREFIX_NAME]: 'p', ADYEN_DEVICE_BASE: 'https://x.example' }));
  assert.equal(live.deviceBaseOverride, false);   // the TEST override does not count for live
  assert.equal(live.deviceBase, 'https://terminal-api-live.adyen.com');
});

test('liveTerminalApiBase: UK (the EU data centre) is the bare classic host, every other region is suffixed', () => {
  assert.equal(liveTerminalApiBase('UK'), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase('uk'), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase('GB'), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase('eu'), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase('EU'), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase(), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase(''), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase(null), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase('us'), 'https://terminal-api-live-us.adyen.com');
  assert.equal(liveTerminalApiBase('US'), 'https://terminal-api-live-us.adyen.com');
  assert.equal(liveTerminalApiBase('au'), 'https://terminal-api-live-au.adyen.com');
  assert.equal(liveTerminalApiBase('apse'), 'https://terminal-api-live-apse.adyen.com');
});

test('terminalEndpointForConfig: live US venues go to the US classic host, UK unchanged', () => {
  const live = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: 'k', [ADYEN_LIVE_PREFIX_NAME]: 'p' }));
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'sync', 'us'), 'https://terminal-api-live-us.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'async', 'us'), 'https://terminal-api-live-us.adyen.com/async');
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'sync', 'eu'), 'https://terminal-api-live.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'sync', 'UK'), 'https://terminal-api-live.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'sync'), 'https://terminal-api-live.adyen.com/sync');
});

test('terminalEndpointForConfig: an explicit live device host wins over the region', () => {
  const live = resolveAdyenConfig('live', reader({
    ADYEN_LIVE_API_KEY: 'k', [ADYEN_LIVE_PREFIX_NAME]: 'p', ADYEN_LIVE_DEVICE_BASE: 'https://device-api-live-us.adyen.com/',
  }));
  assert.equal(terminalEndpointForConfig(live, 'M', 'P', 'sync', 'eu'), 'https://device-api-live-us.adyen.com/v1/merchants/M/devices/P/sync');
  assert.equal(terminalEndpointForConfig(live, 'M', 'P', 'sync', 'us'), 'https://device-api-live-us.adyen.com/v1/merchants/M/devices/P/sync');
});

test('terminalEndpointForConfig: test venues keep the test host whatever the region', () => {
  const t = resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k' }));
  assert.equal(terminalEndpointForConfig(t, 'M', 'P', 'sync', 'us'), 'https://device-api-test.adyen.com/v1/merchants/M/devices/P/sync');
  const t2 = resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k', ADYEN_DEVICE_BASE: 'https://terminal-api-test.adyen.com' }));
  assert.equal(terminalEndpointForConfig(t2, 'M', 'P', 'sync', 'us'), 'https://terminal-api-test.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(t2, 'M', 'P', 'sync', 'eu'), 'https://terminal-api-test.adyen.com/sync');
  const tUs = resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k' }), { region: 'US' });
  assert.equal(terminalEndpointForConfig(tUs, 'M', 'P', 'sync'), 'https://device-api-test.adyen.com/v1/merchants/M/devices/P/sync');
});

// ── Webhooks ─────────────────────────────────────────────────────────────────

test('webhookHmacPolicy: a live notification with only the TEST HMAC key is REJECTED, never verified with it', () => {
  // ADYEN_HMAC_KEY set, ADYEN_LIVE_HMAC_KEY unset: the state on the day the live set is new.
  const live = resolveAdyenConfig('live', reader({ ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey', [ADYEN_LIVE_PREFIX_NAME]: 'p' }));
  assert.equal(live.hmacKey, '');                       // the test key did not leak in
  assert.equal(webhookHmacPolicy(live, true), 'reject');
  assert.equal(webhookHmacPolicy(live, false), 'reject');   // an unsigned live item is rejected too
  // a live US venue with only the UK key: rejected too, the UK key never verifies a US item
  const us = resolveAdyenConfig('live', reader({ ...TEST_SET, ...UK_SET, ...LIVE_SET }), { region: 'US' });
  assert.equal(us.hmacKey, '');
  assert.equal(webhookHmacPolicy(us, true), 'reject');
});

test('webhookHmacPolicy: live with the live key verifies, test without a key is unverifiable', () => {
  const live = resolveAdyenConfig('live', reader(BOTH));
  assert.equal(webhookHmacPolicy(live, true), 'verify');
  assert.equal(webhookHmacPolicy(live, false), 'unverifiable');   // no signature on the item
  const testCfg = resolveAdyenConfig('test', reader({ ADYEN_API_KEY: 'k' }));
  assert.equal(webhookHmacPolicy(testCfg, true), 'unverifiable');
  const testSigned = resolveAdyenConfig('test', reader(TEST_SET));
  assert.equal(webhookHmacPolicy(testSigned, true), 'verify');
  assert.equal(webhookHmacPolicy(testSigned, false), 'unverifiable');
});

test('resolveWebhookKeys: live candidates are UK then US, only the regions with a key; test is the test key', () => {
  assert.deepEqual(resolveWebhookKeys(true, reader(REGIONS)), [
    { region: 'UK', hmacKey: 'uk-hmacKey' },
    { region: 'US', hmacKey: 'us-hmacKey' },
  ]);
  // UK via the unsuffixed fallback name, US absent
  assert.deepEqual(resolveWebhookKeys(true, reader(BOTH)), [{ region: 'UK', hmacKey: 'live-hmacKey' }]);
  // US only
  assert.deepEqual(resolveWebhookKeys(true, reader({ ...TEST_SET, ...US_SET })), [{ region: 'US', hmacKey: 'us-hmacKey' }]);
  // nothing live: an empty list, and NEVER the test key for a live notification
  assert.deepEqual(resolveWebhookKeys(true, reader(TEST_SET)), []);
  // test notification: the test key, and never a live key
  assert.deepEqual(resolveWebhookKeys(false, reader(REGIONS)), [{ region: 'UK', hmacKey: 'test-hmacKey' }]);
  assert.deepEqual(resolveWebhookKeys(false, reader({ ...UK_SET, ...US_SET })), []);
  // the optional US test override adds a second test candidate only when it differs
  assert.deepEqual(resolveWebhookKeys(false, reader({ ...TEST_SET, ADYEN_TEST_US_HMAC_KEY: 'testus-hmacKey' })), [
    { region: 'UK', hmacKey: 'test-hmacKey' },
    { region: 'US', hmacKey: 'testus-hmacKey' },
  ]);
  assert.deepEqual(resolveWebhookKeys(false, reader({ ...TEST_SET, ADYEN_TEST_US_HMAC_KEY: 'test-hmacKey' })), [{ region: 'UK', hmacKey: 'test-hmacKey' }]);
  // the balance platform key uses the same ordering
  assert.deepEqual(resolveWebhookKeys(true, reader(REGIONS), 'bpHmacKey'), [
    { region: 'UK', hmacKey: 'uk-bpHmacKey' },
    { region: 'US', hmacKey: 'us-bpHmacKey' },
  ]);
  assert.deepEqual(resolveWebhookKeys(false, reader(REGIONS), 'bpHmacKey'), [{ region: 'UK', hmacKey: 'test-bpHmacKey' }]);
});

test('resolveWebhookAuthPairs: live accepts any configured region pair (UK then US) then the test pair; test accepts the test pair', () => {
  assert.deepEqual(resolveWebhookAuthPairs(true, reader(REGIONS)), [
    { region: 'UK', user: 'uk-webhookUser', pass: 'uk-webhookPass' },
    { region: 'US', user: 'us-webhookUser', pass: 'us-webhookPass' },
    { region: 'UK', user: 'test-webhookUser', pass: 'test-webhookPass' },
  ]);
  assert.deepEqual(resolveWebhookAuthPairs(true, reader(REGIONS), 'events'), [
    { region: 'UK', user: 'uk-eventsUser', pass: 'uk-eventsPass' },
    { region: 'US', user: 'us-eventsUser', pass: 'us-eventsPass' },
    { region: 'UK', user: 'test-eventsUser', pass: 'test-eventsPass' },
  ]);
  // only the test pair set: live falls back to it (Adyen posts both environments to the one URL)
  assert.deepEqual(resolveWebhookAuthPairs(true, reader(TEST_SET)), [{ region: 'UK', user: 'test-webhookUser', pass: 'test-webhookPass' }]);
  // identical pairs are listed once
  const same = { ...TEST_SET, ADYEN_LIVE_UK_WEBHOOK_USER: 'test-webhookUser', ADYEN_LIVE_UK_WEBHOOK_PASS: 'test-webhookPass' };
  assert.deepEqual(resolveWebhookAuthPairs(true, reader(same)), [{ region: 'UK', user: 'test-webhookUser', pass: 'test-webhookPass' }]);
  // test notifications: the test pair only
  assert.deepEqual(resolveWebhookAuthPairs(false, reader(REGIONS)), [{ region: 'UK', user: 'test-webhookUser', pass: 'test-webhookPass' }]);
  // a half pair is not a pair
  assert.deepEqual(resolveWebhookAuthPairs(false, reader({ ADYEN_WEBHOOK_USER: 'u' })), []);
});

test('resolveLiveRegionsConfigured: the regions whose live set has api key, prefix and merchant account', () => {
  assert.deepEqual(resolveLiveRegionsConfigured(reader(REGIONS)), ['UK', 'US']);
  assert.deepEqual(resolveLiveRegionsConfigured(reader(BOTH)), ['UK']);           // UK via the unsuffixed names
  assert.deepEqual(resolveLiveRegionsConfigured(reader({ ...TEST_SET, ...US_SET, ADYEN_LIVE_US_PREFIX: 'p' })), ['US']);
  assert.deepEqual(resolveLiveRegionsConfigured(reader(TEST_SET)), []);
  assert.deepEqual(resolveLiveRegionsConfigured(reader({ ...UK_SET, ADYEN_LIVE_UK_PREFIX: 'p', ADYEN_LIVE_UK_MERCHANT_ACCOUNT: '' })), []);
});

// ── Merchant account guard ───────────────────────────────────────────────────

test('effectiveMerchantAccount: a live venue whose row still names the TEST merchant account uses ADYEN_LIVE_MERCHANT_ACCOUNT', () => {
  const secrets = { ...BOTH, ADYEN_MERCHANT_ACCOUNT: 'FranPOS_ServOS_TEST', ADYEN_LIVE_MERCHANT_ACCOUNT: 'FranPOS_ServOS_LIVE' };
  const live = resolveAdyenConfig('live', reader(secrets));
  const testCfg = resolveAdyenConfig('test', reader(secrets));
  // The stale row (flipped before set_environment rewrote merchant_account).
  assert.equal(effectiveMerchantAccount(live, 'FranPOS_ServOS_TEST', reader(secrets)), 'FranPOS_ServOS_LIVE');
  assert.equal(effectiveMerchantAccount(live, 'franpos_servos_test', reader(secrets)), 'FranPOS_ServOS_LIVE');
  // The mirror image: a row naming the live account on a test venue.
  assert.equal(effectiveMerchantAccount(testCfg, 'FranPOS_ServOS_LIVE', reader(secrets)), 'FranPOS_ServOS_TEST');
  // A hand entered name that is neither secret is kept verbatim.
  assert.equal(effectiveMerchantAccount(live, 'FranposUK_Provo', reader(secrets)), 'FranposUK_Provo');
  // The row naming this environment's own account is kept.
  assert.equal(effectiveMerchantAccount(live, 'FranPOS_ServOS_LIVE', reader(secrets)), 'FranPOS_ServOS_LIVE');
  // No row value: the secret set's account.
  assert.equal(effectiveMerchantAccount(live, null, reader(secrets)), 'FranPOS_ServOS_LIVE');
  assert.equal(effectiveMerchantAccount(live, '', reader(secrets)), 'FranPOS_ServOS_LIVE');
  // Both secrets the same name (Adyen mirrored it): the row is kept, nothing to swap.
  const same = { ...secrets, ADYEN_LIVE_MERCHANT_ACCOUNT: 'FranPOS_ServOS_TEST' };
  assert.equal(effectiveMerchantAccount(resolveAdyenConfig('live', reader(same)), 'FranPOS_ServOS_TEST', reader(same)), 'FranPOS_ServOS_TEST');
  // No live secret at all: the row stands (the set_environment guard refuses the flip in that case).
  const noLive = { ...secrets, ADYEN_LIVE_MERCHANT_ACCOUNT: '' };
  assert.equal(effectiveMerchantAccount(resolveAdyenConfig('live', reader(noLive)), 'FranPOS_ServOS_TEST', reader(noLive)), 'FranPOS_ServOS_TEST');
});

test('effectiveMerchantAccount: the guard reads the region set (UK names first, US only its own)', () => {
  const secrets = { ...REGIONS, ADYEN_MERCHANT_ACCOUNT: 'FranPOS_ServOS_TEST', ADYEN_LIVE_UK_MERCHANT_ACCOUNT: 'FranPOS_UK_LIVE', ADYEN_LIVE_US_MERCHANT_ACCOUNT: 'FranPOS_US_LIVE' };
  const uk = resolveAdyenConfig('live', reader(secrets), { region: 'UK' });
  const us = resolveAdyenConfig('live', reader(secrets), { region: 'US' });
  assert.equal(effectiveMerchantAccount(uk, 'FranPOS_ServOS_TEST', reader(secrets)), 'FranPOS_UK_LIVE');
  assert.equal(effectiveMerchantAccount(us, 'FranPOS_ServOS_TEST', reader(secrets)), 'FranPOS_US_LIVE');
  assert.equal(effectiveMerchantAccount(us, 'FranPOS_US_LIVE', reader(secrets)), 'FranPOS_US_LIVE');
  assert.equal(effectiveMerchantAccount(us, null, reader(secrets)), 'FranPOS_US_LIVE');
  // a test US venue whose row names the US live account gets the test account back
  const testUs = resolveAdyenConfig('test', reader(secrets), { region: 'US' });
  assert.equal(effectiveMerchantAccount(testUs, 'FranPOS_US_LIVE', reader(secrets)), 'FranPOS_ServOS_TEST');
});

// ── Region migration guard ───────────────────────────────────────────────────

test('isAdyenRegionCheckError: the old check refusing UK is recognised, other errors are not', () => {
  assert.equal(isAdyenRegionCheckError({ code: '23514', message: 'new row for relation "merchant_adyen_accounts" violates check constraint "merchant_adyen_accounts_region_check"' }), true);
  assert.equal(isAdyenRegionCheckError({ message: 'violates check constraint "merchant_adyen_accounts_region_check"' }), true);
  assert.equal(isAdyenRegionCheckError({ code: '23514', message: 'check constraint', details: 'Failing row contains (region UK)' }), true);
  assert.equal(isAdyenRegionCheckError({ code: '23514', message: 'violates check constraint "merchant_adyen_accounts_environment_check"' }), false);
  assert.equal(isAdyenRegionCheckError({ code: '23505', message: 'duplicate key' }), false);
  assert.equal(isAdyenRegionCheckError(null), false);
  assert.equal(ADYEN_REGION_MIGRATION, '20260908_PLATFORM_adyen_region_uk.sql');
  assert.ok(adyenRegionMigrationMessage().includes(ADYEN_REGION_MIGRATION));
});

// ── Row creates carry the venue's region (8 Sep 2026) ───────────────────────
// A merchant_adyen_accounts row created by onboarding's first stamp, the rate
// card save or a hand onboarding save must carry the venue's RESOLVED region,
// never the database default.

test('adyenAccountRowPatch: a CREATE stamps the resolved region, an existing row keeps its own, a named region always wins', () => {
  // onboarding's first stamp on a US venue with no row: region US rides along
  const created = adyenAccountRowPatch({ location_id: 'L1', legal_entity_id: 'LE1' }, null, 'US');
  assert.deepEqual(created, { location_id: 'L1', legal_entity_id: 'LE1', region: 'US' });
  // the rate card save on a UK venue with no row
  assert.equal(adyenAccountRowPatch({ location_id: 'L1', rate_card: {} }, null, 'UK').region, 'UK');
  assert.equal(adyenAccountRowPatch({ location_id: 'L1' }, null, 'EU').region, 'UK');   // legacy input reads as UK
  assert.equal(adyenAccountRowPatch({ location_id: 'L1' }, undefined, null).region, 'UK');
  // an existing row: no region column in the patch, whatever the row says
  assert.deepEqual(adyenAccountRowPatch({ location_id: 'L1', store_id: 'ST1' }, { region: 'US' }, 'UK'), { location_id: 'L1', store_id: 'ST1' });
  assert.ok(!('region' in adyenAccountRowPatch({ location_id: 'L1', region: '' }, { region: 'EU' }, 'US')));
  // a named region is normalised and kept, row or not
  assert.equal(adyenAccountRowPatch({ location_id: 'L1', region: 'usd' }, { region: 'EU' }, 'UK').region, 'US');
  assert.equal(adyenAccountRowPatch({ location_id: 'L1', region: 'EU' }, null, 'US').region, 'UK');
  // an unknown named region is dropped, not written
  assert.ok(!('region' in adyenAccountRowPatch({ location_id: 'L1', region: 'MARS' }, { region: 'UK' }, 'UK')));
  // the input patch is not mutated
  const input = { location_id: 'L1', region: 'EU' };
  adyenAccountRowPatch(input, null, 'US');
  assert.equal(input.region, 'EU');
});

test('adyenRegionRetryWithoutColumn: only a UK write refused by the old check, onto no row or a row that reads as UK', () => {
  const refused = { code: '23514', message: 'new row for relation "merchant_adyen_accounts" violates check constraint "merchant_adyen_accounts_region_check"' };
  assert.equal(adyenRegionRetryWithoutColumn(refused, { region: 'UK' }, null), true);              // create: the old default EU reads as UK
  assert.equal(adyenRegionRetryWithoutColumn(refused, { region: 'UK' }, { region: 'EU' }), true);   // legacy row, same account
  assert.equal(adyenRegionRetryWithoutColumn(refused, { region: 'UK' }, { region: 'UK' }), true);
  assert.equal(adyenRegionRetryWithoutColumn(refused, { region: 'UK' }, { region: 'US' }), false);  // would silently keep US
  assert.equal(adyenRegionRetryWithoutColumn(refused, { region: 'US' }, null), false);              // US passes either check: something else is wrong
  assert.equal(adyenRegionRetryWithoutColumn(refused, {}, null), false);
  assert.equal(adyenRegionRetryWithoutColumn({ code: '23505', message: 'duplicate key' }, { region: 'UK' }, null), false);
  assert.equal(adyenRegionRetryWithoutColumn(null, { region: 'UK' }, null), false);
});

test('resolveRegionByMerchantAccount: the region whose live set names the account, case insensitive, else null', () => {
  const secrets = { ...REGIONS, ADYEN_LIVE_UK_MERCHANT_ACCOUNT: 'FranPOS_UK_LIVE', ADYEN_LIVE_US_MERCHANT_ACCOUNT: 'FranPOS_US_LIVE', ADYEN_MERCHANT_ACCOUNT: 'FranPOS_ServOS_TEST' };
  assert.equal(resolveRegionByMerchantAccount('FranPOS_UK_LIVE', true, reader(secrets)), 'UK');
  assert.equal(resolveRegionByMerchantAccount('franpos_us_live', true, reader(secrets)), 'US');
  assert.equal(resolveRegionByMerchantAccount('FranPOS_ServOS_TEST', true, reader(secrets)), null);   // the test name is not a live account
  assert.equal(resolveRegionByMerchantAccount('FranPOS_ServOS_TEST', false, reader(secrets)), 'UK');
  assert.equal(resolveRegionByMerchantAccount('SomeoneElse', true, reader(secrets)), null);
  assert.equal(resolveRegionByMerchantAccount('', true, reader(secrets)), null);
  assert.equal(resolveRegionByMerchantAccount(null, true, reader(secrets)), null);
  // the unsuffixed live name is the UK fallback
  assert.equal(resolveRegionByMerchantAccount('live-merchantAccount', true, reader(BOTH)), 'UK');
});
