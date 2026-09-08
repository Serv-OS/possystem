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
//   test set  ADYEN_<SUFFIX>       the names in use today, unchanged
//   live set  ADYEN_LIVE_<SUFFIX>  same suffixes
//   plus      ADYEN_LIVE_PREFIX    company URL prefix, REQUIRED for live
//   ADYEN_ENV is ONLY the fallback when a request cannot be tied to a venue
//   row (default 'test'). It never picks the secret set for a known venue.
//
// Suffixes: API_KEY, CLIENT_KEY, HMAC_KEY, MERCHANT_ACCOUNT, DEVICE_BASE,
// MANAGEMENT_KEY, LEM_KEY, BP_KEY, BP_HMAC_KEY, EVENTS_USER, EVENTS_PASS,
// WEBHOOK_USER, WEBHOOK_PASS, REPORT_API_KEY, REPORT_USER, REPORT_PASS,
// CHECKOUT_BASE, MGMT_BASE, LEM_BASE, BP_BASE (the last five plus DEVICE_BASE
// are optional explicit host overrides, else derived from the defaults table).
//
// Fallbacks: managementKey / lemKey / bpKey fall back to the SAME set's apiKey;
// events + webhook basic auth fall back live -> test (Adyen posts both
// environments to the one URL). Nothing else crosses sets. A live venue with
// no ADYEN_LIVE_API_KEY or no ADYEN_LIVE_PREFIX FAILS CLOSED with
// 'Adyen live keys not configured for this venue'. It never gets test keys.
//
// MIRROR: src/lib/payments/adyenEnv.js carries the same suffix table, the same
// defaults and the same resolveAdyenConfig body, with the contract tests in
// adyenEnv.test.js. Deno cannot import from src/, so change both or neither.
//
// HOW TO USE (new code)
//   const cfg = await adyenConfigForLocation(platformAdmin, locationId);
//   // or, when the merchant_adyen_accounts row is already in hand:
//   const cfg = adyenConfig(adyenEnvFromRow(maa));
//   await adyenFetch('POST', `${checkoutBase(cfg)}/payments`, body, { cfg, idempotencyKey });
//   terminalEndpoint(maa.merchant_account, poiid, 'sync', region, cfg)
//   adyenFetch('GET', `${managementBase(cfg)}/...`, undefined, { cfg, apiKey: cfg.managementKey })
//   platformLocationIdFor(platformAdmin, opsOrPlatformId)   either id space -> platform id
//                                    (null when unknown, THROWS on a DB error)
//   adyenAccountForLocation(platformAdmin, platformId, cols)   { env, row } in one read
//   adyenNotConfiguredMessage(cfg)   the 503 text (exact fail closed wording on live)
//   paymentIdempotencyKey(reference, attempt)   'pay:<ref>:a<N>', hashed when over 64 chars
//   maskMerchantAccount(name)   for status responses reachable by customers
//   webhookHmacPolicy(cfg, hasSignature)   'reject' | 'unverifiable' | 'verify'
//
// Every Adyen function resolves its venue first (adyen-checkout,
// adyen-create-session, adyen-modify, adyen-terminal-admin, adyen-terminal-charge,
// adyen-terminal-events, adyen-capture-sweep, adyen-onboard, adyen-financial,
// booking-widget). adyen-webhook and adyen-bp-webhook pick the set by the
// notification (top level live flag, or whichever BP HMAC key verifies);
// adyen-report-ingest by the report download host (ca-live vs ca-test).
//
// Every host and fetch helper takes the venue's config. There is no zero
// argument form any more: a call with no config is a type error, never a
// silent read of the test secrets. resolveAdyenConfig keeps the secretEnv
// option for the mirror tests only.

export type AdyenEnv = 'test' | 'live';

export const ADYEN_LIVE_PREFIX_NAME = 'ADYEN_LIVE_PREFIX';
export const ADYEN_LIVE_FAIL_CLOSED = 'Adyen live keys not configured for this venue';

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
// Live Checkout has no default: it is built from the prefix (liveCheckoutBase).
// Live deviceBase is the CLASSIC terminal-api host for the EU region; the
// other regions are derived per venue in terminalEndpoint (liveTerminalApiBase)
// unless ADYEN_LIVE_DEVICE_BASE overrides the host outright.
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
  configured: boolean;     // test: apiKey set. live: apiKey AND prefix set.
  missing: string[];       // secret NAMES that block `configured`, never values
  apiKey: string;
  clientKey: string;
  hmacKey: string;
  merchantAccount: string;
  prefix: string;          // ADYEN_LIVE_PREFIX, '' on test
  checkoutBase: string;    // '' when live and the prefix is missing (no half built URL)
  managementBase: string;
  lemBase: string;
  balancePlatformBase: string;
  deviceBase: string;
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

export function adyenSecretName(env: AdyenEnv, field: AdyenSecretField): string {
  const suffix = ADYEN_SECRET_SUFFIXES[field];
  if (!suffix) throw new Error(`adyenSecretName: unknown field ${String(field)}`);
  return normalizeAdyenEnv(env) === 'live' ? `ADYEN_LIVE_${suffix}` : `ADYEN_${suffix}`;
}

// Checkout v72 live host carries the per company prefix. The bare
// https://checkout-live.adyen.com host is WRONG for live and must not be used.
export function liveCheckoutBase(prefix: string): string {
  return `https://${prefix}-checkout-live.adyenpayments.com/checkout/v72`;
}

const trimSlash = (s: string): string => String(s).replace(/\/+$/, '');

// resolveAdyenConfig(env, get, opts): the PURE resolver, identical to the JS
// mirror. `get` is the secret reader (Deno.env.get in production, a map in
// tests). opts.secretEnv picks which SECRET SET to read (default = env); only
// the mirror tests use it. Never throws.
export function resolveAdyenConfig(
  env: AdyenEnv | string | null | undefined,
  get: (name: string) => string | undefined | null,
  opts: { secretEnv?: AdyenEnv } = {},
): AdyenConfig {
  const e = normalizeAdyenEnv(env);
  const live = e === 'live';
  const secretEnv = normalizeAdyenEnv(opts.secretEnv ?? e);
  const read = (field: AdyenSecretField, set: AdyenEnv = secretEnv): string => {
    const v = get(adyenSecretName(set, field));
    return v == null ? '' : String(v).trim();
  };
  const prefix = live ? String(get(ADYEN_LIVE_PREFIX_NAME) ?? '').trim() : '';
  const apiKey = read('apiKey');
  const orApiKey = (field: AdyenSecretField): string => read(field) || apiKey;
  const orTest = (field: AdyenSecretField): string => read(field) || read(field, 'test');
  const override = (field: AdyenSecretField): string => { const v = read(field); return v ? trimSlash(v) : ''; };
  const defaults = ADYEN_DEFAULT_BASES[e];

  const missing: string[] = [];
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

const envGet = (name: string): string | undefined => Deno.env.get(name);

// The per venue config for one environment, read from Deno.env NOW.
export function adyenConfig(env: AdyenEnv): AdyenConfig {
  return resolveAdyenConfig(env, envGet);
}

// Fail closed for LIVE only. A test config with no key keeps today's soft
// behaviour (callers check cfg.configured and Adyen 401s).
export function assertAdyenConfigured(cfg: AdyenConfig): AdyenConfig {
  if (cfg && cfg.live && !cfg.configured) {
    const err: any = new Error(ADYEN_LIVE_FAIL_CLOSED);
    err.code = 'ADYEN_LIVE_NOT_CONFIGURED';
    err.missing = Array.isArray(cfg.missing) ? cfg.missing.slice() : [];
    throw err;
  }
  return cfg;
}

// ADYEN_ENV: the fallback ONLY when a request cannot be tied to a venue row.
export function adyenFallbackEnv(): AdyenEnv {
  return normalizeAdyenEnv(Deno.env.get('ADYEN_ENV'));
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

// The venue's account row AND its environment in ONE read. `columns` names
// the extra merchant_adyen_accounts columns the caller wants alongside
// `environment` (merchant_account, store_id, receive_payments_ok, ...). The
// row is null when the venue has none (env = ADYEN_ENV fallback). While the
// environment column is missing the read retries without it so callers still
// get their other columns. THROWS on any other DB error: never guess.
export async function adyenAccountForLocation<T extends Record<string, unknown> = Record<string, unknown>>(
  platformAdmin: any,
  locationId: string | null | undefined,
  columns: string[] = [],
): Promise<{ env: AdyenEnv; row: (T & { environment?: unknown }) | null }> {
  if (!locationId) return { env: adyenFallbackEnv(), row: null };
  const extra = columns.filter((c) => c && c !== 'environment');
  const select = (withEnv: boolean) => [...(withEnv ? ['environment'] : []), ...extra].join(', ');
  let { data, error } = await platformAdmin
    .from('merchant_adyen_accounts').select(select(true)).eq('location_id', locationId).maybeSingle();
  if (error && isUnknownColumnError(error)) {
    warnNoEnvironmentColumn();
    if (!extra.length) return { env: adyenFallbackEnv(), row: null };
    ({ data, error } = await platformAdmin
      .from('merchant_adyen_accounts').select(select(false)).eq('location_id', locationId).maybeSingle());
    if (error) throw new Error(`adyenAccountForLocation: ${error.message ?? String(error)}`);
    return { env: adyenFallbackEnv(), row: (data ?? null) as (T & { environment?: unknown }) | null };
  }
  if (error) throw new Error(`adyenAccountForLocation: ${error.message ?? String(error)}`);
  if (!data) return { env: adyenFallbackEnv(), row: null };   // no row: the request cannot be tied to a venue row
  return { env: adyenEnvFromRow(data), row: data as T & { environment?: unknown } };
}

export async function adyenEnvForLocation(platformAdmin: any, locationId: string | null | undefined): Promise<AdyenEnv> {
  return (await adyenAccountForLocation(platformAdmin, locationId)).env;
}

export async function adyenConfigForLocation(platformAdmin: any, locationId: string | null | undefined): Promise<AdyenConfig> {
  return adyenConfig(await adyenEnvForLocation(platformAdmin, locationId));
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

// The message a caller returns when a venue's config cannot be used: the
// exact fail closed text for live, today's soft wording for test.
export function adyenNotConfiguredMessage(cfg: AdyenConfig): string {
  return cfg.live ? ADYEN_LIVE_FAIL_CLOSED : `Adyen not configured, set ${adyenSecretName('test', 'apiKey')}`;
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

// The classic live Terminal API host for a region. Live hosts are REGIONAL
// (docs/adyen/research/adyen-in-person.md: terminal-api-live for EU, then
// terminal-api-live-us, -au, -apse, -nea). region: 'eu' | 'us' | 'au' | 'apse' | 'nea'.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function liveTerminalApiBase(region = 'eu'): string {
  const r = String(region ?? '').trim().toLowerCase() || 'eu';
  return r === 'eu' ? 'https://terminal-api-live.adyen.com' : `https://terminal-api-live-${r}.adyen.com`;
}

// The reader endpoint for one venue config. An explicit <SET>_DEVICE_BASE is
// authoritative (region ignored). Otherwise live derives the REGIONAL classic
// host from the venue's region, and test keeps the test default.
// KEEP IN SYNC with src/lib/payments/adyenEnv.js.
export function terminalEndpointForConfig(cfg: Pick<AdyenConfig, 'live' | 'deviceBase' | 'deviceBaseOverride'>, merchantAccount: string, poiid: string, mode: 'sync' | 'async', region = 'eu'): string {
  const base = (cfg.live && !cfg.deviceBaseOverride) ? liveTerminalApiBase(region) : cfg.deviceBase;
  return terminalEndpointFor(base, merchantAccount, poiid, mode);
}

// Every reader call site passes the venue's config and its region
// (merchant_adyen_accounts.region 'US' -> 'us', else 'eu').
export function terminalEndpoint(merchantAccount: string, poiid: string, mode: 'sync' | 'async', region = 'eu', cfg: AdyenConfig): string {
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
//     HmacSignature header, key used as raw text.
export async function verifyRawBodyHmac(rawBody: string, headerSig: string, key: string): Promise<boolean> {
  if (!key || !headerSig) return false;
  try {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = b64(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(rawBody)));
    return constantTimeEq(sig, headerSig);
  } catch { return false; }
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
