/**
 * syncRun.test.js — the accounting sync log (xero_sync_log) as a lock, a progress record and
 * a history (supabase/functions/_shared/syncRun.ts, v5.9.11).
 * Run: `npm test`, or `node --test src/lib/accounting/syncRun.test.js`.
 *
 * Pinned, against a fake table with the real unique index and compare and set semantics:
 *   1. The row is never deleted; every attempt is appended to detail.history.
 *   2. Two runs at once: exactly one claims the day, the other is told it is busy.
 *   3. A lease that ran out (a crashed run) can be taken over; a live one cannot.
 *   4. A run whose lease was taken over cannot write again (it stops posting).
 *   5. A day already 'ok' is reported done, not claimed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimSyncRun, readSyncRow } from '../../../supabase/functions/_shared/syncRun.ts';

// A tiny PostgREST lookalike for one table: eq filters, maybeSingle, insert with the partial
// unique index (location_id, kind, ref_date | ref_id), update ... eq(...) returning rows.
function fakeTable() {
  const rows = [];
  let clock = Date.parse('2026-09-19T10:00:00Z');
  const stamp = () => new Date(clock++).toISOString().replace('Z', '+00:00');
  const match = (r, f) => Object.entries(f).every(([k, v]) => {
    if (k === 'updated_at') return Date.parse(r[k]) === Date.parse(v);
    return r[k] === v;
  });
  const builder = (op, payload) => {
    const f = {};
    const q = {
      eq(k, v) { f[k] = v; return q; },
      select() { q._sel = true; return q; },
      maybeSingle() { q._single = true; return q; },
      then(res, rej) {
        let out;
        if (op === 'select') {
          const hit = rows.filter((r) => match(r, f));
          out = { data: hit.length ? structuredClone(hit[0]) : null, error: null };
        } else if (op === 'insert') {
          const clash = rows.find((r) => r.location_id === payload.location_id && r.kind === payload.kind
            && ((payload.ref_date && r.ref_date === payload.ref_date) || (payload.ref_id && r.ref_id === payload.ref_id)));
          if (clash) out = { data: null, error: { code: '23505', message: 'duplicate key' } };
          else {
            const row = { id: `row-${rows.length + 1}`, status: 'ok', xero_id: null, ...structuredClone(payload), updated_at: stamp() };
            rows.push(row);
            out = { data: [structuredClone(row)], error: null };
          }
        } else if (op === 'update') {
          const hit = rows.filter((r) => match(r, f));
          for (const r of hit) Object.assign(r, structuredClone(payload), { updated_at: stamp() });
          out = { data: hit.map((r) => ({ id: r.id, status: r.status, xero_id: r.xero_id, detail: structuredClone(r.detail), updated_at: r.updated_at })), error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return {
    rows,
    advance: (ms) => { clock += ms; },
    from: () => ({
      select: () => builder('select'),
      insert: (p) => builder('insert', p),
      update: (p) => builder('update', p),
    }),
  };
}

const KEY = { table: 'xero_sync_log', locationId: 'loc-1', kind: 'daily_sales', refDate: '2026-09-18' };

test('two runs at once: one claims the day, the other is busy; the history keeps both outcomes', async () => {
  const sb = fakeTable();
  const [a, b] = await Promise.all([claimSyncRun(sb, KEY, { runId: 'A' }), claimSyncRun(sb, KEY, { runId: 'B' })]);
  assert.equal([a, b].filter((x) => x.run).length, 1, 'exactly one run holds the day');
  assert.equal([a, b].filter((x) => x.busy).length, 1);
  const run = (a.run || b.run);
  await run.setPosting('RECEIVE:CARD', { status: 'sending', reference: 'ServOS takings 2026-09-18 (CARD)' });
  await run.setPosting('RECEIVE:CARD', { status: 'posted', id: 'BT1', reference: 'ServOS takings 2026-09-18 (CARD)' });
  await run.finish('ok', { xero_id: 'BT1', detail: { lines: [1] } }, { ok: true, posted: 1 });
  const row = await readSyncRow(sb, KEY);
  assert.equal(row.status, 'ok');
  assert.equal(row.xero_id, 'BT1');
  assert.equal(row.detail.lock, undefined, 'the lease is released');
  assert.equal(row.detail.postings['RECEIVE:CARD'].id, 'BT1');
  assert.equal(row.detail.history.length, 1);
  assert.equal(sb.rows.length, 1, 'one row, never deleted and re-inserted');
  // A day already posted is done, not claimed again.
  const again = await claimSyncRun(sb, KEY, { runId: 'C' });
  assert.ok(again.done);
  assert.equal(again.run, undefined);
});

test('an error keeps what was already posted; the retry sees it and history grows', async () => {
  const sb = fakeTable();
  const first = (await claimSyncRun(sb, KEY, { runId: 'A' })).run;
  await first.setPosting('RECEIVE:CARD', { status: 'posted', id: 'BT1' });
  await first.setPosting('RECEIVE:CASH', { status: 'sending', reference: 'ServOS takings 2026-09-18 (CASH)' });
  await first.finish('partial', { detail: { error: 'Xero 500' } }, { ok: false, error: 'Xero 500' });
  const retry = (await claimSyncRun(sb, KEY, { runId: 'B' })).run;
  assert.ok(retry, 'a partial day can be claimed again');
  assert.equal(retry.postings['RECEIVE:CARD'].status, 'posted', 'the retry skips what worked');
  assert.equal(retry.postings['RECEIVE:CASH'].status, 'sending', 'and checks Xero for what never answered');
  await retry.finish('ok', {}, { ok: true });
  const row = await readSyncRow(sb, KEY);
  assert.deepEqual(row.detail.history.map((h) => h.status), ['partial', 'ok']);
});

test('a live lease blocks; an expired one (a crashed run) can be taken over, and the old run cannot write', async () => {
  const sb = fakeTable();
  const a = (await claimSyncRun(sb, KEY, { runId: 'A' })).run;
  assert.ok((await claimSyncRun(sb, KEY, { runId: 'B' })).busy, 'live lease: busy');
  sb.advance(6 * 60 * 1000);   // the lease is 5 minutes
  // the fake clock only moves the stamps; move the stored lease into the past too
  sb.rows[0].detail.lock.until = new Date(Date.now() - 1000).toISOString();
  const b = (await claimSyncRun(sb, KEY, { runId: 'B' })).run;
  assert.ok(b, 'expired lease: taken over');
  await assert.rejects(() => a.setPosting('RECEIVE:CARD', { status: 'sending' }), /Another run took over/);
  assert.equal(a.lost, true);
  await b.finish('ok', {}, { ok: true });
});

test('bills are keyed by ref_id the same way', async () => {
  const sb = fakeTable();
  const key = { table: 'xero_sync_log', locationId: 'loc-1', kind: 'bill', refId: 'inv-1' };
  const r = (await claimSyncRun(sb, key, { runId: 'A' })).run;
  await r.finish('error', { detail: { error: 'Xero said no' } }, { ok: false, error: 'Xero said no' });
  const row = await readSyncRow(sb, key);
  assert.equal(row.status, 'error');
  assert.equal(row.detail.error, 'Xero said no');
  assert.equal(row.detail.history.length, 1, 'a failed bill push leaves a record');
  assert.ok((await claimSyncRun(sb, key, { runId: 'B' })).run, 'and can be pushed again');
});
