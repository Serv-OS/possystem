// supabase/functions/adyen-onboard/index.ts
//
// ServOS Payments PHASE 4 — the per-venue PAYOUT ONBOARDING pipeline
// (ADYEN_INTEGRATION_PLAN.md). Builds the Adyen-for-Platforms anatomy for one
// venue: legal entity (LEM v4) → account holder + balance account (bcl v2) →
// hosted onboarding link (venue completes KYC + adds their bank there) →
// split configuration on the venue's store (Management v3, one commission
// rule per pricing tier from the venue's resolved rate card — v5.7.3) →
// daily push sweep to the venue's bank.
//
// EVERY Adyen call degrades gracefully: the balance platform is likely NOT
// YET ENABLED on this account, so 401/403 from LEM/bcl is classified
// 'awaiting_enablement' and surfaced as "awaiting enablement from the payment
// partner" — never a raw error. The day Adyen flips the switch, the same
// deployed code completes the pipeline with no changes.
//
// IDEMPOTENCY / RESUME: `start` stamps each id into merchant_adyen_accounts
// the moment its step succeeds and SKIPS any step whose id already exists, so
// re-running after a failure (or after enablement lands) continues where it
// stopped. configure_splits re-points the store atomically (new profile →
// PATCH store → stamp → best-effort delete of the old profile). setup_sweep
// lists existing sweeps first and patches instead of duplicating.
//
// AUDIT: every step (success or failure) is durably logged into platform
// adyen_webhook_events with event_key onboard:<step>:<location>:<ts> — the
// same ledger the terminal-admin probes use — so progress is inspectable
// without function logs.
//
// Endpoints (verified against Adyen's published OpenAPI specs, 19 Aug 2026):
//   POST {lem}/legalEntities                       create legal entity (type organization)
//   POST {lem}/legalEntities/{id}/onboardingLinks  hosted onboarding link — url is
//                                                  SINGLE-USE and expires in 4 MINUTES
//   GET  {lem}/legalEntities/{id}                  transferInstruments[] after venue adds bank
//   POST {bcl}/accountHolders                      { legalEntityId } → AH...
//   POST {bcl}/balanceAccounts                     { accountHolderId, defaultCurrencyCode } → BA...
//   GET  {bcl}/balanceAccounts/{id}                balances[] {available,balance,pending,reserved}
//   GET/POST {bcl}/balanceAccounts/{id}/sweeps     push sweep, schedule daily/weekly/monthly
//   PATCH {bcl}/balanceAccounts/{baId}/sweeps/{id} update schedule
//   GET  {bcl}/accountHolders/{id}                 capabilities (verification truth)
//   POST {mgmt}/merchants/{m}/splitConfigurations  commission/fee/remainder profile
//   PATCH {mgmt}/stores/{storeId}                  { splitConfiguration: { splitConfigurationId, balanceAccountId } }
//
// Auth: super_admin only (payments-admin fence) — this is the internal admin
// portal's door. The venue-facing reads live in adyen-financial.
//
// ⚠ DEPLOY ME (edge functions deploy manually and drift silently):
//   npx supabase functions deploy adyen-onboard --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { lemBase, balancePlatformBase, managementBase, ADYEN_MERCHANT_ACCOUNT, RATE_TIERS, resolveAdyenRateCard } from '../_shared/adyen.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// LEM + Balance Platform may sit behind their own ws user; fall back to the
// main key so nothing breaks when one key carries every role (test setup).
const LEM_KEY = Deno.env.get('ADYEN_LEM_KEY') || Deno.env.get('ADYEN_BP_KEY') || Deno.env.get('ADYEN_API_KEY') || '';
const BP_KEY = Deno.env.get('ADYEN_BP_KEY') || Deno.env.get('ADYEN_API_KEY') || '';
const MGMT_KEY = Deno.env.get('ADYEN_MANAGEMENT_KEY') || Deno.env.get('ADYEN_API_KEY') || '';

interface R<T = any> { ok: boolean; status: number; data: T; }
async function call<T = any>(key: string, method: string, url: string, body?: unknown, idem?: string): Promise<R<T>> {
  const headers: Record<string, string> = { 'X-API-Key': key, 'Content-Type': 'application/json' };
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = null;
  try { const t = await res.text(); data = t ? JSON.parse(t) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}
const lem = (m: string, p: string, b?: unknown, idem?: string) => call(LEM_KEY, m, `${lemBase()}${p}`, b, idem);
const bcl = (m: string, p: string, b?: unknown, idem?: string) => call(BP_KEY, m, `${balancePlatformBase()}${p}`, b, idem);
const mgmt = (m: string, p: string, b?: unknown) => call(MGMT_KEY, m, `${managementBase()}${p}`, b);

// ── Failure classification — every Adyen refusal becomes one of three kinds ──
// 401/403 while the balance platform is not enabled on the account is the
// EXPECTED state today; it must read as a waiting room, not a bug.
type Kind = 'awaiting_enablement' | 'missing_prerequisite' | 'error';
function classify(r: R): { kind: Kind; message: string } {
  if (r.status === 401 || r.status === 403) {
    return {
      kind: 'awaiting_enablement',
      message: 'Awaiting enablement from the payment partner. The balance platform is not switched on for this account yet (or the API key is missing the role). Nothing is wrong with the venue — retry once Adyen confirms enablement.',
    };
  }
  const d: any = r.data ?? {};
  const detail = d.detail || d.title || d.message || (Array.isArray(d.invalidFields) && d.invalidFields.length
    ? d.invalidFields.map((f: any) => `${f.name}: ${f.message}`).join('; ')
    : '') || `HTTP ${r.status}`;
  return { kind: 'error', message: String(detail) };
}

// Durable audit trail — platform adyen_webhook_events (event_key is the pk).
// Fire-and-forget: a logging failure must never fail the step it records.
function logStep(step: string, locationId: string, raw: unknown) {
  void platformAdmin.from('adyen_webhook_events').insert({
    event_key: `onboard:${step}:${locationId}:${Date.now()}`,
    raw,
  }).then(() => {}, () => {});
}

async function stamp(locationId: string, patch: Record<string, unknown>) {
  return await platformAdmin.from('merchant_adyen_accounts').upsert({
    location_id: locationId,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'location_id' });
}

// Platform locations carry ONE free-text address line. LEM only REQUIRES
// country on registeredAddress — parse what we can (UK-shaped) and let hosted
// onboarding collect/correct the rest. Body overrides always win.
function parseAddress(text: string | null | undefined): { street?: string; city?: string; postalCode?: string } {
  const out: { street?: string; city?: string; postalCode?: string } = {};
  const raw = String(text ?? '').trim();
  if (!raw) return out;
  const pc = raw.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
  if (pc) out.postalCode = pc[0].toUpperCase().replace(/\s+/g, ' ');
  const parts = raw.replace(pc?.[0] ?? '', '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length) out.street = parts[0];
  if (parts.length > 1) out.city = parts[parts.length - 1];
  return out;
}

// Postgres 42703 (column does not exist) — the rate-card columns until
// migration 20260821b_adyen_rate_card.sql is hand-applied.
const isMissingColumn = (msg: unknown) => /does not exist|42703/i.test(String(msg ?? ''));

// The venue's resolved TIERED rate card (v5.7.3) — per tier: venue rate_card →
// platform default rate_card → the legacy flat markup (card_present tier only)
// → null. Also returns the flat card_present shape older panel builds read as
// `rate`, so status stays back-compatible.
async function effectiveRates(maa: any): Promise<{ cards: Record<string, any>; flat: { percent: number | null; fixed_pence: number | null; source: 'venue' | 'platform' | null } }> {
  let { data: ps, error } = await platformAdmin.from('platform_settings')
    .select('default_adyen_rate_card, default_adyen_markup_percent, default_adyen_markup_fixed_pence').eq('id', true).maybeSingle();
  if (error && isMissingColumn(error.message)) {
    ({ data: ps } = await platformAdmin.from('platform_settings')
      .select('default_adyen_markup_percent, default_adyen_markup_fixed_pence').eq('id', true).maybeSingle());
  }
  const cards = resolveAdyenRateCard(maa ?? {}, ps ?? {});
  const cp = cards.card_present;
  const source = cp.source == null ? null
    : (cp.source === 'venue' || cp.source === 'legacy_venue') ? 'venue' as const : 'platform' as const;
  return { cards, flat: { percent: cp.percent, fixed_pence: cp.fixed_pence, source } };
}

const TIER_LABELS: Record<string, string> = {
  card_present: 'card-present (credit & debit)',
  card_not_present: 'card-not-present (online)',
  amex: 'American Express & business cards',
  keyed: 'manually keyed',
};
const tierLabel = (t: string) => TIER_LABELS[t] ?? t;

// A tier "has a rate" when it resolves to a non-zero percent or pence — a
// zero/zero tier would mean a 0% commission rule, which is refused on purpose.
const tiersLackingRates = (cards: Record<string, any>): string[] =>
  (RATE_TIERS as readonly string[]).filter((t) => {
    const c = cards[t];
    return !c || ((c.percent == null || Number(c.percent) <= 0) && (c.fixed_pence == null || Number(c.fixed_pence) <= 0));
  });

// Capability snapshot → the columns webhooks also maintain. Under AfP the
// capabilities that matter here: receiveFromPlatformPayments (split funds may
// land in the balance account) and sendToTransferInstrument (bank payouts).
function capabilityFlags(capabilities: any): { receive_ok: boolean; payouts_ok: boolean } {
  const c = capabilities ?? {};
  const allowed = (k: string) => c?.[k]?.allowed === true;
  return {
    receive_ok: allowed('receivePayments') || allowed('receiveFromPlatformPayments'),
    payouts_ok: allowed('sendToTransferInstrument'),
  };
}
function capabilitySnapshot(capabilities: any): Record<string, unknown> | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(capabilities as Record<string, any>)) {
    out[k] = { allowed: v?.allowed ?? null, requested: v?.requested ?? null, verificationStatus: v?.verificationStatus ?? null,
               problems: Array.isArray(v?.problems) && v.problems.length ? v.problems : undefined };
  }
  return out;
}

const balancesOut = (data: any) => (Array.isArray(data?.balances) ? data.balances : []).map((b: any) => ({
  currency: b?.currency ?? 'GBP',
  available_minor: Number(b?.available ?? 0),
  total_minor: Number(b?.balance ?? 0),
  pending_minor: Number(b?.pending ?? 0),
  reserved_minor: Number(b?.reserved ?? 0),
}));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  try {
    // ── Auth: super_admin (the payments-admin fence, verbatim) ───────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!caller) return json({ error: 'Invalid token' }, 401);
    const { data: profile } = await opsAdmin.from('user_profiles').select('role').eq('id', caller.id).single();
    if (profile?.role !== 'super_admin') return json({ error: 'Requires super_admin' }, 403);

    const body: any = await req.json().catch(() => ({}));
    const action = String(body.action || 'status');
    // Admin portal passes the PLATFORM location id; BO surfaces pass the ops
    // id — resolve either (the adyen-terminal-admin dual lookup).
    const locKey = String(body.location_id || body.ops_location_id || '');
    if (!locKey) return json({ error: 'location_id (or ops_location_id) required' }, 400);

    const select = 'id, name, address, currency, payment_processor, ops_location_id';
    let { data: loc } = await platformAdmin.from('locations').select(select).eq('id', locKey).maybeSingle();
    if (!loc) ({ data: loc } = await platformAdmin.from('locations').select(select).eq('ops_location_id', locKey).maybeSingle());
    if (!loc) return json({ error: 'location not found in platform DB' }, 404);

    const { data: maa } = await platformAdmin.from('merchant_adyen_accounts').select('*').eq('location_id', loc.id).maybeSingle();
    const merchant = maa?.merchant_account || ADYEN_MERCHANT_ACCOUNT;

    // ── save_manual: type in what the Adyen Customer Area already created ────
    // v5.7.93. The API onboarding path (`start`) cannot be used: the credential
    // FranPOS issued us is refused by Legal Entity Management and Balance
    // Platform (401), and rather than wait on that, venues are being onboarded
    // BY HAND in the Adyen Customer Area, the way FranPOS themselves do it.
    //
    // So the ids already exist over there; ServOS just has nowhere to put them.
    // This is that place. Everything else in the system reads these same
    // columns, so a hand-onboarded venue behaves exactly like an API-onboarded
    // one: card routing names the store, commission splits find the balance
    // account, and the payouts screen reports real state.
    //
    // Stored verbatim after a shape check. Adyen ids are prefixed and fixed
    // length, and a transposed character here would fail later at payment time
    // with an error nobody would trace back to a typing mistake.
    if (action === 'save_manual') {
      const clean = (v: unknown) => String(v ?? '').trim();
      const fields = {
        merchant_account:   clean(body.merchant_account),
        store_id:           clean(body.store_id),
        account_holder_id:  clean(body.account_holder_id),
        balance_account_id: clean(body.balance_account_id),
        legal_entity_id:    clean(body.legal_entity_id),
        split_profile_id:   clean(body.split_profile_id),
        region:             clean(body.region).toUpperCase() === 'US' ? 'US' : 'EU',
      };
      const shape: Record<string, RegExp> = {
        store_id: /^ST[0-9A-Z]{10,}$/i,
        account_holder_id: /^AH[0-9A-Z]{10,}$/i,
        balance_account_id: /^BA[0-9A-Z]{10,}$/i,
        legal_entity_id: /^LE[0-9A-Z]{10,}$/i,
      };
      const bad: string[] = [];
      for (const [k, re] of Object.entries(shape)) {
        const v = (fields as any)[k];
        if (v && !re.test(v)) bad.push(k);
      }
      if (bad.length) {
        return json({ error: `These do not look like Adyen ids: ${bad.join(', ')}. Copy them exactly from the Customer Area.` }, 400);
      }
      if (!fields.merchant_account) return json({ error: 'Merchant account is required' }, 400);

      // Empty means "leave alone", so a partial paste never wipes what is
      // already stored. Clearing a field is a deliberate act, not a side effect.
      const patch: Record<string, unknown> = { location_id: loc.id, updated_at: new Date().toISOString() };
      for (const [k, v] of Object.entries(fields)) if (v) patch[k] = v;
      // A venue with a store CAN take card payments; that is what the store is.
      if (fields.store_id) patch.receive_payments_ok = true;
      if (fields.balance_account_id) patch.payouts_ok = true;

      const { error } = await platformAdmin.from('merchant_adyen_accounts')
        .upsert(patch, { onConflict: 'location_id' });
      if (error) return json({ error: error.message }, 500);

      logStep('save_manual', loc.id, { fields: Object.keys(patch), region: fields.region });
      const { data: after } = await platformAdmin.from('merchant_adyen_accounts')
        .select('*').eq('location_id', loc.id).maybeSingle();
      return json({ ok: true, saved: after });
    }

    // ── status: everything known + a live enablement probe ───────────────────
    if (action === 'status') {
      let enablement: 'enabled' | 'awaiting_enablement' | 'unknown' = 'unknown';
      let enablementMessage: string | null = null;
      let balances: any[] | null = null;
      let capabilities: Record<string, unknown> | null = null;
      let sweeps: any[] | null = null;

      if (maa?.balance_account_id) {
        // The cheapest call that is also USEFUL: balances double as the probe.
        const r = await bcl('GET', `/balanceAccounts/${encodeURIComponent(maa.balance_account_id)}`);
        logStep('probe_balance', loc.id, { httpStatus: r.status, balances: r.data?.balances ?? null });
        if (r.ok) { enablement = 'enabled'; balances = balancesOut(r.data); }
        else { const c = classify(r); enablement = c.kind === 'awaiting_enablement' ? 'awaiting_enablement' : 'enabled'; enablementMessage = c.message; }
        if (enablement === 'enabled') {
          const sr = await bcl('GET', `/balanceAccounts/${encodeURIComponent(maa.balance_account_id)}/sweeps`);
          if (sr.ok) sweeps = (sr.data?.sweeps ?? []).map((s: any) => ({ id: s.id, type: s.type, category: s.category, schedule: s.schedule?.type ?? null, status: s.status ?? null, counterparty: s.counterparty ?? null }));
        }
      }
      if (maa?.account_holder_id) {
        const r = await bcl('GET', `/accountHolders/${encodeURIComponent(maa.account_holder_id)}`);
        if (r.ok) {
          if (enablement === 'unknown') enablement = 'enabled';
          capabilities = capabilitySnapshot(r.data?.capabilities);
          // Keep the DB truthy on every status load (webhooks also maintain this).
          const flags = capabilityFlags(r.data?.capabilities);
          await stamp(loc.id, { verification_status: { source: 'status_sync', at: new Date().toISOString(), accountHolderStatus: r.data?.status ?? null, capabilities }, receive_payments_ok: flags.receive_ok, payouts_ok: flags.payouts_ok });
        } else if (enablement === 'unknown') {
          const c = classify(r);
          enablement = c.kind === 'awaiting_enablement' ? 'awaiting_enablement' : 'enabled';
          enablementMessage = c.message;
        }
      }
      if (enablement === 'unknown') {
        // Nothing exists yet — probe with an id that cannot exist. 401/403 =
        // the platform is off; ANY other answer (404/422/400) means the API
        // engaged with the request, i.e. the platform is on.
        const r = await bcl('GET', '/balanceAccounts/BA_servos_enablement_probe');
        logStep('probe_enablement', loc.id, { httpStatus: r.status, response: r.data ?? null });
        if (r.status === 401 || r.status === 403) { enablement = 'awaiting_enablement'; enablementMessage = classify(r).message; }
        else enablement = 'enabled';
      }

      // Re-read after any stamp above so the response reflects what status wrote.
      const { data: fresh } = await platformAdmin.from('merchant_adyen_accounts').select('*').eq('location_id', loc.id).maybeSingle();
      const { cards, flat: rate } = await effectiveRates(fresh ?? maa);
      const m = fresh ?? maa;
      const missingSplits: string[] = [];
      if (!m?.store_id) missingSplits.push('store (register a terminal / ensure the store first)');
      if (!m?.balance_account_id) missingSplits.push('balance account (run Start onboarding)');
      const lackingTiers = tiersLackingRates(cards);
      if (lackingTiers.length) missingSplits.push(`rates for ${lackingTiers.map(tierLabel).join(', ')} (set them in the Processing rate editor — one commission rule is written per tier)`);
      const missingSweep: string[] = [];
      if (!m?.balance_account_id) missingSweep.push('balance account (run Start onboarding)');
      if (!m?.transfer_instrument_id) missingSweep.push('bank account (the venue adds it in hosted onboarding; Set up sweep re-checks automatically)');

      return json({
        ok: true,
        venue: loc.name,
        processor: loc.payment_processor || 'stripe',
        merchant,
        enablement,
        enablement_message: enablementMessage,
        ids: {
          legal_entity_id: m?.legal_entity_id ?? null,
          account_holder_id: m?.account_holder_id ?? null,
          balance_account_id: m?.balance_account_id ?? null,
          transfer_instrument_id: m?.transfer_instrument_id ?? null,
          business_line_id: m?.business_line_id ?? null,
          store_id: m?.store_id ?? null,
          split_profile_id: m?.split_profile_id ?? null,
        },
        verification_status: m?.verification_status ?? null,
        receive_payments_ok: !!m?.receive_payments_ok,
        payouts_ok: !!m?.payouts_ok,
        capabilities,
        balances,
        sweeps,
        rate,
        rate_card: cards,
        onboarding_link: m?.onboarding_link_url
          ? { url: m.onboarding_link_url, expires_at: m.onboarding_link_expires_at ?? null }
          : null,
        prerequisites: {
          configure_splits: { ok: missingSplits.length === 0, missing: missingSplits },
          setup_sweep: { ok: missingSweep.length === 0, missing: missingSweep },
        },
      });
    }

    // ── start: the idempotent pipeline (resume-safe by construction) ─────────
    if (action === 'start') {
      const steps: any[] = [];
      const fail = (step: string, r: R) => {
        const c = classify(r);
        steps.push({ step, status: 'failed', kind: c.kind, message: c.message, httpStatus: r.status });
        logStep(step, loc.id, { httpStatus: r.status, response: r.data ?? null, outcome: 'failed' });
        return json({ ok: false, kind: c.kind, message: c.message, steps });
      };

      // 1. Legal entity (organisation) — name/address from the platform row,
      //    body overrides win. LEM requires only country on the address; the
      //    venue corrects details during hosted onboarding.
      let legalEntityId: string | null = maa?.legal_entity_id ?? null;
      if (legalEntityId) steps.push({ step: 'legal_entity', status: 'exists', id: legalEntityId });
      else {
        const parsed = parseAddress(loc.address);
        const country = String(body.country || 'GB').toUpperCase();
        const registeredAddress: Record<string, unknown> = { country };
        const street = body.street ?? parsed.street; if (street) registeredAddress.street = String(street);
        const city = body.city ?? parsed.city; if (city) registeredAddress.city = String(city);
        const postalCode = body.postal_code ?? parsed.postalCode; if (postalCode) registeredAddress.postalCode = String(postalCode);
        const payload = {
          type: 'organization',
          reference: `servos:${loc.id}`,
          organization: { legalName: String(body.legal_name || loc.name).slice(0, 300), registeredAddress },
        };
        const r = await lem('POST', '/legalEntities', payload, `le:${loc.id}`);
        logStep('legal_entity', loc.id, { httpStatus: r.status, request: payload, response: r.data ?? null });
        if (!r.ok || !r.data?.id) return fail('legal_entity', r);
        legalEntityId = r.data.id as string;
        const { error } = await stamp(loc.id, { legal_entity_id: legalEntityId });
        if (error) return json({ ok: false, kind: 'error', message: `legal entity created (${legalEntityId}) but could not be saved: ${error.message}`, steps });
        steps.push({ step: 'legal_entity', status: 'created', id: legalEntityId });
      }

      // 2. Account holder.
      let accountHolderId: string | null = maa?.account_holder_id ?? null;
      if (accountHolderId) steps.push({ step: 'account_holder', status: 'exists', id: accountHolderId });
      else {
        const payload = { legalEntityId, description: `${loc.name} (ServOS)`.slice(0, 300), reference: loc.id };
        const r = await bcl('POST', '/accountHolders', payload, `ah:${loc.id}`);
        logStep('account_holder', loc.id, { httpStatus: r.status, request: payload, response: r.data ?? null });
        if (!r.ok || !r.data?.id) return fail('account_holder', r);
        accountHolderId = r.data.id as string;
        const { error } = await stamp(loc.id, { account_holder_id: accountHolderId });
        if (error) return json({ ok: false, kind: 'error', message: `account holder created (${accountHolderId}) but could not be saved: ${error.message}`, steps });
        steps.push({ step: 'account_holder', status: 'created', id: accountHolderId });
      }

      // 3. Balance account (GBP — or the venue's platform currency).
      let balanceAccountId: string | null = maa?.balance_account_id ?? null;
      if (balanceAccountId) steps.push({ step: 'balance_account', status: 'exists', id: balanceAccountId });
      else {
        const payload = {
          accountHolderId,
          defaultCurrencyCode: String(loc.currency || 'GBP').toUpperCase(),
          description: `${loc.name} payouts (ServOS)`.slice(0, 300),
          reference: loc.id,
        };
        const r = await bcl('POST', '/balanceAccounts', payload, `ba:${loc.id}`);
        logStep('balance_account', loc.id, { httpStatus: r.status, request: payload, response: r.data ?? null });
        if (!r.ok || !r.data?.id) return fail('balance_account', r);
        balanceAccountId = r.data.id as string;
        const { error } = await stamp(loc.id, { balance_account_id: balanceAccountId });
        if (error) return json({ ok: false, kind: 'error', message: `balance account created (${balanceAccountId}) but could not be saved: ${error.message}`, steps });
        steps.push({ step: 'balance_account', status: 'created', id: balanceAccountId });
      }

      // 4. Hosted onboarding link — SINGLE-USE, expires in 4 minutes, so it is
      //    minted fresh on every start/refresh and the caller uses it NOW.
      const linkPayload: Record<string, unknown> = { redirectUrl: String(body.redirect_url || 'https://dev.serv-os.app/') };
      if (body.locale) linkPayload.locale = String(body.locale);
      const lr = await lem('POST', `/legalEntities/${encodeURIComponent(legalEntityId!)}/onboardingLinks`, linkPayload);
      logStep('onboarding_link', loc.id, { httpStatus: lr.status, response: lr.ok ? { url: 'minted' } : (lr.data ?? null) });
      let link: { url: string; expires_at: string } | null = null;
      if (lr.ok && lr.data?.url) {
        link = { url: lr.data.url as string, expires_at: new Date(Date.now() + 4 * 60_000).toISOString() };
        await stamp(loc.id, { onboarding_link_url: link.url, onboarding_link_expires_at: link.expires_at });
        steps.push({ step: 'onboarding_link', status: 'created' });
      } else {
        const c = classify(lr);
        steps.push({ step: 'onboarding_link', status: 'failed', kind: c.kind, message: c.message, httpStatus: lr.status });
      }

      return json({
        ok: true,
        steps,
        ids: { legal_entity_id: legalEntityId, account_holder_id: accountHolderId, balance_account_id: balanceAccountId },
        onboarding_link: link,
        next: link
          ? 'Send the link to the venue now — it is single-use and expires in 4 minutes. They complete identity checks and add their bank account there.'
          : 'Accounts are in place; mint a fresh onboarding link with refresh_link when the venue is ready.',
      });
    }

    // ── refresh_link: a fresh hosted onboarding link (single-use, 4 minutes) ─
    if (action === 'refresh_link') {
      if (!maa?.legal_entity_id) return json({ ok: false, kind: 'missing_prerequisite', message: 'No legal entity yet — run Start onboarding first.' }, 400);
      const payload: Record<string, unknown> = { redirectUrl: String(body.redirect_url || 'https://dev.serv-os.app/') };
      if (body.locale) payload.locale = String(body.locale);
      const r = await lem('POST', `/legalEntities/${encodeURIComponent(maa.legal_entity_id)}/onboardingLinks`, payload);
      logStep('refresh_link', loc.id, { httpStatus: r.status, response: r.ok ? { url: 'minted' } : (r.data ?? null) });
      if (!r.ok || !r.data?.url) { const c = classify(r); return json({ ok: false, kind: c.kind, message: c.message }, 502); }
      const expires_at = new Date(Date.now() + 4 * 60_000).toISOString();
      await stamp(loc.id, { onboarding_link_url: r.data.url, onboarding_link_expires_at: expires_at });
      return json({ ok: true, onboarding_link: { url: r.data.url, expires_at }, note: 'Single-use link, expires in 4 minutes — open or send it now.' });
    }

    // ── configure_splits: one commission rule PER PRICING TIER + store point ─
    // v5.7.3 — the flat single-rule profile is replaced by the tiered model.
    // Adyen split configuration profiles support MULTIPLE rules keyed by
    // currency / fundingSource / paymentMethod / shopperInteraction
    // (Management v3, spec-verified in the v5.7.1 build). Mapping:
    //   amex tier             paymentMethod 'amex' (written per interaction, see below)
    //   card_not_present tier shopperInteraction 'Ecommerce'
    //   keyed tier            shopperInteraction 'Moto'
    //   card_present tier     the catch-all rule (POS / ContAuth / anything else)
    // KNOWN LIMITS against the spec, documented on purpose:
    //   · fundingSource distinguishes credit/debit/prepaid but has NO
    //     commercial/business value, so a BUSINESS card on Visa/Mastercard
    //     cannot be routed to the amex tier at Adyen — it rides the rule for
    //     its channel. Our ledger (adyen_payments.rate_category) still
    //     classifies it amex from additionalData, so internal reporting shows
    //     the divergence until Adyen can key on commercial cards.
    //   · Adyen applies the MOST SPECIFIC matching rule. An Amex ecommerce
    //     payment would tie between 'amex + ANY interaction' and 'ANY method +
    //     Ecommerce' (one specific condition each), so the amex tier is
    //     written per-interaction (two specific conditions) to always outrank
    //     the channel rules — Amex is its own fee wherever the card is used.
    //   · ContAuth (stored-card) payments ride the card_present catch-all,
    //     while the ledger classes stored-card booking payments as
    //     card_not_present (channel 'booking') — a second documented
    //     divergence; revisit when ContAuth volume matters.
    // Refuses missing_prerequisite listing exactly which tiers lack rates.
    if (action === 'configure_splits') {
      const missing: string[] = [];
      if (!maa?.store_id) missing.push('store — register the venue store first (Card terminals → ensure store)');
      if (!maa?.balance_account_id) missing.push('balance account — run Start onboarding first');
      if (!merchant) missing.push('merchant account (ADYEN_MERCHANT_ACCOUNT)');
      const { cards } = await effectiveRates(maa);
      const lacking = tiersLackingRates(cards);
      if (lacking.length) {
        missing.push(`processing rates for: ${lacking.map(tierLabel).join('; ')} — set every tier in the Processing rate editor first (one commission rule is written per tier)`);
      }
      if (missing.length) return json({ ok: false, kind: 'missing_prerequisite', message: `Not ready to configure splits. Missing: ${missing.join('; ')}.`, missing, lacking_tiers: lacking }, 400);

      const currency = String(loc.currency || 'GBP').toUpperCase();
      const commissionFor = (tier: string): Record<string, number> => {
        const commission: Record<string, number> = {};
        const fixed = Math.round(Number(cards[tier].fixed_pence ?? 0));
        const pct = Number(cards[tier].percent ?? 0);
        if (fixed > 0) commission.fixedAmount = fixed;                       // minor units
        if (pct > 0) commission.variablePercentage = Math.round(pct * 100);  // basis points
        return commission;
      };
      const logicFor = (tier: string) => ({
        commission: commissionFor(tier),                // our revenue → liable account
        paymentFee: 'deductFromLiableAccount',          // platform absorbs Adyen's costs (venue pays the all-in tier rate)
        remainder: 'addToOneBalanceAccount',            // sale minus commission → the venue
        tip: 'addToOneBalanceAccount',
        surcharge: 'addToOneBalanceAccount',
        chargeback: 'deductFromOneBalanceAccount',      // the venue carries its own chargebacks
        chargebackCostAllocation: 'deductFromLiableAccount',
        refund: 'deductAccordingToSplitRatio',          // refund unwinds commission + venue share alike
        refundCostAllocation: 'deductFromLiableAccount',
      });
      const rule = (tier: string, paymentMethod: string, shopperInteraction: string) => ({
        currency,                       // must be a real ISO code (the one condition with no ANY)
        fundingSource: 'ANY',           // credit AND debit — one fee, per the pricing model
        paymentMethod,
        shopperInteraction,
        splitLogic: logicFor(tier),
      });
      const profile = {
        description: `ServOS ${loc.name} tiered rates`.slice(0, 300),
        rules: [
          // amex tier per interaction — always more specific than the channel rules
          rule('amex', 'amex', 'Ecommerce'),
          rule('amex', 'amex', 'Moto'),
          rule('amex', 'amex', 'ANY'),
          // channel tiers
          rule('card_not_present', 'ANY', 'Ecommerce'),
          rule('keyed', 'ANY', 'Moto'),
          // default — POS / ContAuth / anything new
          rule('card_present', 'ANY', 'ANY'),
        ],
      };

      const created = await mgmt('POST', `/merchants/${encodeURIComponent(merchant)}/splitConfigurations`, profile);
      logStep('split_profile', loc.id, { httpStatus: created.status, request: profile, response: created.data ?? null });
      if (!created.ok || !created.data?.splitConfigurationId) { const c = classify(created); return json({ ok: false, kind: c.kind, message: c.message }, 502); }
      const splitConfigurationId = created.data.splitConfigurationId as string;

      const patched = await mgmt('PATCH', `/stores/${encodeURIComponent(maa.store_id)}`, {
        splitConfiguration: { splitConfigurationId, balanceAccountId: maa.balance_account_id },
      });
      logStep('split_store_patch', loc.id, { httpStatus: patched.status, splitConfigurationId, response: patched.data ?? null });
      if (!patched.ok) { const c = classify(patched); return json({ ok: false, kind: c.kind, message: `Split profile ${splitConfigurationId} created but the store could not be pointed at it: ${c.message}`, split_profile_id: splitConfigurationId }, 502); }

      const oldProfile = maa.split_profile_id;
      await stamp(loc.id, { split_profile_id: splitConfigurationId });
      if (oldProfile && oldProfile !== splitConfigurationId) {
        // Best-effort tidy-up — the store no longer references it.
        const del = await mgmt('DELETE', `/merchants/${encodeURIComponent(merchant)}/splitConfigurations/${encodeURIComponent(oldProfile)}`);
        logStep('split_profile_delete_old', loc.id, { httpStatus: del.status, oldProfile });
      }

      const tierSummary = (RATE_TIERS as readonly string[]).map((t) =>
        `${tierLabel(t)}: ${Number(cards[t].percent ?? 0)}% + ${Math.round(Number(cards[t].fixed_pence ?? 0))}p`);
      return json({
        ok: true,
        split_profile_id: splitConfigurationId,
        rate_card: cards,
        tier_summary: tierSummary,
        applied: { rules: profile.rules.length, currency, store_id: maa.store_id, balance_account_id: maa.balance_account_id },
        notes: [
          'Business cards on Visa/Mastercard cannot be keyed at Adyen (no commercial fundingSource) — they ride their channel rule; the internal ledger still reports them under the Amex & business tier.',
          'Stored-card (ContAuth) payments ride the card-present catch-all rule.',
        ],
      });
    }

    // ── setup_sweep: daily push of the full available balance to the bank ────
    if (action === 'setup_sweep') {
      if (!maa?.balance_account_id) return json({ ok: false, kind: 'missing_prerequisite', message: 'No balance account yet — run Start onboarding first.' }, 400);

      // Bank account: stamped by webhook/status normally, but resolve it live
      // from the legal entity if we have not seen it yet (the venue adds the
      // bank during hosted onboarding).
      let ti = maa.transfer_instrument_id as string | null;
      if (!ti && maa.legal_entity_id) {
        const r = await lem('GET', `/legalEntities/${encodeURIComponent(maa.legal_entity_id)}`);
        logStep('resolve_transfer_instrument', loc.id, { httpStatus: r.status, count: Array.isArray(r.data?.transferInstruments) ? r.data.transferInstruments.length : null });
        if (!r.ok) { const c = classify(r); return json({ ok: false, kind: c.kind, message: c.message }, 502); }
        ti = r.data?.transferInstruments?.[0]?.id ?? null;
        if (ti) await stamp(loc.id, { transfer_instrument_id: ti });
      }
      if (!ti) {
        return json({ ok: false, kind: 'missing_prerequisite', message: 'The venue has not added a bank account yet. They add it on the hosted onboarding page (use Start onboarding / New onboarding link), then run this again.' }, 400);
      }

      const scheduleType = ['daily', 'weekly', 'monthly', 'balance', 'cron'].includes(String(body.schedule)) ? String(body.schedule) : 'daily';
      const schedule: Record<string, unknown> = { type: scheduleType };
      if (scheduleType === 'cron') {
        if (!body.cron_expression) return json({ ok: false, kind: 'missing_prerequisite', message: 'schedule "cron" needs cron_expression.' }, 400);
        schedule.cronExpression = String(body.cron_expression);
      }

      // Idempotent: reuse the existing push-to-this-bank sweep if there is one.
      const list = await bcl('GET', `/balanceAccounts/${encodeURIComponent(maa.balance_account_id)}/sweeps`);
      if (!list.ok) { const c = classify(list); return json({ ok: false, kind: c.kind, message: c.message }, 502); }
      const existing = (list.data?.sweeps ?? []).find((s: any) =>
        s?.type === 'push' && s?.category === 'bank' && s?.counterparty?.transferInstrumentId === ti);
      if (existing) {
        if (existing.schedule?.type !== scheduleType || (scheduleType === 'cron' && existing.schedule?.cronExpression !== schedule.cronExpression)) {
          const up = await bcl('PATCH', `/balanceAccounts/${encodeURIComponent(maa.balance_account_id)}/sweeps/${encodeURIComponent(existing.id)}`, { schedule });
          logStep('sweep_update', loc.id, { httpStatus: up.status, sweepId: existing.id, schedule, response: up.data ?? null });
          if (!up.ok) { const c = classify(up); return json({ ok: false, kind: c.kind, message: c.message }, 502); }
          return json({ ok: true, sweep: { id: existing.id, schedule: scheduleType, status: up.data?.status ?? existing.status ?? 'active' }, updated: true });
        }
        return json({ ok: true, sweep: { id: existing.id, schedule: existing.schedule?.type ?? scheduleType, status: existing.status ?? 'active' }, existed: true });
      }

      // No triggerAmount/targetAmount: the schedule fires and pushes the FULL
      // available balance to the venue's bank.
      const payload = {
        counterparty: { transferInstrumentId: ti },
        currency: String(loc.currency || 'GBP').toUpperCase(),
        category: 'bank',
        priorities: ['regular', 'fast'],
        schedule,
        status: 'active',
        type: 'push',
        description: `ServOS ${scheduleType} payout — ${loc.name}`.slice(0, 140),
      };
      const r = await bcl('POST', `/balanceAccounts/${encodeURIComponent(maa.balance_account_id)}/sweeps`, payload, `sweep:${loc.id}`);
      logStep('sweep_create', loc.id, { httpStatus: r.status, request: payload, response: r.data ?? null });
      if (!r.ok || !r.data?.id) { const c = classify(r); return json({ ok: false, kind: c.kind, message: c.message }, 502); }
      return json({ ok: true, sweep: { id: r.data.id, schedule: scheduleType, status: r.data.status ?? 'active' }, created: true });
    }

    return json({ error: `unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[adyen-onboard]', e);
    return json({ error: (e as Error).message || 'server error' }, 500);
  }
});
