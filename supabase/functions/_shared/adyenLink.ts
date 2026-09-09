// supabase/functions/_shared/adyenLink.ts
//
// Pull a venue's Adyen ids from Adyen BY REFERENCE (the venue code, for
// example SV-1007), never typed. PURE: no Deno APIs, no Supabase, no network.
//
// MIRROR: src/lib/payments/adyenLink.js carries the SAME helpers (Deno
// cannot import from src/). KEEP IN SYNC: change both or neither.
// src/lib/payments/adyenLink.test.js is the contract for both copies.
//
// Used by adyen-terminal-admin (adyen_lookup, adyen_link,
// adyen_create_store_by_reference and the reference first find in
// ensure_store). The chain, all reads, three credentials:
//   1. Management API v3    GET /merchants/{m}/stores?reference=SV-1007   (cfg.managementKey)
//        store id (ST...), status, businessLineIds, splitConfiguration
//        { balanceAccountId, splitConfigurationId }
//   2. Balance Platform v2  GET /balanceAccounts/{id}      accountHolderId   (cfg.bpKey)
//   3. Balance Platform v2  GET /accountHolders/{id}       legalEntityId, capabilities,
//        primaryBalanceAccount                                               (cfg.bpKey)
//   4. LEM v4               GET /legalEntities/{id}        legal name, verification,
//        transferInstruments[]                                               (cfg.lemKey)
// There is no account holder lookup by reference; the store's split
// configuration is the only documented path from a venue code to a balance
// account. When the store carries none, a known account holder id plus
// GET /accountHolders/{id}/balanceAccounts is the fallback (pickBalanceAccount).
//
// THE VENUE CODE IS NOT ALWAYS A STORE REFERENCE (8 Sep 2026, live screens):
// on the live account SV-1007 is the ACCOUNT HOLDER reference and no store
// carries it, so the lookup also sweeps every merchant the credential can see
// and matches account holders by reference. See FIND THE VENUE HOWEVER ADYEN
// HOLDS IT further down for those endpoints and the merchant mismatch rule.

export const LINK_ID_FIELDS: readonly string[] = Object.freeze([
  'merchant_account', 'store_id', 'split_profile_id', 'balance_account_id',
  'account_holder_id', 'legal_entity_id', 'business_line_id', 'transfer_instrument_id',
]);

export const VERIFICATION_ORDER: readonly string[] = Object.freeze(['valid', 'pending', 'invalid', 'rejected']);

type Dict = Record<string, any>;

const isObj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const lower = (v: unknown): string => str(v).toLowerCase();
const orNull = (v: unknown): string | null => str(v) || null;
// The US secret set (adyen.ts's US_CODES); anything else reads as UK, as it
// does everywhere else. Only used to build a secret NAME here.
const isUsRegion = (v: unknown): boolean => ['US', 'USA', 'USD'].includes(str(v).toUpperCase());

export interface StoreSummary {
  id: string | null;
  reference: string | null;
  status: string | null;
  description: string | null;
  shopperStatement: string | null;
  merchantId: string | null;
  phoneNumber: string | null;
  address: Record<string, string> | null;
  businessLineIds: string[];
  splitConfigurationId: string | null;
  balanceAccountId: string | null;
}

export interface StoreCandidate {
  id: string;
  reference: string | null;
  description: string | null;
  status: string | null;
  merchantId: string | null;
}

export interface CapabilityEntry {
  enabled: unknown;
  allowed: unknown;
  requested: unknown;
  verificationStatus: string | null;
  problems: unknown[] | undefined;
}

export interface CapabilitySummary {
  receiveOk: boolean;
  payoutsOk: boolean;
  verificationStatus: string | null;
  problems: string[];
  byName: Record<string, CapabilityEntry>;
}

export interface LegalEntitySummary {
  id: string | null;
  name: string | null;
  type: string | null;
  reference: string | null;
  status: string | null;
  transferInstrumentId: string | null;
  transferInstruments: string[];
  problems: string[];
  capabilities: Record<string, CapabilityEntry>;
}

export interface AccountHolderSummary {
  id: string | null;
  reference: string | null;
  description: string | null;
  status: string | null;
  legalEntityId: string | null;
  primaryBalanceAccount: string | null;
  balancePlatform: string | null;
  capabilities: CapabilitySummary;
}

export interface BalanceAccountSummary {
  id: string | null;
  reference: string | null;
  description: string | null;
  status: string | null;
  accountHolderId: string | null;
  currency: string | null;
  source: string;
}

export interface LookupResult {
  found: boolean;
  reference: string | null;
  merchantAccount?: string | null;
  store?: StoreSummary | null;
  balanceAccount?: BalanceAccountSummary | null;
  accountHolder?: AccountHolderSummary | null;
  legalEntity?: LegalEntitySummary | null;
  splitConfigurationId?: string | null;
  businessLineIds?: string[];
  candidates?: StoreCandidate[];
  // Every EXACT reference match with the merchant account it sits on.
  storeHits?: StoreCandidate[];
  // Every capability of the account holder, blocked ones first, so a Blocked
  // one is visible BY NAME (capabilityList; the type is declared further down).
  capabilities?: Array<{ name: string; allowed: boolean; requested: boolean; enabled: boolean; verification: string | null; blocked: boolean; problems: number }>;
  errors?: string[];
  notes?: string[];
  scopeMissing?: boolean;
  // 8 Sep 2026, the two route lookup (FIND THE VENUE HOWEVER ADYEN HOLDS IT)
  holderCandidates?: unknown[];
  merchantMismatch?: unknown;
  merchantsSearched?: string[];
  balancePlatform?: string | null;
  storeNeeded?: string | null;
  [k: string]: unknown;
}

export interface LinkDiff {
  changed: string[];
  conflicts: Array<{ field: string; current: string; next: string }>;
  same: string[];
  unchanged: boolean;
}

export interface LinkPlan {
  kind: 'noop' | 'refuse' | 'update' | 'flip';
  diff: LinkDiff;
  reason: string | null;
}

// Comparison key for a store reference: trimmed, upper case. Adyen keeps the
// case the creator typed and the venue code is upper case by convention, so
// SV-1007 and sv-1007 are the same venue.
export function referenceKey(value: unknown): string {
  return str(value).toUpperCase();
}

// The rows of a Management API list answer ({ data: [...] }) or a bare array.
// Anything that is not an object row is dropped.
export function storeRows(response: unknown): Dict[] {
  if (Array.isArray(response)) return response.filter(isObj);
  return Array.isArray((response as Dict)?.data) ? ((response as Dict).data as unknown[]).filter(isObj) : [];
}

// Find the venue's store by reference: EXACT match, case insensitive, never
// partial. Duplicate rows (a page repeated) collapse by id. More than one
// distinct store with the reference is `ambiguous` (the reference is unique
// inside a merchant account only, so a credential wide search can return
// one per merchant): then `store` is null and the caller picks by id.
export function matchStoreByReference(rows: unknown, reference: unknown): { store: Dict | null; matches: Dict[]; ambiguous: boolean } {
  const key = referenceKey(reference);
  if (!key) return { store: null, matches: [], ambiguous: false };
  const seen = new Set<string>();
  const matches: Dict[] = [];
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
export function storeSummary(store: unknown): StoreSummary | null {
  if (!isObj(store)) return null;
  const split: Dict = isObj(store.splitConfiguration) ? store.splitConfiguration : {};
  const a: Dict = isObj(store.address) ? store.address : {};
  const address: Record<string, string> = {};
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
export function storeCandidates(rows: unknown, reference: unknown, limit = 50): StoreCandidate[] {
  const key = referenceKey(reference);
  const seen = new Set<string>();
  const out: StoreCandidate[] = [];
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
  const score = (c: StoreCandidate): number => {
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
export function worstVerificationStatus(statuses: unknown): string | null {
  let worst = -1;
  for (const s of Array.isArray(statuses) ? statuses : []) {
    const i = VERIFICATION_ORDER.indexOf(lower(s));
    if (i > worst) worst = i;
  }
  return worst < 0 ? null : VERIFICATION_ORDER[worst];
}

// One readable line per Adyen problem ({ entity, verificationErrors: [{
// code, message, remediatingActions }] }), prefixed with the capability.
function problemLines(prefix: string, problem: unknown): string[] {
  const p: Dict = isObj(problem) ? problem : {};
  const errors: unknown[] = Array.isArray(p.verificationErrors) ? p.verificationErrors : [];
  const texts = errors.map((e) => str((e as Dict)?.message) || str((e as Dict)?.code)).filter(Boolean);
  if (!texts.length) {
    const single = str(p.message) || str(p.code);
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
export function summariseCapabilities(capabilities: unknown): CapabilitySummary {
  const c: Dict = isObj(capabilities) ? capabilities : {};
  const byName: Record<string, CapabilityEntry> = {};
  const problems: string[] = [];
  const statuses: unknown[] = [];
  for (const [name, v] of Object.entries(c)) {
    if (!isObj(v)) continue;
    const raw: unknown[] = Array.isArray(v.problems) ? v.problems : [];
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
  const allowed = (k: string) => byName[k]?.allowed === true;
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
export function legalEntityName(le: unknown): string | null {
  if (!isObj(le)) return null;
  const org = str(le.organization?.legalName);
  if (org) return org;
  const ind: Dict = isObj(le.individual?.name) ? le.individual.name : {};
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
export function legalEntitySummary(le: unknown): LegalEntitySummary | null {
  if (!isObj(le)) return null;
  const caps = summariseCapabilities(le.capabilities);
  const instruments = (Array.isArray(le.transferInstruments) ? le.transferInstruments : [])
    .map((t: unknown) => str(isObj(t) ? t.id : t)).filter(Boolean);
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
export function accountHolderSummary(ah: unknown): AccountHolderSummary | null {
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
export function balanceAccountSummary(ba: unknown, source = 'store'): BalanceAccountSummary | null {
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
export function pickBalanceAccount(list: unknown, { primaryId, currency }: { primaryId?: unknown; currency?: unknown } = {}): Dict | null {
  const source: unknown[] = Array.isArray((list as Dict)?.balanceAccounts) ? (list as Dict).balanceAccounts : Array.isArray(list) ? list : [];
  const rows = source.filter(isObj);
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
export function resolveLinkEnvironment(currentEnv: unknown, requested: unknown): 'test' | 'live' {
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
export function buildLinkPatch(
  lookup: unknown,
  { merchantAccount, region, environment, at }: { merchantAccount?: unknown; region?: unknown; environment?: unknown; at?: unknown } = {},
): Record<string, unknown> {
  const l: Dict = isObj(lookup) ? lookup : {};
  const store: Dict | null = isObj(l.store) ? l.store : null;
  const ba: Dict | null = isObj(l.balanceAccount) ? l.balanceAccount : null;
  const ah: Dict | null = isObj(l.accountHolder) ? l.accountHolder : null;
  const le: Dict | null = isObj(l.legalEntity) ? l.legalEntity : null;
  const patch: Record<string, unknown> = {};
  const merchant = str(merchantAccount) || str(store?.merchantId);
  if (merchant) patch.merchant_account = merchant;
  if (str(store?.id)) patch.store_id = str(store!.id);
  const split = str(l.splitConfigurationId) || str(store?.splitConfigurationId);
  if (split) patch.split_profile_id = split;
  const baId = str(ba?.id) || str(store?.balanceAccountId);
  if (baId) patch.balance_account_id = baId;
  const ahId = str(ah?.id) || str(ba?.accountHolderId);
  if (ahId) patch.account_holder_id = ahId;
  const leId = str(le?.id) || str(ah?.legalEntityId);
  if (leId) patch.legal_entity_id = leId;
  const lines: unknown = Array.isArray(l.businessLineIds) && l.businessLineIds.length ? l.businessLineIds : (store?.businessLineIds ?? []);
  const line = str(Array.isArray(lines) ? lines[0] : '');
  if (line) patch.business_line_id = line;
  const instrument = str(le?.transferInstrumentId) || str(Array.isArray(le?.transferInstruments) ? le!.transferInstruments[0] : '');
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
export function linkDiff(row: unknown, patch: unknown): LinkDiff {
  const r: Dict = isObj(row) ? row : {};
  const p: Dict = isObj(patch) ? patch : {};
  const changed: string[] = [];
  const conflicts: Array<{ field: string; current: string; next: string }> = [];
  const same: string[] = [];
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
export function planLink(
  { row, currentEnv, targetEnv, patch, provisioned = [], readers = 0, relink = false, storeStatus = null }:
  { row?: unknown; currentEnv?: unknown; targetEnv?: unknown; patch?: unknown; provisioned?: unknown; readers?: unknown; relink?: unknown; storeStatus?: unknown } = {},
): LinkPlan {
  const diff = linkDiff(row, patch);
  const p: Dict = isObj(patch) ? patch : {};
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
export function replacementClear(patch: unknown): Record<string, unknown> {
  const p: Dict = isObj(patch) ? patch : {};
  const clear: Record<string, unknown> = {};
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
// store carries it), so either one counts as found and the other reads as the
// gap it is.
export function lookupSummary(lookup: unknown): string {
  const l: Dict = isObj(lookup) ? lookup : {};
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
// FranPOS_QSR_UK (the value of ADYEN_LIVE_UK_MERCHANT_ACCOUNT) found 0 stores,
// and the Adyen row for that account holder names a DIFFERENT merchant
// account, FranPOS_UK. So the venue is onboarded on the Balance Platform first
// and its store either sits under another merchant account or does not exist
// yet.
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
//                 so the balance platform id is the only way in: it comes from
//                 an account holder or balance account already on the row,
//                 from a pasted id, or from the secret named by
//                 balancePlatformSecretName below.
// Neither the account holder nor the balance account names a merchant account
// or a store (AccountHolder carries balancePlatform, reference, status,
// capabilities, legalEntityId and primaryBalanceAccount, nothing else), so the
// merchant a venue charges on can only come from the store or from the admin.
// A store found on a merchant that is not the configured one is never used
// silently: merchantMismatch says so, and the admin passes merchantAccount to
// link it there on purpose.

export const BALANCE_PLATFORM_SECRET_SUFFIX = 'BALANCE_PLATFORM';

export interface MerchantSummary {
  id: string | null;
  name: string | null;
  reference: string | null;
  status: string | null;
  description: string | null;
  companyId: string | null;
  currency: string | null;
}

export interface AccountHolderCandidate {
  id: string;
  reference: string | null;
  description: string | null;
  status: string | null;
  legalEntityId: string | null;
  balancePlatform: string | null;
}

export interface MerchantMismatch {
  configured: string;
  found: string;
  secret: string | null;
  storeId: string | null;
  reference: string | null;
  message: string;
}

// The secret that would hold the balance platform id (BP...). It does not
// exist yet: ADYEN_SECRET_SUFFIXES has no such field, so the name is built
// here under the SAME rule adyenSecretName follows (test is unprefixed, live
// carries the region, live UK falls back to the unsuffixed name).
export function balancePlatformSecretName(env: unknown, region: unknown): string {
  const s = BALANCE_PLATFORM_SECRET_SUFFIX;
  if (lower(env) !== 'live') return `ADYEN_${s}`;
  return `ADYEN_LIVE_${isUsRegion(region) ? 'US' : 'UK'}_${s}`;
}

// Every name read for the balance platform id, in read order.
export function balancePlatformSecretNames(env: unknown, region: unknown): string[] {
  const s = BALANCE_PLATFORM_SECRET_SUFFIX;
  if (lower(env) !== 'live') return isUsRegion(region) ? [`ADYEN_TEST_US_${s}`, `ADYEN_${s}`] : [`ADYEN_${s}`];
  return isUsRegion(region) ? [`ADYEN_LIVE_US_${s}`] : [`ADYEN_LIVE_UK_${s}`, `ADYEN_LIVE_${s}`];
}

// Rows of a Management API list answer ({ data: [...] }) or a bare array:
// GET /merchants answers the same shape as the store lists.
export function merchantRows(response: unknown): Dict[] {
  return storeRows(response);
}

// Rows of a Balance Platform paged answer ({ accountHolders: [...] }) or a
// bare array. Anything that is not an object row is dropped.
export function accountHolderRows(response: unknown): Dict[] {
  if (Array.isArray(response)) return response.filter(isObj);
  const rows = (response as Dict | null | undefined)?.accountHolders;
  return Array.isArray(rows) ? rows.filter(isObj) : [];
}

// A GET /merchants row as the admin picker shows it. Adyen's own casing is
// kept on `status` (Active, PreActive, Inactive, Closed): it is shown as a
// word, never compared. `storeCount` is filled in by the caller (one
// GET /merchants/{m}/stores?pageSize=1 answers itemsTotal).
export function merchantSummary(merchant: unknown): MerchantSummary | null {
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
// migrated from the classic integration keeps its old code there). Duplicates
// collapse by id; more than one distinct holder is `ambiguous` and the admin
// picks by pasting the id.
export function matchAccountHolderByReference(rows: unknown, reference: unknown): { holder: Dict | null; matches: Dict[]; ambiguous: boolean } {
  const key = referenceKey(reference);
  if (!key) return { holder: null, matches: [], ambiguous: false };
  const seen = new Set<string>();
  const matches: Dict[] = [];
  for (const ah of accountHolderRows(rows)) {
    if (referenceKey(ah.reference) !== key && referenceKey(ah.migratedAccountHolderCode) !== key) continue;
    const id = str(ah.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    matches.push(ah);
  }
  return { holder: matches.length === 1 ? matches[0] : null, matches, ambiguous: matches.length > 1 };
}

// The account holders the admin may pick from when the reference matched none:
// exact matches first, then a reference, code or description that mentions it,
// then the rest in Adyen's order. Deduped by id, at most `limit`.
export function accountHolderCandidates(rows: unknown, reference: unknown, limit = 50): AccountHolderCandidate[] {
  const key = referenceKey(reference);
  const seen = new Set<string>();
  const out: AccountHolderCandidate[] = [];
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
  const score = (c: AccountHolderCandidate): number => {
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

// The business line a store must name, from GET /legalEntities/{id}/businessLines
// ({ businessLines: [{ id, service, industryCode, ... }] }) or a bare array:
// the one whose service is paymentProcessing, else the only line there is.
// Several of the same service is null (the admin picks).
export function pickBusinessLine(list: unknown, service = 'paymentProcessing'): Dict | null {
  const raw = (list as Dict | null | undefined)?.businessLines;
  const rows = (Array.isArray(raw) ? raw : Array.isArray(list) ? list : []).filter(isObj);
  if (!rows.length) return null;
  const want = lower(service);
  const hits = rows.filter((b) => lower(b.service) === want);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null;
  return rows.length === 1 ? rows[0] : null;
}

// A store found on a merchant account that is NOT the one the secret names is
// NEVER linked silently: the venue would charge on one account while its store
// lived on another, and every terminal call would name the wrong merchant. The
// line names the secret, both accounts and the way forward. Null when the
// accounts agree (case insensitively, as Adyen treats them) or either is
// unknown.
export function merchantMismatch(
  { configured, found, secret, storeId, reference }: { configured?: unknown; found?: unknown; secret?: unknown; storeId?: unknown; reference?: unknown } = {},
): MerchantMismatch | null {
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
export function storeStillNeeded(lookup: unknown): string | null {
  const l: Dict = isObj(lookup) ? lookup : {};
  if (isObj(l.store) && str(l.store.id)) return null;
  if (!isObj(l.accountHolder) || !str(l.accountHolder.id)) return null;
  const ref = str(l.reference) || 'this venue';
  return `Adyen holds ${ref} as an account holder, not as a store. A STORE IS STILL NEEDED before card payments route: create one with this reference on the merchant account (it is linked to the balance account for you), then link again.`;
}

// ── ONE ANSWER FOR THE WIZARD (8 Sep 2026, OWNER FEEDBACK) ───────────────────
// "we need this to be easier and better there is far too many words and too
// small we need a flow that supports someone doing this". So the screen does
// NOT assemble the state from four calls and it does NOT decide anything: the
// function answers golive_state and the UI renders these steps in order, one
// thing at a time. Every string here is short, plain and free of API words.
//   state   'done'       nothing to do
//           'todo'       the next thing this person does
//           'attention'  it works, but something is off
//           'blocked'    Adyen or the server is in the way, waiting is wrong
//   action  the button to show, or null for nothing to press
//   hint    the one extra line, only when it helps

export type GoliveStepState = 'done' | 'todo' | 'attention' | 'blocked';

export interface CapabilityRow {
  name: string;
  allowed: boolean;
  requested: boolean;
  enabled: boolean;
  verification: string | null;
  blocked: boolean;
  problems: number;
}

export interface GoliveStep {
  id: string;
  title: string;
  state: GoliveStepState;
  detail: string;
  action: string | null;
  hint: string | null;
}

export interface GoliveReader {
  label: string | null;
  serial: string | null;
  poiid: string | null;
  bound: boolean;
}

export interface GoliveStateInput {
  venue?: { name?: unknown; code?: unknown; region?: unknown; environment?: unknown } | null;
  keys?: { configured?: unknown; missing?: unknown } | null;
  liveKeys?: { configured?: unknown; missing?: unknown } | null;
  holder?: unknown;
  balanceAccount?: unknown;
  legalEntity?: unknown;
  capabilities?: unknown;
  store?: unknown;
  merchantConfigured?: unknown;
  merchantMismatch?: unknown;
  readers?: unknown;
  origins?: { registered?: unknown } | null;
  applePay?: { verification?: unknown } | null;
  [k: string]: unknown;
}

// Every capability as ONE row: the name Adyen uses, whether it is allowed, and
// the verification behind it. A capability Adyen BLOCKS (asked for, not
// allowed) sorts FIRST and carries blocked: true, so it is visible BY NAME
// instead of hiding inside one "pending" word (live, 8 Sep 2026: the account
// holder is Active with one capability Blocked). Takes summariseCapabilities'
// answer ({ byName }) or a bare { name: entry } map.
// adyenAdminRows.capabilityRows is the SCREEN's version of this (labels,
// colours); this one is the wire shape the function answers with.
export function capabilityList(capabilities: unknown): CapabilityRow[] {
  const c: Dict = isObj(capabilities) ? capabilities : {};
  const byName: Dict = isObj(c.byName) ? c.byName : c;
  const rows: CapabilityRow[] = [];
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
  const rank = (r: CapabilityRow): number => (r.blocked ? (r.verification === 'pending' ? 1 : 0) : r.allowed ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// The names of the capabilities Adyen blocks, ready to read out loud.
export function blockedCapabilityNames(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .filter((c) => isObj(c) && c.blocked === true && c.verification !== 'pending')
    .map((c) => str((c as Dict).name)).filter(Boolean);
}

const GOLIVE_TITLES: Record<string, string> = Object.freeze({
  find_venue: 'Find the venue',
  business_account: 'Business account',
  payments_location: 'Payments location',
  go_live: 'Take real cards',
  readers: 'Card readers',
});

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
export function buildGoliveSteps(state: GoliveStateInput = {}): GoliveStep[] {
  const s: Dict = isObj(state) ? state : {};
  const venue: Dict = isObj(s.venue) ? s.venue : {};
  const keys: Dict = isObj(s.keys) ? s.keys : {};
  const holder: Dict | null = isObj(s.holder) && str(s.holder.id) ? s.holder : null;
  const ba: Dict | null = isObj(s.balanceAccount) && str(s.balanceAccount.id) ? s.balanceAccount : null;
  const le: Dict | null = isObj(s.legalEntity) && str(s.legalEntity.id) ? s.legalEntity : null;
  const store: Dict | null = isObj(s.store) && str(s.store.id) ? s.store : null;
  const caps: Dict[] = Array.isArray(s.capabilities) ? (s.capabilities as unknown[]).filter(isObj) : [];
  const mismatch: Dict | null = isObj(s.merchantMismatch) ? s.merchantMismatch : null;
  const readers: Dict[] = (Array.isArray(s.readers) ? (s.readers as unknown[]) : []).filter(isObj);
  const origins: Dict = isObj(s.origins) ? s.origins : {};
  const applePay: Dict = isObj(s.applePay) ? s.applePay : {};
  const code = str(venue.code) || null;
  const env = lower(venue.environment) === 'live' ? 'live' : 'test';
  const missing = (Array.isArray(keys.missing) ? keys.missing : []).map(str).filter(Boolean);
  const keysOk = keys.configured === true && missing.length === 0;
  // `keys` is the set the reads above were made with; `liveKeys` is the LIVE
  // set of the venue's region, which is what taking real money needs. They are
  // the same for a venue already being read on live; a test read passes both,
  // so the go live step never says "ready" on the back of test keys.
  const liveKeys: Dict = isObj(s.liveKeys) ? s.liveKeys : keys;
  const liveMissing = (Array.isArray(liveKeys.missing) ? liveKeys.missing : []).map(str).filter(Boolean);
  const liveKeysOk = liveKeys.configured === true && liveMissing.length === 0;
  const keysBlocked = {
    state: 'blocked' as GoliveStepState,
    detail: 'The Adyen keys are not on the server, so nothing can be read.',
    action: null,
    hint: missing.length ? `Add ${missing.join(', ')}.` : 'Add the Adyen keys for this region.',
  };
  const step = (id: string, x: { state: GoliveStepState; detail: string; action?: string | null; hint?: string | null }): GoliveStep =>
    ({ id, title: GOLIVE_TITLES[id], state: x.state, detail: x.detail, action: x.action ?? null, hint: x.hint ?? null });
  const out: GoliveStep[] = [];

  // 1. find the venue
  if (!keysOk) out.push(step('find_venue', keysBlocked));
  else if (store && holder) out.push(step('find_venue', { state: 'done', detail: `Adyen holds ${code || 'this venue'} as a business account and a store.` }));
  else if (holder) out.push(step('find_venue', { state: 'done', detail: `Adyen holds ${code || 'this venue'} as a business account.`, hint: 'It has no store yet. That is the third step.' }));
  else if (store) out.push(step('find_venue', { state: 'done', detail: `Adyen holds ${code || 'this venue'} as a store.` }));
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
    const pending = caps.filter((c) => c.blocked === true && c.verification === 'pending').map((c) => str(c.name)).filter(Boolean);
    const who = str(le?.name) || str(holder.id);
    if (blocked.length) {
      out.push(step('business_account', {
        state: 'blocked',
        detail: `Adyen blocks ${blocked.join(' and ')}.`,
        action: 'open_adyen',
        hint: 'Clear the checks in the Adyen Customer Area, then look again. Waiting will not fix it.',
      }));
    } else if (str(holder.status) && lower(holder.status) !== 'active') {
      out.push(step('business_account', { state: 'attention', detail: `The business account is ${lower(holder.status)} at Adyen.`, action: 'open_adyen', hint: 'Nothing settles until Adyen makes it active.' }));
    } else if (!ba) {
      out.push(step('business_account', { state: 'attention', detail: 'The money has nowhere to land: no account was found.', action: 'open_adyen', hint: 'Check the business account in the Adyen Customer Area.' }));
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
    out.push(step('payments_location', { state: 'done', detail: `Card payments go to ${str(store.reference) || 'this venue'} on ${str(store.merchantId) || str(s.merchantConfigured) || 'the Adyen account'}.` }));
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
  if (!readers.length) out.push(step('readers', { state: 'todo', detail: 'No card readers on this venue yet.', action: 'add_reader', hint: 'Assign a reader, then bind it to a till.' }));
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
// the reads and writes. KEEP IN SYNC with src/lib/payments/adyenLink.js.

export const STASH_ID_FIELDS: readonly string[] = Object.freeze([
  'store_id', 'split_profile_id', 'legal_entity_id', 'account_holder_id', 'balance_account_id',
  'transfer_instrument_id', 'business_line_id',
]);

export interface StashReader {
  payment_device_id: string | null;
  label: string | null;
  adyen_terminal_id: string;
  terminal_device_id: string | null;
  serial_number: string | null;
}

export interface StashRestorePlan {
  ids: Record<string, unknown>;
  idsSkipped: string | null;
  readers: StashReader[];
  skipped: string | null;
}

// A venue's readers as ONE list keyed on the POIID: the platform registry
// rows (payment_devices, processor adyen, not retired) and the ops link rows
// (terminal_devices, paired, carrying a POIID). A reader known to one side
// only is kept with the other side's id null, so the restore can put back
// whatever existed. Order: platform rows first, then ops only ones.
export function stashReaders(platformRows: unknown, opsRows: unknown): StashReader[] {
  const out: StashReader[] = [];
  const byPoiid = new Map<string, StashReader>();
  for (const r of Array.isArray(platformRows) ? platformRows : []) {
    if (!isObj(r)) continue;
    const poiid = str(r.adyen_terminal_id);
    if (!poiid || byPoiid.has(poiid)) continue;
    const entry: StashReader = { payment_device_id: orNull(r.id), label: orNull(r.label), adyen_terminal_id: poiid, terminal_device_id: null, serial_number: orNull(r.serial_number) };
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
    const entry: StashReader = { payment_device_id: null, label: orNull(r.label), adyen_terminal_id: poiid, terminal_device_id: orNull(r.id), serial_number: orNull(r.serial_number) };
    byPoiid.set(poiid, entry);
    out.push(entry);
  }
  return out;
}

// The stash entry for the environment a venue leaves, from its row as it is
// NOW (before the clear) and its readers (stashReaders). Empty ids are null;
// the flags are booleans; the snapshot rides as is.
export function buildEnvStashEntry(row: unknown, readers: unknown, { at, region }: { at?: unknown; region?: unknown } = {}): Record<string, unknown> {
  const r: Dict = isObj(row) ? row : {};
  const entry: Record<string, unknown> = {};
  for (const k of STASH_ID_FIELDS) entry[k] = orNull(r[k]);
  entry.receive_payments_ok = r.receive_payments_ok === true;
  entry.payouts_ok = r.payouts_ok === true;
  entry.verification_status = isObj(r.verification_status) ? r.verification_status : null;
  entry.merchant_account = orNull(r.merchant_account);
  entry.region = orNull(region) || orNull(r.region);
  entry.readers = (Array.isArray(readers) ? readers : []).filter((x) => isObj(x) && str(x.adyen_terminal_id)).map((x) => ({
    payment_device_id: orNull((x as Dict).payment_device_id),
    label: orNull((x as Dict).label),
    adyen_terminal_id: str((x as Dict).adyen_terminal_id),
    terminal_device_id: orNull((x as Dict).terminal_device_id),
    serial_number: orNull((x as Dict).serial_number),
  }));
  entry.stashed_at = str(at) || new Date().toISOString();
  return entry;
}

// Does a stash entry hold anything worth putting back (an id or a reader)?
export function stashHasSetup(entry: unknown): boolean {
  if (!isObj(entry)) return false;
  if (STASH_ID_FIELDS.some((k) => str(entry[k]))) return true;
  return Array.isArray(entry.readers) && entry.readers.some((x) => isObj(x) && str(x.adyen_terminal_id));
}

// The one line summary the admin portal shows for a kept setup, null when
// the entry holds nothing.
export function stashSummary(entry: unknown): { store_id: string | null; ids: number; readers: number; stashed_at: string | null; region: string | null } | null {
  if (!stashHasSetup(entry)) return null;
  const e = entry as Dict;
  return {
    store_id: orNull(e.store_id),
    ids: STASH_ID_FIELDS.filter((k) => str(e[k])).length,
    readers: Array.isArray(e.readers) ? e.readers.filter((x: unknown) => isObj(x) && str(x.adyen_terminal_id)).length : 0,
    stashed_at: orNull(e.stashed_at),
    region: orNull(e.region),
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
export function stashRestorePlan(entry: unknown, { region, pulled }: { region?: unknown; pulled?: unknown } = {}): StashRestorePlan {
  const none: StashRestorePlan = { ids: {}, idsSkipped: null, readers: [], skipped: null };
  if (!stashHasSetup(entry)) return none;
  const e = entry as Dict;
  const p: Dict = isObj(pulled) ? pulled : {};
  const want = str(region).toUpperCase();
  const was = str(e.region).toUpperCase();
  if (want && was && want !== was) {
    return { ...none, skipped: `The kept setup was made on the ${was} account and the venue is on ${want} now, so it was left alone.` };
  }
  const readers: StashReader[] = (Array.isArray(e.readers) ? e.readers : []).filter((x: unknown) => isObj(x) && str(x.adyen_terminal_id)).map((x: Dict) => ({
    payment_device_id: orNull(x.payment_device_id),
    label: orNull(x.label),
    adyen_terminal_id: str(x.adyen_terminal_id),
    terminal_device_id: orNull(x.terminal_device_id),
    serial_number: orNull(x.serial_number),
  }));
  const pulledStore = str(p.store_id);
  const keptStore = str(e.store_id);
  if (pulledStore && keptStore && pulledStore !== keptStore) {
    return { ids: {}, idsSkipped: `The ids pulled from Adyen name store ${pulledStore}; the kept setup was for store ${keptStore}, so its ids were left alone.`, readers, skipped: null };
  }
  const ids: Record<string, unknown> = {};
  for (const k of STASH_ID_FIELDS) if (str(e[k]) && !(k in p)) ids[k] = str(e[k]);
  if (typeof e.receive_payments_ok === 'boolean' && !('receive_payments_ok' in p)) ids.receive_payments_ok = e.receive_payments_ok;
  if (typeof e.payouts_ok === 'boolean' && !('payouts_ok' in p)) ids.payouts_ok = e.payouts_ok;
  if (isObj(e.verification_status) && !('verification_status' in p)) ids.verification_status = e.verification_status;
  if (str(e.merchant_account) && !('merchant_account' in p)) ids.merchant_account = str(e.merchant_account);
  return { ids, idsSkipped: null, readers, skipped: null };
}
