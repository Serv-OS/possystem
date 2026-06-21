// supabase/functions/hubrise-order-status/index.ts
//
// Push a ServOS order status change back to HubRise (and thus the originating
// channel) via PATCH /locations/:id/orders/:id. The access token stays server-side,
// so the OrdersHub client calls this on each advance / accept / reject.
//
// POST { ops_location_id, ref, action, prep_minutes?, reason? }
//   action: accept | prep | ready | collected | reject | cancel
//   accept -> HubRise 'accepted' + confirmed_time = now + prep_minutes (the merchant ETA)
// Monotonic: a status whose rank is below what we last pushed is ignored (unless terminal),
// so a stale/duplicate advance can't regress the channel's view.
// Auth: signed-in user with location access, or service role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { queueToHrStatus, hrStatusRank } from '../_shared/hubrise-map.ts';
import { patchOrderStatus } from '../_shared/hubrise-ingest.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

const TERMINAL = new Set(['rejected', 'cancelled', 'delivery_failed']);

async function requireAccess(req: Request, loc: string): Promise<Response | null> {
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return json({ error: 'Unauthorized' }, 401);
  if (token === SERVICE_ROLE) return null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return json({ error: 'Invalid token' }, 401);
  const [{ data: ul }, { data: prof }] = await Promise.all([
    sb.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', loc).maybeSingle(),
    sb.from('user_profiles').select('role').eq('id', user.id).maybeSingle(),
  ]);
  if (!ul && prof?.role !== 'super_admin') return json({ error: 'No access to this location' }, 403);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const loc = String(body?.ops_location_id || body?.location_id || '');
  const ref = String(body?.ref || '');
  const action = String(body?.action || '');
  if (!loc || !ref || !action) return json({ error: 'ops_location_id, ref and action required' }, 400);

  const denied = await requireAccess(req, loc);
  if (denied) return denied;

  const { data: link } = await sb.from('hubrise_order_links').select('*').eq('ref', ref).maybeSingle();
  if (!link) return json({ ok: true, skipped: 'not a HubRise order' });

  const hrStatus = queueToHrStatus(action, link.service_type);
  if (!hrStatus) return json({ error: `cannot map action: ${action}` }, 400);

  // Monotonic guard — don't push below what we've already pushed (terminal always allowed).
  if (link.pushed_status && !TERMINAL.has(hrStatus) && hrStatusRank(hrStatus) < hrStatusRank(link.pushed_status)) {
    return json({ ok: true, skipped: `not regressing ${link.pushed_status} -> ${hrStatus}` });
  }

  let confirmedTime: string | null = null;
  if (hrStatus === 'accepted') {
    const prep = Number.isFinite(body?.prep_minutes) ? Math.max(0, Math.round(body.prep_minutes)) : 20;
    confirmedTime = new Date(Date.now() + prep * 60_000).toISOString();
  }

  try {
    await patchOrderStatus(sb, ref, hrStatus, confirmedTime, body?.reason || null);
    return json({ ok: true, hr_status: hrStatus, confirmed_time: confirmedTime });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
