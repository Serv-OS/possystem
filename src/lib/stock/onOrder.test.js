/** onOrder.test.js: what the Order pad counts as already on order. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outstandingOnOrder, ON_ORDER_STATUSES } from './onOrder.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const items = {
  milk: { baseUnit: 'l', conversions: [] },
  beans: { baseUnit: 'kg', conversions: [] },
  keg: { baseUnit: 'l', conversions: [] },
};
const line = (itemId, qtyPacks, qtyReceived, packQty, innerQty, innerUnit) => ({ inventoryItemId: itemId, qtyPacks, qtyReceived, packQty, innerQty, innerUnit });

test('only SENT and PARTIAL count; drafts and received orders do not', () => {
  assert.deepEqual(ON_ORDER_STATUSES, ['SENT', 'PARTIAL']);
  const pos = [
    { id: 'd', status: 'DRAFT', expectedDate: '2026-10-16', lines: [line('beans', 4, 0, 6, 1, 'kg')] },
    { id: 's', status: 'SENT', expectedDate: '2026-10-16', lines: [line('milk', 5, 0, 6, 2, 'l')] },
    { id: 'p', status: 'PARTIAL', expectedDate: '2026-10-16', lines: [line('milk', 2, 1, 6, 2, 'l')] },
    { id: 'r', status: 'RECEIVED', expectedDate: '2026-10-14', lines: [line('milk', 9, 9, 6, 2, 'l')] },
  ];
  const { byItem, stale } = outstandingOnOrder(pos, items, { todayYmd: '2026-10-15' });
  near(byItem.milk, 5 * 12 + 1 * 12);     // 6 x 2 l cases: 60 l sent plus 12 l still to come on the partial
  assert.equal(byItem.beans, undefined);  // a draft was never sent
  assert.deepEqual(stale, []);
});

test('a line in another unit is converted to the item base unit', () => {
  const pos = [{ id: 's', status: 'SENT', expectedDate: '2026-10-16', lines: [line('milk', 3, 0, 1, 500, 'ml'), line('beans', 2, 0, 1, 250, 'g')] }];
  const { byItem } = outstandingOnOrder(pos, items, { todayYmd: '2026-10-15' });
  near(byItem.milk, 1.5);
  near(byItem.beans, 0.5);
  // no path between the units (each on a litre item, no bridge): the pack content as written, as before
  const odd = outstandingOnOrder([{ id: 'x', status: 'SENT', expectedDate: '2026-10-16', lines: [line('keg', 68, 0, 1, 1, 'each')] }], items, { todayYmd: '2026-10-15' });
  near(odd.byItem.keg, 68);
});

test('an order long past its date is stale: not counted, and named', () => {
  const pos = [
    { id: 'old', reference: 'PO-1', supplierId: 'sup', status: 'SENT', expectedDate: '2026-07-30', lines: [line('beans', 29, 0, 1, 1, 'kg')] },
    { id: 'nodate', reference: 'MGR-X', supplierId: 'sup', status: 'SENT', expectedDate: null, orderedAt: '2026-08-26T10:00:00Z', lines: [line('beans', 40, 0, 1, 1, 'kg')] },
    { id: 'late', reference: 'PO-2', status: 'SENT', expectedDate: '2026-10-12', lines: [line('beans', 2, 0, 1, 1, 'kg')] },   // 3 days late: still coming
    { id: 'fresh', reference: 'PO-3', status: 'SENT', expectedDate: null, orderedAt: '2026-10-14T10:00:00Z', lines: [line('beans', 1, 0, 1, 1, 'kg')] },
  ];
  const { byItem, stale } = outstandingOnOrder(pos, items, { todayYmd: '2026-10-15', staleDays: 7 });
  assert.deepEqual(stale.map((s) => s.id), ['old', 'nodate']);
  assert.equal(stale[1].due, '2026-09-02');   // ordered date plus a week
  near(byItem.beans, 3);
  // no today given: nothing is stale, everything open counts
  near(outstandingOnOrder(pos, items).byItem.beans, 72);
  assert.deepEqual(outstandingOnOrder(null, items), { byItem: {}, stale: [] });
});
