// supabase/functions/marketing-compliance/index.ts
//
// Slice 8 — back-office compliance: manage the suppression list + view a customer's consent history.
// Auth mirrors marketing-campaigns (BO user w/ location access or super_admin). Org-scoped. Actions:
//   list_suppressions { ops_location_id, channel?, search? }            → suppression rows
//   add_suppression   { ops_location_id, channel, address, reason? }    → upsert (manual block)
//   remove_suppression{ ops_location_id, id }                           → delete (operator override)
//   consent_history   { ops_location_id, customer_id }                  → customer_consents ledger

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const norm = (channel: string, addr: string) => (channel === 'email' ? addr.trim().toLowerCase() : addr.replace(/\s/g, ''));

async function authed(req: Request, opsLocationId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return true;
  const { data: prof } = await sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return prof?.role === 'super_admin';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const { data: loc } = await sb.from('locations').select('org_id').eq('id', ops).maybeSingle();
  const org_id = loc?.org_id;
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  if (action === 'list_suppressions') {
    let q = sb.from('marketing_suppressions').select('id, channel, address, reason, source, created_at').eq('org_id', org_id).order('created_at', { ascending: false }).limit(500);
    if (body.channel) q = q.eq('channel', String(body.channel));
    if (body.search) q = q.ilike('address', `%${String(body.search).trim()}%`);
    const { data } = await q;
    return json({ suppressions: data ?? [] });
  }

  if (action === 'add_suppression') {
    const channel = String(body.channel ?? '').trim();
    const address = String(body.address ?? '').trim();
    if (!['email', 'sms'].includes(channel) || !address) return json({ error: 'channel + address required' }, 400);
    const { error } = await sb.from('marketing_suppressions').upsert(
      { org_id, channel, address: norm(channel, address), reason: body.reason || 'manual', source: 'back_office' },
      { onConflict: 'org_id,channel,address', ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'remove_suppression') {
    const id = String(body.id ?? '').trim();
    if (!id) return json({ error: 'id required' }, 400);
    const { error } = await sb.from('marketing_suppressions').delete().eq('id', id).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'consent_history') {
    const cid = String(body.customer_id ?? '').trim();
    if (!cid) return json({ error: 'customer_id required' }, 400);
    const { data } = await sb.from('customer_consents').select('channel, purpose, consented, source, method, created_at').eq('org_id', org_id).eq('customer_id', cid).order('created_at', { ascending: false }).limit(100);
    return json({ consents: data ?? [] });
  }

  return json({ error: 'unknown action' }, 400);
});
