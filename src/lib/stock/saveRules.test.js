/**
 * saveRules.test.js: the save function arguments the stock screens send (v5.11.84, multi site stock
 * Drop 0). Run: npm test.
 *
 * The keys are fixed by the Drop 0 contract (section 3.4): the database refuses a key it does not
 * know, so each builder must send exactly its listed keys, the site form of each id, and never
 * org_id, on_hand or current_cost. Versions go back as p_version for an existing record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEEDS_UPDATE, SECTIONS, versionOf, isMissingColumnError, saveRefusal,
  itemFromRow, supplierFromRow, spFromRow, convFromRow, packFromRow, liveOnly,
  itemSaveArgs, supplierSaveArgs, supplierItemSaveArgs, packSaveArgs, bridgeSaveArgs, archiveArgs,
  parPatch, areaPatch, recipeSaveArgs, recipeSaveOutcome, keptRecipeLines,
} from './saveRules.js';

const LOC = '7d0c0000-0000-4000-8000-000000000001';
const sortedKeys = (o) => Object.keys(o).sort();
const NEVER = ['org_id', 'on_hand', 'current_cost', 'row_version'];
const noForbidden = (o, where) => {
  const walk = (v, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    for (const [k, x] of Object.entries(v)) {
      assert.ok(!NEVER.includes(k), `${where}: ${path}${k} must never be sent`);
      walk(x, `${path}${k}.`);
    }
  };
  walk(o, '');
};

test('words and small helpers', () => {
  assert.equal(NEEDS_UPDATE, 'This needs a database update. Ask ServOS to run it.');
  assert.deepEqual({ ...SECTIONS }, { inventory: 'inventory', produce: 'produce', purchasing: 'purchasing' });
  assert.equal(versionOf(3), 3);
  assert.equal(versionOf('7'), 7);
  for (const bad of [null, undefined, '', 0, -1, 1.5, 'x']) assert.equal(versionOf(bad), null, String(bad));
  assert.equal(isMissingColumnError({ code: '42703', message: 'column supplier_products.archived_at does not exist' }, 'archived_at'), true);
  assert.equal(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'archived_at' column" }, 'archived_at'), true);
  assert.equal(isMissingColumnError({ code: '42703', message: 'column x.other does not exist' }, 'archived_at'), false, 'another column is another problem');
  assert.equal(isMissingColumnError({ code: '42501', message: 'permission denied' }), false);
  assert.equal(isMissingColumnError(null), false);
  const paged = new Error('Could not read supplier packs: column supplier_products.archived_at does not exist');
  paged.cause = { code: '42703', message: 'column supplier_products.archived_at does not exist' };
  assert.equal(isMissingColumnError(paged, 'archived_at'), true, 'a paged read keeps the database error as its cause');
});

test('a save answer that is not a success is an error with the database words, conflicts flagged', () => {
  assert.equal(saveRefusal({ ok: true, id: 'a' }), null);
  assert.equal(saveRefusal(null), null);
  assert.equal(saveRefusal('price_list'), null, 'a read answer is not a refusal');
  const conflict = { entity: 'item', id: 'i1', by: 'u2', by_name: 'Second login', at: '2026-10-21T09:00:00Z', row_version: 4 };
  const c = saveRefusal({ ok: false, conflict, error: 'Second login saved this first at 10:00. Reload to see the change, then save again.' });
  assert.equal(c.code, 'conflict');
  assert.deepEqual(c.conflict, conflict);
  assert.match(c.message, /^Second login saved this first at 10:00\. Reload/);
  const plain = saveRefusal({ ok: false });
  assert.equal(plain.code, 'refused');
  assert.match(plain.message, /did not save/);
  assert.match(saveRefusal({ ok: false, conflict }).message, /saved this first/);
});

test('the mappers read row_version, company_ref and archived_at; older rows read as null', () => {
  const it = itemFromRow({ id: 'i1', name: 'Milk', row_version: 3, company_ref: 'c1', on_hand: '2', current_cost: '0.5' });
  assert.equal(it.rowVersion, 3); assert.equal(it.companyRef, 'c1'); assert.equal(it.onHand, 2); assert.equal(it.currentCost, 0.5);
  const old = itemFromRow({ id: 'i1', name: 'Milk' });
  assert.equal(old.rowVersion, null); assert.equal(old.companyRef, null);
  assert.equal(supplierFromRow({ id: 's', row_version: 2 }).rowVersion, 2);
  for (const fn of [spFromRow, convFromRow, packFromRow]) {
    const r = fn({ id: 'x', row_version: 5, company_ref: 'c', archived_at: '2026-10-21T00:00:00Z', pack_qty: 1, inner_qty: 1, pack_price: 1, from_qty: 1, to_qty: 1, qty_in_base: 1 });
    assert.equal(r.rowVersion, 5); assert.equal(r.companyRef, 'c'); assert.equal(r.archivedAt, '2026-10-21T00:00:00Z');
  }
  assert.deepEqual(liveOnly([{ id: 1 }, { id: 2, archived_at: '2026-10-21' }, null, { id: 3, archived_at: null }]).map((r) => r.id), [1, 3]);
  assert.deepEqual(liveOnly(null), []);
});

test('stock_save_item: the contract keys, the site id for an existing item, the version, Inventory', () => {
  const form = {
    id: 'i1', rowVersion: 4, name: '  Oat milk ', kind: 'PURCHASED', baseUnit: 'ml', category: 'Dairy', accountingGroup: 'Food',
    isTracked: true, isSellable: false, costMethod: 'MOVING_AVG', allergens: ['milk'], shelfLifeDays: '7', storageLocation: 'Fridge',
    defaultSupplierId: 's1', sku: 'OAT1', barcode: '5000', notes: 'Barista', purchaseTaxRateId: 't1',
    currentCost: 9.99, onHand: 12, orgId: 'org',
  };
  const a = itemSaveArgs(form, LOC);
  assert.deepEqual(sortedKeys(a), ['p_item', 'p_section', 'p_sites', 'p_version']);
  assert.equal(a.p_version, 4); assert.equal(a.p_sites, null); assert.equal(a.p_section, 'inventory');
  assert.deepEqual(sortedKeys(a.p_item), ['accounting_group', 'allergens', 'barcode', 'base_unit', 'category', 'location_id', 'name', 'purchase_tax_rate_id', 'shelf_life_days', 'site', 'site_item_id', 'sku']);
  assert.deepEqual(sortedKeys(a.p_item.site), ['cost_method', 'default_supplier_id', 'is_sellable', 'is_tracked', 'kind', 'notes', 'storage_location']);
  assert.equal(a.p_item.site_item_id, 'i1'); assert.equal(a.p_item.name, 'Oat milk'); assert.equal(a.p_item.shelf_life_days, 7);
  assert.equal(a.p_item.location_id, LOC); assert.equal(a.p_item.site.notes, 'Barista');
  noForbidden(a, 'item');
  const fresh = itemSaveArgs({ name: 'Cups', kind: 'MADE' }, LOC, { section: 'inventory' });
  assert.equal(fresh.p_version, null, 'a new item has no version');
  assert.ok(!('site_item_id' in fresh.p_item) && !('id' in fresh.p_item), 'no id at all for a new item');
  assert.equal(fresh.p_item.base_unit, 'each'); assert.equal(fresh.p_item.site.kind, 'MADE');
  assert.equal(fresh.p_item.shelf_life_days, null); assert.deepEqual(fresh.p_item.allergens, []);
});

test('stock_save_supplier: the company keys at the top, the site keys inside site (Drop 0 rule for every company)', () => {
  const a = supplierSaveArgs({ id: 's1', rowVersion: 2, name: ' Dairy Co ', contactName: 'A', email: 'o@x', phone: '1', accountNumber: 'AC1', paymentTermsDays: '30', minOrderValue: '50', deliveryDays: ['mon', 'thu'], cutoffTime: '16:00', notes: 'n' }, LOC);
  assert.deepEqual(sortedKeys(a), ['p_section', 'p_sites', 'p_supplier', 'p_version']);
  assert.equal(a.p_section, 'purchasing'); assert.equal(a.p_version, 2);
  assert.deepEqual(sortedKeys(a.p_supplier), ['contact_name', 'location_id', 'name', 'payment_terms_days', 'phone', 'site', 'site_supplier_id']);
  assert.deepEqual(sortedKeys(a.p_supplier.site), ['account_number', 'cutoff_time', 'delivery_days', 'email', 'min_order_value', 'notes']);
  assert.equal(a.p_supplier.payment_terms_days, 30); assert.equal(a.p_supplier.site.min_order_value, 50);
  assert.deepEqual(a.p_supplier.site.delivery_days, ['mon', 'thu']);
  noForbidden(a, 'supplier');
  const quick = supplierSaveArgs({ name: 'New one' }, LOC, { section: 'inventory' });
  assert.equal(quick.p_section, 'inventory', 'the Stock items quick add names Inventory');
  assert.equal(quick.p_version, null);
  assert.deepEqual(quick.p_supplier.site.delivery_days, []);
  assert.equal(quick.p_supplier.payment_terms_days, null);
});

test('stock_save_supplier_item: site ids for item and supplier, the preferred flag inside site, no cost', () => {
  const a = supplierItemSaveArgs({ id: 'sp1', rowVersion: 6, inventoryItemId: 'i1', supplierId: 's1', supplierSku: 'SKU', packDescription: '1 Case', packQty: 1, innerQty: 6000, innerUnit: 'ml', packPrice: '7.5', purchaseTaxRateId: null, priceIncludesTax: true, isPreferred: true, baseUnitCost: 0.00125, netPackPrice: 7.5 }, LOC);
  assert.deepEqual(sortedKeys(a), ['p_section', 'p_si', 'p_version']);
  assert.equal(a.p_version, 6); assert.equal(a.p_section, 'inventory');
  assert.deepEqual(sortedKeys(a.p_si), ['inner_qty', 'inner_unit', 'location_id', 'pack_description', 'pack_price', 'pack_qty', 'price_includes_tax', 'purchase_tax_rate_id', 'site', 'site_item_id', 'site_supplier_id', 'site_supplier_product_id', 'supplier_sku']);
  assert.deepEqual(a.p_si.site, { is_preferred: true });
  assert.equal(a.p_si.pack_price, 7.5);
  noForbidden(a, 'supplier item');
  assert.equal(supplierItemSaveArgs({ inventoryItemId: 'i1', supplierId: 's1' }, LOC).p_version, null);
});

test('stock_save_pack and stock_save_bridge: the site form of every id', () => {
  const p = packSaveArgs({ id: 'f2', rowVersion: 1, inventoryItemId: 'i1', name: ' Case ', qtyInBase: 6000, parentFormatId: 'f1', isCountDefault: true, isPurchaseDefault: false }, LOC);
  assert.deepEqual(sortedKeys(p.p_pack), ['is_count_default', 'is_purchase_default', 'location_id', 'name', 'qty_in_base', 'site_item_id', 'site_pack_id', 'site_parent_pack_id']);
  assert.equal(p.p_pack.name, 'Case'); assert.equal(p.p_pack.site_parent_pack_id, 'f1'); assert.equal(p.p_version, 1);
  assert.equal(packSaveArgs({ inventoryItemId: 'i1', name: 'Bottle', qtyInBase: 750 }, LOC).p_pack.site_parent_pack_id, null);
  const b = bridgeSaveArgs({ inventoryItemId: 'i1', fromQty: 1, fromUnit: 'each', toQty: '110', toUnit: 'g' }, LOC);
  assert.deepEqual(sortedKeys(b.p_bridge), ['from_qty', 'from_unit', 'location_id', 'site_item_id', 'to_qty', 'to_unit']);
  assert.equal(b.p_bridge.to_qty, 110); assert.equal(b.p_version, null);
  noForbidden(p, 'pack'); noForbidden(b, 'bridge');
});

test('archive calls: the record, its version, archive or restore, the section', () => {
  assert.deepEqual(archiveArgs('p_item', 'i1', true, { version: 3, section: 'inventory' }), { p_item: 'i1', p_version: 3, p_archived: true, p_section: 'inventory' });
  assert.deepEqual(archiveArgs('p_supplier', 's1', false, {}, 'purchasing'), { p_supplier: 's1', p_version: null, p_archived: false, p_section: 'purchasing' });
  assert.equal(archiveArgs('p_si', 'x', undefined).p_archived, true, 'a delete is an archive');
});

test('a par edit keeps what the screen did not send (the min_level wipe); an empty box clears', () => {
  assert.deepEqual(parPatch({ parLevel: '12', reorderPoint: '' }), { par_level: 12, reorder_point: null }, 'min_level is not sent, so it is kept');
  assert.deepEqual(parPatch({ minLevel: 2 }), { min_level: 2 });
  assert.deepEqual(parPatch({}), {});
  assert.deepEqual(parPatch(null), {});
  assert.deepEqual(areaPatch('a1', { byName: 'Second login' }), { area_id: 'a1', move_holding: true, by_name: 'Second login' });
  assert.deepEqual(areaPatch(null, { moveHolding: false }), { area_id: null, move_holding: false, by_name: null });
});

test('stock_save_recipe: recipe, kept lines and the till product link in one set of arguments', () => {
  const draft = {
    id: 'r1', rowVersion: 9, recipeType: 'MENU', menuItemId: 42, portion: 2, name: ' Flat white ', yieldQty: 1, yieldUnit: 'each',
    wastagePct: '5', gpTargetPct: '', method: 'Steam', photo: null, outputItemId: null, status: 'active',
    lines: [
      { componentItemId: 'milk', qty: '200', unit: 'ml', usablePct: null, note: null, orderTypes: [] },
      { componentItemId: '', qty: 1, unit: 'each' },
      { componentItemId: 'cup', qty: 1, unit: '@f9', usablePct: 100, orderTypes: ['takeaway'] },
      { componentItemId: 'beans', qty: 0, unit: 'g' },
    ],
  };
  const a = recipeSaveArgs(draft, LOC);
  assert.deepEqual(sortedKeys(a), ['p_lines', 'p_recipe', 'p_section', 'p_version']);
  assert.equal(a.p_section, 'produce'); assert.equal(a.p_version, 9);
  assert.deepEqual(sortedKeys(a.p_recipe), ['gp_target_pct', 'location_id', 'menu_item_id', 'method', 'name', 'photo', 'portion', 'recipe_type', 'site_output_item_id', 'site_recipe_id', 'wastage_pct', 'yield_qty', 'yield_unit']);
  assert.equal(a.p_recipe.menu_item_id, '42'); assert.equal(a.p_recipe.portion, 2); assert.equal(a.p_recipe.name, 'Flat white');
  assert.equal(a.p_recipe.gp_target_pct, null); assert.equal(a.p_recipe.wastage_pct, 5);
  assert.ok(!('status' in a.p_recipe), 'status is not a contract key');
  assert.equal(a.p_lines.length, 2, 'lines with no component or no quantity are dropped, as replaceRecipeLines did');
  assert.deepEqual(a.p_lines[0], { site_component_item_id: 'milk', qty: 200, unit: 'ml', usable_pct: 100, sort_order: 0, note: null, order_types: null });
  assert.deepEqual(a.p_lines[1], { site_component_item_id: 'cup', qty: 1, unit: '@f9', usable_pct: 100, sort_order: 1, note: null, order_types: ['takeaway'] }, 'a pack line keeps "@" plus this site\'s pack id');
  noForbidden(a, 'recipe');
  const batch = recipeSaveArgs({ recipeType: 'BATCH', outputItemId: 'soup', name: 'Soup', lines: [] }, LOC, { section: 'inventory' });
  assert.equal(batch.p_section, 'inventory', 'the made item Recipe tab names Inventory');
  assert.equal(batch.p_recipe.site_output_item_id, 'soup');
  assert.ok(!('menu_item_id' in batch.p_recipe), 'only a dish carries a till product');
  assert.equal(batch.p_version, null);
  assert.deepEqual(keptRecipeLines(null), []);
});

test('the recipe answer: the site recipe id, its new version, and whether the cost rolled up', () => {
  const ok = recipeSaveOutcome({ ok: true, id: 'co1', row_version: 3, site_recipe_id: 'r1', site_row: { id: 'r1', row_version: 7 }, lines_saved: 2, linked: true, cost: { item_id: 'soup', ok: true, before: 1, after: 1.2 }, queued: [] });
  assert.deepEqual(ok, { id: 'r1', rowVersion: 7, linesSaved: 2, linked: true, costOk: true, queued: [] });
  assert.equal(recipeSaveOutcome({ ok: true, cost: { ok: false } }, { id: 'r9' }).costOk, false);
  assert.equal(recipeSaveOutcome({ ok: true, cost: null }).costOk, null, 'no made item: nothing to roll up');
  assert.equal(recipeSaveOutcome(null, { id: 'r9' }).id, 'r9');
});
