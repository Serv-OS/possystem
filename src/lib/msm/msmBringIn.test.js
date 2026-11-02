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
import { ownProducts, bringInChanges, ownCountWords, ownGroups, bringInGroupChanges, ownGroupCountWords } from './msmBringIn.js';

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

// ── Bring in this group (2 Nov 2026): one of a site's own option groups, by the same rules ──────

// Site B builds a "Which syrup" group of its own (the group menu has one at A only), asked by a
// product of its own, with its own "up to" and its own prices; Hazelnut is a sub item of B's own.
function ownSyrupAtB(v, central) {
  const raw = v[B];
  raw.items.push({ ...raw.items.find((i) => i.id === S('m-oat', B)), id: 'own-haz-sub', name: 'Hazelnut shot', menu_name: 'Hazelnut shot', master_id: null, pricing: { base: 0.3 } });
  raw.groups.push({ id: 'mgd-syrup-b', location_id: B, name: 'Which syrup', min: 1, max: 2, selection_type: 'single', sort_order: 3, options: [
    { id: 'opt-b-van', name: 'Vanilla', price: 0.35 }, { id: 'opt-b-haz', name: 'Hazelnut', price: 0.3, itemId: 'own-haz-sub' },
  ] });
  raw.items.push({ ...raw.items.find((i) => i.id === S('m-mocha', B)), id: 'own-special', name: 'Spiced latte', menu_name: 'Spiced latte', master_id: null, assigned_modifier_groups: [{ groupId: 'mgd-syrup-b' }] });
  return { raw, syrup: central.groups.find((g) => g.name === 'Which syrup') };
}

test('a site\'s own option groups are listed with what they look like; managed groups are not', () => {
  const { v, central } = setup();
  const { raw, syrup } = ownSyrupAtB(v, central);
  const own = ownGroups(central, B, raw);
  assert.deepEqual(own.map((o) => o.id), ['mgd-syrup-b'], 'Milk and Tea choice at B are managed: never listed');
  assert.equal(own[0].options, 2);
  assert.deepEqual(own[0].usedBy, ['Spiced latte']);
  assert.deepEqual(own[0].thenAskOf, []);
  assert.deepEqual(own[0].match, { groupId: syrup.id, name: 'Which syrup', how: 'name' });
  assert.equal(ownGroupCountWords(1, 'Leeds'), 'Leeds has 1 option group of its own, not in the group menu.');
  assert.equal(ownGroupCountWords(0, 'Leeds'), 'Every option group Leeds asks is in the group menu.');
});

test('link a site\'s own group to the group menu\'s: options matched by name, its own prices, rule and sub item kept, NOTHING written at the site', () => {
  const { v, central } = setup();
  const { raw, syrup } = ownSyrupAtB(v, central);
  const r = bringInGroupChanges(central, B, raw, 'mgd-syrup-b', { linkTo: syrup.id, idGen: idGen('g'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  for (const c of r.changes) assert.ok(checkChange(c).ok, `${c.target}: ${checkChange(c).words}`);
  assert.equal(r.groupId, syrup.id);
  assert.equal(r.changes.filter((c) => c.target === 'modifier_group').length, 0, 'no new group');
  const gs = r.changes.find((c) => c.target === 'modifier_group_site');
  assert.deepEqual([gs.entity_id, gs.location_id, gs.after.venue_group_id], [syrup.id, B, 'mgd-syrup-b'], 'the EXISTING venue group id');
  assert.equal(gs.after.kept.max, 2, 'B chooses up to 2: its own rule, kept');
  const os = r.changes.filter((c) => c.target === 'modifier_option_site' && c.location_id === B);
  const van = central.options.find((o) => o.name === 'Vanilla');
  const vanB = os.find((c) => c.entity_id === van.id);
  assert.equal(vanB.after.venue_option_id, 'opt-b-van');
  assert.equal(vanB.after.price, 0.35, 'B\'s own price');
  assert.equal(vanB.after.kept.item_link, false, 'B\'s Vanilla has no sub item: kept, never added there');
  const car = central.options.find((o) => o.name === 'Caramel');
  assert.equal(os.find((c) => c.entity_id === car.id).after.active, false, 'Caramel is not offered at B: off there');
  const haz = r.changes.find((c) => c.target === 'modifier_option' && c.after.name === 'Hazelnut');
  assert.ok(haz, 'Hazelnut is new in the group menu');
  assert.equal(haz.after.product_id, null, 'its sub item is B\'s own, not in the group menu');
  assert.equal(os.find((c) => c.entity_id === haz.entity_id).after.kept.item_link, 'own-haz-sub', 'B keeps its own sub item link');
  assert.equal(r.changes.find((c) => c.target === 'modifier_option_site' && c.entity_id === haz.entity_id && c.location_id === A).after.active, false, 'off at A');
  // The proof, both ways, and nothing at A either.
  assert.deepEqual(writesAt(central, r.changes, B, raw).filter((l) => l.groupId === syrup.id), []);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
  assert.deepEqual(writesAt(central, r.changes, A, v[A], false), []);
  assert.equal(r.words[0], 'Which syrup at Site B becomes Site B\'s copy of the group menu\'s Which syrup.');
  assert.match(r.words.join(' '), /Site B keeps its own rule \(how many to choose\) and its own price on 1 option/);
  assert.match(r.words.join(' '), /Hazelnut is new in the group menu: on at Site B, off at the other sites/);
  assert.match(r.words.join(' '), /1 of Which syrup's options is not offered at Site B and stays off there/);
  assert.match(r.words.join(' '), /Nothing changes at Site B/);
  // Once in the draft it is managed here: it drops out of the list.
  assert.deepEqual(ownGroups(applyChanges(central, r.changes).central, B, raw), []);
});

test('bring in as a new group: a group on at that site only with every option, NOTHING written there; the group order the guard checks', () => {
  const { v, central } = setup();
  const { raw } = ownSyrupAtB(v, central);
  const r = bringInGroupChanges(central, B, raw, 'mgd-syrup-b', { idGen: idGen('n'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  for (const c of r.changes) assert.ok(checkChange(c).ok, `${c.target}: ${checkChange(c).words}`);
  const g = r.changes.find((c) => c.target === 'modifier_group');
  assert.deepEqual([g.after.name, g.after.min, g.after.max, g.after.selection_type], ['Which syrup', 1, 2, 'single']);
  assert.equal(r.groupId, g.entity_id);
  assert.equal(r.changes[0], g, 'the group first');
  const gs = r.changes.find((c) => c.target === 'modifier_group_site');
  assert.deepEqual([gs.entity_id, gs.location_id, gs.after.venue_group_id, gs.after.kept], [g.entity_id, B, 'mgd-syrup-b', {}]);
  const opts = r.changes.filter((c) => c.target === 'modifier_option');
  assert.deepEqual(opts.map((c) => [c.after.name, c.after.price, c.after.sort_order]), [['Vanilla', 0.35, 0], ['Hazelnut', 0.3, 1]]);
  const os = r.changes.filter((c) => c.target === 'modifier_option_site');
  assert.deepEqual([...new Set(os.map((c) => c.location_id))], [B], 'on at B only: no rows elsewhere');
  assert.deepEqual(os.map((c) => c.after.venue_option_id), ['opt-b-van', 'opt-b-haz'], 'the EXISTING venue option ids');
  assert.deepEqual(writesAt(central, r.changes, B, raw).filter((l) => l.groupId === g.entity_id), []);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
  assert.deepEqual(writesAt(central, r.changes, A, v[A], false), []);
  assert.equal(r.words[0], 'Option group Which syrup comes into the group menu, on at Site B only, with its 2 options.');
  assert.match(r.words.join(' '), /Nothing changes at Site B.*Add to products/);
  assert.deepEqual(ownGroups(applyChanges(central, r.changes).central, B, raw), []);
});

test('a Then ask group comes in first with the group that asks it, and the option keeps the link', () => {
  const { v, central } = setup();
  const raw = v[B];
  raw.groups.push(
    { id: 'mgd-which-sauce-b', location_id: B, name: 'Which sauce', min: 1, max: 1, selection_type: 'single', sort_order: 5, options: [{ id: 'opt-b-ket', name: 'Ketchup', price: 0 }, { id: 'opt-b-mayo', name: 'Mayo', price: 0.2 }] },
    { id: 'mgd-sauce-b', location_id: B, name: 'Sauce', min: 0, max: 1, selection_type: 'single', sort_order: 4, options: [{ id: 'opt-b-sauce', name: 'Add a sauce', price: 0, subGroupId: 'mgd-which-sauce-b' }] },
  );
  const own = ownGroups(central, B, raw);
  assert.deepEqual(own.map((o) => [o.name, o.thenAskOf]), [['Sauce', []], ['Which sauce', ['Sauce']]]);
  const r = bringInGroupChanges(central, B, raw, 'mgd-sauce-b', { idGen: idGen('t'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  const groups = r.changes.filter((c) => c.target === 'modifier_group');
  assert.deepEqual(groups.map((c) => c.after.name), ['Which sauce', 'Sauce'], 'the asked group before the one that asks it');
  const sauceOpt = r.changes.find((c) => c.target === 'modifier_option' && c.after.name === 'Add a sauce');
  assert.equal(sauceOpt.after.sub_group_id, groups[0].entity_id);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
  assert.deepEqual(writesAt(central, r.changes, B, raw).filter((l) => groups.some((g) => g.entity_id === l.groupId)), []);
  assert.equal(r.words[0], 'Option group Sauce comes into the group menu, on at Site B only, with its 1 option.');
  assert.match(r.words[1], /Option group Which sauce comes in too/);
  assert.deepEqual(ownGroups(applyChanges(central, r.changes).central, B, raw), [], 'both are in the draft now');
});

test('refused in words: a group already managed, a group to link that is already at the site, a missing group, a site not in the group menu', () => {
  const { v, central, G } = setup();
  const { raw, syrup } = ownSyrupAtB(v, central);
  assert.match(bringInGroupChanges(central, B, raw, S('mgd-milk', B)).problems[0], /Milk is already in the group menu/);
  assert.match(bringInGroupChanges(central, B, raw, 'mgd-syrup-b', { linkTo: G('Milk').id, siteName: 'Site B' }).problems[0], /Milk is already at Site B\. Bring this one in as a new group instead/);
  assert.match(bringInGroupChanges(central, B, raw, 'nope').problems[0], /no longer at the site/);
  assert.match(bringInGroupChanges(central, B, raw, 'mgd-syrup-b', { linkTo: 'gone' }).problems[0], /not in the group menu any more/);
  assert.match(bringInGroupChanges(central, 'loc-elsewhere', { ...raw, groups: raw.groups }, 'mgd-syrup-b').problems[0], /not in the group menu yet/);
  assert.ok(syrup);
});

test('bring in for products is unchanged: a product\'s own group still rides in with it, linked by name', () => {
  const { v, central } = setup();
  const { raw, syrup } = ownSyrupAtB(v, central);
  const r = bringInChanges(central, B, raw, 'own-special', { idGen: idGen('p'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  const gs = r.changes.find((c) => c.target === 'modifier_group_site');
  assert.deepEqual([gs.entity_id, gs.after.venue_group_id, gs.after.kept.max], [syrup.id, 'mgd-syrup-b', 2]);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
});
