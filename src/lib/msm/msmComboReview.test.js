// msmComboReview.test.js: the independent review of stage 2 (a Combo with steps in the Multi site
// menu, 5.12.124, 27 Nov 2026). Each fix is pinned on the reviewer's own scenario:
//   1  a step product turned on at a site joins the step there even when the Combo is in the same
//      publish for another reason (its price), and nothing shows as drift afterwards
//   2  a step product made into something no step may hold (an option only sub item, another
//      Combo) is stopped in the group menu, in words, and on the product sheet before it is staged
//   3  a Combo whose steps can all be skipped, at a site that sells none of their products, keeps its
//      steps there (it never sells as a plain product at the set price) and holds that site back
//   4  linking a site's own copy of a step product is said in words, never "would change"
//   5  the first import never keeps a site's steps (its database function knows no kept `combo`)
//   6  Bring in stops, in words: a step product on another menu, a must step left with nothing, a
//      lookalike no step may hold
//   7  the health check counts what the POS can really offer (shown on the POS, a size on sale)
//   8  a removed Combo, or its row deleted at a site, is never written when a step product changes
//   9  drift says changed steps in words, and the same steps saved another way are not drift
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeImport, buildCentral, touchEverything, importPayload } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges, previewSet, siteDrift } from '../../../supabase/functions/_shared/msmDiff.js';
import { checkSite, checkCentral } from '../../../supabase/functions/_shared/msmHealth.js';
import { appliedRaw } from '../../../supabase/functions/_shared/msmSnapshot.js';
import { KEPT_COLUMNS } from '../../../supabase/functions/_shared/msmModel.js';
import { A, B, C, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S } from './msmGroupFixture.js';
import { newProductChanges, productUpdate, stepUseProblems } from './msmEdit.js';
import { bringInChanges, bringInAllChanges } from './msmBringIn.js';
import { comboHasSteps, comboSteps, comboStepsOf, comboUnsellable } from '../combo.js';

const COMBO = '77777777-0000-4000-8000-00000000c0b0';
const SITES = { [A]: 'Site A', [B]: 'Site B', [C]: 'Site C' };
const MENU = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
const clone = (x) => JSON.parse(JSON.stringify(x));

// The fixture's own three sites: C sells no Cookie, has Tea turned off and is the only one with Pie.
function setup({ sqlRun = false } = {}) {
  const v = groupVenues();
  const sites = groupSites(v);
  const central = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') }).central;
  // Rows read from the database carry the steps column once SQL 20261216a has run.
  if (sqlRun) central.products = central.products.map((p) => ({ ...p, combo: p.combo ?? null }));
  central.menu = MENU;
  const P = (n) => central.products.find((p) => p.name === n);
  return { v, central, P };
}
const step = (id, name, selectionType, min, max, pricing, products) => ({ id, name, selectionType, min, max, pricing, products: products.map((p) => (typeof p === 'string' ? { itemId: p, bump: 0 } : p)) });
const dealSteps = (P) => ({ v: 1, steps: [
  step('st-drink', 'Pick a drink', 'single', 1, 1, 'set', [P('Latte').id, P('Tea').id, P('Mocha').id]),
  step('st-bite', 'Pick 2 bites', 'quantity', 2, 2, 'set', [P('Donut').id, { itemId: P('Cookie').id, bump: 0.5 }]),
  step('st-pie', 'Add a pie?', 'multiple', 0, 99, 'own', [P('Pie').id]),
] });
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
function publish(central, v, changes) {
  const after = applyChanges(central, changes).central;
  const next = { ...v };
  const plans = {};
  for (const loc of [A, B, C]) {
    plans[loc] = planSite({ central: after, touched: touchedFromChanges(changes), locationId: loc, orgId: ORG, venue: v[loc] });
    next[loc] = appliedRaw(v[loc], plans[loc]);
  }
  return { central: after, v: next, plans };
}
const itemOf = (raw, id) => raw.items.find((i) => i.id === id);
const comboAt = (st, loc) => itemOf(st.v[loc], st.central.productSites.find((ps) => ps.product_id === COMBO && ps.location_id === loc).venue_item_id);
const stepIds = (row, stepId) => (comboSteps(row).find((s) => s.id === stepId)?.products || []).map((p) => p.itemId);
const on = (P, name, loc, active) => ({ target: 'product_site', entity_id: P(name).id, location_id: loc, op: 'update', after: { active }, before: { active: !active } });
// A product of the site's own, made from a real row of the fixture so every column is there.
const ownRow = (raw, id, name, more) => {
  const base = raw.items.find((i) => i.id === S('m-mocha', B)) || raw.items.find((i) => i.id === 'm-mocha');
  return { ...base, id, name, menu_name: name, receipt_name: name, kitchen_name: name.toUpperCase(), master_id: null, scope: 'local', assigned_modifier_groups: [], ...more };
};

test('1. a step product joins at a site even when the Combo is in the same publish, and no drift follows', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  assert.deepEqual(stepIds(comboAt(first, C), 'st-drink'), [S('m-latte', C), S('m-mocha', C)]);
  // Tea goes on sale at Site C in the same publish as a new price for the Combo.
  const price = { target: 'product', entity_id: COMBO, location_id: null, op: 'update', after: { default_price: 7 }, before: { default_price: 6 } };
  const both = publish(first.central, first.v, [price, on(P, 'Tea', C, true)]);
  assert.deepEqual(stepIds(comboAt(both, C), 'st-drink'), [S('m-latte', C), S('m-tea', C), S('m-mocha', C)], 'Tea joins the step at C');
  assert.equal(both.plans[C].lines.filter((l) => l.column === 'combo').length, 1);
  assert.deepEqual(siteDrift(both.central, C, both.v[C]), []);
  // A later set touching another step product shows nothing changed at the venue (the knock on the
  // review found: the missed join showed up as "changed at the venue" on every later publish).
  const mocha = { target: 'product', entity_id: P('Mocha').id, location_id: null, op: 'update', after: { description: 'Rich' }, before: { description: '' } };
  const atC = previewSet(both.central, [mocha], both.v, { orgId: ORG, siteNames: SITES }).sites.find((s) => s.location_id === C);
  assert.deepEqual(atC.drift, []);
  assert.deepEqual(atC.lines.map((l) => l.column), ['description']);
});

test('2. a step product made into something no step may hold is stopped in the group menu and on the sheet', () => {
  const { v, central, P } = setup();
  const steps = { v: 1, steps: [step('st-bite', 'Pick a bite', 'single', 1, 1, 'set', [P('Donut').id])] };
  const first = publish(central, v, newCombo(central, P, { steps }));
  const donut = first.central.products.find((p) => p.name === 'Donut');
  const ctx = { live: first.central, eff: first.central };
  for (const [fields, why, what] of [
    [{ type: 'subitem', sold_alone: false }, 'That is an option only, not a product. Turn on Sold alone to use it in a Combo.', 'a sub item that is only an option'],
    [{ type: 'combo' }, 'A Combo cannot go inside another Combo.', 'another Combo'],
  ]) {
    // Staged another way (an old draft, a second tab): the publish is held back centrally, in words.
    const ch = { target: 'product', entity_id: donut.id, location_id: null, op: 'update', after: fields, before: { type: donut.type, sold_alone: donut.sold_alone } };
    const c = checkCentral(applyChanges(first.central, [ch]).central, touchedFromChanges([ch]));
    assert.deepEqual(c.blocking.filter((b) => b.productId === COMBO).map((b) => [b.code, b.words]), [
      ['combo_product_refused', `"Pick a bite" in "Breakfast Deal" lists Donut: ${why}`],
      ['combo_step_empty', '"Pick a bite" in "Breakfast Deal" has no product in the group menu, and customers must choose. Add a product to the step, or let customers skip it.'],
    ]);
    // The product sheet never stages it.
    const r = productUpdate(ctx, donut.id, fields);
    assert.equal(r.change, undefined);
    assert.equal(r.words, `Donut is in a step of Breakfast Deal, and a step cannot hold ${what}. Take Donut out of that step first.`);
  }
  // A product no step names is free to change, and so is a step product into anything a step may hold.
  assert.deepEqual(stepUseProblems({ ...P('Cola'), type: 'subitem', sold_alone: false }, ctx), []);
  assert.deepEqual(stepUseProblems({ ...donut, type: 'subitem', sold_alone: true }, ctx), []);
  // A Combo that was removed from the group menu holds nothing back.
  const gone = { ...first.central, products: first.central.products.map((p) => (p.id === COMBO ? { ...p, archived: true } : p)) };
  assert.deepEqual(stepUseProblems({ ...donut, type: 'combo' }, { live: gone, eff: gone }), []);
});

test('3. a Combo whose steps can all be skipped keeps its steps where none of their products is sold, and that site is held back', () => {
  {
    const { v, central, P } = setup();
    const steps = { v: 1, steps: [step('st-pie', 'Add a pie?', 'multiple', 0, 3, 'set', [P('Pie').id])] };   // only Site C sells Pie
    const pv = previewSet(central, newCombo(central, P, { steps, name: 'Pie Box' }), v, { orgId: ORG, siteNames: SITES });
    assert.equal(pv.ok, false);
    for (const s of pv.sites) {
      const row = s.plan.writes.items.insert.find((i) => i.name === 'Pie Box');
      assert.equal(comboHasSteps(row), true, `${s.name}: still a Combo with steps, never a plain product at the set price`);
      if (s.location_id === C) {
        assert.deepEqual(stepIds(row, 'st-pie'), ['l-pie-c']);
        assert.equal(s.health.ok, true);
        continue;
      }
      assert.deepEqual(stepIds(row, 'st-pie'), [], `${s.name}: the step is there, empty`);
      // The preview lists each site under its name ("this site"); the server names it (msm-publish).
      assert.deepEqual(s.health.blocking.map((b) => [b.code, b.words]), [['combo_nothing_here',
        '"Pie Box" has steps, but none of their products is on sale at this site, so nothing could be picked there. Turn some of its products on at this site, or turn "Pie Box" off there.']]);
      assert.deepEqual(checkSite(s.plan, { siteName: s.name }).blocking.map((b) => b.words), [
        `"Pie Box" has steps, but none of their products is on sale at ${s.name}, so nothing could be picked there. Turn some of its products on at ${s.name}, or turn "Pie Box" off there.`]);
      // And if it ever got there, the POS would refuse to sell it with nothing picked.
      assert.match(comboUnsellable({ ...row, archived: false }, { rowsById: new Map() }), /nothing can be picked/);
    }
  }
  {
    // Published at Site A, then every product of its only step comes off sale there.
    const { v, central, P } = setup();
    const steps = { v: 1, steps: [step('st-bite', 'Add a bite?', 'multiple', 0, 2, 'set', [P('Donut').id, P('Cookie').id])] };
    const first = publish(central, v, newCombo(central, P, { steps, name: 'Bite Box', sites: [A] }));
    assert.equal(comboHasSteps(comboAt(first, A)), true);
    const pv = previewSet(first.central, [on(P, 'Donut', A, false), on(P, 'Cookie', A, false)], first.v, { orgId: ORG, siteNames: SITES });
    const atA = pv.sites.find((s) => s.location_id === A);
    assert.ok(atA.lines.some((l) => l.words === 'Bite Box: its steps here are Add a bite? (0 products)'), JSON.stringify(atA.lines.map((l) => l.words)));
    assert.deepEqual(atA.health.blocking.map((b) => b.code), ['combo_nothing_here']);
  }
});

test('4. linking a site\'s own copy of a step product is said in words, never "something at the site would change"', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  // The group's Pie is at Site C only, so Site A's Combo has no pie step. Site A sells its own Pie.
  assert.deepEqual(comboSteps(comboAt(first, A)).map((s) => s.id), ['st-drink', 'st-bite']);
  const rawA = clone(first.v[A]);
  rawA.items.push(ownRow(rawA, 'own-pie-a', 'Pie', { type: 'simple', pricing: { base: 4 } }));
  const link = bringInChanges(first.central, A, rawA, 'own-pie-a', { linkTo: P('Pie').id, siteName: 'Site A' });
  assert.ok(link.ok, link.problems.join(' | '));
  assert.ok(link.words.includes('Breakfast Deal at Site A will offer Pie in its steps once this is published.'), link.words.join(' | '));
  // Publishing it writes only that: the pie step at A, naming A's own Pie.
  const plan = planSite({ central: applyChanges(first.central, link.changes).central, touched: touchedFromChanges(link.changes), locationId: A, orgId: ORG, venue: rawA });
  assert.deepEqual(plan.lines.map((l) => l.column), ['combo']);
  assert.deepEqual(stepIds({ type: 'combo', combo: plan.lines[0].after }, 'st-pie'), ['own-pie-a']);
  // Bring in all says the same. Bringing it in as a new product (not the group's Pie) changes no step.
  const all = bringInAllChanges(first.central, A, rawA, { siteName: 'Site A', orgId: ORG });
  assert.ok(all.ok && all.words.includes('Breakfast Deal at Site A will offer Pie in its steps once this is published.'), all.words.join(' | '));
  const asNew = bringInChanges(first.central, A, rawA, 'own-pie-a', { linkTo: null, siteName: 'Site A' });
  assert.ok(asNew.ok, asNew.problems.join(' | '));
  assert.ok(!asNew.words.some((w) => /in its steps/.test(w)), asNew.words.join(' | '));
});

test('5. the first import never keeps a site\'s steps, and a former Combo\'s parked steps are left alone', () => {
  const v = groupVenues();
  // Site B's Mocha used to be a Combo with steps (the steps stay saved on its row); Site B's "Deal"
  // is a Combo whose list of steps was emptied by hand.
  const mocha = v[B].items.find((i) => i.id === S('m-mocha', B));
  v[B].items.push(ownRow(v[B], 'own-deal', 'Deal', { type: 'combo', pricing: { base: 9 }, combo: { v: 1, steps: [] } }));
  mocha.combo = { v: 1, steps: [step('st', 'Pick a bite', 'single', 1, 1, 'set', [S('m-donut', B)])] };
  const sites = groupSites(v);
  const built = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  assert.equal(built.check.ok, true);
  assert.ok(built.central.productSites.some((ps) => ps.venue_item_id === 'own-deal'), 'the Combo with no steps comes in');
  // What the live msm_import_commit lets a site keep: 20261216a does not change that function.
  const importKeeps = KEPT_COLUMNS.filter((k) => k !== 'combo');
  const payload = importPayload(built.central, { orgId: ORG, name: 'G', description: '' });
  for (const p of payload.products) {
    for (const s of p.sites || []) assert.deepEqual(Object.keys(s.kept || {}).filter((k) => !importKeeps.includes(k)), [], `${p.name} at ${s.venue_item_id}`);
  }
  // A later publish of everything never writes the parked steps either.
  const central = { ...built.central, menu: MENU };
  const plan = planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: B, orgId: ORG, venue: v[B] });
  assert.deepEqual(plan.lines.filter((l) => l.column === 'combo'), []);
});

test('6. Bring in stops, in words: a step product on another menu, a must step left with nothing, a lookalike no step may hold', () => {
  const { v, central } = setup({ sqlRun: true });
  // (a) Site B's own Combo lists a tray from its Catering menu, which the group menu does not manage.
  const ra = clone(v[B]);
  ra.menus.push({ ...ra.menus[0], id: 'menu-catering-b', name: 'Catering', is_default: false, sort_order: 9 });
  ra.categories.push({ ...ra.categories[0], id: 'cat-trays-b', label: 'Trays', menu_id: 'menu-catering-b', parent_id: null });
  ra.items.push(ownRow(ra, 'own-tray', 'Cookie tray', { type: 'simple', pricing: { base: 20 }, cat: 'cat-trays-b', cats: [] }));
  ra.items.push(ownRow(ra, 'own-office', 'Office deal', { type: 'combo', pricing: { base: 30 }, combo: { v: 1, steps: [step('st', 'Pick a tray', 'single', 1, 1, 'set', ['own-tray'])] } }));
  assert.deepEqual(bringInChanges(central, B, ra, 'own-office', { siteName: 'Site B' }), { ok: false, changes: [], words: [], problems: [
    'Office deal cannot come in yet. Its step "Pick a tray" lists Cookie tray: it is on another of Site B\'s menus, not the one the group menu manages there. Take it out of the step, or move it onto that menu at Site B, first. Nothing was added to the draft.',
  ] });
  // (b) A must choose step whose only product is the site's own and switched off there.
  const rb = clone(v[B]);
  rb.items.push(ownRow(rb, 'own-bread', 'Garlic bread', { type: 'simple', pricing: { base: 3 }, archived: true }));
  rb.items.push(ownRow(rb, 'own-pasta', 'Pasta deal', { type: 'combo', pricing: { base: 9 }, combo: { v: 1, steps: [
    step('st-coffee', 'Pick a coffee', 'single', 1, 1, 'set', [S('m-latte', B)]),
    step('st-bread', 'Pick a bread', 'single', 1, 1, 'set', ['own-bread']),
  ] } }));
  assert.deepEqual(bringInChanges(central, B, rb, 'own-pasta', { siteName: 'Site B' }).problems, [
    'Pasta deal cannot come in yet. Its step "Pick a bread" must be answered, needs a product, and none can come into the group menu (Garlic bread is switched off at Site B). Turn one on at Site B, or let customers skip that step, first. Nothing was added to the draft.',
  ]);
  // Bring in all leaves that Combo out, says why, and brings the rest.
  const all = bringInAllChanges(central, B, rb, { idGen: idGen('k'), siteName: 'Site B', orgId: ORG });
  assert.ok(all.problems.some((w) => w.startsWith('Pasta deal cannot come in yet.')), all.problems.join(' | '));
  assert.ok(!applyChanges(central, all.changes || []).central.products.some((p) => p.name === 'Pasta deal'));
  // (c) A step product of the site's own that looks like the group's Vanilla, an option only there.
  const rc = clone(v[B]);
  rc.items.push(ownRow(rc, S('m-van', B), 'Vanilla', { type: 'subitem', sold_alone: true, pricing: { base: 1 } }));
  rc.items.push(ownRow(rc, 'own-vdeal', 'Vanilla deal', { type: 'combo', pricing: { base: 5 }, combo: { v: 1, steps: [step('st', 'Pick a flavour', 'single', 1, 1, 'set', [S('m-van', B)])] } }));
  assert.deepEqual(bringInChanges(central, B, rc, 'own-vdeal', { siteName: 'Site B' }).problems, [
    'Vanilla deal cannot come in yet. Its step "Pick a flavour" lists Vanilla: it is the group menu\'s Vanilla, which no step may hold there (That is an option only, not a product. Turn on Sold alone to use it in a Combo.) Change that in the group menu first. Nothing was added to the draft.',
  ]);
});

test('7. the health check counts only what the POS can offer: on sale, shown on the POS, a size on sale', () => {
  const deal = { id: 'deal', name: 'Deal', type: 'combo', archived: false, cat: 'c1', pricing: { base: 6 }, combo: { v: 1, steps: [step('st', 'Pick a drink', 'single', 1, 1, 'set', ['latte', 'cola'])] } };
  const health = (rows) => checkSite({
    locationId: A, applied: { items: [deal, ...rows], groups: [] }, writtenItemIds: ['deal'], insertedItemIds: [],
    lines: [{ table: 'items', id: 'deal', productId: COMBO, column: 'combo' }], problems: [],
  }, { siteName: 'Site A' });
  const latte = { id: 'latte', name: 'Latte', archived: false, cat: 'c1', pricing: { base: 3 } };
  const cola = { id: 'cola', name: 'Cola', type: 'variants', archived: false, cat: 'c1', pricing: {} };
  const small = { id: 'cola-s', name: 'Small', parent_id: 'cola', archived: false, cat: 'c1', pricing: { base: 2 } };
  const hidden = { ...latte, visibility: { notShownOn: ['pos'] } };
  assert.deepEqual(health([latte, cola, small]).blocking, []);
  // The Latte hidden on the POS by head office and the Cola's only size off: nothing can be picked.
  assert.deepEqual(health([hidden, cola, { ...small, archived: true }]).blocking.map((b) => [b.code, b.words]), [['combo_step_unmet',
    '"Pick a drink" in "Deal" has no product on sale at Site A, so nobody could finish it there. Turn one of its products on at Site A, or turn "Deal" off there.']]);
  // Hidden only on the kiosk, the POS still offers it; a size on sale is enough.
  assert.deepEqual(health([{ ...latte, visibility: { notShownOn: ['kiosk'] } }, cola, { ...small, archived: true }]).blocking, []);
  assert.deepEqual(health([hidden, cola, small]).blocking, []);
});

test('8. a removed Combo, or its row deleted at a site, is never written when a step product changes', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  const teaOn = on(P, 'Tea', C, true);
  // Removed from the group menu, then Tea goes on sale at Site C: only Tea is written there.
  const removed = publish(first.central, first.v, [{ target: 'product', entity_id: COMBO, location_id: null, op: 'remove', after: { archived: true }, before: { archived: false } }]);
  assert.deepEqual(publish(removed.central, removed.v, [teaOn]).plans[C].lines.map((l) => l.column), ['archived']);
  // The Combo's row deleted by hand at Site C: the same, with no problem and nothing made again.
  const vC = { ...first.v[C], items: first.v[C].items.filter((i) => i.id !== comboAt(first, C).id) };
  const p2 = planSite({ central: applyChanges(first.central, [teaOn]).central, touched: touchedFromChanges([teaOn]), locationId: C, orgId: ORG, venue: vC });
  assert.deepEqual(p2.problems, []);
  assert.deepEqual(p2.lines.map((l) => l.column), ['archived']);
  // A new price for a step product writes no steps anywhere.
  const latte = { target: 'product', entity_id: P('Latte').id, location_id: null, op: 'update', after: { default_price: 3.2 }, before: { default_price: P('Latte').default_price } };
  const r3 = publish(first.central, first.v, [latte]);
  for (const loc of [A, B, C]) assert.ok(!JSON.stringify(r3.plans[loc].writes).includes('"combo"'), SITES[loc]);
});

test('9. drift says changed steps in words, and the same steps saved another way are not drift', () => {
  const { v, central, P } = setup();
  const first = publish(central, v, newCombo(central, P));
  const row = comboAt(first, A);
  const withSteps = (combo) => ({ ...first.v[A], items: first.v[A].items.map((i) => (i.id === row.id ? { ...i, combo } : i)) });
  // Site A changed its steps by hand.
  assert.deepEqual(siteDrift(first.central, A, withSteps({ v: 1, steps: [step('st-x', 'Mine', 'single', 1, 1, 'set', ['m-cola'])] })).map((d) => [d.column, d.words]),
    [['combo', 'Breakfast Deal: its steps at the venue are not the group\'s']]);
  // The same steps in another key order, with a bump of 0 left out: what the POS reads is the same.
  const loose = { steps: comboStepsOf(row.combo).map((s) => ({
    products: s.products.map((p) => (p.bump ? { bump: p.bump, itemId: p.itemId } : { itemId: p.itemId })),
    pricing: s.pricing, max: s.max, min: s.min, selectionType: s.selectionType, name: s.name, id: s.id,
  })), v: 1 };
  assert.deepEqual(siteDrift(first.central, A, withSteps(loose)), []);
});
