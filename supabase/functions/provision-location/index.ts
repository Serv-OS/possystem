// supabase/functions/provision-location/index.ts
//
// Mirrors an Ops DB location into the Platform DB so all platform-backed
// features (loyalty, gift cards, online ordering, QR, Challenge 21, message
// templates, location settings) can resolve the location's company.
//
// Without this, a location created in the Ops DB has no platform.locations row
// (ops_location_id → company_id), so resolveCompanyForLocation() returns null
// and every platform feature errors with "No platform row found".
//
// Idempotent: safe to call repeatedly. Find-or-creates the platform company
// for the location's org, then upserts the platform location.
//
// Body: { ops_location_id: string }
// Returns: { ok, company_id, platform_location_id, created_company, created_location }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const opsAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth: any authenticated user (owner provisioning their own location, or
  // super_admin). The function only mirrors existing Ops data to the Platform
  // DB — it cannot create arbitrary tenants.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const { data: { user: caller } } = await opsAdmin.auth.getUser(authHeader.replace('Bearer ', ''));
  if (!caller) return json({ error: 'Invalid token' }, 401);

  let body: { ops_location_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const opsLocationId = body.ops_location_id;
  if (!opsLocationId) return json({ error: 'ops_location_id required' }, 400);

  // 1. Read the Ops location + its org
  const { data: opsLoc, error: locErr } = await opsAdmin
    .from('locations')
    .select('id, name, address, timezone, currency, org_id')
    .eq('id', opsLocationId)
    .maybeSingle();
  if (locErr) return json({ error: `Ops location read failed: ${locErr.message}` }, 500);
  if (!opsLoc) return json({ error: 'Ops location not found' }, 404);
  if (!opsLoc.org_id) return json({ error: 'Ops location has no org_id' }, 400);

  const { data: opsOrg } = await opsAdmin
    .from('organisations')
    .select('id, name, slug')
    .eq('id', opsLoc.org_id)
    .maybeSingle();
  const orgId = opsLoc.org_id;
  const orgName = opsOrg?.name || 'Company';
  const orgSlug = (opsOrg?.slug || orgName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  // 2. Find-or-create the platform company.
  //    a. by id === ops org id (the intended model)
  //    b. by matching slug (legacy rows where ids diverged)
  //    c. create new (id = ops org id)
  let companyId: string | null = null;
  let createdCompany = false;

  const { data: byId } = await platformAdmin.from('companies').select('id').eq('id', orgId).maybeSingle();
  if (byId?.id) {
    companyId = byId.id;
  } else {
    const { data: bySlug } = await platformAdmin.from('companies').select('id').eq('slug', orgSlug).maybeSingle();
    if (bySlug?.id) {
      companyId = bySlug.id;
    } else {
      // Create. If the slug somehow collides (race), fall back to a suffixed slug.
      let insertSlug = orgSlug;
      let ins = await platformAdmin.from('companies')
        .insert({ id: orgId, name: orgName, slug: insertSlug, plan: 'free' })
        .select('id').maybeSingle();
      if (ins.error && /slug/.test(ins.error.message || '')) {
        insertSlug = `${orgSlug}-${orgId.slice(0, 8)}`;
        ins = await platformAdmin.from('companies')
          .insert({ id: orgId, name: orgName, slug: insertSlug, plan: 'free' })
          .select('id').maybeSingle();
      }
      if (ins.error || !ins.data) return json({ error: `Company create failed: ${ins.error?.message || 'unknown'}` }, 500);
      companyId = ins.data.id;
      createdCompany = true;
    }
  }

  // 3. Upsert the platform location (keyed on ops_location_id)
  let createdLocation = false;
  const { data: existingLoc } = await platformAdmin
    .from('locations')
    .select('id, company_id')
    .eq('ops_location_id', opsLocationId)
    .maybeSingle();

  let platformLocationId: string;
  if (existingLoc?.id) {
    platformLocationId = existingLoc.id;
    // Heal a null company_id if a prior partial provision left one
    if (!existingLoc.company_id && companyId) {
      await platformAdmin.from('locations').update({ company_id: companyId }).eq('id', existingLoc.id);
    }
  } else {
    const { data: newLoc, error: insErr } = await platformAdmin
      .from('locations')
      .insert({
        company_id: companyId,
        name: opsLoc.name || 'Location',
        address: opsLoc.address || null,
        timezone: opsLoc.timezone || 'Europe/London',
        // v5.5.327: carry the currency chosen at creation through to the platform
        // mirror (which the app reads for money formatting + Stripe). Only on
        // INSERT — once provisioned, Location Settings owns the platform value,
        // so a re-provision must not clobber an edited currency.
        currency: opsLoc.currency || 'GBP',
        ops_location_id: opsLocationId,
      })
      .select('id')
      .maybeSingle();
    if (insErr || !newLoc) return json({ error: `Platform location create failed: ${insErr?.message || 'unknown'}` }, 500);
    platformLocationId = newLoc.id;
    createdLocation = true;
  }

  return json({
    ok: true,
    company_id: companyId,
    platform_location_id: platformLocationId,
    created_company: createdCompany,
    created_location: createdLocation,
  });
});
