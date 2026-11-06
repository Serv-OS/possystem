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
//   menu_catalogue   { ops_location_id }                          → { items:[{label, ids}], categories:[{label, ids}], tiers, programs }  (5.12.67)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PREBUILT } from '../_shared/segments-prebuilt.ts';
import { secondStepRefusal } from '../_shared/second-step.ts';
import { resolveAudience } from '../_shared/segmentAudience.ts';
import { companyLoyalty } from '../_shared/loyaltyMergeRead.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const opsAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// Prebuilt audience catalogue is shared with the campaign/workflow pickers (see _shared/segments-prebuilt.ts).
const SEGMENT_FIELDS = ['name', 'description', 'kind', 'prebuilt_key', 'definition', 'active'];

import { isVenueWriter } from '../_shared/venueWriter.js';

async function authed(req: Request, opsLocationId: string): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  const { data: { user } } = await opsAdmin.auth.getUser(token);
  if (!user) return false;
  // One rule, shared with the database (migration 20260921u): a link row, a super
  // admin, or an owner acting inside their own organisation.
  return await isVenueWriter(opsAdmin, user, opsLocationId);
}
async function orgFor(opsLocationId: string): Promise<string | null> {
  const { data } = await opsAdmin.from('locations').select('org_id').eq('id', opsLocationId).maybeSingle();
  return data?.org_id ?? null;
}

// 6 Nov 2026 (5.12.67): one shared resolver (loyalty rules decided on the Platform, groups and item
// rules on Ops, paged past the 1,000 row cap) for every caller. See _shared/segmentAudience.ts.
const resolveIds = (org_id: string, definition: any, limit?: number) => resolveAudience(opsAdmin, org_id, definition ?? { match: 'all', rules: [] }, limit ?? null);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock; // docs/SECOND_STEP.md
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '').trim();
  const ops = String(body?.ops_location_id ?? '').trim();
  if (!action || !ops) return json({ error: 'action and ops_location_id required' }, 400);
  if (!(await authed(req, ops))) return json({ error: 'no access to this location' }, 403);
  const org_id = await orgFor(ops);
  if (!org_id) return json({ error: 'location not provisioned (no org)' }, 400);

  // 5.12.67: what the rule builder's pickers show. Items and categories across EVERY venue of the
  // organisation, grouped by name, so "Pizza" is one choice whose ids cover each site's own row (the
  // multi site menu publishes a product into each venue under that venue's id). Sizes (child rows)
  // are folded into their product: the resolver matches a size line by parent_id.
  if (action === 'menu_catalogue') {
    const { data: locs } = await opsAdmin.from('locations').select('id, name').eq('org_id', org_id).limit(100);
    const locIds = (locs ?? []).map((l: any) => l.id);
    const items: Map<string, { label: string; ids: string[]; venues: Set<string> }> = new Map();
    const cats: Map<string, { label: string; ids: string[]; venues: Set<string> }> = new Map();
    if (locIds.length) {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data } = await opsAdmin.from('menu_items').select('id, name, location_id, parent_id, archived').in('location_id', locIds).eq('archived', false).order('id').range(from, from + PAGE - 1);
        const rows = data ?? [];
        for (const r of rows as any[]) {
          if (r.parent_id) continue;                       // a size: folded into its product
          const key = String(r.name || '').trim().toLowerCase();
          if (!key) continue;
          const e = items.get(key) || { label: String(r.name).trim(), ids: [], venues: new Set<string>() };
          e.ids.push(r.id); e.venues.add(r.location_id); items.set(key, e);
        }
        if (rows.length < PAGE) break;
      }
      const { data: cs } = await opsAdmin.from('menu_categories').select('id, label, location_id').in('location_id', locIds).limit(2000);
      for (const r of (cs ?? []) as any[]) {
        const key = String(r.label || '').trim().toLowerCase();
        if (!key) continue;
        const e = cats.get(key) || { label: String(r.label).trim(), ids: [], venues: new Set<string>() };
        e.ids.push(r.id); e.venues.add(r.location_id); cats.set(key, e);
      }
    }
    const pack = (m: Map<string, { label: string; ids: string[]; venues: Set<string> }>) =>
      [...m.values()].map((e) => ({ label: e.label, ids: e.ids, venues: e.venues.size })).sort((a, b) => a.label.localeCompare(b.label));
    // tiers and stamp programs, for the loyalty rules' pickers (blank when the company runs no loyalty)
    let tiers: any[] = [], programs: any[] = [];
    try { const co = await companyLoyalty(opsAdmin, org_id); tiers = co?.tiers ?? []; programs = (co?.programs ?? []).map((p: any) => ({ id: p.id, name: p.name, stamps_required: p.stamps_required })); } catch { /* blank */ }
    return json({ items: pack(items), categories: pack(cats), venues: locs ?? [], tiers, programs });
  }

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
