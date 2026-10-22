/**
 * companyApi.test.js: createStockApi, the one way the Drop 1 and Drop 2 screens talk to the database
 * (v5.11.89, multi site stock Drop 1, contract 2.2; v5.11.93 Drop 2 adds the recipe, batch and prep,
 * allergen and plate cost calls). Run: npm test.
 *
 * A stand in client records every call: each method names its function and sends exactly the
 * contract's arguments; a missing function is needsUpdate with the NEEDS_UPDATE words (never a
 * direct write); "someone saved first" comes back as conflict; queued jobs come back as queued.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStockApi, callRead, callSave, pollJobs, answerOf, needsUpdateError, sectionOfEntity, ymdDaysAgo, inboxPathOf, INBOX_BUCKET } from './companyData.js';
import { NEEDS_UPDATE } from './saveRules.js';

const ORG = 'b1000000-0000-4000-8000-000000000001';
const L1 = 'a1000000-0000-4000-8000-000000000001';
const L2 = 'a1000000-0000-4000-8000-000000000002';
const IT = 'e1000000-0000-4000-8000-000000000001';
const RC = 'c1000000-0000-4000-8000-000000000001';   // a company recipe id (Drop 2)
const PO = 'd1000000-0000-4000-8000-000000000001';   // a purchase order (Drop 3)
const TR = 'f1000000-0000-4000-8000-000000000001';   // a transfer (Drop 3)

/** rpc answers by function name (a value or a function of the args), and table answers by table. */
function fakeClient({ rpc = {}, tables = {} } = {}) {
  const calls = [];
  const queries = [];
  const builder = (table) => {
    const q = { table, steps: [] };
    queries.push(q);
    const answer = () => {
      const a = tables[table];
      if (a === undefined) return { data: [], error: null };
      return typeof a === 'function' ? a(q) : a;
    };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(answer()).then(res, rej);
        return (...args) => { q.steps.push([prop, ...args]); return chain; };
      },
    });
    return chain;
  };
  return {
    calls, queries,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const a = rpc[fn];
      if (a === undefined) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
      return typeof a === 'function' ? a(args) : a;
    },
    from: (t) => builder(t),
  };
}

// method -> [call it, function name, exact args]
const CASES = [
  [(a) => a.itemsPage({ orgId: ORG, sites: [L1], search: 'milk', filters: { on_at: L1 }, after: { k: 'm', id: IT } }), 'stock_items_page',
    { p_org: ORG, p_sites: [L1], p_search: 'milk', p_filters: { on_at: L1 }, p_after: { k: 'm', id: IT }, p_limit: 100 }],
  [(a) => a.itemsPage({ orgId: ORG }), 'stock_items_page', { p_org: ORG, p_sites: null, p_search: null, p_filters: null, p_after: null, p_limit: 100 }],
  [(a) => a.itemDetail(IT), 'stock_item_detail', { p_item: IT }],
  [(a) => a.itemUsedIn(IT), 'stock_item_used_in', { p_item: IT, p_after: null, p_limit: 100 }],
  [(a) => a.changesPage('item', IT, { at: 'x', key: 'c:1' }), 'stock_changes_page', { p_entity: 'item', p_id: IT, p_after: { at: 'x', key: 'c:1' }, p_limit: 100 }],
  [(a) => a.suppliersPage({ orgId: ORG, sites: [L1, L2] }), 'stock_suppliers_page', { p_org: ORG, p_sites: [L1, L2], p_search: null, p_filters: null, p_after: null, p_limit: 100 }],
  [(a) => a.supplierDetail(IT), 'stock_supplier_detail', { p_supplier: IT }],
  [(a) => a.pricesPage({ supplierId: IT, siteId: L2, search: 'oat' }), 'stock_prices_page', { p_supplier: IT, p_site: L2, p_search: 'oat', p_after: null, p_limit: 100 }],
  [(a) => a.needsAttention(ORG, [L1]), 'stock_needs_attention', { p_org: ORG, p_sites: [L1] }],
  [(a) => a.pausedItems(L1), 'stock_paused_items', { p_location: L1 }],
  [(a) => a.goLivePlan(L2), 'stock_golive_plan', { p_location: L2 }],
  [(a) => a.importCheck('job1'), 'stock_import_check', { p_job: 'job1', p_after: null, p_limit: 200 }],
  [(a) => a.saveItem({ item: { id: IT, name: 'Oat milk' }, version: 3 }), 'stock_save_item', { p_item: { id: IT, name: 'Oat milk' }, p_sites: null, p_version: 3, p_section: 'inventory' }],
  [(a) => a.saveItem({ item: { name: 'Oat milk' }, sites: [{ location_id: L1, on: true }] }), 'stock_save_item', { p_item: { name: 'Oat milk' }, p_sites: [{ location_id: L1, on: true }], p_version: null, p_section: 'inventory' }],
  [(a) => a.archiveItem(IT, 4), 'stock_archive_item', { p_item: IT, p_version: 4, p_archived: true, p_section: 'inventory' }],
  [(a) => a.archiveItem(IT, 4, false), 'stock_archive_item', { p_item: IT, p_version: 4, p_archived: false, p_section: 'inventory' }],
  [(a) => a.saveItemSite(IT, L2, { par_level: 4 }), 'stock_save_item_site', { p_item: IT, p_location: L2, p_patch: { par_level: 4 }, p_version: null, p_section: 'inventory' }],
  [(a) => a.setItemSites({ items: [IT], add: [L2] }), 'stock_set_item_sites', { p_items: [IT], p_add: [L2], p_remove: [], p_section: 'inventory' }],
  [(a) => a.pauseItems({ items: [IT], sites: [L2], from: '2026-11-01', until: '2026-11-03' }), 'stock_pause_items', { p_items: [IT], p_sites: [L2], p_from: '2026-11-01', p_until: '2026-11-03', p_paused: true, p_section: 'inventory' }],
  [(a) => a.pauseItems({ items: [IT], paused: false, section: 'purchasing' }), 'stock_pause_items', { p_items: [IT], p_sites: null, p_from: null, p_until: null, p_paused: false, p_section: 'purchasing' }],
  [(a) => a.savePack({ id: 'p1', item_id: IT, location_id: L1 }, 2), 'stock_save_pack', { p_pack: { id: 'p1', item_id: IT, location_id: L1 }, p_version: 2, p_section: 'inventory' }],
  [(a) => a.archivePack('p1', 2, true), 'stock_archive_pack', { p_pack: 'p1', p_version: 2, p_archived: true, p_section: 'inventory' }],
  [(a) => a.setPackDefault('p1', 'purchase', 2), 'stock_set_pack_default', { p_pack: 'p1', p_which: 'purchase', p_version: 2, p_section: 'inventory' }],
  [(a) => a.saveBridge({ id: 'b1' }, 1), 'stock_save_bridge', { p_bridge: { id: 'b1' }, p_version: 1, p_section: 'inventory' }],
  [(a) => a.archiveBridge('b1', 1, true), 'stock_archive_bridge', { p_bridge: 'b1', p_version: 1, p_archived: true, p_section: 'inventory' }],
  [(a) => a.saveSupplier({ supplier: { name: 'Dairy Co' }, sites: [{ location_id: L1, on: true }] }), 'stock_save_supplier', { p_supplier: { name: 'Dairy Co' }, p_sites: [{ location_id: L1, on: true }], p_version: null, p_section: 'purchasing' }],
  [(a) => a.archiveSupplier('s1', 5), 'stock_archive_supplier', { p_supplier: 's1', p_version: 5, p_archived: true, p_section: 'purchasing' }],
  [(a) => a.saveSupplierSite('s1', L2, { account_number: 'A1' }, 2), 'stock_save_supplier_site', { p_supplier: 's1', p_location: L2, p_patch: { account_number: 'A1' }, p_version: 2, p_section: 'purchasing' }],
  [(a) => a.saveSupplierItem({ id: 'si1' }, 3), 'stock_save_supplier_item', { p_si: { id: 'si1' }, p_version: 3, p_section: 'purchasing' }],
  [(a) => a.saveSupplierItem({ id: 'si1' }, 3, 'inventory'), 'stock_save_supplier_item', { p_si: { id: 'si1' }, p_version: 3, p_section: 'inventory' }],
  [(a) => a.saveSupplierItemSite('si1', L2, { price_here: 1.45 }, 2), 'stock_save_supplier_item_site', { p_si: 'si1', p_location: L2, p_patch: { price_here: 1.45 }, p_version: 2, p_section: 'purchasing' }],
  [(a) => a.archiveSupplierItem('si1', 2), 'stock_archive_supplier_item', { p_si: 'si1', p_version: 2, p_archived: true, p_section: 'purchasing' }],
  [(a) => a.saveOrderRules('s1', L1, [{ delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00' }], 6), 'stock_save_order_rules',
    { p_supplier: 's1', p_location: L1, p_rules: [{ delivery_dow: 1, order_by_dow: 0, order_by_time: '14:00' }], p_version: 6, p_section: 'purchasing' }],
  [(a) => a.copyOrderRules('s1', L1, [L2]), 'stock_copy_order_rules', { p_supplier: 's1', p_from: L1, p_to: [L2], p_section: 'purchasing' }],
  [(a) => a.changePrices({ item_ids: [IT], how: 'percent', value: 3 }), 'stock_change_prices', { p_spec: { item_ids: [IT], how: 'percent', value: 3 }, p_preview: true, p_section: 'inventory' }],
  [(a) => a.changePrices({ supplier_id: 's1' }, { preview: false, section: 'purchasing' }), 'stock_change_prices', { p_spec: { supplier_id: 's1' }, p_preview: false, p_section: 'purchasing' }],
  [(a) => a.cancelDatedPrice('d1'), 'stock_cancel_dated_price', { p_id: 'd1', p_section: 'inventory' }],
  [(a) => a.importStage(null, [{ row_no: 1 }], { org_id: ORG, source: 'csv' }), 'stock_import_stage', { p_job: null, p_rows: [{ row_no: 1 }], p_meta: { org_id: ORG, source: 'csv' } }],
  [(a) => a.importCommit('job1', [L1]), 'stock_import_commit', { p_job: 'job1', p_sites: [L1] }],
  [(a) => a.importCancel('job1'), 'stock_import_cancel', { p_job: 'job1' }],
  [(a) => a.copySite(L1, L2), 'stock_copy_site', { p_from: L1, p_to: L2, p_section: 'inventory' }],
  [(a) => a.saveCategory({ org_id: ORG, name: 'Dairy' }), 'stock_save_category', { p_cat: { org_id: ORG, name: 'Dairy' }, p_version: null, p_section: 'inventory' }],
  [(a) => a.archiveCategory('c1', 2), 'stock_archive_category', { p_id: 'c1', p_version: 2, p_archived: true, p_section: 'inventory' }],
  [(a) => a.saveSettings(ORG, { week_start: 1 }, 3), 'stock_save_settings', { p_org: ORG, p_patch: { week_start: 1 }, p_version: 3 }],
  [(a) => a.saveCostRule(ORG, 'deliveries'), 'stock_save_cost_rule', { p_org: ORG, p_rule: 'deliveries', p_override_location: null }],
  [(a) => a.saveCostRule(ORG, 'price_list', L2), 'stock_save_cost_rule', { p_org: ORG, p_rule: 'price_list', p_override_location: L2 }],
  [(a) => a.makeCompanyRecord('item', IT, 2), 'stock_make_company_record', { p_entity: 'item', p_id: IT, p_version: 2, p_section: 'inventory' }],
  [(a) => a.makeCompanyRecord('supplier', 's1', 2), 'stock_make_company_record', { p_entity: 'supplier', p_id: 's1', p_version: 2, p_section: 'purchasing' }],
  [(a) => a.saveGoLiveStep(L2, { step: 'opening_count', done: true }), 'stock_save_golive_step', { p_loc: L2, p_step: { step: 'opening_count', done: true }, p_version: null }],
  [(a) => a.saveSiteGroup({ org_id: ORG, name: 'North', location_ids: [L1] }), 'stock_save_site_group', { p_group: { org_id: ORG, name: 'North', location_ids: [L1] } }],
  [(a) => a.deleteSiteGroup('g1'), 'stock_delete_site_group', { p_id: 'g1' }],
  [(a) => a.setStockControl('u1', 'sites_full'), 'set_stock_control', { p_user: 'u1', p_level: 'sites_full' }],
  [(a) => a.suggestChange('item', IT, 'Shelf life is 7 days'), 'stock_suggest_change', { p_entity: 'item', p_id: IT, p_text: 'Shelf life is 7 days' }],
  [(a) => a.resyncSite(L2), 'stock_resync_site', { p_loc: L2 }],
  // ── Drop 2 (v5.11.93, contract 2.2): recipes, batch and prep, allergens ──
  [(a) => a.recipesPage({ orgId: ORG, sites: [L1], search: 'burger', filters: { kind: 'dish', on_at: L1 }, after: { k: 'b', id: RC } }), 'stock_recipes_page',
    { p_org: ORG, p_sites: [L1], p_search: 'burger', p_filters: { kind: 'dish', on_at: L1 }, p_after: { k: 'b', id: RC }, p_limit: 100 }],
  [(a) => a.recipesPage({ orgId: ORG }), 'stock_recipes_page', { p_org: ORG, p_sites: null, p_search: null, p_filters: null, p_after: null, p_limit: 100 }],
  [(a) => a.recipesPage({ orgId: ORG, limit: 20 }), 'stock_recipes_page', { p_org: ORG, p_sites: null, p_search: null, p_filters: null, p_after: null, p_limit: 20 }],
  [(a) => a.recipeDetail(RC), 'stock_recipe_detail', { p_recipe: RC }],
  [(a) => a.recipeCost(RC), 'stock_recipe_cost', { p_recipe: RC, p_sites: null, p_order_type: null }],
  [(a) => a.recipeCost(RC, [L1, L2], 'takeaway'), 'stock_recipe_cost', { p_recipe: RC, p_sites: [L1, L2], p_order_type: 'takeaway' }],
  [(a) => a.plateCosts(L1), 'stock_plate_costs', { p_loc: L1, p_after: null, p_limit: 1000 }],
  [(a) => a.plateCosts(L1, 'm-0400'), 'stock_plate_costs', { p_loc: L1, p_after: 'm-0400', p_limit: 1000 }],
  [(a) => a.recipeMissing({ orgId: ORG, sites: [L2], after: { k: 'x', id: 'm9' } }), 'stock_recipe_missing', { p_org: ORG, p_sites: [L2], p_after: { k: 'x', id: 'm9' }, p_limit: 100 }],
  [(a) => a.recipeMissing({ orgId: ORG }), 'stock_recipe_missing', { p_org: ORG, p_sites: null, p_after: null, p_limit: 100 }],
  [(a) => a.recipeFacts(RC), 'stock_recipe_facts', { p_recipe: RC, p_sites: null }],
  [(a) => a.recipeFacts(RC, [L1]), 'stock_recipe_facts', { p_recipe: RC, p_sites: [L1] }],
  [(a) => a.recipeCard(L1, { menuItemId: 'm1' }), 'stock_recipe_card', { p_loc: L1, p_menu_item_id: 'm1', p_recipe: null }],
  [(a) => a.recipeCard(L1, { recipeId: RC }), 'stock_recipe_card', { p_loc: L1, p_menu_item_id: null, p_recipe: RC }],
  [(a) => a.recipeCard(L1), 'stock_recipe_card', { p_loc: L1, p_menu_item_id: null, p_recipe: null }],
  [(a) => a.prepList(L1), 'stock_prep_list', { p_loc: L1, p_day: null }],
  [(a) => a.prepList(L1, '2026-11-02'), 'stock_prep_list', { p_loc: L1, p_day: '2026-11-02' }],
  [(a) => a.batchHow({ orgId: ORG, sites: [L1, L2], search: 'sauce', after: { k: 's', id: RC } }), 'stock_batch_how', { p_org: ORG, p_sites: [L1, L2], p_search: 'sauce', p_after: { k: 's', id: RC }, p_limit: 100 }],
  [(a) => a.batchHow({ orgId: ORG }), 'stock_batch_how', { p_org: ORG, p_sites: null, p_search: null, p_after: null, p_limit: 100 }],
  [(a) => a.menuProducts(ORG), 'stock_recipe_menu_products', { p_org: ORG, p_search: null, p_after: null, p_limit: 100 }],
  [(a) => a.menuProducts(ORG, 'latte', { k: 'l', id: 'p1' }), 'stock_recipe_menu_products', { p_org: ORG, p_search: 'latte', p_after: { k: 'l', id: 'p1' }, p_limit: 100 }],
  [(a) => a.saveRecipe({ recipe: { id: RC, name: 'Test Burger', location_id: L1 }, lines: [{ component_item_id: IT, qty: 1, unit: 'each' }], version: 3 }), 'stock_save_recipe',
    { p_recipe: { id: RC, name: 'Test Burger', location_id: L1 }, p_lines: [{ component_item_id: IT, qty: 1, unit: 'each' }], p_version: 3, p_section: 'produce' }],
  [(a) => a.saveRecipe({ recipe: { name: 'Test Burger', kind: 'dish' }, sites: [{ location_id: L1, on: true, menu_item_id: 'm1' }] }), 'stock_save_recipe',
    { p_recipe: { name: 'Test Burger', kind: 'dish', sites: [{ location_id: L1, on: true, menu_item_id: 'm1' }] }, p_lines: null, p_version: null, p_section: 'produce' }],
  [(a) => a.saveRecipe({ recipe: { id: RC, gp_target_pct: 70 }, version: 4, section: 'inventory' }), 'stock_save_recipe', { p_recipe: { id: RC, gp_target_pct: 70 }, p_lines: null, p_version: 4, p_section: 'inventory' }],
  [(a) => a.archiveRecipe(RC, 5), 'stock_archive_recipe', { p_recipe: RC, p_version: 5, p_archived: true, p_section: 'produce' }],
  [(a) => a.archiveRecipe(RC, 5, false), 'stock_archive_recipe', { p_recipe: RC, p_version: 5, p_archived: false, p_section: 'produce' }],
  [(a) => a.setRecipeSites(RC, [{ location_id: L2, on: true, menu_item_id: null }], 5), 'stock_set_recipe_sites', { p_recipe: RC, p_changes: [{ location_id: L2, on: true, menu_item_id: null }], p_version: 5, p_section: 'produce' }],
  [(a) => a.setRecipeSites(RC, null, null), 'stock_set_recipe_sites', { p_recipe: RC, p_changes: [], p_version: null, p_section: 'produce' }],
  [(a) => a.linkProducts([{ location_id: L1, menu_item_id: 'm1', recipe_id: RC }]), 'stock_recipe_link_products', { p_links: [{ location_id: L1, menu_item_id: 'm1', recipe_id: RC }], p_section: 'produce' }],
  [(a) => a.batchSetHow(RC, L2, 'to_order', 6), 'stock_batch_set_how', { p_recipe: RC, p_loc: L2, p_how: 'to_order', p_version: 6, p_section: 'produce' }],
  [(a) => a.saveOptionRule({ recipe_id: RC, kind: 'remove', option_name: 'No cheese', removes_item_id: IT }), 'stock_save_option_rule',
    { p_rule: { recipe_id: RC, kind: 'remove', option_name: 'No cheese', removes_item_id: IT }, p_version: null, p_section: 'produce' }],
  [(a) => a.saveOptionRule({ id: 'r1', recipe_id: RC, kind: 'replace' }, 2), 'stock_save_option_rule', { p_rule: { id: 'r1', recipe_id: RC, kind: 'replace' }, p_version: 2, p_section: 'produce' }],
  [(a) => a.archiveOptionRule('r1', 2), 'stock_archive_option_rule', { p_id: 'r1', p_version: 2, p_archived: true, p_section: 'produce' }],
  [(a) => a.archiveOptionRule('r1', 2, false), 'stock_archive_option_rule', { p_id: 'r1', p_version: 2, p_archived: false, p_section: 'produce' }],
  [(a) => a.swapIngredient({ mode: 'swap', from_item_id: IT, to_item_id: 'e2' }), 'stock_swap_ingredient', { p_spec: { mode: 'swap', from_item_id: IT, to_item_id: 'e2' }, p_preview: true, p_section: 'produce' }],
  [(a) => a.swapIngredient({ mode: 'amount', from_item_id: IT, factor: 1.2 }, { preview: false }), 'stock_swap_ingredient', { p_spec: { mode: 'amount', from_item_id: IT, factor: 1.2 }, p_preview: false, p_section: 'produce' }],
  [(a) => a.makeSizes(RC, [{ name: 'Large', factor: 1.4 }], 3), 'stock_make_sizes', { p_recipe: RC, p_sizes: [{ name: 'Large', factor: 1.4 }], p_version: 3, p_section: 'produce' }],
  [(a) => a.prepTick(L1, RC, 2), 'stock_prep_tick', { p_loc: L1, p_recipe: RC, p_qty: 2, p_section: 'produce' }],
  [(a) => a.prepTick(L1, RC, 1.5, 'inventory'), 'stock_prep_tick', { p_loc: L1, p_recipe: RC, p_qty: 1.5, p_section: 'inventory' }],
  [(a) => a.prepUntick('t1'), 'stock_prep_untick', { p_id: 't1' }],
  [(a) => a.factsSignoff(L1, 'm1'), 'stock_facts_signoff', { p_loc: L1, p_menu_item_id: 'm1', p_section: 'produce' }],
  [(a) => a.factsSignoff(L2, 'm2', 'inventory'), 'stock_facts_signoff', { p_loc: L2, p_menu_item_id: 'm2', p_section: 'inventory' }],
  [(a) => a.makeCompanyRecord('recipe', RC, 2), 'stock_make_company_record', { p_entity: 'recipe', p_id: RC, p_version: 2, p_section: 'produce' }],
  [(a) => a.saveSupplierItem({ id: 'si1', allergens: ['milk'], may_contain: ['nuts'], diets: ['vegetarian'], ingredients_text: 'Milk', nutrition: { kcal: 60 } }, 3), 'stock_save_supplier_item',
    { p_si: { id: 'si1', allergens: ['milk'], may_contain: ['nuts'], diets: ['vegetarian'], ingredients_text: 'Milk', nutrition: { kcal: 60 } }, p_version: 3, p_section: 'purchasing' }],
  // ── Drop 3 (v5.11.96, contract 2.2) ──
  [(a) => a.orderPadContext(L1), 'stock_order_pad_context', { p_loc: L1 }],
  [(a) => a.submitOrder(PO), 'stock_po_submit', { p_po: PO, p_section: 'purchasing' }],
  [(a) => a.decideOrder(PO, 'approve'), 'stock_po_decide', { p_po: PO, p_decision: 'approve', p_note: null, p_section: 'purchasing' }],
  [(a) => a.decideOrder(PO, 'send_back', 'Fewer cups'), 'stock_po_decide', { p_po: PO, p_decision: 'send_back', p_note: 'Fewer cups', p_section: 'purchasing' }],
  [(a) => a.createOrdersMany(ORG, [{ location_id: L1, supplier_id: 's1', lines: [] }]), 'stock_create_orders_many',
    { p_org: ORG, p_orders: [{ location_id: L1, supplier_id: 's1', lines: [] }], p_section: 'purchasing' }],
  [(a) => a.saveStandingOrder({ location_id: L1, supplier_id: 's1', delivery_dows: [1, 3] }), 'stock_save_standing_order',
    { p_so: { location_id: L1, supplier_id: 's1', delivery_dows: [1, 3] }, p_version: null, p_section: 'purchasing' }],
  [(a) => a.saveStandingOrder({ id: 'so1' }, 4), 'stock_save_standing_order', { p_so: { id: 'so1' }, p_version: 4, p_section: 'purchasing' }],
  [(a) => a.editStandingRun('so1', '2026-10-23'), 'stock_edit_standing_run', { p_so: 'so1', p_delivery_day: '2026-10-23', p_lines: null, p_skip: false }],
  [(a) => a.editStandingRun('so1', '2026-10-23', { skip: true }), 'stock_edit_standing_run', { p_so: 'so1', p_delivery_day: '2026-10-23', p_lines: null, p_skip: true }],
  [(a) => a.editStandingRun('so1', '2026-10-23', { lines: [{ inventory_item_id: IT, qty_packs: 2 }] }), 'stock_edit_standing_run',
    { p_so: 'so1', p_delivery_day: '2026-10-23', p_lines: [{ inventory_item_id: IT, qty_packs: 2 }], p_skip: false }],
  [(a) => a.saveDeliveryException({ scope: 'company', name: 'Christmas Day' }), 'stock_save_delivery_exception',
    { p_ex: { scope: 'company', name: 'Christmas Day' }, p_version: null, p_section: 'purchasing' }],
  [(a) => a.saveOrderList({ location_id: L1, name: 'Monday' }, 2), 'stock_save_order_list', { p_list: { location_id: L1, name: 'Monday' }, p_version: 2 }],
  [(a) => a.dueToOrder({ orgId: ORG, sites: [L1, L2], after: { at: 'x' } }), 'stock_due_to_order', { p_org: ORG, p_sites: [L1, L2], p_after: { at: 'x' }, p_limit: 100 }],
  [(a) => a.dueToOrder({ orgId: ORG }), 'stock_due_to_order', { p_org: ORG, p_sites: null, p_after: null, p_limit: 100 }],
  [(a) => a.ordersPage({ orgId: ORG, sites: [L1], status: 'SENT', filters: { search: 'milk' } }), 'stock_orders_page',
    { p_org: ORG, p_sites: [L1], p_status: 'SENT', p_filters: { search: 'milk' }, p_after: null, p_limit: 100 }],
  [(a) => a.deliveriesBoard({ orgId: ORG, sites: [L1] }), 'stock_deliveries_board', { p_org: ORG, p_sites: [L1], p_after: null, p_limit: 100 }],
  [(a) => a.invoicesPage({ orgId: ORG, filters: { match_status: 'both' } }), 'stock_invoices_page', { p_org: ORG, p_sites: null, p_filters: { match_status: 'both' }, p_after: null, p_limit: 100 }],
  [(a) => a.missingInvoices({ orgId: ORG, sites: [L2] }), 'stock_missing_invoices', { p_org: ORG, p_sites: [L2], p_after: null, p_limit: 100 }],
  [(a) => a.matchInvoice('i1'), 'stock_invoice_match', { p_invoice: 'i1' }],
  [(a) => a.approveInvoices(['i1', 'i2']), 'stock_invoices_approve', { p_ids: ['i1', 'i2'], p_note: null }],
  [(a) => a.splitInvoice('i1', [{ location_id: L1, amount: 10 }]), 'stock_invoice_split', { p_invoice: 'i1', p_splits: [{ location_id: L1, amount: 10 }] }],
  [(a) => a.inboxPage({ orgId: ORG }), 'stock_invoice_inbox_page', { p_org: ORG, p_status: 'waiting', p_after: null, p_limit: 100 }],
  [(a) => a.inboxPage({ orgId: ORG, status: 'placed', after: { id: 'x' } }), 'stock_invoice_inbox_page', { p_org: ORG, p_status: 'placed', p_after: { id: 'x' }, p_limit: 100 }],
  [(a) => a.inboxPlace('b1', L1), 'stock_inbox_place', { p_inbox: 'b1', p_location: L1, p_company_supplier: null }],
  [(a) => a.inboxIgnore('b1'), 'stock_inbox_ignore', { p_inbox: 'b1' }],
  [(a) => a.inboxAddress(ORG), 'stock_inbox_address', { p_org: ORG }],
  [(a) => a.saveCreditRequest({ location_id: L1, reason: 'short' }), 'stock_save_credit_request', { p_req: { location_id: L1, reason: 'short' }, p_version: null }],
  [(a) => a.setCreditStatus('cr1', 'written_off', 2, 'Small'), 'stock_credit_set_status', { p_id: 'cr1', p_status: 'written_off', p_version: 2, p_note: 'Small' }],
  [(a) => a.saveCreditNote({ location_id: L1, amount: 4 }), 'stock_save_credit_note', { p_note: { location_id: L1, amount: 4 } }],
  [(a) => a.creditsPage({ orgId: ORG, status: 'asked' }), 'stock_credits_page', { p_org: ORG, p_sites: null, p_status: 'asked', p_after: null, p_limit: 100 }],
  [(a) => a.priceChangesPage({ orgId: ORG, sites: [L1], filters: { rise_over_pct: 5 } }), 'stock_price_changes_page',
    { p_org: ORG, p_sites: [L1], p_filters: { rise_over_pct: 5 }, p_after: null, p_limit: 100 }],
  [(a) => a.makeCompanyPrice('si1', L1, 3), 'stock_make_company_price', { p_si: 'si1', p_location: L1, p_version: 3, p_section: 'purchasing' }],
  [(a) => a.budgetStatus(L1), 'stock_budget_status', { p_site: L1, p_week: null }],
  [(a) => a.budgetBoard(ORG, [L1, L2], '2026-10-20'), 'stock_budget_board', { p_org: ORG, p_sites: [L1, L2], p_week: '2026-10-20' }],
  [(a) => a.saveBudget({ location_id: null, rule: 'fixed', amount: 2600 }), 'stock_save_budget', { p_budget: { location_id: null, rule: 'fixed', amount: 2600 }, p_version: null }],
  [(a) => a.salesHistory(L1), 'stock_sales_history', { p_loc: L1, p_days: 84 }],
  [(a) => a.salesHistory(L1, 28), 'stock_sales_history', { p_loc: L1, p_days: 28 }],
  [(a) => a.forecastWeek(L1, '2026-10-20'), 'stock_forecast_week', { p_loc: L1, p_week_start: '2026-10-20' }],
  [(a) => a.saveForecast(L1, [{ day: '2026-10-22', amount: 900, reason: 'weather' }]), 'stock_save_forecast',
    { p_loc: L1, p_days: [{ day: '2026-10-22', amount: 900, reason: 'weather' }], p_hours: null }],
  [(a) => a.saveForecastSource(L2, L1, 0.8), 'stock_save_forecast_source', { p_loc: L2, p_from: L1, p_scale: 0.8, p_version: null }],
  [(a) => a.saveForecastSource(L2, null, null, 2), 'stock_save_forecast_source', { p_loc: L2, p_from: null, p_scale: null, p_version: 2 }],
  [(a) => a.countDue(ORG, [L1]), 'stock_count_due', { p_org: ORG, p_sites: [L1], p_day: null }],
  [(a) => a.saveCountPlan({ name: 'Full count', every: 'week' }), 'stock_save_count_plan', { p_plan: { name: 'Full count', every: 'week' }, p_version: null }],
  [(a) => a.saveCountTemplate({ name: 'Bar' }, [{ item_id: IT, sort_order: 1 }], [{ location_id: L1 }], 2), 'stock_save_count_template',
    { p_tpl: { name: 'Bar' }, p_lines: [{ item_id: IT, sort_order: 1 }], p_sites: [{ location_id: L1 }], p_version: 2 }],
  [(a) => a.templateForSite('t1', L1), 'stock_template_for_site', { p_template: 't1', p_loc: L1 }],
  [(a) => a.saveShelfOrder('t1', L1, [IT]), 'stock_save_shelf_order', { p_template: 't1', p_loc: L1, p_item_ids: [IT] }],
  [(a) => a.secondApproveCount('c1'), 'stock_second_approve_count', { p_count_id: 'c1', p_note: null }],
  [(a) => a.lockPeriod(L1, '2026-09-01', '2026-09-30'), 'stock_lock_period', { p_loc: L1, p_from: '2026-09-01', p_to: '2026-09-30' }],
  [(a) => a.unlockPeriod('p1', 'A late invoice'), 'stock_unlock_period', { p_period: 'p1', p_reason: 'A late invoice' }],
  [(a) => a.wasteReasons(L1), 'stock_waste_reasons', { p_loc: L1 }],
  [(a) => a.freshCloseDownList(L1), 'stock_fresh_closedown_list', { p_loc: L1, p_day: null }],
  [(a) => a.requestTransfer({ from: L1, to: L2, lines: [{ company_item_id: IT, qty_base: 2 }], reason: 'Ran out' }), 'stock_request_transfer',
    { p_from: L1, p_to: L2, p_lines: [{ company_item_id: IT, qty_base: 2 }], p_reason: 'Ran out', p_note: null }],
  [(a) => a.fulfilRequest(TR), 'stock_fulfil_request', { p_transfer: TR, p_lines: null }],
  [(a) => a.fulfilRequest(TR, [{ line_id: 'l1', qty_base: 1 }]), 'stock_fulfil_request', { p_transfer: TR, p_lines: [{ line_id: 'l1', qty_base: 1 }] }],
  [(a) => a.disputeTransfer(TR, 'Two short'), 'stock_dispute_transfer', { p_transfer: TR, p_note: 'Two short' }],
  [(a) => a.transferLeg(TR, 'refuse'), 'post_stock_transfer_leg', { p_transfer_id: TR, p_leg: 'refuse', p_by_name: null }],
  [(a) => a.transferLeg(TR, 'resolve', 'Area manager'), 'post_stock_transfer_leg', { p_transfer_id: TR, p_leg: 'resolve', p_by_name: 'Area manager' }],
  [(a) => a.transferMatches(TR), 'stock_transfer_matches', { p_transfer: TR }],
  [(a) => a.saveTransferList({ location_id: L1, name: 'Tuesday run' }), 'stock_save_transfer_list', { p_list: { location_id: L1, name: 'Tuesday run' }, p_version: null }],
  [(a) => a.setSiteKind(L2, 'central_kitchen'), 'stock_set_site_kind', { p_loc: L2, p_kind: 'central_kitchen' }],
  [(a) => a.kitchenOrdersIn(L2, '2026-10-23'), 'stock_kitchen_orders_in', { p_kitchen: L2, p_day: '2026-10-23' }],
  [(a) => a.kitchenPlan(L2, '2026-10-23'), 'stock_kitchen_plan', { p_kitchen: L2, p_day: '2026-10-23' }],
  [(a) => a.kitchenIngredients(L2, '2026-10-23'), 'stock_kitchen_ingredients', { p_kitchen: L2, p_day: '2026-10-23' }],
  [(a) => a.kitchenTick(L2, RC, 12), 'stock_kitchen_tick', { p_kitchen: L2, p_recipe: RC, p_qty: 12, p_day: null }],
  [(a) => a.kitchenUntick('k1'), 'stock_kitchen_untick', { p_id: 'k1' }],
  [(a) => a.kitchenPick(PO, [{ po_line_id: 'pl1', qty_packs_sent: 2 }]), 'stock_kitchen_pick', { p_po: PO, p_lines: [{ po_line_id: 'pl1', qty_packs_sent: 2 }] }],
  [(a) => a.setRecipeRestricted(RC, true, L2, 3), 'stock_set_recipe_restricted', { p_recipe: RC, p_restricted: true, p_kitchen: L2, p_version: 3 }],
  [(a) => a.saveRecipeSecret(RC, 'Fold gently', 4), 'stock_save_recipe_secret', { p_recipe: RC, p_method: 'Fold gently', p_version: 4 }],
  [(a) => a.rechargeStatement(ORG, '2026-09-01'), 'stock_recharge_statement', { p_org: ORG, p_month: '2026-09-01' }],
];

test('every method calls its own function with exactly the contract\'s arguments', async () => {
  for (const [call, fn, args] of CASES) {
    const c = fakeClient({ rpc: { [fn]: { data: { ok: true }, error: null } } });
    const r = await call(createStockApi(c));
    assert.equal(c.calls.length, 1, fn);
    assert.equal(c.calls[0].fn, fn);
    assert.deepEqual(c.calls[0].args, args, fn);
    assert.deepEqual(r, { data: { ok: true }, error: null, needsUpdate: false, conflict: null, queued: [] }, fn);
  }
});

test('a missing function is needsUpdate with the NEEDS_UPDATE words, for every method', async () => {
  for (const [call, fn] of CASES) {
    const c = fakeClient();
    const r = await call(createStockApi(c));
    assert.equal(r.needsUpdate, true, fn);
    assert.equal(r.error.message, NEEDS_UPDATE, fn);
    assert.equal(r.data, null);
    assert.equal(c.calls.length, 1, `${fn}: one call, no direct write after it`);
  }
  // 42883 too; a function with the same name but other arguments is a build mismatch, said as it is
  const c = fakeClient({ rpc: { stock_save_item: { data: null, error: { code: '42883', message: 'function public.stock_save_item(jsonb) does not exist' } } } });
  assert.equal((await createStockApi(c).saveItem({ item: {} })).needsUpdate, true);
  const other = { code: 'PGRST202', message: 'Could not find the function', hint: 'Perhaps you meant to call the function public.stock_items_page(p_org, p_sites)' };
  const m = await createStockApi(fakeClient({ rpc: { stock_items_page: { data: null, error: other } } })).itemsPage({ orgId: ORG });
  assert.equal(m.needsUpdate, false); assert.equal(m.error, other);
});

test('someone saved first: conflict and the server\'s words; a refusal: the database words; queued: the jobs', async () => {
  const conflict = { entity: 'item', id: IT, by_name: 'Second login', at: '2026-10-22T09:00:00Z', row_version: 5 };
  const words = 'Second login saved this first at 10:00. Reload to see the change, then save again.';
  const api = createStockApi(fakeClient({ rpc: {
    stock_save_item: { data: { ok: false, conflict, error: words }, error: null },
    stock_set_item_sites: { data: { ok: true, added: 40, queued: [{ location_id: L2, job_id: 77 }] }, error: null },
    stock_save_item_site: { data: null, error: { code: '42501', message: 'Not allowed: prices and the supplier here are set by head office.' } },
  } }));
  const c = await api.saveItem({ item: { id: IT }, version: 4 });
  assert.deepEqual(c.conflict, conflict); assert.equal(c.error.message, words); assert.equal(c.needsUpdate, false);
  const q = await api.setItemSites({ items: [IT], add: [L2] });
  assert.deepEqual(q.queued, [{ location_id: L2, job_id: 77 }]); assert.equal(q.error, null);
  const no = await api.saveItemSite(IT, L2, { price_here: 1.45 }, 3);
  assert.equal(no.error.message, 'Not allowed: prices and the supplier here are set by head office.');
  assert.equal(no.needsUpdate, false); assert.equal(no.conflict, null);
  // a thrown client never throws out of a method
  const thrown = await createStockApi({ rpc: async () => { throw new Error('Failed to fetch'); }, from: () => { throw new Error('Failed to fetch'); } }).itemDetail(IT);
  assert.match(thrown.error.message, /Failed to fetch/);
  const noDb = await createStockApi(null).categories(ORG);
  assert.match(noDb.error.message, /No database/);
});

test('the table reads: the columns, filters, order and the 1,000 row cap; a missing table needs an update', async () => {
  const c = fakeClient({ tables: { stock_co_categories: { data: [{ id: 'c1' }], error: null } } });
  const api = createStockApi(c);
  assert.deepEqual((await api.categories(ORG)).data, [{ id: 'c1' }]);
  const q = c.queries[0];
  assert.equal(q.table, 'stock_co_categories');
  assert.deepEqual(q.steps, [
    ['select', 'id, name, accounting_code, gp_target_pct, sort_order, archived_at, row_version'], ['eq', 'org_id', ORG],
    ['is', 'archived_at', null], ['order', 'sort_order'], ['order', 'name'], ['limit', 1000],
  ]);
  await api.categories(ORG, { archived: true });
  assert.ok(!c.queries[1].steps.some((s) => s[0] === 'is'), 'archived too: no live filter');
  await api.siteAreas(L2);
  assert.deepEqual(c.queries[2].steps, [['select', 'id, name, kind, sort_order'], ['eq', 'location_id', L2], ['is', 'archived_at', null], ['order', 'sort_order'], ['order', 'name'], ['limit', 1000]]);
  await api.queueJobs([1, 2, 2, null]);
  assert.deepEqual(c.queries[3].steps, [['select', 'id, location_id, kind, status, progress, last_error, done_at'], ['in', 'id', [1, 2]]]);
  const many = Array.from({ length: 150 }, (_, i) => i + 1);
  await api.queueJobs(many);
  assert.equal(c.queries[4].steps[1][2].length, 100, 'at most 100 ids');
  assert.deepEqual((await api.queueJobs([])).data, [], 'no ids: no read');
  assert.equal(c.queries.length, 5);
  await api.catchingUp([IT]);
  assert.deepEqual(c.queries[5].steps, [['select', 'id, location_id, kind, status'], ['in', 'status', ['waiting', 'running']], ['overlaps', 'entity_ids', [IT]], ['limit', 100]]);
  const gone = await createStockApi(fakeClient({ tables: { stock_co_categories: { data: null, error: { code: '42P01', message: 'relation "stock_co_categories" does not exist' } } } })).categories(ORG);
  assert.equal(gone.needsUpdate, true); assert.equal(gone.error.message, NEEDS_UPDATE);
});

test('Drop 2 table reads: the facts of a site (every column, at most 200 ids) and one recipe\'s cost history', async () => {
  const c = fakeClient({ tables: { menu_item_stock_facts: { data: [{ location_id: L1, menu_item_id: 'm1', allergens: ['milk'] }], error: null } } });
  const api = createStockApi(c);
  const all = await api.menuStockFacts(L1);
  assert.deepEqual(all.data, [{ location_id: L1, menu_item_id: 'm1', allergens: ['milk'] }]);
  assert.equal(c.queries[0].table, 'menu_item_stock_facts');
  assert.deepEqual(c.queries[0].steps, [['select', '*'], ['eq', 'location_id', L1], ['order', 'menu_item_id'], ['limit', 1000]], 'no ids: the whole site, 1,000 rows at most');
  await api.menuStockFacts(L1, ['m1', 7, 'm1', null, '']);
  assert.deepEqual(c.queries[1].steps, [['select', '*'], ['eq', 'location_id', L1], ['in', 'menu_item_id', ['m1', '7']], ['order', 'menu_item_id'], ['limit', 1000]], 'ids as text, once each, nothing empty');
  const many = Array.from({ length: 250 }, (_, i) => `m${i}`);
  await api.menuStockFacts(L1, many);
  assert.equal(c.queries[2].steps[2][2].length, 200, 'at most 200 ids a read');
  assert.deepEqual((await api.menuStockFacts(L1, [])).data, [], 'ids given but none: no read');
  assert.equal(c.queries.length, 3);
  // the location is text in that table, so a uuid object is sent as its text
  await api.menuStockFacts({ toString: () => L2 });
  assert.deepEqual(c.queries[3].steps[1], ['eq', 'location_id', L2]);
  // a database before Drop 2 has no facts table: needs an update, never a broken screen
  const gone = await createStockApi(fakeClient({ tables: { menu_item_stock_facts: { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.menu_item_stock_facts'" } } } })).menuStockFacts(L1);
  assert.equal(gone.needsUpdate, true); assert.equal(gone.error.message, NEEDS_UPDATE);
  // the cost history: one recipe at one site, the last 90 days, newest first, at most 400 rows
  const h = fakeClient({ tables: { recipe_cost_daily: { data: [{ day: '2026-10-20', cost: 2.1 }], error: null } } });
  const hist = await createStockApi(h).recipeCostHistory(RC, L1);
  assert.deepEqual(hist.data, [{ day: '2026-10-20', cost: 2.1 }]);
  assert.equal(h.queries[0].table, 'recipe_cost_daily');
  const steps = h.queries[0].steps;
  assert.deepEqual(steps.slice(0, 3), [['select', 'day, cost, cost_per_yield, sale_price_net, gp_pct, missing'], ['eq', 'recipe_id', RC], ['eq', 'location_id', L1]]);
  assert.equal(steps[3][0], 'gte'); assert.equal(steps[3][1], 'day');
  assert.match(steps[3][2], /^\d{4}-\d{2}-\d{2}$/, 'the lower bound is a day');
  assert.equal(steps[3][2], ymdDaysAgo(90), 'ninety days back by default');
  assert.deepEqual(steps.slice(4), [['order', 'day', { ascending: false }], ['limit', 400]]);
  await createStockApi(h).recipeCostHistory(RC, L1, 30);
  assert.equal(h.queries[1].steps[3][2], ymdDaysAgo(30));
  assert.match((await createStockApi(null).menuStockFacts(L1)).error.message, /No database/);
});

test('sectionOfEntity and ymdDaysAgo: the section a company record change is named as; a day lower bound', () => {
  assert.equal(sectionOfEntity('item'), 'inventory');
  assert.equal(sectionOfEntity('supplier'), 'purchasing');
  assert.equal(sectionOfEntity('recipe'), 'produce');
  assert.equal(sectionOfEntity('anything else'), 'inventory');
  const now = Date.UTC(2026, 9, 21, 15, 0, 0);   // 21 Oct 2026 15:00 UTC
  assert.equal(ymdDaysAgo(0, now), '2026-10-21');
  assert.equal(ymdDaysAgo(90, now), '2026-07-23');
  assert.equal(ymdDaysAgo(-5, now), '2026-10-21', 'never a day in the future');
  assert.equal(ymdDaysAgo('abc', now), '2026-10-21', 'junk is today');
  assert.equal(ymdDaysAgo(1.9, now), '2026-10-20', 'whole days');
});

test('integrator reads: every site\'s tax rates and the site groups with their versions', async () => {
  const c = fakeClient({ tables: { tax_rates: { data: [{ rate: 0.2, name: 'Standard', active: true, location_id: L1 }], error: null } } });
  const api = createStockApi(c);
  const r = await api.siteTaxRates([L1, L2, L1, null]);
  assert.deepEqual(r.data, [{ rate: 0.2, name: 'Standard', active: true, location_id: L1 }]);
  assert.equal(c.queries[0].table, 'tax_rates');
  assert.deepEqual(c.queries[0].steps, [['select', 'rate, name, active, location_id'], ['in', 'location_id', [L1, L2]], ['order', 'location_id'], ['order', 'id'], ['limit', 1000]]);
  assert.deepEqual((await api.siteTaxRates([])).data, [], 'no sites: no read');
  assert.equal(c.queries.length, 1);
  await api.siteGroups(ORG);
  assert.equal(c.queries[1].table, 'stock_co_site_groups');
  assert.deepEqual(c.queries[1].steps, [['select', 'id, name, location_ids, sort_order, row_version'], ['eq', 'org_id', ORG], ['order', 'sort_order'], ['order', 'name'], ['limit', 1000]]);
  const none = await createStockApi(null).siteGroups(ORG);
  assert.equal(none.error.message, 'No database');
});

test('settings: the company row and the site overrides together; either failing is the answer', async () => {
  const c = fakeClient({ tables: {
    stock_co_settings: { data: { org_id: ORG, cost_rule: 'price_list', row_version: 2 }, error: null },
    stock_co_site_settings: { data: [{ location_id: L2, cost_rule_override: 'deliveries', row_version: 1 }], error: null },
  } });
  const r = await createStockApi(c).settings(ORG);
  assert.deepEqual(r.data, { settings: { org_id: ORG, cost_rule: 'price_list', row_version: 2 }, sites: [{ location_id: L2, cost_rule_override: 'deliveries', row_version: 1 }] });
  assert.deepEqual(c.queries.map((q) => q.table), ['stock_co_settings', 'stock_co_site_settings']);
  assert.deepEqual(c.queries[1].steps.at(-1), ['limit', 1000]);
  const bad = await createStockApi(fakeClient({ tables: { stock_co_site_settings: { data: null, error: { message: 'timeout' } } } })).settings(ORG);
  assert.match(bad.error.message, /timeout/); assert.equal(bad.data, null);
});

test('callRead and callSave: the same answer, a read never carries a conflict', async () => {
  const c = fakeClient({ rpc: { stock_item_detail: { data: { ok: false, conflict: { x: 1 } }, error: null } } });
  const r = await callRead(c, 'stock_item_detail', { p_item: IT });
  assert.deepEqual(r, { data: { ok: false, conflict: { x: 1 } }, error: null, missing: false, conflict: null });
  const s = await callSave(fakeClient(), 'stock_save_item', {});
  assert.equal(s.missing, true); assert.equal(s.error.message, NEEDS_UPDATE); assert.equal(s.error.cause.code, 'PGRST202');
  assert.match((await callRead(null, 'x', {})).error.message, /No database/);
  assert.deepEqual(answerOf(null), { data: null, error: null, needsUpdate: false, conflict: null, queued: [] });
  assert.equal(needsUpdateError().needsUpdate, true);
});

test('pollJobs: polls every 3 s until every job is done or failed, then stops; stop() stops it', async () => {
  const pending = [];
  const timers = { set: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clear: () => {} };
  let n = 0;
  const api = { queueJobs: async (ids) => { n += 1; return { data: ids.map((id) => ({ id, status: n >= 3 ? (id === 2 ? 'failed' : 'done') : 'waiting' })), error: null }; } };
  const ticks = [];
  pollJobs(api, [1, 2], (rows) => ticks.push(rows.map((r) => r.status).join(',')), { timers });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(ticks, ['waiting,waiting']); assert.equal(pending.length, 1); assert.equal(pending[0].ms, 3000);
  await pending.shift().fn();
  await pending.shift().fn();
  assert.deepEqual(ticks, ['waiting,waiting', 'waiting,waiting', 'done,failed']);
  assert.equal(pending.length, 0, 'finished: no more polls');
  // stop() before the next tick: nothing more is asked
  const p2 = [];
  const t2 = { set: (fn) => { p2.push(fn); return 1; }, clear: () => {} };
  let asked = 0;
  const stop = pollJobs({ queueJobs: async () => { asked += 1; return { data: [{ id: 9, status: 'running' }], error: null }; } }, [9], () => {}, { timers: t2 });
  await new Promise((r) => setTimeout(r, 0));
  stop();
  await p2.shift()();
  assert.equal(asked, 1);
  // no ids, no api, or a database without the queue: no polling
  assert.equal(typeof pollJobs(api, [], () => {}), 'function');
  let gone = 0;
  const p3 = [];
  pollJobs({ queueJobs: async () => { gone += 1; return { data: null, error: new Error(NEEDS_UPDATE), needsUpdate: true }; } }, [1], () => {}, { timers: { set: (fn) => { p3.push(fn); }, clear: () => {} } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gone, 1); assert.equal(p3.length, 0);
  // stopWhen
  const p4 = [];
  pollJobs({ queueJobs: async () => ({ data: [{ id: 1, status: 'running' }], error: null }) }, [1], () => {}, { stopWhen: () => true, timers: { set: (fn) => { p4.push(fn); }, clear: () => {} } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p4.length, 0);
});

test('stockApi.js is the one browser instance (source)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./stockApi.js', import.meta.url), 'utf8');
  assert.equal(src.trim().split('\n').length, 3);
  assert.match(src, /^import \{ supabase \} from '\.\.\/supabase';$/m);
  assert.match(src, /^import \{ createStockApi \} from '\.\/companyData\.js';$/m);
  assert.match(src, /^export const stockApi = createStockApi\(supabase\);$/m);
  const data = fs.readFileSync(new URL('./companyData.js', import.meta.url), 'utf8');
  assert.doesNotMatch(data, /from '\.\.\/supabase'/, 'companyData.js stays pure: no browser client');
  assert.doesNotMatch(data, /saveOrDirect/, 'the Drop 0 fallback is gone');
  assert.doesNotMatch(data, /\.from\(table\)\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(data, /[\u2013\u2014]/);
});

// ── Drop 3 (v5.11.96, contract 2.2): table reads and the inbox upload ──

test('Drop 3 table reads: columns, filters, order and caps; a missing table needs an update', async () => {
  const c = fakeClient();
  const api = createStockApi(c);
  await api.deliveryExceptions(ORG);
  await api.standingOrders(L1);
  await api.standingOrders(L1, 's1');
  await api.invoiceSplits('i1');
  await api.countPlans(ORG);
  await api.countTemplates(ORG);
  await api.periods(L1);
  await api.transferLists(L1);
  const steps = c.queries.map((q) => [q.table, q.steps]);
  assert.deepEqual(steps, [
    ['stock_delivery_exceptions', [['select', '*'], ['eq', 'org_id', ORG], ['is', 'archived_at', null], ['gte', 'to_day', ymdDaysAgo(7)], ['order', 'from_day'], ['limit', 1000]]],
    ['stock_standing_orders', [['select', '*, stock_standing_order_lines(*)'], ['eq', 'location_id', L1], ['order', 'name'], ['limit', 200]]],
    ['stock_standing_orders', [['select', '*, stock_standing_order_lines(*)'], ['eq', 'location_id', L1], ['eq', 'supplier_id', 's1'], ['order', 'name'], ['limit', 200]]],
    ['supplier_invoice_site_splits', [['select', '*'], ['eq', 'invoice_id', 'i1'], ['limit', 100]]],
    ['stock_count_plans', [['select', '*'], ['eq', 'org_id', ORG], ['is', 'archived_at', null], ['order', 'name'], ['limit', 200]]],
    ['stock_count_templates', [['select', '*, stock_count_template_lines(item_id, sort_order), stock_count_template_sites(location_id, group_id)'], ['eq', 'org_id', ORG], ['is', 'archived_at', null], ['order', 'name'], ['limit', 200]]],
    ['stock_periods', [['select', '*, stock_period_snapshots(metrics)'], ['eq', 'location_id', L1], ['order', 'from_day', { ascending: false }], ['limit', 60]]],
    ['stock_transfer_lists', [['select', '*'], ['eq', 'location_id', L1], ['is', 'archived_at', null], ['order', 'name'], ['limit', 200]]],
  ]);
  // never a write
  for (const q of c.queries) for (const [step] of q.steps) assert.ok(!['insert', 'update', 'upsert', 'delete'].includes(step), `${q.table}: ${step}`);
  const gone = await createStockApi(fakeClient({ tables: { stock_count_plans: { data: null, error: { code: '42P01', message: 'relation "stock_count_plans" does not exist' } } } })).countPlans(ORG);
  assert.equal(gone.needsUpdate, true); assert.equal(gone.error.message, NEEDS_UPDATE);
  assert.match((await createStockApi(null).periods(L1)).error.message, /No database/);
});

test('inboxPathOf: org/<org>/<id>.<ext>, the extension lower case; nothing usable is null', () => {
  assert.equal(inboxPathOf(ORG, 'Invoice 42.PDF', 'u1'), `org/${ORG}/u1.pdf`);
  assert.equal(inboxPathOf(ORG, 'scan.jpeg', 'u1'), `org/${ORG}/u1.jpeg`);
  assert.equal(inboxPathOf(ORG, 'no extension', 'u1'), `org/${ORG}/u1`);
  assert.equal(inboxPathOf(ORG, 'weird.tar.gz!', 'u1'), `org/${ORG}/u1`);
  assert.equal(inboxPathOf(ORG, '../../x.pdf', 'u1'), `org/${ORG}/u1.pdf`, 'the name never becomes part of the path');
  assert.equal(inboxPathOf(null, 'a.pdf', 'u1'), null);
  assert.equal(inboxPathOf(ORG, 'a.pdf', ''), null);
  assert.equal(inboxPathOf('a/b', 'a.pdf', 'u1'), null);
  assert.equal(inboxPathOf(ORG, 'a.pdf', 'x/y'), null);
  assert.equal(INBOX_BUCKET, 'stock-invoice-inbox');
});

test('inboxUpload: the file into the bucket under the company, then stock_inbox_add; inboxFileUrl: a 5 minute link', async () => {
  const uploads = [];
  const signed = [];
  const c = fakeClient({ rpc: { stock_inbox_add: { data: { ok: true, id: 'b1' }, error: null } } });
  c.storage = { from: (bucket) => ({
    upload: async (path, file, opts) => { uploads.push({ bucket, path, file, opts }); return { data: { path }, error: null }; },
    createSignedUrl: async (path, secs) => { signed.push({ bucket, path, secs }); return { data: { signedUrl: `https://x/${path}` }, error: null }; },
  }) };
  const file = { name: 'Bill.pdf', type: 'application/pdf' };
  const r = await createStockApi(c).inboxUpload(ORG, file);
  assert.equal(r.error, null); assert.deepEqual(r.data, { ok: true, id: 'b1' });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bucket, 'stock-invoice-inbox');
  assert.match(uploads[0].path, new RegExp(`^org/${ORG}/[0-9a-f-]+\\.pdf$`));
  assert.equal(uploads[0].file, file);
  assert.deepEqual(uploads[0].opts, { contentType: 'application/pdf', upsert: false });
  assert.deepEqual(c.calls, [{ fn: 'stock_inbox_add', args: { p_org: ORG, p_file_path: uploads[0].path, p_file_name: 'Bill.pdf', p_mime: 'application/pdf' } }]);
  // a failed upload: no database call
  const c2 = fakeClient({ rpc: { stock_inbox_add: { data: { ok: true }, error: null } } });
  c2.storage = { from: () => ({ upload: async () => ({ data: null, error: { message: 'The object exceeded the maximum allowed size' } }) }) };
  const bad = await createStockApi(c2).inboxUpload(ORG, file);
  assert.match(bad.error.message, /maximum allowed size/); assert.equal(c2.calls.length, 0);
  // no file, no storage
  assert.equal((await createStockApi(c).inboxUpload(ORG, null)).error.message, 'Pick a file to upload.');
  assert.match((await createStockApi(fakeClient()).inboxUpload(ORG, file)).error.message, /No database/);
  // the signed link
  const u = await createStockApi(c).inboxFileUrl(`org/${ORG}/u1.pdf`);
  assert.equal(u.data, `https://x/org/${ORG}/u1.pdf`);
  assert.deepEqual(signed, [{ bucket: 'stock-invoice-inbox', path: `org/${ORG}/u1.pdf`, secs: 300 }]);
});

test('Drop 3 refusals come back as the database words: the waste PIN, the second approval, the raiser', async () => {
  const api = createStockApi(fakeClient({ rpc: {
    stock_po_decide: { data: null, error: { code: '42501', message: 'You raised this order. Another manager approves it.' } },
    stock_second_approve_count: { data: { ok: false, error: 'You gave the first approval. Someone else gives the second.' }, error: null },
    stock_po_submit: { data: { ok: true, needs_approval: true, limit: 800, amount: 912.5, approvers: ['Area manager'] }, error: null },
  } }));
  const d = await api.decideOrder(PO, 'approve');
  assert.equal(d.error.message, 'You raised this order. Another manager approves it.'); assert.equal(d.needsUpdate, false);
  const s2 = await api.secondApproveCount('c1');
  assert.equal(s2.error.message, 'You gave the first approval. Someone else gives the second.');
  const sub = await api.submitOrder(PO);
  assert.equal(sub.error, null); assert.equal(sub.data.needs_approval, true);
});
