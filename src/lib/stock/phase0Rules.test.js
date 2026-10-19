/**
 * phase0Rules.test.js: the stock safety pass (v5.11.79, multi site stock plan Phase 0). Run: npm test.
 *
 * The database half is supabase/migrations/20261019b_OPS_stock_phase0.sql, proved on a local
 * Postgres 17 by supabase/tests/stock_phase0/run.mjs (real roles, live timeouts). These tests pin
 * the browser half: the pure rules, the shared purchasing and costing rules the edge functions use
 * too, and the wiring in the source (the screens go through the one database call, with the old
 * path only when that call is missing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isMissingFunctionError, newUuid, COST_RULES, DEFAULT_COST_RULE, normCostRule, priceSetsCost,
  wasteStockTag, wasteTagText, NO_RECIPE_WORDS, openingCostOf, openingCosts, approvalOutcome, invoiceOutcome,
  recipeGapWords,
} from './phase0Rules.js';
import { poReceiptLines, packLabel, findDuplicateInvoice, duplicateInvoiceText, receivedOrdersOverlapping } from './purchasingRules.js';
import { movingAverageCost, costAfterReceipt } from '../../../supabase/functions/_shared/stockCosting.js';
import { officeReachesVenue } from '../../../supabase/functions/_shared/stockOfficeReach.js';
import { sentInReceiverUnits, shortOf, receivePlan, receiveLineUpdates } from './transferRules.js';
import { computeRecipe } from './costing.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const MIG = '../../../supabase/migrations/20261019b_OPS_stock_phase0.sql';
const RB = '../../../supabase/migrations/20261019b_OPS_stock_phase0_ROLLBACK.sql';

// ── small helpers ───────────────────────────────────────────────────────────────────────────────
test('a missing database function is told apart from any other error', () => {
  assert.equal(isMissingFunctionError({ code: 'PGRST202', message: 'Could not find the function public.approve_stock_count' }), true);
  assert.equal(isMissingFunctionError({ code: '42883', message: 'function x does not exist' }), true);
  assert.equal(isMissingFunctionError({ message: 'Could not find the function public.stock_receive(p_area_id) in the schema cache' }), true);
  assert.equal(isMissingFunctionError({ code: '42501', message: 'this session cannot move stock' }), false);
  assert.equal(isMissingFunctionError(null), false);
});

test('newUuid is a v4 uuid, different every time', () => {
  const a = newUuid(); const b = newUuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

// ── cost rule per venue (plan 4.5, decision 2) ──────────────────────────────────────────────────────
test('the cost rule: price list by default, deliveries by choice, anything else is the default', () => {
  assert.deepEqual([...COST_RULES], ['price_list', 'deliveries']);
  assert.equal(DEFAULT_COST_RULE, 'price_list');
  assert.equal(normCostRule('deliveries'), 'deliveries');
  assert.equal(normCostRule(undefined), 'price_list');
  assert.equal(normCostRule('nonsense'), 'price_list');
});

test('price list: a supplier price sets the cost, as every venue did before', () => {
  assert.equal(priceSetsCost({ rule: 'price_list', newCost: 1.2, currentCost: 0.9, everReceived: true }), true);
});

test('deliveries: a price only sets the cost of an item never received, or with no cost yet', () => {
  assert.equal(priceSetsCost({ rule: 'deliveries', newCost: 1.2, currentCost: 0.9, everReceived: true }), false);
  assert.equal(priceSetsCost({ rule: 'deliveries', newCost: 1.2, currentCost: 0.9, everReceived: false }), true);
  assert.equal(priceSetsCost({ rule: 'deliveries', newCost: 1.2, currentCost: null, everReceived: true }), true, 'an unknown cost is never left standing');
  assert.equal(priceSetsCost({ rule: 'deliveries', newCost: 1.2, currentCost: 0, everReceived: true }), true);
});

test('a price of 0 or less never sets a cost, whatever the rule', () => {
  for (const rule of COST_RULES) {
    assert.equal(priceSetsCost({ rule, newCost: 0 }), false);
    assert.equal(priceSetsCost({ rule, newCost: -1 }), false);
  }
});

test('the item screen never writes cost; price saves follow the venue rule (source)', () => {
  const src = read('./data.js');
  const row = src.slice(src.indexOf('const itemToRow = '), src.indexOf('const supplierFromRow = '));
  assert.doesNotMatch(row, /current_cost\s*:/, 'itemToRow carries no current_cost');
  const rc = src.slice(src.indexOf('export async function recomputeItemCost('));
  assert.match(rc, /const \{ data: rule \} = await fetchCostRule\(locationId\);/);
  assert.match(rc, /priceSetsCost\(\{ rule, newCost: chosenCost, currentCost: prev, everReceived: \(rec \|\| \[\]\)\.length > 0 \}\)/);
  assert.match(src, /from\('stock_site_settings'\)\.select\('cost_rule'\)/);
});

// ── below zero and unknown cost never drag the average (plan 1.3, 4.5, 11.5 item 3) ──────────────────
test('stock below zero takes the delivery price, never an average (on hand -8 at 1 plus 10 at 2 is 2, not 6)', () => {
  assert.equal(movingAverageCost({ onHandQty: -8, currentAvg: 1, receivedQty: 10, receivedUnitCost: 2 }), 2);
  assert.equal(movingAverageCost({ onHandQty: 0, currentAvg: 1, receivedQty: 10, receivedUnitCost: 2 }), 2);
});

test('an unknown cost (null or 0) takes the delivery price, never averages in as free', () => {
  assert.equal(movingAverageCost({ onHandQty: 10, currentAvg: null, receivedQty: 10, receivedUnitCost: 2 }), 2);
  assert.equal(movingAverageCost({ onHandQty: 10, currentAvg: 0, receivedQty: 10, receivedUnitCost: 2 }), 2);
});

test('a normal delivery still averages, and last cost still replaces', () => {
  assert.equal(movingAverageCost({ onHandQty: 10, currentAvg: 1, receivedQty: 10, receivedUnitCost: 2 }), 1.5);
  assert.equal(costAfterReceipt({ costMethod: 'LAST_COST', onHandQty: 10, currentAvg: 1, receivedQty: 1, receivedUnitCost: 3 }), 3);
  assert.equal(movingAverageCost({ onHandQty: 10, currentAvg: 1.5, receivedQty: 0, receivedUnitCost: 9 }), 1.5, 'nothing received moves nothing');
});

// ── wastage % on cost only (decision 3) ───────────────────────────────────────────────────────────
test('wastage % raises the plate cost (the cost side, here) and never the stock the database takes off', () => {
  const itemsById = { milk: { id: 'milk', baseUnit: 'ml', currentCost: 0.001, itemConversions: [] } };
  const out = { baseUnit: 'each', itemConversions: [] };
  const plain = computeRecipe({ yieldQty: 1, yieldUnit: 'each', wastagePct: 0, lines: [{ componentItemId: 'milk', qty: 200, unit: 'ml' }] }, out, { itemsById, recipesByOutputItem: {} });
  const wasted = computeRecipe({ yieldQty: 1, yieldUnit: 'each', wastagePct: 50, lines: [{ componentItemId: 'milk', qty: 200, unit: 'ml' }] }, out, { itemsById, recipesByOutputItem: {} });
  assert.ok(Math.abs(Number(wasted.totalCost ?? wasted.cost ?? wasted.unitCost) - 1.5 * Number(plain.totalCost ?? plain.cost ?? plain.unitCost)) < 1e-9, 'cost 1.5 x with 50% wastage');
  // the quantity side is the database's stock_explode (20261018c) and the waste function (20261019b):
  // neither multiplies by wastage_pct (harness section 21 proves 2 flat whites take 400 ml with 50%).
  const mig = read(MIG);
  const waste = mig.slice(mig.indexOf('create or replace function public.stock_record_waste('), mig.indexOf("revoke all on function public.stock_record_waste("));
  assert.doesNotMatch(waste, /wastage/i, 'the waste explosion never reads wastage %');
  assert.match(waste, /public\.stock_explode\(p_location_id,/, 'the waste explosion is the central depletion rule');
});

// ── waste is never refused (plan 4.7) ─────────────────────────────────────────────────────────────
test('waste tags and words: "No recipe: stock not taken off", never a refusal', () => {
  assert.equal(NO_RECIPE_WORDS, 'No recipe: stock not taken off');
  assert.equal(wasteStockTag({ linked: false, rows: [] }), 'no_recipe');
  assert.equal(wasteStockTag({ linked: true, rows: [] }), 'nothing_to_deduct');
  assert.equal(wasteStockTag({ linked: true, rows: [{}] }), null);
  assert.match(wasteTagText('no_recipe'), /^No recipe: stock not taken off\. It is recorded with the lost sale/);
  assert.match(wasteTagText('nothing_to_deduct'), /It is recorded with the lost sale/);
  assert.equal(wasteTagText(null), '');
});

test('both waste writers go through the one database call and fall back only when it is missing (source)', () => {
  const src = read('./waste.js');
  const menu = src.slice(src.indexOf('export const logMenuItemWaste'), src.indexOf('export const logWaste'));
  assert.match(menu, /supabase\.rpc\('stock_record_waste', \{ p_location_id: locationId, p_event: event, p_lines: rpcLines \}\)/);
  assert.match(menu, /const rpcLines = menuItemId \? null : /, 'a menu product is exploded by the database (p_lines null)');
  assert.match(menu, /menu_item_id: menuItemId \? String\(menuItemId\) : null/, 'the product id goes on the waste row');
  assert.match(menu, /if \(!isMissingFunctionError\(rpcErr\)\) return \{ data: null, error: rpcErr \};/, 'only a missing function falls back');
  const item = src.slice(src.indexOf('export const logWaste'));
  assert.match(item, /supabase\.rpc\('stock_record_waste', \{/);
  assert.match(item, /kind: 'item', inventory_item_id: inventoryItemId/);
});

// ── opening count (plan 4.6) ──────────────────────────────────────────────────────────────────────
test('opening stock is valued at the item cost, else its supplier price, else nothing (the manager types one)', () => {
  assert.equal(openingCostOf({ currentCost: 0.9 }), 0.9);
  assert.equal(openingCostOf({ currentCost: null, supplierProducts: [{ baseUnitCost: 1.2, isPreferred: true }] }), 1.2);
  assert.equal(openingCostOf({ currentCost: 0, supplierProducts: [] }), null);
  assert.equal(openingCostOf(null), null);
});

test('openingCosts: typed costs win, known ones fill in, the rest are named', () => {
  const needs = [{ item_id: 'a', name: 'Syrup' }, { item_id: 'b', name: 'Oat milk' }, { item_id: 'c', name: 'Cups' }];
  const items = { a: { currentCost: null, supplierProducts: [] }, b: { currentCost: 0.002 }, c: { currentCost: null, supplierProducts: [] } };
  const { costs, missing } = openingCosts(needs, items, { a: '0,85', c: '' });
  assert.deepEqual(costs, { a: 0.85, b: 0.002 });
  assert.deepEqual(missing, [{ itemId: 'c', name: 'Cups' }]);
});

test('approval words: needs a cost, approved, opening lines, a repeat', () => {
  const nc = approvalOutcome({ ok: false, code: 'needs_cost', needs_cost: [{ item_id: 'a', name: 'Syrup' }] });
  assert.equal(nc.ok, false); assert.deepEqual(nc.needsCost, [{ item_id: 'a', name: 'Syrup' }]);
  assert.match(nc.text, /never valued at 0/);
  const done = approvalOutcome({ ok: true, total: 3, opening: 1 });
  assert.equal(done.ok, true);
  assert.match(done.text, /3 lines adjusted/); assert.match(done.text, /1 line was opening stock \(left out of The Gap\)/);
  assert.match(done.text, /sales during the count are not added back/);
  assert.match(approvalOutcome({ ok: true, total: 0 }).text, /no stock moved/);
  assert.equal(approvalOutcome({ ok: true, duplicate: true }).ok, true);
  assert.equal(approvalOutcome(null).ok, false);
});

test('count approval is one database call; the old line by line path runs only when it is missing (source)', () => {
  const src = read('./counts.js');
  const fn = src.slice(src.indexOf('export const approveCount'));
  const rpc = fn.indexOf("supabase.rpc('approve_stock_count'");
  const old = fn.indexOf('const ready = await areasReady(locationId);');
  assert.ok(rpc > 0 && rpc < old, 'the one call comes first');
  assert.match(fn, /if \(!isMissingFunctionError\(rpcErr\)\) return \{ error: rpcErr \};/);
  assert.match(fn, /p_costs: costs && Object\.keys\(costs\)\.length \? costs : null/);
  const screen = read('../../backoffice/sections/StockCounts.jsx');
  assert.match(screen, /const \{ error, data: outcome, needsCost \} = await approveCount\(active\.id, locId, \{/);
  assert.match(screen, /review\.needsCost && review\.needsCost\.length > 0 && \(/, 'the screen asks for the missing costs');
});

// ── purchasing (plan 4.9, 11.5 item 3) ───────────────────────────────────────────────────────────────
test('packLabel: the supplier pack in words', () => {
  assert.equal(packLabel({ pack_qty: 6, inner_qty: 1, inner_unit: 'l' }), '6 x 1 l');
  assert.equal(packLabel({ packQty: 1, innerQty: 1.5, innerUnit: 'kg' }), '1.5 kg');
  assert.equal(packLabel({ pack_qty: 12, inner_qty: 0, inner_unit: 'ml' }), null);
});

test('poReceiptLines: one line per item brought in, keyed po:<order>:<line>, net cost per base unit, pack and price paid', () => {
  const lines = [
    { id: 'l1', inventory_item_id: 'milk', supplier_product_id: 'sp1', qty_packs: 2, qty_received: 0, unit_price: 6.6, pack_qty: 6, inner_qty: 1, inner_unit: 'l' },
    { id: 'l2', inventory_item_id: 'beans', qty_packs: 1, qty_received: 0, unit_price: 0, pack_qty: 1, inner_qty: 1, inner_unit: 'kg' },
    { id: 'l3', inventory_item_id: 'cups', qty_packs: 5, qty_received: 5, unit_price: 3, pack_qty: 1, inner_qty: 50, inner_unit: 'each' },
  ];
  const perPackOf = { l1: 6000, l2: 1, l3: 50 };
  const full = poReceiptLines('po1', lines, { perPackOf });
  assert.equal(full.length, 2, 'a line received already brings nothing in');
  assert.deepEqual(full[0], { key: 'po:po1:l1', item_id: 'milk', qty_base: 12000, unit_cost: 6.6 / 6000, supplier_product_id: 'sp1', pack_price: 6.6, pack_label: '6 x 1 l', line_id: 'l1', accepted: 2, price: 6.6 });
  assert.equal(full[1].unit_cost, 0, 'an unpriced line moves stock in at the known cost and leaves the cost alone');
  const byLine = poReceiptLines('po1', lines, { perPackOf, byLine: { l1: { qtyPacks: 1, unitPrice: 7.2 } } });
  assert.equal(byLine.length, 1, 'a line by line receive brings in only what was counted');
  assert.equal(byLine[0].qty_base, 6000); assert.equal(byLine[0].pack_price, 7.2);
});

test('a duplicate invoice number from the same supplier is found before posting, and said plainly', () => {
  const history = [{ id: 'i1', supplierId: 's1', invoiceNumber: ' INV-100 ' }, { id: 'i2', supplierId: 's2', invoiceNumber: 'INV-100' }];
  assert.equal(findDuplicateInvoice(history, { supplierId: 's1', invoiceNumber: 'inv-100' })?.id, 'i1');
  assert.equal(findDuplicateInvoice(history, { supplierId: 's3', invoiceNumber: 'INV-100' }), null, 'another supplier may use the same number');
  assert.equal(findDuplicateInvoice(history, { supplierId: 's1', invoiceNumber: '' }), null);
  assert.equal(duplicateInvoiceText('INV-100', 'Dairy Co'), 'Invoice INV-100 from Dairy Co is posted already at this venue. Nothing was posted again.');
});

test('an invoice for items an order from that supplier brought in lately points at that order (no double count)', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const orders = [
    { id: 'p1', reference: 'PO-1', supplierId: 's1', status: 'RECEIVED', receivedAt: '2026-10-18T09:00:00Z', lines: [{ inventoryItemId: 'milk', qtyReceived: 12 }] },
    { id: 'p2', reference: 'PO-2', supplierId: 's1', status: 'RECEIVED', receivedAt: '2026-09-01T09:00:00Z', lines: [{ inventoryItemId: 'milk', qtyReceived: 12 }] },
    { id: 'p3', reference: 'PO-3', supplierId: 's2', status: 'RECEIVED', receivedAt: '2026-10-18T09:00:00Z', lines: [{ inventoryItemId: 'milk', qtyReceived: 12 }] },
    { id: 'p4', reference: 'PO-4', supplierId: 's1', status: 'SENT', receivedAt: null, lines: [{ inventoryItemId: 'milk', qtyReceived: 0 }] },
  ];
  const got = receivedOrdersOverlapping(orders, { supplierId: 's1', itemIds: ['milk', 'beans'], nowMs: now });
  assert.deepEqual(got.map((o) => o.id), ['p1']);
  assert.equal(got[0].overlap, 1);
});

test('receives and invoices are one database call each; the old browser path only when the call is missing (source)', () => {
  const src = read('./purchasing.js');
  const recv = src.slice(src.indexOf('export const receivePurchaseOrder'), src.indexOf('export const createOrdersFromBasket'));
  assert.match(recv, /supabase\.rpc\('stock_receive', \{/);
  assert.match(recv, /if \(accepted > 0 && !oneCall\) \{/, 'the line by line post runs only without the one call');
  assert.ok(recv.indexOf("supabase.rpc('stock_receive'") < recv.indexOf("from('po_lines').update("), 'stock goes in before any order line changes');
  const inv = src.slice(src.indexOf('export const postInvoice'));
  assert.match(inv, /supabase\.rpc\('stock_post_invoice', \{/);
  assert.match(inv, /po_id: header\.poId \|\| null/, 'an invoice can be kept as the paperwork of a received order');
  const fpo = src.slice(src.indexOf('export const fetchPurchaseOrders'), src.indexOf('export const savePurchaseOrder'));
  assert.match(fpo, /readAllPagesResult\('order lines'/, 'order lines in pages of 1,000');
  assert.match(fpo, /\.in\('po_id', ids\)/, 'only the lines of the orders on screen');
  const ma = read('../../../supabase/functions/manager-approve/index.ts');
  assert.match(ma, /sb\.rpc\('stock_receive', \{/, 'the Manager app receive is the same one call');
});

test('invoice words: posted, paperwork for a received order, a duplicate number', () => {
  assert.match(invoiceOutcome({ ok: true, stock: true }, null, 3).text, /3 lines received into stock/);
  assert.match(invoiceOutcome({ ok: true, stock: false }, null, 3).text, /paperwork for an order received already/);
  assert.match(invoiceOutcome(null, { code: '23505', message: 'duplicate key value violates unique constraint "supplier_invoices_posted_number_uniq"' }).text, /posted already/);
  assert.equal(invoiceOutcome({ ok: false, code: 'duplicate_number', error: 'Invoice X is posted already' }).ok, false);
});

test('PO email and Xero bills accept the owner of the company, as every other screen does', () => {
  const user = { id: 'u1' };
  assert.deepEqual(officeReachesVenue({ user, linked: true }), { ok: true, via: 'link' });
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'owner', org_id: 'o1' }, venueOrgId: 'o1' }), { ok: true, via: 'owner' });
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'owner', org_id: 'o1' }, venueOrgId: 'o2' }), { ok: false, via: null });
  assert.deepEqual(officeReachesVenue({ user, profile: { role: 'super_admin' } }), { ok: true, via: 'super_admin' });
  assert.deepEqual(officeReachesVenue({ user: { id: 'u2', is_anonymous: true }, linked: true }), { ok: false, via: null }, 'never a till or customer session');
  for (const fn of ['po-send', 'xero-bills']) {
    assert.match(read(`../../../supabase/functions/${fn}/index.ts`), /officeReachesVenue\(/);
  }
  assert.match(read('../../../supabase/functions/po-send/index.ts'), /supplier_sku/, 'the PO email carries the supplier code');
});

// ── transfers (plan 4.8) ───────────────────────────────────────────────────────────────────────────
test('a line sent in ml arrives in litres; units that cannot convert are named, never guessed', () => {
  const litres = { id: 'r1', name: 'Milk', baseUnit: 'l', conversions: [] };
  assert.equal(sentInReceiverUnits({ qtyBase: 6000, baseUnit: 'ml' }, litres), 6);
  assert.equal(sentInReceiverUnits({ qtyBase: 6, baseUnit: 'l' }, litres), 6);
  assert.equal(sentInReceiverUnits({ qtyBase: 6, baseUnit: 'each' }, litres), null);
  const eggsByWeight = { id: 'r2', name: 'Eggs', baseUnit: 'g', conversions: [{ fromQty: 1, fromUnit: 'each', toQty: 60, toUnit: 'g' }] };
  assert.equal(sentInReceiverUnits({ qtyBase: 12, baseUnit: 'each' }, eggsByWeight), 720, 'through the receiving item\'s bridge');
});

test('the receive plan: sent in the receiver\'s unit, short worked out, a unit problem blocks the receive', () => {
  const receiver = [{ id: 'r1', name: 'Milk', sku: 'MILK', baseUnit: 'l', conversions: [] }, { id: 'r2', name: 'Cups', sku: 'CUP', baseUnit: 'each', conversions: [] }];
  const plan = receivePlan([
    { id: 'a', skuSnapshot: 'MILK', nameSnapshot: 'Milk', baseUnit: 'ml', qtyBase: 6000 },
    { id: 'b', skuSnapshot: 'CUP', nameSnapshot: 'Cups', baseUnit: 'g', qtyBase: 100 },
  ], receiver);
  assert.equal(plan.lines[0].qtyReceivedBase, 6, 'defaults to what was sent, in litres');
  assert.match(plan.lines[1].unitProblem, /sent in g and your Cups counts in each: add a unit bridge on your item, or drop the line/);
  assert.equal(plan.canReceive, false);
  const part = { ...plan.lines[0], qtyReceivedBase: 4 };
  assert.equal(shortOf(part, receiver[0]), 2, '2 l did not arrive: booked at the sender as Short on transfer');
  assert.equal(shortOf({ ...part, dropped: true }, receiver[0]), null);
  assert.deepEqual(receiveLineUpdates([part]), [{ id: 'a', to_inventory_item_id: 'r1', qty_received_base: 4, dropped: false }]);
});

test('sister sites only: the send list is the venues of this company (source)', () => {
  const src = read('./transfers.js');
  assert.match(src, /homeOrg && String\(l\.org_id\) === String\(homeOrg\)/);
});

// ── the Multi site menu warning (read only) ───────────────────────────────────────────────────────
test('recipe gaps in words, most first', () => {
  assert.deepEqual(recipeGapWords([
    { site_name: 'Location 2', missing: 3, from_site_name: 'Provo' },
    { site_name: 'Leeds', missing: 12, from_site_name: 'Train Station' },
    { site_name: 'York', missing: 1, from_site_name: null },
    { site_name: 'None', missing: 0 },
  ]), [
    '12 products have a recipe at Train Station but none at Leeds.',
    '3 products have a recipe at Provo but none at Location 2.',
    '1 product has a recipe at another site but none at York.',
  ]);
  assert.deepEqual(recipeGapWords(null), []);
});

// ── 1,000 row cap ───────────────────────────────────────────────────────────────────────────────────
test('every recipe and costing read is paged; none asks PostgREST for everything at once (source)', () => {
  const src = read('./recipes.js');
  for (const fn of ['export const fetchRecipes', 'export const buildCostingCtx', 'export const buildDepletionCtx']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n};\n', src.indexOf(fn)));
    assert.doesNotMatch(body, /supabase\.from\(/, `${fn} reads through pageAll only`);
    assert.match(body, /pageAll\(/);
  }
  assert.match(src, /for \(const col of \[\.\.\.order, 'id'\]\) q = q\.order\(col\);/, 'ordered on a unique key');
  const waste = read('./waste.js');
  assert.match(waste.slice(waste.indexOf('export const fetchWaste')), /readAllPagesResult\('waste'/);
});

// ── the kiosk and online browser stock calls ────────────────────────────────────────────────────────
test('the kiosk card path is untouched; the online checkout makes no stock call (source)', () => {
  const kiosk = read('../../surfaces/KioskApp.jsx');
  assert.match(kiosk, /depleteForSaleServer\(\{ id: checkId, items: cart\.map\(kioskDepleteItem\), orderType: orderTypeOut \}\);/, 'the fingerprinted submitOrder is byte for byte as it was');
  const online = read('../../surfaces/online/OnlineCheckout.jsx');
  assert.doesNotMatch(online, /depleteForSaleServer/);
});

// ── the migration and its rollback ──────────────────────────────────────────────────────────────────
test('20261019b and its rollback: ASCII only, bare statements, a visible check, the guard md5s agree', () => {
  const mig = read(MIG), rb = read(RB);
  for (const [name, text] of [['migration', mig], ['rollback', rb]]) {
    assert.ok([...text].every((ch) => ch.charCodeAt(0) < 128), `${name} is ASCII only`);
    assert.doesNotMatch(text, /^(begin|commit|start transaction)\s*;/im, `${name} has no begin or commit of its own`);
    assert.match(text.trimEnd(), /;\s*$/, `${name} ends with a statement`);
    assert.match(text, /VISIBLE CHECK/, `${name} has a visible check at the bottom`);
    assert.match(text, /This is not the Ops database/, `${name} refuses the wrong database`);
  }
  assert.doesNotMatch(mig, /MD5_[A-Z0-9]+/, 'every guard md5 is stamped');
  assert.doesNotMatch(rb, /MD5_[A-Z0-9]+/, 'every rollback md5 is stamped');
  // the base texts it guards on are the live ones (read on Ops 19 Oct 2026)
  assert.match(mig, /not in \('e9865d7cad62f582db4e904bf41ad512', '[0-9a-f]{32}'\)/, '20261018a core');
  assert.match(mig, /not in \('541ac92297e3784706a2f7a958d5c396', '[0-9a-f]{32}'\)/, '20261018c leg');
  const counted = /not in \('([0-9a-f]{32})', '[0-9a-f]{32}'\) then\n {4}v_bad := v_bad \|\| ' _stock_counted_after=/.exec(mig);
  assert.ok(counted && rb.includes(`'${counted[1]}') as counted_is_18c`), 'the rollback puts back the same 20261018c late sale guard');
  assert.match(rb, /'541ac92297e3784706a2f7a958d5c396'\) as leg_is_18c/);
  assert.match(rb, /'e9865d7cad62f582db4e904bf41ad512'\) as core_is_18a/);
});

test('central stock is 20261019\'s: 20261019b switches no venue and adds no recipe trigger', () => {
  const mig = read(MIG), rb = read(RB);
  assert.doesNotMatch(mig, /(perform|select) public\.stock_central_switch\(/, 'no switch is called');
  assert.doesNotMatch(mig, /insert into (public\.)?stock_depletion_mode|update (public\.)?stock_depletion_mode/, 'no mode row is written');
  assert.doesNotMatch(mig, /on public\.menu_item_recipes/, 'no trigger on recipe links');
  assert.doesNotMatch(mig, /update public\.stock_depletion_default|update stock_depletion_default/, 'the default stays browser (20261018c\'s self test)');
  assert.doesNotMatch(mig, /create or replace function public\.(post_stock_movement|stock_outbox_sweep|stock_central_switch|_stock_mode_of|_stock_outbox_on_insert|_stock_outbox_apply|stock_outbox_drain)\(/, 'the door, the sweep, the switch, the enqueue and the drainer are 20261018c\'s');
  assert.match(mig, /20261019 \(v5\.11\.78, run 19 Oct 2026\) made every venue central/, 'the header says why');
  assert.doesNotMatch(rb, /stock_central_switch\(|_stock_auto_central_on_link/, 'the rollback touches no mode either');
});

// ── the fixes of round 1 (19 Oct 2026 review) ──────────────────────────────────────────────────────
test('row locks are FOR NO KEY UPDATE: a save that points at an item never deadlocks with a writer', () => {
  const mig = read(MIG);
  assert.equal((mig.match(/for no key update;/g) || []).length, 10, 'the 10 row locks');
  assert.doesNotMatch(mig.replace(/for update using/g, ''), /for update\b/, 'no FOR UPDATE row lock is left (the policy text "for update using" is not a lock)');
});

test('counts: an older line under a newer approved count is superseded; counted_at and approved counts are locked', () => {
  const mig = read(MIG);
  assert.match(mig, /and coalesce\(o\.counted_at, oc\.approved_at\) > l\.at\s+and \(o\.area_id is null or l\.area_id is null or o\.area_id = l\.area_id\)\) as superseded/);
  assert.match(mig, /if v_l\.superseded then\s+v_delta := 0;/);
  assert.match(mig, /before insert or update or delete on public\.stock_count_lines/, 'the line trigger fires on every write, not only the figure');
  assert.match(mig, /elsif not v_sys then\s+new\.counted_at := old\.counted_at;/, 'an API caller cannot move counted_at');
  assert.match(mig, /before update or delete on public\.stock_counts\s+for each row execute function public\.stock_counts_keep_approved\(\);/);
  assert.match(mig, /if new\.status is distinct from old\.status or new\.approved_at is distinct from old\.approved_at\s+or new\.variance_value is distinct from old\.variance_value or new\.opening_value is distinct from old\.opening_value/);
  // the caller check comes before the lock
  const fn = mig.slice(mig.indexOf('create or replace function public.approve_stock_count('));
  assert.ok(fn.indexOf('stock_office_reaches(v_loc)') < fn.indexOf('for no key update'), 'approve checks the caller before it locks the count');
});

test('receive is Back Office or the Ops tablet; invoices take a client id; item waste with no lines; transfers round down', () => {
  const mig = read(MIG);
  const recv = mig.slice(mig.indexOf('create or replace function public.stock_receive('), mig.indexOf('revoke all on function public.stock_receive('));
  assert.match(recv, /public\.stock_office_reaches\(p_location_id\)/);
  assert.match(recv, /from ops_devices d\s+where d\.location_id = p_location_id and d\.device_uid = auth\.uid\(\) and d\.active/);
  assert.doesNotMatch(recv, /stock_caller_reaches/, 'a till or kiosk session no longer reaches the receive');
  assert.match(mig, /values \(coalesce\(v_client, gen_random_uuid\(\)\), p_location_id/, 'the client id is the invoice id');
  assert.match(mig, /exception when unique_violation then/, 'two retries at once answer duplicate');
  assert.match(mig, /if v_kind = 'item' and \(p_lines is null or jsonb_array_length\(p_lines\) = 0\) then/);
  assert.match(mig, /v_qty := trunc\(least\(coalesce\(v_l\.qty_received_base, v_l\.qty_base \* v_factor\), v_l\.qty_base \* v_factor\), 4\);/);
  assert.match(mig, /if v_short < 0\.00005 \* greatest\(1, 1 \/ v_factor\) then/);
  assert.match(mig, /and public\.stock_caller_reaches\(p_a\)/, 'same company answers only callers that reach the first venue');
  assert.match(mig, /select case when public\.stock_caller_reaches\(p_location_id\)/, 'the cost rule answers only callers that reach the venue');
});

test('usage reads: one row per item, 1,000 items a page; the live reads are kept; the rollback drops only the new ones', () => {
  const mig = read(MIG), rb = read(RB);
  assert.match(mig, /create or replace function public\.stock_usage_weekday_page\(p_location_id uuid, p_weeks integer default 8,\s+p_after uuid default null, p_tz text default null, p_day_start text default null\)\s+returns table\(inventory_item_id uuid, by_dow numeric\[\]\)/);
  assert.match(mig, /create or replace function public\.stock_usage_rates_page\(p_location_id uuid, p_days integer default 28,\s+p_after uuid default null\)/);
  assert.equal((mig.match(/order by i\.id\s+limit 1000/g) || []).length, 2, 'both page by item id, 1,000 at a time');
  assert.doesNotMatch(mig, /drop function if exists public\.stock_usage_by_weekday|create or replace function public\.stock_usage_by_weekday|create or replace function public\.stock_usage_rates\(/, 'the live reads are not touched');
  assert.match(rb, /drop function if exists public\.stock_usage_weekday_page\(uuid, integer, uuid, text, text\);/);
  assert.match(rb, /drop function if exists public\.stock_usage_rates_page\(uuid, integer, uuid\);/);
  assert.doesNotMatch(rb, /create or replace function public\.stock_usage_by_weekday/, 'nothing to put back');
  const data = read('./data.js');
  assert.match(data, /supabase\.rpc\('stock_usage_weekday_page', \{ p_location_id: locationId, p_weeks: weeks, p_after: after \}\)/);
  assert.match(data, /supabase\.rpc\('stock_usage_rates_page', \{ p_location_id: locationId, p_days: days, p_after: after \}\)/);
  const batches = read('../../backoffice/sections/Batches.jsx');
  assert.match(batches, /fetchUsageByWeekday\(8, loc\)/);
  assert.doesNotMatch(batches, /supabase\.rpc\('stock_usage_by_weekday'/, 'Batches no longer reads the capped one row per day answer');
});

test('an invoice carries the screen\'s own id, made once per scan, and a repeat is answered in words', () => {
  const inv = read('../../backoffice/sections/Invoices.jsx');
  assert.match(inv, /header: \{ clientId: newUuid\(\),/);
  const pur = read('./purchasing.js');
  assert.match(pur, /client_id: header\.clientId \|\| null,/);
  const o = invoiceOutcome({ ok: true, duplicate: true, invoice_id: 'x' }, null, 2);
  assert.equal(o.ok, true);
  assert.match(o.text, /posted already\. Nothing was posted twice/);
  assert.match(pur, /const \{ error: lineErr \} = await supabase\.from\('po_lines'\)\.insert\(lrows\);/, 'a failed order line save is said');
});

test('version and changelog say 5.11.79, name the database update, plain words', async () => {
  const { VERSION } = await import('../version.js');
  assert.equal(VERSION, '5.11.79');
  const { CHANGELOG } = await import('../changelog.js');
  assert.equal(CHANGELOG[0].v, '5.11.79');
  assert.ok(CHANGELOG[0].items.some((t) => /20261019b/.test(t)), 'the changelog names the database update');
  assert.ok(CHANGELOG[0].items.some((t) => /every venue has used it since 5\.11\.78/.test(t)), 'and says central stock is 5.11.78\'s, nothing switched here');
  assert.ok(CHANGELOG[0].items.some((t) => /newest count stands/.test(t)) && CHANGELOG[0].items.some((t) => /pages of 1,000 items/.test(t)), 'and names the round 1 fixes');
  for (const t of CHANGELOG[0].items) assert.doesNotMatch(t, /[–—]/, 'no dashes as punctuation');
});

test('the till path dates a sale at its own time, never ahead of the clock (11.5 item 2)', async () => {
  const src = read('./deplete.js');
  assert.match(src, /sourceType: 'closed_check', sourceId: key, idempotencyKey: `sale:\$\{key\}:\$\{invId\}`, occurredAt,/);
  // the pure helper, without importing deplete.js (it pulls the browser supabase client)
  const body = src.slice(src.indexOf('export function saleTimeOf('), src.indexOf('\n}\n', src.indexOf('export function saleTimeOf(')) + 2);
  // eslint-disable-next-line no-new-func
  const saleTimeOf = new Function(`${body.replace('export function', 'return function')}`)();
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(saleTimeOf({ closedAt: now - 3600000 }, now), '2026-10-19T11:00:00.000Z');
  assert.equal(saleTimeOf({ closed_at: '2026-10-19T11:30:00Z' }, now), '2026-10-19T11:30:00.000Z');
  assert.equal(saleTimeOf({ closedAt: now + 3600000 }, now), null, 'a till clock an hour ahead is left to the database');
  assert.equal(saleTimeOf({}, now), null);
});
