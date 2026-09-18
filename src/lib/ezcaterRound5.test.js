/**
 * ezcaterRound5.test.js: the fifth review round on "ezCater orders follow the catering rules".
 * Run: `npm test`, or `node --test src/lib/ezcaterRound5.test.js`.
 *
 * Peter, 18 Sep 2026: ezCater orders must "hit the POS at the right times and parameters set to
 * fire into the kitchen as our own catering orders". The bar: the kitchen gets an order exactly
 * once, on time, printed. One section per reviewer item:
 *
 *   1. TILLS NEVER DELETE A CATERING OR ezCater ROW. They are server owned: a till may drop one
 *      from its own memory, never delete it in the database. A rescheduled (moved later) or
 *      cancelled unfired ezCater order survives every till delete path and fires at its new time.
 *   2. NO RE-CREATION. A row that is gone is never written back as a fresh unfired order when the
 *      link says the kitchen had it; a cancelled one comes back cancelled.
 *   3. A HELD ORDER ACCEPTED AFTER ITS FIRE MOMENT IS FLAGGED LATE, in plain words.
 *   4. A RE-ASK NEVER PUSHES A RELEASED, DUE, UNFIRED ORDER'S sent_at LATER.
 *   5. The deploy list and the migration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { writeEzcaterOrder, recheckOrder, recheckUpcoming, recomputePrepForVenue } from '../../supabase/functions/_shared/ezcaterIngest.ts';
import { orderToQueueRow, queuePayload } from '../../supabase/functions/_shared/ezcater-map.ts';
import {
  ezcaterWritePlan, lateFirePlan, lateFireText, ezcaterOrderWarnings, goneOrderPlan, keepDueFireMoment, recreatedText,
} from '../../supabase/functions/_shared/ezcaterCatering.js';
import {
  isServerOwnedQueueRow, tillDeletableOrFilter, keptOutOfLiveQueue, cateringReleaseDecision, CATERING_STALE_FLOOR_MS,
} from './cateringRules.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── An in memory Supabase, with deletes and the .or() forms a till delete uses ──

/** Evaluates the PostgREST .or() forms used on deletes: col.is.null, col.not.in.(a,b), col.eq.v. */
function orMatcher(expr) {
  const parts = [];
  let depth = 0; let cur = '';
  for (const ch of String(expr)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  const tests = parts.map((p) => {
    let m;
    if ((m = p.match(/^([\w]+)\.is\.null$/))) return (r) => r[m[1]] == null;
    if ((m = p.match(/^([\w]+)\.not\.in\.\(([^)]*)\)$/))) { const vs = m[2].split(','); return (r) => r[m[1]] != null && !vs.includes(r[m[1]]); }
    if ((m = p.match(/^([\w]+)\.eq\.(.*)$/))) return (r) => String(r[m[1]]) === m[2];
    throw new Error(`fake or(): form not handled: ${p}`);
  });
  return (r) => tests.some((t) => t(r));
}

function fakeDb(tables, hooks = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const log = [];
  let clock = 0;
  const stamp = () => `2026-09-18T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;
  for (const r of db.order_queue || []) if (!r.updated_at) r.updated_at = stamp();
  const from = (table) => {
    const st = { table, op: 'select', filters: [], eqs: {}, payload: null, single: false, lim: null, returning: false, opts: null, ors: [] };
    const run = async () => {
      const rows = (db[table] = db[table] || []);
      const match = (r) => st.filters.every((f) => f(r));
      let data = null; let error = null;
      if (st.op === 'select') {
        const forced = hooks.selectError ? hooks.selectError(table, st) : null;
        if (forced) return { data: null, error: forced };
        const hit = rows.filter(match);
        data = st.single ? (hit[0] ? { ...hit[0] } : null) : hit.slice(0, st.lim ?? hit.length).map((r) => ({ ...r }));
      } else if (st.op === 'insert') {
        const dup = table === 'order_queue' && rows.some((r) => r.ref === st.payload.ref && r.location_id === st.payload.location_id);
        if (dup) error = { code: '23505', message: 'duplicate key value' };
        else rows.push({ ...st.payload, ...(table === 'order_queue' ? { updated_at: stamp() } : {}) });
      } else if (st.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) { Object.assign(r, JSON.parse(JSON.stringify(st.payload))); if (table === 'order_queue') r.updated_at = stamp(); }
        data = st.returning ? hit.map((r) => ({ ...r })) : null;
      } else if (st.op === 'upsert') {
        const keys = String(st.opts?.onConflict || 'id').split(',');
        const found = rows.find((r) => keys.every((k) => r[k] === st.payload[k]));
        if (found) Object.assign(found, st.payload); else rows.push({ ...st.payload });
      } else if (st.op === 'delete') {
        // .or() is applied ONLY on deletes here (the re-ask reads use json path forms this fake
        // does not need to evaluate; the pure needsRecheck mirrors them).
        const ok = (r) => match(r) && st.ors.every((o) => orMatcher(o)(r));
        const gone = rows.filter(ok);
        db[table] = rows.filter((r) => !ok(r));
        data = gone;
      }
      log.push({ table, op: st.op, payload: st.payload, eqs: { ...st.eqs }, ors: st.ors });
      return { data, error };
    };
    const api = {
      select() { if (st.op === 'select') return api; st.returning = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return api; },
      delete() { st.op = 'delete'; return api; },
      eq(c, v) { st.eqs[c] = v; st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
      not(c, op, v) {
        if (op === 'in') { const vs = String(v).replace(/[()]/g, '').split(','); st.filters.push((r) => !vs.includes(r[c])); }
        if (op === 'is') st.filters.push((r) => r[c] != null);
        return api;
      },
      gte(c, v) { st.filters.push((r) => r[c] >= v); return api; },
      gt(c, v) { st.filters.push((r) => r[c] > v); return api; },
      lte(c, v) { st.filters.push((r) => r[c] <= v); return api; },
      lt(c, v) { st.filters.push((r) => r[c] < v); return api; },
      or(f) { st.ors.push(f); return api; }, order() { return api; }, range() { return api; },
      limit(n) { st.lim = n; return api; },
      maybeSingle() { st.single = true; return run(); },
      single() { st.single = true; return run(); },
      then(ok, bad) { return run().then(ok, bad); },
    };
    return api;
  };
  return { from, db, log };
}

// ── Fixtures (HKX77V, the live test order) ───────────────────────────────────

const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
const LONDON = { timeZone: 'Europe/London', prepMinutes: 90, prepFallback: false };
const money = (subunits) => ({ subunitsV2: String(subunits), currency: 'USD' });
const UUID = 'eff5588f-1013-40f7-ae24-77febe448deb';
const REF = `EZ-${UUID}`;

const ezOrder = (over = {}) => ({
  uuid: UUID,
  orderNumber: 'HKX77V',
  orderSourceType: 'MARKETPLACE',
  lifecycle: { orderIsCurrently: 'accepted' },
  caterer: { uuid: 'cat-pos-testing', name: 'POS Testing', storeNumber: null },
  event: {
    timestamp: '2026-09-23T18:30:00Z', catererHandoffFoodTime: null,
    timeZoneIdentifier: 'America/New_York', timeZoneOffset: '-04:00', orderType: 'DELIVERY', headcount: 4,
    contact: { name: 'Peter Test', phone: '5555550100' },
    address: { street: '1 Test St', city: 'Boston', state: 'MA', zip: '02116' },
  },
  orderCustomer: { fullName: 'Peter Test' },
  catererCart: {
    totals: { catererTotalDue: 41.31 },
    orderItems: [{ uuid: 'oi-1', name: 'Sandwich Tray', quantity: 1, totalInSubunits: money(3600), customizations: [] }],
    feesAndDiscounts: [], deliveryFees: [],
  },
  totals: { subTotal: money(3600), salesTax: money(0), salesTaxRemittance: money(0), tip: money(0) },
  ...over,
});
const lifecycle = (v, over = {}) => ezOrder({ lifecycle: { orderIsCurrently: v }, ...over });
/** The same order with ezCater's event moved to `ts` (ready 18:30Z fires 17:00Z on 90 minutes). */
const movedTo = (ts, base = ezOrder()) => ({ ...base, event: { ...base.event, timestamp: ts } });

const LINK = (over = {}) => ({ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 1, event_at: '2026-09-18T16:00:00Z', ...over });
const tables = (queueRows = [], extra = {}) => ({
  order_queue: queueRows,
  ezcater_order_links: [LINK()],
  ezcater_caterers: [{ caterer_uuid: 'cat-pos-testing', location_id: PROVO, connection_id: 'conn-1', active: true }],
  ezcater_connections: [{ id: 'conn-1', api_token: 'tok', api_url: null, status: 'connected', connected_at: '2026-09-17T00:00:00Z' }],
  catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 90 }],
  locations: [{ id: PROVO, timezone: 'Europe/London' }],
  ...extra,
});

/** A row as the webhook writes an order (accepted: fires 17:00Z). */
const queueRow = (over = {}, order = ezOrder()) => {
  const { row } = orderToQueueRow(order, PROVO, { venue: LONDON, priorAcceptedCount: 0 });
  const p = queuePayload(row, true, '2026-09-18T16:00:00.000Z');
  return { ...p, kitchen_routed_at: null, ...over };
};
const answers = (order) => () => async () => order;

/** Every way a till deletes an order_queue row, as the app code builds the statement. */
const TILL_DELETES = {
  // src/sync/QueueSync.js flushQueues: the batch delete.
  flush: (sb) => sb.from('order_queue').delete().eq('location_id', PROVO).in('ref', [REF]).or(tillDeletableOrFilter()),
  // src/store/index.js removeFromQueue (a ref this till never saw the source of).
  removeFromQueue: (sb) => sb.from('order_queue').delete().eq('ref', REF).eq('location_id', PROVO).or(tillDeletableOrFilter()),
  // src/sync/OfflineQueue.js replayItem: a buffered delete, maybe from older code.
  offlineReplay: (sb) => sb.from('order_queue').delete().eq('location_id', PROVO).eq('ref', REF).or(tillDeletableOrFilter()),
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. TILLS NEVER DELETE A SERVER OWNED ROW
// ═════════════════════════════════════════════════════════════════════════════

test('1: catering and ezCater rows are server owned; the delete filter keeps them out of every till delete', () => {
  assert.equal(isServerOwnedQueueRow({ source: 'ezcater' }), true);
  assert.equal(isServerOwnedQueueRow({ source: 'catering' }), true);
  assert.equal(isServerOwnedQueueRow({ source: 'EZCATER' }), true);
  assert.equal(isServerOwnedQueueRow({ source: 'pos' }), false);
  assert.equal(isServerOwnedQueueRow({ source: null }), false);
  assert.equal(isServerOwnedQueueRow(null), false);
  assert.equal(tillDeletableOrFilter(), 'source.is.null,source.not.in.(catering,ezcater)');
  const ok = orMatcher(tillDeletableOrFilter());
  assert.equal(ok({ source: 'pos' }), true);
  assert.equal(ok({ source: null }), true, 'a row with no source is still deletable (NULL never matches not.in)');
  assert.equal(ok({ source: 'kiosk' }), true);
  assert.equal(ok({ source: 'ezcater' }), false);
  assert.equal(ok({ source: 'catering' }), false);
});

test('1: an ezCater order MOVED LATER survives every till delete path and fires at its new time', async () => {
  const sb = fakeDb(tables([queueRow()]));
  // 16:00Z: ezCater moved the event from 18:30Z to 20:30Z, so the fire moment moves 17:00Z to 19:00Z.
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T16:00:00.000Z', fetchFor: answers(movedTo('2026-09-23T20:30:00Z')) });
  assert.equal(r.outcome, 'checked');
  const row = sb.db.order_queue[0];
  assert.equal(row.sent_at, '2026-09-23T19:00:00.000Z');
  // Every till now drops it from memory (a future catering order stays out of the live queue)...
  assert.equal(keptOutOfLiveQueue(row, Date.parse('2026-09-23T16:00:01Z')), true);
  // ...and whatever delete a till sends, the row stays.
  for (const [name, del] of Object.entries(TILL_DELETES)) {
    await del(sb);
    assert.equal(sb.db.order_queue.length, 1, `${name} must not delete the ezCater row`);
  }
  // At its NEW time the release fires it, exactly once.
  const at = sb.db.order_queue[0];
  assert.equal(cateringReleaseDecision(at, Date.parse('2026-09-23T18:59:00Z'), CATERING_STALE_FLOOR_MS), 'future');
  assert.equal(cateringReleaseDecision(at, Date.parse('2026-09-23T19:00:30Z'), CATERING_STALE_FLOOR_MS), 'fire');
  assert.equal(keptOutOfLiveQueue(at, Date.parse('2026-09-23T19:00:30Z')), false, 'it comes back into the live queue at its fire moment');
});

test('1: a cancelled, unfired ezCater order and a ServOS catering order are never deleted by a till either', async () => {
  const sb = fakeDb(tables([
    queueRow({ status: 'cancelled' }),
    { ref: 'CAT-1', location_id: PROVO, source: 'catering', status: 'received', sent_at: '2026-09-25T10:00:00.000Z', kitchen_routed_at: null },
    { ref: 'POS-1', location_id: PROVO, source: 'pos', status: 'collected', sent_at: null },
  ]));
  assert.equal(keptOutOfLiveQueue(sb.db.order_queue[0], Date.now()), true, 'cancelled before firing: held out of every till');
  for (const del of Object.values(TILL_DELETES)) await del(sb);
  await sb.from('order_queue').delete().eq('location_id', PROVO).in('ref', ['CAT-1', 'POS-1']).or(tillDeletableOrFilter());
  assert.deepEqual(sb.db.order_queue.map((r) => r.ref).sort(), ['CAT-1', REF].sort(), 'only the till order is deleted');
});

test('1: every till delete path in the app skips server owned rows (source shape)', () => {
  const qs = read('../sync/QueueSync.js');
  // The flush: a server owned ref is dropped from memory only, never sent as a delete.
  const loop = qs.slice(qs.indexOf('for (const ref of Object.keys(_lastSentQueue))'), qs.indexOf('const activeTabIds'));
  assert.ok(loop.indexOf('_serverOwnedQueue.has(String(ref))') !== -1 && loop.indexOf('_serverOwnedQueue.has(String(ref))') < loop.indexOf("type: 'delete'"), 'the flush skips server owned refs before queueing a delete');
  assert.ok(qs.includes(".in('ref', queueDeletes).or(tillDeletableOrFilter())"), 'the batch delete statement carries the filter');
  // Collected: a server owned row is written as collected, not skipped then deleted.
  assert.ok(qs.includes("if (o.status === 'collected' && !isServerOwnedQueueRow(o)) continue;"));
  // Realtime eviction remembers the row as server owned BEFORE it is evicted from memory.
  const rt = qs.slice(qs.indexOf('export function applyQueueRealtimeEvent'), qs.indexOf('export function applyTabRealtimeEvent'));
  assert.ok(rt.indexOf('noteServerOwned(row)') !== -1 && rt.indexOf('noteServerOwned(row)') < rt.indexOf('if (_isFutureCatering(row))'));
  // Rows adopted at boot or by the reconciler are remembered too (latchQueueRows).
  assert.match(qs, /export function latchQueueRows\(rows\) \{ for \(const o of rows \|\| \[\]\) \{ noteServerOwned\(o\);/);
  // removeFromQueue: local only for a server owned row; its delete carries the filter.
  const st = read('../store/index.js');
  const rq = st.slice(st.indexOf('  removeFromQueue: ref => {'), st.indexOf('  // ── 86'));
  assert.ok(rq.includes('if (isServerOwnedQueueRow(gone)) return;'));
  assert.ok(rq.indexOf('if (isServerOwnedQueueRow(gone)) return;') < rq.indexOf('.delete()'));
  assert.ok(rq.includes(".eq('location_id', locId).or(tillDeletableOrFilter())"));
  // The offline replay: every buffered order_queue delete carries the filter.
  const oq = read('../sync/OfflineQueue.js');
  assert.ok(oq.includes("if (item.table === 'order_queue') q = q.or(tillDeletableOrFilter());"));
  // No other order_queue delete anywhere in the app.
  const walk = (dir) => fs.readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}${d.name}${d.isDirectory() ? '/' : ''}`;
    if (d.isDirectory()) return walk(rel);
    return /\.(js|jsx)$/.test(d.name) && !d.name.includes('.test.') ? [rel] : [];
  });
  const offenders = [];
  for (const rel of walk('../')) {
    const src = read(rel);
    for (const m of src.matchAll(/from\('order_queue'\)\s*\.delete\(\)[^;]*/g)) {
      if (!m[0].includes('tillDeletableOrFilter()')) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], 'every order_queue delete in src carries tillDeletableOrFilter');
});

test('1: the reconciler rules still hold: no union, drop only through markQueueDropped, no new delete path', () => {
  const qs = read('../sync/QueueSync.js');
  assert.ok(qs.includes('reconcileList('), 'boot still reconciles through reconcileList');
  assert.ok(qs.includes('r.dropped.forEach(markQueueDropped);'));
  // The reconciler itself never deletes a queue row: a drop is local, the latch records it.
  const rec = read('../sync/QueueReconciler.js');
  assert.equal(/from\('order_queue'\)\s*\.delete/.test(rec), false);
});

test('1: the database refuses a till delete of a server owned row (migration, for tills on older code)', () => {
  const sql = read('../../supabase/migrations/20260918d_OPS_ezcater_server_owned_rows.sql');
  assert.match(sql, /before delete on public\.order_queue/);
  assert.match(sql, /old\.source in \('catering', 'ezcater'\) and v_role in \('anon', 'authenticated'\)/);
  assert.match(sql, /return null;/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. NO RE-CREATION
// ═════════════════════════════════════════════════════════════════════════════

test('2: goneOrderPlan reads the link that survives the delete', () => {
  assert.deepEqual(goneOrderPlan(null), { mode: 'new' });
  assert.equal(goneOrderPlan(LINK({ kitchen_fired_at: '2026-09-23T17:00:00Z', queue_status: 'collected' })).mode, 'skip');
  assert.equal(goneOrderPlan(LINK({ kitchen_fired_at: '2026-09-23T17:00:00Z', queue_status: 'prep' })).mode, 'skip', 'fired, deleted mid kitchen');
  assert.equal(goneOrderPlan(LINK({ kitchen_fired_at: null, queue_status: 'collected' })).mode, 'skip', 'staff finished it');
  assert.equal(goneOrderPlan(LINK({ kitchen_fired_at: null, queue_status: 'cancelled' })).mode, 'cancelled');
  assert.equal(goneOrderPlan(LINK({ kitchen_fired_at: '2026-09-23T17:00:00Z', queue_status: 'cancelled' })).mode, 'skip', 'fired then cancelled');
  assert.equal(goneOrderPlan(LINK({ kitchen_fired_at: null, queue_status: 'received' })).mode, 'unfired');
  assert.equal(goneOrderPlan(LINK()).mode, 'unknown', 'a link from before 20260918d cannot say');
});

test('2: a FIRED and collected order whose row is gone is not written again: no second kitchen ticket', async () => {
  const sb = fakeDb(tables([], { ezcater_order_links: [LINK({ kitchen_fired_at: '2026-09-23T17:00:00Z', queue_status: 'collected', queue_gone_at: '2026-09-23T19:00:00Z' })] }));
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T20:00:00.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(w.gone, 'skip');
  assert.equal(w.isNew, false, 'no replacement check for it either');
  assert.equal(sb.db.order_queue.length, 0, 'nothing inserted');
  assert.equal(sb.db.ezcater_order_links[0].kitchen_fired_at, '2026-09-23T17:00:00Z', 'the link keeps what the kitchen had');
});

test('2: a fired order skipped only once the row is PROVED gone; a failed read retries, never skips', async () => {
  let fail = true;
  const sb = fakeDb(tables([], { ezcater_order_links: [LINK({ kitchen_fired_at: '2026-09-23T17:00:00Z', queue_status: 'prep' })] }),
    { selectError: (t, st) => (t === 'order_queue' && fail ? { code: '57014', message: 'timeout' } : null) });
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T20:00:00.000Z', match: false });
  assert.equal(w.ok, false, 'a read that failed is not "gone": the webhook retries');
  fail = false;
});

test('2: a cancelled unfired order whose row is gone comes back CANCELLED, never live', async () => {
  const sb = fakeDb(tables([], { ezcater_order_links: [LINK({ kitchen_fired_at: null, queue_status: 'cancelled', queue_gone_at: '2026-09-22T10:00:00Z' })] }));
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T16:00:00.000Z', match: false });
  assert.equal(w.ok, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.status, 'cancelled');
  assert.equal(cateringReleaseDecision(row, Date.parse('2026-09-23T17:01:00Z'), CATERING_STALE_FLOOR_MS), 'cancelled', 'never fired');
  assert.equal(keptOutOfLiveQueue(row, Date.parse('2026-09-23T17:01:00Z')), true);
  assert.equal(row.customer.recreatedAfterDelete.was, 'cancelled');
  assert.match(recreatedText(row.customer.recreatedAfterDelete), /put back as cancelled and NOT sent to the kitchen/);
});

test('2: a link from before the migration: written back for staff, marked as sent, never printed again', async () => {
  const sb = fakeDb(tables([]));   // LINK() has no kitchen_fired_at column: pre 20260918d
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T16:00:00.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(w.gone, 'unknown');
  const row = sb.db.order_queue[0];
  assert.ok(row.kitchen_routed_at, 'claimed: no release can print it again');
  assert.equal(cateringReleaseDecision(row, Date.parse('2026-09-23T17:01:00Z'), CATERING_STALE_FLOOR_MS), 'fired');
  assert.match(ezcaterOrderWarnings(row).join(' '), /cannot tell whether the kitchen already made it, so it was NOT sent to the kitchen again/);
  // A later notification plans against the row as FIRED: nothing moves, a change is flagged.
  const w2 = await writeEzcaterOrder(sb, { order: movedTo('2026-09-23T17:30:00Z'), locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T16:05:00.000Z', match: false });
  assert.equal(w2.plan.fired, true);
  assert.equal(sb.db.order_queue.length, 1);
  assert.equal(sb.db.order_queue[0].sent_at, row.sent_at, 'a fired order is never re-timed');
});

test('2: an unfired order a till deleted (the link says the kitchen never had it) comes back unfired, once', async () => {
  const sb = fakeDb(tables([], { ezcater_order_links: [LINK({ kitchen_fired_at: null, queue_status: 'received', queue_gone_at: '2026-09-23T15:00:00Z' })] }));
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T16:00:00.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(w.gone, 'unfired');
  const row = sb.db.order_queue[0];
  assert.equal(row.kitchen_routed_at ?? null, null);
  assert.equal(row.sent_at, '2026-09-23T17:00:00.000Z');
  assert.equal(cateringReleaseDecision(row, Date.parse('2026-09-23T17:00:30Z'), CATERING_STALE_FLOOR_MS), 'fire');
});

test('2: a genuinely new order (no link) is written exactly as before', async () => {
  const sb = fakeDb(tables([], { ezcater_order_links: [] }));
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, nowIso: '2026-09-20T09:00:00.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(w.isNew, true);
  assert.equal(w.gone, undefined);
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z');
  assert.equal(sb.db.order_queue[0].customer.recreatedAfterDelete, undefined);
});

test('2: the migration keeps what the kitchen had on the link, through a delete', () => {
  const sql = read('../../supabase/migrations/20260918d_OPS_ezcater_server_owned_rows.sql');
  for (const col of ['kitchen_fired_at', 'queue_status', 'queue_gone_at']) assert.ok(sql.includes(`add column if not exists ${col}`), col);
  assert.match(sql, /after insert or update or delete on public\.order_queue/);
  assert.match(sql, /kitchen_fired_at = coalesce\(kitchen_fired_at, old\.kitchen_routed_at\)/);
  assert.match(sql, /kitchen_fired_at = coalesce\(kitchen_fired_at, new\.kitchen_routed_at\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. LATE ACCEPTANCE IS FLAGGED
// ═════════════════════════════════════════════════════════════════════════════

test('3: a held order accepted 40 minutes after its fire moment fires now and is flagged late, in plain words', async () => {
  const links = { ezcater_order_links: [LINK({ accepted_count: 0 })] };
  const sb = fakeDb(tables([queueRow({}, lifecycle('submitted'))], links));
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z', 'held at its real fire moment');
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:40:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.outcome, 'checked');
  assert.equal(r.late, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.sent_at, '2026-09-23T17:40:00.000Z', 'fires now (round 4 rule, unchanged)');
  assert.equal(row.customer.lateFire.reason, 'accepted_late');
  assert.equal(row.customer.lateFire.minutesLate, 40);
  assert.match(ezcaterOrderWarnings(row).join(' '), /accepted on ezCater 40 minutes after it was due in the kitchen/);
  // Reported once: the next re-ask is not a new late, and the flag stays.
  const again = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:42:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(again.late, false);
  assert.equal(sb.db.order_queue[0].customer.lateFire.at, '2026-09-23T17:40:00.000Z');
});

test('3: accepted in time is not late; a routine re-ask is not late; a new order is not late', () => {
  const { row: held } = orderToQueueRow(lifecycle('submitted'), PROVO, { venue: LONDON });
  const existing = { ...queuePayload(held, true, '2026-09-18T16:00:00.000Z'), kitchen_routed_at: null };
  const { row: acc } = orderToQueueRow(ezOrder(), PROVO, { venue: LONDON });
  assert.equal(ezcaterWritePlan({ row: acc, existing, terminal: false, nowIso: '2026-09-23T16:30:00.000Z' }).late, false, 'accepted before its fire moment');
  const released = { ...queuePayload(acc, true, '2026-09-18T16:00:00.000Z'), kitchen_routed_at: null };
  assert.equal(ezcaterWritePlan({ row: acc, existing: released, terminal: false, nowIso: '2026-09-23T17:40:00.000Z' }).late, false, 'already released: not late');
  assert.equal(ezcaterWritePlan({ row: acc, existing: null, terminal: false, nowIso: '2026-09-23T17:40:00.000Z' }).late, false, 'a new order is never late');
  // The words.
  const l = lateFirePlan({ fireAt: '2026-09-23T17:00:00.000Z', prevFireAt: '2026-09-23T17:00:00.000Z', nowIso: '2026-09-23T17:02:00.000Z', acceptedLate: true });
  assert.equal(l.minutesLate, 2);
  assert.match(lateFireText(l), /accepted on ezCater 2 minutes after it was due in the kitchen/);
  assert.equal(lateFirePlan({ fireAt: '2026-09-23T17:00:00.000Z', prevFireAt: '2026-09-23T17:00:00.000Z', nowIso: '2026-09-23T17:00:30.000Z', acceptedLate: true }), null, 'under a minute is on time');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. A RE-ASK NEVER PUSHES A DUE ORDER BACK
// ═════════════════════════════════════════════════════════════════════════════

test('4: keepDueFireMoment keeps a due sent_at, moves a later plan, leaves stale and future rows alone', () => {
  const now = Date.parse('2026-09-23T17:04:00Z');
  const nowIso = new Date(now).toISOString();
  assert.equal(keepDueFireMoment('2026-09-23T17:00:00.000Z', nowIso, now), '2026-09-23T17:00:00.000Z', 'due and still due: kept');
  assert.equal(keepDueFireMoment('2026-09-23T17:00:00.000Z', '2026-09-23T19:00:00.000Z', now), '2026-09-23T19:00:00.000Z', 'moved later, still ahead: moves');
  assert.equal(keepDueFireMoment('2026-09-23T18:00:00.000Z', nowIso, now), nowIso, 'not due before: the plan stands');
  assert.equal(keepDueFireMoment('2026-09-23T14:00:00.000Z', nowIso, now), nowIso, 'older than the stale floor: unchanged rule');
  assert.equal(keepDueFireMoment(null, nowIso, now), nowIso);
  // The file's own floor is the tills' and the cron's floor.
  const src = read('../../supabase/functions/_shared/ezcaterCatering.js');
  assert.ok(src.includes('const STALE_FLOOR_MS = 2 * 60 * 60 * 1000;'));
  assert.equal(CATERING_STALE_FLOOR_MS, 2 * 60 * 60 * 1000);
});

test('4: the cron re-ask of a released, due, unfired order keeps its sent_at, so the SAME run\'s backstop fires it', async () => {
  const sb = fakeDb(tables([queueRow()]));
  const nowIso = '2026-09-23T17:04:00.000Z';
  const res = await recheckUpcoming(sb, null, { nowIso, fetchFor: answers(ezOrder()) });
  assert.equal(res.length, 1);
  assert.equal(res[0].outcome, 'checked');
  const row = sb.db.order_queue[0];
  assert.equal(row.customer.ezcaterRecheck.at, nowIso, 'it was re-asked');
  assert.equal(row.sent_at, '2026-09-23T17:00:00.000Z', 'not pushed back to now');
  // catering-release's backstop, run right after: sent_at <= now minus the 3 minute grace.
  const cutoff = new Date(Date.parse(nowIso) - 3 * 60_000).toISOString();
  assert.ok(row.sent_at <= cutoff, 'the backstop picks it up in the same run');
  assert.equal(cateringReleaseDecision(row, Date.parse(nowIso), CATERING_STALE_FLOOR_MS), 'fire');
  // And the cron runs the re-asks before the backstop, with the backstop query unchanged.
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.ok(cron.indexOf('recheckUpcoming(') < cron.indexOf('GRACE_MIN * 60_000'));
});

test('4: a due order ezCater moved LATER still moves later (the catering rule), and a moved earlier one is not pushed back', async () => {
  const sb = fakeDb(tables([queueRow()]));
  await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:02:00.000Z', fetchFor: answers(movedTo('2026-09-23T20:30:00Z')) });
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T19:00:00.000Z');
  const sb2 = fakeDb(tables([queueRow()]));
  await recheckOrder(sb2, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:02:00.000Z', fetchFor: answers(movedTo('2026-09-23T18:00:00Z')) });
  assert.equal(sb2.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z', 'already due: kept, not rewritten to now');
});

test('4: a staff prep change never pushes a released, due order back either', async () => {
  const sb = fakeDb(tables([queueRow()], { catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 120 }] }));
  const venue = { ...LONDON, prepMinutes: 120, prepReadOk: true, tzReadOk: true };
  const out = await recomputePrepForVenue(sb, null, { locationId: PROVO, nowIso: '2026-09-23T17:02:00.000Z', venue });
  assert.equal(out.retimed, 1);
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE DEPLOY LIST AND THE FILES
// ═════════════════════════════════════════════════════════════════════════════

test('5: every function that imports a round 5 _shared file is on the deploy list', () => {
  const changedShared = ['ezcaterIngest.ts', 'ezcaterCatering.js', 'cateringRules.js'];
  const deployList = ['catering-release', 'ezcater-connect', 'ezcater-webhook', 'order-notify', 'review-request', 'uber-direct'];
  const root = new URL('../../supabase/functions/', import.meta.url);
  const sharedDeps = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    let src = '';
    try { src = fs.readFileSync(new URL(`_shared/${file}`, root), 'utf8'); } catch { return seen; }
    for (const m of src.matchAll(/from '\.\/([^']+)'/g)) sharedDeps(m[1], seen);
    return seen;
  };
  const needs = [];
  for (const dir of fs.readdirSync(root)) {
    if (dir.startsWith('_')) continue;
    let src = '';
    try { src = fs.readFileSync(new URL(`${dir}/index.ts`, root), 'utf8'); } catch { continue; }
    const all = new Set();
    for (const m of src.matchAll(/from '\.\.\/_shared\/([^']+)'/g)) for (const x of sharedDeps(m[1])) all.add(x);
    if ([...all].some((f) => changedShared.includes(f))) needs.push(dir);
  }
  assert.deepEqual(needs.sort(), deployList.sort());
});

test('5: no dashes in any round 5 file (QueueSync and OfflineQueue: none in the lines round 5 added)', () => {
  for (const rel of [
    '../../supabase/functions/_shared/ezcaterIngest.ts', '../../supabase/functions/_shared/ezcaterCatering.js',
    '../../supabase/functions/_shared/cateringRules.js', '../../supabase/migrations/20260918d_OPS_ezcater_server_owned_rows.sql',
    './ezcaterRound5.test.js',
  ]) {
    const s = read(rel);
    assert.equal(s.includes(String.fromCharCode(0x2013)) || s.includes(String.fromCharCode(0x2014)), false, `${rel} has a dash`);
  }
});
