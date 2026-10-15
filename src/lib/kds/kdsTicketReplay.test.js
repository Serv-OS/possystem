// 12 Oct 2026, Barnsley hunt (K7): a till replay can never un bump a kitchen ticket. The rules of
// the queue item, the replay options and the "already there" answer. The behaviour through the
// real lib/db.js and sync/OfflineQueue.js is in src/sync/kdsTicketReplayQueue.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KDS_TICKETS, kitchenTicketQueueItem, replayUpsertOptions, upsertRunKey, isDuplicateTicketError,
} from './kdsTicketReplay.js';

test('the queued kitchen ticket is an insert if missing upsert on id', () => {
  const row = { id: 'kds-1', location_id: 'L1', status: 'pending', items: [{ name: 'Chai Latte' }] };
  const item = kitchenTicketQueueItem(row);
  assert.deepEqual(item, { type: 'upsert', table: 'kds_tickets', payload: row, onConflict: 'id', ignoreDuplicates: true });
  assert.equal(item.payload, row, 'the row is carried as it was sent');
  assert.equal(KDS_TICKETS, 'kds_tickets');
  assert.deepEqual(replayUpsertOptions(item), { onConflict: 'id', ignoreDuplicates: true });
});

test('a kitchen ticket queued by an older build (no flag) is still replayed as insert if missing', () => {
  assert.deepEqual(replayUpsertOptions({ type: 'upsert', table: 'kds_tickets', payload: {}, onConflict: 'id' }), { onConflict: 'id', ignoreDuplicates: true });
  assert.deepEqual(replayUpsertOptions({ type: 'upsert', table: 'kds_tickets', payload: {} }), { onConflict: 'id', ignoreDuplicates: true }, 'no conflict key stored either');
  assert.deepEqual(replayUpsertOptions({ table: 'kds_tickets', ignoreDuplicates: false }), { onConflict: 'id', ignoreDuplicates: true }, 'the table decides, not the flag');
});

test('every other table replays with exactly the options it always had', () => {
  const others = [
    [{ type: 'upsert', table: 'order_queue', payload: {}, onConflict: 'location_id,ref' }, { onConflict: 'location_id,ref' }],
    [{ type: 'upsert', table: 'bar_tabs', payload: {}, onConflict: 'id' }, { onConflict: 'id' }],
    [{ type: 'upsert', table: 'active_sessions', payload: {}, onConflict: 'location_id,table_id' }, { onConflict: 'location_id,table_id' }],
    [{ type: 'upsert', table: 'closed_checks', payload: {} }, { onConflict: 'id' }],
  ];
  for (const [item, want] of others) {
    const got = replayUpsertOptions(item);
    assert.deepEqual(got, want, item.table);
    assert.equal('ignoreDuplicates' in got, false, `${item.table}: no new key in the options`);
  }
  assert.deepEqual(replayUpsertOptions(null), { onConflict: 'id' });
  // A caller may ask for insert if missing on another table by flag; nothing in the app does today.
  assert.deepEqual(replayUpsertOptions({ table: 'print_jobs', ignoreDuplicates: true }), { onConflict: 'id', ignoreDuplicates: true });
});

test('the batch key is the old key for every other table and its own for kitchen tickets', () => {
  const oldKey = (it) => `u|${it.table}|${it.onConflict || 'id'}`;   // sync/OfflineQueue.js before 12 Oct 2026
  for (const it of [
    { table: 'order_queue', onConflict: 'location_id,ref' },
    { table: 'bar_tabs', onConflict: 'id' },
    { table: 'active_sessions', onConflict: 'location_id,table_id' },
    { table: 'closed_checks' },
  ]) assert.equal(upsertRunKey(it), oldKey(it), it.table);
  const kitchen = { table: 'kds_tickets', onConflict: 'id' };
  assert.notEqual(upsertRunKey(kitchen), oldKey(kitchen));
  assert.equal(upsertRunKey(kitchen), 'u|kds_tickets|id|keep');
  assert.equal(upsertRunKey({ table: 'kds_tickets' }), upsertRunKey(kitchenTicketQueueItem({ id: 'x' })), 'old and new kitchen items share one statement');
  assert.notEqual(upsertRunKey(kitchen), upsertRunKey({ table: 'bar_tabs', onConflict: 'id' }), 'a merge and an insert if missing never share a statement');
});

test('"already there" is a duplicate key answer, never a network error', () => {
  assert.equal(isDuplicateTicketError({ code: '23505', message: 'duplicate key value violates unique constraint "kds_tickets_pkey"' }), true);
  assert.equal(isDuplicateTicketError({ code: 23505 }), true);
  assert.equal(isDuplicateTicketError({ message: 'duplicate key value violates unique constraint "kds_tickets_pkey"' }), true, 'by its message when the code is missing');
  assert.equal(isDuplicateTicketError(new Error('Duplicate key value violates unique constraint')), true);
  for (const e of [
    null, undefined, {},
    { message: 'TypeError: Load failed', code: '' },
    { message: 'Failed to fetch' },
    { code: '42501', message: 'new row violates row-level security policy for table "kds_tickets"' },
    { code: 'PGRST204', message: "Could not find the 'meta' column of 'kds_tickets' in the schema cache" },
    { code: '57014', message: 'canceling statement due to statement timeout' },
  ]) assert.equal(isDuplicateTicketError(e), false, JSON.stringify(e));
});
