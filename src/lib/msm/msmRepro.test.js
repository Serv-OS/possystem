// Multi site menu, round 2: Peter's exact repro from the dev site (17 Oct 2026, UI issues 8, 10
// and 11): "I chose all the variants, clicked Turn on at, changed a price, then the changes didn't
// show. I was publishing that item to Location 2."
//
// House Red (a product priced by its three sizes) is sold only at site A. Select it and its sizes,
// Turn on at site B, change one size's price at B, open Review and publish: the changes are staged,
// the preview names them at B in plain words, and the planner writes the product and its sizes
// into B's menu (category, VAT, sizes under their product), as Menu Manager would have them. Undo
// takes it all back out of the draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venues, importSites, idGen, A, B, sfx, ORG } from './msmFixture.js';
import { proposeImport, buildCentral } from '../../../supabase/functions/_shared/msmImport.js';
import { applyChanges, previewSet, mergeStaged, changeKey } from '../../../supabase/functions/_shared/msmDiff.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { checkSite } from '../../../supabase/functions/_shared/msmHealth.js';
import { activeMany, sitePriceChange } from './msmEdit.js';
import { undoFor, statusBar } from './msmStatus.js';
import { stagedIndex } from './msmGrid.js';

// The draft as the database keeps it: one row per target, entity and site (msmData.stageMany).
function fold(rows, changes) {
  const by = new Map(rows.map((r) => [changeKey(r), r]));
  for (const c of changes) {
    const m = mergeStaged(by.get(changeKey(c)) || null, c);
    if (m.action === 'insert' || m.action === 'update') by.set(changeKey(c), m.row);
    else if (m.action === 'delete') by.delete(changeKey(c));
  }
  return [...by.values()];
}

function withHouseRed() {
  const v = venues();
  const a = v[A];
  a.categories.push({ id: 'cat-wine', location_id: A, menu_id: 'menu-a', parent_id: null, label: 'Wine', icon: '🍷', color: '#7f1d1d', accounting_group: '', sort_order: 5, default_course: 1, image: null, master_id: null });
  a.links.push({ menu_id: 'menu-a', category_id: 'cat-wine', sort_order: 5 });
  a.printRouting.routing['pc-b'].assignedCategories.push('cat-wine');   // wine prints at the bar
  const base = { location_id: A, description: '', cats: [], allergens: [], assigned_modifier_groups: [], visibility: { pos: true, kiosk: true, online: true, onlineDelivery: true }, sold_alone: true, archived: false, tax_rate_id: 'tr-a', image: null, scope: 'local', org_id: null, master_id: null, tags: [], item_code: null, centre_id: null, updated_at: '2026-10-01T10:00:00.000+00:00' };
  const row = (id, name, extra) => ({ ...base, id, name, menu_name: name, receipt_name: name, kitchen_name: name, cat: 'cat-wine', parent_id: null, sort_order: 0, type: 'simple', pricing: { base: 0 }, ...extra });
  a.items.push(
    row('l-red', 'House Red', { type: 'variants' }),
    row('l-red-175', '175 ml glass', { parent_id: 'l-red', sort_order: 1, pricing: { base: 5.5 } }),
    row('l-red-250', '250 ml glass', { parent_id: 'l-red', sort_order: 2, pricing: { base: 7.5 } }),
    row('l-red-btl', 'Bottle', { parent_id: 'l-red', sort_order: 3, pricing: { base: 22 } }),
  );
  return v;
}

test('THE REPRO: House Red and its sizes turned on at site B, a size price changed there, previewed and planned', () => {
  const v = withHouseRed();
  const sites = importSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.ok(built.check.ok, 'the import writes nothing anywhere');
  const live = built.central;
  // Mark House Red the way round 1 imported it (only at site A), to prove the old mark is no bar.
  const red = live.products.find((p) => p.name === 'House Red');
  red.site_only_location_id = A;
  const sizes = live.products.filter((p) => p.parent_product_id === red.id);
  assert.equal(sizes.length, 3);
  const ids = [red.id, ...sizes.map((s) => s.id)];

  // 1. Select all four rows, Turn on at site B.
  const on = activeMany({ live, eff: live }, ids, [B], true);
  assert.deepEqual(on.words, []);
  assert.equal(on.changes.filter((c) => c.target === 'product_site' && c.op === 'create' && c.location_id === B).length, 4, 'four rows go on at B: nothing silently skipped');
  assert.equal(on.changes.filter((c) => c.target === 'product' && c.after.site_only_location_id === null).length, 1, 'the old one site mark is cleared once');
  // The status bar counts them at once (UI issue 10).
  const eff1 = applyChanges(live, on.changes).central;
  assert.equal(stagedIndex(on.changes).sites.size, 4);
  assert.match(statusBar({ working: { status: 'draft', title: 'Changes 17 Oct 18:00' }, rows: on.changes }).words, /^5 changes, not on the tills yet\.$/);

  // 2. Change the 250 ml glass at site B.
  const glass = sizes.find((s) => s.name === '250 ml glass');
  const pc = sitePriceChange({ live, eff: eff1 }, glass.id, B, 8);
  assert.ok(pc.change, 'a price on a row that is only in the draft still stages');
  const changes = fold(fold([], on.changes), [pc.change]);
  assert.equal(changes.length, 5, 'the price lands on the new row at B, not a sixth change');
  let eff2 = applyChanges(live, changes).central;
  assert.equal(eff2.productSites.find((ps) => ps.product_id === glass.id && ps.location_id === B).price, 8);

  // 3. Review and publish. Wine is new at B and would print nowhere: blocking, in words, with its
  // fix offered on the same line (Prints like), which stages the category's route_like_id.
  const first = previewSet(live, changes, v, { orgId: ORG, siteNames: { [A]: 'Site A', [B]: 'Site B' } });
  const blockB = first.sites.find((s) => s.location_id === B).health.blocking;
  assert.equal(blockB[0]?.code, 'new_category_unrouted');
  assert.match(blockB[0].words, /pick which category it prints like/);
  const wine = live.categories.find((c) => c.label === 'Wine');
  const cold = live.categories.find((c) => c.label === 'Cold drinks');
  changes.push({ target: 'category', entity_id: wine.id, location_id: null, op: 'update', after: { route_like_id: cold.id }, before: { route_like_id: null } });
  // Then site B gets House Red and three sizes, in words.
  const preview = previewSet(live, changes, v, { orgId: ORG, siteNames: { [A]: 'Site A', [B]: 'Site B' } });
  const atB = preview.sites.find((s) => s.location_id === B);
  assert.ok(atB.health.ok, `no blocking problem at B: ${JSON.stringify(atB.health.blocking)}`);
  const words = atB.lines.map((l) => l.words);
  // 17 Oct verification: each size is named with its product and the price it goes on sale at.
  for (const w of ['House Red: new here', 'House Red, 175 ml glass: new here at 5.50', 'House Red, 250 ml glass: new here at 8.00', 'House Red, Bottle: new here at 22.00']) {
    assert.ok(words.includes(w), `"${w}" at B: ${words.join(' | ')}`);
  }
  assert.match(atB.words, /1 new product, 3 new sizes/, 'the site tab counts the product and its sizes apart');
  const atA = preview.sites.find((s) => s.location_id === A);
  assert.equal((atA?.plan?.lines || []).length, 0, 'nothing changes at A');

  // 4. The planner writes the product and its sizes into B's menu, as Menu Manager would.
  eff2 = applyChanges(live, changes).central;
  const plan = planSite({ central: eff2, touched: touchedFromChanges(changes), locationId: B, orgId: ORG, venue: v[B] });
  assert.ok(checkSite(plan).ok);
  const ins = plan.writes.items.insert;
  const parentRow = ins.find((r) => r.name === 'House Red');
  assert.ok(parentRow, 'House Red goes in');
  assert.equal(parentRow.type, 'variants');
  for (const nm of ['175 ml glass', '250 ml glass', 'Bottle']) {
    const r = ins.find((x) => x.name === nm);
    assert.ok(r, `${nm} goes in`);
    assert.equal(r.parent_id, parentRow.id, `${nm} sits under House Red at B`);
    assert.equal(r.tax_rate_id, 'tr-b', 'B\'s own VAT rate, matched by percent');
    assert.ok(r.cat, 'in a category at B (made there when it is missing)');
  }
  assert.equal(ins.find((x) => x.name === '250 ml glass').pricing.base, 8);
  assert.equal(ins.find((x) => x.name === '175 ml glass').pricing.base, 5.5);
  assert.ok(ins.every((r) => r.id.endsWith(`_${sfx(B)}`)), 'new ids in the sharing scheme');
  assert.equal(plan.writes.items.insert.length, 4);

  // 5. Undo (the note's [Undo]): every row that action created comes out of the draft again.
  const back = undoFor(live, on.changes);
  assert.equal(back.unstageKeys.length, 4);
  assert.deepEqual(back.updates.map((u) => [u.target, u.after]), [['product', { site_only_location_id: A }]]);
});

test('turning a product on at a site with no row stages one change; already on says so (UI issue 10)', async () => {
  const { siteActiveChange } = await import('./msmEdit.js');
  const v = withHouseRed();
  const sites = importSites(v);
  const live = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
  const cola = live.products.find((p) => p.name === 'Cola');
  const red = live.products.find((p) => p.name === 'House Red');
  const r = siteActiveChange({ live, eff: live }, red.id, B, true);
  assert.equal(r.change.op, 'create');
  assert.equal(r.change.after.active, true);
  assert.equal(r.change.after.price, null, 'following the group price');
  assert.equal(siteActiveChange({ live, eff: live }, cola.id, A, true).already, true);
});
