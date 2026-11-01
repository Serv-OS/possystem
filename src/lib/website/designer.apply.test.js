// node --test: the AI designer end to end with a fake fetch (ARCHITECTURE.md section 13 D).
//   - the prompt never leaks another company's facts (every read is fenced by company id)
//   - a site outside the caller's companies is a 403 before anything is read or spent
//   - the patch goes through the validator: a refused patch is never written, the model gets one
//     retry, then the errors come back in plain English
//   - build mode picks the layout by photo coverage and writes the whole page set
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDesigner, companiesForUser, attachLocationIds, ANTHROPIC_URL } from '../../../api/website-designer.js';
import { assembleVenueFacts } from '../../../api/_lib/website/venueFacts.js';
import { buildSystemPrompt } from '../../../api/_lib/website/designerPrompt.js';
import { FALLBACK_BLOCK_SCHEMAS } from '../../../api/_lib/website/schemaToTool.js';

const PLAT = 'https://plat.test';
const OPS = 'https://ops.test';
const ENV = {
  PLATFORM_SUPABASE_URL: PLAT, PLATFORM_SUPABASE_SERVICE_ROLE_KEY: 'service-plat',
  SUPABASE_URL: OPS, SUPABASE_SERVICE_ROLE_KEY: 'service-ops',
  ANTHROPIC_API_KEY: 'sk-test', WEBSITE_DESIGNER_MODEL: 'claude-test-model',
};
const SITE_A = '10000000-0000-4000-8000-00000000000a';
const SITE_B = '10000000-0000-4000-8000-00000000000b';
const CO_A = '20000000-0000-4000-8000-00000000000a';
const CO_B = '20000000-0000-4000-8000-00000000000b';
const LOC_A1 = '30000000-0000-4000-8000-0000000000a1';
const LOC_A2 = '30000000-0000-4000-8000-0000000000a2';
const LOC_B1 = '30000000-0000-4000-8000-0000000000b1';
const OPS_A1 = '40000000-0000-4000-8000-0000000000a1';
const OPS_B1 = '40000000-0000-4000-8000-0000000000b1';
const USER = { id: '50000000-0000-4000-8000-000000000001', is_anonymous: false };

const hours = { weekly: { mon: [{ open: '11:00', close: '22:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } };

function tables({ photoCoverage = 80 } = {}) {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `it${i}`, location_id: OPS_A1, name: `Pizza ${i}`, cat: 'cat1', cats: [], parent_id: null, image: i < photoCoverage / 10 ? 'p.jpg' : '', visibility: { online: true }, archived: false }));
  return {
    companies: [{ id: CO_A, name: 'Mozz Pizza', slug: 'mozz' }, { id: CO_B, name: 'Rival Burgers', slug: 'rival' }],
    locations: [
      { id: LOC_A1, company_id: CO_A, ops_location_id: OPS_A1, name: 'Mozz Leeds', address: '1 Briggate, Leeds', timezone: 'Europe/London', currency: 'GBP', online_slug: 'mozz-leeds', online_enabled: true, qr_enabled: true, online_delivery_enabled: false, opening_hours: hours, online_branding: { display_name: 'Mozz Pizza', logo_url: 'https://x/logo.png', hero_url: 'https://x/hero.jpg', accent_color: '#c0392b' }, online_menu_id: null, latitude: 53.8, longitude: -1.5 },
      { id: LOC_A2, company_id: CO_A, ops_location_id: null, name: 'Mozz Huddersfield', address: '2 Market St, Huddersfield', timezone: 'Europe/London', currency: 'GBP', online_slug: 'mozz-hudds', online_enabled: false, qr_enabled: false, online_branding: null },
      { id: LOC_B1, company_id: CO_B, ops_location_id: OPS_B1, name: 'Rival Secret Kitchen', address: '9 Hidden Lane', currency: 'USD', online_slug: 'rival', online_enabled: true, online_branding: { display_name: 'Rival Burgers' } },
    ],
    loyalty_config: [{ company_id: CO_A, enabled: true, points_enabled: false, stamps_enabled: true }, { company_id: CO_B, enabled: true, points_enabled: true }],
    stamp_card_programs: [{ id: 'sp1', company_id: CO_A, active: true, name: 'Pizza club', stamps_required: 8, reward_description: 'Free pizza' }],
    gift_brand_config: [{ company_id: CO_A, enabled: true }, { company_id: CO_B, enabled: true }],
    web_sites: [
      { id: SITE_A, company_id: CO_A, slug: 'mozz', status: 'draft', theme: { mood: 'light' }, nav: [], footer: {}, seo: {}, settings: {} },
      { id: SITE_B, company_id: CO_B, slug: 'rival', status: 'live', theme: {}, nav: [], footer: {}, seo: {}, settings: {} },
    ],
    web_pages: [{ id: 'pg1', site_id: SITE_A, slug: 'menu', title: 'Menu', kind: 'menu', status: 'published', sort_order: 1, seo: {}, layout: { content: [{ type: 'Hero', props: {} }] } }],
    web_posts: [],
    web_ai_messages: [{ site_id: SITE_A, role: 'user', content: 'Earlier question', created_at: '2026-10-30T10:00:00Z' }, { site_id: SITE_A, role: 'assistant', content: 'Earlier answer', created_at: '2026-10-30T10:00:05Z' }],
    user_location_access: [{ user_id: USER.id, location_id: LOC_A1, locations: { company_id: CO_A } }],
    user_company_roles: [],
    menu_categories: [{ id: 'cat1', location_id: OPS_A1, label: 'Pizzas', menu_id: null, parent_id: null, sort_order: 1 }, { id: 'catB', location_id: OPS_B1, label: 'Secret Burgers', parent_id: null }],
    menu_items: [...items, { id: 'b1', location_id: OPS_B1, name: 'Secret Burger', cat: 'catB', image: '', archived: false }],
    menus: [{ id: 'm1', location_id: OPS_A1, name: 'Main', is_active: true, is_default: true }],
    menu_category_links: [],
    catering_site_settings: [{ location_id: OPS_A1, enabled: true, slug: 'mozz' }, { location_id: OPS_B1, enabled: true }],
    booking_rules: [{ location_id: OPS_B1 }],
    waitlist_config: [],
  };
}

// A small PostgREST stand in: eq, in, is filters and limit, plus a log of every write.
// One PostgREST filter part ("col.eq.v", "col.in.(a,b)") as a row predicate.
function filterPart(k, v) {
  if (v.startsWith('eq.')) return (r) => String(r[k]) === v.slice(3);
  if (v.startsWith('is.')) return (r) => String(r[k]) === v.slice(3);
  if (v.startsWith('in.(')) { const set = new Set(v.slice(4, -1).split(',').map((x) => x.replace(/"/g, ''))); return (r) => set.has(String(r[k])); }
  return () => true;
}
// or=(a.in.(x,y),b.eq.z): split on the commas that sit outside brackets.
function orParts(expr) {
  const inner = expr.replace(/^\(/, '').replace(/\)$/, '');
  const parts = []; let depth = 0; let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => { const i = p.indexOf('.'); return [p.slice(0, i), p.slice(i + 1)]; });
}

function fakeFetch({ data, rpcCompanies = [CO_A], claude = [], rpcMissing = false }) {
  const writes = [];
  const claudeCalls = [];
  const rpcCalls = [];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const f = async (url, init = {}) => {
    const u = new URL(url);
    if (url === ANTHROPIC_URL) {
      claudeCalls.push(JSON.parse(init.body));
      const next = claude.shift();
      if (!next) return json(500, { error: { message: 'no scripted reply' } });
      return json(200, { content: [{ type: 'tool_use', id: 't1', name: 'apply_site_patch', input: next }] });
    }
    const m = /^\/rest\/v1\/(.+)$/.exec(u.pathname);
    assert.ok(m, `unexpected url ${url}`);
    const table = m[1];
    if (table.startsWith('rpc/')) {
      if (rpcMissing) return json(404, { code: 'PGRST202', message: 'function not found' });
      const args = JSON.parse(init.body);
      rpcCalls.push({ name: table.slice(4), args });
      assert.equal(args.p_user, USER.id, 'the RPC takes p_user');
      return json(200, rpcCompanies.slice()); // setof uuid comes back as plain strings
    }
    if (init.method && init.method !== 'GET') {
      const body = init.body ? JSON.parse(init.body) : undefined;
      writes.push({ method: init.method, table, query: u.search, body, prefer: init.headers?.prefer });
      if (table.startsWith('web_pages') && init.method === 'POST') return json(201, body.map((r) => ({ id: r.slug === 'menu' ? 'pg1' : `pg-${r.slug}`, slug: r.slug })));
      return json(init.method === 'POST' ? 201 : 204, []);
    }
    let rows = data[table] || [];
    for (const [k, v] of u.searchParams.entries()) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (k === 'or') { const preds = orParts(v).map(([col, f]) => filterPart(col, f)); rows = rows.filter((r) => preds.some((p) => p(r))); continue; }
      rows = rows.filter(filterPart(k, v));
    }
    const limit = Number(u.searchParams.get('limit'));
    if (limit) rows = rows.slice(0, limit);
    return json(200, rows);
  };
  return { fetch: f, writes, claudeCalls, rpcCalls };
}

const importers = { schemas: async () => { throw new Error('not there'); }, validator: async () => { throw new Error('not there'); } };

test('facts are fenced to the company: another company never appears in the facts or the prompt', async () => {
  const { fetch } = fakeFetch({ data: tables() });
  const facts = await assembleVenueFacts({ platform: { url: PLAT, key: 'k' }, ops: { url: OPS, key: 'k' }, companyId: CO_A, siteId: SITE_A, fetchImpl: fetch });
  assert.equal(facts.company.name, 'Mozz Pizza');
  assert.deepEqual(facts.locations.map((l) => l.name), ['Mozz Leeds', 'Mozz Huddersfield']);
  assert.equal(facts.branding.brand_color, '#c0392b');
  assert.deepEqual(facts.channels, { online: true, qr: true, delivery: false, catering: true, loyalty: { on: true, type: 'stamps', programs: [{ name: 'Pizza club', stamps_required: 8, reward: 'Free pizza' }] }, gift: true, bookings: false, waitlist: false });
  assert.equal(facts.menu.photo_coverage_pct, 80);
  assert.deepEqual(facts.menu.categories.map((c) => c.label), ['Pizzas']);
  assert.equal(facts.locations[0].hours[0], 'mon: 11:00 to 22:00');
  assert.deepEqual(facts.recent_messages.map((m) => m.role), ['user', 'assistant']);
  const prompt = buildSystemPrompt({ facts, mode: 'build' });
  for (const leak of ['Rival', 'Secret', 'Hidden Lane', OPS_B1, LOC_B1, CO_B]) assert.ok(!prompt.includes(leak), `prompt leaked ${leak}`);
  assert.ok(!prompt.includes('Earlier question'), 'chat history is sent as turns, not inside the system prompt');
});

test('facts never throw: an unreachable database gives empty facts', async () => {
  const facts = await assembleVenueFacts({ platform: { url: PLAT, key: 'k' }, ops: { url: OPS, key: 'k' }, companyId: CO_A, siteId: SITE_A, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(facts.company.id, CO_A);
  assert.deepEqual(facts.locations, []);
  assert.equal(facts.menu.item_count, 0);
  assert.equal((await assembleVenueFacts({})).company.id, null);
});

test('company fence: a site of another company is 403, the RPC fallback reads the access rows', async () => {
  const { fetch, claudeCalls, writes } = fakeFetch({ data: tables(), rpcCompanies: [CO_A] });
  const out = await runDesigner({ body: { site_id: SITE_B, message: 'hi', mode: 'chat' }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(out.status, 403);
  assert.equal(claudeCalls.length, 0, 'nothing spent');
  assert.equal(writes.filter((w) => !w.table.startsWith('rpc/')).length, 0, 'nothing written');
  const missing = fakeFetch({ data: tables(), rpcMissing: true });
  assert.deepEqual(await companiesForUser({ platform: { url: PLAT, key: 'k' }, uid: USER.id, fetchImpl: missing.fetch }), [CO_A]);
  const unknown = await runDesigner({ body: { site_id: '10000000-0000-4000-8000-0000000000ff', message: 'hi' }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(unknown.status, 404);
  const bad = await runDesigner({ body: { site_id: 'nope' }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(bad.status, 400);
});

test('company fence for an Ops login: the reach goes to the RPC, and the fallback maps Ops ids through locations.ops_location_id', async () => {
  // Production shape: the login lives on the Ops project, so Platform access tables keyed by
  // platform_users hold nothing for it. Only the Ops location ids (requireUser's `reached`) answer.
  const data = { ...tables(), user_location_access: [], user_company_roles: [] };
  const plat = { url: PLAT, key: 'k' };
  // RPC present and answering with the reach.
  const viaRpc = fakeFetch({ data, rpcCompanies: [CO_A] });
  assert.deepEqual(await companiesForUser({ platform: plat, uid: USER.id, opsLocationIds: [OPS_A1], fetchImpl: viaRpc.fetch }), [CO_A]);
  assert.deepEqual(viaRpc.rpcCalls[0], { name: 'web_company_for_user', args: { p_user: USER.id, p_ops_location_ids: [OPS_A1] } }, 'the Ops ids are passed, as the migration contract says');
  // RPC present, nothing passed: null, never an empty list the SQL would treat as "no venue".
  const bare = fakeFetch({ data, rpcCompanies: [] });
  await companiesForUser({ platform: plat, uid: USER.id, fetchImpl: bare.fetch });
  assert.equal(bare.rpcCalls[0].args.p_ops_location_ids, null);
  // RPC missing (SQL not run yet): the site's company resolves through locations.ops_location_id.
  const noRpc = fakeFetch({ data, rpcMissing: true });
  assert.deepEqual(await companiesForUser({ platform: plat, uid: USER.id, opsLocationIds: [OPS_A1, 'junk'], fetchImpl: noRpc.fetch }), [CO_A]);
  // A legacy venue carries the same id on both sides.
  assert.deepEqual(await companiesForUser({ platform: plat, uid: USER.id, opsLocationIds: [LOC_A2], fetchImpl: noRpc.fetch }), [CO_A]);
  // No reach and no Platform rows: no company, so the designer refuses.
  assert.deepEqual(await companiesForUser({ platform: plat, uid: USER.id, opsLocationIds: [], fetchImpl: noRpc.fetch }), []);
  // End to end: the RPC answers nothing (as it does today for every Ops login) but the reach resolves the site's company.
  const { fetch, claudeCalls } = fakeFetch({ data, rpcCompanies: [], claude: [{ reply: 'Your site has one page.' }] });
  const ok = await runDesigner({ body: { site_id: SITE_A, message: 'hi', mode: 'chat' }, user: USER, reached: [OPS_A1], env: ENV, fetchImpl: fetch, importers });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(claudeCalls.length, 1);
  // The same login must still never reach another company's site.
  const other = await runDesigner({ body: { site_id: SITE_B, message: 'hi', mode: 'chat' }, user: USER, reached: [OPS_A1], env: ENV, fetchImpl: fakeFetch({ data, rpcCompanies: [] }).fetch, importers });
  assert.equal(other.status, 403);
  const none = await runDesigner({ body: { site_id: SITE_A, message: 'hi', mode: 'chat' }, user: USER, reached: [], env: ENV, fetchImpl: fakeFetch({ data, rpcCompanies: [] }).fetch, importers });
  assert.equal(none.status, 403, 'no reach, no Platform access rows: refused');
});

test('build mode: ember at 80% photos, whole page set written through the validator, messages saved', async () => {
  const patch = {
    reply: 'Built with Ember because 80% of items have photos.',
    theme: { layout: 'ember', type: 'warm-serif', buttons: 'pill', mood: 'light', brand_color: null },
    nav: [{ label: 'Home', kind: 'page', page_id: '' }, { label: 'Menu', kind: 'page', page_id: 'menu' }, { label: 'News', kind: 'link', href: '/blog' }],
    footer: { text: 'Mozz Pizza', show_powered_by: true },
    seo: { title: 'Mozz Pizza Leeds', description: 'Wood fired pizza in Leeds. Order online.', locale: 'en-GB' },
    pages: [
      { slug: '', title: 'Home', kind: 'home', seo: { title: 'Mozz Pizza, Leeds' }, layout: { root: { props: {} }, content: [{ type: 'Hero', props: { headline: 'Mozz Pizza, Leeds' } }, { type: 'OrderBar', props: { collection: true } }, { type: 'LiveMenu', props: { layout: 'cards' } }] } },
      { slug: 'menu', title: 'Menu', kind: 'menu', layout: { content: [{ type: 'Hero', props: { height: 'short' } }, { type: 'LiveMenu', props: {} }] } },
      { slug: 'mozz-leeds', title: 'Mozz Leeds', kind: 'location', location_id: LOC_A1, layout: { content: [{ type: 'Hero', props: {} }, { type: 'Hours', props: { location_id: LOC_A1 } }] } },
      { slug: 'mozz-hudds', title: 'Mozz Huddersfield', kind: 'location', layout: { content: [{ type: 'Hero', props: {} }] } },
      { slug: 'our-story', title: 'Our story', kind: 'custom', status: 'draft', layout: { content: [{ type: 'Hero', props: {} }, { type: 'Text', props: { md: 'Your words here.' } }] } },
    ],
    posts: [{ slug: 'welcome', title: 'Welcome to Mozz', excerpt: 'Hello Leeds.', body_md: 'We make pizza.', tags: ['news'] }, { slug: 'our-pizzas', title: 'Our pizzas', body_md: 'Ten of them.' }],
  };
  const { fetch, claudeCalls, writes } = fakeFetch({ data: tables({ photoCoverage: 80 }), claude: [patch] });
  const out = await runDesigner({ body: { site_id: SITE_A, message: '', mode: 'build' }, user: USER, env: ENV, fetchImpl: fetch, importers, now: new Date('2026-10-31T12:00:00Z') });
  assert.equal(out.status, 200);
  assert.equal(out.json.applied, true);
  assert.deepEqual(out.json.errors, []);
  assert.deepEqual(out.json.pages_changed, ['', 'menu', 'mozz-leeds', 'mozz-hudds', 'our-story']);
  assert.equal(out.json.reply, patch.reply);

  // The call to Claude: model, tokens, one tool, system prompt with the layout rule applied.
  assert.equal(claudeCalls.length, 1);
  const call = claudeCalls[0];
  assert.equal(call.model, 'claude-test-model');
  assert.equal(call.max_tokens, 16000);
  assert.equal(call.tools.length, 1);
  assert.equal(call.tools[0].name, 'apply_site_patch');
  assert.ok(call.system.includes('Layout: ember (Ember, because 80% of your menu items have photos'));
  assert.ok(call.system.includes(`"${LOC_A1}"`), 'location ids are in the facts for location pages');
  assert.deepEqual(call.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(call.messages[2].content, 'Build my website with the ember layout.');

  // Writes: site fields merged, pages upserted on (site_id, slug), posts upserted, two messages saved.
  const site = writes.find((w) => w.table.startsWith('web_sites'));
  assert.equal(site.method, 'PATCH');
  assert.deepEqual(site.body.theme, { mood: 'light', layout: 'ember', type: 'warm-serif', buttons: 'pill', brand_color: null });
  assert.deepEqual(site.body.nav, [{ label: 'Home', kind: 'page', page_id: 'pg-' }, { label: 'Menu', kind: 'page', page_id: 'pg1' }, { label: 'News', kind: 'link', href: '/blog' }], 'nav page slugs become page ids once the rows exist');
  const pages = writes.find((w) => w.table.startsWith('web_pages'));
  assert.equal(pages.query, '?on_conflict=site_id,slug');
  assert.ok(pages.prefer.includes('resolution=merge-duplicates'));
  assert.equal(pages.body.length, 5);
  assert.equal(pages.body[1].sort_order, 1, 'an existing page keeps its order');
  assert.equal(pages.body[0].sort_order, 2, 'new pages go after the existing ones');
  assert.equal(pages.body[2].location_id, LOC_A1);
  assert.equal(pages.body[3].location_id, LOC_A2, 'a location page with no id is matched by its slug');
  assert.equal(pages.body[4].status, 'draft');
  assert.deepEqual(pages.body[0].layout.content.map((b) => b.props.id), ['hero-1', 'orderbar-2', 'livemenu-3'], 'missing block ids are filled in');
  assert.ok(pages.body.every((p) => p.layout.root && typeof p.layout.root.props === 'object'));
  const posts = writes.find((w) => w.table.startsWith('web_posts'));
  assert.equal(posts.body.length, 2);
  assert.equal(posts.body[0].status, 'draft');
  assert.equal(posts.body[0].published_at, null);
  const msgs = writes.find((w) => w.table === 'web_ai_messages');
  assert.deepEqual(msgs.body.map((m) => m.role), ['user', 'assistant']);
  assert.equal(msgs.body[0].content, 'Build my website with the ember layout.');
  assert.equal(msgs.body[1].patch.theme.layout, 'ember');
});

test('build mode with few photos picks ledger, and the owner\'s own choice wins', async () => {
  const a = fakeFetch({ data: tables({ photoCoverage: 20 }), claude: [{ reply: 'ok' }] });
  await runDesigner({ body: { site_id: SITE_A, mode: 'build' }, user: USER, env: ENV, fetchImpl: a.fetch, importers });
  assert.ok(a.claudeCalls[0].system.includes('Layout: ledger (Ledger, because 20%'));
  const b = fakeFetch({ data: tables({ photoCoverage: 20 }), claude: [{ reply: 'ok' }] });
  await runDesigner({ body: { site_id: SITE_A, mode: 'build', layout: 'marquee' }, user: USER, env: ENV, fetchImpl: b.fetch, importers });
  assert.ok(b.claudeCalls[0].system.includes('Layout: marquee (the owner chose it)'));
});

test('a refused patch is never written: one retry with the errors, then plain English and applied false', async () => {
  const bad = { reply: 'Here', pages: [{ slug: 'menu', title: 'Menu', kind: 'menu', layout: { content: [{ type: 'Carousel', props: {} }] } }] };
  const { fetch, claudeCalls, writes } = fakeFetch({ data: tables(), claude: [bad, bad] });
  const out = await runDesigner({ body: { site_id: SITE_A, message: 'Add a carousel', mode: 'chat' }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(out.status, 200);
  assert.equal(out.json.applied, false);
  assert.deepEqual(out.json.pages_changed, []);
  assert.ok(out.json.errors.some((e) => e.includes('"Carousel" does not exist')));
  assert.ok(out.json.reply.startsWith('I could not apply that change'));
  assert.equal(claudeCalls.length, 2, 'exactly one retry');
  const retry = claudeCalls[1].messages.at(-1);
  assert.equal(retry.content[0].type, 'tool_result');
  assert.ok(retry.content[0].content.includes('Carousel'));
  assert.equal(writes.filter((w) => w.table.startsWith('web_pages') || w.table.startsWith('web_sites')).length, 0, 'no page or site write');
  const msgs = writes.find((w) => w.table === 'web_ai_messages');
  assert.equal(msgs.body[1].patch, null);
  assert.equal(msgs.body[0].content, 'Add a carousel');
});

test('a fixed retry is applied: the second answer passes and is written', async () => {
  const bad = { reply: 'x', pages: [{ slug: 'menu', title: 'Menu', kind: 'menu', layout: { content: [{ type: 'Nope', props: {} }] } }] };
  const good = { reply: 'Fixed', pages: [{ slug: 'menu', title: 'Menu', kind: 'menu', layout: { content: [{ type: 'Hero', props: {} }, { type: 'LiveMenu', props: {} }] } }] };
  const { fetch, writes } = fakeFetch({ data: tables(), claude: [bad, good] });
  const out = await runDesigner({ body: { site_id: SITE_A, message: 'Fix the menu page', mode: 'chat' }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(out.json.applied, true);
  assert.deepEqual(out.json.pages_changed, ['menu']);
  assert.equal(writes.filter((w) => w.table.startsWith('web_pages')).length, 1);
});

test('chat with no change: a reply alone is saved and nothing is written to pages', async () => {
  const { fetch, writes } = fakeFetch({ data: tables(), claude: [{ reply: 'Your menu page already has a live menu.' }] });
  const out = await runDesigner({ body: { site_id: SITE_A, message: 'Is the menu live?', mode: 'chat', page_id: 'pg1' }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(out.json.applied, false);
  assert.deepEqual(out.json.errors, []);
  assert.equal(writes.filter((w) => w.table !== 'web_ai_messages' && !w.table.startsWith('rpc/')).length, 0);
});

// 5.12.5: screenshots ride along as image blocks, the stored message says they were there, and the
// answer carries saved:true so the screen can warn when the chat did not persist.
test('screenshots reach Claude as image blocks before the words, are counted in the saved message, and saved is reported', async () => {
  const { fetch, claudeCalls, writes } = fakeFetch({ data: tables(), claude: [{ reply: 'Matched the look.' }] });
  const images = [{ media_type: 'image/jpeg', data: 'QUJD'.repeat(40) }, { media_type: 'application/pdf', data: 'QUJD' }];
  const out = await runDesigner({ body: { site_id: SITE_A, message: 'Make it like these', mode: 'chat', images }, user: USER, env: ENV, fetchImpl: fetch, importers });
  assert.equal(out.status, 200);
  assert.equal(out.json.saved, true);
  assert.equal(out.json.images_used, 1, 'the pdf was dropped');
  assert.deepEqual(out.json.fetched, []);
  const user = claudeCalls[0].messages.at(-1);
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].type, 'image');
  assert.equal(user.content[0].source.media_type, 'image/jpeg');
  assert.match(user.content[1].text, /^Make it like these\n\nThe owner attached 1 screenshot of/);
  assert.ok(claudeCalls[0].system.includes('REFERENCE SCREENSHOTS'));
  const msgs = writes.find((w) => w.table === 'web_ai_messages');
  assert.equal(msgs.body[0].content, 'Make it like these [1 screenshot attached]');
  assert.equal(msgs.body[1].content, 'Matched the look.');
});

test('facts_only answers the summary and messages without calling Claude', async () => {
  const { fetch, claudeCalls } = fakeFetch({ data: tables() });
  const out = await runDesigner({ body: { site_id: SITE_A, facts_only: true }, user: USER, env: { ...ENV, ANTHROPIC_API_KEY: '' }, fetchImpl: fetch, importers });
  assert.equal(out.status, 200);
  assert.ok(out.json.facts[0].startsWith('Venue: Mozz Pizza (UK, GBP)'));
  assert.ok(out.json.facts.some((l) => l.startsWith('Channels on: online, qr, catering, loyalty (stamps), gift')));
  assert.equal(out.json.messages.length, 2);
  assert.equal(out.json.site.pages.length, 1);
  assert.equal(claudeCalls.length, 0);
});

test('attachLocationIds keeps a valid id, matches by slug, and clears an id from another company', () => {
  const facts = { locations: [{ id: LOC_A1, online_slug: 'mozz-leeds' }] };
  const out = attachLocationIds({ pages: [{ kind: 'location', slug: 'mozz-leeds', location_id: LOC_B1 }, { kind: 'location', slug: 'x', location_id: LOC_B1 }, { kind: 'home', slug: '' }] }, facts);
  assert.equal(out.pages[0].location_id, LOC_A1);
  assert.equal(out.pages[1].location_id, null);
  assert.equal(out.pages[2].location_id, undefined);
  assert.equal(FALLBACK_BLOCK_SCHEMAS.CustomHtml, undefined);
});

// ── With the REAL shared modules (A's validator, B's registry) ─────────────────────────────────────
const realImporters = {
  schemas: () => import('../../surfaces/website/blocks/schema.js'),
  validator: () => import('./validatePatch.js'),
};

test('real modules: the tool schema comes from B\'s registry and a build patch passes A\'s validator', async () => {
  const { runDesigner: run } = await import('../../../api/website-designer.js');
  const patch = {
    reply: 'Built.',
    theme: { layout: 'ember', type: 'warm-serif', buttons: 'pill', mood: 'light', brand_color: null },
    nav: [{ label: 'Home', kind: 'page', page_id: '' }, { label: 'News', kind: 'link', href: '/blog' }],
    seo: { title: 'Mozz Pizza Leeds', description: 'Pizza in Leeds. Order online.', locale: 'en-GB', keywords: ['pizza leeds'] },
    pages: [
      { slug: '', title: 'Home', kind: 'home', seo: { title: 'Mozz Pizza, Leeds', description: 'Pizza in Leeds, order online.' }, layout: { root: { props: {} }, content: [
        { type: 'Hero', props: { headline: 'Mozz Pizza, Leeds', sub: 'Wood fired pizza.', show_status: true, primary: { label: 'Order now', href: 'servos:order' }, height: 'tall' } },
        { type: 'OrderBar', props: { collection: true, delivery: false, book: false, catering: true } },
        { type: 'LiveMenu', props: { layout: 'cards', max_items: 8, show: { photos: true } } },
        { type: 'Text', props: { md: 'A pizza place in Leeds.' } },
        { type: 'Hours', props: { location_id: 'all' } },
        { type: 'FindUs', props: { show_map: true } },
      ] } },
      { slug: 'mozz-leeds', title: 'Mozz Leeds', kind: 'location', layout: { content: [{ type: 'Hero', props: { headline: 'Mozz Leeds' } }, { type: 'Hours', props: { location_id: LOC_A1 } }] } },
    ],
    posts: [{ slug: 'welcome', title: 'Welcome', body_md: 'Hello Leeds.', tags: ['news'] }],
  };
  // A fresh module instance is not possible (caches), so use the loaders directly on this instance.
  const mod = await import('../../../api/website-designer.js');
  const schemas = await mod.loadBlockSchemas(realImporters.schemas);
  assert.ok(schemas.Hero && schemas.LiveMenu && !schemas.CustomHtml, 'B\'s registry minus CustomHtml');
  const { fetch, claudeCalls, writes } = fakeFetch({ data: tables(), claude: [patch] });
  const out = await run({ body: { site_id: SITE_A, mode: 'build' }, user: USER, env: ENV, fetchImpl: fetch, importers: realImporters });
  assert.deepEqual(out.json.errors, []);
  assert.equal(out.json.applied, true, JSON.stringify(out.json));
  assert.deepEqual(out.json.pages_changed, ['', 'mozz-leeds']);
  const toolTypes = claudeCalls[0].tools[0].input_schema.properties.pages.items.properties.layout.properties.content.items.anyOf.map((i) => i.properties.type.enum[0]);
  assert.ok(toolTypes.includes('Hero') && toolTypes.includes('Columns') && !toolTypes.includes('CustomHtml'));
  const heroProps = claudeCalls[0].tools[0].input_schema.properties.pages.items.properties.layout.properties.content.items.anyOf[0].properties.props.properties;
  assert.deepEqual(heroProps.height, { type: 'string', enum: ['tall', 'short'], description: 'Height' });
  assert.equal(heroProps.primary.properties.href.type, 'string');
  const pages = writes.find((w) => w.table.startsWith('web_pages'));
  assert.equal(pages.body[1].location_id, LOC_A1);
  assert.ok(pages.body[0].layout.content.every((b) => typeof b.props.id === 'string'));

  // A's validator refuses a prop the registry does not know, so nothing is written.
  const bad = { reply: 'x', pages: [{ slug: 'menu', title: 'Menu', kind: 'menu', layout: { content: [{ type: 'Hero', props: { headline: 'Menu', wobble: 1 } }] } }] };
  const b = fakeFetch({ data: tables(), claude: [bad, bad] });
  const refused = await run({ body: { site_id: SITE_A, mode: 'chat', message: 'x' }, user: USER, env: ENV, fetchImpl: b.fetch, importers: realImporters });
  assert.equal(refused.json.applied, false);
  assert.ok(refused.json.errors.some((e) => e.includes('wobble')), JSON.stringify(refused.json.errors));
  assert.equal(b.writes.filter((w) => w.table.startsWith('web_pages')).length, 0);
});
