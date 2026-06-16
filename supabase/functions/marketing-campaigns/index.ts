// supabase/functions/marketing-campaigns/index.ts
//
// Slice 4 — back-office campaign management. Auth mirrors marketing-admin/marketing-segments (BO user
// with location access or super_admin; service-role for internal). Campaigns are org-scoped. Actions:
//   list_campaigns { ops_location_id }                       → campaigns + segments + offers (for pickers)
//   save_campaign  { ops_location_id, campaign:{...} }       → upsert
//   delete_campaign{ ops_location_id, id }
//   set_status     { ops_location_id, id, status }           → draft/scheduled/active/paused/archived
//   run_now        { ops_location_id, id }                   → force a run (test send); never-twice still holds
//   list_runs      { ops_location_id, campaign_id }          → runs + recent sends

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runCampaign } from '../_shared/campaign-engine.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const CAMPAIGN_FIELDS = ['name', 'description', 'type', 'channel', 'segment_id', 'trigger', 'schedule', 'subject', 'email_html', 'sms_body', 'from_name', 'offer_id', 'status'];

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
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await sb.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const org_id = await orgFor(ops);
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  if (action === 'list_campaigns') {
    const [{ data: campaigns }, { data: segments }, { data: offers }] = await Promise.all([
      sb.from('campaigns').select('*').eq('org_id', org_id).order('created_at', { ascending: false }),
      sb.from('segments').select('id, name').eq('org_id', org_id).order('name'),
      sb.from('offers').select('id, name, reward_type, reward_value, reward_label').eq('org_id', org_id).eq('active', true).order('name'),
    ]);
    return json({ campaigns: campaigns ?? [], segments: segments ?? [], offers: offers ?? [] });
  }

  if (action === 'save_campaign') {
    const incoming = body.campaign || {};
    const row: Record<string, unknown> = { org_id, updated_at: new Date().toISOString() };
    for (const k of CAMPAIGN_FIELDS) if (k in incoming) row[k] = incoming[k];
    if (incoming.id) row.id = incoming.id;
    if (!row.name) return json({ error: 'name required' }, 400);
    const { data, error } = await sb.from('campaigns').upsert(row, { onConflict: 'id' }).select('*').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, campaign: data });
  }

  if (action === 'set_status') {
    const id = String(body.id ?? '').trim();
    const status = String(body.status ?? '').trim();
    if (!id || !['draft', 'scheduled', 'active', 'paused', 'archived'].includes(status)) return json({ error: 'id + valid status required' }, 400);
    const { error } = await sb.from('campaigns').update({ status, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'delete_campaign') {
    const id = String(body.id ?? '').trim();
    if (!id) return json({ error: 'id required' }, 400);
    const { error } = await sb.from('campaigns').delete().eq('id', id).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'run_now') {
    const id = String(body.id ?? '').trim();
    const { data: c } = await sb.from('campaigns').select('*').eq('id', id).eq('org_id', org_id).maybeSingle();
    if (!c) return json({ error: 'campaign not found' }, 404);
    const today = String(body.today || new Date().toISOString().slice(0, 10));
    const summary = await runCampaign(sb, c, { today, supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE, force: true });
    return json({ ok: true, summary });
  }

  if (action === 'list_runs') {
    const cid = String(body.campaign_id ?? '').trim();
    const [{ data: runs }, { data: sends }] = await Promise.all([
      sb.from('campaign_runs').select('*').eq('org_id', org_id).eq('campaign_id', cid).order('run_at', { ascending: false }).limit(20),
      sb.from('campaign_sends').select('customer_id, channel, status, promo_code, created_at').eq('org_id', org_id).eq('campaign_id', cid).order('created_at', { ascending: false }).limit(50),
    ]);
    return json({ runs: runs ?? [], sends: sends ?? [] });
  }

  return json({ error: 'unknown action' }, 400);
});
