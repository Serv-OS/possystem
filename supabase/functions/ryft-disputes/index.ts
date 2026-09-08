// supabase/functions/ryft-disputes/index.ts
//
// MERCHANT-facing dispute (chargeback) management from the back office.
// Location-scoped: caller must be a signed-in Ops user with access to the
// location (user_locations) — or super_admin. Disputes are captured by the
// ryft-webhook into merchant_ryft_disputes; here the merchant acts on them
// before the respondBy deadline.
//
//   list             { ops_location_id }                          → our disputes (+ a Ryft sync)
//   accept           { ops_location_id, dispute_id }              → concede (refund the cardholder)
//   challenge        { ops_location_id, dispute_id, defence? }    → attach defence text then challenge
//   submit_evidence  { ops_location_id, dispute_id, defence }     → attach/replace defence text only

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getDispute, acceptDispute, addDisputeEvidence, challengeDispute, ryftConfigured } from '../_shared/ryft.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const ryftErr = (d: any): string | null => d?.errors?.[0]?.message || d?.message || null;

const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
const platformAdmin = createClient(Deno.env.get('PLATFORM_SUPABASE_URL') ?? '', Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });

// Mirror a fresh Ryft dispute into our row (keeps status/evidence current).
async function syncRow(d: any) {
  if (!d?.id) return;
  const nowIso = new Date().toISOString();
  await platformAdmin.from('merchant_ryft_disputes').update({
    status: d.status ?? null, evidence: d.evidence ?? null,
    respond_by: d.respondBy ? new Date(Number(d.respondBy) * 1000).toISOString() : null,
    recommended_evidence: d.recommendedEvidence ?? null, raw: d, updated_at: nowIso,
  }).eq('dispute_id', d.id);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = body?.action as string;
  const opsLocationId = body?.ops_location_id as string;
  if (!action || !opsLocationId) return json({ error: 'action and ops_location_id required' }, 400);

  const [{ data: ul }, { data: prof }] = await Promise.all([
    opsAdmin.from('user_locations').select('location_id').eq('user_id', caller.id).eq('location_id', opsLocationId).maybeSingle(),
    opsAdmin.from('user_profiles').select('role').eq('id', caller.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);

  const { data: loc } = await platformAdmin.from('locations').select('id').eq('ops_location_id', opsLocationId).maybeSingle();
  if (!loc) return json({ error: 'location not found in platform DB' }, 404);

  // ── list ────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data: rows } = await platformAdmin.from('merchant_ryft_disputes')
      .select('dispute_id, payment_session_id, amount, currency, status, category, reason_code, reason_description, respond_by, recommended_evidence, evidence, updated_at')
      .eq('location_id', loc.id).order('respond_by', { ascending: true, nullsFirst: false });
    return json({ success: true, disputes: rows ?? [] });
  }

  // Action endpoints need the dispute + the merchant sub-account (Account header).
  const disputeId = String(body.dispute_id ?? '').trim();
  if (!disputeId) return json({ error: 'dispute_id required' }, 400);
  const { data: row } = await platformAdmin.from('merchant_ryft_disputes')
    .select('dispute_id, ryft_account_id, status').eq('location_id', loc.id).eq('dispute_id', disputeId).maybeSingle();
  if (!row) return json({ error: 'dispute not found for this location' }, 404);
  if (!ryftConfigured()) return json({ error: 'Ryft not configured' }, 500);
  const opts = row.ryft_account_id ? { accountId: row.ryft_account_id } : {};

  // ── submit_evidence: attach the merchant's written defence ───────────────
  if (action === 'submit_evidence' || action === 'challenge') {
    const defence = String(body.defence ?? '').trim();
    if (action === 'submit_evidence' && !defence) return json({ error: 'defence text required' }, 400);
    if (defence) {
      const ev = await addDisputeEvidence(disputeId, { text: { uncategorised: defence.slice(0, 4000) } }, opts);
      if (!ev.ok) return json({ error: ryftErr(ev.data) || `Couldn't attach evidence (${ev.status})`, ryft: ev.data }, ev.status >= 400 && ev.status < 500 ? 400 : 502);
      await syncRow(ev.data);
      if (action === 'submit_evidence') return json({ success: true });
    }
    // challenge (after attaching any defence)
    const res = await challengeDispute(disputeId, opts);
    if (!res.ok) return json({ error: ryftErr(res.data) || `Challenge failed (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
    await syncRow(res.data);
    return json({ success: true, status: res.data?.status ?? 'Challenged' });
  }

  // ── accept: concede the dispute ─────────────────────────────────────────
  if (action === 'accept') {
    const res = await acceptDispute(disputeId, opts);
    if (!res.ok) return json({ error: ryftErr(res.data) || `Accept failed (${res.status})`, ryft: res.data }, res.status >= 400 && res.status < 500 ? 400 : 502);
    await syncRow(res.data);
    return json({ success: true, status: res.data?.status ?? 'Accepted' });
  }

  return json({ error: `unknown action: ${action}` }, 400);
});
