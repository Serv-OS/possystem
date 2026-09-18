// supabase/functions/profile-admin/index.ts
//
// The ONE writer of a login's venue (user_profiles.location_id), company (org_id) and Back Office
// access (bo_access), and the reader of a team member's email for the Staff screen.
//
// 18 Sep 2026, lockdown step 1. Migration 20260918c_OPS_profile_venue_lock.sql takes those three
// columns away from the browser and scopes user_profiles to the caller's own row, because any
// login could point any profile at any venue and become staff there. The Back Office screens
// that legitimately change them call this function instead; every decision is in
// _shared/profileAdmin.ts (pure, tested). Service role writes, so it works before and after the
// migration.
//
// POST { action, ... } with the Back Office user's own session (never an anonymous one):
//   set_active_location { location_id }                 Back Office location switcher
//   claim_org           { org_id }                      Company Admin: create organisation
//   adopt_location      { location_id }                 Company Admin: create location
//   set_bo_access       { location_id, user_id, bo_access }   Staff: Back Office access switch
//   team_profiles       { location_id, user_ids[] }     Staff: logins' email and access flag
//   admin_set_location  { user_id, location_id|null }   Admin portal (super admin)
// Every reply carries fn: 'profile-admin' (the client tells "not deployed yet" from a refusal).
//
// verify_jwt = false; the caller is checked here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  decideSignedIn, decideSetActiveLocation, decideClaimOrg, decideAdoptLocation,
  decideSetBoAccess, decideTeamRead, decideAdminSetLocation, type Decision,
} from '../_shared/profileAdmin.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: Record<string, unknown>, s = 200) =>
  new Response(JSON.stringify({ fn: 'profile-admin', ...b }), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const refuse = (d: Decision) => json({ error: (d as any).error }, (d as any).status);

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

async function locationRow(locationId: string | null) {
  if (!locationId) return null;
  const { data } = await admin.from('locations').select('id, org_id').eq('id', locationId).maybeSingle();
  return data ?? null;
}
async function linkedIds(userId: string): Promise<string[]> {
  const { data } = await admin.from('user_locations').select('location_id').eq('user_id', userId).limit(1000);
  return (data || []).map((r: any) => String(r.location_id));
}
async function orgHasOtherMembers(orgId: string, callerId: string): Promise<boolean> {
  const { count: profiles } = await admin.from('user_profiles')
    .select('id', { count: 'exact', head: true }).eq('org_id', orgId).neq('id', callerId);
  if ((profiles ?? 0) > 0) return true;
  const { data: locs } = await admin.from('locations').select('id').eq('org_id', orgId).limit(1000);
  const ids = (locs || []).map((l: any) => l.id);
  if (!ids.length) return false;
  const { count: links } = await admin.from('user_locations')
    .select('id', { count: 'exact', head: true }).in('location_id', ids).neq('user_id', callerId);
  return (links ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const { data: { user } } = token ? await admin.auth.getUser(token) : { data: { user: null } };
  const signedIn = decideSignedIn(user);
  if (!signedIn.ok) return refuse(signedIn);
  const caller = user!;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '');

  const { data: me } = await admin.from('user_profiles').select('id, role, org_id, location_id').eq('id', caller.id).maybeSingle();
  if (!me) return json({ error: 'No profile for this login' }, 403);
  const isSuperAdmin = me.role === 'super_admin';

  if (action === 'set_active_location') {
    const locationId = id(body.location_id);
    const loc = await locationRow(locationId);
    const d = decideSetActiveLocation({
      caller, isSuperAdmin, locationId, locationExists: !!loc,
      linkedLocationIds: isSuperAdmin ? [] : await linkedIds(caller.id),
    });
    if (!d.ok) return refuse(d);
    const { error } = await admin.from('user_profiles').update({ location_id: locationId }).eq('id', caller.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, location_id: locationId });
  }

  if (action === 'claim_org') {
    const orgId = id(body.org_id);
    const { data: org } = orgId ? await admin.from('organisations').select('id').eq('id', orgId).maybeSingle() : { data: null };
    const d = decideClaimOrg({
      caller, isSuperAdmin, profileOrgId: me.org_id ?? null, orgExists: !!org,
      orgHasOtherMembers: org ? await orgHasOtherMembers(orgId!, caller.id) : false,
    });
    if (!d.ok) return refuse(d);
    const { error } = await admin.from('user_profiles').update({ org_id: orgId }).eq('id', caller.id).is('org_id', null);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, org_id: orgId });
  }

  if (action === 'adopt_location') {
    const locationId = id(body.location_id);
    const loc = await locationRow(locationId);
    const { data: mine } = loc
      ? await admin.from('user_locations').select('id').eq('user_id', caller.id).eq('location_id', locationId).maybeSingle()
      : { data: null };
    const { count: others } = loc
      ? await admin.from('user_locations').select('id', { count: 'exact', head: true }).eq('location_id', locationId).neq('user_id', caller.id)
      : { count: 0 };
    const d = decideAdoptLocation({
      caller, isSuperAdmin, profileOrgId: me.org_id ?? null,
      locationOrgId: loc?.org_id ?? null, locationExists: !!loc,
      locationHasOtherUsers: (others ?? 0) > 0,
      orgHasOtherMembers: loc?.org_id && !me.org_id ? await orgHasOtherMembers(String(loc.org_id), caller.id) : false,
      alreadyLinked: !!mine,
    });
    if (!d.ok) return refuse(d);
    if (!mine) {
      const { error: ulErr } = await admin.from('user_locations')
        .upsert({ user_id: caller.id, location_id: locationId, role: 'owner' }, { onConflict: 'user_id,location_id' });
      if (ulErr) return json({ error: ulErr.message }, 500);
    }
    // Fill the opening venue and company only when empty (never relocate an existing login).
    const patch: Record<string, unknown> = {};
    if (!me.location_id) patch.location_id = locationId;
    if (!me.org_id) patch.org_id = loc!.org_id;
    if (Object.keys(patch).length) {
      const { error } = await admin.from('user_profiles').update(patch).eq('id', caller.id);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true, location_id: locationId, filled: Object.keys(patch) });
  }

  if (action === 'set_bo_access') {
    const locationId = id(body.location_id);
    const targetId = id(body.user_id);
    if (typeof body.bo_access !== 'boolean') return json({ error: 'bo_access must be true or false' }, 400);
    const [{ data: myLink }, { data: target }, { data: tLink }, { data: tStaff }] = await Promise.all([
      locationId ? admin.from('user_locations').select('role').eq('user_id', caller.id).eq('location_id', locationId).maybeSingle() : Promise.resolve({ data: null }),
      targetId ? admin.from('user_profiles').select('id, role').eq('id', targetId).maybeSingle() : Promise.resolve({ data: null }),
      locationId && targetId ? admin.from('user_locations').select('id').eq('user_id', targetId).eq('location_id', locationId).maybeSingle() : Promise.resolve({ data: null }),
      locationId && targetId ? admin.from('staff_members').select('id').eq('auth_user_id', targetId).eq('location_id', locationId).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const d = decideSetBoAccess({
      caller, isSuperAdmin, callerRoleAtLocation: (myLink as any)?.role ?? null,
      targetId: (target as any)?.id ?? null, targetLinkedToLocation: !!tLink || !!tStaff,
      targetRole: (target as any)?.role ?? null,
    });
    if (!d.ok) return refuse(d);
    const { error } = await admin.from('user_profiles').update({ bo_access: body.bo_access }).eq('id', targetId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, user_id: targetId, bo_access: body.bo_access });
  }

  if (action === 'team_profiles') {
    const locationId = id(body.location_id);
    const wanted = (Array.isArray(body.user_ids) ? body.user_ids : []).map(id).filter(Boolean).slice(0, 500) as string[];
    const { data: myLink } = locationId && !isSuperAdmin
      ? await admin.from('user_locations').select('id').eq('user_id', caller.id).eq('location_id', locationId).maybeSingle()
      : { data: null };
    const d = decideTeamRead({ caller, isSuperAdmin, callerLinked: !!myLink && !!locationId });
    if (!d.ok) return refuse(d);
    if (!locationId || !wanted.length) return json({ ok: true, profiles: [] });
    // Only logins that belong to THIS venue: linked to one of its staff, or linked to the venue.
    const [{ data: st }, { data: ul }] = await Promise.all([
      admin.from('staff_members').select('auth_user_id').eq('location_id', locationId).in('auth_user_id', wanted),
      admin.from('user_locations').select('user_id').eq('location_id', locationId).in('user_id', wanted),
    ]);
    const allowed = new Set<string>([
      ...(st || []).map((r: any) => String(r.auth_user_id)),
      ...(ul || []).map((r: any) => String(r.user_id)),
    ]);
    if (!allowed.size) return json({ ok: true, profiles: [] });
    const { data: profiles, error } = await admin.from('user_profiles')
      .select('id, email, bo_access').in('id', [...allowed]);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, profiles: profiles || [] });
  }

  if (action === 'admin_set_location') {
    const targetId = id(body.user_id);
    const locationId = body.location_id == null ? null : id(body.location_id);
    if (body.location_id != null && !locationId) return json({ error: 'Unknown location' }, 400);
    const [{ data: target }, { data: tLink }] = await Promise.all([
      targetId ? admin.from('user_profiles').select('id').eq('id', targetId).maybeSingle() : Promise.resolve({ data: null }),
      targetId && locationId ? admin.from('user_locations').select('id').eq('user_id', targetId).eq('location_id', locationId).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const d = decideAdminSetLocation({ caller, isSuperAdmin, targetExists: !!target, locationId, targetLinkedToLocation: !!tLink });
    if (!d.ok) return refuse(d);
    const { error } = await admin.from('user_profiles').update({ location_id: locationId }).eq('id', targetId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, user_id: targetId, location_id: locationId });
  }

  return json({ error: 'unknown action' }, 400);
});
