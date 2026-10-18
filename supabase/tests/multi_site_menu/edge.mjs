#!/usr/bin/env node
// supabase/tests/multi_site_menu/edge.mjs
//
// The msm-publish EDGE FUNCTION itself, bundled (rolldown, the bundler Vite ships) and run in node over the local harness
// Postgres (supabaseMock.mjs answers its Supabase calls with real SQL as the service role or the
// signed in person). Deno.serve and Deno.env are stood in. Proves the glue the pure tests cannot:
// who may call it, the claim loop, start, plan, apply, the failure words, the pre check and late.
//
// Run after starting the harness Postgres (see README.md):  node supabase/tests/multi_site_menu/edge.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { harness, fakeToken } from './supabaseMock.mjs';
import { proposeImport, buildCentral, importPayload } from '../../functions/_shared/msmImport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const DB = harness.db;
const CONN = ['-h', process.env.MSM_PGHOST || '127.0.0.1', '-p', process.env.MSM_PGPORT || '55991', '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
const results = [];
const expect = (name, cond, detail = '') => { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? `  | ${String(detail).slice(0, 500)}` : ''}`); };
const psql = (args, input) => spawnSync('psql', [...CONN, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const one = (sql) => { const p = psql(['-d', DB, '-At'], `${sql};\n`); if (p.status) throw new Error(p.stderr); return p.stdout.trim(); };
const json = (sql) => JSON.parse(one(sql) || 'null');
const asUser = (id, sql) => { const p = psql(['-d', DB, '-At'], `begin;\ndo $c$ begin perform set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated","aal":"aal2"}', true); end $c$;\nset local role authenticated;\n${sql};\ncommit;\n`); if (p.status) throw new Error(p.stderr); return p.stdout.trim(); };
const lit = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

// ── the database ────────────────────────────────────────────────────────────
psql(['-d', 'postgres'], `drop database if exists ${DB};\ncreate database ${DB};\n`);
for (const f of ['supabase/tests/multi_site_menu/baseline.sql', 'supabase/migrations/20261017_OPS_multi_site_menu.sql', 'supabase/migrations/20261017c_OPS_multi_site_menu_groups.sql']) {
  const p = psql(['-d', DB, '-1', '-f', path.join(ROOT, f)]);
  if (p.status) { console.error(p.stderr); process.exit(2); }
}
const ORG = 'a0000000-0000-4000-8000-00000000000a';
const L1 = '11111111-0000-4000-8000-0000000a0001', L2 = '11111111-0000-4000-8000-0000000a0002';
const S = '90000000-0000-4000-8000-000000000001', E = '90000000-0000-4000-8000-000000000002', V = '90000000-0000-4000-8000-000000000003';
const sfx = (l) => l.slice(-8);
one(`
insert into organisations (id, name) values ('${ORG}', 'Company A');
insert into locations (id, org_id, name, timezone) values ('${L1}', '${ORG}', 'Site One', 'Europe/London'), ('${L2}', '${ORG}', 'Site Two', 'Europe/London');
insert into user_profiles (id, role, email, full_name, org_id) values ('${S}', 'super_admin', 's@example.test', 'ServOS', null), ('${E}', 'manager', 'e@example.test', 'Editor', '${ORG}'), ('${V}', 'manager', 'v@example.test', 'Viewer', '${ORG}');
insert into tax_rates (id, location_id, name, rate) values ('c0000000-0000-4000-8000-0000000000a1', '${L1}', 'VAT', 20), ('c0000000-0000-4000-8000-0000000000a2', '${L2}', 'VAT', 20);
insert into menus (id, location_id, name, is_default) values ('menu-1', '${L1}', 'Main', true), ('menu-2_${sfx(L2)}', '${L2}', 'Main', true);
insert into menu_categories (id, location_id, menu_id, label) values ('cat-hot', '${L1}', 'menu-1', 'Hot'), ('cat-hot_${sfx(L2)}', '${L2}', 'menu-2_${sfx(L2)}', 'Hot');
insert into menu_category_links (menu_id, category_id) values ('menu-1', 'cat-hot'), ('menu-2_${sfx(L2)}', 'cat-hot_${sfx(L2)}');
insert into menu_items (id, location_id, name, menu_name, cat, pricing, tax_rate_id, sold_alone) values
  ('m-latte', '${L1}', 'Latte', 'Latte', 'cat-hot', '{"base": 3.00}', 'c0000000-0000-4000-8000-0000000000a1', true),
  ('m-latte_${sfx(L2)}', '${L2}', 'Latte', 'Latte', 'cat-hot_${sfx(L2)}', '{"base": 3.00}', 'c0000000-0000-4000-8000-0000000000a2', true);
insert into print_routing (location_id, centres, routing) values ('${L1}', '[{"id": "pc-k"}]', '{"pc-k": {"assignedCategories": ["cat-hot"]}}'), ('${L2}', '[{"id": "pc-k2"}]', '{"pc-k2": {"assignedCategories": ["cat-hot_${sfx(L2)}"]}}');
`);
asUser(S, `select msm_admin_set_enabled('${ORG}', true)`);
asUser(S, `select msm_admin_set_member('${ORG}', '${E}', 'editor')`);
asUser(S, `select msm_admin_set_member('${ORG}', '${V}', 'viewer')`);
const raw = (loc) => json(`select json_build_object('locationId', '${loc}',
  'menus', (select json_agg(m) from menus m where location_id = '${loc}'), 'categories', (select json_agg(c) from menu_categories c where location_id = '${loc}'),
  'items', (select json_agg(i) from menu_items i where location_id = '${loc}'),
  'links', (select json_agg(json_build_object('menu_id', l.menu_id, 'category_id', l.category_id, 'sort_order', l.sort_order)) from menu_category_links l join menus m on m.id = l.menu_id where m.location_id = '${loc}'),
  'groups', '[]'::json, 'taxRates', (select json_agg(t) from tax_rates t where t.location_id::text = '${loc}'))`);
let n = 0;
const idGen = () => `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const sites = [{ location_id: L1, name: 'Site One', venue_menu_id: 'menu-1', raw: raw(L1) }, { location_id: L2, name: 'Site Two', venue_menu_id: `menu-2_${sfx(L2)}`, raw: raw(L2) }];
const built = buildCentral(proposeImport(sites, { idGen }), sites, {}, { idGen });
const imp = JSON.parse(asUser(E, `select msm_import_commit(${lit(importPayload(built.central, { orgId: ORG, name: 'Group menu' }))})`));
const MENU = imp.menu_id;
const LATTE = json(`select to_json(id) from msm_products where menu_id = '${MENU}' and name = 'Latte'`);
const HOT = json(`select to_json(id) from msm_categories where menu_id = '${MENU}' and label = 'Hot'`);

// ── the function, bundled with the stand in client ─────────────────────────
const out = path.join(process.env.TMPDIR || '/tmp', `msm-publish-${process.pid}.mjs`);
const bundle = await rolldown({
  input: path.join(ROOT, 'supabase/functions/msm-publish/index.ts'),
  platform: 'node',
  plugins: [{ name: 'mock-supabase', resolveId(id) { return /^https:\/\/esm\.sh\/@supabase\/supabase-js/.test(id) ? path.join(HERE, 'supabaseMock.mjs') : null; } }],
});
await bundle.write({ file: out, format: 'esm' });
let handler = null;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: 'http://local', SUPABASE_SERVICE_ROLE_KEY: harness.serviceKey, SUPABASE_ANON_KEY: 'anon-key' })[k] },
  serve: (h) => { handler = h; },
};
await import(pathToFileURL(out).href);
const call = async (body, headers = {}) => {
  const res = await handler(new Request('http://local/msm-publish', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const userAuth = (id, aal = 'aal2') => ({ Authorization: `Bearer ${fakeToken({ sub: id, role: 'authenticated', aal })}` });
const CRON = one(`select decrypted_secret from vault.decrypted_secrets where name = 'msm_cron_key'`);
const mkSet = (title) => JSON.parse(asUser(E, `insert into msm_change_sets (menu_id, org_id, title) values ('${MENU}', '${ORG}', '${title}') returning to_json(id)`));
const stage = (set, c) => asUser(E, `insert into msm_changes (change_set_id, menu_id, org_id, target, entity_id, location_id, op, after, before) values ('${set}', '${MENU}', '${ORG}', '${c.target}', '${c.entity}', ${c.loc ? `'${c.loc}'` : 'null'}, '${c.op}', ${lit(c.after)}, '{}'::jsonb)`);

// ── who may call it ─────────────────────────────────────────────────────────
expect('no sign in: refused', (await call({ action: 'run_due' })).status === 403);
expect('a wrong cron key: refused', (await call({ action: 'run_due' }, { 'x-cron-key': 'f'.repeat(64) })).status === 403);
expect('a person cannot run the scheduler sweep', (await call({ action: 'run_due' }, userAuth(E))).status === 403);
expect('the cron key runs the sweep (nothing due: nothing ran)', (await (async () => { const r = await call({ action: 'run_due' }, { 'x-cron-key': CRON }); return r.status === 200 && r.body.ran.length === 0; })()));

// ── publish now, run by the person's own call ───────────────────────────────
const SET1 = mkSet('Price rise and a new product');
stage(SET1, { target: 'product', entity: LATTE, op: 'update', after: { default_price: 3.2 } });
const NEWCAT = 'e0000000-0000-4000-8000-0000000000c1', NEWP = 'e0000000-0000-4000-8000-0000000000a1';
stage(SET1, { target: 'category', entity: NEWCAT, op: 'create', after: { label: 'Winter', route_like_id: HOT } });
stage(SET1, { target: 'product', entity: NEWP, op: 'create', after: { name: 'Hot chocolate', category_id: NEWCAT, default_price: 3.5, tax_rate_name: 'VAT', tax_rate_percent: 20 } });
stage(SET1, { target: 'product_site', entity: NEWP, loc: L1, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(L1)}`, active: true } });
const V1 = JSON.parse(asUser(E, `select msm_publish_now('${SET1}', true)`)).version_id;
const viewer = await call({ action: 'run_version', version_id: V1 }, userAuth(V));
expect('a viewer cannot make the runner publish', viewer.status === 403, JSON.stringify(viewer.body));
const r1 = await call({ action: 'run_version', version_id: V1 }, userAuth(E));
expect('the editor\'s call publishes both sites at once', r1.status === 200 && r1.body.status === 'done' && r1.body.sites.every((s) => s.status === 'done'), JSON.stringify(r1.body));
expect('site one: the price and the new product are on its rows', one(`select pricing->>'base' from menu_items where id = 'm-latte'`) === '3.2' && one(`select count(*) from menu_items where id = 'msm-e00000000000_${sfx(L1)}' and archived = false`) === '1');
expect('site two: the price, and no new product (it is not on there)', one(`select pricing->>'base' from menu_items where id = 'm-latte_${sfx(L2)}'`) === '3.2' && one(`select count(*) from menu_items where location_id = '${L2}'`) === '1');
const push = json(`select snapshot from config_pushes where location_id = '${L1}' order by created_at desc limit 1`);
expect('site one\'s tills get a push like Push to POS, marked as head office', push && push.pushSource?.kind === 'msm' && push.pushedBy.startsWith('Multi site menu: Editor') && push.menuItems.some((i) => i.id === `msm-e00000000000_${sfx(L1)}`));
expect('the new category is printed where Hot is', one(`select routing #> '{pc-k,assignedCategories}' from print_routing where location_id = '${L1}'`).includes('msmc-'));
expect('the venue feed says what happened, in words', /Head office menu update "Price rise and a new product": 1 price, 1 new product/.test(one(`select body from activity_events where location_id = '${L1}' order by created_at desc limit 1`)));

// ── a scheduled set, run by the job ─────────────────────────────────────────
const SET2 = mkSet('Weekend price');
stage(SET2, { target: 'product_site', entity: LATTE, loc: L2, op: 'update', after: { price: 3.4 } });
const V2 = JSON.parse(asUser(E, `select msm_schedule_set('${SET2}', '2031-01-01 06:00', 5, true)`)).version_id;
expect('nothing runs before its time', (await call({ action: 'run_due' }, { 'x-cron-key': CRON })).body.ran.length === 0);
one(`update msm_version_sites set due_at = now() - interval '1 second' where version_id = '${V2}'`);     // the clock reaches it
const r2 = await call({ action: 'run_due' }, { 'x-cron-key': CRON });
expect('at its time, the job runs it with nobody pressing anything', r2.status === 200 && r2.body.ran.length === 1 && r2.body.ran[0].status === 'done', JSON.stringify(r2.body));
expect('only the site it names changed', one(`select pricing->>'base' from menu_items where id = 'm-latte_${sfx(L2)}'`) === '3.4' && one(`select pricing->>'base' from menu_items where id = 'm-latte'`) === '3.2');
expect('a scheduled push says so', json(`select snapshot from config_pushes where location_id = '${L2}' order by created_at desc limit 1`).pushedBy === 'Multi site menu (scheduled)');

// ── a blocking problem: that site is skipped with words, others still run ───
const SET3 = mkSet('Breakfast');
const BCAT = 'e0000000-0000-4000-8000-0000000000c2', BP = 'e0000000-0000-4000-8000-0000000000a2';
stage(SET3, { target: 'category', entity: BCAT, op: 'create', after: { label: 'Breakfast' } });          // not sent like anything
stage(SET3, { target: 'product', entity: BP, op: 'create', after: { name: 'Toast', category_id: BCAT, default_price: 2, tax_rate_name: 'VAT', tax_rate_percent: 20 } });
stage(SET3, { target: 'product_site', entity: BP, loc: L1, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(L1)}b`, active: true } });
stage(SET3, { target: 'product_site', entity: LATTE, loc: L2, op: 'update', after: { price: 3.5 } });
const V3 = JSON.parse(asUser(E, `select msm_publish_now('${SET3}', true)`)).version_id;
const r3 = await call({ action: 'run_version', version_id: V3 }, userAuth(E));
const s1 = r3.body.sites.find((s) => s.location_id === L1), s2 = r3.body.sites.find((s) => s.location_id === L2);
expect('site one fails in words (the new category is printed nowhere); site two still publishes', s1.status === 'failed' && /would print nowhere\. In Review and publish, pick which category it prints like/.test(s1.error) && s2.status === 'done' && r3.body.status === 'partly_done', JSON.stringify(r3.body));
expect('nothing was written at the failed site', one(`select count(*) from menu_items where location_id = '${L1}' and name = 'Toast'`) === '0');
expect('the failed site\'s feed says it did not get it', /did not get/.test(one(`select title from activity_events where location_id = '${L1}' order by created_at desc limit 1`)));
expect('a failure is noted once in the ledger', json(`select notified from msm_version_sites where version_id = '${V3}' and location_id = '${L1}'`).failed != null);

// ── the pre check: an hour before, a blocking problem is found and told ─────
const SET4 = mkSet('Lunch');
const LCAT = 'e0000000-0000-4000-8000-0000000000c3', LP = 'e0000000-0000-4000-8000-0000000000a3';
stage(SET4, { target: 'category', entity: LCAT, op: 'create', after: { label: 'Lunch' } });
stage(SET4, { target: 'product', entity: LP, op: 'create', after: { name: 'Soup', category_id: LCAT, default_price: 4, tax_rate_name: 'VAT', tax_rate_percent: 20 } });
stage(SET4, { target: 'product_site', entity: LP, loc: L1, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(L1)}c`, active: true } });
const V4 = JSON.parse(asUser(E, `select msm_schedule_set('${SET4}', '2031-01-01 12:00', 5, true)`)).version_id;
one(`update msm_version_sites set due_at = now() + interval '40 minutes' where version_id = '${V4}'`);
await call({ action: 'run_due' }, { 'x-cron-key': CRON });
const pc = json(`select to_json(v) from msm_version_sites v where version_id = '${V4}' and location_id = '${L1}'`);
expect('the pre check marks it "will fail" in words, before opening, with no writes', pc.precheck_ok === false && /will not get "Lunch"/.test(pc.precheck_words) && pc.status === 'scheduled', JSON.stringify(pc));
expect('and the venue feed hears about it once', /will not get "Lunch"/.test(one(`select title from activity_events where location_id = '${L1}' order by created_at desc limit 1`)));
expect('the central tables do not hold the set yet (it has not started)', one(`select count(*) from msm_categories where id = '${LCAT}'`) === '0');

// ── late: a run 15 minutes past its time is marked and told once ───────────
one(`update msm_company set enabled = false where org_id = '${ORG}'`);
one(`update msm_version_sites set due_at = now() - interval '20 minutes' where version_id = '${V4}'`);
await call({ action: 'run_due' }, { 'x-cron-key': CRON });
expect('a company switched off: its sets pause (not run, not marked late)', one(`select status from msm_version_sites where version_id = '${V4}' and location_id = '${L1}'`) === 'scheduled' && one(`select late_at is null from msm_version_sites where version_id = '${V4}' and location_id = '${L1}'`) === 't');
one(`update msm_company set enabled = true where org_id = '${ORG}'`);
const r5 = await call({ action: 'run_due' }, { 'x-cron-key': CRON });
expect('switched on again: marked late once and run (it fails on its problem, in words)', one(`select late_at is not null from msm_version_sites where version_id = '${V4}' and location_id = '${L1}'`) === 't' && r5.body.ran.some((x) => x.status === 'failed'), JSON.stringify(r5.body));
expect('every message was noted in the ledger, so none repeats', Object.keys(json(`select notified from msm_version_sites where version_id = '${V4}' and location_id = '${L1}'`)).sort().join() === 'failed,late,will_fail');

// ── a warm worker never plans from an earlier request's list of changes ─────
const SET5 = mkSet('Mince pies');
stage(SET5, { target: 'product_site', entity: LATTE, loc: L2, op: 'update', after: { price: 3.6 } });
const V5 = JSON.parse(asUser(E, `select msm_schedule_set('${SET5}', '2031-01-01 15:00', 5, true)`)).version_id;
one(`update msm_version_sites set due_at = now() + interval '40 minutes' where version_id = '${V5}'`);
await call({ action: 'run_due' }, { 'x-cron-key': CRON });             // the pre check reads (and used to keep) SET5's changes
expect('warm: the pre check ran for the scheduled set', one(`select precheck_at is not null from msm_version_sites where version_id = '${V5}' and location_id = '${L2}'`) === 't');
asUser(E, `select msm_unschedule_set('${SET5}')`);
const PIE = 'e0000000-0000-4000-8000-0000000000a5';
stage(SET5, { target: 'product', entity: PIE, op: 'create', after: { name: 'Mince pie', category_id: HOT, default_price: 2.5, tax_rate_name: 'VAT', tax_rate_percent: 20 } });
stage(SET5, { target: 'product_site', entity: PIE, loc: L1, op: 'create', after: { venue_item_id: `msm-e000000000a5_${sfx(L1)}`, active: true } });
const V6 = JSON.parse(asUser(E, `select msm_publish_now('${SET5}', true)`)).version_id;
const r6 = await call({ action: 'run_version', version_id: V6 }, userAuth(E));
expect('warm: the product added after unscheduling reaches the site (the same worker read the set afresh)', r6.status === 200
  && one(`select count(*) from menu_items where location_id = '${L1}' and name = 'Mince pie'`) === '1', JSON.stringify(r6.body));

// ── ROUND 2: the contract with the database, the one time refresh, a group publish ──
{
  // An older database (the contract below 2): a site is never planned, it goes back in the queue in words.
  one(`create or replace function public.msm_sql_contract() returns integer language sql immutable set search_path = '' as $f$ select 1 $f$`);
  const SETC = mkSet('Contract');
  stage(SETC, { target: 'product_site', entity: LATTE, loc: L2, op: 'update', after: { price: 3.7 } });
  const VC = JSON.parse(asUser(E, `select msm_publish_now('${SETC}', true)`)).version_id;
  await call({ action: 'run_version', version_id: VC }, userAuth(E));
  const sc = json(`select to_json(v) from msm_version_sites v where version_id = '${VC}' and location_id = '${L2}'`);
  expect('against an older database a site is never planned: back in the queue, "Run 20261017c first"', sc.status === 'scheduled' && /Run 20261017c first/.test(sc.error)
    && one(`select pricing->>'base' from menu_items where id = 'm-latte_${sfx(L2)}'`) !== '3.7', JSON.stringify(sc));
  one(`create or replace function public.msm_sql_contract() returns integer language sql immutable set search_path = '' as $f$ select 2 $f$`);
  one(`update msm_version_sites set due_at = now() - interval '1 second' where version_id = '${VC}'`);
  await call({ action: 'run_due' }, { 'x-cron-key': CRON });
  expect('once 20261017c has run, the same site goes through', one(`select pricing->>'base' from menu_items where id = 'm-latte_${sfx(L2)}'`) === '3.7');

  // A group menu made before round 2: its option group is a jsonb list until the refresh.
  const GX = 'e7000000-0000-4000-8000-000000000001';
  one(`insert into modifier_groups (id, location_id, name, options) values
         ('mgd-shot', '${L1}', 'Extra shot', '[{"id": "opt-shot", "name": "Extra shot", "price": 0.5}]'),
         ('mgd-shot_${sfx(L2)}', '${L2}', 'Extra shot', '[{"id": "opt-shot", "name": "Extra shot", "price": 0.6}]');
       update menu_items set assigned_modifier_groups = '[{"groupId": "mgd-shot"}]' where id = 'm-latte';
       update menu_items set assigned_modifier_groups = '[{"groupId": "mgd-shot_${sfx(L2)}"}]' where id = 'm-latte_${sfx(L2)}';
       insert into msm_modifier_groups (id, menu_id, name, options) values ('${GX}', '${MENU}', 'Extra shot', '[{"id": "opt-shot", "name": "Extra shot", "price": 0.5}]');
       insert into msm_modifier_group_sites (group_id, location_id, venue_group_id) values ('${GX}', '${L1}', 'mgd-shot'), ('${GX}', '${L2}', 'mgd-shot_${sfx(L2)}');
       update msm_products set modifier_groups = '[{"groupId": "${GX}"}]' where id = '${LATTE}';
       update msm_menus set refreshed_at = null where id = '${MENU}'`);
  const rv = await call({ action: 'refresh_groups', menu_id: MENU }, userAuth(V));
  expect('a viewer cannot run the refresh', rv.status === 403, JSON.stringify(rv.body));
  const rr = await call({ action: 'refresh_groups', menu_id: MENU }, userAuth(E));
  expect('the editor\'s refresh brings the option group in as rows, changing nothing at any site', rr.status === 200 && rr.body.ok === true
    && one(`select count(*) from msm_modifier_options where menu_id = '${MENU}'`) === '1'
    && one(`select os.price from msm_modifier_option_sites os join msm_modifier_options o on o.id = os.option_id where o.menu_id = '${MENU}' and os.location_id = '${L2}'`) === '0.60'
    && one(`select options::text from modifier_groups where id = 'mgd-shot'`).includes('0.5'), JSON.stringify(rr.body));
  const again = await call({ action: 'refresh_groups', menu_id: MENU }, userAuth(E));
  expect('a second refresh says there is nothing to do', again.status === 200 && again.body.already === true, JSON.stringify(again.body));
  // A group publish through the runner: the default option price moves where it is followed.
  const OPT = json(`select to_json(id) from msm_modifier_options where menu_id = '${MENU}'`);
  const SETG = mkSet('Shot up');
  stage(SETG, { target: 'modifier_option', entity: OPT, op: 'update', after: { price: 0.55 } });
  const VG = JSON.parse(asUser(E, `select msm_publish_now('${SETG}', true)`)).version_id;
  const rg = await call({ action: 'run_version', version_id: VG }, userAuth(E));
  expect('a group publish: site one\'s option follows to 0.55, site two keeps its own 0.60', rg.status === 200
    && one(`select options->0->>'price' from modifier_groups where id = 'mgd-shot'`) === '0.55'
    && one(`select options->0->>'price' from modifier_groups where id = 'mgd-shot_${sfx(L2)}'`) === '0.6', JSON.stringify(rg.body));
  const pg = json(`select snapshot from config_pushes where location_id = '${L1}' order by created_at desc limit 1`);
  expect('and site one\'s tills get the group as the table now holds it', pg.modifierGroupDefs.find((g) => g.id === 'mgd-shot')?.options[0].price === 0.55);
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
