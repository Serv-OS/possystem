// api/site.js and its helpers (ARCHITECTURE.md section 4): the preview token gate, the shell cache
// and injection, host resolution through the RPC with the view as fallback, the request target, and
// the menu plan for a page. Node only (api/ code), driven with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signPreviewToken, verifyPreviewToken } from '../../../api/_lib/website/preview.js';
import { getShell, injectShell, bootScript, _resetShellCache, SHELL_TTL_MS } from '../../../api/_lib/website/shell.js';
import { resolveSite, loadDraftSnapshot, freeSlugOf, shapeLocation } from '../../../api/_lib/website/resolveSite.js';
import { platformEnv, opsEnv, customerRoot } from '../../../api/_lib/website/env.js';
import { menuPlan, menuBlockOf } from '../../../api/_lib/website/menuForPage.js';
import { requestTarget } from '../../../api/site.js';
import { buildCtx } from './ssr/renderBlocks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const snap = () => JSON.parse(fs.readFileSync(path.resolve(here, 'fixtures/snapshot.sample.json'), 'utf8'));
const SITE_ID = '11111111-1111-4111-8111-111111111111';

test('preview token: signs and verifies; expired, tampered, malformed and secretless all refuse', () => {
  const now = 1_800_000_000_000;
  const tok = signPreviewToken(SITE_ID, now + 60_000, 'shh');
  assert.match(tok, new RegExp(`^${SITE_ID}\\.${now + 60_000}\\.[0-9a-f]{64}$`));
  assert.deepEqual(verifyPreviewToken(tok, 'shh', now), { ok: true, siteId: SITE_ID });
  assert.equal(verifyPreviewToken(tok, 'shh', now + 61_000).ok, false, 'expired');
  assert.equal(verifyPreviewToken(tok, 'other', now).ok, false, 'wrong secret');
  assert.equal(verifyPreviewToken(tok.slice(0, -1) + (tok.endsWith('0') ? '1' : '0'), 'shh', now).ok, false, 'tampered');
  assert.equal(verifyPreviewToken(`not-a-uuid.${now + 1}.abc`, 'shh', now).ok, false);
  assert.equal(verifyPreviewToken('', 'shh', now).ok, false);
  assert.equal(verifyPreviewToken(tok, '', now).ok, false, 'no secret configured = nothing verifies');
  assert.equal(verifyPreviewToken(null, 'shh', now).ok, false);
});

test('shell: fetched once per deployment, cached for 5 minutes, refused when it is not a shell, injection replaces title and root', async () => {
  _resetShellCache();
  let hits = 0;
  const html = '<!doctype html><html><head><title>ServOS</title><meta name="description" content="pos"><script src="/assets/a.js"></script></head><body><div id="root"></div></body></html>';
  const fetchImpl = async () => { hits++; return { ok: true, text: async () => html }; };
  const t0 = 1000;
  assert.equal(await getShell('possystem-x.vercel.app', { fetchImpl, now: t0 }), html);
  assert.equal(await getShell('https://possystem-x.vercel.app/', { fetchImpl, now: t0 + 1000 }), html);
  assert.equal(hits, 1, 'second read is the cache');
  await getShell('possystem-x.vercel.app', { fetchImpl, now: t0 + SHELL_TTL_MS + 1 });
  assert.equal(hits, 2, 'refetched after the TTL');
  assert.equal(await getShell('other.vercel.app', { fetchImpl: async () => ({ ok: true, text: async () => '<html>nope</html>' }), now: t0 }), null);
  assert.equal(await getShell('down.vercel.app', { fetchImpl: async () => { throw new Error('net'); }, now: t0 }), null);
  assert.equal(await getShell('', { fetchImpl }), null);
  const out = injectShell(html, { head: '<title>Mozz</title><meta name="description" content="pizza">', body: '<h1>Hi</h1>', boot: bootScript({ a: 1 }) });
  assert.equal((out.match(/<title>/g) || []).length, 1);
  assert.match(out, /<title>Mozz<\/title>/);
  assert.doesNotMatch(out, /content="pos"/);
  assert.match(out, /<div id="root"><h1>Hi<\/h1><\/div><script>window\.__SERVOS_SITE__=\{"a":1\}<\/script>/);
  assert.match(out, /<script src="\/assets\/a\.js">/, 'the SPA bundle still loads');
  assert.match(bootScript({ s: '</script><script>x' }), /\\u003c\/script>/, 'a closing tag in the data cannot end the script');
});

function fakePlatform({ rpcRows = null, rpcError = null, viewRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) { calls.push(['rpc', name, args]); return rpcError ? { data: null, error: rpcError } : { data: rpcRows, error: null }; },
    from(table) {
      calls.push(['from', table]);
      const q = { _f: null, select() { return q; }, eq(k, v) { q._f = (r) => r[k] === v; return q; }, or(expr) { q._f = (r) => expr.split(',').some((part) => { const m = /^(\w+)\.eq\.(.+)$/.exec(part); return m && r[m[1]] === m[2]; }); return q; }, limit() { return q; },
        async maybeSingle() { const rows = (viewRows || []).filter((r) => !q._f || q._f(r)); return { data: rows[0] || null, error: null }; } };
      return q;
    },
  };
}

test('resolveSite: the RPC answers; a missing RPC falls to the view by slug or by domain; nothing live = null', async () => {
  const row = { slug: 'mozz', custom_domain: 'www.mozzpizza.com', apex_domain: 'mozzpizza.com', published_version_id: 'v1', snapshot: JSON.stringify(snap()) };
  const viaRpc = await resolveSite(fakePlatform({ rpcRows: [row] }), 'www.mozzpizza.com');
  assert.equal(viaRpc.site.slug, 'mozz');
  assert.equal(viaRpc.site.snapshot.site.custom_domain, 'www.mozzpizza.com', 'snapshot parsed and the row address applied');
  const missing = { code: 'PGRST202', message: 'Could not find the function public.web_resolve_host' };
  const viaView = await resolveSite(fakePlatform({ rpcError: missing, viewRows: [row] }), 'mozz.sites.serv-os.app');
  assert.equal(viaView.site.slug, 'mozz');
  assert.deepEqual(viaView.error, null);
  const byDomain = await resolveSite(fakePlatform({ rpcError: missing, viewRows: [row] }), 'mozzpizza.com');
  assert.equal(byDomain.site.slug, 'mozz');
  assert.equal(viaRpc.site.domain_live, false, 'no domain_live column (SQL not run yet) means not live');
  assert.equal(viaRpc.site.snapshot.site.domain_live, false);
  const liveRow = await resolveSite(fakePlatform({ rpcRows: [{ ...row, domain_live: true }] }), 'www.mozzpizza.com');
  assert.equal(liveRow.site.domain_live, true);
  assert.equal(liveRow.site.snapshot.site.domain_live, true, 'the renderer reads it from the snapshot');
  const noDomain = await resolveSite(fakePlatform({ rpcRows: [{ ...row, custom_domain: null, domain_live: true }] }), 'mozz.sites.serv-os.app');
  assert.equal(noDomain.site.domain_live, false, 'live means nothing without a domain');
  const forced = await resolveSite(fakePlatform({ rpcRows: [] }), 'localhost', { slug: 'mozz' });
  assert.equal(forced.site, null, 'the ?site= door reads the view, which had nothing here');
  const none = await resolveSite(fakePlatform({ rpcRows: [] }), 'nobody.com');
  assert.equal(none.site, null);
  const err = await resolveSite(fakePlatform({ rpcError: { code: '500', message: 'boom' } }), 'x.com');
  assert.equal(err.site, null);
  assert.ok(err.error);
  assert.equal((await resolveSite(null, 'x')).site, null);
  assert.equal(freeSlugOf('mozz.sites.serv-os.app'), 'mozz');
  assert.equal(freeSlugOf('mozz.sites.dev.serv-os.app'), 'mozz');
  assert.equal(freeSlugOf('www.mozzpizza.com'), null);
});

test('loadDraftSnapshot builds the draft shape from the tables when no RPC exists; drafts become visible', async () => {
  const tables = {
    web_sites: [{ id: SITE_ID, company_id: 'co', slug: 'mozz', theme: { mood: 'dark' }, nav: [], footer: {}, seo: {}, settings: {} }],
    web_pages: [{ id: 'p1', site_id: SITE_ID, slug: '', title: 'Home', kind: 'home', status: 'draft', layout: { content: [] } }],
    web_posts: [{ id: 'q1', site_id: SITE_ID, slug: 'hi', title: 'Hi', status: 'draft', body_md: 'x' }],
    locations: [{ id: 'l1', company_id: 'co', name: 'Leeds', online_slug: 'mozz-leeds', online_enabled: true, bookings_enabled: true, latitude: 1, longitude: 2 }],
  };
  const svc = {
    async rpc() { return { data: null, error: { code: 'PGRST202' } }; },
    from(table) {
      const q = { _f: [], select() { return q; }, eq(k, v) { q._f.push((r) => r[k] === v); return q; }, order() { return q; },
        _rows() { return (tables[table] || []).filter((r) => q._f.every((f) => f(r))); },
        async maybeSingle() { return { data: q._rows()[0] || null, error: null }; },
        then(res, rej) { return Promise.resolve({ data: q._rows(), error: null }).then(res, rej); } };
      return q;
    },
  };
  const r = await loadDraftSnapshot(svc, SITE_ID);
  assert.equal(r.error, null);
  assert.equal(r.snapshot.site.status, 'draft');
  assert.equal(r.snapshot.pages[0].status, 'published', 'a preview shows the draft page');
  assert.equal(r.snapshot.posts[0].status, 'published');
  assert.equal(r.snapshot.locations[0].channels.bookings, true);
  assert.equal(r.snapshot.locations[0].channels.catering, false);
  assert.equal(r.snapshot.preview, true);
  assert.equal(r.snapshot.site.domain_live, false);
  tables.web_sites[0].custom_domain = 'www.mozzpizza.com';
  tables.web_sites[0].domain_status = { state: 'live' };
  assert.equal((await loadDraftSnapshot(svc, SITE_ID)).snapshot.site.domain_live, true, 'the draft reads domain_status itself');
  assert.equal((await loadDraftSnapshot(null, SITE_ID)).snapshot, null);
  assert.equal(shapeLocation(null), null);
});

test('env names reuse the api/ conventions and the release pack names', () => {
  const p = platformEnv({ PLATFORM_SUPABASE_URL: 'https://p.supabase.co/', PLATFORM_SUPABASE_ANON_KEY: 'a', PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 's' });
  assert.deepEqual(p, { url: 'https://p.supabase.co', anon: 'a', service: 's' });
  assert.deepEqual(opsEnv({ VITE_SUPABASE_URL: 'https://o.supabase.co', VITE_SUPABASE_ANON_KEY: 'k' }), { url: 'https://o.supabase.co', anon: 'k' });
  assert.equal(customerRoot({ VITE_APP_TIER: 'prod' }), 'serv-os.app');
  assert.equal(customerRoot({ VITE_APP_TIER: 'dev' }), 'dev.serv-os.app');
  assert.equal(customerRoot({}), 'serv-os.app');
});

test('requestTarget reads host and path from the rewrite', () => {
  assert.deepEqual(requestTarget({ url: '/api/site?path=/menu', headers: { host: 'WWW.Mozzpizza.com:443' } }), { host: 'www.mozzpizza.com', path: '/menu', siteParam: null, token: null });
  assert.deepEqual(requestTarget({ url: '/api/site?path=/index.html', headers: { 'x-forwarded-host': 'a.sites.serv-os.app, proxy', host: 'x' } }).path, '/');
  const t = requestTarget({ url: '/preview?token=abc&site=Mozz', headers: {} });
  assert.equal(t.path, '/preview');
  assert.equal(t.token, 'abc');
  assert.equal(t.siteParam, 'mozz');
  assert.equal(requestTarget({ url: '/api/site', headers: { host: 'h' } }).path, '/');
});

test('menuPlan: the first menu block names the venue and price mode; pages without a menu need no read', () => {
  const s = snap();
  const ctx = buildCtx({ snapshot: s, host: 'h', path: '/' });
  const home = menuPlan(s.pages[0], ctx);
  assert.equal(home.location.id, 'loc-leeds');
  assert.equal(home.options.priceMode, 'collection');
  assert.equal(home.options.timezone, 'Europe/London');
  assert.equal(home.options.menuId, 'follow');
  assert.equal(menuBlockOf(s.pages[0]).type, 'LiveMenu');
  const leeds = menuPlan(s.pages.find((p) => p.id === 'p-loc-leeds'), ctx);
  assert.equal(leeds.location.ops_location_id, 'ops-leeds');
  assert.equal(menuPlan(s.pages.find((p) => p.id === 'p-order'), ctx), null);
  assert.equal(menuPlan(null, ctx), null);
  assert.equal(menuPlan(s.pages[0], buildCtx({ snapshot: { site: {}, pages: [], locations: [] } })), null, 'no venue = no read, never a throw');
});
