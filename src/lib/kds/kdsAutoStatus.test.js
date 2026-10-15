// The last bump marks the order ready / collected (30 Sep 2026). See kdsAutoStatus.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PRE_READY_STATUSES, autoStatusSettings, allTicketsBumped, autoStatusAfterBump, autoStatusSteps, bumpedWithoutRef } from './kdsAutoStatus.js';

const ON = { ready: true, collected: false };
const BOTH = { ready: true, collected: true };
const bumped = (n) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, status: 'bumped' }));

test('settings: off by default, collected only counts with ready on', () => {
  assert.deepEqual(autoStatusSettings(null), { ready: false, collected: false });
  assert.deepEqual(autoStatusSettings({}), { ready: false, collected: false });
  assert.deepEqual(autoStatusSettings({ kds_auto_ready: true }), { ready: true, collected: false });
  assert.deepEqual(autoStatusSettings({ kds_auto_ready: true, kds_auto_collected: true }), BOTH);
  assert.deepEqual(autoStatusSettings({ kds_auto_collected: true }), { ready: false, collected: false }, 'second switch alone does nothing');
  assert.deepEqual(autoStatusSettings({ kds_auto_ready: 'true' }), { ready: false, collected: false }, 'only a real boolean');
  assert.deepEqual(autoStatusSettings([]), { ready: false, collected: false });
});

test('allTicketsBumped: every row, and at least one', () => {
  assert.equal(allTicketsBumped(bumped(2)), true);
  assert.equal(allTicketsBumped([{ status: 'bumped' }, { status: 'pending' }]), false);
  assert.equal(allTicketsBumped([{ status: 'bumped' }, { status: 'held' }]), false);
  assert.equal(allTicketsBumped([]), false);
  assert.equal(allTicketsBumped(null), false);
  assert.equal(allTicketsBumped(['bumped', 'bumped']), true, 'plain statuses work too');
});

test('fires only when the LAST screen bumps (Peter): a row still pending means none', () => {
  const order = { ref: 'R1', status: 'prep', source: 'kiosk' };
  assert.equal(autoStatusAfterBump({ ticketRows: [{ status: 'bumped' }, { status: 'pending' }], settings: BOTH, order }), 'none');
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(2), settings: BOTH, order }), 'collected');
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: ON, order }), 'ready');
});

test('off by default: nothing fires, whatever the order', () => {
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: autoStatusSettings(null), order: { status: 'prep', source: 'kiosk' } }), 'none');
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: undefined, order: { status: 'prep' } }), 'none');
});

test('an order with no order_queue row (a table send, a bar round) is skipped', () => {
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: BOTH, order: null }), 'none');
});

test('every pre ready status goes to ready; ready, collected, paid, cancelled and scheduled do not', () => {
  for (const st of PRE_READY_STATUSES) {
    assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: ON, order: { status: st } }), 'ready', st);
  }
  assert.deepEqual([...PRE_READY_STATUSES], ['received', 'prep', 'preparing', 'accepted']);
  for (const st of ['collected', 'paid', 'cancelled', 'scheduled', 'awaiting_payment']) {
    assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: BOTH, order: { status: st, source: 'kiosk' } }), 'none', st);
  }
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: ON, order: { status: 'ready' } }), 'none', 'already ready, collected off');
  assert.equal(autoStatusAfterBump({ ticketRows: bumped(1), settings: ON, order: { status: null } }), 'ready', 'no status reads as received');
});

test('collected only for a PAID order: unpaid and payment being checked stop at ready (Orders Hub rule)', () => {
  const rows = bumped(1);
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: 'kiosk' } }), 'collected', 'kiosk is prepaid');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: 'online' } }), 'collected', 'online is prepaid');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: null, paid: true } }), 'collected', 'till order marked paid');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: null, customer: { paid: true } } }), 'collected');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: null } }), 'ready', 'unpaid till order stops at ready');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: 'hubrise', customer: { paid: false } } }), 'ready');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'prep', source: 'online', customer: { payment_state: 'checking' } } }), 'ready', 'never hand over a payment being checked');
  // Staff tapped Ready by hand, then the kitchen bumped the last row: a paid order is handed over.
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'ready', source: 'kiosk' } }), 'collected');
  assert.equal(autoStatusAfterBump({ ticketRows: rows, settings: BOTH, order: { status: 'ready', source: null } }), 'none');
});

test('steps are conditional writes in order, so two screens racing cannot double fire', () => {
  assert.deepEqual(autoStatusSteps('none', 'prep'), []);
  assert.deepEqual(autoStatusSteps('ready', 'prep'), [{ to: 'ready', from: ['received', 'prep', 'preparing', 'accepted'] }]);
  assert.deepEqual(autoStatusSteps('collected', 'prep'), [
    { to: 'ready', from: ['received', 'prep', 'preparing', 'accepted'] },
    { to: 'collected', from: ['ready'] },
  ]);
  // The second step never lists a pre ready status: an order goes through ready first, so the
  // customer's ready message (order_queue_notify) and the order screen's ready mark still fire.
  for (const st of PRE_READY_STATUSES) assert.ok(!autoStatusSteps('collected', 'prep')[1].from.includes(st));
});

test('an order staff already marked ready skips the ready step, so collected really runs', () => {
  // Review 30 Sep 2026: the ready step changed 0 rows, read as gone, and collected never ran.
  assert.deepEqual(autoStatusSteps('collected', 'ready'), [{ to: 'collected', from: ['ready'] }]);
  assert.deepEqual(autoStatusSteps('ready', 'ready'), [{ to: 'ready', from: ['received', 'prep', 'preparing', 'accepted'] }], 'ready alone never targets a ready order (the decision is none there)');
  assert.deepEqual(autoStatusSteps('collected', undefined), [
    { to: 'ready', from: ['received', 'prep', 'preparing', 'accepted'] },
    { to: 'collected', from: ['ready'] },
  ], 'no status reads as pre ready');
});

test('bumpedWithoutRef: a till or kiosk ticket with no ref is worth a warning, a table or bar send is not', () => {
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'till', isTable: false, orderNo: '94' }), true, 'old till build');
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'kiosk', isTable: false, orderNo: '27' }), true);
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'online', isTable: false }), true);
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'till', isTable: false, ref: 'R4894' }), false, 'new build stamps the ref');
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'table', isTable: true }), false, 'table send has no order_queue row');
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'bar', isTable: false }), false, 'bar tab send has no order_queue row');
  assert.equal(bumpedWithoutRef({ v: 1, channel: 'qr', isTable: true }), false, 'QR at a table');
  assert.equal(bumpedWithoutRef(null), false);
  assert.equal(bumpedWithoutRef({ channel: 'till', ref: '   ' }), true, 'blank ref is no ref');
});
