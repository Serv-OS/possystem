// supabase/functions/_shared/adyen.ts
//
// Minimal Adyen REST client + protocol helpers for edge functions (raw REST,
// the official SDK targets Node 18/node-https and does not run on Deno).
// Built per ADYEN_INTEGRATION_PLAN.md Phase 0; API facts from docs/adyen/research/*.
//
// Auth: X-API-Key header. Amounts: Checkout + webhooks use MINOR units
// ({value, currency}); Terminal API (nexo 3.0) uses DECIMAL MAJOR units.
//
// ── PER VENUE ENVIRONMENT (owner decision 7 Sep 2026) ────────────────────────
// Dev and live share ONE Supabase project pair, so the Adyen environment is a
// PER VENUE setting: merchant_adyen_accounts.environment ('test' | 'live',
// default 'test', migration 20260907_PLATFORM_adyen_environment.sql). Every
// request resolves the venue's env and picks the matching secret set. Secrets
// are read at CALL time, never at module load, so a secret change needs no
// redeploy.
//
// ── PER VENUE REGION (owner facts 8 Sep 2026) ────────────────────────────────
// The UK live account and the US live account are DIFFERENT Adyen accounts:
// different api key, client key, URL prefix, merchant account, webhook HMAC
// key and hosts. So the LIVE secret set is per region, and the region code
// the owner sees everywhere (secret names, admin select, database value) is
// 'UK', never 'EU'. merchant_adyen_accounts.region holds 'UK' | 'US' after
// 20260908_PLATFORM_adyen_region_uk.sql; a legacy 'EU' row reads as 'UK'.
//
//   test set, UK   ADYEN_<SUFFIX>            the names in use today, unchanged
//   test set, US   ADYEN_TEST_US_<SUFFIX>    optional override, else ADYEN_<SUFFIX>
//   live set, UK   ADYEN_LIVE_UK_<SUFFIX>    then ADYEN_LIVE_<SUFFIX> (UK fallback ONLY)
//   live set, US   ADYEN_LIVE_US_<SUFFIX>    never UK, never the unsuffixed names
//   prefix         ADYEN_LIVE_UK_PREFIX (then ADYEN_LIVE_PREFIX), ADYEN_LIVE_US_PREFIX
//   ADYEN_ENV is ONLY the fallback when a request cannot be tied to a venue
//   row (default 'test'). It never picks the secret set for a known venue.
//
// Hosting per region: UK uses Adyen's EU data centre (Drop-in 'live',
// terminal-api-live.adyen.com); US uses 'live-us' and
// terminal-api-live-us.adyen.com. Checkout live is
// https://<REGION PREFIX>-checkout-live.adyenpayments.com/checkout/v72.
// Management, LEM and BCL live hosts are the same for both regions.
//
// Suffixes: API_KEY, CLIENT_KEY, HMAC_KEY, MERCHANT_ACCOUNT, DEVICE_BASE,
// MANAGEMENT_KEY, LEM_KEY, BP_KEY, BP_HMAC_KEY, EVENTS_USER, EVENTS_PASS,
// WEBHOOK_USER, WEBHOOK_PASS, REPORT_API_KEY, REPORT_USER, REPORT_PASS,
// CHECKOUT_BASE, MGMT_BASE, LEM_BASE, BP_BASE (the last five plus DEVICE_BASE
// are optional explicit host overrides, else derived from the defaults table).
//
// Fallbacks: managementKey / lemKey / bpKey fall back to the SAME set's apiKey;
// events + webhook basic auth fall back live -> test (Adyen posts both
// environments to the one URL). Nothing else crosses sets. A live venue whose
// REGION set has no api key, no prefix or no merchant account FAILS CLOSED
// with 'Adyen live keys not configured for this venue' naming the missing
// secret names. It never gets test keys, and a US venue never gets UK keys.
//
// MIRROR: src/lib/payments/adyenEnv.js carries the same suffix table, the same
// defaults and the same resolveAdyenConfig body, with the contract tests in
// adyenEnv.test.js. Deno cannot import from src/, so change both or neither.
//
// HOW TO USE (new code)
//   const cfg = await adyenConfigForLocation(platformAdmin, locationId);
//   // or, when the merchant_adyen_accounts row is already in hand:
//   const cfg = adyenConfig(adyenEnvFromRow(maa), adyenRegionFromRow(maa, loc));
//   // adyenEnvForLocation returns { env, region }; adyenConfig takes that
//   // object as is, or (env, region) as two arguments. adyenConfig(env) alone
//   // is the UK set.
//   await adyenFetch('POST', `${checkoutBase(cfg)}/payments`, body, { cfg, idempotencyKey });
//   terminalEndpoint(maa.merchant_account, poiid, 'sync', cfg.region, cfg)
//   adyenFetch('GET', `${managementBase(cfg)}/...`, undefined, { cfg, apiKey: cfg.managementKey })
//   platformLocationIdFor(platformAdmin, opsOrPlatformId)   either id space -> platform id
//                                    (null when unknown, THROWS on a DB error)
//   adyenAccountForLocation(platformAdmin, platformId, cols)   { env, region, row } in one read
//   adyenNotConfiguredMessage(cfg)   the 503 text (exact fail closed wording on live, plus the names)
//   liveRegionsConfigured()          ['UK', 'US'] filtered to the usable live sets
//   webhookKeysFor(live)             [{ region, hmacKey }] to try in order, UK then US
//   webhookAuthPairsFor(live, kind)  [{ region, user, pass }] basic auth pairs accepted
//   paymentIdempotencyKey(reference, attempt)   'pay:<ref>:a<N>', hashed when over 64 chars
//   maskMerchantAccount(name)   for status responses reachable by customers
//   webhookHmacPolicy(cfg, hasSignature)   'reject' | 'unverifiable' | 'verify'
//   isAdyenRegionCheckError(err) + adyenRegionMigrationMessage()   a 'UK' write
//                                    refused by the OLD check constraint
//   upsertAdyenAccountRow(platformAdmin, patch, { region? })   the region aware
//                                    merchant_adyen_accounts upsert: a CREATE stamps the
//                                    venue's resolved region, a 'UK' the old check refuses
//                                    is retried without the column and named in `warning`
//   adyenRegionForMerchantAccount(platformAdmin, code, live)   which account a merchant
//                                    account NAME belongs to (the secret sets, then rows)
//
// Every Adyen function resolves its venue first (adyen-checkout,
// adyen-create-session, adyen-modify, adyen-terminal-admin, adyen-terminal-charge,
// adyen-terminal-events, adyen-capture-sweep, adyen-onboard, adyen-financial,
// booking-widget). adyen-webhook and adyen-bp-webhook pick the set by the
// notification (top level live flag, then whichever region key verifies);
// adyen-report-ingest by the report download host (ca-live vs ca-test).
//
// Every host and fetch helper takes the venue's config. There is no zero
// argument form any more: a call with no config is a type error, never a
// silent read of the test secrets. resolveAdyenConfig keeps the secretEnv
// option for the mirror tests only.

export type AdyenEnv = 'test' | 'live';
export type AdyenRegion = 'UK' | 'US';
export type AdyenDropinEnvironment = 'test' | 'live' | 'live-us';
export interface AdyenTarget { env: AdyenEnv; region: AdyenRegion }

export const ADYEN_REGIONS: readonly AdyenRegion[] = ['UK', 'US'] as const;
export const ADYEN_LIVE_PREFIX_NAME = 'ADYEN_LIVE_PREFIX';   // the UK fallback name
export const ADYEN_LIVE_FAIL_CLOSED = 'Adyen live keys not configured for this venue';
export const ADYEN_REGION_MIGRATION = '20260908_PLATFORM_adyen_region_uk.sql';

// Config field -> secret name suffix. KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export const ADYEN_SECRET_SUFFIXES = {
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
} as const;
export type AdyenSecretField = keyof typeof ADYEN_SECRET_SUFFIXES;

// Default hosts per environment (docs/adyen/research/adyen-setup-golive.md §4).
// Live Checkout has no default: it is built from the region's prefix
// (liveCheckoutBase). Live deviceBase here is the UK (EU data centre) classic
// host; resolveAdyenConfig derives the regional host with liveTerminalApiBase
// unless <SET>_DEVICE_BASE overrides the host outright.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export const ADYEN_DEFAULT_BASES: Record<AdyenEnv, { checkoutBase: string; managementBase: string; lemBase: string; balancePlatformBase: string; deviceBase: string }> = {
  test: {
    checkoutBase: 'https://checkout-test.adyen.com/v72',
    managementBase: 'https://management-test.adyen.com/v3',
    lemBase: 'https://kyc-test.adyen.com/lem/v4',
    balancePlatformBase: 'https://balanceplatform-api-test.adyen.com/bcl/v2',
    deviceBase: 'https://device-api-test.adyen.com',
  },
  live: {
    checkoutBase: '',
    managementBase: 'https://management-live.adyen.com/v3',
    lemBase: 'https://kyc-live.adyen.com/lem/v4',
    balancePlatformBase: 'https://balanceplatform-api-live.adyen.com/bcl/v2',
    deviceBase: 'https://terminal-api-live.adyen.com',
  },
};

export interface AdyenConfig {
  env: AdyenEnv;
  live: boolean;
  region: AdyenRegion;                        // 'UK' | 'US', the secret set and hosts this config was built for
  dropinEnvironment: AdyenDropinEnvironment;  // Drop-in / Components `environment`: 'test' | 'live' | 'live-us'
  configured: boolean;     // test: apiKey set. live: apiKey AND prefix AND merchant account set (region set).
  missing: string[];       // secret NAMES that block `configured`, never values
  apiKey: string;
  clientKey: string;
  hmacKey: string;
  merchantAccount: string;
  prefix: string;          // ADYEN_LIVE_<REGION>_PREFIX (UK falls back to ADYEN_LIVE_PREFIX), '' on test
  checkoutBase: string;    // '' when live and the prefix is missing (no half built URL)
  managementBase: string;
  lemBase: string;
  balancePlatformBase: string;
  deviceBase: string;      // live: the region's classic terminal host unless overridden
  deviceBaseOverride: boolean;   // true when <SET>_DEVICE_BASE set the host explicitly (then region is ignored)
  managementKey: string;
  lemKey: string;
  bpKey: string;
  bpHmacKey: string;
  eventsUser: string;
  eventsPass: string;
  webhookUser: string;
  webhookPass: string;
  reportApiKey: string;
  reportUser: string;
  reportPass: string;
}

// Anything that is not exactly 'live' (case and whitespace tolerant) is 'test'.
export function normalizeAdyenEnv(v: unknown): AdyenEnv {
  return String(v ?? '').trim().toLowerCase() === 'live' ? 'live' : 'test';
}

// The environment stamped on a merchant_adyen_accounts row. Missing row,
// missing column (migration pending) or any other value all mean 'test'.
// Callers that already hold the row (store id, POIID, merchantAccountCode
// lookups) select `environment` alongside the rest and use this.
export function adyenEnvFromRow(row: { environment?: unknown } | null | undefined): AdyenEnv {
  return normalizeAdyenEnv(row?.environment);
}

// ── Region ───────────────────────────────────────────────────────────────────
// Region codes are 'UK' and 'US'. Legacy rows say 'EU' (the foundation
// migration's default) and read as 'UK'; country and currency style inputs
// are accepted too so a row, a location or a currency can all feed this.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
const US_CODES = new Set(['US', 'USA', 'USD']);
const UK_CODES = new Set(['UK', 'GB', 'GBR', 'GBP', 'EU']);

// A region from ONE value, or null when the value says nothing.
export function parseAdyenRegion(value: unknown): AdyenRegion | null {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v) return null;
  if (US_CODES.has(v)) return 'US';
  if (UK_CODES.has(v)) return 'UK';
  return null;
}

// normaliseAdyenRegion(value, currency): the stored region first ('EU', 'GB'
// and 'GBP' style inputs read as 'UK'; 'US' and 'USD' as 'US'); anything
// unknown falls back by currency (USD => US); else UK.
export function normaliseAdyenRegion(value: unknown, currency?: unknown): AdyenRegion {
  return parseAdyenRegion(value) ?? parseAdyenRegion(currency) ?? 'UK';
}
export const normalizeAdyenRegion = normaliseAdyenRegion;

// The region for a merchant_adyen_accounts row, with the platform location
// (its currency) as the fallback when the row is missing or says nothing.
export function adyenRegionFromRow(row: { region?: unknown } | null | undefined, location?: { currency?: unknown } | null): AdyenRegion {
  return normaliseAdyenRegion(row?.region, location?.currency);
}

// The Adyen Drop-in / Components `environment` option for a venue.
export function dropinEnvironmentFor(env: unknown, region: unknown): AdyenDropinEnvironment {
  if (normalizeAdyenEnv(env) !== 'live') return 'test';
  return normaliseAdyenRegion(region) === 'US' ? 'live-us' : 'live';
}

// ── Secret names ─────────────────────────────────────────────────────────────
// adyenSecretName: the CANONICAL name for a field, the one shown in messages
// and in `missing`. Live names carry the region (ADYEN_LIVE_UK_API_KEY); the
// test set is the unprefixed names in use today whatever the region.
export function adyenSecretName(env: AdyenEnv | string, field: AdyenSecretField, region: AdyenRegion | string = 'UK'): string {
  const suffix = ADYEN_SECRET_SUFFIXES[field];
  if (!suffix) throw new Error(`adyenSecretName: unknown field ${String(field)}`);
  if (normalizeAdyenEnv(env) !== 'live') return `ADYEN_${suffix}`;
  return `ADYEN_LIVE_${normaliseAdyenRegion(region)}_${suffix}`;
}

// adyenSecretNames: every name read for a field, in read order (the first
// non blank value wins).
//   test UK   [ADYEN_X]
//   test US   [ADYEN_TEST_US_X, ADYEN_X]
//   live UK   [ADYEN_LIVE_UK_X, ADYEN_LIVE_X]
//   live US   [ADYEN_LIVE_US_X]
export function adyenSecretNames(env: AdyenEnv | string, field: AdyenSecretField, region: AdyenRegion | string = 'UK'): string[] {
  const suffix = ADYEN_SECRET_SUFFIXES[field];
  if (!suffix) throw new Error(`adyenSecretNames: unknown field ${String(field)}`);
  const r = normaliseAdyenRegion(region);
  if (normalizeAdyenEnv(env) !== 'live') {
    return r === 'US' ? [`ADYEN_TEST_US_${suffix}`, `ADYEN_${suffix}`] : [`ADYEN_${suffix}`];
  }
  return r === 'UK' ? [`ADYEN_LIVE_UK_${suffix}`, `ADYEN_LIVE_${suffix}`] : [`ADYEN_LIVE_US_${suffix}`];
}

// The live Checkout URL prefix: canonical name and read order per region.
export function adyenLivePrefixName(region: AdyenRegion | string = 'UK'): string {
  return `ADYEN_LIVE_${normaliseAdyenRegion(region)}_PREFIX`;
}
export function adyenLivePrefixNames(region: AdyenRegion | string = 'UK'): string[] {
  return normaliseAdyenRegion(region) === 'UK'
    ? [adyenLivePrefixName('UK'), ADYEN_LIVE_PREFIX_NAME]
    : [adyenLivePrefixName('US')];
}

// Checkout v72 live host carries the per company (per region) prefix. The
// bare https://checkout-live.adyen.com host is WRONG for live and must not be used.
export function liveCheckoutBase(prefix: string): string {
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/v72`;
}

const trimSlash = (s: string): string => String(s).replace(/\/+$/, '');

// The classic live Terminal API host for a region. Live hosts are REGIONAL
// (docs/adyen/research/adyen-in-person.md: terminal-api-live for the EU data
// centre, which is where UK venues live, then terminal-api-live-us, -au,
// -apse, -nea). Accepts 'UK' | 'US' as well as the lower case Adyen suffixes.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function liveTerminalApiBase(region: AdyenRegion | string = 'UK'): string {
  const r = String(region ?? '').trim().toLowerCase();
  if (!r || r === 'uk' || r === 'eu' || r === 'gb') return 'https://terminal-api-live.adyen.com';
  return `https://terminal-api-live-${r}.adyen.com`;
}

type SecretReader = (name: string) => string | undefined | null;

// resolveAdyenConfig(env, get, opts): the PURE resolver, identical to the JS
// mirror. `get` is the secret reader (Deno.env.get in production, a map in
// tests). opts.region picks the region set (default 'UK', 'EU' reads as UK);
// opts.secretEnv picks which SECRET SET to read (default = env); only the
// mirror tests use it. Never throws.
export function resolveAdyenConfig(
  env: AdyenEnv | string | null | undefined,
  get: SecretReader,
  opts: { region?: AdyenRegion | string | null; secretEnv?: AdyenEnv } = {},
): AdyenConfig {
  const e = normalizeAdyenEnv(env);
  const live = e === 'live';
  const region = normaliseAdyenRegion(opts.region);
  const secretEnv = normalizeAdyenEnv(opts.secretEnv ?? e);
  const first = (names: string[]): string => {
    for (const n of names) {
      const v = get(n);
      const s = v == null ? '' : String(v).trim();
      if (s) return s;
    }
    return '';
  };
  const read = (field: AdyenSecretField, set: AdyenEnv = secretEnv): string => first(adyenSecretNames(set, field, region));
  const prefix = live ? first(adyenLivePrefixNames(region)) : '';
  const apiKey = read('apiKey');
  const merchantAccount = read('merchantAccount');
  const orApiKey = (field: AdyenSecretField): string => read(field) || apiKey;
  const orTest = (field: AdyenSecretField): string => read(field) || read(field, 'test');
  const override = (field: AdyenSecretField): string => { const v = read(field); return v ? trimSlash(v) : ''; };
  const defaults = ADYEN_DEFAULT_BASES[e];

  const missing: string[] = [];
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
    deviceBaseOverride: !!override('deviceBase'),
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

const envGet: SecretReader = (name: string): string | undefined => Deno.env.get(name);

// The per venue config for one environment AND region, read from Deno.env
// NOW. Takes the { env, region } object adyenEnvForLocation returns, or
// (env, region) as two arguments. adyenConfig(env) alone is the UK set, so
// every existing call keeps its meaning.
export function adyenConfig(env: AdyenEnv | AdyenTarget | string, region?: AdyenRegion | string | null): AdyenConfig {
  if (env && typeof env === 'object') {
    return resolveAdyenConfig(env.env, envGet, { region: normaliseAdyenRegion(region ?? env.region) });
  }
  return resolveAdyenConfig(env, envGet, { region: normaliseAdyenRegion(region) });
}

// The message a caller returns when a venue's config cannot be used: the
// exact fail closed text for live, naming the missing secret NAMES for the
// venue's region (never values); today's soft wording for test.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function adyenNotConfiguredMessage(cfg: Pick<AdyenConfig, 'live' | 'missing' | 'region'> | null | undefined): string {
  if (!cfg || !cfg.live) return `Adyen not configured, set ${adyenSecretName('test', 'apiKey')}`;
  const names = Array.isArray(cfg.missing) ? cfg.missing.filter(Boolean) : [];
  const region = cfg.region ? ` (${cfg.region})` : '';
  return names.length ? `${ADYEN_LIVE_FAIL_CLOSED}${region}: set ${names.join(', ')}` : `${ADYEN_LIVE_FAIL_CLOSED}${region}`;
}

// Fail closed for LIVE only. A test config with no key keeps today's soft
// behaviour (callers check cfg.configured and Adyen 401s). The message starts
// with ADYEN_LIVE_FAIL_CLOSED and names the missing secrets for the region.
export function assertAdyenConfigured(cfg: AdyenConfig): AdyenConfig {
  if (cfg && cfg.live && !cfg.configured) {
    const err: any = new Error(adyenNotConfiguredMessage(cfg));
    err.code = 'ADYEN_LIVE_NOT_CONFIGURED';
    err.region = cfg.region;
    err.missing = Array.isArray(cfg.missing) ? cfg.missing.slice() : [];
    throw err;
  }
  return cfg;
}

// The live regions whose set is usable (api key, prefix and merchant
// account all present), UK then US. PURE form plus the Deno.env reader.
export function resolveLiveRegionsConfigured(get: SecretReader): AdyenRegion[] {
  return ADYEN_REGIONS.filter((region) => resolveAdyenConfig('live', get, { region }).configured);
}
export function liveRegionsConfigured(): AdyenRegion[] {
  return resolveLiveRegionsConfigured(envGet);
}

// Webhook HMAC key candidates for one notification, UK then US. A live
// notification cannot say which account signed it before it is verified, so
// the receiver tries every configured live region key and records the one
// that matched; a test notification uses the test key (plus the optional US
// test override when it differs). `field` picks the standard key ('hmacKey',
// adyen-webhook and adyen-terminal-events) or the balance platform key
// ('bpHmacKey', adyen-bp-webhook). Blank keys are left out.
export interface WebhookKeyCandidate { region: AdyenRegion; hmacKey: string }
export function resolveWebhookKeys(live: boolean, get: SecretReader, field: 'hmacKey' | 'bpHmacKey' = 'hmacKey'): WebhookKeyCandidate[] {
  const out: WebhookKeyCandidate[] = [];
  const env: AdyenEnv = live ? 'live' : 'test';
  for (const region of ADYEN_REGIONS) {
    const key = resolveAdyenConfig(env, get, { region })[field] || '';
    if (!key) continue;
    if (!live && out.some((c) => c.hmacKey === key)) continue;   // the one test account, no US override
    out.push({ region, hmacKey: key });
  }
  return out;
}
export function webhookKeysFor(live: boolean, field: 'hmacKey' | 'bpHmacKey' = 'hmacKey'): WebhookKeyCandidate[] {
  return resolveWebhookKeys(live, envGet, field);
}

// Basic auth pairs a webhook or terminal events receiver accepts: on live,
// any configured region pair (UK then US), then the test pair as the
// fallback; on test, the test pair. `kind` is 'webhook' | 'events'.
export interface WebhookAuthPair { region: AdyenRegion; user: string; pass: string }
export function resolveWebhookAuthPairs(live: boolean, get: SecretReader, kind: 'webhook' | 'events' = 'webhook'): WebhookAuthPair[] {
  const userField: AdyenSecretField = kind === 'events' ? 'eventsUser' : 'webhookUser';
  const passField: AdyenSecretField = kind === 'events' ? 'eventsPass' : 'webhookPass';
  const out: WebhookAuthPair[] = [];
  const push = (region: AdyenRegion, cfg: AdyenConfig) => {
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
export function webhookAuthPairsFor(live: boolean, kind: 'webhook' | 'events' = 'webhook'): WebhookAuthPair[] {
  return resolveWebhookAuthPairs(live, envGet, kind);
}

// ADYEN_ENV: the fallback ONLY when a request cannot be tied to a venue row.
export function adyenFallbackEnv(): AdyenEnv {
  return normalizeAdyenEnv(Deno.env.get('ADYEN_ENV'));
}
// The region when a request cannot be tied to a venue row: UK.
export function adyenFallbackRegion(): AdyenRegion {
  return 'UK';
}

// Postgres refuses a region the OLD check constraint does not know ('UK'
// before ADYEN_REGION_MIGRATION is run). set_region and every row create
// catch this and answer with the migration's name instead of a bare
// constraint error. KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function isAdyenRegionCheckError(err: any): boolean {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '') + ' ' + String(err?.details ?? '');
  return /merchant_adyen_accounts_region_check/i.test(msg) || (code === '23514' && /region/i.test(msg));
}
export function adyenRegionMigrationMessage(): string {
  return `The database still only accepts the old region codes. Run ${ADYEN_REGION_MIGRATION} on the platform project, then try again.`;
}

// ── Row writes that may CREATE the venue's account row ───────────────────────
// A merchant_adyen_accounts upsert that only carries the columns it changes
// CREATES a missing row with the database DEFAULT region ('EU' today, 'UK'
// after ADYEN_REGION_MIGRATION). For a US venue, whose region was resolved by
// currency while it had no row, that silently flipped every later request to
// the UK set (8 Sep 2026: onboarding's first stamp, the rate card save). So a
// create stamps the RESOLVED region; an existing row keeps its own unless the
// caller names one; a named region is normalised ('EU' reads as UK) and an
// unknown one is dropped. Never mutates the input.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function adyenAccountRowPatch<T extends Record<string, unknown>>(
  patch: T,
  existingRow: { region?: unknown } | null | undefined,
  region: AdyenRegion | string | null | undefined,
): T & { region?: AdyenRegion } {
  const out: Record<string, unknown> = { ...patch };
  const named = parseAdyenRegion(out.region);
  if (named) { out.region = named; return out as T & { region?: AdyenRegion }; }
  delete out.region;
  if (!existingRow) out.region = normaliseAdyenRegion(region);
  return out as T & { region?: AdyenRegion };
}

// May a write the OLD check constraint refused be retried WITHOUT the region
// column? Only a 'UK' write (the old default 'EU' reads as UK everywhere)
// onto a row that already reads as UK, or no row at all. 'US' passes either
// check, so a refused US write is some other problem; and a UK write onto a
// row that says US must not silently keep US, that caller answers with the
// migration instead. KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function adyenRegionRetryWithoutColumn(
  err: unknown,
  patch: { region?: unknown } | null | undefined,
  existingRow: { region?: unknown } | null | undefined,
): boolean {
  if (!isAdyenRegionCheckError(err)) return false;
  if (parseAdyenRegion(patch?.region) !== 'UK') return false;
  if (existingRow && normaliseAdyenRegion(existingRow.region) !== 'UK') return false;
  return true;
}

// The region whose secret set names this merchant account (case insensitive),
// null when neither does. PURE; adyenRegionForMerchantAccount below adds the
// venue rows. KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function resolveRegionByMerchantAccount(merchantAccount: unknown, live: boolean, get: SecretReader): AdyenRegion | null {
  const code = String(merchantAccount ?? '').trim().toLowerCase();
  if (!code) return null;
  for (const region of ADYEN_REGIONS) {
    const mine = resolveAdyenConfig(live ? 'live' : 'test', get, { region }).merchantAccount;
    if (mine && mine.toLowerCase() === code) return region;
  }
  return null;
}

// ── Environment resolution by venue ──────────────────────────────────────────
// environment lives on the venue's merchant_adyen_accounts row (PLATFORM DB).
// While the migration is pending the column does not exist: that select error
// is swallowed ONCE with a warning and the ADYEN_ENV fallback is returned, so
// nothing changes for existing venues. Any OTHER error is thrown: guessing
// 'test' for a live venue would push a real customer's card through the test
// keys and call it paid.
let warnedNoEnvironmentColumn = false;
export function isUnknownColumnError(err: any, column = 'environment'): boolean {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');
  if (code === '42703' || code === 'PGRST204') return true;
  const col = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`column\\b.*\\b${col}\\b.*\\bdoes not exist`, 'i').test(msg)
      || new RegExp(`\\b${col}\\b.*\\bcolumn\\b`, 'i').test(msg);
}

function warnNoEnvironmentColumn(): void {
  if (warnedNoEnvironmentColumn) return;
  warnedNoEnvironmentColumn = true;
  console.warn('[adyen] merchant_adyen_accounts.environment is missing (run 20260907_PLATFORM_adyen_environment.sql); using ADYEN_ENV fallback', adyenFallbackEnv());
}

// The region for a venue: the row's own region when it says something
// ('UK', 'US', or a legacy 'EU'), else the platform location's currency
// (USD => US, else UK). The currency read only happens when the row is
// missing or silent. THROWS on a DB error: never guess.
async function adyenRegionForLocationRow(platformAdmin: any, locationId: string, row: { region?: unknown } | null): Promise<AdyenRegion> {
  const fromRow = parseAdyenRegion(row?.region);
  if (fromRow) return fromRow;
  const { data, error } = await platformAdmin.from('locations').select('currency').eq('id', locationId).maybeSingle();
  if (error) throw new Error(`adyenRegionForLocation: ${error.message ?? String(error)}`);
  return normaliseAdyenRegion(null, data?.currency);
}

// The venue's account row AND its environment AND its region in ONE read.
// `columns` names the extra merchant_adyen_accounts columns the caller wants
// alongside `environment` and `region` (merchant_account, store_id,
// receive_payments_ok, ...). The row is null when the venue has none (env =
// ADYEN_ENV fallback, region by the location's currency). While the
// environment column is missing the read retries without it so callers still
// get their other columns. THROWS on any other DB error: never guess.
export async function adyenAccountForLocation<T extends Record<string, unknown> = Record<string, unknown>>(
  platformAdmin: any,
  locationId: string | null | undefined,
  columns: string[] = [],
): Promise<{ env: AdyenEnv; region: AdyenRegion; row: (T & { environment?: unknown; region?: unknown }) | null }> {
  type Row = T & { environment?: unknown; region?: unknown };
  if (!locationId) return { env: adyenFallbackEnv(), region: adyenFallbackRegion(), row: null };
  const extra = columns.filter((c) => c && c !== 'environment' && c !== 'region');
  const select = (withEnv: boolean) => [...(withEnv ? ['environment'] : []), 'region', ...extra].join(', ');
  let { data, error } = await platformAdmin
    .from('merchant_adyen_accounts').select(select(true)).eq('location_id', locationId).maybeSingle();
  if (error && isUnknownColumnError(error)) {
    warnNoEnvironmentColumn();
    ({ data, error } = await platformAdmin
      .from('merchant_adyen_accounts').select(select(false)).eq('location_id', locationId).maybeSingle());
    if (error) throw new Error(`adyenAccountForLocation: ${error.message ?? String(error)}`);
    const row = (data ?? null) as Row | null;
    return { env: adyenFallbackEnv(), region: await adyenRegionForLocationRow(platformAdmin, locationId, row), row };
  }
  if (error) throw new Error(`adyenAccountForLocation: ${error.message ?? String(error)}`);
  if (!data) {   // no row: the request cannot be tied to a venue row
    return { env: adyenFallbackEnv(), region: await adyenRegionForLocationRow(platformAdmin, locationId, null), row: null };
  }
  const row = data as Row;
  return { env: adyenEnvFromRow(row), region: await adyenRegionForLocationRow(platformAdmin, locationId, row), row };
}

// { env, region } for a venue. Pass the object straight to adyenConfig.
export async function adyenEnvForLocation(platformAdmin: any, locationId: string | null | undefined): Promise<AdyenTarget> {
  const { env, region } = await adyenAccountForLocation(platformAdmin, locationId);
  return { env, region };
}

export async function adyenConfigForLocation(platformAdmin: any, locationId: string | null | undefined): Promise<AdyenConfig> {
  return adyenConfig(await adyenEnvForLocation(platformAdmin, locationId));
}

// upsertAdyenAccountRow: the region aware merchant_adyen_accounts upsert
// (keyed on location_id), for EVERY writer that may create the row
// (adyen-onboard's stamps and save_manual, payments-admin's rate card save).
// Reads the venue's row and resolved region first (one adyenAccountForLocation
// read), stamps the region on a CREATE (adyenAccountRowPatch), and retries a
// 'UK' the OLD check constraint refuses without the column
// (adyenRegionRetryWithoutColumn) with the migration named in `warning`. Any
// other error is returned as is; a read error THROWS. opts.region overrides
// the resolved region for a create (a caller already holding cfg.region
// passes it); opts.select returns those columns in `data`.
export interface AdyenAccountRowWrite {
  data: any;
  error: { message: string; code?: string; details?: string } | null;
  warning: string | null;   // adyenRegionMigrationMessage() when the write had to drop the region
  region: AdyenRegion;      // the region the row reads as after this write
  created: boolean;         // the venue had no row before this write
}
export async function upsertAdyenAccountRow(
  platformAdmin: any,
  patch: Record<string, unknown>,
  opts: { region?: AdyenRegion | string | null; select?: string } = {},
): Promise<AdyenAccountRowWrite> {
  const locationId = String(patch?.location_id ?? '').trim();
  if (!locationId) return { data: null, error: { message: 'upsertAdyenAccountRow: location_id required' }, warning: null, region: 'UK', created: false };
  const { region: resolved, row } = await adyenAccountForLocation(platformAdmin, locationId);
  const p = adyenAccountRowPatch({ ...patch, location_id: locationId }, row, opts.region ?? resolved);
  const region: AdyenRegion = p.region ?? resolved;
  const run = async (x: Record<string, unknown>) => {
    const q = platformAdmin.from('merchant_adyen_accounts').upsert(x, { onConflict: 'location_id' });
    return opts.select ? await q.select(opts.select).maybeSingle() : await q;
  };
  let res = await run(p);
  if (res?.error && adyenRegionRetryWithoutColumn(res.error, p, row)) {
    const { region: _region, ...rest } = p;
    res = await run(rest);
    if (!res?.error) return { data: res?.data ?? null, error: null, warning: adyenRegionMigrationMessage(), region, created: !row };
  }
  return { data: res?.data ?? null, error: res?.error ?? null, warning: null, region, created: !row };
}

// Which account a merchant account NAME belongs to: the region whose secret
// set (live or test) names it, else the one region of the venue rows on that
// environment carrying it (an ambiguous name says nothing). The webhooks use
// this BEFORE verification, only to tell a missing region key from a forgery
// and to name the secret, and AFTER it for a live item with no verified
// region and no venue; nothing is trusted from it. THROWS on a DB error.
export async function adyenRegionForMerchantAccount(platformAdmin: any, merchantAccount: unknown, live = true): Promise<AdyenRegion | null> {
  const bySecrets = resolveRegionByMerchantAccount(merchantAccount, live, envGet);
  if (bySecrets) return bySecrets;
  const code = String(merchantAccount ?? '').trim();
  if (!code || !platformAdmin) return null;
  const env: AdyenEnv = live ? 'live' : 'test';
  const query = (scoped: boolean) => {
    let q = platformAdmin.from('merchant_adyen_accounts').select('region').eq('merchant_account', code);
    if (scoped) q = q.eq('environment', env);
    return q.limit(5);
  };
  let { data, error } = await query(true);
  if (error && isUnknownColumnError(error)) ({ data, error } = await query(false));
  if (error) throw new Error(`adyenRegionForMerchantAccount: ${error.message ?? String(error)}`);
  const regions = new Set<AdyenRegion>((Array.isArray(data) ? data : []).map((r: any) => normaliseAdyenRegion(r?.region)));
  return regions.size === 1 ? [...regions][0] : null;
}

// Callers arrive with EITHER id space (the ops location id the till and the
// public widgets carry, or the platform id). merchant_adyen_accounts is keyed
// on the PLATFORM id, so resolve that first: by ops_location_id, then by id.
// Null ONLY when the platform DB genuinely knows neither id. A DB error
// THROWS: a swallowed error here used to read as "unknown venue", which sent
// a live venue to the ADYEN_ENV fallback (test keys, test host) for as long as
// the caller cached the answer.
export async function platformLocationIdFor(platformAdmin: any, id: string | null | undefined): Promise<string | null> {
  const key = String(id ?? '').trim();
  if (!key) return null;
  const byOps = await platformAdmin.from('locations').select('id').eq('ops_location_id', key).maybeSingle();
  if (byOps?.error) throw new Error(`platformLocationIdFor: ${byOps.error.message ?? String(byOps.error)}`);
  if (byOps?.data?.id) return String(byOps.data.id);
  const byId = await platformAdmin.from('locations').select('id').eq('id', key).maybeSingle();
  if (byId?.error) throw new Error(`platformLocationIdFor: ${byId.error.message ?? String(byId.error)}`);
  if (byId?.data?.id) return String(byId.data.id);
  return null;
}

// The merchant account a venue's Adyen calls go out with (8 Sep 2026).
// merchant_adyen_accounts.merchant_account is preferred over the secret set's
// ADYEN[_LIVE_<REGION>]_MERCHANT_ACCOUNT, because a hand onboarded venue may
// sit under a merchant account the secrets do not name. But the row's name
// was written on ONE environment: a venue flipped to live still carried its
// TEST merchant name (FranPOS_ServOS_TEST) and every live call named it on
// the live host. set_environment now rewrites the column on a flip; this is
// the guard for rows that predate that: a row naming the OTHER environment's
// secret account (same region) falls back to this environment's secret
// account. Anything else on the row is kept verbatim (a real, hand entered
// live merchant name).
// KEEP IN SYNC with src/lib/payments/adyenEnv.js (effectiveMerchantAccount).
export function effectiveMerchantAccount(cfg: AdyenConfig, rowMerchant: unknown, get: SecretReader = envGet): string {
  const row = String(rowMerchant ?? '').trim();
  const mine = String(cfg?.merchantAccount ?? '').trim();
  if (!row) return mine;
  const otherEnv: AdyenEnv = cfg?.live ? 'test' : 'live';
  let other = '';
  for (const name of adyenSecretNames(otherEnv, 'merchantAccount', cfg?.region)) {
    other = String(get(name) ?? '').trim();
    if (other) break;
  }
  if (mine && other && row.toLowerCase() === other.toLowerCase() && row.toLowerCase() !== mine.toLowerCase()) return mine;
  return row;
}

// Merchant account NAME for admin screens: enough to recognise, never the
// whole identifier (per venue status calls are reachable by anonymous
// customers of the online checkout).
export function maskMerchantAccount(name: string | null | undefined): string | null {
  const s = String(name ?? '').trim();
  if (!s) return null;
  if (s.length <= 6) return `${s.slice(0, 1)}${'*'.repeat(Math.max(0, s.length - 1))}`;
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(3, s.length - 7))}${s.slice(-3)}`;
}

// Idempotency-Key for a /payments call: the order reference plus the attempt
// number, so a retransmit of the same attempt replays and a fresh attempt
// gets a fresh key. Adyen caps the header at 64 chars; a reference too long
// to fit is replaced by its SHA-256 hex so two different references can never
// collapse into one key.
export async function paymentIdempotencyKey(reference: string, attempt: number | string | null | undefined): Promise<string> {
  const ref = String(reference ?? '').trim();
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const plain = `pay:${ref}:a${n}`;
  if (plain.length <= 64) return plain;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ref));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const suffix = `:a${n}`;
  return `pay:${hex.slice(0, 64 - 4 - suffix.length)}${suffix}`;   // the attempt suffix always survives
}

// ── Webhook HMAC policy ──────────────────────────────────────────────────────
// What the standard webhook receiver does with one item, given the config the
// notification's own live flag selected. PURE, mirrored in adyenEnv.js.
//   'reject'        live notification and the live HMAC key is not set. The
//                   test key must never verify a live item and a live item
//                   must never be applied unverified, so the receiver answers
//                   503 and Adyen retries once the key exists.
//   'unverifiable'  test with no key, or an item with no signature: recorded
//                   with hmac_valid null (today's soft test behaviour).
//   'verify'        run verifyNotificationItem with cfg.hmacKey.
export type WebhookHmacVerdict = 'reject' | 'unverifiable' | 'verify';
export function webhookHmacPolicy(cfg: Pick<AdyenConfig, 'live' | 'hmacKey'>, hasSignature: boolean): WebhookHmacVerdict {
  if (cfg.live && !cfg.hmacKey) return 'reject';
  if (!cfg.hmacKey || !hasSignature) return 'unverifiable';
  return 'verify';
}

// ── Endpoint bases ───────────────────────────────────────────────────────────
// Always the VENUE'S hosts. Live checkout fails closed without the prefix or
// key. Checkout v72: live REQUIRES the per-company URL prefix.
export function checkoutBase(cfg: AdyenConfig): string {
  assertAdyenConfigured(cfg);
  return cfg.checkoutBase;
}
// Management v3: NO prefix.
export function managementBase(cfg: AdyenConfig): string {
  return cfg.managementBase;
}
// Legal Entity Management v4 (KYC host). Verify base on first key-holding call.
export function lemBase(cfg: AdyenConfig): string {
  return cfg.lemBase;
}
// Balance Platform Configuration v2. Verify base on first key-holding call.
export function balancePlatformBase(cfg: AdyenConfig): string {
  return cfg.balancePlatformBase;
}

// Cloud Terminal API endpoint for one reader.
// CLASSIC cloud Terminal API hosts (terminal-api-*) take the bare /sync
// path, the POIID rides in the nexo MessageHeader, not the URL. The newer
// device-api hosts take the per merchant, per device path and are
// account-gated (14 Aug: 00_403 with every role ticked), so
// ADYEN_DEVICE_BASE=https://terminal-api-test.adyen.com is the reliable
// default until Adyen enables device-api on the account.
export function terminalEndpointFor(deviceBase: string, merchantAccount: string, poiid: string, mode: 'sync' | 'async'): string {
  const base = trimSlash(deviceBase);
  if (/terminal-api/.test(base)) return `${base}/${mode}`;
  return `${base}/v1/merchants/${encodeURIComponent(merchantAccount)}/devices/${encodeURIComponent(poiid)}/${mode}`;
}

// The reader endpoint for one venue config. An explicit <SET>_DEVICE_BASE is
// authoritative (region ignored). Otherwise live derives the REGIONAL classic
// host from the region (an explicit argument wins, else the config's own
// region), and test keeps the test default. liveTerminalApiBase sits with the
// resolver above. KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function terminalEndpointForConfig(cfg: Pick<AdyenConfig, 'live' | 'deviceBase' | 'deviceBaseOverride'> & { region?: AdyenRegion | string }, merchantAccount: string, poiid: string, mode: 'sync' | 'async', region?: AdyenRegion | string | null): string {
  const r = region ?? cfg.region ?? 'UK';
  const base = (cfg.live && !cfg.deviceBaseOverride) ? liveTerminalApiBase(r) : cfg.deviceBase;
  return terminalEndpointFor(base, merchantAccount, poiid, mode);
}

// Every reader call site passes the venue's config and its region ('UK' |
// 'US', or the older 'eu' | 'us' spellings; null means the config's region).
export function terminalEndpoint(merchantAccount: string, poiid: string, mode: 'sync' | 'async', region: AdyenRegion | string | null | undefined, cfg: AdyenConfig): string {
  return terminalEndpointForConfig(cfg, merchantAccount, poiid, mode, region);
}

export interface AdyenResult<T = any> { ok: boolean; status: number; data: T; }

export interface AdyenFetchOpts {
  idempotencyKey?: string;
  timeoutMs?: number;
  cfg: AdyenConfig;    // the venue's config: its api key, fail closed on live. REQUIRED.
  apiKey?: string;     // explicit key override, e.g. cfg.managementKey or cfg.lemKey
}

export async function adyenFetch<T = any>(method: string, url: string, body: unknown, opts: AdyenFetchOpts): Promise<AdyenResult<T>> {
  if (!opts?.cfg) throw new Error('adyenFetch: a venue config is required');
  assertAdyenConfigured(opts.cfg);              // live without keys: throw, never test keys
  const apiKey = opts.apiKey || opts.cfg.apiKey;
  const headers: Record<string, string> = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const ctrl = new AbortController();
  // Terminal API /sync holds the connection for the whole cardholder interaction,
  // callers pass ~165s there; everything else defaults to 30s.
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } finally { clearTimeout(t); }
}

// ── Webhook HMAC — TWO different schemes (docs/adyen/research/adyen-webhooks-reporting.md)
//
// (1) STANDARD webhooks: per-NotificationRequestItem signature. The signing
//     string is built from FIELDS (not the raw body), signed with the HMAC key
//     decoded from HEX, output base64, carried in additionalData.hmacSignature:
//     pspReference:originalReference:merchantAccountCode:merchantReference:
//     value:currency:eventCode:success
export function hmacSigningString(item: any): string {
  const amount = item?.amount ?? {};
  return [
    item?.pspReference ?? '',
    item?.originalReference ?? '',
    item?.merchantAccountCode ?? '',
    item?.merchantReference ?? '',
    amount?.value ?? '',
    amount?.currency ?? '',
    item?.eventCode ?? '',
    item?.success ?? '',
  ].join(':');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signNotificationItem(item: any, hmacHexKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(hmacHexKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(hmacSigningString(item)));
  return b64(sig);
}

export async function verifyNotificationItem(item: any, hmacHexKey: string): Promise<boolean> {
  const given = item?.additionalData?.hmacSignature ?? '';
  if (!hmacHexKey || !given) return false;
  try { return constantTimeEq(await signNotificationItem(item, hmacHexKey), given); }
  catch { return false; }
}

// (2) BALANCE PLATFORM webhooks: classic raw-body HMAC-SHA256 (base64) in the
//     HmacSignature header.
//
// KEY ENCODING (8 Sep 2026): the Customer Area issues the key as a HEX string
// and Adyen signs with the key DECODED from hex (adyen-node-api-library
// hmacValidator.validateHMACSignature: createHmac('sha256', Buffer.from(key,
// 'hex'))). This used to import the hex text as the raw key bytes, so no real
// Balance Platform signature could ever verify. A hex shaped key is now tried
// decoded first, and as raw text second (belt and braces: the docs have been
// wrong before); a key that is not hex shaped is used as text.
export async function verifyRawBodyHmac(rawBody: string, headerSig: string, key: string): Promise<boolean> {
  if (!key || !headerSig) return false;
  const k = key.trim();
  const candidates: Uint8Array[] = [];
  if (/^[0-9a-f]+$/i.test(k) && k.length % 2 === 0) candidates.push(hexToBytes(k));
  candidates.push(new TextEncoder().encode(k));
  for (const bytes of candidates) {
    try {
      const ck = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = b64(await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(rawBody)));
      if (constantTimeEq(sig, headerSig)) return true;
    } catch { /* try the next encoding */ }
  }
  return false;
}

// ── Terminal API (nexo 3.0) message builders ─────────────────────────────────
// docs/adyen/research/adyen-in-person.md. POIID format: {Model}-{Serial},
// e.g. AMS1-000168243358252. ServiceID: 1-10 alphanumerics, unique per POIID
// within 48h. Amounts are DECIMAL MAJOR units.

export const minorToMajor = (minor: number): number => Math.round(minor) / 100;

// On-screen MENU on the terminal (nexo Input / GetMenuEntry) — Pay at Table's
// open-table picker. The response carries the 1-based selected entry in
// InputResponse.Input.MenuEntryNumber.
export function buildMenuInputRequest(o: { poiid: string; saleId: string; serviceId: string; title: string; entries: string[]; maxInputTime?: number }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Input', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      InputRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          // Hardware-verified 15 Aug: OutputContent.OutputFormat must be 'Text'
          // ("value 'MenuEntry': Value not supported") — the menu itself rides
          // the sibling MenuEntry array.
          OutputContent: {
            OutputFormat: 'Text',
            PredefinedContent: { ReferenceID: 'MenuButtons' },
            OutputText: [{ Text: o.title }],
          },
          MenuEntry: o.entries.map((text) => ({
            OutputFormat: 'Text',
            OutputText: [{ Text: text }],
          })),
        },
        InputData: {
          Device: 'CustomerInput', InfoQualify: 'Input', InputCommand: 'GetMenuEntry',
          MaxInputTime: o.maxInputTime ?? 60,
        },
      },
    },
  };
}

// NON-BLOCKING text on the reader (nexo Display). Unlike an InputRequest — which
// renders a widget and holds the /sync call open until someone answers or
// MaxInputTime expires — this paints and returns, so it can be fired and
// forgotten while the responder is still gathering the bill. That preamble is
// several serial network legs, during which the reader showed its HOME screen
// and staff had no idea anything was happening (Peter, 15 Aug: "the reader looks
// like nothing is happening which will cause confusion").
// Envelope mirrors the proven buildMenuInputRequest DisplayOutput exactly, minus
// the MenuEntry array and InputData. The shape is NOT hardware-verified on this
// fleet — every call site must ignore failures, so a rejection costs nothing but
// the dead air we already have.
export function buildDisplayRequest(o: { poiid: string; saleId: string; serviceId: string; text: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      DisplayRequest: {
        // HARDWARE-VERIFIED 19 Aug: this fleet renders Display messages ONLY in
        // the nexo ARRAY form — the object form (Adyen's docs sample) returns an
        // empty DisplayResponse and paints nothing, which is why the
        // 'Loading tables…' status pushes never appeared during pay-at-table.
        DisplayOutput: [{
          Device: 'CustomerDisplay', InfoQualify: 'Status',
          OutputContent: { OutputFormat: 'Text', OutputText: [{ Text: o.text }] },
        }],
      },
    },
  };
}

// FULL-SCREEN IMAGE on the terminal (nexo Display / MessageRef+Image) — the
// branding/"screensaver" push. Docs (display-image): OutputFormat 'MessageRef',
// PredefinedContent.ReferenceID 'Image', base64 image in OutputText. With no
// MinimumDisplayTime the image HOLDS until the next request — a payment, another
// image, or the Idle push below. NOT yet hardware-verified on this fleet (which
// has contradicted the docs three times); that is what admin test_image is for.
// NOTE the contrast with buildDisplayRequest above (OutputFormat 'Text', no
// PredefinedContent, unverified): if Image works and Text does not, that is the
// answer to why "Loading tables…" never showed.
export function buildDisplayImageRequest(o: { poiid: string; saleId: string; serviceId: string; imageB64: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      DisplayRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          OutputContent: {
            OutputFormat: 'MessageRef',
            PredefinedContent: { ReferenceID: 'Image' },
            OutputText: [{ Text: o.imageB64 }],
          },
        },
      },
    },
  };
}

// Force the terminal BACK to its standby screen (ReferenceID 'Idle') — docs say
// this works "regardless of the terminal model".
export function buildDisplayIdleRequest(o: { poiid: string; saleId: string; serviceId: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Display', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      DisplayRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          OutputContent: { OutputFormat: 'MessageRef', PredefinedContent: { ReferenceID: 'Idle' } },
        },
      },
    },
  };
}

export function parseMenuInputResponse(data: any): { selected: number | null; result: string } {
  // Docs + hardware, 15 Aug: MenuEntryNumber is a SELECTION-MASK array — the
  // chosen option's position holds 1, every other item 0 ("if the third option
  // is selected, the third item is 1"). Tap row 3 → [0,0,1]. The single-entry
  // case [1] is the same rule, which is why only that probe ever "worked".
  const r = data?.SaleToPOIResponse?.InputResponse;
  const result = r?.InputResult?.Response?.Result ?? r?.Response?.Result ?? 'Failure';
  const raw = r?.InputResult?.Input?.MenuEntryNumber ?? r?.Input?.MenuEntryNumber;
  let sel: number | null = null;
  if (Array.isArray(raw)) {
    const i = raw.findIndex((v: unknown) => Number(v) === 1);
    if (i >= 0) sel = i + 1;                          // 1-based position of the 1
  } else if (Number(raw) >= 1) {
    sel = Number(raw);                                // defensive: plain index form
  }
  return { selected: result === 'Success' && sel != null ? sel : null, result: String(result) };
}

// On-screen AMOUNT ENTRY on the terminal (nexo Input / DecimalString) — the
// split-payment "enter amount" step. Docs (point-of-sale/shopper-engagement/
// shopper-input/amount): PredefinedContent ReferenceID 'GetAmount' renders the
// currency keypad; entry populates RIGHT-TO-LEFT (typing 3,6,5,9 shows 0.03 →
// 0.36 → 3.65 → 36.59); the entered amount returns as a decimal STRING in
// InputResult.Input.DigitInput ("36.59"). Cancel/timeout → Result 'Failure'.
export function buildAmountInputRequest(o: { poiid: string; saleId: string; serviceId: string; title: string; maxInputTime?: number }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Device', MessageCategory: 'Input', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      InputRequest: {
        DisplayOutput: {
          Device: 'CustomerDisplay', InfoQualify: 'Display',
          OutputContent: {
            OutputFormat: 'Text',
            PredefinedContent: { ReferenceID: 'GetAmount' },
            OutputText: [{ Text: o.title }],
          },
        },
        InputData: {
          Device: 'CustomerInput', InfoQualify: 'Input', InputCommand: 'DecimalString',
          MaxInputTime: o.maxInputTime ?? 45,
          DefaultInputString: '0.00',
        },
      },
    },
  };
}

export function parseAmountInputResponse(data: any): { amountMinor: number | null; result: string } {
  const r = data?.SaleToPOIResponse?.InputResponse;
  const result = r?.InputResult?.Response?.Result ?? r?.Response?.Result ?? 'Failure';
  // HARDWARE-VERIFIED 15 Aug (AMS1): a DecimalString answer comes back as
  // `TextInput`, NOT the `DigitInput` the docs show — £10.00 typed on the
  // reader arrived as Input.TextInput "10.00" and the DigitInput-only parser
  // read null, so the flow bailed silently to the home screen. Accept both,
  // plus DecimalString, and take whichever the firmware actually sends.
  const inp = r?.InputResult?.Input ?? r?.Input ?? {};
  const raw = inp.TextInput ?? inp.DigitInput ?? inp.DecimalString ?? inp.DigitString;
  let minor: number | null = null;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) minor = Math.round(n * 100);
  }
  return { amountMinor: result === 'Success' ? minor : null, result: String(result) };
}

export function newServiceId(): string {
  // 10 RANDOM base36 chars (~51 bits). Three jobs in one review finding hang off
  // this: (1) uniqueness within Adyen's 48h/POIID window — randomness beats the
  // old time+per-isolate-counter scheme, which collided across fresh isolates in
  // the same second; (2) idx_tj_nexo_service enforces it DB-side (a collision
  // fails the CAS stamp and the initiator re-mints); (3) it doubles as the
  // report_local capability token — only the device that received prepare_local's
  // response can present it, so a forged report from another device at the venue
  // can't bind to the job.
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return out;
}

export interface NexoPaymentOpts {
  poiid: string;
  saleId: string;              // our POS component id (till/kiosk id)
  serviceId: string;           // newServiceId(); PERSIST it — status recovery needs it
  transactionId: string;       // our reference → shows as merchantReference in CA/reports
  amountMinor: number;
  currency: string;            // 'GBP' | 'USD' | ...
  tipMinor?: number;           // pre-agreed tip (tipping-from-POS mode)
  askGratuity?: boolean;       // terminal prompts for tip (tipping-from-terminal mode)
  preAuth?: boolean;           // bar tabs: authorisation only, capture later
  manualCapture?: boolean;     // v5.7.5 tip-on-receipt: suppress auto-capture; we capture via Checkout API
  allowPartial?: boolean;      // partial approvals (gift/prepaid top-ups)
  merchantAccount?: string;
  storeId?: string;            // AfP: route to the venue's store
}

export function buildPaymentRequest(o: NexoPaymentOpts): any {
  const saleToAcquirer: string[] = [];
  if (o.preAuth) saleToAcquirer.push('authorisationType=PreAuth');
  // v5.7.5 tip-on-receipt: manualCapture=true stops captureDelayHours auto-capture,
  // so the capture is OURS (tip_capture / webhook kick / adyen-capture-sweep).
  // Always paired with authorisationType=PreAuth by the caller.
  if (o.manualCapture) saleToAcquirer.push('manualCapture=true');
  if (o.allowPartial) saleToAcquirer.push('tenderOption=AllowPartialAuthorisation');
  if (o.askGratuity) saleToAcquirer.push('tenderOption=AskGratuity');
  if (o.storeId) saleToAcquirer.push(`store=${o.storeId}`);
  const amounts: any = { Currency: o.currency, RequestedAmount: minorToMajor(o.amountMinor) };
  if (o.tipMinor && o.tipMinor > 0) amounts.TipAmount = minorToMajor(o.tipMinor);
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Payment', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      PaymentRequest: {
        SaleData: {
          SaleTransactionID: { TransactionID: o.transactionId, TimeStamp: new Date().toISOString() },
          ...(saleToAcquirer.length ? { SaleToAcquirerData: saleToAcquirer.join('&') } : {}),
        },
        PaymentTransaction: { AmountsReq: amounts },
      },
    },
  };
}

export function buildTransactionStatusRequest(o: { poiid: string; saleId: string; serviceId: string; origServiceId: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'TransactionStatus', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      TransactionStatusRequest: {
        ReceiptReprintFlag: false,
        MessageReference: { SaleID: o.saleId, ServiceID: o.origServiceId, MessageCategory: 'Payment' },
      },
    },
  };
}

export function buildAbortRequest(o: { poiid: string; saleId: string; serviceId: string; origServiceId: string; reason?: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Abort', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      AbortRequest: {
        AbortReason: o.reason ?? 'MerchantAbort',
        MessageReference: { SaleID: o.saleId, ServiceID: o.origServiceId, MessageCategory: 'Payment' },
      },
    },
  };
}

// Referenced refund/reversal on-terminal (full reversal of a same-day auth).
export function buildReversalRequest(o: { poiid: string; saleId: string; serviceId: string; origPoiTransactionId: string; origTimestamp: string; reason?: string }): any {
  return {
    SaleToPOIRequest: {
      MessageHeader: {
        ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'Reversal', MessageType: 'Request',
        ServiceID: o.serviceId, SaleID: o.saleId, POIID: o.poiid,
      },
      ReversalRequest: {
        ReversalReason: o.reason ?? 'MerchantCancel',
        OriginalPOITransaction: {
          POITransactionID: { TransactionID: o.origPoiTransactionId, TimeStamp: o.origTimestamp },
        },
      },
    },
  };
}

// ── Response parsing ─────────────────────────────────────────────────────────
// additionalResponse arrives as base64 JSON, plain JSON, or a URL-encoded query
// string depending on terminal config — parse all three tolerantly.
export function parseAdditionalResponse(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, string>;
  const s = String(raw);
  try { return JSON.parse(s); } catch { /* not plain JSON */ }
  try {
    const decoded = atob(s);
    try { return JSON.parse(decoded); } catch { /* not b64 JSON */ }
  } catch { /* not base64 */ }
  const out: Record<string, string> = {};
  for (const part of s.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

// Extract everything the POS needs from a nexo PaymentResponse: result, ids,
// and the EMV receipt block (same shape src/lib/cardReceipt.js renders today).
export function parsePaymentResponse(body: any): {
  result: 'Success' | 'Partial' | 'Failure' | 'Unknown';
  serviceId: string | null;   // MessageHeader.ServiceID — binds a response to ITS attempt
  poiid: string | null;       // MessageHeader.POIID — binds it to ITS terminal
  errorCondition: string | null;
  refusalReason: string | null;    // Adyen's own text, e.g. 'Not enough balance'
  refusalCode: string | null;      // Adyen's raw refusal code when present
  pspReference: string | null;
  poiTransactionId: string | null;
  poiTimestamp: string | null;
  authorizedMinor: number | null;
  tipMinor: number | null;
  card: { brand: string | null; last4: string | null; authCode: string | null; aid: string | null; applicationName: string | null; cvm: string | null; readMethod: string | null };
  additional: Record<string, string>;
} {
  const resp = body?.SaleToPOIResponse?.PaymentResponse ?? body?.PaymentResponse ?? {};
  const header = body?.SaleToPOIResponse?.MessageHeader ?? {};
  const response = resp?.Response ?? {};
  const result = (response?.Result === 'Success' || response?.Result === 'Partial' || response?.Result === 'Failure')
    ? response.Result : 'Unknown';
  const additional = parseAdditionalResponse(response?.AdditionalResponse);
  const pRes = resp?.PaymentResult ?? {};
  const amounts = pRes?.AmountsResp ?? {};
  const poiTx = resp?.POIData?.POITransactionID ?? {};
  const instrument = pRes?.PaymentInstrumentData?.CardData ?? {};
  const toMinor = (v: unknown) => (v === undefined || v === null || isNaN(Number(v))) ? null : Math.round(Number(v) * 100);
  const maskedPan: string = instrument?.MaskedPan ?? additional['cardSummary'] ?? '';
  const last4 = maskedPan ? maskedPan.replace(/[^0-9]/g, '').slice(-4) || null : (additional['cardSummary'] ?? null);
  return {
    result,
    serviceId: header?.ServiceID ?? null,
    poiid: header?.POIID ?? null,
    // v5.7.82: Adyen's OWN refusal reason wins. ErrorCondition is a coarse nexo
    // bucket ('Refusal') that cannot tell "wrong PIN" from "no balance" from
    // "terminal unreachable", so preferring it threw away the only text that
    // tells the operator what to do next. Both are kept: the reason drives what
    // staff are told, the condition still drives control flow.
    errorCondition: response?.ErrorCondition ?? additional['refusalReason'] ?? null,
    refusalReason: additional['refusalReason'] ?? additional['message'] ?? null,
    refusalCode: additional['refusalReasonRaw'] ?? additional['refusalReasonCode'] ?? null,
    pspReference: additional['pspReference'] ?? null,
    poiTransactionId: poiTx?.TransactionID ?? null,
    poiTimestamp: poiTx?.TimeStamp ?? null,
    authorizedMinor: toMinor(amounts?.AuthorizedAmount),
    // v5.7.90: a tip added ON the terminal does not always arrive in
    // AmountsResp.TipAmount. Adyen also reports it in additionalData as
    // posAmountGratuityValue, and which one you get depends on the terminal and
    // the tipping mode. Reading only the first meant the authorised amount came
    // back higher than we asked for with nothing to explain the difference, so
    // the leg was PARKED for a manager: the customer had paid, tip included, and
    // the check would not close.
    //
    // The units differ and that matters. AmountsResp is in MAJOR units (2.50),
    // additionalData gratuity is already MINOR (250). Treating one as the other
    // is a hundredfold error on a live tip, so they are converted separately.
    tipMinor: toMinor(amounts?.TipAmount)
      ?? (Number.isFinite(Number(additional['posAmountGratuityValue']))
            ? Math.round(Number(additional['posAmountGratuityValue']))
            : null)
      ?? toMinor(additional['tipAmount']),
    card: {
      brand: instrument?.PaymentBrand ?? additional['paymentMethod'] ?? null,
      last4,
      authCode: additional['authCode'] ?? null,
      aid: additional['aid'] ?? null,
      applicationName: additional['applicationLabel'] ?? additional['applicationPreferredName'] ?? null,
      cvm: additional['cardHolderVerificationMethodResults'] ?? additional['cvmResult'] ?? null,
      readMethod: additional['posEntryMode'] ?? null,
    },
    additional,
  };
}

// Standard-webhook card block (AUTHORISATION additionalData) → same shape.
export function cardFromWebhookAdditionalData(ad: Record<string, any> | undefined | null) {
  if (!ad) return null;
  return {
    brand: ad['paymentMethod'] ?? ad['paymentMethodVariant'] ?? null,
    last4: ad['cardSummary'] ?? null,
    authCode: ad['authCode'] ?? null,
    aid: ad['aid'] ?? null,
    applicationName: ad['applicationLabel'] ?? null,
    cvm: ad['cardHolderVerificationMethodResults'] ?? null,
    readMethod: ad['posEntryMode'] ?? ad['shopperInteraction'] ?? null,
  };
}

// ── Tiered rate card (v5.7.3) ───────────────────────────────────────────────
// The four-tier ServOS Payments pricing model (migration 20260821b):
//   card_present      in-person credit AND debit — one fee
//   card_not_present  online orders (ecommerce)
//   amex              American Express + business/commercial cards
//   keyed             manually keyed in (MOTO)
// Stored as jsonb {tier: {percent, fixed_pence}} on merchant_adyen_accounts
// .rate_card (venue) and platform_settings.default_adyen_rate_card (default).

export const RATE_TIERS = ['card_present', 'card_not_present', 'amex', 'keyed'] as const;
export type RateTier = typeof RATE_TIERS[number];

export interface TierRate {
  percent: number | null;
  fixed_pence: number | null;
  // Which layer supplied the rate: the venue's card, the platform default
  // card, the venue's legacy flat markup, the platform's legacy flat default,
  // or null when nothing is configured for the tier.
  source: 'venue' | 'platform' | 'legacy_venue' | 'legacy_platform' | null;
}

const tierField = (card: any, tier: string, field: string): number | null => {
  const v = card?.[tier]?.[field];
  return v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v);
};

// Resolve the effective rate card for one venue. Per-field fallback chain,
// per tier: venue rate_card → platform default rate_card → the LEGACY flat
// markup columns → null. The legacy flat rate (v5.7.0's single all-payments
// number) counts as the card_present tier ONLY — the other tiers stay null
// until someone prices them, so configure_splits and the commission stamp
// never silently reuse the in-person rate for online / Amex / keyed traffic.
export function resolveAdyenRateCard(
  account: { rate_card?: any; markup_percent?: unknown; markup_fixed_pence?: unknown } | null | undefined,
  settings: { default_adyen_rate_card?: any; default_adyen_markup_percent?: unknown; default_adyen_markup_fixed_pence?: unknown } | null | undefined,
): Record<RateTier, TierRate> {
  const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
  const legacyVenue = { percent: numOrNull(account?.markup_percent), fixed_pence: numOrNull(account?.markup_fixed_pence) };
  const legacyPlatform = { percent: numOrNull(settings?.default_adyen_markup_percent), fixed_pence: numOrNull(settings?.default_adyen_markup_fixed_pence) };
  const out = {} as Record<RateTier, TierRate>;
  for (const tier of RATE_TIERS) {
    const pick = (field: 'percent' | 'fixed_pence'): { value: number | null; source: TierRate['source'] } => {
      const venue = tierField(account?.rate_card, tier, field);
      if (venue !== null) return { value: venue, source: 'venue' };
      const def = tierField(settings?.default_adyen_rate_card, tier, field);
      if (def !== null) return { value: def, source: 'platform' };
      if (tier === 'card_present') {
        if (legacyVenue[field] !== null) return { value: legacyVenue[field], source: 'legacy_venue' };
        if (legacyPlatform[field] !== null) return { value: legacyPlatform[field], source: 'legacy_platform' };
      }
      return { value: null, source: null };
    };
    const pct = pick('percent');
    const fix = pick('fixed_pence');
    out[tier] = {
      percent: pct.value,
      fixed_pence: fix.value === null ? null : Math.round(fix.value),
      source: pct.source ?? fix.source,
    };
  }
  return out;
}

// Validate + normalise a rate card arriving from the admin UI. Unknown tiers
// are dropped; '' clears a field to null. Returns null when every field ends
// up null — storing null (not {}) is what keeps the "legacy applies until a
// rate card exists" rule readable.
export function sanitizeRateCard(input: unknown): Record<string, { percent: number | null; fixed_pence: number | null }> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, { percent: number | null; fixed_pence: number | null }> = {};
  let any = false;
  for (const tier of RATE_TIERS) {
    const t: any = (input as any)[tier];
    if (!t || typeof t !== 'object') continue;
    const num = (v: unknown, max: number) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return isNaN(n) || n < 0 || n > max ? null : n;
    };
    const percent = num(t.percent, 100);
    const fixedRaw = num(t.fixed_pence, 10000);
    const fixed_pence = fixedRaw === null ? null : Math.round(fixedRaw);
    out[tier] = { percent, fixed_pence };
    if (percent !== null || fixed_pence !== null) any = true;
  }
  return any ? out : null;
}

// Commission for one payment: the tier rate applied to the amount, rounded
// half up. Null when the tier has no rate at all (honest "not configured").
export function commissionForAmount(amountMinor: number, tier: TierRate | null | undefined): number | null {
  if (!tier || (tier.percent === null && tier.fixed_pence === null)) return null;
  if (!Number.isFinite(amountMinor) || amountMinor < 0) return null;
  const pct = Number(tier.percent ?? 0);
  const fixed = Math.round(Number(tier.fixed_pence ?? 0));
  return Math.floor((amountMinor * pct) / 100 + 0.5) + fixed;
}
