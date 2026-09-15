// Stops a screen going back to its own copy of the menu rules (lib/menuRules.js).
//
// 15 Sep 2026: the kiosk had kept its own copy since v5.3.1 and disagreed with the till in four
// ways (No Ice as a product, no size options, Milk optional, Cooking preference always
// required), and Back Office's Flow tab could save options on the main product of an item with
// sizes. This test reads the source files: if one of these checks fails, use lib/menuRules.js
// instead of writing the rule again.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('nobody writes the "option only sub item" rule again: they call isOptionOnlyItem', () => {
  const root = new URL('.', SRC).pathname;
  const copies = [
    /type\s*===\s*['"]subitem['"]\s*&&\s*!\s*\w+\.sold_?[aA]lone/,
    /type\s*!==\s*['"]subitem['"]\s*\|\|\s*\w+\.sold_?[aA]lone/,
    /\(\s*\w+\.sold_alone\s*\?\?\s*\w+\.soldAlone\s*\)\s*!==\s*true/,
  ];
  const offenders = [];
  for (const file of sourceFiles(root)) {
    if (file.endsWith(path.join('lib', 'menuRules.js'))) continue;
    if (file.endsWith(path.join('sections', 'MenuVisualizer.jsx'))) continue;   // not mounted anywhere
    const src = fs.readFileSync(file, 'utf8');
    for (const re of copies) if (re.test(src)) offenders.push(`${path.relative(root, file)} ${re}`);
  }
  assert.deepEqual(offenders, []);
  for (const rel of ['surfaces/POSSurface.jsx', 'surfaces/BarSurface.jsx', 'components/PosWasteModal.jsx', 'backoffice/sections/MenuManager.jsx', 'lib/kioskMenu.js']) {
    assert.match(read(rel), /isOptionOnlyItem/, rel);
  }
});

test('the till, kiosk and online choose size options with sizeOrMainOptions', () => {
  const till = read('components/InlineItemFlow.jsx');
  assert.match(till, /sizeOrMainOptions\(buildModGroups\(activeItem\), buildModGroups\(item\)\)/);
  assert.match(till, /sizeOrMainOptions\(buildInstGroups\(activeItem\), buildInstGroups\(item\)\)/);
  assert.match(till, /required: modifierGroupRequired\(def\)/);
  assert.match(till, /min: instructionGroupMin\(a, def\)/);
  assert.doesNotMatch(till, /childMods\.length > 0 \? childMods/);

  const kiosk = read('lib/kioskOptionGroups.js');
  assert.match(kiosk, /sizeOrMainOptions\(/);
  assert.match(kiosk, /instructionGroupMin\(/);
  // The kiosk used to copy an item's saved min and max over the group's (Milk became optional).
  assert.doesNotMatch(kiosk, /merged\.min\s*=|merged\.max\s*=/);
  const rules = read('lib/kioskGroupRules.js');
  assert.doesNotMatch(rules, /override\.min|override\.max/);
  assert.match(rules, /instructionGroupMin\(/);

  const online = read('surfaces/online/OnlineItemSheet.jsx');
  assert.equal((online.match(/sizeOrMainOptions\(/g) || []).length, 2);
});

test('Back Office never saves options on the main product of an item with sizes', () => {
  const mm = read('backoffice/sections/MenuManager.jsx');
  // Every add a size button goes through addSizeTo, which moves main product options.
  assert.doesNotMatch(mm, /addMenuItem\(\{\s*name:\s*'New size'/);
  assert.equal((mm.match(/addSizeTo\(/g) || []).length, 4);   // the helper plus the three buttons
  // The Flow tab's Add to flow box is not offered on the main product of an item with sizes.
  const box = mm.indexOf('Add modifier/instruction quick-add');
  assert.ok(box > 0);
  assert.match(mm.slice(box, box + 400), /\{isParent \? \(/);
  // Clone moves them too.
  assert.match(mm, /const sizeMove = moveMainProductOptions\(item, liveSizesOfSource\)/);
});
