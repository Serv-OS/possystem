// supabase/functions/marketing-report/index.ts
//
// Slice 7 — back-office marketing reporting & attribution. Auth mirrors marketing-campaigns. One action:
//   overview { ops_location_id, days? }  → the whole dashboard for the org over the window (default 30d)
// via the marketing_report() SQL function (all aggregation server-side).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

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
  const ops = String(body?.ops_location_id ?? '').trim();
  if (String(body?.action ?? '') !== 'overview' || !ops) return json({ error: 'action overview + ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const { data: loc } = await sb.from('locations').select('org_id').eq('id', ops).maybeSingle();
  const org_id = loc?.org_id;
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await sb.rpc('marketing_report', { p_org: org_id, p_since: since });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, days, report: data });
});
