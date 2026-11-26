// Multi site menu, 5.12.114. Peter, 26 Nov 2026, Mozz: the Sites tab said "36 changes were made
// at" each of four sites, "Changed at the site", with a list of "category was changed at Mozz
// Pizza - Daybreak" for every sub item. Nobody had touched those sites.
//
// The 36 were sub items that are only options, brought in from Sandy in a section called Pizza
// Options. Publishing made them at the other sites with NO category (ensureSubItem: an option
// only sub item is on no menu), and the check for changes made at a site then wanted the group
// menu's category on each one. The two halves of the planner disagreed the moment the publish
// finished. Now where an option only sub item sits at a site is never written and never compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, siteDrift } from '../../../supabase/functions/_shared/msmDiff.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites } from './msmGroupFixture.js';

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  // An option only sub item both sites have, and a category of the group menu to file it under.
  const sub = central.products.find((p) => p.type === 'subitem' && p.sold_alone !== true && !p.archived
    && [A, B].every((loc) => central.productSites.some((s) => s.product_id === p.id && s.location_id === loc && v[loc].items.some((i) => i.id === s.venue_item_id))));
  const cat = central.categories.find((c) => !c.archived && [A, B].every((loc) => central.catSites.some((s) => s.category_id === c.id && s.location_id === loc)));
  assert.ok(sub && cat, 'the fixture has an option only sub item at both sites and a category at both');
  const vRow = (loc) => v[loc].items.find((i) => i.id === central.productSites.find((s) => s.product_id === sub.id && s.location_id === loc).venue_item_id);
  const vCat = (loc) => central.catSites.find((s) => s.category_id === cat.id && s.location_id === loc).venue_category_id;
  return { v, central, sub, cat, vRow, vCat };
}
const catLines = (central, loc, venue) => siteDrift(central, loc, venue).filter((d) => d.column === 'cat' || d.column === 'cats');

test('the Mozz fault: filed under a section in the group menu, no category at the site: no change is reported', () => {
  const { v, central, sub, cat, vRow } = setup();
  sub.category_id = cat.id;            // the group menu files it under a section (as Sandy had it)
  vRow(A).cat = null; vRow(A).cats = [];   // made at this site by a publish, with no category
  assert.deepEqual(catLines(central, A, v[A]), [], 'nobody changed anything at the site');
});

test('and the site it came from keeps its section: nothing is reported or written there either', () => {
  const { v, central, sub, cat, vRow, vCat } = setup();
  sub.category_id = null;              // the group menu has it under nothing
  vRow(B).cat = vCat(B);               // the site still files it under its own section
  assert.deepEqual(catLines(central, B, v[B]), []);
  // A publish that moves it to another section in the group menu writes no category at a site.
  const change = { target: 'product', entity_id: sub.id, location_id: null, op: 'update', after: { category_id: cat.id } };
  for (const loc of [A, B]) {
    const plan = planSite({ central: applyChanges(central, [change]).central, touched: touchedFromChanges([change]), locationId: loc, orgId: ORG, venue: v[loc] });
    assert.equal(plan.lines.filter((l) => l.column === 'cat' || l.column === 'cats').length, 0);
    assert.equal(plan.writes.categories.insert.length, 0, 'no section is made at a site just to hold options');
  }
});

test('a full publish over the whole menu writes no category on an option only sub item', () => {
  const { v, central, sub, cat, vRow } = setup();
  sub.category_id = cat.id;
  vRow(A).cat = null;
  const plan = planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: A, orgId: ORG, venue: v[A] });
  assert.equal(plan.lines.filter((l) => l.id === vRow(A).id && (l.column === 'cat' || l.column === 'cats')).length, 0);
});

test('made into a product sold on its own, it IS given its category (it is on the menu now)', () => {
  const { v, central, sub, cat, vRow, vCat } = setup();
  vRow(A).cat = null;
  const change = { target: 'product', entity_id: sub.id, location_id: null, op: 'update', after: { sold_alone: true, category_id: cat.id } };
  const plan = planSite({ central: applyChanges(central, [change]).central, touched: touchedFromChanges([change]), locationId: A, orgId: ORG, venue: v[A] });
  const line = plan.lines.find((l) => l.id === vRow(A).id && l.column === 'cat');
  assert.ok(line, 'the category is written');
  assert.equal(line.after, vCat(A));
});

test('a product that is sold is still checked: its category changed at a site is still reported', () => {
  const { v, central } = setup();
  const p = central.products.find((x) => x.type !== 'subitem' && !x.archived && !x.parent_product_id && x.category_id
    && central.productSites.some((s) => s.product_id === x.id && s.location_id === A && !(s.kept && 'cat' in s.kept)));
  const row = v[A].items.find((i) => i.id === central.productSites.find((s) => s.product_id === p.id && s.location_id === A).venue_item_id);
  const other = v[A].categories.find((c) => c.id !== row.cat);
  row.cat = other.id;                  // somebody moved it at the site
  assert.equal(catLines(central, A, v[A]).filter((d) => d.venueItemId === row.id).length, 1);
});
