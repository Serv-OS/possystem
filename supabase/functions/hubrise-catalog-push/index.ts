// supabase/functions/hubrise-catalog-push/index.ts
//
// Build the HubRise catalog from this venue's ServOS menu and publish it.
// HubRise catalogs are a single whole-document PUT (no per-product endpoints); we
// reuse our own menu_item / category / modifier ids as the HubRise `ref`s so inbound
// orders' sku_ref map straight back to our items. Money is sent as "<amount> <CCY>".
//
// POST { ops_location_id }. Auth: signed-in user with location access, or service role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createLocationCatalog, putCatalog, uploadCatalogImage } from '../_shared/hubrise.ts';
import { buildCatalog } from '../_shared/hubrise-map.ts';
import { resyncInventory } from '../_shared/hubrise-ingest.ts';

const EMPTY_CATALOG = { variants: [], categories: [], products: [], option_lists: [], deals: [], discounts: [], charges: [] };

/** Fetch an image URL and upload its bytes to the catalog; returns the HubRise image id (or null). */
async function uploadImageFromUrl(token: string, catalogId: string, url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 1_000_000) return null; // HubRise: 1 MB per image
    return await uploadCatalogImage(token, catalogId, buf, ct);
  } catch { return null; }
}

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

/** Pull the venue's menu and publish it. Shared so the reconcile cron can call it too.
 *  force=true re-uploads every image even if one already exists (use when an operator
 *  has changed product images); default reuses already-uploaded image ids. */
export async function pushCatalog(loc: string, force = false): Promise<{ catalogId: string; products: number; images: number; imagesReused: number }> {
  const { data: conn } = await sb.from('hubrise_connections').select('*').eq('location_id', loc).maybeSingle();
  if (!conn?.access_token) throw new Error('not connected');
  const token = conn.access_token;

  const [{ data: categories }, { data: items }, { data: groups }, { data: snapRow }] = await Promise.all([
    sb.from('menu_categories').select('*').eq('location_id', loc),
    sb.from('menu_items').select('*').eq('location_id', loc),
    sb.from('modifier_groups').select('*').eq('location_id', loc),
    sb.from('config_pushes').select('snapshot').eq('location_id', loc).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  // Cooking-instruction groups live in the latest config-push snapshot, not a table.
  const instructionGroups = snapRow?.snapshot?.instructionGroupDefs || [];

  // Menu selection: if the operator picked which menu(s) publish to HubRise, restrict to
  // those and resolve each item's DELIVERY price from that menu's tier; otherwise publish
  // all online-visible items at the top-level delivery price.
  const menuIds = Array.isArray(conn.menu_ids) ? conn.menu_ids.map(String) : [];
  let cats = categories || [];
  let publishIds: Set<string> | null = null;
  const itemMenuId: Record<string, string | null> = {};
  if (menuIds.length) {
    const sel = new Set(menuIds);
    const { data: links } = await sb.from('menu_category_links').select('menu_id, category_id');
    const catMenus: Record<string, Set<string>> = {};
    (links || []).forEach((l: any) => { (catMenus[String(l.category_id)] ??= new Set()).add(String(l.menu_id)); });
    (categories || []).forEach((c: any) => { if (c.menu_id) (catMenus[String(c.id)] ??= new Set()).add(String(c.menu_id)); });
    const selCatMenu: Record<string, string> = {};  // category id -> first selected menu it's in
    for (const [catId, menus] of Object.entries(catMenus)) {
      for (const m of menus) if (sel.has(m)) { selCatMenu[catId] = m; break; }
    }
    cats = (categories || []).filter((c: any) => selCatMenu[String(c.id)]);
    publishIds = new Set();
    (items || []).forEach((it: any) => {
      if (it.parent_id) return; // variant children ride with their parent
      const candidates = [it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean).map(String);
      const menuForItem = candidates.map((c) => selCatMenu[c]).find(Boolean) || null;
      if (menuForItem) { publishIds!.add(String(it.id)); itemMenuId[String(it.id)] = menuForItem; }
    });
  }

  const name = `${conn.hubrise_location_name || 'ServOS'} menu`;
  let catalogId = conn.hubrise_catalog_id;

  // Product images: HubRise needs uploaded image ids, not URLs. Per HubRise's guidance we
  // do NOT GET the catalog before publishing (pure push) — already-uploaded image ids are
  // cached on hubrise_connections.catalog_image_ids, keyed per item on the source URL at
  // upload time. Same URL -> reuse the id; changed URL -> re-upload (fixes the stale-image
  // bug the old pre-publish GET had, where a changed image never re-uploaded).
  let cached: Record<string, { id: string; url: string }> = (!force && conn.catalog_image_ids) || {};

  try {
    // Ensure the catalog exists first — image upload (POST /catalogs/:id/images) needs its id.
    if (!catalogId) {
      const created = await createLocationCatalog(token, name, EMPTY_CATALOG);
      catalogId = created?.id;
      cached = {}; // a new catalog invalidates any previously cached image ids
      await sb.from('hubrise_connections').update({
        hubrise_catalog_id: catalogId, hubrise_catalog_name: name, catalog_image_ids: {},
        updated_at: new Date().toISOString(),
      }).eq('location_id', loc);
    }

    const imageIdByItem: Record<string, string> = {};
    const nextCache: Record<string, { id: string; url: string }> = {};
    let imagesReused = 0;
    for (const it of (items || [])) {
      // Match buildCatalog.publishable — incl. sold-alone sub-items (donuts) so their images upload too.
      if (it.parent_id || it.archived || it.sold_alone === false) continue;
      if (it.visibility && it.visibility.online === false) continue;
      if (publishIds && !publishIds.has(String(it.id))) continue;
      if (!it.image) continue;
      const ref = String(it.id);
      const url = String(it.image);
      const hit = cached[ref];
      if (hit?.id && hit.url === url) {
        imageIdByItem[ref] = hit.id; imagesReused++;   // reuse — no re-upload
      } else {
        const id = await uploadImageFromUrl(token, catalogId!, url);
        if (id) imageIdByItem[ref] = id;
      }
      if (imageIdByItem[ref]) nextCache[ref] = { id: imageIdByItem[ref], url };
    }

    const data = buildCatalog({
      categories: cats, items: items || [], modifierGroups: groups || [],
      currency: conn.currency || 'GBP', publishIds, itemMenuId, channel: 'delivery',
      instructionGroups, imageIdByItem,
    });

    await putCatalog(token, catalogId!, name, data);
    await sb.from('hubrise_connections').update({
      hubrise_catalog_name: name, catalog_pushed_at: new Date().toISOString(),
      catalog_push_error: null, catalog_image_ids: nextCache,   // drops removed items; force rebuilds fully
      updated_at: new Date().toISOString(),
    }).eq('location_id', loc);

    // HubRise guidance: PUT /inventory immediately after every catalog update, so the 86/stock
    // state re-applies against the just-published refs (a stock ref only sticks once its catalog
    // entry exists — pushing the catalog first then re-asserting inventory is the correct order).
    // Best-effort: a stock blip must not fail the catalog publish.
    try { await resyncInventory(sb, loc); }
    catch (e) { console.warn('[hubrise-catalog-push] post-publish inventory resync failed:', e instanceof Error ? e.message : e); }

    return { catalogId: catalogId!, products: data.products.length, images: Object.keys(imageIdByItem).length, imagesReused };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('hubrise_connections').update({ catalog_push_error: msg, updated_at: new Date().toISOString() }).eq('location_id', loc);
    throw e;
  }
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
    const out = await pushCatalog(loc, !!body?.force);  // force=true re-uploads all images
    return json({ ok: true, ...out });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
