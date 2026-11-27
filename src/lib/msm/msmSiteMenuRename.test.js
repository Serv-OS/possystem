// src/lib/msm/msmSiteMenuRename.test.js
//
// 5.12.121. A site can now rename its own menu in Menu manager (lib/menuRename.js). The Multi site
// menu reads a site's menu NAME in one place only: when head office adds a menu to the group menu
// (matchSiteMenus, foundSiteMenus). After that the link is the menu's ID (msm_menu_sites
// .venue_menu_id for the main menu, the extra menu's sites map, or the fixed id publish made).
// These pin what that means for a rename at the site:
//   * the menu stays linked, and publish makes no second menu beside it,
//   * publish does not put the old name back,
//   * a linked menu is never offered as a "found" menu again under its new name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite } from '../../../supabase/functions/_shared/msmHealth.js';
import { extraVenueMenuId, extraMenuAt } from '../../../supabase/functions/_shared/msmMenus.js';
import { foundSiteMenus } from './msmEdit.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites } from './msmGroupFixture.js';

const CATER = 'ca7e0000-0000-4000-8000-000000000001';

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17', extra_menus: [] };
  const cat = central.categories.find((c) => !c.archived && !c.parent_id && [A, B].every((loc) => central.catSites.some((s) => s.category_id === c.id && s.location_id === loc)));
  const vCat = (loc) => central.catSites.find((s) => s.category_id === cat.id && s.location_id === loc)?.venue_category_id;
  const mainOf = (loc) => central.sites.find((s) => s.location_id === loc).venue_menu_id;
  const plan = (changes, loc) => planSite({ central: applyChanges(central, changes).central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue: v[loc] });
  const ctx = (changes = []) => ({ live: central, eff: applyChanges(central, changes).central });
  return { v, central, cat, vCat, mainOf, plan, ctx };
}
const menuChange = (central, list) => ({ target: 'menu', entity_id: central.menu.id, location_id: null, op: 'update', after: { extra_menus: list }, before: { extra_menus: [] } });
const keysChange = (cat, keys) => ({ target: 'category', entity_id: cat.id, location_id: null, op: 'update', after: { menu_keys: keys }, before: { menu_keys: null } });
const menuWrites = (p) => p.lines.filter((l) => l.table === 'menus' && l.column !== 'is_default');

test('a site renames the menu a group menu was matched to: still linked, no second menu, the new name stays', () => {
  const { v, central, cat, vCat, plan } = setup();
  // Head office added "Catering" while A's own menu was called Catering. Since then A renamed it.
  v[A].menus.push({ id: 'menu-a-cater', location_id: A, name: 'Events and parties', is_default: false, is_active: true, sort_order: 4 });
  const extra = { id: CATER, name: 'Catering', sites: { [A]: 'menu-a-cater' } };
  assert.deepEqual(extraMenuAt(extra, A, new Map(v[A].menus.map((m) => [m.id, m]))), { off: false, id: 'menu-a-cater', how: 'matched' }, 'found by its id, whatever it is called');

  const a = plan([menuChange(central, [extra]), keysChange(cat, ['main', CATER])], A);
  assert.equal(a.writes.menus.insert.length, 0, 'publish makes no second Catering menu beside the renamed one');
  assert.deepEqual(a.writes.links.insert.map((l) => [l.menu_id, l.category_id]), [['menu-a-cater', vCat(A)]], 'the category goes on the renamed menu');
  assert.deepEqual(menuWrites(a), [], 'and the site\'s name for it is left alone');
  assert.equal(a.applied.menus.find((m) => m.id === 'menu-a-cater').name, 'Events and parties');
  assert.equal(checkSite(a).ok, true, JSON.stringify(checkSite(a)));
});

test('a site renames the menu publish MADE for the group, or its main menu: both stay linked', () => {
  const { v, central, cat, mainOf, plan } = setup();
  const made = extraVenueMenuId(CATER, B);
  v[B].menus.push({ id: made, location_id: B, name: 'Office lunches', is_default: false, is_active: true, sort_order: 4 });
  v[B].menus.find((m) => m.id === mainOf(B)).name = 'Dine in and takeout';
  const b = plan([menuChange(central, [{ id: CATER, name: 'Catering' }]), keysChange(cat, ['main', CATER])], B);
  assert.equal(b.writes.menus.insert.length, 0, 'the menu publish made is found by its fixed id, so none is made again');
  assert.deepEqual(menuWrites(b), [], 'neither name is put back');
  assert.ok(b.menuIds.includes(made) && b.menuIds.includes(mainOf(B)));
  assert.equal(b.applied.menus.find((m) => m.id === mainOf(B)).name, 'Dine in and takeout');
  assert.equal(checkSite(b).ok, true, JSON.stringify(checkSite(b)));
});

test('"use this name at every site": only a publish that changes the group menu\'s name writes it on the main menu', () => {
  const { v, central, cat, mainOf, plan } = setup();
  central.menu.use_name_everywhere = true;
  v[A].menus.find((m) => m.id === mainOf(A)).name = 'Sandy in store';
  // A publish of something else leaves the site's own name.
  assert.deepEqual(menuWrites(plan([keysChange(cat, ['main'])], A)), []);
  // Head office renames the group menu: that publish does write its name at the site.
  const rename = { target: 'menu', entity_id: central.menu.id, location_id: null, op: 'update', after: { name: 'Mozz menu' }, before: { name: 'Group menu' } };
  assert.deepEqual(menuWrites(plan([rename], A)).map((l) => [l.id, l.column, l.before, l.after]), [[mainOf(A), 'name', 'Sandy in store', 'Mozz menu']]);
});

test('a linked menu is never "found" again under its new name; an unlinked one is found by the name it has now', () => {
  const { v, central, ctx } = setup();
  const own = [
    { id: 'menu-a-cater', location_id: A, name: 'Events and parties', is_active: true, sort_order: 4 },   // linked, then renamed
    { id: 'menu-b-brunch', location_id: B, name: 'Weekend brunch', is_active: true, sort_order: 5 },     // not linked, renamed from Brunch
  ];
  const venueMenus = new Map([...v[A].menus, ...v[B].menus, ...own].map((m) => [m.id, m]));
  const linked = [menuChange(central, [{ id: CATER, name: 'Catering', sites: { [A]: 'menu-a-cater' } }])];
  assert.deepEqual(foundSiteMenus(ctx(linked), venueMenus).map((f) => [f.name, f.ids]), [['Weekend brunch', ['menu-b-brunch']]]);
});
