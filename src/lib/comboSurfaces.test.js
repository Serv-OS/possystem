// comboSurfaces.test.js: a Combo with steps is rung up on the POS only, for now (5.12.123, stage 1).
//
// Scenario G of the brief: "hidden on every screen that has not learned Combos". Only the main POS
// walks a Combo's steps so far. Anywhere else, selling it would take the set price and send NO food
// to the kitchen, so every other way onto an order leaves it out or refuses it in words:
//   the bar screen, the phone POS, online, QR at the table, the kiosk (both designs), the catering
//   page, the delivery platforms (HubRise catalogue), the voice order parser, the assistant, a
//   booking package, and store.addItem itself (the door the phone POS, a scan and the assistant use).
// A Combo with NO steps is an ordinary product: it shows and sells everywhere exactly as before.
// It is the product itself that is held back, never its "Visible on" switches, so the menu boards,
// the printed menu and the website menu still show it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { comboPosOnly, comboHasSteps, comboNotHereWords } from './combo.js';
import { channelVisible } from './channelMenu.js';
import { kioskCardEligible } from './kioskMenu.js';
import { cateringVisible } from './cateringPricing.js';
import { buildCatalog, comboWithSteps as hubriseCombo } from '../../supabase/functions/_shared/hubrise-map.ts';
import { comboWithSteps as msmCombo } from '../../supabase/functions/_shared/msmImport.js';
import { comboWithSteps as voiceCombo } from '../../api/voice-order.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const STEPS = { v: 1, steps: [{ id: 'st-1', name: 'Pick 5 pizzas', selectionType: 'quantity', min: 5, max: 5, pricing: 'set', products: [{ itemId: 'm-marg', bump: 0 }] }] };
const ALL_ON = { pos: true, kiosk: true, online: true, onlineDelivery: true };
const BYO = { id: 'm-byo', name: 'Build Your Own Package', type: 'combo', cat: 'c', pricing: { base: 149 }, combo: STEPS, visibility: { ...ALL_ON } };
const PLAIN = { id: 'm-deal', name: 'Meal Deal', type: 'combo', cat: 'c', pricing: { base: 9 }, combo: null, visibility: { ...ALL_ON } };
const OLD = { id: 'm-old', name: 'Old Combo', type: 'combo', cat: 'c', pricing: { base: 9 }, visibility: { ...ALL_ON } };   // a row from before the column
const PIZZA = { id: 'm-marg', name: 'Margherita', type: 'modifiable', cat: 'c', pricing: { base: 13 }, visibility: { ...ALL_ON } };
const NOT_POS = ['bar', 'bar-tab', 'mpos', 'handheld', 'kiosk', 'online', 'qr', 'catering', 'hubrise', 'delivery'];

test('which product is held back: a Combo with steps, and nothing else', () => {
  assert.equal(comboPosOnly(BYO), true);
  for (const row of [PLAIN, OLD, PIZZA, { ...PIZZA, combo: STEPS }, null, undefined, {}]) assert.equal(comboPosOnly(row), false, JSON.stringify(row));
  assert.equal(comboNotHereWords(BYO), 'Build Your Own Package is a Combo with choices. Ring it up from the menu on the main POS.');
});

test('every channel but the POS leaves a Combo with steps out, whatever its switches say', () => {
  for (const ch of NOT_POS) {
    assert.equal(channelVisible(BYO, ch), false, `${ch} must not show a Combo with steps`);
    assert.equal(channelVisible(BYO, ch, 'delivery'), false, `${ch} delivery`);
    assert.equal(channelVisible({ ...BYO, visibility: undefined }, ch), false, `${ch}, no switches set`);
  }
  // An unknown or missing channel is not the POS: held back too (the safe side).
  assert.equal(channelVisible(BYO, undefined), false);
  assert.equal(channelVisible(BYO, 'something-new'), false);
  // The POS shows it, by its own POS switch as any product.
  assert.equal(channelVisible(BYO, 'pos'), true);
  assert.equal(channelVisible(BYO, 'till'), true);
  assert.equal(channelVisible({ ...BYO, visibility: { ...ALL_ON, pos: false } }, 'pos'), false);
});

test('a Combo with no steps, and every other product, shows exactly as before', () => {
  for (const row of [PLAIN, OLD, PIZZA]) {
    for (const ch of [...NOT_POS, 'pos', 'till']) assert.equal(channelVisible(row, ch), true, `${row.name} on ${ch}`);
    assert.equal(channelVisible({ ...row, visibility: { ...ALL_ON, online: false } }, 'online'), false);
    assert.equal(channelVisible({ ...row, visibility: { ...ALL_ON, kiosk: false } }, 'kiosk'), false);
    assert.equal(channelVisible({ ...row, visibility: { ...ALL_ON, onlineDelivery: false } }, 'online', 'delivery'), false);
    assert.equal(kioskCardEligible(row), true);
    assert.equal(cateringVisible(row), true);
    assert.equal(cateringVisible(row, 'delivery'), true);
  }
  assert.equal(channelVisible({ id: 'x', name: 'No switches' }, 'online'), true);
});

test('the kiosk and the catering page have their own card rules: both leave it out', () => {
  assert.equal(kioskCardEligible(BYO), false);
  assert.equal(kioskCardEligible({ ...BYO, visibility: undefined }), false);
  assert.equal(cateringVisible(BYO), false);
  assert.equal(cateringVisible(BYO, 'delivery'), false);
  assert.equal(cateringVisible({ ...BYO, visibility: undefined }), false);
});

test('the delivery platforms: a Combo with steps never goes into the catalogue', () => {
  const build = (items) => buildCatalog({ categories: [{ id: 'c', label: 'C' }], items, modifierGroups: [], currency: 'USD', itemMenuId: {}, channel: 'delivery' });
  const cat = build([BYO, PLAIN, OLD, PIZZA]);
  const names = cat.products.map((p) => p.name).sort();
  assert.deepEqual(names, ['Margherita', 'Meal Deal', 'Old Combo']);
  assert.equal(build([BYO]).products.length, 0);
});

test('the three copies of "a Combo with steps" outside src read it exactly as the app does', () => {
  const rows = [
    BYO, PLAIN, OLD, PIZZA,
    { type: 'combo', combo: STEPS.steps }, { type: 'combo', combo: { v: 1, steps: [] } }, { type: 'combo', combo: [] },
    { type: 'combo', combo: 'x' }, { type: 'combo', combo: 7 }, { type: 'combo', combo: { steps: 'x' } }, { type: 'combo', combo: { steps: [null, 3, 'a', []] } },
    { type: 'combo', combo: { steps: [{}] } }, { type: 'combo', combo: [{}] },
    { type: 'simple', combo: STEPS }, { type: 'variants', combo: STEPS }, { type: 'subitem', combo: STEPS },
    null, undefined, {}, { combo: STEPS },
  ];
  for (const r of rows) {
    const want = comboHasSteps(r);
    assert.equal(hubriseCombo(r), want, `hubrise-map.ts: ${JSON.stringify(r)}`);
    assert.equal(msmCombo(r), want, `msmImport.js: ${JSON.stringify(r)}`);
    assert.equal(voiceCombo(r), want, `api/voice-order.js: ${JSON.stringify(r)}`);
  }
});

test('every door onto an order is closed to it, and says so where a person is asking', () => {
  // The lists.
  const online = read('../surfaces/online/OnlineSurface.jsx');
  assert.match(online, /if \(!channelVisible\(i, visibleChannel, priceType\)\) return false;/);
  assert.match(online, /if \(!channelVisible\(item, visibleChannel, priceType\) \|\|[^\n]*\n\s+alert\(`Sorry, \$\{item\.menu_name \|\| item\.name\} cannot be ordered here\.`\); return;/);
  assert.match(read('../surfaces/BarSurface.jsx'), /if \(!channelVisible\(i, 'bar'\)\) return false;/);
  assert.match(read('../surfaces/mpos/MMenu.jsx'), /channelVisible\(i, 'mpos'\)/);
  assert.match(read('../surfaces/KioskApp.jsx'), /\.filter\(kioskCardEligible\)/);
  assert.match(read('../surfaces/catering/CateringSurface.jsx'), /cateringVisible\(i, fulfilment\)/);
  // The add doors behind the lists.
  assert.match(read('../surfaces/KioskApp.jsx'), /if \(comboPosOnly\(item\)\) \{ console\.warn\('\[kiosk\] not added: a Combo with steps is rung up on the POS', item\?\.name\); return; \}/);
  assert.match(read('../surfaces/catering/CateringSurface.jsx'), /if \(comboPosOnly\(item\)\) \{ alert\(`Sorry, \$\{item\.menu_name \|\| item\.name\} cannot be ordered here yet\. Please call us to order it\.`\); return; \}/);
  assert.match(read('../surfaces/BarSurface.jsx'), /if \(comboPosOnly\(item\)\) \{ showToast\(comboNotHereWords\(item\), 'error'\); return; \}/);
  // The store's own add: the phone POS, a scan, voice and the assistant all add through it.
  assert.match(read('../store/index.js'), /if \(comboHasSteps\(item\)\) \{\n\s+get\(\)\.showToast\?\.\(comboNotHereWords\(item\), 'error'\);\n\s+return null;/);
  assert.match(read('../surfaces/mpos/MItemDetail.jsx'), /addItem\(item, flatMods, null,/);
  assert.match(read('../surfaces/mpos/MVoiceOrder.jsx'), /menu: menuItems\.filter\(m => !comboPosOnly\(m\)\),/);
  assert.match(read('../../api/voice-order.js'), /if \(comboWithSteps\(m\)\) return false;/);
  assert.match(read('./aiTools.js'), /if \(comboPosOnly\(item\)\) return \{ result: \{ error: comboNotHereWords\(item\) \} \};/);
  // The delivery catalogue and a booking package.
  assert.match(read('../../supabase/functions/_shared/hubrise-map.ts'), /!comboWithSteps\(it\) &&/);
  assert.match(read('../backoffice/sections/PackageBuilder.jsx'), /filter\(m => !m\.archived && !comboPosOnly\(m\)\)/);
  // And the POS itself opens the steps instead of adding the bare product.
  assert.match(read('../surfaces/POSSurface.jsx'), /if \(comboHasSteps\(item\)\) \{ openCombo\(item\); return; \}/);
});

test('the Back Office says where it is sold, in words', () => {
  const tab = read('../backoffice/sections/ComboStepsTab.jsx');
  assert.match(tab, /COMBO_WORDS\.posOnly \+ ' It is left off the kiosk, online ordering, QR, catering, the phone POS and the delivery apps until they learn it\.'/);
});
