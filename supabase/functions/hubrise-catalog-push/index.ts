// supabase/functions/hubrise-catalog-push/index.ts
//
// Build the HubRise catalog from this venue's ServOS menu and publish it.
// HubRise catalogs are a single whole-document PUT (no per-product endpoints); we
// reuse our own menu_item / category / modifier ids as the HubRise `ref`s so inbound
// orders' sku_ref map straight back to our items. Money is sent as "<amount> <CCY>".
//
// POST { ops_location_id }. Auth: signed-in user with location access, or service role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createLocationCatalog, putCatalog } from '../_shared/hubrise.ts';
import { buildCatalog } from '../_shared/hubrise-map.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } });

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

/** Pull the venue's menu and publish it. Shared so the reconcile cron can call it too. */
export async function pushCatalog(loc: string): Promise<{ catalogId: string; products: number }> {
  const { data: conn } = await sb.from('hubrise_connections').select('*').eq('location_id', loc).maybeSingle();
  if (!conn?.access_token) throw new Error('not connected');

  const [{ data: categories }, { data: items }, { data: groups }] = await Promise.all([
    sb.from('menu_categories').select('*').eq('location_id', loc),
    sb.from('menu_items').select('*').eq('location_id', loc),
    sb.from('modifier_groups').select('*').eq('location_id', loc),
  ]);

  const data = buildCatalog({
    categories: categories || [], items: items || [], modifierGroups: groups || [],
    currency: conn.currency || 'GBP',
  });

  let catalogId = conn.hubrise_catalog_id;
  const name = `${conn.hubrise_location_name || 'ServOS'} menu`;
  try {
    if (!catalogId) {
      const created = await createLocationCatalog(conn.access_token, name, data);
      catalogId = created?.id;
      await sb.from('hubrise_connections').update({
        hubrise_catalog_id: catalogId, hubrise_catalog_name: name,
        catalog_pushed_at: new Date().toISOString(), catalog_push_error: null, updated_at: new Date().toISOString(),
      }).eq('location_id', loc);
    } else {
      await putCatalog(conn.access_token, catalogId, name, data);
      await sb.from('hubrise_connections').update({
        catalog_pushed_at: new Date().toISOString(), catalog_push_error: null, updated_at: new Date().toISOString(),
      }).eq('location_id', loc);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('hubrise_connections').update({ catalog_push_error: msg, updated_at: new Date().toISOString() }).eq('location_id', loc);
    throw e;
  }
  return { catalogId: catalogId!, products: data.products.length };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const loc = String(body?.ops_location_id || body?.location_id || '');
  if (!loc) return json({ error: 'ops_location_id required' }, 400);

  const denied = await requireAccess(req, loc);
  if (denied) return denied;

  try {
    const out = await pushCatalog(loc);
    return json({ ok: true, ...out });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
