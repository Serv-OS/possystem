// supabase/functions/marketing-domains/index.ts
//
// Back-office management of per-org branded sending domains via the Resend Domains API. Auth mirrors
// marketing-campaigns (BO user with location access / super_admin, or service-role). Uses the platform
// RESEND_API_KEY (all venue domains live under the platform's Resend account). Actions:
//   list_domains  { ops_location_id }
//   add_domain    { ops_location_id, domain }                       → POST /domains, store DNS records
//   verify_domain { ops_location_id, id }                           → POST /domains/{id}/verify + refresh
//   refresh_domain{ ops_location_id, id }                           → GET /domains/{id} (status/records)
//   set_from      { ops_location_id, id, from_name, from_address, reply_to }
//   set_active    { ops_location_id, id, active }                   → gate: must be verified + has from
//   delete_domain { ops_location_id, id }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
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
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await sb.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}
async function resend(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`https://api.resend.com${path}`, { method, headers: { Authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
const cleanDomain = (d: string) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@/, '');

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
  const now = new Date().toISOString();

  if (action === 'list_domains') {
    const { data } = await sb.from('org_sending_domains').select('*').eq('org_id', org_id).order('created_at', { ascending: false });
    return json({ domains: data ?? [] });
  }

  if (action === 'add_domain') {
    if (!RESEND_KEY) return json({ error: 'RESEND_API_KEY not configured' }, 500);
    const domain = cleanDomain(body.domain);
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return json({ error: 'enter a valid domain (e.g. mail.yourvenue.com)' }, 400);
    const { ok, j } = await resend('/domains', 'POST', { name: domain, custom_return_path: 'send' });
    if (!ok) return json({ error: j?.message || j?.name || 'Resend rejected the domain' }, 502);
    const { data, error } = await sb.from('org_sending_domains').upsert({
      org_id, domain, resend_domain_id: j.id, region: j.region || 'us-east-1', status: j.status || 'not_started',
      dns_records: j.records || [], last_checked_at: now, updated_at: now,
    }, { onConflict: 'org_id,domain' }).select('*').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, domain: data });
  }

  if (action === 'verify_domain' || action === 'refresh_domain') {
    const { data: row } = await sb.from('org_sending_domains').select('*').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle();
    if (!row?.resend_domain_id) return json({ error: 'domain not found' }, 404);
    if (action === 'verify_domain') await resend(`/domains/${row.resend_domain_id}/verify`, 'POST');
    const { ok, j } = await resend(`/domains/${row.resend_domain_id}`, 'GET');
    if (!ok) return json({ error: j?.message || 'Resend lookup failed' }, 502);
    const status = j.status || row.status;
    const { data } = await sb.from('org_sending_domains').update({
      status, dns_records: j.records || row.dns_records, last_checked_at: now,
      verified_at: status === 'verified' ? (row.verified_at || now) : row.verified_at, updated_at: now,
    }).eq('id', row.id).select('*').maybeSingle();
    return json({ ok: true, domain: data });
  }

  if (action === 'set_from') {
    const { data: row } = await sb.from('org_sending_domains').select('domain').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle();
    if (!row) return json({ error: 'domain not found' }, 404);
    const from = String(body.from_address || '').trim().toLowerCase();
    if (from && !from.endsWith(`@${row.domain}`)) return json({ error: `the From address must end with @${row.domain}` }, 400);
    const { data, error } = await sb.from('org_sending_domains').update({ from_name: body.from_name || null, from_address: from || null, reply_to: String(body.reply_to || '').trim() || null, updated_at: now }).eq('id', String(body.id)).eq('org_id', org_id).select('*').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, domain: data });
  }

  if (action === 'set_active') {
    const active = body.active === true;
    const { data: row } = await sb.from('org_sending_domains').select('*').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle();
    if (!row) return json({ error: 'domain not found' }, 404);
    if (active && (row.status !== 'verified' || !row.from_address)) return json({ error: 'verify the domain and set a From address before activating' }, 400);
    // Atomic deactivate-others + activate-this (one transaction) so a partial failure can't leave zero active.
    const { error } = await sb.rpc('marketing_set_active_domain', { p_org: org_id, p_id: row.id, p_active: active });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'delete_domain') {
    const { data: row } = await sb.from('org_sending_domains').select('resend_domain_id').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle();
    if (row?.resend_domain_id) { try { await resend(`/domains/${row.resend_domain_id}`, 'DELETE'); } catch (_e) { /* best effort */ } }
    const { error } = await sb.from('org_sending_domains').delete().eq('id', String(body.id)).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
});
