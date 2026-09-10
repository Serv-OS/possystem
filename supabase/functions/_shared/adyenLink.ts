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
  // The STORE route alone was refused (401 or 403 on the Management key).
  // scopeMissing above merges both routes, and the Balance Platform refusing
  // the key sets it too, so the go live flow reads THIS one for step 1.
  storeScopeMissing?: boolean;
  // 8 Sep 2026, the two route lookup (FIND THE VENUE HOWEVER ADYEN HOLDS IT)
  holderCandidates?: unknown[];
  merchantMismatch?: unknown;
  merchantsSearched?: string[];
  balancePlatform?: string | null;
  storeNeeded?: string | null;
  // 9 Sep 2026: the push to bank sweep on the venue balance account, and
  // whether the sweeps were listed at all (buildLinkPatch's payout_sweep_id).
  sweep?: unknown;
  sweepKnown?: boolean;
  // The store's split configuration names a balance account that belongs to
  // ANOTHER account holder than the one chosen (9 Sep 2026): it was not
  // adopted, storeBalanceAccountId keeps what the store carries for step 5a.
  storeBalanceAccountForeign?: boolean;
  storeBalanceAccountId?: string | null;
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

// WHEN that clear rides (9 Sep 2026). replacementClear exists so an OLD
// account holder's bank account never survives under a NEW balance account,
// so it belongs to a replacement that MOVES THE MONEY SIDE: a conflict on
// balance_account_id or account_holder_id. A store swap alone, with the
// holder side simply unreadable this time (the Balance Platform refused the
// key), is not that case: nulling the holder, legal entity and bank account
// because a READ failed would drop the venue to "No holder", "No payouts",
// KYC unknown, with the onboarding link gone. So: the full clear when the
// conflicts move the money, nothing otherwise.
export const MONEY_CONFLICT_FIELDS: readonly string[] = Object.freeze(['balance_account_id', 'account_holder_id']);
export function conflictsMoveMoney(conflicts: unknown): boolean {
  return (Array.isArray(conflicts) ? conflicts : []).some((c) => isObj(c) && MONEY_CONFLICT_FIELDS.includes(str(c.field)));
}
export function relinkClear(diff: unknown, patch: unknown): Record<string, unknown> {
  const conflicts = isObj(diff) && Array.isArray(diff.conflicts) ? diff.conflicts : [];
  return conflicts.length && conflictsMoveMoney(conflicts) ? replacementClear(patch) : {};
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

export interface MerchantAccountKept {
  id: string;
  name: string | null;
  status: string | null;
}

export interface PlatformSettingsLearned {
  balancePlatformId?: string | null;
  merchantAccounts?: unknown;
}

// The primary key of the settings row for an environment and a region, in the
// exact words the database holds ('test' | 'live', 'UK' | 'US'). A legacy 'EU'
// reads as UK, as it does everywhere else.
export function platformSettingsKey(env: unknown, region: unknown): { environment: string; region: string } {
  return { environment: lower(env) === 'live' ? 'live' : 'test', region: isUsRegion(region) ? 'US' : 'UK' };
}

// Merchant accounts as the settings row keeps them: { id, name, status }, in
// the order given, deduped case insensitively (Adyen compares codes that way).
// A bare string is taken as an id, so a list of codes works too.
export function merchantAccountsSeen(list: unknown): MerchantAccountKept[] {
  const out: MerchantAccountKept[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(list) ? list : []) {
    const row: Dict = isObj(m) ? m : { id: m };
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
export function mergeMerchantAccounts(stored: unknown, seen: unknown): MerchantAccountKept[] {
  const kept = merchantAccountsSeen(stored);
  const fresh = merchantAccountsSeen(seen);
  const byKey = new Map(fresh.map((m) => [m.id.toLowerCase(), m]));
  const done = new Set<string>();
  const out: MerchantAccountKept[] = [];
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
export function platformSettingsPatch(row: unknown, learned: PlatformSettingsLearned | null | undefined): Dict | null {
  const r: Dict = isObj(row) ? row : {};
  const l: Dict = isObj(learned) ? (learned as Dict) : {};
  const patch: Dict = {};
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
export function learnedBalancePlatform(lookup: unknown): string | null {
  const l: Dict = isObj(lookup) ? lookup : {};
  const holder: Dict = isObj(l.accountHolder) ? l.accountHolder : {};
  return str(holder.balancePlatform) || null;
}

// PostgREST's two shapes for a table that is not there: 42P01 "relation
// public.x does not exist" from Postgres, PGRST205 "Could not find the table
// 'public.x' in the schema cache" from PostgREST itself. The table name must
// be in the text, so one missing table never reads as another.
export function isUnknownRelationError(err: unknown, table?: unknown): boolean {
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
export function platformSettingsMissingMessage(): string {
  return `Our own Adyen ids were not kept: the platform table ${ADYEN_PLATFORM_SETTINGS_TABLE} is not there yet, so every venue needs its Adyen id pasted. Run ${ADYEN_PLATFORM_SETTINGS_MIGRATION} on the platform project.`;
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

export interface GoliveStepPart {
  id: string;
  state: GoliveStepState;
  detail: string;
  action: string | null;
  hint: string | null;
}

export interface GoliveStep {
  id: string;
  state: GoliveStepState;
  detail: string;
  action: string | null;
  hint: string | null;
  // Only the payouts step carries parts (split, payout): each its own line
  // and button on the screen.
  parts?: GoliveStepPart[];
}

// The environment the flow is LOOKING at, when it is not the venue's own.
export interface GoliveStepOptions {
  target?: string | null;
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
  // The venue row on the environment the flow looks at ({ store_id, ... }, {}
  // for no row yet), null or absent when the flow looks at the other one.
  row?: unknown;
  // { refused, secret }: the Balance Platform refused our key (401 or 403),
  // and the secret the separate credential goes in.
  balancePlatformKey?: { refused?: unknown; secret?: unknown } | null;
  // { refused, ambiguous }: what the STORE search came back with when no
  // store was resolved (the store list refused, or more than one store
  // carrying the code), so step 1 never says "nothing carries the code".
  storeRead?: { refused?: unknown; ambiguous?: unknown } | null;
  // The venue's RATE CARD as the ledger resolves it and what the profile on
  // the store says (CARD RATES above): { currency, tiers, priced, unpriced,
  // onAdyen: { profileId, read, tiers, matches, missing, remainder, rules },
  // liableBalanceAccountId }. `commission` is the old name, read as an alias
  // when it carries the same shape.
  rates?: { currency?: unknown; tiers?: unknown; priced?: unknown; unpriced?: unknown; onAdyen?: unknown; liableBalanceAccountId?: unknown } | null;
  commission?: unknown;
  // { read, sweep }: the push to bank sweep on the venue balance account.
  payouts?: { read?: unknown; sweep?: unknown } | null;
  [k: string]: unknown;
}

// One error line as the screen shows it (PLAIN PROBLEMS below).
export interface PlainProblem { kind: string; text: string; rawDetail: string }
export interface GoliveProblems { raw: string[]; problems: PlainProblem[]; bpRefused: boolean; platformSettingsMissing: boolean }

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

// TAKING money and PAYING it out are different jobs, and Adyen blocks them
// separately (live, 8 Sep 2026: an ACTIVE account holder with
// sendToTransferInstrument rejected). A refused pay in capability stops cards
// dead; a refused pay out only holds the settlement to the venue's bank, so it
// must never halt the go live flow.
const PAY_IN_CAPABILITIES: readonly string[] = Object.freeze(['receivepayments', 'receivefromplatformpayments']);
const isPayInCapability = (name: unknown): boolean => PAY_IN_CAPABILITIES.includes(lower(name));

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
export function bpKeyBlockedHint(_secret: unknown, env: unknown): string {
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
// The shape work is here (mirror of src/lib/payments/adyenLink.js); the calls
// are in _shared/adyenPayouts.ts, used by adyen-terminal-admin (set_split,
// onboarding_link, setup_sweep) and adyen-onboard (configure_splits,
// setup_sweep). KEEP IN SYNC: adyenLink.test.js checks both copies.

// The capability that gates paying the venue out.
export const PAYOUT_CAPABILITY = 'sendToTransferInstrument';

export interface AdyenCommission { variablePercentage?: number; fixedAmount?: number }

export interface SplitLogic {
  // Absent for a tier priced at 0% and 0p (10 Sep 2026): Adyen takes the
  // block as optional, and an empty one is never sent.
  commission?: AdyenCommission;
  paymentFee: string;
  remainder: string;
  tip: string;
  surcharge: string;
  chargeback: string;
  chargebackCostAllocation: string;
  refund: string;
  refundCostAllocation: string;
}

export interface SplitRule {
  currency: string;
  fundingSource: string;
  paymentMethod: string;
  shopperInteraction: string;
  splitLogic: SplitLogic;
}

export interface SplitProfile { description: string; rules: SplitRule[] }

export interface SweepSummary {
  id: string | null;
  type: string | null;
  category: string | null;
  schedule: string | null;
  status: string | null;
  transferInstrumentId: string | null;
  currency: string | null;
}

export type PayoutCapabilityState = 'allowed' | 'pending' | 'needs_details' | 'rejected' | 'unrequested' | 'unknown';

export interface PayoutInstrumentPick { transferInstrumentId: string; source: 'sweep' | 'row' | 'approved' | 'legal_entity'; sweepId: string | null }

// A percent and a pence as Adyen's commission ({ variablePercentage in basis
// points, fixedAmount in minor units }); null when both are nothing, because
// a rule with an empty commission is refused and a 0% rule is never wanted.
export function commissionFromRates(percent: unknown, fixedPence: unknown): AdyenCommission | null {
  const pct = Number(percent);
  const fix = Number(fixedPence);
  const out: AdyenCommission = {};
  if (Number.isFinite(pct) && pct > 0) out.variablePercentage = Math.round(pct * 100);
  if (Number.isFinite(fix) && fix > 0) out.fixedAmount = Math.round(fix);
  return Object.keys(out).length ? out : null;
}

// The split logic every ServOS rule carries: our commission to the liable
// account, the platform absorbs Adyen's fees (the venue pays the all in
// rate), the rest of the sale, tips and surcharges to the venue, chargebacks
// against the venue, refunds unwound in the same ratio.
export function splitLogicFor(commission: unknown): SplitLogic {
  return {
    // A tier priced at 0% and 0p is a real price (10 Sep 2026): the rule is
    // written with NO commission block (Adyen: commission is optional), so
    // the key is left out rather than sent empty.
    ...(isObj(commission) ? { commission: commission as AdyenCommission } : {}),
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
export function splitRule({ currency, paymentMethod = 'ANY', shopperInteraction = 'ANY', fundingSource = 'ANY', commission }: {
  currency?: unknown; paymentMethod?: unknown; shopperInteraction?: unknown; fundingSource?: unknown; commission?: unknown;
} = {}): SplitRule {
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
export function buildCommissionProfile({ description, currency, percent, fixedPence }: {
  description?: unknown; currency?: unknown; percent?: unknown; fixedPence?: unknown;
} = {}): SplitProfile | null {
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
// one. A tier priced 0% and 0p is a valid price (10 Sep 2026): its rule is
// written with no commission block, so Adyen takes nothing on it.
export const COMMISSION_TIERS: readonly string[] = Object.freeze(['card_present', 'card_not_present', 'amex', 'keyed']);
const TIER_RULES: ReadonlyArray<readonly [string, string, string]> = Object.freeze([
  ['amex', 'amex', 'Ecommerce'],
  ['amex', 'amex', 'Moto'],
  ['amex', 'amex', 'ANY'],
  ['card_not_present', 'ANY', 'Ecommerce'],
  ['keyed', 'ANY', 'Moto'],
  ['card_present', 'ANY', 'ANY'],
] as const);
export function tieredCommissionRules(currency: unknown, tiers: unknown): { rules: SplitRule[]; lacking: string[] } {
  const t: Dict = isObj(tiers) ? tiers : {};
  const commissionOf = (tier: string): AdyenCommission | null => {
    const c: Dict = isObj(t[tier]) ? t[tier] : {};
    return commissionFromRates(c.percent, c.fixedPence ?? c.fixed_pence);
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
export function buildTieredProfile({ description, currency, tiers }: { description?: unknown; currency?: unknown; tiers?: unknown } = {}): SplitProfile | null {
  const built = tieredCommissionRules(currency, tiers);
  if (!built.rules.length) return null;
  return { description: str(description).slice(0, 300) || 'ServOS rates', rules: built.rules };
}

// A flat percent and pence as every tier, for a venue priced with one number
// (the go live flow's two boxes): the ledger then charges the same on every
// card because the venue's rate_card names it for every tier.
export function flatRateCard(percent: unknown, fixedPence: unknown): Record<string, { percent: number | null; fixed_pence: number | null }> | null {
  const pct = Number(percent);
  const fix = Number(fixedPence);
  const entry = {
    percent: Number.isFinite(pct) && pct > 0 ? pct : null,
    fixed_pence: Number.isFinite(fix) && fix > 0 ? Math.round(fix) : null,
  };
  if (entry.percent === null && entry.fixed_pence === null) return null;
  const out: Record<string, { percent: number | null; fixed_pence: number | null }> = {};
  for (const tier of COMMISSION_TIERS) out[tier] = { ...entry };
  return out;
}

// Does a rate card price anything at all (any tier with a number)?
export function rateCardPriced(card: unknown): boolean {
  if (!isObj(card)) return false;
  return COMMISSION_TIERS.some((tier) => {
    const c: Dict | null = isObj(card[tier]) ? card[tier] : null;
    if (!c) return false;
    const pct = Number(c.percent);
    const fix = Number(c.fixedPence ?? c.fixed_pence);
    return (Number.isFinite(pct) && pct > 0) || (Number.isFinite(fix) && fix > 0);
  });
}

export interface ProfileCommission { percent: number; fixedPence: number; rules: number; remainder: string | null; venueRules: number }

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
export function profileCommission(profile: unknown): ProfileCommission | null {
  const rules: Dict[] = (Array.isArray((profile as Dict)?.rules) ? ((profile as Dict).rules as unknown[]) : []).filter(isObj);
  if (!rules.length) return null;
  const any = (v: unknown): boolean => !str(v) || lower(v) === 'any';
  const isCatchAll = (r: Dict): boolean => any(r.paymentMethod) && any(r.shopperInteraction) && any(r.fundingSource);
  const priced = rules.filter((r) => isObj(r.splitLogic) && isObj(r.splitLogic.commission));
  const catchAll = rules.find(isCatchAll) || null;
  const pricedPick = priced.find(isCatchAll) || priced[0] || null;
  const c: Dict = pricedPick ? pricedPick.splitLogic.commission : {};
  const bp = Number(c.variablePercentage);
  const fix = Number(c.fixedAmount);
  const remainderOf = (r: Dict | null): string | null => orNull(isObj(r?.splitLogic) ? r!.splitLogic.remainder : null);
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
const plainNumber = (n: unknown): string => String(Number(Number(n).toFixed(4)));

// The commission in plain words: "0.8% plus 5p", "0.8%", "5p"; US pence read
// as cents. Null when there is nothing.
export function commissionLine(percent: unknown, fixedPence: unknown, currency?: unknown): string | null {
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
// KEEP IN SYNC with src/lib/payments/adyenLink.js (adyenLink.test.js).

export interface RateTier { percent: number | null; fixedPence: number | null; source?: 'venue' | 'platform default' | null }
export type RateTiers = Record<string, RateTier | null>;
export interface RatesOnAdyen { tiers: RateTiers | null; matches: boolean; missing: boolean; remainder: string | null; rules: number }

// Plain words for each tier. Amex keeps its capital everywhere.
export const RATE_TIER_LABELS: Readonly<Record<string, string>> = Object.freeze({ card_present: 'In person', card_not_present: 'Online', amex: 'Amex', keyed: 'Keyed' });
export function rateTierLabel(tier: unknown, { lower: lc = false }: { lower?: boolean } = {}): string {
  const label = RATE_TIER_LABELS[str(tier)] || str(tier);
  return lc && label !== 'Amex' ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

// A number, or null for empty: '' and null are "not set", 0 is a price.
const rateNumber = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const tierOf = (tiers: unknown, tier: string): Dict => (isObj(tiers) && isObj(tiers[tier]) ? tiers[tier] : {});
const tierPercent = (c: Dict): number | null => rateNumber(c.percent);
const tierFixed = (c: Dict): number | null => {
  const n = rateNumber(c.fixedPence ?? c.fixed_pence);
  return n === null ? null : Math.round(n);
};

// One tier's rate in plain words: "1.4% + 5p", "1.4%", "5p"; "0%" for a tier
// priced at nothing; null when it has no price at all. US pence read as cents.
export function tierRateLine(percent: unknown, fixedPence: unknown, currency?: unknown): string | null {
  const pct = rateNumber(percent);
  const fix = rateNumber(fixedPence);
  if (pct === null && fix === null) return null;
  const minor = str(currency).toUpperCase() === 'USD' ? 'c' : 'p';
  const parts: string[] = [];
  if (pct !== null && pct > 0) parts.push(`${plainNumber(pct)}%`);
  if (fix !== null && fix > 0) parts.push(`${Math.round(fix)}${minor}`);
  return parts.length ? parts.join(' + ') : '0%';
}

// The four rates in one line, for a collapsed step or a log line:
// "In person 1.4% + 5p, online 1.9% + 10p, Amex 2.5% + 10p, keyed 2.9% + 15p".
// A tier with no price reads "not set".
export function rateCardLine(tiers: unknown, currency?: unknown): string {
  return COMMISSION_TIERS.map((tier, i) => {
    const c = tierOf(tiers, tier);
    return `${rateTierLabel(tier, { lower: i > 0 })} ${tierRateLine(tierPercent(c), tierFixed(c), currency) || 'not set'}`;
  }).join(', ');
}

// resolveAdyenRateCard's answer ({ tier: { percent, fixed_pence, source } })
// as the screen reads it: { tier: { percent, fixedPence, source } } with the
// source as one grey word, "venue" or "platform default" (the legacy flat
// columns count as whichever side they sit on), or null for no price.
export function tiersFromResolved(cards: unknown): Record<string, RateTier> {
  const out: Record<string, RateTier> = {};
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
export function unpricedTiers(tiers: unknown): string[] {
  return COMMISSION_TIERS.filter((tier) => {
    const c = tierOf(tiers, tier);
    return tierPercent(c) === null && tierFixed(c) === null;
  });
}

// Tier names for a sentence: "online, Amex and keyed".
export function tierListWords(tiers: unknown): string {
  const words = (Array.isArray(tiers) ? tiers : []).map((t) => rateTierLabel(t, { lower: true })).filter(Boolean);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// The profile on the store (GET /merchants/{m}/splitConfigurations/{id}) rule
// by rule, back into the four tiers the way tieredCommissionRules wrote them:
// paymentMethod amex is the Amex tier, shopperInteraction Ecommerce is online,
// Moto is keyed, the catch all rule is in person. A rule with no commission
// block is a tier priced at 0% and 0p. Null when the profile has no rules;
// a tier with no rule is null inside the answer.
export function profileTiers(profile: unknown): RateTiers | null {
  const rules: Dict[] = (Array.isArray((profile as Dict)?.rules) ? ((profile as Dict).rules as unknown[]) : []).filter(isObj);
  if (!rules.length) return null;
  const any = (v: unknown): boolean => !str(v) || lower(v) === 'any';
  const out: RateTiers = { card_present: null, card_not_present: null, amex: null, keyed: null };
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
    const c: Dict = isObj(r.splitLogic) && isObj(r.splitLogic.commission) ? r.splitLogic.commission : {};
    const bp = Number(c.variablePercentage);
    const fix = Number(c.fixedAmount);
    const rate: RateTier = { percent: Number.isFinite(bp) ? bp / 100 : 0, fixedPence: Number.isFinite(fix) ? Math.round(fix) : 0 };
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
export function tiersMatch(a: unknown, b: unknown): boolean {
  return COMMISSION_TIERS.every((tier) => {
    const x = tierOf(a, tier);
    const y = tierOf(b, tier);
    const xp = tierPercent(x); const yp = tierPercent(y);
    const xf = tierFixed(x); const yf = tierFixed(y);
    if ((xp === null && xf === null) || (yp === null && yf === null)) return false;
    return Math.round((xp ?? 0) * 100) === Math.round((yp ?? 0) * 100) && (xf ?? 0) === (yf ?? 0);
  });
}

// What Adyen holds against what the venue pays: the profile's tiers, whether
// every tier has a rule (missing), whether they match the venue's card, and
// where the catch all rule sends the rest of each sale. Null profile (not
// read, or no rules) is { tiers: null, matches: false, missing: true }.
export function ratesOnAdyen(profile: unknown, venueTiers: unknown): RatesOnAdyen {
  const tiers = profileTiers(profile);
  const pc = profileCommission(profile);
  if (!tiers || !pc) return { tiers: null, matches: false, missing: true, remainder: null, rules: 0 };
  const missing = COMMISSION_TIERS.some((t) => !tiers[t]);
  return { tiers, matches: !missing && tiersMatch(tiers, venueTiers), missing, remainder: pc.remainder, rules: pc.rules };
}

// The line for a found store AND a found business account that the venue row
// does not name yet (link_all, 10 Sep 2026): one click saves every id.
export const DETAILS_NOT_SAVED_DETAIL = 'Adyen holds the venue’s details, they are not saved on the venue yet.';

// Rows of GET /balanceAccounts/{id}/sweeps ({ sweeps: [...] }) or a bare array.
export function sweepRows(response: unknown): Dict[] {
  if (Array.isArray(response)) return response.filter(isObj);
  return Array.isArray((response as Dict)?.sweeps) ? ((response as Dict).sweeps as unknown[]).filter(isObj) : [];
}

// One sweep as the screen and the row see it. schedule is the type word
// (daily, weekly, monthly, balance, cron), lower case.
export function sweepSummary(sweep: unknown): SweepSummary | null {
  if (!isObj(sweep)) return null;
  const cp: Dict = isObj(sweep.counterparty) ? sweep.counterparty : {};
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
export function findPushSweep(list: unknown, transferInstrumentId?: unknown): SweepSummary | null {
  const ti = str(transferInstrumentId);
  const rows = sweepRows(list).map(sweepSummary)
    .filter((s): s is SweepSummary => !!s && !!s.id && s.type === 'push' && s.category === 'bank' && s.status !== 'inactive');
  if (ti) return rows.find((s) => s.transferInstrumentId === ti) ?? null;
  return rows[0] ?? null;
}

// POST /balanceAccounts/{id}/sweeps: the full available balance to the bank
// on the schedule (daily by default). No sweepAmount, targetAmount or
// triggerAmount, so everything goes.
export function sweepPayload({ transferInstrumentId, currency, schedule = 'daily', cronExpression, description }: {
  transferInstrumentId?: unknown; currency?: unknown; schedule?: unknown; cronExpression?: unknown; description?: unknown;
} = {}): Dict {
  const type = ['daily', 'weekly', 'monthly', 'balance', 'cron'].includes(lower(schedule)) ? lower(schedule) : 'daily';
  const sched: Dict = { type };
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
//   allowed      Adyen pays the venue out
//   pending      asked for, still being checked
//   rejected     asked for, not allowed, and Adyen has decided
//   unrequested  never asked for, so it can never become allowed
//   unknown      no capability list at all
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
export function payoutCapabilityState(caps: unknown): PayoutCapabilityState {
  const list: Dict[] = (Array.isArray(caps) ? (caps as unknown[]) : []).filter(isObj);
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
// KEEP IN SYNC with src/lib/payments/adyenLink.js (adyenLink.test.js).
export function pickPayoutInstrument(holderCapabilities: unknown, { sweeps, rowTransferInstrumentId, legalEntityInstruments }: {
  sweeps?: unknown; rowTransferInstrumentId?: unknown; legalEntityInstruments?: unknown;
} = {}): PayoutInstrumentPick | null {
  const caps: Dict = isObj(holderCapabilities) ? holderCapabilities : {};
  const cap: Dict = isObj(caps[PAYOUT_CAPABILITY]) ? caps[PAYOUT_CAPABILITY] : {};
  const approved: string[] = (Array.isArray(cap.transferInstruments) ? (cap.transferInstruments as unknown[]) : []).filter(isObj)
    .filter((t) => t.allowed === true && lower(t.verificationStatus) === 'valid')
    .map((t) => str(t.id)).filter(Boolean);
  const fallback: string[] = (Array.isArray(legalEntityInstruments) ? (legalEntityInstruments as unknown[]) : []).map((t) => str(isObj(t) ? t.id : t)).filter(Boolean);
  const pool = approved.length ? approved : fallback;
  const source: PayoutInstrumentPick['source'] = approved.length ? 'approved' : 'legal_entity';
  if (!pool.length) return null;
  const live = sweepRows(sweeps).map(sweepSummary)
    .filter((s): s is SweepSummary => !!s && !!s.id && s.type === 'push' && s.category === 'bank' && s.status !== 'inactive');
  const bySweep = live.find((s) => !!s.transferInstrumentId && pool.includes(s.transferInstrumentId));
  if (bySweep) return { transferInstrumentId: bySweep.transferInstrumentId as string, source: 'sweep', sweepId: bySweep.id };
  const onRow = str(rowTransferInstrumentId);
  if (onRow && pool.includes(onRow)) return { transferInstrumentId: onRow, source: 'row', sweepId: null };
  return { transferInstrumentId: pool[0], source, sweepId: null };
}

// The secret that may hold OUR liable balance account id (the platform
// account the commission lands in). Optional: the commission goes there
// whether or not we know the id, so it is only ever shown, never a gate.
// Same rule as balancePlatformSecretName.
export const LIABLE_BALANCE_ACCOUNT_SECRET_SUFFIX = 'LIABLE_BALANCE_ACCOUNT';
export function liableBalanceAccountSecretName(env: unknown, region: unknown): string {
  const s = LIABLE_BALANCE_ACCOUNT_SECRET_SUFFIX;
  if (lower(env) !== 'live') return `ADYEN_${s}`;
  return `ADYEN_LIVE_${isUsRegion(region) ? 'US' : 'UK'}_${s}`;
}
export function liableBalanceAccountSecretNames(env: unknown, region: unknown): string[] {
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
const PAYOUT_WAIT_ACTIONS: readonly string[] = Object.freeze(['check_payouts', 'open_adyen']);

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
// `state.rates` is { currency, tiers, priced, unpriced, onAdyen, liableBalanceAccountId }
// (10 Sep 2026): the venue's RATE CARD as the ledger resolves it, four tiers
// each { percent, fixedPence, source } (tiersFromResolved), and what the
// profile on the store actually says when it could be read: onAdyen is
// { profileId, read, tiers, matches, missing, remainder, rules } (ratesOnAdyen).
// The old `state.commission` is read as an alias when it carries the same
// shape, and ignored otherwise.
// `state.payouts` is { read, sweep }: read is true when the sweeps of the
// venue balance account were listed, sweep is the push to bank sweep
// (sweepSummary) or null.
export function buildGoliveSteps(state: GoliveStateInput = {}, opts: GoliveStepOptions = {}): GoliveStep[] {
  const s: Dict = isObj(state) ? state : {};
  const o: Dict = isObj(opts) ? (opts as Dict) : {};
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
  const rates: Dict = isObj(s.rates) ? s.rates : (isObj(s.commission) && isObj((s.commission as Dict).tiers) ? (s.commission as Dict) : {});
  const payouts: Dict = isObj(s.payouts) ? s.payouts : {};
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
  const row: Dict | null = isObj(s.row) ? s.row : null;
  const storeSaved = !store || !row || str(row.store_id) === str(store.id);
  // THE MONEY SIDE MUST AGREE TOO (9 Sep 2026): the balance account the read
  // hands over is the chosen holder's own (the lookup never adopts a store's
  // foreign one), so a row naming the holder with a blank or different
  // balance account is not saved right, and link_holder writes the right one.
  const holderNamed = !holder || !row || str(row.account_holder_id) === str(holder.id);
  const moneySaved = !holder || !row || !ba || str(row.balance_account_id) === str(ba.id);
  const holderSaved = holderNamed && moneySaved;
  const storeActive = !!store && lower(store.status) === 'active';
  const bpKey: Dict = isObj(s.balancePlatformKey) ? s.balancePlatformKey : {};
  const bpRefused = bpKey.refused === true;
  // BOTH FOUND, NEITHER SAVED (10 Sep 2026, zero paste onboarding): the read
  // found the store and the business account and the row names neither, so
  // steps 2 and 3 collapse into ONE click (link_all, adyen_link with every id
  // the read found). link_store and link_holder stay for the partial cases.
  const linkAll = !!store && storeActive && !mismatch && !!holder && !storeSaved && !holderNamed;
  const bpSecret = str(bpKey.secret) || null;
  const storeRead: Dict = isObj(s.storeRead) ? s.storeRead : {};
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
    ({ id, state: x.state, detail: x.detail, action: x.action ?? null, hint: x.hint ?? null });
  const out: GoliveStep[] = [];

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
  } else {
    out.push(step('find_venue', { state: 'todo', detail: `Nothing at Adyen carries the code ${code} yet.`, action: 'find_venue', hint: 'Paste the account holder id (it starts with AH), or pick the store from the list.' }));
  }

  // 2. the business account
  if (!keysOk) out.push(step('business_account', keysBlocked));
  else if (bpRefused) {
    // THE ONE PLAIN REASON. Whatever else was or was not read, the business
    // account side is unreadable until the separate credential is on the
    // server, and waiting will not change that.
    out.push(step('business_account', { state: 'blocked', detail: BP_KEY_BLOCKED_DETAIL, action: 'add_bp_key', hint: bpKeyBlockedHint(bpSecret, target || env) }));
  } else if (!holder) out.push(step('business_account', { state: 'todo', detail: 'No business account at Adyen yet.', action: 'find_venue', hint: 'Adyen makes one when the venue is onboarded. Paste its id if you have it.' }));
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
    out.push(step('payments_location', { state: 'done', detail: `Card payments go to ${str(store!.reference) || 'this venue'}.` }));
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

interface PayoutsStepInput {
  keysOk: boolean;
  keysBlocked: { state: GoliveStepState; detail: string; action: string | null; hint: string | null };
  bpRefused: boolean;
  holder: Dict | null;
  holderSaved: boolean;
  ba: Dict | null;
  le: Dict | null;
  store: Dict | null;
  storeSaved: boolean;
  mismatch: Dict | null;
  caps: Dict[];
  row: Dict | null;
  rates: Dict;
  payouts: Dict;
}

// Step 5 on its own: the split part and the payout part, then the step that
// carries them. Every line under 120 characters, no id in a sentence.
function buildPayoutsStep(x: PayoutsStepInput): GoliveStep {
  const part = (id: string, p: { state: GoliveStepState; detail: string; action?: string | null; hint?: string | null }): GoliveStepPart =>
    ({ id, state: p.state, detail: p.detail, action: p.action ?? null, hint: p.hint ?? null });
  const row = x.row;
  // NO ROW IN HAND means the flow is looking at the OTHER environment (a test
  // venue looking at live, the go live path). The three writes behind this
  // step (set_split, onboarding_link, setup_sweep) act on the venue's OWN
  // row and account, so offering them here would set a commission on the
  // test store, mint a bank details link for the test legal entity, or sweep
  // the test balance account (9 Sep 2026). Nothing is offered until the venue
  // is on the account the flow looks at: step 4 moves it.
  if (!row) {
    const wait = { state: 'todo' as GoliveStepState, detail: PAYOUTS_WAIT_FOR_LIVE_DETAIL, action: null };
    return { id: 'payouts', state: 'todo', detail: wait.detail, action: null, hint: null, parts: [part('split', wait), part('payout', wait)] };
  }
  const rowBa = str(row.balance_account_id);
  const rowTi = str(row.transfer_instrument_id);
  const rates: Dict = isObj(x.rates) ? x.rates : {};
  const currency = str(rates.currency).toUpperCase() || str(x.ba?.currency).toUpperCase() || 'GBP';
  // THE VENUE RATE CARD (10 Sep 2026): four tiers, every one priced before
  // anything goes to Adyen. The four rates in one line ride as the hint and,
  // when short, as the collapsed step's own line.
  const tiers: Dict = isObj(rates.tiers) ? rates.tiers : {};
  const unpriced = unpricedTiers(tiers);
  const priced = unpriced.length === 0;
  const line = priced ? rateCardLine(tiers, currency) : null;
  const shortLine = line && line.length <= PROBLEM_TEXT_MAX ? line : null;
  const onAdyen: Dict = isObj(rates.onAdyen) ? rates.onAdyen : {};
  const profileRead = onAdyen.read === true;
  const remainder = str(onAdyen.remainder);

  // (a) the card rates on the store
  let split: GoliveStepPart;
  if (!x.keysOk) split = part('split', x.keysBlocked);
  else if (!x.store && !x.holder) split = part('split', { state: 'todo', detail: 'Find the venue first.', action: null });
  else if (x.mismatch && str(x.mismatch.found)) split = part('split', { state: 'todo', detail: 'Pick the right Adyen account in step 3 first.', action: null });
  else if (!x.store) split = part('split', { state: 'todo', detail: 'Make the payments location first.', action: null });
  else if (!x.storeSaved) split = part('split', { state: 'todo', detail: 'Save the payments location on the venue first.', action: null });
  else if (!x.holderSaved) split = part('split', { state: 'todo', detail: 'Save the business account on the venue first.', action: null });
  else if (!rowBa) split = part('split', { state: 'todo', detail: 'The venue has no account for the money to land in yet.', action: null, hint: 'Save the business account in step 2.' });
  else if (!priced) {
    // A tier with no price cannot go to Adyen: name the tiers and offer the
    // editor. 0% and 0p is a price; empty is not.
    split = part('split', { state: 'attention', detail: `No rate is set for ${tierListWords(unpriced)} yet.`, action: 'edit_rates', hint: 'Set every payment type, then apply the rates on Adyen.' });
  } else if (str(x.store.splitConfigurationId)) {
    // DONE needs all of these (9 and 10 Sep 2026): the store names an account
    // for the rest of each sale, it is the venue's own, the rules send the
    // rest there (a profile whose remainder is addToLiableAccount keeps it
    // for the platform), and the rules carry THE SAME RATES the venue pays.
    // A profile that could not be read is trusted on the account alone.
    const storeBa = str(x.store.balanceAccountId);
    if (!storeBa) {
      split = part('split', { state: 'attention', detail: 'The rates on Adyen name no account for the rest of each sale.', action: 'set_split', hint: 'Apply the rates again to point them at the venue.' });
    } else if (storeBa !== rowBa) {
      split = part('split', { state: 'attention', detail: 'The rates on Adyen send the rest of each sale to a different account, not the venue’s.', action: 'set_split', hint: 'Apply the rates again to point them at the venue.' });
    } else if (profileRead && lower(remainder) !== lower(REMAINDER_TO_VENUE)) {
      split = part('split', { state: 'attention', detail: 'The rates on Adyen do not send the rest of each sale to the venue.', action: 'set_split', hint: 'Apply the rates again to point them at the venue.' });
    } else if (profileRead && onAdyen.matches !== true) {
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
  let payout: GoliveStepPart;
  const capability = payoutCapabilityState(x.caps);
  const hasBank = !!(str(x.le?.transferInstrumentId) || rowTi);
  const sweep: Dict | null = isObj(x.payouts.sweep) && str(x.payouts.sweep.id) ? x.payouts.sweep : null;
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
    const when = sweep.schedule && sweep.schedule !== 'daily' ? String(sweep.schedule) : 'daily';
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
  const rank: Record<string, number> = { blocked: 3, attention: 2, todo: 1, done: 0 };
  const worst = parts.reduce<GoliveStepState>((a, p) => (rank[p.state] > rank[a] ? p.state : a), 'done');
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
// KEEP IN SYNC with src/lib/payments/adyenLink.js (adyenLink.test.js).
export const PROBLEM_TEXT_MAX = 120;

// The refusal line refusalText (adyen-terminal-admin) builds: "refused (401):
// the credential behind ADYEN_LIVE_UK_BP_KEY (the set's API key when that is
// unset) needs the Balance Platform BCL role". The secret NAME in it says
// which key was refused; the role text is the fallback.
const REFUSED = /\brefused \((401|403)\)/i;
function refusedKey(raw: string): string | null {
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
const PROBLEM_SUBJECTS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
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
  [/^split configuration\b/i, 'the commission rules'],
  [/^onboarding link\b/i, 'the bank details link'],
  [/^platform defaults?\b/i, 'the default rates'],
  [/^payout (capability|approval)\b/i, 'the payout approval'],
  [/^rate card\b/i, 'the venue rates'],
] as const);

// ONE raw error line as the screen shows it, or null for an empty line.
export function plainAdyenProblem(raw: unknown): PlainProblem | null {
  const text = str(raw);
  if (!text) return null;
  const say = (kind: string, plain: string): PlainProblem => ({ kind, text: plain, rawDetail: text });
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
  if (/account holders .* carry the reference/i.test(text)) return say('ambiguous_holder', 'More than one business account carries this code. Paste the right id in step 1.');
  if (/names no account holder/i.test(text)) return say('gap', 'Where the money lands names no business account at Adyen.');
  if (/names no legal entity/i.test(text)) return say('gap', 'The business account names no registered company at Adyen.');
  if (/none could be chosen/i.test(text)) return say('gap', 'The business account has several money accounts and none could be chosen.');
  if (/no venue code/i.test(text)) return say('no_code', 'This venue has no code, so there is nothing to search for.');
  for (const [re, subject] of PROBLEM_SUBJECTS) if (re.test(text)) return say('read_failed', `Adyen would not answer about ${subject}.`);
  return say('other', 'Adyen said something we did not expect.');
}

// The settings warning for a platform table the migration has not made yet
// (platformSettingsMissingMessage), told apart from a read or write failure.
export function isPlatformSettingsMissingWarning(text: unknown): boolean {
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
export function goliveProblems(errors: unknown, { settingsWarning }: { settingsWarning?: unknown } = {}): GoliveProblems {
  const raw: string[] = [];
  const seenRaw = new Set<string>();
  for (const e of Array.isArray(errors) ? errors : []) {
    const t = str(e);
    if (!t || seenRaw.has(t)) continue;
    seenRaw.add(t);
    raw.push(t);
  }
  const problems: PlainProblem[] = [];
  const byText = new Map<string, PlainProblem>();
  const add = (p: PlainProblem | null) => {
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
