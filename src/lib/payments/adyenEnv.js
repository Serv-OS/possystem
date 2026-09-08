/**
 * adyenEnv.js: per venue Adyen environment ('test' | 'live'), the secret name
 * table and the base URL derivation. PURE. No Deno, no Supabase, no network.
 *
 * MIRROR: supabase/functions/_shared/adyen.ts carries the SAME table and the
 * SAME resolveAdyenConfig body (Deno cannot import from src/). Change both or
 * neither. adyenEnv.test.js is the contract for both copies.
 *
 * Owner decision 7 Sep 2026: dev and live share ONE Supabase project pair, so
 * the Adyen environment is a PER VENUE setting
 * (merchant_adyen_accounts.environment, default 'test') and every request
 * picks the matching secret set. Nothing changes for a venue until its row is
 * flipped to 'live'.
 *
 * SECRET SETS (same suffixes, different prefix)
 *   test  ADYEN_<SUFFIX>        the names in use today, unchanged
 *   live  ADYEN_LIVE_<SUFFIX>
 *   plus  ADYEN_LIVE_PREFIX     the company URL prefix live Checkout needs
 *
 * FALLBACK RULES
 *   managementKey, lemKey, bpKey   fall back to the SAME set's apiKey
 *   eventsUser/Pass, webhookUser/Pass
 *                                  live falls back to the TEST values when the
 *                                  live ones are unset (Adyen posts both
 *                                  environments to the one URL)
 *   deviceBase                     live default https://terminal-api-live.adyen.com
 *                                  (the EU classic host; other regions derive
 *                                  from the venue's region, see
 *                                  terminalEndpointForConfig) unless the set's
 *                                  DEVICE_BASE overrides it outright
 *   everything else                no cross set fallback at all
 *
 * FAIL CLOSED
 *   A live config with no apiKey or no prefix is `configured: false`.
 *   assertAdyenConfigured throws ADYEN_LIVE_FAIL_CLOSED for it. It NEVER
 *   falls back to the test keys.
 */

export const ADYEN_ENVS = Object.freeze(['test', 'live']);
export const ADYEN_LIVE_PREFIX_NAME = 'ADYEN_LIVE_PREFIX';
export const ADYEN_LIVE_FAIL_CLOSED = 'Adyen live keys not configured for this venue';

// Config field -> secret name suffix. KEEP IN SYNC with _shared/adyen.ts.
export const ADYEN_SECRET_SUFFIXES = Object.freeze({
  apiKey: 'API_KEY',
  clientKey: 'CLIENT_KEY',
  hmacKey: 'HMAC_KEY',
  merchantAccount: 'MERCHANT_ACCOUNT',
  deviceBase: 'DEVICE_BASE',
  managementKey: 'MANAGEMENT_KEY',
  lemKey: 'LEM_KEY',
  bpKey: 'BP_KEY',
  bpHmacKey: 'BP_HMAC_KEY',
  eventsUser: 'EVENTS_USER',
  eventsPass: 'EVENTS_PASS',
  webhookUser: 'WEBHOOK_USER',
  webhookPass: 'WEBHOOK_PASS',
  reportApiKey: 'REPORT_API_KEY',
  reportUser: 'REPORT_USER',
  reportPass: 'REPORT_PASS',
  checkoutBase: 'CHECKOUT_BASE',
  managementBase: 'MGMT_BASE',
  lemBase: 'LEM_BASE',
  balancePlatformBase: 'BP_BASE',
});

// Default hosts per environment. Live Checkout has no default: it is built
// from the prefix (liveCheckoutBase). KEEP IN SYNC with _shared/adyen.ts.
export const ADYEN_DEFAULT_BASES = Object.freeze({
  test: Object.freeze({
    checkoutBase: 'https://checkout-test.adyen.com/v72',
    managementBase: 'https://management-test.adyen.com/v3',
    lemBase: 'https://kyc-test.adyen.com/lem/v4',
    balancePlatformBase: 'https://balanceplatform-api-test.adyen.com/bcl/v2',
    deviceBase: 'https://device-api-test.adyen.com',
  }),
  live: Object.freeze({
    checkoutBase: '',
    managementBase: 'https://management-live.adyen.com/v3',
    lemBase: 'https://kyc-live.adyen.com/lem/v4',
    balancePlatformBase: 'https://balanceplatform-api-live.adyen.com/bcl/v2',
    deviceBase: 'https://terminal-api-live.adyen.com',
  }),
});

// Anything that is not exactly 'live' (case and whitespace tolerant) is 'test'.
export function normalizeAdyenEnv(v) {
  return String(v ?? '').trim().toLowerCase() === 'live' ? 'live' : 'test';
}

// The environment stamped on a merchant_adyen_accounts row. Missing row,
// missing column (migration pending) or any other value all mean 'test'.
export function adyenEnvFromRow(row) {
  return normalizeAdyenEnv(row && row.environment);
}

export function adyenSecretName(env, field) {
  const suffix = ADYEN_SECRET_SUFFIXES[field];
  if (!suffix) throw new Error(`adyenSecretName: unknown field ${field}`);
  return normalizeAdyenEnv(env) === 'live' ? `ADYEN_LIVE_${suffix}` : `ADYEN_${suffix}`;
}

// Checkout v72 live host carries the per company prefix.
export function liveCheckoutBase(prefix) {
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/v72`;
}

const trimSlash = (s) => String(s).replace(/\/+$/, '');

/**
 * resolveAdyenConfig(env, get, opts)
 *   env             'test' | 'live'  (anything else reads as 'test')
 *   get(name)       injected secret reader, returns string | undefined
 *   opts.secretEnv  which SECRET SET to read, default = env. The Deno zero
 *                   argument helpers pass secretEnv 'test' with env taken from
 *                   ADYEN_ENV: that is exactly today's behaviour for callers
 *                   not yet moved to per venue config.
 * Never throws. `configured` and `missing` say whether the set is usable;
 * `missing` holds secret NAMES only, never values.
 */
export function resolveAdyenConfig(env, get, opts = {}) {
  const e = normalizeAdyenEnv(env);
  const live = e === 'live';
  const secretEnv = normalizeAdyenEnv(opts.secretEnv ?? e);
  const read = (field, set = secretEnv) => {
    const v = get(adyenSecretName(set, field));
    return v == null ? '' : String(v).trim();
  };
  const prefix = live ? String(get(ADYEN_LIVE_PREFIX_NAME) ?? '').trim() : '';
  const apiKey = read('apiKey');
  const orApiKey = (field) => read(field) || apiKey;
  const orTest = (field) => read(field) || read(field, 'test');
  const override = (field) => { const v = read(field); return v ? trimSlash(v) : ''; };
  const defaults = ADYEN_DEFAULT_BASES[e];

  const missing = [];
  if (!apiKey) missing.push(adyenSecretName(secretEnv, 'apiKey'));
  if (live && !prefix) missing.push(ADYEN_LIVE_PREFIX_NAME);

  return {
    env: e,
    live,
    configured: missing.length === 0,
    missing,
    apiKey,
    clientKey: read('clientKey'),
    hmacKey: read('hmacKey'),
    merchantAccount: read('merchantAccount'),
    prefix,
    checkoutBase: override('checkoutBase') || (live ? (prefix ? liveCheckoutBase(prefix) : '') : defaults.checkoutBase),
    managementBase: override('managementBase') || defaults.managementBase,
    lemBase: override('lemBase') || defaults.lemBase,
    balancePlatformBase: override('balancePlatformBase') || defaults.balancePlatformBase,
    deviceBase: override('deviceBase') || defaults.deviceBase,
    deviceBaseOverride: !!override('deviceBase'),   // explicit host: region is ignored
    managementKey: orApiKey('managementKey'),
    lemKey: orApiKey('lemKey'),
    bpKey: orApiKey('bpKey'),
    bpHmacKey: read('bpHmacKey'),
    eventsUser: orTest('eventsUser'),
    eventsPass: orTest('eventsPass'),
    webhookUser: orTest('webhookUser'),
    webhookPass: orTest('webhookPass'),
    reportApiKey: read('reportApiKey'),
    reportUser: read('reportUser'),
    reportPass: read('reportPass'),
  };
}

// Fail closed for LIVE only. A test config with no key keeps today's soft
// behaviour (callers check `configured` themselves and Adyen 401s).
export function assertAdyenConfigured(cfg) {
  if (cfg && cfg.live && !cfg.configured) {
    const err = new Error(ADYEN_LIVE_FAIL_CLOSED);
    err.code = 'ADYEN_LIVE_NOT_CONFIGURED';
    err.missing = Array.isArray(cfg.missing) ? cfg.missing.slice() : [];
    throw err;
  }
  return cfg;
}

// What the standard webhook receiver does with one item, given the config the
// notification's own live flag selected. MIRROR of _shared/adyen.ts.
//   'reject'        live notification, live HMAC key not set: the test key must
//                   never verify a live item and a live item must never be
//                   applied unverified. The receiver answers 503 so Adyen
//                   retries once the key exists.
//   'unverifiable'  test with no key, or an item with no signature: recorded
//                   with hmac_valid null (today's soft test behaviour).
//   'verify'        verify the signature with cfg.hmacKey.
export function webhookHmacPolicy(cfg, hasSignature) {
  if (cfg.live && !cfg.hmacKey) return 'reject';
  if (!cfg.hmacKey || !hasSignature) return 'unverifiable';
  return 'verify';
}

// Cloud Terminal API endpoint for one reader. The classic terminal-api hosts
// take the bare /sync path (the POIID rides in the nexo MessageHeader); the
// device-api hosts take the per merchant, per device path.
export function terminalEndpointFor(deviceBase, merchantAccount, poiid, mode) {
  const base = trimSlash(deviceBase);
  if (/terminal-api/.test(base)) return `${base}/${mode}`;
  return `${base}/v1/merchants/${encodeURIComponent(merchantAccount)}/devices/${encodeURIComponent(poiid)}/${mode}`;
}

// The classic live Terminal API host for a region. Live hosts are REGIONAL:
// terminal-api-live for EU, then terminal-api-live-us, -au, -apse, -nea.
// MIRROR of _shared/adyen.ts.
export function liveTerminalApiBase(region = 'eu') {
  const r = String(region ?? '').trim().toLowerCase() || 'eu';
  return r === 'eu' ? 'https://terminal-api-live.adyen.com' : `https://terminal-api-live-${r}.adyen.com`;
}

// The reader endpoint for one venue config. An explicit <SET>_DEVICE_BASE is
// authoritative (region ignored). Otherwise live derives the REGIONAL classic
// host from the venue's region, and test keeps the test default.
// MIRROR of _shared/adyen.ts.
export function terminalEndpointForConfig(cfg, merchantAccount, poiid, mode, region = 'eu') {
  const base = (cfg.live && !cfg.deviceBaseOverride) ? liveTerminalApiBase(region) : cfg.deviceBase;
  return terminalEndpointFor(base, merchantAccount, poiid, mode);
}
