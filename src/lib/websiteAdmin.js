// src/lib/websiteAdmin.js
//
// WEBSITE BUILDER (v5.12.0): the Back Office's door to the website tables on the Platform DB.
//
// The Platform browser client holds no login, so the browser never writes web_* tables itself.
// Every write (and the owner's read of their own site) goes through two edge functions under
// the service role: `website-admin` (site, pages, posts, publish, uploads, AI patch) and
// `website-domain` (custom domain checks). Same pattern as src/lib/locationAdmin.js.
//
// The functions work out WHICH company from the signed in user's venues (server side). A
// company_id may be passed only to choose among the companies the login already manages, which
// matters for a ServOS admin signed in across several. Every helper resolves { ok, data } or
// { ok:false, error } with the server's plain English reason; nothing here throws.

import { supabase, getLocationId } from './supabase';
import { reportSave } from './saveHealth';

// supabase-js turns a non-2xx invoke into a FunctionsHttpError whose message is a generic
// "non-2xx status code"; the real reason is in the response body. Unwrap it or every refusal
// reaches the screen as the same useless string.
async function unwrapError(error) {
  if (!error) return null;
  try {
    const body = await error.context?.json?.();
    const msg = body?.error || body?.message;
    if (msg) {
      const e = new Error(String(msg));
      if (body.code) e.code = body.code;
      if (Array.isArray(body.errors)) e.errors = body.errors;
      if (Array.isArray(body.companies)) e.companies = body.companies;
      return e;
    }
  } catch { /* body was not JSON, fall through to the transport error */ }
  return error;
}

async function call(fn, entity, body, { companyId = null } = {}) {
  if (!supabase) {
    const error = new Error('Not connected. Sign in to the back office again.');
    reportSave(entity, error);
    return { ok: false, error };
  }
  // 5.12.1: say which venue the Back Office is open on, so a login that manages several
  // companies (a group owner) lands on that venue's company instead of "Say which one".
  let locationId = null;
  try { locationId = await getLocationId(); } catch { locationId = null; }
  const payload = { ...body, ...(locationId ? { location_id: locationId } : {}), ...(companyId ? { company_id: companyId } : {}) };
  let res;
  try {
    res = await supabase.functions.invoke(fn, { body: payload });
  } catch (e) {
    reportSave(entity, e);
    return { ok: false, error: e };
  }
  // A 2xx body can still carry { error } (website-domain answers 200 with the error inside the
  // status so the screen keeps rendering): that is a failed call, not a saved one.
  const failure = (await unwrapError(res.error)) || (res.data?.error && res.data?.ok !== true ? Object.assign(new Error(String(res.data.error)), { data: res.data }) : null);
  reportSave(entity, failure);
  return failure ? { ok: false, error: failure, data: res.data ?? null } : { ok: true, data: res.data };
}

const admin = (entity, body, opts) => call('website-admin', entity, body, opts);
const domain = (entity, body, opts) => call('website-domain', entity, body, opts);

// ── website-admin ─────────────────────────────────────────────────────────────────────────

/** Site + pages + posts + versions + designer messages + public locations. Makes the draft site the first time. */
export const getSite = (opts) => admin('website', { action: 'get_site' }, opts);

/** patch: any of theme, nav, footer, seo, settings, slug. Unknown keys are refused (400), never dropped. */
export const saveSite = (patch, opts) => admin('website', { action: 'save_site', patch }, opts);

/** pageId null makes a new page. patch: slug, title, kind, layout, seo, sort_order, status, location_id. */
export const savePage = (pageId, patch, opts) => admin('website page', { action: 'save_page', page_id: pageId, patch }, opts);
export const deletePage = (pageId, opts) => admin('website page', { action: 'delete_page', page_id: pageId }, opts);
/** ids in the new order, every one a page of this site. */
export const reorderPages = (ids, opts) => admin('website pages', { action: 'reorder_pages', ids }, opts);

/** postId null makes a new post. patch: slug, title, excerpt, body_md, cover_url, author, tags, status. */
export const savePost = (postId, patch, opts) => admin('website post', { action: 'save_post', post_id: postId, patch }, opts);
export const deletePost = (postId, opts) => admin('website post', { action: 'delete_post', post_id: postId }, opts);

/** Snapshot built on the server, kept as a version, site goes live. Resolves { version_id, published_at, site }. */
/** acceptTerms: the PUBLISH_TERMS_VERSION the owner just accepted (first publish, or after the terms change). */
export const publishSite = (note = '', opts, acceptTerms = null) => admin('website publish', acceptTerms ? { action: 'publish', note, accept_terms: acceptTerms } : { action: 'publish', note }, opts);
export const unpublishSite = (opts) => admin('website publish', { action: 'unpublish' }, opts);
export const restoreVersion = (versionId, opts) => admin('website publish', { action: 'restore_version', version_id: versionId }, opts);

/** { token, expires_at, path } for /preview?token=... (30 minutes). */
export const previewToken = (opts) => admin('website preview', { action: 'preview_token' }, opts);

/**
 * { signed_url, token, path, public_url, asset_id }. Upload with
 * platformSupabase.storage.from('web-assets').uploadToSignedUrl(path, token, file), then use public_url.
 */
export const uploadUrl = (kind, ext, alt = null, opts) => admin('website upload', { action: 'upload_url', kind, ext, alt }, opts);

/** A designer patch, validated server side and applied. Resolves { applied, pages_changed, posts_changed, site, pages }. */
export const applyAiPatch = (patch, messageId = null, opts) => admin('website designer', { action: 'apply_ai_patch', patch, message_id: messageId }, opts);

/** Geocode venues with no coordinates (once each, cached on the site). */
export const geocodeLocations = (opts) => admin('website locations', { action: 'geocode_locations' }, opts);

// ── website-domain ────────────────────────────────────────────────────────────────────────

/**
 * Register and check a custom domain. customDomain undefined = re check the stored one.
 * Resolves { custom_domain, apex_domain, domain_status:{state, records[], ssl, checked_at, error?} }.
 */
export const checkDomain = (customDomain, opts) => domain('website domain', customDomain === undefined ? { action: 'check_domain' } : { action: 'check_domain', custom_domain: customDomain }, opts);
export const removeDomain = (opts) => domain('website domain', { action: 'remove_domain' }, opts);

/** Every action the two functions know, for tests and for the screens' error copy. */
export const WEBSITE_ADMIN_ACTIONS = Object.freeze([
  'get_site', 'save_site', 'save_page', 'delete_page', 'reorder_pages', 'save_post', 'delete_post',
  'publish', 'unpublish', 'restore_version', 'preview_token', 'upload_url', 'apply_ai_patch', 'geocode_locations',
]);
export const WEBSITE_DOMAIN_ACTIONS = Object.freeze(['check_domain', 'remove_domain']);
