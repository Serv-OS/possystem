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
import { getAccount, getPaymentSession } from '../_shared/ryft.ts';

const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// closed_checks live in the OPS DB — reconciliation reads/writes them here.
const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
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

// UK card-receipt block from a PaymentSession — best-effort, kept in step with cardOf()
// in terminal-job-charge so a webhook-settled job carries the same card block on its receipt.
function cardOfSession(d: any): { card: Record<string, unknown> | null; authCode: string | null; txnId: string | null } {
  let card: Record<string, unknown> | null = null;
  let authCode: string | null = null;
  let txnId: string | null = null;
  try {
    const pm = d?.paymentMethod ?? {};
    const c = pm.card ?? d?.card ?? {};
    const tx = d?.lastPaymentTransaction ?? d?.transaction ?? {};
    const brand = c.scheme ?? c.brand ?? pm.scheme ?? null;
    const last4 = c.last4 ?? c.lastFour ?? null;
    authCode = tx.approvalCode ?? tx.authorizationCode ?? d?.approvalCode ?? d?.authorizationCode ?? null;
    txnId = tx.id ?? null;
    if (brand || last4 || authCode) {
      card = { brand, last4, auth_code: authCode, read_method: d?.entryMode ?? tx.entryMode ?? null, aid: null, application_name: null, cvm: null, account_type: null };
    }
  } catch { /* best-effort */ }
  return { card, authCode, txnId };
}

// Reconcile a PaymentSession outcome (captured / refunded / voided) against our
// records. Writes a server-truth row to ryft_payments (Platform DB) and, on a
// refund, reflects it in the matching closed_check (Ops DB) — so a refund issued
// in the Ryft dashboard shows up in our reports, and a captured payment with no
// closed_check stays visible as an orphan (matched_closed_check = null).
// ── GIFT CARD FULFILMENT ─────────────────────────────────────────────────────
// v5.5.911 — the gift card is issued by a WEBHOOK, never by the browser. On Stripe
// that trigger is stripe-webhook-connect's `checkout.session.completed`; Ryft had no
// equivalent, which is precisely why gift purchases were Stripe-only. Wiring the Ryft
// purchase flow WITHOUT this would charge the customer and issue nothing.
//
// Deliberately NOT called from the client's success callback: that value is asserted by
// the browser, and a second automatic caller would race this one — gift-fulfill's
// idempotency is a read-then-insert, not a claim, so two callers can double-issue.
// This webhook is signature-verified and deduped on event_id upstream, so it is the one
// trustworthy trigger.
async function maybeFulfilGift(evt: any) {
  const ps: any = evt?.data ?? {};
  const meta = ps?.metadata ?? {};
  if (meta.type !== 'gift_card_purchase' || !meta.purchase_id) return;

  const { data: p } = await platformAdmin
    .from('gift_card_purchases')
    .select('id, amount_minor, status')
    .eq('id', meta.purchase_id)
    .maybeSingle();
  if (!p) { console.error('[ryft-webhook] gift purchase not found', meta.purchase_id); return; }
  if (p.status === 'fulfilled') return;                       // already issued — nothing to do

  // AMOUNT FENCE. The session is created server-side, but this costs nothing and closes
  // the whole class: never issue a card worth more than the money actually captured.
  const captured = Math.round(Number(ps?.amount ?? 0));
  if (!captured || captured < Number(p.amount_minor)) {
    console.error('[ryft-webhook] gift amount mismatch — NOT issuing', p.id, captured, p.amount_minor);
    return;
  }

  await platformAdmin.from('gift_card_purchases')
    .update({ status: 'paid', ryft_payment_session_id: ps.id ?? null })
    .eq('id', p.id);

  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/gift-fulfill`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`,
      },
      body: JSON.stringify({ purchase_id: p.id }),
    });
    if (!r.ok) console.error('[ryft-webhook] gift-fulfill failed', p.id, await r.text());
  } catch (e) {
    // The purchase is left at 'paid', so Back Office -> Gift cards -> Manual Fulfill can
    // finish it. Never throw: a 500 here makes Ryft retry the whole event.
    console.error('[ryft-webhook] gift-fulfill error', p.id, (e as Error).message);
  }
}

async function reconcilePayment(evt: any, type: string) {
  const dataPs: any = evt?.data ?? {};
  const psId: string | undefined = dataPs.id;
  const accountId: string | undefined = evt?.accountId ?? dataPs.accountId ?? dataPs.subAccount?.id;
  if (!psId) return;
  const nowIso = new Date().toISOString();
  if (accountId) await platformAdmin.from('merchant_ryft_accounts').update({ last_webhook_at: nowIso }).eq('ryft_account_id', accountId);

  const isRefund = type === 'PaymentSession.refunded';
  const isVoid = type === 'PaymentSession.voided';
  const status = isRefund ? 'Refunded' : isVoid ? 'Voided' : 'Captured';

  // Refunds: re-fetch the session for the authoritative cumulative refundedAmount
  // (event payloads can be partial). Captures/voids: trust the payload.
  let ps = dataPs;
  if (isRefund && accountId) {
    try { const got = await getPaymentSession(psId, { accountId }); if (got.ok && got.data) ps = got.data; } catch { /* keep payload */ }
  }

  let location_id: string | null = null;
  if (accountId) {
    const { data: mra } = await platformAdmin.from('merchant_ryft_accounts').select('location_id').eq('ryft_account_id', accountId).maybeSingle();
    location_id = mra?.location_id ?? null;
  }

  // Match the closed_check by the payment-session id (stored on Ryft checks as
  // stripe_payment_intent_id and/or inside payment_intents[].id).
  let matched: any = null;
  try {
    const a = await opsAdmin.from('closed_checks').select('id, refunds, status, total').eq('stripe_payment_intent_id', psId).limit(1);
    matched = a.data?.[0] ?? null;
    if (!matched) {
      const b = await opsAdmin.from('closed_checks').select('id, refunds, status, total').contains('payment_intents', [{ id: psId }]).limit(1);
      matched = b.data?.[0] ?? null;
    }
  } catch (e) { console.error('[ryft-webhook] closed_check match', (e as Error).message); }

  const refundedMinor = Math.round(Number(ps?.refundedAmount ?? 0));
  const meta = ps?.metadata ?? {};
  await platformAdmin.from('ryft_payments').upsert({
    payment_session_id: psId,
    ryft_account_id: accountId ?? null,
    location_id,
    amount: Math.round(Number(ps?.amount ?? 0)),
    amount_refunded: refundedMinor,
    currency: ps?.currency ?? null,
    status,
    channel: meta.channel ?? null,
    order_ref: meta.ref ?? meta.order_ref ?? null,
    matched_closed_check: matched?.id ?? null,
    raw: ps,
    updated_at: nowIso,
    ...(status === 'Captured' ? { captured_at: nowIso } : {}),
    ...(isRefund ? { refunded_at: nowIso } : {}),
  }, { onConflict: 'payment_session_id' });

  // v5.5.866 — B1 BACKSTOP. Settle the matching terminal_job so a PAX Table-Pay whose device
  // DIED mid-tender (app killed / backgrounded / network lost after the tap but before the
  // result-poll settled) is still driven to 'approved' server-side. terminal_job_settle_from_processor
  // is the ONE settlement writer; the POS reconciler then books the pre-minted closed_check and
  // closes the table. terminal_jobs.payment_session_id is unique; the RPC is idempotent on a
  // terminal status, so a webhook racing the device or the sweeper is a harmless no-op. Refund
  // events NEVER settle a job (the job settled long before any refund). Captured→approved, Voided→declined.
  if (!isRefund) {
    try {
      const { data: tj } = await opsAdmin
        .from('terminal_jobs').select('id').eq('payment_session_id', psId).maybeSingle();
      if (tj?.id) {
        const { card, authCode, txnId } = cardOfSession(ps);
        const { error: settleErr } = await opsAdmin.rpc('terminal_job_settle_from_processor', {
          p_job_id: tj.id,
          p_outcome: isVoid ? 'declined' : 'approved',
          p_payment_session_id: psId,
          p_transaction_id: txnId,
          p_auth_code: authCode,
          p_card: card,
          p_decline_reason: isVoid ? 'voided at processor' : null,
          p_source: 'webhook',
          p_session_amount_minor: Math.round(Number(ps?.amount ?? 0)),
        });
        if (settleErr) console.error('[ryft-webhook] terminal_job settle rpc', settleErr.message);
      }
    } catch (e) { console.error('[ryft-webhook] terminal_job settle', (e as Error).message); }
  }

  // Reflect a Ryft-side refund into the closed_check without double-counting a
  // refund our own app already recorded. refundedAmount is CUMULATIVE, so we
  // only append the delta beyond what's already on the check (amounts in £).
  // Re-read refunds immediately before writing to narrow the race with the
  // app's own refundCheck write, and key our entry on a deterministic id so a
  // duplicate/retry can't double-append.
  if (isRefund && matched && refundedMinor > 0) {
    const refundId = `ref-ryft-${psId}-${refundedMinor}`;
    const { data: fresh } = await opsAdmin.from('closed_checks').select('refunds, total').eq('id', matched.id).maybeSingle();
    const existing: any[] = Array.isArray(fresh?.refunds) ? fresh.refunds : [];
    if (!existing.some((r) => r?.id === refundId)) {
      const alreadyMajor = existing.reduce((s, r) => s + Number(r.amount ?? 0), 0);
      const refundedMajor = +(refundedMinor / 100).toFixed(2);
      if (refundedMajor > alreadyMajor + 0.005) {
        const delta = +(refundedMajor - alreadyMajor).toFixed(2);
        const refunds = [...existing, { id: refundId, timestamp: Date.now(), manager: 'Ryft', reason: 'Refunded in Ryft', amount: delta, source: 'ryft_reconcile' }];
        const total = Number(fresh?.total ?? matched.total ?? 0);
        const newStatus = refundedMajor >= total - 0.005 ? 'refunded' : 'partial_refund';
        await opsAdmin.from('closed_checks').update({ refunds, status: newStatus }).eq('id', matched.id);
      }
    }
  }
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
        const patch = {
          charges_enabled: d.charges_enabled,
          details_submitted: d.details_submitted,
          requirements: d.verification ?? null,
          country: d.country,
          last_webhook_at: new Date().toISOString(),
        };
        // AUTO-CONNECT: every account we create stamps metadata.location_id, so
        // the moment it's created / progresses through onboarding we upsert the
        // merchant row for that location — no manual "paste the account id" step
        // in the admin, and "ready to trade" lights up on its own. Accounts made
        // outside our system (no location_id metadata) fall back to updating an
        // existing row by account id.
        const metaLocId: string | undefined = account?.metadata?.location_id;
        if (metaLocId) {
          const { data: locRow } = await platformAdmin.from('locations').select('id, company_id').eq('id', metaLocId).maybeSingle();
          if (locRow?.id) {
            await platformAdmin.from('merchant_ryft_accounts').upsert({
              location_id: locRow.id,
              company_id: locRow.company_id ?? null,
              ryft_account_id: accountId,
              link_method: 'hosted',
              ...patch,
            }, { onConflict: 'location_id' });
          } else {
            await platformAdmin.from('merchant_ryft_accounts').update(patch).eq('ryft_account_id', accountId);
          }
        } else {
          await platformAdmin.from('merchant_ryft_accounts').update(patch).eq('ryft_account_id', accountId);
        }
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
    } else if (/^PaymentSession\.(captured|refunded|voided)$/.test(type)) {
      // Reconcile the money movement to our records (ledger + closed_check).
      await reconcilePayment(evt, type);
      // v5.5.911: a captured payment carrying gift metadata must ISSUE THE CARD.
      // This is the Ryft twin of stripe-webhook-connect's checkout.session.completed
      // branch. Without it a Ryft venue takes the customer's money and issues nothing.
      if (type === 'PaymentSession.captured') await maybeFulfilGift(evt);
    } else if (/^(PaymentSession|Person)\./.test(type)) {
      // Other lifecycle events (approved/declined, person updates) — just touch
      // last_webhook_at so we can see the account is active. Best-effort.
      const accountId: string | undefined = evt?.accountId ?? evt?.data?.accountId;
      if (accountId) await platformAdmin.from('merchant_ryft_accounts').update({ last_webhook_at: new Date().toISOString() }).eq('ryft_account_id', accountId);
    }
  } catch (e) {
    console.error('[ryft-webhook] handler error', (e as Error).message);
    // Still 200 — we verified the signature; don't trigger Ryft retries for our bug.
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
