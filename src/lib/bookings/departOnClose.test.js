import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingIdsToDepart } from './departOnClose.js';

const CLOSED = Date.parse('2026-10-16T20:00:00Z');
const SEATED = CLOSED - 90 * 60 * 1000;

test('the closing session names its booking: that booking departs', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-1' } },
    bookings: [{ id: 'bk-1', status: 'dining', primaryTableId: 'T1', seatedAt: SEATED }],
  });
  assert.deepEqual(ids, ['bk-1']);
});

test('no session here (another device closed it): the dining booking on that table departs', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED, seatedAt: SEATED - 3000 },
    bookings: [
      { id: 'bk-1', status: 'dining', primaryTableId: 'T1', seatedAt: SEATED },
      { id: 'bk-2', status: 'dining', primaryTableId: 'T2', seatedAt: SEATED },
      { id: 'bk-3', status: 'confirmed', primaryTableId: 'T1' },
    ],
  });
  assert.deepEqual(ids, ['bk-1']);
});

test('a member table of a join is not the primary: closing it departs nothing', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T7', closedAt: CLOSED },
    bookings: [{ id: 'bk-1', status: 'dining', primaryTableId: 'T5', tables: ['T5', 'T7'], seatedAt: SEATED }],
  });
  assert.deepEqual(ids, []);
});

test('a split child check never departs the party', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T4-2', closedAt: CLOSED },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-1' } },
    tableIsChild: true,
    bookings: [{ id: 'bk-1', status: 'dining', primaryTableId: 'T4', seatedAt: SEATED }],
  });
  assert.deepEqual(ids, []);
});

test('a party seated AFTER the check closed is a new occupation and stays', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED },
    bookings: [{ id: 'bk-9', status: 'dining', primaryTableId: 'T1', seatedAt: CLOSED + 10 * 60 * 1000 }],
  });
  assert.deepEqual(ids, []);
});

test('already departed, undone or no show: left alone (idempotent)', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-1' } },
    bookings: [{ id: 'bk-1', status: 'departed', primaryTableId: 'T1', seatedAt: SEATED }],
  });
  assert.deepEqual(ids, []);
});

test('a booking not loaded here (another day) still comes back from the session', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-old' } },
    bookings: [],
  });
  assert.deepEqual(ids, ['bk-old']);
});

test('a walk in session with no booking, and no check: nothing', () => {
  assert.deepEqual(bookingIdsToDepart({ check: { tableId: 'T1', closedAt: CLOSED }, session: { seatedAt: SEATED } }), []);
  assert.deepEqual(bookingIdsToDepart({ check: null }), []);
  assert.deepEqual(bookingIdsToDepart(), []);
});

test('session and store name the same booking once', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-1' } },
    bookings: [{ id: 'bk-1', status: 'dining', primaryTableId: 'T1', seatedAt: SEATED + 500 }],
  });
  assert.deepEqual(ids, ['bk-1']);
});

test('a QR pay now round on a dining booked table departs nothing', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T6', closedAt: CLOSED - 30 * 60 * 1000, source: 'qr', seatedAt: null },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-6' } },
    bookings: [{ id: 'bk-6', status: 'dining', primaryTableId: 'T6', seatedAt: SEATED + 2000 }],
  });
  assert.deepEqual(ids, []);
});

test('a void tombstone departs nothing', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED, seatedAt: SEATED, status: 'voided' },
    session: { seatedAt: SEATED, booking: { bookingId: 'bk-1' } },
    bookings: [{ id: 'bk-1', status: 'dining', primaryTableId: 'T1', seatedAt: SEATED + 2000 }],
  });
  assert.deepEqual(ids, []);
});

test('booking moved to T5: the next party\'s check on T1 does not depart it', () => {
  const noon = Date.parse('2026-10-16T12:00:00Z');
  const walkInSeated = Date.parse('2026-10-16T13:30:00Z');
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: Date.parse('2026-10-16T14:30:00Z'), seatedAt: walkInSeated },
    session: { seatedAt: walkInSeated },
    bookings: [{ id: 'bk-moved', status: 'dining', primaryTableId: 'T1', seatedAt: noon + 3000 }],
  });
  assert.deepEqual(ids, []);
});

test('a booking seated 30 s after the close is the next occupation when the check names the earlier one', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED, seatedAt: SEATED },
    bookings: [{ id: 'bk-next', status: 'dining', primaryTableId: 'T1', seatedAt: CLOSED + 30 * 1000 }],
  });
  assert.deepEqual(ids, []);
});

test('another device\'s session for a different occupation is not the closing one', () => {
  const ids = bookingIdsToDepart({
    check: { tableId: 'T1', closedAt: CLOSED, seatedAt: SEATED },
    session: { seatedAt: CLOSED + 5000, booking: { bookingId: 'bk-new' } },
    bookings: [{ id: 'bk-new', status: 'dining', primaryTableId: 'T1', seatedAt: CLOSED + 7000 }],
  });
  assert.deepEqual(ids, []);
});
