// msmCombo.test.js: the Multi site menu and a SITE'S OWN Combo with steps (5.12.124, stage 2).
//
// Stage 1 (5.12.123) left a Combo built from steps at its site: the group menu could not hold its
// steps. Stage 2 can (msm_products.combo, the same shape, each product a product of the group menu).
// Peter, 27 Nov 2026: "make sure its also in the multi site menu manager properly". So now:
//   first import      still leaves it at its site, and says to bring it in from Sites afterwards
//                     (its steps name the site's own items, which only become the group menu's
//                     products through that import)
//   Bring in          brings it WITH its steps: each step product becomes the group menu product it
//                     already is there, or comes in with the Combo (a product the group menu does
//                     not manage yet). One that cannot come in stops it, in words. Writes nothing.
//   Bring in all      the same, every product once
//   publish           a Combo the group menu does not manage is never touched
// A Combo with NO steps is an ordinary product and comes in exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { proposeImport, buildCentral, touchEverything, reviewWords, comboWithSteps } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S } from './msmGroupFixture.js';
import { ownProducts, bringInChanges, bringInAllChanges, joinableProducts } from './msmBringIn.js';
import { combosKeptWords } from './msmImportReview.js';
import { comboHasSteps, comboStepsOf } from '../combo.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// Site B's own Combo: a coffee (both group menu products), and an optional treat that keeps its
// price (the site's own Brownie, not in the group menu yet, and the group's Cookie).
const stepsAt = (treat = ['own-brownie', 'l-cookie-b']) => ({ v: 1, steps: [
  { id: 'st-coffee', name: 'Pick a coffee', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: S('m-latte', B), bump: 0 }, { itemId: S('m-mocha', B), bump: 0.5 }] },
  { id: 'st-treat', name: 'Add a treat?', selectionType: 'multiple', min: 0, max: 2, pricing: 'own', products: treat.map((itemId) => ({ itemId, bump: 0 })) },
] });

function setup({ comboAtImport = false } = {}) {
  const v = groupVenues();
  if (comboAtImport) addOwn(v[B]);
  const sites = groupSites(v);
  const proposal = proposeImport(sites, { idGen: idGen() });
  const built = buildCentral(proposal, sites, {}, { idGen: idGen('g') });
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  return { v, central, proposal };
}
// Products of Site B's own, made from a real row of the fixture so every column is there.
function addOwn(raw, extra = []) {
  const base = raw.items.find((i) => i.id === S('m-mocha', B));
  const own = (id, name, more) => ({ ...base, id, name, menu_name: name, receipt_name: name, kitchen_name: name.toUpperCase(), master_id: null, scope: 'local', assigned_modifier_groups: [], ...more });
  raw.items.push(own('own-brownie', 'Brownie', { type: 'simple', pricing: { base: 2.5 } }));
  raw.items.push(own('own-byo', 'Coffee and a treat', { type: 'combo', pricing: { base: 4.5 }, combo: stepsAt() }));
  raw.items.push(own('own-plain', 'Plain Meal Deal', { type: 'combo', combo: null, pricing: { base: 9 } }));
  for (const [id, name, more] of extra) raw.items.push(own(id, name, more));
  return raw;
}
const productNamed = (central, name) => central.products.find((p) => !p.parent_product_id && (p.menu_name || p.name) === name && !p.archived);
const planAt = (central, changes, loc, venue) => planSite({ central, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue });

test('the server side reading of "a Combo with steps" is the app\'s own', () => {
  const rows = [
    { type: 'combo', combo: stepsAt() }, { type: 'combo', combo: stepsAt().steps }, { type: 'combo', combo: { v: 1, steps: [] } },
    { type: 'combo', combo: null }, { type: 'combo' }, { type: 'combo', combo: 'x' }, { type: 'combo', combo: { steps: 'x' } },
    { type: 'combo', combo: { steps: [null, 3, 'a'] } }, { type: 'combo', combo: { steps: [[]] } },
    { type: 'simple', combo: stepsAt() }, { type: 'modifiable', combo: stepsAt() }, null, undefined, {},
  ];
  for (const r of rows) assert.equal(comboWithSteps(r), comboHasSteps(r), JSON.stringify(r));
  assert.equal(comboWithSteps(rows[0]), true);
  assert.equal(comboWithSteps(rows[3]), false);
});

test('the first import leaves a Combo with steps at its site, and says to bring it in from Sites afterwards', () => {
  const { central, proposal } = setup({ comboAtImport: true });
  assert.ok(!central.products.some((p) => p.name === 'Coffee and a treat'));
  assert.ok(!central.productSites.some((ps) => ps.venue_item_id === 'own-byo'));
  assert.deepEqual(proposal.review.combosKept, [{ location_id: B, id: 'own-byo', name: 'Coffee and a treat' }]);
  assert.equal(combosKeptWords(proposal.review), '1 Combo with steps stays at its site for now (Coffee and a treat). Once this import is published, bring it in from Sites: its steps come with it.');
  // Its step product and the Combo with no steps come in as any product only at one site does.
  assert.ok(central.products.some((p) => p.name === 'Brownie'));
  assert.ok(central.productSites.some((ps) => ps.venue_item_id === 'own-plain' && ps.location_id === B));
  assert.match(reviewWords(proposal.review), /products? already shared between sites/);
  assert.equal(combosKeptWords({ combosKept: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] }), '4 Combos with steps stay at their sites for now (A, B, C and more). Once this import is published, bring them in from Sites: their steps come with them.');
  assert.equal(combosKeptWords({}), '');
  assert.equal(combosKeptWords(null), '');
  assert.equal('combosKept' in setup().proposal.review, false);
});

test('Bring in brings a Combo WITH its steps, and the product its steps need that the group menu did not have', () => {
  const { v, central } = setup();
  const raw = addOwn(v[B]);
  // Listed as the site's own, with the buttons (nothing held any more).
  const listed = ownProducts(central, B, raw).find((o) => o.id === 'own-byo');
  assert.ok(listed);
  assert.equal('held' in listed, false);
  const r = bringInChanges(central, B, raw, 'own-byo', { idGen: idGen('b'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  // The Combo and the Brownie are new in the group menu; Latte, Mocha and Cookie are the group's own.
  const creates = r.changes.filter((c) => c.target === 'product' && c.op === 'create');
  assert.deepEqual(creates.map((c) => c.after.name), ['Brownie', 'Coffee and a treat']);
  // The database guard reads them in order: the Brownie before the Combo that names it.
  assert.ok(r.changes.indexOf(creates[0]) < r.changes.indexOf(creates[1]));
  const after = applyChanges(central, r.changes).central;
  const combo = after.products.find((p) => p.name === 'Coffee and a treat');
  const id = (n) => productNamed(after, n).id;
  assert.deepEqual(comboStepsOf(combo.combo).map((s) => [s.name, s.pricing, s.products.map((x) => [x.itemId, x.bump])]), [
    ['Pick a coffee', 'set', [[id('Latte'), 0], [id('Mocha'), 0.5]]],
    ['Add a treat?', 'own', [[id('Brownie'), 0], [id('Cookie'), 0]]],
  ]);
  assert.equal(combo.type, 'combo');
  // On at Site B only, as its own Combo there, and NOTHING is written at Site B by publishing it.
  assert.deepEqual(after.productSites.filter((ps) => ps.product_id === combo.id).map((ps) => [ps.location_id, ps.venue_item_id]), [[B, 'own-byo']]);
  const plan = planAt(after, r.changes, B, raw);
  assert.deepEqual(plan.lines, [], JSON.stringify(plan.lines));
  assert.deepEqual(plan.problems.filter((p) => p.level === 'block'), []);
  // Said in words.
  assert.equal(r.words[0], 'Coffee and a treat comes into the group menu as a product on at Site B only.');
  assert.ok(r.words.includes('Brownie comes into the group menu as a product on at Site B only.'), r.words.join(' | '));
  assert.ok(r.words.includes('Its steps come with it: Pick a coffee (2 products), Add a treat? (2 products).'), r.words.join(' | '));
  assert.ok(r.words.includes('Nothing changes at Site B: the tills keep selling it exactly as they do now.'));
});

test('a step that lists a product switched off at the site: the group menu leaves it out, the site keeps its own steps', () => {
  const { v, central } = setup();
  // "Old special" is the site's own and switched off there.
  const raw = addOwn(v[B], [['own-byo2', 'Coffee and a special', { type: 'combo', pricing: { base: 6 }, combo: stepsAt(['l-old-b', 'own-brownie']) }]]);
  const r = bringInChanges(central, B, raw, 'own-byo2', { idGen: idGen('s'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  const after = applyChanges(central, r.changes).central;
  const combo = after.products.find((p) => p.name === 'Coffee and a special');
  // Not brought in (it is switched off and the site's own); the step keeps what is left.
  assert.ok(!after.products.some((p) => p.name === 'Old special'));
  assert.deepEqual(comboStepsOf(combo.combo)[1].products.map((x) => x.itemId), [productNamed(after, 'Brownie').id]);
  // The site keeps its own steps (they still name it), so publishing writes nothing there.
  const ps = after.productSites.find((x) => x.product_id === combo.id && x.location_id === B);
  assert.deepEqual(ps.kept.combo, raw.items.find((i) => i.id === 'own-byo2').combo);
  assert.deepEqual(planAt(after, r.changes, B, raw).lines, []);
  assert.ok(r.words.includes('Site B keeps its own steps for Coffee and a special (Old special is switched off there). Changes to the steps in the group menu reach Site B once you tell it to use the group\'s.'), r.words.join(' | '));
});

test('a variant the site added to a group menu product comes in as that product\'s variant', () => {
  const { v, central } = setup();
  const latteB = v[B].items.find((i) => i.id === S('m-latte', B));
  const raw = addOwn(v[B], [
    ['own-latte-xl', 'Extra large', { type: 'simple', parent_id: S('m-latte', B), cat: latteB.cat, pricing: { base: 4.1 } }],
    ['own-byo3', 'Big coffee deal', { type: 'combo', pricing: { base: 5 }, combo: { v: 1, steps: [{ id: 'st', name: 'Coffee', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'own-latte-xl', bump: 0 }] }] } }],
  ]);
  const r = bringInChanges(central, B, raw, 'own-byo3', { idGen: idGen('x'), siteName: 'Site B' });
  assert.ok(r.ok, r.problems.join(' | '));
  const after = applyChanges(central, r.changes).central;
  const xl = after.products.find((p) => p.name === 'Extra large');
  assert.equal(xl.parent_product_id, productNamed(after, 'Latte').id);
  assert.deepEqual(after.productSites.filter((ps) => ps.product_id === xl.id).map((ps) => [ps.location_id, ps.venue_item_id]), [[B, 'own-latte-xl']]);
  assert.deepEqual(comboStepsOf(after.products.find((p) => p.name === 'Big coffee deal').combo)[0].products.map((x) => x.itemId), [xl.id]);
  assert.ok(r.words.includes('Extra large comes in as a new variant of Latte, on at Site B only.'), r.words.join(' | '));
  assert.deepEqual(planAt(after, r.changes, B, raw).lines, []);
});

test('a step product that cannot come in stops the Combo, in words, and nothing is added', () => {
  const { v, central } = setup();
  // Oat milk is a sub item that is only an option at Site B.
  const raw = addOwn(v[B], [['own-bad', 'Coffee with milk', { type: 'combo', pricing: { base: 4 }, combo: { v: 1, steps: [{ id: 'st', name: 'Milk', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: S('m-oat', B), bump: 0 }] }] } }]]);
  const r = bringInChanges(central, B, raw, 'own-bad', { idGen: idGen('z'), siteName: 'Site B' });
  assert.deepEqual(r, { ok: false, changes: [], words: [], problems: ['Coffee with milk cannot come in yet. Its step "Milk" lists Oat milk: That is an option only, not a product. Turn on Sold alone to use it in a Combo. Take it out of the step at Site B first. Nothing was added to the draft.'] });
  // A Combo inside a Combo, the same.
  const raw2 = addOwn(groupVenues()[B], [['own-nest', 'Two deals', { type: 'combo', pricing: { base: 9 }, combo: { v: 1, steps: [{ id: 'st', name: 'Deal', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'own-byo', bump: 0 }] }] } }]]);
  assert.match(bringInChanges(central, B, raw2, 'own-nest', { siteName: 'Site B' }).problems[0], /^Two deals cannot come in yet\. Its step "Deal" lists Coffee and a treat: A Combo cannot go inside another Combo\./);
});

test('Bring in all brings the Combo and every product its steps need, each once', () => {
  const { v, central } = setup();
  const raw = addOwn(v[B]);
  const r = bringInAllChanges(central, B, raw, { idGen: idGen('a'), siteName: 'Site B', orgId: ORG });
  assert.ok(r.ok, r.problems.join(' | '));
  assert.deepEqual(r.problems, []);
  const after = applyChanges(central, r.changes).central;
  for (const n of ['Brownie', 'Coffee and a treat', 'Plain Meal Deal']) {
    assert.equal(after.products.filter((p) => p.name === n).length, 1, `${n} once`);
  }
  const combo = after.products.find((p) => p.name === 'Coffee and a treat');
  assert.deepEqual(comboStepsOf(combo.combo)[1].products.map((x) => x.itemId), [productNamed(after, 'Brownie').id, productNamed(after, 'Cookie').id]);
  assert.deepEqual(ownProducts(after, B, raw).filter((o) => !o.archived), []);
  // The whole set writes nothing at the site.
  assert.deepEqual(planAt(after, r.changes, B, raw).lines, []);
});

test('publish leaves a site\'s own Combo alone until it is brought in', () => {
  const { v, central } = setup();
  const raw = addOwn(v[B]);
  const before = JSON.stringify(raw.items.find((i) => i.id === 'own-byo'));
  for (const loc of [A, B]) {
    const plan = planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: loc, orgId: ORG, venue: loc === B ? raw : v[A] });
    for (const part of ['writes', 'lines', 'writtenItemIds', 'insertedItemIds', 'managedItemIds', 'problems']) {
      assert.ok(!(JSON.stringify(plan[part]) || '').includes('own-byo'), `plan.${part} never names the site's own Combo (${loc})`);
    }
    // No other product of the group menu has steps, so no write names the steps at all.
    assert.ok(!(JSON.stringify(plan.writes) || '').includes('"combo"'), 'no write names a combo column');
  }
  assert.equal(JSON.stringify(raw.items.find((i) => i.id === 'own-byo')), before, 'planning never changes the site row it read');
});

test('a site joining the group can link its own copy of a group Combo; the screens show every Combo with its buttons', () => {
  const { v, central } = setup();
  const raw = addOwn(v[B]);
  // The group's own Combo is offered to a joining site like any of the group's products.
  assert.ok(Array.isArray(joinableProducts(central, B, raw, raw.menus[0].id)));
  // The stage 1 words and the held list are gone.
  const bring = read('./msmBringIn.js');
  assert.ok(!/comboStaysWords|held:/.test(bring));
  assert.match(bring, /filter\(\(o\) => !o\.archived && o\.match && o\.match\.how === 'family'\)/);
  const sites = read('../../backoffice/sections/msm/MsmSites.jsx');
  assert.ok(!/o\.held/.test(sites), 'both own product lists show the buttons for a Combo too');
  assert.match(read('../../backoffice/sections/msm/MsmImport.jsx'), /combosKeptWords\(r\)/);
  // The first import is the one place that still leaves it at its site.
  assert.match(read('../../../supabase/functions/_shared/msmImport.js'), /if \(comboWithSteps\(row\)\) \{\n\s+if \(row\.archived !== true\) combosKept\.push\(/);
});
