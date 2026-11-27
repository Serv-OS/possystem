// msmComboPlan.test.js: a Combo with steps in the GROUP menu, published to each site (5.12.124).
//
// Peter, 27 Nov 2026: "make sure its also in the multi site menu manager properly".
// The group menu holds a Combo's steps in the same shape a site does (msm_products.combo), with
// each step product being one of the group menu's own products. Publish writes each site's Combo
// with those swapped for THAT site's own items (supabase/functions/_shared/msmPlan.js mapCombo):
//   * a step product not sold at a site is left out there, and said;
//   * a step nobody has to answer that ends up empty is left out there;
//   * a step that MUST be answered and cannot be met holds that site back in words
//     (msmHealth combo_step_unmet), and the other sites still publish;
//   * a product turned on or off at a site joins or leaves the step there, with no change to the
//     Combo itself;
//   * a site that keeps its own steps is never written;
//   * nothing odd crashes the planner (a deleted site menu, a removed step product).
// The fixture is the Multi site menu's own three sites: A and B sell most things, C sells no
// Cookie, has Tea turned off and is the only one with Pie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, touchEverything } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, previewSet } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite, checkCentral } from '../../../supabase/functions/_shared/msmHealth.js';
import { checkChange, VENUE_INSERT, VENUE_UPDATE, STAGE_FIELDS, KEPT_COLUMNS, PRODUCT_COLUMN } from '../../../supabase/functions/_shared/msmModel.js';
import { appliedRaw } from '../../../supabase/functions/_shared/msmSnapshot.js';
import { A, B, C, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S } from './msmGroupFixture.js';
import { newProductChanges, productUpdate, comboProblems } from './msmEdit.js';
import { comboHasSteps, comboSteps } from '../combo.js';

const COMBO = '77777777-0000-4000-8000-00000000c0b0';
const SITES = { [A]: 'Site A', [B]: 'Site B', [C]: 'Site C' };

function setup() {
  const v = groupVenues();
  const sites = groupSites(v);
  const central = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  const P = (n) => central.products.find((p) => p.name === n);
  return { v, central, P };
}
const step = (id, name, selectionType, min, max, pricing, products) => ({ id, name, selectionType, min, max, pricing, products: products.map((p) => (typeof p === 'string' ? { itemId: p, bump: 0 } : p)) });
// "Breakfast Deal": a drink (must choose), two bites (Cookie costs 0.50 more), and a pie that keeps its price.
const dealSteps = (P) => ({ v: 1, steps: [
  step('st-drink', 'Pick a drink', 'single', 1, 1, 'set', [P('Latte').id, P('Tea').id, P('Mocha').id]),
  step('st-bite', 'Pick 2 bites', 'quantity', 2, 2, 'set', [P('Donut').id, { itemId: P('Cookie').id, bump: 0.5 }]),
  step('st-pie', 'Add a pie?', 'multiple', 0, 99, 'own', [P('Pie').id]),
] });
// The fixture's group works on VAT rates, so a product names one (the Latte's).
const tax = (P) => ({ tax_rate_name: P('Latte').tax_rate_name, tax_rate_percent: P('Latte').tax_rate_percent });
function newCombo(central, P, { steps = dealSteps(P), sites = [A, B, C], name = 'Breakfast Deal' } = {}) {
  const r = newProductChanges({ live: central, eff: central }, {
    id: COMBO,
    fields: { name, type: 'combo', category_id: P('Latte').category_id, default_price: 6, ...tax(P), combo: steps },
    sites: sites.map((l) => ({ location_id: l, active: true, price: null })),
  });
  assert.ok(r.changes, r.words);
  return r.changes;
}
const plan = (central, changes, loc, venue) => {
  const after = applyChanges(central, changes).central;
  return { after, plan: planSite({ central: after, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue }) };
};
// Publish a set everywhere: the group menu and each site as they are afterwards.
function publish(central, v, changes) {
  const after = applyChanges(central, changes).central;
  const next = {};
  const plans = {};
  for (const loc of [A, B, C]) {
    plans[loc] = planSite({ central: after, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue: v[loc] });
    next[loc] = appliedRaw(v[loc], plans[loc]);
  }
  return { central: after, v: next, plans };
}
const itemOf = (raw, id) => raw.items.find((i) => i.id === id);
const stepIds = (row, stepId) => (comboSteps(row).find((s) => s.id === stepId)?.products || []).map((p) => p.itemId);
const codes = (list) => list.map((p) => p.code);

test('the model knows the field: staged, written on new and existing rows, and a site can keep its own', () => {
  assert.ok(STAGE_FIELDS.product.includes('combo'));
  assert.equal(PRODUCT_COLUMN.combo, 'combo');
  assert.ok(VENUE_INSERT.items.includes('combo') && VENUE_UPDATE.items.includes('combo'));
  assert.ok(KEPT_COLUMNS.includes('combo'));
});

test('a new Combo is staged with its steps, and a new product of any other kind carries no such key', () => {
  const { central, P } = setup();
  const changes = newCombo(central, P);
  for (const c of changes) assert.ok(checkChange(c).ok, `${c.target}: ${checkChange(c).words}`);
  const create = changes.find((c) => c.target === 'product');
  assert.equal(create.after.type, 'combo');
  assert.deepEqual(create.after.combo.steps.map((s) => [s.id, s.name, s.selectionType, s.min, s.max, s.pricing, s.products.length]), [
    ['st-drink', 'Pick a drink', 'single', 1, 1, 'set', 3], ['st-bite', 'Pick 2 bites', 'quantity', 2, 2, 'set', 2], ['st-pie', 'Add a pie?', 'multiple', 0, 99, 'own', 1],
  ]);
  assert.equal(create.after.combo.steps[1].products[1].bump, 0.5);
  // Any other product: the change is what it always was (SQL 20261216a is not needed for it).
  const plain = newProductChanges({ live: central, eff: central }, { id: COMBO, fields: { name: 'Scone', type: 'simple', category_id: P('Latte').category_id, default_price: 2, ...tax(P) }, sites: [{ location_id: A, active: true }] });
  assert.equal('combo' in plain.changes[0].after, false);
  // A Combo with no steps too.
  const bare = newProductChanges({ live: central, eff: central }, { id: COMBO, fields: { name: 'Plain deal', type: 'combo', category_id: P('Latte').category_id, default_price: 2, ...tax(P), combo: null }, sites: [{ location_id: A, active: true }] });
  assert.equal('combo' in bare.changes[0].after, false);
});

test('publish writes each site\'s Combo with that site\'s own items, and leaves out what it does not sell', () => {
  const { v, central, P } = setup();
  const changes = newCombo(central, P);
  const rows = {};
  const plans = {};
  for (const loc of [A, B, C]) {
    const r = plan(central, changes, loc, v[loc]);
    plans[loc] = r.plan;
    const ins = r.plan.writes.items.insert.find((i) => i.name === 'Breakfast Deal');
    assert.ok(ins, `inserted at ${SITES[loc]}`);
    assert.equal(ins.type, 'combo');
    assert.equal(ins.pricing.base, 6);
    rows[loc] = ins;
    assert.equal(comboHasSteps(ins), true);
    // Every key of the new row is one the database lets publish write.
    for (const k of Object.keys(ins)) assert.ok(VENUE_INSERT.items.includes(k) || k === 'tax_profile_id', `${k} may be written on a new row`);
    // And every item a step names is at THIS site (already there).
    for (const id of comboSteps(ins).flatMap((s) => s.products.map((p) => p.itemId))) assert.ok(itemOf(v[loc], id), `${id} is one of ${SITES[loc]}'s own items`);
  }
  // Site A: Latte, Tea and Mocha; Donut and Cookie (with its bump). Nobody sells Pie there, so the
  // step nobody has to answer is left out.
  assert.deepEqual(stepIds(rows[A], 'st-drink'), ['m-latte', 'm-tea', 'm-mocha']);
  assert.deepEqual(comboSteps(rows[A]).find((s) => s.id === 'st-bite').products, [{ itemId: 'm-donut', bump: 0 }, { itemId: 'l-cookie-a', bump: 0.5 }]);
  assert.deepEqual(comboSteps(rows[A]).map((s) => s.id), ['st-drink', 'st-bite']);
  // Site B: its own ids.
  assert.deepEqual(stepIds(rows[B], 'st-drink'), [S('m-latte', B), S('m-tea', B), S('m-mocha', B)]);
  assert.deepEqual(stepIds(rows[B], 'st-bite'), [S('m-donut', B), 'l-cookie-b']);
  // Site C: Tea is turned off there and it has no Cookie, so both are left out; it is the one site with Pie.
  assert.deepEqual(stepIds(rows[C], 'st-drink'), [S('m-latte', C), S('m-mocha', C)]);
  assert.deepEqual(stepIds(rows[C], 'st-bite'), [S('m-donut', C)]);
  assert.deepEqual(comboSteps(rows[C]).find((s) => s.id === 'st-pie'), { id: 'st-pie', name: 'Add a pie?', selectionType: 'multiple', min: 0, max: 99, pricing: 'own', products: [{ itemId: 'l-pie-c', bump: 0 }] });
  // What was left out is said, once each, as a warning. Nothing blocks.
  const said = (loc) => plans[loc].problems.filter((p) => p.code === 'combo_pick_left_out').map((p) => p.words);
  assert.deepEqual(said(A), ['"Pie" is not sold at this site, so it is left out of "Add a pie?" in "Breakfast Deal" here.']);
  assert.deepEqual(said(C), [
    '"Tea" is not sold at this site, so it is left out of "Pick a drink" in "Breakfast Deal" here.',
    '"Cookie" is not sold at this site, so it is left out of "Pick 2 bites" in "Breakfast Deal" here.',
  ]);
  for (const loc of [A, B, C]) {
    const h = checkSite(plans[loc], { siteName: SITES[loc] });
    assert.deepEqual(h.blocking, [], `${SITES[loc]}: ${h.blocking.map((b) => b.words).join(' | ')}`);
    assert.equal(h.ok, true);
  }
});

test('a step that MUST be answered and cannot be met holds that site back, and the others still publish', () => {
  const { v, central, P } = setup();
  // Only Site C sells Pie, and the step must be answered.
  const steps = { v: 1, steps: [step('st-pie', 'Pick a pie', 'single', 1, 1, 'set', [P('Pie').id])] };
  const changes = newCombo(central, P, { steps, name: 'Pie Deal' });
  const health = {};
  for (const loc of [A, B, C]) health[loc] = checkSite(plan(central, changes, loc, v[loc]).plan, { siteName: SITES[loc] });
  assert.deepEqual(codes(health[A].blocking), ['combo_step_unmet']);
  assert.equal(health[A].blocking[0].words, '"Pick a pie" in "Pie Deal" has no product on sale at Site A, so nobody could finish it there. Turn one of its products on at Site A, or turn "Pie Deal" off there.');
  assert.equal(health[A].ok, false);
  assert.equal(health[B].ok, false);
  assert.equal(health[C].ok, true, health[C].blocking.map((b) => b.words).join(' | '));
  // The whole set, as the screen previews it: C is fine, A and B are named.
  const pv = previewSet(central, changes, v, { orgId: ORG, siteNames: SITES });
  assert.deepEqual(pv.sites.map((s) => [s.name, s.health.ok]), [['Site A', false], ['Site B', false], ['Site C', true]]);
  // Fix it the way the words say: do not sell the Combo at A and B.
  const onlyC = newCombo(central, P, { steps, name: 'Pie Deal', sites: [C] });
  const pv2 = previewSet(central, onlyC, v, { orgId: ORG, siteNames: SITES });
  assert.equal(pv2.ok, true, JSON.stringify(pv2.sites.map((s) => s.health?.blocking)));
});

test('"each product only once" needs enough DIFFERENT products at a site', () => {
  const { v, central, P } = setup();
  const steps = { v: 1, steps: [step('st-two', 'Pick 2 different bites', 'multiple_once', 2, 2, 'set', [P('Donut').id, P('Cookie').id])] };
  const changes = newCombo(central, P, { steps, name: 'Bite Box' });
  assert.equal(checkSite(plan(central, changes, A, v[A]).plan, { siteName: 'Site A' }).ok, true);
  const hc = checkSite(plan(central, changes, C, v[C]).plan, { siteName: 'Site C' });   // no Cookie at C
  assert.deepEqual(codes(hc.blocking), ['combo_step_unmet']);
  assert.equal(hc.blocking[0].words, '"Pick 2 different bites" in "Bite Box" needs 2 different products on sale at Site C and has 1, so nobody could finish it there. Turn more of its products on at Site C, or turn "Bite Box" off there.');
});

test('a change to the steps is written to every site, only the steps, and a second publish writes nothing', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  // Nothing more to write once it is published, even with everything touched (the self check).
  for (const loc of [A, B, C]) {
    const again = planSite({ central: first.central, touched: touchedFromChanges(touchEverything(first.central)), locationId: loc, orgId: ORG, venue: first.v[loc] });
    assert.deepEqual(again.lines.filter((l) => l.productId === COMBO), [], `${SITES[loc]} is settled`);
  }
  // Head office takes Mocha out of the drinks and lets customers skip the bites.
  const now = dealSteps(P);
  now.steps[0].products = now.steps[0].products.filter((p) => p.itemId !== P('Mocha').id);
  now.steps[1] = step('st-bite', 'Pick up to 2 bites', 'multiple', 0, 2, 'set', [P('Donut').id, { itemId: P('Cookie').id, bump: 0.5 }]);
  const r = productUpdate({ live: first.central, eff: first.central }, COMBO, { combo: now });
  assert.ok(r.change, r.words);
  assert.deepEqual(Object.keys(r.change.after), ['combo']);
  assert.ok(checkChange(r.change).ok);
  const second = publish(first.central, first.v, [r.change]);
  for (const loc of [A, B, C]) {
    const upd = second.plans[loc].writes.items.update.filter((u) => u.id === first.central.productSites.find((ps) => ps.product_id === COMBO && ps.location_id === loc).venue_item_id);
    assert.equal(upd.length, 1, SITES[loc]);
    assert.deepEqual(Object.keys(upd[0].set), ['combo'], 'only the steps are written');
    assert.equal(second.plans[loc].writes.items.insert.length, 0);
    for (const k of Object.keys(upd[0].set)) assert.ok(VENUE_UPDATE.items.includes(k));
  }
  const rowA = itemOf(second.v[A], first.central.productSites.find((ps) => ps.product_id === COMBO && ps.location_id === A).venue_item_id);
  assert.deepEqual(stepIds(rowA, 'st-drink'), ['m-latte', 'm-tea']);
  assert.equal(comboSteps(rowA).find((s) => s.id === 'st-bite').name, 'Pick up to 2 bites');
  // The preview says it in words, with no ids.
  const line = second.plans[A].lines.find((l) => l.column === 'combo');
  assert.equal(lineWords(line, { [COMBO]: 'Breakfast Deal' }), 'Breakfast Deal: its steps here are Pick a drink (2 products), Pick up to 2 bites (2 products)');
  // The same change again: nothing to stage.
  assert.equal(productUpdate({ live: second.central, eff: second.central }, COMBO, { combo: now }).change, null);
});

test('a product turned on or off at a site joins or leaves the step there, with no change to the Combo', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  const comboAt = (st, loc) => itemOf(st.v[loc], st.central.productSites.find((ps) => ps.product_id === COMBO && ps.location_id === loc).venue_item_id);
  assert.deepEqual(stepIds(comboAt(first, C), 'st-drink'), [S('m-latte', C), S('m-mocha', C)]);
  // Tea goes on sale at Site C. Only that is staged.
  const teaOn = [{ target: 'product_site', entity_id: P('Tea').id, location_id: C, op: 'update', after: { active: true }, before: { active: false } }];
  const second = publish(first.central, first.v, teaOn);
  assert.deepEqual(stepIds(comboAt(second, C), 'st-drink'), [S('m-latte', C), S('m-tea', C), S('m-mocha', C)], 'Tea joins the step at C, in the group menu\'s order');
  assert.deepEqual(second.plans[A].lines, [], 'nothing changes at A');
  assert.deepEqual(second.plans[B].lines, [], 'nothing changes at B');
  // Cookie comes off sale at Site A: it leaves the step there. The step can still be answered.
  const cookieOff = [{ target: 'product_site', entity_id: P('Cookie').id, location_id: A, op: 'update', after: { active: false }, before: { active: true } }];
  const third = publish(second.central, second.v, cookieOff);
  assert.deepEqual(stepIds(comboAt(third, A), 'st-bite'), ['m-donut']);
  assert.equal(checkSite(third.plans[A], { siteName: 'Site A' }).ok, true);
  assert.ok(third.plans[A].problems.some((p) => p.code === 'combo_pick_left_out' && /"Cookie" is not sold at this site/.test(p.words)));
});

test('removing the last product of a must choose step is stopped, in words, before anything is written', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  const gone = ['Donut', 'Cookie'].map((n) => ({ target: 'product', entity_id: P(n).id, location_id: null, op: 'update', after: { archived: true }, before: { archived: false } }));
  const pv = previewSet(first.central, gone, first.v, { orgId: ORG, siteNames: SITES });
  assert.equal(pv.ok, false);
  for (const s of pv.sites) {
    assert.ok(s.health.blocking.some((b) => b.code === 'combo_step_unmet' && b.words.includes('"Pick 2 bites" in "Breakfast Deal" has no product on sale')), `${s.name}: ${JSON.stringify(s.health.blocking)}`);
  }
  // Removing only one of the two: the step can still be answered, so it goes through, and says so.
  const one = [gone[1]];
  const pv1 = previewSet(first.central, one, first.v, { orgId: ORG, siteNames: SITES });
  assert.equal(pv1.ok, true, JSON.stringify(pv1.sites.map((s) => s.health.blocking)));
  const planA = pv1.sites.find((s) => s.location_id === A).plan;
  assert.ok(planA.problems.some((p) => p.code === 'combo_pick_left_out' && p.words === '"Cookie" was removed from the group menu, so it is left out of "Pick 2 bites" in "Breakfast Deal".'));
});

test('the group menu itself refuses steps that could never work', () => {
  const { central, P } = setup();
  const ctx = { live: central, eff: central };
  const base = { id: COMBO, name: 'Deal', type: 'combo', category_id: P('Latte').category_id, default_price: 6, ...tax(P) };
  const fields = (steps) => ({ ...base, combo: { v: 1, steps } });
  assert.deepEqual(comboProblems(fields(dealSteps(P).steps), ctx), []);
  assert.deepEqual(comboProblems({ ...base, combo: null }, ctx), []);
  assert.deepEqual(comboProblems({ ...base, type: 'simple', combo: { v: 1, steps: [step('s', 'Empty', 'single', 1, 1, 'set', [])] } }, ctx), [], 'steps only count on a Combo');
  // A must choose step with nothing in it.
  assert.deepEqual(comboProblems(fields([step('s', 'Pick one', 'single', 1, 1, 'set', [])]), ctx), ['"Pick one" has no product, and customers must choose. Add a product to the step, or let customers skip it.']);
  // A step nobody has to answer may be empty (it is simply left out at every site).
  assert.deepEqual(comboProblems(fields([step('s', 'Extras?', 'multiple', 0, 3, 'set', [])]), ctx), []);
  // Itself, a sub item that is only an option, a variant as the Combo.
  assert.deepEqual(comboProblems(fields([step('s', 'Pick one', 'single', 1, 1, 'set', [COMBO, P('Latte').id])]), { live: central, eff: { ...central, products: [...central.products, { id: COMBO, name: 'Deal', type: 'combo' }] } }), ['"Pick one": A Combo cannot hold itself.']);
  assert.deepEqual(comboProblems(fields([step('s', 'Pick one', 'single', 1, 1, 'set', [P('Oat milk').id, P('Latte').id])]), ctx), ['"Pick one": That is an option only, not a product. Turn on Sold alone to use it in a Combo.']);
  assert.ok(comboProblems({ ...fields(dealSteps(P).steps), parent_product_id: P('Latte').id }, ctx).includes('A variant cannot be a Combo with steps.'));
  // The sheet cannot stage them: newProductChanges and productUpdate say the same words.
  const bad = newProductChanges(ctx, { id: COMBO, fields: fields([step('s', 'Pick one', 'single', 1, 1, 'set', [])]), sites: [{ location_id: A, active: true }] });
  assert.match(bad.words, /"Pick one" has no product, and customers must choose/);
  // And the health check holds the same line if one ever got into a draft another way.
  const staged = { ...base, combo: { v: 1, steps: [step('s', 'Pick one', 'single', 1, 1, 'set', [])] } };
  delete staged.id;                                            // a change's `after` never carries the id
  const after = applyChanges(central, [{ target: 'product', entity_id: COMBO, location_id: null, op: 'create', after: staged, before: {} }]).central;
  const c = checkCentral(after, touchedFromChanges([{ target: 'product', entity_id: COMBO, op: 'create', after: { combo: {} } }]));
  assert.ok(c.blocking.some((b) => b.code === 'combo_step_empty' && b.words === '"Pick one" in "Deal" has no product in the group menu, and customers must choose. Add a product to the step, or let customers skip it.'), JSON.stringify(c.blocking));
});

test('a site that keeps its own steps is never written; "Use the group\'s" writes them', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  const ps = first.central.productSites.find((x) => x.product_id === COMBO && x.location_id === B);
  const own = { v: 1, steps: [step('st-own', 'Site B special', 'single', 1, 1, 'set', [S('m-cola', B)])] };
  // Site B keeps its own steps (as Bring in records them).
  const keeps = { ...first.central, productSites: first.central.productSites.map((x) => (x === ps ? { ...x, kept: { ...(x.kept || {}), combo: own } } : x)) };
  const venueB = { ...first.v[B], items: first.v[B].items.map((i) => (i.id === ps.venue_item_id ? { ...i, combo: own } : i)) };
  const now = dealSteps(P);
  now.steps[0].name = 'Choose a drink';
  const change = productUpdate({ live: keeps, eff: keeps }, COMBO, { combo: now }).change;
  const after = applyChanges(keeps, [change]).central;
  const pb = planSite({ central: after, touched: touchedFromChanges([change]), locationId: B, orgId: ORG, venue: venueB });
  assert.deepEqual(pb.lines, [], 'Site B keeps its own steps');
  const pa = planSite({ central: after, touched: touchedFromChanges([change]), locationId: A, orgId: ORG, venue: first.v[A] });
  assert.equal(pa.lines.filter((l) => l.column === 'combo').length, 1, 'Site A takes the change');
  // "Use the group's" at B: the kept key is given back, and the group's steps are written there.
  const give = { target: 'product_site', entity_id: COMBO, location_id: B, op: 'update', after: { kept: {} }, before: { kept: { combo: own } } };
  const after2 = applyChanges(after, [give]).central;
  const pb2 = planSite({ central: after2, touched: touchedFromChanges([change, give]), locationId: B, orgId: ORG, venue: venueB });
  const line = pb2.lines.find((l) => l.column === 'combo');
  assert.ok(line, 'the steps are written at B now');
  assert.equal(comboSteps({ type: 'combo', combo: line.after })[0].name, 'Choose a drink');
});

test('odd states never crash the planner', () => {
  const { v, central, P } = setup();
  const changes = newCombo(central, P);
  const after = applyChanges(central, changes).central;
  const T = () => touchedFromChanges(changes);
  // 1. The site's own menu the group menu writes into was deleted at the site (the 5.12.122 crash).
  const noMenu = { ...v[A], menus: [] };
  const p1 = planSite({ central: after, touched: T(), locationId: A, orgId: ORG, venue: noMenu });
  assert.ok(p1.problems.some((p) => p.code === 'no_venue_menu'));
  assert.deepEqual(p1.writes.items.insert, []);
  // 2. A site that is not in the group menu at all.
  const p2 = planSite({ central: after, touched: T(), locationId: 'dddddddd-0000-4000-8000-0000000d0004', orgId: ORG, venue: v[A] });
  assert.equal(p2.notAtSite, true);
  // 3. A step names a product that is not in the group menu (deleted by hand, an old draft).
  const ghost = dealSteps(P);
  ghost.steps[0].products.push({ itemId: '00000000-0000-4000-8000-00000000dead', bump: 0 });
  const c3 = newCombo(central, P, { steps: ghost });
  const p3 = plan(central, c3, A, v[A]).plan;
  assert.deepEqual(stepIds(p3.writes.items.insert.find((i) => i.name === 'Breakfast Deal'), 'st-drink'), ['m-latte', 'm-tea', 'm-mocha']);
  assert.ok(p3.problems.some((p) => p.code === 'combo_pick_left_out' && p.words === '"Pick a drink" in "Breakfast Deal" lists a product that is no longer in the group menu. It is left out.'));
  // 4. Rubbish in the field: nothing is written for it and nothing throws.
  for (const junk of ['x', 7, [], { steps: 'x' }, { v: 1, steps: [null, 3] }]) {
    const cj = newCombo(central, P, { steps: dealSteps(P) });
    cj[0].after.combo = junk;
    const pj = plan(central, cj, A, v[A]).plan;
    assert.equal('combo' in pj.writes.items.insert.find((i) => i.name === 'Breakfast Deal'), false, JSON.stringify(junk));
  }
  // 5. A Combo that lists itself never points at itself at a site.
  const self = dealSteps(P);
  self.steps[0].products.unshift({ itemId: COMBO, bump: 0 });
  const c5 = newCombo(central, P, { steps: dealSteps(P) });
  c5[0].after.combo = self;
  const p5 = plan(central, c5, A, v[A]).plan;
  assert.deepEqual(stepIds(p5.writes.items.insert.find((i) => i.name === 'Breakfast Deal'), 'st-drink'), ['m-latte', 'm-tea', 'm-mocha']);
  // 6. The type is changed away from Combo: the steps are not written as steps.
  const first = publish(central, v, changes);
  const typed = { target: 'product', entity_id: COMBO, location_id: null, op: 'update', after: { type: 'simple', combo: dealSteps(P) }, before: { type: 'combo' } };
  const p6 = planSite({ central: applyChanges(first.central, [typed]).central, touched: touchedFromChanges([typed]), locationId: A, orgId: ORG, venue: first.v[A] });
  assert.deepEqual(p6.lines.map((l) => [l.column, l.after]), [['type', 'simple'], ['combo', null]]);
});

test('a publish of anything else never names the steps (so it runs on a database without SQL 20261216a)', () => {
  const { v, central, P } = setup();
  // A plain new product, a price change, a name change, a site turned on: no `combo` key anywhere.
  const scone = newProductChanges({ live: central, eff: central }, { id: COMBO, fields: { name: 'Scone', type: 'simple', category_id: P('Latte').category_id, default_price: 2, ...tax(P) }, sites: [A, B, C].map((l) => ({ location_id: l, active: true })) }).changes;
  const sets = [scone,
    [{ target: 'product', entity_id: P('Latte').id, location_id: null, op: 'update', after: { default_price: 9, name: 'Latte grande' }, before: { default_price: 3, name: 'Latte' } }],
    touchEverything(central),
  ];
  for (const changes of sets) {
    for (const loc of [A, B, C]) {
      const w = plan(central, changes, loc, v[loc]).plan.writes;
      assert.ok(!JSON.stringify(w).includes('"combo"'), `no steps key in the writes at ${SITES[loc]}`);
    }
  }
});
