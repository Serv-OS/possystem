// supabase/tests/multi_site_menu/menus.mjs
//
// SEVERAL MENUS IN ONE GROUP MENU (5.12.116, 20261214a_OPS_multi_site_menu_several_menus.sql) on the
// same throwaway Postgres as run.mjs, driven end to end with the real planner and push builder.
// Called by run.mjs after round 2 (its database, people and helpers are passed in). It applies
// 20261211a and 20261213a first, as Ops has them, then 20261214a, and rolls all three back at the
// end so run.mjs's own roll back checks see the database it expects.
//
// What it proves:
//   * 20261214a applies as one transaction, twice, and its check row reads as the file says;
//   * the guard takes the two new fields and refuses a bad shape of either;
//   * a new group menu "Catering" matched to a site's own Catering menu uses THAT menu, and at a
//     site with none publish makes one (never the default, last in the list);
//   * a category only on Catering is made with that menu as its home and never touches Main; a
//     Main category ticked into Catering gets a link there and keeps its home;
//   * a site with no default menu gets its main menu made the default in that same publish, so the
//     menu a POS with no menu picked resolves to (lib/menus/resolveActiveMenu.js) is still Main;
//     a site that has a default is not touched;
//   * unticking takes the link away again; the site's own menus and links are never touched;
//   * apply refuses is_default false, and a menu the group menu does not manage;
//   * the roll back refuses while a menu is in use, then puts every function back exactly.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraVenueMenuId } from '../../functions/_shared/msmMenus.js';
import { resolveActiveMenu } from '../../../src/lib/menus/resolveActiveMenu.js';
import { lineWords } from '../../functions/_shared/msmPlan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGS = path.resolve(HERE, '..', '..', 'migrations');
const file = (n) => path.join(MIGS, n);

export async function run(h) {
  const { q, one, json, lit, psql, expect, central, readRaw, mkSet, stage, runSite, LA1, LA2, U, as, SERVICE, sfx, DB } = h;
  let r;
  const publish = (set) => {
    const V = json(`select msm_publish_now('${set}', true)`, as(U.E)).version_id;
    one(`select count(*) from msm_claim_due(20)`, SERVICE);
    json(`select msm_start_version('${V}')`, SERVICE);
    return V;
  };
  one(`update msm_version_sites set status = 'done' where status in ('scheduled', 'running')`);

  // ── the three files, as Ops has them ──────────────────────────────────────
  for (const f of ['20261211a_OPS_multi_site_menu_category_rename.sql', '20261213a_OPS_option_group_once_each.sql']) {
    r = psql(['-d', DB, '-1', '-At', '-f', file(f)]);
    expect(`several menus: ${f.slice(0, 9)} applies first, as on Ops`, r.code === 0, r.err);
  }
  const FN = `select string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname, pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'msm%'`;
  const before = one(FN);
  r = psql(['-d', DB, '-1', '-At', '-f', file('20261214a_OPS_multi_site_menu_several_menus.sql')]);
  expect('several menus: 20261214a applies as one transaction', r.code === 0, r.err);
  const once = one(FN);
  r = psql(['-d', DB, '-1', '-At', '-f', file('20261214a_OPS_multi_site_menu_several_menus.sql')]);
  expect('several menus: 20261214a applies a second time and changes nothing more', r.code === 0 && one(FN) === once, r.err);
  expect('several menus: the check row reads as the file says', r.out.split('\n').pop() === '2|t|t|t|t|4|0|t|0|0', r.out);

  // ── the guard ─────────────────────────────────────────────────────────────
  let C = central();
  const menuId = C.menu.id;
  const hot = C.categories.find((c) => c.label === 'Hot drinks');
  const CATER = '5e116000-0000-4000-8000-000000000001';
  const TRAYS = '5e116000-0000-4000-8000-000000000002';
  const TRAY = '5e116000-0000-4000-8000-000000000003';
  const SETG = mkSet('Menus guard');
  const menuChange = (set, list) => stage({ set, target: 'menu', entity: menuId, op: 'update', after: { extra_menus: list }, before: { extra_menus: [] } });
  for (const [why, bad] of [
    ['not a list', { a: 1 }], ['no name', [{ id: CATER }]], ['an id that is not one', [{ id: 'main', name: 'X' }]], ['a field nobody knows', [{ id: CATER, name: 'Catering', priority: 9 }]],
    ['the same id twice', [{ id: CATER, name: 'A' }, { id: CATER, name: 'B' }]], ['a site value that is not a menu id or false', [{ id: CATER, name: 'Catering', sites: { [LA1]: true } }]],
    ['nine menus', Array.from({ length: 9 }, (_, i) => ({ id: `f2000000-0000-4000-8000-00000000000${i}`, name: `M${i}` }))],
  ]) {
    r = menuChange(SETG, bad);
    expect(`several menus: the guard refuses a list of menus with ${why}`, r.code !== 0 && /list of menus/.test(r.err), r.err);
  }
  for (const [why, bad] of [['a word', 'main'], ['an empty list', []], ['a key that is not one', ['main', 'x y']], ['the same key twice', ['main', 'main']]]) {
    r = stage({ set: SETG, target: 'category', entity: hot.id, op: 'update', after: { menu_keys: bad } });
    expect(`several menus: the guard refuses a category's menus given as ${why}`, r.code !== 0 && /menus a category is on/.test(r.err), r.err);
  }
  r = stage({ set: SETG, target: 'category', entity: hot.id, op: 'update', after: { menu_keys: ['main', CATER], color: '#000000' } });
  expect('several menus: a category the group menu has still cannot change its colour', r.code !== 0 && /place and colour/.test(r.err), r.err);
  r = q(`insert into msm_changes (change_set_id, menu_id, org_id, target, entity_id, op, after) values ('${SETG}', '${menuId}', '${C.menu.org_id}', 'menu', '${menuId}', 'update', ${lit({ extra_menus: [{ id: CATER, name: 'Catering' }] })})`, as(U.V));
  expect('several menus: a viewer cannot stage a menu', r.code !== 0, r.err);
  expect('several menus: nothing refused was left in the draft', one(`select count(*) from msm_changes where change_set_id = '${SETG}'`) === '0');

  // ── the sites as they are: A1 has its own Catering menu, A2 has no default menu ──
  const MAIN1 = 'menu-a1';
  const MAIN2 = `menu-a2_${sfx(LA2)}`;
  one(`insert into menus (id, location_id, name, is_default, sort_order) values ('menu-a1-cater', '${LA1}', 'Catering', false, 3), ('menu-a1-bar', '${LA1}', 'Bar', false, 4)`);
  one(`insert into menu_category_links (menu_id, category_id) select 'menu-a1-bar', venue_category_id from msm_category_sites where category_id = '${hot.id}' and location_id = '${LA1}'`);
  one(`update menus set is_default = false where location_id = '${LA2}'`);
  const hot1 = one(`select venue_category_id from msm_category_sites where category_id = '${hot.id}' and location_id = '${LA1}'`);
  const hot2 = one(`select venue_category_id from msm_category_sites where category_id = '${hot.id}' and location_id = '${LA2}'`);
  const resolved = (loc) => { const raw = readRaw(loc); return resolveActiveMenu({ menus: raw.menus, categories: raw.categories, links: raw.links, timezone: 'Europe/London' }); };
  expect('several menus: before, a POS with no menu picked is on Main at both sites', resolved(LA1) === MAIN1 && resolved(LA2) === MAIN2, `${resolved(LA1)} ${resolved(LA2)}`);

  // ── Catering: matched at A1, made at A2; a Catering only category; Hot drinks on both ──
  const SET = mkSet('Catering menu');
  r = menuChange(SET, [{ id: CATER, name: 'Catering', sites: { [LA1]: 'menu-a1-cater' } }]);
  expect('several menus: a new menu, matched to site A1\'s own Catering menu, is staged', r.code === 0, r.err);
  r = stage({ set: SET, target: 'category', entity: TRAYS, op: 'create', after: { label: 'Trays', sort_order: 20, route_like_id: hot.id, menu_keys: [CATER] } });
  expect('several menus: a new category on Catering only is staged', r.code === 0, r.err);
  r = stage({ set: SET, target: 'category', entity: hot.id, op: 'update', after: { menu_keys: ['main', CATER] }, before: { menu_keys: null } });
  expect('several menus: Hot drinks ticked into Catering too is staged', r.code === 0, r.err);
  r = stage({ set: SET, target: 'product', entity: TRAY, op: 'create', after: { name: 'Pizza tray', category_id: TRAYS, default_price: 45, tax_rate_name: 'VAT', tax_rate_percent: 20, type: 'simple', sold_alone: true } });
  expect('several menus: a product in the Catering category is staged', r.code === 0, r.err);
  for (const loc of [LA1, LA2]) {
    r = stage({ set: SET, target: 'product_site', entity: TRAY, loc, op: 'create', after: { venue_item_id: `msm-5e1160000000_${sfx(loc)}`, active: true } });
    expect(`several menus: the product is staged on at ${loc === LA1 ? 'A1' : 'A2'}`, r.code === 0, r.err);
  }
  const V = publish(SET);
  C = central();
  expect('several menus: the publish saves the menu and both categories\' menus in the group menu',
    C.menu.extra_menus.length === 1 && C.menu.extra_menus[0].name === 'Catering'
    && JSON.stringify(C.categories.find((c) => c.id === TRAYS).menu_keys) === JSON.stringify([CATER])
    && JSON.stringify(C.categories.find((c) => c.id === hot.id).menu_keys) === JSON.stringify(['main', CATER]), JSON.stringify(C.menu.extra_menus));

  const a1 = runSite(V, LA1);
  expect('several menus, A1: published', a1.out?.ok && a1.out.push_id, a1.res.err || JSON.stringify(a1.health));
  expect('several menus, A1: no menu is made (its own Catering menu is used)', a1.plan.writes.menus.insert.length === 0 && one(`select count(*) from menus where location_id = '${LA1}'`) === '3');
  const trays1 = one(`select venue_category_id from msm_category_sites where category_id = '${TRAYS}' and location_id = '${LA1}'`);
  expect('several menus, A1: Trays is made on the Catering menu and is NOT on Main',
    one(`select menu_id from menu_categories where id = '${trays1}'`) === 'menu-a1-cater'
    && one(`select string_agg(menu_id, ',' order by menu_id) from menu_category_links where category_id = '${trays1}'`) === 'menu-a1-cater', one(`select menu_id from menu_categories where id = '${trays1}'`));
  expect('several menus, A1: Hot drinks keeps Main as its home and gains a link to Catering; its link to the site\'s own Bar menu is untouched',
    one(`select menu_id from menu_categories where id = '${hot1}'`) === MAIN1
    && one(`select string_agg(menu_id, ',' order by menu_id) from menu_category_links where category_id = '${hot1}'`) === `${MAIN1},menu-a1-bar,menu-a1-cater`, one(`select string_agg(menu_id, ',' order by menu_id) from menu_category_links where category_id = '${hot1}'`));
  expect('several menus, A1: it has a default menu already, so no menu row is changed', a1.plan.writes.menus.update.length === 0 && one(`select is_default from menus where id = '${MAIN1}'`) === 't');
  expect('several menus, A1: the words say which menu', a1.plan.lines.map((l) => lineWords(l, { [hot.id]: 'Hot drinks' })).includes('Hot drinks: now on the Catering menu'), JSON.stringify(a1.plan.lines.map((l) => lineWords(l, { [hot.id]: 'Hot drinks' }))));

  const a2 = runSite(V, LA2);
  const cater2 = extraVenueMenuId(CATER, LA2);
  expect('several menus, A2: published', a2.out?.ok && a2.out.push_id, a2.res.err || JSON.stringify(a2.health));
  const made = json(`select to_json(m) from menus m where id = '${cater2}'`);
  expect('several menus, A2: a Catering menu is made there, on, never the default, after its other menus', made && made.name === 'Catering' && made.is_default === false && made.is_active === true && made.location_id === LA2 && made.sort_order >= 1, JSON.stringify(made));
  const trays2 = one(`select venue_category_id from msm_category_sites where category_id = '${TRAYS}' and location_id = '${LA2}'`);
  expect('several menus, A2: Trays is on the new Catering menu only, Hot drinks on Main and Catering',
    one(`select menu_id from menu_categories where id = '${trays2}'`) === cater2
    && one(`select menu_id from menu_categories where id = '${hot2}'`) === MAIN2
    && one(`select count(*) from menu_category_links where category_id = '${hot2}' and menu_id = '${cater2}'`) === '1');
  expect('several menus, A2: it had NO default menu, so Main is made the default in the same publish', one(`select is_default from menus where id = '${MAIN2}'`) === 't'
    && a2.plan.lines.some((l) => l.table === 'menus' && l.column === 'is_default'), JSON.stringify(a2.plan.writes.menus));
  expect('several menus: after, a POS with no menu picked is still on Main at both sites', resolved(LA1) === MAIN1 && resolved(LA2) === MAIN2, `${resolved(LA1)} ${resolved(LA2)}`);
  const push2 = json(`select snapshot from config_pushes where id = '${a2.out.push_id}'`);
  expect('several menus, A2: the push the POS reads holds the new menu and Main as the default', push2.menus.some((m) => m.id === cater2) && push2.menus.some((m) => m.id === MAIN2 && (m.is_default === true || m.isDefault === true)), JSON.stringify(push2.menus));
  expect('several menus: the product is on sale in the Catering category at both sites', one(`select count(*) from menu_items where id like 'msm-5e1160000000_%' and archived = false and cat in ('${trays1}', '${trays2}')`) === '2');

  // ── publishing again changes nothing; unticking takes the link away ───────
  const SET2 = mkSet('Hot drinks off Catering');
  stage({ set: SET2, target: 'category', entity: hot.id, op: 'update', after: { menu_keys: null }, before: { menu_keys: ['main', CATER] } });
  const V2 = publish(SET2);
  const b1 = runSite(V2, LA1);
  const b2 = runSite(V2, LA2);
  expect('several menus: unticked, Hot drinks comes off Catering at both sites and stays on Main (and on A1\'s own Bar menu)',
    b1.out?.ok && b2.out?.ok
    && one(`select string_agg(menu_id, ',' order by menu_id) from menu_category_links where category_id = '${hot1}'`) === `${MAIN1},menu-a1-bar`
    && one(`select count(*) from menu_category_links where category_id = '${hot2}' and menu_id = '${cater2}'`) === '0'
    && one(`select menu_id from menu_categories where id = '${hot1}'`) === MAIN1, b1.res.err || b2.res.err);
  expect('several menus: Trays is still on Catering only', one(`select menu_id from menu_categories where id = '${trays2}'`) === cater2 && one(`select menu_id from menu_categories where id = '${trays1}'`) === 'menu-a1-cater');

  // ── a site left out; the write path refuses what it must ──────────────────
  const SET3 = mkSet('Probe menus');
  stage({ set: SET3, target: 'product', entity: TRAY, op: 'update', after: { description: 'probe' }, before: { description: '' } });
  const V3 = publish(SET3);
  const probe = (writes) => runSite(V3, LA1, { writesOverride: writes }).res;
  r = probe({ menus: { update: [{ id: MAIN1, set: { is_default: false } }] } });
  expect('several menus: apply refuses to take a default menu away', r.code !== 0 && /only make a menu the default/.test(r.err), r.err);
  r = probe({ menus: { update: [{ id: 'menu-a1-bar', set: { is_default: true } }] } });
  expect('several menus: apply refuses to change a menu the group menu does not manage', r.code !== 0 && /does not manage/.test(r.err), r.err);
  r = probe({ links: { insert: [{ menu_id: 'menu-b1', category_id: hot1 }] } });
  expect('several menus: apply refuses a link to another company\'s menu', r.code !== 0 && /outside this site/.test(r.err), r.err);
  expect('several menus: the refused applies wrote nothing', one(`select is_default from menus where id = '${MAIN1}'`) === 't' && one(`select is_default from menus where id = 'menu-a1-bar'`) === 'f');
  runSite(V3, LA1); runSite(V3, LA2);

  // ── roll back ─────────────────────────────────────────────────────────────
  r = psql(['-d', DB, '-1', '-At', '-f', file('20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql')]);
  expect('several menus: the roll back refuses while a group menu still has another menu', r.code !== 0 && /still has another menu/.test(r.err), r.err);
  one(`update msm_categories set menu_keys = null; update msm_menus set extra_menus = '[]'`);
  expect('several menus: the roll back also refuses while a publish that is still running holds a change to the menus', (() => { const x = psql(['-d', DB, '-1', '-At', '-f', file('20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql')]); return x.code !== 0 && /still holds a change to the menus/.test(x.err); })());
  // The harness has a third site these versions never ran at, so they are still running: settle them.
  one(`set local session_replication_role = replica; update msm_change_sets set status = 'done' where status = 'running' and id in (select change_set_id from msm_changes c where c.after ? 'extra_menus' or c.after ? 'menu_keys')`);
  r = psql(['-d', DB, '-1', '-At', '-f', file('20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql')]);
  expect('several menus: once nothing uses it, the roll back runs and reads 0|0', r.code === 0 && r.out.split('\n').pop() === '0|0', r.err || r.out);
  expect('several menus: the roll back puts every function back exactly as it was before 20261214a', one(FN) === before);
  for (const f of ['20261213a_OPS_option_group_once_each_ROLLBACK.sql', '20261211a_OPS_multi_site_menu_category_rename_ROLLBACK.sql']) {
    r = psql(['-d', DB, '-1', '-At', '-f', file(f)]);
    expect(`several menus: ${f.slice(0, 9)} rolls back after it`, r.code === 0, r.err);
  }
}
