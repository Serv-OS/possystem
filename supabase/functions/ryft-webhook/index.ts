// supabase/functions/ryft-webhook/index.ts
//
// Receives Ryft webhook events. The one we care about most: a sub-account's
// verification status changing — so merchant_ryft_accounts.charges_enabled
// flips to true AUTOMATICALLY the moment a merchant finishes onboarding, with
// no manual "Sync" needed.
//
// Auth = signature, not a JWT (Ryft calls this). Verify the `Signature` header:
// HMAC-SHA256 of the RAW body with the webhook endpoint secret (RYFT_WEBHOOK_SECRET).
// Deployed with verify_jwt=false. Must return 200 fast (Ryft retries on failure).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAccount } from '../_shared/ryft.ts';

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const WEBHOOK_SECRET = Deno.env.get('RYFT_WEBHOOK_SECRET') ?? '';

async function validSignature(rawBody: string, header: string): Promise<boolean> {
  if (!WEBHOOK_SECRET || !header) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ header.charCodeAt(i);  // constant-time-ish
  return diff === 0;
}

// Best-effort urgent email to the merchant when a dispute is raised. Email goes
// to the Ryft account email; routed through send-receipt (provider-agnostic).
// Best-effort merchant email: resolves the Ryft account email + ops location,
// routes through send-receipt (provider-agnostic). Never throws.
async function sendMerchantEmail(accountId: string | undefined, platformLocationId: string | null, subject: string, html: string) {
  try {
    if (!accountId || !platformLocationId) return;
    const acct = await getAccount(accountId);
    const email = acct.ok ? acct.data?.email : null;
    const { data: ploc } = await platformAdmin.from('locations').select('ops_location_id').eq('id', platformLocationId).maybeSingle();
    const opsLoc = ploc?.ops_location_id;
    if (!email || !opsLoc) return;
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}` },
      body: JSON.stringify({ to: email, subject, html, location_id: opsLoc }),
    });
  } catch (e) {
    console.error('[ryft-webhook] merchant email failed', (e as Error).message);
  }
}

async function alertDispute(d: any, accountId: string | undefined, platformLocationId: string | null) {
  const amount = ((Number(d.amount) || 0) / 100).toFixed(2);
  const by = d.respondBy ? new Date(Number(d.respondBy) * 1000).toUTCString() : 'soon';
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px">
    <h2 style="margin:0 0 8px">Action needed: a card payment was disputed</h2>
    <p>A customer has disputed a card payment of <strong>${d.currency || 'GBP'} ${amount}</strong>.</p>
    <p>You must respond by <strong>${by}</strong>. If you don't, it is lost automatically and a non-reclaimable fee applies.</p>
    <p>Open <strong>Back Office → Reports → Disputes &amp; chargebacks</strong> to accept it or challenge it with your evidence.</p>
  </div>`;
  await sendMerchantEmail(accountId, platformLocationId, 'Action needed: a card payment was disputed', html);
}

function deriveStatus(account: any) {
  const v = account?.verification ?? {};
  const caps = account?.capabilities ?? {};
  const anyEnabled = ['visaPayments', 'mastercardPayments', 'amexPayments', 'inPersonPayments'].some((k) => caps?.[k]?.status === 'Enabled');
  return {
    charges_enabled: anyEnabled || v?.status === 'Verified',
    details_submitted: !!v?.status && v.status !== 'Required',
    verification: v,
    country: account?.business?.registeredAddress?.country ?? account?.individual?.address?.country ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('Signature') ?? ''))) {
    return new Response('invalid signature', { status: 401 });
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const type: string = evt?.eventType ?? evt?.type ?? '';

  // Idempotency — Ryft retries (0,1,5,10,10,10 min). Record the event id once;
  // a duplicate delivery returns 200 without re-running side-effects.
  const eventId: string | undefined = evt?.id;
  if (eventId) {
    try {
      const { data: ins } = await platformAdmin.from('ryft_webhook_events')
        .upsert({ event_id: eventId, event_type: type, account_id: evt?.accountId ?? evt?.data?.subAccount?.id ?? evt?.data?.id ?? null }, { onConflict: 'event_id', ignoreDuplicates: true })
        .select('event_id');
      if (Array.isArray(ins) && ins.length === 0) {
        return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } catch { /* dedupe is best-effort; fall through and process */ }
  }

  try {
    if (/^Account\.(updated|verification_status_updated|created)$/.test(type)) {
      const accountId: string | undefined = evt?.data?.id ?? evt?.accountId;
      if (accountId) {
        // Re-fetch the account so we derive status from the authoritative source
        // (event payloads can be partial), then update the merchant row.
        const got = await getAccount(accountId);
        const account = got.ok ? got.data : (evt?.data ?? {});
        const d = deriveStatus(account);
        await platformAdmin.from('merchant_ryft_accounts').update({
          charges_enabled: d.charges_enabled,
          details_submitted: d.details_submitted,
          requirements: d.verification ?? null,
          country: d.country,
          last_webhook_at: new Date().toISOString(),
        }).eq('ryft_account_id', accountId);
      }
    } else if (/^Dispute\./.test(type)) {
      // Chargeback. Capture it with its respondBy DEADLINE so the merchant can
      // act before it auto-Expires. The event payload carries the full Dispute.
      const d: any = evt?.data ?? {};
      const disputeId: string | undefined = d.id;
      const accountId: string | undefined = d.subAccount?.id ?? evt?.accountId;
      if (disputeId) {
        let location_id: string | null = null;
        if (accountId) {
          const { data: mra } = await platformAdmin.from('merchant_ryft_accounts').select('location_id').eq('ryft_account_id', accountId).maybeSingle();
          location_id = mra?.location_id ?? null;
        }
        const nowIso = new Date().toISOString();
        await platformAdmin.from('merchant_ryft_disputes').upsert({
          dispute_id: disputeId,
          ryft_account_id: accountId ?? null,
          location_id,
          payment_session_id: d.paymentSession?.id ?? null,
          amount: d.amount ?? null,
          currency: d.currency ?? null,
          status: d.status ?? null,
          category: d.category ?? null,
          reason_code: d.reason?.code ?? null,
          reason_description: d.reason?.description ?? null,
          respond_by: d.respondBy ? new Date(Number(d.respondBy) * 1000).toISOString() : null,
          recommended_evidence: d.recommendedEvidence ?? null,
          evidence: d.evidence ?? null,
          raw: d,
          updated_at: nowIso,
          last_event_at: nowIso,
        }, { onConflict: 'dispute_id' });
        if (accountId) await platformAdmin.from('merchant_ryft_accounts').update({ last_webhook_at: nowIso }).eq('ryft_account_id', accountId);
        if (type === 'Dispute.created') await alertDispute(d, accountId, location_id);
      }
    } else if (/^Payout\./.test(type)) {
      // A failed/returned payout means the merchant's bank details are wrong and
      // their money is stuck — alert them. Successful payouts show in the report.
      const p: any = evt?.data ?? {};
      const accountId: string | undefined = evt?.accountId ?? p.accountId;
      if (accountId) {
        await platformAdmin.from('merchant_ryft_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('ryft_account_id', accountId);
        const st = String(p.status || '').toLowerCase();
        if (type === 'Payout.status_updated' && /(fail|return|revers|declin)/.test(st)) {
          const { data: mra } = await platformAdmin.from('merchant_ryft_accounts').select('location_id').eq('ryft_account_id', accountId).maybeSingle();
          const amount = ((Number(p.amount) || 0) / 100).toFixed(2);
          const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px">
            <h2 style="margin:0 0 8px">Your payout didn't go through</h2>
            <p>A payout of <strong>${p.currency || 'GBP'} ${amount}</strong> to your bank failed${p.failureReason ? `: ${p.failureReason}` : ''}.</p>
            <p>Please check your bank / payout details. Your funds stay safe in your balance until a payout succeeds.</p>
          </div>`;
          await sendMerchantEmail(accountId, mra?.location_id ?? null, "Your payout didn't go through", html);
        }
      }
    } else if (/^(PaymentSession|Person)\./.test(type)) {
      // Touch last_webhook_at so we can see the account is active. Best-effort.
      const accountId: string | undefined = evt?.accountId ?? evt?.data?.accountId;
      if (accountId) await platformAdmin.from('merchant_ryft_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('ryft_account_id', accountId);
    }
  } catch (e) {
    console.error('[ryft-webhook] handler error', (e as Error).message);
    // Still 200 — we verified the signature; don't trigger Ryft retries for our bug.
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
