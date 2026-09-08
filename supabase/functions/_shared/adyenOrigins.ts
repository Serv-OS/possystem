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

export interface StorefrontInput { slug?: string | null; customDomain?: string | null; apex?: string; devRoot?: string }

export function buildWebOrigins({ customDomain }: { customDomain?: string | null } = {}): string[] {
  return dedupeBy([...STATIC_WEB_ORIGINS, customDomainOrigin(customDomain)], originKey);
}

export function buildStorefrontDomains({ slug, customDomain, apex = SERVOS_APEX, devRoot = SERVOS_DEV_ROOT }: StorefrontInput = {}): string[] {
  const s = String(slug ?? '').trim().toLowerCase();
  const out: string[] = [];
  if (SLUG_RE.test(s)) out.push(`${s}.${apex}`, `${s}.${devRoot}`);
  const custom = normaliseHost(customDomain);
  if (custom) out.push(custom);
  return dedupeBy(out, domainKey);
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
