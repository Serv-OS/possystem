// menuImportSubItems.test.js: the menu importer can land a row as a Sub item (5.12.27).
//
// Peter, 2 Nov 2026: "on the importer is there a way we can build to make an item as a sub item".
// The AI parse marks add ons and choices as kind 'option'; the review screen shows Product / Sub item
// on every single price row; publishing an option makes a type 'subitem' row, not sold alone, tagged
// with its menu section. Everything else about the importer is byte for byte as it was.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

test('the AI schema and prompt know an option', () => {
  const api = read('../../api/ai/menu-import.js');
  assert.match(api, /kind: \{\s+type: 'string',\s+enum: \['product', 'option'\],/, 'kind is in the tool schema');
  assert.ok(api.includes('are kind "option", with the extra charge as the price (0 when free)'), 'the prompt says what an option is');
  assert.ok(api.includes('When unsure, "product".'), 'a doubtful row stays a product');
});

test('the review screen offers Product / Sub item, and publishing an option lands a sub item', () => {
  const modal = read('../backoffice/components/MenuImportModal.jsx');
  assert.match(modal, /<select value=\{item\.kind === 'option' \? 'option' : 'product'\} onChange=\{e=>updateItem\(item\.id, \{ kind: e\.target\.value \}\)\}/);
  assert.match(modal, /\} else if \(it\.kind === 'option'\) \{[\s\S]*?type: 'subitem',\s+soldAlone: false,\s+subGroup: draft\.categories\.find\(c => c\.id === it\.categoryId\)\?\.label \|\| '',/, 'an option is a sub item, only an option, tagged with its section');
  assert.ok(modal.includes("type: 'simple',\n            cat: realCat,"), 'a product is still simple');
  assert.ok(modal.includes('products and ${subItems} sub items. Put the sub items in modifier groups'), 'the toast says what landed and what to do next');
  for (const [name, text] of [['menu-import.js', read('../../api/ai/menu-import.js')], ['MenuImportModal.jsx', modal]]) {
    assert.doesNotMatch(text.split('\n').filter((l) => l.includes('5.12.27') || l.includes('kind')).join('\n'), /[\u2013\u2014]/, `${name}: no long dashes in the new lines`);
  }
});
