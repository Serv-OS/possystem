// supabase/functions/ryft-tab/index.ts
//
// Ryft open-tab (pre-auth) lifecycle. The tab is opened as a MANUAL-capture
// session (auth held up to 7 days, card saved); this function closes it.
//   capture  { location_id, payment_session_id, amount_minor }  → capture up to the held amount
//   void     { location_id, payment_session_id }                → release the hold (no-show/cancel)
//   overage  { location_id, previous_session_id, amount_minor, customer_email? }
//                → bill exceeded the hold: charge the difference off-session on the saved card
//
// Auth mirrors stripe-refund / ryft-refund: any valid signed-in user (the POS /
// customer-side close uses an anonymous device JWT). location_id resolves the
// merchant sub-account (the Account header).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { capturePaymentSession, voidPaymentSession, createPaymentSession, getPaymentSession, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const ryftErr = (d: any): string | null => d?.errors?.[0]?.message || d?.message || null;

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const opsLocationId = String(body?.location_id ?? '').trim();
  if (!action || !opsLocationId) return json({ error: 'action and location_id required' }, 400);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);

  const { data: loc } = await platformAdmin.from('locations').select('id')
    .or(`ops_location_id.eq.${opsLocationId},id.eq.${opsLocationId}`).maybeSingle();
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);
  const { data: mra } = await platformAdmin.from('merchant_ryft_accounts')
    .select('ryft_account_id, markup_percent, markup_fixed_pence').eq('location_id', loc.id).maybeSingle();
  const accountId = mra?.ryft_account_id as string | undefined;
  const opts = accountId ? { accountId } : {};

  // ── capture: take the actual bill, up to the held amount ────────────────
  if (action === 'capture') {
    const sid = String(body.payment_session_id ?? '').trim();
    const amount = Math.round(Number(body.amount_minor));
    if (!sid || !Number.isFinite(amount) || amount <= 0) return json({ error: 'payment_session_id and a positive amount_minor required' }, 400);

    // Clamp to the authorised hold — Ryft (like Stripe) rejects over-capture.
    // Read the session's authorised amount and never ask for more; surface any
    // shortfall so the caller can chase it as an off-session overage charge.
    const ses = await getPaymentSession(sid, opts);
    if (!ses.ok) return json({ error: ryftErr(ses.data) || `Could not read session (${ses.status})`, ryft: ses.data }, ses.status >= 400 && ses.status < 500 ? 400 : 502);
    const authorised = Math.round(Number(ses.data?.amount ?? 0));
    const captureAmount = authorised > 0 ? Math.min(amount, authorised) : amount;
    const shortfall = Math.max(0, amount - captureAmount);

    // captureType Final closes the hold and releases any unused authorisation.
    const res = await capturePaymentSession(sid, { amount: captureAmount, captureType: 'Final' }, opts);
    if (!res.ok) return json({ error: ryftErr(res.data) || `Capture failed (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
    // Echo the hold's currency so the caller charges any overage in the SAME
    // currency (the off-session MIT references this session — a mismatch is
    // rejected). Don't assume GBP — venues can be USD/EUR.
    return json({ success: true, captured: res.data, captured_amount: captureAmount, shortfall, capped_from_overage: shortfall > 0, currency: ses.data?.currency ?? null });
  }

  // ── void: release the hold ──────────────────────────────────────────────
  if (action === 'void') {
    const sid = String(body.payment_session_id ?? '').trim();
    if (!sid) return json({ error: 'payment_session_id required' }, 400);
    const res = await voidPaymentSession(sid, {}, opts);
    if (!res.ok) return json({ error: ryftErr(res.data) || `Void failed (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
    return json({ success: true, voided: res.data });
  }

  // ── overage: bill above the hold → charge the difference off-session ─────
  // MIT (merchant-initiated, customer not present): a new Unscheduled session
  // that charges the card stored at tab open. Ryft requires THREE ids together:
  //   customerDetails.id (cus_), previousPayment.id (the initial hold ps_, where
  //   3DS was completed), and attemptPayment.paymentMethod.id (the stored pmt_).
  // With attemptPayment embedded the card is charged immediately on create.
  // If the stored-card ids weren't captured at tab open we can't charge off-
  // session — return a structured 422 so the caller settles the shortfall in
  // person rather than failing the whole close.
  if (action === 'overage') {
    const prev = String(body.previous_session_id ?? '').trim();
    const customerId = String(body.customer_id ?? '').trim();        // cus_…
    const storedCardId = String(body.stored_card_id ?? '').trim();   // pmt_…
    const amount = Math.round(Number(body.amount_minor));
    if (!prev || !Number.isFinite(amount) || amount <= 0) return json({ error: 'previous_session_id and a positive amount_minor required' }, 400);
    if (!customerId || !storedCardId) {
      return json({ error: 'no_stored_card', detail: 'This tab has no saved card on file, so the overage cannot be charged off-session. Settle the difference in person.' }, 422);
    }

    // Our markup on the overage (platform fee), same model as a normal payment.
    let platformFee: number | undefined;
    if (accountId) {
      const { data: ps } = await platformAdmin.from('platform_settings')
        .select('default_ryft_markup_percent, default_ryft_markup_fixed_pence').eq('id', true).maybeSingle();
      const pct = mra?.markup_percent != null ? Number(mra.markup_percent) : Number(ps?.default_ryft_markup_percent ?? 0);
      const fixed = mra?.markup_fixed_pence != null ? Number(mra.markup_fixed_pence) : Number(ps?.default_ryft_markup_fixed_pence ?? 0);
      const fee = Math.round(amount * (pct / 100)) + Math.round(fixed);
      if (fee > 0) platformFee = fee;
    }
    const paymentSettings: Record<string, unknown> = {};
    if (accountId) paymentSettings.platform = { paymentFees: { combined: { bookTo: accountId } } };

    // Merchant-initiated (off-session) charge on the card saved at tab open.
    const res = await createPaymentSession({
      amount,
      currency: String(body.currency || 'gbp').toUpperCase(),
      captureFlow: 'Automatic',
      paymentType: 'Unscheduled',
      customerDetails: { id: customerId },
      previousPayment: { id: prev },
      attemptPayment: { paymentMethod: { id: storedCardId } },
      ...(Object.keys(paymentSettings).length ? { paymentSettings } : {}),
      ...(platformFee != null ? { platformFee } : {}),
      metadata: { tab_overage_of: prev },
    }, { ...opts, idempotencyKey: `overage_${prev}_${amount}` });
    if (!res.ok) return json({ error: ryftErr(res.data) || `Overage charge failed (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
    const st = res.data?.status ?? null;
    const charged = st === 'Approved' || st === 'Captured';
    return json({ success: charged, overage: res.data, status: st, charged });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
