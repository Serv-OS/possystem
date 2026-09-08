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
//                     are cleared).
//   set_region      → ADMIN. { region: 'UK' | 'US' }. super_admin only.
//                     Refused while the venue is live or holds a store or
//                     readers (provisioning is per account). Writes
//                     merchant_adyen_accounts.region, creating the row when
//                     missing. Until 20260908_PLATFORM_adyen_region_uk.sql
//                     runs the database refuses 'UK' and this answers
//                     'Run migration 20260908_PLATFORM_adyen_region_uk.sql first'.

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  managementBase, buildMenuInputRequest, buildAmountInputRequest, parseAmountInputResponse, buildDisplayImageRequest,
  buildDisplayIdleRequest, newServiceId, adyenFetch, terminalEndpoint,
  adyenConfig, adyenEnvForLocation, adyenSecretName, normalizeAdyenEnv, assertAdyenConfigured, effectiveMerchantAccount,
  parseAdyenRegion, liveRegionsConfigured, isAdyenRegionCheckError, adyenRegionMigrationMessage, ADYEN_REGION_MIGRATION,
  type AdyenConfig,
} from '../_shared/adyen.ts';

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PLATFORM_SERVICE_KEY') ?? '',
);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Management API call with the VENUE'S config: its host and its management
// key. A live venue without live keys throws the fail closed error before
// any request leaves (caught by the handler's outer try).
async function mgmt<T = Record<string, unknown>>(cfg: AdyenConfig, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  assertAdyenConfigured(cfg);
  const res = await fetch(`${managementBase(cfg)}${path}`, {
    method,
    headers: { 'X-API-Key': cfg.managementKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: T;
  try { data = await res.json(); } catch { data = {} as T; }
  return { ok: res.ok, status: res.status, data };
}

const scopeMissing = (status: number) => status === 401 || status === 403;

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
    if (action === 'set_environment') {
      if (!isServosAdmin) return adminOnly();
      const raw = String(body.environment ?? '').trim().toLowerCase();
      if (raw !== 'test' && raw !== 'live') return json({ error: "environment must be 'test' or 'live'" }, 400);
      const next = normalizeAdyenEnv(raw);
      if (next === 'live' && next !== env && !liveCfg.merchantAccount) {
        return json({ ok: false, error: `Set ${adyenSecretName('live', 'merchantAccount', region)} on the server first: the venue's ${region} live merchant account name comes from it.` }, 400);
      }
      const provisionedOnCurrent = next !== env && (provisioned.length > 0 || readers > 0);
      if (provisionedOnCurrent && body.reprovision !== true) {
        const parts = [
          provisioned.length ? 'payments store' : '',
          readers ? `${readers} card reader${readers === 1 ? '' : 's'}` : '',
        ].filter(Boolean);
        const verb = parts.length > 1 || readers > 1 ? 'were' : 'was';
        return json({
          ok: false,
          needs_reprovision: true,
          error: `This venue's ${parts.join(' and ')} ${verb} set up on the ${env} system. Switching to ${next} clears that setup: run store setup and register the readers again afterwards.`,
          provisioned,
          readers,
        }, 409);
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
      const { error: envErr, warning: regionWarning } = await upsertAccountRow(patch, 'location_id, environment');
      if (envErr) {
        const hint = /environment|42703|does not exist/i.test(envErr.message)
          ? ' (apply supabase/migrations/20260907_PLATFORM_adyen_environment.sql to the platform DB first)' : '';
        return json({ ok: false, error: `environment write failed: ${envErr.message}${hint}` }, 500);
      }
      if (provisionedOnCurrent && readers > 0) {
        // The platform registry rows point at readers boarded to the old
        // environment. Retire them here (location_id is NOT NULL, so the row
        // keeps its venue); the ops terminal_devices link rows stay until
        // `assign` re-registers each reader on the new environment, which
        // updates both rows in place.
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
      const warnings: string[] = [];
      if (regionWarning) warnings.push(regionWarning);
      if (next === 'live' && !liveReady) {
        warnings.push(`Live keys for the ${region} account are not fully configured (${liveMissing.join(', ')}): this venue will refuse every card call until they are set.`);
      }
      if (provisionedOnCurrent) {
        warnings.push(`Store and reader setup from the ${env} system was cleared. Run store setup and register the readers again on ${next}.`);
      }
      if (next !== env && merchantNext !== merchantWas) {
        warnings.push(merchantNext
          ? `The merchant account was switched to the ${region} ${next} account (${merchantNext})${merchantWas ? `, replacing ${merchantWas}` : ''}.`
          : `No ${region} ${next} merchant account is configured on the server; the venue's merchant account was cleared.`);
      }
      console.log(`[adyen-terminal-admin] ${caller.id} set environment=${next} for ${loc.id} (${region}, was ${env}${provisionedOnCurrent ? ', reprovision' : ''})`);
      return json({ ok: true, environment: next, region, previous: env, liveConfigured: liveReady, liveRegionsConfigured: liveRegions, reprovisioned: provisionedOnCurrent, warning: warnings.join(' ') || null });
    }

    // The row's name wins, unless it names the OTHER environment's secret
    // account (a row flipped before set_environment rewrote it).
    const merchant = effectiveMerchantAccount(cfg, maa?.merchant_account);
    if (!merchant) return json({ error: `no merchant account configured for card payments (${adyenSecretName(cfg.env, 'merchantAccount', cfg.region)})` }, 500);

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
    if (action === 'ensure_store') {
      if (!isServosAdmin) return adminOnly();
      if (maa?.store_id) return json({ ok: true, storeId: maa.store_id, existing: true });
      const a = (body.address || {}) as Record<string, string>;
      const phone = String(body.phone || '').replace(/[^\d+]/g, '');
      // The store is the record Adyen keeps for the venue (compliance,
      // receipts, terminal settings). On TEST a placeholder address is fine;
      // on LIVE the real address and phone are required (8 Sep 2026: the
      // panel used to create live stores at "1 High Street, London" with a
      // made up phone number).
      if (cfg.live && (!a.line1 || !a.city || !a.postal_code || !phone)) {
        return json({ ok: false, error: 'A live store needs the venue address (street, town, postcode) and a phone number.' }, 200);
      }
      // The venue's short code as the store reference: adyen-onboard
      // list_stores matches a store to its venue on it.
      let venueCode: string | null = null;
      try {
        const { data: opsLoc } = await opsAdmin.from('locations').select('venue_code').eq('id', opsLocationId).maybeSingle();
        venueCode = opsLoc?.venue_code ? String(opsLoc.venue_code) : null;
      } catch { /* the reference is a convenience */ }
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
      if (venueCode) payload.reference = venueCode.slice(0, 50);
      const r = await mgmt(cfg, 'POST', `/merchants/${merchant}/stores`, payload);
      if (scopeMissing(r.status)) return json({ ok: false, error: 'scope_missing' }, 200);
      if (!r.ok) return json({ ok: false, error: (r.data as Record<string, unknown>)?.detail || (r.data as Record<string, unknown>)?.title || `store create failed (${r.status})` }, 200);
      const storeId = String((r.data as Record<string, unknown>).id || '');
      // The row names the region the store was created on ('UK' | 'US'; a
      // legacy 'EU' row is rewritten to 'UK'). upsertAccountRow retries a
      // 'UK' the old check refuses and reports the migration as a warning:
      // the store exists at Adyen, so the mapping must land either way.
      const mapping: Record<string, unknown> = { location_id: loc.id, merchant_account: merchant, store_id: storeId, receive_payments_ok: true, region };
      const { error: upErr, warning: regionWarning } = await upsertAccountRow(mapping);
      if (upErr) return json({ ok: false, error: `store created (${storeId}) but mapping write failed: ${upErr.message}` }, 500);
      const pm = await ensurePaymentMethods(cfg, merchant, storeId, market);
      return json({ ok: true, storeId, existing: false, paymentMethods: pm, environment: cfg.env, region, reference: venueCode, warning: regionWarning });
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
