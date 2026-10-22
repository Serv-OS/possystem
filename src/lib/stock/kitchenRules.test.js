// node --test: the central kitchen's plain maths and words (src/lib/stock/kitchenRules.js, multi site
// stock Drop 3, contract 3.4). Synthetic names and amounts only (the repo is public).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  q3, dayWords, shortDay, addDaysYmd, makeOf, doneOf, leftToMake, planRow, bySiteWords, qtyUnit, fillWords, planTotals,
  tickQty, tickWords, perPackBase, packsToBase, shortOf, sentQty, sentAsOrdered, pickLines, shortLines, lotWords,
  deliveryNote, labelsOf, ALLERGENS_UNKNOWN, ordersInStatus, ingredientBasket, basketWords, monthStart, monthChoices, rechargeState, rechargeToSend,
} from './kitchenRules.js';

test('days in words, on the venue day given (never the device clock)', () => {
  assert.equal(dayWords('2026-10-21'), 'Wednesday 21 October');
  assert.equal(dayWords('nope'), '');
  assert.equal(shortDay('2026-10-24T08:00:00Z'), '24 Oct');
  assert.equal(shortDay(null), '');
  assert.equal(addDaysYmd('2026-10-31', 1), '2026-11-01');
  assert.equal(addDaysYmd('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysYmd('bad', 1), '');
});

test('Make is ordered plus catering plus standing, less holds, never below 0 (the mockup rows)', () => {
  // Brioche bun: 312 ordered by sites, 40 catering, 24 standing, 96 held -> 280
  assert.equal(makeOf({ ordered: 312, catering: 40, standing: 24, holds: 96 }), 280);
  // Burger sauce: 4 + 2 - 1 = 5
  assert.equal(makeOf({ ordered: 4, catering: 2, standing: 0, holds: 1 }), 5);
  assert.equal(makeOf({ ordered: 2, holds: 9 }), 0);
  assert.equal(makeOf({ ordered: 0.1, catering: 0.2 }), 0.3);
  assert.equal(makeOf(), 0);
  assert.equal(q3('x'), 0);
});

test('Done ticks add up; what is left never goes below 0', () => {
  const ticks = [{ qty: 100 }, { qty: 80.5 }, { qty: -3 }, { qty: 'x' }];
  assert.equal(doneOf(ticks), 180.5);
  assert.equal(doneOf(null), 0);
  assert.equal(leftToMake({ make: 280, ticks }), 99.5);
  assert.equal(leftToMake({ make: 100, done: 120 }), 0);
  assert.equal(leftToMake({ ordered: 10, holds: 2, ticks: [{ qty: 3 }] }), 5);
});

test('a plan row keeps the server figures and works make and done out when missing', () => {
  const r = planRow({ recipe_id: 'r1', name: 'Bun', unit: 'buns', ordered: 10, catering: 2, standing: 1, holds: 3, ticks: [{ qty: 4 }], by_site: [{ site_name: 'North', qty: 6 }, { site_name: 'South', qty: 4 }] });
  assert.equal(r.make, 10);
  assert.equal(r.done, 4);
  assert.equal(r.left, 6);
  const s = planRow({ name: 'Sauce', make: 7, done: 2 });
  assert.equal(s.make, 7);
  assert.equal(s.left, 5);
  assert.equal(planRow(null).name, 'Recipe');
});

test('the expand row and the Done words', () => {
  assert.equal(bySiteWords([{ site_name: 'North', qty: 72 }, { site_name: 'South', qty: 36 }, { site_name: 'East', qty: 0 }]), 'North 72 · South 36');
  assert.equal(bySiteWords(null), '');
  assert.equal(qtyUnit(1.5, 'L'), '1.5 L');
  assert.equal(qtyUnit(3, ''), '3');
  assert.equal(fillWords({ make: 0, done: 0 }), 'Nothing to make');
  assert.equal(fillWords({ make: 40, done: 40, unit: 'buns' }), 'Done');
  assert.equal(fillWords({ make: 40, done: 0, unit: 'buns' }), '40 buns to make');
  assert.equal(fillWords({ make: 40, done: 12, unit: 'buns' }), '12 of 40 buns');
  assert.deepEqual(planTotals([{ make: 4, done: 4 }, { make: 2, done: 1 }, { make: 0 }]), { rows: 3, toMake: 2, done: 1 });
});

test('a tick quantity must be above 0; tick words name who and when', () => {
  assert.equal(tickQty('12,5'), 12.5);
  assert.equal(tickQty('0'), null);
  assert.equal(tickQty(''), null);
  assert.equal(tickQty('abc'), null);
  assert.equal(tickWords({ qty: 20, done_by_name: 'Sam', done_at: '2026-10-21T09:40:00Z' }), '20 by Sam at 09:40');
  assert.equal(tickWords({ qty: 5 }), '5');
});

test('packs to base units: the server figure first, else pack times inner', () => {
  assert.equal(perPackBase({ per_pack_base: 2500 }), 2500);
  assert.equal(perPackBase({ pack_qty: 6, inner_qty: 2 }), 12);
  assert.equal(perPackBase({}), 1);
  assert.equal(packsToBase(3, { packQty: 12, innerQty: 1 }), 36);
  assert.equal(packsToBase(-2, { pack_qty: 12 }), 0);
});

test('short lines and the sent figures', () => {
  assert.equal(shortOf(10, 7), 3);
  assert.equal(shortOf(5, 8), 0);
  assert.equal(sentQty(''), null);
  assert.equal(sentQty('0'), 0);
  assert.equal(sentQty('-1'), null);
  const order = { lines: [{ po_line_id: 'l1', name: 'Bun', qty_packs: 6 }, { po_line_id: 'l2', name: 'Loaf', qty_packs: 2 }] };
  assert.deepEqual(sentAsOrdered(order), { l1: 6, l2: 2 });
  assert.deepEqual(shortLines(order, { l1: '4' }), [{ po_line_id: 'l1', name: 'Bun', ordered: 6, sent: 4, short: 2 }]);
});

test('the pick lines: as ordered by default, typed figures win, a batch rides along, bad figures are named', () => {
  const order = { lines: [{ po_line_id: 'l1', name: 'Bun', qty_packs: 6 }, { po_line_id: 'l2', name: 'Loaf', qty_packs: 2 }] };
  assert.deepEqual(pickLines(order), { lines: [{ po_line_id: 'l1', qty_packs_sent: 6 }, { po_line_id: 'l2', qty_packs_sent: 2 }], error: null });
  assert.deepEqual(pickLines(order, { l2: '0' }, { l1: 'b1' }).lines, [{ po_line_id: 'l1', qty_packs_sent: 6, batch_id: 'b1' }, { po_line_id: 'l2', qty_packs_sent: 0 }]);
  assert.match(pickLines(order, { l1: 'x' }).error, /^Bun: type how many packs/);
  assert.match(pickLines(order, { l1: '0', l2: '0' }).error, /Nothing is sent/);
  assert.match(pickLines({ lines: [] }).error, /no lines/);
});

test('lot and use by words', () => {
  assert.equal(lotWords({ lot_code: 'B12', use_by_at: '2026-10-24T23:59:00Z' }), 'Lot B12 · use by 24 Oct');
  assert.equal(lotWords({ lot_code: 'B12' }), 'Lot B12');
  assert.equal(lotWords({ use_by_at: '2026-10-24' }), 'Use by 24 Oct');
  assert.equal(lotWords(), '');
});

test('the delivery note: lines from the order, sent, short, lot and use by from the pick answer', () => {
  const order = { reference: 'PO-9', site_name: 'North', lines: [
    { po_line_id: 'l1', name: 'Bun', qty_packs: 6, pack_label: '12 each', unit_price: 3.5 },
    { po_line_id: 'l2', name: 'Loaf', qty_packs: 2, pack_label: '1 each', unit_price: 2 },
  ] };
  const answer = { reference: 'TR-4', note: { site: 'North', kitchen: 'Central', day: '2026-10-22', lines: [
    { po_line_id: 'l1', sent: 4, lot_code: 'B12', use_by_at: '2026-10-24' },
  ] } };
  const n = deliveryNote(answer, order);
  assert.equal(n.reference, 'TR-4');
  assert.equal(n.kitchen, 'Central');
  assert.equal(n.rows.length, 2);
  assert.deepEqual(n.rows[0], { name: 'Bun', pack: '12 each', ordered: 6, sent: 4, short: 2, lot: 'B12', useBy: '2026-10-24', lotLine: 'Lot B12 · use by 24 Oct', unitPrice: 3.5, allergens: null });
  assert.equal(n.rows[1].sent, 0);
  assert.equal(n.rows[1].short, 2);
  assert.equal(n.shortCount, 2);
  assert.equal(n.value, 14);
  assert.deepEqual(labelsOf(n), [{ name: 'Bun', lot: 'B12', useBy: '2026-10-24', qty: 4, pack: '12 each', site: 'North', allergens: [ALLERGENS_UNKNOWN] }]);
  // a line the database told the allergens of keeps them
  const told = deliveryNote({ note: { lines: [{ name: 'Bun', ordered: 1, sent: 1, allergens: ['gluten', 'milk'] }] } });
  assert.deepEqual(labelsOf(told)[0].allergens, ['gluten', 'milk']);
  assert.equal(ALLERGENS_UNKNOWN, 'check the recipe card');
  // no order passed: the note's own lines
  assert.equal(deliveryNote({ note: { lines: [{ name: 'Sauce', ordered: 2, sent: 2 }] } }, null, { kitchenName: 'K' }).rows[0].short, 0);
});

test('Orders in status words', () => {
  assert.equal(ordersInStatus({ status: 'SENT' }), 'To pick');
  assert.equal(ordersInStatus({ status: 'RECEIVED' }), 'Received');
  assert.equal(ordersInStatus({ transfer_id: 't', transfer_status: 'SENT' }), 'In transit');
  assert.equal(ordersInStatus({ transfer_id: 't', transfer_status: 'DONE' }), 'Received');
  assert.equal(ordersInStatus({ transfer_id: 't', transfer_status: 'DISPUTED' }), 'Disputed');
  assert.equal(ordersInStatus({ transfer_id: 't', transfer_status: 'DRAFT' }), 'Picking');
});

test('Order these: ingredient rows to basket lines at the kitchen, net of VAT where the price holds it', () => {
  const rows = [
    { inventory_item_id: 'i1', name: 'Flour', short_base: 5000, supplier_id: 's1', supplier_product_id: 'p1', packs: 1.2 },
    { inventory_item_id: 'i2', name: 'Butter', short_base: 200, supplier_id: 's2', supplier_product_id: 'p2', packs: 1 },
    { inventory_item_id: 'i3', name: 'Salt', short_base: 10, supplier_id: null, supplier_product_id: null, packs: 0 },
    { inventory_item_id: 'i4', name: 'Sugar', short_base: 0, supplier_id: 's1', supplier_product_id: 'p4', packs: 0 },
  ];
  const packs = {
    p1: { pack_qty: 1, inner_qty: 16000, inner_unit: 'g', pack_price: 12, price_includes_tax: false, purchase_tax_rate_id: null },
    p2: { pack_qty: 10, inner_qty: 250, inner_unit: 'g', pack_price: 24, price_includes_tax: true, purchase_tax_rate_id: 'vat' },
  };
  const { lines, skipped } = ingredientBasket(rows, packs, { vat: 0.2 });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { supplierId: 's1', supplierProductId: 'p1', inventoryItemId: 'i1', description: 'Flour', qtyPacks: 2, packQty: 1, innerQty: 16000, innerUnit: 'g', unitPrice: 12, purchaseTaxRateId: null });
  assert.equal(lines[1].unitPrice, 20);
  assert.deepEqual(skipped, ['Salt']);
  assert.equal(basketWords(lines), '2 orders to 2 suppliers');
  assert.equal(basketWords([lines[0]]), '1 order to 1 supplier');
  assert.equal(basketWords([]), 'Nothing to order');
});

test('recharge months and which rows are sent', () => {
  assert.equal(monthStart('2026-10-22'), '2026-10-01');
  const m = monthChoices('2026-01-15', 3);
  assert.deepEqual(m, [{ value: '2026-01-01', label: 'January 2026' }, { value: '2025-12-01', label: 'December 2025' }, { value: '2025-11-01', label: 'November 2025' }]);
  assert.equal(rechargeState({ from_tenant: 'a', to_tenant: 'b', posted: { xero_invoice_id: 'i', xero_bill_id: 'b' } }), 'sent');
  assert.equal(rechargeState({ from_tenant: 'a', to_tenant: 'b', posted: { xero_invoice_id: 'i' } }), 'part');
  assert.equal(rechargeState({ from_tenant: 'a', to_tenant: null }), 'no_xero');
  assert.equal(rechargeState({ from_tenant: 'a', to_tenant: 'b' }), 'ready');
  const rows = [{ from_tenant: 'a', to_tenant: 'b', amount: 10 }, { from_tenant: 'a', to_tenant: 'b', amount: 0 }, { from_tenant: null, to_tenant: 'b', amount: 5 }];
  assert.equal(rechargeToSend(rows).length, 1);
});
