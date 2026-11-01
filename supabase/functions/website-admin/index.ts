// supabase/functions/website-admin/index.ts
// MARKER 5.12.0 website builder admin
//
// Back Office writes to the website builder tables on the PLATFORM DB (web_sites, web_pages,
// web_posts, web_site_versions, web_ai_messages, web_assets). Contract: docs/website-builder/
// ARCHITECTURE.md sections 2, 8 and 10.
//
// WHY AN EDGE FUNCTION. The Platform browser client holds no login (src/lib/supabase.js,
// persistSession false), so a browser policy cannot tell the owner from anyone else. Every
// write therefore comes here under the service role, behind the fence in _shared/websiteAuth.ts
// (real signed in user, venues read server side, company id derived from them, never from the
// body). Same discipline as location-admin.
//
// WHITELISTS. Each action accepts named keys only (_shared/websiteRules.js). Anything else is
// REFUSED with 400 and a plain reason, never dropped: a silent drop is how an owner believes a
// page saved when it did not.
//
// ACTIONS (body: { action, company_id?, ...})
//   get_site            {}                                → site + pages + posts + versions + messages + locations
//                                                           (creates the draft web_sites row the first time)
//   save_site           {patch:{theme,nav,footer,seo,settings,slug}}
//   save_page           {page_id|null, patch:{slug,title,kind,layout,seo,sort_order,status,location_id}}
//   delete_page         {page_id}
//   reorder_pages       {ids[]}
//   save_post           {post_id|null, patch:{slug,title,excerpt,body_md,cover_url,author,tags,status}}
//   delete_post         {post_id}
//   publish             {note}                            → snapshot, version row, published_version_id, status live
//   unpublish           {}                                → status offline
//   restore_version     {version_id}                      → that snapshot republished as a new version
//   preview_token       {}                                → HMAC token for /preview, 30 minutes
//   upload_url          {kind, ext}                       → signed upload URL into web-assets
//   apply_ai_patch      {patch, message_id?}              → validated designer patch applied
//   geocode_locations   {}                                → Nominatim once per venue, cached on settings.geo
//
// Secrets: PLATFORM_SUPABASE_URL, PLATFORM_SUPABASE_SERVICE_ROLE_KEY (already set for
// location-admin), WEBSITE_PREVIEW_SECRET (new).

import { websiteCaller, resolveCompany, platformAdmin, PLATFORM_URL, json, cors, fetchWithTimeout } from '../_shared/websiteAuth.ts';
import {
  LIMITS, isPlainObject, isUuid, slugify, siteSlugProblem, pageSlugProblem,
  validateSitePatch, validatePagePatch, validatePostPatch, validateAiPatch, signPreviewToken, freeHostFor,
  touchesCustomCode, mayChangeCustomCode, PUBLISH_TERMS_VERSION, publishTermsAccepted, publishTermsRecord,
} from '../_shared/websiteRules.js';
import { buildSnapshot, publicLocation } from '../_shared/websiteSnapshot.js';

const BUCKET = 'web-assets';
const ASSET_KINDS = new Set(['photo', 'logo', 'og', 'favicon', 'post']);
const ASSET_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'ico', 'avif']);
const EMPTY_LAYOUT = { content: [], root: { props: {} } };
const DEFAULT_SETTINGS = { allow_custom_code: false, custom_head_html: '', nearest_store: true, default_location_id: null, order_mode: 'link' };

type Row = Record<string, unknown>;

const bad = (msg: string, extra: Row = {}) => json({ error: msg, ...extra }, 400);
const failed = (where: string, e: unknown) => {
  const msg = String((e as { message?: string })?.message || e || 'unknown');
  console.error(`[website-admin] ${where}:`, msg);
  return json({ error: `Could not ${where}. ${msg}` }, 500);
};

// ── Site row ─────────────────────────────────────────────────────────────────────────────

async function loadSite(companyId: string): Promise<Row | null> {
  const { data, error } = await platformAdmin.from('web_sites').select('*').eq('company_id', companyId).maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

/** The draft web_sites row, made on first visit. Slug from the company slug or its name. */
async function ensureSite(companyId: string): Promise<Row> {
  const existing = await loadSite(companyId);
  if (existing) return existing;
  const { data: company } = await platformAdmin.from('companies').select('id, name, slug').eq('id', companyId).maybeSingle();
  if (!company) throw new Error('company not found on the platform');
  const c = company as { name?: string; slug?: string };
  let base = slugify(c.slug || c.name || 'site');
  if (base.length < 3) base = `${base}-site`.replace(/^-/, '');
  if (siteSlugProblem(base)) base = `${base}-site`;
  if (siteSlugProblem(base)) base = `site-${companyId.slice(0, 8)}`;
  for (let i = 0; i < 6; i++) {
    const slug = i === 0 ? base : `${base.slice(0, 36)}-${i + 1}`;
    const { data, error } = await platformAdmin.from('web_sites')
      .insert({ company_id: companyId, slug, settings: DEFAULT_SETTINGS })
      .select('*').maybeSingle();
    if (!error && data) return data as Row;
    // 23505 = unique violation: another company holds that slug (or two tabs raced the first create).
    if ((error as { code?: string })?.code !== '23505') throw error;
    const again = await loadSite(companyId);
    if (again) return again;
  }
  throw new Error('could not find a free site address');
}

async function sitePages(siteId: string, onlyPublished = false): Promise<Row[]> {
  let q = platformAdmin.from('web_pages').select('*').eq('site_id', siteId).order('sort_order', { ascending: true }).order('slug', { ascending: true });
  if (onlyPublished) q = q.eq('status', 'published');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

async function sitePosts(siteId: string, onlyPublished = false): Promise<Row[]> {
  let q = platformAdmin.from('web_posts').select('*').eq('site_id', siteId).order('published_at', { ascending: false, nullsFirst: false }).order('updated_at', { ascending: false });
  if (onlyPublished) q = q.eq('status', 'published');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

/** Every Platform location of the company. select * so a missing column never breaks a publish. */
async function companyLocations(companyId: string): Promise<Row[]> {
  const { data, error } = await platformAdmin.from('locations').select('*').eq('company_id', companyId).order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Row[];
}

async function updateSite(siteId: string, patch: Row): Promise<Row> {
  const { data, error } = await platformAdmin.from('web_sites').update(patch).eq('id', siteId).select('*').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('site update matched 0 rows');
  return data as Row;
}

const mergeObj = (a: unknown, b: unknown): Row => ({ ...(isPlainObject(a) ? a as Row : {}), ...(isPlainObject(b) ? b as Row : {}) });

/** The platform locations.id for an Ops venue id, only when that venue belongs to this company. */
async function ownPlatformLocation(companyId: string, opsLocationId: unknown): Promise<string | null> {
  const ops = typeof opsLocationId === 'string' ? opsLocationId.trim() : '';
  if (!ops) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ops);
    if (!isUuid && !/^[A-Za-z0-9_-]+$/.test(ops)) return null; // never a filter built from odd input
    let q = platformAdmin.from('locations').select('id, ops_location_id').eq('company_id', companyId);
    q = isUuid ? q.or(`ops_location_id.eq.${ops},id.eq.${ops}`) : q.eq('ops_location_id', ops);
    const { data } = await q.limit(2);
    const rows = (data ?? []) as Array<{ id: string; ops_location_id: string | null }>;
    const hit = rows.find((r) => r.ops_location_id === ops) || rows.find((r) => r.id === ops) || null;
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

// ── Publish ──────────────────────────────────────────────────────────────────────────────

async function publishSnapshot(site: Row, snapshot: Row, note: string, userId: string | null) {
  const { data: ver, error } = await platformAdmin.from('web_site_versions')
    .insert({ site_id: site.id, snapshot, note: note || null, created_by: userId })
    .select('id, created_at').maybeSingle();
  if (error) throw error;
  if (!ver) throw new Error('version row not returned');
  const v = ver as { id: string; created_at: string };
  const updated = await updateSite(site.id as string, { published_version_id: v.id, published_at: v.created_at, status: 'live' });
  return { version_id: v.id, published_at: v.created_at, site: updated };
}

async function publishNow(site: Row, note: string, userId: string | null) {
  const [pages, posts, locations] = await Promise.all([sitePages(site.id as string, true), sitePosts(site.id as string, true), companyLocations(site.company_id as string)]);
  if (!pages.length) return { refusal: bad('Build or add a published page before you publish the site.') };
  // The slug and domain in the snapshot are the row's live values, so a slug change publishes
  // only when the owner presses Publish (what the public reads is always one whole version).
  const snapshot = buildSnapshot({ site, pages, posts, locations });
  return { result: await publishSnapshot(site, snapshot as Row, note, userId) };
}

// ── Geocoding (contract section 8) ───────────────────────────────────────────────────────

async function geocodeOnce(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'ServOS website builder (serv-os.app)', Accept: 'application/json' } }, 8000);
  if (!res || !res.ok) return null;
  try {
    const list = await res.json();
    const hit = Array.isArray(list) ? list[0] : null;
    const lat = Number(hit?.lat); const lng = Number(hit?.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch { return null; }
}

// ── Handler ──────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const who = await websiteCaller(req);
  if ('refusal' in who) return who.refusal;
  const caller = who.caller;

  let body: Row;
  try { body = await req.json(); } catch { return bad('The request was not valid JSON.'); }
  if (!isPlainObject(body)) return bad('The request body must be an object.');
  const action = String(body.action ?? '').trim();
  if (!action) return bad('action is needed.');

  const picked = await resolveCompany(caller, body);
  if ('refusal' in picked) return picked.refusal;
  const companyId = picked.companyId;

  let site: Row;
  try { site = await ensureSite(companyId); } catch (e) { return failed('open the site', e); }
  const siteId = site.id as string;
  // 5.12.5: a site with no default venue takes the one the Back Office is open on (body.location_id,
  // an Ops id), so the public site speaks for that venue and not the first by name. Owners change
  // it later under Branding and domain. Best effort: a failure here never blocks the action.
  if (!(isPlainObject(site.settings) && (site.settings as Row).default_location_id)) {
    const own = await ownPlatformLocation(companyId, body.location_id);
    if (own) {
      try { site = await updateSite(siteId, { settings: mergeObj(site.settings, { default_location_id: own }) }); }
      catch (e) { console.warn('[website-admin] default venue not set:', String((e as Error)?.message || e)); }
    }
  }
  const settings = isPlainObject(site.settings) ? site.settings as Row : {};
  const allowCustomCode = settings.allow_custom_code === true;

  try {
    // ── get_site ───────────────────────────────────────────────────────────────────────
    if (action === 'get_site') {
      const [pages, posts, locations, versionsRes, messagesRes, companyRes] = await Promise.all([
        sitePages(siteId), sitePosts(siteId), companyLocations(companyId),
        platformAdmin.from('web_site_versions').select('id, note, created_by, created_at').eq('site_id', siteId).order('created_at', { ascending: false }).limit(30),
        platformAdmin.from('web_ai_messages').select('id, role, content, patch, created_at').eq('site_id', siteId).order('created_at', { ascending: false }).limit(50),
        platformAdmin.from('companies').select('id, name, slug').eq('id', companyId).maybeSingle(),
      ]);
      const geo = isPlainObject(settings.geo) ? settings.geo as Row : {};
      return json({
        ok: true,
        site, pages, posts,
        versions: versionsRes.data ?? [],
        messages: ((messagesRes.data ?? []) as Row[]).reverse(),
        locations: locations.map((l) => publicLocation(l, geo)),
        company: companyRes.data ?? { id: companyId },
        free_host: freeHostFor(site.slug as string),
        companies: caller.companyIds,
      });
    }

    // ── save_site ──────────────────────────────────────────────────────────────────────
    if (action === 'save_site') {
      const v = validateSitePatch(body.patch);
      if (!v.ok) return bad(v.errors[0], { errors: v.errors });
      const clean = v.clean as Row;
      if (!Object.keys(clean).length) return bad('Nothing to save.');
      const row: Row = {};
      // Settings and seo MERGE so two screens (Branding, Search and sharing) never wipe each other.
      if ('theme' in clean) row.theme = mergeObj(site.theme, clean.theme);
      if ('nav' in clean) row.nav = clean.nav;
      if ('footer' in clean) row.footer = mergeObj(site.footer, clean.footer);
      if ('seo' in clean) row.seo = mergeObj(site.seo, clean.seo);
      if ('settings' in clean) {
        // Custom code is an OWNER only switch (never the designer, never a manager's login): the head
        // HTML runs on every visitor's page, so only the business owner may turn it on or change it.
        if (touchesCustomCode(clean.settings) && !mayChangeCustomCode(caller)) return json({ error: 'Only the owner can change custom code.' }, 403);
        // The publishing terms record is written by the publish action only (5.12.1). The screens
        // send their whole settings copy back, so the key is dropped here, never trusted.
        delete (clean.settings as Row).publish_terms;
        row.settings = mergeObj(site.settings, clean.settings);
      }
      if ('slug' in clean) row.slug = clean.slug;
      let updated: Row;
      try { updated = await updateSite(siteId, row); } catch (e) {
        if ((e as { code?: string })?.code === '23505') return json({ error: 'That site address is taken. Pick another.', code: 'slug_taken' }, 409);
        throw e;
      }
      return json({ ok: true, site: updated, free_host: freeHostFor(updated.slug as string) });
    }

    // ── save_page ──────────────────────────────────────────────────────────────────────
    if (action === 'save_page') {
      const pageId = body.page_id == null || body.page_id === '' ? null : String(body.page_id);
      if (pageId && !isUuid(pageId)) return bad('page_id must be a page id.');
      let existing: Row | null = null;
      if (pageId) {
        const { data } = await platformAdmin.from('web_pages').select('*').eq('id', pageId).eq('site_id', siteId).maybeSingle();
        if (!data) return json({ error: 'That page is not on this site.' }, 404);
        existing = data as Row;
      }
      const v = validatePagePatch(body.patch, { allowCustomCode, existingKind: (existing?.kind as string) ?? 'custom', isNew: !existing });
      if (!v.ok) return bad(v.errors[0], { errors: v.errors });
      const clean = v.clean as Row;
      if (!Object.keys(clean).length) return bad('Nothing to save.');
      if (existing && existing.slug === '' && 'slug' in clean && clean.slug !== '') return bad('The home page keeps the empty address. Add another page instead.');
      let saved: Row | null = null;
      try {
        if (existing) {
          const { data, error } = await platformAdmin.from('web_pages').update(clean).eq('id', pageId!).eq('site_id', siteId).select('*').maybeSingle();
          if (error) throw error;
          saved = data as Row | null;
        } else {
          const { count } = await platformAdmin.from('web_pages').select('id', { count: 'exact', head: true }).eq('site_id', siteId);
          if ((count ?? 0) >= LIMITS.MAX_PAGES) return bad(`A site can hold at most ${LIMITS.MAX_PAGES} pages.`);
          const row: Row = { site_id: siteId, layout: EMPTY_LAYOUT, kind: 'custom', ...clean };
          if (row.sort_order === undefined) row.sort_order = (count ?? 0) + 1;
          const { data, error } = await platformAdmin.from('web_pages').insert(row).select('*').maybeSingle();
          if (error) throw error;
          saved = data as Row | null;
        }
      } catch (e) {
        if ((e as { code?: string })?.code === '23505') return json({ error: 'That address is already used by another page on this site.', code: 'slug_taken' }, 409);
        throw e;
      }
      if (!saved) return failed('save the page', new Error('no row returned'));
      return json({ ok: true, page: saved });
    }

    // ── delete_page ────────────────────────────────────────────────────────────────────
    if (action === 'delete_page') {
      const pageId = String(body.page_id ?? '');
      if (!isUuid(pageId)) return bad('page_id must be a page id.');
      const { data: page } = await platformAdmin.from('web_pages').select('id, slug').eq('id', pageId).eq('site_id', siteId).maybeSingle();
      if (!page) return json({ error: 'That page is not on this site.' }, 404);
      if ((page as Row).slug === '') return bad('The home page cannot be deleted.');
      const { error } = await platformAdmin.from('web_pages').delete().eq('id', pageId).eq('site_id', siteId);
      if (error) throw error;
      return json({ ok: true, deleted: pageId });
    }

    // ── reorder_pages ──────────────────────────────────────────────────────────────────
    if (action === 'reorder_pages') {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
      if (!ids || !ids.length || !ids.every(isUuid)) return bad('ids must be a list of page ids.');
      if (new Set(ids).size !== ids.length) return bad('ids has a repeat.');
      const pages = await sitePages(siteId);
      const own = new Set(pages.map((p) => p.id as string));
      if (!ids.every((id) => own.has(id))) return bad('Every id must be a page on this site.');
      for (let i = 0; i < ids.length; i++) {
        const { error } = await platformAdmin.from('web_pages').update({ sort_order: i }).eq('id', ids[i]).eq('site_id', siteId);
        if (error) throw error;
      }
      return json({ ok: true, pages: await sitePages(siteId) });
    }

    // ── save_post ──────────────────────────────────────────────────────────────────────
    if (action === 'save_post') {
      const postId = body.post_id == null || body.post_id === '' ? null : String(body.post_id);
      if (postId && !isUuid(postId)) return bad('post_id must be a post id.');
      let existing: Row | null = null;
      if (postId) {
        const { data } = await platformAdmin.from('web_posts').select('*').eq('id', postId).eq('site_id', siteId).maybeSingle();
        if (!data) return json({ error: 'That post is not on this site.' }, 404);
        existing = data as Row;
      }
      const v = validatePostPatch(body.patch, { isNew: !existing });
      if (!v.ok) return bad(v.errors[0], { errors: v.errors });
      const clean = v.clean as Row;
      if (!Object.keys(clean).length) return bad('Nothing to save.');
      // published_at is set the first time a post goes live and cleared when it is pulled back.
      if (clean.status === 'published' && !(existing?.published_at)) clean.published_at = new Date().toISOString();
      if (clean.status === 'draft') clean.published_at = null;
      let saved: Row | null = null;
      try {
        if (existing) {
          const { data, error } = await platformAdmin.from('web_posts').update(clean).eq('id', postId!).eq('site_id', siteId).select('*').maybeSingle();
          if (error) throw error;
          saved = data as Row | null;
        } else {
          const { count } = await platformAdmin.from('web_posts').select('id', { count: 'exact', head: true }).eq('site_id', siteId);
          if ((count ?? 0) >= LIMITS.MAX_POSTS) return bad(`A site can hold at most ${LIMITS.MAX_POSTS} posts.`);
          const { data, error } = await platformAdmin.from('web_posts').insert({ site_id: siteId, body_md: '', status: 'draft', ...clean }).select('*').maybeSingle();
          if (error) throw error;
          saved = data as Row | null;
        }
      } catch (e) {
        if ((e as { code?: string })?.code === '23505') return json({ error: 'That address is already used by another post.', code: 'slug_taken' }, 409);
        throw e;
      }
      if (!saved) return failed('save the post', new Error('no row returned'));
      return json({ ok: true, post: saved });
    }

    // ── delete_post ────────────────────────────────────────────────────────────────────
    if (action === 'delete_post') {
      const postId = String(body.post_id ?? '');
      if (!isUuid(postId)) return bad('post_id must be a post id.');
      const { error, count } = await platformAdmin.from('web_posts').delete({ count: 'exact' }).eq('id', postId).eq('site_id', siteId);
      if (error) throw error;
      if (!count) return json({ error: 'That post is not on this site.' }, 404);
      return json({ ok: true, deleted: postId });
    }

    // ── publish / unpublish ────────────────────────────────────────────────────────────
    if (action === 'publish') {
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      // 5.12.1: the publishing terms gate. The first publish (and the first after the terms
      // change) must carry accept_terms = the current version; acceptance is recorded on the site.
      if (!publishTermsAccepted(settings)) {
        if (body.accept_terms !== PUBLISH_TERMS_VERSION) {
          return json({ error: 'Read and accept the publishing terms before you publish.', terms_required: PUBLISH_TERMS_VERSION }, 428);
        }
        const nextSettings = { ...settings, publish_terms: publishTermsRecord({ userId: caller.userId, role: caller.role }) };
        try { site = await updateSite(siteId, { settings: nextSettings }); } catch (e) { return failed('record the publishing terms', e); }
      }
      const r = await publishNow(site, note, caller.userId);
      if ('refusal' in r) return r.refusal;
      return json({ ok: true, ...r.result, free_host: freeHostFor(site.slug as string) });
    }
    if (action === 'unpublish') {
      const updated = await updateSite(siteId, { status: 'offline' });
      return json({ ok: true, site: updated });
    }

    // ── restore_version ────────────────────────────────────────────────────────────────
    if (action === 'restore_version') {
      const versionId = String(body.version_id ?? '');
      if (!isUuid(versionId)) return bad('version_id must be a version id.');
      const { data: ver } = await platformAdmin.from('web_site_versions').select('id, snapshot, created_at').eq('id', versionId).eq('site_id', siteId).maybeSingle();
      if (!ver) return json({ error: 'That version is not on this site.' }, 404);
      const v = ver as { snapshot: Row; created_at: string };
      const when = new Date(v.created_at).toISOString().slice(0, 16).replace('T', ' ');
      const result = await publishSnapshot(site, v.snapshot, `Restored the version from ${when}`, caller.userId);
      return json({ ok: true, ...result, restored_from: versionId });
    }

    // ── preview_token ──────────────────────────────────────────────────────────────────
    if (action === 'preview_token') {
      const secret = Deno.env.get('WEBSITE_PREVIEW_SECRET') ?? '';
      if (!secret) return json({ error: 'Preview is not set up yet. Add the WEBSITE_PREVIEW_SECRET secret to Supabase.' }, 500);
      const t = await signPreviewToken(siteId, secret);
      return json({ ok: true, ...t, path: `/preview?token=${encodeURIComponent(t.token)}` });
    }

    // ── upload_url ─────────────────────────────────────────────────────────────────────
    if (action === 'upload_url') {
      const kind = String(body.kind ?? 'photo');
      const ext = String(body.ext ?? '').toLowerCase().replace(/^\./, '');
      if (!ASSET_KINDS.has(kind)) return bad(`kind must be one of: ${[...ASSET_KINDS].join(', ')}.`);
      if (!ASSET_EXT.has(ext)) return bad(`Images can be: ${[...ASSET_EXT].join(', ')}.`);
      const path = `${siteId}/${crypto.randomUUID()}.${ext}`;
      const { data, error } = await platformAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return failed('make an upload link', error ?? new Error('no data'));
      const alt = typeof body.alt === 'string' ? body.alt.slice(0, 300) : null;
      const { data: asset, error: aErr } = await platformAdmin.from('web_assets').insert({ site_id: siteId, path, kind, alt }).select('id').maybeSingle();
      if (aErr) console.warn('[website-admin] web_assets row:', aErr.message);
      return json({
        ok: true,
        signed_url: data.signedUrl, token: data.token, path,
        public_url: `${PLATFORM_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`,
        asset_id: (asset as { id?: string } | null)?.id ?? null,
      });
    }

    // ── apply_ai_patch ─────────────────────────────────────────────────────────────────
    if (action === 'apply_ai_patch') {
      const [pagesNow, postsNow] = await Promise.all([sitePages(siteId), sitePosts(siteId)]);
      const v = validateAiPatch(body.patch, { allowCustomCode, existingPageCount: 0, existingPostCount: 0 });
      if (!v.ok) return bad(v.errors[0], { errors: v.errors });
      const patch = v.clean as Row;
      const siteRow: Row = {};
      if ('theme' in patch) siteRow.theme = mergeObj(site.theme, patch.theme);
      if ('nav' in patch) siteRow.nav = patch.nav;
      if ('footer' in patch) siteRow.footer = mergeObj(site.footer, patch.footer);
      if ('seo' in patch) siteRow.seo = mergeObj(site.seo, patch.seo);
      const bySlug = new Map(pagesNow.map((p) => [p.slug as string, p]));
      const pagesChanged: string[] = [];
      const newPages = Array.isArray(patch.pages) ? patch.pages as Row[] : [];
      const adding = newPages.filter((p) => !bySlug.has(p.slug as string)).length;
      if (pagesNow.length + adding > LIMITS.MAX_PAGES) return bad(`A site can hold at most ${LIMITS.MAX_PAGES} pages.`);
      let nextSort = pagesNow.reduce((m, p) => Math.max(m, Number(p.sort_order) || 0), 0) + 1;
      for (const p of newPages) {
        const slug = p.slug as string;
        const cur = bySlug.get(slug);
        const row: Row = {
          title: p.title, kind: p.kind ?? (cur?.kind ?? 'custom'), layout: p.layout ?? EMPTY_LAYOUT,
          seo: p.seo !== undefined ? p.seo : (cur?.seo ?? {}),
          status: p.status ?? (cur?.status ?? 'published'),
          location_id: p.location_id !== undefined ? p.location_id : (cur?.location_id ?? null),
        };
        if (p.sort_order !== undefined) row.sort_order = p.sort_order;
        if (cur) {
          const { error } = await platformAdmin.from('web_pages').update(row).eq('id', cur.id as string).eq('site_id', siteId);
          if (error) throw error;
        } else {
          if (row.sort_order === undefined) row.sort_order = nextSort++;
          const { error } = await platformAdmin.from('web_pages').insert({ site_id: siteId, slug, ...row });
          if (error) throw error;
        }
        pagesChanged.push(slug);
      }
      const dels = Array.isArray(patch.delete_pages) ? (patch.delete_pages as string[]).filter((s) => s !== '' && !pageSlugProblem(s)) : [];
      if (dels.length) {
        const { error } = await platformAdmin.from('web_pages').delete().eq('site_id', siteId).in('slug', dels);
        if (error) throw error;
        pagesChanged.push(...dels.map((s) => `-${s}`));
      }
      const postsChanged: string[] = [];
      const newPosts = Array.isArray(patch.posts) ? patch.posts as Row[] : [];
      const postBySlug = new Map(postsNow.map((p) => [p.slug as string, p]));
      if (postsNow.length + newPosts.filter((p) => !postBySlug.has(p.slug as string)).length > LIMITS.MAX_POSTS) return bad(`A site can hold at most ${LIMITS.MAX_POSTS} posts.`);
      for (const p of newPosts) {
        const slug = p.slug as string;
        const cur = postBySlug.get(slug);
        // The designer's posts are drafts unless it says otherwise: the owner reads before the world does.
        const status = (p.status as string) ?? (cur?.status as string) ?? 'draft';
        const row: Row = { title: p.title, excerpt: p.excerpt ?? null, body_md: p.body_md ?? '', tags: p.tags ?? [], status };
        if (p.cover_url !== undefined) row.cover_url = p.cover_url;
        if (p.author !== undefined) row.author = p.author;
        if (status === 'published' && !cur?.published_at) row.published_at = new Date().toISOString();
        if (status === 'draft') row.published_at = null;
        if (cur) {
          const { error } = await platformAdmin.from('web_posts').update(row).eq('id', cur.id as string).eq('site_id', siteId);
          if (error) throw error;
        } else {
          const { error } = await platformAdmin.from('web_posts').insert({ site_id: siteId, slug, ...row });
          if (error) throw error;
        }
        postsChanged.push(slug);
      }
      let updatedSite = site;
      if (Object.keys(siteRow).length) updatedSite = await updateSite(siteId, siteRow);
      const messageId = typeof body.message_id === 'string' && isUuid(body.message_id) ? body.message_id : null;
      if (messageId) {
        const { error } = await platformAdmin.from('web_ai_messages').update({ patch }).eq('id', messageId).eq('site_id', siteId);
        if (error) console.warn('[website-admin] message patch:', error.message);
      }
      return json({ ok: true, applied: true, pages_changed: pagesChanged, posts_changed: postsChanged, site: updatedSite, pages: await sitePages(siteId) });
    }

    // ── geocode_locations ──────────────────────────────────────────────────────────────
    if (action === 'geocode_locations') {
      const locations = await companyLocations(companyId);
      const geo = isPlainObject(settings.geo) ? { ...(settings.geo as Row) } : {};
      const done: string[] = [];
      const missing: string[] = [];
      let looked = 0;
      for (const loc of locations) {
        const id = loc.id as string;
        const hasCols = Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude)) && loc.latitude !== null;
        if (hasCols || isPlainObject(geo[id])) continue;
        const address = typeof loc.address === 'string' ? loc.address.trim() : '';
        if (!address) { missing.push(id); continue; }
        // Nominatim asks for one request a second; 20 venues a press keeps the call well inside the timeout.
        if (looked >= 20) break;
        looked++;
        const hit = await geocodeOnce(address);
        if (hit) { geo[id] = { lat: hit.lat, lng: hit.lng, at: new Date().toISOString(), source: 'nominatim' }; done.push(id); }
        else missing.push(id);
        await new Promise((r) => setTimeout(r, 1100));
      }
      const updated = done.length ? await updateSite(siteId, { settings: { ...settings, geo } }) : site;
      return json({ ok: true, geocoded: done, missing, site: updated });
    }

    return bad(`Unknown action "${action}".`);
  } catch (e) {
    return failed(action.replace(/_/g, ' '), e);
  }
});
