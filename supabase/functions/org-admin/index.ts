// supabase/functions/org-admin/index.ts
//
// DELETE AN ORGANISATION (OR A LOCATION) AND WIPE ALL ITS DATA. ServOS staff only.
//
// WHY (Peter, 5 Nov 2026): "Cant delete organizations from the back office. Delete button
// doesn't do anything, this should say delete organizations - all locations and wipe all data."
// Until now Company Admin deleted 13 hand listed tables from the browser and ignored every
// error; two hundred other tables point at a venue, so nothing ever went.
//
// Whoever can call this can erase a whole company. So the door is as narrow as
// update-emails-admin's, in the same order:
//   1. A real sign in that has done its SECOND STEP (requireAal2).
//   2. The token must belong to a real user (getUser), never an anonymous session.
//   3. That user's user_profiles.role must be 'super_admin', read here with the service role.
//   4. delete_* needs the organisation's (or location's) name typed exactly; the SQL checks the
//      organisation name a second time.
//
// WHAT A DELETE DOES, in order (each SQL call is all or nothing):
//   a. For each location of the organisation, one at a time (a big venue stays inside one
//      statement's time): Ops admin_wipe_locations, Platform admin_wipe_platform_locations,
//      then the venue's files in every storage bucket (best effort, errors listed).
//   b. Ops admin_wipe_organisation: the org keyed rows, the people's profiles, the
//      organisations row. It answers login_ids: those sign ins are removed here through the
//      auth admin API (the SQL never touches schema auth).
//   c. Platform admin_wipe_platform_company: the company's gift cards, loyalty, sites, the
//      companies row (the company with the organisation's id, or found by its slug).
//   A step that fails stops the rest; what went before stays gone, and pressing Delete again
//   carries on from where it stopped (every step is a no op on rows already gone).
//
//   preview          { org_id }                  -> { org, locations, ops, platform, logins, locations_count }   dry run, nothing changes
//   delete_org       { org_id, name_typed }      -> { ok, name, locations, ops, platform, logins, storage, ... }
//   preview_location { location_id }             -> { location, ops, platform }
//   delete_location  { location_id, name_typed } -> { ok, name, ops, platform, storage }
//              409 not_ready        a wipe function is missing (20261125a on Ops, 20261125b on Platform)
//              409 name_mismatch    the typed name is not the name
//
// SQL: 20261125a_OPS_admin_wipe.sql (Ops), 20261125b_PLATFORM_admin_wipe.sql (Platform).
// Deploy: npx supabase functions deploy org-admin --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAal2, bearerToken } from '../_shared/second-step.ts';
// @ts-ignore plain JS shared with node tests and the screen
import { nameMatches, isUuid, isMissingWipeFunction, STORAGE_BUCKETS, storagePrefixes, NEEDS_UPDATE_LINE } from '../_shared/orgWipeRules.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

// The Platform project (payments, gift cards, loyalty, online pages). Same names provision-location uses.
const PLATFORM_URL = Deno.env.get('PLATFORM_SUPABASE_URL') ?? '';
const PLATFORM_KEY = Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '';
const platform = PLATFORM_URL && PLATFORM_KEY
  ? createClient(PLATFORM_URL, PLATFORM_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const OPS_NOT_READY = 'Run the Ops database update first (20261125a_OPS_admin_wipe.sql). Nothing was deleted.';
const PLATFORM_NOT_READY = 'Run the Platform database update first (20261125b_PLATFORM_admin_wipe.sql). Nothing more was deleted.';
const STORAGE_PAGE = 1000;
const STORAGE_MAX_FILES = 20000;
const REMOVE_BATCH = 100;

type Report = Record<string, unknown>;

const refusal = (e: any, where: 'ops' | 'platform') => {
  if (isMissingWipeFunction(e)) return json({ error: where === 'ops' ? OPS_NOT_READY : PLATFORM_NOT_READY, code: 'not_ready', where }, 409);
  const msg = String(e?.message ?? '');
  if (/does not match/i.test(msg)) return json({ error: 'The name typed does not match. Nothing was deleted.', code: 'name_mismatch' }, 409);
  return json({ error: `The ${where === 'ops' ? 'Ops' : 'Platform'} database refused that: ${msg}`, code: 'db_refused', where, detail: msg }, 500);
};

async function rpc(client: any, fn: string, args: Record<string, unknown>): Promise<{ data: any; error: any }> {
  const { data, error } = await client.rpc(fn, args);
  return { data, error };
}

// ── Storage: every file under the venue's prefixes, in every bucket, best effort ──────────
async function listAll(bucket: string, prefix: string, out: string[], errors: string[]) {
  let offset = 0;
  while (out.length < STORAGE_MAX_FILES) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: STORAGE_PAGE, offset });
    if (error) {
      // A bucket that does not exist is not an error worth a line.
      if (!/not found|does not exist/i.test(String(error.message ?? ''))) errors.push(`${bucket}/${prefix}: ${error.message}`);
      return;
    }
    const rows = data ?? [];
    for (const r of rows) {
      const full = prefix ? `${prefix}/${r.name}` : r.name;
      if (r.id == null) await listAll(bucket, full, out, errors);   // a folder
      else out.push(full);
    }
    if (rows.length < STORAGE_PAGE) return;
    offset += STORAGE_PAGE;
  }
}

async function sweepStorage(locationIds: string[]): Promise<{ files: number; errors: string[] }> {
  let files = 0;
  const errors: string[] = [];
  for (const bucket of STORAGE_BUCKETS) {
    const paths: string[] = [];
    for (const id of locationIds) {
      for (const prefix of storagePrefixes(id)) await listAll(bucket, prefix, paths, errors);
      // terminal-idle/<locationId>-... sits in a shared folder: match by file name
      const { data } = await admin.storage.from(bucket).list('terminal-idle', { limit: STORAGE_PAGE, search: id });
      for (const r of data ?? []) if (r.id != null && String(r.name).startsWith(`${id}-`)) paths.push(`terminal-idle/${r.name}`);
    }
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      const batch = paths.slice(i, i + REMOVE_BATCH);
      const { data, error } = await admin.storage.from(bucket).remove(batch);
      if (error) errors.push(`${bucket}: ${error.message} (${batch.length} files)`);
      else files += (data ?? []).length;
    }
  }
  return { files, errors };
}

// ── The Platform company for an organisation: same id, else the slug ─────────────────────
async function platformCompanyId(orgId: string, slug: string | null): Promise<string | null> {
  if (!platform) return null;
  const { data: byId } = await platform.from('companies').select('id').eq('id', orgId).maybeSingle();
  if (byId?.id) return String(byId.id);
  if (slug) {
    const { data: bySlug } = await platform.from('companies').select('id').eq('slug', slug).maybeSingle();
    if (bySlug?.id) return String(bySlug.id);
  }
  return null;
}

async function removeLogins(ids: string[]): Promise<{ removed: number; errors: string[] }> {
  let removed = 0;
  const errors: string[] = [];
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error && !/not found/i.test(String(error.message ?? ''))) errors.push(`${id}: ${error.message}`);
    else removed += 1;
  }
  return { removed, errors };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // 1. A real sign in with its second step done, always (docs/SECOND_STEP.md).
  const needs = requireAal2(req, [SERVICE_ROLE]);
  if (needs) return needs;

  // 2. A real user, never an anonymous session and never the service key itself.
  const token = bearerToken(req);
  if (!token || token === SERVICE_ROLE) return json({ error: 'Sign in to Company Admin first.' }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user || !user.id) return json({ error: 'Sign in to Company Admin first.' }, 401);
  if (user.is_anonymous) return json({ error: 'Only ServOS staff can do this.' }, 403);

  // 3. ServOS staff: the role on the profile, read with the service role.
  const { data: profile, error: profErr } = await admin.from('user_profiles').select('role').eq('id', user.id).maybeSingle();
  if (profErr || profile?.role !== 'super_admin') return json({ error: 'Only ServOS staff can do this.' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const action = String(body?.action ?? '');

  // ── An organisation ───────────────────────────────────────────────────────────────────────
  if (action === 'preview' || action === 'delete_org') {
    const orgId = String(body?.org_id ?? '');
    if (!isUuid(orgId)) return json({ error: 'org_id must be a uuid.' }, 400);
    const { data: org, error: orgErr } = await admin.from('organisations').select('id, name, slug').eq('id', orgId).maybeSingle();
    if (orgErr) return json({ error: `Could not read the organisation: ${orgErr.message}` }, 500);
    if (!org) return json({ error: 'Organisation not found.', code: 'not_found' }, 404);
    const name = String(org.name ?? '');
    const { data: locs } = await admin.from('locations').select('id, name').eq('org_id', orgId).order('created_at', { ascending: true });
    const locations = (locs ?? []).map((l: any) => ({ id: String(l.id), name: String(l.name ?? '') }));
    const locIds = locations.map((l) => l.id);
    const companyId = await platformCompanyId(orgId, org.slug ? String(org.slug) : null);

    if (action === 'preview') {
      const ops = await rpc(admin, 'admin_wipe_organisation', { p_org_id: orgId, p_org_name: name, p_dry_run: true });
      if (ops.error) return refusal(ops.error, 'ops');
      let plat: Report = { configured: !!platform, company: !!companyId };
      if (platform) {
        if (locIds.length) {
          const pl = await rpc(platform, 'admin_wipe_platform_locations', { p_ops_location_ids: locIds, p_dry_run: true });
          if (pl.error) return refusal(pl.error, 'platform');
          plat.locations_report = pl.data;
        }
        if (companyId) {
          const pc = await rpc(platform, 'admin_wipe_platform_company', { p_company_id: companyId, p_dry_run: true });
          if (pc.error) return refusal(pc.error, 'platform');
          plat.company_report = pc.data;
        }
      }
      return json({
        ok: true, dry_run: true, org: { id: orgId, name, slug: org.slug ?? null }, locations, locations_count: locations.length,
        logins: Number(ops.data?.logins ?? 0), ops: ops.data, platform: plat, needs_update_line: NEEDS_UPDATE_LINE,
      });
    }

    // 4. The typed name.
    if (!nameMatches(body?.name_typed, name)) return json({ error: 'The name typed does not match the organisation name. Nothing was deleted.', code: 'name_mismatch' }, 409);

    const venues: Report[] = [];
    const storage = { files: 0, errors: [] as string[] };
    for (const loc of locations) {
      const ops = await rpc(admin, 'admin_wipe_locations', { p_location_ids: [loc.id], p_dry_run: false });
      if (ops.error) return refusal(ops.error, 'ops');
      let plat: any = null;
      if (platform) {
        const pl = await rpc(platform, 'admin_wipe_platform_locations', { p_ops_location_ids: [loc.id], p_dry_run: false });
        if (pl.error) return refusal(pl.error, 'platform');
        plat = pl.data;
      }
      const sw = await sweepStorage([loc.id]);
      storage.files += sw.files; storage.errors.push(...sw.errors);
      venues.push({ id: loc.id, name: loc.name, ops: ops.data, platform: plat, files: sw.files });
    }
    const org_report = await rpc(admin, 'admin_wipe_organisation', { p_org_id: orgId, p_org_name: String(body?.name_typed ?? ''), p_dry_run: false });
    if (org_report.error) return refusal(org_report.error, 'ops');
    const loginIds: string[] = Array.isArray(org_report.data?.login_ids) ? org_report.data.login_ids.map(String) : [];
    const logins = await removeLogins(loginIds);
    let company: any = null;
    if (platform && companyId) {
      const pc = await rpc(platform, 'admin_wipe_platform_company', { p_company_id: companyId, p_dry_run: false });
      if (pc.error) return refusal(pc.error, 'platform');
      company = pc.data;
    }
    console.log('[org-admin] organisation deleted', orgId, name, 'by', user.id, 'locations', locations.length, 'logins', logins.removed, 'files', storage.files);
    return json({
      ok: true, name, locations: locations.length, venues, ops: org_report.data, platform: { configured: !!platform, company_report: company },
      logins: logins.removed, login_errors: logins.errors, storage,
    });
  }

  // ── One location ──────────────────────────────────────────────────────────────────────────
  if (action === 'preview_location' || action === 'delete_location') {
    const locId = String(body?.location_id ?? '');
    if (!isUuid(locId)) return json({ error: 'location_id must be a uuid.' }, 400);
    const { data: loc, error: locErr } = await admin.from('locations').select('id, name, org_id').eq('id', locId).maybeSingle();
    if (locErr) return json({ error: `Could not read the location: ${locErr.message}` }, 500);
    if (!loc) return json({ error: 'Location not found.', code: 'not_found' }, 404);
    const name = String(loc.name ?? '');

    if (action === 'preview_location') {
      const ops = await rpc(admin, 'admin_wipe_locations', { p_location_ids: [locId], p_dry_run: true });
      if (ops.error) return refusal(ops.error, 'ops');
      let plat: any = { configured: !!platform };
      if (platform) {
        const pl = await rpc(platform, 'admin_wipe_platform_locations', { p_ops_location_ids: [locId], p_dry_run: true });
        if (pl.error) return refusal(pl.error, 'platform');
        plat = { configured: true, ...pl.data };
      }
      return json({ ok: true, dry_run: true, location: { id: locId, name, org_id: loc.org_id ?? null }, locations: 1, ops: ops.data, platform: plat, needs_update_line: NEEDS_UPDATE_LINE });
    }

    if (!nameMatches(body?.name_typed, name)) return json({ error: 'The name typed does not match the location name. Nothing was deleted.', code: 'name_mismatch' }, 409);
    const ops = await rpc(admin, 'admin_wipe_locations', { p_location_ids: [locId], p_dry_run: false });
    if (ops.error) return refusal(ops.error, 'ops');
    let plat: any = { configured: !!platform };
    if (platform) {
      const pl = await rpc(platform, 'admin_wipe_platform_locations', { p_ops_location_ids: [locId], p_dry_run: false });
      if (pl.error) return refusal(pl.error, 'platform');
      plat = { configured: true, ...pl.data };
    }
    const storage = await sweepStorage([locId]);
    console.log('[org-admin] location deleted', locId, name, 'by', user.id, 'files', storage.files);
    return json({ ok: true, name, locations: 1, ops: ops.data, platform: plat, storage });
  }

  return json({ error: 'unknown action' }, 400);
});
