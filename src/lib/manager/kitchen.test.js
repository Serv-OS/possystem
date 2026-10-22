/** kitchen.test.js — Manager Kitchen below-par + batch status. Run: `node --test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belowPar, bySupplier, batchStatus, groupBatches, roundQty, qtyText, orderPacksFor, orderValue } from './kitchen.js';

const NOW = 1_800_000_000_000;
const min = (n) => NOW - n * 60000;

test('belowPar: below par or 86, 86 first then biggest gap', () => {
  const r = belowPar([
    { itemId: '1', name: 'Buns', onHand: 10, par: 4, supplier: 'A' },   // ok
    { itemId: '2', name: 'Milk', onHand: 1, par: 6, supplier: 'B' },    // gap 5
    { itemId: '3', name: 'Limes', onHand: 0, par: 2, supplier: 'B', eightySixed: true },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].itemId, '3');   // 86 first
  assert.equal(r[1].itemId, '2');
  assert.equal(r[1].shortfall, 5);
});
test('bySupplier groups below-par items', () => {
  const g = bySupplier([
    { itemId: '2', name: 'Milk', onHand: 1, par: 6, supplier: 'B' },
    { itemId: '4', name: 'Beer', onHand: 2, par: 10, supplier: 'C' },
  ]);
  assert.deepEqual(Object.keys(g).sort(), ['B', 'C']);
});
test('batchStatus: done / overdue / due', () => {
  assert.equal(batchStatus({ completedAtMs: min(5), dueAtMs: min(60) }, NOW), 'done');
  assert.equal(batchStatus({ completedAtMs: null, dueAtMs: min(10) }, NOW), 'overdue');
  assert.equal(batchStatus({ completedAtMs: null, dueAtMs: min(-30) }, NOW), 'due');
});
test('groupBatches: counts + notRecorded', () => {
  const g = groupBatches([
    { id: 'a', dueAtMs: min(60), completedAtMs: min(50) },
    { id: 'b', dueAtMs: min(20), completedAtMs: null },
    { id: 'c', dueAtMs: min(-30), completedAtMs: null },
  ], NOW);
  assert.equal(g.counts.done, 1);
  assert.equal(g.counts.overdue, 1);
  assert.equal(g.counts.due, 1);
  assert.equal(g.notRecorded, 2);
});
test('qtyText: whole numbers for counted units, two decimals for weight and volume, unit appended', () => {
  assert.equal(qtyText(70.44800000000001, 'l'), '70.45 l');
  assert.equal(qtyText(39.4, 'kg'), '39.4 kg');
  assert.equal(qtyText(15.04, 'l'), '15.04 l');
  assert.equal(qtyText(1080, 'each'), '1080 each');
  assert.equal(qtyText(2.4, 'each'), '3 each');        // you cannot order 2.4 patties
  assert.equal(qtyText(5, null), '5');
  // no unit known (a snapshot from before the deploy): two decimals, never rounded UP to a whole
  assert.equal(qtyText(70.44800000000001, undefined), '70.45');
  assert.equal(qtyText(39.4, ''), '39.4');
  assert.equal(qtyText('nonsense', 'kg'), '0 kg');
  assert.equal(roundQty(29.552, 'l'), 29.55);
  assert.equal(roundQty(3, 'each'), 3);               // an exact whole stays itself
});
test('belowPar: the shortfall is already rounded for its unit', () => {
  const r = belowPar([{ itemId: 'k', name: 'Keg', onHand: 29.552, par: 100, unit: 'l', supplier: 'A' }]);
  assert.equal(r[0].shortfall, 70.45);
  const w = belowPar([{ itemId: 'b', name: 'Buns', onHand: 10.5, par: 20, unit: 'each', supplier: 'A' }]);
  assert.equal(w[0].shortfall, 10);
});
test('orderPacksFor: the Raise order sheet starts in whole packs, not base units', () => {
  const eggs = { itemId: 'e', name: 'Free Range Eggs', onHand: 148, par: 180, unit: 'each', supplier: 'Hartley',
    pack: { id: 'sp1', packQty: 1, innerQty: 180, innerUnit: 'each', perPack: 180, packPrice: 32.4, vatRate: 0 } };
  const avo = { itemId: 'a', name: 'Avocados', onHand: 9, par: 36, unit: 'each', supplier: 'Hartley',
    pack: { id: 'sp2', packQty: 1, innerQty: 24, innerUnit: 'each', perPack: 24, packPrice: 18, vatRate: 0 } };
  const noPack = { itemId: 'n', name: 'Soup of the day', onHand: 0, par: 10, unit: 'l', supplier: null, pack: null };
  const [a, e, n] = belowPar([eggs, avo, noPack]).sort((x, y) => x.itemId.localeCompare(y.itemId));
  assert.equal(orderPacksFor(e), 1);     // 32 eggs short, a pack of 180
  assert.equal(orderPacksFor(a), 2);     // 27 avocados short, trays of 24
  assert.equal(orderPacksFor(n), 0);     // nothing to order it in
  // v5.11.65: the shortfall is in the item's base unit; a pack in another unit divides by its
  // content in the item unit (perPackBase from manager-snapshot), so 4.5 kg short on a 1 x 2.5 kg
  // pack is 2 packs, not 1800
  const flour = { itemId: 'f', name: 'Flour', onHand: 500, par: 5000, unit: 'g', supplier: 'Mill',
    pack: { id: 'sp3', packQty: 1, innerQty: 2.5, innerUnit: 'kg', perPack: 2.5, perPackBase: 2500, packPrice: 3, vatRate: 0 } };
  assert.equal(orderPacksFor(belowPar([flour])[0]), 2);
  // an older snapshot with no perPackBase still divides by the pack's own figure
  const old = { ...flour, unit: 'kg', onHand: 0.5, par: 5, pack: { ...flour.pack, perPackBase: undefined } };
  assert.equal(orderPacksFor(belowPar([old])[0]), 2);
  assert.equal(orderValue([e, a, n], { e: 1, a: 2, n: 5 }), 68.4);   // 32.40 + 2 x 18.00; no pack adds nothing
  assert.equal(orderValue([], {}), 0);
});

// -- v5.11.96 (multi site stock Drop 3): the phone's order by line, approvals, needNow and the sheets --
import {
  dowWord, dayWord, leftWords, orderByLine, raiseWords, approvalsLine, stockNeedNow, typedBase, receiveLines, pickedLines,
  closeDownLines, shopBuyLines, FORECAST_REASONS, forecastDays,
} from './kitchen.js';

test('Drop 3: days and minutes in words', () => {
  assert.equal(dowWord('2026-10-20'), 'Tue');
  assert.equal(dowWord('2026-10-20T14:00'), 'Tue');
  assert.equal(dowWord('x'), '');
  assert.equal(dayWord('2026-10-22'), 'Thu 22 Oct');
  assert.equal(leftWords(200), '3 h 20 m');
  assert.equal(leftWords(45), '45 m');
  assert.equal(leftWords(-5), '0 m');
});

test('Drop 3: the order by line (4.5), counting down from when the snapshot was made', () => {
  const row = { deliveryDay: '2026-10-21', orderByAt: '2026-10-20T14:00', minutesLeft: 200 };
  assert.equal(orderByLine(row), 'Order by Tue 14:00 (in 3 h 20 m)');
  assert.equal(orderByLine(row, { nowMs: 10 * 60000, generatedMs: 0 }), 'Order by Tue 14:00 (in 3 h 10 m)');
  assert.equal(orderByLine({ ...row, minutesLeft: 0 }), 'Order by Tue 14:00 (passed)');
  assert.equal(orderByLine({ deliveryDay: '2026-10-21', orderByYmd: '2026-10-20', orderByHm: '23:59' }), 'Order by Tue 23:59');
  assert.equal(orderByLine({ deliveryDay: '2026-10-21' }), 'Next delivery Wed 21 Oct');
  assert.equal(orderByLine(null), '');
  assert.equal(orderByLine({ deliveryDay: null }), '');
});

test('Drop 3: the words after a phone order', () => {
  assert.equal(raiseWords({ ok: true, reference: 'MGR-1' }, { supplier: 'Bakers' }), 'Order MGR-1 sent to Bakers.');
  assert.equal(raiseWords({ ok: true, needs_approval: true, approvers: ['Sam', 'Alex'] }), 'Sent for approval. Sam, Alex can approve it. It passes up 60 and 30 minutes before the cut off.');
  assert.equal(raiseWords({ ok: true, needs_approval: true }), 'Sent for approval. Another manager approves it. It passes up 60 and 30 minutes before the cut off.');
  assert.equal(raiseWords({ ok: true, internal: true }), 'The order is with the central kitchen. It arrives as a transfer.');
  assert.equal(raiseWords({ ok: true, reference: 'MGR-2', emailed: false, email_error: 'supplier_has_no_email' }, { supplier: 'Bakers' }), 'Order MGR-2 is on order, but the email to Bakers did not go: supplier_has_no_email. Phone them.');
  assert.equal(raiseWords({ ok: false }), '');
  assert.equal(approvalsLine([{ status: 'waiting' }, { status: 'waiting' }, { status: 'sent_back' }]), '2 orders waiting for approval');
  assert.equal(approvalsLine([]), '');
});

test('Drop 3: the Home needNow rows from the stock bell rows', () => {
  const rows = stockNeedNow([
    { id: 'a1', kind: 'approval_wait', refId: 'purchase-orders:p1' }, { id: 'a2', kind: 'approval_60', refId: 'purchase-orders:p1' },
    { id: 'a3', kind: 'approval_wait', refId: 'purchase-orders:p2' }, { id: 'c1', kind: 'count_due' }, { id: 'c2', kind: 'count_due' },
    { id: 't1', kind: 'transfer_waiting' }, { id: 'd1', kind: 'delivery_overdue' }, { id: 'o1', kind: 'order_by', title: 'Order by in 1 hour: Bakers' },
    { id: 'x1', kind: 'price_rise' },
  ]);
  assert.deepEqual(rows.map((r) => r.words), ['2 orders waiting for approval', 'Count due today', 'Transfer waiting', 'Delivery overdue', 'Order by in 1 hour: Bakers']);
  assert.deepEqual(stockNeedNow(null), []);
});

test('Drop 3: the sheet lines', () => {
  assert.equal(typedBase('1,5'), 1.5);
  assert.equal(typedBase(''), null);
  assert.equal(typedBase('-1'), null);
  assert.deepEqual(receiveLines({ lines: [{ id: 'l1', qtyBase: 10 }, { id: 'l2', qtyBase: 4 }] }, { l2: '3' }), [{ line_id: 'l1', qty_received_base: 10 }, { line_id: 'l2', qty_received_base: 3 }]);
  assert.deepEqual(pickedLines({ i1: '2', i2: '0', i3: 'x' }), [{ inventory_item_id: 'i1', qty_base: 2 }]);
  assert.deepEqual(pickedLines({ c1: '5' }, 'company_item_id'), [{ company_item_id: 'c1', qty_base: 5 }]);
  assert.deepEqual(closeDownLines([{ inventory_item_id: 'i1' }, { inventory_item_id: 'i2' }], { i1: '0.5', i2: '0' }), [{ inventory_item_id: 'i1', qty_base: 0.5 }]);
  assert.deepEqual(shopBuyLines([{ itemId: 'i1', name: 'Milk', qty: '2000', total: '1.80' }]), { lines: [{ inventory_item_id: 'i1', qty_base: 2000, line_total: 1.8 }], error: null, total: 1.8 });
  assert.match(shopBuyLines([{ itemId: 'i1', name: 'Milk', qty: '', total: '1' }]).error, /^Milk: type how much/);
  assert.match(shopBuyLines([{ itemId: 'i1', name: 'Milk', qty: '1', total: '' }]).error, /^Milk: type what it cost/);
  assert.equal(shopBuyLines([]).error, 'Add what you bought.');
});

test('Drop 3: forecast edits need a reason when the figure changes (the database words)', () => {
  assert.deepEqual(FORECAST_REASONS.map((r) => r.value), ['weather', 'local_event', 'booking', 'promotion', 'closure', 'other']);
  const saved = [{ day: '2026-10-22', amount: 1000, reason: null }, { day: '2026-10-23', amount: null }];
  assert.deepEqual(forecastDays(saved, { '2026-10-22': { amount: '1000' } }), { days: [], error: null });
  assert.equal(forecastDays(saved, { '2026-10-22': { amount: '1200' } }).error, 'Pick a reason for Thu 22 Oct.');
  assert.deepEqual(forecastDays(saved, { '2026-10-23': { amount: '900', reason: 'local_event', note: 'Fair' } }), { days: [{ day: '2026-10-23', amount: 900, reason: 'local_event', reason_note: 'Fair' }], error: null });
  assert.equal(forecastDays(saved, { '2026-10-23': { amount: 'x' } }).error, 'Type a figure for Fri 23 Oct.');
});
