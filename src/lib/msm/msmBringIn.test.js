// Multi site menu round 2, design 3.1: bring a site's own products into the group menu
// (src/lib/msm/msmBringIn.js). The rule: bringing in writes NOTHING at the site, proved with the
// real planner with everything brought in touched, and with the draft's own changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkChange } from '../../../supabase/functions/_shared/msmModel.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S, VAT } from './msmGroupFixture.js';
import { ownProducts, bringInChanges, ownCountWords } from './msmBringIn.js';

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  return { v, central, P: (n) => central.products.find((p) => p.name === n), G: (n) => central.groups.find((g) => g.name === n) };
}
const writesAt = (central, changes, loc, venue, everything = true) => {
  const after = applyChanges(central, changes).central;
  const touched = touchedFromChanges(everything ? touchEverything(after) : changes);
  return planSite({ central: after, touched, locationId: loc, orgId: ORG, venue }).lines;
};

test('the site\'s own products are listed with what they look like; managed ones, sizes and option only sub items are not', () => {
  const { v, central } = setup();
  const own = ownProducts(central, B, v[B]);
  const ids = own.map((o) => o.id);
  assert.ok(!ids.includes(S('m-latte', B)), 'managed');
  assert.ok(!ids.includes(S('m-latte-l', B)), 'a size comes with its product');
  assert.ok(!ids.includes(S('m-oat', B)), 'an option only sub item is never listed alone');
  assert.match(ownCountWords(2, 'Leeds'), /^Leeds has 2 products of its own, not in the group menu\.$/);
});

test('bring in as a new product: a product on at that site only, and publishing writes NOTHING there', () => {
  const { v, central, G } = setup();
  const raw = v[B];
  raw.groups.push({ id: 'mgd-syrup-b', location_id: B, name: 'Which syrup', min: 1, max: 1, selection_type: 'single', sort_order: 3, options: [
    { id: 'opt-b-van', name: 'Vanilla', price: 0.35 }, { id: 'opt-b-haz', name: 'Hazelnut', price: 0.3 },
  ] });
  raw.items.push({ ...raw.items.find((i) => i.id === S('m-mocha', B)), id: 'own-special', name: 'Spiced latte', menu_name: 'Spiced latte', receipt_name: 'Spiced latte', kitchen_name: 'SPICED', pricing: { base: 3.65, takeaway: 3.5 }, master_id: null, assigned_modifier_groups: [{ groupId: S('mgd-milk', B) }, { groupId: 'mgd-syrup-b' }], allergens: ['milk'] });
  const own = ownProducts(central, B, raw).find((o) => o.id === 'own-special');
  assert.ok(own, 'listed');
  assert.equal(own.match, null, 'nothing like it in the group menu');
  assert.deepEqual(own.groups.sort(), ['Milk', 'Which syrup']);

  const r = bringInChanges(central, B, raw, 'own-special', { idGen: idGen('b'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  for (const c of r.changes) assert.ok(checkChange(c).ok, `${c.target}: ${checkChange(c).words}`);
  const prod = r.changes.find((c) => c.target === 'product' && c.op === 'create');
  assert.equal(prod.after.name, 'Spiced latte');
  assert.equal(prod.after.default_price, 3.65);
  assert.equal(prod.after.default_channels.takeaway, 3.5);
  assert.equal(prod.after.modifier_groups.length, 2);
  const ps = r.changes.filter((c) => c.target === 'product_site');
  assert.deepEqual(ps.map((c) => c.location_id), [B], 'on at site B only: no rows elsewhere, nothing written elsewhere');
  assert.equal(ps[0].after.venue_item_id, 'own-special', 'the EXISTING venue item id');
  // Milk is managed at B already: used as it is. Which syrup is linked to the group menu's.
  assert.ok(prod.after.modifier_groups.some((g) => g.groupId === G('Milk').id));
  assert.ok(prod.after.modifier_groups.some((g) => g.groupId === G('Which syrup').id));
  const gs = r.changes.find((c) => c.target === 'modifier_group_site');
  assert.deepEqual([gs.entity_id, gs.after.venue_group_id], [G('Which syrup').id, 'mgd-syrup-b']);
  // Vanilla matched by name (B's own price), Hazelnut new (on at B, off at A), Caramel off at B.
  const os = r.changes.filter((c) => c.target === 'modifier_option_site' && c.location_id === B);
  const van = central.options.find((o) => o.name === 'Vanilla');
  const vanB = os.find((c) => c.entity_id === van.id);
  assert.equal(vanB.after.venue_option_id, 'opt-b-van');
  assert.equal(vanB.after.price, 0.35);
  assert.equal(vanB.after.kept.item_link, false, 'B\'s option has no sub item: kept, never added there');
  const car = central.options.find((o) => o.name === 'Caramel');
  assert.equal(os.find((c) => c.entity_id === car.id).after.active, false);
  const haz = r.changes.find((c) => c.target === 'modifier_option' && c.after.name === 'Hazelnut');
  assert.ok(haz);
  assert.equal(r.changes.find((c) => c.target === 'modifier_option_site' && c.entity_id === haz.entity_id && c.location_id === A).after.active, false);
  // The proof, both ways: everything touched, and the draft's own changes.
  assert.deepEqual(writesAt(central, r.changes, B, raw).filter((l) => l.productId === prod.entity_id || l.groupId === G('Which syrup').id), []);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
  assert.deepEqual(writesAt(central, r.changes, A, v[A], false), [], 'nothing is written at site A either');
  assert.match(r.words.join(' '), /Nothing changes at Site B/);
});

test('link to an existing product: it becomes that site\'s copy, its own values kept, nothing written', () => {
  const { v, central, P } = setup();
  // The Donut was left out at site B: B's row is its own now.
  central.productSites = central.productSites.filter((ps) => !(ps.product_id === P('Donut').id && ps.location_id === B));
  const raw = v[B];
  raw.items.find((i) => i.id === S('m-donut', B)).pricing = { base: 2.25 };
  const own = ownProducts(central, B, raw).find((o) => o.id === S('m-donut', B));
  assert.deepEqual(own.match, { productId: P('Donut').id, name: 'Donut', how: 'family' });
  const r = bringInChanges(central, B, raw, S('m-donut', B), { linkTo: P('Donut').id, idGen: idGen('l'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  assert.equal(r.changes.filter((c) => c.target === 'product').length, 0, 'no new product');
  const ps = r.changes.find((c) => c.target === 'product_site');
  assert.equal(ps.after.price, 2.25, 'B charges its own price');
  // B has no takeaway key (the group gives Zero Rate) and its own counter and drive thru keys.
  assert.equal(ps.after.kept.tax_overrides.takeaway, false);
  assert.equal(ps.after.kept.tax_overrides.counter, VAT.B);
  assert.equal(ps.after.kept.tax_overrides['drive-thru'], null);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
  assert.deepEqual(writesAt(central, r.changes, B, raw).filter((l) => l.productId === P('Donut').id), []);
  assert.match(r.words.join(' '), /Site B keeps its own VAT by order type and its own price, so nothing changes there/);
});

test('refused in words: a product already managed, a product to link that is already at the site, a missing row', () => {
  const { v, central, P } = setup();
  assert.match(bringInChanges(central, B, v[B], S('m-latte', B)).problems[0], /already in the group menu/);
  assert.match(bringInChanges(central, B, v[B], 'l-old-b', { linkTo: P('Latte').id }).problems[0], /already at Site B|already at this site/);
  assert.match(bringInChanges(central, B, v[B], 'nope').problems[0], /no longer at the site/);
});
