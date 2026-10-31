/* global process */
// api/site.js: the server rendered venue website (ARCHITECTURE.md section 4, the SEO heart).
//
// vercel.json sends every path on a website host here (?path=/...). Steps:
//   1. web_resolve_host(host) with the Platform anon key; no row → a plain "no site here" 404.
//   2. Pick the page from the path (src/surfaces/website/routes.js, shared with the SPA).
//   3 to 5. HEAD, JSON-LD and BODY from src/surfaces/website/ssr/renderBlocks.js, the live menu
//      from the Ops DB through the same loader the browser uses (data/loadMenu.js).
//   6. Inject into this deployment's index.html (cached 5 minutes) with window.__SERVOS_SITE__ so
//      the SPA hydrates without a second fetch; a self contained document when the shell fails.
//   7. Cache headers: public for live sites, no-store for previews and offline sites.
//   8. Owner custom head HTML only when settings.allow_custom_code is true (renderPage does this).
// Also /sitemap.xml, /robots.txt, /preview?token= (HMAC verified, service role read), and the apex
// domain redirect to www. Customer facing: this function never throws to the client; every
// failure path answers with a readable page.

import { createClient } from '@supabase/supabase-js';
import { parseWebsiteHost, canonicalHost } from '../src/surfaces/website/hostParse.js';
import { resolveRoute } from '../src/surfaces/website/routes.js';
import { renderPage, renderDocument, renderSitemap, renderRobots, renderNoSite, buildCtx } from '../src/surfaces/website/ssr/renderBlocks.js';
import { platformEnv, opsEnv, customerRoot, previewSecret } from './_lib/website/env.js';
import { verifyPreviewToken } from './_lib/website/preview.js';
import { getShell, injectShell, bootScript } from './_lib/website/shell.js';
import { resolveSite, loadDraftSnapshot } from './_lib/website/resolveSite.js';
import { menuForPage } from './_lib/website/menuForPage.js';

const CACHE_LIVE = 'public, s-maxage=60, stale-while-revalidate=600';
const CACHE_NONE = 'no-store';

let clients = null;
function getClients() {
  if (clients) return clients;
  const plat = platformEnv(), ops = opsEnv();
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  clients = {
    platform: plat.url && plat.anon ? createClient(plat.url, plat.anon, opts) : null,
    service: plat.url && plat.service ? createClient(plat.url, plat.service, opts) : null,
    ops: ops.url && ops.anon ? createClient(ops.url, ops.anon, opts) : null,
  };
  return clients;
}

/** Host and path of the request, from the rewrite's ?path= or the URL itself. */
export function requestTarget(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  const url = new URL(req.url || '/', 'https://x.invalid');
  let path = url.searchParams.get('path') || url.pathname;
  if (path === '/api/site' || path === '/index.html') path = '/';
  const siteParam = (url.searchParams.get('site') || '').toLowerCase() || null;
  const token = url.searchParams.get('token') || null;
  return { host: rawHost, path, siteParam, token };
}

function send(res, status, type, body, cache, extra = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  for (const [k, v] of Object.entries(extra)) if (v) res.setHeader(k, v);
  res.end(body);
}

export default async function handler(req, res) {
  const { host, path, siteParam, token } = requestTarget(req);
  const root = customerRoot();
  const parsed = parseWebsiteHost(host, root);
  const { platform, service, ops } = getClients();

  try {
    if (!platform) return send(res, 503, 'text/html; charset=utf-8', renderNoSite(host), CACHE_NONE);

    // ── draft preview: the token must verify before anything is read with the service role ──
    let snapshot = null, status = 'live', preview = false;
    if (path.startsWith('/preview')) {
      const v = verifyPreviewToken(token, previewSecret());
      if (!v.ok || !service) return send(res, 403, 'text/html; charset=utf-8', renderNoSite(host), CACHE_NONE);
      const draft = await loadDraftSnapshot(service, v.siteId);
      if (!draft.snapshot) return send(res, 404, 'text/html; charset=utf-8', renderNoSite(host), CACHE_NONE);
      snapshot = draft.snapshot; status = 'draft'; preview = true;
    } else {
      if (!parsed && !siteParam) return send(res, 404, 'text/html; charset=utf-8', renderNoSite(host), CACHE_NONE);
      const r = await resolveSite(platform, host, { slug: siteParam || (parsed && parsed.kind === 'free' ? parsed.slug : null) });
      if (!r.site) return send(res, 404, 'text/html; charset=utf-8', renderNoSite(host), CACHE_NONE);
      snapshot = r.site.snapshot; status = r.site.status || 'live';
      // The apex domain redirects to the www address so Google sees one canonical host.
      if (r.site.apex_domain && r.site.custom_domain && host === String(r.site.apex_domain).toLowerCase() && host !== String(r.site.custom_domain).toLowerCase()) {
        res.statusCode = 301;
        res.setHeader('Location', `https://${r.site.custom_domain}${path === '/' ? '/' : path}`);
        res.setHeader('Cache-Control', CACHE_LIVE);
        return res.end();
      }
    }

    const offline = status === 'offline';
    const cache = preview || offline ? CACHE_NONE : CACHE_LIVE;
    // Canonical, sitemap and robots name the custom domain only once its DNS is live (domain_live
    // from the public row) or when the request already came on it; until then the request host.
    const publicHost = canonicalHost(snapshot.site, host);

    if (path === '/robots.txt') return send(res, 200, 'text/plain; charset=utf-8', renderRobots(publicHost, { offline: offline || preview }), cache);
    if (path === '/sitemap.xml') return send(res, 200, 'application/xml; charset=utf-8', renderSitemap(snapshot, publicHost), cache);

    const pagePath = preview ? (new URL(req.url || '/', 'https://x.invalid').searchParams.get('page') || '/') : path;
    const route = resolveRoute(snapshot, pagePath);
    const ctx = buildCtx({ snapshot, host, path: pagePath, customerRoot: root });
    const menu = route.page ? await menuForPage(ops, route.page, ctx) : null;
    const rendered = renderPage({ snapshot, route, path: pagePath, host, menu, customerRoot: root, status, preview });

    const boot = bootScript({ snapshot, path: pagePath, host, preview, status });
    const dep = req.headers['x-vercel-deployment-url'] || process.env.VERCEL_URL || '';
    const shell = dep ? await getShell(dep) : null;
    const html = shell ? injectShell(shell, { head: rendered.head, body: rendered.body, boot })
      : renderDocument({ head: rendered.head, body: rendered.body, snapshot, path: pagePath });
    const code = route.kind === 'notfound' ? 404 : 200;
    return send(res, code, 'text/html; charset=utf-8', html, cache, { 'X-Robots-Tag': rendered.noindex ? 'noindex' : '' });
  } catch (e) {
    console.error('[api/site]', e && e.message);
    return send(res, 500, 'text/html; charset=utf-8', renderNoSite(host), CACHE_NONE);
  }
}
