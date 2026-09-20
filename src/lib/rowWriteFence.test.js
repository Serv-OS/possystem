// rowWriteFence.test.js: database fence stage 1, fix round 2, the zero row blocker.
//
// Row level security does not refuse an update or a delete of a row it hides: it changes nothing
// and answers success. So every update and delete that must change a row (bar_tabs,
// active_sessions, order_queue, closed_checks, kds_tickets, print_jobs) counts the rows it
// changed, and when none changed asks whether this device is still linked. Not linked: the write
// is kept (parked) and sent again once it is linked. Linked: the row really is gone, done.
// These tests drive lib/rowWriteFence.js with a fake Supabase client, for every table and both
// outcomes. sync/offlineQueueFence.test.js runs the same rules through the real OfflineQueue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MUST_CHANGE_TABLES, PARKED_LINK, OCCUPATION_KEY, MAX_WRITE_ATTEMPTS,
  returningColumns, rowKeyOf, occupationMatch, seatedAtOf, buildWriteQuery, rowsChanged,
  zeroRowDecision, parkedWriteItem, queuedWriteItem, runMustChangeWrite, runMustChangeMany,
  replayMustChangeItem, heldBehindParked, parkedAgain, waitingRowKeys, replayBlocksRow,
  isLateSafeParkedDelete,
} from './rowWriteFence.js';
import { isParkedPermissionItem, releaseParkedItem, isPermissionError } from './deviceFence.js';

// ── A fake PostgREST client: records every call, answers from a script ──────────────────────────

function fakeClient(answers = []) {
  const calls = [];
  const queue = [...answers];
  const client = {
    calls,
    from(table) {
      const q = { table, op: null, payload: undefined, filters: [], select: null };
      calls.push(q);
      const b = {
        update(p) { q.op = 'update'; q.payload = p; return b; },
        delete() { q.op = 'delete'; return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        neq(c, v) { q.filters.push(['neq', c, v]); return b; },
        in(c, v) { q.filters.push(['in', c, v]); return b; },
        select(cols) { q.select = cols; return b; },
        then(res, rej) {
          const next = queue.length ? queue.shift() : { data: [], error: null };
          const out = typeof next === 'function' ? next(q) : next;
          return Promise.resolve(out).then(res, rej);
        },
      };
      return b;
    },
  };
  return client;
}

const ROW_OF = {
  bar_tabs: { id: 'tab-1' },
  active_sessions: { location_id: 'L1', table_id: 'T9' },
  order_queue: { location_id: 'L1', ref: '1042' },
  closed_checks: { id: 'chk-1' },
  kds_tickets: { id: 'kt-1' },
  print_jobs: { id: 'pj-1' },
};
const writeFor = (table, type) => ({
  table, type, match: { ...ROW_OF[table] },
  ...(type === 'update' ? { payload: { status: 'closed' } } : {}),
  kind: 'test', label: `${type} ${table}`,
});

function deps({ client, link = 'bound', epochs = null } = {}) {
  const parked = [];
  const queued = [];
  let afterParkCalls = 0;
  let epochCalls = 0;
  const d = {
    client,
    confirmLink: async () => (typeof link === 'function' ? link() : link),
    linkEpoch: () => (epochs ? epochs[Math.min(epochCalls++, epochs.length - 1)] : 0),
    park: async (item) => { parked.push(item); },
    parkedRowKeys: async () => new Set(),
    queueBehind: async (item) => { queued.push(item); },
    afterPark: () => { afterParkCalls += 1; },
    now: () => 1_000_000,
  };
  return { d, parked, queued, afterPark: () => afterParkCalls };
}

test('the six tables whose update or delete must change a row', () => {
  assert.deepEqual([...MUST_CHANGE_TABLES].sort(), ['active_sessions', 'bar_tabs', 'closed_checks', 'kds_tickets', 'order_queue', 'print_jobs']);
  assert.equal(PARKED_LINK, 'parked_link');
  assert.equal(returningColumns('order_queue'), 'location_id, ref');
  assert.equal(returningColumns('active_sessions'), 'location_id, table_id');
  assert.equal(returningColumns('bar_tabs'), 'id');
  assert.equal(returningColumns('some_other', { ref: 'x' }), 'ref');
});

for (const table of Object.keys(ROW_OF)) {
  for (const type of ['update', 'delete']) {
    test(`${table} ${type}: a row changed is applied, no link check, nothing kept`, async () => {
      const client = fakeClient([{ data: [ROW_OF[table]], error: null }]);
      let asked = 0;
      const { d, parked } = deps({ client, link: () => { asked += 1; return 'bound'; } });
      const r = await runMustChangeWrite(writeFor(table, type), d);
      assert.equal(r.outcome, 'applied');
      assert.equal(r.rows, 1);
      assert.equal(asked, 0, 'no device_status when the write changed its row');
      assert.equal(parked.length, 0);
      assert.equal(client.calls.length, 1);
      assert.equal(client.calls[0].op, type);
      assert.ok(client.calls[0].select, 'the write asks for its rows back, so it can count them');
    });

    test(`${table} ${type}: 0 rows while NOT linked is kept for the link (never counted as sent)`, async () => {
      const client = fakeClient([{ data: [], error: null }]);
      const { d, parked, afterPark } = deps({ client, link: 'unbound' });
      const r = await runMustChangeWrite(writeFor(table, type), d);
      assert.equal(r.outcome, 'parked');
      assert.equal(parked.length, 1);
      const item = parked[0];
      assert.equal(item.status, PARKED_LINK);
      assert.equal(item.table, table);
      assert.equal(item.type, type);
      assert.deepEqual(item.match, ROW_OF[table]);
      assert.equal(item.zeroRows, true);
      assert.equal(item.attempts, 0, 'waiting for the link is not a failure');
      if (type === 'update') assert.deepEqual(item.payload, { status: 'closed' });
      else assert.equal('payload' in item, false);
      assert.equal(afterPark(), 1, 'the banner and the re-link are started');
      // It is released on relink like every parked write (never failed, never dismissed).
      assert.equal(isParkedPermissionItem(item), true);
      assert.equal(isPermissionError(item.lastError), true);
      assert.equal(releaseParkedItem(item).status, 'pending');
    });

    test(`${table} ${type}: 0 rows while linked means the row is gone: done, nothing kept`, async () => {
      const client = fakeClient([{ data: [], error: null }]);
      const { d, parked } = deps({ client, link: 'bound' });
      const r = await runMustChangeWrite(writeFor(table, type), d);
      assert.equal(r.outcome, 'gone');
      assert.equal(parked.length, 0);
      assert.equal(client.calls.length, 1, 'sent once, never twice');
    });
  }
}

test('not a device (Back Office, a customer page) and before file A: today\'s behaviour, done', async () => {
  for (const link of ['not_device', 'unsupported']) {
    const client = fakeClient([{ data: [], error: null }]);
    const { d, parked } = deps({ client, link });
    const r = await runMustChangeWrite(writeFor('order_queue', 'update'), d);
    assert.equal(r.outcome, 'gone', link);
    assert.equal(parked.length, 0, link);
  }
  // No confirmLink at all counts as not a device.
  const client = fakeClient([{ data: [], error: null }]);
  const r = await runMustChangeWrite(writeFor('bar_tabs', 'delete'), { client });
  assert.equal(r.outcome, 'gone');
});

test('the link could not be checked: kept to try again (retry_pending), released on relink too', async () => {
  const client = fakeClient([{ data: [], error: null }]);
  const { d, parked } = deps({ client, link: 'unknown' });
  const r = await runMustChangeWrite(writeFor('closed_checks', 'update'), d);
  assert.equal(r.outcome, 'parked');
  assert.equal(parked[0].status, 'retry_pending');
  assert.equal(parked[0].attempts, 1);
  assert.equal(isParkedPermissionItem(parked[0]), true, 'released on relink like a refused write');
  // A link check that throws is "could not check" too.
  const c2 = fakeClient([{ data: [], error: null }]);
  const { d: d2, parked: p2 } = deps({ client: c2, link: () => { throw new Error('offline'); } });
  assert.equal((await runMustChangeWrite(writeFor('kds_tickets', 'update'), d2)).outcome, 'parked');
  assert.equal(p2[0].status, 'retry_pending');
});

test('a re-link that landed while the write was in flight: sent once more (it changed nothing)', async () => {
  const client = fakeClient([{ data: [], error: null }, { data: [{ id: 'tab-1' }], error: null }]);
  // epoch 0 before the first write, 1 after it (a relink landed), 1 before and after the second.
  const { d, parked } = deps({ client, link: 'bound', epochs: [0, 1, 1, 1] });
  const r = await runMustChangeWrite(writeFor('bar_tabs', 'update'), d);
  assert.equal(r.outcome, 'applied');
  assert.equal(client.calls.length, 2);
  assert.equal(parked.length, 0);
});

test('a re-link that keeps landing: at most MAX_WRITE_ATTEMPTS sends, then kept to try again', async () => {
  const client = fakeClient([{ data: [] }, { data: [] }, { data: [] }, { data: [] }]);
  let e = 0;
  const { d, parked } = deps({ client, link: 'bound' });
  d.linkEpoch = () => (e += 1);   // moves between every read: a relink always seems to have landed
  const r = await runMustChangeWrite(writeFor('print_jobs', 'update'), d);
  assert.equal(client.calls.length, MAX_WRITE_ATTEMPTS);
  assert.equal(r.outcome, 'parked');
  assert.equal(parked[0].status, 'retry_pending');
});

test('a refused write (42501) is judged on the link too: unlinked kept, linked is the caller\'s error', async () => {
  const refusal = { code: '42501', message: 'new row violates row-level security policy for table "bar_tabs"' };
  const c1 = fakeClient([{ data: null, error: refusal }]);
  const { d: d1, parked: p1 } = deps({ client: c1, link: 'unbound' });
  const r1 = await runMustChangeWrite(writeFor('bar_tabs', 'update'), d1);
  assert.equal(r1.outcome, 'parked');
  assert.equal(p1.length, 1);
  const c2 = fakeClient([{ data: null, error: refusal }]);
  const { d: d2, parked: p2 } = deps({ client: c2, link: 'bound' });
  const r2 = await runMustChangeWrite(writeFor('bar_tabs', 'update'), d2);
  assert.equal(r2.outcome, 'error');
  assert.equal(r2.error, refusal);
  assert.equal(p2.length, 0);
  // Any other database error is the caller's, without a link check.
  let asked = 0;
  const c3 = fakeClient([{ data: null, error: { code: '23505', message: 'duplicate' } }]);
  const { d: d3 } = deps({ client: c3, link: () => { asked += 1; return 'bound'; } });
  assert.equal((await runMustChangeWrite(writeFor('order_queue', 'update'), d3)).outcome, 'error');
  assert.equal(asked, 0);
});

test('a write that must not be replayed late is never kept, but the banner still learns', async () => {
  const client = fakeClient([{ data: [] }]);
  let asked = 0;
  const { d, parked } = deps({ client, link: () => { asked += 1; return 'unbound'; } });
  const r = await runMustChangeWrite({ ...writeFor('active_sessions', 'update'), parkable: false }, d);
  assert.equal(r.outcome, 'unlinked');
  assert.equal(parked.length, 0);
  assert.equal(asked, 1);
});

test('a write of a row that has a parked write waits behind it (queued, not sent)', async () => {
  const client = fakeClient([]);
  const { d, parked, queued } = deps({ client, link: 'bound' });
  d.parkedRowKeys = async () => new Set([rowKeyOf({ table: 'kds_tickets', match: { id: 'kt-1' } })]);
  const r = await runMustChangeWrite({ table: 'kds_tickets', type: 'update', payload: { status: 'pending' }, match: { id: 'kt-1' } }, d);
  assert.equal(r.outcome, 'queued');
  assert.equal(client.calls.length, 0, 'nothing sent ahead of the parked write');
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], { type: 'update', table: 'kds_tickets', match: { id: 'kt-1' }, payload: { status: 'pending' } });
  assert.equal(parked.length, 0);
  // Another row is not held up.
  const r2 = await runMustChangeWrite({ table: 'kds_tickets', type: 'update', payload: { status: 'pending' }, match: { id: 'kt-2' } }, { ...d, client: fakeClient([{ data: [{ id: 'kt-2' }] }]) });
  assert.equal(r2.outcome, 'applied');
});

test('an active_sessions delete kept for later carries its occupation, so it never removes a table seated since', async () => {
  assert.equal(OCCUPATION_KEY, 'session->>seatedAt');
  assert.deepEqual(occupationMatch(1726700000000), { 'session->>seatedAt': '1726700000000' });
  assert.deepEqual(occupationMatch(null), {});
  assert.deepEqual(occupationMatch(0), {});
  assert.equal(seatedAtOf(JSON.stringify({ seatedAt: 1726700000000, items: [] })), 1726700000000);
  assert.equal(seatedAtOf('cleared'), null);
  assert.equal(seatedAtOf('{not json'), null);
  assert.equal(seatedAtOf({ seatedAt: 5 }), 5);
  const match = { location_id: 'L1', table_id: 'T9' };
  const replayMatch = { ...match, ...occupationMatch(1726700000000) };
  const client = fakeClient([{ data: [] }]);
  const { d, parked } = deps({ client, link: 'unbound' });
  await runMustChangeWrite({ table: 'active_sessions', type: 'delete', match, replayMatch }, d);
  assert.deepEqual(parked[0].match, replayMatch, 'the parked copy pins the occupation');
  assert.deepEqual(client.calls[0].filters, [['eq', 'location_id', 'L1'], ['eq', 'table_id', 'T9']], 'the live delete is today\'s');
  // Replayed, the occupation is a filter of its own.
  const c2 = fakeClient([{ data: [{ location_id: 'L1', table_id: 'T9' }] }]);
  await replayMustChangeItem(parked[0], { client: c2, confirmLink: async () => 'bound' });
  assert.deepEqual(c2.calls[0].filters, [['eq', 'location_id', 'L1'], ['eq', 'table_id', 'T9'], ['eq', 'session->>seatedAt', '1726700000000']]);
});

test('a bar tab update keeps its guard: never re-opens a closed tab, live or replayed', async () => {
  const client = fakeClient([{ data: [{ id: 'tab-1' }] }]);
  const q = await buildWriteQuery(client, { table: 'bar_tabs', type: 'update', payload: { status: 'closed' }, match: { id: 'tab-1' }, notMatch: { status: 'closed' } });
  assert.deepEqual(client.calls[0].filters, [['eq', 'id', 'tab-1'], ['neq', 'status', 'closed']]);
  assert.equal(client.calls[0].select, 'id');
  assert.equal(rowsChanged(q), 1);
  const item = parkedWriteItem({ table: 'bar_tabs', type: 'update', payload: { status: 'closed' }, match: { id: 'tab-1' }, notMatch: { status: 'closed' } });
  assert.deepEqual(item.notMatch, { status: 'closed' });
  assert.deepEqual(queuedWriteItem({ table: 'bar_tabs', type: 'delete', match: { id: 'tab-1' } }), { type: 'delete', table: 'bar_tabs', match: { id: 'tab-1' } });
});

test('rows changed is read from the answer, never guessed', () => {
  assert.equal(rowsChanged({ data: [], error: null }), 0);
  assert.equal(rowsChanged({ data: [{}, {}], error: null }), 2);
  assert.equal(rowsChanged({ data: { id: 1 }, error: null }), 1);
  assert.equal(rowsChanged({ data: null, count: 0, error: null }), 0);
  assert.equal(rowsChanged({ data: null, error: null }), null, 'no representation: cannot say');
  assert.equal(rowsChanged({ data: null, error: { message: 'x' } }), null);
});

test('the decision table', () => {
  assert.equal(zeroRowDecision({ linkState: 'bound' }), 'done');
  assert.equal(zeroRowDecision({ linkState: 'bound', relinkedSince: true }), 'retry');
  assert.equal(zeroRowDecision({ linkState: 'unbound' }), 'park');
  assert.equal(zeroRowDecision({ linkState: 'unbound', relinkedSince: true }), 'park');
  assert.equal(zeroRowDecision({ linkState: 'unknown' }), 'retry_later');
  assert.equal(zeroRowDecision({ linkState: 'not_device' }), 'done');
  assert.equal(zeroRowDecision({ linkState: 'unsupported' }), 'done');
});

test('many rows by key (a batched delete of tables, the rounds of a QR tab): each key on its own', async () => {
  // T1 deleted, T2 and T3 hidden (not linked): T2 and T3 kept, each with its own occupation.
  const client = fakeClient([{ data: [{ table_id: 'T1' }] }]);
  const { d, parked, afterPark } = deps({ client, link: 'unbound' });
  const seated = { T1: 1, T2: 2, T3: 3 };
  const r = await runMustChangeMany({
    table: 'active_sessions', type: 'delete', match: { location_id: 'L1' }, inColumn: 'table_id',
    keys: ['T1', 'T2', 'T3', 'T2', null], identityFor: (k) => occupationMatch(seated[k]),
  }, d);
  assert.equal(r.outcome, 'parked');
  assert.deepEqual(r.changed, ['T1']);
  assert.deepEqual(r.parked, ['T2', 'T3']);
  assert.deepEqual(parked.map(p => p.match), [
    { location_id: 'L1', table_id: 'T2', 'session->>seatedAt': '2' },
    { location_id: 'L1', table_id: 'T3', 'session->>seatedAt': '3' },
  ]);
  assert.equal(afterPark(), 1);
  assert.deepEqual(client.calls[0].filters, [['eq', 'location_id', 'L1'], ['in', 'table_id', ['T1', 'T2', 'T3']]]);
  assert.equal(client.calls[0].select, 'table_id');
  // Linked: the missing keys are simply gone.
  const c2 = fakeClient([{ data: [{ ref: 'A' }] }]);
  const { d: d2, parked: p2 } = deps({ client: c2, link: 'bound' });
  const r2 = await runMustChangeMany({ table: 'order_queue', type: 'update', payload: { status: 'collected' }, match: { location_id: 'L1' }, inColumn: 'ref', keys: ['A', 'B'] }, d2);
  assert.equal(r2.outcome, 'applied');
  assert.deepEqual(r2.changed, ['A']);
  assert.deepEqual(r2.gone, ['B']);
  assert.equal(p2.length, 0);
});

test('many rows: a relink in flight re-sends only the keys that did not change', async () => {
  const client = fakeClient([{ data: [{ ref: 'A' }] }, { data: [{ ref: 'B' }] }]);
  const { d } = deps({ client, link: 'bound', epochs: [0, 1, 1, 1] });
  const r = await runMustChangeMany({ table: 'order_queue', type: 'update', payload: { status: 'collected' }, match: { location_id: 'L1' }, inColumn: 'ref', keys: ['A', 'B'] }, d);
  assert.deepEqual(r.changed, ['A', 'B']);
  assert.deepEqual(client.calls[1].filters, [['eq', 'location_id', 'L1'], ['in', 'ref', ['B']]]);
});

test('replaying a kept write: applied, gone, kept again, or tried again, never sent twice', async () => {
  const item = parkedWriteItem(writeFor('closed_checks', 'update'));
  const applied = await replayMustChangeItem(item, { client: fakeClient([{ data: [{ id: 'chk-1' }] }]), confirmLink: async () => 'bound' });
  assert.equal(applied.outcome, 'applied');
  const gone = await replayMustChangeItem(item, { client: fakeClient([{ data: [] }]), confirmLink: async () => 'bound' });
  assert.equal(gone.outcome, 'gone');
  const park = await replayMustChangeItem(item, { client: fakeClient([{ data: [] }]), confirmLink: async () => 'unbound', linkEpoch: () => 7 });
  assert.equal(park.outcome, 'park');
  assert.equal(park.epoch, 7, 'the epoch the decision was made at goes back to the queue');
  const later = await replayMustChangeItem(item, { client: fakeClient([{ data: [] }]), confirmLink: async () => 'unknown' });
  assert.equal(later.outcome, 'retry_later');
  const err = await replayMustChangeItem(item, { client: fakeClient([{ data: null, error: { code: '08006', message: 'connection' } }]) });
  assert.equal(err.outcome, 'error');
  const again = parkedAgain(releaseParkedItem(item), { now: 5 });
  assert.equal(again.status, PARKED_LINK);
  assert.equal(again.zeroRows, true);
  assert.equal(again.firstFailedAt, item.firstFailedAt, 'the first failure time is kept');
});

test('queue order: later writes of a row wait behind a parked one; a relinked write still waits', () => {
  const items = [
    { id: 1, type: 'update', table: 'bar_tabs', match: { id: 'tab-1' }, status: PARKED_LINK, zeroRows: true },
    { id: 2, type: 'delete', table: 'bar_tabs', match: { id: 'tab-1' }, status: 'pending' },
    { id: 3, type: 'update', table: 'bar_tabs', match: { id: 'tab-2' }, status: 'pending' },
    { id: 0, type: 'update', table: 'bar_tabs', match: { id: 'tab-1' }, status: 'pending' },   // older than the parked one
  ];
  assert.deepEqual([...heldBehindParked(items)], [2]);
  // New live writes queue behind parked writes AND released 0 row writes not replayed yet.
  const waiting = waitingRowKeys([
    { type: 'update', table: 'kds_tickets', match: { id: 'a' }, status: PARKED_LINK },
    { type: 'update', table: 'kds_tickets', match: { id: 'b' }, status: 'pending', zeroRows: true },
    { type: 'update', table: 'kds_tickets', match: { id: 'c' }, status: 'retry_pending', zeroRows: true },
    { type: 'update', table: 'kds_tickets', match: { id: 'd' }, status: 'pending' },
    { type: 'update', table: 'kds_tickets', match: { id: 'e' }, status: 'failed_stale', zeroRows: true, permanentFailure: true },
  ]);
  assert.deepEqual([...waiting].sort(), ['kds_tickets|a', 'kds_tickets|b', 'kds_tickets|c']);
  assert.equal(replayBlocksRow('done'), false);
  for (const o of ['parked', 'failed', undefined]) assert.equal(replayBlocksRow(o), true);
  assert.equal(rowKeyOf({ table: 'order_queue', match: { location_id: 'L1', ref: '7' } }), 'order_queue|L1|7');
  assert.equal(rowKeyOf({ table: 'order_queue', payload: { location_id: 'L1', ref: '7' } }), 'order_queue|L1|7');
  assert.equal(rowKeyOf({ table: 'order_queue', match: { id: 9 } }), null, 'no key, no ordering');
});

test('a kept delete that can only remove its own row goes whenever the till is linked again, even a day later', () => {
  const tab = { type: 'delete', table: 'bar_tabs', match: { id: 'tab-1726700000000' }, zeroRows: true };
  const table = { type: 'delete', table: 'active_sessions', match: { location_id: 'L1', table_id: 'T9', 'session->>seatedAt': '1726700000000' }, zeroRows: true };
  assert.equal(isLateSafeParkedDelete(tab), true, 'a paid bar tab by its id');
  assert.equal(isLateSafeParkedDelete(table), true, 'a paid table by its occupation');
  assert.equal(isLateSafeParkedDelete({ ...table, match: { location_id: 'L1', table_id: 'T9' } }), false, 'no occupation: it could remove a party seated since');
  assert.equal(isLateSafeParkedDelete({ ...tab, zeroRows: undefined }), false, 'only a write kept for the link');
  assert.equal(isLateSafeParkedDelete({ type: 'delete', table: 'order_queue', match: { location_id: 'L1', ref: '1042' }, zeroRows: true }), false, 'order refs are reused over time');
  assert.equal(isLateSafeParkedDelete({ type: 'update', table: 'bar_tabs', match: { id: 'tab-1' }, zeroRows: true }), false, 'a late update could overwrite a newer change');
  const oq = fs.readFileSync(new URL('../sync/OfflineQueue.js', import.meta.url), 'utf8');
  assert.ok(oq.includes("const ALWAYS_REPLAY = (it) => it.table === 'closed_checks' || it.kind === 'closed_check' || isLateSafeParkedDelete(it);"));
});

test('every update and delete of the six tables in the app counts its rows', () => {
  const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  // The live writers of a row that must change go through lib/rowWrites.js.
  const pins = [
    ['./db.js', "table: 'kds_tickets', type: 'update', payload: { status: 'bumped'"],
    ['./db.js', "table: 'closed_checks', type: 'update', payload: patch,"],
    ['../sync/SessionSync.js', "table: 'active_sessions', type: 'delete', match: { location_id: _locationId },"],
    ['../sync/SessionSync.js', "const r = await mustChangeRow({ table: 'active_sessions', type: 'delete', match, replayMatch,"],
    ['../sync/SessionReconciler.js', "table: 'active_sessions', type: 'delete', match: { location_id: _locationId },"],
    ['../surfaces/kds/KDSSurface.jsx', "mustChangeRow({ table: 'kds_tickets', type: 'update', payload, match: { id }"],
    ['../surfaces/OrdersHub.jsx', "table: 'order_queue', type: 'update', payload: { status: 'collected' },"],
    ['../store/index.js', "mustChangeRow({ table: 'order_queue', type: 'delete', match: { ref, location_id: locId }"],
    ['../store/index.js', "table: 'kds_tickets', type: 'update', payload: { fired_courses: firedCourses, items: updatedItems },"],
    ['../store/index.js', "table: 'print_jobs', type: 'update', payload: { status: 'pending', error: null, attempts: 0 },"],
    ['./printer.js', "table: 'print_jobs', type: 'update', match: { id: jobId }, kind: 'print_job', label: 'Print job printed',"],
    ['../sync/DataSafe.js', "table: 'closed_checks', type: 'update', payload: patch,"],
  ];
  for (const [file, line] of pins) assert.ok(read(file).includes(line), `${file} must keep: ${line}`);
  // QueueSync writes every order_queue and bar_tabs update and delete to the durable queue FIRST
  // (its live write is only a fast path); the queue's replay counts rows (sync/OfflineQueue.js).
  const qs = read('../sync/QueueSync.js');
  assert.ok(qs.includes("queueWrite({ type: 'update', table: 'order_queue', payload: row, match: { location_id: _locationId, ref: o.ref } });"));
  assert.ok(qs.includes("queueWrite({ type: 'delete', table: 'order_queue', match: { location_id: _locationId, ref } });"));
  assert.ok(qs.includes("queueWrite({ type: 'update', table: 'bar_tabs', payload: row, match: { id: t.id }, notMatch: { status: 'closed' } });"));
  assert.ok(qs.includes("queueWrite({ type: 'delete', table: 'bar_tabs', match: { id } });"));
  const oq = read('../sync/OfflineQueue.js');
  assert.ok(oq.includes('const r = await replayMustChangeItem(item, zeroRowDeps(supabase));'));
  assert.ok(!/\.from\((['"])(bar_tabs|active_sessions|closed_checks|kds_tickets)\1\)\s*\.(update|delete)\(/.test(read('../store/index.js')), 'no uncounted store write of these tables');
  assert.ok(!/\.from\('kds_tickets'\)\.update\(/.test(read('../surfaces/kds/KDSSurface.jsx')), 'no uncounted KDS ticket write');
});
