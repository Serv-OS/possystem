/**
 * adyenLink.js: pull a venue's Adyen ids from Adyen BY REFERENCE (the venue
 * code, for example SV-1007), never typed. PURE: no network, no Supabase,
 * no Deno.
 *
 * MIRROR: supabase/functions/_shared/adyenLink.ts carries the SAME helpers
 * (Deno cannot import from src/). KEEP IN SYNC: change both or neither.
 * adyenLink.test.js is the contract for both copies.
 *
 * WHY (owner rules, 8 Sep 2026): Adyen already holds the venue's store,
 * balance account and account holder, created by FranPOS or Adyen with the
 * venue code as the STORE REFERENCE. The admin portal must pull the ids from
 * Adyen by that reference, never type them. The chain is four reads across
 * three Adyen APIs (adyen-terminal-admin adyen_lookup and adyen_link):
 *   1. Management API v3    GET /merchants/{m}/stores?reference=SV-1007
 *        store id (ST...), status, businessLineIds, splitConfiguration
 *        { balanceAccountId, splitConfigurationId }
 *   2. Balance Platform v2  GET /balanceAccounts/{id}     accountHolderId (AH...)
 *   3. Balance Platform v2  GET /accountHolders/{id}      legalEntityId (LE...),
 *        capabilities (the receive_payments_ok and payouts_ok truth),
 *        primaryBalanceAccount
 *   4. LEM v4               GET /legalEntities/{id}       legal name, capability
 *        verification, transferInstruments[] (SI...)
 * There is no account holder lookup by reference, so the store's split
 * configuration is the only documented path from a venue code to a balance
 * account. When the store carries none, a known account holder id plus
 * GET /accountHolders/{id}/balanceAccounts is the fallback (pickBalanceAccount).
 *
 * THE VENUE CODE IS NOT ALWAYS A STORE REFERENCE (8 Sep 2026, live screens):
 * on the live account SV-1007 is the ACCOUNT HOLDER reference and no store
 * carries it, so the lookup also sweeps every merchant the credential can
 * see and matches account holders by reference. See FIND THE VENUE HOWEVER
 * ADYEN HOLDS IT further down for those endpoints and the merchant mismatch
 * rule.
 *
 * Everything here is shape work on Adyen's answers and on the
 * merchant_adyen_accounts row: matching the store, summarising capabilities,
 * building the row patch and deciding whether a link is a no op, a refusal
 * or a write.
 */

// The merchant_adyen_accounts columns a link writes, in display order.
export const LINK_ID_FIELDS = Object.freeze([
  'merchant_account', 'store_id', 'split_profile_id', 'balance_account_id',
  'account_holder_id', 'legal_entity_id', 'business_line_id', 'transfer_instrument_id',
]);

// Adyen capability verificationStatus values, best first. The worst wins.
export const VERIFICATION_ORDER = Object.freeze(['valid', 'pending', 'invalid', 'rejected']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const lower = (v) => str(v).toLowerCase();
const orNull = (v) => str(v) || null;
// The US secret set (adyenEnv's US_CODES); anything else reads as UK, as it
// does everywhere else. Only used to build a secret NAME here.
const isUsRegion = (v) => ['US', 'USA', 'USD'].includes(str(v).toUpperCase());

// Comparison key for a store reference: trimmed, upper case. Adyen keeps the
// case the creator typed and the venue code is upper case by convention, so
// SV-1007 and sv-1007 are the same venue.
export function referenceKey(value) {
  return str(value).toUpperCase();
}

// The rows of a Management API list answer ({ data: [...] }) or a bare array.
// Anything that is not an object row is dropped.
export function storeRows(response) {
  if (Array.isArray(response)) return response.filter(isObj);
  return Array.isArray(response?.data) ? response.data.filter(isObj) : [];
}

// Find the venue's store by reference: EXACT match, case insensitive, never
// partial. Duplicate rows (a page repeated) collapse by id. More than one
// distinct store with the reference is `ambiguous` (the reference is unique
// inside a merchant account only, so a credential wide search can return
// one per merchant): then `store` is null and the caller picks by id.
export function matchStoreByReference(rows, reference) {
  const key = referenceKey(reference);
  if (!key) return { store: null, matches: [], ambiguous: false };
  const seen = new Set();
  const matches = [];
  for (const s of storeRows(rows)) {
    if (referenceKey(s.reference) !== key) continue;
    const id = str(s.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    matches.push(s);
  }
  return { store: matches.length === 1 ? matches[0] : null, matches, ambiguous: matches.length > 1 };
}

// A store as the admin sees it: the ids and the fields that tell one store
// from another. Status is lower cased (active | inactive | closed).
export function storeSummary(store) {
  if (!isObj(store)) return null;
  const split = isObj(store.splitConfiguration) ? store.splitConfiguration : {};
  const a = isObj(store.address) ? store.address : {};
  const address = {};
  for (const k of ['line1', 'line2', 'line3', 'city', 'postalCode', 'stateOrProvince', 'country']) {
    const v = str(a[k]);
    if (v) address[k] = v;
  }
  return {
    id: orNull(store.id),
    reference: orNull(store.reference),
    status: lower(store.status) || null,
    description: orNull(store.description),
    shopperStatement: orNull(store.shopperStatement),
    merchantId: orNull(store.merchantId),
    phoneNumber: orNull(store.phoneNumber),
    address: Object.keys(address).length ? address : null,
    businessLineIds: Array.isArray(store.businessLineIds) ? store.businessLineIds.map(str).filter(Boolean) : [],
    splitConfigurationId: orNull(split.splitConfigurationId),
    balanceAccountId: orNull(split.balanceAccountId),
  };
}

// The stores the admin may pick from when the reference matched nothing:
// exact reference matches first (there should be none, or the caller would
// not be here), then stores whose reference or description mentions the
// reference, then the rest in Adyen's order. Deduped by id, at most `limit`.
export function storeCandidates(rows, reference, limit = 50) {
  const key = referenceKey(reference);
  const seen = new Set();
  const out = [];
  for (const s of storeRows(rows)) {
    const id = str(s.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      reference: orNull(s.reference),
      description: orNull(s.description) || orNull(s.shopperStatement),
      status: lower(s.status) || null,
      merchantId: orNull(s.merchantId),
    });
  }
  const score = (c) => {
    if (!key) return 2;
    const r = referenceKey(c.reference);
    if (r === key) return 0;
    if ((r && r.includes(key)) || referenceKey(c.description).includes(key)) return 1;
    return 2;
  };
  return out
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((x) => x.c);
}

// The worst of several capability verification statuses (rejected beats
// invalid beats pending beats valid); null when none is a known status.
export function worstVerificationStatus(statuses) {
  let worst = -1;
  for (const s of Array.isArray(statuses) ? statuses : []) {
    const i = VERIFICATION_ORDER.indexOf(lower(s));
    if (i > worst) worst = i;
  }
  return worst < 0 ? null : VERIFICATION_ORDER[worst];
}

// One readable line per Adyen problem ({ entity, verificationErrors: [{
// code, message, remediatingActions }] }), prefixed with the capability.
function problemLines(prefix, problem) {
  const errors = Array.isArray(problem?.verificationErrors) ? problem.verificationErrors : [];
  const texts = errors.map((e) => str(e?.message) || str(e?.code)).filter(Boolean);
  if (!texts.length) {
    const single = str(problem?.message) || str(problem?.code);
    if (single) texts.push(single);
  }
  if (!texts.length) return [];
  return [`${prefix}: ${texts.join('; ')}`];
}

// The capabilities map of an account holder or a legal entity (keyed by
// name: receivePayments, receiveFromPlatformPayments, sendToTransferInstrument,
// ...) as the flags the row needs plus a per capability snapshot in the same
// shape adyen-onboard and adyen-bp-webhook store under verification_status.
//   receiveOk   receivePayments or receiveFromPlatformPayments allowed
//   payoutsOk   sendToTransferInstrument allowed (THE payout gate)
//   verificationStatus  the worst status across the capabilities that were
//               requested (an unrequested one says nothing)
//   problems    readable lines, capability first
export function summariseCapabilities(capabilities) {
  const c = isObj(capabilities) ? capabilities : {};
  const byName = {};
  const problems = [];
  const statuses = [];
  for (const [name, v] of Object.entries(c)) {
    if (!isObj(v)) continue;
    const raw = Array.isArray(v.problems) ? v.problems : [];
    byName[name] = {
      enabled: v.enabled ?? null,
      allowed: v.allowed ?? null,
      requested: v.requested ?? null,
      verificationStatus: lower(v.verificationStatus) || null,
      problems: raw.length ? raw : undefined,
    };
    if (v.requested !== false) statuses.push(v.verificationStatus);
    for (const p of raw) problems.push(...problemLines(name, p));
  }
  const allowed = (k) => byName[k]?.allowed === true;
  return {
    receiveOk: allowed('receivePayments') || allowed('receiveFromPlatformPayments'),
    payoutsOk: allowed('sendToTransferInstrument'),
    verificationStatus: worstVerificationStatus(statuses),
    problems,
    byName,
  };
}

// The display name of a legal entity: the organisation's legal name, else
// the individual's name, else a sole proprietorship's or trust's name, else
// the reference.
export function legalEntityName(le) {
  if (!isObj(le)) return null;
  const org = str(le.organization?.legalName);
  if (org) return org;
  const ind = isObj(le.individual?.name) ? le.individual.name : {};
  const person = [str(ind.firstName), str(ind.lastName)].filter(Boolean).join(' ');
  if (person) return person;
  const sole = str(le.soleProprietorship?.name);
  if (sole) return sole;
  const trust = str(le.trust?.name);
  if (trust) return trust;
  return orNull(le.reference);
}

// GET /legalEntities/{id} as the admin sees it: name, type, the worst
// verification status across its capabilities, its bank accounts (transfer
// instruments, SI...) and every problem line.
export function legalEntitySummary(le) {
  if (!isObj(le)) return null;
  const caps = summariseCapabilities(le.capabilities);
  const instruments = (Array.isArray(le.transferInstruments) ? le.transferInstruments : [])
    .map((t) => str(isObj(t) ? t.id : t)).filter(Boolean);
  const problems = [...caps.problems];
  for (const p of Array.isArray(le.problems) ? le.problems : []) problems.push(...problemLines('legalEntity', p));
  return {
    id: orNull(le.id),
    name: legalEntityName(le),
    type: orNull(le.type),
    reference: orNull(le.reference),
    status: caps.verificationStatus,
    transferInstrumentId: instruments[0] ?? null,
    transferInstruments: instruments,
    problems,
    capabilities: caps.byName,
  };
}

// GET /accountHolders/{id} as the admin sees it, capabilities summarised.
export function accountHolderSummary(ah) {
  if (!isObj(ah)) return null;
  return {
    id: orNull(ah.id),
    reference: orNull(ah.reference),
    description: orNull(ah.description),
    status: lower(ah.status) || null,
    legalEntityId: orNull(ah.legalEntityId),
    primaryBalanceAccount: orNull(ah.primaryBalanceAccount),
    balancePlatform: orNull(ah.balancePlatform),
    capabilities: summariseCapabilities(ah.capabilities),
  };
}

// GET /balanceAccounts/{id} as the admin sees it. `source` says how it was
// reached: 'store' (the store's split configuration named it) or
// 'account_holder' (picked from the holder's balance accounts).
export function balanceAccountSummary(ba, source = 'store') {
  if (!isObj(ba)) return null;
  return {
    id: orNull(ba.id),
    reference: orNull(ba.reference),
    description: orNull(ba.description),
    status: lower(ba.status) || null,
    accountHolderId: orNull(ba.accountHolderId),
    currency: str(ba.defaultCurrencyCode).toUpperCase() || null,
    source,
  };
}

// The balance account to link when the store names none: the holder's
// primary balance account, else the one open account in the region's
// currency, else the only account there is. Several with no way to choose
// is null (the admin picks). Takes GET /accountHolders/{id}/balanceAccounts
// ({ balanceAccounts: [...] }) or a bare array.
export function pickBalanceAccount(list, { primaryId, currency } = {}) {
  const rows = (Array.isArray(list?.balanceAccounts) ? list.balanceAccounts : Array.isArray(list) ? list : []).filter(isObj);
  if (!rows.length) return null;
  const pid = str(primaryId);
  const primary = pid ? rows.find((b) => str(b.id) === pid) : null;
  if (primary) return primary;
  const cur = str(currency).toUpperCase();
  const open = rows.filter((b) => lower(b.status) !== 'closed');
  if (cur) {
    const inCurrency = open.filter((b) => str(b.defaultCurrencyCode).toUpperCase() === cur);
    if (inCurrency.length === 1) return inCurrency[0];
    if (inCurrency.length > 1) return null;
  }
  return open.length === 1 ? open[0] : rows.length === 1 ? rows[0] : null;
}

// Which environment a lookup or link targets: LIVE, always, except that a
// venue still on test may look at (and link) the test account when the
// admin asks for it explicitly. A live venue never links test ids.
export function resolveLinkEnvironment(currentEnv, requested) {
  const cur = lower(currentEnv) === 'live' ? 'live' : 'test';
  return cur === 'test' && lower(requested) === 'test' ? 'test' : 'live';
}

// The merchant_adyen_accounts patch for a lookup answer ({ reference, store,
// balanceAccount, accountHolder, legalEntity, splitConfigurationId,
// businessLineIds } as the summaries above build them). ONLY resolved ids
// ride: a piece the chain did not reach is left out, so a relink never
// blanks a stored id with nothing (the environment flip clears ids itself).
//   receive_payments_ok  the store is active (a store is what a payment names)
//   payouts_ok           the account holder may send to its bank
//   verification_status  the snapshot adyen-onboard and the webhook also write
export function buildLinkPatch(lookup, { merchantAccount, region, environment, at } = {}) {
  const l = isObj(lookup) ? lookup : {};
  const store = isObj(l.store) ? l.store : null;
  const ba = isObj(l.balanceAccount) ? l.balanceAccount : null;
  const ah = isObj(l.accountHolder) ? l.accountHolder : null;
  const le = isObj(l.legalEntity) ? l.legalEntity : null;
  const patch = {};
  const merchant = str(merchantAccount) || str(store?.merchantId);
  if (merchant) patch.merchant_account = merchant;
  if (str(store?.id)) patch.store_id = str(store.id);
  const split = str(l.splitConfigurationId) || str(store?.splitConfigurationId);
  if (split) patch.split_profile_id = split;
  const baId = str(ba?.id) || str(store?.balanceAccountId);
  if (baId) patch.balance_account_id = baId;
  const ahId = str(ah?.id) || str(ba?.accountHolderId);
  if (ahId) patch.account_holder_id = ahId;
  const leId = str(le?.id) || str(ah?.legalEntityId);
  if (leId) patch.legal_entity_id = leId;
  const lines = Array.isArray(l.businessLineIds) && l.businessLineIds.length ? l.businessLineIds : (store?.businessLineIds ?? []);
  const line = str(Array.isArray(lines) ? lines[0] : '');
  if (line) patch.business_line_id = line;
  const instrument = str(le?.transferInstrumentId) || str(Array.isArray(le?.transferInstruments) ? le.transferInstruments[0] : '');
  if (instrument) patch.transfer_instrument_id = instrument;
  // A CARD PAYMENT NAMES A STORE AND NOTHING ELSE (8 Sep 2026). With a store
  // the flag is its status; with an account holder and NO store the flag is
  // FALSE, written out loud, so a venue linked on its business account alone
  // never reads as ready to take cards (storeStillNeeded says why in words).
  if (store) patch.receive_payments_ok = lower(store.status) === 'active';
  else if (ah?.id) patch.receive_payments_ok = false;
  if (ah && isObj(ah.capabilities)) {
    patch.payouts_ok = ah.capabilities.payoutsOk === true;
    patch.verification_status = {
      source: 'adyen_link',
      at: str(at) || new Date().toISOString(),
      reference: orNull(l.reference),
      accountHolderStatus: ah.status ?? null,
      verificationStatus: ah.capabilities.verificationStatus ?? null,
      capabilities: isObj(ah.capabilities.byName) ? ah.capabilities.byName : null,
      legalEntity: le ? { id: le.id ?? null, name: le.name ?? null, status: le.status ?? null } : null,
    };
  }
  if (str(region)) patch.region = str(region);
  if (str(environment)) patch.environment = lower(environment) === 'live' ? 'live' : 'test';
  return patch;
}

// The stored row against the patch, id field by id field (only the fields
// the patch carries). `changed` differ, `conflicts` differ AND the row
// already holds a value (linking would replace a real id), `same` agree.
// Adyen ids compare exactly; the merchant account name compares case
// insensitively (Adyen treats it so).
export function linkDiff(row, patch) {
  const r = isObj(row) ? row : {};
  const p = isObj(patch) ? patch : {};
  const changed = [];
  const conflicts = [];
  const same = [];
  for (const k of LINK_ID_FIELDS) {
    if (!(k in p)) continue;
    const next = str(p[k]);
    const cur = str(r[k]);
    const equal = k === 'merchant_account' ? next.toLowerCase() === cur.toLowerCase() : next === cur;
    if (equal) same.push(k);
    else {
      changed.push(k);
      if (cur) conflicts.push({ field: k, current: cur, next });
    }
  }
  return { changed, conflicts, same, unchanged: changed.length === 0 };
}

// What a link must do, given the row, the environments and the patch:
//   noop    same environment and every id agrees: nothing to write
//   refuse  same environment but a stored id would be replaced; the venue
//           moves environments while its store or readers were set up on the
//           current one; or the target is LIVE and the store is not active at
//           Adyen, which is NOT the same as having no store at all (a venue
//           held as a business account only links fine). Linking would flip
//           the venue live, clear its working test
//           readers and leave it on a store Adyen refuses payments for). All
//           three need `relink` (the admin's explicit yes)
//   update  same environment, blanks filled or relink confirmed
//   flip    environment change (set_environment's rules apply, ids ride along)
// The reasons are shown to the admin as they are, so they read as plain
// words ("confirm"), never as API instructions. `storeStatus` is the store's
// status as the lookup read it, for the wording only: the decision reads
// patch.receive_payments_ok (false when the store was found and not active).
export function planLink({ row, currentEnv, targetEnv, patch, provisioned = [], readers = 0, relink = false, storeStatus = null } = {}) {
  const diff = linkDiff(row, patch);
  const p = isObj(patch) ? patch : {};
  const cur = lower(currentEnv) === 'live' ? 'live' : 'test';
  const next = lower(targetEnv) === 'live' ? 'live' : 'test';
  const sameEnv = cur === next;
  if (sameEnv && diff.unchanged) return { kind: 'noop', diff, reason: 'This venue is already linked to these Adyen ids.' };
  // A store that EXISTS and is not active stops a live link: the venue would
  // flip live onto a store Adyen refuses payments for. NO store at all is a
  // different thing and is allowed (8 Sep 2026): a venue Adyen holds as a
  // business account only is linked so its account holder, balance account,
  // legal entity and business line ids land on the row, and storeStillNeeded
  // says in plain words that a store comes before card payments route.
  if (next === 'live' && p.receive_payments_ok === false && str(p.store_id) && relink !== true) {
    const status = lower(storeStatus) || 'not active';
    return { kind: 'refuse', diff, reason: `The store ${str(p.store_id)} is ${status} at Adyen, so payments naming it are refused. Link it once it is active, or confirm to link it anyway.` };
  }
  if (sameEnv && diff.conflicts.length && relink !== true) {
    const fields = diff.conflicts.map((c) => `${c.field} ${c.current} to ${c.next}`).join(', ');
    return { kind: 'refuse', diff, reason: `This venue is already linked on ${next} to different Adyen ids (${fields}). Confirm to replace them.` };
  }
  const setup = [
    Array.isArray(provisioned) && provisioned.length ? 'payments store' : '',
    Number(readers) > 0 ? `${Number(readers)} card reader${Number(readers) === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (!sameEnv && setup.length && relink !== true) {
    const verb = setup.length > 1 || Number(readers) > 1 ? 'were' : 'was';
    return { kind: 'refuse', diff, reason: `This venue's ${setup.join(' and ')} ${verb} set up on the ${cur} system. Linking to ${next} clears that setup (register the readers again afterwards). Confirm to go ahead.` };
  }
  return { kind: sameEnv ? 'update' : 'flip', diff, reason: null };
}

// The clear that rides with a CONFIRMED replacement on the same environment
// (plan 'update' with conflicts, relink given): every link id the chain did
// not reach is nulled, and the payout flag, the verification snapshot and
// the hosted onboarding link (all the OLD account holder's) are reset. The
// same list flipEnvironment clears. Without it the row would name the new
// balance account with the old legal entity's bank account whenever the new
// legal entity has no bank account yet, the store has no split
// configuration or the account holder read was refused. A first link (no
// conflicts) keeps buildLinkPatch's rule: an unreached piece is left alone.
// Spread it UNDER the patch: { ...replacementClear(patch), ...patch }.
export function replacementClear(patch) {
  const p = isObj(patch) ? patch : {};
  const clear = {};
  for (const k of LINK_ID_FIELDS) if (!(k in p)) clear[k] = null;
  if (!('receive_payments_ok' in p)) clear.receive_payments_ok = false;
  if (!('payouts_ok' in p)) clear.payouts_ok = false;
  if (!('verification_status' in p)) clear.verification_status = null;
  clear.onboarding_link_url = null;
  clear.onboarding_link_expires_at = null;
  return clear;
}

// The admin's one line summary of a lookup: what was found, what was not.
// A venue may be held as a STORE, as an ACCOUNT HOLDER, or as both (8 Sep
// 2026: SV-1007 is the account holder reference on the live account and no
// store carries it), so either one counts as found and the other reads as
// the gap it is.
export function lookupSummary(lookup) {
  const l = isObj(lookup) ? lookup : {};
  const ref = str(l.reference) || 'no reference';
  const store = isObj(l.store) && str(l.store.id) ? l.store : null;
  const ah = isObj(l.accountHolder) && str(l.accountHolder.id) ? l.accountHolder : null;
  if (!store && !ah) {
    const n = Array.isArray(l.candidates) ? l.candidates.length : 0;
    return `No store or account holder with reference ${ref} on ${str(l.merchantAccount) || 'the merchant account'}${n ? ` (${n} store${n === 1 ? '' : 's'} listed to pick from)` : ''}.`;
  }
  const parts = [store ? `store ${store.id}${store.status ? ` (${store.status})` : ''}` : 'NO store yet'];
  parts.push(isObj(l.balanceAccount) && l.balanceAccount.id ? `balance account ${l.balanceAccount.id}` : 'no balance account');
  parts.push(ah ? `account holder ${ah.id}${ah.status ? ` (${ah.status})` : ''}` : 'no account holder');
  parts.push(isObj(l.legalEntity) && l.legalEntity.id ? `legal entity ${l.legalEntity.name || l.legalEntity.id}` : 'no legal entity');
  return `Found ${ref}: ${parts.join(', ')}.`;
}

// ── FIND THE VENUE HOWEVER ADYEN HOLDS IT (8 Sep 2026, live screens) ─────────
// The store-first chain above assumed the venue code is a STORE reference. On
// the live account it is not: SV-1007 is the ACCOUNT HOLDER reference
// (AH32BZP22322CJ5PXF2BD5FTR, legal entity POINT OF SALE UNIFIED PARTNERS
// LIMITED, active, one capability blocked), the store search on
// FranPOS_QSR_UK (the value of ADYEN_LIVE_UK_MERCHANT_ACCOUNT) found 0
// stores, and the Adyen row for that account holder names a DIFFERENT
// merchant account, FranPOS_UK. So the venue is onboarded on the Balance
// Platform first and its store either sits under another merchant account or
// does not exist yet.
//
// A lookup therefore runs TWO routes and merges them (endpoints verified on
// docs.adyen.com and against the Adyen OpenAPI specs, 8 Sep 2026):
//   STORE route   Management v3 GET /stores?reference=X (credential wide, the
//                 merchantId filter is optional), then GET /merchants (paged,
//                 role "Account read") and GET /merchants/{m}/stores?reference=X
//                 per merchant, so a store on ANOTHER merchant is found.
//   HOLDER route  Balance Platform v2 GET /accountHolders/{id} for a pasted
//                 AH id, else GET /balancePlatforms/{bp}/accountHolders
//                 (offset/limit paging, max 100 a page) matched on reference.
//                 There is NO /accountHolders list endpoint and NO reference
//                 filter anywhere on the Balance Platform Configuration API,
//                 so the balance platform id is the only way in: it comes
//                 from an account holder or balance account already on the
//                 row, from a pasted id, or from the secret named by
//                 balancePlatformSecretName below.
// Neither the account holder nor the balance account names a merchant
// account or a store (AccountHolder carries balancePlatform, reference,
// status, capabilities, legalEntityId and primaryBalanceAccount, nothing
// else), so the merchant a venue charges on can only come from the store or
// from the admin. A store found on a merchant that is not the configured one
// is never used silently: merchantMismatch says so, and the admin passes
// merchantAccount to link it there on purpose.

export const BALANCE_PLATFORM_SECRET_SUFFIX = 'BALANCE_PLATFORM';

// The secret that would hold the balance platform id (BP...). It does not
// exist yet: ADYEN_SECRET_SUFFIXES has no such field, so the name is built
// here under the SAME rule adyenSecretName follows (test is unprefixed, live
// carries the region, live UK falls back to the unsuffixed name).
export function balancePlatformSecretName(env, region) {
  const s = BALANCE_PLATFORM_SECRET_SUFFIX;
  if (lower(env) !== 'live') return `ADYEN_${s}`;
  return `ADYEN_LIVE_${isUsRegion(region) ? 'US' : 'UK'}_${s}`;
}

// Every name read for the balance platform id, in read order.
export function balancePlatformSecretNames(env, region) {
  const s = BALANCE_PLATFORM_SECRET_SUFFIX;
  if (lower(env) !== 'live') return isUsRegion(region) ? [`ADYEN_TEST_US_${s}`, `ADYEN_${s}`] : [`ADYEN_${s}`];
  return isUsRegion(region) ? [`ADYEN_LIVE_US_${s}`] : [`ADYEN_LIVE_UK_${s}`, `ADYEN_LIVE_${s}`];
}

// Rows of a Management API list answer ({ data: [...] }) or a bare array:
// GET /merchants answers the same shape as the store lists.
export function merchantRows(response) {
  return storeRows(response);
}

// Rows of a Balance Platform paged answer ({ accountHolders: [...] }) or a
// bare array. Anything that is not an object row is dropped.
export function accountHolderRows(response) {
  if (Array.isArray(response)) return response.filter(isObj);
  return Array.isArray(response?.accountHolders) ? response.accountHolders.filter(isObj) : [];
}

// A GET /merchants row as the admin picker shows it. Adyen's own casing is
// kept on `status` (Active, PreActive, Inactive, Closed): it is shown as a
// word, never compared. `storeCount` is filled in by the caller (one
// GET /merchants/{m}/stores?pageSize=1 answers itemsTotal).
export function merchantSummary(merchant) {
  if (!isObj(merchant)) return null;
  return {
    id: orNull(merchant.id),
    name: orNull(merchant.name),
    reference: orNull(merchant.reference),
    status: orNull(merchant.status),
    description: orNull(merchant.description),
    companyId: orNull(merchant.companyId),
    currency: str(merchant.primarySettlementCurrency).toUpperCase() || null,
  };
}

// The account holder whose reference IS the venue code: EXACT match, case
// insensitive, on `reference` and on `migratedAccountHolderCode` (a holder
// migrated from the classic integration keeps its old code there).
// Duplicates collapse by id; more than one distinct holder is `ambiguous`
// and the admin picks by pasting the id.
export function matchAccountHolderByReference(rows, reference) {
  const key = referenceKey(reference);
  if (!key) return { holder: null, matches: [], ambiguous: false };
  const seen = new Set();
  const matches = [];
  for (const ah of accountHolderRows(rows)) {
    if (referenceKey(ah.reference) !== key && referenceKey(ah.migratedAccountHolderCode) !== key) continue;
    const id = str(ah.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    matches.push(ah);
  }
  return { holder: matches.length === 1 ? matches[0] : null, matches, ambiguous: matches.length > 1 };
}

// The account holders the admin may pick from when the reference matched
// none: exact matches first, then a reference, code or description that
// mentions it, then the rest in Adyen's order. Deduped by id, at most `limit`.
export function accountHolderCandidates(rows, reference, limit = 50) {
  const key = referenceKey(reference);
  const seen = new Set();
  const out = [];
  for (const ah of accountHolderRows(rows)) {
    const id = str(ah.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      reference: orNull(ah.reference) || orNull(ah.migratedAccountHolderCode),
      description: orNull(ah.description),
      status: lower(ah.status) || null,
      legalEntityId: orNull(ah.legalEntityId),
      balancePlatform: orNull(ah.balancePlatform),
    });
  }
  const score = (c) => {
    if (!key) return 2;
    const r = referenceKey(c.reference);
    if (r === key) return 0;
    if ((r && r.includes(key)) || referenceKey(c.description).includes(key)) return 1;
    return 2;
  };
  return out
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((x) => x.c);
}

// ── OUR OWN ADYEN IDS, KEPT PER ENVIRONMENT AND REGION (8 Sep 2026) ─────────
// The Balance Platform Configuration API has NO filter by reference, and the
// ONLY account holder listing is under a balance platform id:
//   GET /balancePlatforms/{id}/accountHolders?limit=100&offset=N   max 100 a page
//     https://docs.adyen.com/api-explorer/balanceplatform/2/get/balancePlatforms/_id_/accountHolders
//   GET /accountHolders/{id}   answers the holder INCLUDING its balancePlatform
//     https://docs.adyen.com/api-explorer/balanceplatform/2/get/accountHolders/_id_
// So the FIRST venue on an Adyen account is linked by pasting its account
// holder id once. That one read hands us the balance platform id; we keep it
// in the platform table adyen_platform_settings (the migration named below),
// and EVERY VENUE AFTER IT IS FOUND BY ITS REFERENCE on its own.
//
// The same row keeps the merchant account codes a credential can see, so the
// admin portal can draw its account picker with no live call. Both are IDS,
// not secrets, which is why they live in a table and not in a secret.
export const ADYEN_PLATFORM_SETTINGS_TABLE = 'adyen_platform_settings';
export const ADYEN_PLATFORM_SETTINGS_MIGRATION = 'supabase/migrations/20260908c_PLATFORM_adyen_platform_settings.sql';
// The venue row's own copy of the same id (the column the migration adds).
export const ADYEN_ROW_BALANCE_PLATFORM_COLUMN = 'balance_platform_id';
// A guard on the kept list, never a limit anybody would meet: a credential
// with more merchant accounts than this keeps the first ones it saw.
export const MERCHANT_ACCOUNTS_KEPT = 200;

// The primary key of the settings row for an environment and a region, in the
// exact words the database holds ('test' | 'live', 'UK' | 'US'). A legacy 'EU'
// reads as UK, as it does everywhere else.
export function platformSettingsKey(env, region) {
  return { environment: lower(env) === 'live' ? 'live' : 'test', region: isUsRegion(region) ? 'US' : 'UK' };
}

// Merchant accounts as the settings row keeps them: { id, name, status }, in
// the order given, deduped case insensitively (Adyen compares codes that way).
// A bare string is taken as an id, so a list of codes works too.
export function merchantAccountsSeen(list) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(list) ? list : []) {
    const row = isObj(m) ? m : { id: m };
    const id = str(row.id) || str(row.code) || str(row.merchantAccount) || str(row.merchant_account);
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name: orNull(row.name), status: orNull(row.status) });
  }
  return out.slice(0, MERCHANT_ACCOUNTS_KEPT);
}

// The kept list plus what was just seen: kept ones first in the order they
// were kept (a row seen again refreshes its name and status), anything new
// after. Never drops a kept account, because a credential can be scoped down
// between reads and the picker must not lose the account a venue is on.
export function mergeMerchantAccounts(stored, seen) {
  const kept = merchantAccountsSeen(stored);
  const fresh = merchantAccountsSeen(seen);
  const byKey = new Map(fresh.map((m) => [m.id.toLowerCase(), m]));
  const done = new Set();
  const out = [];
  for (const m of kept) {
    const key = m.id.toLowerCase();
    done.add(key);
    const seenNow = byKey.get(key);
    // The id we kept FIRST is the one the picker keeps offering, so a
    // different casing back from Adyen refreshes the name and the status
    // without changing the value under the option.
    out.push(seenNow ? { ...seenNow, id: m.id } : m);
  }
  for (const m of fresh) if (!done.has(m.id.toLowerCase())) out.push(m);
  return out.slice(0, MERCHANT_ACCOUNTS_KEPT);
}

// What to WRITE onto the settings row, or null when nothing is new. Called on
// every read that saw an account holder or a merchant list, so "nothing new"
// is the normal answer and no write leaves.
//   `row`     the settings row as it is now (null when there is none yet)
//   `learned` { balancePlatformId, merchantAccounts } from this read
// Never clears and never RE-POINTS: a learned id fills a blank only, and the
// merchant accounts merge. A different id is a clash, not an update. The row is
// keyed by (environment, region) alone and more than one Adyen account is in
// play for one region under the reseller model, so one venue sitting on a
// second balance platform must not re-point the search for every other venue.
// savePlatformSettings turns that clash into a warning the admin can read.
export function platformSettingsPatch(row, learned) {
  const r = isObj(row) ? row : {};
  const l = isObj(learned) ? learned : {};
  const patch = {};
  const bp = str(l.balancePlatformId);
  if (bp && !str(r.balance_platform_id)) patch.balance_platform_id = bp;
  const fresh = merchantAccountsSeen(l.merchantAccounts);
  if (fresh.length) {
    const kept = merchantAccountsSeen(r.merchant_accounts);
    const merged = mergeMerchantAccounts(kept, fresh);
    if (JSON.stringify(merged) !== JSON.stringify(kept)) patch.merchant_accounts = merged;
  }
  return Object.keys(patch).length ? patch : null;
}

// The balance platform id THIS lookup learned, and ONLY from an account holder
// Adyen actually answered with: a pasted holder, the holder the listing matched
// by reference, or the holder the store's balance account named
// (accountHolderSummary carries balancePlatform). NEVER lookup.balancePlatform:
// that is the id the listing SEARCHED with, set before the listing ran and so
// true whether or not any holder was found. Learning it would write an
// unverified id (a stale secret, a typed BP) over the good kept one, on a row
// no screen can read back or clear. Null when no account holder was read.
export function learnedBalancePlatform(lookup) {
  const l = isObj(lookup) ? lookup : {};
  const holder = isObj(l.accountHolder) ? l.accountHolder : {};
  return str(holder.balancePlatform) || null;
}

// PostgREST's two shapes for a table that is not there: 42P01 "relation
// public.x does not exist" from Postgres, PGRST205 "Could not find the table
// 'public.x' in the schema cache" from PostgREST itself. The table name must
// be in the text, so one missing table never reads as another.
export function isUnknownRelationError(err, table) {
  if (!isObj(err)) return false;
  const code = str(err.code);
  const text = [err.message, err.details, err.hint].map(str).join(' ').toLowerCase();
  const name = lower(table);
  if (name && !text.includes(name)) return false;
  if (code === '42P01' || code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/.test(text);
}

// The one line for a settings table that has not been created yet. Named so
// the admin can act on it: nothing is broken, every venue just needs its id
// pasted until the migration runs.
export function platformSettingsMissingMessage() {
  return `Our own Adyen ids were not kept: the platform table ${ADYEN_PLATFORM_SETTINGS_TABLE} is not there yet, so every venue needs its Adyen id pasted. Run ${ADYEN_PLATFORM_SETTINGS_MIGRATION} on the platform project.`;
}

// The business line a store must name, from GET /legalEntities/{id}/businessLines
// ({ businessLines: [{ id, service, industryCode, ... }] }) or a bare array:
// the one whose service is paymentProcessing, else the only line there is.
// Several of the same service is null (the admin picks).
export function pickBusinessLine(list, service = 'paymentProcessing') {
  const rows = (Array.isArray(list?.businessLines) ? list.businessLines : Array.isArray(list) ? list : []).filter(isObj);
  if (!rows.length) return null;
  const want = lower(service);
  const hits = rows.filter((b) => lower(b.service) === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  return rows.length === 1 ? rows[0] : null;
}

// A store found on a merchant account that is NOT the one the secret names
// is NEVER linked silently: the venue would charge on one account while its
// store lived on another, and every terminal call would name the wrong
// merchant. The line names the secret, both accounts and the way forward.
// Null when the accounts agree (case insensitively, as Adyen treats them) or
// when either is unknown.
export function merchantMismatch({ configured, found, secret, storeId, reference } = {}) {
  const cur = str(configured);
  const other = str(found);
  if (!cur || !other || cur.toLowerCase() === other.toLowerCase()) return null;
  const what = [str(storeId) ? `Store ${str(storeId)}` : 'The store', str(reference) ? `with the reference ${str(reference)}` : ''].filter(Boolean).join(' ');
  return {
    configured: cur,
    found: other,
    secret: str(secret) || null,
    storeId: orNull(storeId),
    reference: orNull(reference),
    message: `${what} sits on merchant account ${other}, but ${str(secret) || 'the configured secret'} names ${cur}. Nothing was linked to it: choose ${other} as the merchant account to link the venue there (the link writes it onto the venue), or point ${str(secret) || 'the secret'} at ${other}.`,
  };
}

// A venue Adyen holds as an account holder with NO store: the plain sentence
// the function and the admin portal both say, because a card payment names a
// store and nothing else. Null when a store was found, or when there is no
// account holder either (then nothing was found at all).
export function storeStillNeeded(lookup) {
  const l = isObj(lookup) ? lookup : {};
  if (isObj(l.store) && str(l.store.id)) return null;
  if (!isObj(l.accountHolder) || !str(l.accountHolder.id)) return null;
  const ref = str(l.reference) || 'this venue';
  return `Adyen holds ${ref} as an account holder, not as a store. A STORE IS STILL NEEDED before card payments route: create one with this reference on the merchant account (it is linked to the balance account for you), then link again.`;
}

// ── ONE ANSWER FOR THE WIZARD (8 Sep 2026, OWNER FEEDBACK) ───────────────────
// "we need this to be easier and better there is far too many words and too
// small we need a flow that supports someone doing this". So the screen does
// NOT assemble the state from four calls and it does NOT decide anything: the
// server answers golive_state and the UI renders these steps in order, one
// thing at a time. Every string here is short, plain and free of API words.
//   state   'done'       nothing to do
//           'todo'       the next thing this person does
//           'attention'  it works, but something is off
//           'blocked'    Adyen or the server is in the way, waiting is wrong
//   action  the button to show, or null for nothing to press
//   hint    the one extra line, only when it helps

// Every capability as ONE row: the name Adyen uses, whether it is allowed, and
// the verification behind it. A capability Adyen BLOCKS (asked for, not
// allowed) sorts FIRST and carries blocked: true, so it is visible BY NAME
// instead of hiding inside one "pending" word (live, 8 Sep 2026: the account
// holder is Active with one capability Blocked). Takes summariseCapabilities'
// answer ({ byName }) or a bare { name: entry } map.
// adyenAdminRows.capabilityRows is the SCREEN's version of this (labels,
// colours); this one is the wire shape the function answers with.
export function capabilityList(capabilities) {
  const c = isObj(capabilities) ? capabilities : {};
  const byName = isObj(c.byName) ? c.byName : c;
  const rows = [];
  for (const [name, raw] of Object.entries(byName)) {
    if (!isObj(raw)) continue;
    const allowed = raw.allowed === true;
    const requested = raw.requested !== false;
    const verification = lower(raw.verificationStatus) || null;
    rows.push({
      name,
      allowed,
      requested,
      enabled: raw.enabled === true,
      verification,
      blocked: requested && !allowed,
      problems: Array.isArray(raw.problems) ? raw.problems.length : 0,
    });
  }
  // Blocked and settled first (Adyen has decided), then blocked and still
  // being checked, then allowed, then never asked for.
  const rank = (r) => (r.blocked ? (r.verification === 'pending' ? 1 : 0) : r.allowed ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// The names of the capabilities Adyen blocks, ready to read out loud.
export function blockedCapabilityNames(list) {
  return (Array.isArray(list) ? list : []).filter((c) => isObj(c) && c.blocked === true && c.verification !== 'pending').map((c) => str(c.name)).filter(Boolean);
}

// TAKING money and PAYING it out are different jobs, and Adyen blocks them
// separately (live, 8 Sep 2026: an ACTIVE account holder with
// sendToTransferInstrument rejected). A refused pay in capability stops cards
// dead; a refused pay out only holds the settlement to the venue's bank, so it
// must never halt the go live flow.
const PAY_IN_CAPABILITIES = Object.freeze(['receivepayments', 'receivefromplatformpayments']);
const isPayInCapability = (name) => PAY_IN_CAPABILITIES.includes(lower(name));

// The one line for a refused pay out capability, in plain words.
const PAYOUT_BLOCKED_HINT = 'Sort it out with Adyen when you can. It does not stop a card being taken.';

// The step titles the screen draws live in ONE place,
// src/lib/payments/adyenAdminRows.js (GOLIVE_STEP_TITLES). The steps answered
// here carry no title of their own, so the two can never drift.

// The five steps, always all five, always in this order. Nothing is decided on
// the screen: `state` is the colour, `detail` is the one line under the title,
// `action` is the button (or null) and `hint` is the only extra sentence.
//   find_venue        does Adyen hold this venue at all (store, holder, both)
//   business_account  the account holder, its money account, its KYC, its
//                     capabilities (a BLOCKED one is named)
//   payments_location the store a card payment names, and whether it sits on
//                     the merchant account the secret names
//   go_live           real cards on or off
//   readers           the card machines, and whether they are on a till
//
// `opts.target` is the environment the flow is LOOKING at (the screen only
// ever looks at live today). When it is not the environment the venue is on,
// the readers step cannot be "done": those readers belong to the account the
// venue is leaving, and going live retires every one of them.
export function buildGoliveSteps(state = {}, opts = {}) {
  const s = isObj(state) ? state : {};
  const o = isObj(opts) ? opts : {};
  const venue = isObj(s.venue) ? s.venue : {};
  const keys = isObj(s.keys) ? s.keys : {};
  const holder = isObj(s.holder) && str(s.holder.id) ? s.holder : null;
  const ba = isObj(s.balanceAccount) && str(s.balanceAccount.id) ? s.balanceAccount : null;
  const le = isObj(s.legalEntity) && str(s.legalEntity.id) ? s.legalEntity : null;
  const store = isObj(s.store) && str(s.store.id) ? s.store : null;
  const caps = Array.isArray(s.capabilities) ? s.capabilities.filter(isObj) : [];
  const mismatch = isObj(s.merchantMismatch) ? s.merchantMismatch : null;
  const readers = (Array.isArray(s.readers) ? s.readers : []).filter(isObj);
  const origins = isObj(s.origins) ? s.origins : {};
  const applePay = isObj(s.applePay) ? s.applePay : {};
  const code = str(venue.code) || null;
  const env = lower(venue.environment) === 'live' ? 'live' : 'test';
  const target = lower(o.target) === 'live' ? 'live' : lower(o.target) === 'test' ? 'test' : null;
  const missing = (Array.isArray(keys.missing) ? keys.missing : []).map(str).filter(Boolean);
  const keysOk = keys.configured === true && missing.length === 0;
  // `keys` is the set the reads above were made with; `liveKeys` is the LIVE
  // set of the venue's region, which is what taking real money needs. They are
  // the same for a venue already being read on live; a test read passes both,
  // so the go live step never says "ready" on the back of test keys.
  const liveKeys = isObj(s.liveKeys) ? s.liveKeys : keys;
  const liveMissing = (Array.isArray(liveKeys.missing) ? liveKeys.missing : []).map(str).filter(Boolean);
  const liveKeysOk = liveKeys.configured === true && liveMissing.length === 0;
  const keysBlocked = {
    state: 'blocked',
    detail: 'The Adyen keys are not on the server, so nothing can be read.',
    action: null,
    hint: missing.length ? `Add ${missing.join(', ')}.` : 'Add the Adyen keys for this region.',
  };
  const step = (id, x) => ({ id, state: x.state, detail: x.detail, action: x.action ?? null, hint: x.hint ?? null });
  const out = [];

  // 1. find the venue
  if (!keysOk) out.push(step('find_venue', keysBlocked));
  else if (store && holder) out.push(step('find_venue', { state: 'done', detail: `Adyen holds ${code || 'this venue'} as a business account and a store.` }));
  else if (store) out.push(step('find_venue', { state: 'done', detail: `Adyen holds ${code || 'this venue'} as a store.` }));
  // A payments location was found on ANOTHER Adyen account, so nothing was
  // resolved. The explanation belongs on the step the flow opens, not one row
  // down behind a click (8 Sep 2026: pasting an ST id redrew the screen
  // byte for byte and said nothing). The STATE and the ACTION carry it: the
  // screen draws the mismatch block itself on any step whose action is
  // choose_merchant (the two account names as ids, with the picker under
  // them), so a detail and a hint here would be written and never rendered.
  else if (mismatch && str(mismatch.found)) {
    out.push(step('find_venue', { state: 'attention', detail: '', action: 'choose_merchant' }));
  } else if (holder) out.push(step('find_venue', { state: 'done', detail: `Adyen holds ${code || 'this venue'} as a business account.`, hint: 'It has no store yet. That is the third step.' }));
  else if (!code) {
    out.push(step('find_venue', { state: 'todo', detail: 'This venue has no code, so there is nothing to search for.', action: 'set_venue_code', hint: 'Set the venue code in the Back Office, then look again.' }));
  } else {
    out.push(step('find_venue', { state: 'todo', detail: `Nothing at Adyen carries the code ${code} yet.`, action: 'find_venue', hint: 'Paste the account holder id (it starts with AH), or pick the store from the list.' }));
  }

  // 2. the business account
  if (!keysOk) out.push(step('business_account', keysBlocked));
  else if (!holder) out.push(step('business_account', { state: 'todo', detail: 'No business account at Adyen yet.', action: 'find_venue', hint: 'Adyen makes one when the venue is onboarded. Paste its id if you have it.' }));
  else {
    const blocked = blockedCapabilityNames(caps);
    // Taking cards and paying out are separate refusals. Only a refused PAY IN
    // stops the venue taking a card, so only that one blocks the flow.
    const blockedIn = blocked.filter(isPayInCapability);
    const blockedOut = blocked.filter((n) => !isPayInCapability(n));
    const pending = caps.filter((c) => c.blocked === true && c.verification === 'pending').map((c) => str(c.name)).filter(Boolean);
    // Never the account holder id inside a sentence: the screen carries every
    // id as its own small grey row with a copy button (rule 5, 8 Sep 2026).
    const who = str(le?.name) || 'This venue';
    if (blockedIn.length) {
      out.push(step('business_account', {
        state: 'blocked',
        detail: `Adyen blocks ${blockedIn.join(' and ')}.`,
        action: 'open_adyen',
        hint: 'Clear the checks in the Adyen Customer Area, then look again. Waiting will not fix it.',
      }));
    } else if (str(holder.status) && lower(holder.status) !== 'active') {
      out.push(step('business_account', { state: 'attention', detail: `The business account is ${lower(holder.status)} at Adyen.`, action: 'open_adyen', hint: 'Nothing settles until Adyen makes it active.' }));
    } else if (!ba) {
      out.push(step('business_account', { state: 'attention', detail: 'The money has nowhere to land: no account was found.', action: 'open_adyen', hint: 'Check the business account in the Adyen Customer Area.' }));
    } else if (blockedOut.length) {
      // The live case: an ACTIVE account holder Adyen will not pay out from
      // yet. Cards work, so the flow says so and moves on.
      out.push(step('business_account', { state: 'attention', detail: 'Cards work. Payouts wait for Adyen.', action: null, hint: PAYOUT_BLOCKED_HINT }));
    } else if (pending.length) {
      out.push(step('business_account', { state: 'attention', detail: `Adyen is still checking ${pending.join(' and ')}.`, action: null, hint: 'Cards can still work. Payouts wait for the check.' }));
    } else if (le && !str(le.transferInstrumentId)) {
      out.push(step('business_account', { state: 'attention', detail: `${who} has no bank account yet.`, action: 'send_onboarding', hint: 'The venue adds one through its onboarding link.' }));
    } else {
      // No id inside a sentence (the screen shows every id as its own small
      // grey row with a copy button, 8 Sep 2026).
      out.push(step('business_account', { state: 'done', detail: `${who} is set up. Money lands in its ${str(ba.currency) || 'own'} account.` }));
    }
  }

  // 3. the payments location (the store)
  if (!keysOk) out.push(step('payments_location', keysBlocked));
  else if (mismatch && str(mismatch.found)) {
    out.push(step('payments_location', {
      state: 'attention',
      detail: `The store sits on ${str(mismatch.found)}, not on ${str(mismatch.configured) || 'the account we use'}.`,
      action: 'choose_merchant',
      hint: str(mismatch.message) || null,
    }));
  } else if (store && lower(store.status) === 'active') {
    // The Adyen account name is an id, so it rides as its own grey row on the
    // screen, never inside this sentence (rule 5, 8 Sep 2026).
    out.push(step('payments_location', { state: 'done', detail: `Card payments go to ${str(store.reference) || 'this venue'}.` }));
  } else if (store) {
    out.push(step('payments_location', { state: 'attention', detail: `The store is ${lower(store.status) || 'not active'} at Adyen.`, action: 'open_adyen', hint: 'Cards are refused until Adyen makes it active.' }));
  } else if (holder) {
    out.push(step('payments_location', {
      state: 'todo',
      detail: 'No payments location yet, so cards have nowhere to go.',
      action: 'create_store',
      hint: code ? `Make it with the code ${code}. It is joined to where the money lands for you.` : 'Make it, and it is joined to where the money lands for you.',
    }));
  } else {
    out.push(step('payments_location', { state: 'todo', detail: 'Find the venue first.', action: null }));
  }

  // 4. real cards
  const storeReady = !!store && lower(store.status) === 'active' && !mismatch;
  const originsOk = origins.registered !== false;
  if (!liveKeysOk) {
    out.push(step('go_live', {
      state: 'blocked',
      detail: 'The live Adyen keys are not on the server.',
      action: null,
      hint: liveMissing.length ? `Add ${liveMissing.join(', ')}.` : 'Add the live Adyen keys for this region.',
    }));
  }
  else if (env === 'live' && storeReady && !originsOk) {
    out.push(step('go_live', { state: 'attention', detail: 'Real cards are on. Online checkout still needs its web addresses.', action: 'register_origins', hint: 'One click adds them.' }));
  } else if (env === 'live' && storeReady) {
    out.push(step('go_live', { state: 'done', detail: `${str(venue.name) || 'This venue'} takes real cards.`, hint: str(applePay.verification) && lower(applePay.verification) !== 'valid' ? `Apple Pay is ${lower(applePay.verification)} at Adyen.` : null }));
  } else if (env === 'live') {
    out.push(step('go_live', { state: 'attention', detail: 'Real cards are on, but the store is not ready.', action: null, hint: 'Fix the step above, or switch back to test cards.' }));
  } else if (storeReady && holder) {
    out.push(step('go_live', { state: 'todo', detail: 'Ready to switch from test cards to real money.', action: 'go_live', hint: 'This writes the Adyen ids on the venue and moves it over.' }));
  } else {
    out.push(step('go_live', { state: 'todo', detail: 'Finish the steps above first.', action: null }));
  }

  // 5. the card readers
  const bound = readers.filter((r) => r.bound === true).length;
  // The readers on the row belong to the environment the venue is on NOW. When
  // the flow is looking at the OTHER one, they are not this flow's readers:
  // going live retires every one of them, so the step can never read "done".
  if (readers.length && target && target !== env) {
    out.push(step('readers', {
      state: 'todo',
      detail: `These ${readers.length} reader${readers.length === 1 ? ' is' : 's are'} on the ${env} account.`,
      action: 'add_reader',
      hint: `They come off when the venue moves to ${target}, and each one is added again after.`,
    }));
  }
  else if (!readers.length) out.push(step('readers', { state: 'todo', detail: 'No card readers on this venue yet.', action: 'add_reader', hint: 'Assign a reader, then bind it to a till.' }));
  else if (!bound) out.push(step('readers', { state: 'attention', detail: `${readers.length} reader${readers.length === 1 ? '' : 's'} boarded, none on a till.`, action: 'bind_reader', hint: 'Bind each reader to the till it sits next to.' }));
  else if (bound < readers.length) out.push(step('readers', { state: 'attention', detail: `${bound} of ${readers.length} readers are on a till.`, action: 'bind_reader' }));
  else out.push(step('readers', { state: 'done', detail: `${readers.length} reader${readers.length === 1 ? '' : 's'} ready.` }));

  return out;
}

// ── ENVIRONMENT STASH (8 Sep 2026) ───────────────────────────────────────────
// A flip between test and live clears the setup made on the environment the
// venue leaves (the Adyen store, split configuration, legal entity, account
// holder, balance account, bank account and business line ids, plus the
// boarded readers), because those ids belong to ONE Adyen environment. That
// clear used to be final: moving Provo live and back to test wiped its test
// store id and both test reader links, and they were put back by hand with
// SQL. So the outgoing environment's setup is KEPT on
// merchant_adyen_accounts.env_stash under its environment name, and a flip
// INTO an environment that has a stash puts it back:
//   { test: { store_id, split_profile_id, legal_entity_id, account_holder_id,
//             balance_account_id, transfer_instrument_id, business_line_id,
//             receive_payments_ok, payouts_ok, verification_status,
//             merchant_account, region,
//             readers: [{ payment_device_id, label, adyen_terminal_id,
//                         terminal_device_id, serial_number }],
//             stashed_at },
//     live: { ... } }
// Everything here is shape work: adyen-terminal-admin's flipEnvironment does
// the reads and writes. MIRROR of supabase/functions/_shared/adyenLink.ts.

export const STASH_ID_FIELDS = Object.freeze([
  'store_id', 'split_profile_id', 'legal_entity_id', 'account_holder_id', 'balance_account_id',
  'transfer_instrument_id', 'business_line_id',
]);

// A venue's readers as ONE list keyed on the POIID: the platform registry
// rows (payment_devices, processor adyen, not retired) and the ops link rows
// (terminal_devices, paired, carrying a POIID). A reader known to one side
// only is kept with the other side's id null, so the restore can put back
// whatever existed. Order: platform rows first, then ops only ones.
export function stashReaders(platformRows, opsRows) {
  const out = [];
  const byPoiid = new Map();
  for (const r of Array.isArray(platformRows) ? platformRows : []) {
    if (!isObj(r)) continue;
    const poiid = str(r.adyen_terminal_id);
    if (!poiid || byPoiid.has(poiid)) continue;
    const entry = { payment_device_id: orNull(r.id), label: orNull(r.label), adyen_terminal_id: poiid, terminal_device_id: null, serial_number: orNull(r.serial_number) };
    byPoiid.set(poiid, entry);
    out.push(entry);
  }
  for (const r of Array.isArray(opsRows) ? opsRows : []) {
    if (!isObj(r)) continue;
    const poiid = str(r.adyen_terminal_id);
    if (!poiid) continue;
    const have = byPoiid.get(poiid);
    if (have) {
      if (!have.terminal_device_id) have.terminal_device_id = orNull(r.id);
      if (!have.label) have.label = orNull(r.label);
      if (!have.serial_number) have.serial_number = orNull(r.serial_number);
      continue;
    }
    const entry = { payment_device_id: null, label: orNull(r.label), adyen_terminal_id: poiid, terminal_device_id: orNull(r.id), serial_number: orNull(r.serial_number) };
    byPoiid.set(poiid, entry);
    out.push(entry);
  }
  return out;
}

// The stash entry for the environment a venue leaves, from its row as it is
// NOW (before the clear) and its readers (stashReaders). Empty ids are null;
// the flags are booleans; the snapshot rides as is.
export function buildEnvStashEntry(row, readers, { at, region } = {}) {
  const r = isObj(row) ? row : {};
  const entry = {};
  for (const k of STASH_ID_FIELDS) entry[k] = orNull(r[k]);
  entry.receive_payments_ok = r.receive_payments_ok === true;
  entry.payouts_ok = r.payouts_ok === true;
  entry.verification_status = isObj(r.verification_status) ? r.verification_status : null;
  entry.merchant_account = orNull(r.merchant_account);
  entry.region = orNull(region) || orNull(r.region);
  entry.readers = (Array.isArray(readers) ? readers : []).filter((x) => isObj(x) && str(x.adyen_terminal_id)).map((x) => ({
    payment_device_id: orNull(x.payment_device_id),
    label: orNull(x.label),
    adyen_terminal_id: str(x.adyen_terminal_id),
    terminal_device_id: orNull(x.terminal_device_id),
    serial_number: orNull(x.serial_number),
  }));
  entry.stashed_at = str(at) || new Date().toISOString();
  return entry;
}

// Does a stash entry hold anything worth putting back (an id or a reader)?
export function stashHasSetup(entry) {
  if (!isObj(entry)) return false;
  if (STASH_ID_FIELDS.some((k) => str(entry[k]))) return true;
  return Array.isArray(entry.readers) && entry.readers.some((x) => isObj(x) && str(x.adyen_terminal_id));
}

// The one line summary the admin portal shows for a kept setup, null when
// the entry holds nothing.
export function stashSummary(entry) {
  if (!stashHasSetup(entry)) return null;
  return {
    store_id: orNull(entry.store_id),
    ids: STASH_ID_FIELDS.filter((k) => str(entry[k])).length,
    readers: Array.isArray(entry.readers) ? entry.readers.filter((x) => isObj(x) && str(x.adyen_terminal_id)).length : 0,
    stashed_at: orNull(entry.stashed_at),
    region: orNull(entry.region),
  };
}

// What a flip INTO an environment puts back from that environment's stash.
//   ids       the row columns to write (STASH_ID_FIELDS, the two flags, the
//             snapshot and the merchant account), minus anything `pulled`
//             carries: ids the caller pulled from Adyen for that environment
//             win, field by field
//   readers   the readers to un-retire and relink
//   skipped   set (and nothing restored) when the stash was made on another
//             region's account: its ids belong to that account
//   idsSkipped set (row ids left alone, readers still restored) when the
//             pulled ids name a DIFFERENT store from the kept one: mixing the
//             kept split configuration or balance account under a new store
//             is the exact wrong row replacementClear exists to prevent
export function stashRestorePlan(entry, { region, pulled } = {}) {
  const none = { ids: {}, idsSkipped: null, readers: [], skipped: null };
  if (!stashHasSetup(entry)) return none;
  const p = isObj(pulled) ? pulled : {};
  const want = str(region).toUpperCase();
  const was = str(entry.region).toUpperCase();
  if (want && was && want !== was) {
    return { ...none, skipped: `The kept setup was made on the ${was} account and the venue is on ${want} now, so it was left alone.` };
  }
  const readers = (Array.isArray(entry.readers) ? entry.readers : []).filter((x) => isObj(x) && str(x.adyen_terminal_id)).map((x) => ({
    payment_device_id: orNull(x.payment_device_id),
    label: orNull(x.label),
    adyen_terminal_id: str(x.adyen_terminal_id),
    terminal_device_id: orNull(x.terminal_device_id),
    serial_number: orNull(x.serial_number),
  }));
  const pulledStore = str(p.store_id);
  const keptStore = str(entry.store_id);
  if (pulledStore && keptStore && pulledStore !== keptStore) {
    return { ids: {}, idsSkipped: `The ids pulled from Adyen name store ${pulledStore}; the kept setup was for store ${keptStore}, so its ids were left alone.`, readers, skipped: null };
  }
  const ids = {};
  for (const k of STASH_ID_FIELDS) if (str(entry[k]) && !(k in p)) ids[k] = str(entry[k]);
  if (typeof entry.receive_payments_ok === 'boolean' && !('receive_payments_ok' in p)) ids.receive_payments_ok = entry.receive_payments_ok;
  if (typeof entry.payouts_ok === 'boolean' && !('payouts_ok' in p)) ids.payouts_ok = entry.payouts_ok;
  if (isObj(entry.verification_status) && !('verification_status' in p)) ids.verification_status = entry.verification_status;
  if (str(entry.merchant_account) && !('merchant_account' in p)) ids.merchant_account = str(entry.merchant_account);
  return { ids, idsSkipped: null, readers, skipped: null };
}
