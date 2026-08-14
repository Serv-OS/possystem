// supabase/functions/adyen-modify
//
// Post-payment modifications on Checkout v72 (ADYEN_INTEGRATION_PLAN.md Phase 4,
// built ahead of keys): capture (tab close, with tip), cancel (release a hold),
// refund (referenced), adjust (bar-tab step-up via /amountUpdates).
//
// All results are ASYNC at Adyen — success here means "accepted"; the truth
// lands via CAPTURE/REFUND/CANCELLATION webhooks into adyen_payments and the
// closed-check reflection in adyen-webhook. Callers must treat 'received' as
// in-flight, exactly like the Ryft fire-and-forget refund contract.
//
// AUTH (Phase 0): service role, or a signed-in BACK OFFICE user with access to
// the location (user_locations). The POS refund path joins in Phase 4 with the
// same device fence adyen-terminal-charge uses.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adyenConfigured, checkoutBase, adyenFetch } from '../_shared/adyen.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!adyenConfigured()) return json({ error: 'Adyen not configured — set ADYEN_API_KEY' }, 503);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'unauthorized' }, 401);
  const isServiceRole = token === SERVICE_ROLE;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body.action ?? '');
  const psp = String(body.psp_reference ?? '');
  const locationId = String(body.location_id ?? '');
  if (!psp || !locationId || !['capture', 'cancel', 'refund', 'adjust'].includes(action)) {
    return json({ error: "action ('capture'|'cancel'|'refund'|'adjust'), psp_reference and location_id required" }, 400);
  }

  // Resolve venue + merchant account (either id space).
  let { data: ploc } = await platformAdmin.from('locations').select('id, ops_location_id').eq('ops_location_id', locationId).maybeSingle();
  if (!ploc) {
    const fb = await platformAdmin.from('locations').select('id, ops_location_id').eq('id', locationId).maybeSingle();
    ploc = fb.data ?? null;
  }
  if (!ploc) return json({ error: 'location not found' }, 404);

  if (!isServiceRole) {
    const { data: u } = await opsAdmin.auth.getUser(token);
    const uid = u?.user?.id;
    if (!uid) return json({ error: 'unauthorized' }, 401);
    const { data: ul } = await opsAdmin.from('user_locations')
      .select('user_id').eq('user_id', uid).eq('location_id', ploc.ops_location_id ?? locationId).maybeSingle();
    if (!ul) return json({ error: 'no access to this location' }, 403);
  }

  const { data: maa } = await platformAdmin.from('merchant_adyen_accounts')
    .select('merchant_account').eq('location_id', ploc.id).maybeSingle();
  if (!maa?.merchant_account) return json({ error: 'venue has no Adyen account' }, 409);

  // v968 review hardening: bind the pspReference to the CALLER'S venue. Under
  // AfP every venue shares the regional merchant account, so Adyen itself will
  // NOT reject a cross-venue reference — our ledger must. Service role bypasses
  // (server flows can act before the AUTHORISATION webhook lands).
  if (!isServiceRole) {
    const { data: ledger } = await platformAdmin.from('adyen_payments')
      .select('location_id').eq('psp_reference', psp).maybeSingle();
    if (!ledger) return json({ error: 'unknown payment — not yet in the ledger for this venue' }, 404);
    if (ledger.location_id !== ploc.id) return json({ error: 'payment belongs to a different venue' }, 403);
  }

  const amountMinor = body.amount_minor != null ? Math.round(Number(body.amount_minor)) : null;
  const currency = String(body.currency || 'GBP').toUpperCase();
  const reference = String(body.reference || `${action}:${psp}:${amountMinor ?? 'full'}`).slice(0, 80);
  // v968: the Idempotency-Key is only deterministic when the CALLER supplied a
  // reference (their operation id). A derived (action,psp,amount) key made two
  // legitimate equal-amount refunds collapse into one — the second was silently
  // swallowed by Adyen's replay semantics and no money moved.
  const idempotencyKey = body.reference ? `mod:${reference}` : `mod:${action}:${psp}:${crypto.randomUUID()}`;
  const base = checkoutBase();

  let path: string; let payload: any;
  if (action === 'capture') {
    if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor required for capture' }, 400);
    path = `/payments/${encodeURIComponent(psp)}/captures`;
    payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, reference };
  } else if (action === 'refund') {
    if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor required for refund' }, 400);
    path = `/payments/${encodeURIComponent(psp)}/refunds`;
    payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, reference };
  } else if (action === 'cancel') {
    path = `/payments/${encodeURIComponent(psp)}/cancels`;
    payload = { merchantAccount: maa.merchant_account, reference };
  } else { // adjust — bar-tab hold step-up/down to a NEW TOTAL (not a delta)
    if (!Number.isFinite(amountMinor)) return json({ error: 'amount_minor (new total) required for adjust' }, 400);
    path = `/payments/${encodeURIComponent(psp)}/amountUpdates`;
    payload = { merchantAccount: maa.merchant_account, amount: { value: amountMinor, currency }, industryUsage: 'delayedCharge', reference };
  }

  const res = await adyenFetch('POST', `${base}${path}`, payload, { idempotencyKey });
  if (!res.ok) {
    // Graceful-fallback contract (mirrors stripe-increment-authorization): the
    // caller decides what a refusal means — never a thrown 5xx for a scheme
    // that simply doesn't support the modification.
    return json({ ok: false, error: `adyen ${res.status}`, detail: res.data }, res.status >= 500 ? 502 : 200);
  }
  return json({ ok: true, status: res.data?.status ?? 'received', modification_psp: res.data?.pspReference ?? null, reference });
});
