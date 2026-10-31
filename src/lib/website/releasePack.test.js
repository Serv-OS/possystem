// node --test: the parts of area A that are files rather than functions. The migration makes what
// the contract names (section 2), the browser client knows every action the two edge functions
// know (section 10), and the release pack and the UI copy keep the house rules (no dashes as
// punctuation, plain English).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261031_PLATFORM_website_builder.sql');
const admin = read('supabase/functions/website-admin/index.ts');
const domainFn = read('supabase/functions/website-domain/index.ts');
const auth = read('supabase/functions/_shared/websiteAuth.ts');
const client = read('src/lib/websiteAdmin.js');
const release = read('docs/website-builder/RELEASE.md');

const TABLES = ['web_sites', 'web_pages', 'web_posts', 'web_site_versions', 'web_ai_messages', 'web_assets'];

test('migration makes the six tables, forces RLS on each, and is idempotent in style', () => {
  for (const t of TABLES) {
    assert.ok(sql.includes(`create table if not exists public.${t} (`), t);
    assert.ok(new RegExp(`alter table public\\.${t}\\s+force row level security;`).test(sql), `${t} force rls`);
    assert.ok(new RegExp(`alter table public\\.${t}\\s+enable row level security;`).test(sql), `${t} enable rls`);
  }
  assert.ok(!/create table (?!if not exists)/.test(sql), 'every create table is if not exists');
  // Every create policy is preceded by its drop policy if exists (storage one included).
  const creates = [...sql.matchAll(/create policy (\w+)/g)].map((m) => m[1]);
  for (const name of creates) assert.ok(sql.includes(`drop policy if exists ${name} `), `drop before create: ${name}`);
  assert.equal(creates.length, 7);   // six owner reads + the bucket read
  assert.ok(/create or replace view public\.web_sites_public/.test(sql));
  assert.ok(/create or replace function public\.web_resolve_host\(p_host text\)/.test(sql));
  assert.ok(/security definer/.test(sql));
  assert.ok(/grant execute on function public\.web_resolve_host\(text\) to anon/.test(sql));
  assert.ok(/create or replace function public\.web_company_for_user\(p_user uuid/.test(sql));
  assert.ok(/grant execute on function public\.web_company_for_user\(uuid, uuid\[\]\) to service_role/.test(sql));
  assert.ok(!/grant execute on function public\.web_company_for_user[^\n]*anon/.test(sql), 'the AI fence is never anon callable');
  for (const col of ['slug', 'custom_domain', 'apex_domain', 'company_id']) assert.ok(sql.includes(`web_sites_${col}_idx`), col);
  for (const t of ['web_sites', 'web_pages', 'web_posts']) assert.ok(sql.includes(`create trigger ${t}_touch before update on public.${t}`), `${t} updated_at trigger`);
  assert.ok(sql.includes("'web-assets', 'web-assets', true"), 'public bucket');
  assert.ok(/VISIBLE CHECK/.test(sql));
  assert.ok(/to_regclass\('public\.user_locations'\) is not null/.test(sql), 'guard against running in Ops');
  assert.ok(!/insert into public\.web_/.test(sql), 'the migration seeds nothing');
});

test('the view exposes only the public columns (plus the domain_live fact) and only live sites', () => {
  const view = sql.slice(sql.indexOf('create or replace view public.web_sites_public'), sql.indexOf('revoke all on public.web_sites_public'));
  assert.ok(/select s\.slug, s\.custom_domain, s\.apex_domain, s\.published_version_id, v\.snapshot,\s+coalesce\(\(s\.domain_status->>'state'\) = 'live', false\) as domain_live/.test(view));
  assert.ok(/where s\.status = 'live'/.test(view));
  assert.ok(!/s\.settings|s\.theme|s\.domain_status,|s\.domain_status\s+from/.test(view), 'the raw domain_status jsonb (records, errors) is never exposed, only the live boolean');
  // The host lookup returns the same shape, and is dropped first because its return type changed.
  assert.ok(sql.indexOf('drop function if exists public.web_resolve_host(text);') < sql.indexOf('create or replace function public.web_resolve_host(p_host text)'));
  assert.ok(/returns table \(slug text, custom_domain text, apex_domain text, published_version_id uuid, snapshot jsonb, domain_live boolean\)/.test(sql));
  assert.ok(/p\.snapshot, p\.domain_live\s+from public\.web_sites_public p/.test(sql));
});

test('the browser client names every action the edge functions handle, and nothing else', () => {
  const adminActions = [...admin.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]);
  const domainActions = [...domainFn.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]);
  const clientActions = [...client.matchAll(/action: '([a-z_]+)'/g)].map((m) => m[1]);
  const contract = ['get_site', 'save_site', 'save_page', 'delete_page', 'reorder_pages', 'save_post', 'delete_post', 'publish', 'unpublish', 'restore_version', 'preview_token', 'upload_url', 'apply_ai_patch', 'geocode_locations'];
  assert.deepEqual([...new Set(adminActions)].sort(), [...contract].sort());
  assert.deepEqual([...new Set(domainActions)].sort(), ['check_domain', 'remove_domain']);
  for (const a of [...contract, 'check_domain', 'remove_domain']) assert.ok(clientActions.includes(a), `client has ${a}`);
  for (const a of clientActions) assert.ok([...contract, 'check_domain', 'remove_domain'].includes(a), `client action ${a} exists on a function`);
});

test('fence order: second step, bearer, real user, venues read server side, company from venues', () => {
  const order = ['secondStepRefusal(req)', 'Authorization', 'opsAdmin.auth.getUser(token)', 'user.is_anonymous', "from('user_locations')", 'await companiesForOpsLocations('];
  let last = -1;
  for (const step of order) {
    const at = auth.indexOf(step);
    assert.ok(at > last, `fence step out of order or missing: ${step}`);
    last = at;
  }
  // The body's company_id can only choose among the caller's companies, and the venue the Back
  // Office is open on (body.location_id) picks that venue's company (5.12.1, pure rule pickCompany).
  const rules = read('supabase/functions/_shared/websiteRules.js');
  assert.ok(auth.includes("import { pickCompany } from './websiteRules.js'") && auth.includes('pickCompany(caller'));
  assert.ok(auth.includes("body?.location_id") && auth.includes('companiesForOpsLocations([locationId])'));
  assert.ok(/ids\.includes\(want\)/.test(rules) && /ids\.includes\(fromLoc\[0\]\)/.test(rules));
  for (const fn of [admin, domainFn]) {
    assert.ok(fn.includes('websiteCaller(req)') && fn.includes('resolveCompany('), 'both functions use the shared fence');
    assert.ok(!/body\.company_id\)\s*;?\s*const site/.test(fn));
  }
  assert.ok(admin.includes("Deno.env.get('WEBSITE_PREVIEW_SECRET')"));
  assert.ok(domainFn.includes('fetchWithTimeout') && auth.includes('ms = 8000'), 'outside calls time out at 8 s');
});

test('no em or en dashes in UI copy, docs or SQL comments; release pack covers every step', () => {
  for (const [name, text] of Object.entries({ sql, admin, domainFn, auth, client, release })) {
    assert.ok(!/[–—]/.test(text), `${name} has a dash used as punctuation`);
  }
  for (const must of ['WEBSITE_PREVIEW_SECRET', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', '*.sites', 'web-assets', 'website-admin', 'website-domain', '20261031_PLATFORM_website_builder.sql', 'PLATFORM_SUPABASE_URL', 'PLATFORM_SUPABASE_ANON_KEY', 'PLATFORM_SUPABASE_SERVICE_ROLE_KEY', 'mozz.sites.serv-os.app', 'curl', '76.76.21.21', 'yhzjgyrkyjabvhblqxzu']) {
    assert.ok(release.includes(must), `RELEASE.md names ${must}`);
  }
  assert.ok(/Supabase SQL editor, Platform project/.test(release));
  assert.ok(/Mac Terminal app, any folder/.test(release));
});
