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
 *
 * ONE HOST ON LIVE (29 Sep 2026, v5.11.17): a live venue registers
 * <slug>.serv-os.app (plus its custom domain) and nothing else. Registering
 * both ServOS hosts on the live merchant let a refused dev host turn a live
 * answer into ok false, and a live venue's .dev host runs on the same keys
 * but is not its shop, so it is not registered on purpose.
 * A TEST venue keeps every address it can be opened on: <slug>.dev.serv-os.app
 * first, then <slug>.serv-os.app (production Back Office hands a venue that is
 * still on Adyen test its production address, env.js CUSTOMER_ROOT) and the
 * custom domain. The test merchant cannot touch live, so a refusal there
 * never marks live as failed.
 *
 * AUTOMATIC, SELF RETRYING (29 Sep 2026, v5.11.17). Coffee Boy's Apple Pay
 * sheet closed at once for a week because the six hosts were refused on 22
 * Sep, only a yes/no was kept and nothing ever asked again. Now the server
 * asks by itself (adyen-terminal-admin ensure_apple_pay_domains, nudged by
 * the online checkout), at most every APPLE_PAY_RETRY_MS after a refusal and
 * every APPLE_PAY_RECHECK_MS once registered, and keeps the outcome and
 * Adyen's reason in ONE row per venue and environment (applePayStateFrom,
 * platform adyen_webhook_events, event_key applePayStateKey). The helpers
 * below decide when to ask again and what to tell the admin; the function
 * does the calls.
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

// 'live' | 'test' for an environment word, '' for anything else.
function envWord(environment) {
  const e = String(environment ?? '').trim().toLowerCase();
  return e === 'live' || e === 'test' ? e : '';
}

// The venue's storefront hosts for Apple Pay, for ONE environment:
//   live  <slug>.serv-os.app, plus the custom domain when there is one
//   test  <slug>.dev.serv-os.app, then <slug>.serv-os.app and the custom
//         domain (a venue on Adyen test is opened on both deploy tiers)
// With no environment it is the legacy pair (both hosts, plus the custom
// domain); no server caller uses that since v5.11.17. A missing or invalid
// slug gives no ServOS hosts; the caller says so.
export function buildStorefrontDomains({ slug, customDomain, environment, apex = SERVOS_APEX, devRoot = SERVOS_DEV_ROOT } = {}) {
  const s = String(slug ?? '').trim().toLowerCase();
  const env = envWord(environment);
  const out = [];
  if (SLUG_RE.test(s)) {
    if (env === 'live') out.push(`${s}.${apex}`);
    else if (env === 'test') out.push(`${s}.${devRoot}`, `${s}.${apex}`);
    else out.push(`${s}.${apex}`, `${s}.${devRoot}`);
  }
  const custom = normaliseHost(customDomain);
  if (custom) out.push(custom);
  return dedupeBy(out, domainKey);
}

// The venue's MAIN storefront host on an environment, the key the kept row
// and the throttle use: <slug>.dev.serv-os.app on test, <slug>.serv-os.app
// otherwise. '' for a missing or invalid slug.
export function storefrontHostFor({ slug, environment, apex = SERVOS_APEX, devRoot = SERVOS_DEV_ROOT } = {}) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) return '';
  return envWord(environment) === 'test' ? `${s}.${devRoot}` : `${s}.${apex}`;
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
// against what is registered already. storefront.environment picks the one
// host of that environment (buildStorefrontDomains).
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
  // What to do about it, in one plain sentence (applePayGuidance), unless the
  // error or the note already says it.
  const guidance = String(result.guidance ?? '').trim();
  if (guidance && !String(result.error ?? '').includes(guidance) && !String(result.note ?? '').includes(guidance)) {
    lines.push({ tone: 'warn', text: guidance });
  }
  if (!lines.length) lines.push({ tone: 'info', text: 'Nothing to register.' });
  return lines;
}

// ── AUTOMATIC APPLE PAY REGISTRATION (29 Sep 2026, v5.11.17) ────────────────
// adyen-terminal-admin ensure_apple_pay_domains asks Adyen by itself, from the
// online checkout (throttled), from the go live screen (throttled) and from
// the go live flip, adyen_link and the Register for Apple Pay button (always).
// Each attempt keeps ONE row per venue and environment in platform
// adyen_webhook_events (event_key applePayStateKey, raw applePayStateFrom).

// After a refusal or an error, ask again at most this often.
export const APPLE_PAY_RETRY_MS = 6 * 60 * 60 * 1000;
// Once registered, check again at most this often (a host removed by hand in
// the Customer Area comes back by itself within a day).
export const APPLE_PAY_RECHECK_MS = 24 * 60 * 60 * 1000;
// A checkedAt this far ahead of the reader's clock still counts as now (two
// isolates never share one clock exactly); further ahead reads as bad.
export const APPLE_PAY_CLOCK_SKEW_MS = 60 * 1000;
export const APPLE_PAY_STATE_PREFIX = 'applepay_state';
// The triggers a person started: they always ask Adyen, whatever the throttle.
export const APPLE_PAY_MANUAL_TRIGGERS = Object.freeze(['admin', 'go_live', 'adyen_link']);
// The one fix ServOS cannot make in code: the Management API role on the
// credential FranPOS owns (22 Sep 2026: every Coffee Boy host was refused).
export const APPLE_PAY_PERMISSION_GUIDANCE = 'Ask FranPOS to tick Management API: Payment methods read and write on the ServOS API credential.';
// The longest guidance sentence, so it fits a go live step hint.
export const APPLE_PAY_GUIDANCE_MAX = 120;
const STATE_TEXT_MAX = 300;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const numOrNull = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isScope = (v) => Number(v) === 401 || Number(v) === 403;

// Cut a text to `max` characters, ending in '...' when it was cut.
export function clipText(value, max) {
  const s = text(value).replace(/\s+/g, ' ');
  if (!s || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// The row key: 'applepay_state:<live|test>:<platform location id>'. '' when
// either part is missing, so nothing is written under a half key.
export function applePayStateKey(env, platformLocationId) {
  const e = envWord(env);
  const id = text(platformLocationId);
  return e && id ? `${APPLE_PAY_STATE_PREFIX}:${e}:${id}` : '';
}

// Should an automatic trigger ask Adyen now? A manual trigger always does.
// Otherwise yes when there is no usable row (none, unreadable, a checkedAt
// that is not a date or is ahead of the clock), when the host or the merchant
// account changed since, when the caller read a DIFFERENT Apple Pay payment
// method than the row was kept for (paymentMethodId, when both are known),
// or when the row is older than APPLE_PAY_RECHECK_MS (registered) or
// APPLE_PAY_RETRY_MS (anything else).
export function applePayRetryDue(state, { now = Date.now(), host = '', merchant = '', trigger = '', paymentMethodId = '' } = {}) {
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

// Adyen's errorCode from a Management API refusal body, or null.
export function adyenErrorCode(data) {
  const c = isObj(data) ? data.errorCode : null;
  const s = text(c);
  return s ? s.slice(0, 40) : null;
}

// The answer's code, with a timed out call named 'timeout' (the function
// throws "Adyen did not answer ... within 15s" and the attempt keeps it as
// the error line).
export function applePayAnswerCode(answer) {
  const a = isObj(answer) ? answer : {};
  const code = text(a.code);
  if (code) return code;
  return /did not answer/i.test(text(a.error)) ? 'timeout' : '';
}

// Adyen refused ServOS's credential: 401 or 403 on the payment method list
// read, or on any host it was asked to add.
export function isPermissionRefusal(answer) {
  const a = isObj(answer) ? answer : {};
  if (text(a.code) === 'scope_missing') return true;
  if (isScope(a.status)) return true;
  return (Array.isArray(a.failed) ? a.failed : []).some((f) => isObj(f) && isScope(f.status));
}

// ONE plain sentence on what to do about an Apple Pay answer (a register
// answer or a read only probe), null when there is nothing to do.
export function applePayGuidance(answer) {
  const a = isObj(answer) ? answer : {};
  const failed = (Array.isArray(a.failed) ? a.failed : []).filter(isObj);
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

// The row kept for one attempt (platform adyen_webhook_events, raw). outcome:
//   registered     the host was on Adyen's list already
//   added          ServOS added it just now
//   refused        Adyen said no (a missing role, or a host it would not take)
//   not_requested  Apple Pay is not switched on for the merchant
//   store_scoped   Apple Pay is set up per store and this store has none
//   no_storefront  the venue has no online address to register
//   error          no usable answer (a timeout, an Adyen 5xx, missing keys)
// failures counts the attempts in a row that did not end registered.
export function applePayStateFrom(answer, { trigger = null, host = '', now = Date.now(), previous = null } = {}) {
  const a = isObj(answer) ? answer : {};
  const code = applePayAnswerCode(a);
  const failed = (Array.isArray(a.failed) ? a.failed : []).filter(isObj).slice(0, 10).map((f) => ({
    domain: clipText(f.domain, 120) || null,
    status: numOrNull(f.status),
    errorCode: text(f.errorCode) || null,
    message: clipText(f.message, STATE_TEXT_MAX) || null,
  }));
  const added = (Array.isArray(a.added) ? a.added : []).map(text).filter(Boolean).slice(0, 10);
  const hostNow = domainKey(text(host) || text(a.host));
  const registered = a.ok === true && !!hostNow && failed.length === 0 && !code;
  let outcome = 'error';
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
