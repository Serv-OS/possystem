// supabase/functions/adyen-financial/index.ts
//
// Per-venue Adyen financial reporting reads (Financial services Phase 1).
// Serves the Back Office report screens:
//   payments  → summary tiles + a paged payment list from adyen_payments
//   disputes  → the venue's merchant_adyen_disputes rows (list only in Phase 1 —
//               accept/challenge wiring is a later phase)
//
// Both tables live in the PLATFORM DB with service-role-only RLS, so the client
// cannot read them directly — this fn is the fence. Auth model copied from
// payments-onboard: a signed-in Ops user with access to the location
// (user_locations), or super_admin.
//
// Fees are NOT served yet: they arrive with settlement-report ingestion in
// Phase 2 (adyen_payouts / adyen_payout_lines). The UI shows an honest "—".
//
// ⚠ DEPLOY ME (edge functions deploy manually and drift silently):
//   npx supabase functions deploy adyen-financial --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// Summary sums are computed in-function over a capped slice (PostgREST
// aggregates are not enabled on the project). The cap is generous for a single
// venue's period; if it is ever hit the response says so honestly.
const SUMMARY_CAP = 5000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // ── Auth: signed-in Ops user WITH access to this location (payments-onboard fence)
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const opsLocationId = body?.ops_location_id as string;
  if (!action) return json({ error: 'action required' }, 400);
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);

  const [{ data: ul }, { data: prof }] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

  // Ops location → Platform location (the ledger keys on the platform id).
  const { data: loc, error: locErr } = await platformAdmin.from('locations')
    .select('id, name').eq('ops_location_id', opsLocationId).maybeSingle();
  if (locErr) return json({ error: `location lookup failed: ${locErr.message}` }, 500);
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // ── payments: summary tiles + paged list ─────────────────────────────────
  if (action === 'payments') {
    const page = Math.max(0, Math.floor(Number(body.page) || 0));
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(body.page_size) || 50)));
    const isoOrNull = (v: unknown) => {
      if (!v) return null;
      const d = new Date(String(v));
      return isNaN(d.getTime()) ? null : d.toISOString();
    };
    const fromIso = isoOrNull(body.from);
    const toIso = isoOrNull(body.to);

    let sumQ = platformAdmin.from('adyen_payments')
      .select('amount_minor, amount_refunded_minor, success, last_event_code, currency')
      .eq('location_id', loc.id).limit(SUMMARY_CAP);
    if (fromIso) sumQ = sumQ.gte('created_at', fromIso);
    if (toIso) sumQ = sumQ.lte('created_at', toIso);
    const { data: sumRows, error: sumErr } = await sumQ;
    if (sumErr) return json({ error: `summary read failed: ${sumErr.message}` }, 500);

    // A "payment" for the tiles = a successful authorisation that was not
    // cancelled. Declines and cancellations stay visible in the list.
    const isPayment = (r: any) => r.success === true && r.last_event_code !== 'CANCELLATION';
    const paid = (sumRows ?? []).filter(isPayment);
    const summary = {
      count: paid.length,
      sum_minor: paid.reduce((s, r) => s + (Number(r.amount_minor) || 0), 0),
      refunds_minor: (sumRows ?? []).reduce((s, r) => s + (Number(r.amount_refunded_minor) || 0), 0),
      fees_minor: null,                  // Phase 2: settlement ingestion
      currency: (sumRows ?? []).find((r) => r.currency)?.currency ?? 'GBP',
      capped: (sumRows ?? []).length >= SUMMARY_CAP,
    };

    let listQ = platformAdmin.from('adyen_payments')
      .select('psp_reference, merchant_reference, channel, last_event_code, success, amount_minor, currency, amount_refunded_minor, card, matched_closed_check, created_at', { count: 'exact' })
      .eq('location_id', loc.id)
      .order('created_at', { ascending: false })
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (fromIso) listQ = listQ.gte('created_at', fromIso);
    if (toIso) listQ = listQ.lte('created_at', toIso);
    const { data: payments, error: listErr, count } = await listQ;
    if (listErr) return json({ error: `payments read failed: ${listErr.message}` }, 500);

    return json({ ok: true, summary, payments: payments ?? [], page, page_size: pageSize, total: count ?? 0 });
  }

  // ── disputes: list (Phase 1 — read-only) ─────────────────────────────────
  if (action === 'disputes') {
    const { data: disputes, error: dErr } = await platformAdmin.from('merchant_adyen_disputes')
      .select('dispute_psp_reference, payment_psp_reference, status, reason_code, reason, amount_minor, currency, respond_by, outcome, created_at, updated_at')
      .eq('location_id', loc.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (dErr) return json({ error: `disputes read failed: ${dErr.message}` }, 500);
    return json({ ok: true, disputes: disputes ?? [] });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
