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
// Secret: ADYEN_BP_HMAC_KEY = the HMAC key generated on that webhook's config
// page in the Balance Platform Customer Area.
//
// PHILOSOPHY (same as adyen-webhook): durability first, semantics second.
// Every event lands RAW in ops adyen_bp_events (migration 20260821) before
// anything interprets it. HMAC is FAIL-CLOSED from day one — this stream is
// new, so there is no legacy observe-only period:
//   - key unset      → store raw with hmac_valid=false, answer 401 (Adyen
//                       retries; nothing is lost, nothing is trusted)
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
import { verifyRawBodyHmac } from '../_shared/adyen.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const BP_HMAC_KEY = Deno.env.get('ADYEN_BP_HMAC_KEY') ?? '';

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
  const hmacValid = BP_HMAC_KEY ? await verifyRawBodyHmac(rawBody, headerSig, BP_HMAC_KEY) : false;

  let payload: any = null;
  try { payload = JSON.parse(rawBody); } catch { payload = { unparseable: rawBody.slice(0, 8000) }; }
  const type = typeof payload?.type === 'string' ? payload.type : null;
  const data = payload?.data ?? {};

  // ── 1. Land it durably (ops adyen_bp_events, migration 20260821) ──────────
  const { data: landed, error: landErr } = await admin.from('adyen_bp_events').insert({
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
    console.error(`[adyen-bp-webhook] HMAC ${BP_HMAC_KEY ? 'INVALID' : 'unverifiable (ADYEN_BP_HMAC_KEY not set)'} — stored raw (${landed?.id}), refusing`);
    return new Response('invalid hmac', { status: 401 });
  }

  // ── 3. Semantics (best-effort ON TOP of the stored raw event) ────────────
  let processed = false;
  try {
    if (type?.startsWith('balancePlatform.accountHolder.')) {
      const ah = data?.accountHolder ?? {};
      if (ah?.id) {
        const flags = capabilityFlags(ah.capabilities);
        const { data: updated, error } = await platformAdmin.from('merchant_adyen_accounts').update({
          verification_status: {
            source: 'bp_webhook',
            at: payload?.timestamp ?? new Date().toISOString(),
            accountHolderStatus: ah.status ?? null,
            capabilities: capabilitySnapshot(ah.capabilities),
          },
          receive_payments_ok: flags.receive_ok,
          payouts_ok: flags.payouts_ok,
          last_webhook_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('account_holder_id', ah.id).select('location_id');
        if (error) console.error('[adyen-bp-webhook] accountHolder update failed:', error.message);
        else if (!updated?.length) console.warn(`[adyen-bp-webhook] accountHolder ${ah.id} matches no venue (yet) — raw kept for replay`);
        else processed = true;
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
        const { error } = await platformAdmin.from('adyen_payouts').upsert({
          reference: data.id,                              // transfer id — its own reference space vs report batches
          location_id: locationId,
          balance_account_id: baId,
          payout_date: String(when).slice(0, 10),
          amount_minor: Number(data?.amount?.value ?? 0) || null,
          currency: data?.amount?.currency ?? null,
          status: payoutStatus(String(data?.status ?? '')),
          raw: { transfer: { id: data.id, status: data?.status ?? null, type: data?.type ?? null, reason: data?.reason ?? null } },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'reference' });
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
    await admin.from('adyen_bp_events').update({ processed_at: new Date().toISOString() }).eq('id', landed.id);
  }

  // Any 2xx accepts the webhook (BalancePlatformNotificationResponse).
  return new Response(JSON.stringify({ notificationResponse: '[accepted]' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
