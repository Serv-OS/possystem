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
import { fileURLToPath } from 'node:url';

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
  const root = fileURLToPath(new URL('.', SRC));   // .pathname keeps %20 and fails on a path with spaces
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

// 17 Sep 2026: "Sold alone" switched itself ON for sub items, because every writer defaulted a
// missing flag to true (db.js "?? true", twice, and cloneItem), and the store never set the
// flag on a new item. lib/menuRules.js rule 6 (resolveSoldAlone) is the one default now.
test('no writer defaults Sold alone by itself: they call resolveSoldAlone', () => {
  const root = fileURLToPath(new URL('.', SRC));
  // sold_alone: x ?? true, soldAlone: x || false, and so on. Reading a row
  // (soldAlone: item.sold_alone ?? item.soldAlone) is fine: it ends in a field, not a default.
  const ownDefault = /\bsold_?[aA]lone\s*:[^\n]*(\?\?|\|\|)\s*(true|false)\b/;
  const offenders = [];
  for (const file of sourceFiles(root)) {
    if (file.endsWith(path.join('lib', 'menuRules.js'))) continue;
    if (file.endsWith(path.join('sections', 'MenuVisualizer.jsx'))) continue;   // not mounted anywhere
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (ownDefault.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);

  // db.js: upsertMenuItem (every item save, Push to POS, SyncBridge local items) and the shared
  // sub item copy. Every sold_alone it writes comes from the rule, with the type it writes.
  const db = read('lib/db.js');
  const dbWrites = db.split('\n').filter(l => /^\s*sold_alone\s*:/.test(l));
  assert.equal(dbWrites.length, 2);
  for (const l of dbWrites) assert.match(l, /sold_alone:\s+resolveSoldAlone\(/, l);
  assert.ok(/sold_alone:\s+resolveSoldAlone\(\{ \.\.\.item, type: _type \}\)/.test(db), 'upsertMenuItem passes the type it writes');
  assert.ok(db.includes("import { resolveSoldAlone } from './menuRules'"), 'db.js imports the rule with a static import');

  // The store has no menu item writer of its own (the unused sbUpsertMenuItem wrote
  // soldAlone || false), and a new item is stamped before its first save.
  const store = read('store/index.js');
  assert.ok(!/sold_alone\s*:/.test(store), 'the store never writes sold_alone itself');
  assert.ok(!/const\s+sbUpsertMenuItem\b/.test(store), 'the unused second item writer stays deleted');
  const add = store.slice(store.indexOf('addMenuItem: item => {'));
  const stamp = add.indexOf('newItem.soldAlone = resolveSoldAlone(newItem);');
  const save = add.indexOf('upsertMenuItem(newItem);');
  assert.ok(stamp > 0 && save > stamp, 'addMenuItem stamps soldAlone before it saves');

  // Clone keeps the source's choice and uses the same default.
  assert.ok(/soldAlone:\s+resolveSoldAlone\(item\),/.test(read('backoffice/sections/MenuManager.jsx')), 'cloneItem uses the rule');
});

test('the store applies the Sold alone type change rule, and Back Office shows the plain note', () => {
  const store = read('store/index.js');
  const upd = store.slice(store.indexOf('updateMenuItem: (id, patch) => {'), store.indexOf('addMenuItem: item => {'));
  // The exact merge menuRules.test.js rule 7 exercises.
  assert.ok(upd.includes('const updated = { ...item, ...patch, ...soldAlonePatchForTypeChange(item, patch) };'));
  // Visibility is never rewritten on a type change (no screen can put it back).
  assert.ok(!upd.includes('visibility'), 'updateMenuItem never rewrites visibility');

  const mm = read('backoffice/sections/MenuManager.jsx');
  // The "Sub item" chip still sends only the type, so the rule above is what decides.
  assert.ok(/\['subitem','Sub item'\]\]\.map\(\(\[v,l\]\) => \{[\s\S]{0,200}onClick=\{\(\)=>f\('type',v\)\}/.test(mm), 'the type chip sends only the type');
  // One plain line under both Sold alone switches (Items list row and the item editor).
  assert.equal((mm.match(/<SoldAloneNote item=\{item\}/g) || []).length, 2);
  assert.ok(mm.includes("if (item?.type !== 'subitem' || isOptionOnlyItem(item)) return null;"), 'the note only shows on a sub item that is sold alone');
  const note = mm.match(/const SOLD_ALONE_NOTE = '([^']+)';/);
  assert.ok(note);
  assert.match(note[1], /its own product on the till, kiosk and online/);
  assert.doesNotMatch(note[1], /[\u2013\u2014]/);   // no dashes in copy
});
