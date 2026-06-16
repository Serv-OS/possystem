// supabase/functions/marketing-run/index.ts
//
// Slice 4 — the daily campaign engine entry (invoked by Vercel Cron via api/marketing-cron).
// Runs every active automation campaign across all orgs for "today". Idempotent: re-invoking on the
// same day is a no-op (campaign_runs unique per day-window; campaign_sends unique per occurrence).
//
// Auth: SERVICE_ROLE bearer (internal) OR body/header secret === MARKETING_RUN_SECRET (so the Vercel
// cron function can call it without holding the service-role key). Optional body: { today, campaign_id }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runCampaign, runDueCampaigns } from '../_shared/campaign-engine.ts';
import { runWorkflows } from '../_shared/workflow-engine.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-run-secret' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const RUN_SECRET = Deno.env.get('MARKETING_RUN_SECRET') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

function todayUTC(): string { return new Date().toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any = {}; try { body = await req.json(); } catch { /* allow empty */ }
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const secret = (req.headers.get('x-run-secret') ?? body?.secret ?? '').trim();
  const authed = (bearer && bearer === SERVICE_ROLE) || (RUN_SECRET && secret === RUN_SECRET);
  if (!authed) return json({ error: 'unauthorised' }, 403);

  const opts = { today: String(body?.today || todayUTC()), supabaseUrl: SUPABASE_URL, serviceRole: SERVICE_ROLE };

  try {
    if (body?.campaign_id) {
      const { data: c } = await sb.from('campaigns').select('*').eq('id', String(body.campaign_id)).maybeSingle();
      if (!c) return json({ error: 'campaign not found' }, 404);
      const summary = await runCampaign(sb, c, { ...opts, force: body?.force === true });
      return json({ ok: true, today: opts.today, results: [summary] });
    }
    const wfOpts = { ...opts, now: body?.now };   // body.now lets tests fast-forward drips
    const results = await runDueCampaigns(sb, opts);
    const workflows = await runWorkflows(sb, wfOpts);
    return json({ ok: true, today: opts.today, count: results.length, results, workflows });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
