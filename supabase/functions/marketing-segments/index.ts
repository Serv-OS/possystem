// supabase/functions/marketing-segments/index.ts
//
// Slice 3 — back-office segmentation. Auth mirrors marketing-admin (BO user w/ location access or
// super_admin; service-role bearer for internal/cron). Segments are org-scoped; membership for
// dynamic segments is computed on demand via the injection-safe marketing_resolve_segment() RPC over
// the customer_rfm view (RFM already materialised in customer_locations). Actions:
//   list_segments    { ops_location_id }                          → saved segments + prebuilt catalogue
//   save_segment     { ops_location_id, segment:{...} }           → upsert (recomputes member_count)
//   delete_segment   { ops_location_id, id }
//   preview_segment  { ops_location_id, definition, sample? }     → { count, sample:[customers] }
//   resolve_segment  { ops_location_id, id? | definition, limit? }→ { customer_ids:[...] }   (slice 4)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PREBUILT } from '../_shared/segments-prebuilt.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// Prebuilt audience catalogue is shared with the campaign/workflow pickers (see _shared/segments-prebuilt.ts).
const SEGMENT_FIELDS = ['name', 'description', 'kind', 'prebuilt_key', 'definition', 'active'];

async function authed(req: Request, opsLocationId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return false;
  const { data: ul } = await opsAdmin.from('user_locations').select('location_id').eq('user_id', user.id).eq('location_id', opsLocationId).maybeSingle();
  if (ul) return true;
  const { data: prof } = await opsAdmin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  return prof?.role === 'super_admin';
}
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await opsAdmin.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}

async function resolveIds(org_id: string, definition: any, limit?: number): Promise<string[]> {
  const { data, error } = await opsAdmin.rpc('marketing_resolve_segment', { p_org: org_id, p_def: definition ?? { match: 'all', rules: [] }, p_limit: limit ?? null });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => r.customer_id);
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

  if (action === 'list_segments') {
    const { data } = await opsAdmin.from('segments').select('*').eq('org_id', org_id).order('created_at', { ascending: false });
    return json({ segments: data ?? [], prebuilt: PREBUILT });
  }

  if (action === 'save_segment') {
    const incoming = body.segment || {};
    const row: Record<string, unknown> = { org_id, updated_at: new Date().toISOString() };
    for (const k of SEGMENT_FIELDS) if (k in incoming) row[k] = incoming[k];
    if (incoming.id) row.id = incoming.id;
    if (!row.name) return json({ error: 'name required' }, 400);
    // recompute cached member_count at save time (advisory; live count via preview)
    try { row.member_count = (await resolveIds(org_id, row.definition)).length; row.last_computed_at = new Date().toISOString(); } catch (_e) { /* leave null */ }
    const { data, error } = await opsAdmin.from('segments').upsert(row, { onConflict: 'id' }).select('*').maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, segment: data });
  }

  if (action === 'delete_segment') {
    const id = String(body.id ?? '').trim();
    if (!id) return json({ error: 'id required' }, 400);
    const { error } = await opsAdmin.from('segments').delete().eq('id', id).eq('org_id', org_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === 'preview_segment') {
    let def = body.definition;
    if (!def && body.id) { const { data } = await opsAdmin.from('segments').select('definition').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle(); def = data?.definition; }
    let ids: string[];
    try { ids = await resolveIds(org_id, def); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
    const sampleN = Math.min(Number(body.sample) || 8, 50);
    let sample: any[] = [];
    if (ids.length) {
      const { data } = await opsAdmin.from('customers').select('id, first_name, last_name, name, email, phone, birthday, marketing_opt_in').in('id', ids.slice(0, sampleN));
      sample = data ?? [];
    }
    return json({ count: ids.length, sample });
  }

  if (action === 'resolve_segment') {
    let def = body.definition;
    if (!def && body.id) { const { data } = await opsAdmin.from('segments').select('definition').eq('id', String(body.id)).eq('org_id', org_id).maybeSingle(); def = data?.definition; }
    try { const ids = await resolveIds(org_id, def, Number(body.limit) || undefined); return json({ customer_ids: ids, count: ids.length }); }
    catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
  }

  return json({ error: 'unknown action' }, 400);
});
