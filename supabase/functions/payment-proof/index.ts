// supabase/functions/payment-proof/index.ts
//
// Database fence stage 1, contract C0. The ONLY writer of Ops public.payment_proofs.
//
// A customer page (online, QR, catering) asks: "I paid with this payment, please record it".
// This function looks the payment up at the PROCESSOR (or in our server written ledger for
// Adyen, gift cards and loyalty), checks it belongs to this venue and is in the state the kind
// asks for, and upserts one proof row with the amount the processor reports. Nothing in the
// request body is trusted for money. place_public_order and settle_qr_tab then count only
// these rows as "paid".
//
// Body: { ops_location_id, processor: 'stripe'|'ryft'|'adyen'|'gift'|'loyalty',
//         kind: 'card'|'preauth'|'capture'|'gift'|'loyalty', payment_ref }
// Answer: { ok: true, proof_id, amount_minor, kind } or { ok: false, reason }.
//   reason 'unsupported' means the payment_proofs table does not exist yet (20260919a not
//   run): the app then keeps today's path (FENCE STAGE 1 FALLBACK in src/lib/publicOrder.js).
//
// Deploy: npx supabase functions deploy payment-proof --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
// (it checks the caller's session itself: any session may ask, because a proof only records
// what the processor already says, for the venue the payment itself names).

import Stripe from 'https://esm.sh/stripe@14.21.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getPaymentSession } from '../_shared/ryft.ts';
import {
  parseProofRequest, stripeProof, ryftProof, adyenProof, giftProof, loyaltyProof, allowProofRequest,
  processorOrderRef, processorParentRef, loyaltyRewardValueMinor,
} from '../_shared/paymentProofRules.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { apiVersion: '2024-06-20' });
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

// Best effort throttle per caller, per function instance (about 30 proofs in 10 minutes).
const recent = new Map<string, number[]>();

const isMissingTable = (msg: string | undefined) =>
  /relation .*payment_proofs.* does not exist|could not find the table .*payment_proofs/i.test(String(msg || ''));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return json({ ok: false, reason: 'no_session' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ ok: false, reason: 'no_session' }, 401);

  const gate = allowProofRequest(recent.get(caller.id) || [], Date.now());
  recent.set(caller.id, gate.history);
  if (!gate.ok) return json({ ok: false, reason: 'rate' }, 429);

  let raw: unknown;
  try { raw = await req.json(); } catch { return json({ ok: false, reason: 'json' }, 400); }
  const parsed = parseProofRequest(raw);
  if (!parsed.ok) return json({ ok: false, reason: parsed.reason }, 400);
  const { ops_location_id: opsId, processor, kind, payment_ref: ref } = parsed.body;

  // The venue: its Platform row(s) and company.
  const { data: locs } = await platformAdmin.from('locations').select('id, company_id, ops_location_id')
    .or(`ops_location_id.eq.${opsId},id.eq.${opsId}`);
  const venueRows = (locs || []) as Array<{ id: string; company_id: string | null; ops_location_id: string | null }>;
  if (!venueRows.length) return json({ ok: false, reason: 'venue' }, 404);
  const platformIds = venueRows.map((l) => l.id);
  const companyId = venueRows.find((l) => l.company_id)?.company_id || null;

  let verdict: { ok: boolean; amount_minor?: number; currency?: string | null; reason?: string } = { ok: false, reason: 'not_seen' };
  const meta: Record<string, unknown> = { caller: caller.id };
  try {
    if (processor === 'stripe') {
      const { data: msa } = await platformAdmin.from('merchant_stripe_accounts')
        .select('stripe_account_id').in('location_id', platformIds).limit(1).maybeSingle();
      if (!msa?.stripe_account_id) return json({ ok: false, reason: 'no_account' }, 400);
      const pi = await stripe.paymentIntents.retrieve(ref, {}, { stripeAccount: msa.stripe_account_id });
      verdict = stripeProof(pi, kind, opsId);
      meta.status = (pi as any)?.status ?? null;
      // Fix round (C18): the order this payment was made for, from the processor's own record.
      meta.order_ref = processorOrderRef('stripe', pi);
      // Fix round 2 (C24): an overage names the tab's card hold it belongs to.
      meta.parent_ref = processorParentRef('stripe', pi);
    } else if (processor === 'ryft') {
      const { data: mra } = await platformAdmin.from('merchant_ryft_accounts')
        .select('ryft_account_id').in('location_id', platformIds).limit(1).maybeSingle();
      const accountId = (mra?.ryft_account_id as string | undefined) || undefined;
      const ses = await getPaymentSession(ref, accountId ? { accountId } : {});
      if (!ses.ok) return json({ ok: false, reason: ses.status === 404 ? 'not_seen' : 'processor' }, ses.status === 404 ? 404 : 502);
      verdict = ryftProof(ses.data, kind, { venueAccountId: accountId });
      meta.status = ses.data?.status ?? null;
      meta.order_ref = processorOrderRef('ryft', ses.data);
      meta.parent_ref = processorParentRef('ryft', ses.data);
    } else if (processor === 'adyen') {
      const { data: row } = await platformAdmin.from('adyen_payments')
        .select('psp_reference, location_id, amount_minor, currency, success, capture_required, captured_at, last_event_code, merchant_reference, raw')
        .eq('psp_reference', ref).maybeSingle();
      verdict = adyenProof(row, kind, { venuePlatformIds: platformIds });
      meta.order_ref = processorOrderRef('adyen', row);
    } else if (processor === 'gift') {
      const { data: tx } = await platformAdmin.from('gift_card_transactions')
        .select('type, company_id, amount_minor, card_id').eq('idempotency_key', ref).maybeSingle();
      verdict = giftProof(tx, { companyId });
    } else if (processor === 'loyalty') {
      let row: any = null;
      const { data: lt } = await opsAdmin.from('loyalty_transactions')
        .select('type, company_id, location_id, reward_id').eq('idempotency_key', ref).maybeSingle();
      row = lt;
      if (!row) {
        const { data: st } = await opsAdmin.from('stamp_transactions')
          .select('type, location_id').eq('idempotency_key', ref).maybeSingle();
        row = st;
      }
      // Fix round (C18): a reward with a fixed money value is recorded at that value (the
      // server caps a declared loyalty discount at it); otherwise the marker 1.
      let rewardValueMinor = 0;
      if (row?.reward_id && companyId) {
        const { data: reward } = await platformAdmin.from('loyalty_rewards')
          .select('reward_value').eq('id', row.reward_id).eq('company_id', companyId).maybeSingle();
        rewardValueMinor = loyaltyRewardValueMinor(reward);
      }
      verdict = loyaltyProof(row, { companyId, opsLocationId: opsId, rewardValueMinor });
    }
  } catch (e) {
    console.warn('[payment-proof] lookup failed:', (e as Error)?.message);
    return json({ ok: false, reason: 'processor' }, 502);
  }

  if (!verdict.ok) return json({ ok: false, reason: verdict.reason || 'not_seen' }, 409);
  if (meta.order_ref == null) delete meta.order_ref;
  if (meta.parent_ref == null) delete meta.parent_ref;

  const { data: up, error: upErr } = await opsAdmin.from('payment_proofs').upsert({
    processor,
    payment_ref: ref,
    kind,
    location_id: opsId,
    amount_minor: verdict.amount_minor,
    currency: verdict.currency ?? null,
    verified_at: new Date().toISOString(),
    verified_by: 'payment-proof',
    meta,
  }, { onConflict: 'processor,payment_ref,kind' }).select('id, amount_minor, used_by_ref').single();
  if (upErr) {
    if (isMissingTable(upErr.message)) return json({ ok: false, reason: 'unsupported' }, 200);
    console.error('[payment-proof] proof write failed:', upErr.message);
    return json({ ok: false, reason: 'write' }, 500);
  }
  return json({ ok: true, proof_id: up.id, amount_minor: up.amount_minor, kind, used: !!up.used_by_ref });
});
