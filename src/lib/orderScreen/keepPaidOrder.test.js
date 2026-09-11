/**
 * keepPaidOrder.test.js: which paid till orders stay in the queue, and when a refund clears one.
 * Run: `node --test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldKeepPaidOrderInQueue, markQueueEntryPaid, paidQueueRefToClearOnRefund } from './keepPaidOrder.js';

const posEntry = (patch = {}) => ({ ref: 'R1047', status: 'prep', ...patch });

test('setting off, no entry, or a non till source never keeps', () => {
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: false, orderType: 'takeaway', entry: posEntry() }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: undefined, orderType: 'takeaway', entry: posEntry() }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: 'true', orderType: 'takeaway', entry: posEntry() }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'takeaway', entry: null }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'takeaway', entry: undefined }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'takeaway', entry: posEntry({ source: 'kiosk' }) }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'takeaway', entry: posEntry({ source: 'hubrise' }) }), false);
  assert.equal(shouldKeepPaidOrderInQueue(), false);
});

test('collected, scheduled and bar-tab never keep', () => {
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'takeaway', entry: posEntry({ status: 'collected' }) }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'takeaway', entry: posEntry({ status: 'scheduled' }) }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: 'bar-tab', entry: posEntry() }), false);
  assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType: undefined, entry: posEntry() }), false);
});

test('a ready order paid on collection is removed as before, never kept', () => {
  // Pay later flow: staff tap Ready, the customer arrives, staff take payment. The
  // customer leaves with the food, so the row must go and the screen shows Collected.
  for (const orderType of ['dine-in', 'takeaway', 'collection', 'delivery']) {
    assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType, entry: posEntry({ status: 'ready' }) }), false, orderType);
    assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType, entry: posEntry({ status: 'ready', source: 'pos' }) }), false, `${orderType} pos`);
  }
});

test('a till entry in received or prep keeps for every collectable type', () => {
  for (const status of ['received', 'prep']) {
    for (const orderType of ['dine-in', 'takeaway', 'collection', 'delivery']) {
      assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType, entry: posEntry({ status }) }), true, `${status} ${orderType}`);
      assert.equal(shouldKeepPaidOrderInQueue({ enabled: true, orderType, entry: posEntry({ status, source: 'pos' }) }), true, `${status} ${orderType} pos`);
    }
  }
});

test('markQueueEntryPaid sets both flags and does not mutate the input', () => {
  const input = { ref: 'R1', status: 'prep', customer: { name: 'Sam Taylor' } };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = markQueueEntryPaid(input);
  assert.equal(out.paid, true);
  assert.equal(out.customer.paid, true);
  assert.equal(out.customer.name, 'Sam Taylor');
  assert.equal(out.status, 'prep');
  assert.deepEqual(input, snapshot);
  assert.notEqual(out.customer, input.customer);

  const bare = markQueueEntryPaid({ ref: 'R2' });
  assert.deepEqual(bare, { ref: 'R2', paid: true, customer: { paid: true } });
});

test('a full refund clears a kept paid till order; anything else leaves the queue alone', () => {
  const kept = markQueueEntryPaid(posEntry({ ref: 'R1047', status: 'ready' }));
  const queue = [posEntry({ ref: 'R9' }), kept];
  assert.equal(paidQueueRefToClearOnRefund({ queue, ref: 'R1047', checkStatus: 'refunded' }), 'R1047');
  assert.equal(paidQueueRefToClearOnRefund({ queue: [{ ...kept, paid: false }], ref: 'R1047', checkStatus: 'refunded' }), 'R1047', 'customer.paid alone counts');
  // Partial refund: the order is still wanted.
  assert.equal(paidQueueRefToClearOnRefund({ queue, ref: 'R1047', checkStatus: 'partial_refund' }), null);
  // No matching queue entry.
  assert.equal(paidQueueRefToClearOnRefund({ queue, ref: 'R5555', checkStatus: 'refunded' }), null);
  // Unpaid entry (never kept by the setting).
  assert.equal(paidQueueRefToClearOnRefund({ queue, ref: 'R9', checkStatus: 'refunded' }), null);
  // Channel orders are not the till's to clear.
  assert.equal(paidQueueRefToClearOnRefund({ queue: [{ ...kept, source: 'online' }], ref: 'R1047', checkStatus: 'refunded' }), null);
  assert.equal(paidQueueRefToClearOnRefund({ queue, ref: null, checkStatus: 'refunded' }), null);
  assert.equal(paidQueueRefToClearOnRefund({ queue: null, ref: 'R1047', checkStatus: 'refunded' }), null);
  assert.equal(paidQueueRefToClearOnRefund(), null);
});
