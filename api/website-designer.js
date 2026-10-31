/**
 * api/website-designer.js: the AI website designer (Website builder, ARCHITECTURE.md section 11).
 *
 * WHO MAY ASK: a signed in person (api/_userAuth.js requireUser, the same check as api/ai.js; no
 * anonymous session, no device). Then the company fence: the Platform RPC
 * web_company_for_user(uid, ops_location_ids) (or, until that function exists, the Platform
 * locations rows for those Ops ids plus the caller's own Platform access rows) must include the
 * company that owns the site named in the body. Otherwise 403 and nothing is read or spent. The Ops
 * location ids come from requireUser (`reached`): the login lives on the Ops project, so a Platform
 * table keyed by platform_users never knows it; mapping locations.ops_location_id (legacy: id) is the
 * only route that answers for a real owner (the same one _shared/websiteAuth.ts takes).
 *
 * WHAT IT DOES: assembles the venue facts server side (api/_lib/website/venueFacts.js), builds the
 * system prompt (designerPrompt.js), calls Claude with ONE tool, apply_site_patch, whose schema comes
 * from the block registry (schemaToTool.js), validates the patch with the shared validator
 * (src/lib/website/validatePatch.js, agent A), writes pages, posts and site fields with the Platform
 * service role, saves the message pair to web_ai_messages, and answers {reply, applied, pages_changed,
 * errors}. A refused patch is never written: the model is asked once more with the errors, then the
 * function gives up gracefully with the errors in plain English.
 *
 * GET ?facts=1&site_id=... returns the facts summary and the stored messages without calling Claude
 * (the Designer's "what I read" list and chat history).
 *
 * Env: ANTHROPIC_API_KEY, WEBSITE_DESIGNER_MODEL (optional), PLATFORM_SUPABASE_URL,
 * PLATFORM_SUPABASE_SERVICE_ROLE_KEY, and the Ops SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or the
 * public key) for menu facts. No secret is ever sent to the browser.
 */

import { requireUser } from './_userAuth.js';
import { assembleVenueFacts, factsSummaryLines, restSelect } from './_lib/website/venueFacts.js';
import { buildPatchTool, describeBlocks, schemasFromModule, FALLBACK_BLOCK_SCHEMAS, TOOL_NAME, PAGE_KINDS } from './_lib/website/schemaToTool.js';
import { buildSystemPrompt, buildUserMessage, historyTurns, pickLayout, LAYOUT_IDS } from './_lib/website/designerPrompt.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MAX_TOKENS = 16000;
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const MAX_STRING = 20 * 1024;
const MAX_LAYOUT = 400 * 1024;
const MAX_PAGES = 60;
const WRITE_TIMEOUT_MS = 8000;

export function platformEnv(env = globalThis.process?.env || {}) {
  return {
    url: String(env.PLATFORM_SUPABASE_URL || env.VITE_PLATFORM_SUPABASE_URL || '').replace(/\/$/, ''),
    key: String(env.PLATFORM_SUPABASE_SERVICE_ROLE_KEY || env.PLATFORM_SERVICE_KEY || ''),
    anon: String(env.PLATFORM_SUPABASE_ANON_KEY || env.VITE_PLATFORM_SUPABASE_ANON_KEY || ''),
  };
}

export function opsEnv(env = globalThis.process?.env || {}) {
  return {
    url: String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: String(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''),
  };
}

// ── Shared modules that other agents own: loaded at call time so a missing file degrades, not crashes.
let _schemas = null;
// Only the production path (no importer) is cached; tests pass their own importer each time.
export async function loadBlockSchemas(importer) {
  if (!importer && _schemas) return _schemas;
  let out;
  try {
    const mod = await (importer ? importer() : import('../src/surfaces/website/blocks/schema.js'));
    out = schemasFromModule(mod) || FALLBACK_BLOCK_SCHEMAS;
  } catch {
    out = FALLBACK_BLOCK_SCHEMAS;
  }
  if (!importer) _schemas = out;
  return out;
}

let _validator = null;
export async function loadValidator(importer) {
  if (!importer && _validator) return _validator;
  let out;
  try {
    const mod = await (importer ? importer() : import('../src/lib/website/validatePatch.js'));
    const fn = mod?.validatePatch || mod?.default;
    out = typeof fn === 'function' ? fn : basicValidatePatch;
  } catch {
    out = basicValidatePatch;
  }
  if (!importer) _validator = out;
  return out;
}

/** The contract's validatePatch shape, for when agent A's module is not there: {ok, errors[], patch}. */
export function basicValidatePatch(patch, { schemas = FALLBACK_BLOCK_SCHEMAS } = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object') return { ok: false, errors: ['The patch is not an object.'], patch: null };
  const out = { reply: String(patch.reply || '') };
  const tooLong = (s) => typeof s === 'string' && s.length > MAX_STRING;
  for (const k of ['theme', 'footer', 'seo']) {
    if (patch[k] != null) {
      if (typeof patch[k] !== 'object' || Array.isArray(patch[k])) errors.push(`${k} must be an object.`);
      else out[k] = patch[k];
    }
  }
  if (patch.theme?.layout && !LAYOUT_IDS.includes(patch.theme.layout)) errors.push(`theme.layout "${patch.theme.layout}" is not ember, ledger or marquee.`);
  if (patch.nav != null) {
    if (!Array.isArray(patch.nav)) errors.push('nav must be a list.');
    else out.nav = patch.nav.filter((n) => n && typeof n.label === 'string' && (typeof n.href === 'string' || typeof n.page_id === 'string'));
  }
  if (patch.pages != null) {
    if (!Array.isArray(patch.pages)) errors.push('pages must be a list.');
    else {
      if (patch.pages.length > MAX_PAGES) errors.push(`Too many pages (${patch.pages.length}, the limit is ${MAX_PAGES}).`);
      out.pages = [];
      patch.pages.forEach((p, i) => {
        const where = `pages[${i}]${p?.slug != null ? ` "${p.slug}"` : ''}`;
        if (!p || typeof p !== 'object') { errors.push(`${where} is not an object.`); return; }
        const slug = String(p.slug ?? '');
        if (slug !== '' && !SLUG_RE.test(slug)) errors.push(`${where}: slug must be lower case letters, numbers and hyphens.`);
        if (!p.title || typeof p.title !== 'string') errors.push(`${where}: title is missing.`);
        if (!PAGE_KINDS.includes(p.kind)) errors.push(`${where}: kind "${p.kind}" is not a page kind.`);
        const content = p.layout?.content;
        if (!Array.isArray(content)) errors.push(`${where}: layout.content must be a list of blocks.`);
        else {
          content.forEach((b, j) => {
            if (!b || typeof b !== 'object' || !schemas[b.type]) errors.push(`${where}: block ${j + 1} type "${b?.type}" does not exist.`);
            if (b && b.props != null && typeof b.props !== 'object') errors.push(`${where}: block ${j + 1} props must be an object.`);
            for (const v of Object.values(b?.props || {})) if (tooLong(v)) errors.push(`${where}: block ${j + 1} has a text over 20 KB.`);
          });
          const heroes = content.filter((b) => b?.type === 'Hero').length;
          if (heroes > 1) errors.push(`${where}: ${heroes} Hero blocks, only one is allowed.`);
        }
        if (JSON.stringify(p.layout || {}).length > MAX_LAYOUT) errors.push(`${where}: layout is over 400 KB.`);
        if (p.location_id != null && !UUID_RE.test(String(p.location_id))) errors.push(`${where}: location_id is not an id.`);
        out.pages.push({
          slug, title: String(p.title || ''), kind: p.kind, seo: p.seo && typeof p.seo === 'object' ? p.seo : {},
          layout: { root: p.layout?.root && typeof p.layout.root === 'object' ? p.layout.root : { props: {} }, content: Array.isArray(content) ? content.map((b) => ({ type: b?.type, props: { ...(b?.props || {}) } })) : [] },
          status: p.status === 'draft' ? 'draft' : 'published',
          ...(p.location_id ? { location_id: String(p.location_id) } : {}),
        });
      });
    }
  }
  if (patch.delete_pages != null) {
    if (!Array.isArray(patch.delete_pages)) errors.push('delete_pages must be a list of slugs.');
    else out.delete_pages = patch.delete_pages.map(String).filter((s) => s === '' || SLUG_RE.test(s));
  }
  if (patch.posts != null) {
    if (!Array.isArray(patch.posts)) errors.push('posts must be a list.');
    else {
      out.posts = [];
      patch.posts.forEach((p, i) => {
        const where = `posts[${i}]${p?.slug ? ` "${p.slug}"` : ''}`;
        if (!p || typeof p !== 'object') { errors.push(`${where} is not an object.`); return; }
        if (!SLUG_RE.test(String(p.slug || ''))) errors.push(`${where}: slug must be lower case letters, numbers and hyphens.`);
        if (!p.title) errors.push(`${where}: title is missing.`);
        if (typeof p.body_md !== 'string' || !p.body_md.trim()) errors.push(`${where}: body is empty.`);
        if (tooLong(p.body_md)) errors.push(`${where}: body is over 20 KB.`);
        out.posts.push({ slug: String(p.slug || ''), title: String(p.title || ''), excerpt: p.excerpt ? String(p.excerpt) : null, body_md: String(p.body_md || ''), tags: Array.isArray(p.tags) ? p.tags.map(String) : [], status: p.status === 'published' ? 'published' : 'draft' });
      });
    }
  }
  return { ok: errors.length === 0, errors, patch: errors.length ? null : out };
}

// ── Platform REST helpers (service role) ───────────────────────────────────────────────────────────
async function restWrite(platform, method, path, body, { fetchImpl, prefer } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f || !platform?.url || !platform?.key) return { ok: false, status: 500, body: null };
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), WRITE_TIMEOUT_MS) : null;
  try {
    const res = await f(`${platform.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: platform.key, authorization: `Bearer ${platform.key}`,
        'content-type': 'application/json', accept: 'application/json',
        prefer: prefer || 'return=representation',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    let out = null;
    try { out = await res.json(); } catch { out = null; }
    return { ok: res.ok, status: res.status, body: out };
  } catch (e) {
    return { ok: false, status: 503, body: { message: e?.message || 'network' } };
  } finally {
    if (t) clearTimeout(t);
  }
}

const inList = (ids) => ids.map((x) => `"${String(x).replace(/"/g, '')}"`).join(',');

/**
 * The companies this user may design for. RPC first (with the Ops location ids the login reaches),
 * then the fallback: Platform locations matched on ops_location_id or legacy id, plus the caller's
 * own Platform access rows (they answer only for a Platform login, harmless otherwise).
 */
export async function companiesForUser({ platform, uid, opsLocationIds = [], fetchImpl }) {
  const ids = new Set();
  const ops = [...new Set((Array.isArray(opsLocationIds) ? opsLocationIds : []).map(String).filter((x) => UUID_RE.test(x)))];
  // web_company_for_user(p_user uuid, p_ops_location_ids uuid[] default null) returns setof uuid.
  const rpc = await restWrite(platform, 'POST', 'rpc/web_company_for_user', { p_user: uid, p_ops_location_ids: ops.length ? ops : null }, { fetchImpl, prefer: 'return=representation' });
  if (rpc.ok && Array.isArray(rpc.body)) {
    for (const r of rpc.body) {
      const v = r && typeof r === 'object' ? (r.company_id ?? Object.values(r)[0]) : r;
      if (v) ids.add(String(v));
    }
    if (ids.size) return [...ids];
  } else if (rpc.ok && typeof rpc.body === 'string') {
    return [rpc.body];
  }
  // The function is not there yet (or returned nothing): the Ops venues mapped to Platform
  // locations (ops_location_id first, legacy same id second), then the caller's own access rows.
  const [viaOps, access, roles] = await Promise.all([
    ops.length ? restSelect(platform, `locations?or=(ops_location_id.in.(${inList(ops)}),id.in.(${inList(ops)}))&select=company_id&limit=500`, { fetchImpl }) : Promise.resolve([]),
    restSelect(platform, `user_location_access?user_id=eq.${uid}&select=locations(company_id)&limit=200`, { fetchImpl }),
    restSelect(platform, `user_company_roles?user_id=eq.${uid}&select=company_id&limit=50`, { fetchImpl }),
  ]);
  for (const r of viaOps) if (r?.company_id) ids.add(String(r.company_id));
  for (const r of access) if (r?.locations?.company_id) ids.add(String(r.locations.company_id));
  for (const r of roles) if (r?.company_id) ids.add(String(r.company_id));
  return [...ids];
}

/** The site row, or null. */
export async function loadSite({ platform, siteId, fetchImpl }) {
  if (!UUID_RE.test(String(siteId || ''))) return null;
  const rows = await restSelect(platform, `web_sites?id=eq.${siteId}&select=id,company_id,slug,status,theme,nav,footer,seo,settings`, { fetchImpl });
  return rows[0] || null;
}

// ── Claude ─────────────────────────────────────────────────────────────────────────────────────────
export async function callClaude({ apiKey, model, system, messages, tool, fetchImpl, maxTokens = MAX_TOKENS }) {
  const f = fetchImpl || fetch;
  const res = await f(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system, messages,
      tools: [tool],
      // 5.12.2: Claude Opus 5.5 (and Sonnet 5.5, Fable 5.1) refuse a forced tool choice with 400
      // "tool_choice: type "tool" and "any" are not supported for this model". auto + the system
      // prompt's "always answer through apply_site_patch" does the same job; a text only answer
      // is still handled below (it becomes the reply, nothing changes).
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) return { ok: false, status: res.status, error: body?.error?.message || 'The designer could not be reached.' };
  const content = Array.isArray(body?.content) ? body.content : [];
  const toolUse = content.find((c) => c?.type === 'tool_use' && c.name === TOOL_NAME);
  const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
  return { ok: true, patch: toolUse?.input || null, text, raw: body };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}

/**
 * Puck keys every block by props.id and the validator requires it. The model may leave ids out or
 * repeat them, so missing or duplicate ids are filled in here before validation (never a refusal
 * for something the server can fix).
 */
export function ensureBlockIds(patch) {
  if (!patch?.pages || !Array.isArray(patch.pages)) return patch;
  const pages = patch.pages.map((p) => {
    const content = p?.layout?.content;
    if (!Array.isArray(content)) return p;
    const seen = new Set();
    const fixed = content.map((b, i) => {
      if (!b || typeof b !== 'object') return b;
      const props = b.props && typeof b.props === 'object' ? { ...b.props } : {};
      let id = typeof props.id === 'string' && props.id.trim() ? props.id.trim() : '';
      if (!id || seen.has(id)) id = `${String(b.type || 'block').toLowerCase()}-${i + 1}`;
      while (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      return { ...b, props: { ...props, id } };
    });
    return { ...p, layout: { ...p.layout, root: p.layout.root && typeof p.layout.root === 'object' ? p.layout.root : { props: {} }, content: fixed } };
  });
  return { ...patch, pages };
}

/** Location pages get their location_id from the facts (the model's id when it matches, else the slug). */
export function attachLocationIds(patch, facts) {
  const locs = facts?.locations || [];
  if (!patch?.pages) return patch;
  const pages = patch.pages.map((p) => {
    if (p.kind !== 'location') return p;
    const byId = locs.find((l) => l.id === p.location_id);
    const bySlug = locs.find((l) => l.online_slug && l.online_slug === p.slug);
    const loc = byId || bySlug || null;
    return loc ? { ...p, location_id: loc.id } : { ...p, location_id: null };
  });
  return { ...patch, pages };
}

/** Write a validated patch with the Platform service role. Returns { pages_changed, errors }. */
export async function applyPatch({ platform, site, patch, fetchImpl, now = new Date() }) {
  const errors = [];
  const pagesChanged = [];
  const ts = now.toISOString();

  // Pages first: nav items may name a page by slug, and the ids only exist once the rows do.
  const existing = await restSelect(platform, `web_pages?site_id=eq.${site.id}&select=id,slug,sort_order`, { fetchImpl });
  const idBySlug = new Map(existing.map((p) => [p.slug, p.id]));
  if (Array.isArray(patch.pages) && patch.pages.length) {
    const order = new Map(existing.map((p) => [p.slug, p.sort_order ?? 0]));
    let next = existing.reduce((m, p) => Math.max(m, p.sort_order ?? 0), -1) + 1;
    const rows = patch.pages.map((p) => ({
      site_id: site.id, slug: p.slug, title: p.title, kind: p.kind,
      layout: p.layout, seo: p.seo || {}, status: p.status || 'published',
      location_id: p.kind === 'location' ? (p.location_id || null) : null,
      sort_order: order.has(p.slug) ? order.get(p.slug) : next++,
      updated_at: ts,
    }));
    const r = await restWrite(platform, 'POST', 'web_pages?on_conflict=site_id,slug', rows, { fetchImpl, prefer: 'resolution=merge-duplicates,return=representation' });
    if (r.ok) {
      pagesChanged.push(...rows.map((x) => x.slug));
      for (const row of Array.isArray(r.body) ? r.body : []) if (row?.slug != null && row.id) idBySlug.set(row.slug, row.id);
    } else errors.push(`The pages could not be saved${r.body?.message ? ` (${r.body.message})` : ''}.`);
  }

  const siteFields = {};
  if (patch.theme) siteFields.theme = deepMerge(site.theme || {}, patch.theme);
  if (patch.nav) siteFields.nav = patch.nav.map((n) => (n && n.kind === 'page' && typeof n.page_id === 'string' && idBySlug.has(n.page_id) ? { ...n, page_id: idBySlug.get(n.page_id) } : n));
  if (patch.footer) siteFields.footer = deepMerge(site.footer || {}, patch.footer);
  if (patch.seo) siteFields.seo = deepMerge(site.seo || {}, patch.seo);
  if (Object.keys(siteFields).length) {
    const r = await restWrite(platform, 'PATCH', `web_sites?id=eq.${site.id}`, { ...siteFields, updated_at: ts }, { fetchImpl, prefer: 'return=minimal' });
    if (!r.ok) errors.push('The site settings could not be saved.');
  }

  if (Array.isArray(patch.delete_pages) && patch.delete_pages.length) {
    const list = patch.delete_pages.map((s) => `"${s}"`).join(',');
    const r = await restWrite(platform, 'DELETE', `web_pages?site_id=eq.${site.id}&slug=in.(${list})`, undefined, { fetchImpl, prefer: 'return=minimal' });
    if (r.ok) pagesChanged.push(...patch.delete_pages);
    else errors.push('Some pages could not be removed.');
  }

  if (Array.isArray(patch.posts) && patch.posts.length) {
    const rows = patch.posts.map((p) => ({
      site_id: site.id, slug: p.slug, title: p.title, excerpt: p.excerpt || null, body_md: p.body_md,
      tags: p.tags || [], status: p.status || 'draft', published_at: p.status === 'published' ? ts : null, updated_at: ts,
    }));
    const r = await restWrite(platform, 'POST', 'web_posts?on_conflict=site_id,slug', rows, { fetchImpl, prefer: 'resolution=merge-duplicates,return=minimal' });
    if (!r.ok) errors.push('The blog posts could not be saved.');
  }

  return { pages_changed: pagesChanged, errors };
}

export async function saveMessages({ platform, siteId, userText, reply, patch, fetchImpl }) {
  const rows = [
    { site_id: siteId, role: 'user', content: String(userText || '').slice(0, MAX_STRING) },
    { site_id: siteId, role: 'assistant', content: String(reply || '').slice(0, MAX_STRING), patch: patch || null },
  ];
  const r = await restWrite(platform, 'POST', 'web_ai_messages', rows, { fetchImpl, prefer: 'return=minimal' });
  return r.ok;
}

/** Plain English for a refused patch. */
export function refusalReply(errors) {
  const list = (errors || []).slice(0, 8).map((e) => `- ${e}`).join('\n');
  return `I could not apply that change because the site rules refused it:\n${list}\nNothing was changed. Tell me what to adjust and I will try again.`;
}

/**
 * The whole request, pure apart from fetch (tests drive it with a fake):
 *   body: {site_id, message, mode:'build'|'chat'|'post', page_id?, layout?}
 *   user: the proven user ({id})
 *   reached: the Ops location ids the login reaches (requireUser's `reached`), for the company fence
 * Returns { status, json }.
 */
export async function runDesigner({ body, user, reached = [], env = globalThis.process?.env || {}, fetchImpl, now = new Date(), importers = {} } = {}) {
  const platform = platformEnv(env);
  const ops = opsEnv(env);
  if (!platform.url || !platform.key) return { status: 500, json: { error: 'The website designer is not configured on this server (Platform key).' } };
  const siteId = String(body?.site_id || '');
  if (!UUID_RE.test(siteId)) return { status: 400, json: { error: 'site_id required' } };
  const mode = ['build', 'chat', 'post'].includes(body?.mode) ? body.mode : 'chat';
  const layout = LAYOUT_IDS.includes(body?.layout) ? body.layout : null;
  const message = String(body?.message || '').slice(0, MAX_STRING);

  // Company fence: the site must belong to a company this user reaches.
  const [site, companies] = await Promise.all([
    loadSite({ platform, siteId, fetchImpl }),
    companiesForUser({ platform, uid: user.id, opsLocationIds: reached, fetchImpl }),
  ]);
  if (!site) return { status: 404, json: { error: 'No website with that id.' } };
  if (!companies.includes(String(site.company_id))) return { status: 403, json: { error: 'Not allowed: this login does not reach that website.' } };

  const facts = await assembleVenueFacts({ platform, ops, companyId: site.company_id, siteId, fetchImpl, now });

  if (body?.facts_only) {
    return { status: 200, json: { facts: factsSummaryLines(facts), messages: facts.recent_messages, site: facts.site } };
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { status: 500, json: { error: 'AI not configured' } };
  const model = env.WEBSITE_DESIGNER_MODEL || DEFAULT_MODEL;
  const schemas = await loadBlockSchemas(importers.schemas);
  const validate = await loadValidator(importers.validator);
  const tool = buildPatchTool(schemas);
  const chosenLayout = mode === 'build' ? (layout || pickLayout(facts.menu.photo_coverage_pct)) : layout;
  // The system prompt gets the OWNER's pick (null when none), so build mode can say why it chose.
  const system = buildSystemPrompt({ facts, mode, layout, blocksDescription: describeBlocks(schemas) });
  const page = body?.page_id ? facts.site?.pages?.find((p) => p.id === body.page_id) || null : null;
  const userText = buildUserMessage({ message, mode, layout: chosenLayout, page });
  const messages = [...historyTurns(facts.recent_messages), { role: 'user', content: userText }];

  let reply = '';
  let applied = false;
  let pagesChanged = [];
  let errors = [];
  let finalPatch = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let out;
    try {
      out = await callClaude({ apiKey, model, system, messages, tool, fetchImpl });
    } catch (e) {
      return { status: 502, json: { error: e?.message || 'The designer could not be reached.' } };
    }
    if (!out.ok) return { status: out.status || 502, json: { error: out.error } };
    const rawPatch = attachLocationIds(ensureBlockIds(out.patch || { reply: out.text || 'I had nothing to change.' }), facts);
    const patchSlugs = new Set((Array.isArray(rawPatch.pages) ? rawPatch.pages : []).map((p) => p?.slug));
    const v = validate(rawPatch, {
      schemas,
      allowCustomCode: false, // the designer never places custom code, whatever the site allows
      existingPageCount: (facts.site?.pages || []).filter((p) => !patchSlugs.has(p.slug)).length,
      existingPostCount: (facts.site?.posts || []).length,
    });
    if (v.ok) {
      finalPatch = v.clean || v.patch || rawPatch;
      reply = String(finalPatch.reply || rawPatch.reply || out.text || '').trim();
      const hasChanges = ['theme', 'nav', 'footer', 'seo', 'pages', 'delete_pages', 'posts'].some((k) => finalPatch[k] != null && (Array.isArray(finalPatch[k]) ? finalPatch[k].length : true));
      if (hasChanges) {
        const res = await applyPatch({ platform, site, patch: finalPatch, fetchImpl, now });
        pagesChanged = res.pages_changed;
        errors = res.errors;
        applied = errors.length === 0;
        if (!applied) reply = `${reply}\n\nSome of it could not be saved: ${errors.join(' ')}`.trim();
      } else {
        applied = false;
      }
      break;
    }
    errors = v.errors || ['The patch was refused.'];
    if (attempt === 0) {
      // One more go: the model sees exactly what was refused and fixes it.
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `retry_${attempt}`, name: TOOL_NAME, input: rawPatch }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `retry_${attempt}`, content: `The validator refused this patch:\n${errors.map((e) => `- ${e}`).join('\n')}\nFix every point and call ${TOOL_NAME} again.` }] });
      continue;
    }
    reply = refusalReply(errors);
    finalPatch = null;
  }

  await saveMessages({ platform, siteId, userText: message || userText, reply, patch: applied ? finalPatch : null, fetchImpl });
  return { status: 200, json: { reply, applied, pages_changed: pagesChanged, errors } };
}

export default async function handler(req, res) {
  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const who = await requireUser(req, { venueRequired: false, device: 'none', signInMessage: 'Sign in to use the website designer.' });
  if (!who.ok) return res.status(who.status).json({ error: who.error });

  const body = isGet
    ? { site_id: req.query?.site_id, facts_only: true }
    : { ...(req.body || {}), facts_only: !!(req.body?.facts_only || req.query?.facts) };
  try {
    const out = await runDesigner({ body, user: who.user, reached: who.reached || [] });
    return res.status(out.status).json(out.json);
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'The designer hit a problem.' });
  }
}
