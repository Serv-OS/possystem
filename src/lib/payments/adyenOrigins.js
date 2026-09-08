/**
 * adyenOrigins.js: the ServOS web origins and per venue storefront domains
 * that Adyen must know about, and the pure planning around them. No network,
 * no Supabase, no Deno.
 *
 * MIRROR: supabase/functions/_shared/adyenOrigins.ts carries the SAME
 * builders and the SAME dedupe (Deno cannot import from src/). Change both or
 * neither. adyenOrigins.test.js is the contract for both copies.
 *
 * WHY (8 Sep 2026): the Drop-in and Components run on the operator hosts
 * (app.serv-os.app, dev.serv-os.app) and on every venue storefront
 * (<slug>.serv-os.app, <slug>.dev.serv-os.app), so the API credential the
 * client key belongs to must list those as ALLOWED ORIGINS. The live
 * Customer Area refuses a wildcard in its screen, while Adyen's docs allow
 * https://*.example.org, so the wildcards go in through the Management API
 * (adyen-terminal-admin register_origins):
 *   GET  /v3/me                  { username, clientKey, allowedOrigins, roles }
 *   GET  /v3/me/allowedOrigins   { data: [{ id, domain }] }
 *   POST /v3/me/allowedOrigins   { domain }
 * /me is credential scoped, and the Drop-in only honours origins on the
 * credential its client key was generated on, so the fn signs with the set's
 * API key and checks GET /me's clientKey before posting.
 * https://docs.adyen.com/api-explorer/Management/3/get/me/allowedOrigins
 * https://docs.adyen.com/api-explorer/Management/3/post/me/allowedOrigins
 * https://docs.adyen.com/development-resources/client-side-authentication
 *
 * Apple Pay with Adyen's certificate needs every storefront host registered
 * on the merchant's Apple Pay payment method (the app serves the association
 * file at /.well-known/apple-developer-merchantid-domain-association on every
 * host since v5.8.36), through register_apple_pay_domains:
 *   GET  /v3/merchants/{m}/paymentMethodSettings?pageSize=100
 *   GET  /v3/merchants/{m}/paymentMethodSettings/{id}/getApplePayDomains   { domains }
 *   POST /v3/merchants/{m}/paymentMethodSettings/{id}/addApplePayDomains   { domains }   204
 * https://docs.adyen.com/api-explorer/Management/3/get/merchants/(merchantId)/paymentMethodSettings
 * https://docs.adyen.com/api-explorer/Management/3/get/merchants/(merchantId)/paymentMethodSettings/(paymentMethodId)/getApplePayDomains
 * https://docs.adyen.com/api-explorer/Management/3/post/merchants/(merchantId)/paymentMethodSettings/(paymentMethodId)/addApplePayDomains
 *
 * Both registrations are idempotent: whatever Adyen already lists is
 * reported as existing and never posted twice (splitAgainstExisting), and an
 * "already exists" refusal counts as existing too (isDuplicateRefusal).
 *
 * Storefront hosts follow src/lib/env.js: prod is <slug>.serv-os.app, dev is
 * <slug>.dev.serv-os.app. There is no custom storefront domain column yet
 * (org_sending_domains is email only); every builder already takes one so
 * nothing here changes when it arrives.
 */

export const SERVOS_APEX = 'serv-os.app';
export const SERVOS_DEV_ROOT = 'dev.serv-os.app';

// The origins every credential needs, in the order they are registered.
export const STATIC_WEB_ORIGINS = Object.freeze([
  'https://app.serv-os.app',
  'https://serv-os.app',
  'https://dev.serv-os.app',
  'https://*.serv-os.app',
  'https://*.dev.serv-os.app',
]);

// A hostname (labels of a-z, 0-9 and hyphens, at least two labels), with an
// optional leading wildcard label.
const HOST_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// The same rule as customerUrl.js isValidSlug: lowercase a-z, digits,
// hyphens, 3 to 40 characters, no leading or trailing hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/;

// A bare host out of whatever was typed: scheme, path, query, port and a
// trailing dot are dropped. '' when what is left is not a hostname.
export function normaliseHost(value) {
  let s = String(value ?? '').trim().toLowerCase();
  if (!s) return '';
  const m = s.match(SCHEME_RE);
  if (m) s = m[2];
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.+$/, '');
  return HOST_RE.test(s) ? s : '';
}

// Comparison key for an ALLOWED ORIGIN: scheme plus host (and port when
// given), lower case, no path, no trailing slash. A bare host is https.
// Loose on purpose: Adyen's existing list may hold localhost or an IP, and
// those must still compare equal to themselves.
export function originKey(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const m = raw.match(SCHEME_RE);
  const scheme = m ? m[1] : 'https';
  const rest = (m ? m[2] : raw).split(/[/?#]/)[0].replace(/\.+$/, '');
  return rest ? `${scheme}://${rest}` : '';
}

// Comparison key for an APPLE PAY DOMAIN: the host only, lower case. Loose
// like originKey: an odd entry Adyen already holds still compares to itself.
export function domainKey(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const m = raw.match(SCHEME_RE);
  return (m ? m[2] : raw).split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.+$/, '');
}

// The origin for a venue's custom domain, '' when there is none.
export function customDomainOrigin(customDomain) {
  const host = normaliseHost(customDomain);
  return host ? `https://${host}` : '';
}

// Keep the first of every key, in order. Entries with no key are dropped.
export function dedupeBy(list, key) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const k = key(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

// Every allowed origin a credential needs: the static ServOS hosts and
// wildcards, plus the venue's custom domain when the app has one.
export function buildWebOrigins({ customDomain } = {}) {
  return dedupeBy([...STATIC_WEB_ORIGINS, customDomainOrigin(customDomain)], originKey);
}

// The venue's storefront hosts for Apple Pay: <slug>.serv-os.app and
// <slug>.dev.serv-os.app (plus the custom domain when there is one). A
// missing or invalid slug gives no ServOS hosts; the caller says so.
export function buildStorefrontDomains({ slug, customDomain, apex = SERVOS_APEX, devRoot = SERVOS_DEV_ROOT } = {}) {
  const s = String(slug ?? '').trim().toLowerCase();
  const out = [];
  if (SLUG_RE.test(s)) out.push(`${s}.${apex}`, `${s}.${devRoot}`);
  const custom = normaliseHost(customDomain);
  if (custom) out.push(custom);
  return dedupeBy(out, domainKey);
}

// Split `wanted` into what Adyen already lists and what must be posted,
// comparing by `key`. Order is kept, duplicates in `wanted` collapse.
export function splitAgainstExisting(wanted, existing, key = originKey) {
  const have = new Set((Array.isArray(existing) ? existing : []).map(key).filter(Boolean));
  const missing = [];
  const present = [];
  for (const w of dedupeBy(wanted, key)) (have.has(key(w)) ? present : missing).push(w);
  return { missing, existing: present };
}

// GET /me/allowedOrigins answers { data: [{ id, domain }] }; a bare array of
// strings or of rows is accepted too.
export function allowedOriginDomains(response) {
  const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  return rows.map((r) => (typeof r === 'string' ? r : r?.domain)).filter((d) => typeof d === 'string' && d.trim());
}

// The plan for a credential: what it needs, what it has, what to post.
export function originsPlan(existingResponse, { customDomain } = {}) {
  const wanted = buildWebOrigins({ customDomain });
  const { missing, existing } = splitAgainstExisting(wanted, allowedOriginDomains(existingResponse), originKey);
  return { wanted, missing, existing };
}

// GET .../getApplePayDomains answers { domains: [...] }; a bare array is
// accepted too (the payment method's own applePay.domains).
export function applePayDomainList(response) {
  const list = Array.isArray(response?.domains) ? response.domains : Array.isArray(response) ? response : [];
  return list.filter((d) => typeof d === 'string' && d.trim());
}

// The plan for a merchant's Apple Pay method: the venue's storefront hosts
// against what is registered already.
export function applePayDomainsPlan(existingResponse, storefront = {}) {
  const wanted = buildStorefrontDomains(storefront);
  const { missing, existing } = splitAgainstExisting(wanted, applePayDomainList(existingResponse), domainKey);
  return { wanted, missing, existing };
}

// The Apple Pay rows of a merchant's payment methods (GET
// /merchants/{m}/paymentMethodSettings, rows under `data`; a bare array is
// accepted too).
function applePayRows(response) {
  return (Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [])
    .filter((pm) => pm && String(pm.type ?? '').toLowerCase() === 'applepay');
}

// Does the merchant hold ANY Apple Pay entry? With pickApplePayMethod null
// this tells "set up per store, none for this venue's store" from "never
// requested".
export function hasApplePayEntries(response) {
  return applePayRows(response).length > 0;
}

// The Apple Pay entry for a venue: the one scoped to its store, else the
// merchant level one (no storeIds). Null when Apple Pay was never requested
// on the merchant, or when every entry is scoped to some OTHER store: another
// venue's entry is never picked (it used to fall back to rows[0], which
// wrote this venue's hosts onto another venue's entry).
export function pickApplePayMethod(response, storeId) {
  const rows = applePayRows(response);
  if (!rows.length) return null;
  const sid = String(storeId ?? '').trim();
  const forStore = sid ? rows.find((pm) => Array.isArray(pm.storeIds) && pm.storeIds.includes(sid)) : null;
  if (forStore) return forStore;
  return rows.find((pm) => !Array.isArray(pm.storeIds) || pm.storeIds.length === 0) ?? null;
}

// One sentence on the Apple Pay method's state for the admin. Management API
// verificationStatus: valid | pending | invalid | rejected. storeScoped is
// the third null state: entries exist, none for this venue's store.
export function applePayStatusNote(paymentMethod, merchant, { storeScoped = false } = {}) {
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

// The text of a Management API refusal (RFC 7807 style: title, detail,
// errorCode, invalidFields), falling back to the raw body or the status.
export function adyenRefusalMessage(status, data) {
  const d = data && typeof data === 'object' ? data : {};
  const parts = [];
  const head = d.detail || d.title || d.message;
  if (head) parts.push(String(head));
  if (Array.isArray(d.invalidFields) && d.invalidFields.length) {
    parts.push(d.invalidFields.map((f) => [f?.name, f?.message].filter(Boolean).join(': ')).filter(Boolean).join('; '));
  }
  if (!parts.length && typeof d.raw === 'string' && d.raw.trim()) parts.push(d.raw.trim().slice(0, 200));
  if (!parts.length) parts.push(`HTTP ${status}`);
  return parts.filter(Boolean).join(' ');
}

// "It is there already" refusals count as existing, never as failures. A
// 409 always does; otherwise the text must say already, duplicate or exists
// without saying the thing does NOT exist.
export function isDuplicateRefusal(status, data) {
  if (Number(status) === 409) return true;
  const msg = adyenRefusalMessage(status, data);
  if (/not (?:exist|found)|does ?n[o']t exist|unknown/i.test(msg)) return false;
  return /already|duplicate|exists/i.test(msg);
}

// The lines the admin sees for one registration answer ({ added, existing,
// failed: [{ origin | domain, status, message }], error?, note? }), each with
// a tone: ok | info | warn | err.
export function registrationLines(result) {
  if (!result || typeof result !== 'object') return [];
  const lines = [];
  const added = Array.isArray(result.added) ? result.added : [];
  const existing = Array.isArray(result.existing) ? result.existing : [];
  const failed = Array.isArray(result.failed) ? result.failed : [];
  if (result.error) lines.push({ tone: 'err', text: String(result.error) });
  if (added.length) lines.push({ tone: 'ok', text: `Added: ${added.join(', ')}` });
  if (existing.length) lines.push({ tone: 'info', text: `Already there: ${existing.join(', ')}` });
  for (const f of failed) {
    const target = f?.origin || f?.domain || '?';
    const why = [f?.status, f?.message].filter((x) => x !== undefined && x !== null && x !== '').join(' ');
    lines.push({ tone: 'err', text: `Failed: ${target}${why ? ` (${why})` : ''}` });
  }
  if (result.note && result.note !== result.error) lines.push({ tone: result.ok === false && !failed.length && !result.error ? 'warn' : 'info', text: String(result.note) });
  if (!lines.length) lines.push({ tone: 'info', text: 'Nothing to register.' });
  return lines;
}
