/**
 * saveContract.test.js: the stock saves keep their names, arguments and answers while their bodies
 * move to the database save functions (v5.11.84, multi site stock Drop 0, map 5.4 and 9.2).
 * v5.11.89 (Drop 1): 0b is live and the Drop 0 fallbacks are gone. A database without a save
 * function answers NEEDS_UPDATE; no browser path writes the catalogue tables directly any more.
 * The one site screens are read where Drop 1 moved them (stock/items/StockItemsSplit.jsx and
 * stock/suppliers/SuppliersSplit.jsx, the same text). Run: npm test.
 *
 * data.js and recipes.js import the browser Supabase client, which node cannot load, so the paths
 * are driven here through the same pieces those files are built from (companyData.js with a stand
 * in client, saveRules.js), and the source is pinned to use exactly those pieces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callSave, liveOrAll, runRecipeSave, readAll } from './companyData.js';
import { supplierSaveArgs, supplierFromRow, NEEDS_UPDATE } from './saveRules.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
// Drop 1 moved the one site screens whole (contract 3.2, 3.4); their text is today's.
const ITEMS_SCREEN = '../../backoffice/sections/stock/items/StockItemsSplit.jsx';
const SUPPLIERS_SCREEN = '../../backoffice/sections/stock/suppliers/SuppliersSplit.jsx';
const LOC = '7d0c0000-0000-4000-8000-000000000001';
const MISSING = { code: 'PGRST202', message: 'Could not find the function public.stock_save_item in the schema cache' };

/** A stand in client: answers each rpc from `answers` (a value or a function of the args) and records the calls. */
function fakeClient(answers = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const a = answers[fn];
      if (a === undefined) return { data: null, error: { code: '42883', message: `function public.${fn} does not exist` } };
      return typeof a === 'function' ? a(args) : a;
    },
  };
}

// ── the call itself ──────────────────────────────────────────────────────────────────────────────
test('callSave: a success, a missing function, a refusal, someone saving first, a thrown client', async () => {
  const ok = await callSave(fakeClient({ stock_save_item: { data: { ok: true, id: 'c1' }, error: null } }), 'stock_save_item', {});
  assert.deepEqual(ok, { data: { ok: true, id: 'c1' }, error: null, missing: false, conflict: null });
  for (const err of [MISSING, { code: '42883', message: 'function does not exist' }]) {
    const m = await callSave(fakeClient({ stock_save_item: { data: null, error: err } }), 'stock_save_item', {});
    assert.equal(m.missing, true);
    assert.equal(m.error.message, NEEDS_UPDATE, 'Drop 1: the words the screen shows');
    assert.equal(m.error.cause, err, 'the database answer rides along');
  }
  const refused = await callSave(fakeClient({ stock_save_item: { data: null, error: { code: '42501', message: 'Not allowed: this login does not reach Leeds.' } } }), 'stock_save_item', {});
  assert.equal(refused.missing, false, 'a refusal is never "not installed": no direct write behind it');
  assert.match(refused.error.message, /^Not allowed: /);
  const conflict = { entity: 'supplier', id: 's1', by: 'u2', by_name: 'Second login', at: '2026-10-21T09:00:00Z', row_version: 3 };
  const first = await callSave(fakeClient({ stock_save_supplier: { data: { ok: false, conflict, error: 'Second login saved this first at 10:00. Reload to see the change, then save again.' }, error: null } }), 'stock_save_supplier', {});
  assert.equal(first.missing, false); assert.deepEqual(first.conflict, conflict); assert.equal(first.error.code, 'conflict');
  assert.match(first.error.message, /Second login saved this first/);
  // the function is there with other arguments (a build that does not match its database): said, never a quiet direct write
  const other = { code: 'PGRST202', message: 'Could not find the function public.stock_save_item(p_item, p_section, p_sites, p_version) in the schema cache', hint: 'Perhaps you meant to call the function public.stock_save_item(p_item, p_sites, p_version)' };
  const mismatch = await callSave(fakeClient({ stock_save_item: { data: null, error: other } }), 'stock_save_item', {});
  assert.equal(mismatch.missing, false); assert.equal(mismatch.error, other);
  const near = { ...other, hint: 'Perhaps you meant to call the function public.stock_save_item_site(p_item, p_location, p_patch)' };
  assert.equal((await callSave(fakeClient({ stock_save_item: { data: null, error: near } }), 'stock_save_item', {})).missing, true, 'a hint naming ANOTHER function is still not installed');
  const thrown = await callSave({ rpc: async () => { throw new Error('Failed to fetch'); } }, 'stock_save_item', {});
  assert.equal(thrown.missing, false); assert.match(thrown.error.message, /Failed to fetch/);
  assert.match((await callSave(null, 'x', {})).error.message, /No database/);
});

test('Drop 1: no fallback. A missing save function answers NEEDS_UPDATE and nothing else runs', async () => {
  const client = fakeClient({});
  const r = await callSave(client, 'stock_save_pack', { p_pack: {} });
  assert.equal(client.calls.length, 1, 'one call, nothing after it');
  assert.equal(r.missing, true); assert.equal(r.error.message, NEEDS_UPDATE); assert.equal(r.data, null);
  const src = read('./companyData.js');
  assert.doesNotMatch(src, /saveOrDirect/, 'the Drop 0 fallback helper is deleted');
});

test('liveOrAll: archived rows left out; a database without the column reads as before', async () => {
  const seen = [];
  const r = await liveOrAll(async (live) => { seen.push(live); return { data: [1], error: null }; });
  assert.deepEqual(seen, [true]); assert.deepEqual(r.data, [1]);
  const seen2 = [];
  const r2 = await liveOrAll(async (live) => { seen2.push(live); return live ? { data: null, error: { code: '42703', message: 'column supplier_products.archived_at does not exist' } } : { data: [2], error: null }; });
  assert.deepEqual(seen2, [true, false]); assert.deepEqual(r2.data, [2]);
  const r3 = await liveOrAll(async () => ({ data: null, error: { message: 'Failed to fetch' } }));
  assert.match(r3.error.message, /Failed to fetch/, 'any other failure is a failure, never a wider read');
});

test('readAll: pages past the 1,000 row cap in order; a failed page is a failure', async () => {
  const rows = Array.from({ length: 2300 }, (_, i) => i);
  const build = () => ({ range: async (a, b) => ({ data: rows.slice(a, b + 1), error: null }) });
  const all = await readAll(build);
  assert.equal(all.data.length, 2300); assert.equal(all.data[2299], 2299);
  let n = 0;
  const bad = await readAll(() => ({ range: async () => { n += 1; return n === 2 ? { data: null, error: { message: 'timeout' } } : { data: rows.slice(0, 1000), error: null }; } }));
  assert.equal(bad.data, null); assert.match(bad.error.message, /timeout/);
});

// ── upsertSupplier saves and reads back every Suppliers form field ────────────────────────────────
// What the database does with stock_save_supplier in Drop 0 (contract 3.4): the company keys at the
// top and the site keys inside `site`, all written on location_id's suppliers row, which comes back
// as site_row.
const serverSaveSupplier = (args) => {
  const p = args.p_supplier;
  const row = {
    id: p.site_supplier_id || 'new-site-row', location_id: p.location_id, org_id: 'company', row_version: 2,
    name: p.name, contact_name: p.contact_name, phone: p.phone, payment_terms_days: p.payment_terms_days,
    account_number: p.site.account_number, email: p.site.email, min_order_value: p.site.min_order_value,
    delivery_days: p.site.delivery_days, cutoff_time: p.site.cutoff_time, notes: p.site.notes,
  };
  return { data: { ok: true, id: 'company-supplier', row_version: 2, site_supplier_id: row.id, site_row: row, queued: [] }, error: null };
};

test('contract: upsertSupplier saves and reads back every Suppliers form field (one save, no field lost)', async () => {
  // every field the Suppliers form edits (SuppliersSplit.jsx blank() and its inputs)
  const screen = read(SUPPLIERS_SCREEN);
  const blankFields = Object.keys(new Function(`return ${screen.match(/const blank = \(\) => (\(\{[^\n]*\}\));/)[1]}`)());
  assert.deepEqual(blankFields.sort(), ['accountNumber', 'contactName', 'cutoffTime', 'deliveryDays', 'email', 'minOrderValue', 'name', 'notes', 'paymentTermsDays', 'phone']);
  const edited = [...screen.matchAll(/upd\('(\w+)'/g)].map((m) => m[1]);
  for (const f of edited) assert.ok(blankFields.includes(f), `the form edits ${f}`);
  assert.match(screen, /const toggleDay = /, 'and the delivery days');
  const form = {
    id: 's1', rowVersion: 1, name: 'Dairy Co', contactName: 'Order desk', email: 'orders@example.test', phone: '0100 000000',
    accountNumber: 'AC-77', paymentTermsDays: '30', minOrderValue: '120.5', deliveryDays: ['mon', 'thu'], cutoffTime: '16:00', notes: 'Back door',
  };
  const client = fakeClient({ stock_save_supplier: serverSaveSupplier });
  const r = await callSave(client, 'stock_save_supplier', supplierSaveArgs(form, LOC, { section: 'purchasing' }));
  assert.equal(client.calls.length, 1, 'ONE call');
  assert.equal(client.calls[0].args.p_version, 1, 'the version of the row the form loaded');
  assert.equal(client.calls[0].args.p_section, 'purchasing');
  const back = supplierFromRow(r.data.site_row);
  const want = { ...form, paymentTermsDays: 30, minOrderValue: 120.5, rowVersion: 2 };
  for (const f of [...blankFields, 'id']) assert.deepEqual(back[f], want[f], f);
  // the same form saved new: no id, no version
  const fresh = fakeClient({ stock_save_supplier: serverSaveSupplier });
  const n = await callSave(fresh, 'stock_save_supplier', supplierSaveArgs({ ...form, id: undefined, rowVersion: undefined }, LOC));
  assert.equal(fresh.calls[0].args.p_version, null);
  assert.equal(supplierFromRow(n.data.site_row).accountNumber, 'AC-77');
  // data.js builds exactly this call and reads the row back through the same mapper
  const data = read('./data.js');
  const fn = data.slice(data.indexOf('export const upsertSupplier'), data.indexOf('export const setSupplierArchived'));
  assert.match(fn, /const r = await callSave\(supabase, 'stock_save_supplier', supplierSaveArgs\(supplier, locationId, opts\)\);/);
  assert.match(fn, /const row = siteRowOf\(r\.data, 'site_supplier_id'\);\s+return \{ data: row \? supplierFromRow\(row\) : null, error: null, queued: r\.data\?\.queued \|\| \[\] \};/);
  assert.doesNotMatch(fn, /supabase\.from\('suppliers'\)\.upsert\(/, 'Drop 1: no direct write behind it');
  assert.match(screen, /await upsertSupplier\(draft, locId, \{ section: 'purchasing' \}\)/);
});

// ── saveRecipeWithLines: recipe, lines and link in one call ───────────────────────────────────────
const dish = { id: 'r1', rowVersion: 3, recipeType: 'MENU', menuItemId: 'm7', portion: 1, name: 'Flat white', yieldQty: 1, yieldUnit: 'each', lines: [{ componentItemId: 'milk', qty: 200, unit: 'ml' }, { componentItemId: 'cup', qty: 1, unit: '@f1' }] };

test('contract: saveRecipeWithLines saves recipe, lines and link in ONE call and never reports lost lines', async () => {
  const client = fakeClient({ stock_save_recipe: { data: { ok: true, id: 'co', row_version: 4, site_recipe_id: 'r1', site_row: { id: 'r1', row_version: 4 }, lines_saved: 2, linked: true, cost: null, queued: [] }, error: null } });
  const r = await runRecipeSave({ client }, dish, LOC, { section: 'produce' });
  assert.equal(client.calls.length, 1); assert.equal(client.calls[0].fn, 'stock_save_recipe');
  const args = client.calls[0].args;
  assert.equal(args.p_recipe.site_recipe_id, 'r1'); assert.equal(args.p_recipe.menu_item_id, 'm7', 'the till product link goes in the same call');
  assert.equal(args.p_lines.length, 2); assert.equal(args.p_version, 3); assert.equal(args.p_section, 'produce');
  assert.equal(r.stage, null); assert.equal(r.error, null);
  assert.equal(r.data.id, 'r1'); assert.equal(r.data.rowVersion, 4);
  assert.equal(r.costOk, null, 'a dish makes no item: nothing to roll up');
  // a made item recipe: the cost answer drives the warning, exactly as before
  const batch = { recipeType: 'BATCH', outputItemId: 'soup', name: 'Soup', lines: [{ componentItemId: 'veg', qty: 1, unit: 'kg' }] };
  const good = await runRecipeSave({ client: fakeClient({ stock_save_recipe: { data: { ok: true, site_recipe_id: 'r2', cost: { item_id: 'soup', ok: true } }, error: null } }) }, batch, LOC);
  assert.equal(good.costOk, true);
  const noCost = await runRecipeSave({ client: fakeClient({ stock_save_recipe: { data: { ok: true, site_recipe_id: 'r2', cost: { item_id: 'soup', ok: false } }, error: null } }) }, batch, LOC);
  assert.equal(noCost.stage, null, 'the recipe and its lines DID save'); assert.equal(noCost.costOk, false);
  // a refusal or someone saving first: nothing saved, said once, at the recipe stage, never as lost lines
  for (const answer of [
    { data: null, error: { code: '42501', message: 'Not allowed: this screen cannot change recipes.' } },
    { data: { ok: false, conflict: { by_name: 'Second login' }, error: 'Second login saved this first at 10:00. Reload to see the change, then save again.' }, error: null },
  ]) {
    const c = fakeClient({ stock_save_recipe: answer });
    const bad = await runRecipeSave({ client: c }, dish, LOC);
    assert.equal(bad.stage, 'recipe'); assert.ok(bad.error); assert.equal(c.calls.length, 1);
  }
});

test('saveRecipeWithLines on a database without the function: NEEDS_UPDATE at the recipe stage, nothing else runs', async () => {
  const client = fakeClient({});
  const r = await runRecipeSave({ client }, { ...dish, outputItemId: 'sauce' }, LOC);
  assert.equal(r.stage, 'recipe'); assert.equal(r.error.message, NEEDS_UPDATE); assert.equal(r.data, null);
  assert.equal(client.calls.length, 1, 'only the save function was asked');
  const recipes = read('./recipes.js');
  for (const gone of ['export const upsertRecipe', 'export const replaceRecipeLines', 'export const recomputeMadeItemCost'])
    assert.ok(!recipes.includes(gone), `${gone}: the Drop 0 fallback is deleted`);
  assert.doesNotMatch(recipes, /\.(upsert|update|delete|insert)\(/, 'recipes.js writes nothing directly');
});

test('the recipe screens: one saveRecipeWithLines call each, the same toasts, lost lines only on the old path (source)', () => {
  const recipes = read('./recipes.js');
  assert.match(recipes, /export const saveRecipeWithLines = async \(draft, locationId = null, opts = \{\}\) => \{/);
  assert.match(recipes, /return runRecipeSave\(\{ client: supabase \}, draft, locationId, opts\);/);
  const screen = read('../../backoffice/sections/Recipes.jsx');
  const save = screen.slice(screen.indexOf('  const save = async () => {'), screen.indexOf('  const archive = async () => {'));
  assert.equal((save.match(/saveRecipeWithLines\(/g) || []).length, 1, 'ONE call');
  assert.doesNotMatch(save, /upsertRecipe\(|replaceRecipeLines\(|linkMenuItemRecipe\(|recomputeMadeItemCost\(/, 'none of the four old calls');
  assert.match(save, /const lineErr = res\.stage === 'lines' \? res\.error : null;/, '"Ingredients NOT saved" only when the lines really did not save');
  for (const words of ["'Save failed: ' + error.message", "'Ingredients NOT saved", "'Saved, but NOT linked to the menu product", "'. The item cost was NOT recalculated: check every ingredient has a price and a unit it understands'"]) {
    assert.ok(save.includes(words), `the toast stays: ${words}`);
  }
  const items = read(ITEMS_SCREEN);
  const tab = items.slice(items.indexOf('function RecipeTab('), items.indexOf('function NeedSaveFirst('));
  assert.equal((tab.match(/saveRecipeWithLines\(/g) || []).length, 1);
  assert.doesNotMatch(tab, /upsertRecipe\(|replaceRecipeLines\(|recomputeMadeItemCost\(/);
  assert.match(tab, /\}, locId, INV\);/, 'the made item tab names Inventory');
  assert.match(tab, /setRecipe\(r => \(\{ \.\.\.\(r \|\| \{\}\), id: saved\.id, rowVersion: saved\.rowVersion \?\? null \}\)\);/, 'a second save from the tab updates the same recipe');
  for (const words of ["'Recipe saved. Cost updated from ingredients.'", "'Recipe saved, but the cost was NOT recalculated: check every ingredient has a price and a unit it understands.'", "error?.message || 'Recipe save failed'"]) {
    assert.ok(tab.includes(words), `the toast stays: ${words}`);
  }
});

test('every browser catalogue write named in the map goes to its save function, and only to it (source)', () => {
  const data = read('./data.js');
  const body = (src, name, next) => src.slice(src.indexOf(name), next ? src.indexOf(next, src.indexOf(name) + 1) : undefined);
  const table = [
    ['export const upsertInventoryItem', 'stock_save_item', "from('inventory_items').upsert("],
    ['export const setInventoryItemArchived', 'stock_archive_item', "from('inventory_items')"],
    ['export const upsertSupplier ', 'stock_save_supplier', "from('suppliers').upsert("],
    ['export const setSupplierArchived', 'stock_archive_supplier', "from('suppliers').update("],
    ['export const upsertSupplierProduct', 'stock_save_supplier_item', 'directSupplierProduct(sp, locationId)'],
    ['export const deleteSupplierProduct', 'stock_archive_supplier_item', "from('supplier_products').delete()"],
    ['export const upsertItemConversion', 'stock_save_bridge', "from('inventory_item_conversions').upsert("],
    ['export const deleteItemConversion', 'stock_archive_bridge', "from('inventory_item_conversions').delete()"],
    ['export const upsertPackagingFormat', 'stock_save_pack', "from('item_packaging_formats').upsert("],
    ['export const setUnitDefault', 'stock_set_pack_default', "from('item_packaging_formats').update("],
    ['export const deletePackagingFormat', 'stock_archive_pack', "from('item_packaging_formats').delete()"],
    ['export const saveCostRule', 'stock_save_cost_rule', "from('stock_site_settings')"],
  ];
  for (const [name, fn, direct] of table) {
    const b = body(data, name, '\nexport ');
    assert.ok(b.length > 50, name);
    assert.match(b, new RegExp(`callSave\\(supabase, '${fn}', `), `${name} -> ${fn}`);
    assert.ok(!b.includes(direct), `${name}: Drop 1, no direct write (${direct}) behind it`);
  }
  // a delete is an archive from now on: the answer still carries the row id for the callers
  for (const name of ['export const deleteSupplierProduct', 'export const deleteItemConversion', 'export const deletePackagingFormat', 'export const setInventoryItemArchived', 'export const setSupplierArchived']) {
    assert.match(body(data, name, '\nexport '), /return \{ data: r\.error \? null : \[\{ id \}\], error: r\.error \};/, name);
  }
  // the cost step runs in the database: a save function answer never reports a "cost not updated" half
  for (const name of ['export const upsertSupplierProduct', 'export const upsertItemConversion']) {
    assert.match(body(data, name, '\nexport '), /return \{ data: [^\n]*, error: null, partial: null, queued: r\.data\?\.queued \|\| \[\] \};/, name);
  }
  const counts = read('./counts.js');
  const parFn = body(counts, 'export const upsertParLevel', '\nexport ');
  assert.match(parFn, /callSave\(supabase, 'stock_save_item_site', \{\s+p_item: inventoryItemId, p_location: locationId, p_patch: parPatch\(par\), p_version: null,/);
  assert.doesNotMatch(parFn, /from\('par_levels'\)/, 'no direct par write');
  const areas = read('./areas.js');
  const assign = body(areas, 'export const assignItemArea', '\nexport ');
  assert.match(assign, /callSave\(supabase, 'stock_save_item_site', \{\s+p_item: inventoryItemId, p_location: locationId, p_patch: areaPatch\(areaId, \{ moveHolding, byName \}\),/);
  assert.ok(!assign.includes("from('inventory_item_areas')"), 'Drop 1: no direct area steps');
  const recipes = read('./recipes.js');
  assert.match(body(recipes, 'export const setRecipeArchived', '\nexport '), /callSave\(supabase, 'stock_archive_recipe', archiveArgs\('p_recipe', id, archived, opts, SECTIONS\.produce\)\);/);
  assert.match(body(recipes, 'export const linkMenuItemRecipe', '\nexport '), /callSave\(supabase, 'stock_link_menu_item', \{/);
  assert.match(body(recipes, 'export const unlinkMenuItem', '\nexport '), /p_recipe: null/);
  assert.equal(NEEDS_UPDATE, 'This needs a database update. Ask ServOS to run it.');
  // nothing in the four data files writes a catalogue table directly any more
  for (const [file, src] of [['data.js', data], ['counts.js', counts], ['areas.js', areas], ['recipes.js', recipes]]) {
    for (const t of ['inventory_items', 'suppliers', 'supplier_products', 'inventory_item_conversions', 'item_packaging_formats', 'par_levels', 'inventory_item_areas', 'recipes', 'recipe_lines', 'menu_item_recipes', 'item_cost_history', 'stock_site_settings'])
      assert.doesNotMatch(src, new RegExp(`from\\('${t}'\\)\\s*\\.(insert|update|upsert|delete)\\(`), `${file}: no direct write to ${t}`);
    assert.doesNotMatch(src, /saveOrDirect/, `${file}: no fallback helper`);
  }
  assert.doesNotMatch(data, /export async function recomputeItemCost/, 'the browser cost step is gone: the database takes it');
});

test('each screen names its own section (Inventory, Produce, Purchasing) and sends the version it loaded (source)', () => {
  const items = read(ITEMS_SCREEN);
  assert.match(items, /const INV = Object\.freeze\(\{ section: 'inventory' \}\);/);
  for (const call of ['upsertInventoryItem(draft, locId, INV)', 'upsertParLevel(draft.id, nextBase, locId, INV)', "upsertSupplier({ name: newSupplier.trim() }, locId, INV)",
    'upsertSupplierProduct(sp, locId, INV)', 'setInventoryItemArchived(draft.id, next, locId, { ...INV, version: draft.rowVersion })',
    'deleteSupplierProduct(sp.id, draft.id, locId, { ...INV, version: sp.rowVersion })', 'setUnitDefault(id, draft.id, kind, locId, { ...INV, version: versionIn(formats, id) })']) {
    assert.ok(items.includes(call), call);
  }
  assert.match(items, /isPreferred: row\.isPreferred, rowVersion: row\.rowVersion \?\? null,/, 'an edited supplier pack carries its version');
  const suppliers = read(SUPPLIERS_SCREEN);
  assert.match(suppliers, /setSupplierArchived\(draft\.id, true, locId, \{ section: 'purchasing', version: draft\.rowVersion \}\)/);
  const recipes = read('../../backoffice/sections/Recipes.jsx');
  assert.match(recipes, /setRecipeArchived\(draft\.id, true, locId, \{ section: 'produce', version: draft\.rowVersion \}\)/);
  assert.match(recipes, /saveRecipeWithLines\(\{ \.\.\.draft, name: [^\n]*\}, locId, \{ section: 'produce' \}\)/);
});
