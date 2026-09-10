// supabase/functions/adyen-bp-webhook/index.ts
//
// ServOS Payments PHASE 4 — the BALANCE PLATFORM webhook receiver. This is a
// SEPARATE stream from adyen-webhook (standard payment events): it is
// configured in the Balance Platform Customer Area (Developers → Webhooks),
// carries account-holder verification, balance-account, sweep and transfer
// events, and signs with the RAW-BODY HMAC scheme (base64 HMAC-SHA256 of the
// entire body in the HmacSignature header, key used as text) — NOT the
// per-item field recipe the standard stream uses. verifyRawBodyHmac in
// _shared/adyen.ts has waited for this fn since Phase 0.
//
// Register as: https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/adyen-bp-webhook
// Secrets: ADYEN_BP_HMAC_KEY (test) and, per live region, ADYEN_LIVE_UK_BP_HMAC_KEY
// and ADYEN_LIVE_US_BP_HMAC_KEY (the unsuffixed ADYEN_LIVE_BP_HMAC_KEY is the
// UK fallback) = the HMAC key generated on that webhook's config page in each
// account's Balance Platform Customer Area.
//
// PHILOSOPHY (same as adyen-webhook): durability first, semantics second.
// Every event lands RAW in PLATFORM adyen_bp_events (migration 20260821, which
// was applied to the platform project yhzjgyrkyjabvhblqxzu, beside
// merchant_adyen_accounts and adyen_payouts that this fn updates; 8 Sep 2026:
// the insert used to go to the ops project, which has no such table, so every
// delivery answered 500) before anything interprets it. HMAC is FAIL-CLOSED
// from day one — this stream is new, so there is no legacy observe-only period:
//   - key unset      → store raw with hmac_valid=false, answer 401 (Adyen
//                       retries; nothing is lost, nothing is trusted); a LIVE
//                       payload with no live key answers 503 (same verdict as
//                       the standard webhook's fail closed reject)
//   - bad signature  → store raw with hmac_valid=false, answer 401
//   - good signature → store, process, answer 200
//   - landing table missing / insert fails → 500 so Adyen retries; deploying
//     this fn before the migration can never lose an event.
//
// SEMANTICS (kept deliberately minimal):
//   balancePlatform.accountHolder.*  → merchant_adyen_accounts.verification_status
//                                       snapshot + receive_payments_ok /
//                                       payouts_ok (payouts_ok flips when the
//                                       sendToTransferInstrument capability
//                                       becomes allowed — THE payout gate)
//   balancePlatform.transfer.*       → Phase 4-lite: bank-category transfers
//                                       (the sweep paying the venue) upsert an
//                                       adyen_payouts row keyed on the transfer
//                                       id, carrying the status lifecycle the
//                                       Phase 2 report path deferred. Amounts /
//                                       lines stay report-fed.
//   everything else                   → stored raw only (replayable forever).
//
// ⚠ DEPLOY ME (edge functions deploy manually and drift silently):
//   npx supabase functions deploy adyen-bp-webhook --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyRawBodyHmac, normalizeAdyenEnv, normaliseAdyenRegion, webhookKeysFor, adyenSecretName, ADYEN_REGIONS, type AdyenEnv, type AdyenRegion } from '../_shared/adyen.ts';

// Everything this fn reads and writes lives in the PLATFORM project: the
// landing table, merchant_adyen_accounts and adyen_payouts.
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// PER VENUE ENVIRONMENT AND REGION (7 and 8 Sep 2026): Adyen posts test and
// live balance platform notifications to this ONE URL, each signed with its
// own HMAC key: ADYEN_BP_HMAC_KEY for test, and per live region
// ADYEN_LIVE_UK_BP_HMAC_KEY and ADYEN_LIVE_US_BP_HMAC_KEY (the UK and US live
// accounts are different Adyen accounts). The payload's own `environment`
// field only orders the attempts (it is unverified until a key matches); the
// candidates for each environment come from webhookKeysFor (live: every
// configured region key, UK then US; test: the test key). Whichever key
// verifies the raw body is the environment AND region of record, stamped on
// adyen_payouts.live and logged.
type Tried = { env: AdyenEnv; region: AdyenRegion };
const triedLabel = (t: Tried) => (t.env === 'live' ? `live ${t.region}` : 'test');
async function verifyBpSignature(rawBody: string, headerSig: string, declared: unknown): Promise<{ valid: boolean; env: AdyenEnv | null; region: AdyenRegion | null; anyKey: boolean; tried: Tried[] }> {
  const tried: Tried[] = [];
  if (!headerSig) return { valid: false, env: null, region: null, anyKey: false, tried };
  const first = normalizeAdyenEnv(declared);
  const order: AdyenEnv[] = first === 'live' ? ['live', 'test'] : ['test', 'live'];
  for (const env of order) {
    for (const c of webhookKeysFor(env === 'live', 'bpHmacKey')) {
      tried.push({ env, region: c.region });
      if (await verifyRawBodyHmac(rawBody, headerSig, c.hmacKey)) return { valid: true, env, region: c.region, anyKey: true, tried };
    }
  }
  return { valid: false, env: null, region: null, anyKey: tried.length > 0, tried };
}

// The region a balance platform event NAMES: the one region of the venue
// row(s) carrying its account holder or balance account (a stored 'EU' reads
// as UK). Read BEFORE verification only to tell a missing region key from a
// forgery and to name the secret; nothing is trusted from it. Null when the
// event names no venue we know, or an ambiguous set of them.
async function namedRegion(data: any): Promise<AdyenRegion | null> {
  const ah = String(data?.accountHolder?.id ?? data?.accountHolderId ?? '').trim();
  const ba = String(data?.balanceAccount?.id ?? data?.balanceAccountId ?? '').trim();
  if (!ah && !ba) return null;
  const base = platformAdmin.from('merchant_adyen_accounts').select('region');
  const { data: rows, error } = await (ah ? base.eq('account_holder_id', ah) : base.eq('balance_account_id', ba)).limit(5);
  if (error) { console.error('[adyen-bp-webhook] named region lookup failed:', error.message); return null; }
  const regions = new Set<AdyenRegion>((rows ?? []).map((r: any) => normaliseAdyenRegion(r?.region)));
  return regions.size === 1 ? [...regions][0] : null;
}

// Same capability→flags mapping adyen-onboard uses on its status sync. Under
// AfP: receiveFromPlatformPayments = split funds may land in the balance
// account; sendToTransferInstrument = bank payouts allowed.
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

// Transfer status → the adyen_payouts lifecycle words (initiated | sent | failed).
function payoutStatus(s: string): string {
  if (/failed|returned|cancelled|refused|rejected|error/i.test(s)) return 'failed';
  if (/booked|credited/i.test(s)) return 'sent';
  return 'initiated';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Raw body FIRST — the HMAC covers the exact bytes.
  const rawBody = await req.text();
  const headerSig = req.headers.get('HmacSignature') ?? req.headers.get('hmacsignature') ?? '';
  const hmacPresent = !!headerSig;

  let payload: any = null;
  try { payload = JSON.parse(rawBody); } catch { payload = { unparseable: rawBody.slice(0, 8000) }; }
  const type = typeof payload?.type === 'string' ? payload.type : null;
  const data = payload?.data ?? {};

  // Try the declared environment's key first, then the other; the key that
  // verifies IS the environment (payload.environment alone is not trusted).
  const sig = await verifyBpSignature(rawBody, headerSig, payload?.environment);
  const hmacValid = sig.valid;
  const matchedEnv: AdyenEnv | null = sig.env;
  const matchedRegion: AdyenRegion | null = sig.region;
  if (hmacValid) console.log(`[adyen-bp-webhook] HMAC verified with the ${matchedEnv === 'live' ? `live ${matchedRegion}` : 'test'} key (payload says ${payload?.environment ?? 'nothing'})`);

  // ── 1. Land it durably (PLATFORM adyen_bp_events, migration 20260821) ─────
  const { data: landed, error: landErr } = await platformAdmin.from('adyen_bp_events').insert({
    event_type: type,
    environment: payload?.environment ?? null,
    account_holder_id: data?.accountHolder?.id ?? null,
    balance_account_id: data?.balanceAccount?.id ?? data?.balanceAccountId ?? null,
    transfer_id: type?.startsWith('balancePlatform.transfer.') ? (data?.id ?? null) : null,
    hmac_present: hmacPresent,
    hmac_valid: hmacValid,
    raw: payload,
  }).select('id').single();
  if (landErr) {
    // Durability by retry: refuse the delivery so Adyen redelivers.
    console.error('[adyen-bp-webhook] landing insert failed:', landErr.message);
    return new Response('storage failed', { status: 500 });
  }

  // ── 2. Fail closed on signature ──────────────────────────────────────────
  if (!hmacValid) {
    const declaredLive = normalizeAdyenEnv(payload?.environment) === 'live';
    const liveKeyMissing = declaredLive && !sig.tried.some((t) => t.env === 'live');
    // The region the event NAMES (its account holder or balance account on a
    // venue row) whose live key was never tried because it is not set: the
    // same configuration gap as no live key at all (8 Sep 2026; it used to
    // read as a forgery, 401, with the missing secret never named).
    const named = declaredLive && !liveKeyMissing ? await namedRegion(data) : null;
    const namedKeyMissing = !!named && !sig.tried.some((t) => t.env === 'live' && t.region === named);
    const liveNames = ADYEN_REGIONS.map((r) => adyenSecretName('live', 'bpHmacKey', r)).join(' / ');
    console.error(`[adyen-bp-webhook] HMAC ${sig.anyKey ? `INVALID with the ${sig.tried.map(triedLabel).join(' and ')} key${sig.tried.length > 1 ? 's' : ''}` : `unverifiable (${adyenSecretName('test', 'bpHmacKey')} / ${liveNames} not set)`}${liveKeyMissing ? ` (payload says live and neither ${liveNames} is set)` : ''}${namedKeyMissing && named ? ` (the event names the ${named} account and ${adyenSecretName('live', 'bpHmacKey', named)} is not set)` : ''}, stored raw (${landed?.id}), refusing`);
    // A live event that could not even be tried against ITS live key is a
    // configuration gap, not a forgery: 503 so Adyen keeps retrying and the
    // event is applied once the key exists (the standard webhook's verdict).
    if (liveKeyMissing || namedKeyMissing) return new Response('live balance platform HMAC key not configured', { status: 503 });
    return new Response('invalid hmac', { status: 401 });
  }

  // ── 3. Semantics (best-effort ON TOP of the stored raw event) ────────────
  let processed = false;
  try {
    if (type?.startsWith('balancePlatform.accountHolder.')) {
      const ah = data?.accountHolder ?? {};
      if (ah?.id) {
        const flags = capabilityFlags(ah.capabilities);
        // receive_payments_ok is "the venue's payments may name its store",
        // which a STORE grants on its own (ensure_store writes true). The
        // account holder's capability is false until KYC completes and must
        // not take the store away from every online payment (8 Sep 2026).
        // payouts_ok is the CAPABILITY (Adyen allows payouts to the venue's
        // bank), so this webhook follows it both ways: a capability blip
        // lowers it and its return raises it again. Whether the venue is
        // actually PAID OUT (the daily push sweep) is a separate column,
        // payout_sweep_id, that only adyen-terminal-admin and adyen-onboard
        // write; the admin list chip reads the two together (9 Sep 2026).
        const { data: rows, error: readErr } = await platformAdmin.from('merchant_adyen_accounts')
          .select('location_id, store_id, payouts_ok').eq('account_holder_id', ah.id);
        if (readErr) console.error('[adyen-bp-webhook] accountHolder venue read failed:', readErr.message);
        else if (!rows?.length) console.warn(`[adyen-bp-webhook] accountHolder ${ah.id} matches no venue (yet) — raw kept for replay`);
        else {
          for (const row of rows) {
            const { error } = await platformAdmin.from('merchant_adyen_accounts').update({
              verification_status: {
                source: 'bp_webhook',
                at: payload?.timestamp ?? new Date().toISOString(),
                accountHolderStatus: ah.status ?? null,
                capabilities: capabilitySnapshot(ah.capabilities),
              },
              receive_payments_ok: flags.receive_ok || !!row.store_id,
              payouts_ok: flags.payouts_ok,
              last_webhook_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('location_id', row.location_id);
            if (error) console.error('[adyen-bp-webhook] accountHolder update failed:', error.message);
            else processed = true;
          }
        }
      }
    } else if (type?.startsWith('balancePlatform.balanceAccount.')) {
      // Minimal: freshness stamp on the owning venue; the raw row is the record.
      const baId = data?.balanceAccount?.id ?? data?.id ?? null;
      if (baId) {
        const { data: updated } = await platformAdmin.from('merchant_adyen_accounts')
          .update({ last_webhook_at: new Date().toISOString() }).eq('balance_account_id', baId).select('location_id');
        processed = !!updated?.length;
      }
    } else if (type?.startsWith('balancePlatform.transfer.')) {
      // Phase 4-lite, deliberately narrow: only BANK-category outgoing
      // transfers (the sweep paying the venue's bank) get a ledger row. All
      // other transfer traffic (platformPayment splits, internal moves, fees)
      // stays raw-only until a later phase needs it.
      if (data?.category === 'bank' && data?.direction === 'outgoing' && data?.id) {
        let locationId: string | null = null;
        const baId = data?.balanceAccount?.id ?? null;
        if (baId) {
          const { data: m } = await platformAdmin.from('merchant_adyen_accounts')
            .select('location_id').eq('balance_account_id', baId).maybeSingle();
          locationId = m?.location_id ?? null;
        }
        const when = data?.executionDate ?? data?.createdAt ?? payload?.timestamp ?? new Date().toISOString();
        const payout: Record<string, unknown> = {
          reference: data.id,                              // transfer id — its own reference space vs report batches
          location_id: locationId,
          balance_account_id: baId,
          payout_date: String(when).slice(0, 10),
          amount_minor: Number(data?.amount?.value ?? 0) || null,
          currency: data?.amount?.currency ?? null,
          status: payoutStatus(String(data?.status ?? '')),
          raw: { transfer: { id: data.id, status: data?.status ?? null, type: data?.type ?? null, reason: data?.reason ?? null } },
          updated_at: new Date().toISOString(),
        };
        if (matchedEnv) payout.live = matchedEnv === 'live';   // the key that verified (20260907 migration)
        if (matchedEnv === 'live' && matchedRegion) (payout.raw as Record<string, unknown>).region = matchedRegion;   // which live account signed it
        let { error } = await platformAdmin.from('adyen_payouts').upsert(payout, { onConflict: 'reference' });
        if (error && /live|42703|does not exist/i.test(String(error.message)) && 'live' in payout) {
          delete payout.live;                                // 20260907 not applied yet
          ({ error } = await platformAdmin.from('adyen_payouts').upsert(payout, { onConflict: 'reference' }));
        }
        if (error) console.error('[adyen-bp-webhook] payout upsert failed:', error.message);
        else processed = true;
      } else {
        processed = true;                                  // consciously raw-only
      }
    }
  } catch (e) {
    // A semantics bug can never lose the event — it is already stored.
    console.error('[adyen-bp-webhook] processing error:', (e as Error).message);
  }

  if (processed && landed?.id) {
    await platformAdmin.from('adyen_bp_events').update({ processed_at: new Date().toISOString() }).eq('id', landed.id);
  }

  // Any 2xx accepts the webhook (BalancePlatformNotificationResponse).
  return new Response(JSON.stringify({ notificationResponse: '[accepted]' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
