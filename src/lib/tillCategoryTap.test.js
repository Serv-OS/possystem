// 5.12.33 (Peter, 2 Nov 2026): "when you are in a product and it is showing modifiers or
// variants, clicking on a new category should close that screen, showing the products in the
// category clicked on". The till's category and sub category taps close the inline options
// screen (modalItem) and a pre order line edit (editLine). Pinned on the source, as the menu
// rules are (lib/menuRulesUsage.test.js), because POSSurface only mounts in a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const till = fs.readFileSync(new URL('../surfaces/POSSurface.jsx', import.meta.url), 'utf8');

test('a category tap closes the options screen and shows the products', () => {
  assert.match(till, /onClick=\{\(\) => \{ setCat\(c\.id\); setSearch\(''\); setRightTab\('menu'\); setModalItem\(null\); setEditLine\(null\); \}\}/);
});

test('a sub category tap, and All, do the same', () => {
  assert.match(till, /setSubCat\(null\); setRightTab\('menu'\); setModalItem\(null\); setEditLine\(null\);/);
  assert.match(till, /setSubCat\(sc\.id\); setRightTab\('menu'\); setModalItem\(null\); setEditLine\(null\);/);
});

test('the Allergen filter button shows open as well as filters on', () => {
  assert.match(till, /aria-pressed=\{showAllergens\}/);
  assert.match(till, /showAllergens\?'var\(--acc\)':'var\(--bdr\)'/);
});
