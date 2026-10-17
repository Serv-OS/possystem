#!/usr/bin/env node
// supabase/tests/multi_site_menu/run.mjs
//
// 20261017_OPS_multi_site_menu.sql on a LOCAL, throwaway Postgres 17. Never Supabase.
// The same method as supabase/tests/second_step: the live shape (roles WITH production's default
// privileges, the menu tables with their live columns, the auth helpers, vault, pg_net and pg_cron
// stand ins), the file applied as ONE transaction twice, then every rule checked as the roles
// PostgREST really uses. The publish path is driven END TO END with the real planner, health check
// and snapshot builder (supabase/functions/_shared/msm*.js), exactly as msm-publish runs them.
//
// Run:
//   initdb -D <scratch>/data -U postgres --auth=trust -E UTF8
//   LC_ALL=C pg_ctl -D <scratch>/data -o "-p 55991 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
//   node supabase/tests/multi_site_menu/run.mjs        (MSM_PGHOST / MSM_PGPORT override the address)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { proposeImport, buildCentral, importPayload } from '../../functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, countsWords } from '../../functions/_shared/msmPlan.js';
import { checkSite } from '../../functions/_shared/msmHealth.js';
import { buildMsmSnapshot, appliedRaw } from '../../functions/_shared/msmSnapshot.js';
import { localToUtc } from '../../functions/_shared/msmSchedule.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations', '20261017_OPS_multi_site_menu.sql');
const RB = path.join(ROOT, 'supabase', 'migrations', '20261017_OPS_multi_site_menu_ROLLBACK.sql');
const BASE = path.join(HERE, 'baseline.sql');
const DB = 'msm_harness';
const CONN = ['-h', process.env.MSM_PGHOST || '127.0.0.1', '-p', process.env.MSM_PGPORT || '55991', '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];

const results = [];
const expect = (name, cond, detail = '') => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? `  | ${String(detail).slice(0, 400)}` : ''}`);
};

function psql(args, input) {
  const p = spawnSync('psql', [...CONN, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { out: (p.stdout || '').trim(), err: (p.stderr || '').trim(), code: p.status };
}
// One statement as a caller. claims null = the database owner (no row level security).
function q(sqlText, who = null) {
  const pre = who
    ? `do $c$ begin perform set_config('request.jwt.claims', '${JSON.stringify(who.claims).replace(/'/g, "''")}', true); end $c$;\nset local role ${who.role};\n`
    : '';
  return psql(['-d', DB, '-At'], `begin;\n${pre}${sqlText};\ncommit;\n`);
}
const one = (sqlText, who) => { const r = q(sqlText, who); if (r.code) throw new Error(r.err); return r.out; };
const json = (sqlText, who) => JSON.parse(one(sqlText, who) || 'null');
const lit = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

// ── ids ─────────────────────────────────────────────────────────────────────
const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const LA1 = '11111111-0000-4000-8000-0000000a0001';
const LA2 = '11111111-0000-4000-8000-0000000a0002';
const LB1 = '22222222-0000-4000-8000-0000000b0001';
const U = {
  S: '90000000-0000-4000-8000-000000000001', E: '90000000-0000-4000-8000-000000000002',
  V: '90000000-0000-4000-8000-000000000003', O: '90000000-0000-4000-8000-000000000004',
  EB: '90000000-0000-4000-8000-000000000005',
};
const as = (id, aal = 'aal2') => ({ role: 'authenticated', claims: { sub: id, role: 'authenticated', aal } });
const ANON = { role: 'anon', claims: { role: 'anon' } };
const SERVICE = { role: 'service_role', claims: { role: 'service_role' } };
const sfx = (l) => l.slice(-8);
const VAT_A1 = 'c0000000-0000-4000-8000-0000000000a1';
const VAT_A2 = 'c0000000-0000-4000-8000-0000000000a2';
const VAT_B1 = 'c0000000-0000-4000-8000-0000000000b1';

// ── setup ───────────────────────────────────────────────────────────────────
psql(['-d', 'postgres'], `drop database if exists ${DB};\ncreate database ${DB};\n`);
let r = psql(['-d', DB, '-f', BASE]);
if (r.code) { console.error(r.err); process.exit(2); }

r = psql(['-d', DB, '-1', '-At', '-f', MIG]);
expect('migration applies as one transaction', r.code === 0, r.err);
r = psql(['-d', DB, '-1', '-At', '-f', MIG]);
expect('migration applies a second time (idempotent)', r.code === 0, r.err);
const check = r.out.split('\n').pop().split('|');
expect('check row: 15 tables, 15 with row level security, 15 fenced', check[0] === '15' && check[1] === '15' && check[2] === '15', r.out);
expect('check row: anon has no table rights and no function rights', check[3] === '0' && check[4] === '0', r.out);
expect('check row: 18 member functions, 12 server functions', check[5] === '18' && check[6] === '12', r.out);
expect('check row: the job runs every minute, the key is there and not in the job', check[7] === '1' && check[8] === 't' && check[9] === '1', r.out);
expect('check row: 8 guards, 0 companies switched on', check[10] === '8' && check[11] === '0', r.out);

one(`
insert into organisations (id, name) values ('${ORG_A}', 'Company A'), ('${ORG_B}', 'Company B');
insert into locations (id, org_id, name, timezone) values ('${LA1}', '${ORG_A}', 'Site A1', 'Europe/London'), ('${LA2}', '${ORG_A}', 'Site A2', 'Europe/London'), ('${LB1}', '${ORG_B}', 'Site B1', 'America/Los_Angeles');
insert into user_profiles (id, org_id, role, email, full_name) values
  ('${U.S}', null, 'super_admin', 's@example.test', 'ServOS person'),
  ('${U.E}', '${ORG_A}', 'manager', 'e@example.test', 'Editor A'),
  ('${U.V}', '${ORG_A}', 'manager', 'v@example.test', 'Viewer A'),
  ('${U.O}', '${ORG_A}', 'owner', 'o@example.test', 'Owner A'),
  ('${U.EB}', '${ORG_B}', 'manager', 'eb@example.test', 'Editor B');
insert into tax_rates (id, location_id, name, rate) values ('${VAT_A1}', '${LA1}', 'VAT', 20), ('${VAT_A2}', '${LA2}', 'Standard Rate', 20), ('${VAT_B1}', '${LB1}', 'VAT', 20);
insert into menus (id, location_id, name, is_default) values ('menu-a1', '${LA1}', 'Main', true), ('menu-a2_${sfx(LA2)}', '${LA2}', 'Main', true), ('menu-b1', '${LB1}', 'Main', true);
insert into menu_categories (id, location_id, menu_id, label, sort_order) values ('cat-hot', '${LA1}', 'menu-a1', 'Hot drinks', 1), ('cat-milk', '${LA1}', 'menu-a1', 'Milks', 9);
insert into menu_categories (id, location_id, menu_id, label, sort_order, master_id) values ('cat-hot_${sfx(LA2)}', '${LA2}', 'menu-a2_${sfx(LA2)}', 'Hot drinks', 1, null);
insert into menu_categories (id, location_id, menu_id, label) values ('cat-b', '${LB1}', 'menu-b1', 'B drinks');
insert into menu_category_links (menu_id, category_id) values ('menu-a1', 'cat-hot'), ('menu-a1', 'cat-milk'), ('menu-a2_${sfx(LA2)}', 'cat-hot_${sfx(LA2)}'), ('menu-b1', 'cat-b');
insert into menu_items (id, location_id, name, menu_name, cat, pricing, tax_rate_id, type, sold_alone, assigned_modifier_groups, scope) values
  ('m-latte', '${LA1}', 'Latte', 'Latte', 'cat-hot', '{"base": 3.00, "menus": {"menu-a1": {"base": 2.50}}}', '${VAT_A1}', 'simple', true, '[{"groupId": "mgd-milk"}]', 'shared'),
  ('m-oat', '${LA1}', 'Oat milk', 'Oat milk', 'cat-milk', '{"base": 0.40}', '${VAT_A1}', 'subitem', false, '[]', 'local');
insert into menu_items (id, location_id, name, menu_name, cat, pricing, tax_rate_id, master_id, scope, sold_alone) values
  ('m-latte_${sfx(LA2)}', '${LA2}', 'Latte', 'Latte', 'cat-hot_${sfx(LA2)}', '{"base": 3.20}', '${VAT_A2}', 'm-latte', 'shared', true);
insert into menu_items (id, location_id, name, cat, pricing) values ('m-b', '${LB1}', 'B coffee', 'cat-b', '{"base": 2.00}');
insert into modifier_groups (id, location_id, name, options) values ('mgd-milk', '${LA1}', 'Milk', '[{"id": "opt-1", "name": "Oat milk", "price": 0.40, "itemId": "m-oat"}]');
insert into print_routing (location_id, centres, routing) values ('${LA1}', '[{"id": "pc-k", "name": "Kitchen"}]', '{"pc-k": {"assignedCategories": ["cat-hot"], "excludedItems": []}}');
insert into config_pushes (location_id, pushed_by, snapshot) values ('${LA1}', 'Somebody', '{"locationId": "${LA1}", "instructionGroupDefs": [{"id": "ig1"}], "tables": [{"id": "t1"}], "quickScreenIds": ["m-latte"], "menuItems": [{"id": "m-latte", "variantLabel": "Regular"}]}');
`);

// ── access: the switch and the named logins ─────────────────────────────────
r = q(`select msm_admin_set_enabled('${ORG_A}', true)`, as(U.E));
expect('an editor cannot switch a company on', r.code !== 0 && /ServOS staff/.test(r.err), r.err);
r = q(`select msm_admin_set_enabled('${ORG_A}', true)`, as(U.S, 'aal1'));
expect('ServOS without the second step cannot switch a company on', r.code !== 0 && /second step/.test(r.err), r.err);
r = q(`select msm_admin_set_enabled('${ORG_A}', true)`, ANON);
expect('the public key cannot call the switch at all', r.code !== 0 && /permission denied/.test(r.err), r.err);
one(`select msm_admin_set_enabled('${ORG_A}', true)`, as(U.S));
one(`select msm_admin_set_enabled('${ORG_B}', true)`, as(U.S));
one(`select msm_admin_set_member('${ORG_A}', '${U.E}', 'editor')`, as(U.S));
one(`select msm_admin_set_member('${ORG_A}', '${U.V}', 'viewer')`, as(U.S));
const st = json(`select msm_admin_set_member('${ORG_B}', '${U.EB}', 'editor')`, as(U.S));
expect('ServOS adds named people and sees them', st?.enabled === true && st.members.length === 1, JSON.stringify(st));
const acc = json(`select msm_my_access()`, as(U.E));
expect('my access: the editor sees company A, on, as editor', acc.companies.length === 1 && acc.companies[0].role === 'editor' && acc.companies[0].enabled === true, JSON.stringify(acc));
expect('my access: the owner who is not named sees nothing', json(`select msm_my_access()`, as(U.O)).companies.length === 0);
expect('my access: an anonymous session sees nothing', (q(`select msm_my_access()`, ANON).code !== 0));
r = q(`insert into msm_members (org_id, user_id, role) values ('${ORG_A}', '${U.O}', 'editor')`, as(U.O));
expect('nobody adds themselves from the browser', r.code !== 0, r.err);

// ── import ──────────────────────────────────────────────────────────────────
function readRaw(loc) {
  return json(`select json_build_object(
    'locationId', '${loc}',
    'menus', coalesce((select json_agg(m order by m.sort_order, m.id) from menus m where m.location_id = '${loc}'), '[]'),
    'categories', coalesce((select json_agg(c order by c.sort_order, c.label, c.id) from menu_categories c where c.location_id = '${loc}'), '[]'),
    'items', coalesce((select json_agg(i order by i.sort_order, i.id) from menu_items i where i.location_id = '${loc}'), '[]'),
    'links', coalesce((select json_agg(json_build_object('menu_id', l.menu_id, 'category_id', l.category_id, 'sort_order', l.sort_order) order by l.menu_id, l.category_id) from menu_category_links l join menus m on m.id = l.menu_id where m.location_id = '${loc}'), '[]'),
    'groups', coalesce((select json_agg(g order by g.sort_order, g.id) from modifier_groups g where g.location_id = '${loc}'), '[]'),
    'taxRates', coalesce((select json_agg(t order by t.rate desc, t.id) from tax_rates t where t.location_id::text = '${loc}' and t.active), '[]'),
    'printRouting', (select to_json(p) from print_routing p where p.location_id::text = '${loc}' limit 1),
    'printers', coalesce((select json_agg(p order by p.id) from printers p where p.location_id::text = '${loc}'), '[]'),
    'taxProfiles', '[]'::json, 'taxProfileLines', '[]'::json,
    'location', (select json_build_object('id', l.id, 'org_id', l.org_id, 'name', l.name, 'timezone', l.timezone, 'default_tax_profile_id', l.default_tax_profile_id) from locations l where l.id::text = '${loc}'))`);
}
let n = 0;
const idGen = () => `d0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const sites = [
  { location_id: LA1, name: 'Site A1', venue_menu_id: 'menu-a1', raw: readRaw(LA1) },
  { location_id: LA2, name: 'Site A2', venue_menu_id: `menu-a2_${sfx(LA2)}`, raw: readRaw(LA2) },
];
const proposal = proposeImport(sites, { idGen });
const built = buildCentral(proposal, sites, {}, { idGen });
expect('import self check: publishing now would change 0 things at 0 sites', built.check.ok && built.check.writes === 0, JSON.stringify(built.check));
const payload = importPayload(built.central, { orgId: ORG_A, name: 'Group menu', description: 'All sites' });

// Refusals first (each rolls back).
const badSite = JSON.parse(JSON.stringify(payload));
badSite.sites.push({ location_id: LB1, venue_menu_id: 'menu-b1' });
r = q(`select msm_import_commit(${lit(badSite)})`, as(U.E));
expect('import refuses a site of another company', r.code !== 0 && /not in this company/.test(r.err), r.err);
const badItem = JSON.parse(JSON.stringify(payload));
badItem.products[0].sites[0].venue_item_id = 'm-b';
r = q(`select msm_import_commit(${lit(badItem)})`, as(U.E));
expect('import refuses a product id from another venue', r.code !== 0 && /not at the site/.test(r.err), r.err);
r = q(`select msm_import_commit(${lit(payload)})`, as(U.V));
expect('a viewer cannot import', r.code !== 0 && /editor/.test(r.err), r.err);
r = q(`select msm_import_commit(${lit(payload)})`, as(U.EB));
expect('an editor of another company cannot import into this one', r.code !== 0 && /editor/.test(r.err), r.err);
const imp = json(`select msm_import_commit(${lit(payload)})`, as(U.E));
expect('import writes the group menu: version 1, 0 changes', imp.ok && imp.words.includes('0 changes at 0 sites') && imp.sites === 2, JSON.stringify(imp));
const menuId = imp.menu_id;
r = q(`select msm_import_commit(${lit(payload)})`, as(U.E));
expect('a second import is refused', r.code !== 0 && /already has a group menu/.test(r.err), r.err);
expect('import changed nothing at any venue (no push, no row stamped)', one(`select count(*) from config_pushes`) === '1');

// ── row level security ──────────────────────────────────────────────────────
r = q(`select count(*) from msm_products`, ANON);
expect('the public key cannot read the group menu', r.code !== 0 && /permission denied/.test(r.err), r.err);
expect('a viewer reads the group menu', Number(one(`select count(*) from msm_products`, as(U.V))) > 0);
expect('the owner who is not named reads nothing', one(`select count(*) from msm_products`, as(U.O)) === '0');
expect('an editor of another company reads nothing of this one', one(`select count(*) from msm_products`, as(U.EB)) === '0');
expect('ServOS reads it', Number(one(`select count(*) from msm_products`, as(U.S))) > 0);
expect('without the second step even an editor reads nothing (fence)', one(`select count(*) from msm_products`, as(U.E, 'aal1')) === '0');
r = q(`update msm_products set default_price = 9`, as(U.E));
expect('central rows have no write rule: an editor updates nothing directly', r.code !== 0 || /UPDATE 0/.test(r.out) || r.out === '', r.err || r.out);
expect('central row unchanged', one(`select count(*) from msm_products where default_price = 9`) === '0');
r = q(`insert into msm_change_sets (menu_id, org_id, title) values ('${menuId}', '${ORG_A}', 'Try')`, as(U.V));
expect('a viewer cannot make a set of changes', r.code !== 0 && /row-level security/.test(r.err), r.err);
r = q(`insert into msm_change_sets (menu_id, org_id, title) values ('${menuId}', '${ORG_A}', 'Try')`, as(U.O));
expect('the owner who is not named cannot make a set of changes', r.code !== 0, r.err);
r = q(`insert into msm_change_sets (menu_id, org_id, title, status) values ('${menuId}', '${ORG_A}', 'Sneaky', 'scheduled')`, as(U.E));
expect('a set always starts as a draft', r.code !== 0 && /draft/.test(r.err), r.err);
const SET1 = json(`insert into msm_change_sets (menu_id, org_id, title) values ('${menuId}', '${ORG_B}', 'Monday price rise') returning to_json(id)`, as(U.E));
expect('an editor makes a named draft (company taken from the menu, not the request)', one(`select org_id from msm_change_sets where id = '${SET1}'`) === ORG_A);

// ── staging guards ──────────────────────────────────────────────────────────
const central = () => json(`select json_build_object(
  'menu', (select to_json(m) from msm_menus m where m.id = '${menuId}'),
  'sites', coalesce((select json_agg(s) from msm_menu_sites s where s.menu_id = '${menuId}'), '[]'),
  'categories', coalesce((select json_agg(c) from msm_categories c where c.menu_id = '${menuId}'), '[]'),
  'catSites', coalesce((select json_agg(x) from msm_category_sites x join msm_categories c on c.id = x.category_id where c.menu_id = '${menuId}'), '[]'),
  'groups', coalesce((select json_agg(g) from msm_modifier_groups g where g.menu_id = '${menuId}'), '[]'),
  'groupSites', coalesce((select json_agg(x) from msm_modifier_group_sites x join msm_modifier_groups g on g.id = x.group_id where g.menu_id = '${menuId}'), '[]'),
  'products', coalesce((select json_agg(p) from msm_products p where p.menu_id = '${menuId}'), '[]'),
  'productSites', coalesce((select json_agg(x) from msm_product_sites x join msm_products p on p.id = x.product_id where p.menu_id = '${menuId}'), '[]'))`);
let C = central();
const latte = C.products.find((p) => p.name === 'Latte');
const oat = C.products.find((p) => p.name === 'Oat milk');
const hot = C.categories.find((c) => c.label === 'Hot drinks');
expect('the import kept one Latte for both sites with the master price and an override', latte && Number(latte.default_price) === 3 && C.productSites.filter((s) => s.product_id === latte.id).length === 2
  && Number(C.productSites.find((s) => s.product_id === latte.id && s.location_id === LA2).price) === 3.2, JSON.stringify(C.productSites));
const stage = (row, who = as(U.E)) => q(`insert into msm_changes (change_set_id, menu_id, org_id, target, entity_id, location_id, op, after, before)
  values ('${row.set}', '${menuId}', '${ORG_A}', '${row.target}', '${row.entity}', ${row.loc ? `'${row.loc}'` : 'null'}, '${row.op}', ${lit(row.after || {})}, ${lit(row.before || {})})`, who);
r = stage({ set: SET1, target: 'product_site', entity: latte.id, loc: LB1, op: 'update', after: { price: 1 } });
expect('staging a site of another company is refused', r.code !== 0 && /not in this company/.test(r.err), r.err);
r = stage({ set: SET1, target: 'product', entity: latte.id, op: 'update', after: { id: 'x' } });
expect('staging a field that is not allowed is refused', r.code !== 0 && /cannot be changed here/.test(r.err), r.err);
r = stage({ set: SET1, target: 'product', entity: '00000000-0000-4000-8000-000000000000', op: 'update', after: { name: 'x' } });
expect('staging a product that is not in this menu is refused', r.code !== 0 && /not in this group menu/.test(r.err), r.err);
r = stage({ set: SET1, target: 'product_site', entity: latte.id, loc: LA1, op: 'update', after: { kept: { centre_id: 'x' } } });
expect('a site can keep only the allowed venue fields', r.code !== 0 && /cannot keep/.test(r.err), r.err);
r = stage({ set: SET1, target: 'product_site', entity: oat.id, loc: LA2, op: 'create', after: { venue_item_id: 'm-b', active: true } });
expect('a new product at a site cannot take another venue\'s product id', r.code !== 0 && /another site/.test(r.err), r.err);
r = stage({ set: SET1, target: 'product', entity: latte.id, op: 'update', after: { default_price: 3.10 }, before: { default_price: 3 } }, as(U.EB));
expect('an editor of another company cannot stage into this set', r.code !== 0, r.err);
r = stage({ set: SET1, target: 'product', entity: latte.id, op: 'update', after: { default_price: 3.10 }, before: { default_price: 3 } });
expect('an editor stages a default price', r.code === 0, r.err);
const XMAS_CAT = 'e0000000-0000-4000-8000-000000000001';
const XMAS = 'e0000000-0000-4000-8000-000000000002';
r = stage({ set: SET1, target: 'category', entity: XMAS_CAT, op: 'create', after: { label: 'Christmas', sort_order: 5, route_like_id: hot.id } });
expect('a new category (sent like Hot drinks) is staged', r.code === 0, r.err);
r = stage({ set: SET1, target: 'product', entity: XMAS, op: 'create', after: { name: 'Gingerbread latte', category_id: XMAS_CAT, default_price: 3.95, tax_rate_name: 'VAT', tax_rate_percent: 20, type: 'simple', sold_alone: true } });
expect('a new product in it is staged', r.code === 0, r.err);
r = stage({ set: SET1, target: 'product_site', entity: XMAS, loc: LA1, op: 'create', after: { venue_item_id: `msm-e00000000000_${sfx(LA1)}`, active: true } });
expect('the new product is staged on at site A1', r.code === 0, r.err);

// ── schedule, frozen, unschedule ────────────────────────────────────────────
r = q(`select msm_schedule_set('${SET1}', '2020-01-01 06:00', 5, true)`, as(U.E));
expect('a time already passed is refused', r.code !== 0 && /already passed/.test(r.err), r.err);
const sch = json(`select msm_schedule_set('${SET1}', '2030-10-27 06:00', 5, true)`, as(U.E));
expect('scheduling works out each site\'s due time on its own clock (06:00 GMT less 5 minutes)', sch.ok && sch.sites.every((s) => new Date(s.due_at).toISOString() === '2030-10-27T05:55:00.000Z'), JSON.stringify(sch));
r = stage({ set: SET1, target: 'product', entity: latte.id, op: 'update', after: { name: 'Big latte' } });
expect('a scheduled set is frozen: no new change lands in it', r.code !== 0 && /cannot be changed/.test(r.err), r.err);
r = q(`update msm_change_sets set status = 'draft' where id = '${SET1}'`, as(U.E));
expect('the status cannot be moved from the browser', r.code !== 0, r.err);
r = q(`delete from msm_changes where change_set_id = '${SET1}'`, as(U.E));
expect('a scheduled set\'s changes cannot be removed', r.code !== 0, r.err);
expect('unschedule: back to a draft with every change kept', json(`select msm_unschedule_set('${SET1}')`, as(U.E)).status === 'draft'
  && one(`select count(*) from msm_changes where change_set_id = '${SET1}'`) === '4' && one(`select count(*) from msm_versions where change_set_id = '${SET1}'`) === '0');
// The clock: Postgres and msmSchedule.js agree on the clock change weekends.
for (const [local, tz] of [['2026-10-25 01:30', 'Europe/London'], ['2026-03-29 01:30', 'Europe/London'], ['2026-03-08 02:30', 'America/Los_Angeles'], ['2026-11-01 01:30', 'America/Los_Angeles'], ['2026-07-01 06:00', 'Europe/London']]) {
  const pg = one(`select to_char(('${local}'::timestamp at time zone '${tz}') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI')`);
  const js = new Date(localToUtc(local.replace(' ', 'T'), tz)).toISOString().slice(0, 16);
  expect(`the database and the screen agree: ${local} ${tz} is ${pg}`, pg === js, `pg ${pg} js ${js}`);
}

// ── publish now, run by the server ──────────────────────────────────────────
const pub = json(`select msm_publish_now('${SET1}', true)`, as(U.E));
expect('publish now freezes the set into a version due now', pub.ok && pub.sites.length === 2, JSON.stringify(pub));
const V1 = pub.version_id;
r = q(`select msm_claim_due(5)`, as(U.E));
expect('only the server can claim due runs', r.code !== 0 && /permission denied/.test(r.err), r.err);
const claimed = one(`select json_agg(c) from msm_claim_due(5) c`, SERVICE);
expect('the server claims both sites', JSON.parse(claimed).length === 2, claimed);
expect('a second claim finds nothing (claimed rows are taken)', one(`select count(*) from msm_claim_due(5)`, SERVICE) === '0');
const started = json(`select msm_start_version('${V1}')`, SERVICE);
expect('starting the version applies the set to the central tables once', started.ok && !started.already && started.version_no === 2 && started.changes.length === 4, JSON.stringify(started));
expect('starting again does nothing (idempotent)', json(`select msm_start_version('${V1}')`, SERVICE).already === true);
expect('central default price is now 3.10', one(`select default_price from msm_products where id = '${latte.id}'`) === '3.10');

function runSite(versionId, loc, { tamper = null, writesOverride = null } = {}) {
  const fp = one(`select msm_venue_fingerprint('${loc}')`, SERVICE);
  const raw = readRaw(loc);
  const changes = json(`select json_agg(x) from msm_changes x where change_set_id = (select change_set_id from msm_versions where id = '${versionId}')`);
  const plan = planSite({ central: central(), touched: touchedFromChanges(changes || []), locationId: loc, orgId: ORG_A, venue: raw });
  const health = checkSite(plan);
  const last = json(`select snapshot from config_pushes where location_id = '${loc}' order by created_at desc limit 1`);
  const snap = buildMsmSnapshot({ raw: appliedRaw(raw, plan), last, pushSource: { versionId, title: 'Monday price rise', applyWhenIdle: true }, pushedBy: 'Multi site menu: Editor A', now: 1790000000000, resort: plan.writes.items.insert.length > 0 });
  if (tamper) one(tamper);
  const res = q(`select msm_apply_site('${versionId}', '${loc}', ${lit(writesOverride || plan.writes)}, ${lit(snap)}, '${fp}', ${lit(plan.counts)}, 'Multi site menu: Editor A', ${lit(countsWords(plan.counts)).replace('::jsonb', '::text')})`, SERVICE);
  return { plan, health, res, out: res.code ? null : JSON.parse(res.out || 'null') };
}
const a1 = runSite(V1, LA1);
expect('site A1: health check passes (the new category is sent like Hot drinks)', a1.health.ok, JSON.stringify(a1.health));
expect('site A1: published', a1.out?.ok && a1.out.push_id, a1.res.err);
const lat = json(`select to_json(i) from menu_items i where id = 'm-latte'`);
expect('site A1: the Latte is 3.10, its Lunch menu price untouched, its own sort and scope untouched', Number(lat.pricing.base) === 3.1 && lat.pricing.menus['menu-a1'].base === 2.5 && lat.scope === 'shared');
expect('site A1: updated_at stamped by the server clock', new Date(lat.updated_at) > new Date(Date.now() - 600000));
const xm = json(`select to_json(i) from menu_items i where id = 'msm-e00000000000_${sfx(LA1)}'`);
expect('site A1: the new product is there, in a new category, with the VAT rate mapped by name and rate', xm && xm.cat && xm.cat.startsWith('msmc-') && xm.tax_rate_id === VAT_A1 && Number(xm.pricing.base) === 3.95 && xm.scope === 'local' && xm.org_id === ORG_A, JSON.stringify(xm));
expect('site A1: the new category is on the menu (menu id and link)', one(`select count(*) from menu_categories c join menu_category_links l on l.category_id = c.id and l.menu_id = 'menu-a1' where c.id = '${xm.cat}' and c.menu_id = 'menu-a1'`) === '1');
expect('site A1: the kitchen centre now takes the new category', one(`select routing #> '{pc-k,assignedCategories}' ? '${xm.cat}' from print_routing where location_id = '${LA1}'`) === 't');
expect('site A1: the category map is recorded centrally', one(`select venue_category_id from msm_category_sites where category_id = '${XMAS_CAT}' and location_id = '${LA1}'`) === xm.cat);
const push = json(`select to_json(p) from config_pushes p where id = '${a1.out.push_id}'`);
expect('site A1: a config push like Push to POS, with the menu, the carried keys and pushSource', push.snapshot.locationId === LA1 && push.snapshot.pushSource.kind === 'msm' && push.snapshot.instructionGroupDefs.length === 1
  && !('tables' in push.snapshot) && !('quickScreenIds' in push.snapshot) && push.snapshot.menuItems.some((i) => i.id === 'm-latte' && i.variantLabel === 'Regular' && i.srvAt), JSON.stringify(push.snapshot).slice(0, 400));
expect('site A1: an activity feed entry in words', one(`select body from activity_events where location_id = '${LA1}' and ref_id = '${V1}'`).length > 3);
expect('site A1: the exact before and after of every write is kept (audit)', json(`select writes from msm_version_sites where version_id = '${V1}' and location_id = '${LA1}'`).some((w) => w.table === 'items' && w.id === 'm-latte' && w.before.pricing.base === 3 && w.after.pricing.base === 3.1));
const again = q(`select msm_apply_site('${V1}', '${LA1}', '{}'::jsonb, null, 'x')`, SERVICE);
expect('a second apply of the same site does nothing (idempotent)', again.code === 0 && JSON.parse(again.out).already === true, again.err);
const a2 = runSite(V1, LA2);
expect('site A2: its own price override is kept; nothing to write, no push', a2.out?.ok && a2.plan.empty && !a2.out.push_id && one(`select status from msm_version_sites where version_id = '${V1}' and location_id = '${LA2}'`) === 'nothing', JSON.stringify(a2.plan.lines));
expect('site A2: the Latte still 3.20', one(`select pricing->>'base' from menu_items where id = 'm-latte_${sfx(LA2)}'`) === '3.20');
expect('the version and the set are done', one(`select status from msm_versions where id = '${V1}'`) === 'done' && one(`select status from msm_change_sets where id = '${SET1}'`) === 'done');

// ── a venue saved in between: refused whole ─────────────────────────────────
const mkSet = (title) => json(`insert into msm_change_sets (menu_id, org_id, title) values ('${menuId}', '${ORG_A}', '${title}') returning to_json(id)`, as(U.E));
const SET2 = mkSet('Oat milk up');
stage({ set: SET2, target: 'product_site', entity: oat.id, loc: LA1, op: 'update', after: { price: 0.5 }, before: { price: null } });
const V2 = json(`select msm_publish_now('${SET2}', true)`, as(U.E)).version_id;
one(`select count(*) from msm_claim_due(5)`, SERVICE);
json(`select msm_start_version('${V2}')`, SERVICE);
const raced = runSite(V2, LA1, { tamper: `update menu_items set description = 'saved in Back Office' where id = 'm-latte'` });
expect('a venue saved between the read and the write is refused whole (fingerprint)', raced.out && raced.out.ok === false && raced.out.reason === 'changed', raced.res.err || raced.res.out);
expect('nothing was written by the refused apply', one(`select pricing->>'base' from menu_items where id = 'm-oat'`) === '0.40');
const okRun = runSite(V2, LA1);
expect('read again, it publishes', okRun.out?.ok && okRun.out.push_id, okRun.res.err);
expect('the sub item is 0.50', one(`select pricing->>'base' from menu_items where id = 'm-oat'`) === '0.5');
expect('the option on the Milk group FOLLOWS its sub item: 0.50 (review blocker 2)', one(`select options->0->>'price' from modifier_groups where id = 'mgd-milk'`) === '0.5'
  && one(`select options->0->>'id' from modifier_groups where id = 'mgd-milk'`) === 'opt-1');

// ── the write path refuses what it must ─────────────────────────────────────
const SET3 = mkSet('Probe');
stage({ set: SET3, target: 'product', entity: latte.id, op: 'update', after: { description: 'probe' }, before: { description: '' } });
const V3 = json(`select msm_publish_now('${SET3}', true)`, as(U.E)).version_id;
one(`select count(*) from msm_claim_due(5)`, SERVICE);
json(`select msm_start_version('${V3}')`, SERVICE);
const probe = (writes) => runSite(V3, LA1, { writesOverride: writes }).res;
r = probe({ items: { update: [{ id: 'm-b', set: { name: 'hijack' } }] } });
expect('apply refuses to update a product of another venue', r.code !== 0 && /not at this site/.test(r.err), r.err);
r = probe({ items: { insert: [{ id: 'm-latte', name: 'dup' }] } });
expect('apply refuses an insert whose id exists', r.code !== 0 && /already taken/.test(r.err), r.err);
r = probe({ items: { update: [{ id: 'm-latte', set: { centre_id: 'pc-x' } }] } });
expect('apply refuses a column publish may not write (print centre is venue owned)', r.code !== 0 && /may not write/.test(r.err), r.err);
r = probe({ items: { update: [{ id: 'm-latte', set: { cat: 'cat-b' } }] } });
expect('apply refuses a category of another venue', r.code !== 0 && /not at this site/.test(r.err), r.err);
r = probe({ items: { update: [{ id: 'm-latte', pricing: { menus: {} } }] } });
expect('apply refuses to write the venue\'s menu tier prices', r.code !== 0 && /may not write/.test(r.err), r.err);
expect('none of the refused applies wrote anything', one(`select name from menu_items where id = 'm-b'`) === 'B coffee' && one(`select coalesce(centre_id, '') from menu_items where id = 'm-latte'`) === '');

// ── failures, retry, the ledger, late, the job ─────────────────────────────
one(`select msm_fail_site('${V3}', '${LA2}', 'Site A2 has no 20% VAT rate.')`, SERVICE);
expect('a failed site says why in words', one(`select error from msm_version_sites where version_id = '${V3}' and location_id = '${LA2}'`).includes('VAT'));
r = q(`select msm_retry_site('${V3}', '${LA2}')`, as(U.V));
expect('a viewer cannot retry', r.code !== 0, r.err);
expect('an editor retries a failed site: it runs again at once', json(`select msm_retry_site('${V3}', '${LA2}')`, as(U.E)).status === 'scheduled');
expect('the notification ledger sends once', one(`select msm_note_notified('${V3}', '${LA2}', 'failed')`, SERVICE) === 't' && one(`select msm_note_notified('${V3}', '${LA2}', 'failed')`, SERVICE) === 'f');
one(`update msm_version_sites set status = 'scheduled', due_at = now() - interval '20 minutes', late_at = null where version_id = '${V3}' and location_id = '${LA2}'`);
expect('a run 15 minutes past its time is marked late, once', one(`select count(*) from msm_mark_late()`, SERVICE) === '1' && one(`select count(*) from msm_mark_late()`, SERVICE) === '0');
const before = one(`select count(*) from net.calls`);
one(`select msm_run_due()`);
const call = json(`select to_json(c) from net.calls c order by id desc limit 1`);
expect('the job posts to msm-publish when something is due, with the key in a header', Number(one(`select count(*) from net.calls`)) === Number(before) + 1 && call.url.endsWith('/functions/v1/msm-publish') && call.headers['x-cron-key'].length >= 32);
const cronKey = one(`select decrypted_secret from vault.decrypted_secrets where name = 'msm_cron_key'`);
expect('the cron key check: right key yes, wrong key no, short no', one(`select msm_cron_ok('${cronKey}')`, SERVICE) === 't' && one(`select msm_cron_ok(repeat('0', 64))`, SERVICE) === 'f' && one(`select msm_cron_ok('')`, SERVICE) === 'f');
r = q(`select msm_cron_ok('${cronKey}')`, as(U.E));
expect('a signed in person cannot even ask the cron key check', r.code !== 0 && /permission denied/.test(r.err), r.err);
one(`update msm_version_sites set status = 'done' where status in ('scheduled', 'running')`);
const before2 = one(`select count(*) from net.calls`);
one(`select msm_run_due()`);
expect('the job posts nothing when nothing is due', one(`select count(*) from net.calls`) === before2);

// ── cancel, switch off pauses, the lock list ────────────────────────────────
const SET4 = mkSet('Christmas off');
stage({ set: SET4, target: 'product_site', entity: XMAS, loc: LA1, op: 'update', after: { active: false }, before: { active: true } });
json(`select msm_schedule_set('${SET4}', '2031-01-02 06:00', 5, true)`, as(U.E));
expect('cancel: a scheduled set will not run', json(`select msm_cancel_set('${SET4}')`, as(U.E)).status === 'cancelled'
  && one(`select count(*) from msm_version_sites vs join msm_versions v on v.id = vs.version_id where v.change_set_id = '${SET4}' and vs.status = 'cancelled'`) === '1');
const SET5 = mkSet('While off');
stage({ set: SET5, target: 'product_site', entity: XMAS, loc: LA1, op: 'update', after: { active: false }, before: { active: true } });
json(`select msm_publish_now('${SET5}', true)`, as(U.E));
expect('the lock list: a venue user sees the managed products of their venue', Number(one(`select count(*) from msm_managed_items('${LA1}')`, as(U.O))) >= 3);
expect('the lock list: nothing for a venue the caller does not use', one(`select count(*) from msm_managed_items('${LA1}')`, as(U.EB)) === '0');
one(`select msm_admin_set_enabled('${ORG_A}', false)`, as(U.S));
expect('switched off: the server claims nothing for that company (scheduled sets pause)', one(`select count(*) from msm_claim_due(5)`, SERVICE) === '0');
expect('switched off: members read nothing', one(`select count(*) from msm_products`, as(U.V)) === '0');
expect('switched off: the lock lifts', one(`select count(*) from msm_managed_items('${LA1}')`, as(U.O)) === '0');
r = q(`insert into msm_change_sets (menu_id, org_id, title) values ('${menuId}', '${ORG_A}', 'x')`, as(U.E));
expect('switched off: editors cannot stage', r.code !== 0, r.err);
one(`select msm_admin_set_enabled('${ORG_A}', true)`, as(U.S));
expect('switched on again: the paused set runs', one(`select count(*) from msm_claim_due(5)`, SERVICE) === '1');

// ── roll back ───────────────────────────────────────────────────────────────
const menusBefore = one(`select count(*) from menu_items`);
r = psql(['-d', DB, '-1', '-At', '-f', RB]);
expect('the roll back runs', r.code === 0, r.err);
expect('the roll back leaves no msm_ table, function, job or key', r.out.split('\n').pop() === '0|0|0|0', r.out);
expect('the roll back leaves every venue row', one(`select count(*) from menu_items`) === menusBefore);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
