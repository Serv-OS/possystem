// msmCombo.test.js: the Multi site menu and a site's own Combo with steps (5.12.123, stage 1).
//
// The brief: "the Multi site menu must not crash on, bring in, rewrite or delete a site's own
// Combo (Bring in and Sync from sites skip with one line of words; publish leaves alone)".
//
// A Combo built from steps lives in menu_items.combo, which the group menu has no model for yet
// (that is stage 2). So until then such a Combo is the SITE'S OWN and stays exactly as it is:
//   first import      left out of the group menu, and the review says so in one line
//   Bring in          refused at the one door, in words (the list shows the words, not the buttons)
//   Bring in all      left out, said once in "Left out", everything else still comes in
//   joining a site    never linked
//   publish           plans no write to it, and never names the combo column for any product
// A Combo with NO steps is an ordinary product and comes in exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { proposeImport, buildCentral, touchEverything, reviewWords, comboWithSteps } from '../../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges } from '../../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../../supabase/functions/_shared/msmDiff.js';
import { A, B, ORG, idGen } from './msmFixture.js';
import { groupVenues, groupSites, S } from './msmGroupFixture.js';
import { ownProducts, bringInChanges, bringInAllChanges, joinableProducts, comboStaysWords } from './msmBringIn.js';
import { combosKeptWords } from './msmImportReview.js';
import { comboHasSteps } from '../combo.js';

const STEPS = { v: 1, steps: [{ id: 'st-1', name: 'Pick 5 pizzas', selectionType: 'quantity', min: 5, max: 5, pricing: 'set', products: [{ itemId: 'm-x', bump: 0 }] }] };
const WORDS = 'Build Your Own Package is a Combo with steps. It stays at this site for now: Combos come to the group menu in a later update.';

function setup({ comboAtImport = false } = {}) {
  const v = groupVenues();
  if (comboAtImport) addCombos(v[B]);
  const sites = groupSites(v);
  const proposal = proposeImport(sites, { idGen: idGen() });
  const built = buildCentral(proposal, sites, {}, { idGen: idGen('g') });
  const central = built.central;
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  return { v, central, proposal };
}
// Site B gets two products of its own, made from a real row of the fixture so every column is there:
// a Combo built from steps, and a Combo with no steps (the kind that exists today).
function addCombos(raw) {
  const base = raw.items.find((i) => i.id === S('m-mocha', B));
  const own = (id, name, extra) => ({ ...base, id, name, menu_name: name, receipt_name: name, kitchen_name: name.toUpperCase(), master_id: null, scope: 'local', type: 'combo', assigned_modifier_groups: [], pricing: { base: 149 }, ...extra });
  raw.items.push(own('own-byo', 'Build Your Own Package', { combo: STEPS }));
  raw.items.push(own('own-plain', 'Plain Meal Deal', { combo: null, pricing: { base: 9 } }));
  return raw;
}
const writesAt = (central, changes, loc, venue, everything = true) => {
  const after = applyChanges(central, changes).central;
  const touched = touchedFromChanges(everything ? touchEverything(after) : changes);
  return planSite({ central: after, touched, locationId: loc, orgId: ORG, venue }).lines;
};

test('the server side reading of "a Combo with steps" is the app\'s own', () => {
  const rows = [
    { type: 'combo', combo: STEPS }, { type: 'combo', combo: STEPS.steps }, { type: 'combo', combo: { v: 1, steps: [] } },
    { type: 'combo', combo: null }, { type: 'combo' }, { type: 'combo', combo: 'x' }, { type: 'combo', combo: { steps: 'x' } },
    { type: 'combo', combo: { steps: [null, 3, 'a'] } }, { type: 'combo', combo: { steps: [[]] } },
    { type: 'simple', combo: STEPS }, { type: 'modifiable', combo: STEPS }, null, undefined, {},
  ];
  for (const r of rows) assert.equal(comboWithSteps(r), comboHasSteps(r), JSON.stringify(r));
  assert.equal(comboWithSteps(rows[0]), true);
  assert.equal(comboWithSteps(rows[3]), false);
});

test('the first import leaves a Combo with steps at its site, and says so in one line', () => {
  const { central, proposal } = setup({ comboAtImport: true });
  // Not a product of the group menu, not linked to any site row.
  assert.ok(!central.products.some((p) => p.name === 'Build Your Own Package'));
  assert.ok(!central.productSites.some((ps) => ps.venue_item_id === 'own-byo'));
  assert.deepEqual(proposal.review.combosKept, [{ location_id: B, id: 'own-byo', name: 'Build Your Own Package' }]);
  assert.equal(combosKeptWords(proposal.review), '1 Combo with steps stays at its site for now, not in the group menu (Build Your Own Package).');
  // The Combo with no steps comes in as any product only at one site does.
  assert.ok(central.products.some((p) => p.name === 'Plain Meal Deal'));
  assert.ok(central.productSites.some((ps) => ps.venue_item_id === 'own-plain' && ps.location_id === B));
  // The headline counts are about what came in; they still read as a sentence.
  assert.match(reviewWords(proposal.review), /products? already shared between sites/);
  // Several, and none.
  assert.equal(combosKeptWords({ combosKept: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] }), '4 Combos with steps stay at their sites for now, not in the group menu (A, B, C and more).');
  assert.equal(combosKeptWords({}), '');
  assert.equal(combosKeptWords(null), '');
  // An import with no such Combo has no such key: every other review is what it was.
  assert.equal('combosKept' in setup().proposal.review, false);
});

test('Bring in refuses a Combo with steps in words; the list shows the words in place of the buttons', () => {
  const { v, central } = setup();
  const raw = addCombos(v[B]);
  const own = ownProducts(central, B, raw);
  const byo = own.find((o) => o.id === 'own-byo');
  assert.ok(byo, 'it is listed: it IS the site\'s own product');
  assert.equal(byo.held, WORDS);
  assert.equal(comboStaysWords(byo.row), WORDS);
  assert.equal('held' in own.find((o) => o.id === 'own-plain'), false);
  // The door itself, whoever calls it (as new, or linked).
  const r = bringInChanges(central, B, raw, 'own-byo', { idGen: idGen('b'), siteName: 'Site B' });
  assert.deepEqual(r, { ok: false, changes: [], words: [], problems: [WORDS] });
  const anyProduct = central.products.find((p) => !p.archived && !p.parent_product_id);
  assert.deepEqual(bringInChanges(central, B, raw, 'own-byo', { linkTo: anyProduct.id, siteName: 'Site B' }).problems, [WORDS]);
  // Never offered as a product a join would link.
  assert.ok(!joinableProducts(central, B, raw, raw.menus[0].id).some((o) => o.id === 'own-byo'));
  // The Combo with no steps comes in as before, and writes nothing at the site.
  const plain = bringInChanges(central, B, raw, 'own-plain', { idGen: idGen('p'), siteName: 'Site B' });
  assert.ok(plain.ok, plain.problems.join(' | '));
  assert.equal(plain.changes.find((c) => c.target === 'product' && c.op === 'create').after.name, 'Plain Meal Deal');
  assert.deepEqual(writesAt(central, plain.changes, B, raw), []);
});

test('Bring in all leaves the Combo out, says it once, and brings everything else', () => {
  const { v, central } = setup();
  const raw = addCombos(v[B]);
  const r = bringInAllChanges(central, B, raw, { idGen: idGen('a'), siteName: 'Site B', orgId: ORG });
  assert.ok(r.ok, r.problems.join(' | '));
  assert.deepEqual(r.problems.filter((p) => /Combo with steps/.test(p)), [WORDS]);
  assert.ok(r.words.some((w) => /Plain Meal Deal comes into the group menu/.test(w)), r.words.join(' | '));
  assert.ok(!r.words.some((w) => /Build Your Own Package/.test(w)));
  const after = applyChanges(central, r.changes).central;
  assert.ok(!after.productSites.some((ps) => ps.venue_item_id === 'own-byo'));
  assert.ok(after.productSites.some((ps) => ps.venue_item_id === 'own-plain'));
  // It is still listed as the site's own afterwards, still held.
  assert.deepEqual(ownProducts(after, B, raw).filter((o) => !o.archived).map((o) => [o.id, !!o.held]), [['own-byo', true]]);
  assert.deepEqual(writesAt(central, r.changes, B, raw, false), []);
});

test('publish leaves a site\'s own Combo alone: no write to it, with everything in the group menu touched', () => {
  const { v, central } = setup();
  const raw = addCombos(v[B]);
  const before = JSON.stringify(raw.items.find((i) => i.id === 'own-byo'));
  for (const loc of [A, B]) {
    const plan = planSite({ central, touched: touchedFromChanges(touchEverything(central)), locationId: loc, orgId: ORG, venue: loc === B ? raw : v[A] });
    // Nothing to write for it: not in the writes, the lines, the written ids or the inserted ids.
    for (const part of ['writes', 'lines', 'writtenItemIds', 'insertedItemIds', 'managedItemIds', 'problems']) {
      assert.ok(!(JSON.stringify(plan[part]) || '').includes('own-byo'), `plan.${part} never names the site's own Combo (${loc})`);
    }
    assert.ok(!(JSON.stringify(plan.writes) || '').includes('"combo"'), 'no write names a combo column');
    assert.ok(!(JSON.stringify(plan.lines) || '').includes('"combo"'), 'no line names a combo column');
    // The site as it would be after the publish still holds the row, steps and all, unchanged.
    if (loc === B) {
      const after = JSON.stringify(plan.applied);
      assert.ok(after.includes(JSON.stringify(STEPS)), 'the steps are still on the site row after the plan');
    }
  }
  assert.equal(JSON.stringify(raw.items.find((i) => i.id === 'own-byo')), before, 'planning never changes the site row it read');
});

test('the planner and the writer never name the combo column, so a publish cannot blank a Combo\'s steps', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  // The planner builds an update from the group menu's own fields (its product model has no combo),
  // and the SQL writer updates named columns only (msm_changes / the publish function).
  for (const f of ['../../../supabase/functions/_shared/msmPlan.js', '../../../supabase/functions/_shared/msmDiff.js', '../../../supabase/functions/_shared/msmModel.js']) {
    assert.ok(!/\bcombo\b/.test(read(f).replace(/type === 'combo'|'combo'\s*[,\]]|combo product|Combo/g, '')), `${f} does not write a combo column`);
  }
  // The two doors are wired where this file says they are.
  const bring = read('./msmBringIn.js');
  assert.match(bring, /if \(comboWithSteps\(row\)\) return fail\(comboStaysWords\(row\)\);/);
  assert.match(bring, /\.\.\.\(comboWithSteps\(row\) \? \{ held: comboStaysWords\(row\) \} : \{\}\),/);
  assert.match(bring, /filter\(\(o\) => !o\.archived && !o\.held && o\.match && o\.match\.how === 'family'\)/);
  const imp = read('../../../supabase/functions/_shared/msmImport.js');
  assert.match(imp, /if \(comboWithSteps\(row\)\) \{\n\s+if \(row\.archived !== true\) combosKept\.push\(/);
  const sites = read('../../backoffice/sections/msm/MsmSites.jsx');
  assert.equal((sites.match(/\{editable && !o\.held && \(/g) || []).length, 2, 'both own product lists hide the buttons on a held Combo');
  assert.match(read('../../backoffice/sections/msm/MsmImport.jsx'), /combosKeptWords\(r\)/);
});
