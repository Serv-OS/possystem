// supabase/functions/adyen-webhook/index.ts
//
// Receives BOTH Adyen webhook families (Phase 0 of ADYEN_INTEGRATION_PLAN.md):
//
//  A. STANDARD webhooks — envelope { live, notificationItems: [{ NotificationRequestItem }] }.
//     Signature is PER ITEM: HMAC-SHA256 over a field-built signing string, key
//     decoded from hex, base64 result in additionalData.hmacSignature.
//     Events handled: AUTHORISATION, CAPTURE(_FAILED), REFUND(_FAILED),
//     CANCELLATION, CHARGEBACK family, REPORT_AVAILABLE.
//
//  B. BALANCE PLATFORM webhooks — single JSON object with `type` like
//     'balancePlatform.transfer.updated'; raw-body HMAC in the HmacSignature header.
//     Used for payout/sweep tracking into adyen_payouts.
//
// Contract with Adyen: acknowledge fast with HTTP 200 '[accepted]' — store first,
// process after. Retries arrive with identical content; adyen_webhook_events PK
// makes processing idempotent. FAIL CLOSED: no HMAC key configured → 401
// (deployable before the test keys arrive without accepting junk).
// Deployed with verify_jwt=false (Adyen calls this, not a user).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyNotificationItem, verifyRawBodyHmac, cardFromWebhookAdditionalData } from '../_shared/adyen.ts';

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const HMAC_KEY = Deno.env.get('ADYEN_HMAC_KEY') ?? '';        // standard webhooks (hex)
const BP_HMAC_KEY = Deno.env.get('ADYEN_BP_HMAC_KEY') ?? '';  // balance platform (raw text)

const DISPUTE_EVENTS = new Set(['CHARGEBACK', 'SECOND_CHARGEBACK', 'CHARGEBACK_REVERSED', 'NOTIFICATION_OF_CHARGEBACK', 'REQUEST_FOR_INFORMATION']);

// Venue resolution: the merchant account is shared per region — the STORE is the
// per-venue key (additionalData.store, set because every payment we make carries
// the venue's store). Falls back to merchant_reference → closed_check → location.
async function locationForItem(item: any): Promise<string | null> {
  const store = item?.additionalData?.store ?? null;
  if (store) {
    const { data } = await platformAdmin.from('merchant_adyen_accounts').select('location_id').eq('store_id', store).maybeSingle();
    if (data?.location_id) return data.location_id;
  }
  return null;
}

async function matchClosedCheck(psp: string, originalRef: string | null): Promise<any | null> {
  // Same two-step idiom as ryft-webhook: the reference our app stored is either in
  // stripe_payment_intent_id (misnamed catch-all) or a payment_intents[] leg id.
  for (const ref of [originalRef, psp].filter(Boolean) as string[]) {
    try {
      const a = await opsAdmin.from('closed_checks').select('id, refunds, status, total').eq('stripe_payment_intent_id', ref).limit(1);
      if (a.data?.[0]) return a.data[0];
      const b = await opsAdmin.from('closed_checks').select('id, refunds, status, total').contains('payment_intents', [{ id: ref }]).limit(1);
      if (b.data?.[0]) return b.data[0];
    } catch (e) { console.error('[adyen-webhook] closed_check match', (e as Error).message); }
  }
  return null;
}

async function handleAuthorisation(item: any) {
  const psp = item.pspReference;
  const success = String(item.success) === 'true';
  const location_id = await locationForItem(item);
  const matched = await matchClosedCheck(psp, item.merchantReference ?? null);

  await platformAdmin.from('adyen_payments').upsert({
    psp_reference: psp,
    merchant_reference: item.merchantReference ?? null,
    location_id,
    merchant_account: item.merchantAccountCode ?? null,
    store: item?.additionalData?.store ?? null,
    channel: item?.additionalData?.shopperInteraction === 'POS' ? 'pos' : 'online',
    last_event_code: 'AUTHORISATION',
    success,
    amount_minor: Math.round(Number(item?.amount?.value ?? 0)),
    currency: item?.amount?.currency ?? null,
    card: cardFromWebhookAdditionalData(item?.additionalData),
    matched_closed_check: matched?.id ?? null,
    raw: item,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'psp_reference' });

  // B1-backstop parity (ryft-webhook v5.5.866): a terminal job whose device died
  // mid-tender still settles server-side. Success only — a failed AUTHORISATION
  // never force-declines a job that may retry another tender.
  // v968 (review finding): match by the `tj-{id}` merchantReference FIRST —
  // payment_session_id only exists AFTER settle, so it can never find the
  // in-flight job this backstop exists for. The session-id match remains for
  // late duplicates (harmless idempotent no-op on settled rows).
  if (success) {
    try {
      let tj: any = null;
      const mref = String(item.merchantReference ?? '');
      if (mref.startsWith('tj-')) {
        const byRef = await opsAdmin.from('terminal_jobs')
          .select('id, processor, status').eq('id', mref.slice(3)).maybeSingle();
        tj = byRef.data ?? null;
      }
      if (!tj) {
        const bySession = await opsAdmin.from('terminal_jobs')
          .select('id, processor, status').eq('payment_session_id', psp).maybeSingle();
        tj = bySession.data ?? null;
      }
      if (tj?.id && tj.processor === 'adyen') {
        const ad = item?.additionalData ?? {};
        const { error: settleErr } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
          p_job_id: tj.id,
          p_outcome: 'approved',
          p_payment_session_id: psp,
          p_transaction_id: psp,
          p_auth_code: ad['authCode'] ?? null,
          p_card: cardFromWebhookAdditionalData(ad),
          p_decline_reason: null,
          p_source: 'webhook',
          p_session_amount_minor: Math.round(Number(item?.amount?.value ?? 0)),
        });
        if (settleErr) console.error('[adyen-webhook] terminal_job settle rpc', settleErr.message);
      }
    } catch (e) { console.error('[adyen-webhook] terminal_job settle', (e as Error).message); }
  }
}

async function handleCaptureOrCancel(item: any, eventCode: string) {
  const parent = item.originalReference || item.pspReference;
  await platformAdmin.from('adyen_payments')
    .update({ last_event_code: eventCode, updated_at: new Date().toISOString() })
    .eq('psp_reference', parent);
}

async function handleRefund(item: any) {
  const success = String(item.success) === 'true';
  const parent = item.originalReference || item.pspReference;
  const refundMinor = Math.round(Number(item?.amount?.value ?? 0));
  if (!success || refundMinor <= 0) {
    await platformAdmin.from('adyen_payments')
      .update({ last_event_code: 'REFUND_FAILED', updated_at: new Date().toISOString() })
      .eq('psp_reference', parent);
    return;
  }

  // Ledger: cumulative refunded on the PARENT row. The event_key dedupe upstream
  // makes retries idempotent, so a plain increment is safe here.
  const { data: ledger } = await platformAdmin.from('adyen_payments')
    .select('psp_reference, amount_refunded_minor, matched_closed_check').eq('psp_reference', parent).maybeSingle();
  const cumulative = Math.round(Number(ledger?.amount_refunded_minor ?? 0)) + refundMinor;
  await platformAdmin.from('adyen_payments').upsert({
    psp_reference: parent,
    last_event_code: 'REFUND',
    amount_refunded_minor: cumulative,
    raw: item,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'psp_reference' });

  // Reflect a dashboard-initiated refund into the closed_check without double-
  // counting one our own app already recorded (identical contract to ryft-webhook:
  // deterministic id + append only the delta beyond what's already on the check).
  const matched = ledger?.matched_closed_check
    ? { id: ledger.matched_closed_check }
    : await matchClosedCheck(parent, item.merchantReference ?? null);
  if (matched?.id) {
    const refundId = `ref-adyen-${item.pspReference}`;
    const { data: fresh } = await opsAdmin.from('closed_checks').select('refunds, total').eq('id', matched.id).maybeSingle();
    const existing: any[] = Array.isArray(fresh?.refunds) ? fresh.refunds : [];
    if (!existing.some((r) => r?.id === refundId)) {
      const alreadyMajor = existing.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      const cumulativeMajor = +(cumulative / 100).toFixed(2);
      if (cumulativeMajor > alreadyMajor + 0.005) {
        const delta = +(cumulativeMajor - alreadyMajor).toFixed(2);
        const refunds = [...existing, { id: refundId, timestamp: Date.now(), manager: 'Adyen', reason: 'Refunded at Adyen', amount: delta, source: 'adyen_reconcile' }];
        const total = Number(fresh?.total ?? 0);
        const newStatus = cumulativeMajor >= total - 0.005 ? 'refunded' : 'partial_refund';
        await opsAdmin.from('closed_checks').update({ refunds, status: newStatus }).eq('id', matched.id);
      }
    }
  }
}

async function handleDispute(item: any, eventCode: string) {
  const parent = item.originalReference || item.pspReference;
  const ad = item?.additionalData ?? {};
  const location_id = await locationForItem(item)
    ?? (await platformAdmin.from('adyen_payments').select('location_id').eq('psp_reference', parent).maybeSingle()).data?.location_id
    ?? null;
  const status =
    eventCode === 'REQUEST_FOR_INFORMATION' ? 'info_requested'
    : eventCode === 'NOTIFICATION_OF_CHARGEBACK' ? 'open'
    : eventCode === 'CHARGEBACK_REVERSED' ? 'won'
    : String(item.success) === 'true' ? 'open' : 'open';
  await platformAdmin.from('merchant_adyen_disputes').upsert({
    dispute_psp_reference: item.pspReference,
    payment_psp_reference: parent,
    location_id,
    status,
    reason_code: ad['chargebackReasonCode'] ?? null,
    reason: ad['chargebackReason'] ?? null,
    amount_minor: Math.round(Number(item?.amount?.value ?? 0)),
    currency: item?.amount?.currency ?? null,
    respond_by: ad['defensePeriodEndsAt'] ?? null,
    raw: item,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'dispute_psp_reference' });
}

// REPORT_AVAILABLE: record name + download URL now; adyen-report-ingest (Phase 5)
// turns settlement-details reports into adyen_payouts(_lines).
async function handleReportAvailable(item: any) {
  await platformAdmin.from('adyen_webhook_events')
    .update({ raw: { report: item.pspReference, url: item.reason ?? null, merchantAccount: item.merchantAccountCode ?? null, item } })
    .eq('event_key', eventKey(item));
}

const eventKey = (item: any) => `${item?.pspReference ?? 'no-psp'}:${item?.eventCode ?? 'no-event'}:${item?.success ?? ''}`;

async function processItem(item: any) {
  const code = item?.eventCode ?? '';
  if (code === 'AUTHORISATION') return handleAuthorisation(item);
  if (code === 'CAPTURE' || code === 'CAPTURE_FAILED' || code === 'CANCELLATION') return handleCaptureOrCancel(item, code);
  if (code === 'REFUND' || code === 'REFUND_FAILED' || code === 'REFUNDED_REVERSED') return handleRefund(item);
  if (DISPUTE_EVENTS.has(code)) return handleDispute(item, code);
  if (code === 'REPORT_AVAILABLE') return handleReportAvailable(item);
  // Everything else is already stored raw by the dedupe insert — nothing to do.
}

// Balance Platform family — payout/sweep tracking. Store what we can recognise.
async function processBalancePlatformEvent(evt: any) {
  const type: string = evt?.type ?? '';
  const data = evt?.data ?? {};
  if (type.startsWith('balancePlatform.transfer.')) {
    const transfer = data?.transfer ?? data;
    const isPayout = (transfer?.category === 'bank') || (transfer?.type === 'bankTransfer');
    if (!isPayout) return;
    const ref = transfer?.reference ?? transfer?.id ?? null;
    if (!ref) return;
    const ba = transfer?.balanceAccountId ?? transfer?.balanceAccount?.id ?? null;
    const { data: maa } = ba
      ? await platformAdmin.from('merchant_adyen_accounts').select('location_id').eq('balance_account_id', ba).maybeSingle()
      : { data: null } as any;
    await platformAdmin.from('adyen_payouts').upsert({
      reference: ref,
      location_id: maa?.location_id ?? null,
      balance_account_id: ba,
      payout_date: (transfer?.creationDate ?? new Date().toISOString()).slice(0, 10),
      amount_minor: Math.round(Number(transfer?.amount?.value ?? 0)),
      currency: transfer?.amount?.currency ?? null,
      status: transfer?.status ?? evt?.type?.split('.').pop() ?? null,
      destination_last4: (transfer?.counterparty?.bankAccount?.accountIdentification?.iban
        ?? transfer?.counterparty?.bankAccount?.accountIdentification?.accountNumber ?? '').slice(-4) || null,
      raw: evt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'reference' });
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const raw = await req.text();

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  // ── Family B: Balance Platform (single object, raw-body HMAC header) ──────
  if (!Array.isArray(body?.notificationItems)) {
    if (!(await verifyRawBodyHmac(raw, req.headers.get('HmacSignature') ?? '', BP_HMAC_KEY))) {
      return new Response('invalid signature', { status: 401 }); // fail closed pre-keys
    }
    const key = `bp:${body?.data?.id ?? body?.id ?? crypto.randomUUID()}:${body?.type ?? ''}`;
    const { error: dupErr } = await platformAdmin.from('adyen_webhook_events').insert({ event_key: key, raw: body });
    if (!dupErr) { try { await processBalancePlatformEvent(body); } catch (e) { console.error('[adyen-webhook] bp process', (e as Error).message); } }
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // ── Family A: standard notification items (per-item HMAC) ─────────────────
  if (!HMAC_KEY) return new Response('webhook not configured', { status: 401 }); // fail closed pre-keys
  for (const wrapper of body.notificationItems) {
    const item = wrapper?.NotificationRequestItem;
    if (!item) continue;
    if (!(await verifyNotificationItem(item, HMAC_KEY))) {
      console.error('[adyen-webhook] HMAC mismatch', item?.eventCode, item?.pspReference);
      continue; // never process an unauthenticated item; still 200 the envelope per Adyen contract
    }
    // Dedupe FIRST (PK insert), process after — retries become no-ops.
    const { error: dupErr } = await platformAdmin.from('adyen_webhook_events').insert({ event_key: eventKey(item), raw: item });
    if (dupErr) continue; // duplicate delivery
    try { await processItem(item); } catch (e) { console.error('[adyen-webhook] process', item?.eventCode, (e as Error).message); }
    // Stamp venue liveness for the BO account screen.
    try {
      const store = item?.additionalData?.store;
      if (store) await platformAdmin.from('merchant_adyen_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('store_id', store);
    } catch { /* best effort */ }
  }
  return new Response('[accepted]', { status: 200 });
});
