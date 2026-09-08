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
  ADYEN_SECRET_SUFFIXES, ADYEN_DEFAULT_BASES, ADYEN_LIVE_FAIL_CLOSED, ADYEN_LIVE_PREFIX_NAME,
  normalizeAdyenEnv, adyenEnvFromRow, adyenSecretName, liveCheckoutBase,
  resolveAdyenConfig, assertAdyenConfigured, terminalEndpointFor,
  liveTerminalApiBase, terminalEndpointForConfig, webhookHmacPolicy,
} from './adyenEnv.js';

const FIELDS = Object.keys(ADYEN_SECRET_SUFFIXES);
const reader = (map) => (name) => map[name];

// A full test set and a full live set, every value distinct so a leak from
// one set into the other is visible in the assertions.
const TEST_SET = Object.fromEntries(FIELDS.map((f) => [`ADYEN_${ADYEN_SECRET_SUFFIXES[f]}`, `test-${f}`]));
const LIVE_SET = Object.fromEntries(FIELDS.map((f) => [`ADYEN_LIVE_${ADYEN_SECRET_SUFFIXES[f]}`, `live-${f}`]));
const BOTH = { ...TEST_SET, ...LIVE_SET, [ADYEN_LIVE_PREFIX_NAME]: 'abc123-ServOS' };

// The base overrides are hosts, not keys; drop them so defaults are exercised.
const withoutBases = (set, prefix) => Object.fromEntries(
  Object.entries(set).filter(([k]) => !/_(CHECKOUT_BASE|MGMT_BASE|LEM_BASE|BP_BASE|DEVICE_BASE)$/.test(k) || !k.startsWith(prefix)),
);

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
});

test('secret names: the live set is ADYEN_LIVE_ plus the same suffixes', () => {
  for (const f of FIELDS) {
    const t = adyenSecretName('test', f);
    const l = adyenSecretName('live', f);
    assert.equal(l, t.replace(/^ADYEN_/, 'ADYEN_LIVE_'), f);
  }
  assert.equal(adyenSecretName('live', 'apiKey'), 'ADYEN_LIVE_API_KEY');
  assert.equal(adyenSecretName('live', 'managementBase'), 'ADYEN_LIVE_MGMT_BASE');
  assert.equal(adyenSecretName('live', 'deviceBase'), 'ADYEN_LIVE_DEVICE_BASE');
  assert.throws(() => adyenSecretName('live', 'nope'), /unknown field/);
});

test('test config: reads the test set only, test defaults, configured with just the api key', () => {
  const cfg = resolveAdyenConfig('test', reader(withoutBases(BOTH, 'ADYEN_')));
  assert.equal(cfg.env, 'test');
  assert.equal(cfg.live, false);
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

test('live config: reads the live set only, live defaults, prefix URL shape', () => {
  const cfg = resolveAdyenConfig('live', reader(withoutBases(BOTH, 'ADYEN_LIVE_')));
  assert.equal(cfg.env, 'live');
  assert.equal(cfg.live, true);
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

test('live checkout base is NEVER the unprefixed checkout-live host', () => {
  const cfg = resolveAdyenConfig('live', reader(withoutBases(BOTH, 'ADYEN_LIVE_')));
  assert.notEqual(cfg.checkoutBase, 'https://checkout-live.adyen.com');
  assert.notEqual(cfg.checkoutBase, 'https://checkout-live.adyen.com/v72');
  assert.match(cfg.checkoutBase, /^https:\/\/abc123-ServOS-checkout-live\.adyenpayments\.com\/checkout\/v72$/);
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

test('fail closed: live without the live api key', () => {
  const cfg = resolveAdyenConfig('live', reader({ ...TEST_SET, [ADYEN_LIVE_PREFIX_NAME]: 'p' }));
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, ['ADYEN_LIVE_API_KEY']);
  assert.equal(cfg.apiKey, '');                            // NOT the test key
  assert.throws(() => assertAdyenConfigured(cfg), (err) => {
    assert.equal(err.message, ADYEN_LIVE_FAIL_CLOSED);
    assert.equal(err.message, 'Adyen live keys not configured for this venue');
    assert.equal(err.code, 'ADYEN_LIVE_NOT_CONFIGURED');
    assert.deepEqual(err.missing, ['ADYEN_LIVE_API_KEY']);
    return true;
  });
});

test('fail closed: live without the prefix, even with an explicit checkout base override', () => {
  const cfg = resolveAdyenConfig('live', reader({ ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey' }));
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, [ADYEN_LIVE_PREFIX_NAME]);
  assert.equal(cfg.checkoutBase, '');                     // no half built URL
  assert.throws(() => assertAdyenConfigured(cfg), { message: ADYEN_LIVE_FAIL_CLOSED });

  const cfg2 = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: 'k', ADYEN_LIVE_CHECKOUT_BASE: 'https://x.example/checkout/v72/' }));
  assert.equal(cfg2.checkoutBase, 'https://x.example/checkout/v72');
  assert.equal(cfg2.configured, false);
  assert.throws(() => assertAdyenConfigured(cfg2), { message: ADYEN_LIVE_FAIL_CLOSED });
});

test('fail closed: both missing lists both names, never a value', () => {
  const cfg = resolveAdyenConfig('live', reader({ ...TEST_SET }));
  assert.deepEqual(cfg.missing, ['ADYEN_LIVE_API_KEY', ADYEN_LIVE_PREFIX_NAME]);
  for (const m of cfg.missing) assert.ok(!/test-|live-/.test(m));
});

test('test without an api key is soft: not configured but assert does not throw', () => {
  const cfg = resolveAdyenConfig('test', reader({}));
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.missing, ['ADYEN_API_KEY']);
  assert.doesNotThrow(() => assertAdyenConfigured(cfg));
  assert.equal(assertAdyenConfigured(cfg), cfg);
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
});

test('values are trimmed and blank secrets count as unset', () => {
  const cfg = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: '  k  ', [ADYEN_LIVE_PREFIX_NAME]: '   ' }));
  assert.equal(cfg.apiKey, 'k');
  assert.equal(cfg.prefix, '');
  assert.equal(cfg.configured, false);
});

test('legacy zero argument mode: env from ADYEN_ENV, secrets from the TEST names', () => {
  // This is what the Deno helper's checkoutBase() / managementBase() etc. do
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

test('liveTerminalApiBase: EU is the bare classic host, every other region is suffixed', () => {
  assert.equal(liveTerminalApiBase('eu'), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase(), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase(''), 'https://terminal-api-live.adyen.com');
  assert.equal(liveTerminalApiBase('us'), 'https://terminal-api-live-us.adyen.com');
  assert.equal(liveTerminalApiBase('US'), 'https://terminal-api-live-us.adyen.com');
  assert.equal(liveTerminalApiBase('au'), 'https://terminal-api-live-au.adyen.com');
  assert.equal(liveTerminalApiBase('apse'), 'https://terminal-api-live-apse.adyen.com');
});

test('terminalEndpointForConfig: live US venues go to the US classic host, EU unchanged', () => {
  const live = resolveAdyenConfig('live', reader({ ADYEN_LIVE_API_KEY: 'k', [ADYEN_LIVE_PREFIX_NAME]: 'p' }));
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'sync', 'us'), 'https://terminal-api-live-us.adyen.com/sync');
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'async', 'us'), 'https://terminal-api-live-us.adyen.com/async');
  assert.equal(terminalEndpointForConfig(live, 'M', 'AMS1-1', 'sync', 'eu'), 'https://terminal-api-live.adyen.com/sync');
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
});

test('webhookHmacPolicy: a live notification with only the TEST HMAC key is REJECTED, never verified with it', () => {
  // ADYEN_HMAC_KEY set, ADYEN_LIVE_HMAC_KEY unset: the state on the day the live set is new.
  const live = resolveAdyenConfig('live', reader({ ...TEST_SET, ADYEN_LIVE_API_KEY: 'live-apiKey', [ADYEN_LIVE_PREFIX_NAME]: 'p' }));
  assert.equal(live.hmacKey, '');                       // the test key did not leak in
  assert.equal(webhookHmacPolicy(live, true), 'reject');
  assert.equal(webhookHmacPolicy(live, false), 'reject');   // an unsigned live item is rejected too
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
