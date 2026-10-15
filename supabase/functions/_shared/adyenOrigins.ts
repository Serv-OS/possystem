// supabase/functions/_shared/adyenOrigins.ts
//
// The ServOS web origins and per venue storefront domains Adyen must know
// about, and the pure planning around them. PURE: no Deno APIs, no Supabase,
// no network.
//
// MIRROR: src/lib/payments/adyenOrigins.js carries the SAME builders and the
// SAME dedupe (Deno cannot import from src/). Change both or neither.
// src/lib/payments/adyenOrigins.test.js is the contract for both copies.
//
// Used by adyen-terminal-admin (register_origins, register_apple_pay_domains
// and the tail of set_environment). Endpoints, confirmed on docs.adyen.com
// (Management API v3, host = managementBase(cfg)):
//   GET  /v3/me                                                   { username, clientKey, allowedOrigins, roles }
//   GET  /v3/me/allowedOrigins                                    { data: [{ id, domain }] }
//   POST /v3/me/allowedOrigins                                    { domain }        200 { id, domain }
//   GET  /v3/merchants/{m}/paymentMethodSettings?pageSize=100     { data: [{ id, type, verificationStatus, storeIds, applePay: { domains } }] }
//   GET  /v3/merchants/{m}/paymentMethodSettings/{id}/getApplePayDomains   { domains }
//   POST /v3/merchants/{m}/paymentMethodSettings/{id}/addApplePayDomains   { domains }   204
// /me is CREDENTIAL scoped: the key that makes the call is the key whose
// origins change, and the Drop-in only honours origins on the credential its
// client key was generated on, so the caller signs with the set's API key
// and checks GET /me's clientKey first. Wildcards (https://*.example.org)
// are allowed by the API; the live Customer Area screen refuses them, which
// is why this exists.
//
// ONE HOST ON LIVE and AUTOMATIC, SELF RETRYING Apple Pay registration (29
// Sep 2026, v5.11.17): see the header of the JS mirror. A live venue
// registers <slug>.serv-os.app (plus its custom domain) only; a test venue
// every address it can be opened on (<slug>.dev.serv-os.app, then
// <slug>.serv-os.app and the custom domain). The throttle, the guidance
// sentence and the kept state row are the helpers at the bottom of this file.

export const SERVOS_APEX = 'serv-os.app';
export const SERVOS_DEV_ROOT = 'dev.serv-os.app';

export const STATIC_WEB_ORIGINS: readonly string[] = Object.freeze([
  'https://app.serv-os.app',
  'https://serv-os.app',
  'https://dev.serv-os.app',
  'https://*.serv-os.app',
  'https://*.dev.serv-os.app',
]);

const HOST_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/;

export function normaliseHost(value: unknown): string {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  const m = s.match(SCHEME_RE);
  if (m) s = m[2];
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.+$/, '');
  return HOST_RE.test(s) ? s : '';
}

export function originKey(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const m = raw.match(SCHEME_RE);
  const scheme = m ? m[1] : 'https';
  const rest = (m ? m[2] : raw).split(/[/?#]/)[0].replace(/\.+$/, '');
  return rest ? `${scheme}://${rest}` : '';
}

export function domainKey(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const m = raw.match(SCHEME_RE);
  return (m ? m[2] : raw).split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.+$/, '');
}

export function customDomainOrigin(customDomain: unknown): string {
  const host = normaliseHost(customDomain);
  return host ? `https://${host}` : '';
}

export function dedupeBy<T>(list: T[] | null | undefined, key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const k = key(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export interface StorefrontInput { slug?: string | null; customDomain?: string | null; environment?: string | null; apex?: string; devRoot?: string }

export function buildWebOrigins({ customDomain }: { customDomain?: string | null } = {}): string[] {
  return dedupeBy([...STATIC_WEB_ORIGINS, customDomainOrigin(customDomain)], originKey);
}

// 'live' | 'test' for an environment word, '' for anything else.
function envWord(environment: unknown): '' | 'live' | 'test' {
  const e = String(environment ?? '').trim().toLowerCase();
  return e === 'live' || e === 'test' ? e : '';
}

// The venue's storefront hosts for Apple Pay, for ONE environment: live is
// <slug>.serv-os.app plus the custom domain; test is <slug>.dev.serv-os.app,
// then <slug>.serv-os.app and the custom domain. No environment is the legacy
// pair (no server caller since v5.11.17).
export function buildStorefrontDomains({ slug, customDomain, environment, apex = SERVOS_APEX, devRoot = SERVOS_DEV_ROOT }: StorefrontInput = {}): string[] {
  const s = String(slug ?? '').trim().toLowerCase();
  const env = envWord(environment);
  const out: string[] = [];
  if (SLUG_RE.test(s)) {
    if (env === 'live') out.push(`${s}.${apex}`);
    else if (env === 'test') out.push(`${s}.${devRoot}`, `${s}.${apex}`);
    else out.push(`${s}.${apex}`, `${s}.${devRoot}`);
  }
  const custom = normaliseHost(customDomain);
  if (custom) out.push(custom);
  return dedupeBy(out, domainKey);
}

// The venue's MAIN storefront host on an environment (the kept row's and the
// throttle's key): <slug>.dev.serv-os.app on test, <slug>.serv-os.app
// otherwise. '' for a missing or invalid slug.
export function storefrontHostFor({ slug, environment, apex = SERVOS_APEX, devRoot = SERVOS_DEV_ROOT }: StorefrontInput = {}): string {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) return '';
  return envWord(environment) === 'test' ? `${s}.${devRoot}` : `${s}.${apex}`;
}

export function splitAgainstExisting(wanted: string[], existing: string[] | null | undefined, key: (v: unknown) => string = originKey): { missing: string[]; existing: string[] } {
  const have = new Set((Array.isArray(existing) ? existing : []).map(key).filter(Boolean));
  const missing: string[] = [];
  const present: string[] = [];
  for (const w of dedupeBy(wanted, key)) (have.has(key(w)) ? present : missing).push(w);
  return { missing, existing: present };
}

export function allowedOriginDomains(response: unknown): string[] {
  const r = response as { data?: unknown } | null;
  const rows: unknown[] = Array.isArray(r?.data) ? r.data : Array.isArray(response) ? response : [];
  return rows
    .map((row) => (typeof row === 'string' ? row : (row as { domain?: unknown } | null)?.domain))
    .filter((d): d is string => typeof d === 'string' && d.trim() !== '');
}

export function originsPlan(existingResponse: unknown, { customDomain }: { customDomain?: string | null } = {}): { wanted: string[]; missing: string[]; existing: string[] } {
  const wanted = buildWebOrigins({ customDomain });
  const { missing, existing } = splitAgainstExisting(wanted, allowedOriginDomains(existingResponse), originKey);
  return { wanted, missing, existing };
}

export function applePayDomainList(response: unknown): string[] {
  const r = response as { domains?: unknown } | null;
  const list: unknown[] = Array.isArray(r?.domains) ? r.domains : Array.isArray(response) ? response : [];
  return list.filter((d): d is string => typeof d === 'string' && d.trim() !== '');
}

export function applePayDomainsPlan(existingResponse: unknown, storefront: StorefrontInput = {}): { wanted: string[]; missing: string[]; existing: string[] } {
  const wanted = buildStorefrontDomains(storefront);
  const { missing, existing } = splitAgainstExisting(wanted, applePayDomainList(existingResponse), domainKey);
  return { wanted, missing, existing };
}

export interface AdyenPaymentMethodRow {
  id?: unknown;
  type?: unknown;
  enabled?: unknown;
  verificationStatus?: unknown;
  storeIds?: unknown;
  applePay?: { domains?: unknown } | null;
  [k: string]: unknown;
}

// The Apple Pay rows of a merchant's payment methods (GET
// /merchants/{m}/paymentMethodSettings, rows under `data`; a bare array is
// accepted too).
function applePayRows(response: unknown): AdyenPaymentMethodRow[] {
  const r = response as { data?: unknown } | null;
  return ((Array.isArray(r?.data) ? r.data : Array.isArray(response) ? response : []) as AdyenPaymentMethodRow[])
    .filter((pm) => pm && String(pm.type ?? '').toLowerCase() === 'applepay');
}

// Does the merchant hold ANY Apple Pay entry? With pickApplePayMethod null
// this tells "set up per store, none for this venue's store" from "never
// requested".
export function hasApplePayEntries(response: unknown): boolean {
  return applePayRows(response).length > 0;
}

// The Apple Pay entry for a venue: the one scoped to its store, else the
// merchant level one (no storeIds). Null when Apple Pay was never requested
// on the merchant, or when every entry is scoped to some OTHER store: another
// venue's entry is never picked (it used to fall back to rows[0], which
// wrote this venue's hosts onto another venue's entry).
export function pickApplePayMethod(response: unknown, storeId?: string | null): AdyenPaymentMethodRow | null {
  const rows = applePayRows(response);
  if (!rows.length) return null;
  const sid = String(storeId ?? '').trim();
  const forStore = sid ? rows.find((pm) => Array.isArray(pm.storeIds) && (pm.storeIds as unknown[]).includes(sid)) : null;
  if (forStore) return forStore;
  return rows.find((pm) => !Array.isArray(pm.storeIds) || (pm.storeIds as unknown[]).length === 0) ?? null;
}

export function applePayStatusNote(paymentMethod: AdyenPaymentMethodRow | null | undefined, merchant?: string | null, { storeScoped = false }: { storeScoped?: boolean } = {}): string {
  const where = merchant ? ` on ${merchant}` : '';
  if (!paymentMethod) {
    if (storeScoped) return `Apple Pay${where} is set up per store and this venue's store has none yet. Create the store, request Apple Pay on it, then run this again.`;
    return `Apple Pay is not requested${where} yet. Request it in the Adyen Customer Area (Payment methods, Request payment methods, Apple Pay, with Adyen's certificate), then run this again.`;
  }
  const status = String(paymentMethod.verificationStatus ?? '').trim().toLowerCase();
  if (status === 'valid') return `Apple Pay is approved${where}.`;
  if (status === 'pending') return `Apple Pay is requested${where} but Adyen has not approved it yet. The domains are registered now and work once it is approved.`;
  if (status === 'invalid' || status === 'rejected') return `Adyen marked Apple Pay ${status}${where}. Fix that in the Customer Area; the domains registered here are used once it is approved.`;
  return `Apple Pay is requested${where} (status ${status || 'unknown'}).`;
}

export function adyenRefusalMessage(status: number, data: unknown): string {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const parts: string[] = [];
  const head = d.detail || d.title || d.message;
  if (head) parts.push(String(head));
  if (Array.isArray(d.invalidFields) && d.invalidFields.length) {
    parts.push((d.invalidFields as Array<{ name?: unknown; message?: unknown }>)
      .map((f) => [f?.name, f?.message].filter(Boolean).join(': ')).filter(Boolean).join('; '));
  }
  if (!parts.length && typeof d.raw === 'string' && d.raw.trim()) parts.push(d.raw.trim().slice(0, 200));
  if (!parts.length) parts.push(`HTTP ${status}`);
  return parts.filter(Boolean).join(' ');
}

export function isDuplicateRefusal(status: number, data: unknown): boolean {
  if (Number(status) === 409) return true;
  const msg = adyenRefusalMessage(status, data);
  if (/not (?:exist|found)|does ?n[o']t exist|unknown/i.test(msg)) return false;
  return /already|duplicate|exists/i.test(msg);
}

// ── AUTOMATIC APPLE PAY REGISTRATION (29 Sep 2026, v5.11.17) ────────────────
// MIRROR of the block at the bottom of src/lib/payments/adyenOrigins.js, which
// carries the comments. adyen-terminal-admin ensureApplePayDomains uses these.
export const APPLE_PAY_RETRY_MS = 6 * 60 * 60 * 1000;
export const APPLE_PAY_RECHECK_MS = 24 * 60 * 60 * 1000;
export const APPLE_PAY_CLOCK_SKEW_MS = 60 * 1000;
export const APPLE_PAY_STATE_PREFIX = 'applepay_state';
export const APPLE_PAY_MANUAL_TRIGGERS: readonly string[] = Object.freeze(['admin', 'go_live', 'adyen_link']);
export const APPLE_PAY_PERMISSION_GUIDANCE = 'Ask FranPOS to tick Management API: Payment methods read and write on the ServOS API credential.';
export const APPLE_PAY_GUIDANCE_MAX = 120;
const STATE_TEXT_MAX = 300;

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const numOrNull = (v: unknown): number | null => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isScope = (v: unknown): boolean => Number(v) === 401 || Number(v) === 403;

export function clipText(value: unknown, max: number): string {
  const s = text(value).replace(/\s+/g, ' ');
  if (!s || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function applePayStateKey(env: unknown, platformLocationId: unknown): string {
  const e = envWord(env);
  const id = text(platformLocationId);
  return e && id ? `${APPLE_PAY_STATE_PREFIX}:${e}:${id}` : '';
}

export interface ApplePayRetryInput { now?: number; host?: string | null; merchant?: string | null; trigger?: string | null; paymentMethodId?: string | null }
export function applePayRetryDue(state: unknown, { now = Date.now(), host = '', merchant = '', trigger = '', paymentMethodId = '' }: ApplePayRetryInput = {}): boolean {
  if (APPLE_PAY_MANUAL_TRIGGERS.includes(text(trigger))) return true;
  if (!isObj(state)) return true;
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const at = Date.parse(text(state.checkedAt));
  if (!Number.isFinite(at) || at > t + APPLE_PAY_CLOCK_SKEW_MS) return true;
  if (domainKey(host) !== domainKey(state.host)) return true;
  if (text(merchant) !== text(state.merchant)) return true;
  const pm = text(paymentMethodId);
  if (pm && text(state.paymentMethodId) && pm !== text(state.paymentMethodId)) return true;
  return t - at >= (state.registered === true ? APPLE_PAY_RECHECK_MS : APPLE_PAY_RETRY_MS);
}

export function adyenErrorCode(data: unknown): string | null {
  const c = isObj(data) ? data.errorCode : null;
  const s = text(c);
  return s ? s.slice(0, 40) : null;
}

export function applePayAnswerCode(answer: unknown): string {
  const a: Dict = isObj(answer) ? answer : {};
  const code = text(a.code);
  if (code) return code;
  return /did not answer/i.test(text(a.error)) ? 'timeout' : '';
}

export function isPermissionRefusal(answer: unknown): boolean {
  const a: Dict = isObj(answer) ? answer : {};
  if (text(a.code) === 'scope_missing') return true;
  if (isScope(a.status)) return true;
  return (Array.isArray(a.failed) ? a.failed as unknown[] : []).some((f) => isObj(f) && isScope(f.status));
}

export function applePayGuidance(answer: unknown): string | null {
  const a: Dict = isObj(answer) ? answer : {};
  const failed = (Array.isArray(a.failed) ? a.failed as unknown[] : []).filter(isObj);
  const code = applePayAnswerCode(a);
  if ((a.ok === true || a.registered === true) && !failed.length && !code) {
    const v = text(a.verificationStatus ?? a.verification).toLowerCase();
    return v && v !== 'valid' ? applePayStatusNote({ verificationStatus: v }, text(a.merchant) || null) : null;
  }
  if (isPermissionRefusal(a)) return APPLE_PAY_PERMISSION_GUIDANCE;
  if (code === 'apple_pay_not_requested') return "Apple Pay is not switched on for this Adyen account. Ask FranPOS to request it with Adyen's certificate.";
  if (code === 'apple_pay_store_scoped') return "Apple Pay is set up store by store and this venue's store has none. Ask FranPOS to add it.";
  if (code === 'no_storefront') return "This venue has no online address yet. Set it in Channels first.";
  if (code === 'timeout') return 'Adyen did not answer. ServOS tries again by itself.';
  const f = failed[0];
  if (f) {
    const host = text(f.domain) || text(a.host) || 'the shop address';
    const head = `Adyen would not add ${host}`;
    const why = clipText(f.message || (numOrNull(f.status) ? `HTTP ${f.status}` : ''), APPLE_PAY_GUIDANCE_MAX - head.length - 3);
    return clipText(why ? `${head}: ${why}${why.endsWith('...') ? '' : '.'}` : `${head}.`, APPLE_PAY_GUIDANCE_MAX);
  }
  if (code === 'read_failed' || text(a.error)) {
    const head = 'Adyen could not be asked about Apple Pay';
    const tail = ' ServOS tries again by itself.';
    const why = clipText(a.message || a.error, APPLE_PAY_GUIDANCE_MAX - head.length - tail.length - 3);
    return why ? `${head}: ${why}${why.endsWith('...') ? '' : '.'}${tail}` : `${head}.${tail}`;
  }
  return null;
}

export interface ApplePayFailedHost { domain: string | null; status: number | null; errorCode: string | null; message: string | null }
export interface ApplePayState {
  v: 1;
  environment: 'live' | 'test' | null;
  host: string | null;
  merchant: string | null;
  paymentMethodId: string | null;
  verification: string | null;
  registered: boolean;
  outcome: 'registered' | 'added' | 'refused' | 'not_requested' | 'store_scoped' | 'no_storefront' | 'error';
  code: string | null;
  status: number | null;
  errorCode: string | null;
  error: string | null;
  failed: ApplePayFailedHost[];
  added: string[];
  guidance: string | null;
  checkedAt: string;
  trigger: string | null;
  failures: number;
}
export interface ApplePayStateInput { trigger?: string | null; host?: string | null; now?: number; previous?: unknown }
export function applePayStateFrom(answer: unknown, { trigger = null, host = '', now = Date.now(), previous = null }: ApplePayStateInput = {}): ApplePayState {
  const a: Dict = isObj(answer) ? answer : {};
  const code = applePayAnswerCode(a);
  const failed: ApplePayFailedHost[] = (Array.isArray(a.failed) ? a.failed as unknown[] : []).filter(isObj).slice(0, 10).map((f) => ({
    domain: clipText(f.domain, 120) || null,
    status: numOrNull(f.status),
    errorCode: text(f.errorCode) || null,
    message: clipText(f.message, STATE_TEXT_MAX) || null,
  }));
  const added = (Array.isArray(a.added) ? a.added as unknown[] : []).map(text).filter(Boolean).slice(0, 10);
  const hostNow = domainKey(text(host) || text(a.host));
  const registered = a.ok === true && !!hostNow && failed.length === 0 && !code;
  let outcome: ApplePayState['outcome'] = 'error';
  if (code === 'no_storefront') outcome = 'no_storefront';
  else if (code === 'apple_pay_not_requested') outcome = 'not_requested';
  else if (code === 'apple_pay_store_scoped') outcome = 'store_scoped';
  else if (registered) outcome = added.length ? 'added' : 'registered';
  else if (isPermissionRefusal(a) || failed.length) outcome = 'refused';
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const before = isObj(previous) ? Number(previous.failures) : 0;
  return {
    v: 1,
    environment: envWord(a.environment) || null,
    host: hostNow || null,
    merchant: text(a.merchant) || null,
    paymentMethodId: text(a.paymentMethodId) || null,
    verification: text(a.verificationStatus ?? a.verification) || null,
    registered,
    outcome,
    code: code || null,
    status: numOrNull(a.status) ?? (failed[0] ? failed[0].status : null),
    errorCode: text(a.errorCode) || (failed[0] ? failed[0].errorCode : null) || null,
    error: registered ? null : (clipText(a.message || (failed[0] ? failed[0].message : '') || a.error, STATE_TEXT_MAX) || null),
    failed,
    added,
    guidance: applePayGuidance(a),
    checkedAt: new Date(t).toISOString(),
    trigger: text(trigger) || null,
    failures: registered ? 0 : (Number.isFinite(before) && before > 0 ? before : 0) + 1,
  };
}
