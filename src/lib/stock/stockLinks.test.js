// src/lib/stock/stockLinks.test.js
//
// MULTI SITE STOCK (v5.11.89, Drop 1, integrator): the company stock screens reach each other.
//   - StockScope's go(route, { open }) leaves one record waiting only for a route this login can
//     open (the same canOpenRoute rule as BackOfficeApp's guarded setSection); takeOpen takes it
//     once; peekOpen only looks.
//   - A supplier's Items tab opens an item's page, and an item's Suppliers tab opens a supplier's
//     page, each only when the login can open that route.
//   - The routers open a record asked for on arrival, on the multi site branch only: a one site
//     company's branch comes first and is untouched (Drop 2, v5.11.93: Recipes too, { recipeId, tab }).
// Run: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const SCOPE = read('../../backoffice/StockScope.jsx');
const ITEMS = read('../../backoffice/sections/StockItems.jsx');
const SUPPLIERS = read('../../backoffice/sections/Suppliers.jsx');
const RECIPES = read('../../backoffice/sections/Recipes.jsx');   // v5.11.93 (Drop 2): the recipes router opens a record too
const SUPPLIER_ITEMS = read('../../backoffice/sections/stock/suppliers/SupplierItemsTab.jsx');
const ITEM_SUPPLIERS = read('../../backoffice/sections/stock/items/ItemSuppliersTab.jsx');
const USED_IN = read('../../backoffice/sections/stock/items/ItemUsedInTab.jsx');
const LIST = read('../../backoffice/sections/stock/items/CompanyItemList.jsx');

test('StockScope: a record waits only for a route this login can open, and is taken once', () => {
  assert.match(SCOPE, /import \{ canOpenRoute \} from '\.\.\/lib\/boSections';/);
  assert.match(SCOPE, /const allowed = canOpenRoute\(route, access\);/);
  assert.match(SCOPE, /openNewRef\.current = allowed && openNew \? route : null;/);
  assert.match(SCOPE, /openRef\.current = allowed && open \? \{ route, value: open \} : null;/);
  assert.match(SCOPE, /if \(o && o\.route === route\) \{ openRef\.current = null; return o\.value; \}/, 'takeOpen clears what it takes');
  assert.match(SCOPE, /const peekOpen = useCallback\(\(route\) => \(openRef\.current && openRef\.current\.route === route \? openRef\.current\.value : null\), \[\]\);/, 'peekOpen never clears');
  assert.match(SCOPE, /const canOpen = useCallback\(\(route\) => !!route && canOpenRoute\(route, access\), \[access\]\);/);
  // No provider (a screen alone, a node test): nothing opens and no link is drawn.
  assert.match(SCOPE, /takeOpen: \(\) => null,\n {2}peekOpen: \(\) => null,\n {2}canOpen: \(\) => false,/);
});

test('the routers open a record asked for only after the one site branch', () => {
  for (const [src, route, key] of [[ITEMS, 'stock-items', 'itemId'], [SUPPLIERS, 'suppliers', 'id'], [RECIPES, 'recipes', 'recipeId']]) {
    const body = src.slice(src.indexOf('export default function '));
    const oneSite = body.indexOf('if (!sc.multi) return ');
    const arrival = body.indexOf(`if (!open && sc.peekOpen?.('${route}')?.${key}) return <OpenOnArrival take={sc.takeOpen} onOpen={setOpen} />;`);
    assert.ok(oneSite > 0 && arrival > oneSite, `${route}: the one site branch comes first`);
    assert.match(src, new RegExp(`const o = take\\?\\.\\('${route}'\\); if \\(o\\?\\.${key}\\) onOpen\\(o\\);`), `${route}: taken once, opened only with its id`);
    assert.match(body, /const \[open, setOpen\] = useState\(null\);/, `${route}: nothing opens before the scope is known`);
  }
});

test('a supplier\'s Items tab opens the item page; an item\'s Suppliers tab opens the supplier page', () => {
  assert.match(SUPPLIER_ITEMS, /sc\.canOpen\?\.\('stock-items'\) && row\.item_id/);
  assert.match(SUPPLIER_ITEMS, /sc\.go\('stock-items', \{ open: \{ itemId: row\.item_id, tab: 'suppliers' \} \}\)/);
  assert.match(ITEM_SUPPLIERS, /sc\.canOpen\?\.\('suppliers'\) && si\.supplier_id/);
  assert.match(ITEM_SUPPLIERS, /sc\.go\('suppliers', \{ open: \{ id: si\.supplier_id, tab: 'items' \} \}\)/);
  assert.match(USED_IN, /sc\.canOpen\?\.\('recipes'\)/, 'a recipe links only when Recipes can open');
  assert.match(LIST, /\{sc\.canOpen\('stock-counts'\) && <Btn onClick=\{startCount\}>Start a count<\/Btn>\}/, 'Start a count only when Counts can open');
});

test('no em or en dash in this test or the files it reads', () => {
  for (const src of [SCOPE, ITEMS, SUPPLIERS, RECIPES, SUPPLIER_ITEMS, ITEM_SUPPLIERS, USED_IN, LIST, read('./stockLinks.test.js')]) {
    assert.doesNotMatch(src, /[\u2013\u2014]/);
  }
});
