// supabase/functions/adyen-terminal-admin
//
// The Back Office's Adyen FLEET door — the Lightspeed-style "register the
// terminal on the location" flow (Peter, 14 Aug: "I want this setup properly
// with a proper flow"). AMS1-class terminals run Adyen's own software, so
// there is no on-device claim code: registration = Management API reassign to
// the venue's STORE + a linked ops terminal_devices row the charge path and
// till-binding already understand.
//
// Actions (all BO-fenced; the ones marked ADMIN also need super_admin):
//   status       → processor, merchant, store mapping, Management-API scope probe
//   ensure_store → ADMIN. create the venue's Adyen store + merchant_adyen_accounts row
//   ensure_payment_methods → ADMIN. request the card schemes on the store again
//   list         → Adyen fleet for the merchant, split store vs inventory,
//                  joined to our terminal_devices links
//   assign       → reassign terminal to the venue store + payment_devices row
//                  + ops terminal_devices row (paired, ready to bind to a till)
//   unlink       → retire the ops row (terminal stays boarded at Adyen)
//   register_origins → ADMIN. the ServOS hosts and wildcards on the venue's
//                  API credential's allowed origins (WEB ORIGINS below)
//   register_apple_pay_domains → ADMIN. the venue's storefront hosts on the
//                  merchant's Apple Pay payment method (APPLE PAY below)
//   adyen_lookup → ADMIN. { reference?, storeId?, accountHolderId?, environment? }
//                  PULL the venue's Adyen ids BY REFERENCE (the venue code,
//                  SV-1007, as the store reference): store, balance account,
//                  account holder, legal entity. Read only, never throws on a
//                  missing piece (PULL BY REFERENCE below)
//   adyen_link   → ADMIN. the same lookup, then ONE write of every id onto
//                  merchant_adyen_accounts (through the set_environment rules
//                  when the venue moves to live), then origins and Apple Pay
//                  best effort. Idempotent; relink: true to replace ids
//   adyen_create_store_by_reference → ADMIN. ensure_store with the venue
//                  code as the reference (finds an existing store by
//                  reference before creating one), on the account
//                  adyen_lookup looks on (live by default); across
//                  environments the row is not written, adyen_link maps it
//
// Auth: BO JWT → user_locations membership (or super_admin), the ryft-terminals
// fence, verbatim in spirit. All writes service-role.
//
// OWNER RULE (8 Sep 2026): a venue (any Back Office role, the owner included)
// must not move itself between test cards and live, create the Adyen store or
// request its card schemes. Those are ServOS internal actions, run from the
// admin portal (?mode=admin, src/admin/components/AdyenEnvironmentControls.jsx)
// by a platform super_admin. The check is the caller's user_profiles.role,
// the same lookup adyen-onboard fences on, never a client supplied flag. A
// venue role gets 403 { error: 'ServOS admin only' }. Every other action
// stays open to Back Office users with access to the venue, and
// 'environment' is read only so the venue can show its badge.
//
// Scope: needs an API key with Management API "Terminals read/write" roles.
// If ADYEN_MANAGEMENT_KEY (ADYEN_LIVE_<REGION>_MANAGEMENT_KEY for a live
// venue) is set it is used for management calls; otherwise that set's API
// key. A 401/403 from Adyen surfaces as scope_missing so the BO can say
// exactly what to fix instead of a dead button.
// The /me calls behind register_origins are the one exception: allowed
// origins live on the credential the Drop-in CLIENT KEY was generated on, so
// they sign with the set's API key (ADYEN_API_KEY, ADYEN_LIVE_<REGION>_API_KEY)
// and GET /me proves that credential's clientKey is the set's client key
// before anything is posted (WEB ORIGINS below).
// Every Management call is bounded by MGMT_TIMEOUT_MS: a hang answers as an
// error instead of leaving the admin portal waiting on a flip that has
// already been written.
//
// PER VENUE ENVIRONMENT (7 Sep 2026): the venue's merchant_adyen_accounts
// .environment ('test' | 'live') picks the secret set for every Management
// and Terminal API call here.
// PER VENUE REGION (8 Sep 2026): the same row's region ('UK' | 'US'; a
// legacy 'EU' reads as UK, no row = by the location's currency) picks WHICH
// live set (ADYEN_LIVE_UK_* or ADYEN_LIVE_US_*), the Terminal API host, and
// the market (currency and country) for stores and payment methods. Three
// actions manage the pair:
//   environment     → { environment, region, liveConfigured, liveRegionsConfigured,
//                       testConfigured, liveMissing, canSetEnvironment, canSetRegion,
//                       regionLocked, regionLockReason }
//                     any Back Office user with access (read only).
//                     liveConfigured and liveMissing are for THIS venue's
//                     region; liveRegionsConfigured lists every usable live set.
//   set_environment → ADMIN. { environment: 'test' | 'live', reprovision?: true }
//                     super_admin only (8 Sep 2026, was owner too). Flips the
//                     venue's row (created when it does not exist). Needs the
//                     region's live merchant account to go live, and writes
//                     it. Refused with 409 + needs_reprovision while the row
//                     or its readers were provisioned on the current
//                     environment, unless reprovision is true (then the ids
//                     are cleared). STASH AND RESTORE (8 Sep 2026): before
//                     the clear, the outgoing environment's setup (store and
//                     account ids, flags, snapshot, merchant account, the
//                     readers) is kept under merchant_adyen_accounts
//                     .env_stash[<env>], and a flip INTO an environment that
//                     has a stash puts it back (row ids, un-retired
//                     payment_devices, POIIDs back on the paired ops rows).
//                     Answers stash_saved, restored and keeps_setup; until
//                     20260908b_PLATFORM_adyen_env_stash.sql runs, the flip
//                     works as before and the answer names the migration.
//   set_region      → ADMIN. { region: 'UK' | 'US' }. super_admin only.
//                     Refused while the venue is live or holds a store or
//                     readers (provisioning is per account). Writes
//                     merchant_adyen_accounts.region, creating the row when
//                     missing. Until 20260908_PLATFORM_adyen_region_uk.sql
//                     runs the database refuses 'UK' and this answers
//                     'Run migration 20260908_PLATFORM_adyen_region_uk.sql first'.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  managementBase, balancePlatformBase, lemBase, buildMenuInputRequest, buildAmountInputRequest, parseAmountInputResponse, buildDisplayImageRequest,
  buildDisplayIdleRequest, newServiceId, adyenFetch, terminalEndpoint,
  adyenConfig, adyenEnvForLocation, adyenSecretName, normalizeAdyenEnv, assertAdyenConfigured, effectiveMerchantAccount,
  parseAdyenRegion, liveRegionsConfigured, isAdyenRegionCheckError, adyenRegionMigrationMessage, ADYEN_REGION_MIGRATION,
  type AdyenConfig, type AdyenEnv,
} from '../_shared/adyen.ts';
import {
  buildWebOrigins, buildStorefrontDomains, originsPlan, applePayDomainsPlan, pickApplePayMethod, hasApplePayEntries,
  applePayStatusNote, adyenRefusalMessage, isDuplicateRefusal,
} from '../_shared/adyenOrigins.ts';
import {
  referenceKey, storeRows, matchStoreByReference, storeSummary, storeCandidates, accountHolderSummary, balanceAccountSummary,
  legalEntitySummary, pickBalanceAccount, resolveLinkEnvironment, buildLinkPatch, planLink, replacementClear, lookupSummary,
  stashReaders, buildEnvStashEntry, stashHasSetup, stashSummary, stashRestorePlan,
  type StoreSummary, type BalanceAccountSummary, type AccountHolderSummary, type LookupResult, type StashReader, type StashRestorePlan,
} from '../_shared/adyenLink.ts';

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '',
);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Management API call with the VENUE'S config: its host and, by default, its
// management key. `apiKey` overrides the key for the credential scoped /me
// calls (registerWebOrigins signs with cfg.apiKey, the credential the Drop-in
// client key belongs to). A live venue without live keys throws the fail
// closed error before any request leaves (caught by the handler's outer
// try). Bounded by MGMT_TIMEOUT_MS (8 Sep 2026): set_environment runs up to
// about fourteen of these AFTER the row is written, and a hang there left
// the switch reading test while live cards were already being charged. A
// timed out call throws; attempt() turns that into the error line of that
// half, the outer try into a 500 for every other action.
const MGMT_TIMEOUT_MS = 15_000;
interface HostAnswer<T> { ok: boolean; status: number; data: T }
// One call on one of the venue's Adyen hosts with one of its keys: the
// Management host (mgmt), the Balance Platform host (bcl) and the Legal
// Entity Management host (lem) share this body, the timeout and the fail
// closed check. A 204 or a non JSON body reads as {}.
async function adyenHostCall<T = Record<string, unknown>>(cfg: AdyenConfig, base: string, apiKey: string, method: string, path: string, body?: unknown): Promise<HostAnswer<T>> {
  assertAdyenConfigured(cfg);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(MGMT_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`Adyen did not answer ${method} ${path.split('?')[0]} within ${MGMT_TIMEOUT_MS / 1000}s`);
    throw e;
  }
  let data: T;
  try { data = await res.json(); } catch { data = {} as T; }
  return { ok: res.ok, status: res.status, data };
}
async function mgmt<T = Record<string, unknown>>(cfg: AdyenConfig, method: string, path: string, body?: unknown, apiKey: string = cfg.managementKey): Promise<HostAnswer<T>> {
  return adyenHostCall<T>(cfg, managementBase(cfg), apiKey, method, path, body);
}
// Balance Platform Configuration API v2 (cfg.bpKey, the set's API key when
// no separate ADYEN[_LIVE_<REGION>]_BP_KEY is set) and Legal Entity
// Management API v4 (cfg.lemKey): the two further hosts of PULL BY
// REFERENCE below. Same hosts for both regions, different key sets.
const bcl = <T = Record<string, unknown>>(cfg: AdyenConfig, method: string, path: string, body?: unknown) => adyenHostCall<T>(cfg, balancePlatformBase(cfg), cfg.bpKey, method, path, body);
const lem = <T = Record<string, unknown>>(cfg: AdyenConfig, method: string, path: string, body?: unknown) => adyenHostCall<T>(cfg, lemBase(cfg), cfg.lemKey, method, path, body);

const scopeMissing = (status: number) => status === 401 || status === 403;

// The text of an Adyen refusal for the admin: a 401/403 names the secret the
// key came from (never its value) and the role it lacks; anything else is
// the RFC 7807 detail.
function refusalText(cfg: AdyenConfig, r: { status: number; data: unknown }, keyField: 'managementKey' | 'bpKey' | 'lemKey', role: string): string {
  if (scopeMissing(r.status)) {
    return `refused (${r.status}): the credential behind ${adyenSecretName(cfg.env, keyField, cfg.region)} (the set's API key when that is unset) needs ${role}`;
  }
  return adyenRefusalMessage(r.status, r.data);
}

// The venue's short code (ops locations.venue_code, for example SV-1007):
// the store REFERENCE at Adyen, the key PULL BY REFERENCE and ensure_store
// share. Null when the venue has none.
async function venueCodeFor(opsLocationId: string): Promise<string | null> {
  try {
    const { data } = await opsAdmin.from('locations').select('venue_code').eq('id', opsLocationId).maybeSingle();
    const code = String((data as Record<string, unknown> | null)?.venue_code ?? '').trim();
    return code || null;
  } catch { return null; }
}

// ── PULL BY REFERENCE (8 Sep 2026, OWNER RULE 1) ─────────────────────────────
// Adyen already holds the venue's store, balance account and account holder,
// created by FranPOS or Adyen with the venue code (SV-1007) as the STORE
// REFERENCE. The admin pulls every id from Adyen by that reference and never
// types one. Four reads on three hosts, three keys, all on the venue's
// REGION set (docs.adyen.com, verified 8 Sep 2026):
//   1. Management v3   GET /merchants/{m}/stores?reference=SV-1007&pageSize=100
//        role "Stores read". data[] { id (ST...), reference, status,
//        businessLineIds[], splitConfiguration { balanceAccountId,
//        splitConfigurationId }, address }. The reference is unique per
//        merchant; the docs do not say whether the filter is exact, so the
//        rows are matched again here (exact, case insensitive) and the whole
//        list is paged when the filtered call finds nothing (candidates).
//   2. Balance Platform v2  GET /balanceAccounts/{id}   { accountHolderId (AH...), status, defaultCurrencyCode }
//   3. Balance Platform v2  GET /accountHolders/{id}    { legalEntityId (LE...), status, capabilities, primaryBalanceAccount, balancePlatform }
//        Fallback when the store carries no split configuration and a holder
//        id is known: GET /accountHolders/{id}/balanceAccounts?limit=100 and
//        pick the primary (or the one open account in the region's currency).
//        There is NO account holder lookup by reference.
//   4. LEM v4               GET /legalEntities/{id}     { organization.legalName, type, capabilities, transferInstruments[] (SI...), problems }
// The shape work (matching, summaries, the row patch, the plan) is in
// _shared/adyenLink.ts, mirror of src/lib/payments/adyenLink.js, tests in
// adyenLink.test.js. Nothing here throws on a missing piece: every refusal
// is a line in `errors`, every gap a line in `notes`, and the answer says
// what WAS found.
const STORE_PAGE_SIZE = 100;
const STORE_PAGES = 20;   // 2000 stores per merchant, plenty for one reseller merchant
type Dict = Record<string, unknown>;
interface StoreListAnswer { rows: Dict[]; errors: string[]; scopeMissing: boolean }
interface StoreSearch { store: Dict | null; matches: Dict[]; ambiguous: boolean; rows: Dict[]; errors: string[]; scopeMissing: boolean }

// Page the merchant's stores, optionally filtered by reference (query is
// 'reference=...&' or ''). Stops at the last page (pagesTotal, or no
// _links.next), at an empty page, or at STORE_PAGES.
async function listStores(cfg: AdyenConfig, merchant: string, query: string): Promise<StoreListAnswer> {
  const m = encodeURIComponent(merchant);
  const rows: Dict[] = [];
  const errors: string[] = [];
  for (let page = 1; page <= STORE_PAGES; page++) {
    const r = await mgmt<{ data?: unknown[]; pagesTotal?: unknown; _links?: { next?: unknown } }>(cfg, 'GET', `/merchants/${m}/stores?${query}pageSize=${STORE_PAGE_SIZE}&pageNumber=${page}`);
    if (!r.ok) {
      errors.push(`store list${query ? ' by reference' : ''} on ${merchant}: ${refusalText(cfg, r, 'managementKey', 'the Management API role "Stores read"')}`);
      return { rows, errors, scopeMissing: scopeMissing(r.status) };
    }
    const pageRows = storeRows(r.data);
    rows.push(...pageRows);
    const pagesTotal = Number(r.data?.pagesTotal);
    const more = pageRows.length > 0 && ((Number.isFinite(pagesTotal) && pagesTotal > page) || !!r.data?._links?.next);
    if (!more) break;
  }
  return { rows, errors, scopeMissing: false };
}

// Hop 1: the venue's store by reference on ONE merchant account. The
// filtered call first; when it matches nothing the whole list is paged so
// the admin gets candidates (and a reference Adyen filters differently
// still matches). A refused filtered call is forgotten when the full list
// answers; a 401/403 anywhere stops the search.
async function findStoreByReference(cfg: AdyenConfig, merchant: string, reference: string): Promise<StoreSearch> {
  const byRef = await listStores(cfg, merchant, `reference=${encodeURIComponent(reference)}&`);
  if (byRef.scopeMissing) return { store: null, matches: [], ambiguous: false, rows: [], errors: byRef.errors, scopeMissing: true };
  let found = matchStoreByReference(byRef.rows, reference);
  if (found.matches.length) return { ...found, rows: byRef.rows, errors: byRef.errors, scopeMissing: false };
  const all = await listStores(cfg, merchant, '');
  if (all.scopeMissing) return { store: null, matches: [], ambiguous: false, rows: [], errors: [...byRef.errors, ...all.errors], scopeMissing: true };
  found = matchStoreByReference(all.rows, reference);
  return { ...found, rows: all.rows, errors: all.errors.length ? [...byRef.errors, ...all.errors] : [], scopeMissing: false };
}

interface LookupOpts { storeId?: string | null; accountHolderId?: string | null; currency: string }

// The whole chain for one venue on one config. `reference` is the venue
// code (or the admin's override); `storeId` skips the search (the admin
// picked a candidate); `accountHolderId` is the fallback holder when the
// store names no balance account (the owner supplied Provo id).
async function lookupByReference(cfg: AdyenConfig, merchant: string, reference: string | null, opts: LookupOpts): Promise<LookupResult> {
  const errors: string[] = [];
  const notes: string[] = [];
  const out: LookupResult = {
    found: false, reference, merchantAccount: merchant, environment: cfg.env, region: cfg.region,
    store: null, balanceAccount: null, accountHolder: null, legalEntity: null,
    splitConfigurationId: null, businessLineIds: [], candidates: [], errors, notes, scopeMissing: false,
  };

  // 1. the store: by id when the admin picked one, else by reference
  let store: StoreSummary | null = null;
  const storeId = String(opts.storeId ?? '').trim();
  if (storeId) {
    const r = await mgmt<Dict>(cfg, 'GET', `/stores/${encodeURIComponent(storeId)}`);
    if (!r.ok) {
      errors.push(`store ${storeId}: ${refusalText(cfg, r, 'managementKey', 'the Management API role "Stores read"')}`);
      out.scopeMissing = scopeMissing(r.status);
    } else {
      store = storeSummary(r.data);
      if (store?.merchantId && store.merchantId.toLowerCase() !== merchant.toLowerCase()) {
        errors.push(`store ${storeId} belongs to merchant account ${store.merchantId}, not ${merchant}; it cannot be linked to a ${cfg.region} venue on this account.`);
        store = null;
      } else if (store && reference && referenceKey(store.reference) !== referenceKey(reference)) {
        notes.push(`Store ${storeId} carries the reference ${store.reference ?? '(none)'}, not the venue code ${reference}. It was chosen by id.`);
      }
    }
  } else if (reference) {
    const s = await findStoreByReference(cfg, merchant, reference);
    errors.push(...s.errors);
    out.scopeMissing = s.scopeMissing;
    if (s.store) store = storeSummary(s.store);
    else {
      out.candidates = storeCandidates(s.rows, reference, 50);
      if (s.ambiguous) {
        errors.push(`${s.matches.length} stores on ${merchant} carry the reference ${reference} (${s.matches.map((x) => String(x.id ?? '?')).join(', ')}). Pass storeId to pick one.`);
      } else if (!s.scopeMissing) {
        notes.push(`No store on ${merchant} has the reference ${reference}. Pick one of the ${out.candidates.length} stores listed (storeId), or create it with adyen_create_store_by_reference.`);
      }
    }
  } else {
    errors.push('This venue has no venue code, so there is no store reference to look up. Set one in the Back Office (Venue settings) or pass reference.');
  }
  if (!store) return out;
  out.found = true;
  out.store = store;
  out.splitConfigurationId = store.splitConfigurationId;
  out.businessLineIds = store.businessLineIds;
  if (store.status && store.status !== 'active') notes.push(`The store is ${store.status} at Adyen; payments naming it are refused until it is active.`);

  // 2. the balance account the store's split configuration names
  let ba: BalanceAccountSummary | null = null;
  if (store.balanceAccountId) {
    const r = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(store.balanceAccountId)}`);
    if (r.ok) ba = balanceAccountSummary(r.data, 'store');
    else errors.push(`balance account ${store.balanceAccountId}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  } else {
    notes.push('The store carries no split configuration, so Adyen names no balance account for it.');
  }

  // 3. the account holder: the balance account's, else the id the admin passed
  let ah: AccountHolderSummary | null = null;
  const holderId = ba?.accountHolderId || String(opts.accountHolderId ?? '').trim() || null;
  if (holderId) {
    const r = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(holderId)}`);
    if (r.ok) {
      ah = accountHolderSummary(r.data);
      if (!ba?.accountHolderId) notes.push(`Account holder ${holderId} was read from the id given, not from the store.`);
    } else errors.push(`account holder ${holderId}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  } else if (ba) {
    errors.push(`balance account ${ba.id} names no account holder.`);
  } else {
    notes.push('No account holder is reachable: the store names no balance account and no accountHolderId was given.');
  }

  // 3b. the store names no balance account but the holder is known: pick
  //     one of the holder's (primary, else the one open account in the
  //     region's currency, else the only one)
  if (!ba && ah?.id) {
    const r = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(ah.id)}/balanceAccounts?limit=100`);
    if (r.ok) {
      const pick = pickBalanceAccount(r.data, { primaryId: ah.primaryBalanceAccount, currency: opts.currency });
      if (pick) {
        ba = balanceAccountSummary(pick, 'account_holder');
        notes.push(`Balance account ${ba?.id} was taken from the account holder (its primary, or the one open account in ${opts.currency}); the store's split configuration at Adyen does not name it yet, so payments do not split into it until that is configured.`);
      } else {
        const n = Array.isArray((r.data as Dict)?.balanceAccounts) ? ((r.data as Dict).balanceAccounts as unknown[]).length : 0;
        errors.push(`account holder ${ah.id} has ${n} balance account${n === 1 ? '' : 's'} and none could be chosen for ${opts.currency}.`);
      }
    } else errors.push(`balance accounts of ${ah.id}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  }

  // 4. the legal entity (KYC truth, legal name, bank accounts)
  if (ah?.legalEntityId) {
    const r = await lem<Dict>(cfg, 'GET', `/legalEntities/${encodeURIComponent(ah.legalEntityId)}`);
    if (r.ok) out.legalEntity = legalEntitySummary(r.data);
    else errors.push(`legal entity ${ah.legalEntityId}: ${refusalText(cfg, r, 'lemKey', 'the roles "Manage LegalEntities via API" and "Balance Platform BCL Legal Entity role"')}`);
  } else if (ah) {
    errors.push(`account holder ${ah.id} names no legal entity.`);
  }

  out.balanceAccount = ba;
  out.accountHolder = ah;
  return out;
}

// Durable audit trail for the link actions, the ledger adyen-onboard and the
// probes use (platform adyen_webhook_events, event_key is the pk). Fire and
// forget: a logging failure never fails the step it records.
function logLink(step: string, locationId: string, raw: unknown) {
  void platformAdmin.from('adyen_webhook_events').insert({
    event_key: `link:${step}:${locationId}:${Date.now()}`,
    raw,
  }).then(() => {}, () => {});
}

// Run a registration half, turning a throw into its error line.
async function attemptRegistration(label: string, run: () => Promise<RegistrationAnswer>): Promise<RegistrationAnswer> {
  try { return await run(); } catch (e) { return { ok: false, error: `${label}: ${(e as Error)?.message || String(e)}` }; }
}

// Write a merchant_adyen_accounts row that names its region. Before
// 20260908_PLATFORM_adyen_region_uk.sql runs, the OLD check constraint
// refuses 'UK': a UK write is retried WITHOUT the column (the old default
// 'EU' reads as UK everywhere) and the caller gets a warning naming the
// migration, so a store create or an environment flip never fails on the
// region alone. A US write passes either check. set_region does NOT use this:
// it must refuse, because silently keeping 'EU' is not what was asked.
async function upsertAccountRow(patch: Record<string, unknown>, select?: string): Promise<{ error: { message: string } | null; warning: string | null }> {
  const run = async (p: Record<string, unknown>) => {
    const q = platformAdmin.from('merchant_adyen_accounts').upsert(p, { onConflict: 'location_id' });
    return select ? await q.select(select).maybeSingle() : await q;
  };
  let { error } = await run(patch);
  if (error && isAdyenRegionCheckError(error) && parseAdyenRegion(patch.region) === 'UK') {
    const { region: _region, ...rest } = patch;
    ({ error } = await run(rest));
    if (!error) return { error: null, warning: adyenRegionMigrationMessage() };
  }
  return { error: error ?? null, warning: null };
}

// ── the kept setup: merchant_adyen_accounts.env_stash (8 Sep 2026) ──────────
// A flip clears the setup made on the environment the venue leaves; the
// stash keeps it (see ENVIRONMENT STASH in _shared/adyenLink.ts). The column
// arrives with 20260908b_PLATFORM_adyen_env_stash.sql: until it runs, the
// read below answers `available: false` and a warning naming the file, and
// the flip runs exactly as before (nothing kept, nothing restored). The
// column is read ON ITS OWN, never in the venue select: PostgREST answers 400
// for a select naming an unknown column, which would kill every action.
const ENV_STASH_MIGRATION = 'supabase/migrations/20260908b_PLATFORM_adyen_env_stash.sql';
type EnvStashState = { stash: Record<string, unknown>; available: boolean; warning: string | null };

// PostgREST's two shapes for a column that is not there: 42703 "column ...
// does not exist" on a select, PGRST204 "Could not find the '...' column of
// '...' in the schema cache" on a write. The column name must be in the text.
function isUnknownColumnError(err: { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null | undefined, column: string): boolean {
  if (!err) return false;
  const code = String(err.code ?? '');
  const text = [err.message, err.details, err.hint].map((v) => String(v ?? '')).join(' ');
  if (!text.includes(column)) return false;
  return code === '42703' || code === 'PGRST204' || /does not exist|schema cache|could not find/i.test(text);
}

function envStashMissingMessage(): string {
  return `The setup of the environment the venue leaves was NOT kept: merchant_adyen_accounts has no env_stash column yet. Run ${ENV_STASH_MIGRATION} on the platform project. Register the readers and link the store again if the venue switches back.`;
}

async function readEnvStash(locationId: string): Promise<EnvStashState> {
  const { data, error } = await platformAdmin.from('merchant_adyen_accounts').select('env_stash').eq('location_id', locationId).maybeSingle();
  if (error) {
    if (isUnknownColumnError(error, 'env_stash')) return { stash: {}, available: false, warning: envStashMissingMessage() };
    // Any other refusal: never write a stash blind (it would replace what is kept).
    return { stash: {}, available: false, warning: `The kept setup could not be read (${error.message}), so nothing was kept or put back on this switch.` };
  }
  const raw = (data as Record<string, unknown> | null)?.env_stash;
  const stash = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { stash, available: true, warning: null };
}

// Currency symbol for text shown ON a reader (the pay at table menu).
const currencySymbol = (currency: string) => (currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£');

// A store with no payment methods bricks its terminals ("no payment method
// configured" on the reader). Request the card schemes for the store; test
// auto-approves, live goes to Adyen review. Idempotent — "already exists"
// style refusals are fine. Currency and country follow the venue's REGION
// (8 Sep 2026: they were hardcoded GBP/GB, wrong for a US venue).
async function ensurePaymentMethods(cfg: AdyenConfig, merchant: string, storeId: string, market: { currency: string; country: string }): Promise<{ requested: string[]; errors: string[] }> {
  const requested: string[] = [];
  const errors: string[] = [];
  const schemes = market.country === 'US' ? ['visa', 'mc', 'amex', 'discover'] : ['visa', 'mc', 'amex', 'maestro'];
  for (const type of schemes) {
    const r = await mgmt(cfg, 'POST', `/merchants/${merchant}/paymentMethodSettings`, {
      type, storeIds: [storeId], currencies: [market.currency], countries: [market.country],
    });
    if (r.ok) requested.push(type);
    else {
      const msg = String((r.data as Record<string, unknown>)?.detail || (r.data as Record<string, unknown>)?.title || r.status);
      if (/exist|already|duplicate/i.test(msg)) requested.push(type);
      else errors.push(`${type}: ${msg}`);
    }
  }
  return { requested, errors };
}

// ── WEB ORIGINS and APPLE PAY domains (8 Sep 2026) ───────────────────────────
// The Drop-in and Components run on the operator hosts (app.serv-os.app,
// dev.serv-os.app) and on every venue storefront (<slug>.serv-os.app,
// <slug>.dev.serv-os.app), so the API credential the client key belongs to
// must list those as ALLOWED ORIGINS. The live Customer Area refuses a
// wildcard in its screen while Adyen's docs allow https://*.example.org, so
// the wildcards go in through the Management API (docs.adyen.com, Management
// API v3, host = managementBase(cfg)):
//   GET  /v3/me                     { username, clientKey, allowedOrigins, roles }   any Management role
//   GET  /v3/me/allowedOrigins      { data: [{ id, domain }] }   any Management role
//   POST /v3/me/allowedOrigins      { domain }                   200 { id, domain }
// /me is CREDENTIAL scoped: the key that makes the call is the key whose
// origins change, and the Drop-in only honours origins on the credential its
// CLIENT KEY was generated on. So these calls sign with cfg.apiKey (the
// set's API key, never cfg.managementKey, which may be a separate credential
// holding the management roles) and GET /me proves it first: when that
// credential's clientKey is not cfg.clientKey the answer is wrong_credential
// and nothing is posted (8 Sep 2026: with a management key set every origin
// landed on the management credential, the answer said ok, and the Drop-in
// still refused every host). The VENUE's config (its environment and its
// region set) picks the credential: a test venue registers on the test
// credential, a UK live venue on the UK live credential, a US one on the US
// credential. The answer names it (credential: the /me username).
//
// APPLE PAY with Adyen's certificate needs every storefront host registered
// on the merchant's Apple Pay payment method. The app serves the association
// file at /.well-known/apple-developer-merchantid-domain-association on
// every host (public/.well-known, v5.8.36), so the hosts verify on the spot:
//   GET  /v3/merchants/{m}/paymentMethodSettings?pageSize=100
//        { data: [{ id, type, enabled, verificationStatus, storeIds, applePay: { domains } }] }
//   GET  /v3/merchants/{m}/paymentMethodSettings/{id}/getApplePayDomains   { domains }
//   POST /v3/merchants/{m}/paymentMethodSettings/{id}/addApplePayDomains   { domains }   204
//        role "Management API, Payment methods read and write"
// Neither action REQUESTS Apple Pay on the merchant: that is done in the
// Customer Area, and the answer says so (verificationStatus valid | pending |
// invalid | rejected) when it has not happened yet.
//
// Both are idempotent: whatever Adyen already lists is reported as existing
// and never posted twice; an "already exists" refusal counts as existing.
// Both run by themselves at the end of set_environment when a venue MOVES TO
// LIVE, best effort, and again from the admin portal's button at any time.
// The list builders and the dedupe live in _shared/adyenOrigins.ts (mirror
// of src/lib/payments/adyenOrigins.js, tests in adyenOrigins.test.js).
type RegistrationAnswer = Record<string, unknown> & { ok: boolean };
interface Storefront { slug: string | null; customDomain: string | null }

// The venue's storefront: platform locations.online_slug becomes
// <slug>.serv-os.app and <slug>.dev.serv-os.app (src/lib/customerUrl.js,
// src/lib/env.js). Read on its own, never in the venue select above, so a
// venue with no slug still reaches every other action. There is no custom
// storefront domain column yet (org_sending_domains is email only), so
// customDomain is always null here; the builders already take one.
async function storefrontFor(locationId: string): Promise<Storefront> {
  const { data, error } = await platformAdmin.from('locations').select('online_slug').eq('id', locationId).maybeSingle();
  if (error) throw new Error(`storefront lookup failed: ${error.message}`);
  const slug = String((data as Record<string, unknown> | null)?.online_slug ?? '').trim().toLowerCase() || null;
  return { slug, customDomain: null };
}

// GET /me with the set's API KEY (cfg.apiKey: the credential the Drop-in
// client key belongs to, never the management key), prove its clientKey is
// the set's client key, then GET that credential's allowed origins and POST
// each missing ServOS origin with the same key. Answers { ok, environment,
// region, credential, wanted, added, existing, failed: [{ origin, status,
// message }], note } or, when the credential or its list cannot be read
// ({ ok: false, status, error }) or it is not the client key's credential
// ({ ok: false, code: 'wrong_credential', credential, error }), with the
// lists empty.
async function registerWebOrigins(cfg: AdyenConfig, customDomain: string | null): Promise<RegistrationAnswer> {
  const label = `${cfg.region} ${cfg.env} API credential`;
  const apiKeyName = adyenSecretName(cfg.env, 'apiKey', cfg.region);
  const base = {
    environment: cfg.env, region: cfg.region, credential: null as string | null, wanted: buildWebOrigins({ customDomain }),
    added: [] as string[], existing: [] as string[], failed: [] as Array<{ origin: string; status: number; message: string }>,
  };
  const apiKey = cfg.apiKey;
  const me = await mgmt<{ username?: unknown; clientKey?: unknown }>(cfg, 'GET', '/me', undefined, apiKey);
  if (!me.ok) {
    return {
      ...base, ok: false, status: me.status,
      error: scopeMissing(me.status)
        ? `The ${label} (${apiKeyName}) cannot read itself (${me.status}). Any Management API role should do; check the key in the Customer Area.`
        : `Could not read the ${label} (${apiKeyName}): ${adyenRefusalMessage(me.status, me.data)}`,
    };
  }
  const username = String(me.data?.username ?? '').trim() || null;
  const credential = username ? `${label} (${username})` : label;
  const meClientKey = String(me.data?.clientKey ?? '').trim();
  if (cfg.clientKey && meClientKey !== cfg.clientKey) {
    return {
      ...base, ok: false, code: 'wrong_credential', credential: username,
      error: `The ${credential}, behind ${apiKeyName}, is not the credential the Drop-in client key (${adyenSecretName(cfg.env, 'clientKey', cfg.region)}) belongs to. Add the origins on that credential: set ${apiKeyName} to an API key generated on it, or move the client key.`,
    };
  }
  const list = await mgmt(cfg, 'GET', '/me/allowedOrigins', undefined, apiKey);
  if (!list.ok) {
    return {
      ...base, ok: false, status: list.status, credential: username,
      error: scopeMissing(list.status)
        ? `The ${credential} cannot read its own allowed origins (${list.status}). Any Management API role should do; check the key in the Customer Area.`
        : `Could not read the allowed origins of the ${credential}: ${adyenRefusalMessage(list.status, list.data)}`,
    };
  }
  const plan = originsPlan(list.data, { customDomain });
  const added: string[] = [];
  const existing = [...plan.existing];
  const failed: Array<{ origin: string; status: number; message: string }> = [];
  for (const origin of plan.missing) {
    const r = await mgmt(cfg, 'POST', '/me/allowedOrigins', { domain: origin }, apiKey);
    if (r.ok) added.push(origin);
    else if (isDuplicateRefusal(r.status, r.data)) existing.push(origin);
    else failed.push({ origin, status: r.status, message: adyenRefusalMessage(r.status, r.data) });
  }
  return { ...base, ok: failed.length === 0, credential: username, added, existing, failed, note: `Registered on ${username ?? `the ${label}`}.` };
}

// Find the merchant's Apple Pay payment method, read the domains it holds,
// POST each missing storefront host. Answers { ok, environment, region,
// merchant, paymentMethodId, verificationStatus, domains, added, existing,
// failed: [{ domain, status, message }], note } or { ok: false, code, error }
// when there is no storefront, the list cannot be read or Apple Pay was
// never requested on the merchant.
async function registerApplePayDomains(cfg: AdyenConfig, merchant: string, storeId: string | null, storefront: Storefront): Promise<RegistrationAnswer> {
  const domains = buildStorefrontDomains(storefront);
  const base = {
    environment: cfg.env, region: cfg.region, merchant, domains,
    added: [] as string[], existing: [] as string[], failed: [] as Array<{ domain: string; status: number; message: string }>,
    paymentMethodId: null as string | null, verificationStatus: null as string | null, note: null as string | null,
  };
  if (!domains.length) {
    return { ...base, ok: false, code: 'no_storefront', error: 'This venue has no online slug yet, so it has no storefront address to register for Apple Pay. Set the slug in the Back Office (Channels) first.' };
  }
  const m = encodeURIComponent(merchant);
  const rows: unknown[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await mgmt<{ data?: unknown[]; _links?: { next?: unknown } }>(cfg, 'GET', `/merchants/${m}/paymentMethodSettings?pageSize=100&pageNumber=${page}`);
    if (!r.ok) {
      return {
        ...base, ok: false, status: r.status,
        error: scopeMissing(r.status)
          ? `The ${cfg.region} ${cfg.env} API key cannot read the payment methods on ${merchant} (${r.status}). It needs the Management API role "Payment methods read and write".`
          : `Could not read the payment methods on ${merchant}: ${adyenRefusalMessage(r.status, r.data)}`,
      };
    }
    const pageRows: unknown = r.data?.data;
    rows.push(...(Array.isArray(pageRows) ? pageRows : []));
    if (!r.data?._links?.next) break;
  }
  const pm = pickApplePayMethod(rows, storeId);
  // Null WITH Apple Pay entries present means every entry is scoped to some
  // OTHER venue's store (the picker never falls back to rows[0]: that wrote
  // this venue's hosts onto another venue's entry and reported it as this
  // venue's registration).
  const storeScoped = !pm && hasApplePayEntries(rows);
  const note = applePayStatusNote(pm, merchant, { storeScoped });
  if (!pm) return { ...base, ok: false, code: storeScoped ? 'apple_pay_store_scoped' : 'apple_pay_not_requested', error: note, note };
  const pmId = String(pm.id ?? '');
  const verificationStatus = pm.verificationStatus === undefined || pm.verificationStatus === null ? null : String(pm.verificationStatus);
  // What is registered already. The GET is the source of truth: 200 with
  // { domains }, or 204 with no body when nothing is registered yet (the
  // normal first run of every venue), which is an EMPTY list, not a failed
  // read. The method's own applePay.domains is the fallback for a refused
  // GET; with neither every host is sent and an "already exists" answer
  // counts as existing.
  let known: string[] | null = null;
  const cur = await mgmt<{ domains?: unknown }>(cfg, 'GET', `/merchants/${m}/paymentMethodSettings/${encodeURIComponent(pmId)}/getApplePayDomains`);
  const got: unknown = cur.ok ? cur.data?.domains : null;
  const own: unknown = pm.applePay?.domains;
  if (cur.ok && (cur.status === 204 || cur.data == null || got === undefined)) known = [];
  else if (Array.isArray(got)) known = got.filter((d): d is string => typeof d === 'string');
  else if (Array.isArray(own)) known = own.filter((d): d is string => typeof d === 'string');
  const plan = applePayDomainsPlan(known ?? [], storefront);
  const added: string[] = [];
  const existing = [...plan.existing];
  const failed: Array<{ domain: string; status: number; message: string }> = [];
  for (const domain of plan.missing) {
    // One host per call so a host that does not serve the association file
    // fails on its own line instead of taking the batch down with it.
    const r = await mgmt(cfg, 'POST', `/merchants/${m}/paymentMethodSettings/${encodeURIComponent(pmId)}/addApplePayDomains`, { domains: [domain] });
    if (r.ok) added.push(domain);
    else if (isDuplicateRefusal(r.status, r.data)) existing.push(domain);
    else failed.push({ domain, status: r.status, message: adyenRefusalMessage(r.status, r.data) });
  }
  const notes = [note];
  if (known === null) notes.push('Adyen did not list the domains registered already, so every host was sent; "already exists" answers count as existing.');
  if (failed.length) notes.push('A host is refused when it does not serve /.well-known/apple-developer-merchantid-domain-association over https. The app serves it on every ServOS host, so check that the host resolves.');
  return { ...base, ok: failed.length === 0, paymentMethodId: pmId, verificationStatus, added, existing, failed, note: notes.join(' ') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'status');
    // `locationId` is accepted as an alias (the environment actions use it);
    // it is fenced exactly like ops_location_id.
    // The admin portal sends the PLATFORM id; it is canonicalised to the ops
    // id once the venue row is resolved below, so the ops side queries (link
    // rows, venue code) hit the right venue whichever id the caller knew.
    let opsLocationId = String(body.ops_location_id || body.locationId || body.location_id || '');
    if (!opsLocationId || opsLocationId === 'loc-demo') return json({ error: 'ops_location_id required' }, 400);

    // ── BO fence (the ryft-terminals pattern) ────────────────────────────────
    const authHeader = req.headers.get('Authorization') || '';
    const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!caller) return json({ error: 'not authenticated' }, 401);
    const [{ data: ul }, { data: prof }] = await Promise.all([
      opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
      opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
    ]);
    if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

    // ── venue resolution: ops → platform → merchant mapping ──────────────────
    // No `country` in this select: platform locations has no such column
    // (000_baseline_platform.sql, read off the live catalog 6 Aug 2026), and
    // a bad column makes PostgREST answer 400 for EVERY action. The market
    // is derived further down from currency and the merchant row's region.
    // A query error is a 500 with the message, never folded into the 404,
    // so a schema mismatch is visible the next time.
    const select = 'id, name, payment_processor, currency, ops_location_id';
    let { data: loc, error: locErr } = await platformAdmin.from('locations').select(select).eq('ops_location_id', opsLocationId).maybeSingle();
    if (locErr) return json({ error: `platform locations lookup failed: ${locErr.message}` }, 500);
    if (!loc) ({ data: loc, error: locErr } = await platformAdmin.from('locations').select(select).eq('id', opsLocationId).maybeSingle());
    if (locErr) return json({ error: `platform locations lookup failed: ${locErr.message}` }, 500);
    if (!loc) return json({ error: 'location not found in platform DB' }, 404);
    // platform locations.ops_location_id is THE ops mapping (3 of 6 venues
    // carry different ids in the two DBs). A caller that only knew the
    // platform id (the admin portal) is moved onto the ops id here, so the
    // reprovision clear of terminal_devices and the venue code lookup below
    // reach the venue's own ops rows.
    const mappedOps = (loc as Record<string, unknown>).ops_location_id;
    if (mappedOps) opsLocationId = String(mappedOps);

    // Account row + the venue's environment in one wait. The environment
    // picks the secret set for EVERY Adyen call below. The provisioning ids
    // are read too: set_environment must know whether the row was set up on
    // the OTHER environment (Adyen store, legal entity, balance account and
    // reader ids are environment specific).
    const [{ data: maa }, target] = await Promise.all([
      platformAdmin.from('merchant_adyen_accounts')
        .select('merchant_account, store_id, region, receive_payments_ok, legal_entity_id, account_holder_id, balance_account_id, split_profile_id, transfer_instrument_id, business_line_id')
        .eq('location_id', loc.id).maybeSingle(),
      adyenEnvForLocation(platformAdmin, loc.id),
    ]);
    // adyenEnvForLocation answers { env, region } (8 Sep 2026): env is the
    // row's environment, region the row's region normalised ('EU' reads as
    // 'UK'; no row = by the location's currency). `env` and `region` stay
    // plain strings below (the actions compare and report them); every
    // config is built from both so the venue's REGION set is the one used,
    // including the live and test probes that decide what the switch offers.
    const { env, region } = target;
    const cfg = adyenConfig(target);
    const liveCfg = adyenConfig('live', region);
    const testCfg = adyenConfig('test', region);
    const liveRegions = liveRegionsConfigured();   // every usable live set, UK then US

    // Can the venue actually WORK live on ITS region? The api key, prefix and
    // merchant account make the region set `configured`, but the online paths
    // (adyen-checkout status, the Drop-in, booking_pay) also need the live
    // client key. The switch must not unlock on a half set. The merchant
    // account must be the LIVE secret of the region: the row's own name was
    // written on the current (test) environment and used to satisfy this
    // rule, which let a venue go live carrying FranPOS_ServOS_TEST (8 Sep
    // 2026). Names carry the region (ADYEN_LIVE_US_CLIENT_KEY), never values.
    const liveMissing = [...liveCfg.missing];
    if (!liveCfg.clientKey) liveMissing.push(adyenSecretName('live', 'clientKey', region));
    if (!liveCfg.merchantAccount && !liveMissing.includes(adyenSecretName('live', 'merchantAccount', region))) {
      liveMissing.push(adyenSecretName('live', 'merchantAccount', region));
    }
    const liveReady = liveMissing.length === 0;

    // Provisioning is per Adyen account (environment AND region): store,
    // legal entity, account holder, balance account, split profile, bank and
    // business line ids, plus the boarded readers. Read once here for the
    // environment answer, set_environment and set_region.
    const provisioned = ['store_id', 'legal_entity_id', 'account_holder_id', 'balance_account_id', 'split_profile_id', 'transfer_instrument_id', 'business_line_id']
      .filter((k) => !!(maa as Record<string, unknown> | null)?.[k]);
    const { count: readerCount } = await platformAdmin.from('payment_devices')
      .select('id', { count: 'exact', head: true }).eq('location_id', loc.id).eq('processor', 'adyen').neq('status', 'retired');
    const readers = Number(readerCount) || 0;

    // ── the kept setup (env_stash, 8 Sep 2026) ───────────────────────────────
    // Read on its own and only when an action asks, once per request.
    let envStashMemo: Promise<EnvStashState> | null = null;
    const getEnvStash = (): Promise<EnvStashState> => (envStashMemo ??= readEnvStash(loc.id));
    const stashSummaries = (state: EnvStashState) => ({ test: stashSummary(state.stash.test), live: stashSummary(state.stash.live) });

    // The venue's readers as the stash keeps them: the platform registry rows
    // (processor adyen, not retired) joined on the POIID to the ops link rows
    // (paired, with a POIID). A failed read is an error, never an empty list:
    // a stash without its readers is the incident this exists to prevent.
    const readReaderRows = async (): Promise<{ rows: StashReader[]; error: string | null }> => {
      const [pd, td] = await Promise.all([
        platformAdmin.from('payment_devices').select('id, label, adyen_terminal_id, serial_number')
          .eq('location_id', loc.id).eq('processor', 'adyen').neq('status', 'retired'),
        opsAdmin.from('terminal_devices').select('id, label, adyen_terminal_id, serial_number')
          .eq('location_id', opsLocationId).eq('status', 'paired').not('adyen_terminal_id', 'is', null),
      ]);
      if (pd.error) return { rows: [], error: `reader registry read failed: ${pd.error.message}` };
      if (td.error) return { rows: [], error: `ops terminal read failed: ${td.error.message}` };
      return { rows: stashReaders(pd.data || [], td.data || []), error: null };
    };

    // Put the readers of a kept setup back: the platform registry rows are
    // un-retired (status registered) and the POIID goes back on the ops link
    // row, only where that row is still paired and holds no POIID (a row
    // that was linked again meanwhile keeps what it has; idx_td_adyen also
    // refuses a POIID another paired row holds). Each reader answers for
    // itself: a refusal is a line in the answer, never a failed flip.
    const restoreReaders = async (list: StashReader[]): Promise<{ platform: number; ops: number; skipped: string[] }> => {
      const answer = { platform: 0, ops: 0, skipped: [] as string[] };
      const pdIds = list.map((r) => r.payment_device_id).filter((id): id is string => !!id);
      if (pdIds.length) {
        const { data, error } = await platformAdmin.from('payment_devices')
          .update({ status: 'registered' })
          .in('id', pdIds).eq('location_id', loc.id).eq('processor', 'adyen').eq('status', 'retired')
          .select('id');
        if (error) answer.skipped.push(`The reader registry could not be restored: ${error.message}`);
        else answer.platform = (data || []).length;
      }
      for (const r of list) {
        if (!r.terminal_device_id) continue;
        const name = r.label || r.adyen_terminal_id;
        const { data, error } = await opsAdmin.from('terminal_devices')
          .update({ adyen_terminal_id: r.adyen_terminal_id })
          .eq('id', r.terminal_device_id).eq('location_id', opsLocationId).eq('status', 'paired').is('adyen_terminal_id', null)
          .select('id');
        if (error) answer.skipped.push(`${name} could not be relinked: ${error.message}`);
        else if ((data || []).length) answer.ops += 1;
        else answer.skipped.push(`${name} was not relinked: its terminal row is no longer paired or already holds a reader.`);
      }
      return answer;
    };

    // The region may only change while nothing at Adyen belongs to it yet.
    const setupParts = [provisioned.length ? 'payments store' : '', readers ? `${readers} card reader${readers === 1 ? '' : 's'}` : ''].filter(Boolean);
    const regionLockReason: string | null = env === 'live'
      ? 'The venue is live. Switch it back to test cards before changing its region.'
      : setupParts.length
        ? `This venue's ${setupParts.join(' and ')} ${setupParts.length > 1 || readers > 1 ? 'were' : 'was'} set up on the ${region} account. Clear that setup first (switch environments with reprovision, or unlink the readers).`
        : null;
    const regionLocked = regionLockReason !== null;
    // OWNER RULE (8 Sep 2026): only a ServOS super_admin may move a venue
    // between test cards and real money, create its Adyen store or request
    // its card schemes. Venue roles, the owner included, read the state only.
    // Same source of truth as adyen-onboard's fence: the caller's
    // user_profiles.role, read above with the service role, never a client
    // supplied flag.
    const isServosAdmin = prof?.role === 'super_admin';
    const canSetEnvironment = isServosAdmin;
    const canSetRegion = isServosAdmin;
    const adminOnly = () => json({ error: 'ServOS admin only' }, 403);

    // ── environment: read the venue's Adyen environment and region (never the values) ──
    if (action === 'environment') {
      const envStash = await getEnvStash();
      return json({
        ok: true,
        environment: env,
        region,                                // 'UK' | 'US' (a stored legacy 'EU' reads as 'UK')
        storedRegion: maa?.region ?? null,     // the raw column, so the admin can see a legacy 'EU'
        liveConfigured: liveReady,             // THIS region: api key, prefix, client key AND a merchant account
        liveRegionsConfigured: liveRegions,    // every live set with api key, prefix and merchant account
        testConfigured: testCfg.configured,
        liveMissing,                           // secret NAMES of this region's set only
        canSetEnvironment,
        canSetRegion,
        regionLocked,                          // live, or a store or readers exist on the current account
        regionLockReason,
        provisioned,
        readers,
        // The kept setup per environment (8 Sep 2026): null where nothing is
        // kept; stashAvailable is false until the platform migration ran.
        stashAvailable: envStash.available,
        stashes: stashSummaries(envStash),
        stashWarning: envStash.warning,
      });
    }

    // ── set_region: UK or US, before anything at Adyen belongs to the venue ──
    // super_admin only (OWNER RULE). The live account, the Terminal API host
    // and the Drop-in environment all hang off this, so it is refused while
    // the venue is live or holds a store or readers: those were created on
    // ONE Adyen account and would silently point at the wrong one. Writes
    // merchant_adyen_accounts.region and creates the row when there is none.
    // Until 20260908_PLATFORM_adyen_region_uk.sql runs, the old check
    // constraint refuses 'UK' and the answer names the migration.
    if (action === 'set_region') {
      if (!isServosAdmin) return adminOnly();
      const next = parseAdyenRegion(body.region);
      if (!next) return json({ error: "region must be 'UK' or 'US'" }, 400);
      if (regionLocked) return json({ ok: false, error: regionLockReason, locked: true }, 409);
      if (String(maa?.region ?? '').trim().toUpperCase() === next) {
        return json({ ok: true, region: next, previous: region, unchanged: true, liveConfigured: adyenConfig('live', next).configured, liveRegionsConfigured: liveRegions });
      }
      const patch: Record<string, unknown> = { location_id: loc.id, region: next, updated_at: new Date().toISOString() };
      // A test venue whose merchant_account is the OLD region's test account
      // moves to the new region's test account (the test set is one set, so
      // this only changes anything when ADYEN_TEST_US_MERCHANT_ACCOUNT is set).
      const nextTestCfg = adyenConfig('test', next);
      const rowMerchant = String(maa?.merchant_account ?? '').trim();
      if (rowMerchant && testCfg.merchantAccount && nextTestCfg.merchantAccount
          && rowMerchant.toLowerCase() === testCfg.merchantAccount.toLowerCase()
          && nextTestCfg.merchantAccount.toLowerCase() !== rowMerchant.toLowerCase()) {
        patch.merchant_account = nextTestCfg.merchantAccount;
      }
      const { error: regionErr } = await platformAdmin.from('merchant_adyen_accounts')
        .upsert(patch, { onConflict: 'location_id' }).select('location_id, region').maybeSingle();
      if (regionErr) {
        if (isAdyenRegionCheckError(regionErr)) {
          return json({ ok: false, error: `Run migration ${ADYEN_REGION_MIGRATION} first`, migration: ADYEN_REGION_MIGRATION, detail: adyenRegionMigrationMessage() }, 409);
        }
        return json({ ok: false, error: `region write failed: ${regionErr.message}` }, 500);
      }
      const nextLive = adyenConfig('live', next);
      console.log(`[adyen-terminal-admin] ${caller.id} set region=${next} for ${loc.id} (was ${maa?.region ?? 'unset'}, read as ${region})`);
      return json({
        ok: true,
        region: next,
        previous: region,
        liveConfigured: nextLive.configured && !!nextLive.clientKey,
        liveRegionsConfigured: liveRegions,
        merchantAccount: (patch.merchant_account as string | undefined) ?? maa?.merchant_account ?? null,
        warning: patch.merchant_account ? `The merchant account was switched to the ${next} test account (${patch.merchant_account}).` : null,
      });
    }

    // ── set_environment: flip the venue between test and live ────────────────
    // super_admin only (OWNER RULE above). The upsert writes environment and
    // region (plus updated_at) on an existing row and creates a row with
    // those when none exists.
    //
    // PROVISIONING IS PER ENVIRONMENT. Adyen store ids, legal entity ids,
    // account holder and balance account ids all belong to the environment
    // that created them, and readers are boarded to one environment at a
    // time. A row that still carries ids from the current environment cannot
    // simply be flipped: every live call would carry test ids (store not
    // found, terminalSettings 404, balances for the wrong account). So the
    // flip is REFUSED with 409 while such ids are present, unless the caller
    // sends reprovision: true, in which case the same upsert clears them and
    // the venue starts store setup and reader registration again on the new
    // environment. merchant_account is REPLACED with the target environment's
    // secret account on every change of environment (8 Sep 2026: it used to
    // be kept on the theory that Adyen mirrors the name, but the test account
    // is FranPOS_ServOS_TEST and every function prefers the row over the
    // secret, so a live venue named the test merchant on the live host).
    //
    // Flipping to live without the live keys is allowed but warned: that venue
    // fails closed on every card call until the keys are set. Flipping to
    // live without the REGION'S live merchant account
    // (ADYEN_LIVE_UK_MERCHANT_ACCOUNT or ADYEN_LIVE_US_MERCHANT_ACCOUNT) is
    // refused outright: nothing sensible could be written into merchant_account.
    //
    // The flip lives in flipEnvironment (8 Sep 2026) so adyen_link, which
    // moves a venue to live with the ids it just pulled from Adyen, runs the
    // SAME rules, the same reader registry and ops link clearing and the
    // same merchant account rewrite, in one write.

    // Web origins and Apple Pay domains for one config, best effort: both
    // halves always answer, a storefront lookup failure answers both with
    // its error, a throw becomes that half's error line. Shared by the go
    // live tail of set_environment and by adyen_link.
    const runRegistrations = async (regCfg: AdyenConfig, regMerchant: string, regStoreId: string | null): Promise<{ webOrigins: RegistrationAnswer; applePayDomains: RegistrationAnswer }> => {
      let storefront: Storefront;
      try { storefront = await storefrontFor(loc.id); } catch (e) {
        const error = `storefront lookup: ${(e as Error)?.message || String(e)}`;
        return { webOrigins: { ok: false, error }, applePayDomains: { ok: false, error } };
      }
      const sf = storefront;
      const webOrigins = await attemptRegistration('web origins', () => registerWebOrigins(regCfg, sf.customDomain));
      const applePayDomains = await attemptRegistration('Apple Pay domains', () => registerApplePayDomains(regCfg, regMerchant, regStoreId, sf));
      return { webOrigins, applePayDomains };
    };

    // The flip. `reprovision` is the caller's yes to clearing setup made on
    // the current environment. `extraPatch` rides on the SAME upsert, merged
    // AFTER the reprovision clear (adyen_link's freshly pulled ids replace
    // the cleared ones in one write). `registrations` runs the go live
    // origins and Apple Pay tail; adyen_link passes false and runs its own
    // with the store id it now holds. Answers { ok: false, status, body }
    // for a refusal (returned as is) or the flip's outcome.
    type StashSummary = ReturnType<typeof stashSummary>;
    type RestoreAnswer = { environment: AdyenEnv; stashed_at: string | null; store_id: string | null; ids: string[]; readers: { platform: number; ops: number }; skipped: string[] };
    type FlipOutcome =
      | { ok: false; status: number; body: Record<string, unknown> }
      | {
        ok: true; reprovisioned: boolean; merchantNext: string | null; warnings: string[];
        webOrigins: RegistrationAnswer | null; applePayDomains: RegistrationAnswer | null;
        stashSaved: StashSummary; restored: RestoreAnswer | null; keepsSetup: boolean;
      };
    const flipEnvironment = async (next: AdyenEnv, opts: { reprovision: boolean; extraPatch?: Record<string, unknown>; registrations: boolean }): Promise<FlipOutcome> => {
      if (next === 'live' && next !== env && !liveCfg.merchantAccount) {
        return { ok: false, status: 400, body: { ok: false, error: `Set ${adyenSecretName('live', 'merchantAccount', region)} on the server first: the venue's ${region} live merchant account name comes from it.` } };
      }
      const provisionedOnCurrent = next !== env && (provisioned.length > 0 || readers > 0);
      // The kept setup (8 Sep 2026), read only when the environment changes.
      // `available` is false until the platform migration adds the column:
      // the flip then runs as before and the answer names the file.
      const envStash: EnvStashState = next !== env ? await getEnvStash() : { stash: {}, available: false, warning: null };
      const restores = envStash.available ? stashSummary(envStash.stash[next]) : null;
      if (provisionedOnCurrent && !opts.reprovision) {
        const parts = [
          provisioned.length ? 'payments store' : '',
          readers ? `${readers} card reader${readers === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        const verb = parts.length > 1 || readers > 1 ? 'were' : 'was';
        const tail = envStash.available
          ? `Switching to ${next} sets that setup aside.`
          : `Switching to ${next} clears that setup: run store setup and register the readers again afterwards.`;
        return {
          ok: false, status: 409,
          body: {
            ok: false,
            needs_reprovision: true,
            error: `This venue's ${parts.join(' and ')} ${verb} set up on the ${env} system. ${tail}`,
            provisioned,
            readers,
            // keeps_setup: the admin portal's confirm adds "Your test setup
            // is kept and comes back if you switch back". restores: what a
            // flip puts back on the target environment (null: nothing kept).
            keeps_setup: envStash.available,
            restores,
            stash_warning: envStash.warning,
          },
        };
      }
      // The row carries its region explicitly from here on (a new row would
      // otherwise take the database default; a legacy 'EU' row is rewritten
      // to 'UK'). upsertAccountRow retries a 'UK' the old check refuses.
      const patch: Record<string, unknown> = { location_id: loc.id, environment: next, region, updated_at: new Date().toISOString() };
      // The merchant account belongs to the environment AND region: on a
      // change it is the TARGET set's secret for this region (null only when
      // that secret is unset, which the live guard above already refused).
      const merchantWas = maa?.merchant_account ?? null;
      const merchantNext = next !== env ? ((next === 'live' ? liveCfg : testCfg).merchantAccount || null) : merchantWas;
      if (next !== env) patch.merchant_account = merchantNext;
      if (provisionedOnCurrent) {
        Object.assign(patch, {
          store_id: null, split_profile_id: null, legal_entity_id: null, account_holder_id: null, balance_account_id: null,
          transfer_instrument_id: null, business_line_id: null, onboarding_link_url: null, onboarding_link_expires_at: null,
          receive_payments_ok: false, payouts_ok: false, verification_status: null,
        });
      }
      // STASH AND RESTORE (8 Sep 2026). The outgoing environment's setup
      // goes under env_stash[env] on the SAME upsert as the clear above (one
      // write: the clear can never land without the stash; moving Provo live
      // and back wiped its test store id and both reader links). A stash for
      // the environment the venue ARRIVES on is put back onto the row here:
      // over the clear, under anything the caller pulled (adyen_link's ids
      // for that environment win field by field, stashRestorePlan). The
      // readers follow after the row write. A stash that holds nothing never
      // replaces one that does, and the stash for the environment just left
      // stays where it is.
      let stashSaved: StashSummary = null;
      let restorePlan: StashRestorePlan | null = null;
      let restoreEntry: Record<string, unknown> | null = null;
      if (next !== env && envStash.available) {
        const { rows: readerRows, error: readerErr } = await readReaderRows();
        if (readerErr) return { ok: false, status: 500, body: { ok: false, error: `The ${env} setup could not be read to keep it (${readerErr}), so the venue was not switched.` } };
        const entry = buildEnvStashEntry(maa, readerRows, { region });
        const previous = envStash.stash[env];
        const keepPrevious = !stashHasSetup(entry) && stashHasSetup(previous);
        const kept = keepPrevious ? previous : entry;
        patch.env_stash = { ...envStash.stash, [env]: kept };
        stashSaved = stashSummary(kept);
        const target = envStash.stash[next];
        if (stashHasSetup(target)) {
          restoreEntry = target as Record<string, unknown>;
          restorePlan = stashRestorePlan(target, { region, pulled: opts.extraPatch });
          Object.assign(patch, restorePlan.ids);
        }
      }
      if (opts.extraPatch) Object.assign(patch, opts.extraPatch);
      const merchantWritten = next !== env ? (String(patch.merchant_account ?? '').trim() || null) : merchantWas;
      let { error: envErr, warning: regionWarning } = await upsertAccountRow(patch, 'location_id, environment');
      let stashWarning = envStash.warning;
      if (envErr && 'env_stash' in patch && isUnknownColumnError(envErr, 'env_stash')) {
        // The column went between the read and the write: flip without the
        // stash, as before the migration, and say so.
        delete patch.env_stash;
        stashSaved = null;
        ({ error: envErr, warning: regionWarning } = await upsertAccountRow(patch, 'location_id, environment'));
        stashWarning = envStashMissingMessage();
      }
      if (envErr) {
        const hint = /environment|42703|does not exist/i.test(envErr.message)
          ? ' (apply supabase/migrations/20260907_PLATFORM_adyen_environment.sql to the platform DB first)' : '';
        return { ok: false, status: 500, body: { ok: false, error: `environment write failed: ${envErr.message}${hint}` } };
      }
      if (provisionedOnCurrent && readers > 0) {
        // The platform registry rows point at readers boarded to the old
        // environment. Retire them here (location_id is NOT NULL, so the row
        // keeps its venue); the ops terminal_devices link rows stay until
        // `assign` re-registers each reader on the new environment, which
        // updates both rows in place, or the stash puts them back on a
        // switch back.
        const { error: pdErr } = await platformAdmin.from('payment_devices')
          .update({ status: 'retired' })
          .eq('location_id', loc.id).eq('processor', 'adyen');
        if (pdErr) console.error('[adyen-terminal-admin] reader registry clear failed:', pdErr.message);
      }
      if (provisionedOnCurrent) {
        // The OPS link rows carried the old environment's POIIDs too, and
        // adyen-terminal-charge dispatches to whatever POIID a paired row
        // holds. Clear the POIID (keep the row, its till binding and its
        // device identity) so a till answers terminal_not_linked until
        // `assign` re-adopts the reader on the new environment, instead of
        // sending a live payment to a test POIID (8 Sep 2026).
        const { error: tdErr } = await opsAdmin.from('terminal_devices')
          .update({ adyen_terminal_id: null })
          .eq('location_id', opsLocationId).eq('status', 'paired').not('adyen_terminal_id', 'is', null);
        if (tdErr) console.error('[adyen-terminal-admin] ops terminal link clear failed:', tdErr.message);
      }
      // The readers the venue had on the environment it arrives on come
      // back AFTER the clear above (the two sets are different POIIDs, or
      // the same physical reader re-boarded, and the clear must not undo
      // the restore).
      let restored: RestoreAnswer | null = null;
      if (restorePlan && restoreEntry) {
        const readerAnswer = restorePlan.skipped ? { platform: 0, ops: 0, skipped: [] as string[] } : await restoreReaders(restorePlan.readers);
        const skipped = [restorePlan.skipped, restorePlan.idsSkipped, ...readerAnswer.skipped].filter((t): t is string => !!t);
        restored = {
          environment: next,
          stashed_at: String(restoreEntry.stashed_at ?? '').trim() || null,
          store_id: typeof restorePlan.ids.store_id === 'string' ? restorePlan.ids.store_id : null,
          ids: Object.keys(restorePlan.ids),
          readers: { platform: readerAnswer.platform, ops: readerAnswer.ops },
          skipped,
        };
      }
      const warnings: string[] = [];
      if (regionWarning) warnings.push(regionWarning);
      if (stashWarning) warnings.push(stashWarning);
      if (next === 'live' && !liveReady) {
        warnings.push(`Live keys for the ${region} account are not fully configured (${liveMissing.join(', ')}): this venue will refuse every card call until they are set.`);
      }
      if (provisionedOnCurrent) {
        if (stashSaved) {
          warnings.push(opts.extraPatch
            ? `Store and reader setup from the ${env} system was set aside and replaced with the ids pulled from Adyen. It is kept and comes back if the venue switches back to ${env}.`
            : `Store and reader setup from the ${env} system was set aside. It is kept and comes back if the venue switches back to ${env}.`);
        } else {
          warnings.push(opts.extraPatch
            ? `Store and reader setup from the ${env} system was cleared and replaced with the ids pulled from Adyen. Register the readers again on ${next}.`
            : `Store and reader setup from the ${env} system was cleared. Run store setup and register the readers again on ${next}.`);
        }
      }
      if (restored?.skipped.length) warnings.push(...restored.skipped);
      if (next !== env && merchantWritten !== merchantWas) {
        warnings.push(merchantWritten
          ? `The merchant account was switched to the ${region} ${next} account (${merchantWritten})${merchantWas ? `, replacing ${merchantWas}` : ''}.`
          : `No ${region} ${next} merchant account is configured on the server; the venue's merchant account was cleared.`);
      }
      console.log(`[adyen-terminal-admin] ${caller.id} set environment=${next} for ${loc.id} (${region}, was ${env}${provisionedOnCurrent ? ', reprovision' : ''}${opts.extraPatch ? ', via adyen_link' : ''}${stashSaved ? `, kept ${env} setup` : ''}${restored ? `, restored ${next} setup (${restored.ids.length} ids, ${restored.readers.ops} ops readers, ${restored.readers.platform} registry rows)` : ''})`);
      // Going live: the ServOS hosts go on the live credential's allowed
      // origins and the venue's storefront on the merchant's Apple Pay
      // domains, so the Drop-in and Apple Pay work on the new account
      // without a Customer Area visit (8 Sep 2026). BEST EFFORT: a refusal
      // rides in the answer as web_origins / apple_pay_domains, it never
      // fails the flip (the admin portal's button runs both again).
      let webOrigins: RegistrationAnswer | null = null;
      let applePayDomains: RegistrationAnswer | null = null;
      if (opts.registrations && next === 'live' && next !== env) {
        if (!liveReady) {
          const error = `Skipped: live keys for the ${region} account are not fully configured (${liveMissing.join(', ')}).`;
          webOrigins = { ok: false, skipped: true, error };
          applePayDomains = { ok: false, skipped: true, error };
        } else {
          const liveMerchant = merchantWritten || liveCfg.merchantAccount;
          // A venue arriving on live has a live store only when the stash
          // just put one back (a store id on the row belonged to the test
          // account and was cleared above); with none the merchant level
          // Apple Pay entry is the only sensible target. The admin portal's
          // button, which passes the row's store id, covers the store
          // scoped case once the live store exists.
          const liveStoreId: string | null = restored?.store_id ?? null;
          ({ webOrigins, applePayDomains } = await runRegistrations(liveCfg, liveMerchant, liveStoreId));
        }
        console.log(`[adyen-terminal-admin] ${caller.id} go live registrations for ${loc.id}: origins ${webOrigins?.ok ? 'ok' : 'refused'}, apple pay ${applePayDomains?.ok ? 'ok' : 'refused'}`);
      }
      return { ok: true, reprovisioned: provisionedOnCurrent, merchantNext: merchantWritten, warnings, webOrigins, applePayDomains, stashSaved, restored, keepsSetup: envStash.available };
    };

    if (action === 'set_environment') {
      if (!isServosAdmin) return adminOnly();
      const raw = String(body.environment ?? '').trim().toLowerCase();
      if (raw !== 'test' && raw !== 'live') return json({ error: "environment must be 'test' or 'live'" }, 400);
      const next = normalizeAdyenEnv(raw);
      const flip = await flipEnvironment(next, { reprovision: body.reprovision === true, registrations: true });
      if (!flip.ok) return json(flip.body, flip.status);
      return json({
        ok: true, environment: next, region, previous: env, liveConfigured: liveReady, liveRegionsConfigured: liveRegions,
        reprovisioned: flip.reprovisioned, warning: flip.warnings.join(' ') || null,
        web_origins: flip.webOrigins, apple_pay_domains: flip.applePayDomains,
        // The kept setup (8 Sep 2026): what this switch put aside, what it
        // put back, and whether keeping works at all (the platform column).
        stash_saved: flip.stashSaved, restored: flip.restored, keeps_setup: flip.keepsSetup,
      });
    }

    // ── register_origins: the ServOS hosts and wildcards on the credential ──
    // super_admin only. /me is credential scoped, so the VENUE's config (its
    // environment and its region set) picks the key whose origins change: a
    // test venue registers on the test credential. body.region overrides the
    // region set only (register on the US credential before a venue moves).
    // Answers 200 with ok false and the detail when Adyen refuses, so the
    // admin portal lists every line; the outer catch answers 500 only for a
    // live venue without live keys (fail closed) or a thrown DB error.
    if (action === 'register_origins') {
      if (!isServosAdmin) return adminOnly();
      const rawRegion = String(body.region ?? '').trim();
      const wantRegion = rawRegion ? parseAdyenRegion(rawRegion) : null;
      if (rawRegion && !wantRegion) return json({ error: "region must be 'UK' or 'US'" }, 400);
      const originCfg = wantRegion && wantRegion !== region ? adyenConfig(env, wantRegion) : cfg;
      const storefront = await storefrontFor(loc.id);
      const r = await registerWebOrigins(originCfg, storefront.customDomain);
      console.log(`[adyen-terminal-admin] ${caller.id} register_origins for ${loc.id} on ${originCfg.region} ${originCfg.env}: added ${(r.added as string[] | undefined)?.length ?? 0}, existing ${(r.existing as string[] | undefined)?.length ?? 0}, failed ${(r.failed as unknown[] | undefined)?.length ?? 0}${r.error ? ` (${r.error})` : ''}`);
      return json({ action, ...r });
    }

    // ── adyen_lookup and adyen_link: PULL BY REFERENCE (OWNER RULES, 8 Sep 2026) ──
    // super_admin only. The venue's REGION set on the target environment:
    // LIVE by default (the owner links live venues), the test set only when
    // the venue is still on test and asks for it (resolveLinkEnvironment).
    // The merchant account is that set's; the row's name wins on the same
    // environment, as everywhere else. Refused outright when the set is not
    // configured: nothing could be pulled.
    //   adyen_lookup { reference?, storeId?, accountHolderId?, environment? }
    //     read only. { found, store, balanceAccount, accountHolder,
    //     legalEntity, splitConfigurationId, businessLineIds, candidates,
    //     errors, notes, patch, plan }: patch and plan say what a link would
    //     write and do against the row as it is now.
    //   adyen_link { reference?, storeId?, accountHolderId?, environment?, relink? }
    //     the lookup, then ONE write: through flipEnvironment when the venue
    //     moves environments (its rules, its clearing, its merchant rewrite,
    //     the pulled ids on the same upsert), a plain upsert otherwise; then
    //     origins and Apple Pay best effort with the store id it now holds.
    //     Idempotent: the same ids again is a no op. 409 needs_relink when a
    //     stored id would be replaced, or setup on the current environment
    //     would be cleared, until relink: true.
    if (action === 'adyen_lookup' || action === 'adyen_link') {
      if (!isServosAdmin) return adminOnly();
      const linkEnv = resolveLinkEnvironment(env, body.environment);
      const linkCfg = linkEnv === 'live' ? liveCfg : testCfg;
      const linkMissing = [...linkCfg.missing];
      const merchantSecret = adyenSecretName(linkEnv, 'merchantAccount', region);
      if (!linkCfg.merchantAccount && !linkMissing.includes(merchantSecret)) linkMissing.push(merchantSecret);
      if (linkMissing.length) {
        return json({
          ok: false, environment: linkEnv, region, missing: linkMissing,
          error: `The ${region} ${linkEnv} Adyen set is not configured on the server (missing ${linkMissing.join(', ')}), so nothing can be pulled from Adyen for this venue.`,
        }, 400);
      }
      const merchant = effectiveMerchantAccount(linkCfg, linkEnv === env ? maa?.merchant_account : null);
      const storeId = String(body.storeId ?? body.store_id ?? '').trim() || null;
      const accountHolderId = String(body.accountHolderId ?? body.account_holder_id ?? '').trim() || null;
      if (storeId && !/^ST[0-9A-Z]{10,}$/i.test(storeId)) return json({ error: 'storeId does not look like an Adyen store id (ST...)' }, 400);
      if (accountHolderId && !/^AH[0-9A-Z]{10,}$/i.test(accountHolderId)) return json({ error: 'accountHolderId does not look like an Adyen account holder id (AH...)' }, 400);
      const venueCode = await venueCodeFor(opsLocationId);
      const reference = String(body.reference ?? '').trim().slice(0, 50) || venueCode;
      const linkCurrency = region === 'US' ? 'USD' : 'GBP';
      const lookup = await lookupByReference(linkCfg, merchant, reference, { storeId, accountHolderId, currency: linkCurrency });
      const patch = lookup.found ? buildLinkPatch(lookup, { merchantAccount: merchant, region, environment: linkEnv }) : null;
      const confirm = body.relink === true || body.reprovision === true;
      // storeStatus feeds the refusal wording for a store that is not
      // active (the decision itself reads patch.receive_payments_ok).
      const plan = patch ? planLink({ row: maa, currentEnv: env, targetEnv: linkEnv, patch, provisioned, readers, relink: confirm, storeStatus: lookup.store?.status ?? null }) : null;
      const summary = lookupSummary(lookup);
      const errors = Array.isArray(lookup.errors) ? lookup.errors : [];
      // provisioned and readers ride along so the admin portal's confirm can
      // say exactly what a flip sets aside (the store ids, N card readers);
      // keepsSetup and stashes say whether it is kept and what a flip puts
      // back (the env_stash column, 8 Sep 2026).
      const envStash = await getEnvStash();
      const base = {
        action, environment: linkEnv, previous: env, region, merchantAccount: merchant, venueCode, reference, summary, lookup, patch, plan, provisioned, readers,
        keepsSetup: envStash.available, stashes: stashSummaries(envStash), stashWarning: envStash.warning,
      };

      if (action === 'adyen_lookup') {
        logLink('lookup', loc.id, { environment: linkEnv, region, merchant, reference, storeId, found: lookup.found, summary, errors, candidates: Array.isArray(lookup.candidates) ? lookup.candidates.length : 0, plan: plan?.kind ?? null });
        console.log(`[adyen-terminal-admin] ${caller.id} adyen_lookup ${reference ?? '(no reference)'} for ${loc.id} on ${merchant} (${region} ${linkEnv}): ${lookup.found ? 'found' : 'not found'}${errors.length ? ` (${errors.length} error${errors.length === 1 ? '' : 's'})` : ''}`);
        return json({ ok: true, ...base });
      }

      // adyen_link
      if (!lookup.found || !patch || !plan) {
        logLink('link_not_found', loc.id, { environment: linkEnv, region, merchant, reference, storeId, summary, errors });
        return json({ ok: false, error: summary, ...base }, 200);
      }
      if (plan.kind === 'noop') {
        return json({ ok: true, unchanged: true, message: plan.reason, ...base, row: maa ?? null, reprovisioned: false, web_origins: null, apple_pay_domains: null, warnings: [], warning: null, stash_saved: null, restored: null });
      }
      if (plan.kind === 'refuse') {
        return json({ ok: false, needs_relink: true, error: plan.reason, ...base }, 409);
      }
      const warnings: string[] = [];
      let reprovisioned = false;
      let stashSaved: ReturnType<typeof stashSummary> = null;
      let restored: Record<string, unknown> | null = null;
      if (plan.kind === 'flip') {
        // The environment changes: set_environment's rules, clearing and
        // merchant rewrite, with the pulled ids on the same upsert. The
        // plan already required relink for setup on the current
        // environment, so reprovision is given here. The outgoing setup is
        // kept and the target environment's stash comes back under the
        // pulled ids (flipEnvironment).
        const flip = await flipEnvironment(linkEnv, { reprovision: true, extraPatch: patch, registrations: false });
        if (!flip.ok) return json({ ...flip.body, ...base }, flip.status);
        reprovisioned = flip.reprovisioned;
        stashSaved = flip.stashSaved;
        restored = flip.restored;
        warnings.push(...flip.warnings);
      } else {
        // Same environment. A CONFIRMED replacement (conflicts, relink
        // given) clears every id the chain did not reach, the payout flag,
        // the snapshot and the hosted onboarding link, so the OLD account
        // holder's bank account never survives under the NEW balance
        // account (8 Sep 2026). Filling blanks on a first link clears nothing.
        const clear = plan.diff.conflicts.length ? replacementClear(patch) : {};
        const { error: linkErr, warning: regionWarning } = await upsertAccountRow({ location_id: loc.id, ...clear, ...patch, updated_at: new Date().toISOString() }, 'location_id');
        if (linkErr) return json({ ok: false, error: `link write failed: ${linkErr.message}`, ...base }, 500);
        if (regionWarning) warnings.push(regionWarning);
        if (plan.diff.conflicts.length) {
          const cleared = Object.keys(clear).filter((k) => k !== 'onboarding_link_url' && k !== 'onboarding_link_expires_at');
          if (cleared.length) warnings.push(`The previous ids were replaced; the pieces the lookup did not reach were cleared (${cleared.join(', ')}).`);
        }
      }
      if (errors.length) warnings.push(`Linked with gaps, ${errors.length === 1 ? 'this piece' : 'these pieces'} could not be read: ${errors.join(' ')}`);
      // Origins and Apple Pay on the linked set, best effort, with the store
      // id the row now holds (a store scoped Apple Pay entry is preferred).
      let webOrigins: RegistrationAnswer | null = null;
      let applePayDomains: RegistrationAnswer | null = null;
      if (linkEnv === 'live' && !liveReady) {
        const error = `Skipped: live keys for the ${region} account are not fully configured (${liveMissing.join(', ')}).`;
        webOrigins = { ok: false, skipped: true, error };
        applePayDomains = { ok: false, skipped: true, error };
      } else {
        ({ webOrigins, applePayDomains } = await runRegistrations(linkCfg, merchant, String(patch.store_id ?? '').trim() || null));
      }
      // The same whitelist payments-admin adyen_accounts answers: never the
      // hosted onboarding link (a bearer style URL) or a future secret column.
      const { data: after, error: afterErr } = await platformAdmin.from('merchant_adyen_accounts')
        .select('location_id, region, environment, merchant_account, store_id, account_holder_id, balance_account_id, legal_entity_id, split_profile_id, transfer_instrument_id, business_line_id, receive_payments_ok, payouts_ok, verification_status, updated_at')
        .eq('location_id', loc.id).maybeSingle();
      if (afterErr) warnings.push(`The row was written but could not be read back: ${afterErr.message}`);
      const ids = Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'verification_status'));
      logLink('link', loc.id, { environment: linkEnv, previous: env, region, merchant, reference, storeId, plan: plan.kind, diff: plan.diff, ids, reprovisioned, stashSaved, restored, errors, warnings, origins: webOrigins?.ok ?? null, applePay: applePayDomains?.ok ?? null });
      console.log(`[adyen-terminal-admin] ${caller.id} adyen_link ${reference ?? '(by id)'} for ${loc.id} on ${merchant} (${region} ${linkEnv}, was ${env}): ${plan.kind}, changed ${plan.diff.changed.join(', ') || 'nothing'}; origins ${webOrigins?.ok ? 'ok' : 'refused'}, apple pay ${applePayDomains?.ok ? 'ok' : 'refused'}`);
      return json({
        ok: true, ...base, reprovisioned, row: after ?? null,
        web_origins: webOrigins, apple_pay_domains: applePayDomains,
        warnings, warning: warnings.join(' ') || null,
        stash_saved: stashSaved, restored,
      });
    }

    // The row's name wins, unless it names the OTHER environment's secret
    // account (a row flipped before set_environment rewrote it).
    const merchant = effectiveMerchantAccount(cfg, maa?.merchant_account);
    if (!merchant) return json({ error: `no merchant account configured for card payments (${adyenSecretName(cfg.env, 'merchantAccount', cfg.region)})` }, 500);

    // ── register_apple_pay_domains: the venue's storefront hosts on the merchant ──
    // super_admin only. The venue's config and merchant account (the row's
    // name, or the region set's) pick the Apple Pay payment method; the
    // venue's store id prefers a store scoped entry when the merchant has
    // one. Answers 200 with ok false and a plain message when Apple Pay is
    // not requested or approved yet, or the venue has no slug.
    if (action === 'register_apple_pay_domains') {
      if (!isServosAdmin) return adminOnly();
      const storefront = await storefrontFor(loc.id);
      const r = await registerApplePayDomains(cfg, merchant, (maa?.store_id as string | undefined) ?? null, storefront);
      console.log(`[adyen-terminal-admin] ${caller.id} register_apple_pay_domains for ${loc.id} on ${merchant} (${cfg.region} ${cfg.env}): added ${(r.added as string[] | undefined)?.length ?? 0}, existing ${(r.existing as string[] | undefined)?.length ?? 0}, failed ${(r.failed as unknown[] | undefined)?.length ?? 0}${r.error ? ` (${r.error})` : ''}`);
      return json({ action, ...r });
    }

    // ── status: everything the panel needs to decide what to show ────────────
    if (action === 'status') {
      const probe = await mgmt(cfg, 'GET', `/merchants/${merchant}/stores?pageSize=1`);
      // v5.6.96 — THE structural probe for per-venue balances (Financial services
      // build): does this venue's STORE carry a splitConfiguration, and does that
      // point at a PER-VENUE balance account or the platform's liable account?
      // Research: balances/payouts per venue exist ONLY if a per-venue balance
      // account exists; a store alone routes payments and nothing else. Fired
      // from the venue panel's normal status load (it sends probe: true) and
      // logged durably so no extra clicks are needed to answer it. The admin
      // portal's per venue cards call status too, so the probe is opt in:
      // without the flag a page view writes no rows and makes no extra
      // Management call per venue.
      if (maa?.store_id && body.probe === true) {
        mgmt(cfg, 'GET', `/stores/${encodeURIComponent(maa.store_id)}`).then((sr) => {
          void platformAdmin.from('adyen_webhook_events').insert({
            event_key: `probe:store:${maa.store_id}:${Date.now()}`,
            raw: { httpStatus: sr.status, store: sr.data ?? null },
          }).then(() => {}, () => {});
        }).catch(() => {});
      }
      // The venue's postal address, for the admin portal's store form (the
      // platform row's address is often empty; the ops one is what the venue
      // types in Back Office, Venue settings). Read with the service role so
      // the admin portal needs no ops RLS of its own. Prefill only.
      let venueAddress: string | null = null;
      try {
        const { data: opsLoc } = await opsAdmin.from('locations').select('address').eq('id', opsLocationId).maybeSingle();
        venueAddress = opsLoc?.address ? String(opsLoc.address) : null;
      } catch { /* prefill only */ }
      return json({
        ok: true,
        venue: loc.name,
        venueAddress,
        processor: loc.payment_processor || 'stripe',
        merchant,
        environment: cfg.env,
        region: cfg.region,
        dropinEnvironment: cfg.dropinEnvironment,
        liveConfigured: liveReady,
        liveRegionsConfigured: liveRegions,
        storeId: maa?.store_id || null,
        receivePaymentsOk: maa?.receive_payments_ok ?? null,
        scopeOk: !scopeMissing(probe.status),
        scopeError: scopeMissing(probe.status)
          ? `Adyen refused the Management API call (${probe.status}) for merchant ${merchant} on ${cfg.env} (${cfg.region}). Either the API credential behind ${adyenSecretName(cfg.env, 'apiKey', cfg.region)} lacks the Management roles (Stores, Terminals, Terminal settings, Payment methods; set ${adyenSecretName(cfg.env, 'managementKey', cfg.region)} to a credential that has them) or that merchant account does not exist on ${cfg.env} (${cfg.region}).`
          : null,
      });
    }

    // The venue's market for payment methods, the store, gratuities and
    // standalone payments follows its REGION (8 Sep 2026): US => USD and US,
    // UK => GBP and GB. Platform locations carries no country column; its
    // currency only fed the region when the row had none (adyenEnvForLocation).
    const venueCurrency: string = region === 'US' ? 'USD' : 'GBP';
    const venueCountry: string = region === 'US' ? 'US' : 'GB';
    const market = { currency: venueCurrency, country: venueCountry };

    // ── ensure_store: the venue's physical store at Adyen + our mapping row ──
    // ADMIN (OWNER RULE): the store is created by ServOS, never by the venue.
    // REFERENCE FIRST (8 Sep 2026): the venue code (or body.reference) is
    // the store reference, and a store that already carries it on the
    // merchant (created by FranPOS, by Adyen, or by an earlier run whose
    // mapping write failed) is MAPPED, never created twice. Only when none
    // exists is one created, with that reference.
    // adyen_create_store_by_reference is the same action with the reference
    // required: it refuses when the venue has no venue code.
    if (action === 'ensure_store' || action === 'adyen_create_store_by_reference') {
      if (!isServosAdmin) return adminOnly();
      // The TARGET account (8 Sep 2026): adyen_create_store_by_reference
      // creates on the account adyen_lookup looked on (resolveLinkEnvironment:
      // live by default, test only while the venue is on test and asks),
      // never on the venue's current environment by accident. Before this a
      // test venue whose LIVE lookup found nothing was offered "Create store
      // with reference SV-1007" and the store landed on the TEST merchant
      // (or, worse, its test store id came back as "existing"). Plain
      // ensure_store keeps the venue's own environment and merchant.
      const byReference = action === 'adyen_create_store_by_reference';
      const storeEnv = byReference ? resolveLinkEnvironment(env, body.environment) : env;
      const crossEnv = storeEnv !== env;
      const storeCfg = crossEnv ? (storeEnv === 'live' ? liveCfg : testCfg) : cfg;
      if (crossEnv) {
        const storeMissing = [...storeCfg.missing];
        const storeMerchantSecret = adyenSecretName(storeEnv, 'merchantAccount', region);
        if (!storeCfg.merchantAccount && !storeMissing.includes(storeMerchantSecret)) storeMissing.push(storeMerchantSecret);
        if (storeMissing.length) {
          return json({
            ok: false, environment: storeEnv, region, missing: storeMissing,
            error: `The ${region} ${storeEnv} Adyen set is not configured on the server (missing ${storeMissing.join(', ')}), so no store can be created there.`,
          }, 200);
        }
      }
      const storeMerchant = crossEnv ? effectiveMerchantAccount(storeCfg, null) : merchant;
      // The mapped store belongs to the venue's CURRENT environment, so it
      // only answers "existing" on that environment: a test venue asking
      // for its live store is never handed its test store id.
      if (maa?.store_id && !crossEnv) return json({ ok: true, storeId: maa.store_id, existing: true, foundByReference: false, mapped: true, environment: env, region });
      // Across environments the row is NOT written: a live store id on a
      // test row would be a mixed identity (and would count as test setup
      // for the next flip). The store is found or created on the target
      // account and adyen_link, whose lookup now finds it, maps it while it
      // moves the venue there.
      const crossHint = `The store is on the ${region} ${storeEnv} account; the venue stays on ${env}. Link to Adyen now: the ${storeEnv} lookup finds it and the link moves the venue with its ids.`;
      const venueCode = await venueCodeFor(opsLocationId);
      const reference = String(body.reference ?? '').trim().slice(0, 50) || venueCode;
      if (byReference && !reference) {
        return json({ ok: false, error: 'This venue has no venue code, so there is no store reference to create with. Set one in the Back Office (Venue settings) or pass reference.' }, 200);
      }
      if (reference) {
        const found = await findStoreByReference(storeCfg, storeMerchant, reference);
        if (found.scopeMissing) return json({ ok: false, error: 'scope_missing', detail: found.errors.join(' ') }, 200);
        if (found.ambiguous) {
          return json({
            ok: false,
            error: `${found.matches.length} stores on ${storeMerchant} carry the reference ${reference}. Link one of them with adyen_link and its storeId instead of creating another.`,
            candidates: storeCandidates(found.matches, reference),
          }, 200);
        }
        if (found.store) {
          const s = storeSummary(found.store)!;
          let mapWarning: string | null = null;
          if (!crossEnv) {
            // The mapping names what Adyen holds for the store: its id, and
            // its split configuration and balance account when it carries
            // them. adyen_link pulls the account holder and legal entity too.
            const mapping: Record<string, unknown> = { location_id: loc.id, merchant_account: storeMerchant, store_id: s.id, receive_payments_ok: s.status === 'active', region };
            if (s.splitConfigurationId) mapping.split_profile_id = s.splitConfigurationId;
            if (s.balanceAccountId) mapping.balance_account_id = s.balanceAccountId;
            const { error: mapErr, warning } = await upsertAccountRow(mapping);
            if (mapErr) return json({ ok: false, error: `store ${s.id} found by reference but mapping write failed: ${mapErr.message}` }, 500);
            mapWarning = warning;
          }
          logLink('store_found_by_reference', loc.id, { environment: storeCfg.env, region, merchant: storeMerchant, reference, storeId: s.id, status: s.status, mapped: !crossEnv });
          console.log(`[adyen-terminal-admin] ${caller.id} ${action} ${crossEnv ? 'found' : 'mapped existing'} store ${s.id} (reference ${reference}) for ${loc.id} on ${storeMerchant} (${region} ${storeCfg.env})`);
          return json({
            ok: true, storeId: s.id, existing: true, foundByReference: true, mapped: !crossEnv, reference: s.reference, store: s,
            environment: storeCfg.env, region, warning: mapWarning,
            hint: crossEnv ? crossHint : s.status === 'active' ? 'Run adyen_link to pull the balance account, account holder and legal entity too.' : `The store is ${s.status ?? 'not active'} at Adyen.`,
          });
        }
        if (found.errors.length) return json({ ok: false, error: found.errors.join(' ') }, 200);
      }
      const a = (body.address || {}) as Record<string, string>;
      const phone = String(body.phone || '').replace(/[^\d+]/g, '');
      // The store is the record Adyen keeps for the venue (compliance,
      // receipts, terminal settings). On TEST a placeholder address is fine;
      // on LIVE the real address and phone are required (8 Sep 2026: the
      // panel used to create live stores at "1 High Street, London" with a
      // made up phone number).
      if (storeCfg.live && (!a.line1 || !a.city || !a.postal_code || !phone)) {
        return json({ ok: false, error: 'A live store needs the venue address (street, town, postcode) and a phone number.' }, 200);
      }
      const payload: Record<string, unknown> = {
        description: String(body.description || loc.name || 'ServOS venue').slice(0, 100),
        shopperStatement: String(body.shopper_statement || loc.name || 'ServOS').replace(/[^a-zA-Z0-9 .,'-]/g, '').slice(0, 22) || 'ServOS',
        phoneNumber: phone || '+441234567890',
        address: {
          country: String(a.country || venueCountry),
          line1: String(a.line1 || '1 High Street'),
          city: String(a.city || 'London'),
          postalCode: String(a.postal_code || 'EC1A 1AA'),
        },
      };
      // The venue's short code as the store reference: the pull by
      // reference actions and adyen-onboard list_stores match a store to
      // its venue on it.
      if (reference) payload.reference = reference;
      const r = await mgmt(storeCfg, 'POST', `/merchants/${storeMerchant}/stores`, payload);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: (r.data as Record<string, unknown>)?.detail || (r.data as Record<string, unknown>)?.title || `store create failed (${r.status})` }, 200);
      const storeId = String((r.data as Record<string, unknown>).id || '');
      let regionWarning: string | null = null;
      if (!crossEnv) {
        // The row names the region the store was created on ('UK' | 'US'; a
        // legacy 'EU' row is rewritten to 'UK'). upsertAccountRow retries a
        // 'UK' the old check refuses and reports the migration as a warning:
        // the store exists at Adyen, so the mapping must land either way.
        const mapping: Record<string, unknown> = { location_id: loc.id, merchant_account: storeMerchant, store_id: storeId, receive_payments_ok: true, region };
        const { error: upErr, warning } = await upsertAccountRow(mapping);
        if (upErr) return json({ ok: false, error: `store created (${storeId}) but mapping write failed: ${upErr.message}` }, 500);
        regionWarning = warning;
      }
      const pm = await ensurePaymentMethods(storeCfg, storeMerchant, storeId, market);
      logLink('store_created', loc.id, { environment: storeCfg.env, region, merchant: storeMerchant, reference, storeId, mapped: !crossEnv });
      console.log(`[adyen-terminal-admin] ${caller.id} ${action} created store ${storeId} (reference ${reference ?? '(none)'}) for ${loc.id} on ${storeMerchant} (${region} ${storeCfg.env}${crossEnv ? ', not mapped' : ''})`);
      return json({
        ok: true, storeId, existing: false, foundByReference: false, mapped: !crossEnv, paymentMethods: pm,
        environment: storeCfg.env, region, reference, warning: regionWarning, hint: crossEnv ? crossHint : null,
      });
    }

    // Everything below needs the store mapping.
    if (!maa?.store_id) return json({ ok: false, error: 'no_store', hint: 'Run ensure_store first — the venue has no payments store yet.' }, 200);

    // ── ensure_payment_methods: repair a store missing its card schemes ──────
    // ADMIN (OWNER RULE): changes the venue's store at Adyen.
    if (action === 'ensure_payment_methods') {
      if (!isServosAdmin) return adminOnly();
      const pm = await ensurePaymentMethods(cfg, merchant, maa.store_id as string, market);
      return json({ ok: pm.errors.length === 0, ...pm });
    }

    // ── list: merchant fleet split store vs inventory, joined to our links ───
    if (action === 'list') {
      const r = await mgmt<{ data?: Record<string, unknown>[] }>(cfg, 'GET', `/terminals?merchantIds=${encodeURIComponent(merchant)}&pageSize=100`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: `terminal list failed (${r.status})` }, 200);
      const { data: links } = await opsAdmin.from('terminal_devices')
        .select('id, label, adyen_terminal_id, bound_pos_device_id, status, last_seen_at, tip_config, modes, idle_screen')
        .eq('location_id', opsLocationId).not('adyen_terminal_id', 'is', null).neq('status', 'retired');
      const linkBy = new Map((links || []).map((l) => [String(l.adyen_terminal_id), l]));
      const rows = (r.data.data || []).map((t) => {
        const asn = (t.assignment || {}) as Record<string, unknown>;
        return {
          id: t.id, model: t.model, serialNumber: t.serialNumber,
          firmwareVersion: t.firmwareVersion || null,
          lastActivityAt: t.lastActivityAt || null,
          onStore: asn.storeId === maa.store_id,
          assignmentStatus: asn.status || null,
          link: linkBy.get(String(t.id)) || null,
        };
      });
      // v5.6.81 — app terminals waiting for a POIID: a paired terminal_devices row
      // at this venue that a DEVICE owns (self-registered by our MPOS wrapper on an
      // Adyen Android terminal, then claimed by code) and that no POIID is on yet.
      // The panel offers these when registering, so the link lands on the row the
      // physical device can actually authenticate as. See 'assign' → adopt.
      const { data: appTerms } = await opsAdmin.from('terminal_devices')
        .select('id, label, serial_number, last_seen_at, app_version')
        .eq('location_id', opsLocationId).eq('status', 'paired').eq('active', true)
        .is('adyen_terminal_id', null).is('ryft_terminal_id', null)
        .order('last_seen_at', { ascending: false }).limit(20);

      return json({
        ok: true,
        store: rows.filter((x) => x.onStore),
        inventory: rows.filter((x) => !x.onStore),
        appTerminals: appTerms ?? [],
      });
    }

    // ── find_by_serial: locate a boxed reader anywhere the credential sees ───
    // A fresh reader boards to COMPANY inventory, which the merchant-filtered
    // list can't show. The operator types the serial off the box label; this
    // searches credential-wide and returns candidates for assign.
    if (action === 'find_by_serial') {
      const serial = String(body.serial || '').replace(/[^a-zA-Z0-9]/g, '');
      if (serial.length < 6) return json({ ok: false, error: 'Type the full serial number from the label on the reader (or its box).' }, 200);
      const r = await mgmt<{ data?: Record<string, unknown>[] }>(cfg, 'GET', `/terminals?searchQuery=${encodeURIComponent(serial)}&pageSize=20`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: `search failed (${r.status})` }, 200);
      const matches = (r.data.data || []).map((t) => {
        const asn = (t.assignment || {}) as Record<string, unknown>;
        return {
          id: t.id, model: t.model, serialNumber: t.serialNumber,
          firmwareVersion: t.firmwareVersion || null, lastActivityAt: t.lastActivityAt || null,
          onStore: asn.storeId === maa.store_id,
          assignmentStatus: asn.status || null,
        };
      });
      return json({ ok: true, matches });
    }

    // ── assign: board onto the venue store + both link rows ──────────────────
    if (action === 'assign') {
      const terminalId = String(body.terminal_id || '');
      if (!terminalId) return json({ error: 'terminal_id required' }, 400);
      const label = String(body.label || '').slice(0, 60) || terminalId;

      // 1. Adyen-side: put the terminal on the venue's store (no-op if already there).
      const re = await mgmt(cfg, 'POST', `/terminals/${encodeURIComponent(terminalId)}/reassign`, { storeId: maa.store_id });
      if (scopeMissing(re.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      // 409/422 "already assigned" is fine — anything else refuses loudly.
      if (!re.ok && re.status !== 409 && re.status !== 422) {
        return json({ ok: false, error: (re.data as Record<string, unknown>)?.detail || `reassign failed (${re.status})` }, 200);
      }

      const serial = terminalId.includes('-') ? terminalId.split('-').slice(1).join('-') : terminalId;

      // 2. Platform registry row (billing/fleet visibility) — keyed on the POIID.
      const { data: pdExisting } = await platformAdmin.from('payment_devices')
        .select('id').eq('adyen_terminal_id', terminalId).maybeSingle();
      if (pdExisting) {
        await platformAdmin.from('payment_devices')
          .update({ location_id: loc.id, label, status: 'online', processor: 'adyen' })
          .eq('id', pdExisting.id);
      } else {
        const { error: pdErr } = await platformAdmin.from('payment_devices').insert({
          location_id: loc.id, processor: 'adyen', adyen_terminal_id: terminalId,
          serial_number: serial, label, connection_kind: 'network', device_type: String(terminalId.split('-')[0] || 'AMS1'), status: 'online',
        });
        if (pdErr) return json({ ok: false, error: `platform registry write failed: ${pdErr.message}` }, 500);
      }

      // 3. Ops link row — what the charge path, till binding and the POS status
      // drawer all read. AMS1 has no on-device app, so no claim code: the row
      // is born 'paired'. device_uid is NOT NULL default auth.uid(), which is
      // NULL under service-role — synthesize one.
      //
      // ── v5.6.81: ADOPT AN APP TERMINAL'S OWN ROW RATHER THAN MINTING A RIVAL ──
      //
      // An S1F2L (or S1E2L / S1E4 Pro) running our MPOS wrapper is not an AMS1: it
      // DOES have an on-device app, it self-registers via register_terminal_device,
      // and a manager claims it by code in Back Office → Card readers. That row
      // carries the DEVICE'S OWN device_uid, which is the identity every on-device
      // path depends on — _terminal_for_caller, terminal_jobs' SELECT policy and
      // adyen-terminal-charge's target-terminal fence all resolve through it.
      //
      // The synthesized-device_uid row below can never serve that device: keyed on
      // the POIID with a random uid, it would leave the physical terminal holding a
      // paired row with NO POIID (so prepare_local answers 'terminal_not_linked')
      // beside a POIID row it cannot authenticate as. Two rows, one machine, and no
      // working payment. So: if this venue already has a claimed app-terminal row
      // waiting for a POIID, put the POIID on THAT row.
      //
      // Matched either explicitly (`terminal_device_id`, chosen by the operator from
      // the picker in AdyenTerminals) or automatically by hardware serial — which
      // only lines up when Build.getSerial() returned the real one, hence the picker.
      const adoptId = String(body.terminal_device_id || '');
      let adopt: { id: string } | null = null;
      if (adoptId) {
        const { data: cand } = await opsAdmin.from('terminal_devices')
          .select('id, location_id, status, active')
          .eq('id', adoptId).maybeSingle();
        // Venue-fenced: an id from the client can only ever name a row at the venue
        // this caller already proved access to.
        if (!cand || cand.location_id !== opsLocationId || cand.status !== 'paired' || cand.active !== true) {
          return json({ ok: false, error: 'That paired terminal is not at this venue (or is no longer active).' }, 200);
        }
        adopt = { id: cand.id };
      } else {
        const { data: bySerial } = await opsAdmin.from('terminal_devices')
          .select('id').eq('location_id', opsLocationId).eq('serial_number', serial)
          .eq('status', 'paired').eq('active', true).is('adyen_terminal_id', null).maybeSingle();
        if (bySerial) adopt = { id: bySerial.id };
      }

      if (adopt) {
        // Free idx_td_adyen (unique POIID among paired rows) before writing it here.
        // Scoped to this venue: a serial/POIID collision must never let one tenant
        // retire another's terminal.
        await opsAdmin.from('terminal_devices')
          .update({ status: 'retired', active: false })
          .eq('adyen_terminal_id', terminalId).eq('location_id', opsLocationId).neq('id', adopt.id);
        const { error: adErr } = await opsAdmin.from('terminal_devices')
          .update({
            adyen_terminal_id: terminalId, label, location_id: opsLocationId,
            status: 'paired', active: true, claimed_at: new Date().toISOString(),
          })
          .eq('id', adopt.id);
        if (adErr) return json({ ok: false, error: `terminal link write failed: ${adErr.message}` }, 500);
        console.log(`[adyen-terminal-admin] adopted app-terminal row ${adopt.id} for POIID ${terminalId} (${adoptId ? 'operator-chosen' : 'serial match'})`);
        return json({ ok: true, terminalDeviceId: adopt.id, poiid: terminalId, adopted: true });
      }

      const { data: tdExisting } = await opsAdmin.from('terminal_devices')
        .select('id, status').eq('adyen_terminal_id', terminalId).maybeSingle();
      let terminalDeviceId: string;
      if (tdExisting) {
        await opsAdmin.from('terminal_devices')
          .update({ location_id: opsLocationId, label, status: 'paired', active: true, claimed_at: new Date().toISOString() })
          .eq('id', tdExisting.id);
        terminalDeviceId = tdExisting.id;
      } else {
        const { data: td, error: tdErr } = await opsAdmin.from('terminal_devices').insert({
          device_uid: crypto.randomUUID(),
          serial_number: serial,
          location_id: opsLocationId,
          label,
          status: 'paired',
          active: true,
          claimed_at: new Date().toISOString(),
          adyen_terminal_id: terminalId,
        }).select('id').maybeSingle();
        if (tdErr || !td) return json({ ok: false, error: `terminal link write failed: ${tdErr?.message || 'no row'}` }, 500);
        terminalDeviceId = td.id;
      }
      return json({ ok: true, terminalDeviceId, poiid: terminalId });
    }

    // ── sync_gratuities: BO tipping percentages → the reader's tip screen ────
    if (action === 'sync_gratuities') {
      // Adyen's gratuity presets take WHOLE percentages only — "12.5%" is
      // rejected as an invalid JSON value (hit live 14 Aug). Round + dedupe.
      const pcts = [...new Set((Array.isArray(body.percentages) ? body.percentages : [5, 10, 15])
        .map((n: unknown) => Math.round(Number(n)))
        .filter((n: number) => Number.isFinite(n) && n > 0 && n <= 100))].slice(0, 4);
      const gratuities = [{
        currency: market.currency,   // the venue's region: GBP for UK, USD for US
        usePredefinedTipEntries: true,
        predefinedTipEntries: pcts.map((n: number) => `${n}%`),
        allowCustomAmount: body.allow_custom !== false,
      }];
      const r = await mgmt(cfg, 'PATCH', `/stores/${maa.store_id}/terminalSettings`, { gratuities });
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: (r.data as Record<string, unknown>)?.detail || `gratuities update failed (${r.status})` }, 200);
      return json({ ok: true, presets: pcts });
    }

    // ── standalone (manual payments ON the reader): per-terminal setting ─────
    // Staff type the amount on the reader itself — Adyen books it against the
    // store and it arrives via the webhook; it does NOT attach to a POS check.
    if (action === 'standalone_get') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const r = await mgmt<Record<string, unknown>>(cfg, 'GET', `/terminals/${encodeURIComponent(tid)}/terminalSettings`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      const st = (r.data?.standalone || {}) as Record<string, unknown>;
      return json({ ok: true, enabled: st.enableStandalone === true });
    }
    if (action === 'standalone_set') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const r = await mgmt(cfg, 'PATCH', `/terminals/${encodeURIComponent(tid)}/terminalSettings`, {
        standalone: { enableStandalone: body.enabled === true, currencyCode: market.currency },
      });
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: (r.data as Record<string, unknown>)?.detail || `standalone update failed (${r.status})` }, 200);
      return json({ ok: true, enabled: body.enabled === true });
    }

    // ── settings_probe: raw store terminalSettings groups (shape discovery) ──
    if (action === 'settings_probe') {
      const r = await mgmt<Record<string, unknown>>(cfg, 'GET', `/stores/${maa.store_id}/terminalSettings`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      const d = r.data || {};
      return json({ ok: true, keys: Object.keys(d), nexo: d.nexo ?? null, payAtTable: d.payAtTable ?? null, standalone: d.standalone ?? null, gratuities: d.gratuities ?? null });
    }

    // ── set_pay_at_table: enable the reader's own Pay-at-table journey ───────
    if (action === 'set_pay_at_table') {
      const r = await mgmt(cfg, 'PATCH', `/stores/${maa.store_id}/terminalSettings`, {
        payAtTable: { enablePayAtTable: body.enabled !== false, paymentInstrument: 'Card' },
      });
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: (r.data as Record<string, unknown>)?.detail || `payAtTable update failed (${r.status})` }, 200);
      return json({ ok: true });
    }

    // ── set_event_url_terminal: same, but at TERMINAL level (firmware quirk) ─
    if (action === 'set_event_url_terminal') {
      const tid = String(body.terminal_id || '');
      const url = String(body.url || '');
      if (!tid || !/^https:\/\//.test(url)) return json({ error: 'terminal_id + https url required' }, 400);
      const r = await mgmt(cfg, 'PATCH', `/terminals/${encodeURIComponent(tid)}/terminalSettings`, {
        nexo: { eventUrls: { eventLocalUrls: [], eventPublicUrls: [{ url }] } },
      });
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: JSON.stringify(r.data).slice(0, 300) }, 200);
      return json({ ok: true });
    }

    // ── set_event_url: point terminal event notifications at our endpoint ────
    // Docs: eventPublicUrls objects carry EXPLICIT username/password fields
    // (basic auth) — never credentials inside the url string.
    if (action === 'set_event_url') {
      const url = String(body.url || '');
      if (!/^https:\/\//.test(url)) return json({ error: 'https url required' }, 400);
      const entry: Record<string, unknown> = { url };
      if (body.username) entry.username = String(body.username);
      if (body.password) entry.password = String(body.password);
      const r = await mgmt(cfg, 'PATCH', `/stores/${maa.store_id}/terminalSettings`, {
        nexo: { eventUrls: { eventLocalUrls: [], eventPublicUrls: [entry] } },
      });
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: JSON.stringify(r.data).slice(0, 300) }, 200);
      return json({ ok: true });
    }

    // ── test_menu: render the pay-at-table MENU on a reader right now ────────
    // Drives the exact nexo Input message the responder sends, with the venue's
    // real open tables — the hardware shape-test without a button press.
    if (action === 'test_menu') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const { data: term } = await opsAdmin.from('terminal_devices')
        .select('id, location_id').eq('adyen_terminal_id', tid).eq('status', 'paired').maybeSingle();
      if (!term) return json({ error: 'terminal not linked' }, 404);
      const [{ data: sess }, { data: floor }] = await Promise.all([
        opsAdmin.from('active_sessions').select('table_id, total_minor').eq('location_id', term.location_id),
        opsAdmin.from('floor_tables').select('id, label').eq('location_id', term.location_id),
      ]);
      const billBy = new Map((sess || []).map((r) => [String(r.table_id), Number(r.total_minor) || 0]));
      const entries = (floor || [])
        .filter((f) => billBy.has(String(f.id)))
        .sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }))
        .slice(0, 20)
        .map((f) => `${f.label}  ·  ${currencySymbol(market.currency)}${((billBy.get(String(f.id)) || 0) / 100).toFixed(2)}`);
      if (!entries.length) entries.push('No open tables');
      const menu = buildMenuInputRequest({
        poiid: tid, saleId: 'servos-menutest', serviceId: newServiceId(),
        title: 'Pay at table — choose the table', entries,
      });
      const r = await adyenFetch('POST', terminalEndpoint(merchant, tid, 'sync', cfg.region, cfg), menu, { cfg, timeoutMs: 75_000 });
      return json({ ok: r.ok, status: r.status, entries, response: r.data }, 200);
    }

    // ── test_amount: render the split AMOUNT-ENTRY screen on a reader now ────
    // Hardware shape-test for the DecimalString Input (split payments, task
    // #103) — returns the raw response so the parsed amount can be verified
    // without running the whole pay-at-table flow.
    if (action === 'test_amount') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const msg = buildAmountInputRequest({
        poiid: tid, saleId: 'servos-amttest', serviceId: newServiceId(),
        title: 'Split — enter amount to pay',
      });
      const r = await adyenFetch('POST', terminalEndpoint(merchant, tid, 'sync', cfg.region, cfg), msg, { cfg, timeoutMs: 75_000 });
      return json({ ok: r.ok, status: r.status, parsed: parseAmountInputResponse(r.data), response: r.data }, 200);
    }

    // ── logos_get: does Adyen even acknowledge a standby logo for this model? ─
    // The /terminalLogos model enum in the docs lists S1F2 but neither AMS1 nor
    // S1F2L. Ground truth per terminal, not per docs.
    if (action === 'logos_get') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const r = await mgmt<Record<string, unknown>>(cfg, 'GET', `/terminals/${encodeURIComponent(tid)}/terminalLogos`);
      const d = r.data as Record<string, unknown>;
      return json({
        ok: r.ok, status: r.status,
        // never echo half a megabyte of base64 back to the browser
        hasLogo: !!d?.data, logoChars: d?.data ? String(d.data).length : 0,
        raw: d?.data ? { ...d, data: undefined } : d,
      });
    }

    // ── test_image: push the ServOS logo as a FULL-SCREEN held display ───────
    // Docs: MessageRef + ReferenceID 'Image', base64 in OutputText, no
    // MinimumDisplayTime => the image holds until the next request. The
    // screensaver-by-push experiment: if this lands and holds, idle branding on
    // Adyen-software readers is a solved problem.
    if (action === 'test_image') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const imgUrl = String(body.image_url || 'https://tbetcegmszzotrwdtqhi.supabase.co/storage/v1/object/public/receipt-assets/branding/servos-logo-primary-dark.png');
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) return json({ error: `image fetch failed: ${imgRes.status}` }, 502);
      const buf = new Uint8Array(await imgRes.arrayBuffer());
      if (buf.length > 400_000) return json({ error: `image too large (${buf.length} bytes; docs cap ~512KB, stay under 400KB)` }, 400);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      const b64img = btoa(bin);
      // First press (19 Aug, S1F2L fw 1.133.3): object-form DisplayOutput came
      // back HTTP 200 with an EMPTY DisplayResponse — acknowledged, rendered
      // nothing. The nexo spec makes DisplayRequest.DisplayOutput an ARRAY;
      // Adyen's docs sample shows an object. Try both in one press and record
      // both answers, so one tap settles the shape question per model.
      const rendered = (d: unknown) =>
        !!(d as Record<string, any>)?.SaleToPOIResponse?.DisplayResponse?.OutputResult;
      const ep = terminalEndpoint(merchant, tid, 'sync', cfg.region, cfg);
      const objMsg = buildDisplayImageRequest({ poiid: tid, saleId: 'servos-brand', serviceId: newServiceId(), imageB64: b64img });
      const arrMsg = buildDisplayImageRequest({ poiid: tid, saleId: 'servos-brand', serviceId: newServiceId(), imageB64: b64img });
      (arrMsg.SaleToPOIRequest.DisplayRequest as Record<string, unknown>).DisplayOutput =
        [ (arrMsg.SaleToPOIRequest.DisplayRequest as Record<string, any>).DisplayOutput ];
      const rArr = await adyenFetch('POST', ep, arrMsg, { cfg, timeoutMs: 30_000 });
      let rObj: { ok: boolean; status: number; data: unknown } | null = null;
      if (!rendered(rArr.data)) {
        rObj = await adyenFetch('POST', ep, objMsg, { cfg, timeoutMs: 30_000 });
      }
      const winner = rendered(rArr.data) ? 'array' : rendered(rObj?.data) ? 'object' : 'neither';
      void platformAdmin.from('adyen_webhook_events').insert({
        event_key: `brand:${tid}:${Date.now()}`,
        raw: { action: 'test_image', winner, imageBytes: buf.length,
               arrayForm: { httpStatus: rArr.status, response: rArr.data ?? null },
               objectForm: rObj ? { httpStatus: rObj.status, response: rObj.data ?? null } : 'skipped (array rendered)' },
      }).then(() => {}, () => {});
      return json({ ok: winner !== 'neither', status: rArr.status, imageBytes: buf.length, winner,
                    response: winner === 'neither' ? { arrayForm: rArr.data, objectForm: rObj?.data } : undefined });
    }

    // ── test_idle: force the terminal back to its own standby screen ─────────
    if (action === 'test_idle') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const msg = buildDisplayIdleRequest({ poiid: tid, saleId: 'servos-brand', serviceId: newServiceId() });
      // Hardware truth (19 Aug): this fleet renders Display messages only in the
      // nexo ARRAY form — object-form (the docs sample) is acknowledged with an
      // empty DisplayResponse and ignored, which left the reader stuck on the
      // pushed image with 'Back to idle' doing nothing.
      (msg.SaleToPOIRequest.DisplayRequest as Record<string, unknown>).DisplayOutput =
        [ (msg.SaleToPOIRequest.DisplayRequest as Record<string, any>).DisplayOutput ];
      const r = await adyenFetch('POST', terminalEndpoint(merchant, tid, 'sync', cfg.region, cfg), msg, { cfg, timeoutMs: 30_000 });
      void platformAdmin.from('adyen_webhook_events').insert({
        event_key: `brand:${tid}:${Date.now()}`,
        raw: { action: 'test_idle', httpStatus: r.status, response: r.data ?? null },
      }).then(() => {}, () => {});
      return json({ ok: r.ok, status: r.status, response: r.data });
    }

    // ── test_async: prove the event-URL delivery pipe WITHOUT a button press ─
    // An /async TransactionStatusRequest's response is delivered by Adyen's
    // BACKEND to the configured event URLs — if it arrives, the pipe works and
    // only the notification button is in question; if not, the pipe itself is
    // the problem (support territory).
    if (action === 'test_async') {
      const tid = String(body.terminal_id || '');
      if (!tid) return json({ error: 'terminal_id required' }, 400);
      const msg = {
        SaleToPOIRequest: {
          MessageHeader: {
            ProtocolVersion: '3.0', MessageClass: 'Service', MessageCategory: 'TransactionStatus', MessageType: 'Request',
            ServiceID: crypto.randomUUID().replace(/-/g, '').slice(0, 10), SaleID: 'servos-pipe-test', POIID: tid,
          },
          TransactionStatusRequest: {
            MessageReference: { MessageCategory: 'Payment', SaleID: 'servos-pipe-test', ServiceID: 'pipetest001' },
          },
        },
      };
      // The venue's device host (cfg.deviceBase: test default device-api-test,
      // live default terminal-api-live, or the explicit *_DEVICE_BASE override)
      // and its key. Never the test host for a live venue.
      const res = await adyenFetch('POST', terminalEndpoint(merchant, tid, 'async', cfg.region, cfg), msg, { cfg, timeoutMs: 30_000 });
      return json({ ok: res.ok, status: res.status, body: JSON.stringify(res.data ?? null).slice(0, 300) });
    }

    // ── set_wakeup_button: the reader's own "Pay at table" menu button ───────
    // nexo.notification puts a button in the reader's menu; pressing it fires
    // an EventNotification (category rides in the payload) at our event URL —
    // the responder answers with an input prompt + the table's bill.
    if (action === 'set_wakeup_button') {
      const r = await mgmt(cfg, 'PATCH', `/stores/${maa.store_id}/terminalSettings`, {
        nexo: { notification: {
          enabled: body.enabled !== false,
          showButton: true,
          title: String(body.title || 'Pay at table').slice(0, 40),
          category: 'SaleWakeUp',
          // EMPTY details = no reference pin pad — the button fires straight
          // away and the responder answers with the open-tables MENU (list-first,
          // the Lightspeed flow Peter wants). Pass details explicitly to bring
          // the number pad back as a fast path.
          details: String(body.details ?? '').slice(0, 60),
        } },
      });
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: JSON.stringify(r.data).slice(0, 300) }, 200);
      return json({ ok: true });
    }

    // ── passcodes: the reader's on-device admin menu PIN (store-level) ───────
    if (action === 'passcodes') {
      const r = await mgmt<Record<string, unknown>>(cfg, 'GET', `/merchants/${merchant}/terminalSettings`);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      const sr = await mgmt<Record<string, unknown>>(cfg, 'GET', `/stores/${maa.store_id}/terminalSettings`);
      const merchantPass = (r.data?.passcodes || {}) as Record<string, unknown>;
      const storePass = (sr.data?.passcodes || {}) as Record<string, unknown>;
      // Set a known admin PIN at store level if none exists anywhere. On a
      // LIVE store the PIN must be chosen, never the 1111 default.
      if (cfg.live && body.set_default && !body.pin) return json({ ok: false, error: 'On live choose the admin PIN yourself (pass pin); 1111 is not set on a live store.' }, 200);
      if (!storePass.adminMenuPin && !merchantPass.adminMenuPin && body.set_default) {
        const pin = String(body.pin || '1111');
        const up = await mgmt(cfg, 'PATCH', `/stores/${maa.store_id}/terminalSettings`, { passcodes: { adminMenuPin: pin } });
        if (up.ok) return json({ ok: true, adminMenuPin: pin, source: 'set_now' });
        return json({ ok: false, error: (up.data as Record<string, unknown>)?.detail || `passcode set failed (${up.status})` }, 200);
      }
      return json({
        ok: true,
        adminMenuPin: storePass.adminMenuPin || merchantPass.adminMenuPin || null,
        refundPin: storePass.refundPin || merchantPass.refundPin || null,
        source: storePass.adminMenuPin ? 'store' : merchantPass.adminMenuPin ? 'merchant' : 'unset',
      });
    }

    // ── unlink: retire our link; the terminal stays boarded at Adyen ─────────
    if (action === 'unlink') {
      const tdId = String(body.terminal_device_id || '');
      if (!tdId) return json({ error: 'terminal_device_id required' }, 400);
      const { error } = await opsAdmin.from('terminal_devices')
        .update({ status: 'retired', active: false })
        .eq('id', tdId).eq('location_id', opsLocationId);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[adyen-terminal-admin]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
