// supabase/functions/_shared/hubrise-catalog.ts
//
// Build the HubRise catalog from a venue's ServOS menu and publish it. Moved here from
// hubrise-catalog-push/index.ts (v5.11.81) so the reconcile run can push a changed menu by itself
// (hubriseAutoSync.js): an edge function cannot import another function's index (each one is its
// own bundle and starts its own server).
//
// HubRise catalogs are a single whole-document PUT (no per-product endpoints); we reuse our own
// menu_item / category / modifier ids as the HubRise `ref`s so inbound orders' sku_ref map straight
// back to our items. Money is sent as "<amount> <CCY>".
//
// v5.11.81 also:
//   - every menu row is read page by page (one read stops at the Data API's 1,000 row cap, so a big
//     menu was published with products missing), and only the links of the venue's chosen menus
//     (the old read took every venue's links, 1,000 at most, on the whole platform)
//   - the Delivery switch (visibility.onlineDelivery false) keeps a product off the delivery
//     platforms, as Online off always did (buildCatalog, lib/channelMenu.js channelVisible)
//   - onlyIfChanged: build the document with the image ids already uploaded and send nothing when
//     it is the document last sent (catalog_payload_key); the automatic run uses this
//   - the menu fingerprint at the start of a push is recorded with it, so the automatic run knows
//     HubRise has that menu (a manual Push menu counts too)

import { createLocationCatalog, putCatalog, uploadCatalogImage } from './hubrise.ts';
import { buildCatalog } from './hubrise-map.ts';
import { resyncInventory } from './hubrise-ingest.ts';
import { catalogPayloadKey } from './hubriseAutoSync.js';
// v5.11.91 (multi site stock Drop 2): the allergens the stock recipe at this site adds ride the
// items into the catalogue (hubrise-map reads it.allergens; never fewer than typed). The menu
// fingerprint (hubrise_menu_fingerprint, 20261025a) covers the facts table, so the automatic run
// notices a facts change.
import { mergeStockFacts } from './menuStockFacts.js';

const EMPTY_CATALOG = { variants: [], categories: [], products: [], option_lists: [], deals: [], discounts: [], charges: [] };
const PAGE = 1000;
const MAX_PAGES = 20;

/** Every row of a query, page by page. make() builds a fresh query each time. Throws on a failed page. */
async function readAll(make: () => any, what: string): Promise<any[]> {
  const rows: any[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await make().range(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw new Error(`${what} could not be read: ${error.message || error}`);
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
  throw new Error(`${what}: more rows than one catalog can hold`);
}

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

/** The venue's menu fingerprint (migration 20261020a), or null when it cannot be read. */
export async function menuFingerprint(sb: any, loc: string): Promise<string | null> {
  try {
    const { data, error } = await sb.rpc('hubrise_menu_fingerprint', { p_location_id: loc });
    if (error) return null;
    return typeof data === 'string' && data ? data : null;
  } catch { return null; }
}

// What buildCatalog publishes as a product, the image loop below must match it.
const publishedProduct = (it: any) => it && !it.parent_id && !it.archived && it.sold_alone !== false
  && !(it.visibility && (it.visibility.online === false || it.visibility.onlineDelivery === false));

/** Pull the venue's menu and publish it.
 *  force=true re-uploads every image even if one already exists (use when an operator
 *  has changed product images); default reuses already-uploaded image ids.
 *  onlyIfChanged=true sends nothing when the document is the one last sent. */
export async function pushCatalog(sb: any, loc: string, force = false, { onlyIfChanged = false } = {}):
  Promise<{ catalogId: string; products: number; images: number; imagesReused: number; unchanged?: boolean }> {
  const { data: conn } = await sb.from('hubrise_connections').select('*').eq('location_id', loc).maybeSingle();
  if (!conn?.access_token) throw new Error('not connected');
  const token = conn.access_token;
  // The menu as it is now, BEFORE it is read: if it changes during the push, the next run sees it.
  const fingerprint = await menuFingerprint(sb, loc);

  const menuIds = Array.isArray(conn.menu_ids) ? conn.menu_ids.map(String) : [];
  const [categories, items, groups, { data: snapRow }, { data: taxRates }, links] = await Promise.all([
    readAll(() => sb.from('menu_categories').select('*').eq('location_id', loc).order('id'), 'categories'),
    readAll(() => sb.from('menu_items').select('*').eq('location_id', loc).order('id'), 'menu items'),
    readAll(() => sb.from('modifier_groups').select('*').eq('location_id', loc).order('id'), 'option groups'),
    sb.from('config_pushes').select('snapshot').eq('location_id', loc).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('tax_rates').select('*').eq('location_id', loc),
    menuIds.length
      ? readAll(() => sb.from('menu_category_links').select('menu_id, category_id').in('menu_id', menuIds).order('menu_id').order('category_id'), 'menu links')
      : Promise.resolve([]),
  ]);
  // Cooking-instruction groups live in the latest config-push snapshot, not a table.
  const instructionGroups = snapRow?.snapshot?.instructionGroupDefs || [];
  // v5.11.91: the stock facts of this venue's products. Optional: a database before 20261025a has
  // no table, and a failed read publishes the typed allergens as before.
  let facts: any[] = [];
  try { facts = await readAll(() => sb.from('menu_item_stock_facts').select('*').eq('location_id', loc).order('menu_item_id'), 'stock facts'); }
  catch (e) { console.warn('[hubrise-catalog] stock facts not read, typed allergens published:', e instanceof Error ? e.message : e); facts = []; }
  const itemsWithFacts = mergeStockFacts(items || [], facts) as any[];

  // Menu selection: if the operator picked which menu(s) publish to HubRise, restrict to
  // those and resolve each item's DELIVERY price from that menu's tier; otherwise publish
  // all online-visible items at the top-level delivery price.
  let cats = categories || [];
  let publishIds: Set<string> | null = null;
  const itemMenuId: Record<string, string | null> = {};
  if (menuIds.length) {
    const sel = new Set(menuIds);
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
  // upload time. Same URL -> reuse the id; changed URL -> re-upload.
  let cached: Record<string, { id: string; url: string }> = (!force && conn.catalog_image_ids) || {};
  const wanted = itemsWithFacts.filter((it: any) => publishedProduct(it) && (!publishIds || publishIds.has(String(it.id))) && it.image);
  const build = (imageIdByItem: Record<string, string>) => buildCatalog({
    categories: cats, items: itemsWithFacts, modifierGroups: groups || [],
    currency: conn.currency || 'GBP', publishIds, itemMenuId, channel: 'delivery',
    instructionGroups, imageIdByItem, taxRates: taxRates || [],
  });

  // The automatic run: nothing new to upload and the same document as last time, send nothing.
  if (onlyIfChanged && catalogId && !force) {
    const allCached = wanted.every((it: any) => cached[String(it.id)]?.id && cached[String(it.id)].url === String(it.image));
    if (allCached) {
      const ids: Record<string, string> = {};
      wanted.forEach((it: any) => { ids[String(it.id)] = cached[String(it.id)].id; });
      const doc = build(ids);
      if (conn.catalog_payload_key && catalogPayloadKey(doc) === conn.catalog_payload_key) {
        await recordFingerprint(sb, loc, fingerprint, null);
        return { catalogId, products: doc.products.length, images: Object.keys(ids).length, imagesReused: Object.keys(ids).length, unchanged: true };
      }
    }
  }

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
    for (const it of wanted) {
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

    const data = build(imageIdByItem);

    await putCatalog(token, catalogId!, name, data);
    await sb.from('hubrise_connections').update({
      hubrise_catalog_name: name, catalog_pushed_at: new Date().toISOString(),
      catalog_push_error: null, catalog_image_ids: nextCache,   // drops removed items; force rebuilds fully
      updated_at: new Date().toISOString(),
    }).eq('location_id', loc);
    await recordFingerprint(sb, loc, fingerprint, catalogPayloadKey(data));

    // HubRise guidance: PUT /inventory immediately after every catalog update, so the 86/stock
    // state re-applies against the just-published refs (a stock ref only sticks once its catalog
    // entry exists — pushing the catalog first then re-asserting inventory is the correct order).
    // Best-effort: a stock blip must not fail the catalog publish.
    try { await resyncInventory(sb, loc); }
    catch (e) { console.warn('[hubrise-catalog] post-publish inventory resync failed:', e instanceof Error ? e.message : e); }

    return { catalogId: catalogId!, products: data.products.length, images: Object.keys(imageIdByItem).length, imagesReused };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('hubrise_connections').update({ catalog_push_error: msg, updated_at: new Date().toISOString() }).eq('location_id', loc);
    throw e;
  }
}

// The columns 20261020a adds. Written on their own, so a push still works before it runs (the
// update is refused and nothing else is lost).
async function recordFingerprint(sb: any, loc: string, fingerprint: string | null, payloadKey: string | null) {
  if (!fingerprint && !payloadKey) return;
  const patch: Record<string, unknown> = {};
  if (fingerprint) Object.assign(patch, { catalog_fingerprint: fingerprint, menu_fingerprint: fingerprint, menu_fingerprint_at: new Date().toISOString() });
  if (payloadKey) patch.catalog_payload_key = payloadKey;
  try { await sb.from('hubrise_connections').update(patch).eq('location_id', loc); } catch { /* before 20261020a */ }
}
