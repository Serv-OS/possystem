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
//                  environments the row is not written, adyen_link maps it.
//                  Takes an optional merchantAccount (create it on the
//                  account the store belongs on, not the one the secret
//                  names) and, when the venue's row already holds a balance
//                  account, JOINS the new store to it so the chain completes
//   adyen_merchants → ADMIN. { } the merchant accounts each configured
//                  credential can see, with code, name, status and a store
//                  count, plus the secret that names the configured one. The
//                  live account has more than one and the portal could not
//                  show it (8 Sep 2026)
//   golive_state → ADMIN. { locationId } ONE call the go live wizard renders:
//                  { venue, keys, holder, balanceAccount, legalEntity,
//                    capabilities, store, merchantConfigured,
//                    merchantMismatch, readers, origins, applePay, row,
//                    rates, payouts,
//                    steps: [{ id, state, detail, action, hint, parts? }] }.
//                  The six steps (find_venue, business_account,
//                  payments_location, go_live, payouts, readers) are
//                  computed on the SERVER so the screen assembles nothing
//                  and decides nothing (OWNER FEEDBACK, 8 Sep 2026: "far too
//                  many words and too small ... a flow that supports someone
//                  doing this"). Also answers balancePlatformKnown (is the
//                  reference search automatic on this account yet) and
//                  holderFoundBy ('pasted' | 'reference' | 'store'). Read
//                  only for the VENUE bar ONE flag: payouts_ok is kept in
//                  step with what it read (PAYOUTS AND COMMISSION below);
//                  it does keep what it learns about OUR Adyen account
//                  (FINDING A VENUE BY ITS REFERENCE below)
//   set_split    → ADMIN. { environment? } and NO numbers (10 Sep 2026)
//                  step 5a: the venue's RATE CARD on its store, ONE RULE PER
//                  PAYMENT TYPE from the same card the ledger charges
//                  (resolveAdyenRateCard: venue card, else platform default).
//                  A body carrying percent or fixedPence is refused (400):
//                  rates are set per payment type in Processing. A tier with
//                  no price refuses in plain words naming the tiers. The row
//                  is written only after Adyen accepted the profile and the
//                  store PATCH, and NEVER the legacy markup columns
//   set_balance_platform → ADMIN. { balancePlatformId, environment? } the
//                  balance platform id for the venue's region, once
//                  (FranPOS_UK or a BP id), checked with GET /balancePlatforms/{id}
//                  and kept in adyen_platform_settings, so every venue after
//                  it is found by its code with nothing pasted
//   onboarding_link → ADMIN. step 5b: a hosted onboarding link for the
//                  venue's legal entity (the venue adds its bank account and
//                  finishes identity checks there). Works ONCE, for 4 MINUTES
//   setup_sweep  → ADMIN. step 5b: the daily push of the full balance to the
//                  venue's bank, once Adyen allows payouts and the bank is
//                  there. One sweep, repointed rather than doubled. Writes
//                  payouts_ok (the capability) and payout_sweep_id (the
//                  sweep, PAID OUT)
//   request_payouts → ADMIN. step 5b: ask Adyen for the payout capability
//                  on a holder that was never asked for it
//   The three step 5 writes and request_payouts act on the venue's OWN
//   environment: a body.environment naming the other one is refused.
//
// PAYOUTS AND COMMISSION (9 Sep 2026, docs.adyen.com): a split configuration
// profile PATCHed onto the store is enough on its own (no request carries
// split instructions), and with NO profile "the whole transaction amount and
// fees are booked to your liable balance account", which is exactly the live
// Provo case: store ST32DDL22322BQ5PXJVN95JSM carried no split configuration
// so nothing reached BA32C5F22322CJ5PXF2BD7FKK. The commission always goes
// to OUR liable account, so the rule needs no liable account id. Paying out
// needs a bank account on the legal entity (hosted onboarding), the
// sendToTransferInstrument capability allowed, then a daily push sweep.
// payouts_ok on the row is the CAPABILITY (Adyen allows payouts, what the
// webhook and the venue's Card payments screen mean); payout_sweep_id is
// PAID OUT (the sweep exists), and the list chip reads the two together. The
// shape work is in _shared/adyenLink.ts, the writes in
// _shared/adyenPayouts.ts (shared with adyen-onboard).
//
// FINDING A VENUE BY ITS REFERENCE, BY ITSELF (8 Sep 2026, docs checked that
// day): the Balance Platform Configuration API has NO filter by reference, and
// the only account holder listing is under a balance platform id,
//   GET /balancePlatforms/{id}/accountHolders?limit=100&offset=N   max 100 a page
//   https://docs.adyen.com/api-explorer/balanceplatform/2/get/balancePlatforms/_id_/accountHolders
// while GET /accountHolders/{id} answers the holder INCLUDING its
// balancePlatform. So the FIRST venue on an Adyen account is linked by pasting
// its account holder id once; every action that reads an account holder
// (adyen_lookup, adyen_link, golive_state) keeps the balancePlatform it saw in
// the platform table adyen_platform_settings, keyed by environment and region,
// and from then on EVERY VENUE IS FOUND BY ITS REFERENCE with nothing typed.
// adyen_merchants keeps the merchant account codes it lists on the same row, so
// the account picker draws with no live call. Those are ids, not secrets, which
// is why they live in a table. The table (and the venue row's own
// balance_platform_id) arrive with
// supabase/migrations/20260908c_PLATFORM_adyen_platform_settings.sql: until it
// runs, every read skips it with a warning naming the file and the flow works
// as before, one paste per venue.
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
  resolveAdyenRateCard, RATE_TIERS,
  type AdyenConfig, type AdyenEnv, type TierRate,
} from '../_shared/adyen.ts';
import {
  buildWebOrigins, buildStorefrontDomains, originsPlan, applePayDomainsPlan, pickApplePayMethod, hasApplePayEntries,
  applePayStatusNote, adyenRefusalMessage, isDuplicateRefusal,
} from '../_shared/adyenOrigins.ts';
import {
  referenceKey, storeRows, matchStoreByReference, storeSummary, storeCandidates, accountHolderSummary, balanceAccountSummary,
  legalEntitySummary, pickBalanceAccount, resolveLinkEnvironment, buildLinkPatch, planLink, relinkClear, lookupSummary,
  stashReaders, buildEnvStashEntry, stashHasSetup, stashSummary, stashRestorePlan,
  merchantRows, merchantSummary, accountHolderRows, matchAccountHolderByReference, accountHolderCandidates,
  pickBusinessLine, merchantMismatch, storeStillNeeded, balancePlatformSecretName, balancePlatformSecretNames,
  capabilityList, blockedCapabilityNames, buildGoliveSteps, goliveProblems,
  summariseCapabilities, findPushSweep, pickPayoutInstrument, PAYOUT_CAPABILITY,
  buildTieredProfile, tieredCommissionRules, tiersFromResolved, unpricedTiers, tierListWords, rateCardLine, ratesOnAdyen,
  liableBalanceAccountSecretName, liableBalanceAccountSecretNames, ADYEN_LIABLE_BALANCE_ACCOUNT_COLUMN,
  ADYEN_PLATFORM_SETTINGS_TABLE, ADYEN_ROW_BALANCE_PLATFORM_COLUMN,
  platformSettingsKey, platformSettingsPatch, platformSettingsMissingMessage,
  learnedBalancePlatform, isUnknownRelationError, merchantAccountsSeen,
  type StoreSummary, type BalanceAccountSummary, type AccountHolderSummary, type LookupResult, type StashReader, type StashRestorePlan,
  type MerchantSummary, type MerchantMismatch, type AccountHolderCandidate, type CapabilityRow, type GoliveStep, type GoliveReader,
  type PlatformSettingsLearned,
} from '../_shared/adyenLink.ts';
import { createSplitOnStore, ensurePushSweep, type AdyenApi } from '../_shared/adyenPayouts.ts';

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
async function adyenHostCall<T = Record<string, unknown>>(cfg: AdyenConfig, base: string, apiKey: string, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<HostAnswer<T>> {
  assertAdyenConfigured(cfg);
  let res: Response;
  const headers: Record<string, string> = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
  // A create that must never happen twice (the sweep) carries Adyen's
  // Idempotency-Key, the same way adyen-onboard sends it.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
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
const bcl = <T = Record<string, unknown>>(cfg: AdyenConfig, method: string, path: string, body?: unknown, idempotencyKey?: string) => adyenHostCall<T>(cfg, balancePlatformBase(cfg), cfg.bpKey, method, path, body, idempotencyKey);
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

// ── FIND THE VENUE HOWEVER ADYEN HOLDS IT (8 Sep 2026, LIVE FINDING) ─────────
// The store first chain above assumed the venue code is a STORE reference. On
// the live account it is not: SV-1007 is the ACCOUNT HOLDER reference
// (AH32BZP22322CJ5PXF2BD5FTR, legal entity POINT OF SALE UNIFIED PARTNERS
// LIMITED, Active, one capability Blocked), the store search on
// FranPOS_QSR_UK (the value of ADYEN_LIVE_UK_MERCHANT_ACCOUNT) answered 0
// stores, and Adyen's own row for that account holder names a DIFFERENT
// merchant account, FranPOS_UK. So a lookup runs TWO routes in parallel and
// merges them, and a store on another merchant is REPORTED, never used
// silently.
//
// Every endpoint below was confirmed against docs.adyen.com and the Adyen
// OpenAPI specs on 8 Sep 2026:
//   Management API v3 (cfg.managementKey)
//     GET /stores?reference=X&pageSize=&pageNumber=          credential wide, merchantId optional
//        https://docs.adyen.com/api-explorer/Management/3/get/stores
//     GET /merchants?pageSize=&pageNumber=                   role "Account read"
//        https://docs.adyen.com/api-explorer/Management/3/get/merchants
//     GET /merchants/{m}/stores?reference=X                  per merchant, role "Stores read"
//        https://docs.adyen.com/api-explorer/Management/3/get/merchants/_merchantId_/stores
//     PATCH /merchants/{m}/stores/{storeId}                  splitConfiguration { balanceAccountId, splitConfigurationId }
//        https://docs.adyen.com/api-explorer/Management/3/patch/merchants/_merchantId_/stores/_storeId_
//        https://docs.adyen.com/platforms/automatic-split-configuration/create-split-configuration
//     GET /merchants/{m}/splitConfigurations                 the merchant's split profiles
//        https://docs.adyen.com/api-explorer/Management/3/get/merchants/_merchantId_/splitConfigurations
//   Balance Platform Configuration API v2 (cfg.bpKey)
//     GET /balancePlatforms/{id}/accountHolders?limit=&offset=   THE ONLY listing; max 100 a page
//        https://docs.adyen.com/api-explorer/balanceplatform/2/get/balancePlatforms/_id_/accountHolders
//     GET /accountHolders/{id}                               reference, status, capabilities, legalEntityId, balancePlatform
//        https://docs.adyen.com/api-explorer/balanceplatform/2/get/accountHolders/_id_
//     GET /accountHolders/{id}/balanceAccounts?limit=&offset=
//        https://docs.adyen.com/api-explorer/balanceplatform/2/get/accountHolders/_id_/balanceAccounts
//   Legal Entity Management API v4 (cfg.lemKey)
//     GET /legalEntities/{id}/businessLines                  { businessLines: [{ id, service }] }
//        https://docs.adyen.com/api-explorer/legalentity/4/get/legalEntities/_id_/businessLines
// There is NO GET /accountHolders list and NO reference filter anywhere on the
// Balance Platform API, so the balance platform id is the only way into the
// holder listing. It is taken, in this order, from a pasted balancePlatform,
// from the secret balancePlatformSecretName names, from OUR OWN KEPT SETTINGS
// (adyen_platform_settings for this environment and region, learned the first
// time any account holder on this account was read), then from the venue's own
// row (its account holder, or its balance account's account holder). Only the
// last two cost an Adyen call, and the kept settings are why they almost never
// run: the FIRST venue is linked by pasting its account holder id, that read
// hands us the balance platform id, and EVERY VENUE AFTER IT IS FOUND BY ITS
// REFERENCE on its own (8 Sep 2026). With none of those, the answer says the
// id is needed instead of guessing.
// An account holder names NO merchant account and NO store (the Adyen schema
// carries balancePlatform, reference, status, capabilities, legalEntityId and
// primaryBalanceAccount, nothing else), so the merchant a venue charges on can
// only come from its store or from the admin.
const MERCHANT_PAGE_SIZE = 100;
const MERCHANT_PAGES = 5;         // 500 merchant accounts on one credential
const MERCHANT_SWEEP_MAX = 25;    // store searches one lookup will run
const HOLDER_PAGE_SIZE = 100;     // the Balance Platform maximum
// 2000 account holders on one balance platform. Deliberately NOT deeper: the
// whole listing runs inside golive_state, which the panel calls on mount and
// again after every action, and for a venue that is not on Adyen yet it runs
// to the cap every time, sequentially, each page a round trip bounded by
// MGMT_TIMEOUT_MS. The store sweep below was made opt in for the same reason.
// A listing that stops here says so (`capped`), it never reports an absence.
const HOLDER_PAGES = 20;

interface MerchantListAnswer { merchants: Dict[]; errors: string[]; scopeMissing: boolean; capped: boolean }

// Every merchant account the credential can see, paged. A refusal is a line,
// never a throw: the sweep is a best effort extra route.
async function listMerchants(cfg: AdyenConfig): Promise<MerchantListAnswer> {
  const merchants: Dict[] = [];
  const errors: string[] = [];
  let capped = false;
  for (let page = 1; page <= MERCHANT_PAGES; page++) {
    const r = await mgmt<{ data?: unknown[]; pagesTotal?: unknown; _links?: { next?: unknown } }>(cfg, 'GET', `/merchants?pageSize=${MERCHANT_PAGE_SIZE}&pageNumber=${page}`);
    if (!r.ok) {
      errors.push(`merchant list: ${refusalText(cfg, r, 'managementKey', 'the Management API role "Account read"')}`);
      return { merchants, errors, scopeMissing: scopeMissing(r.status), capped };
    }
    const rows = merchantRows(r.data);
    merchants.push(...rows);
    const pagesTotal = Number(r.data?.pagesTotal);
    const more = rows.length > 0 && ((Number.isFinite(pagesTotal) && pagesTotal > page) || !!r.data?._links?.next);
    if (!more) break;
    if (page === MERCHANT_PAGES) capped = true;
  }
  return { merchants, errors, scopeMissing: false, capped };
}

// How many stores a merchant account holds (itemsTotal on a one row page).
// Null when Adyen refused: the count is decoration, never a decision.
async function storeCountFor(cfg: AdyenConfig, merchant: string): Promise<number | null> {
  const r = await mgmt<{ itemsTotal?: unknown }>(cfg, 'GET', `/merchants/${encodeURIComponent(merchant)}/stores?pageSize=1&pageNumber=1`);
  if (!r.ok) return null;
  const n = Number(r.data?.itemsTotal);
  return Number.isFinite(n) ? n : null;
}

// EVERY merchant account the credential can see, with a store count each
// (adyen_merchants, 8 Sep 2026, OWNER RULE 5). The live account has more than
// one (FranPOS_QSR_UK, the value of ADYEN_LIVE_UK_MERCHANT_ACCOUNT, and
// FranPOS_UK, which is where the venue's store actually lives), and nobody
// could see that from the portal. Counts are decoration: a refused count is
// null, never an error.
//   GET /v3/merchants                       role "Account read"
//   GET /v3/merchants/{m}/stores?pageSize=1 role "Stores read", itemsTotal
const MERCHANT_COUNT_MAX = 25;   // store counts one answer will fetch

async function merchantsWithStoreCounts(cfg: AdyenConfig): Promise<{ merchants: Array<MerchantSummary & { storeCount: number | null }>; errors: string[]; scopeMissing: boolean; capped: boolean }> {
  const list = await listMerchants(cfg);
  const rows = list.merchants.map(merchantSummary).filter((m): m is MerchantSummary => !!m && !!m.id);
  const counted = rows.slice(0, MERCHANT_COUNT_MAX);
  const counts = await Promise.all(counted.map((m) => storeCountFor(cfg, m.id as string)));
  const merchants = rows.map((m, i) => ({ ...m, storeCount: i < counted.length ? counts[i] : null }));
  return { merchants, errors: list.errors, scopeMissing: list.scopeMissing, capped: list.capped || rows.length > counted.length };
}

// The credential wide store search: GET /stores?reference=X, whose merchantId
// filter is optional, so it can answer stores from every merchant account the
// credential can see in one call. Paged the same way as the per merchant list.
async function listStoresAnywhere(cfg: AdyenConfig, reference: string): Promise<StoreListAnswer> {
  const rows: Dict[] = [];
  const errors: string[] = [];
  for (let page = 1; page <= STORE_PAGES; page++) {
    const r = await mgmt<{ data?: unknown[]; pagesTotal?: unknown; _links?: { next?: unknown } }>(cfg, 'GET', `/stores?reference=${encodeURIComponent(reference)}&pageSize=${STORE_PAGE_SIZE}&pageNumber=${page}`);
    if (!r.ok) {
      errors.push(`store search across merchant accounts: ${refusalText(cfg, r, 'managementKey', 'the Management API role "Stores read"')}`);
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

interface StoreSweep extends StoreSearch { merchantsSearched: string[]; notes: string[] }

// The store, wherever it lives: the configured merchant account first (the
// filtered list, then its whole list so the admin gets candidates), then the
// credential wide search, then merchant by merchant. The sweep only runs when
// the configured account has no match, which is exactly the live case.
async function findStoreAnywhere(cfg: AdyenConfig, merchant: string, reference: string): Promise<StoreSweep> {
  const searched: string[] = [];
  const notes: string[] = [];
  const own = await findStoreByReference(cfg, merchant, reference);
  searched.push(merchant);
  if (own.scopeMissing || own.matches.length) return { ...own, merchantsSearched: searched, notes };

  const rows: Dict[] = [...own.rows];
  const errors: string[] = [...own.errors];
  const anywhere = await listStoresAnywhere(cfg, reference);
  errors.push(...anywhere.errors);
  rows.push(...anywhere.rows);
  let found = matchStoreByReference(rows, reference);
  if (found.matches.length) {
    notes.push(`No store on ${merchant} carries the reference ${reference}; it was found by searching every merchant account this credential can see.`);
    return { ...found, rows, errors, scopeMissing: false, merchantsSearched: searched, notes };
  }

  // Merchant by merchant: the credential wide call may be scoped down on some
  // credentials, so the sweep the owner asked for is run in full.
  const list = await listMerchants(cfg);
  errors.push(...list.errors);
  const others = list.merchants
    .map((m) => String(m.id ?? '').trim())
    .filter((id) => id && id.toLowerCase() !== merchant.toLowerCase());
  const sweep = others.slice(0, MERCHANT_SWEEP_MAX);
  if (others.length > sweep.length) notes.push(`Only the first ${sweep.length} of ${others.length} other merchant accounts were searched. Pass merchantAccount to search one directly.`);
  for (const other of sweep) {
    const r = await listStores(cfg, other, `reference=${encodeURIComponent(reference)}&`);
    searched.push(other);
    if (r.scopeMissing) { errors.push(...r.errors); break; }
    errors.push(...r.errors);
    rows.push(...r.rows);
  }
  found = matchStoreByReference(rows, reference);
  if (found.matches.length) notes.push(`The store with the reference ${reference} was found by sweeping ${searched.length} merchant account${searched.length === 1 ? '' : 's'}, not on ${merchant}.`);
  return { ...found, rows, errors, scopeMissing: false, merchantsSearched: searched, notes };
}

interface HolderSearch {
  holder: Dict | null;
  candidates: AccountHolderCandidate[];
  balancePlatform: string | null;
  balancePlatformSource: string | null;
  needsBalancePlatform: boolean;
  // HOW the holder we ended up with was reached: 'pasted' (an AH id was
  // given), 'reference' (the listing matched the venue code with nothing
  // pasted, which is the automatic route every venue after the first takes),
  // or null (no holder on this route).
  foundBy: 'pasted' | 'reference' | null;
  // TRUE when the listing stopped at HOLDER_PAGES with more still to read, so
  // "nothing carries this reference" is not something this read established.
  capped: boolean;
  errors: string[];
  notes: string[];
  scopeMissing: boolean;
}

// The balance platform id from a secret, if one is set. The secret is optional
// and normally unset: the id is learned from Adyen and kept in
// adyen_platform_settings instead (OUR OWN ADYEN IDS below). Never the value in
// an answer, only whether one exists.
function balancePlatformFromSecret(env: AdyenEnv, region: string): string | null {
  return balancePlatformSecretNames(env, region)
    .map((name) => String(Deno.env.get(name) ?? '').trim())
    .find((v) => !!v) ?? null;
}

// The balance platform id a holder listing needs, without asking the admin to
// type one: a pasted id, the secret, OUR OWN KEPT SETTINGS for this
// environment and region, the venue's own account holder, or its balance
// account's account holder. Reads only, and only the last two cost an Adyen
// call, so a kept id makes the whole listing free.
async function resolveBalancePlatform(
  cfg: AdyenConfig,
  { given, stored, holderId, balanceAccountId }: { given?: string | null; stored?: string | null; holderId?: string | null; balanceAccountId?: string | null },
): Promise<{ id: string | null; source: string | null; errors: string[] }> {
  const errors: string[] = [];
  const pasted = String(given ?? '').trim();
  if (pasted) return { id: pasted, source: 'the id given', errors };
  const fromEnv = balancePlatformFromSecret(cfg.env, cfg.region);
  if (fromEnv) return { id: fromEnv, source: `the secret ${balancePlatformSecretName(cfg.env, cfg.region)}`, errors };
  const kept = String(stored ?? '').trim();
  if (kept) return { id: kept, source: `the id kept for the ${cfg.region} ${cfg.env} account`, errors };
  const known = String(holderId ?? '').trim();
  if (known) {
    const r = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(known)}`);
    if (r.ok) {
      const bp = String((r.data as Dict)?.balancePlatform ?? '').trim();
      if (bp) return { id: bp, source: `the venue's account holder ${known}`, errors };
    } else errors.push(`account holder ${known} on the row: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  }
  const ba = String(balanceAccountId ?? '').trim();
  if (ba) {
    const r = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(ba)}`);
    if (r.ok) {
      const ahId = String((r.data as Dict)?.accountHolderId ?? '').trim();
      if (ahId) {
        const h = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(ahId)}`);
        if (h.ok) {
          const bp = String((h.data as Dict)?.balancePlatform ?? '').trim();
          if (bp) return { id: bp, source: `the venue's balance account ${ba}`, errors };
        } else errors.push(`account holder ${ahId} of balance account ${ba}: ${refusalText(cfg, h, 'bpKey', 'the Balance Platform BCL role')}`);
      }
    } else errors.push(`balance account ${ba} on the row: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  }
  return { id: null, source: null, errors };
}

// The ACCOUNT HOLDER route: a pasted AH id, else every account holder on the
// balance platform, paged, matched on reference (or a migrated classic code).
// Nothing here throws: a refusal is a line and the store route still answers.
async function findAccountHolder(
  cfg: AdyenConfig,
  reference: string | null,
  opts: { accountHolderId?: string | null; balancePlatform?: string | null; storedBalancePlatform?: string | null; rowHolderId?: string | null; rowBalanceAccountId?: string | null },
): Promise<HolderSearch> {
  const out: HolderSearch = {
    holder: null, candidates: [], balancePlatform: null, balancePlatformSource: null,
    needsBalancePlatform: false, foundBy: null, capped: false, errors: [], notes: [], scopeMissing: false,
  };
  const pasted = String(opts.accountHolderId ?? '').trim();
  if (pasted) {
    const r = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(pasted)}`);
    if (r.ok) {
      out.holder = r.data as Dict;
      out.foundBy = 'pasted';
      out.balancePlatform = String((r.data as Dict)?.balancePlatform ?? '').trim() || null;
      out.balancePlatformSource = 'the account holder given';
      out.notes.push(`Account holder ${pasted} was read from the id given, not found by reference. Its balance platform is kept, so the next venue on this account is found by its reference on its own.`);
    } else {
      out.errors.push(`account holder ${pasted}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
      out.scopeMissing = scopeMissing(r.status);
    }
    return out;
  }
  if (!reference) return out;

  const bp = await resolveBalancePlatform(cfg, {
    given: opts.balancePlatform, stored: opts.storedBalancePlatform,
    holderId: opts.rowHolderId, balanceAccountId: opts.rowBalanceAccountId,
  });
  out.errors.push(...bp.errors);
  if (!bp.id) {
    out.needsBalancePlatform = true;
    out.notes.push(`Adyen has no account holder lookup by reference, so the venue's account holder can only be found by listing the balance platform. Type the balance platform id once in step 1 (set_balance_platform): it is kept and every venue is found by its reference on its own. Setting ${balancePlatformSecretName(cfg.env, cfg.region)} to the balance platform id does the same thing.`);
    return out;
  }
  out.balancePlatform = bp.id;
  out.balancePlatformSource = bp.source;

  // THE AUTOMATIC ROUTE. Page the balance platform's account holders, then
  // match the reference exactly and case insensitively over EVERYTHING read:
  // 100 a page is the documented maximum, and the paging stops at a SHORT page
  // (Adyen's own offset/limit end of list), at hasNext false, at a refusal, or
  // at HOLDER_PAGES. It deliberately does NOT stop on the first page that
  // matches. Adyen does not enforce a unique reference across a balance
  // platform (references are only unique per merchant account), so two holders
  // carrying the same venue code on different pages must BOTH be seen: the
  // account holder is the settlement identity, and picking the wrong one in
  // silence sends the venue's payouts to another business's bank account.
  const rows: Dict[] = [];
  let capped = false;
  let refused = false;
  for (let page = 0; page < HOLDER_PAGES; page++) {
    const r = await bcl<Dict>(cfg, 'GET', `/balancePlatforms/${encodeURIComponent(bp.id)}/accountHolders?limit=${HOLDER_PAGE_SIZE}&offset=${page * HOLDER_PAGE_SIZE}`);
    if (!r.ok) {
      out.errors.push(`account holders on balance platform ${bp.id}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
      out.scopeMissing = scopeMissing(r.status);
      refused = true;
      break;
    }
    const pageRows = accountHolderRows(r.data);
    rows.push(...pageRows);
    if (pageRows.length < HOLDER_PAGE_SIZE || (r.data as Dict)?.hasNext === false) break;
    // Pages ran out before account holders did.
    if (page === HOLDER_PAGES - 1) capped = true;
  }
  out.capped = capped;
  const match = matchAccountHolderByReference(rows, reference);
  if (match.holder) {
    out.holder = match.holder;
    out.foundBy = 'reference';
    out.notes.push(`Account holder ${String(match.holder.id ?? '')} carries the reference ${reference} on balance platform ${bp.id} (found from ${bp.source}). Nothing was pasted.`);
    return out;
  }
  if (match.ambiguous) {
    out.errors.push(`${match.matches.length} account holders on balance platform ${bp.id} carry the reference ${reference} (${match.matches.map((x) => String(x.id ?? '?')).join(', ')}). They cannot be told apart by reference, so paste the account holder id of the right one.`);
    out.candidates = accountHolderCandidates(match.matches, reference, 50);
    return out;
  }
  out.candidates = accountHolderCandidates(rows, reference, 50);
  // A TRUNCATED listing, or one a refusal cut short, NEVER reports an absence.
  // The definite line drives buildGoliveSteps to "Nothing at Adyen carries the
  // code" and offers to create a store, which would make a duplicate for a
  // venue Adyen already holds further down the list.
  if (capped || refused) {
    out.notes.push(rows.length
      ? `The first ${rows.length} account holders on balance platform ${bp.id} were read and none carries the reference ${reference}. There are more on this account, so paste this venue's account holder id (AH...).`
      : `No account holder on balance platform ${bp.id} could be read, so nothing was ruled out. Paste this venue's account holder id (AH...).`);
  } else if (rows.length) {
    out.notes.push(`No account holder on balance platform ${bp.id} carries the reference ${reference} (${rows.length} read). Paste the accountHolderId if Adyen gave you one.`);
  }
  return out;
}

// The business line a store must name, read from the venue's legal entity.
// Only used when there is no store to take one from.
async function findBusinessLine(cfg: AdyenConfig, legalEntityId: string): Promise<{ id: string | null; error: string | null }> {
  const r = await lem<Dict>(cfg, 'GET', `/legalEntities/${encodeURIComponent(legalEntityId)}/businessLines`);
  if (!r.ok) return { id: null, error: `business lines of ${legalEntityId}: ${refusalText(cfg, r, 'lemKey', 'the roles "Manage LegalEntities via API" and "Balance Platform BCL Legal Entity role"')}` };
  const pick = pickBusinessLine(r.data);
  return { id: pick ? String(pick.id ?? '').trim() || null : null, error: null };
}

// The merchant's split configuration profiles: used when a store must be
// linked to a balance account and no profile id is known (the documented
// splitConfiguration takes BOTH the profile and the balance account).
async function findSplitConfiguration(cfg: AdyenConfig, merchant: string): Promise<{ id: string | null; error: string | null; count: number }> {
  const r = await mgmt<{ data?: unknown[] }>(cfg, 'GET', `/merchants/${encodeURIComponent(merchant)}/splitConfigurations`);
  if (!r.ok) return { id: null, error: `split configuration profiles on ${merchant}: ${refusalText(cfg, r, 'managementKey', 'the Management API role "Split configuration read"')}`, count: 0 };
  const rows = storeRows(r.data);
  const ids = rows.map((x) => String(x.splitConfigurationId ?? x.id ?? '').trim()).filter(Boolean);
  return { id: ids.length === 1 ? ids[0] : null, error: null, count: ids.length };
}

// Link a store to the venue's balance account, the documented way: the store's
// splitConfiguration names BOTH the split configuration profile and the
// balance account the split amounts are booked to. Done as a PATCH AFTER the
// store exists, so a refusal here never loses a created store.
async function linkStoreToBalanceAccount(
  cfg: AdyenConfig, merchant: string, storeId: string,
  { balanceAccountId, splitConfigurationId }: { balanceAccountId: string; splitConfigurationId?: string | null },
): Promise<{ ok: boolean; splitConfigurationId: string | null; message: string }> {
  let profile = String(splitConfigurationId ?? '').trim();
  const notes: string[] = [];
  if (!profile) {
    const found = await findSplitConfiguration(cfg, merchant);
    if (found.error) notes.push(found.error);
    if (found.id) profile = found.id;
    else if (found.count > 1) notes.push(`${merchant} has ${found.count} split configuration profiles, so none could be chosen. Pass splitConfigurationId.`);
  }
  const splitConfiguration: Dict = { balanceAccountId };
  if (profile) splitConfiguration.splitConfigurationId = profile;
  const r = await mgmt<Dict>(cfg, 'PATCH', `/merchants/${encodeURIComponent(merchant)}/stores/${encodeURIComponent(storeId)}`, { splitConfiguration });
  if (r.ok) {
    return {
      ok: true, splitConfigurationId: profile || null,
      message: `Store ${storeId} now books its payments to balance account ${balanceAccountId}${profile ? ` under split configuration ${profile}` : ''}.${notes.length ? ` ${notes.join(' ')}` : ''}`,
    };
  }
  return {
    ok: false, splitConfigurationId: profile || null,
    message: `Store ${storeId} was NOT linked to balance account ${balanceAccountId}: ${adyenRefusalMessage(r.status, r.data)}${profile ? '' : ' Adyen wants a split configuration profile as well as the balance account.'}${notes.length ? ` ${notes.join(' ')}` : ''}`,
  };
}

interface LookupOpts {
  storeId?: string | null;
  accountHolderId?: string | null;
  currency: string;
  merchantSecret?: string;            // the secret that names `merchant`, for the mismatch line
  merchantOverride?: boolean;         // the admin named the merchant account explicitly
  balancePlatform?: string | null;    // a pasted balance platform id (BP...)
  // The balance platform id we ALREADY KEPT for this environment and region
  // (adyen_platform_settings). This is what makes the reference search work by
  // itself after the first venue: with it the holder listing needs no pasted
  // id, no secret and no extra Adyen read.
  storedBalancePlatform?: string | null;
  row?: Dict | null;                  // merchant_adyen_accounts as it is NOW: its ids bootstrap the holder listing
  // Search EVERY merchant account this credential can see when the configured
  // one has no match. That sweep is 70+ Adyen calls (findStoreAnywhere), so it
  // is opt in: the guided flow's automatic read passes false and offers it as
  // a button instead (8 Sep 2026, expanding a venue row must not hang).
  sweep?: boolean;
}

// The whole chain for one venue on one config, BOTH ROUTES AT ONCE (8 Sep
// 2026): the STORE route (this merchant, then every merchant the credential
// can see) and the ACCOUNT HOLDER route (a pasted AH id, else the balance
// platform's holders matched on reference) run in parallel and are merged, so
// a venue Adyen holds only as an account holder is found, and a store that
// lives on another merchant account is reported instead of used.
// `reference` is the venue code (or the admin's override); `storeId` skips the
// search (the admin picked a candidate); `accountHolderId` is the holder the
// admin pasted. Nothing throws: every refusal is a line in `errors`, every gap
// a line in `notes`.
async function lookupByReference(cfg: AdyenConfig, merchant: string, reference: string | null, opts: LookupOpts): Promise<LookupResult> {
  const errors: string[] = [];
  const notes: string[] = [];
  const out: LookupResult = {
    found: false, reference, merchantAccount: merchant, environment: cfg.env, region: cfg.region,
    store: null, balanceAccount: null, accountHolder: null, legalEntity: null,
    splitConfigurationId: null, businessLineIds: [], candidates: [], errors, notes, scopeMissing: false,
    holderCandidates: [], merchantMismatch: null, merchantsSearched: [], balancePlatform: null, storeNeeded: null,
  };
  const storeId = String(opts.storeId ?? '').trim();
  const row = (opts.row ?? null) as Dict | null;
  const merchantSecret = String(opts.merchantSecret ?? '').trim();

  // ── the two routes, together ────────────────────────────────────────────────
  const [storeSide, holderSide] = await Promise.all([
    (async () => {
      const e: string[] = [];
      const n: string[] = [];
      let store: StoreSummary | null = null;
      let sweep: StoreSweep | null = null;
      let mismatch: MerchantMismatch | null = null;
      let scope = false;
      // Every EXACT reference match, whatever merchant account it sits on: the
      // reference is unique inside a merchant account only, so a credential
      // wide sweep can answer one store per account and the admin must see
      // WHICH account each one is on before picking (8 Sep 2026).
      let raw: Dict[] = [];
      if (storeId) {
        // 1a. the store the admin picked, by id
        const r = await mgmt<Dict>(cfg, 'GET', `/stores/${encodeURIComponent(storeId)}`);
        if (!r.ok) {
          e.push(`store ${storeId}: ${refusalText(cfg, r, 'managementKey', 'the Management API role "Stores read"')}`);
          scope = scopeMissing(r.status);
        } else {
          const s = storeSummary(r.data);
          if (s?.merchantId && s.merchantId.toLowerCase() !== merchant.toLowerCase()) {
            // NEVER silently: the venue would charge on one account while its
            // store lived on another. merchantAccount is the way to say yes.
            mismatch = merchantMismatch({ configured: merchant, found: s.merchantId, secret: merchantSecret, storeId, reference });
            e.push(mismatch?.message ?? `store ${storeId} belongs to merchant account ${s.merchantId}, not ${merchant}.`);
          } else {
            store = s;
            raw = [r.data as Dict];
            if (s && reference && referenceKey(s.reference) !== referenceKey(reference)) {
              n.push(`Store ${storeId} carries the reference ${s.reference ?? '(none)'}, not the venue code ${reference}. It was chosen by id.`);
            }
          }
        }
      } else if (reference) {
        // 1b. the store by reference: this merchant, and (only when asked)
        // every merchant account the credential can see.
        if (opts.sweep === false) {
          const own = await findStoreByReference(cfg, merchant, reference);
          sweep = { ...own, merchantsSearched: [merchant], notes: [] };
          if (!own.store && !own.ambiguous && !own.scopeMissing) {
            sweep.notes.push(`No store on ${merchant} carries the reference ${reference}. Search every Adyen account to look wider.`);
          }
        } else {
          sweep = await findStoreAnywhere(cfg, merchant, reference);
        }
        e.push(...sweep.errors);
        n.push(...sweep.notes);
        scope = sweep.scopeMissing;
        raw = sweep.matches;
        if (sweep.store) {
          const s = storeSummary(sweep.store)!;
          if (s.merchantId && s.merchantId.toLowerCase() !== merchant.toLowerCase()) {
            mismatch = merchantMismatch({ configured: merchant, found: s.merchantId, secret: merchantSecret, storeId: s.id, reference });
          } else {
            store = s;
          }
        } else if (sweep.ambiguous) {
          e.push(`${sweep.matches.length} stores carry the reference ${reference} (${sweep.matches.map((x) => `${String(x.id ?? '?')} on ${String(x.merchantId ?? '?')}`).join(', ')}). Pass storeId to pick one.`);
        }
      } else {
        e.push('This venue has no venue code, so there is no store reference to look up. Set one in the Back Office (Venue settings) or pass reference.');
      }
      return { store, sweep, errors: e, notes: n, scopeMissing: scope, mismatch, raw };
    })(),
    findAccountHolder(cfg, reference, {
      accountHolderId: opts.accountHolderId,
      balancePlatform: opts.balancePlatform,
      storedBalancePlatform: opts.storedBalancePlatform,
      rowHolderId: row?.account_holder_id ? String(row.account_holder_id) : null,
      rowBalanceAccountId: row?.balance_account_id ? String(row.balance_account_id) : null,
    }),
  ]);

  errors.push(...storeSide.errors, ...holderSide.errors);
  notes.push(...storeSide.notes, ...holderSide.notes);
  out.scopeMissing = storeSide.scopeMissing || holderSide.scopeMissing;
  // The store route on its own, for the go live flow's step 1: the merged
  // flag above is also true when the Balance Platform refuses the key.
  out.storeScopeMissing = storeSide.scopeMissing;
  out.merchantMismatch = storeSide.mismatch;
  out.merchantsSearched = storeSide.sweep?.merchantsSearched ?? [merchant];
  // WHICH MERCHANT EACH HIT SITS ON, as rows the picker renders: id, reference,
  // status and merchantId per exact match. One row is the normal case; more
  // than one means the same reference exists on several merchant accounts and
  // the admin passes storeId (and merchantAccount) to say which.
  out.storeHits = storeCandidates(storeSide.raw, reference, 25);
  out.holderCandidates = holderSide.candidates;
  out.balancePlatform = holderSide.balancePlatform;
  out.needsBalancePlatform = holderSide.needsBalancePlatform;
  out.balancePlatformSecret = balancePlatformSecretName(cfg.env, cfg.region);

  // 1. the store, or the plain reason there is none
  const store = storeSide.store;
  if (store) {
    out.store = store;
    out.splitConfigurationId = store.splitConfigurationId;
    out.businessLineIds = store.businessLineIds;
    if (store.status && store.status !== 'active') notes.push(`The store is ${store.status} at Adyen; payments naming it are refused until it is active.`);
  } else if (reference && !storeId) {
    out.candidates = storeCandidates(storeSide.sweep?.rows ?? [], reference, 50);
    if (!storeSide.scopeMissing && !storeSide.mismatch && !storeSide.sweep?.ambiguous) {
      const where = opts.sweep === false ? `No store on ${merchant} has the reference ${reference}` : `No store on ${merchant}, or on any other merchant account this credential can see, has the reference ${reference}`;
      notes.push(`${where}. Pick one of the ${out.candidates.length} stores listed (storeId), create it with adyen_create_store_by_reference, or link the account holder on its own.`);
    }
  }

  // 2. the balance account the store's split configuration names
  let ba: BalanceAccountSummary | null = null;
  out.storeBalanceAccountId = store?.balanceAccountId ?? null;
  out.storeBalanceAccountForeign = false;
  if (store?.balanceAccountId) {
    const r = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(store.balanceAccountId)}`);
    if (r.ok) ba = balanceAccountSummary(r.data, 'store');
    else errors.push(`balance account ${store.balanceAccountId}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  } else if (store) {
    notes.push('The store carries no split configuration, so Adyen names no balance account for it.');
  }

  // 3. the account holder: THE PASTED ID WINS, then the one the reference
  //    matched, and only then the store's (through its balance account).
  //    A store's split configuration can name the platform's liable account
  //    or another venue's balance account (a store FranPOS made in the
  //    Customer Area before the venue's holder existed), and until 9 Sep
  //    2026 that account's holder won over the one the admin pasted: the
  //    read adopted the OTHER company, the link wrote its balance account,
  //    legal entity and bank onto the venue, and step 5a blessed it. Now a
  //    balance account that belongs to a different holder than the chosen
  //    one is an ERROR, it is never adopted, and the chosen holder's own
  //    account is picked instead (3b).
  let ah: AccountHolderSummary | null = null;
  const byReferenceHolder = holderSide.holder;
  const byReferenceHolderId = String(byReferenceHolder?.id ?? '').trim();
  const pastedHolderId = String(opts.accountHolderId ?? '').trim();
  const holderId = pastedHolderId || byReferenceHolderId || ba?.accountHolderId || null;
  if (holderId && holderId === byReferenceHolderId) {
    ah = accountHolderSummary(byReferenceHolder);       // already read on the holder route
  } else if (holderId) {
    const r = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(holderId)}`);
    if (r.ok) {
      ah = accountHolderSummary(r.data);
      if (holderId === pastedHolderId) notes.push(`Account holder ${holderId} was read from the id given, not from the store.`);
    } else errors.push(`account holder ${holderId}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  } else if (ba) {
    errors.push(`balance account ${ba.id} names no account holder.`);
  } else if (store) {
    notes.push('No account holder is reachable: the store names no balance account, no accountHolderId was given and no account holder carries the reference.');
  }
  // HOW the account holder we ended up with was reached, for the one line the
  // screen shows: 'pasted' (an id was typed in AND it is the one used),
  // 'reference' (the balance platform listing matched the venue code with
  // nothing pasted, the automatic route every venue after the first takes),
  // 'store' (the store's balance account named it), or null.
  out.holderFoundBy = !ah?.id ? null
    : pastedHolderId && ah.id === pastedHolderId ? 'pasted'
    : holderSide.foundBy === 'reference' && ah.id === byReferenceHolderId ? 'reference'
    : ba?.accountHolderId && ah.id === ba.accountHolderId ? 'store'
    : null;
  if (ba && ah?.id && ba.accountHolderId && ba.accountHolderId !== ah.id) {
    // The store's account is NOT the chosen holder's. Said as an error (the
    // screen turns it into one plain line, and step 5a offers set_split),
    // and the account is dropped here so nothing downstream writes it.
    errors.push(`balance account ${ba.id} (named by the store's split configuration) belongs to a different account holder, ${ba.accountHolderId}, not ${ah.id}. It was not used; apply the rates again so the store points at the venue's own account.`);
    out.storeBalanceAccountForeign = true;
    ba = null;
  } else if (ba && ah?.id && !ba.accountHolderId) {
    errors.push(`balance account ${ba.id} (named by the store's split configuration) names no account holder, so it cannot be shown to be ${ah.id}'s. It was not used.`);
    out.storeBalanceAccountForeign = true;
    ba = null;
  }

  // 3b. no balance account from the store, but the holder is known: pick one
  //     of the holder's (primary, else the one open account in the region's
  //     currency, else the only one)
  if (!ba && ah?.id) {
    const r = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(ah.id)}/balanceAccounts?limit=100`);
    if (r.ok) {
      const pick = pickBalanceAccount(r.data, { primaryId: ah.primaryBalanceAccount, currency: opts.currency });
      if (pick) {
        ba = balanceAccountSummary(pick, 'account_holder');
        notes.push(store
          ? `Balance account ${ba?.id} was taken from the account holder (its primary, or the one open account in ${opts.currency}); the store's split configuration at Adyen does not name it yet, so payments do not split into it until that is configured.`
          : `Balance account ${ba?.id} was taken from the account holder (its primary, or the one open account in ${opts.currency}).`);
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

  // 4b. the sweeps on the venue balance account (9 Sep 2026): ANY active push
  //     to a bank is what "paid out" means (the venue may have changed bank,
  //     and the oldest bank the legal entity lists is not the one to look
  //     for), for buildLinkPatch's payout_sweep_id and for the go live flow's
  //     step 5. One read, best effort; sweepKnown says whether it happened.
  //       GET /balanceAccounts/{id}/sweeps   https://docs.adyen.com/api-explorer/balanceplatform/latest/get/balanceAccounts/(balanceAccountId)/sweeps
  out.sweep = null;
  out.sweepKnown = false;
  if (ba?.id) {
    const r = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(ba.id)}/sweeps`);
    if (r.ok) {
      out.sweepKnown = true;
      out.sweep = findPushSweep(r.data, null);
    } else errors.push(`sweeps of balance account ${ba.id}: ${refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role')}`);
  }

  // 5. no store to take a business line from: read the legal entity's
  //    payment processing line, so the row can hold it and a store created
  //    later can name it.
  if (!store && out.legalEntity?.id) {
    const bl = await findBusinessLine(cfg, out.legalEntity.id);
    if (bl.error) errors.push(bl.error);
    else if (bl.id) {
      out.businessLineIds = [bl.id];
      notes.push(`Business line ${bl.id} was read from the legal entity (its payment processing line); a store created for this venue must name it.`);
    }
  }

  out.balanceAccount = ba;
  out.accountHolder = ah;
  // EVERY capability by name, blocked ones first (8 Sep 2026): the live account
  // holder is Active with ONE capability Blocked, and a single verification
  // word hid it. The wizard renders this list as it is.
  out.capabilities = capabilityList(ah?.capabilities);
  // FOUND means Adyen holds this venue: as a store, as an account holder, or
  // as both. A holder with no store can be linked; card payments wait for the
  // store (storeNeeded says so in plain words).
  out.found = !!store || !!ah?.id;
  out.storeNeeded = storeStillNeeded(out);
  if (out.storeNeeded) notes.push(out.storeNeeded);
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

// ── OUR OWN ADYEN IDS: adyen_platform_settings (8 Sep 2026) ─────────────────
// The Balance Platform Configuration API has no filter by reference, so the
// FIRST venue on an Adyen account is linked by pasting its account holder id.
// That one read answers accountHolder.balancePlatform, which is kept here, and
// from then on GET /balancePlatforms/{id}/accountHolders finds every other
// venue by its reference on its own. The merchant account codes a credential
// can see are kept on the same row, so the flow can draw its account picker
// with no live call.
//
// One row per environment ('test' | 'live') and region ('UK' | 'US'). Ids, not
// secrets. The table arrives with the migration named below: until it runs,
// every read answers { row: null, available: false } with a warning naming the
// file and every write is skipped, so the flow works exactly as before (one
// paste per venue) and the order of deploy and migration does not matter.
const PLATFORM_SETTINGS_MIGRATION = 'supabase/migrations/20260908c_PLATFORM_adyen_platform_settings.sql';
type PlatformSettings = { row: Dict | null; available: boolean; warning: string | null };

async function readPlatformSettings(env: AdyenEnv, region: string): Promise<PlatformSettings> {
  const key = platformSettingsKey(env, region);
  const { data, error } = await platformAdmin.from(ADYEN_PLATFORM_SETTINGS_TABLE)
    .select('environment, region, balance_platform_id, merchant_accounts, updated_at')
    .eq('environment', key.environment).eq('region', key.region).maybeSingle();
  if (error) {
    if (isUnknownRelationError(error, ADYEN_PLATFORM_SETTINGS_TABLE)) return { row: null, available: false, warning: platformSettingsMissingMessage() };
    return { row: null, available: false, warning: `Our own Adyen ids could not be read (${error.message}), so this venue needs its Adyen id pasted.` };
  }
  return { row: (data as Dict | null) ?? null, available: true, warning: null };
}

// Keep what THIS read learned, and nothing else. platformSettingsPatch answers
// null when there is nothing new, which is the normal case, so no write leaves
// on a repeat read. Fire and forget in spirit: a failure here never fails the
// action that learned the id, it just means the next read learns it again.
async function savePlatformSettings(
  env: AdyenEnv, region: string, settings: PlatformSettings, learned: PlatformSettingsLearned,
): Promise<{ saved: boolean; warning: string | null }> {
  if (!settings.available) return { saved: false, warning: settings.warning };
  // A DIFFERENT balance platform id is a CLASH, never an update. The row is
  // keyed by (environment, region) alone, and under the reseller model more
  // than one Adyen account is in play for one region: silently re-pointing it
  // would make every OTHER venue on the kept account list the wrong platform,
  // match nothing, and be told it is not on Adyen when it is. The kept id
  // stays (platformSettingsPatch fills a blank only) and the admin is told.
  const learnedBp = String(learned.balancePlatformId ?? '').trim();
  const keptBp = String(settings.row?.balance_platform_id ?? '').trim();
  const clash = learnedBp && keptBp && learnedBp !== keptBp
    ? `This venue is on balance platform ${learnedBp}, but the ${region} ${env} account we search is ${keptBp}. Nothing was changed.`
    : null;
  const patch = platformSettingsPatch(settings.row, learned);
  if (!patch) return { saved: false, warning: clash };
  const key = platformSettingsKey(env, region);
  const { error } = await platformAdmin.from(ADYEN_PLATFORM_SETTINGS_TABLE)
    .upsert({ ...key, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'environment,region' });
  if (error) {
    if (isUnknownRelationError(error, ADYEN_PLATFORM_SETTINGS_TABLE)) return { saved: false, warning: platformSettingsMissingMessage() };
    return { saved: false, warning: `Our own Adyen ids could not be kept (${error.message}). Run ${PLATFORM_SETTINGS_MIGRATION} on the platform project if the table is missing.` };
  }
  // The caller reads this row again on its next call, so keep the copy in hand
  // in step with the write: a second learn in the same request writes nothing.
  settings.row = { ...(settings.row ?? key), ...patch };
  return { saved: true, warning: clash };
}

// The same id ON THE VENUE ROW, so a venue carries the Adyen account it lives
// on without a join. Its own statement, never part of the link upsert: the
// column arrives with the same migration and a write naming a column that is
// not there would take the whole link write down with it (PostgREST answers
// PGRST204 for the lot). Absent column, or any refusal, is skipped in silence.
async function rememberBalancePlatformOnVenue(locationId: string, balancePlatform: string | null): Promise<string | null> {
  const bp = String(balancePlatform ?? '').trim();
  if (!bp) return null;
  try {
    const { error } = await platformAdmin.from('merchant_adyen_accounts')
      .update({ [ADYEN_ROW_BALANCE_PLATFORM_COLUMN]: bp })
      .eq('location_id', locationId);
    if (!error) return null;
    // The column arrives with the same migration as the settings table. Absent
    // is fine and quiet: the id is kept in adyen_platform_settings either way.
    if (isUnknownColumnError(error, ADYEN_ROW_BALANCE_PLATFORM_COLUMN)) return null;
    return `The venue row could not be told which Adyen balance platform it is on (${error.message}).`;
  } catch (e) {
    return `The venue row could not be told which Adyen balance platform it is on (${(e as Error)?.message || String(e)}).`;
  }
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

// ── READ ONLY probes for golive_state (8 Sep 2026) ───────────────────────────
// The wizard must SHOW where a venue stands without changing anything, so
// these two are the register actions with every POST taken out. Same
// endpoints, same credential rules, nothing written:
//   GET /v3/me                  https://docs.adyen.com/api-explorer/Management/3/get/me
//   GET /v3/me/allowedOrigins   https://docs.adyen.com/api-explorer/Management/3/get/me/allowedOrigins
// `registered` is the one thing the step reads: true when every ServOS origin
// is already on the credential the Drop-in client key belongs to. A refusal
// answers registered false with the reason, never a throw.
async function probeWebOrigins(cfg: AdyenConfig, customDomain: string | null): Promise<Record<string, unknown> & { registered: boolean }> {
  const wanted = buildWebOrigins({ customDomain });
  const base = { environment: cfg.env, region: cfg.region, credential: null as string | null, wanted, existing: [] as string[], missing: wanted, registered: false };
  const apiKeyName = adyenSecretName(cfg.env, 'apiKey', cfg.region);
  const me = await mgmt<{ username?: unknown; clientKey?: unknown }>(cfg, 'GET', '/me', undefined, cfg.apiKey);
  if (!me.ok) return { ...base, error: `Could not read the ${cfg.region} ${cfg.env} API credential (${apiKeyName}): ${adyenRefusalMessage(me.status, me.data)}` };
  const username = String(me.data?.username ?? '').trim() || null;
  const meClientKey = String(me.data?.clientKey ?? '').trim();
  if (cfg.clientKey && meClientKey !== cfg.clientKey) {
    return { ...base, credential: username, code: 'wrong_credential', error: `${apiKeyName} is not the credential the Drop-in client key belongs to, so its origins are not the ones the browser checks.` };
  }
  const list = await mgmt(cfg, 'GET', '/me/allowedOrigins', undefined, cfg.apiKey);
  if (!list.ok) return { ...base, credential: username, error: `Could not read the allowed origins: ${adyenRefusalMessage(list.status, list.data)}` };
  const plan = originsPlan(list.data, { customDomain });
  return { ...base, credential: username, existing: plan.existing, missing: plan.missing, registered: plan.missing.length === 0 };
}

// The venue's Apple Pay state, read only:
//   GET /v3/merchants/{m}/paymentMethodSettings                              https://docs.adyen.com/api-explorer/Management/3/get/merchants/_merchantId_/paymentMethodSettings
//   GET /v3/merchants/{m}/paymentMethodSettings/{id}/getApplePayDomains      https://docs.adyen.com/api-explorer/Management/3/get/merchants/_merchantId_/paymentMethodSettings/_paymentMethodId_/getApplePayDomains
// `domains` is what Adyen holds NOW, `verification` the payment method's own
// status (valid | pending | invalid | rejected), null when Apple Pay was never
// requested on the merchant.
async function probeApplePay(cfg: AdyenConfig, merchant: string, storeId: string | null, storefront: Storefront): Promise<Record<string, unknown> & { domains: string[]; verification: string | null }> {
  const wanted = buildStorefrontDomains(storefront);
  const base = { environment: cfg.env, region: cfg.region, merchant, domains: [] as string[], wanted, missing: wanted, verification: null as string | null, registered: false };
  if (!wanted.length) return { ...base, code: 'no_storefront', error: 'This venue has no online address yet, so there is nothing to register for Apple Pay.' };
  const m = encodeURIComponent(merchant);
  const rows: unknown[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await mgmt<{ data?: unknown[]; _links?: { next?: unknown } }>(cfg, 'GET', `/merchants/${m}/paymentMethodSettings?pageSize=100&pageNumber=${page}`);
    if (!r.ok) return { ...base, error: `Could not read the payment methods on ${merchant}: ${adyenRefusalMessage(r.status, r.data)}` };
    const pageRows: unknown = r.data?.data;
    rows.push(...(Array.isArray(pageRows) ? pageRows : []));
    if (!r.data?._links?.next) break;
  }
  const pm = pickApplePayMethod(rows, storeId);
  const storeScoped = !pm && hasApplePayEntries(rows);
  if (!pm) return { ...base, code: storeScoped ? 'apple_pay_store_scoped' : 'apple_pay_not_requested', error: applePayStatusNote(pm, merchant, { storeScoped }) };
  const pmId = String(pm.id ?? '');
  const verification = pm.verificationStatus === undefined || pm.verificationStatus === null ? null : String(pm.verificationStatus);
  const cur = await mgmt<{ domains?: unknown }>(cfg, 'GET', `/merchants/${m}/paymentMethodSettings/${encodeURIComponent(pmId)}/getApplePayDomains`);
  const got: unknown = cur.ok ? cur.data?.domains : null;
  const own: unknown = pm.applePay?.domains;
  let known: string[] = [];
  if (cur.ok && (cur.status === 204 || cur.data == null || got === undefined)) known = [];
  else if (Array.isArray(got)) known = got.filter((d): d is string => typeof d === 'string');
  else if (Array.isArray(own)) known = own.filter((d): d is string => typeof d === 'string');
  const plan = applePayDomainsPlan(known, storefront);
  return { ...base, paymentMethodId: pmId, verification, domains: known, missing: plan.missing, registered: plan.missing.length === 0 };
}

// ── step 5 reads for golive_state and set_split (9 Sep 2026) ─────────────────
// Where the hosted onboarding page sends the venue owner afterwards, and how
// long Adyen keeps the link alive (docs: "Expires after 4 minutes").
const ONBOARDING_REDIRECT_URL = 'https://app.serv-os.app/';
const ONBOARDING_LINK_TTL_MS = 4 * 60_000;

// THE VENUE'S RATE AS THE LEDGER RESOLVES IT (9 Sep 2026). adyen-webhook
// stamps what ServOS earns on every payment from resolveAdyenRateCard, per
// tier: the venue's rate_card, else the platform default rate_card, else the
// legacy flat markup as the in person tier ONLY. Step 5 shows, and set_split
// writes, those SAME numbers, so Adyen never takes one rate while the ledger
// and the venue's Card payments screen say another. rate_card and
// default_adyen_rate_card arrive with 20260821b_adyen_rate_card.sql and are
// read on their own statements: a missing column is a line, never a 400 for
// every action.
interface VenueRates { cards: Record<string, TierRate>; rowRateCard: Dict | null; settings: Dict; errors: string[] }
async function readVenueRates(locationId: string, maa: Dict | null): Promise<VenueRates> {
  const errors: string[] = [];
  let rowRateCard: Dict | null = null;
  try {
    const { data, error } = await platformAdmin.from('merchant_adyen_accounts').select('rate_card').eq('location_id', locationId).maybeSingle();
    if (error && !isUnknownColumnError(error, 'rate_card')) errors.push(`rate card of the venue: ${error.message}`);
    else if (!error) {
      const card = (data as Dict | null)?.rate_card;
      rowRateCard = card && typeof card === 'object' && !Array.isArray(card) ? (card as Dict) : null;
    }
  } catch (e) { errors.push(`rate card of the venue: ${(e as Error)?.message || String(e)}`); }
  let settings: Dict = {};
  try {
    let { data, error } = await platformAdmin.from('platform_settings')
      .select('default_adyen_rate_card, default_adyen_markup_percent, default_adyen_markup_fixed_pence').eq('id', true).maybeSingle();
    if (error && isUnknownColumnError(error, 'default_adyen_rate_card')) {
      ({ data, error } = await platformAdmin.from('platform_settings')
        .select('default_adyen_markup_percent, default_adyen_markup_fixed_pence').eq('id', true).maybeSingle());
    }
    if (error) errors.push(`platform defaults: ${error.message}`);
    else settings = (data as Dict | null) ?? {};
  } catch (e) { errors.push(`platform defaults: ${(e as Error)?.message || String(e)}`); }
  const cards = resolveAdyenRateCard(
    { rate_card: rowRateCard, markup_percent: maa?.markup_percent, markup_fixed_pence: maa?.markup_fixed_pence },
    settings as { default_adyen_rate_card?: unknown; default_adyen_markup_percent?: unknown; default_adyen_markup_fixed_pence?: unknown },
  );
  return { cards, rowRateCard, settings, errors };
}
// The resolved card as the screen and the profile builder take it
// ({ tier: { percent, fixedPence, source } }, tiersFromResolved).
function tiersForProfile(cards: Record<string, TierRate>): Record<string, { percent: number | null; fixedPence: number | null }> {
  const out: Record<string, { percent: number | null; fixedPence: number | null }> = {};
  for (const t of RATE_TIERS) out[t] = { percent: cards[t]?.percent ?? null, fixedPence: cards[t]?.fixed_pence ?? null };
  return out;
}

// THE PAYOUT SWEEP ON THE ROW (9 Sep 2026). payouts_ok stays the capability
// (Adyen allows payouts), as adyen-bp-webhook, adyen-financial and the
// venue's own Card payments screen mean it; whether the venue is actually
// PAID OUT is merchant_adyen_accounts.payout_sweep_id, written by setup_sweep
// and golive_state and read by the list chip together with the flag. The
// column arrives with the migration named here and is read and written ON
// ITS OWN, so the function works before it runs (a write then answers a
// warning naming the file).
const PAYOUT_SWEEP_COLUMN = 'payout_sweep_id';
const PAYOUT_SWEEP_MIGRATION = 'supabase/migrations/20260909b_PLATFORM_adyen_payout_sweep_id.sql';
function payoutSweepMissingMessage(): string {
  return `The daily payout was not kept on the venue: merchant_adyen_accounts has no ${PAYOUT_SWEEP_COLUMN} column yet, so the list chip cannot read it. Run ${PAYOUT_SWEEP_MIGRATION} on the platform project.`;
}
async function readPayoutSweepId(locationId: string): Promise<{ id: string | null; available: boolean }> {
  try {
    const { data, error } = await platformAdmin.from('merchant_adyen_accounts').select(PAYOUT_SWEEP_COLUMN).eq('location_id', locationId).maybeSingle();
    if (error) return { id: null, available: !isUnknownColumnError(error, PAYOUT_SWEEP_COLUMN) };
    return { id: String((data as Dict | null)?.[PAYOUT_SWEEP_COLUMN] ?? '').trim() || null, available: true };
  } catch { return { id: null, available: false }; }
}
async function rememberPayoutSweepOnVenue(locationId: string, sweepId: string | null): Promise<string | null> {
  try {
    const { error } = await platformAdmin.from('merchant_adyen_accounts')
      .update({ [PAYOUT_SWEEP_COLUMN]: sweepId, updated_at: new Date().toISOString() })
      .eq('location_id', locationId);
    if (!error) return null;
    if (isUnknownColumnError(error, PAYOUT_SWEEP_COLUMN)) return payoutSweepMissingMessage();
    return `The daily payout could not be kept on the venue (${error.message}).`;
  } catch (e) {
    return `The daily payout could not be kept on the venue (${(e as Error)?.message || String(e)}).`;
  }
}

// OUR liable balance account id, if we know it: the secret named by
// liableBalanceAccountSecretName, else the column on adyen_platform_settings
// (read on its own; absent until 20260909_PLATFORM_adyen_liable_balance_account.sql
// runs, and that is fine: the commission lands there whether or not the id
// can be shown, so this is decoration, never a gate).
async function readLiableBalanceAccount(env: AdyenEnv, region: string): Promise<string | null> {
  const fromSecret = liableBalanceAccountSecretNames(env, region).map((n) => String(Deno.env.get(n) ?? '').trim()).find((v) => !!v);
  if (fromSecret) return fromSecret;
  const key = platformSettingsKey(env, region);
  try {
    const { data, error } = await platformAdmin.from(ADYEN_PLATFORM_SETTINGS_TABLE)
      .select(ADYEN_LIABLE_BALANCE_ACCOUNT_COLUMN).eq('environment', key.environment).eq('region', key.region).maybeSingle();
    if (error) return null;
    return String((data as Dict | null)?.[ADYEN_LIABLE_BALANCE_ACCOUNT_COLUMN] ?? '').trim() || null;
  } catch { return null; }
}

// What the profile on the store actually says, so step 5 shows the real
// rates and not the row's: GET /merchants/{m}/splitConfigurations/{id}
//   https://docs.adyen.com/api-explorer/Management/3/get/merchants/(merchantId)/splitConfigurations/(splitConfigurationId)
// The raw profile goes through ratesOnAdyen (rule by rule back into the four
// tiers, matched against the venue's card, plus where the catch all rule
// sends the rest of each sale), so step 5a can say "Adyen holds different
// rates" and refuse to read Done on a profile that keeps the remainder.
interface ProfileRead { raw: Dict | null; read: boolean; error: string | null }
async function readProfileRates(cfg: AdyenConfig, merchant: string, profileId: string): Promise<ProfileRead> {
  const r = await mgmt<Dict>(cfg, 'GET', `/merchants/${encodeURIComponent(merchant)}/splitConfigurations/${encodeURIComponent(profileId)}`);
  if (!r.ok) return { raw: null, read: false, error: `split configuration ${profileId}: ${refusalText(cfg, r, 'managementKey', 'the Management API role "SplitConfiguration read"')}` };
  return { raw: (r.data as Dict) ?? null, read: true, error: null };
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
        .select('merchant_account, store_id, region, receive_payments_ok, payouts_ok, legal_entity_id, account_holder_id, balance_account_id, split_profile_id, transfer_instrument_id, business_line_id, markup_percent, markup_fixed_pence')
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
      // The daily payout belonged to the outgoing account's balance account
      // (on its own statement: the column may be waiting on its migration).
      if (provisionedOnCurrent) {
        const sweepWarning = await rememberPayoutSweepOnVenue(loc.id, null);
        if (sweepWarning && !warnings.includes(sweepWarning)) warnings.push(sweepWarning);
      }
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
      // MERCHANT OVERRIDE (8 Sep 2026): the venue's store may live on another
      // merchant account than the secret names (live: FranPOS_UK, not
      // FranPOS_QSR_UK). The lookup reports that as merchantMismatch and never
      // uses the store; body.merchantAccount is the admin's explicit yes, and
      // adyen_link writes it onto the row.
      const merchantOverride = String(body.merchantAccount ?? body.merchant_account ?? '').trim() || null;
      if (merchantOverride && !/^[A-Za-z0-9_.-]{3,80}$/.test(merchantOverride)) return json({ error: 'merchantAccount does not look like an Adyen merchant account code' }, 400);
      const merchant = merchantOverride || effectiveMerchantAccount(linkCfg, linkEnv === env ? maa?.merchant_account : null);
      const storeId = String(body.storeId ?? body.store_id ?? '').trim() || null;
      const accountHolderId = String(body.accountHolderId ?? body.account_holder_id ?? '').trim() || null;
      const balancePlatform = String(body.balancePlatform ?? body.balance_platform ?? '').trim() || null;
      if (storeId && !/^ST[0-9A-Z]{10,}$/i.test(storeId)) return json({ error: 'storeId does not look like an Adyen store id (ST...)' }, 400);
      if (accountHolderId && !/^AH[0-9A-Z]{10,}$/i.test(accountHolderId)) return json({ error: 'accountHolderId does not look like an Adyen account holder id (AH...)' }, 400);
      const venueCode = await venueCodeFor(opsLocationId);
      const reference = String(body.reference ?? '').trim().slice(0, 50) || venueCode;
      const linkCurrency = region === 'US' ? 'USD' : 'GBP';
      // OUR OWN KEPT IDS for this Adyen account: the balance platform id
      // learned the first time any account holder on it was read. With it the
      // venue is found by its REFERENCE with nothing pasted (THE AUTOMATIC
      // ROUTE in findAccountHolder); without it, the first venue pastes its id
      // once and that read teaches us the id for every venue after it.
      const linkSettings = await readPlatformSettings(linkEnv, region);
      // The row's ids belong to the environment the venue is on NOW. Handing a
      // TEST account holder to the LIVE Balance Platform is a guaranteed 404
      // on every read and a live round trip for nothing (8 Sep 2026), so the
      // row only bootstraps the search when the target IS the venue's own.
      const lookup = await lookupByReference(linkCfg, merchant, reference, {
        storeId, accountHolderId, currency: linkCurrency, balancePlatform,
        storedBalancePlatform: String(linkSettings.row?.balance_platform_id ?? '').trim() || null,
        merchantSecret, merchantOverride: !!merchantOverride, row: linkEnv === env ? (maa as Dict | null) : null,
      });
      // Whatever this read learned is kept, so the NEXT venue on this account
      // needs no pasted id. Nothing new is the normal answer and writes nothing.
      const learnedBp = learnedBalancePlatform(lookup);
      const kept = await savePlatformSettings(linkEnv, region, linkSettings, { balancePlatformId: learnedBp });
      const balancePlatformKnown = !!(learnedBp || String(linkSettings.row?.balance_platform_id ?? '').trim() || balancePlatformFromSecret(linkEnv, region));
      const patch = lookup.found ? buildLinkPatch(lookup, { merchantAccount: merchant, region, environment: linkEnv }) : null;
      // payout_sweep_id rides on its OWN statement (the column may not exist
      // yet, and a select or upsert naming an unknown column is a 400 for the
      // whole write): taken off the patch here, written after the row below.
      const sweepIdPatch: string | null | undefined = patch && 'payout_sweep_id' in patch ? ((patch.payout_sweep_id as string | null) ?? null) : undefined;
      if (patch) delete (patch as Dict).payout_sweep_id;
      const confirm = body.relink === true || body.reprovision === true;
      // storeStatus feeds the refusal wording for a store that is not
      // active (the decision itself reads patch.receive_payments_ok).
      const plan = patch ? planLink({ row: maa, currentEnv: env, targetEnv: linkEnv, patch, provisioned, readers, relink: confirm, storeStatus: lookup.store?.status ?? null }) : null;
      const summary = lookupSummary(lookup);
      // Exact repeats dropped, and ONE plain line per problem for the screen
      // (9 Sep 2026: a pasted account holder the Balance Platform refused was
      // in the list twice, word for word, and the owner saw "errors all over").
      const screen = goliveProblems(lookup.errors, { settingsWarning: kept.warning ?? linkSettings.warning ?? null });
      const errors = screen.raw;
      // provisioned and readers ride along so the admin portal's confirm can
      // say exactly what a flip sets aside (the store ids, N card readers);
      // keepsSetup and stashes say whether it is kept and what a flip puts
      // back (the env_stash column, 8 Sep 2026).
      const envStash = await getEnvStash();
      const base = {
        action, environment: linkEnv, previous: env, region, merchantAccount: merchant, venueCode, reference, summary, lookup, patch, plan, provisioned, readers,
        problems: screen.problems, bpRefused: screen.bpRefused, platformSettingsMissing: screen.platformSettingsMissing,
        keepsSetup: envStash.available, stashes: stashSummaries(envStash), stashWarning: envStash.warning,
        // 8 Sep 2026: what the two route lookup found out about WHERE the venue
        // lives. merchantMismatch is a warning with a way forward, never a
        // silent choice; merchantSecret names the secret the switch compares to.
        merchantSecret, merchantOverride: merchantOverride ?? null,
        merchantMismatch: lookup.merchantMismatch ?? null,
        merchantsSearched: lookup.merchantsSearched ?? [],
        storeHits: lookup.storeHits ?? [],
        storeNeeded: lookup.storeNeeded ?? null,
        balancePlatform: lookup.balancePlatform ?? null,
        balancePlatformSecret: lookup.balancePlatformSecret ?? balancePlatformSecretName(linkEnv, region),
        needsBalancePlatform: lookup.needsBalancePlatform === true,
        // Is the reference search automatic on this account yet? True once a
        // balance platform id is known for this environment and region, which
        // is what the flow reads to stop making the paste box the main path.
        balancePlatformKnown,
        holderFoundBy: lookup.holderFoundBy ?? null,
        platformSettingsWarning: kept.warning ?? linkSettings.warning ?? null,
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
      // What the daily payout column ends up as: the sweep the lookup listed
      // (or null when it listed none), else null when the money side is
      // replaced or cleared (the old sweep belonged to the old account), else
      // untouched.
      let sweepIdWrite: string | null | undefined = sweepIdPatch;
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
        // A reprovisioning flip already cleared the daily payout column
        // (flipEnvironment); only a sweep the lookup listed is written here.
      } else {
        // Same environment. A CONFIRMED replacement (conflicts, relink
        // given) that MOVES THE MONEY SIDE (balance_account_id or
        // account_holder_id) clears every id the chain did not reach, the
        // payout flag, the snapshot and the hosted onboarding link, so the
        // OLD account holder's bank account never survives under the NEW
        // balance account (8 Sep 2026). A store swap alone with the holder
        // side unreadable this time (the Balance Platform refused the key)
        // clears NOTHING: a failed read is not a new holder (9 Sep 2026).
        // Filling blanks on a first link clears nothing either (relinkClear).
        // A HOLDER ONLY SAVE KEEPS THE STORE (9 Sep 2026, link_holder): with no
        // store read, buildLinkPatch says receive_payments_ok false, which
        // would switch off the store the row already names. The store on the
        // row is what a payment names, so it, its merchant account and its
        // flag are left alone when the read reached no store at all.
        const holderOnly = !lookup.store && !!String(maa?.store_id ?? '').trim();
        if (holderOnly) delete (patch as Dict).receive_payments_ok;
        const clear: Dict = relinkClear(plan.diff, patch);
        if (holderOnly) { delete clear.receive_payments_ok; delete clear.store_id; delete clear.merchant_account; }
        const { error: linkErr, warning: regionWarning } = await upsertAccountRow({ location_id: loc.id, ...clear, ...patch, updated_at: new Date().toISOString() }, 'location_id');
        if (linkErr) return json({ ok: false, error: `link write failed: ${linkErr.message}`, ...base }, 500);
        if (regionWarning) warnings.push(regionWarning);
        if (plan.diff.conflicts.length) {
          const cleared = Object.keys(clear).filter((k) => k !== 'onboarding_link_url' && k !== 'onboarding_link_expires_at');
          if (cleared.length) warnings.push(`The previous ids were replaced; the pieces the lookup did not reach were cleared (${cleared.join(', ')}).`);
        }
        if (sweepIdWrite === undefined && Object.keys(clear).length) sweepIdWrite = null;
      }
      // The venue row's own copy of the balance platform it lives on, on its
      // own statement so an absent column never touches the link write.
      const bpOnRow = await rememberBalancePlatformOnVenue(loc.id, learnedBp);
      if (bpOnRow) warnings.push(bpOnRow);
      // The daily payout the lookup listed (or its absence), on its own
      // statement for the same reason.
      if (sweepIdWrite !== undefined) {
        const sweepWarning = await rememberPayoutSweepOnVenue(loc.id, sweepIdWrite);
        if (sweepWarning) warnings.push(sweepWarning);
      }
      if (kept.warning) warnings.push(kept.warning);
      if (errors.length) warnings.push(`Linked with gaps, ${errors.length === 1 ? 'this piece' : 'these pieces'} could not be read: ${errors.join(' ')}`);
      // A venue linked on its BUSINESS ACCOUNT alone is linked, and it cannot
      // take a card yet: the row now carries the account holder, balance
      // account, legal entity and business line with store_id still empty and
      // receive_payments_ok false. Said out loud in the warnings as well as in
      // storeNeeded, because this is the live case (8 Sep 2026).
      if (lookup.storeNeeded) warnings.push(String(lookup.storeNeeded));
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

    // ── adyen_merchants: which merchant accounts can we even see? (OWNER RULE 5) ──
    // super_admin only, read only. The live account has MORE THAN ONE and
    // nobody could see that from the portal: the secret named FranPOS_QSR_UK
    // while the venue's store sat on FranPOS_UK (8 Sep 2026, live screens).
    // One answer per configured credential set (this venue's region live set,
    // and test), each with the accounts the credential can see, a store count
    // apiece and the secret that names the configured one, so the merchant
    // picker in the portal is a plain list instead of a typed guess.
    //   GET /v3/merchants                        https://docs.adyen.com/api-explorer/Management/3/get/merchants
    //   GET /v3/merchants/{m}/stores?pageSize=1  https://docs.adyen.com/api-explorer/Management/3/get/merchants/_merchantId_/stores
    if (action === 'adyen_merchants') {
      if (!isServosAdmin) return adminOnly();
      const side = async (want: AdyenEnv) => {
        const sideCfg = want === 'live' ? liveCfg : testCfg;
        const secret = adyenSecretName(want, 'merchantAccount', region);
        const missing = [...sideCfg.missing];
        if (!sideCfg.merchantAccount && !missing.includes(secret)) missing.push(secret);
        const merchantAccount = sideCfg.merchantAccount || null;
        // A LIST needs only a key that can sign a Management call: the host is
        // fixed per environment, so no prefix and no merchant account are
        // needed. That matters, because the reason to open this list is usually
        // that the merchant account secret is missing or names the wrong
        // account. No key at all is the only thing that stops the call.
        if (!sideCfg.managementKey) {
          return {
            configured: false, secret, merchantAccount, merchants: [], capped: false, missing,
            error: `The ${region} ${want} Adyen set has no API key on the server (missing ${missing.join(', ') || adyenSecretName(want, 'apiKey', region)}), so the merchant accounts cannot be listed.`,
          };
        }
        const r = await merchantsWithStoreCounts(sideCfg);
        return {
          // `configured` is what the merchant picker reads: the set is usable.
          // The list can be there while the merchant account secret is not.
          configured: missing.length === 0, secret, merchantAccount, merchants: r.merchants, capped: r.capped, missing,
          error: r.errors.length ? r.errors.join(' ') : null,
        };
      };
      const [live, test] = await Promise.all([side('live'), side('test')]);
      // KEEP WHAT WE SAW (8 Sep 2026): the codes go onto the settings row for
      // that environment and region, so the go live flow can draw its account
      // picker with no live call. Merged, never replaced: a credential scoped
      // down between reads must not lose the account a venue is already on.
      const merchantWarnings: string[] = [];
      for (const [want, answer] of [['live', live], ['test', test]] as Array<[AdyenEnv, typeof live]>) {
        if (!answer.merchants.length) continue;
        const settings = await readPlatformSettings(want, region);
        const saved = await savePlatformSettings(want, region, settings, { merchantAccounts: answer.merchants });
        const warning = saved.warning ?? settings.warning;
        if (warning && !merchantWarnings.includes(warning)) merchantWarnings.push(warning);
      }
      console.log(`[adyen-terminal-admin] ${caller.id} adyen_merchants for ${loc.id} (${region}): live ${live.merchants.length}, test ${test.merchants.length}`);
      return json({ ok: true, action, region, environment: env, live, test, platformSettingsWarning: merchantWarnings.join(' ') || null });
    }

    // ── set_balance_platform: the one id Adyen needs per region (10 Sep 2026) ──
    // "there is no way copying and pasting codes backwards and forwards is the
    // only way to do this". With the balance platform id known for the venue's
    // environment and region, findAccountHolder pages its account holders and
    // matches the venue code, so NOTHING is pasted for any venue. The first
    // read usually learns the id on its own; when it cannot (no venue on the
    // account has been read yet), the admin types it ONCE here: the name Adyen
    // shows (FranPOS_UK) or its BP id. It is checked with GET
    // /balancePlatforms/{id} on the target set before it is kept, and the
    // flow reads the venue again straight after.
    //   { balancePlatformId, environment? }  → { ok, balancePlatformId, environment, region, replaced }
    if (action === 'set_balance_platform') {
      if (!isServosAdmin) return adminOnly();
      const targetEnv = resolveLinkEnvironment(env, body.environment);
      const targetCfg = targetEnv === 'live' ? liveCfg : testCfg;
      const given = String(body.balancePlatformId ?? body.balance_platform_id ?? body.balancePlatform ?? '').trim();
      if (!given) return json({ ok: false, error: 'Type the balance platform id first.' }, 400);
      if (!/^[A-Za-z0-9_.-]{2,80}$/.test(given)) return json({ ok: false, error: 'That does not look like a balance platform id.' }, 400);
      if (targetCfg.missing.length) {
        return json({ ok: false, error: `The ${region} ${targetEnv} Adyen set is not configured on the server, so the id could not be checked.`, detail: `missing ${targetCfg.missing.join(', ')}` }, 200);
      }
      const check = await bcl<Dict>(targetCfg, 'GET', `/balancePlatforms/${encodeURIComponent(given)}`);
      if (!check.ok) {
        const refused = scopeMissing(check.status);
        return json({
          ok: false, status: check.status,
          error: refused ? 'Our payments key was refused, so the id could not be checked.' : `Adyen does not know that balance platform on the ${region} ${targetEnv} account.`,
          detail: refusalText(targetCfg, check, 'bpKey', 'the Balance Platform BCL role'),
        }, 200);
      }
      const confirmed = String((check.data as Dict)?.id ?? '').trim() || given;
      const settings = await readPlatformSettings(targetEnv, region);
      if (!settings.available) {
        return json({ ok: false, error: 'The settings table is not there yet, so the id could not be kept.', detail: settings.warning }, 200);
      }
      const previous = String(settings.row?.balance_platform_id ?? '').trim() || null;
      const key = platformSettingsKey(targetEnv, region);
      const { error: keepErr } = await platformAdmin.from(ADYEN_PLATFORM_SETTINGS_TABLE)
        .upsert({ ...key, balance_platform_id: confirmed, updated_at: new Date().toISOString() }, { onConflict: 'environment,region' });
      if (keepErr) {
        if (isUnknownRelationError(keepErr, ADYEN_PLATFORM_SETTINGS_TABLE)) return json({ ok: false, error: 'The settings table is not there yet, so the id could not be kept.', detail: platformSettingsMissingMessage() }, 200);
        return json({ ok: false, error: 'The id was checked but could not be kept.', detail: keepErr.message }, 200);
      }
      logLink('set_balance_platform', loc.id, { environment: targetEnv, region, balancePlatformId: confirmed, previous, status: check.status });
      console.log(`[adyen-terminal-admin] ${caller.id} set_balance_platform ${confirmed} for ${region} ${targetEnv}${previous && previous !== confirmed ? ` (was ${previous})` : ''}`);
      return json({ ok: true, balancePlatformId: confirmed, environment: targetEnv, region, replaced: previous && previous !== confirmed ? previous : null });
    }

    // ── golive_state: ONE call the wizard renders (OWNER FEEDBACK, 8 Sep 2026) ──
    // "we need this to be easier and better there is far too many words and
    // too small we need a flow that supports someone doing this". The screen
    // used to assemble this from four calls (environment, adyen_lookup,
    // status, list) and decide the wording itself. It does not any more:
    // super_admin asks once and renders `steps` in order, one thing at a time.
    // Read only for the VENUE row. It DOES write adyen_platform_settings (the
    // balance platform id it learned) and the audit trail. Everything else is
    // best effort: a refusal is a line, never a 500.
    //   { venue, keys, holder, balanceAccount, legalEntity, capabilities,
    //     store, merchantConfigured, merchantMismatch, readers, origins,
    //     applePay, steps: [{ id, title, state, detail, action, hint }] }
    // The five step ids are fixed: find_venue, business_account,
    // payments_location, go_live, readers (buildGoliveSteps, _shared/adyenLink.ts).
    if (action === 'golive_state') {
      if (!isServosAdmin) return adminOnly();
      const targetEnv = resolveLinkEnvironment(env, body.environment);
      const targetCfg = targetEnv === 'live' ? liveCfg : testCfg;
      const merchantSecret = adyenSecretName(targetEnv, 'merchantAccount', region);
      // What a GO LIVE actually needs: the set's own secrets, its merchant
      // account AND the Drop-in client key (online checkout is half the venue).
      const keysMissing = [...targetCfg.missing];
      if (!targetCfg.clientKey) keysMissing.push(adyenSecretName(targetEnv, 'clientKey', region));
      if (!targetCfg.merchantAccount && !keysMissing.includes(merchantSecret)) keysMissing.push(merchantSecret);
      const keysOk = keysMissing.length === 0;
      const venueCode = await venueCodeFor(opsLocationId);
      const merchantOverride = String(body.merchantAccount ?? body.merchant_account ?? '').trim() || null;
      if (merchantOverride && !/^[A-Za-z0-9_.-]{3,80}$/.test(merchantOverride)) return json({ error: 'merchantAccount does not look like an Adyen merchant account code' }, 400);
      const pickedStoreId = String(body.storeId ?? body.store_id ?? '').trim() || null;
      const pickedHolderId = String(body.accountHolderId ?? body.account_holder_id ?? '').trim() || null;
      if (pickedStoreId && !/^ST[0-9A-Z]{10,}$/i.test(pickedStoreId)) return json({ error: 'storeId does not look like an Adyen store id (ST...)' }, 400);
      if (pickedHolderId && !/^AH[0-9A-Z]{10,}$/i.test(pickedHolderId)) return json({ error: 'accountHolderId does not look like an Adyen account holder id (AH...)' }, 400);
      const merchantConfigured = merchantOverride || effectiveMerchantAccount(targetCfg, targetEnv === env ? maa?.merchant_account : null) || null;
      // The venue code is what Adyen is searched for, unless the admin says
      // Adyen carries this venue under a different code (the reference field
      // the old dense panel had).
      const lookupReference = String(body.reference ?? '').trim().slice(0, 50) || venueCode;

      // The readers, ours to answer with no Adyen call at all: the platform
      // registry rows (processor adyen, not retired) joined on the POIID to
      // the ops link rows, and `bound` is the till the reader sits on.
      const readReaders = async (): Promise<{ readers: GoliveReader[]; error: string | null }> => {
        const [pd, td] = await Promise.all([
          platformAdmin.from('payment_devices').select('label, adyen_terminal_id, serial_number')
            .eq('location_id', loc.id).eq('processor', 'adyen').neq('status', 'retired'),
          opsAdmin.from('terminal_devices').select('label, adyen_terminal_id, serial_number, bound_pos_device_id')
            .eq('location_id', opsLocationId).not('adyen_terminal_id', 'is', null).neq('status', 'retired'),
        ]);
        if (pd.error) return { readers: [], error: `The reader list could not be read: ${pd.error.message}` };
        if (td.error) return { readers: [], error: `The till links could not be read: ${td.error.message}` };
        const byPoiid = new Map<string, GoliveReader>();
        const out: GoliveReader[] = [];
        for (const r of (pd.data || []) as Dict[]) {
          const poiid = String(r.adyen_terminal_id ?? '').trim();
          if (!poiid || byPoiid.has(poiid)) continue;
          const entry: GoliveReader = { label: String(r.label ?? '').trim() || null, serial: String(r.serial_number ?? '').trim() || null, poiid, bound: false };
          byPoiid.set(poiid, entry);
          out.push(entry);
        }
        for (const r of (td.data || []) as Dict[]) {
          const poiid = String(r.adyen_terminal_id ?? '').trim();
          if (!poiid) continue;
          const have = byPoiid.get(poiid);
          const bound = !!String(r.bound_pos_device_id ?? '').trim();
          if (have) {
            if (bound) have.bound = true;
            if (!have.label) have.label = String(r.label ?? '').trim() || null;
            if (!have.serial) have.serial = String(r.serial_number ?? '').trim() || null;
            continue;
          }
          const entry: GoliveReader = { label: String(r.label ?? '').trim() || null, serial: String(r.serial_number ?? '').trim() || null, poiid, bound };
          byPoiid.set(poiid, entry);
          out.push(entry);
        }
        return { readers: out, error: null };
      };

      const readerAnswer = await readReaders();
      const errors: string[] = [];
      const notes: string[] = [];
      if (readerAnswer.error) errors.push(readerAnswer.error);

      type OriginsProbe = Record<string, unknown> & { registered: boolean };
      type ApplePayProbe = Record<string, unknown> & { domains: string[]; verification: string | null };
      let lookup: LookupResult | null = null;
      let origins: OriginsProbe = { registered: false, wanted: [], existing: [], missing: [] };
      let applePay: ApplePayProbe = { domains: [], verification: null };
      // OUR OWN KEPT IDS. This action is read only for the VENUE; it does keep
      // what it learns about OUR Adyen account, because that is the whole point
      // of the automatic route: the first venue pastes its account holder id,
      // the balance platform id behind it is kept here, and every venue after
      // it is found by its reference with nothing typed (8 Sep 2026).
      const settings = await readPlatformSettings(targetEnv, region);
      const storedBp = String(settings.row?.balance_platform_id ?? '').trim() || null;
      if (keysOk && merchantConfigured) {
        const linkCurrency = region === 'US' ? 'USD' : 'GBP';
        // The row's ids belong to the environment the venue is on NOW, so they
        // only bootstrap the search when the target IS that environment. The
        // credential wide sweep is opt in (body.sweep): the automatic read on
        // every expand must not spend 70+ Adyen calls (8 Sep 2026).
        lookup = await lookupByReference(targetCfg, merchantConfigured, lookupReference, {
          storeId: pickedStoreId,
          accountHolderId: pickedHolderId,
          currency: linkCurrency,
          balancePlatform: String(body.balancePlatform ?? body.balance_platform ?? '').trim() || null,
          storedBalancePlatform: storedBp,
          merchantSecret, merchantOverride: !!merchantOverride,
          row: targetEnv === env ? (maa as Dict | null) : null,
          sweep: body.sweep === true,
        });
        errors.push(...(Array.isArray(lookup.errors) ? lookup.errors : []));
        notes.push(...(Array.isArray(lookup.notes) ? lookup.notes : []));
        let storefront: Storefront = { slug: null, customDomain: null };
        try { storefront = await storefrontFor(loc.id); } catch (e) { errors.push(`The venue's online address could not be read: ${(e as Error)?.message || String(e)}`); }
        const storeIdNow = String((lookup.store as Dict | null)?.id ?? (targetEnv === env ? maa?.store_id : '') ?? '').trim() || null;
        // Both probes always answer: a throw becomes that probe's own error
        // line, so one refused read never takes the whole screen down.
        const [o, a] = await Promise.all([
          (async (): Promise<OriginsProbe> => {
            try { return await probeWebOrigins(targetCfg, storefront.customDomain); }
            catch (e) { return { registered: false, wanted: [], existing: [], missing: [], error: `web origins: ${(e as Error)?.message || String(e)}` }; }
          })(),
          (async (): Promise<ApplePayProbe> => {
            try { return await probeApplePay(targetCfg, merchantConfigured, storeIdNow, storefront); }
            catch (e) { return { domains: [], verification: null, error: `Apple Pay: ${(e as Error)?.message || String(e)}` }; }
          })(),
        ]);
        origins = o;
        applePay = a;
      } else if (!keysOk) {
        notes.push(`Nothing was read from Adyen: the ${region} ${targetEnv} set is missing ${keysMissing.join(', ')}.`);
      } else {
        notes.push(`Nothing was read from Adyen: no merchant account is known for the ${region} ${targetEnv} account (${merchantSecret}).`);
      }

      // ── step 5, Card rates and payouts (9 and 10 Sep 2026) ─────────────────
      // The venue's RATE CARD as the ledger resolves it (every tier, venue
      // card else platform default), what the profile on the store actually
      // says, our liable account if we know it, and the sweep the lookup
      // listed. The row's ids ride only on the venue's own environment, as
      // for step 3.
      // A venue with NO row yet on its own environment is `{}` (a row with
      // nothing on it), never null: null means the OTHER environment, and
      // step 5 offers nothing there (buildPayoutsStep).
      const rowNow: Dict | null = targetEnv === env ? ((maa as Dict | null) ?? {}) : null;
      const stepCurrency = region === 'US' ? 'USD' : 'GBP';
      // THE RESOLVED CARD, never the venue row alone (10 Sep 2026: a venue on
      // the platform default was shown as flat because only the row's own
      // rate_card was looked at). The four tiers ride with one source word
      // each, and `unpriced` names the tiers with no price at all.
      const venueRates = await readVenueRates(loc.id, maa as Dict | null);
      errors.push(...venueRates.errors);
      const rateTiers = tiersFromResolved(venueRates.cards);
      const unpriced = unpricedTiers(rateTiers);
      const profileId = String((lookup?.store as StoreSummary | null)?.splitConfigurationId ?? '').trim();
      let profileRead: ProfileRead = { raw: null, read: false, error: null };
      if (profileId && keysOk && merchantConfigured) {
        profileRead = await readProfileRates(targetCfg, merchantConfigured, profileId);
        if (profileRead.error) errors.push(profileRead.error);
      }
      const onAdyen = ratesOnAdyen(profileRead.raw, rateTiers);
      const liableBalanceAccountId = await readLiableBalanceAccount(targetEnv, region);
      const rates = {
        currency: stepCurrency,
        tiers: rateTiers,
        priced: unpriced.length === 0,
        unpriced,
        line: unpriced.length ? null : rateCardLine(rateTiers, stepCurrency),
        onAdyen: { profileId: profileId || null, read: profileRead.read, ...onAdyen },
        liableBalanceAccountId, liableSecret: liableBalanceAccountSecretName(targetEnv, region),
      };
      const payoutsState = { read: lookup?.sweepKnown === true, sweep: lookup?.sweep ?? null };
      // THE VENUE ROW WRITES this action makes, on the venue's own environment
      // and only for the holder the row names: payouts_ok follows the
      // CAPABILITY just read (Adyen allows payouts), and payout_sweep_id
      // follows the sweeps just listed (the daily push to the venue's bank,
      // or null when there is none). The list chip reads the two together.
      let payoutsSynced: boolean | null = null;
      let sweepSynced: string | null | undefined = undefined;
      const sweepOnRow = rowNow ? await readPayoutSweepId(loc.id) : { id: null, available: false };
      const holderRead = lookup?.accountHolder as AccountHolderSummary | null;
      if (rowNow && holderRead?.id && String(rowNow.account_holder_id ?? '').trim() === holderRead.id) {
        const allowed = holderRead.capabilities?.payoutsOk === true;
        if ((rowNow.payouts_ok === true) !== allowed) {
          const { error: syncErr } = await platformAdmin.from('merchant_adyen_accounts').update({ payouts_ok: allowed, updated_at: new Date().toISOString() }).eq('location_id', loc.id);
          if (syncErr) notes.push(`The payout flag could not be updated on the venue: ${syncErr.message}`);
          else { payoutsSynced = allowed; rowNow.payouts_ok = allowed; }
        }
        if (lookup?.sweepKnown === true) {
          const sweepId = String((lookup?.sweep as Dict | null)?.id ?? '').trim() || null;
          if (!sweepOnRow.available || sweepOnRow.id !== sweepId) {
            const sweepWarning = await rememberPayoutSweepOnVenue(loc.id, sweepId);
            if (sweepWarning) notes.push(sweepWarning);
            else sweepSynced = sweepId;
          }
        }
      }
      const payoutSweepOnRow = sweepSynced !== undefined ? sweepSynced : sweepOnRow.id;

      // Keep the balance platform id this read learned, so the NEXT venue on
      // this account is found by its reference with nothing pasted.
      const learnedBp = learnedBalancePlatform(lookup);
      const kept = await savePlatformSettings(targetEnv, region, settings, { balancePlatformId: learnedBp });
      const settingsWarning = kept.warning ?? settings.warning ?? null;
      if (settingsWarning) notes.push(settingsWarning);
      const balancePlatformKnown = !!(learnedBp || storedBp || balancePlatformFromSecret(targetEnv, region));
      // ONE PLAIN LINE PER PROBLEM (9 Sep 2026). Exact repeats are dropped, the
      // Balance Platform refusal is ONE fact the business account step says
      // (bpRefused), the settings table waiting on its migration is ONE short
      // line at the top of the flow (platformSettingsMissing), and everything
      // else is a plain line under 120 characters with the raw Adyen answer
      // behind it in rawDetail.
      const screen = goliveProblems(errors, { settingsWarning });
      const bpSecret = adyenSecretName(targetEnv, 'bpKey', region);
      const state = {
        venue: { name: loc.name ?? null, code: lookupReference, region, environment: env },
        keys: { configured: keysOk, missing: keysMissing },
        // What taking REAL money needs, whichever account was just read: the
        // go live step reads this, so a test read never says "ready to go live".
        liveKeys: { configured: liveReady, missing: liveMissing },
        holder: (lookup?.accountHolder as AccountHolderSummary | null) ?? null,
        balanceAccount: (lookup?.balanceAccount as BalanceAccountSummary | null) ?? null,
        legalEntity: lookup?.legalEntity ?? null,
        capabilities: (lookup?.capabilities as CapabilityRow[] | undefined) ?? [],
        store: (lookup?.store as StoreSummary | null) ?? null,
        merchantConfigured,
        merchantMismatch: lookup?.merchantMismatch ?? null,
        readers: readerAnswer.readers,
        origins,
        applePay,
        // A FOUND STORE IS NOT A LINKED STORE (9 Sep 2026, live screen: the
        // store was found at Adyen, step 3 said done, and the venue row still
        // held store_id NULL). The row's ids on the environment the flow looks
        // at ride in, so the step builder can tell the two apart and offer to
        // save the store (link_store). Null when the flow looks at the OTHER
        // environment: those ids belong to the one the venue is on, and the go
        // live flip writes the new ones.
        row: rowNow
          ? {
            store_id: rowNow.store_id ?? null, merchant_account: rowNow.merchant_account ?? null, account_holder_id: rowNow.account_holder_id ?? null,
            balance_account_id: rowNow.balance_account_id ?? null, legal_entity_id: rowNow.legal_entity_id ?? null,
            split_profile_id: rowNow.split_profile_id ?? null, transfer_instrument_id: rowNow.transfer_instrument_id ?? null,
            payouts_ok: rowNow.payouts_ok === true, payout_sweep_id: payoutSweepOnRow,
            markup_percent: rowNow.markup_percent ?? null, markup_fixed_pence: rowNow.markup_fixed_pence ?? null,
          }
          : null,
        // Step 5 (CARD RATES AND PAYOUTS): the venue rate card, what the
        // profile on the store holds, our liable account, and the push to
        // bank sweep. `commission` is the old name, the same object, kept
        // for one release.
        rates,
        commission: rates,
        payouts: payoutsState,
        // THE ONE PLAIN REASON: the Balance Platform refused our key, and the
        // secret the separate credential goes in (the name, never a value).
        balancePlatformKey: { refused: screen.bpRefused, secret: bpSecret },
        // What the STORE search came back with when no store was resolved,
        // so step 1 never says "nothing carries the code" while the box says
        // the list was refused or that two stores carry it (rule 6).
        storeRead: {
          refused: lookup?.storeScopeMissing === true && !lookup?.store,
          ambiguous: (lookup?.storeHits ?? []).length > 1,
        },
      };
      // The VENUE row's ids are not touched here: adyen_link writes them, and
      // link_store and link_holder on the screen are that same call with the
      // store id or the account holder id this read found. The one exception
      // is the payouts_ok flag above, kept in step with what was read.

      // The target rides in: the venue's readers belong to the environment it
      // is on now, so they are never "done" for a flow looking at the other.
      const steps: GoliveStep[] = buildGoliveSteps(state, { target: targetEnv });
      console.log(`[adyen-terminal-admin] ${caller.id} golive_state for ${loc.id} (${region} ${targetEnv}, venue on ${env}, sweep ${body.sweep === true}): ${steps.map((x) => `${x.id}=${x.state}`).join(' ')}`);
      // Every read is written to the audit trail, so a "nothing happened"
      // screen can be answered from the server instead of by asking the
      // operator to click again (8 Sep 2026: a pasted account holder id
      // redrew the same screen and the refusal was only in `errors`, which
      // sat behind a toggle).
      logLink('golive_state', loc.id, {
        environment: targetEnv, region, venueOn: env,
        merchantFromSecret: targetCfg.merchantAccount || null,
        merchantUsed: merchantOverride ?? targetCfg.merchantAccount ?? null,
        reference: lookupReference, pickedHolderId, pickedStoreId,
        merchantsSearched: lookup?.merchantsSearched ?? [],
        found: lookup?.found ?? null, holderFoundBy: lookup?.holderFoundBy ?? null,
        steps: steps.map((x) => `${x.id}=${x.state}`).join(' '),
        errors: screen.raw, notes,
      });
      return json({
        ok: true, action, ...state, steps,
        target: targetEnv, merchantSecret, merchantOverride: merchantOverride ?? null,
        swept: body.sweep === true,
        payoutsSynced,
        payoutSweepSynced: sweepSynced ?? null,
        // merchantConfigured is the account the reads above actually used; this
        // is what the SECRET names. They differ only when the admin passed an
        // override, and merchantMismatch is the case that makes them differ on
        // purpose (live, 8 Sep 2026: the secret names FranPOS_QSR_UK and the
        // venue's store lives on FranPOS_UK).
        merchantFromSecret: targetCfg.merchantAccount || null,
        reference: lookupReference, venueCode, summary: lookup ? lookupSummary(lookup) : null,
        storeNeeded: lookup?.storeNeeded ?? null,
        candidates: lookup?.candidates ?? [],
        holderCandidates: lookup?.holderCandidates ?? [],
        merchantsSearched: lookup?.merchantsSearched ?? [],
        storeHits: lookup?.storeHits ?? [],
        balancePlatform: lookup?.balancePlatform ?? null,
        balancePlatformSecret: lookup?.balancePlatformSecret ?? balancePlatformSecretName(targetEnv, region),
        needsBalancePlatform: lookup?.needsBalancePlatform === true,
        // THE TWO THE FLOW READS (8 Sep 2026). balancePlatformKnown says the
        // reference search runs by itself on this account, so the flow stops
        // making the paste box the main path; holderFoundBy says how THIS read
        // reached the account holder, so a venue found by its reference with
        // nothing pasted is said out loud in one line.
        balancePlatformKnown,
        holderFoundBy: lookup?.holderFoundBy ?? null,
        // The merchant accounts we have SEEN on this account, kept from the
        // last adyen_merchants, so the picker can draw with no live call.
        merchantAccountsKnown: merchantAccountsSeen(settings.row?.merchant_accounts),
        platformSettingsWarning: settingsWarning,
        // THE SCREEN READS THESE, not errors and notes (9 Sep 2026): one plain
        // line per problem with the raw answer in rawDetail, and the two
        // facts said in their own place (the business account step, the top
        // line of the flow) so the box under the steps never repeats them.
        problems: screen.problems,
        bpRefused: screen.bpRefused,
        platformSettingsMissing: screen.platformSettingsMissing,
        blockedCapabilities: blockedCapabilityNames(state.capabilities),
        readers_error: readerAnswer.error,
        // The raw lines, exact repeats dropped, for the audit trail and Show
        // detail; never drawn as they are.
        errors: screen.raw, notes,
      });
    }

    // The row's name wins, unless it names the OTHER environment's secret
    // account (a row flipped before set_environment rewrote it).
    const merchant = effectiveMerchantAccount(cfg, maa?.merchant_account);
    if (!merchant) return json({ error: `no merchant account configured for card payments (${adyenSecretName(cfg.env, 'merchantAccount', cfg.region)})` }, 500);

    // ── STEP 5, CARD RATES AND PAYOUTS (9 and 10 Sep 2026) ───────────────────
    // Three super_admin writes on the venue's OWN environment and merchant,
    // each ONE click on the go live flow. The calls live in
    // _shared/adyenPayouts.ts, shared with adyen-onboard. Every refusal is a
    // 200 with ok false, a plain `error` and the raw answer in `detail`.
    const payoutApi: AdyenApi = {
      mgmt: (m: string, p: string, b?: unknown) => mgmt<Dict>(cfg, m, p, b),
      bcl: (m: string, p: string, b?: unknown, idem?: string) => bcl<Dict>(cfg, m, p, b, idem),
    };
    const stepCurrency = region === 'US' ? 'USD' : 'GBP';
    const stepPlainErrors = {
      noStore: 'The payments location is not saved on the venue yet. Do step 3 first.',
      noHolder: 'The business account is not saved on the venue yet. Do step 2 first.',
    };
    // THE ENVIRONMENT THE SCREEN IS LOOKING AT must be the one the venue is on
    // (9 Sep 2026): the flow looks at live by default while a test venue is
    // still on test, and these writes act on the venue's OWN row and account,
    // so a click there would set a commission on the test store, mint a bank
    // details link for the test legal entity or sweep the test balance
    // account. The screen names the environment it looks at; a different one
    // is refused in plain words. No environment given is the venue's own.
    const envGuard = (): Response | null => {
      const asked = body.environment;
      if (asked === undefined || asked === null || String(asked).trim() === '') return null;
      const want = normalizeAdyenEnv(asked);
      if (want === env) return null;
      return json({
        ok: false, wrong_environment: true, environment: env, asked: want,
        error: want === 'live' ? 'This venue is still on test cards. Turn on live payments first.' : 'This venue is on live cards. This step only acts on the account it is on.',
      }, 200);
    };

    // ── set_split: the venue's card rates on its store (step 5a) ─────────────
    // ONE RULE PER PAYMENT TYPE, from the SAME source the ledger charges
    // (readVenueRates, resolveAdyenRateCard): the venue's rate card, else the
    // platform default. NO NUMBERS IN THE BODY (10 Sep 2026, OWNER RULE: "we
    // set the rate that customers get charged for the different card types");
    // a body carrying percent or fixedPence is refused, and a tier with no
    // price refuses in plain words naming the tiers. A tier priced 0% and 0p
    // is written as a rule with no commission block. The legacy markup
    // columns are read only from now on: nothing here writes them.
    // Nothing is written on the row until Adyen has accepted the profile AND
    // put it on the store; a refused set leaves the row exactly as it was.
    // Before any write the store is read (it must sit on the merchant the row
    // names, and its own merchant is the one both calls use) and the balance
    // account is read (it must belong to the venue's own account holder), so
    // money is never routed to another company's account.
    if (action === 'set_split') {
      if (!isServosAdmin) return adminOnly();
      const wrongEnv = envGuard();
      if (wrongEnv) return wrongEnv;
      if (body.percent !== undefined || body.fixedPence !== undefined || body.fixed_pence !== undefined) {
        return json({ ok: false, error: 'Rates are set per payment type on the venue rate card.' }, 400);
      }
      const storeId = String(maa?.store_id ?? '').trim();
      const balanceAccountId = String(maa?.balance_account_id ?? '').trim();
      const holderId = String(maa?.account_holder_id ?? '').trim();
      if (!storeId) return json({ ok: false, error: stepPlainErrors.noStore }, 200);
      if (!balanceAccountId || !holderId) return json({ ok: false, error: stepPlainErrors.noHolder }, 200);
      const venueRates = await readVenueRates(loc.id, maa as Dict | null);
      const warnings: string[] = [...venueRates.errors];
      const cards = venueRates.cards;
      const rateTiers = tiersFromResolved(cards);
      const tiers = tiersForProfile(cards);
      const built = tieredCommissionRules(stepCurrency, tiers);
      if (built.lacking.length) {
        return json({
          ok: false, lacking: built.lacking,
          error: `No rate is set for ${tierListWords(built.lacking)}. Set the venue rate card in Processing first.`,
        }, 200);
      }
      // The store, as it is now: on which merchant, and what it carries.
      const storeRead = await mgmt<Dict>(cfg, 'GET', `/stores/${encodeURIComponent(storeId)}`);
      if (!storeRead.ok) {
        return json({ ok: false, error: 'The payments location could not be read, so the rates were not applied.', detail: refusalText(cfg, storeRead, 'managementKey', 'the Management API role "Stores read"') }, 200);
      }
      const storeNow = storeSummary(storeRead.data);
      const storeMerchant = String(storeNow?.merchantId ?? '').trim();
      if (storeMerchant && storeMerchant.toLowerCase() !== merchant.toLowerCase()) {
        return json({ ok: false, error: 'The payments location sits on a different Adyen account than the venue names, so the rates were not applied.', detail: `store ${storeId} is on ${storeMerchant}; the venue row names ${merchant}. Fix the venue's merchant account in step 3.` }, 200);
      }
      const useMerchant = storeMerchant || merchant;
      // Where the money lands must be the venue's own business account's.
      const baRead = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(balanceAccountId)}`);
      if (!baRead.ok) {
        return json({ ok: false, error: 'Where the money lands could not be checked, so the rates were not applied.', detail: refusalText(cfg, baRead, 'bpKey', 'the Balance Platform BCL role') }, 200);
      }
      const baHolder = String(baRead.data?.accountHolderId ?? '').trim();
      if (baHolder !== holderId) {
        logLink('set_split_refused', loc.id, { environment: env, region, storeId, balanceAccountId, balanceAccountHolder: baHolder || null, rowHolder: holderId });
        return json({ ok: false, foreign_balance_account: true, error: 'Where the money lands is not the venue’s own business account, so the rates were not applied.', detail: `balance account ${balanceAccountId} belongs to account holder ${baHolder || '(none)'}; the venue names ${holderId}. Save the business account again in step 2.` }, 200);
      }
      const profile = buildTieredProfile({ description: `ServOS ${loc.name ?? 'venue'} rates`, currency: stepCurrency, tiers });
      if (!profile) return json({ ok: false, error: 'No rate is set for any payment type. Set the venue rate card in Processing first.' }, 200);
      const previousProfileId = String(maa?.split_profile_id ?? '').trim() || storeNow?.splitConfigurationId || null;
      const split = await createSplitOnStore(payoutApi, { merchant: useMerchant, storeId, balanceAccountId, profile, previousProfileId });
      logLink('set_split', loc.id, {
        environment: env, region, merchant: useMerchant, storeId, balanceAccountId,
        tiers: rateTiers, rules: profile.rules.length, stage: split.stage, httpStatus: split.status, splitConfigurationId: split.splitConfigurationId,
        created: split.created, patched: split.patched, previousProfileId: split.previousProfileId, orphanDeleted: split.orphanDeleted,
      });
      if (!split.ok) {
        const raw = split.stage === 'create' ? split.created : split.patched;
        const refused = scopeMissing(split.status);
        const orphan = split.stage === 'patch'
          ? (split.orphanDeleted === true ? ' The rules that were made have been removed again.' : ' The rules that were made are still on the Adyen account, unused.')
          : '';
        return json({
          ok: false, stage: split.stage, splitConfigurationId: split.splitConfigurationId, orphanDeleted: split.orphanDeleted,
          error: refused
            ? 'Our payments key is missing an Adyen permission, so the rates were not applied.'
            : split.stage === 'create' ? 'Adyen would not take the rates.' : `The rates were made, but Adyen would not put them on the payments location.${orphan}`,
          detail: refused
            ? `refused (${split.status}): the credential behind ${adyenSecretName(cfg.env, 'managementKey', cfg.region)} needs the Management API roles "SplitConfiguration read and write" and "Stores read and write"`
            : adyenRefusalMessage(split.status, raw),
        }, 200);
      }
      // ONLY NOW the row, and ONLY the profile id: the rates themselves live
      // on the venue rate card (or the platform default) and were never typed
      // here, and the legacy markup columns are never written again.
      const { error: stampErr, warning: stampWarning } = await upsertAccountRow({ location_id: loc.id, split_profile_id: split.splitConfigurationId, updated_at: new Date().toISOString() });
      if (stampErr) warnings.push(`The rates are on Adyen but the venue row could not be updated: ${stampErr.message}`);
      if (stampWarning) warnings.push(stampWarning);
      const line = rateCardLine(rateTiers, stepCurrency);
      console.log(`[adyen-terminal-admin] ${caller.id} set_split for ${loc.id} on ${useMerchant} (${region} ${env}): ${split.splitConfigurationId} (${profile.rules.length} rules) on ${storeId} to ${balanceAccountId}, ${line}`);
      return json({
        ok: true, splitConfigurationId: split.splitConfigurationId, storeId, balanceAccountId,
        rules: profile.rules.length, tiers: rateTiers, line, previousProfileId: split.previousProfileId,
        warnings, warning: warnings.join(' ') || null,
      });
    }

    // ── request_payouts: ask Adyen for the payout capability (step 5b) ────────
    // Adyen only checks a capability that was REQUESTED, so a holder made
    // without sendToTransferInstrument can never become allowed on its own.
    // One PATCH asks for it; Adyen then runs its checks and the flow reads
    // the answer on the next look.
    //   PATCH /accountHolders/{id}   { capabilities: { sendToTransferInstrument: { requested: true } } }
    if (action === 'request_payouts') {
      if (!isServosAdmin) return adminOnly();
      const wrongEnv = envGuard();
      if (wrongEnv) return wrongEnv;
      const holderId = String(maa?.account_holder_id ?? '').trim();
      if (!holderId) return json({ ok: false, error: stepPlainErrors.noHolder }, 200);
      const r = await bcl<Dict>(cfg, 'PATCH', `/accountHolders/${encodeURIComponent(holderId)}`, { capabilities: { [PAYOUT_CAPABILITY]: { requested: true } } });
      logLink('request_payouts', loc.id, { environment: env, region, holderId, httpStatus: r.status, response: r.ok ? { capabilities: capabilityList(summariseCapabilities(r.data?.capabilities)) } : (r.data ?? null) });
      if (!r.ok) return json({ ok: false, error: 'Adyen would not take the request for payouts.', detail: refusalText(cfg, r, 'bpKey', 'the Balance Platform BCL role') }, 200);
      const caps = summariseCapabilities(r.data?.capabilities);
      const { error: snapErr, warning: snapWarning } = await upsertAccountRow({
        location_id: loc.id, payouts_ok: caps.payoutsOk,
        verification_status: { source: 'request_payouts', at: new Date().toISOString(), accountHolderStatus: r.data?.status ?? null, verificationStatus: caps.verificationStatus, capabilities: caps.byName },
        updated_at: new Date().toISOString(),
      });
      const warnings = [snapWarning, snapErr ? `Adyen took the request but the venue row could not be updated: ${snapErr.message}` : null].filter((w): w is string => !!w);
      const entry = caps.byName[PAYOUT_CAPABILITY] ?? null;
      console.log(`[adyen-terminal-admin] ${caller.id} request_payouts for ${loc.id} (${region} ${env}): ${holderId} requested, allowed ${caps.payoutsOk}, verification ${entry?.verificationStatus ?? 'none'}`);
      return json({ ok: true, requested: true, allowed: caps.payoutsOk, verificationStatus: entry?.verificationStatus ?? null, warnings, warning: warnings.join(' ') || null });
    }

    // ── onboarding_link: the bank details link for the venue owner (step 5b) ──
    // POST /legalEntities/{id}/onboardingLinks (LEM v4; every body field is
    // optional). The url works ONCE and for 4 MINUTES, so it is minted on the
    // click and shown at once with Copy; it is kept on the row the way
    // adyen-onboard keeps it, and never logged.
    if (action === 'onboarding_link') {
      if (!isServosAdmin) return adminOnly();
      const wrongEnv = envGuard();
      if (wrongEnv) return wrongEnv;
      const legalEntityId = String(maa?.legal_entity_id ?? '').trim();
      if (!legalEntityId) return json({ ok: false, error: stepPlainErrors.noHolder }, 200);
      const redirect = String(body.redirectUrl ?? body.redirect_url ?? '').trim();
      if (redirect && !/^https:\/\/[^\s]+$/i.test(redirect)) return json({ error: 'redirectUrl must be an https address' }, 400);
      const payload = { redirectUrl: redirect || ONBOARDING_REDIRECT_URL, locale: region === 'US' ? 'en-US' : 'en-GB' };
      const r = await lem<Dict>(cfg, 'POST', `/legalEntities/${encodeURIComponent(legalEntityId)}/onboardingLinks`, payload);
      const url = String(r.data?.url ?? '').trim();
      logLink('onboarding_link', loc.id, { environment: env, region, legalEntityId, httpStatus: r.status, minted: r.ok && !!url, response: r.ok ? { url: 'minted' } : (r.data ?? null) });
      if (!r.ok || !url) {
        return json({ ok: false, error: 'Adyen would not make the bank details link.', detail: refusalText(cfg, r, 'lemKey', 'the roles "Manage LegalEntities via API" and "Onboarding"') }, 200);
      }
      const expiresAt = new Date(Date.now() + ONBOARDING_LINK_TTL_MS).toISOString();
      const { error: keepErr, warning: keepWarning } = await upsertAccountRow({ location_id: loc.id, onboarding_link_url: url, onboarding_link_expires_at: expiresAt, updated_at: new Date().toISOString() });
      const warnings = [keepWarning, keepErr ? `The link was made but could not be kept on the venue: ${keepErr.message}` : null].filter((w): w is string => !!w);
      return json({ ok: true, url, expiresAt, legalEntityId, warnings, warning: warnings.join(' ') || null });
    }

    // ── setup_sweep: pay the venue out daily (step 5b) ────────────────────────
    // Adyen's approval is read NOW (the row's snapshot may be old), the BANK
    // is chosen from that same read (pickPayoutInstrument: the approved bank
    // an active push sweep already names, else the row's, else the first
    // approved one; never simply the oldest one the legal entity lists), the
    // balance account must be this holder's own, and the sweep is the shared
    // ensurePushSweep: one sweep, repointed rather than doubled. On success
    // payouts_ok (the capability) and payout_sweep_id (PAID OUT) are written.
    if (action === 'setup_sweep') {
      if (!isServosAdmin) return adminOnly();
      const wrongEnv = envGuard();
      if (wrongEnv) return wrongEnv;
      const balanceAccountId = String(maa?.balance_account_id ?? '').trim();
      const holderId = String(maa?.account_holder_id ?? '').trim();
      if (!balanceAccountId || !holderId) return json({ ok: false, error: stepPlainErrors.noHolder }, 200);
      const h = await bcl<Dict>(cfg, 'GET', `/accountHolders/${encodeURIComponent(holderId)}`);
      if (!h.ok) return json({ ok: false, error: 'The business account could not be read, so payouts were not switched on.', detail: refusalText(cfg, h, 'bpKey', 'the Balance Platform BCL role') }, 200);
      const caps = summariseCapabilities(h.data?.capabilities);
      if (!caps.payoutsOk) {
        return json({ ok: false, pending: true, error: 'Adyen has not approved payouts for this venue yet. Check again later.', verificationStatus: caps.verificationStatus ?? null }, 200);
      }
      // Where the money lands must be this holder's, or the sweep would pay
      // another company's balance to this venue's bank (or the reverse).
      const baRead = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(balanceAccountId)}`);
      if (!baRead.ok) return json({ ok: false, error: 'Where the money lands could not be checked, so payouts were not switched on.', detail: refusalText(cfg, baRead, 'bpKey', 'the Balance Platform BCL role') }, 200);
      const baHolder = String(baRead.data?.accountHolderId ?? '').trim();
      if (baHolder !== holderId) {
        return json({ ok: false, foreign_balance_account: true, error: 'Where the money lands is not the venue’s own business account, so payouts were not switched on.', detail: `balance account ${balanceAccountId} belongs to account holder ${baHolder || '(none)'}; the venue names ${holderId}. Save the business account again in step 2.` }, 200);
      }
      // The sweeps as they are now, and the registered company's banks as the
      // fallback pool when the capability lists none.
      const sweepsNow = await bcl<Dict>(cfg, 'GET', `/balanceAccounts/${encodeURIComponent(balanceAccountId)}/sweeps`);
      if (!sweepsNow.ok) return json({ ok: false, error: 'The payout schedule could not be read, so payouts were not switched on.', detail: refusalText(cfg, sweepsNow, 'bpKey', 'the Balance Platform BCL role') }, 200);
      const legalEntityId = String(maa?.legal_entity_id ?? '').trim();
      let legalEntityInstruments: string[] = [];
      const warnings: string[] = [];
      if (legalEntityId) {
        const le = await lem<Dict>(cfg, 'GET', `/legalEntities/${encodeURIComponent(legalEntityId)}`);
        if (le.ok) legalEntityInstruments = legalEntitySummary(le.data)?.transferInstruments ?? [];
        else warnings.push(`The registered company could not be read (${refusalText(cfg, le, 'lemKey', 'the roles "Manage LegalEntities via API" and "Balance Platform BCL Legal Entity role"')}), so only the banks Adyen has approved were considered.`);
      }
      const pick = pickPayoutInstrument(h.data?.capabilities, {
        sweeps: sweepsNow.data, rowTransferInstrumentId: maa?.transfer_instrument_id ?? null, legalEntityInstruments,
      });
      if (!pick) return json({ ok: false, error: 'The venue has not added an approved bank account yet. Send the bank details link first.' }, 200);
      const transferInstrumentId = pick.transferInstrumentId;
      const outcome = await ensurePushSweep(payoutApi, {
        balanceAccountId, transferInstrumentId, currency: stepCurrency, schedule: 'daily',
        description: `ServOS daily payout, ${loc.name ?? 'venue'}`,
        // The key names the BANK: a create for a different bank inside Adyen's
        // replay window is a new request, never a replay of the old one.
        idempotencyKey: `sweep:${cfg.env}:${loc.id}:${transferInstrumentId}`,
      });
      logLink('setup_sweep', loc.id, {
        environment: env, region, balanceAccountId, transferInstrumentId, bankChosenBy: pick.source, stage: outcome.stage, httpStatus: outcome.status,
        sweep: outcome.sweep, created: outcome.created, existed: outcome.existed, updated: outcome.updated, retargeted: outcome.retargeted, deactivated: outcome.deactivated, response: outcome.data ?? null,
      });
      if (!outcome.ok || !outcome.sweep?.id) {
        return json({ ok: false, stage: outcome.stage, error: outcome.stage === 'update' ? 'Adyen would not change the payout that is already there, so nothing was made.' : 'Adyen would not set up the daily payout.', detail: adyenRefusalMessage(outcome.status, outcome.data) }, 200);
      }
      const { error: stampErr, warning: stampWarning } = await upsertAccountRow({ location_id: loc.id, payouts_ok: true, transfer_instrument_id: transferInstrumentId, updated_at: new Date().toISOString() });
      if (stampWarning) warnings.push(stampWarning);
      if (stampErr) warnings.push(`The payout is set up at Adyen but the venue row could not be updated: ${stampErr.message}`);
      const sweepWarning = await rememberPayoutSweepOnVenue(loc.id, outcome.sweep.id);
      if (sweepWarning) warnings.push(sweepWarning);
      console.log(`[adyen-terminal-admin] ${caller.id} setup_sweep for ${loc.id} (${region} ${env}): sweep ${outcome.sweep.id} ${outcome.created ? 'created' : outcome.retargeted ? 'repointed' : outcome.updated ? 'updated' : 'existed'} on ${balanceAccountId} to ${transferInstrumentId} (${pick.source})${outcome.deactivated.length ? `, ${outcome.deactivated.length} other switched off` : ''}`);
      return json({
        ok: true, sweep: outcome.sweep, created: outcome.created, existed: outcome.existed, updated: outcome.updated,
        retargeted: outcome.retargeted, deactivated: outcome.deactivated, transferInstrumentId, bankChosenBy: pick.source,
        warnings, warning: warnings.join(' ') || null,
      });
    }

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
      // MERCHANT OVERRIDE (8 Sep 2026, OWNER RULE 4): the venue's store may
      // belong on a merchant account the secret does not name (live:
      // FranPOS_UK, not FranPOS_QSR_UK). adyen_lookup reports that as
      // merchantMismatch; body.merchantAccount is the admin saying "create it
      // there", and the same name goes on the row so every terminal call
      // afterwards uses it.
      const storeMerchantOverride = String(body.merchantAccount ?? body.merchant_account ?? '').trim() || null;
      if (storeMerchantOverride && !/^[A-Za-z0-9_.-]{3,80}$/.test(storeMerchantOverride)) return json({ error: 'merchantAccount does not look like an Adyen merchant account code' }, 400);
      const storeMerchant = storeMerchantOverride || (crossEnv ? effectiveMerchantAccount(storeCfg, null) : merchant);
      // The mapped store belongs to the venue's CURRENT environment, so it
      // only answers "existing" on that environment: a test venue asking
      // for its live store is never handed its test store id.
      // An override means "look on THAT account": the mapped store id is the
      // one on the configured account, so it is not the answer.
      const sameMerchant = !storeMerchantOverride || storeMerchantOverride.toLowerCase() === String(maa?.merchant_account ?? merchant).toLowerCase();
      if (maa?.store_id && !crossEnv && sameMerchant) return json({ ok: true, storeId: maa.store_id, existing: true, foundByReference: false, mapped: true, environment: env, region });
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
            merchantAccount: storeMerchant, merchantOverride: storeMerchantOverride ?? null,
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
      // A merchant with more than one business line REFUSES a store that names
      // none (docs.adyen.com, POST /merchants/{m}/stores). The venue's own line
      // is on its row, put there by adyen_link from the legal entity's
      // paymentProcessing line, and it belongs to the SAME Adyen environment,
      // so it only rides when the store is created on that environment.
      const rowBusinessLine = !crossEnv ? String(maa?.business_line_id ?? '').trim() : '';
      if (rowBusinessLine) payload.businessLineIds = [rowBusinessLine];
      const r = await mgmt(storeCfg, 'POST', `/merchants/${storeMerchant}/stores`, payload);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) {
        const detail = String((r.data as Record<string, unknown>)?.detail || (r.data as Record<string, unknown>)?.title || `store create failed (${r.status})`);
        // A platform merchant with more than one business line refuses a store
        // that names none, and the message from Adyen does not say where to
        // get one (8 Sep 2026).
        const hint = !rowBusinessLine ? `This venue's row holds no business line. Link the venue to Adyen first: the link reads the legal entity's payment processing line and writes it on the venue, and the store then names it.` : null;
        return json({ ok: false, error: detail, hint, merchantAccount: storeMerchant }, 200);
      }
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
      // COMPLETE THE CHAIN (8 Sep 2026, OWNER RULE 4): a venue Adyen already
      // holds as an account holder has a balance account and no store, so the
      // store created here is joined to that balance account straight away
      // (PATCH /merchants/{m}/stores/{storeId} with splitConfiguration, the
      // documented way: it names the profile AND the balance account). Done as
      // a PATCH after the create, so a refusal never loses the store. Only on
      // the venue's OWN environment: a balance account id belongs to one Adyen
      // environment and joining a live store to a test account would be wrong.
      const rowBalanceAccount = !crossEnv ? String(maa?.balance_account_id ?? '').trim() : '';
      let balanceAccountLink: { ok: boolean; splitConfigurationId: string | null; message: string } | null = null;
      if (rowBalanceAccount) {
        balanceAccountLink = await linkStoreToBalanceAccount(storeCfg, storeMerchant, storeId, {
          balanceAccountId: rowBalanceAccount,
          splitConfigurationId: String(maa?.split_profile_id ?? '').trim() || null,
        });
        if (balanceAccountLink.ok && balanceAccountLink.splitConfigurationId && !crossEnv) {
          const { error: splitErr } = await upsertAccountRow({ location_id: loc.id, split_profile_id: balanceAccountLink.splitConfigurationId, updated_at: new Date().toISOString() });
          if (splitErr) balanceAccountLink.message += ` The split configuration could not be written on the venue: ${splitErr.message}`;
        }
      } else if (!crossEnv) {
        balanceAccountLink = { ok: false, splitConfigurationId: null, message: 'This venue has no balance account on its row yet, so the store books its payments nowhere in particular. Link the venue to Adyen first, then create the store.' };
      }
      logLink('store_created', loc.id, { environment: storeCfg.env, region, merchant: storeMerchant, reference, storeId, mapped: !crossEnv, businessLineId: rowBusinessLine || null, balanceAccount: rowBalanceAccount || null, balanceAccountLinked: balanceAccountLink?.ok ?? null });
      console.log(`[adyen-terminal-admin] ${caller.id} ${action} created store ${storeId} (reference ${reference ?? '(none)'}) for ${loc.id} on ${storeMerchant} (${region} ${storeCfg.env}${crossEnv ? ', not mapped' : ''})${rowBalanceAccount ? `, balance account ${balanceAccountLink?.ok ? 'linked' : 'NOT linked'}` : ''}`);
      return json({
        ok: true, storeId, existing: false, foundByReference: false, mapped: !crossEnv, paymentMethods: pm,
        environment: storeCfg.env, region, reference, warning: regionWarning, hint: crossEnv ? crossHint : null,
        merchantAccount: storeMerchant, merchantOverride: storeMerchantOverride ?? null,
        businessLineId: rowBusinessLine || null,
        balanceAccount: rowBalanceAccount || null, balanceAccountLink,
      });
    }

    // Everything below needs the store mapping.
    if (!maa?.store_id) return json({ ok: false, error: 'no_store', hint: 'This venue has no payments location yet. Make one in step 3 first.' }, 200);

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
