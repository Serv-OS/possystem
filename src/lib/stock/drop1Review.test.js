// src/lib/stock/drop1Review.test.js
//
// MULTI SITE STOCK (v5.11.89, Drop 1, the review fixes). Node cannot draw these screens, so this pins the
// wiring the review asked for; the rules themselves are tested in itemListRules.test.js,
// itemPageRules.test.js and stockNative1Migration.test.js, and what the database does in
// supabase/tests/stock_native/drop1.mjs.
//   - Stock items list: a cell saved reads only its row again (stock_items_page filter ids), never every
//     loaded page; Add to sites offers every open site, whatever the picker shows.
//   - Item Details: "someone saved first" lists only what THEY changed, and Save mine on top sends this
//     screen against their version (so the table is what is saved).
//   - Purchased or made: on the Sites tab per site, on Add item, and kept by Clone.
// Run: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const ITEMS = '../../backoffice/sections/stock/items/';
const LIST = read(`${ITEMS}CompanyItemList.jsx`);
const DETAILS = read(`${ITEMS}ItemDetailsTab.jsx`);
const SITES = read(`${ITEMS}ItemSitesTab.jsx`);
const ADD = read(`${ITEMS}AddItemModal.jsx`);
const CLONE = read(`${ITEMS}CloneItemModal.jsx`);

// the text of one arrow function const of a screen: from `const name = ` to the next line that is `  };`
const fnText = (src, name) => {
  const at = src.indexOf(`const ${name} = `);
  if (at < 0) return '';
  const end = src.indexOf('\n  };', at);
  return src.slice(at, end < 0 ? undefined : end);
};

test('Stock items list: one tick or one price reads only that row again, never every loaded page', () => {
  assert.match(LIST, /const refreshRows = useCallback\(async \(ids\) =>/);
  assert.match(fnText(LIST, 'refreshRows'), /filters: \{ \.\.\.\(filters \|\| \{\}\), ids: want\.slice\(i, i \+ PAGE\) \}/, 'the same scope, search and filters, plus ids');
  assert.match(fnText(LIST, 'refreshRows'), /replaceRows\(p, want, got\)/);
  for (const name of ['tickSite', 'setPriceHere', 'bulkDone', 'archiveTicked']) {
    const body = fnText(LIST, name);
    assert.ok(body, `${name} is there`);
    assert.match(body, /await refreshRows\(/, `${name} reads only its rows again`);
    assert.doesNotMatch(body, /await refresh\(\)/, `${name} never reads every loaded page again`);
  }
  assert.match(LIST, /onRetry=\{retry \? async \(\) => \{[^}]*await refreshRows\(retryRows\); \}/, 'Try again reads only its rows');
});

test('Stock items list: Add to sites offers every open site in reach, whatever the picker shows', () => {
  assert.match(LIST, /const openSites = useMemo\(\(\) => sortSites\(siteList\(sc\.sites, sc\.siteName\)\)/);
  assert.match(LIST, /<AddToSitesModal items=\{tickedRows\} sites=\{openSites\} groups=\{openGroups\}/);
  // the other bulk boxes act on what the list shows (the picker's sites)
  for (const m of ['RemoveFromSitesModal', 'RunOutModal', 'SetParModal', 'PauseModal']) {
    assert.match(LIST, new RegExp(`<${m} items=\\{tickedRows\\} sites=\\{sites\\} groups=\\{groups\\}`), m);
  }
});

test('Item Details: someone saved first lists only their changes, and Save mine on top sends what the table says', () => {
  assert.match(DETAILS, /onTopRows\(detailsDraft\(item\), draft, detailsDraft\(freshItem\), DETAIL_WORDS, \{ names \}\)/);
  assert.doesNotMatch(DETAILS, /conflictRows\(/, 'never every field that differs from the screen');
  assert.match(DETAILS, /const \{ patch, error \} = detailsPatch\(draft, base\);/, 'the patch is measured against the base it saves on');
  assert.match(DETAILS, /onSaveMine=\{\(\) => save\(conflict\.version, true, conflict\.fresh \|\| item, false\)\}/, 'on top of THEIR version');
  assert.match(DETAILS, /if \(!rows\.length && again\) return save\(version, false, freshItem, false\);/, 'nothing of theirs clashes: saved again with no question, once');
});

test('Purchased or made: the Sites tab, Add item and Clone', () => {
  assert.match(SITES, /const COLS = 14;/);
  assert.match(SITES, /<Th hint="[^"]*">Purchased or made<\/Th>/);
  assert.match(SITES, /KIND_CHOICES\.map\(\(k\) => <option key=\{k\.value\} value=\{k\.value\}>\{k\.label\}<\/option>\)/);
  assert.match(fnText(SITES, 'saveHow'), /stockApi\.saveItem\(\{ item: \{ id: item\.id, location_id: m\.siteId, site \}, version: detail\?\.row_version \?\? item\.row_version \?\? null \}\)/,
    'stock_save_item at that site, with the item version (company)');
  assert.match(SITES, /disabled=\{!companyEditor \|\| !!item\.archived_at \|\| !!busy\}/, 'greyed for a login without company rights');
  assert.match(SITES, /Sold directly/);
  assert.match(ADD, /<Field label="Purchased or made"/);
  assert.match(ADD, /kind: 'PURCHASED'/, 'a new item is purchased unless Made here is picked');
  assert.match(CLONE, /const kinds = cloneSiteKinds\(detail, ticked\);/);
  assert.match(CLONE, /site: \{ kind: first\.kind, is_sellable: first\.is_sellable \}/);
});

test('no long dash in the files the review changed', () => {
  for (const [name, src] of Object.entries({ LIST, DETAILS, SITES, ADD, CLONE })) assert.doesNotMatch(src, /[\u2013\u2014]/, name);
});
