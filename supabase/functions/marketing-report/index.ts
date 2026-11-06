// supabase/functions/marketing-report/index.ts
//
// Slice 7 — back-office marketing reporting & attribution. Auth mirrors marketing-campaigns. One action:
//   overview { ops_location_id, days? }  → the whole dashboard for the org over the window (default 30d)
// via the marketing_report() SQL function (all aggregation server-side).
// 5.12.67: two more, same shape:
//   links    { ops_location_id, days? }  → clicks on tracked email links per campaign, automation and link (marketing_link_report)
//   website  { ops_location_id, days?, host? }  → the venue website's visits: per day, pages, referrers, sources, from campaigns (website_report);
//                                          5.12.68: host narrows it to one of the company's sites, and sites[] always lists every site
//   sites    { ops_location_id, days? }  → 5.12.68: the marketing report split by venue (marketing_report_sites)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { secondStepRefusal } from '../_shared/second-step.ts';

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
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const ops = String(body?.ops_location_id ?? '').trim();
  const action = String(body?.action ?? '');
  const FN: Record<string, string> = { overview: 'marketing_report', links: 'marketing_link_report', website: 'website_report', sites: 'marketing_report_sites' };
  if (!FN[action] || !ops) return json({ error: 'action overview, links, website or sites + ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const { data: loc } = await sb.from('locations').select('org_id').eq('id', ops).maybeSingle();
  const org_id = loc?.org_id;
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const args: Record<string, unknown> = { p_org: org_id, p_since: since };
  const host = typeof body.host === 'string' ? body.host.trim().toLowerCase().slice(0, 253) : '';
  if (action === 'website' && host) args.p_host = host;
  const { data, error } = await sb.rpc(FN[action], args);
  // The SQL not run yet (20261126a, 20261127a): say so in words, the screen shows the message.
  if (error && /could not find the function|does not exist/i.test(error.message)) return json({ error: `This report needs SQL ${action === 'sites' || host ? '20261127a' : '20261126a'} run on the database first.`, code: 'sql_missing' }, 400);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, days, report: data });
});
