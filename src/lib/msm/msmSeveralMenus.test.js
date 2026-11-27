// Multi site menu, 5.12.116: SEVERAL MENUS in one group menu, and "Shows on".
//
// Peter, 26 Nov 2026 (Mozz): "each site has multiple menus, they have online, instore ... catering
// menus all with different products ... we cant manage this in multi site menus", then: "the menu
// built is for instore and online but unlike the POS I dont want certain categories to show at
// all. The less menus the better. Then literal differences like menus with different products can
// have different menus like catering."
//
// So two things, both head office's, both in the one group menu:
//   1. ANOTHER MENU (Catering) for different products: a category is ticked into menus, publish
//      uses the site's own menu of that name or makes one (_shared/msmMenus.js, msmPlan 2b, 4a, 8).
//   2. SHOWS ON for the same menu on different screens: a product, or a whole category of them, is
//      hidden on the POS, the kiosk, online or delivery at every site (lib/soldAs.js notShownOn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { proposeImport, buildCentral, touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, siteDrift, mergeStaged } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite } from '../../../supabase/functions/_shared/msmHealth.js';
import { STAGE_FIELDS, CATEGORY_UPDATE_FIELDS, VENUE_UPDATE, checkChange } from '../../../supabase/functions/_shared/msmModel.js';
import {
  MAIN_MENU, allExtraMenus, extraMenus, groupMenus, menuKeysOf, menuKeysValue, toggleMenuKey, menuKeysWords, productMenuKeys,
  extraVenueMenuId, extraMenuAt, matchSiteMenus, extraMenuNameProblem, extraMenusShapeOk, menuKeysShapeOk, extraMenusChangeWords, menuKeyNames, MAX_EXTRA_MENUS,
} from '../../../supabase/functions/_shared/msmMenus.js';
import { resolveActiveMenu } from '../menus/resolveActiveMenu.js';
import { channelVisible } from '../channelMenu.js';
import {
  SHOWN_ON_KEYS, notShownOn, withNotShownOn, toggleShownOn, shownOnSummary, applyNotShownOn, holdsNotShownOn, sameShownOn, withGroupRules, notSoldAs,
} from '../soldAs.js';
import { lockedItemPatch } from './msmLock.js';
import { optionOnlyCategoryIds } from '../menuRules.js';
import {
  addMenuChanges, renameMenuChange, removeMenuChange, menuSiteChange, categoryMenuChange, menusReady, menusGuardWords,
  categoryShownOn, categoryShownOnChanges, categoryProducts, foundSiteMenus, foundMenuWords,
} from './msmEdit.js';
import { changeWords } from './msmWords.js';
import { summarise } from './msmSummary.js';
import { ownProducts } from './msmBringIn.js';
import { buildGridRows } from './msmGrid.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites } from './msmGroupFixture.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CATER = 'ca7e0000-0000-4000-8000-000000000001';
const ONLINE = '0a11e000-0000-4000-8000-000000000002';

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17', extra_menus: [] };
  const cat = central.categories.find((c) => !c.archived && !c.parent_id && [A, B].every((loc) => central.catSites.some((s) => s.category_id === c.id && s.location_id === loc)));
  const vCat = (loc, id = cat.id) => central.catSites.find((s) => s.category_id === id && s.location_id === loc)?.venue_category_id;
  const mainOf = (loc) => central.sites.find((s) => s.location_id === loc).venue_menu_id;
  const ctx = (changes = []) => ({ live: central, eff: applyChanges(central, changes).central });
  const plan = (changes, loc, venue = v[loc]) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });
  return { v, central, cat, vCat, mainOf, ctx, plan };
}
const menuChange = (central, list) => ({ target: 'menu', entity_id: central.menu.id, location_id: null, op: 'update', after: { extra_menus: list }, before: { extra_menus: [] } });
const keysChange = (cat, keys) => ({ target: 'category', entity_id: cat.id, location_id: null, op: 'update', after: { menu_keys: keys }, before: { menu_keys: null } });
const linksOf = (rows, vid) => rows.filter((l) => l.category_id === vid).map((l) => l.menu_id).sort();

// ── the model ───────────────────────────────────────────────────────────────

test('nothing set: every category is on the main menu only, and a group menu has one menu', () => {
  const menu = { extra_menus: [] };
  assert.deepEqual(groupMenus(menu), [{ key: 'main', name: 'Main', main: true }]);
  assert.deepEqual(menuKeysOf({ id: 'c', menu_keys: null }, new Map(), menu), [MAIN_MENU]);
  assert.deepEqual(menuKeysOf({ id: 'c' }, new Map(), { }), [MAIN_MENU], 'a database without the new columns reads the same');
  assert.equal(menuKeysValue([MAIN_MENU], menu), null, 'main only is saved as nothing at all');
});

test('a category is ticked into menus; a sub category follows its top category; a removed menu drops out', () => {
  const menu = { extra_menus: [{ id: CATER, name: 'Catering' }, { id: ONLINE, name: 'Web', archived: true }] };
  const top = { id: 't', parent_id: null, menu_keys: ['main', CATER, ONLINE] };
  const sub = { id: 's', parent_id: 't', menu_keys: null };
  const cats = new Map([[top.id, top], [sub.id, sub]]);
  assert.deepEqual(extraMenus(menu).map((m) => m.name), ['Catering']);
  assert.equal(allExtraMenus(menu).length, 2, 'a removed menu stays known, so publish can take categories off it');
  assert.deepEqual(menuKeysOf(top, cats, menu), ['main', CATER]);
  assert.deepEqual(menuKeysOf(sub, cats, menu), ['main', CATER], 'the sub category is on its top category\'s menus');
  assert.equal(menuKeysWords(['main', CATER], menu), 'Main and Catering');
  assert.deepEqual(toggleMenuKey(top, cats, menu, 'main', false).value, [CATER], 'Catering only');
  const only = { id: 'o', menu_keys: [CATER] };
  assert.equal(toggleMenuKey(only, new Map([[only.id, only]]), menu, CATER, false).ok, false, 'never on no menu at all');
  assert.deepEqual(toggleMenuKey(only, new Map([[only.id, only]]), menu, 'main', true).value, ['main', CATER]);
  // A product is on a menu through its category, or an "Also in" category.
  assert.deepEqual(productMenuKeys({ category_id: 't', extra_category_ids: [] }, cats, menu), ['main', CATER]);
  assert.deepEqual(productMenuKeys({ category_id: 'x', extra_category_ids: ['o'] }, new Map([[only.id, only]]), menu), [CATER]);
});

test('where a menu is at a site: matched to the site\'s own, the one publish made, to be made, or not there', () => {
  const m = { id: CATER, name: 'Catering', sites: { [A]: 'menu-a-cater', [B]: false } };
  const C = 'cccccccc-0000-4000-8000-0000000c0003';
  assert.deepEqual(extraMenuAt(m, A, new Map([['menu-a-cater', {}]])), { off: false, id: 'menu-a-cater', how: 'matched' });
  assert.deepEqual(extraMenuAt(m, B, new Map()), { off: true, id: null, how: 'off' });
  assert.deepEqual(extraMenuAt(m, C, new Map()), { off: false, id: null, how: 'new' });
  assert.deepEqual(extraMenuAt(m, C, new Map([[extraVenueMenuId(CATER, C), {}]])), { off: false, id: extraVenueMenuId(CATER, C), how: 'made' });
  assert.equal(extraMenuAt(m, A, new Map()).how, 'new', 'the matched menu was deleted at the site: a new one is made');
  assert.match(extraVenueMenuId(CATER, C), /^menu-msm-ca7e00000000_000c0003$/);
});

test('a new menu takes the site\'s own menu of the same name, never the main one, never one already used', () => {
  const menus = [
    { id: 'm1', location_id: A, name: 'Main' }, { id: 'c1', location_id: A, name: ' catering ' }, { id: 'c1b', location_id: A, name: 'Catering', sort_order: 5 },
    { id: 'm2', location_id: B, name: 'Main' }, { id: 'c2', location_id: B, name: 'Catering', is_active: false },
  ];
  assert.deepEqual(matchSiteMenus('Catering', menus, ['m1', 'm2']), { [A]: 'c1' });
  assert.deepEqual(matchSiteMenus('Catering', menus, ['c1']), { [A]: 'c1b' });
  assert.deepEqual(matchSiteMenus('', menus), {});
});

test('names and shapes: what the screens refuse is what the database refuses (20261214a)', () => {
  const menu = { extra_menus: [{ id: CATER, name: 'Catering' }] };
  assert.equal(extraMenuNameProblem(menu, 'Online'), '');
  assert.match(extraMenuNameProblem(menu, ' catering'), /already has a menu with that name/);
  assert.match(extraMenuNameProblem(menu, 'Main'), /already has its Main menu/);
  assert.match(extraMenuNameProblem(menu, ''), /Give the menu a name/);
  assert.equal(extraMenusShapeOk([{ id: CATER, name: 'Catering', sites: { [A]: 'menu-x', [B]: false } }]), true);
  for (const bad of [{}, [{ id: CATER }], [{ id: 'main', name: 'X' }], [{ id: CATER, name: 'C', priority: 1 }], [{ id: CATER, name: 'C', sites: { [A]: true } }],
    [{ id: CATER, name: 'A' }, { id: CATER, name: 'B' }], Array.from({ length: MAX_EXTRA_MENUS + 1 }, (_, i) => ({ id: `f2000000-0000-4000-8000-00000000000${i}`, name: `M${i}` }))]) {
    assert.equal(extraMenusShapeOk(bad), false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(menuKeysShapeOk(null), true);
  assert.equal(menuKeysShapeOk(['main', CATER]), true);
  for (const bad of ['main', [], ['main', 'x y'], ['main', 'main']]) assert.equal(menuKeysShapeOk(bad), false, JSON.stringify(bad));
  assert.equal(checkChange({ target: 'menu', op: 'update', after: { extra_menus: 'x' } }).ok, false);
  assert.equal(checkChange({ target: 'category', op: 'update', after: { menu_keys: [] } }).ok, false);
  assert.equal(checkChange({ target: 'category', op: 'update', after: { menu_keys: null } }).ok, true);
});

// ── the SQL file ────────────────────────────────────────────────────────────

test('20261214a: the live guard, the publish and the site write take exactly the fields the model names', () => {
  const sql = read('../../../supabase/migrations/20261214a_OPS_multi_site_menu_several_menus.sql');
  const rb = read('../../../supabase/migrations/20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql');
  const list = (s) => [...s.matchAll(/''([^']+)''/g)].map((m) => m[1]);
  const line = (re) => { const m = re.exec(sql); assert.ok(m, String(re)); return list(m[1]); };
  assert.deepEqual(line(/\n\s+'when ''menu'' then array\[([^\]]+'extra_menus'')\]',/), [...STAGE_FIELDS.menu]);
  assert.deepEqual(line(/\n\s+'when ''category'' then array\[([^\]]+'menu_keys'')\]',/), [...STAGE_FIELDS.category]);
  assert.deepEqual(line(/'v_upd_menus {2}constant text\[\] := array\[([^\]]+'is_default'')\];'/), [...VENUE_UPDATE.menus]);
  const rule = /where k <> all \(array\[([^\]]+)\]\)\) then\n\s+raise exception 'A category''s place and colour/.exec(sql);
  assert.deepEqual([...rule[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), [...CATEGORY_UPDATE_FIELDS]);
  assert.match(sql, /Publish may only make a menu the default, never take that away/);
  assert.match(sql, /add column if not exists extra_menus jsonb not null default '\[\]'::jsonb/);
  assert.match(sql, /add column if not exists menu_keys jsonb;/);
  // It patches the functions as they are on the database (never a copy from a repo file), and
  // stops when a line is not there exactly once.
  assert.match(sql, /v_def := pg_get_functiondef\(f\);/);
  assert.match(sql, /if v_n <> 1 then\n\s+raise exception/);
  assert.ok(!/create or replace function public\.msm_(changes_guard|start_version|apply_site)\(/.test(sql), 'the three big functions are never written whole');
  // The roll back swaps the very same lines back, and refuses while anything still uses a menu.
  const pairs = (s) => s.slice(s.indexOf('v_pairs constant text[] := array['), s.indexOf('  ];', s.indexOf('v_pairs constant text[] := array[')));
  assert.equal(pairs(rb), pairs(sql));
  assert.match(rb, /still has another menu/);
  assert.match(rb, /drop column if exists extra_menus/);
  for (const f of [sql, rb]) assert.ok(!new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`).test(f), 'no long dashes');
});

// ── the publish planner ─────────────────────────────────────────────────────

test('a group menu with no other menu: the plan is exactly what it was (nothing new is written, nothing reads as changed)', () => {
  const { v, central } = setup();
  for (const loc of [A, B]) {
    const plan = planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: loc, orgId: ORG, venue: v[loc] });
    assert.equal(plan.lines.length, 0, JSON.stringify(plan.lines.slice(0, 3)));
    assert.equal(plan.writes.menus.insert.length + plan.writes.menus.update.length + plan.writes.links.insert.length + plan.writes.links.delete.length, 0);
    assert.deepEqual(siteDrift(central, loc, v[loc]), []);
    assert.deepEqual(plan.menuIds, [central.sites.find((s) => s.location_id === loc).venue_menu_id]);
  }
});

test('Catering, matched at A and made at B: a category ticked in gets a link, keeps its home, and Main stays what a POS shows', () => {
  const { v, central, cat, vCat, mainOf, plan } = setup();
  v[A].menus.push({ id: 'menu-a-cater', location_id: A, name: 'Catering', is_default: false, is_active: true, sort_order: 4 });
  for (const m of v[B].menus) m.is_default = false;             // B has NO default menu (as the Mozz sites)
  const changes = [menuChange(central, [{ id: CATER, name: 'Catering', sites: { [A]: 'menu-a-cater' } }]), keysChange(cat, ['main', CATER])];

  const a = plan(changes, A);
  assert.equal(a.writes.menus.insert.length, 0, 'A already has a Catering menu: none is made');
  assert.deepEqual(a.writes.links.insert.map((l) => [l.menu_id, l.category_id]), [['menu-a-cater', vCat(A)]]);
  assert.equal(a.applied.categories.find((c) => c.id === vCat(A)).menu_id, mainOf(A), 'its home is still Main');
  assert.equal(a.writes.menus.update.length, v[A].menus.some((m) => m.is_default) ? 0 : 1);
  assert.ok(a.lines.map((l) => lineWords(l, { [cat.id]: cat.label })).includes(`${cat.label}: now on the Catering menu`));
  assert.ok(a.menuIds.includes('menu-a-cater') && a.menuIds.includes(mainOf(A)));
  assert.equal(checkSite(a).ok, true, JSON.stringify(checkSite(a)));

  const b = plan(changes, B);
  const made = extraVenueMenuId(CATER, B);
  assert.deepEqual(b.writes.menus.insert.map((m) => [m.id, m.name, m.is_default, m.is_active]), [[made, 'Catering', false, true]], 'B gets a Catering menu, never the default');
  assert.equal(b.writes.menus.insert[0].sort_order, v[B].menus.length, 'after its other menus');
  assert.deepEqual(b.writes.links.insert.map((l) => [l.menu_id, l.category_id]), [[made, vCat(B)]]);
  assert.deepEqual(b.writes.menus.update, [{ id: mainOf(B), set: { is_default: true } }], 'B had no default menu: Main becomes it in the same publish');
  for (const [p, loc] of [[a, A], [b, B]]) {
    assert.equal(resolveActiveMenu({ menus: p.applied.menus, categories: p.applied.categories, links: p.applied.links, timezone: 'Europe/London' }), mainOf(loc), 'a POS with no menu picked is on Main');
  }
});

test('a Catering only category: made on the Catering menu, never on Main; an existing one moves there', () => {
  const { central, cat, vCat, mainOf, plan } = setup();
  const TRAYS = 'ca7e0000-0000-4000-8000-0000000000aa';
  const TRAY = 'ca7e0000-0000-4000-8000-0000000000ab';
  const menu = menuChange(central, [{ id: CATER, name: 'Catering' }]);
  const made = extraVenueMenuId(CATER, A);
  const fresh = plan([menu,
    { target: 'category', entity_id: TRAYS, location_id: null, op: 'create', after: { label: 'Trays', sort_order: 30, route_like_id: cat.id, menu_keys: [CATER] } },
    { target: 'product', entity_id: TRAY, location_id: null, op: 'create', after: { name: 'Pizza tray', category_id: TRAYS, default_price: 45, type: 'simple', sold_alone: true } },
    { target: 'product_site', entity_id: TRAY, location_id: A, op: 'create', after: { venue_item_id: `msm-ca7e000000ab_${A.slice(-8)}`, active: true } },
  ], A);
  const row = fresh.writes.categories.insert.find((c) => c.label === 'Trays');
  assert.ok(row, 'the category is made at the site');
  assert.equal(row.menu_id, made, 'its home is the Catering menu');
  assert.deepEqual(linksOf(fresh.writes.links.insert, row.id), [made], 'and it is not linked to Main');
  assert.equal(fresh.writes.menus.insert.length, 1);

  // An existing Main category moved to Catering only: off Main (home and link), on Catering.
  const moved = plan([menu, keysChange(cat, [CATER])], A);
  const after = moved.applied.categories.find((c) => c.id === vCat(A));
  assert.equal(after.menu_id, made);
  assert.ok(!moved.applied.links.some((l) => l.category_id === vCat(A) && l.menu_id === mainOf(A)), 'no link to Main is left');
  assert.ok(moved.lines.some((l) => l.table === 'categories' && l.column === 'menu_id' && l.several));
});

test('unticked again, a site left out, a menu removed: only the menus the group menu manages are touched', () => {
  const { v, central, cat, vCat, mainOf, plan } = setup();
  const made = extraVenueMenuId(CATER, A);
  // As it is after a publish: Catering made at A, the category linked to it, and to the site's OWN Bar menu.
  v[A].menus.push({ id: made, location_id: A, name: 'Catering', is_default: false, is_active: true, sort_order: 5 }, { id: 'menu-a-bar', location_id: A, name: 'Bar', is_default: false, is_active: true, sort_order: 6 });
  v[A].links.push({ menu_id: made, category_id: vCat(A), sort_order: 1 }, { menu_id: 'menu-a-bar', category_id: vCat(A), sort_order: 1 });
  central.menu.extra_menus = [{ id: CATER, name: 'Catering' }];
  central.categories.find((c) => c.id === cat.id).menu_keys = ['main', CATER];
  const same = planSite({ central, touched: touchedFromChanges([{ ...menuChange(central, central.menu.extra_menus) }, keysChange(cat, ['main', CATER])]), locationId: A, orgId: ORG, venue: v[A] });
  assert.equal(same.lines.length, 0, 'publishing it again writes nothing');

  const off = plan([{ ...keysChange(cat, null), before: { menu_keys: ['main', CATER] } }], A);
  assert.deepEqual(off.writes.links.delete, [{ menu_id: made, category_id: vCat(A) }], 'the Catering link goes, the Bar link is the site\'s own');
  assert.equal(off.applied.categories.find((c) => c.id === vCat(A)).menu_id, mainOf(A));

  const notHere = plan([{ ...menuChange(central, [{ id: CATER, name: 'Catering', sites: { [A]: false } }]), before: { extra_menus: central.menu.extra_menus } }], A);
  assert.deepEqual(notHere.writes.links.delete, [], 'a site left out is simply not written to (its menu stays as it is)');
  assert.equal(notHere.writes.menus.insert.length, 0);

  const gone = plan([{ ...menuChange(central, [{ id: CATER, name: 'Catering', archived: true }]), before: { extra_menus: central.menu.extra_menus } }], A);
  assert.deepEqual(gone.writes.links.delete, [{ menu_id: made, category_id: vCat(A) }], 'a removed menu: the group\'s categories come off it');
  assert.ok(gone.applied.menus.some((m) => m.id === made), 'the site\'s menu itself stays');
  assert.ok(gone.applied.links.some((l) => l.menu_id === 'menu-a-bar' && l.category_id === vCat(A)));
});

// ── the edits ───────────────────────────────────────────────────────────────

test('adding a menu: matched by name, and what is already on the site\'s menu comes in ticked', () => {
  const { v, central, cat, vCat, ctx } = setup();
  assert.equal(menusReady(central), true);
  assert.equal(menusReady({ menu: { id: 'x' } }), false, 'a database without 20261214a');
  const venueMenus = [...v[A].menus, ...v[B].menus, { id: 'menu-a-cater', location_id: A, name: 'Catering', is_active: true }];
  const r = addMenuChanges(ctx(), 'Catering', { idGen: () => CATER, venueMenus, onVenueMenus: [{ menu_id: 'menu-a-cater', category_id: vCat(A) }] });
  assert.deepEqual(r.matched, [A]);
  assert.deepEqual(r.changes[0].after.extra_menus, [{ id: CATER, name: 'Catering', sites: { [A]: 'menu-a-cater' } }]);
  assert.deepEqual(r.ticked, [cat.label]);
  assert.deepEqual(r.changes[1].after.menu_keys, ['main', CATER]);
  for (const c of r.changes) assert.equal(mergeStaged(null, c).action, 'insert', 'each is a change the draft takes');
  // With it ticked in, publishing takes nothing off the site's own Catering menu.
  v[A].menus.push({ id: 'menu-a-cater', location_id: A, name: 'Catering', is_default: false, is_active: true, sort_order: 4 });
  v[A].links.push({ menu_id: 'menu-a-cater', category_id: vCat(A), sort_order: 1 });
  const plan = planSite({ central: applyChanges(central, r.changes).central, touched: touchedFromChanges(r.changes), locationId: A, orgId: ORG, venue: v[A] });
  assert.equal(plan.writes.links.delete.length + plan.writes.links.insert.length, 0, JSON.stringify(plan.lines));
  assert.match(addMenuChanges(ctx(r.changes), 'catering', { idGen: () => ONLINE }).words, /already has a menu with that name/);
});

test('ticking a category, renaming, matching a site and removing a menu', () => {
  const { central, cat, ctx } = setup();
  const start = [menuChange(central, [{ id: CATER, name: 'Catering' }])];
  const tick = categoryMenuChange(ctx(start), cat.id, CATER, true);
  assert.deepEqual(tick.change.after.menu_keys, ['main', CATER]);
  assert.match(tick.words, /is now on Main and Catering/);
  assert.match(categoryMenuChange(ctx(start), cat.id, 'main', false).words, /at least one menu/);
  const only = categoryMenuChange(ctx([...start, tick.change]), cat.id, 'main', false);
  assert.deepEqual(only.change.after.menu_keys, [CATER]);
  assert.equal(renameMenuChange(ctx(start), CATER, 'Events').change.after.extra_menus[0].name, 'Events');
  assert.equal(menuSiteChange(ctx(start), CATER, A, false).change.after.extra_menus[0].sites[A], false);
  assert.match(menuSiteChange(ctx(start), CATER, A, central.sites.find((s) => s.location_id === A).venue_menu_id).words, /main menu/);
  // Remove: refused while a category is only on it; a menu never published just leaves the list.
  assert.match(removeMenuChange(ctx([...start, tick.change, only.change]), CATER).words, /only on Catering/);
  const rm = removeMenuChange(ctx([...start, tick.change]), CATER);
  assert.deepEqual(rm.changes[0].after.extra_menus, []);
  assert.equal(rm.changes[1].after.menu_keys, null, 'its categories go back to Main only');
  central.menu.extra_menus = [{ id: CATER, name: 'Catering' }];          // published
  assert.deepEqual(removeMenuChange(ctx(), CATER).changes[0].after.extra_menus, [{ id: CATER, name: 'Catering', archived: true }], 'a published menu stays in the list as removed');
  assert.match(menusGuardWords('This cannot be changed here: extra_menus'), /SQL 20261214a/);
});

test('the words: a draft and a summary say which menu, by name', () => {
  const { central, cat } = setup();
  const menu = menuChange(central, [{ id: CATER, name: 'Catering' }]);
  assert.deepEqual(extraMenusChangeWords([], [{ id: CATER, name: 'Catering' }]), ['new menu Catering']);
  assert.deepEqual(extraMenusChangeWords([{ id: CATER, name: 'Catering' }], [{ id: CATER, name: 'Events', archived: true }]), ['Catering menu removed']);
  assert.deepEqual(extraMenusChangeWords([{ id: CATER, name: 'Catering' }], [{ id: CATER, name: 'Events' }]), ['Catering menu renamed to Events']);
  assert.deepEqual(changeWords(menu, {}), { subject: 'Menus', words: 'new menu Catering' });
  const names = { categories: new Map([[cat.id, cat.label]]), menus: new Map([['main', 'Main'], [CATER, 'Catering']]) };
  assert.deepEqual(changeWords(keysChange(cat, ['main', CATER]), names), { subject: cat.label, words: 'now on Main and Catering' });
  assert.equal(menuKeyNames(null, names.menus), 'Main');
  const eff = applyChanges(central, [menu, keysChange(cat, ['main', CATER])]).central;
  const said = summarise([menu, keysChange(cat, ['main', CATER])], eff, {});
  const text = JSON.stringify(said);
  assert.match(text, /New menu Catering\./);
  assert.match(text, new RegExp(`${cat.label} is now on Main and Catering\\. Its products follow it\\.`));
});

test('the grid lists one menu\'s products; Bring in offers what is on the group\'s other menus at a site', () => {
  const { v, central, cat } = setup();
  central.menu.extra_menus = [{ id: CATER, name: 'Catering', sites: { [A]: 'menu-a-cater' } }];
  const inCat = central.products.filter((p) => !p.archived && !p.parent_product_id && p.category_id === cat.id).length;
  assert.ok(inCat > 0);
  assert.equal(buildGridRows(central, { menuKey: CATER, menu: central.menu }).products, 0, 'nothing is on Catering yet');
  central.categories.find((c) => c.id === cat.id).menu_keys = ['main', CATER];
  const onCater = buildGridRows(central, { menuKey: CATER, menu: central.menu, show: 'everything' });
  assert.ok(onCater.products >= inCat && onCater.rows.filter((r) => r.kind === 'product' && !r.size).every((r) => r.product.category_id === cat.id || (r.product.extra_category_ids || []).includes(cat.id)));
  // A site's own product in its own Catering menu: never offered before, offered once that menu is the group's.
  v[A].menus.push({ id: 'menu-a-cater', location_id: A, name: 'Catering', is_default: false, is_active: true, sort_order: 4 });
  v[A].categories.push({ id: 'cat-a-trays', location_id: A, menu_id: 'menu-a-cater', parent_id: null, label: 'Trays', sort_order: 40 });
  v[A].items.push({ id: 'a-tray', location_id: A, name: 'Party tray', menu_name: 'Party tray', cat: 'cat-a-trays', cats: [], type: 'simple', sold_alone: true, archived: false, pricing: { base: 40 }, assigned_modifier_groups: [] });
  assert.ok(ownProducts(central, A, v[A]).some((p) => p.id === 'a-tray'));
  assert.ok(!ownProducts({ ...central, menu: { ...central.menu, extra_menus: [] } }, A, v[A]).some((p) => p.id === 'a-tray'), 'with no Catering menu in the group it is another menu\'s product');
});

// ── SHOWS ON ────────────────────────────────────────────────────────────────

test('Shows on: head office\'s list sits beside the site\'s switches and turns the named ones off', () => {
  assert.deepEqual([...SHOWN_ON_KEYS], ['pos', 'kiosk', 'online', 'onlineDelivery']);
  const site = { pos: true, kiosk: false, online: true, onlineDelivery: true, notSoldAs: ['delivery'] };
  const hidden = applyNotShownOn(site, ['online']);
  assert.deepEqual(hidden, { pos: true, kiosk: false, online: false, onlineDelivery: true, notSoldAs: ['delivery'], notShownOn: ['online'] });
  assert.equal(holdsNotShownOn({ visibility: hidden }, ['online']), true);
  assert.equal(holdsNotShownOn({ visibility: { ...hidden, online: true } }, ['online']), false, 'the switch was turned back on: publish writes it off again');
  // Every screen hides it with the rule it already has.
  for (const ch of ['online', 'qr', 'catering', 'hubrise']) assert.equal(channelVisible({ visibility: hidden }, ch), false, ch);
  assert.equal(channelVisible({ visibility: hidden }, 'pos'), true);
  assert.equal(channelVisible({ visibility: hidden }, 'kiosk'), false, 'the site\'s own kiosk switch is still the site\'s');
  // Given back: only the switch head office had hidden comes back on.
  assert.deepEqual(applyNotShownOn(hidden, []), { pos: true, kiosk: false, online: true, onlineDelivery: true, notSoldAs: ['delivery'] });
  assert.equal(shownOnSummary({ visibility: { notShownOn: ['kiosk', 'online'] } }), 'Hidden on Kiosk and Online');
  assert.equal(shownOnSummary({ visibility: { pos: true } }), '');
  assert.deepEqual(notShownOn({ visibility: toggleShownOn({ pos: true }, 'online', false) }), ['online']);
  assert.deepEqual(withNotShownOn({ pos: true, notShownOn: ['online'] }, []), { pos: true });
  assert.equal(sameShownOn({ visibility: { notShownOn: ['online'] } }, { visibility: { pos: false, notShownOn: ['online'] } }), true);
  const both = withGroupRules({ pos: true }, { visibility: { notSoldAs: ['takeaway'], notShownOn: ['kiosk'] } });
  assert.deepEqual([notSoldAs({ visibility: both }), notShownOn({ visibility: both })], [['takeaway'], ['kiosk']]);
});

test('Shows on: a whole category in one tap, published as one write per product, and a site cannot turn it back on', () => {
  const { v, central, cat, ctx } = setup();
  const list = categoryProducts(central, cat.id);
  assert.ok(list.length > 0);
  assert.equal(categoryShownOn(central, cat.id).online, 'on');
  const r = categoryShownOnChanges(ctx(), cat.id, 'online', false);
  assert.equal(r.changes.length, list.length);
  assert.match(r.words, new RegExp(`^${cat.label}: ${list.length} product`));
  const eff = applyChanges(central, r.changes).central;
  assert.equal(categoryShownOn(eff, cat.id).online, 'off');
  assert.equal(categoryShownOn(applyChanges(central, r.changes.slice(0, 1)).central, cat.id).online, list.length === 1 ? 'off' : 'mixed');
  for (const loc of [A, B]) {
    const plan = planSite({ central: eff, touched: touchedFromChanges(r.changes), locationId: loc, orgId: ORG, venue: v[loc] });
    const here = list.filter((p) => central.productSites.some((s) => s.product_id === p.id && s.location_id === loc));
    assert.equal(plan.lines.length, here.length, JSON.stringify(plan.lines.map((l) => l.column)));
    for (const l of plan.lines) {
      assert.equal(l.column, 'visibility');
      assert.equal(l.after.online, false);
      assert.deepEqual(l.after.notShownOn, ['online']);
      assert.equal(l.after.pos ?? true, (l.before || {}).pos ?? true, 'the site\'s other switches are as they were');
      assert.match(lineWords(l, {}), /now hidden on Online$/);
    }
    // Once written, the drift check reads nothing, and a second publish writes nothing.
    const after = { ...v[loc], items: plan.applied.items };
    assert.deepEqual(siteDrift(eff, loc, after), []);
    assert.equal(planSite({ central: eff, touched: touchedFromChanges(r.changes), locationId: loc, orgId: ORG, venue: after }).lines.length, 0);
  }
  // At the site: its own switch still saves, head office's hidden one stays off.
  const cur = { id: 'x', visibility: { pos: true, kiosk: true, online: false, onlineDelivery: true, notShownOn: ['online'] } };
  const locked = lockedItemPatch({ visibility: { pos: true, kiosk: false, online: true, onlineDelivery: true } }, cur, []);
  assert.deepEqual(locked.patch.visibility, { pos: true, kiosk: false, online: false, onlineDelivery: true, notShownOn: ['online'] });
  assert.ok(locked.dropped.includes('shown_on'), 'and the site is told that part did not save');
  // The draft and the summary say it in words.
  assert.match(changeWords(r.changes[0], { products: new Map() }).words, /hidden on Online/);
  assert.match(JSON.stringify(summarise(r.changes.slice(0, 1), eff, {})), /now hidden on Online at every site/);
});

test('a category whose every product is hidden on the POS is left off the POS, as the kiosk and online leave an empty one off', () => {
  const cats = [{ id: 'staff' }, { id: 'pizza' }, { id: 'empty' }];
  const items = [
    { id: 'a', cat: 'staff', type: 'simple', sold_alone: true, visibility: { pos: false, online: true } },
    { id: 'b', cat: 'staff', type: 'simple', sold_alone: true, visibility: { pos: false, notShownOn: ['pos'] } },
    { id: 'c', cat: 'pizza', type: 'simple', sold_alone: true, visibility: { pos: true, online: false, notShownOn: ['online'] } },
    { id: 'd', cat: 'pizza', type: 'simple', sold_alone: true, visibility: { pos: false } },
  ];
  assert.deepEqual([...optionOnlyCategoryIds(cats, items, { hiddenOn: 'pos' })], ['staff']);
  assert.deepEqual([...optionOnlyCategoryIds(cats, items)], [], 'without the screen named the rule is what it was');
  for (const f of ['../../surfaces/POSSurface.jsx', '../../surfaces/mpos/MMenu.jsx', '../../surfaces/BarSurface.jsx']) {
    assert.match(read(f), /optionOnlyCategoryIds\([^)]*\{ hiddenOn: 'pos' \}\)/, `${f} names the POS`);
  }
});

// 5.12.118. Peter, 27 Nov 2026 (Sandy has its own Catering menu, and the screen made him type its
// name): "thats wrong logic people will be confused it needs to find the menus and be able to
// publish them to multiple sites".
test('the sites\' own menus are FOUND, never typed: one row per name, and one tap adds it for every site', () => {
  const { v, central, cat, vCat, mainOf, ctx } = setup();
  const own = [
    { id: 'menu-a-cater', location_id: A, name: 'Catering', is_active: true, sort_order: 4 },
    { id: 'menu-b-cater', location_id: B, name: ' catering ', is_active: true, sort_order: 2 },
    { id: 'menu-a-brunch', location_id: A, name: 'Brunch', is_active: true, sort_order: 5 },
    { id: 'menu-a-old', location_id: A, name: 'Old menu', is_active: false, sort_order: 6 },
    { id: 'menu-a-main2', location_id: A, name: 'Main', is_active: true, sort_order: 7 },
    { id: 'menu-x', location_id: 'another-site', name: 'Late', is_active: true },
  ];
  const venueMenus = new Map([...v[A].menus, ...v[B].menus, ...own].map((m) => [m.id, m]));
  const found = foundSiteMenus(ctx(), venueMenus);
  assert.deepEqual(found.map((f) => [f.name, f.sites, f.ids]), [
    ['Catering', [A, B], ['menu-a-cater', 'menu-b-cater']],
    ['Brunch', [A], ['menu-a-brunch']],
  ], 'never the menu the group menu writes into, a switched off one, a second Main, nor another group\'s site');
  assert.ok(!found.some((f) => f.ids.includes(mainOf(A)) || f.ids.includes(mainOf(B))));
  const names = new Map([[A, 'Sandy'], [B, 'Provo']]);
  assert.equal(foundMenuWords(found[0], names, 2), 'At every site');
  assert.equal(foundMenuWords(found[1], names, 2), 'Only at Sandy');
  assert.equal(foundMenuWords({ sites: [A, B] }, names, 5), 'At 2 of 5 sites: Sandy, Provo');
  assert.deepEqual(foundSiteMenus(ctx(), [...venueMenus.values()]).map((f) => f.name), ['Catering', 'Brunch'], 'a list reads the same as a Map');

  // One tap: the found name goes through the same add, so it takes exactly the menus it listed.
  const r = addMenuChanges(ctx(), found[1].name, { idGen: () => CATER, venueMenus: [...venueMenus.values()], onVenueMenus: [{ menu_id: 'menu-a-brunch', category_id: vCat(A) }, { menu_id: 'menu-a-brunch', category_id: 'cat-only-at-a' }] });
  assert.deepEqual(r.matched, found[1].sites);
  assert.deepEqual(r.ticked, [cat.label]);
  assert.equal(r.notInGroup, 1, 'a category on it that the group menu does not have is counted, to bring in');
  // Once it is in the group menu it is no longer "found", and the other one still is.
  assert.deepEqual(foundSiteMenus(ctx(r.changes), venueMenus).map((f) => f.name), ['Catering']);
  // It then goes to the site that has none: publish makes one there, with the ticked category on it.
  const planB = planSite({ central: applyChanges(central, r.changes).central, touched: touchedFromChanges(r.changes), locationId: B, orgId: ORG, venue: v[B] });
  assert.equal(planB.writes.menus.insert.length, 1, JSON.stringify(planB.lines));
  assert.equal(planB.writes.menus.insert[0].name, 'Brunch');
  // A menu publish made for the group is the group's, never "found" again.
  const made = { id: extraVenueMenuId(CATER, B), location_id: B, name: 'Brunch', is_active: true };
  assert.deepEqual(foundSiteMenus(ctx(r.changes), new Map([...venueMenus, [made.id, made]])).map((f) => f.name), ['Catering']);
  // No room for another: still listed, marked full, so the button can say why.
  const many = Array.from({ length: MAX_EXTRA_MENUS }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, name: `Menu ${i}` }));
  assert.ok(foundSiteMenus(ctx([menuChange(central, many)]), venueMenus).every((f) => f.full));
  assert.deepEqual(foundSiteMenus({ eff: null }, venueMenus), []);
});

test('the screens find the menus: the Menus card lists them and the Products tab says so', () => {
  const details = read('../../backoffice/sections/msm/MsmDetails.jsx');
  assert.match(details, /foundSiteMenus\(ctx, venueMenus\)/);
  assert.match(details, /data-testid="msm-menu-found-add"[^>]*onClick=\{\(\) => add\(f\.name\)\}/, 'the button adds the found name; nobody types it');
  assert.ok(!/client\.from\('menus'\)/.test(details), 'one read of the sites\' menus, by the screen (useSiteMenus)');
  const page = read('../../backoffice/sections/msm/MultiSiteMenu.jsx');
  assert.match(page, /useSiteMenus\(/);
  assert.match(page, /data-testid="msm-found-menus"/);
  // The hook is called before the first early return (rules of hooks: 5.12.91 crashed on this kind of slip).
  assert.ok(page.indexOf('useSiteMenus(phase') < page.indexOf("if (phase === 'loading') return"));
});
