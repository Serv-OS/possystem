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
  errors?: string[];
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
  if (store) patch.receive_payments_ok = lower(store.status) === 'active';
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
//           Adyen (linking would flip the venue live, clear its working test
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
  if (next === 'live' && p.receive_payments_ok === false && relink !== true) {
    const status = lower(storeStatus) || 'not active';
    return { kind: 'refuse', diff, reason: `The store ${str(p.store_id) || 'found'} is ${status} at Adyen, so payments naming it are refused. Link it once it is active, or confirm to link it anyway.` };
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
export function lookupSummary(lookup: unknown): string {
  const l: Dict = isObj(lookup) ? lookup : {};
  const ref = str(l.reference) || 'no reference';
  if (!l.found || !isObj(l.store)) {
    const n = Array.isArray(l.candidates) ? l.candidates.length : 0;
    return `No store with reference ${ref} on ${str(l.merchantAccount) || 'the merchant account'}${n ? ` (${n} store${n === 1 ? '' : 's'} listed to pick from)` : ''}.`;
  }
  const parts = [`store ${l.store.id}${l.store.status ? ` (${l.store.status})` : ''}`];
  parts.push(isObj(l.balanceAccount) && l.balanceAccount.id ? `balance account ${l.balanceAccount.id}` : 'no balance account');
  parts.push(isObj(l.accountHolder) && l.accountHolder.id ? `account holder ${l.accountHolder.id}` : 'no account holder');
  parts.push(isObj(l.legalEntity) && l.legalEntity.id ? `legal entity ${l.legalEntity.name || l.legalEntity.id}` : 'no legal entity');
  return `Found ${ref}: ${parts.join(', ')}.`;
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
