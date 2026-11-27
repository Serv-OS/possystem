// msmComboScreens.test.js: a Combo's steps on the group menu's screens and in their words
// (5.12.124, Combo products stage 2).
//
// The parent session's brief, 27 Nov 2026: "Group menu product sheet: a product can be a Combo
// with steps, using the same Steps editor and the same words as the site editor", "shown in the
// changes list and the publish preview in plain words", and "at a managed site the steps of a group
// managed Combo are locked in the site's Menu Manager, with the usual chip".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { comboStepRow, comboStepRows, comboStepItem, comboColumnReady } from './msmComboRows.js';
import { comboWarnings, stepProductBlock, stepsEditBlock, comboSteps } from '../combo.js';
import { lockedItemPatch, itemLock, lockWord, OWNED_ITEM_KEYS } from './msmLock.js';
import { changeWords, keptValueWords, colWord, fieldWord } from './msmWords.js';
import { summarise } from './msmSummary.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// A few group menu products (msm_products rows, as msmRead gives them once SQL 20261216a has run).
const P = {
  latte: { id: 'g-latte', name: 'Latte', menu_name: 'Latte', type: 'simple', category_id: 'g-hot', default_price: 3.2, archived: false, sold_alone: true, allergens: ['milk'], combo: null },
  large: { id: 'g-latte-l', name: 'Large', menu_name: 'Large', type: 'simple', parent_product_id: 'g-latte', category_id: 'g-hot', default_price: 3.8, combo: null },
  oat: { id: 'g-oat', name: 'Oat milk', type: 'subitem', sold_alone: false, default_price: 0.4, combo: null },
  fish: { id: 'g-fish', name: 'Market fish', type: 'simple', default_price: null, combo: null },
  deal: { id: 'g-deal', name: 'Coffee deal', menu_name: 'Coffee deal', type: 'combo', default_price: 4.5, category_id: 'g-hot',
    combo: { v: 1, steps: [{ id: 's1', name: 'Pick a coffee', selectionType: 'single', min: 1, max: 1, pricing: 'set', products: [{ itemId: 'g-latte', bump: 0 }, { itemId: 'g-oat', bump: 0 }] }] } },
};

test('the group menu\'s products are shaped as the Steps editor reads a menu (one editor, two places)', () => {
  const row = comboStepRow(P.latte);
  assert.deepEqual(row, {
    id: 'g-latte', name: 'Latte', menuName: 'Latte', receiptName: null, kitchenName: null, parentId: null, type: 'simple', cat: 'g-hot', cats: [],
    pricing: { base: 3.2 }, price: 3.2, archived: false, soldAlone: true, scope: 'local', allergens: ['milk'], visibility: null, sortOrder: 0, combo: null,
  });
  assert.equal(comboStepRow(P.large).parentId, 'g-latte');                // a variant under its product
  assert.equal(comboStepRow(P.oat).soldAlone, false);                      // an option only sub item stays one
  assert.deepEqual(comboStepRow(P.fish).pricing, { base: null });          // no price set is "no price"
  assert.equal('combo' in comboStepRow({ id: 'x', name: 'X' }), false);    // a row read before the SQL has no key
  assert.equal(comboStepRow(null), null);
  assert.deepEqual(comboStepRows([P.latte, null, P.oat]).map((r) => r.id), ['g-latte', 'g-oat']);
  // The Combo being edited: a new one carries the id the sheet stages it with.
  const item = comboStepItem({ id: 'g-new', form: { name: 'Lunch deal', combo: P.deal.combo, modifier_groups: [{ groupId: 'gg' }] }, price: '6' });
  assert.deepEqual(item, { id: 'g-new', type: 'combo', name: 'Lunch deal', menuName: 'Lunch deal', combo: P.deal.combo, scope: 'local', parentId: null, pricing: { base: 6 }, assignedModifierGroups: [{ groupId: 'gg' }] });
  assert.deepEqual(comboStepItem({ id: 'g-new', price: null }).pricing, { base: null });
  // The same rules read the adapted rows: an option only sub item is refused in a step, as at a site.
  const rows = new Map(comboStepRows(Object.values(P)).map((r) => [r.id, r]));
  assert.match(stepProductBlock(rows.get('g-oat')), /option only/);
  assert.equal(stepProductBlock(rows.get('g-latte')), null);
  const warn = comboWarnings({ ...comboStepItem({ id: 'g-deal', form: P.deal, price: 4.5 }) }, { rowsById: rows });
  assert.deepEqual(warn.map((w) => w.words), ['Oat milk: That is an option only, not a product. Turn on Sold alone to use it in a Combo.']);
  assert.equal(comboSteps(comboStepItem({ id: 'g-deal', form: P.deal })).length, 1);
  assert.equal(stepsEditBlock(comboStepItem({ id: 'g-deal', form: P.deal })), null);
  // The editor is offered once the group menu can hold steps (SQL 20261216a): the rows carry the column.
  assert.equal(comboColumnReady([P.latte]), true);
  assert.equal(comboColumnReady([{ id: 'x', name: 'Before the SQL' }]), false);
  assert.equal(comboColumnReady([]), false);
  assert.equal(comboColumnReady(null), false);
});

test('the product sheet: "A Combo" is a kind of product, with the same Steps editor; a variant is never one', () => {
  const sheet = read('../../backoffice/sections/msm/MsmProductSheet.jsx');
  assert.match(sheet, /\.\.\.\(isSizeForm \? \[\] : \[\{ value: 'combo', label: 'A Combo \(built in steps\)' \}\]\)/);
  assert.match(sheet, /<MsmComboSteps id=\{p\?\.id \|\| ids\.product\} form=\{form\} price=\{groupPrice\} products=\{eff\?\.products\} categories=\{eff\?\.categories\}/);
  assert.match(sheet, /columnReady=\{comboColumnReady\(eff\?\.products\)\} readOnly=\{!editable\}/);
  // What the sheet stages: tidied steps for a Combo, none for anything else.
  assert.match(sheet, /f\.combo = f\.type === COMBO_TYPE \? comboColumnValue\(comboStepsOf\(f\.combo\)\) : null;/);
  assert.match(sheet, /default_channels: chText\(x\.default_channels\), combo: x\.combo \?\? null,/);
  const adapter = read('../../backoffice/sections/msm/MsmComboSteps.jsx');
  assert.match(adapter, /import ComboStepsTab from '\.\.\/ComboStepsTab';/);
  assert.match(adapter, /const rows = useMemo\(\(\) => comboStepRows\(products\), \[products\]\);/);
  assert.match(adapter, /posOnlyNote=\{false\}/);
  assert.match(adapter, /SQL 20261216a/);
});

test('at a site: a group managed Combo\'s steps are head office\'s, read only with the usual lock, unless the site keeps its own', () => {
  assert.equal(OWNED_ITEM_KEYS.combo, 'combo');
  assert.equal(lockWord('combo'), 'steps');
  const cur = { id: 'v-deal', name: 'Coffee deal', combo: P.deal.combo };
  const mine = { combo: { v: 1, steps: [] } };
  // Not kept: the change of steps is dropped, in words; anything the site owns still saves.
  assert.deepEqual(lockedItemPatch({ ...mine, colour: 'red' }, cur, []), { patch: { colour: 'red' }, dropped: ['combo'] });
  // The same steps sent back (a screen that sends the whole row) are harmless.
  assert.deepEqual(lockedItemPatch({ combo: P.deal.combo }, cur, []), { patch: { combo: P.deal.combo }, dropped: [] });
  // Kept: the site edits its own steps.
  assert.deepEqual(lockedItemPatch(mine, cur, ['combo']), { patch: mine, dropped: [] });
  const lock = itemLock({ ids: new Set(['v-deal']), kept: new Map([['v-deal', ['combo']]]) }, 'v-deal');
  assert.equal(lock.locked('combo'), false);
  assert.equal(itemLock({ ids: new Set(['v-deal']), kept: new Map() }, 'v-deal').locked('combo'), true);
  // Menu Manager: the Steps tab inside the usual lock, read only, and "keeps its own" said.
  const mm = read('../../backoffice/sections/MenuManager.jsx');
  assert.match(mm, /<MsmLocked on=\{lockOn\('combo'\)\} label="Steps">\n\s+<ComboStepsTab/);
  assert.match(mm, /readOnly=\{lockOn\('combo'\)\}\n\s+keptSteps=\{!!msmLock && msmLock\.kept\.has\('combo'\)\}/);
  const tab = read('../../backoffice/sections/ComboStepsTab.jsx');
  assert.match(tab, /const save = \(next\) => \{ if \(readOnly\) return;/);
  assert.match(tab, /draggable=\{!isOpen && !readOnly\}/);
  assert.match(tab, /\{!readOnly && <button onClick=\{addStep\} data-testid="combo-add-step"/);
  // The stage 1 refusal is gone: a managed product is not "a site's own product for now".
  assert.ok(!/A Combo with steps is set up as a site\\'s own product for now/.test(read('../combo.js')));
});

test('the changes list, the summary, kept values, drift and undo say steps in plain words', () => {
  const names = { products: new Map([['g-deal', 'Coffee deal']]), categories: new Map([['g-hot', 'Hot drinks']]), sites: new Map([['L1', 'Leeds']]) };
  assert.deepEqual(changeWords({ target: 'product', op: 'create', entity_id: 'g-deal', after: { name: 'Coffee deal', type: 'combo', default_price: 4.5, category_id: 'g-hot', combo: P.deal.combo } }, names),
    { subject: 'Coffee deal', words: 'New Combo, set price 4.50, in Hot drinks, steps: Pick a coffee (2 products)' });
  // A new product of any other kind reads exactly as before.
  assert.deepEqual(changeWords({ target: 'product', op: 'create', entity_id: 'g-x', after: { name: 'Mocha', type: 'simple', default_price: 3, category_id: 'g-hot' } }, names),
    { subject: 'Mocha', words: 'New product, group price 3.00, in Hot drinks' });
  assert.equal(changeWords({ target: 'product', op: 'update', entity_id: 'g-deal', after: { combo: P.deal.combo }, before: { combo: null } }, names).words, 'steps now Pick a coffee (2 products)');
  assert.equal(changeWords({ target: 'product', op: 'update', entity_id: 'g-deal', after: { combo: null }, before: { combo: P.deal.combo } }, names).words, 'steps taken off');
  assert.equal(changeWords({ target: 'product', op: 'update', entity_id: 'g-deal', after: { type: 'combo' }, before: { type: 'simple' } }, names).words, 'now a Combo');
  assert.equal(keptValueWords('combo', P.deal.combo), 'its own steps (Pick a coffee (2 products))');
  assert.equal(keptValueWords('combo', null), 'no steps');
  assert.equal(keptValueWords('type', 'combo'), 'a Combo');
  assert.equal(colWord('combo'), 'steps');
  assert.equal(fieldWord('combo'), 'steps');
  // The draft summary: one sentence of its own.
  const central = { sites: [{ location_id: 'L1' }], products: [P.deal] };
  assert.deepEqual(summarise([{ target: 'product', op: 'update', entity_id: 'g-deal', after: { combo: P.deal.combo }, before: { combo: null } }], central),
    ['Coffee deal: its steps are now Pick a coffee (2 products) at every site that sells it. A site that does not sell a product in a step leaves it out there.']);
  assert.deepEqual(summarise([{ target: 'product', op: 'update', entity_id: 'g-deal', after: { combo: null }, before: { combo: P.deal.combo } }], central),
    ['Coffee deal: its steps come off at every site. It sells as a plain product at its price.']);
  // Drift, undo and the publish preview name the column in words.
  const diff = read('../../../supabase/functions/_shared/msmDiff.js');
  assert.match(diff, /const DRIFT_WORDS = \{ combo: 'list of steps',/);
  // A changed list of steps is never said as "[object Object]" (review of 27 Nov 2026).
  assert.match(diff, /\? `\$\{n\[l\.productId\] \|\| l\.id\}: its steps at the venue are not the group's`/);
  assert.match(diff, /const UNDO_WORDS = \{ combo: 'steps',/);
  assert.match(read('./msmPublishView.js'), /combo: 'steps',/);
});
