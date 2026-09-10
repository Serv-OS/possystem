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
  // THE STORE'S BALANCE ACCOUNT IS NOT ALWAYS THE VENUE'S (9 Sep 2026): a
  // store FranPOS made in the Customer Area can carry a split configuration
  // naming the platform's liable account or another venue's account. The
  // lookup says so (storeBalanceAccountForeign) and hands over the chosen
  // holder's own account instead; a foreign one never falls through here.
  const baId = str(ba?.id) || (l.storeBalanceAccountForeign === true ? '' : str(store?.balanceAccountId));
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
    // payouts_ok is the CAPABILITY, as adyen-bp-webhook and adyen-financial
    // mean it: Adyen allows payouts to the venue's bank. Whether the venue is
    // actually PAID OUT (a daily push sweep exists) is a separate column,
    // payout_sweep_id, written when the sweeps were listed (sweepKnown): the
    // sweep's id, or null when none is there. The two together are what the
    // list chip PAYOUTS reads (adyenAdminRows). Kept apart on purpose (9 Sep
    // 2026): folding the sweep into payouts_ok told a venue Adyen had
    // approved to complete KYC again in its own Back Office.
    patch.payouts_ok = ah.capabilities.payoutsOk === true;
    if (l.sweepKnown === true) patch.payout_sweep_id = orNull(isObj(l.sweep) ? l.sweep.id : null);
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

// WHEN that clear rides (9 Sep 2026). replacementClear exists so an OLD
// account holder's bank account never survives under a NEW balance account,
// so it belongs to a replacement that MOVES THE MONEY SIDE: a conflict on
// balance_account_id or account_holder_id. A store swap alone, with the
// holder side simply unreadable this time (the Balance Platform refused the
// key), is not that case: nulling the holder, legal entity and bank account
// because a READ failed would drop the venue to "No holder", "No payouts",
// KYC unknown, with the onboarding link gone. So: the full clear when the
// conflicts move the money, nothing otherwise.
export const MONEY_CONFLICT_FIELDS = Object.freeze(['balance_account_id', 'account_holder_id']);
export function conflictsMoveMoney(conflicts) {
  return (Array.isArray(conflicts) ? conflicts : []).some((c) => isObj(c) && MONEY_CONFLICT_FIELDS.includes(str(c.field)));
}
export function relinkClear(diff, patch) {
  const conflicts = isObj(diff) && Array.isArray(diff.conflicts) ? diff.conflicts : [];
  return conflicts.length && conflictsMoveMoney(conflicts) ? replacementClear(patch) : {};
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

// THE ONE PLAIN REASON when the Balance Platform refuses our key (9 Sep 2026,
// live screen). The payments key cannot read the business account side at
// all: Adyen issues a SEPARATE credential for the Balance Platform (Customer
// Area, Developers, API credentials, the Platforms tab), and it goes in the
// BP_KEY secret of the region. Four long code lines said that on the live
// screen and the owner read "errors all over the place". The step says it
// once, in these words, and nothing else on the screen repeats it.
export const BP_KEY_BLOCKED_DETAIL = 'Our payments key cannot see the business account side.';
// Two short sentences and NO id inside them (rule 5): the secret the key goes
// in rides as its own grey "Server setting" row under the step, so the hint
// only points at it. The 201 character version named the secret in the
// sentence and broke the 120 character rule the plain lines keep.
export function bpKeyBlockedHint(_secret, env) {
  const where = lower(env) === 'live' ? 'live' : 'test';
  return `A second key is made in the ${where} Customer Area: Developers, API credentials, Platforms. It goes in the setting below.`;
}

// The line for a found store the venue row does not name yet (link_store).
export const STORE_NOT_SAVED_DETAIL = 'Adyen holds the payments location, it is not saved on the venue yet.';
// The line for a found account holder the venue row does not name yet
// (link_holder, 9 Sep 2026, live screen: golive_state READ the pasted
// holder, said step 2 was Done because Adyen holds it, and the venue row
// still had account_holder_id, balance_account_id and legal_entity_id NULL,
// so the list chips read NO HOLDER and NO PAYOUTS). Nothing had written it.
export const HOLDER_NOT_SAVED_DETAIL = 'Adyen holds the business account, it is not saved on the venue yet.';
// The line for a saved holder whose money side on the row is blank or names
// an account that is not the holder's (9 Sep 2026: a store's split
// configuration can name the platform's or another venue's balance account,
// and nothing checked that the row's account belonged to the row's holder
// before money was routed to it). link_holder writes the right one.
export const HOLDER_MONEY_MISMATCH_DETAIL = 'Where the money lands is not saved right on the venue.';
// Step 5 while the flow looks at the OTHER environment (9 Sep 2026): the
// server acts on the venue's own row, so nothing is offered until the venue
// is on the account the flow is looking at.
export const PAYOUTS_WAIT_FOR_LIVE_DETAIL = 'Turn on live payments first.';

// ── PAYOUTS AND COMMISSION (9 Sep 2026) ──────────────────────────────────────
// Adyen for Platforms, confirmed on docs.adyen.com on 9 Sep 2026:
//   ROUTING   A split configuration profile PATCHed onto the store is enough
//             on its own: Adyen applies it to every payment through the store
//             and no request needs split instructions. With NO profile "the
//             whole transaction amount and fees are booked to your liable
//             balance account", so nothing reaches the venue (live, Provo:
//             the store carries no split configuration). The commission ALWAYS
//             goes to the platform's liable account, so no liable account id
//             is needed in the rule; the store's balanceAccountId is "the one
//             balance account" the remainder is booked to.
//               POST  /merchants/{m}/splitConfigurations   (role "SplitConfiguration read and write")
//               PATCH /merchants/{m}/stores/{storeId}      { splitConfiguration: { splitConfigurationId, balanceAccountId } }
//             commission.variablePercentage is in BASIS POINTS (100 = 1%),
//             commission.fixedAmount in minor units: 0.8% plus 5p is 80 and 5.
//   PAYOUTS   A push sweep on the venue balance account to its transfer
//             instrument (bank account) pays the full balance out daily at
//             07:00 CET. It needs the legal entity to hold a bank account
//             (added on the hosted onboarding page) and the account holder's
//             sendToTransferInstrument capability allowed.
//               GET/POST /balanceAccounts/{id}/sweeps   { type push, category bank, counterparty { transferInstrumentId }, currency, schedule { type daily } }
//               POST /legalEntities/{id}/onboardingLinks  { redirectUrl, locale }   the url works ONCE and for 4 MINUTES
// The shape work is here (mirror of _shared/adyenLink.ts); the calls are in
// _shared/adyenPayouts.ts, used by adyen-terminal-admin (set_split,
// onboarding_link, setup_sweep) and adyen-onboard (configure_splits,
// setup_sweep).

// The capability that gates paying the venue out.
export const PAYOUT_CAPABILITY = 'sendToTransferInstrument';

// A percent and a pence as Adyen's commission ({ variablePercentage in basis
// points, fixedAmount in minor units }); null when both are nothing, because
// a rule with an empty commission is refused and a 0% rule is never wanted.
export function commissionFromRates(percent, fixedPence) {
  const pct = Number(percent);
  const fix = Number(fixedPence);
  const out = {};
  if (Number.isFinite(pct) && pct > 0) out.variablePercentage = Math.round(pct * 100);
  if (Number.isFinite(fix) && fix > 0) out.fixedAmount = Math.round(fix);
  return Object.keys(out).length ? out : null;
}

// The split logic every ServOS rule carries: our commission to the liable
// account, the platform absorbs Adyen's fees (the venue pays the all in
// rate), the rest of the sale, tips and surcharges to the venue, chargebacks
// against the venue, refunds unwound in the same ratio.
export function splitLogicFor(commission) {
  return {
    // Adyen's SplitConfigurationLogic marks commission REQUIRED (Management
    // API v3). tieredCommissionRules always passes a block, an explicit zero
    // for a tier priced at 0% and 0p; a null here leaves the key out.
    ...(isObj(commission) ? { commission } : {}),
    paymentFee: 'deductFromLiableAccount',
    remainder: 'addToOneBalanceAccount',
    tip: 'addToOneBalanceAccount',
    surcharge: 'addToOneBalanceAccount',
    chargeback: 'deductFromOneBalanceAccount',
    chargebackCostAllocation: 'deductFromLiableAccount',
    refund: 'deductAccordingToSplitRatio',
    refundCostAllocation: 'deductFromLiableAccount',
  };
}

// One rule of a split configuration profile. currency must be a real ISO code
// (the one condition Adyen refuses ANY for); the others default to ANY.
export function splitRule({ currency, paymentMethod = 'ANY', shopperInteraction = 'ANY', fundingSource = 'ANY', commission } = {}) {
  return {
    currency: str(currency).toUpperCase() || 'GBP',
    fundingSource: str(fundingSource) || 'ANY',
    paymentMethod: str(paymentMethod) || 'ANY',
    shopperInteraction: str(shopperInteraction) || 'ANY',
    splitLogic: splitLogicFor(commission),
  };
}

// The ONE rule profile the go live flow writes: the venue's percent and pence
// on every payment through its store, whatever the card or the channel. Null
// when there is no commission to set.
export function buildCommissionProfile({ description, currency, percent, fixedPence } = {}) {
  const commission = commissionFromRates(percent, fixedPence);
  if (!commission) return null;
  return {
    description: str(description).slice(0, 300) || 'ServOS rates',
    rules: [splitRule({ currency, commission })],
  };
}

// THE SAME RULES THE LEDGER CHARGES (9 Sep 2026). adyen-webhook stamps what
// ServOS earns per payment from the venue's resolved rate card (four tiers:
// card_present, card_not_present, amex, keyed; _shared/adyen.ts
// resolveAdyenRateCard), so the profile on the store must carry ONE RULE PER
// TIER built from the same numbers, or Adyen takes one rate while the ledger
// and the venue's Card payments screen say another. This is the shape
// adyen-onboard's configure_splits has always written; the go live flow's
// set_split writes the same. Order matters to Adyen (the most specific rule
// wins, and an Amex ecommerce payment would tie between 'amex + ANY' and
// 'ANY + Ecommerce'), so the amex tier is written per interaction.
//   tiers   { card_present: { percent, fixedPence }, card_not_present, amex, keyed }
//           (fixed_pence is accepted too, the rate card's own spelling)
// Answers { rules, lacking }: lacking names the tiers with NO PRICE at all
// (percent and pence both empty), and rules is empty when any tier lacks
// one. A tier priced 0% and 0p is a valid price (10 Sep 2026): its rule
// carries an EXPLICIT zero commission ({ variablePercentage: 0 }), because
// Adyen's contract marks commission required, so Adyen takes nothing on it.
// A negative number is no price at all (rateNumber).
export const COMMISSION_TIERS = Object.freeze(['card_present', 'card_not_present', 'amex', 'keyed']);
const TIER_RULES = Object.freeze([
  ['amex', 'amex', 'Ecommerce'],
  ['amex', 'amex', 'Moto'],
  ['amex', 'amex', 'ANY'],
  ['card_not_present', 'ANY', 'Ecommerce'],
  ['keyed', 'ANY', 'Moto'],
  ['card_present', 'ANY', 'ANY'],
]);
export function tieredCommissionRules(currency, tiers) {
  const t = isObj(tiers) ? tiers : {};
  const commissionOf = (tier) => {
    const c = isObj(t[tier]) ? t[tier] : {};
    return commissionFromRates(c.percent, c.fixedPence ?? c.fixed_pence) ?? { variablePercentage: 0 };
  };
  const lacking = unpricedTiers(t);
  if (lacking.length) return { rules: [], lacking };
  return {
    rules: TIER_RULES.map(([tier, paymentMethod, shopperInteraction]) => splitRule({ currency, paymentMethod, shopperInteraction, commission: commissionOf(tier) })),
    lacking: [],
  };
}

// The profile the go live flow and configure_splits both write: one rule per
// tier. Null when any tier has no price (tieredCommissionRules says which).
export function buildTieredProfile({ description, currency, tiers } = {}) {
  const built = tieredCommissionRules(currency, tiers);
  if (!built.rules.length) return null;
  return { description: str(description).slice(0, 300) || 'ServOS rates', rules: built.rules };
}

// A flat percent and pence as every tier, for a venue priced with one number
// (the go live flow's two boxes): the ledger then charges the same on every
// card because the venue's rate_card names it for every tier.
export function flatRateCard(percent, fixedPence) {
  const pct = Number(percent);
  const fix = Number(fixedPence);
  const entry = {
    percent: Number.isFinite(pct) && pct > 0 ? pct : null,
    fixed_pence: Number.isFinite(fix) && fix > 0 ? Math.round(fix) : null,
  };
  if (entry.percent === null && entry.fixed_pence === null) return null;
  const out = {};
  for (const tier of COMMISSION_TIERS) out[tier] = { ...entry };
  return out;
}

// Does a rate card price anything at all (any tier with a number)?
export function rateCardPriced(card) {
  if (!isObj(card)) return false;
  return COMMISSION_TIERS.some((tier) => {
    const c = isObj(card[tier]) ? card[tier] : null;
    if (!c) return false;
    const pct = Number(c.percent);
    const fix = Number(c.fixedPence ?? c.fixed_pence);
    return (Number.isFinite(pct) && pct > 0) || (Number.isFinite(fix) && fix > 0);
  });
}

// GET /merchants/{m}/splitConfigurations/{id} back into what it does:
//   percent, fixedPence  the catch all rule (ANY method, ANY interaction)
//                        when there is one, else the first rule that carries
//                        a commission, else 0 and 0 (a profile with rules and
//                        no commission takes nothing for ServOS)
//   rules                how many rules there are
//   remainder            where the catch all rule (else the first rule)
//                        sends the rest of each sale: addToOneBalanceAccount
//                        is the venue, addToLiableAccount is ServOS
//   venueRules           how many rules send the rest to the venue
// Null when the profile has no rules at all.
export function profileCommission(profile) {
  const rules = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  if (!rules.length) return null;
  const any = (v) => !str(v) || lower(v) === 'any';
  const isCatchAll = (r) => any(r.paymentMethod) && any(r.shopperInteraction) && any(r.fundingSource);
  const priced = rules.filter((r) => isObj(r.splitLogic) && isObj(r.splitLogic.commission));
  const catchAll = rules.find(isCatchAll) || null;
  const pricedPick = priced.find(isCatchAll) || priced[0] || null;
  const c = pricedPick ? pricedPick.splitLogic.commission : {};
  const bp = Number(c.variablePercentage);
  const fix = Number(c.fixedAmount);
  const remainderOf = (r) => orNull(isObj(r?.splitLogic) ? r.splitLogic.remainder : null);
  return {
    percent: Number.isFinite(bp) ? bp / 100 : 0,
    fixedPence: Number.isFinite(fix) ? Math.round(fix) : 0,
    rules: rules.length,
    remainder: remainderOf(catchAll || rules[0]),
    venueRules: rules.filter((r) => lower(remainderOf(r)) === 'addtoonebalanceaccount').length,
  };
}

// The remainder word that sends the rest of each sale to the venue.
export const REMAINDER_TO_VENUE = 'addToOneBalanceAccount';

// A number the way a person writes it: 0.8, 1, 1.75. Never 0.80000001.
const plainNumber = (n) => String(Number(Number(n).toFixed(4)));

// The commission in plain words: "0.8% plus 5p", "0.8%", "5p"; US pence read
// as cents. Null when there is nothing.
export function commissionLine(percent, fixedPence, currency) {
  const pct = Number(percent);
  const fix = Number(fixedPence);
  const hasPct = Number.isFinite(pct) && pct > 0;
  const hasFix = Number.isFinite(fix) && fix > 0;
  if (!hasPct && !hasFix) return null;
  const minor = str(currency).toUpperCase() === 'USD' ? 'c' : 'p';
  return [hasPct ? `${plainNumber(pct)}%` : '', hasFix ? `${Math.round(fix)}${minor}` : ''].filter(Boolean).join(' plus ');
}

// ── CARD RATES (10 Sep 2026, OWNER RULE) ─────────────────────────────────────
// "we set the rate that customers get charged for the different card types,
// out of the money the adyen charge whats left is ours". The venue pays a
// RATE CARD with four payment types (in person, online, Amex, keyed), and on
// Adyen that is ONE RULE PER TIER on the venue's store with the tier's rate as
// the rule's commission. There is no flat rate and no separate platform fee:
// Adyen and FranPOS take their costs out of the rate, the rest is ServOS
// margin. The word commission stays off every screen; these helpers give the
// screen and the server the same words and the same comparison.
//   tiersFromResolved  resolveAdyenRateCard's answer as the screen reads it
//   unpricedTiers      the tiers with no price at all (both fields empty)
//   profileTiers       the profile on the store, rule by rule, as four tiers
//   ratesOnAdyen       what Adyen holds against what the venue pays
//   rateCardLine       the four rates in one line for a collapsed step

// Plain words for each tier. Amex keeps its capital everywhere.
export const RATE_TIER_LABELS = Object.freeze({ card_present: 'In person', card_not_present: 'Online', amex: 'Amex', keyed: 'Keyed' });
export function rateTierLabel(tier, { lower: lc = false } = {}) {
  const label = RATE_TIER_LABELS[str(tier)] || str(tier);
  return lc && label !== 'Amex' ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

// A number, or null for empty: '' and null are "not set", 0 is a price. A
// NEGATIVE number is no price either (a hand edited card or an old column):
// Adyen cannot take it, so the tier is named as unpriced and never applied.
const rateNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const tierOf = (tiers, tier) => (isObj(tiers) && isObj(tiers[tier]) ? tiers[tier] : {});
const tierPercent = (c) => rateNumber(c.percent);
const tierFixed = (c) => {
  const n = rateNumber(c.fixedPence ?? c.fixed_pence);
  return n === null ? null : Math.round(n);
};

// One tier's rate in plain words: "1.4% + 5p", "1.4%", "5p"; "0%" for a tier
// priced at nothing; null when it has no price at all. US pence read as cents.
export function tierRateLine(percent, fixedPence, currency) {
  const pct = rateNumber(percent);
  const fix = rateNumber(fixedPence);
  if (pct === null && fix === null) return null;
  const minor = str(currency).toUpperCase() === 'USD' ? 'c' : 'p';
  const parts = [];
  if (pct !== null && pct > 0) parts.push(`${plainNumber(pct)}%`);
  if (fix !== null && fix > 0) parts.push(`${Math.round(fix)}${minor}`);
  return parts.length ? parts.join(' + ') : '0%';
}

// The four rates in one line, for a collapsed step or a log line:
// "In person 1.4% + 5p, online 1.9% + 10p, Amex 2.5% + 10p, keyed 2.9% + 15p".
// A tier with no price reads "not set".
export function rateCardLine(tiers, currency) {
  return COMMISSION_TIERS.map((tier, i) => {
    const c = tierOf(tiers, tier);
    return `${rateTierLabel(tier, { lower: i > 0 })} ${tierRateLine(tierPercent(c), tierFixed(c), currency) || 'not set'}`;
  }).join(', ');
}

// resolveAdyenRateCard's answer ({ tier: { percent, fixed_pence, source } })
// as the screen reads it: { tier: { percent, fixedPence, source } } with the
// source as one grey word, "venue" or "platform default" (the legacy flat
// columns count as whichever side they sit on), or null for no price.
export function tiersFromResolved(cards) {
  const out = {};
  for (const tier of COMMISSION_TIERS) {
    const c = tierOf(cards, tier);
    const src = lower(c.source);
    out[tier] = {
      percent: tierPercent(c),
      fixedPence: tierFixed(c),
      source: src === 'venue' || src === 'legacy_venue' ? 'venue' : src === 'platform' || src === 'legacy_platform' ? 'platform default' : null,
    };
  }
  return out;
}

// The tiers with no price at all: percent AND pence empty. 0 is a price.
export function unpricedTiers(tiers) {
  return COMMISSION_TIERS.filter((tier) => {
    const c = tierOf(tiers, tier);
    return tierPercent(c) === null && tierFixed(c) === null;
  });
}

// Tier names for a sentence: "online, Amex and keyed".
export function tierListWords(tiers) {
  const words = (Array.isArray(tiers) ? tiers : []).map((t) => rateTierLabel(t, { lower: true })).filter(Boolean);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// The row names every rate table and editor uses (the Card rates table in
// step 5, RateCardRows), so a sentence naming tiers reads the SAME words as
// the rows under it: "No rate is set yet for: Online, Keyed in."
export const RATE_ROW_LABELS = Object.freeze({ card_present: 'In person', card_not_present: 'Online', amex: 'Amex and business cards', keyed: 'Keyed in' });
export function tierRowList(tiers) {
  return (Array.isArray(tiers) ? tiers : []).map((t) => RATE_ROW_LABELS[str(t)] || str(t)).filter(Boolean).join(', ');
}

// ── WHAT IS WRONG WITH A RATE CARD (10 Sep 2026) ────────────────────────────
// Checked before the card is saved (payments-admin adyen_pricing) and before
// it is applied on Adyen (set_split), and live in both editors:
//   errors     a value that can never be right: not a number, outside 0 to 100
//              percent or 0 to 10000 pence, a percent finer than a basis
//              point (Adyen holds whole basis points, so 1.255% would drift
//              from the ledger), or pence that are not whole
//   overLimit  a value above the usual limit (RATE_PERCENT_LIMIT percent or
//              RATE_PENCE_LIMIT pence): 14 typed for 1.4 takes 14% of every
//              sale. It is refused unless the admin confirms (over_limit)
// Each entry is { tier, text } with one plain sentence naming the row. `verb`
// ends the over limit sentence ("so it was not saved"); null ends it there.
export const RATE_PERCENT_LIMIT = 5;
export const RATE_PENCE_LIMIT = 50;
export function rateCardProblems(card, { currency, verb = null } = {}) {
  const c = isObj(card) ? card : {};
  const errors = [];
  const overLimit = [];
  const empty = (v) => v === null || v === undefined || v === '';
  for (const tier of COMMISSION_TIERS) {
    const row = isObj(c[tier]) ? c[tier] : {};
    const label = RATE_ROW_LABELS[tier];
    const pRaw = row.percent;
    const fRaw = row.fixedPence ?? row.fixed_pence;
    let pct = null;
    let fix = null;
    if (!empty(pRaw)) {
      const n = Number(pRaw);
      if (!Number.isFinite(n)) errors.push({ tier, field: 'percent', text: `${label} rate must be a number.` });
      else if (n < 0 || n > 100) errors.push({ tier, field: 'percent', text: `${label} rate must be between 0 and 100.` });
      else if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) errors.push({ tier, field: 'percent', text: `${label} rate can have at most two decimals.` });
      else pct = n;
    }
    if (!empty(fRaw)) {
      const n = Number(fRaw);
      if (!Number.isFinite(n)) errors.push({ tier, field: 'fixed_pence', text: `${label} per payment must be a number.` });
      else if (n < 0 || n > 10000) errors.push({ tier, field: 'fixed_pence', text: `${label} per payment must be between 0 and 10000.` });
      else if (!Number.isInteger(n)) errors.push({ tier, field: 'fixed_pence', text: `${label} per payment must be a whole number.` });
      else fix = n;
    }
    if ((pct !== null && pct > RATE_PERCENT_LIMIT) || (fix !== null && fix > RATE_PENCE_LIMIT)) {
      const rate = tierRateLine(pct, fix, currency) || '';
      overLimit.push({ tier, text: `${label} is ${rate}. That is above the usual limit${str(verb) ? `, so it was not ${str(verb)}` : ''}.` });
    }
  }
  return { errors, overLimit };
}

// The profile on the store (GET /merchants/{m}/splitConfigurations/{id}) rule
// by rule, back into the four tiers the way tieredCommissionRules wrote them:
// paymentMethod amex is the Amex tier, shopperInteraction Ecommerce is online,
// Moto is keyed, the catch all rule is in person. A rule with no commission
// block is a tier priced at 0% and 0p. Null when the profile has no rules;
// a tier with no rule is null inside the answer.
export function profileTiers(profile) {
  const rules = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  if (!rules.length) return null;
  const any = (v) => !str(v) || lower(v) === 'any';
  const out = { card_present: null, card_not_present: null, amex: null, keyed: null };
  let amexGeneral = false;
  for (const r of rules) {
    const pm = lower(r.paymentMethod);
    const si = lower(r.shopperInteraction);
    const tier = pm === 'amex' ? 'amex'
      : any(pm) && si === 'ecommerce' ? 'card_not_present'
      : any(pm) && si === 'moto' ? 'keyed'
      : any(pm) && any(si) ? 'card_present'
      : null;
    if (!tier) continue;
    const c = isObj(r.splitLogic) && isObj(r.splitLogic.commission) ? r.splitLogic.commission : {};
    const bp = Number(c.variablePercentage);
    const fix = Number(c.fixedAmount);
    const rate = { percent: Number.isFinite(bp) ? bp / 100 : 0, fixedPence: Number.isFinite(fix) ? Math.round(fix) : 0 };
    // Amex is written three times (per interaction); the ANY one is THE
    // Amex rate, the others only exist so the most specific rule wins.
    if (tier === 'amex') {
      if (out.amex && (amexGeneral || !any(si))) continue;
      amexGeneral = any(si);
    } else if (out[tier]) continue;
    out[tier] = rate;
  }
  return out;
}

// Do two rate cards say the same thing on every tier? An empty pence on one
// side is 0 on the other (a rule with no fixedAmount reads back as 0), a
// tier with no price on either side never matches, and percents compare in
// basis points so 1.4 and 1.4000001 agree.
export function tiersMatch(a, b) {
  return COMMISSION_TIERS.every((tier) => {
    const x = tierOf(a, tier);
    const y = tierOf(b, tier);
    const xp = tierPercent(x); const yp = tierPercent(y);
    const xf = tierFixed(x); const yf = tierFixed(y);
    if ((xp === null && xf === null) || (yp === null && yf === null)) return false;
    return Math.round((xp ?? 0) * 100) === Math.round((yp ?? 0) * 100) && (xf ?? 0) === (yf ?? 0);
  });
}

// THE WHOLE PROFILE, NOT JUST THE NUMBERS (10 Sep 2026). A profile that holds
// the venue's four commission numbers can still route money differently: a
// USD rule on a GBP venue matches no sale (everything books to the liable
// account), paymentFee on the venue's account makes it pay Adyen's fees on
// top, an extra amex Ecommerce or debit Ecommerce rule outranks the one read
// back, or a remainder kept for the platform. So "matches" means the profile
// holds EXACTLY the rules tieredCommissionRules would write for this venue:
// the same conditions (currency, payment method, interaction, funding source,
// card region and usage ANY or absent) and the same split logic on every key
// we write, with no other fee type or additional commission on any rule.
const SPLIT_LOGIC_KEYS = Object.freeze(['paymentFee', 'remainder', 'tip', 'surcharge', 'chargeback', 'chargebackCostAllocation', 'refund', 'refundCostAllocation']);
const OTHER_SPLIT_KEYS = Object.freeze(['acquiringFees', 'adyenFees', 'adyenCommission', 'adyenMarkup', 'interchange', 'schemeFee', 'additionalCommission']);
function splitRuleKey(r) {
  const cond = (v) => (!str(v) || lower(v) === 'any' ? 'any' : lower(v));
  return [str(r.currency).toUpperCase(), cond(r.paymentMethod), cond(r.shopperInteraction), cond(r.fundingSource), cond(r.cardRegion), cond(r.cardUsageType)].join('|');
}
function sameSplitLogic(a, b) {
  const x = isObj(a) ? a : {};
  const y = isObj(b) ? b : {};
  const cx = isObj(x.commission) ? x.commission : {};
  const cy = isObj(y.commission) ? y.commission : {};
  const whole = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
  if (whole(cx.variablePercentage) !== whole(cy.variablePercentage) || whole(cx.fixedAmount) !== whole(cy.fixedAmount)) return false;
  if (SPLIT_LOGIC_KEYS.some((k) => lower(x[k]) !== lower(y[k]))) return false;
  const present = (v) => v !== undefined && v !== null && v !== '' && !(isObj(v) && !Object.keys(v).length);
  return !OTHER_SPLIT_KEYS.some((k) => present(x[k]) !== present(y[k]));
}
export function profileMatchesRules(profile, expectedRules) {
  const actual = (Array.isArray(profile?.rules) ? profile.rules : []).filter(isObj);
  const expected = (Array.isArray(expectedRules) ? expectedRules : []).filter(isObj);
  if (!expected.length || actual.length !== expected.length) return false;
  const used = new Set();
  return expected.every((e) => {
    const key = splitRuleKey(e);
    const i = actual.findIndex((a, j) => !used.has(j) && splitRuleKey(a) === key && sameSplitLogic(a.splitLogic, e.splitLogic));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

// What Adyen holds against what the venue pays: the profile's tiers, whether
// every tier has a rule (missing), whether the WHOLE profile is what we would
// write for this venue in this currency (profileMatchesRules), and where the
// catch all rule sends the rest of each sale. Null profile (not read, or no
// rules) is { tiers: null, matches: false, missing: true }.
export function ratesOnAdyen(profile, venueTiers, currency = 'GBP') {
  const tiers = profileTiers(profile);
  const pc = profileCommission(profile);
  if (!tiers || !pc) return { tiers: null, matches: false, missing: true, remainder: null, rules: 0 };
  const missing = COMMISSION_TIERS.some((t) => !tiers[t]);
  const expected = tieredCommissionRules(str(currency) || 'GBP', venueTiers).rules;
  const matches = !missing && tiersMatch(tiers, venueTiers) && profileMatchesRules(profile, expected);
  return { tiers, matches, missing, remainder: pc.remainder, rules: pc.rules };
}

// The line for a found store AND a found business account that the venue row
// does not name yet (link_all, 10 Sep 2026): one click saves every id.
export const DETAILS_NOT_SAVED_DETAIL = 'Adyen holds the venue’s details, they are not saved on the venue yet.';

// The business accounts could not be searched because the Adyen platform
// name for this environment and region is not known yet (10 Sep 2026). Never
// "no business account": nothing was searched. The step carries
// set_balance_platform and the screen draws the one input on it.
export const PLATFORM_STEP_DETAIL = 'ServOS cannot search Adyen for this venue until it knows the Adyen platform name.';
// Two business accounts carry the venue code: the step carries pick_holder
// and the screen draws the picker on it.
export const HOLDER_AMBIGUOUS_DETAIL = 'More than one business account carries the code.';

// Rows of GET /balanceAccounts/{id}/sweeps ({ sweeps: [...] }) or a bare array.
export function sweepRows(response) {
  if (Array.isArray(response)) return response.filter(isObj);
  return Array.isArray(response?.sweeps) ? response.sweeps.filter(isObj) : [];
}

// One sweep as the screen and the row see it. schedule is the type word
// (daily, weekly, monthly, balance, cron), lower case.
export function sweepSummary(sweep) {
  if (!isObj(sweep)) return null;
  const cp = isObj(sweep.counterparty) ? sweep.counterparty : {};
  return {
    id: orNull(sweep.id),
    type: lower(sweep.type) || null,
    category: lower(sweep.category) || null,
    schedule: isObj(sweep.schedule) ? lower(sweep.schedule.type) || null : lower(sweep.schedule) || null,
    status: lower(sweep.status) || null,
    transferInstrumentId: orNull(cp.transferInstrumentId),
    currency: str(sweep.currency).toUpperCase() || null,
  };
}

// The sweep that pays the venue's bank: push, category bank, not inactive,
// and pointed at the given bank account when one is named (else any). Null
// when there is none, which is what "not paid out yet" means.
export function findPushSweep(list, transferInstrumentId) {
  const ti = str(transferInstrumentId);
  const rows = sweepRows(list).map(sweepSummary)
    .filter((s) => s && s.id && s.type === 'push' && s.category === 'bank' && s.status !== 'inactive');
  if (ti) return rows.find((s) => s.transferInstrumentId === ti) ?? null;
  return rows[0] ?? null;
}

// POST /balanceAccounts/{id}/sweeps: the full available balance to the bank
// on the schedule (daily by default). No sweepAmount, targetAmount or
// triggerAmount, so everything goes.
export function sweepPayload({ transferInstrumentId, currency, schedule = 'daily', cronExpression, description } = {}) {
  const type = ['daily', 'weekly', 'monthly', 'balance', 'cron'].includes(lower(schedule)) ? lower(schedule) : 'daily';
  const sched = { type };
  if (type === 'cron' && str(cronExpression)) sched.cronExpression = str(cronExpression);
  return {
    counterparty: { transferInstrumentId: str(transferInstrumentId) },
    currency: str(currency).toUpperCase() || 'GBP',
    category: 'bank',
    priorities: ['regular', 'fast'],
    schedule: sched,
    status: 'active',
    type: 'push',
    description: str(description).slice(0, 140) || `ServOS ${type} payout`,
  };
}

// The payout capability as one word, from capabilityList's rows:
//   allowed        Adyen pays the venue out
//   pending        asked for, still being checked (a null verification with
//                  requested true reads as this, not as a refusal)
//   needs_details  asked for, and Adyen wants more from the venue
//                  (verification invalid: the bank details link fixes it)
//   rejected       asked for, not allowed, and Adyen has decided
//   unrequested    never asked for, so it can never become allowed. Adyen
//                  only answers the capabilities that were requested, so a
//                  capability list WITHOUT this row means the same thing
//   unknown        no capability list at all (the holder was not read)
export function payoutCapabilityState(caps) {
  const list = (Array.isArray(caps) ? caps : []).filter(isObj);
  const row = list.find((c) => lower(c.name) === lower(PAYOUT_CAPABILITY));
  if (!row) return list.length ? 'unrequested' : 'unknown';
  if (row.allowed === true) return 'allowed';
  if (row.requested === false) return 'unrequested';
  const v = lower(row.verification);
  if (v === 'invalid') return 'needs_details';
  if (v === 'rejected') return 'rejected';
  return 'pending';
}

// THE BANK A PAYOUT GOES TO (9 Sep 2026). A legal entity can hold more than
// one bank account (the venue changed bank), and the OLDEST one Adyen lists
// is not the one to pay: the account holder's own capability says which
// banks Adyen has approved,
//   capabilities.sendToTransferInstrument.transferInstruments[]
//     { id (SI...), allowed, requested, verificationStatus, problems }
// so the bank is chosen from there: allowed and valid, preferring the one an
// active push sweep already names, then the one the venue row names, then
// the first approved one. With no approved list at all (an older holder, or
// the capability answered without the list) the legal entity's own list
// stands in, with the same preference order. Null when nothing qualifies.
//   holderCapabilities  the raw capabilities map of GET /accountHolders/{id}
//                       (or summariseCapabilities' byName: both carry the
//                       transferInstruments list when Adyen answered one)
//   sweeps              GET /balanceAccounts/{id}/sweeps, or a bare array
//   rowTransferInstrumentId   merchant_adyen_accounts.transfer_instrument_id
//   legalEntityInstruments    legalEntitySummary's transferInstruments
// Answers { transferInstrumentId, source: 'sweep' | 'row' | 'approved' | 'legal_entity', sweepId }.
export function pickPayoutInstrument(holderCapabilities, { sweeps, rowTransferInstrumentId, legalEntityInstruments } = {}) {
  const caps = isObj(holderCapabilities) ? holderCapabilities : {};
  const cap = isObj(caps[PAYOUT_CAPABILITY]) ? caps[PAYOUT_CAPABILITY] : {};
  const approved = (Array.isArray(cap.transferInstruments) ? cap.transferInstruments : []).filter(isObj)
    .filter((t) => t.allowed === true && lower(t.verificationStatus) === 'valid')
    .map((t) => str(t.id)).filter(Boolean);
  const fallback = (Array.isArray(legalEntityInstruments) ? legalEntityInstruments : []).map((t) => str(isObj(t) ? t.id : t)).filter(Boolean);
  const pool = approved.length ? approved : fallback;
  const source = approved.length ? 'approved' : 'legal_entity';
  if (!pool.length) return null;
  const live = sweepRows(sweeps).map(sweepSummary)
    .filter((s) => s && s.id && s.type === 'push' && s.category === 'bank' && s.status !== 'inactive');
  const bySweep = live.find((s) => s.transferInstrumentId && pool.includes(s.transferInstrumentId));
  if (bySweep) return { transferInstrumentId: bySweep.transferInstrumentId, source: 'sweep', sweepId: bySweep.id };
  const onRow = str(rowTransferInstrumentId);
  if (onRow && pool.includes(onRow)) return { transferInstrumentId: onRow, source: 'row', sweepId: null };
  return { transferInstrumentId: pool[0], source, sweepId: null };
}

// The secret that may hold OUR liable balance account id (the platform
// account the commission lands in). Optional: the commission goes there
// whether or not we know the id, so it is only ever shown, never a gate.
// Same rule as balancePlatformSecretName.
export const LIABLE_BALANCE_ACCOUNT_SECRET_SUFFIX = 'LIABLE_BALANCE_ACCOUNT';
export function liableBalanceAccountSecretName(env, region) {
  const s = LIABLE_BALANCE_ACCOUNT_SECRET_SUFFIX;
  if (lower(env) !== 'live') return `ADYEN_${s}`;
  return `ADYEN_LIVE_${isUsRegion(region) ? 'US' : 'UK'}_${s}`;
}
export function liableBalanceAccountSecretNames(env, region) {
  const s = LIABLE_BALANCE_ACCOUNT_SECRET_SUFFIX;
  if (lower(env) !== 'live') return isUsRegion(region) ? [`ADYEN_TEST_US_${s}`, `ADYEN_${s}`] : [`ADYEN_${s}`];
  return isUsRegion(region) ? [`ADYEN_LIVE_US_${s}`] : [`ADYEN_LIVE_UK_${s}`, `ADYEN_LIVE_${s}`];
}
// The same id kept on adyen_platform_settings (the column the migration
// named here adds; read on its own, tolerated when absent).
export const ADYEN_LIABLE_BALANCE_ACCOUNT_COLUMN = 'liable_balance_account_id';
export const ADYEN_LIABLE_BALANCE_ACCOUNT_MIGRATION = 'supabase/migrations/20260909_PLATFORM_adyen_liable_balance_account.sql';

// Actions on a payouts part that are WAITING on Adyen, not work the owner can
// do: they stay on the part (the screen draws the button) and never lift to
// the step, so the flow does not park the owner on them. add_bp_key is not
// here on purpose: it lifts, so the step reads as server only, like step 2.
const PAYOUT_WAIT_ACTIONS = Object.freeze(['check_payouts', 'open_adyen']);

// The six steps, always all six, always in this order. Nothing is decided on
// the screen: `state` is the colour, `detail` is the one line under the title,
// `action` is the button (or null) and `hint` is the only extra sentence.
//   find_venue        does Adyen hold this venue at all (store, holder, both)
//   business_account  the account holder, its money account, its KYC, its
//                     capabilities (a BLOCKED one is named), and whether the
//                     VENUE ROW names it (a found holder is not a saved one)
//   payments_location the store a card payment names, and whether it sits on
//                     the merchant account the secret names, and whether the
//                     VENUE ROW names it (a found store is not a linked one)
//   go_live           real cards on or off
//   payouts           TWO parts (`parts`): split, the venue's card rates on
//                     the store, one rule per payment type, the rest of
//                     every sale to the venue (Card rates, 10 Sep 2026);
//                     payout, the bank account, Adyen's approval and the
//                     daily sweep. The step's own state, detail and action
//                     are the first part that needs doing
//   readers           the card machines, and whether they are on a till
//
// `opts.target` is the environment the flow is LOOKING at (the screen only
// ever looks at live today). When it is not the environment the venue is on,
// the readers step cannot be "done": those readers belong to the account the
// venue is leaving, and going live retires every one of them.
//
// `state.row` is the venue's merchant_adyen_accounts row as it is NOW on the
// environment the flow looks at ({ store_id, account_holder_id,
// balance_account_id, legal_entity_id, split_profile_id,
// transfer_instrument_id, payouts_ok, markup_percent, markup_fixed_pence },
// or {} for no row yet), and null or absent when the flow looks at the OTHER
// environment: the row's ids belong to the one the venue is on, and the go
// live flip writes the new ones.
// `state.balancePlatformKey` is { refused, secret }: refused is true when the
// Balance Platform answered 401 or 403 to the key, secret names the secret the
// separate credential goes in.
// `state.storeRead` is { refused, ambiguous }, what the STORE search itself
// came back with when no store was resolved: refused is true when the store
// list was refused (401 or 403 on the Management key), ambiguous when more
// than one store carries the code. Either way "nothing carries the code" is
// not something the read established, so step 1 must not say it (rule 6).
// `state.holderRead` is { needsPlatform, ambiguous, capped } (10 Sep 2026),
// what the BUSINESS ACCOUNT search came back with when no holder was
// resolved: needsPlatform when the listing could not run because the Adyen
// platform name is not known (set_balance_platform), ambiguous when more than
// one holder carries the code (pick_holder), capped when the listing ran out
// of pages. None of them may read as "no business account".
// `state.rates` is { currency, tiers, priced, unpriced, onAdyen, liableBalanceAccountId, readFailed }
// (10 Sep 2026): the venue's RATE CARD as the ledger resolves it, four tiers
// each { percent, fixedPence, source } (tiersFromResolved), and what the
// profile on the store actually says when it could be read: onAdyen is
// { profileId, read, tiers, matches, missing, remainder, rules } (ratesOnAdyen).
// The old `state.commission` is read as an alias when it carries the same
// shape, and ignored otherwise.
// `state.payouts` is { read, sweep }: read is true when the sweeps of the
// venue balance account were listed, sweep is the push to bank sweep
// (sweepSummary) or null.
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
  const rates = isObj(s.rates) ? s.rates : (isObj(s.commission) && isObj(s.commission.tiers) ? s.commission : {});
  const payouts = isObj(s.payouts) ? s.payouts : {};
  const code = str(venue.code) || null;
  const env = lower(venue.environment) === 'live' ? 'live' : 'test';
  const target = lower(o.target) === 'live' ? 'live' : lower(o.target) === 'test' ? 'test' : null;
  const missing = (Array.isArray(keys.missing) ? keys.missing : []).map(str).filter(Boolean);
  const keysOk = keys.configured === true && missing.length === 0;
  // A FOUND STORE IS NOT A LINKED STORE (9 Sep 2026, live screen): the read
  // found the store at Adyen, said step 3 was done, and the venue row still
  // held store_id NULL with the list chip reading NOT LINKED. With the row in
  // hand the step is done ONLY when the row names the store Adyen holds;
  // otherwise it offers to save it. No row in hand (the other environment, or
  // an old caller) keeps the old reading: the flip writes the ids.
  // A FOUND HOLDER IS NOT A SAVED HOLDER either (same day, same screen): the
  // same rule on account_holder_id, and link_holder writes it.
  const row = isObj(s.row) ? s.row : null;
  const storeSaved = !store || !row || str(row.store_id) === str(store.id);
  // THE MONEY SIDE MUST AGREE TOO (9 Sep 2026): the balance account the read
  // hands over is the chosen holder's own (the lookup never adopts a store's
  // foreign one), so a row naming the holder with a blank or different
  // balance account is not saved right, and link_holder writes the right one.
  const holderNamed = !holder || !row || str(row.account_holder_id) === str(holder.id);
  const moneySaved = !holder || !row || !ba || str(row.balance_account_id) === str(ba.id);
  const holderSaved = holderNamed && moneySaved;
  const storeActive = !!store && lower(store.status) === 'active';
  const bpKey = isObj(s.balancePlatformKey) ? s.balancePlatformKey : {};
  const bpRefused = bpKey.refused === true;
  const bpSecret = str(bpKey.secret) || null;
  const storeRead = isObj(s.storeRead) ? s.storeRead : {};
  const holderRead = isObj(s.holderRead) ? s.holderRead : {};
  // BOTH FOUND, NEITHER SAVED (10 Sep 2026, zero paste onboarding): the read
  // found the store and the business account and the row names neither, so
  // steps 2 and 3 collapse into ONE click (link_all, adyen_link with every id
  // the read found). link_store and link_holder stay for the partial cases.
  const linkAll = !!store && storeActive && !mismatch && !!holder && !storeSaved && !holderNamed;
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
  } else if (storeRead.ambiguous === true) {
    // More than one store carries the code, so nothing was resolved and
    // "nothing carries the code" would contradict the box under the steps.
    out.push(step('find_venue', { state: 'attention', detail: `More than one payments location carries the code ${code}.`, action: 'find_venue', hint: 'Pick the right one from the list below.' }));
  } else if (storeRead.refused === true) {
    // The store list itself was refused: a refusal Adyen gave us must never
    // look like nothing found (rule 6). Nothing to press until the key has
    // the role.
    out.push(step('find_venue', { state: 'blocked', detail: 'Our payments key was refused, so the search could not run.', action: null, hint: 'The key needs the Stores read role at Adyen.' }));
  } else if (bpRefused) {
    // Only the payments side could be searched, so "nothing carries the code"
    // would be a guess. Pasting an id would not help either: the one thing to
    // do is at step 2, and it is said there, once.
    out.push(step('find_venue', { state: 'todo', detail: `No payments location carries the code ${code} yet.`, action: 'find_venue', hint: 'The business account side could not be checked. See step 2.' }));
  } else if (holderRead.needsPlatform === true) {
    // The business accounts were never searched: the one thing to do is the
    // Adyen platform name, typed once per region, on THIS step.
    out.push(step('find_venue', { state: 'attention', detail: PLATFORM_STEP_DETAIL, action: 'set_balance_platform' }));
  } else if (holderRead.ambiguous === true) {
    out.push(step('find_venue', { state: 'attention', detail: HOLDER_AMBIGUOUS_DETAIL, action: 'pick_holder', hint: 'Pick the right one from the list below.' }));
  } else if (holderRead.capped === true) {
    // The listing ran out of pages: nothing was ruled out.
    out.push(step('find_venue', { state: 'todo', detail: `No payments location carries the code ${code} yet.`, action: 'find_venue', hint: 'Not every business account could be checked. Open Advanced if Adyen gave you its id.' }));
  } else {
    out.push(step('find_venue', { state: 'todo', detail: `Nothing at Adyen carries the code ${code} yet.`, action: 'find_venue', hint: 'Check the venue code, or search every Adyen account.' }));
  }

  // 2. the business account
  if (!keysOk) out.push(step('business_account', keysBlocked));
  else if (bpRefused) {
    // THE ONE PLAIN REASON. Whatever else was or was not read, the business
    // account side is unreadable until the separate credential is on the
    // server, and waiting will not change that.
    out.push(step('business_account', { state: 'blocked', detail: BP_KEY_BLOCKED_DETAIL, action: 'add_bp_key', hint: bpKeyBlockedHint(bpSecret, target || env) }));
  } else if (!holder && holderRead.needsPlatform === true) {
    out.push(step('business_account', { state: 'attention', detail: PLATFORM_STEP_DETAIL, action: 'set_balance_platform' }));
  } else if (!holder && holderRead.ambiguous === true) {
    out.push(step('business_account', { state: 'attention', detail: HOLDER_AMBIGUOUS_DETAIL, action: 'pick_holder', hint: 'Pick the right one from the list below.' }));
  } else if (!holder && holderRead.capped === true) {
    out.push(step('business_account', { state: 'attention', detail: 'Not every business account at Adyen could be checked.', action: 'find_venue', hint: 'Open Advanced in step 1 if Adyen gave you its id.' }));
  } else if (!holder) out.push(step('business_account', { state: 'todo', detail: 'No business account at Adyen yet.', action: 'find_venue', hint: 'Adyen makes one when the venue is onboarded. Look again after that.' }));
  else if (linkAll) {
    out.push(step('business_account', { state: 'attention', detail: DETAILS_NOT_SAVED_DETAIL, action: 'link_all', hint: 'One click saves all of them on the venue.' }));
  } else if (!holderNamed) {
    // Found at Adyen, not on the venue row. ONE button saves it (adyen_link on
    // the venue's own environment with this account holder id): the holder,
    // where the money lands, the registered company, the business line, the
    // bank account, the KYC snapshot and the payout flag all land on the row.
    out.push(step('business_account', { state: 'attention', detail: HOLDER_NOT_SAVED_DETAIL, action: 'link_holder', hint: 'One click writes it on the venue.' }));
  } else if (!moneySaved) {
    // The holder is on the row, but where the money lands is blank or is not
    // the holder's own account. The same click writes the right one (a
    // replacement asks first, as every money side replacement does).
    out.push(step('business_account', { state: 'attention', detail: HOLDER_MONEY_MISMATCH_DETAIL, action: 'link_holder', hint: 'One click saves the right one.' }));
  } else {
    const blocked = blockedCapabilityNames(caps);
    // Taking cards and paying out are separate refusals. Only a refused PAY IN
    // stops the venue taking a card, so only that one blocks the flow; paying
    // out has its own step (5), so nothing about it is said here.
    const blockedIn = blocked.filter(isPayInCapability);
    const pendingIn = caps.filter((c) => c.blocked === true && c.verification === 'pending' && isPayInCapability(c.name)).map((c) => str(c.name)).filter(Boolean);
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
    } else if (pendingIn.length) {
      out.push(step('business_account', { state: 'attention', detail: `Adyen is still checking ${pendingIn.join(' and ')}.`, action: null, hint: 'Cards can still work while it checks.' }));
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
  } else if (linkAll) {
    out.push(step('payments_location', { state: 'attention', detail: DETAILS_NOT_SAVED_DETAIL, action: 'link_all', hint: 'One click saves all of them on the venue.' }));
  } else if (storeActive && !storeSaved) {
    // Found at Adyen, not on the venue row. ONE button saves it (adyen_link on
    // the venue's own environment with this store id), and that works with
    // the Balance Platform read refused: only the store side is written.
    out.push(step('payments_location', { state: 'attention', detail: STORE_NOT_SAVED_DETAIL, action: 'link_store', hint: 'One click writes it on the venue.' }));
  } else if (storeActive) {
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
  const storeReady = storeActive && !mismatch && storeSaved;
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
  } else if (env === 'live' && storeActive && !mismatch && !storeSaved) {
    // Live, the store is fine at Adyen, and the venue row does not name it:
    // a card names a store the venue has not been told about. Step 3 saves it.
    out.push(step('go_live', { state: 'attention', detail: 'Real cards are on, but the payments location is not saved on the venue.', action: null, hint: 'Save it in the step above.' }));
  } else if (env === 'live') {
    out.push(step('go_live', { state: 'attention', detail: 'Real cards are on, but the store is not ready.', action: null, hint: 'Fix the step above, or switch back to test cards.' }));
  } else if (storeReady && holder) {
    out.push(step('go_live', { state: 'todo', detail: 'Ready to switch from test cards to real money.', action: 'go_live', hint: 'This writes the Adyen ids on the venue and moves it over.' }));
  } else {
    out.push(step('go_live', { state: 'todo', detail: 'Finish the steps above first.', action: null }));
  }

  // 5. card rates and payouts: two parts, one step
  out.push(buildPayoutsStep({
    keysOk, keysBlocked, bpRefused, holder, holderSaved, ba, le, store, storeSaved, mismatch, caps, row, rates, payouts,
  }));

  // 6. the card readers
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

// Step 5 on its own: the split part and the payout part, then the step that
// carries them. Every line under 120 characters, no id in a sentence.
function buildPayoutsStep(x) {
  const part = (id, p) => ({ id, state: p.state, detail: p.detail, action: p.action ?? null, hint: p.hint ?? null });
  const row = x.row;
  // NO ROW IN HAND means the flow is looking at the OTHER environment (a test
  // venue looking at live, the go live path). The three writes behind this
  // step (set_split, onboarding_link, setup_sweep) act on the venue's OWN
  // row and account, so offering them here would set a commission on the
  // test store, mint a bank details link for the test legal entity, or sweep
  // the test balance account (9 Sep 2026). Nothing is offered until the venue
  // is on the account the flow looks at: step 4 moves it.
  if (!row) {
    const wait = { state: 'todo', detail: PAYOUTS_WAIT_FOR_LIVE_DETAIL, action: null };
    return { id: 'payouts', state: 'todo', detail: wait.detail, action: null, hint: null, parts: [part('split', wait), part('payout', wait)] };
  }
  const rowBa = str(row.balance_account_id);
  const rowTi = str(row.transfer_instrument_id);
  const rates = isObj(x.rates) ? x.rates : {};
  const currency = str(rates.currency).toUpperCase() || str(x.ba?.currency).toUpperCase() || 'GBP';
  // THE VENUE RATE CARD (10 Sep 2026): four tiers, every one priced before
  // anything goes to Adyen. The four rates in one line ride as the hint and,
  // when short, as the collapsed step's own line.
  const tiers = isObj(rates.tiers) ? rates.tiers : {};
  const unpriced = unpricedTiers(tiers);
  const priced = unpriced.length === 0;
  const line = priced ? rateCardLine(tiers, currency) : null;
  const shortLine = line && line.length <= PROBLEM_TEXT_MAX ? line : null;
  const onAdyen = isObj(rates.onAdyen) ? rates.onAdyen : {};
  const profileRead = onAdyen.read === true;
  const remainder = str(onAdyen.remainder);

  // (a) the card rates on the store
  let split;
  if (!x.keysOk) split = part('split', x.keysBlocked);
  else if (!x.store && !x.holder) split = part('split', { state: 'todo', detail: 'Find the venue first.', action: null });
  else if (x.mismatch && str(x.mismatch.found)) split = part('split', { state: 'todo', detail: 'Pick the right Adyen account in step 3 first.', action: null });
  else if (!x.store) split = part('split', { state: 'todo', detail: 'Make the payments location first.', action: null });
  else if (!x.storeSaved) split = part('split', { state: 'todo', detail: 'Save the payments location on the venue first.', action: null });
  else if (!x.holderSaved) split = part('split', { state: 'todo', detail: 'Save the business account on the venue first.', action: null });
  else if (!rowBa) split = part('split', { state: 'todo', detail: 'The venue has no account for the money to land in yet.', action: null, hint: 'Save the business account in step 2.' });
  else if (rates.readFailed === true) {
    // THE VENUE RATES COULD NOT BE READ (10 Sep 2026): the tiers above are a
    // fallback, not the venue's card, so nothing is compared and nothing is
    // offered to apply. Check again reads the venue once more.
    split = part('split', { state: 'attention', detail: 'The venue rates could not be read, so they are not checked yet.', action: 'check_rates', hint: null });
  } else if (!priced) {
    // A tier with no price cannot go to Adyen: name the tiers in the table's
    // own row words and offer the editor. 0% and 0p is a price; empty is not.
    split = part('split', { state: 'attention', detail: `No rate is set yet for: ${tierRowList(unpriced)}.`, action: 'edit_rates', hint: 'Set every payment type, then apply the rates on Adyen.' });
  } else if (str(x.store.splitConfigurationId)) {
    // DONE needs all of these (9 and 10 Sep 2026): the store names an account
    // for the rest of each sale, it is the venue's own, the profile was READ,
    // the rules send the rest there (a profile whose remainder is
    // addToLiableAccount keeps it for the platform), and the whole profile is
    // what we would write for these rates. A profile that could not be read
    // is never shown as done: its rates are not checked.
    const storeBa = str(x.store.balanceAccountId);
    if (!storeBa) {
      split = part('split', { state: 'attention', detail: 'The rates on Adyen name no account for the rest of each sale.', action: 'set_split', hint: 'Apply the rates again to point them at the venue.' });
    } else if (storeBa !== rowBa) {
      split = part('split', { state: 'attention', detail: 'The rates on Adyen send the rest of each sale to a different account, not the venue’s.', action: 'set_split', hint: 'Apply the rates again to point them at the venue.' });
    } else if (!profileRead) {
      split = part('split', { state: 'attention', detail: 'Adyen’s rates could not be read, so they are not checked yet.', action: 'check_rates', hint: null });
    } else if (lower(remainder) !== lower(REMAINDER_TO_VENUE)) {
      split = part('split', { state: 'attention', detail: 'The rates on Adyen do not send the rest of each sale to the venue.', action: 'set_split', hint: 'Apply the rates again to point them at the venue.' });
    } else if (onAdyen.matches !== true) {
      split = part('split', { state: 'attention', detail: 'Adyen holds different rates. Apply again.', action: 'set_split', hint: shortLine });
    } else {
      split = part('split', { state: 'done', detail: 'Adyen holds these rates.', hint: shortLine });
    }
  } else {
    split = part('split', {
      state: 'attention',
      detail: 'Adyen does not hold these rates yet, so every card sale settles to the platform and nothing to the venue.',
      action: 'set_split',
      hint: shortLine,
    });
  }

  // (b) the bank account, Adyen's approval and the daily sweep
  let payout;
  const capability = payoutCapabilityState(x.caps);
  const hasBank = !!(str(x.le?.transferInstrumentId) || rowTi);
  const sweep = isObj(x.payouts.sweep) && str(x.payouts.sweep.id) ? x.payouts.sweep : null;
  if (!x.keysOk) payout = part('payout', x.keysBlocked);
  // The same server secret step 2 is blocked on. The ONE plain reason is said
  // at step 2 and nowhere else, so this line only points there; the action
  // names the secret step so the flow (goliveFlowView) treats it as server
  // only and never parks the owner here, and the screen draws no button.
  else if (x.bpRefused) payout = part('payout', { state: 'blocked', detail: 'Payouts cannot be checked until step 2 is fixed.', action: 'add_bp_key', hint: null });
  else if (!x.holder) payout = part('payout', { state: 'todo', detail: 'Find the venue first.', action: null });
  else if (!x.holderSaved) payout = part('payout', { state: 'todo', detail: 'Save the business account on the venue first.', action: null });
  else if (!hasBank) {
    payout = part('payout', { state: 'todo', detail: 'The venue has not added its bank account yet.', action: 'send_bank_link', hint: 'One click makes a link for the venue owner.' });
  } else if (capability === 'allowed' && sweep) {
    const when = sweep.schedule && sweep.schedule !== 'daily' ? sweep.schedule : 'daily';
    payout = part('payout', { state: 'done', detail: `Paid out ${when} to the venue bank.` });
  } else if (capability === 'allowed') {
    payout = part('payout', { state: 'todo', detail: 'The bank account is approved. Daily payouts are not switched on yet.', action: 'setup_sweep', hint: 'One click pays the venue out every day.' });
  } else if (capability === 'unrequested') {
    // Never asked for, so it can never become allowed. Asking is ONE call
    // (PATCH the holder with requested true), so the flow asks instead of
    // sending the owner to the Customer Area (9 Sep 2026).
    payout = part('payout', { state: 'todo', detail: 'Adyen was never asked to allow payouts for this venue.', action: 'request_payouts', hint: 'One click asks Adyen. It then checks the venue.' });
  } else if (capability === 'needs_details') {
    // Adyen wants more from the venue (a bank statement, an identity
    // document): the hosted onboarding page is where it is given.
    payout = part('payout', { state: 'attention', detail: 'Adyen needs more details from the venue.', action: 'send_bank_link', hint: 'One click makes a link for the venue owner to give them.' });
  } else if (capability === 'rejected') {
    payout = part('payout', { state: 'attention', detail: 'Adyen will not pay this venue out yet.', action: 'open_adyen', hint: 'Clear the check in the Adyen Customer Area, then check again.' });
  } else {
    payout = part('payout', { state: 'attention', detail: 'Adyen is still checking the venue. Payouts start when it is approved.', action: 'check_payouts', hint: null });
  }

  // the step: the worst colour, and the first part with work the owner can do
  const parts = [split, payout];
  const rank = { blocked: 3, attention: 2, todo: 1, done: 0 };
  const worst = parts.reduce((a, p) => (rank[p.state] > rank[a] ? p.state : a), 'done');
  const next = parts.find((p) => p.state !== 'done' && p.action && !PAYOUT_WAIT_ACTIONS.includes(p.action))
    || parts.find((p) => p.state !== 'done');
  const both = split.state === 'done' && payout.state === 'done';
  // The collapsed line when everything is done: the four rates when they fit
  // in one line, else the plain sentence.
  const bothLine = shortLine && `${shortLine}. ${payout.detail}`.length <= PROBLEM_TEXT_MAX ? `${shortLine}. ${payout.detail}` : `Adyen holds these rates. ${payout.detail}`;
  return {
    id: 'payouts',
    state: worst,
    detail: both ? bothLine : str(next?.detail) || split.detail,
    action: next && next.action && !PAYOUT_WAIT_ACTIONS.includes(next.action) ? next.action : null,
    hint: both ? null : (next?.hint ?? null),
    parts,
  };
}

// ── PLAIN PROBLEMS FOR THE SCREEN (9 Sep 2026, OWNER FEEDBACK) ───────────────
// "just errors all over the place, I dont know whats happening". The live
// screen showed a box of four long code lines for ONE fact: the payments key
// cannot read the Balance Platform, and Adyen issues a separate credential for
// that. So every error string the function collects becomes ONE plain line
// under PROBLEM_TEXT_MAX characters, deduped by that line, with the raw Adyen
// status and message kept apart in rawDetail for the small Show detail toggle.
//   kind       what it is, so the screen can route it: a bp_refused line is
//              said once, at the business account step, and nowhere else; a
//              mismatch has its own block
//   text       the plain line, under PROBLEM_TEXT_MAX characters, no ids
//   rawDetail  the raw line(s) as the function produced them
export const PROBLEM_TEXT_MAX = 120;

// The refusal line refusalText (adyen-terminal-admin) builds: "refused (401):
// the credential behind ADYEN_LIVE_UK_BP_KEY (the set's API key when that is
// unset) needs the Balance Platform BCL role". The secret NAME in it says
// which key was refused; the role text is the fallback.
const REFUSED = /\brefused \((401|403)\)/i;
function refusedKey(raw) {
  if (!REFUSED.test(raw)) return null;
  if (/_BP_KEY\b/.test(raw)) return 'bp';
  if (/_LEM_KEY\b/.test(raw)) return 'lem';
  if (/_MANAGEMENT_KEY\b/.test(raw)) return 'management';
  if (/Legal Entity role|LegalEntities/i.test(raw)) return 'lem';
  if (/Balance Platform BCL role/i.test(raw)) return 'bp';
  if (/Management API role/i.test(raw)) return 'management';
  return 'unknown';
}

// What an error line is about, from the label the function puts first. Adyen
// words become the plain words the screen uses everywhere else.
const PROBLEM_SUBJECTS = Object.freeze([
  [/^(store list|store search)/i, 'the payments locations'],
  [/^merchant list/i, 'the Adyen accounts'],
  [/^store\b/i, 'the payments location'],
  [/^balance accounts? of\b/i, 'where the money lands'],
  [/^balance account\b/i, 'where the money lands'],
  [/^account holders? on balance platform/i, 'the business accounts'],
  [/^account holder\b/i, 'the business account'],
  [/^legal entity\b/i, 'the registered company'],
  [/^business lines? of\b/i, 'the business line'],
  [/^web origins/i, 'the web addresses'],
  [/^apple pay/i, 'Apple Pay'],
  [/^sweeps? (of|on)\b/i, 'the payout schedule'],
  [/^split configuration\b/i, 'the card rates on Adyen'],
  [/^onboarding link\b/i, 'the bank details link'],
  [/^platform defaults?\b/i, 'the default rates'],
  [/^payout (capability|approval)\b/i, 'the payout approval'],
  [/^rate card\b/i, 'the venue rates'],
]);

// ONE raw error line as the screen shows it, or null for an empty line.
export function plainAdyenProblem(raw) {
  const text = str(raw);
  if (!text) return null;
  const say = (kind, plain) => ({ kind, text: plain, rawDetail: text });
  const key = refusedKey(text);
  if (key === 'bp') return say('bp_refused', BP_KEY_BLOCKED_DETAIL);
  if (key === 'lem') return say('lem_refused', 'Our key cannot read the registered company at Adyen. It needs the legal entity roles.');
  if (key === 'management') return say('management_refused', 'Our payments key is missing an Adyen permission, so a read was refused.');
  if (key) return say('refused', 'Adyen refused one of our keys.');
  // Our OWN lists (Postgres) before the Adyen timeout words: "The reader list
  // could not be read: connection timed out" is our database, not Adyen.
  if (/reader list|till links/i.test(text)) return say('readers', 'The card reader list could not be read, so step 5 may be wrong.');
  if (/online address/i.test(text)) return say('storefront', 'The venue’s web address could not be read.');
  if (/did not answer .* within \d+s/i.test(text) || /\btimed? ?out\b/i.test(text)) return say('timeout', 'Adyen took too long to answer. Try again in a moment.');
  if (/sits on merchant account/i.test(text)) return say('mismatch', 'This venue is on a different Adyen account than the one we are set to use.');
  // The store's split configuration names a balance account that belongs to
  // another account holder (9 Sep 2026): step 5a says it in its own place.
  if (/belongs to (a different|another) (account holder|business account)/i.test(text)) return say('foreign_balance_account', 'The payments location sends the rest of each sale to another business account.');
  if (/stores carry the reference/i.test(text)) return say('ambiguous_store', 'More than one payments location carries this code. Pick one in step 1.');
  if (/account holders .* carry the reference/i.test(text)) return say('ambiguous_holder', 'More than one business account carries this code. Pick the right one from the list.');
  if (/names no account holder/i.test(text)) return say('gap', 'Where the money lands names no business account at Adyen.');
  if (/names no legal entity/i.test(text)) return say('gap', 'The business account names no registered company at Adyen.');
  if (/none could be chosen/i.test(text)) return say('gap', 'The business account has several money accounts and none could be chosen.');
  if (/no venue code/i.test(text)) return say('no_code', 'This venue has no code, so there is nothing to search for.');
  for (const [re, subject] of PROBLEM_SUBJECTS) if (re.test(text)) return say('read_failed', `Adyen would not answer about ${subject}.`);
  return say('other', 'Adyen said something we did not expect.');
}

// The settings warning for a platform table the migration has not made yet
// (platformSettingsMissingMessage), told apart from a read or write failure.
export function isPlatformSettingsMissingWarning(text) {
  const t = lower(text);
  return !!t && t.includes(ADYEN_PLATFORM_SETTINGS_TABLE) && t.includes('not there yet');
}

// Everything golive_state (and adyen_lookup, adyen_link) says about problems,
// ready for the screen:
//   raw        the error lines with exact repeats dropped (the pasted account
//              holder was refused twice, word for word, on the live screen)
//   problems   one plain line per DISTINCT plain text, first come first kept,
//              every raw line behind it in rawDetail
//   bpRefused  the Balance Platform refused our key: the business account step
//              says the one reason and the box says nothing about it
//   platformSettingsMissing  the settings table is not there yet: one short
//              line at the top of the flow, never inside the box
export function goliveProblems(errors, { settingsWarning } = {}) {
  const raw = [];
  const seenRaw = new Set();
  for (const e of Array.isArray(errors) ? errors : []) {
    const t = str(e);
    if (!t || seenRaw.has(t)) continue;
    seenRaw.add(t);
    raw.push(t);
  }
  const problems = [];
  const byText = new Map();
  const add = (p) => {
    if (!p) return;
    const have = byText.get(p.text);
    if (have) {
      if (p.rawDetail && !have.rawDetail.split('\n').includes(p.rawDetail)) have.rawDetail = `${have.rawDetail}\n${p.rawDetail}`;
      return;
    }
    byText.set(p.text, p);
    problems.push(p);
  };
  for (const t of raw) add(plainAdyenProblem(t));
  const warning = str(settingsWarning);
  const platformSettingsMissing = isPlatformSettingsMissingWarning(warning);
  if (warning && !platformSettingsMissing) {
    add({
      kind: 'settings',
      text: /nothing was changed/i.test(warning)
        ? 'This venue sits on a different Adyen platform than the one we search.'
        : 'Our own Adyen ids could not be kept this time.',
      rawDetail: warning,
    });
  }
  return { raw, problems, bpRefused: problems.some((p) => p.kind === 'bp_refused'), platformSettingsMissing };
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
