// supabase/functions/hubrise-inventory-push/index.ts
//
// Push ServOS 86 / stock state to HubRise so connected channels stop selling
// sold-out items. HubRise inventory is per-location, keyed by the catalog sku_ref
// (== our menu_item id), with stock "0" = sold out and stock null (PATCH) = restore
// (unlimited). An item omitted from inventory is treated as unlimited.
//
// POST { ops_location_id, changes?: [{ itemId, is86 }], full?: true }
//   - changes : incremental real-time PATCH (instant 86 / un-86 from the toggle)
//   - full    : rebuild the whole 86 set and PUT (resync / safety net for the cron)
// Auth: signed-in user with location access, or service role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { patchInventory } from '../_shared/hubrise.ts';
import { resyncInventory } from '../_shared/hubrise-ingest.ts';

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
    if (body?.full) {
      const out = await resyncInventory(sb, loc);
      return json({ ok: true, ...out });
    }
    const changes = Array.isArray(body?.changes) ? body.changes : [];
    if (!changes.length) return json({ ok: true, skipped: 'no changes' });

    const { data: conn } = await sb.from('hubrise_connections').select('access_token, hubrise_catalog_id').eq('location_id', loc).maybeSingle();
    if (!conn?.access_token) return json({ ok: true, skipped: 'not connected' });
    if (!conn.hubrise_catalog_id) return json({ ok: true, skipped: 'no catalog' });

    // 86 -> stock "0"; un-86 -> stock null (removes the entry = unlimited). Push each id as
    // BOTH sku_ref and option_ref (items can be sold standalone AND appear as a modifier
    // option sharing the same ref); sku-only fallback if HubRise rejects unknown option refs.
    const valid = changes.filter((c: any) => c?.itemId);
    if (!valid.length) return json({ ok: true, skipped: 'no valid changes' });
    const skuEntries = valid.map((c: any) => ({ sku_ref: String(c.itemId), stock: c.is86 ? '0' : null }));
    const allEntries = [...skuEntries, ...valid.map((c: any) => ({ option_ref: String(c.itemId), stock: c.is86 ? '0' : null }))];

    try { await patchInventory(conn.access_token, conn.hubrise_catalog_id, allEntries); }
    catch { await patchInventory(conn.access_token, conn.hubrise_catalog_id, skuEntries); }
    await sb.from('hubrise_connections').update({ inventory_synced_at: new Date().toISOString() }).eq('location_id', loc);
    return json({ ok: true, pushed: skuEntries.length });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
