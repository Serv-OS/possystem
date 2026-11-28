// comboFlow.test.js: 5.12.127. Peter, 27 Nov 2026, after testing 5.12.126 live: "its good but the flow
// doesnt work its not clear that change means choose extras", and "dont allow modification of a product
// so like the pizzas dont let you modify them or if they have a modifiers flow that shows those
// modifiers and the rules etc around them". Two changes, on every screen with Combos:
//   1. per step, "Can customers change these products?" No (asIs): each pick goes exactly as it is,
//      nothing asked, no note, a required option never blocks it (a size is still chosen: it is which
//      product). Yes (the default, and what every step saved before reads): its options, with rules.
//   2. the flow, like Toast's catering package: a product with options (">") opens them the moment it
//      is tapped, headed with the Combo's name, and Continue returns to the step; tapping the pick
//      opens them again. No "Change" button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normaliseStep, comboColumnValue, comboStepsOf, stepAsIs, stepPickNeeds, stepOpensOptions, comboMissing, mapStepProducts,
} from './combo.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const rows = [
  { id: 'marg', name: 'Margherita', assignedModifierGroups: ['g-req'] },
  { id: 'calz', name: 'Calzone' }, { id: 'calz-s', name: 'Small', parentId: 'calz' }, { id: 'calz-l', name: 'Large', parentId: 'calz' },
  { id: 'salad', name: 'Caesar' },
];
const ctx = {
  rowsById: new Map(rows.map((r) => [r.id, r])),
  sizesOf: (id) => rows.filter((r) => r.parentId === id),
  requiresAnswers: (r) => r.id === 'marg' || r.id === 'calz',
  hasOptions: (r) => r.id === 'marg' || r.id === 'calz' || r.id === 'salad',
};
const stepOf = (asIs) => normaliseStep({ id: 'st', name: 'Pick 2', selectionType: 'quantity', min: 2, max: 2, pricing: 'set', products: ['marg', 'calz', 'salad'], ...(asIs ? { asIs: true } : {}) });

test('the switch is kept only when set: every step saved before reads and saves exactly as it did', () => {
  const old = { id: 'st', name: 'Pick 2', selectionType: 'quantity', min: 2, max: 2, pricing: 'set', products: [{ itemId: 'marg', bump: 0 }] };
  assert.deepEqual(normaliseStep(old), old, 'no new key on a step that never had it');
  assert.equal(stepAsIs(normaliseStep(old)), false, 'customers can change it (what it always did)');
  assert.equal(normaliseStep({ ...old, asIs: true }).asIs, true);
  assert.equal('asIs' in normaliseStep({ ...old, asIs: 'yes' }), false, 'only true counts');
  assert.deepEqual(comboStepsOf(comboColumnValue([{ ...old, asIs: true }]))[0].asIs, true, 'saved and read back');
  // The Multi site menu keeps it when it maps a step to a site's own items.
  assert.equal(mapStepProducts([{ ...old, asIs: true }], (id) => `site-${id}`).steps[0].asIs, true);
});

test('a step whose products go as they are asks nothing but a size; a required option never blocks it', () => {
  const off = stepOf(true);
  const on = stepOf(false);
  const marg = { stepId: 'st', entryId: 'marg', itemId: 'marg', configured: false };
  const calz = { stepId: 'st', entryId: 'calz', itemId: null, configured: false };
  assert.equal(stepPickNeeds(off, marg, ctx), null, 'its required option is not asked');
  assert.equal(stepPickNeeds(on, marg, ctx), 'options');
  assert.equal(stepPickNeeds(off, calz, ctx), 'size', 'a size is which product: still chosen');
  assert.equal(comboMissing([off], [marg, { ...marg }], ctx), null, 'added as they are');
  assert.equal(comboMissing([on], [marg, { ...marg }], ctx), 'Margherita: choose its options');
  // A ">" (opens its options on a tap) only where customers can change it, and only with options.
  assert.equal(stepOpensOptions(on, rows[4], ctx), true);
  assert.equal(stepOpensOptions(off, rows[4], ctx), false);
  assert.equal(stepOpensOptions(on, { id: 'water', name: 'Water' }, ctx), false);
});

test('the flow on every screen: a tap opens the options, Continue returns, the pick opens again, no Change', () => {
  // The POS (the phone POS and the bar screen use the same flow).
  const flow = read('../components/ComboFlow.jsx');
  assert.match(flow, /if \(made && \(stepOpensOptions\(step, e\.row, ctx\) \|\| stepPickNeeds\(step, made, ctx\)\)\) \{ setConfiguring\(\{ key: made\.key, fresh: true, before: picks \}\); return; \}/);
  assert.match(flow, /heading=\{item\.menuName \|\| item\.name\}\n\s+confirmLabel="Continue"/);
  assert.match(flow, /onClick=\{opens \? \(\) => setConfiguring\(\{ key: p\.key, fresh: false \}\) : undefined\}/);
  assert.match(flow, /if \(cancelled && configuring\.fresh\) setPicks\(/, 'backing out of a product just tapped never leaves it picked');
  assert.doesNotMatch(flow, /combo-pick-change|>\s*\{needs \? 'Choose' : canChange \? 'Change' : 'Note'\}/);
  assert.match(read('../components/InlineItemFlow.jsx'), /: confirmLabel\n\s+\? \(extraCost > 0 \? `\$\{confirmLabel\} · \+\$\{money\(extraCost \* qty\)\}` : confirmLabel\)/);
  // Online, catering and QR.
  const sheet = read('../surfaces/online/OnlineComboSheet.jsx');
  assert.match(sheet, /if \(made && \(stepOpensOptions\(step, e\.row, ctx\) \|\| stepPickNeeds\(step, made, ctx\)\)\) setConfiguring/);
  assert.match(sheet, /addLabel="Continue" contextTitle=\{tItemName\(item\) \|\| item\.menu_name \|\| item\.name\}/);
  assert.match(sheet, /data-testid="online-combo-pick" onClick=\{\(\) => setConfiguring\(\{ key: p\.key, fresh: false \}\)\}/);
  assert.doesNotMatch(sheet, />\{needs \? 'Choose' : 'Change'\}</);
  assert.match(read('../surfaces/online/OnlineItemSheet.jsx'), /\{contextTitle && <span data-testid="sheet-context-title"/);
  assert.match(read('../surfaces/online/OnlineCart.jsx'), />Edit<\/button>/);
  // A pick already on the order is never changed in a step whose products go as they are.
  assert.match(read('../surfaces/POSSurface.jsx'), /if \(comboRow && stepAsIs\(comboSteps\(comboRow\)\.find\(s => s\.id === line\.comboStepId\)\)\) return false;/);
  // The Steps tab (site Menu Manager, and the Multi site menu product sheet through the same editor).
  const tab = read('../backoffice/sections/ComboStepsTab.jsx');
  assert.match(tab, /Can customers change these products\?/);
  assert.match(tab, /'Yes, they choose its options'/);
  assert.match(tab, /'No, it goes as it is'/);
  assert.match(tab, /nothing is asked, required options included\./);
  assert.match(read('./msm/msmComboRows.js') + read('../backoffice/sections/msm/MsmComboSteps.jsx'), /ComboStepsTab/);
});
