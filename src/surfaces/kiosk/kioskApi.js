/**
 * kioskApi: the network reads the new kiosk design makes on top of KioskApp's own loads.
 *
 * Stage A: venue reads (currency, tables). Stage B: modifier group rules for the one tap
 * add rule. Stage C: the venue tipping row, the Challenge 21 alcohol categories, the text
 * code (loyalty-otp), the gift card lookup and the promo check. The last three call the
 * SAME edge functions today's kiosk screens call, with the same bodies; none of them
 * charges, debits or redeems anything (that stays in submitOrder). Stage D: the urgent staff
 * alert from the card screen, setting the kiosk's venue for the shared location resolver,
 * and points for a number given for points only (the same store call submitOrder makes).
 *
 * Every read resolves (never throws, never hangs): a customer must always be able to
 * order, so a failed or slow read gives the safe fallback (the keypad, the stored
 * currency). The DEV preview passes its own object with the same functions.
 */
import { getLocationConfig } from '../../lib/locationTime';
import { getActiveCurrencyCode } from '../../lib/currency';
import { fetchKioskTables, groupKioskTables } from '../../lib/kioskTables';
import { kioskTableStatus } from '../../lib/kioskFlow';
import { supabase, platformSupabase, ensureAuthToken, setResolvedLocationId } from '../../lib/supabase';
import { logActivity } from '../../lib/activity';
import { kioskOtpErrorKey } from '../../lib/kioskCheckout';
import { useStore } from '../../store';

const OPS_URL = import.meta.env.VITE_SUPABASE_URL;
const OPS_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CALL_TIMEOUT_MS = 15000;

const READ_TIMEOUT_MS = 8000;

// A plain function, never a timer stored as an object method: browsers throw
// "Illegal invocation" for that (the v5.8.56 pairing outage).
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

/**
 * The venue currency. getLocationConfig(locationId) saves it for money() and
 * stripeCurrency(), which today's kiosk never did (it asked with no id and got GBP).
 * Resolves the active currency code.
 */
export async function loadCurrency(locationId) {
  if (locationId) await withTimeout(getLocationConfig(locationId), READ_TIMEOUT_MS, null);
  return getActiveCurrencyCode();
}

/**
 * The venue's tables for the start screen: { status: 'ok'|'empty'|'failed', groups }.
 * groups is groupKioskTables output ([{ sectionId, label, tables }]).
 */
export async function loadTables(locationId) {
  const res = await withTimeout(fetchKioskTables(locationId), READ_TIMEOUT_MS, { ok: false, tables: [], sectionLabels: {} });
  const status = kioskTableStatus(res);
  return {
    status,
    groups: status === 'ok' ? groupKioskTables(res.tables, res.sectionLabels) : [],
  };
}

// Only the columns the one tap add rule reads (lib/kioskGroupRules.js normalizeGroup).
const GROUP_RULE_COLUMNS = 'id,min,max,min_select,max_select,selection_type';
const GROUP_RULE_CHUNK = 100;

/**
 * The rule columns of every modifier group the menu uses, as a Map of id to row.
 * Resolves null when any read fails or times out: then every item with modifier groups
 * opens the sheet (the safe way), so a required choice is never skipped by a quick add.
 */
export async function loadGroupRules(ids) {
  const list = Array.from(new Set((Array.isArray(ids) ? ids : []).filter(Boolean)));
  const rules = new Map();
  for (let i = 0; i < list.length; i += GROUP_RULE_CHUNK) {
    const chunk = list.slice(i, i + GROUP_RULE_CHUNK);
    const res = await withTimeout(
      supabase.from('modifier_groups').select(GROUP_RULE_COLUMNS).in('id', chunk),
      READ_TIMEOUT_MS,
      null,
    );
    if (!res || res.error || !Array.isArray(res.data)) return null;
    for (const row of res.data) if (row && row.id != null) rules.set(row.id, row);
  }
  return rules;
}

// One platform.locations column set for this venue, read on its own so a column that a
// venue's migration has not added yet only loses that one setting. null on any failure.
async function readPlatformLocation(locationId, columns) {
  if (!locationId || !platformSupabase) return null;
  const res = await withTimeout(
    platformSupabase.from('locations').select(columns)
      .or(`ops_location_id.eq.${locationId},id.eq.${locationId}`)
      .limit(1).maybeSingle(),
    READ_TIMEOUT_MS,
    null,
  );
  if (!res || res.error || !res.data) return null;
  return res.data;
}

/**
 * The venue's tipping row ({ tipping_config }) for lib/tipping.js kioskTipRule.
 * Resolves { ok: true, row } or { ok: false } (then the kiosk uses its profile presets).
 */
export async function loadTipping(locationId) {
  const row = await readPlatformLocation(locationId, 'tipping_config');
  return row ? { ok: true, row } : { ok: false, row: null };
}

/** The Challenge 21 alcohol category ids ticked for this venue ([] when none, switched off or unreadable). */
export async function loadAlcoholCategoryIds(locationId) {
  const row = await readPlatformLocation(locationId, 'challenge_21_enabled, challenge_21_alcohol_category_ids');
  // Challenge 21 switched off means no ID reminder, the same rule the staff tickets use.
  if (!row?.challenge_21_enabled) return [];
  return Array.isArray(row?.challenge_21_alcohol_category_ids) ? row.challenge_21_alcohol_category_ids : [];
}

// POST to an Ops edge function. Resolves { httpOk, status, body } or { networkError: true };
// never throws and never hangs past CALL_TIMEOUT_MS.
async function postFunction(name, body, { bearer } = {}) {
  const run = async () => {
    const token = bearer || (await ensureAuthToken().catch(() => null));
    if (!token) return { networkError: true };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    if (bearer && OPS_ANON) headers.apikey = OPS_ANON;
    const res = await fetch(`${OPS_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { httpOk: res.ok, status: res.status, body: json };
  };
  return withTimeout(run(), CALL_TIMEOUT_MS, { networkError: true });
}

/**
 * Text a 6 digit code (loyalty-otp send, as ScreenLoyalty). phone is E.164.
 * Resolves { ok: true } or { errorKey }.
 */
export async function sendOtp({ phone, companyId, locationId }) {
  if (!companyId) return { errorKey: 'k2.otp.notSetUp' };
  const r = await postFunction('loyalty-otp', { action: 'send', phone, company_id: companyId, location_id: locationId }, { bearer: OPS_ANON });
  if (r.networkError) return { errorKey: 'k2.otp.failed' };
  if (!r.httpOk) return { errorKey: kioskOtpErrorKey({ action: 'send', status: r.status, body: r.body }) };
  return { ok: true };
}

/**
 * Check the code (loyalty-otp verify, as ScreenLoyalty).
 * Resolves { data } (the verify body; the screens never show its personal details) or { errorKey }.
 */
export async function verifyOtp({ phone, companyId, code }) {
  const r = await postFunction('loyalty-otp', { action: 'verify', phone, company_id: companyId, code }, { bearer: OPS_ANON });
  if (r.networkError) return { errorKey: 'k2.otp.failed' };
  if (!r.httpOk) return { errorKey: kioskOtpErrorKey({ action: 'verify', status: r.status, body: r.body }) };
  if (!r.body?.verified) return { errorKey: 'k2.otp.wrong' };
  return { data: r.body };
}

/** gift-lookup (read only). code: the 16 character code. Resolves { httpOk, body } or { networkError }. */
export async function lookupGift({ code, locationId }) {
  return postFunction('gift-lookup', { code, location_id: locationId });
}

/**
 * promo-redeem validate (no write). The basket basis is the goods subtotal, the same
 * basketValue submitOrder commits the code with.
 */
export async function validatePromo({ code, locationId, customerId = null, subtotal = 0 }) {
  return postFunction('promo-redeem', {
    action: 'validate', code, location_id: locationId, customer_id: customerId || null, basket: { subtotal },
  });
}

/**
 * Stage D: the staff only alert when the card screen asks the customer to fetch staff.
 * An urgent activity event, which the tills show and chime (lib/activity.js). Best effort:
 * it never throws and never holds the screen.
 */
export async function logStaffAlert(locationId, alert) {
  if (!locationId || !alert?.title) return { ok: false };
  const r = await withTimeout(logActivity(locationId, alert), READ_TIMEOUT_MS, { ok: false });
  if (!r?.ok) console.warn('[kiosk] staff alert not logged:', r?.error || 'timed out', alert.body);
  return r || { ok: false };
}

/**
 * Stage D (D6): tell the shared location resolver which venue this kiosk belongs to, so
 * the CRM and points writes (store attributeOrderToCustomer, upsertCustomer) can find the
 * venue on a kiosk (F3). The kiosk pairing keys are kept by the tenant fence
 * (supabase.js TENANT_FENCE_KEEP), so this can never unpair the kiosk.
 */
export function adoptLocation(locationId) {
  if (!locationId) return;
  try { setResolvedLocationId(locationId); } catch (e) { console.warn('[kiosk] could not set the venue:', e?.message || e); }
}

/**
 * Decision 9: whether new design kiosk orders may create a CRM customer, earn points and send
 * the welcome text. 'off' when points are switched off at this kiosk, so a number given only
 * for the ready text stays out of the CRM (store attributeOrderToCustomer reads it). Only the
 * new design ever sets it; today's kiosk leaves it unset and behaves as before.
 */
export function setAttributionPolicy(policy) {
  try {
    useStore.setState({ kioskV2AttributionPolicy: policy === 'off' ? 'off' : 'points' });
  } catch (e) { console.warn('[kiosk] could not set the attribution policy:', e?.message || e); }
}

/**
 * Stage D: points for a number given for points only (build spec 3.10 and 4.4). The SAME
 * store call submitOrder makes when it is given a phone; fire and forget, never throws.
 * orderRecord comes from lib/kioskCheckout.js kioskAttributionRecord.
 */
export async function attributePointsOrder({ customer, orderRecord }) {
  try {
    const run = useStore.getState().attributeOrderToCustomer;
    if (typeof run !== 'function') return null;
    return await run({ customer, orderRecord });
  } catch (e) {
    console.warn('[kiosk] points attribution failed:', e?.message || e);
    return null;
  }
}

/**
 * The venue's menu translations for one language (lib/menuText.js). The rows are public
 * reads like menu_items. null on any failure, and the kiosk then stays in English for the
 * venue text while the screen text still follows the picked language.
 */
export async function loadMenuTranslations(locationId, lang) {
  if (!locationId || !lang || lang === 'en') return [];
  const res = await withTimeout(
    supabase.from('menu_translations').select('entity_type,entity_id,text').eq('location_id', locationId).eq('lang', lang),
    READ_TIMEOUT_MS,
    null,
  );
  if (!res || res.error || !Array.isArray(res.data)) return null;
  return res.data;
}

// No loadModifierGroups here: on a real kiosk the item sheet reads modifier_groups itself,
// exactly as today's item screen does. The DEV preview passes one with sample data.
const kioskApi = {
  loadCurrency, loadTables, loadGroupRules, loadTipping, loadAlcoholCategoryIds, loadMenuTranslations,
  sendOtp, verifyOtp, lookupGift, validatePromo,
  logStaffAlert, adoptLocation, attributePointsOrder, setAttributionPolicy,
};
export default kioskApi;
