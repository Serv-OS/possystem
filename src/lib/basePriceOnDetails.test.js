// basePriceOnDetails.test.js — the base price is edited beside the name.
//
// Peter, 23 Sep 2026: "add the base price editable under this view and then
// set the other prices under price". One field (pricing.base, via fp), one
// place to edit it, and the Pricing tab keeps the exceptions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../backoffice/sections/MenuManager.jsx', import.meta.url)), 'utf8');
const details = src.slice(src.indexOf("{sec==='details' && ("), src.indexOf("{sec==='pricing' && ("));
const pricing = src.slice(src.indexOf("{sec==='pricing' && ("), src.indexOf("{sec==='tax' && ("));

test('Details has an editable base price next to the POS button name', () => {
  assert.match(details, /aria-label="Base price"/);
  assert.match(details, /onChange=\{e=>fp\('base',e\.target\.value\)\}/, 'the same updater the Pricing tab used, so nothing drifts');
  assert.ok(details.indexOf('POS button name') < details.indexOf('aria-label="Base price"'), 'name first, price beside it');
  assert.ok(details.indexOf('aria-label="Base price"') < details.indexOf('Receipt name'), 'it is at the top, not buried');
});

test('a cleared base price shows empty, never a forced 0', () => {
  assert.match(details, /value=\{\(p\.base\|\|p\.base===0\)\?p\.base:''\}/);
});

test('a sized parent gets the Sizes note instead of a base price', () => {
  assert.match(details, /\{!isParent && \(\s*<div>\s*<span style=\{lbl\}>Base price<\/span>/);
  assert.match(details, /Each size carries its own price, set in the Sizes tab/);
});

test('the Pricing tab shows the base as the reference and no longer edits it', () => {
  assert.doesNotMatch(pricing, /k:\s*'base'/, 'no second editable copy');
  assert.match(pricing, /\{money\(p\.base\|\|0\)\}/);
  assert.match(pricing, /setSec\('details'\)/, 'one click takes you to where it is edited');
  assert.match(pricing, /k:\s*'dineIn'/); assert.match(pricing, /k:\s*'driveThru'/);
});
