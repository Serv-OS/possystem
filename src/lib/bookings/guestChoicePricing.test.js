/**
 * guestChoicePricing.test.js — what the guest booking page shows as extra for
 * a size or an option, and when a pick counts as chosen (10 Sep 2026 review).
 * These used to live inside BookingWidget.jsx with no test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  plainChoice, choiceFromRow, choicePayload, menuRowFor, choicePriceFor, choiceExtra, choiceComplete,
} from './guestChoicePricing.js';

// The real Back Office shapes: a size parent at base 0 (never charged itself),
// sizes at 28 and 36, a per item Required temperature ({ groupId, min: 1 }) and
// instruction defs with NO required field.
const ROWS = [
  { id: 'm-steak', name: 'Ribeye', type: 'variants', pricing: { base: 0 }, price: 0,
    assigned_modifier_groups: ['g-sauce'], assigned_instruction_groups: [{ groupId: 'igd-cook-temp', min: 1 }] },
  { id: 'm-steak-8', name: '8oz', menu_name: '8oz', parent_id: 'm-steak', pricing: { base: 28 }, price: 28, sort_order: 1 },
  { id: 'm-steak-12', name: '12oz', menu_name: '12oz', parent_id: 'm-steak', pricing: { base: 36 }, price: 36, sort_order: 2 },
  { id: 'm-soup', name: 'Soup', pricing: { base: 6 }, price: 6 },
];
const DEFS = [{ id: 'igd-cook-temp', name: 'Cooking temperature', options: ['Rare', 'Medium rare', 'Well done'] }];
const MENU = { status: 'ready', items: ROWS, instGroupDefs: DEFS, groupMin: {} };
const row = (id) => ROWS.find((r) => r.id === id);
const STEAK_OPT = { name: 'Ribeye', itemId: 'm-steak', priceOverride: null };

test('deposit and hold: sizes are priced from the CHEAPEST size, never from the £0 parent', () => {
  for (const model of ['deposit', 'hold', null]) {
    const priceFor = choicePriceFor(model, null, row('m-steak'), ROWS);
    assert.equal(priceFor(row('m-steak-8')), 0, `${model} 8oz`);
    assert.equal(priceFor(row('m-steak-12')), 8, `${model} 12oz`);
    assert.equal(priceFor(row('m-steak')), 0, `${model} the parent itself`);
  }
});

test('prepay: every size is included; a deposit with a price override follows the override', () => {
  const prepay = choicePriceFor('prepay', null, row('m-steak'), ROWS);
  assert.equal(prepay(row('m-steak-8')), 0);
  assert.equal(prepay(row('m-steak-12')), 0);
  const override = choicePriceFor('deposit', 18, row('m-steak'), ROWS);
  assert.equal(override(row('m-steak-12')), 0);
  // An unsized dish: the dish itself is included.
  assert.equal(choicePriceFor('deposit', null, row('m-soup'), ROWS)(row('m-soup')), 0);
});

test('choiceExtra: the size difference plus the options, matching the chip summary', () => {
  const pick = { name: 'Ribeye', variantItemId: 'm-steak-12', mods: [{ name: 'Peppercorn sauce', price: 2.5 }] };
  assert.equal(choiceExtra(pick, STEAK_OPT, MENU, 'deposit'), 10.5);
  assert.equal(choiceExtra({ ...pick, variantItemId: 'm-steak-8' }, STEAK_OPT, MENU, 'hold'), 2.5);
  assert.equal(choiceExtra(pick, STEAK_OPT, MENU, 'prepay'), 2.5);
  assert.equal(choiceExtra(null, STEAK_OPT, MENU, 'deposit'), 0);
  assert.equal(choiceExtra(pick, STEAK_OPT, { status: 'loading' }, 'deposit'), 2.5);
});

test('choiceComplete: a sized steak with a sauce but NO temperature is not chosen', () => {
  const opts = [STEAK_OPT, { name: 'Soup', itemId: 'm-soup' }];
  const noTemp = { name: 'Ribeye', itemId: 'm-steak', variantItemId: 'm-steak-12', mods: [{ name: 'Peppercorn sauce', price: 2.5 }], configured: true };
  assert.equal(choiceComplete(noTemp, opts, MENU), false);
  const withTemp = { ...noTemp, mods: [...noTemp.mods, { id: 'ig-igd-cook-temp-Medium rare', label: 'Medium rare', groupLabel: 'Cooking temperature', price: 0, _instruction: true }] };
  assert.equal(choiceComplete(withTemp, opts, MENU), true);
  // A plain chip tap on the steak never counts.
  assert.equal(choiceComplete(plainChoice(STEAK_OPT), opts, MENU), false);
  // A dish with nothing to choose counts on a tap.
  assert.equal(choiceComplete(plainChoice(opts[1]), opts, MENU), true);
  // A menu still loading never blocks the booking; an option no longer offered never counts.
  assert.equal(choiceComplete(plainChoice(STEAK_OPT), opts, { status: 'loading' }), true);
  assert.equal(choiceComplete({ name: 'Lobster' }, opts, MENU), false);
  assert.equal(choiceComplete(null, opts, MENU), false);
});

test('a steak with no sizes and only a required temperature needs the sheet', () => {
  const rows = [{ id: 'm-fillet', name: 'Fillet', pricing: { base: 30 }, assigned_instruction_groups: [{ groupId: 'igd-cook-temp', min: 1 }] }];
  const menu = { status: 'ready', items: rows, instGroupDefs: DEFS, groupMin: {} };
  const opt = { name: 'Fillet', itemId: 'm-fillet' };
  assert.equal(choiceComplete(plainChoice(opt), [opt], menu), false);
  assert.equal(choiceComplete({ ...plainChoice(opt), configured: true, mods: [{ groupLabel: 'Cooking temperature', label: 'Rare', _instruction: true }] }, [opt], menu), true);
});

test('payload, saved rows and menu rows', () => {
  const p = choicePayload(2, 'Ana', 2, { name: 'Ribeye', itemId: 'm-steak', mods: [], variantItemId: 'm-steak-8', variantName: '8oz', notes: 'x'.repeat(300) });
  assert.equal(p.notes.length, 120);
  assert.equal(p.course, 2);
  assert.equal(p.variantItemId, 'm-steak-8');
  assert.deepEqual(choiceFromRow({ name: 'Soup', itemId: 'm-soup' }), { name: 'Soup', itemId: 'm-soup', mods: [], variantItemId: null, variantName: null, notes: '' });
  assert.equal(choiceFromRow({}), null);
  assert.equal(menuRowFor(MENU, 'm-soup').name, 'Soup');
  assert.equal(menuRowFor({ status: 'failed', items: ROWS }, 'm-soup'), null);
});
