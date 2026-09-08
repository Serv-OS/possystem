/**
 * adyenEnv.js: per venue Adyen environment ('test' | 'live') AND region
 * ('UK' | 'US'), the secret name table and the base URL derivation. PURE.
 * No Deno, no Supabase, no network.
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
 * Owner facts 8 Sep 2026: the UK live account and the US live account are
 * DIFFERENT Adyen accounts (api key, client key, URL prefix, merchant
 * account, webhook HMAC key). So the live secret set is PER REGION, and the
 * region code the owner sees everywhere is 'UK' (never 'EU').
 *
 * SECRET SETS (same suffixes, different prefix), read in this order
 *   test, UK   ADYEN_<SUFFIX>
 *   test, US   ADYEN_TEST_US_<SUFFIX>, then ADYEN_<SUFFIX>   (one test account,
 *              the US override is optional)
 *   live, UK   ADYEN_LIVE_UK_<SUFFIX>, then ADYEN_LIVE_<SUFFIX>   (the
 *              unsuffixed live names stay as the UK fallback ONLY)
 *   live, US   ADYEN_LIVE_US_<SUFFIX>   (never UK, never the unsuffixed names)
 *   prefix     ADYEN_LIVE_UK_PREFIX (then ADYEN_LIVE_PREFIX), ADYEN_LIVE_US_PREFIX
 *
 * HOSTING PER REGION
 *   UK uses Adyen's EU data centre: Drop-in environment 'live', terminal host
 *   terminal-api-live.adyen.com. US: 'live-us', terminal-api-live-us.adyen.com.
 *   Checkout live: https://<REGION PREFIX>-checkout-live.adyenpayments.com/checkout/v72.
 *   Management, LEM and BCL live hosts are the same for both regions.
 *
 * FALLBACK RULES
 *   managementKey, lemKey, bpKey   fall back to the SAME set's apiKey
 *   eventsUser/Pass, webhookUser/Pass
 *                                  live falls back to the TEST values when the
 *                                  live ones are unset (Adyen posts both
 *                                  environments to the one URL)
 *   deviceBase                     live derives the classic terminal host from
 *                                  the region unless the set's DEVICE_BASE
 *                                  overrides it outright
 *   everything else                no cross set fallback at all
 *
 * FAIL CLOSED
 *   A live config whose REGION set lacks the api key, the prefix or the
 *   merchant account is `configured: false` and `missing` names the region
 *   specific secret names (never values). assertAdyenConfigured throws
 *   ADYEN_LIVE_FAIL_CLOSED plus those names. It NEVER falls back to the test
 *   keys, and a US venue never falls back to the UK keys.
 */

export const ADYEN_ENVS = Object.freeze(['test', 'live']);
export const ADYEN_REGIONS = Object.freeze(['UK', 'US']);
export const ADYEN_LIVE_PREFIX_NAME = 'ADYEN_LIVE_PREFIX';   // the UK fallback name
export const ADYEN_LIVE_FAIL_CLOSED = 'Adyen live keys not configured for this venue';
export const ADYEN_REGION_MIGRATION = '20260908_PLATFORM_adyen_region_uk.sql';

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
// from the region's prefix (liveCheckoutBase). Live deviceBase here is the UK
// (EU data centre) classic host; resolveAdyenConfig derives the regional host
// with liveTerminalApiBase. KEEP IN SYNC with _shared/adyen.ts.
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

// ── Region ───────────────────────────────────────────────────────────────────
// Region codes are 'UK' and 'US'. Legacy rows say 'EU' (the foundation
// migration's default) and read as 'UK'; country and currency style inputs
// are accepted too so a row, a location or a currency can all feed this.
const US_CODES = new Set(['US', 'USA', 'USD']);
const UK_CODES = new Set(['UK', 'GB', 'GBR', 'GBP', 'EU']);

// A region from ONE value, or null when the value says nothing.
export function parseAdyenRegion(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v) return null;
  if (US_CODES.has(v)) return 'US';
  if (UK_CODES.has(v)) return 'UK';
  return null;
}

// normaliseAdyenRegion(value, currency): the stored region first ('EU', 'GB'
// and 'GBP' style inputs read as 'UK'; 'US' and 'USD' as 'US'); anything
// unknown falls back by currency (USD => US); else UK.
export function normaliseAdyenRegion(value, currency) {
  return parseAdyenRegion(value) ?? parseAdyenRegion(currency) ?? 'UK';
}
export const normalizeAdyenRegion = normaliseAdyenRegion;

// The region for a merchant_adyen_accounts row, with the platform location
// (its currency) as the fallback when the row is missing or says nothing.
export function adyenRegionFromRow(row, location) {
  return normaliseAdyenRegion(row && row.region, location && location.currency);
}

// The Adyen Drop-in / Components `environment` option for a venue.
export function dropinEnvironmentFor(env, region) {
  if (normalizeAdyenEnv(env) !== 'live') return 'test';
  return normaliseAdyenRegion(region) === 'US' ? 'live-us' : 'live';
}

// ── Secret names ─────────────────────────────────────────────────────────────
// adyenSecretName: the CANONICAL name for a field, the one shown in messages
// and in `missing`. Live names carry the region (ADYEN_LIVE_UK_API_KEY); the
// test set is the unprefixed names in use today whatever the region.
export function adyenSecretName(env, field, region = 'UK') {
  const suffix = ADYEN_SECRET_SUFFIXES[field];
  if (!suffix) throw new Error(`adyenSecretName: unknown field ${field}`);
  if (normalizeAdyenEnv(env) !== 'live') return `ADYEN_${suffix}`;
  return `ADYEN_LIVE_${normaliseAdyenRegion(region)}_${suffix}`;
}

// adyenSecretNames: every name read for a field, in read order (the first
// non blank value wins).
//   test UK   [ADYEN_X]
//   test US   [ADYEN_TEST_US_X, ADYEN_X]
//   live UK   [ADYEN_LIVE_UK_X, ADYEN_LIVE_X]
//   live US   [ADYEN_LIVE_US_X]
export function adyenSecretNames(env, field, region = 'UK') {
  const suffix = ADYEN_SECRET_SUFFIXES[field];
  if (!suffix) throw new Error(`adyenSecretNames: unknown field ${field}`);
  const r = normaliseAdyenRegion(region);
  if (normalizeAdyenEnv(env) !== 'live') {
    return r === 'US' ? [`ADYEN_TEST_US_${suffix}`, `ADYEN_${suffix}`] : [`ADYEN_${suffix}`];
  }
  return r === 'UK' ? [`ADYEN_LIVE_UK_${suffix}`, `ADYEN_LIVE_${suffix}`] : [`ADYEN_LIVE_US_${suffix}`];
}

// The live Checkout URL prefix: canonical name and read order per region.
export function adyenLivePrefixName(region = 'UK') {
  return `ADYEN_LIVE_${normaliseAdyenRegion(region)}_PREFIX`;
}
export function adyenLivePrefixNames(region = 'UK') {
  return normaliseAdyenRegion(region) === 'UK'
    ? [adyenLivePrefixName('UK'), ADYEN_LIVE_PREFIX_NAME]
    : [adyenLivePrefixName('US')];
}

// Checkout v72 live host carries the per company (per region) prefix.
export function liveCheckoutBase(prefix) {
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/v72`;
}

const trimSlash = (s) => String(s).replace(/\/+$/, '');

// The classic live Terminal API host for a region. Live hosts are REGIONAL:
// terminal-api-live for the EU data centre (UK venues), then
// terminal-api-live-us, -au, -apse, -nea. Accepts 'UK' | 'US' as well as the
// lower case Adyen suffixes. MIRROR of _shared/adyen.ts.
export function liveTerminalApiBase(region = 'UK') {
  const r = String(region ?? '').trim().toLowerCase();
  if (!r || r === 'uk' || r === 'eu' || r === 'gb') return 'https://terminal-api-live.adyen.com';
  return `https://terminal-api-live-${r}.adyen.com`;
}

/**
 * resolveAdyenConfig(env, get, opts)
 *   env             'test' | 'live'  (anything else reads as 'test')
 *   get(name)       injected secret reader, returns string | undefined
 *   opts.region     'UK' | 'US' (default 'UK'; normalised, so 'EU' reads UK)
 *   opts.secretEnv  which SECRET SET to read, default = env. Mirror tests only.
 * Never throws. `configured` and `missing` say whether the set is usable;
 * `missing` holds secret NAMES only, never values.
 */
export function resolveAdyenConfig(env, get, opts = {}) {
  const e = normalizeAdyenEnv(env);
  const live = e === 'live';
  const region = normaliseAdyenRegion(opts.region);
  const secretEnv = normalizeAdyenEnv(opts.secretEnv ?? e);
  const first = (names) => {
    for (const n of names) {
      const v = get(n);
      const s = v == null ? '' : String(v).trim();
      if (s) return s;
    }
    return '';
  };
  const read = (field, set = secretEnv) => first(adyenSecretNames(set, field, region));
  const prefix = live ? first(adyenLivePrefixNames(region)) : '';
  const apiKey = read('apiKey');
  const merchantAccount = read('merchantAccount');
  const orApiKey = (field) => read(field) || apiKey;
  const orTest = (field) => read(field) || read(field, 'test');
  const override = (field) => { const v = read(field); return v ? trimSlash(v) : ''; };
  const defaults = ADYEN_DEFAULT_BASES[e];

  const missing = [];
  if (!apiKey) missing.push(adyenSecretName(secretEnv, 'apiKey', region));
  if (live && !prefix) missing.push(adyenLivePrefixName(region));
  if (live && !merchantAccount) missing.push(adyenSecretName(secretEnv, 'merchantAccount', region));

  return {
    env: e,
    live,
    region,
    dropinEnvironment: dropinEnvironmentFor(e, region),
    configured: missing.length === 0,
    missing,
    apiKey,
    clientKey: read('clientKey'),
    hmacKey: read('hmacKey'),
    merchantAccount,
    prefix,
    checkoutBase: override('checkoutBase') || (live ? (prefix ? liveCheckoutBase(prefix) : '') : defaults.checkoutBase),
    managementBase: override('managementBase') || defaults.managementBase,
    lemBase: override('lemBase') || defaults.lemBase,
    balancePlatformBase: override('balancePlatformBase') || defaults.balancePlatformBase,
    deviceBase: override('deviceBase') || (live ? liveTerminalApiBase(region) : defaults.deviceBase),
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

// The message a caller returns when a venue's config cannot be used: the
// exact fail closed text for live, naming the missing secret NAMES for the
// venue's region (never values); today's soft wording for test.
export function adyenNotConfiguredMessage(cfg) {
  if (!cfg || !cfg.live) return `Adyen not configured, set ${adyenSecretName('test', 'apiKey')}`;
  const names = Array.isArray(cfg.missing) ? cfg.missing.filter(Boolean) : [];
  const region = cfg.region ? ` (${cfg.region})` : '';
  return names.length ? `${ADYEN_LIVE_FAIL_CLOSED}${region}: set ${names.join(', ')}` : `${ADYEN_LIVE_FAIL_CLOSED}${region}`;
}

// Fail closed for LIVE only. A test config with no key keeps today's soft
// behaviour (callers check `configured` themselves and Adyen 401s).
export function assertAdyenConfigured(cfg) {
  if (cfg && cfg.live && !cfg.configured) {
    const err = new Error(adyenNotConfiguredMessage(cfg));
    err.code = 'ADYEN_LIVE_NOT_CONFIGURED';
    err.region = cfg.region;
    err.missing = Array.isArray(cfg.missing) ? cfg.missing.slice() : [];
    throw err;
  }
  return cfg;
}

// The live regions whose set is usable (api key, prefix and merchant
// account all present), UK then US.
export function resolveLiveRegionsConfigured(get) {
  return ADYEN_REGIONS.filter((region) => resolveAdyenConfig('live', get, { region }).configured);
}

// Webhook HMAC key candidates for one notification, UK then US. A live
// notification cannot say which account signed it before it is verified, so
// the receiver tries every configured live region key and records the one
// that matched; a test notification uses the test key (plus the optional US
// test override when it differs). `field` picks the standard key ('hmacKey')
// or the balance platform key ('bpHmacKey'). Blank keys are left out.
export function resolveWebhookKeys(live, get, field = 'hmacKey') {
  const out = [];
  const env = live ? 'live' : 'test';
  for (const region of ADYEN_REGIONS) {
    const key = resolveAdyenConfig(env, get, { region })[field] || '';
    if (!key) continue;
    if (!live && out.some((c) => c.hmacKey === key)) continue;   // the one test account, no US override
    out.push({ region, hmacKey: key });
  }
  return out;
}

// Basic auth pairs a webhook or terminal events receiver accepts: on live,
// any configured region pair (UK then US), then the test pair as the
// fallback; on test, the test pair. `kind` is 'webhook' | 'events'.
export function resolveWebhookAuthPairs(live, get, kind = 'webhook') {
  const userField = kind === 'events' ? 'eventsUser' : 'webhookUser';
  const passField = kind === 'events' ? 'eventsPass' : 'webhookPass';
  const out = [];
  const push = (region, cfg) => {
    const user = cfg[userField] || '';
    const pass = cfg[passField] || '';
    if (!user || !pass) return;
    if (out.some((c) => c.user === user && c.pass === pass)) return;
    out.push({ region, user, pass });
  };
  if (live) for (const region of ADYEN_REGIONS) push(region, resolveAdyenConfig('live', get, { region }));
  push('UK', resolveAdyenConfig('test', get, { region: 'UK' }));
  return out;
}

// The merchant account a venue's Adyen calls go out with. MIRROR of
// _shared/adyen.ts effectiveMerchantAccount (8 Sep 2026). The venue row's
// merchant_account wins over the secret set's, EXCEPT when the row names the
// OTHER environment's secret account for the same region (a venue flipped to
// live while its row still said FranPOS_ServOS_TEST): then this environment's
// secret account is used. `get` reads the secrets.
export function effectiveMerchantAccount(cfg, rowMerchant, get) {
  const row = String(rowMerchant ?? '').trim();
  const mine = String(cfg?.merchantAccount ?? '').trim();
  if (!row) return mine;
  const otherEnv = cfg?.live ? 'test' : 'live';
  let other = '';
  for (const name of adyenSecretNames(otherEnv, 'merchantAccount', cfg?.region)) {
    other = String(get(name) ?? '').trim();
    if (other) break;
  }
  if (mine && other && row.toLowerCase() === other.toLowerCase() && row.toLowerCase() !== mine.toLowerCase()) return mine;
  return row;
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

// Postgres refuses a region the OLD check constraint does not know ('UK'
// before ADYEN_REGION_MIGRATION is run). Writers catch this and answer with
// the migration's name instead of a bare constraint error.
export function isAdyenRegionCheckError(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '') + ' ' + String(err?.details ?? '');
  return /merchant_adyen_accounts_region_check/i.test(msg) || (code === '23514' && /region/i.test(msg));
}
export function adyenRegionMigrationMessage() {
  return `The database still only accepts the old region codes. Run ${ADYEN_REGION_MIGRATION} on the platform project, then try again.`;
}

// The patch for a merchant_adyen_accounts write that may CREATE the row.
// MIRROR of _shared/adyen.ts adyenAccountRowPatch (8 Sep 2026). A bare upsert
// created a missing row with the database DEFAULT region ('EU' today, 'UK'
// after the migration), which silently turned a US venue (region resolved by
// currency while it had no row) into a UK one for every later request. A
// create stamps the RESOLVED region; an existing row keeps its own unless the
// caller names one; a named region is normalised and an unknown one dropped.
// Never mutates the input.
export function adyenAccountRowPatch(patch, existingRow, region) {
  const out = { ...patch };
  const named = parseAdyenRegion(out.region);
  if (named) { out.region = named; return out; }
  delete out.region;
  if (!existingRow) out.region = normaliseAdyenRegion(region);
  return out;
}

// May a write the OLD check constraint refused be retried WITHOUT the region
// column? Only a 'UK' write (the old default 'EU' reads as UK) onto a row
// that already reads as UK, or no row at all. 'US' passes either check, and
// a UK write onto a row that says US must not silently keep US.
export function adyenRegionRetryWithoutColumn(err, patch, existingRow) {
  if (!isAdyenRegionCheckError(err)) return false;
  if (parseAdyenRegion(patch?.region) !== 'UK') return false;
  if (existingRow && normaliseAdyenRegion(existingRow.region) !== 'UK') return false;
  return true;
}

// The region whose secret set names this merchant account (case insensitive),
// null when neither does. MIRROR of _shared/adyen.ts.
export function resolveRegionByMerchantAccount(merchantAccount, live, get) {
  const code = String(merchantAccount ?? '').trim().toLowerCase();
  if (!code) return null;
  for (const region of ADYEN_REGIONS) {
    const mine = resolveAdyenConfig(live ? 'live' : 'test', get, { region }).merchantAccount;
    if (mine && mine.toLowerCase() === code) return region;
  }
  return null;
}

// Cloud Terminal API endpoint for one reader. The classic terminal-api hosts
// take the bare /sync path (the POIID rides in the nexo MessageHeader); the
// device-api hosts take the per merchant, per device path.
export function terminalEndpointFor(deviceBase, merchantAccount, poiid, mode) {
  const base = trimSlash(deviceBase);
  if (/terminal-api/.test(base)) return `${base}/${mode}`;
  return `${base}/v1/merchants/${encodeURIComponent(merchantAccount)}/devices/${encodeURIComponent(poiid)}/${mode}`;
}

// The reader endpoint for one venue config. An explicit <SET>_DEVICE_BASE is
// authoritative (region ignored). Otherwise live derives the REGIONAL classic
// host from the region (an explicit argument wins, else the config's own
// region), and test keeps the test default. MIRROR of _shared/adyen.ts.
export function terminalEndpointForConfig(cfg, merchantAccount, poiid, mode, region) {
  const r = region ?? cfg.region ?? 'UK';
  const base = (cfg.live && !cfg.deviceBaseOverride) ? liveTerminalApiBase(r) : cfg.deviceBase;
  return terminalEndpointFor(base, merchantAccount, poiid, mode);
}
