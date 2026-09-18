/**
 * ezcaterRound4.test.js: the fourth review round on "ezCater orders follow the catering rules".
 * Run: `npm test`, or `node --test src/lib/ezcaterRound4.test.js`.
 *
 * Peter, 18 Sep 2026: ezCater orders must "hit the POS at the right times and parameters set to
 * fire into the kitchen as our own catering orders". The bar for this round: the kitchen gets an
 * order exactly once, on time, printed. Where new automatic behaviour caused a bug it was removed
 * or narrowed. One section per reviewer item:
 *
 *   1. A FAILED SETTINGS READ CHANGES NOTHING. No prep sweep in the cron; re-time on a prep
 *      change only on a staff save, only with a successfully read, explicitly set prep time.
 *   2. THE CRON IS ONLY A BACKSTOP. It fires only rows past the grace window; a re-ask moves
 *      sent_at, the till fires it (printed, routed).
 *   3. A CANCELLED ORDER NEVER REVIVES from an older ezCater answer; tills never write the
 *      ezCater owned fields.
 *   4. HELD ROWS KEEP THEIR REAL FIRE MOMENT; the re-ask batch is picked fairly per venue.
 *   5. SENT LATE ONLY WHEN A CHANGE MOVED THE FIRE TIME INTO THE PAST.
 *   6. BUDGETS, COMPANY FILTER IN THE QUERY, NO NULL COMPANY ON A BLIP, NO CONTACT DETAILS IN
 *      THE PRE FIRE ANSWER, AND STAFF "SEND ANYWAY".
 *   7. The deploy list: every function importing a changed _shared file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  readCateringVenue, venueForExisting, writeEzcaterOrder, prefireCheck, recheckOrder, recheckUpcoming,
  recomputePrepForVenue, pickRecheckBatch, prefireRowForTill, PREFIRE_CONTACT_KEYS, sendAnyway,
  checkReplacements,
} from '../../supabase/functions/_shared/ezcaterIngest.ts';
import * as ingest from '../../supabase/functions/_shared/ezcaterIngest.ts';
import { orderToQueueRow, queuePayload } from '../../supabase/functions/_shared/ezcater-map.ts';
import { ezcaterWritePlan, lateFirePlan, answerOlderThanRow, ezcaterOrderWarnings } from '../../supabase/functions/_shared/ezcaterCatering.js';
import { connectionForLocation, venueCompanyStrict } from '../../supabase/functions/_shared/ezcaterConnections.ts';
import { cateringHoldReason, releasableOrFilter, isSentAnyway } from './cateringRules.js';
import { tillQueueWrite, EZCATER_TILL_FIELDS, mergePrefireRow } from './ezcaterTillWrite.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── An in memory Supabase that behaves like order_queue's trigger ────────────

function fakeDb(tables, hooks = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const log = [];
  let clock = 0;
  const stamp = () => `2026-09-18T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;
  for (const r of db.order_queue || []) if (!r.updated_at) r.updated_at = stamp();
  const from = (table) => {
    const st = { table, op: 'select', filters: [], eqs: {}, payload: null, single: false, lim: null, returning: false, opts: null, isNullOn: [], ors: [] };
    const run = async () => {
      const rows = (db[table] = db[table] || []);
      const match = (r) => st.filters.every((f) => f(r));
      let data = null; let error = null;
      if (st.op === 'select') {
        const forced = hooks.selectError ? hooks.selectError(table, st) : null;
        if (forced) { log.push({ table, op: 'select', eqs: { ...st.eqs }, ors: st.ors, error: true }); return { data: null, error: forced }; }
        const hit = rows.filter(match);
        data = st.single ? (hit[0] ? { ...hit[0] } : null) : hit.slice(0, st.lim ?? hit.length).map((r) => ({ ...r }));
      } else if (st.op === 'insert') {
        const dup = table === 'order_queue' && rows.some((r) => r.ref === st.payload.ref && r.location_id === st.payload.location_id);
        if (dup) error = { code: '23505', message: 'duplicate key value' };
        else rows.push({ ...st.payload, ...(table === 'order_queue' ? { updated_at: stamp() } : {}) });
      } else if (st.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) {
          Object.assign(r, JSON.parse(JSON.stringify(st.payload)));
          if (table === 'order_queue') r.updated_at = stamp();
        }
        data = st.returning ? hit.map((r) => ({ ...r })) : null;
      } else if (st.op === 'upsert') {
        const keys = String(st.opts?.onConflict || 'id').split(',');
        const found = rows.find((r) => keys.every((k) => r[k] === st.payload[k]));
        if (found) Object.assign(found, st.payload); else rows.push({ ...st.payload });
      }
      log.push({ table, op: st.op, payload: st.payload, eqs: { ...st.eqs }, isNullOn: st.isNullOn, ors: st.ors, lim: st.lim });
      return { data, error };
    };
    const api = {
      select() { if (st.op === 'select') return api; st.returning = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return api; },
      eq(c, v) { st.eqs[c] = v; st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { if (v === null) st.isNullOn.push(c); st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
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
      or(f) { st.ors.push(f); return api; }, order() { return api; },
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

const baseTables = (queueRows = [], extra = {}) => ({
  order_queue: queueRows,
  ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 1, event_at: '2026-09-18T16:00:00Z' }],
  ezcater_caterers: [{ caterer_uuid: 'cat-pos-testing', location_id: PROVO, connection_id: 'conn-1', active: true }],
  ezcater_connections: [{ id: 'conn-1', api_token: 'tok', api_url: null, status: 'connected', connected_at: '2026-09-17T00:00:00Z' }],
  catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 90 }],
  locations: [{ id: PROVO, timezone: 'Europe/London' }],
  ...extra,
});

/** A row as the webhook writes an ACCEPTED order today (ready 18:30Z, fires 17:00Z on 90 min). */
const heldRow = (over = {}, order = ezOrder()) => {
  const { row } = orderToQueueRow(order, PROVO, { venue: LONDON, priorAcceptedCount: 0 });
  const p = queuePayload(row, true, '2026-09-18T16:00:00.000Z');
  return { ...p, kitchen_routed_at: null, ...over };
};
const answers = (order) => () => async () => order;
const settingsFail = { selectError: (t) => (t === 'catering_site_settings' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null) };
/** A clock that moves one second per call, starting at iso. */
const tickClock = (iso) => { let t = Date.parse(iso); return () => (t += 1000); };

// ═════════════════════════════════════════════════════════════════════════════
// 1. A FAILED SETTINGS READ CHANGES NOTHING
// ═════════════════════════════════════════════════════════════════════════════

test('1: a failed catering settings read is NOT "no prep set": readCateringVenue says so', async () => {
  const ok = await readCateringVenue(fakeDb(baseTables()), null, PROVO);
  assert.equal(ok.prepReadOk, true);
  assert.equal(ok.prepMinutes, 90);
  const failed = await readCateringVenue(fakeDb(baseTables(), settingsFail), null, PROVO);
  assert.equal(failed.prepReadOk, false, 'an error answer is a failed read');
  assert.equal(failed.prepFallback, true, 'the fallback is still offered for a brand new order');
  const unset = await readCateringVenue(fakeDb(baseTables([], { catering_site_settings: [] })), null, PROVO);
  assert.equal(unset.prepReadOk, true);
  assert.equal(unset.prepFallback, true, 'a missing row really is not set');
  // A failed read keeps an existing order on its own prep and clock.
  const v = venueForExisting(failed, { customer: { prepMinutes: 90, prepFallback: false, venueTimeZone: 'Europe/London' } });
  assert.equal(v.prepMinutes, 90);
  assert.equal(v.prepFallback, false);
});

test('1: a re-ask during a settings outage never re-times the order to the 60 minute fallback', async () => {
  const sb = fakeDb(baseTables([heldRow()]), settingsFail);
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T12:00:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.outcome, 'checked');
  const row = sb.db.order_queue[0];
  assert.equal(row.sent_at, '2026-09-23T17:00:00.000Z', 'still 18:30 minus its own 90, never 18:30 minus 60');
  assert.equal(row.customer.prepMinutes, 90);
  assert.equal(row.customer.prepFallback, false);
  // The pre fire check too.
  const sb2 = fakeDb(baseTables([heldRow()]), settingsFail);
  await prefireCheck(sb2, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T16:59:50.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(sb2.db.order_queue[0].customer.prepMinutes, 90);
});

test('1: re-time on a prep change ONLY with a successfully read, explicitly set prep time', async () => {
  const nowIso = '2026-09-23T12:00:00.000Z';
  // A failed read changes nothing.
  const failed = fakeDb(baseTables([heldRow()], { catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 180 }] }), settingsFail);
  const f = await recomputePrepForVenue(failed, null, { locationId: PROVO, nowIso });
  assert.equal(f.ok, false);
  assert.match(f.why, /could not be read/);
  assert.equal(failed.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z');
  // No prep set changes nothing either (it used to re-time everything to the fallback).
  const unset = fakeDb(baseTables([heldRow()], { catering_site_settings: [] }));
  const u = await recomputePrepForVenue(unset, null, { locationId: PROVO, nowIso });
  assert.equal(u.ok, false);
  assert.match(u.why, /no catering prep time is set/);
  assert.equal(unset.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z');
  // A venue with no ezCater order waiting is fine whatever its settings.
  assert.equal((await recomputePrepForVenue(fakeDb(baseTables([], { catering_site_settings: [] })), null, { locationId: PROVO, nowIso })).ok, true);
  // A set prep time, read fine: re-timed.
  const set = fakeDb(baseTables([heldRow()], { catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 120 }] }));
  const s = await recomputePrepForVenue(set, null, { locationId: PROVO, nowIso });
  assert.equal(s.ok, true);
  assert.equal(s.retimed, 1);
  assert.equal(set.db.order_queue[0].sent_at, '2026-09-23T16:30:00.000Z');
});

test('1: the cron has no prep sweep; only the staff save re-times', () => {
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.equal(/recomputePrep/.test(cron.replace(/^\/\/.*$/gm, '')), false, 'no prep code in the cron');
  assert.equal('recomputePrepSweep' in ingest, false, 'the sweep is removed, not just unused');
  assert.ok(read('../backoffice/sections/CateringSettings.jsx').includes('const r = await ezcaterRecomputePrep(locId);'));
  assert.ok(read('../../supabase/functions/ezcater-connect/index.ts').includes('return json({ ok: r.ok, why: r.why ?? null, checked: r.checked, retimed: r.retimed, late: r.late });'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE CRON IS ONLY A BACKSTOP
// ═════════════════════════════════════════════════════════════════════════════

test('2: a re-ask never tells the cron to fire, and the cron fires only the grace window query', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  // The pickup moved earlier and the fire moment is now past: sent_at moves to now, nothing fires.
  const earlier = ezOrder({ event: { ...ezOrder().event, catererHandoffFoodTime: '2026-09-23T17:30:00Z' } });
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T16:40:00.000Z', fetchFor: answers(earlier) });
  assert.equal(r.outcome, 'checked');
  assert.equal('dueNow' in r, false);
  assert.equal(sb.db.order_queue[0].kitchen_routed_at, null);
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T16:40:00.000Z', 'the till release fires it, printed and routed');

  const cron = read('../../supabase/functions/catering-release/index.ts');
  const code = cron.replace(/^\/\/.*$/gm, '');
  assert.equal(/dueNow|lateKeys|lateRefsByLoc/.test(code), false, 'no same run firing of re-asked orders');
  assert.equal((code.match(/\.from\('order_queue'\)/g) || []).length, 2, 'one read (the grace window) and one claim');
  assert.ok(code.includes(".lte('sent_at', cutoff)"));
  assert.ok(code.includes('const GRACE_MIN = 3;'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. A CANCELLED ORDER NEVER REVIVES; TILLS NEVER WRITE THE ezCater OWNED FIELDS
// ═════════════════════════════════════════════════════════════════════════════

test('3: answerOlderThanRow: only a read that BEGAN after the row\'s answer came back is newer', () => {
  const row = { customer: { ezcaterAnswer: { startedAt: '2026-09-23T16:59:58.000Z', receivedAt: '2026-09-23T17:00:00.000Z' } } };
  assert.equal(answerOlderThanRow(row, '2026-09-23T16:59:59.000Z'), true, 'overlapping: may be older');
  assert.equal(answerOlderThanRow(row, '2026-09-23T17:00:00.000Z'), false);
  assert.equal(answerOlderThanRow(row, '2026-09-23T17:00:01.000Z'), false);
  assert.equal(answerOlderThanRow({ customer: {} }, '2026-09-23T17:00:01.000Z'), false, 'a row from older code is not judged');
});

test('3: a cancel written while the pre fire check was matching items is never undone', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const clock = tickClock('2026-09-23T17:00:00.000Z');
  let calls = 0;
  const fetchFor = () => async () => {
    calls++;
    if (calls === 1) {
      // While our read is out, ezCater cancels and the webhook writes it (its read is newer).
      const started = new Date(clock()).toISOString();
      const received = new Date(clock()).toISOString();
      const w = await writeEzcaterOrder(sb, { order: lifecycle('cancelled'), answer: { startedAt: started, receivedAt: received }, locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T17:00:05.000Z', match: false });
      assert.equal(w.ok, true);
      assert.equal(sb.db.order_queue[0].status, 'cancelled');
      return ezOrder();                        // our (older) answer: still accepted
    }
    return lifecycle('cancelled');             // the fresh read
  };
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:10.000Z', fetchFor, clock });
  assert.equal(r.fire, false);
  assert.equal(r.outcome, 'cancelled');
  assert.equal(calls, 2, 'ezCater was read again rather than trusting the older answer');
  assert.equal(sb.db.order_queue[0].status, 'cancelled', 'the cancel stands');
  assert.equal(sb.db.order_queue[0].customer.restoredAt, undefined);
});

test('3: when ezCater cannot be read again, the older answer is dropped and the cancel still stands', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const clock = tickClock('2026-09-23T17:00:00.000Z');
  let calls = 0;
  const fetchFor = () => async () => {
    calls++;
    if (calls === 1) {
      await writeEzcaterOrder(sb, { order: lifecycle('cancelled'), answer: { startedAt: new Date(clock()).toISOString(), receivedAt: new Date(clock()).toISOString() }, locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T17:00:05.000Z', match: false });
      return ezOrder();
    }
    throw new Error('ezCater is down');
  };
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:10.000Z', fetchFor, clock });
  assert.equal(r.fire, false);
  assert.equal(r.outcome, 'cancelled');
  assert.equal(sb.db.order_queue[0].status, 'cancelled');
  // The scheduled re-ask (no refetch) drops it too.
  const again = fakeDb(baseTables([heldRow()]));
  const c2 = tickClock('2026-09-23T12:00:00.000Z');
  let n = 0;
  const rr = await recheckOrder(again, null, {
    locationId: PROVO, ref: REF, nowIso: '2026-09-23T12:00:10.000Z', clock: c2,
    fetchFor: () => async () => {
      if (n++ === 0) await writeEzcaterOrder(again, { order: lifecycle('cancelled'), answer: { startedAt: new Date(c2()).toISOString(), receivedAt: new Date(c2()).toISOString() }, locationId: PROVO, venue: LONDON, nowIso: '2026-09-23T12:00:05.000Z', match: false });
      return ezOrder();
    },
  });
  assert.equal(rr.outcome, 'stale');
  assert.equal(again.db.order_queue[0].status, 'cancelled');
});

test('3: a real uncancel (a read that began after the cancel came back) still restores the order', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  await writeEzcaterOrder(sb, { order: lifecycle('cancelled'), answer: { startedAt: '2026-09-22T10:00:00.000Z', receivedAt: '2026-09-22T10:00:01.000Z' }, locationId: PROVO, venue: LONDON, nowIso: '2026-09-22T10:00:01.000Z', match: false });
  assert.equal(sb.db.order_queue[0].status, 'cancelled');
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), answer: { startedAt: '2026-09-22T11:00:00.000Z', receivedAt: '2026-09-22T11:00:01.000Z' }, locationId: PROVO, venue: LONDON, nowIso: '2026-09-22T11:00:01.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(w.plan.restored, true);
  assert.notEqual(sb.db.order_queue[0].status, 'cancelled');
});

test('3: a replacement check never marks an order replaced on an answer older than the row\'s', async () => {
  const orig = heldRow();
  const newer = { ...heldRow({}, ezOrder({ uuid: '99999999-2222-3333-4444-555555555555', orderNumber: 'NEW1' })) };
  const sb = fakeDb(baseTables([orig, newer]));
  const clock = tickClock('2026-09-20T09:00:00.000Z');
  const out = await checkReplacements(sb, {
    locationId: PROVO, newRow: newer, venue: LONDON, nowIso: '2026-09-20T09:00:10.000Z', clock,
    fetchFor: () => async () => {
      // A live answer about the original lands while our (cancelled) read is out.
      await writeEzcaterOrder(sb, { order: ezOrder(), answer: { startedAt: new Date(clock()).toISOString(), receivedAt: new Date(clock()).toISOString() }, locationId: PROVO, venue: LONDON, nowIso: '2026-09-20T09:00:05.000Z', match: false });
      return lifecycle('cancelled');
    },
  });
  assert.equal(out[0].outcome, 'flagged', 'only flagged for staff, never replaced on an older answer');
  const o = sb.db.order_queue.find((r) => r.ref === REF);
  assert.notEqual(o.status, 'cancelled');
  assert.equal(o.customer.replacedBy, undefined);
});

test('3: a till writes ONLY status and staff on an ezCater row, as an update, never onto a cancel', () => {
  const row = { ref: REF, location_id: PROVO, source: 'ezcater', status: 'prep', staff: 'Jane', customer: { name: 'x', ezcater_lifecycle: 'accepted' }, sent_at: '2026-09-23T17:00:00Z', items: [], total: 1, collection_time: '14:30' };
  const w = tillQueueWrite(row);
  assert.equal(w.mode, 'update');
  assert.deepEqual(w.payload, { ref: REF, status: 'prep', staff: 'Jane' });
  assert.deepEqual(w.notMatch, { status: 'cancelled' });
  assert.deepEqual([...EZCATER_TILL_FIELDS], ['status', 'staff']);
  for (const k of ['customer', 'sent_at', 'items', 'total', 'collection_time', 'type', 'created_at', 'is_asap']) assert.equal(k in w.payload, false, k);
  assert.equal(tillQueueWrite({ ...row, source: 'catering' }).mode, 'as_before', 'our own catering is unchanged');
  assert.equal(tillQueueWrite({ ...row, source: 'pos' }).mode, 'as_before');
  const qs = read('../sync/QueueSync.js');
  const ez = qs.indexOf('const ez = tillQueueWrite(row);');
  assert.ok(ez > 0 && ez < qs.indexOf("queueWrite({ type: 'upsert', table: 'order_queue'"), 'decided before any upsert');
  assert.ok(qs.includes("queueWrite({ type: 'update', table: 'order_queue', payload: ez.payload, match, notMatch: ez.notMatch });"));
  assert.ok(qs.includes('for (const [k, v] of Object.entries(notMatch || {})) q = q.neq(k, v);'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. HELD ROWS KEEP THEIR REAL FIRE MOMENT; THE RE-ASK BATCH IS FAIR PER VENUE
// ═════════════════════════════════════════════════════════════════════════════

test('4: a held order past its fire moment keeps its real sent_at on every re-ask', async () => {
  const links = { ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 0 }] };
  const sb = fakeDb(baseTables([heldRow({}, lifecycle('submitted'))], links));
  for (const nowIso of ['2026-09-23T17:20:00.000Z', '2026-09-23T17:40:00.000Z']) {
    await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso, fetchFor: answers(lifecycle('submitted')) });
    assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:00:00.000Z', `not rewritten to ${nowIso}`);
  }
  // Accepted later: released, and due, so it fires now (through the till).
  await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:45:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:45:00.000Z');
  // A NEW held order with a past fire moment is written at that moment, not now.
  const { row } = orderToQueueRow(lifecycle('submitted'), PROVO, { venue: LONDON });
  const plan = ezcaterWritePlan({ row, existing: null, terminal: false, nowIso: '2026-09-23T17:30:00.000Z' });
  assert.equal(plan.row.fire_at, '2026-09-23T17:00:00.000Z');
});

test('4: the re-ask batch takes turns across venues, released orders first', () => {
  const r = (loc, i, held = false) => ({ ref: `${loc}-${i}`, location_id: loc, source: 'ezcater', status: 'received', sent_at: new Date(Date.parse('2026-09-23T10:00:00Z') + i * 60e3).toISOString(), customer: { ezcater_lifecycle: held ? 'submitted' : 'accepted' } });
  const busy = Array.from({ length: 40 }, (_, i) => r('A', i, true));   // 40 held orders, oldest first
  const other = [r('B', 100), r('C', 200)];
  const pick = pickRecheckBatch([...busy, ...other], 20);
  assert.equal(pick.length, 20);
  assert.ok(pick.some((x) => x.location_id === 'B'), 'venue B is never crowded out');
  assert.ok(pick.some((x) => x.location_id === 'C'));
  assert.equal(pick[0].location_id === 'A', false, 'a released order goes before a pile of held ones');
  // Within a venue, released first.
  const mixed = pickRecheckBatch([r('A', 1, true), r('A', 5)], 1);
  assert.equal(mixed[0].ref, 'A-5');
});

test('4: the scheduled read is wide and location fair, not the platform\'s 20 oldest', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const at = (ms) => new Date(ms).toISOString();
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...heldRow({}, lifecycle('submitted')), ref: `EZ-A${i}`, location_id: 'venue-a', sent_at: at(now - 3600e3 + i * 1000) }));
  rows.push({ ...heldRow(), ref: 'EZ-B', location_id: 'venue-b', sent_at: at(now + 3600e3) });
  const sb = fakeDb(baseTables(rows));
  const asked = [];
  await recheckUpcoming(sb, null, { nowIso: at(now), budgetMs: 2000, fetchFor: (a) => async () => { asked.push(a); return ezOrder(); } });
  const reads = sb.log.filter((l) => l.table === 'order_queue' && l.op === 'select' && l.ors.length);
  assert.ok(reads.every((l) => l.lim === ingest.EZ_RECHECK_READ_LIMIT), 'wide read to pick from');
  // venue-b was picked (it has no caterer mapped here so it cannot be asked, but it was attempted).
  const attempted = sb.log.filter((l) => l.table === 'order_queue' && l.op === 'select' && l.eqs.ref === 'EZ-B');
  assert.ok(attempted.length >= 1, 'the other venue\'s order was re-asked');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. SENT LATE ONLY WHEN A CHANGE MOVED THE FIRE TIME INTO THE PAST
// ═════════════════════════════════════════════════════════════════════════════

test('5: a routine pre fire check, even minutes after the fire moment, is never "late"', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  // The backstop's check, 3 minutes after the fire moment, nothing changed on ezCater.
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:03:30.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.fire, true);
  assert.equal(sb.db.order_queue[0].customer.lateFire, undefined);
  assert.equal(ezcaterOrderWarnings(sb.db.order_queue[0]).some((w) => /LATE/.test(w)), false);
});

test('5: a new order, or an accepted notification that moved nothing, is never "late"', () => {
  const { row } = orderToQueueRow(ezOrder(), PROVO, { venue: LONDON });
  const fresh = ezcaterWritePlan({ row, existing: null, terminal: false, nowIso: '2026-09-23T17:30:00.000Z' });
  assert.equal(fresh.late, false);
  assert.equal(fresh.row.customer.lateFire, undefined);
  const again = ezcaterWritePlan({ row, existing: heldRow(), terminal: false, nowIso: '2026-09-23T17:30:00.000Z' });
  assert.equal(again.late, false);
});

test('5: a pickup moved earlier, or a longer prep, into the past IS late; a later one is not', async () => {
  const was = '2026-09-23T17:00:00.000Z';
  assert.equal(lateFirePlan({ fireAt: '2026-09-23T16:00:00.000Z', prevFireAt: was, nowIso: '2026-09-23T16:30:00.000Z' }).minutesLate, 30);
  assert.equal(lateFirePlan({ fireAt: '2026-09-23T16:00:00.000Z', prevFireAt: null, nowIso: '2026-09-23T16:30:00.000Z' }), null, 'no previous moment: not a change');
  assert.equal(lateFirePlan({ fireAt: was, prevFireAt: was, nowIso: '2026-09-23T17:05:00.000Z' }), null, 'unchanged: routine');
  // Prep 90 -> 180 at 16:00: 18:30 - 180 = 15:30, moved earlier into the past.
  const sb = fakeDb(baseTables([heldRow()], { catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 180 }] }));
  const r = await recomputePrepForVenue(sb, null, { locationId: PROVO, nowIso: '2026-09-23T16:00:00.000Z' });
  assert.equal(r.late, 1);
  assert.equal(sb.db.order_queue[0].customer.lateFire.fireAt, '2026-09-23T15:30:00.000Z');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. BUDGETS, COMPANY IN THE QUERY, NO NULL COMPANY, NO CONTACT DETAILS, SEND ANYWAY
// ═════════════════════════════════════════════════════════════════════════════

test('6: the unchecked flag is written inside the fire budget, in parallel, not in a serial loop', () => {
  const cron = read('../../supabase/functions/catering-release/index.ts');
  const serve = cron.slice(cron.indexOf('Deno.serve('), cron.indexOf('async function fireOne('));
  assert.equal(serve.includes('await flagUnchecked('), false, 'not in the main loop');
  const fire = cron.slice(cron.indexOf('async function fireOne('));
  assert.ok(fire.indexOf('await flagUnchecked(') < fire.indexOf("sb.from('order_queue')"), 'flagged before the claim, inside fireOne');
  assert.ok(cron.includes('await runWithBudget(toFire, (row: any) => fireOne(row, nowIso), { concurrency: FIRE_CONCURRENCY, budgetMs: FIRE_BUDGET_MS })'));
});

test('6: the connection for a venue is found by company IN THE QUERY, however many other companies connected first', async () => {
  const others = Array.from({ length: 25 }, (_, i) => ({ id: `other-${i}`, company_id: `co-other-${i}`, status: 'connected', connected_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
  const sb = fakeDb({ ezcater_caterers: [], ezcater_connections: [...others, { id: 'mine', company_id: 'co-1', status: 'connected', connected_at: '2026-09-01T00:00:00Z' }] });
  const platform = fakeDb({ locations: [{ id: 'p-1', ops_location_id: PROVO, company_id: 'co-1' }] });
  const c = await connectionForLocation(sb, platform, PROVO);
  assert.equal(c?.id, 'mine');
  const q = sb.log.find((l) => l.table === 'ezcater_connections' && l.eqs.company_id === 'co-1');
  assert.ok(q, 'filtered by company in the query');
  // A connection made before company_id was written is found through a sibling venue's caterer.
  const legacy = fakeDb({
    ezcater_caterers: [{ caterer_uuid: 'c1', location_id: 'sibling-ops', connection_id: 'old' }],
    ezcater_connections: [...others, { id: 'old', company_id: null, status: 'connected', connected_at: '2025-01-01T00:00:00Z' }],
  });
  const plat2 = fakeDb({ locations: [{ id: 'p-1', ops_location_id: PROVO, company_id: 'co-1' }, { id: 'p-2', ops_location_id: 'sibling-ops', company_id: 'co-1' }] });
  assert.equal((await connectionForLocation(legacy, plat2, PROVO))?.id, 'old');
  // Another company's connection is never returned.
  const plat3 = fakeDb({ locations: [{ id: 'p-9', ops_location_id: PROVO, company_id: 'co-nobody' }] });
  assert.equal(await connectionForLocation(sb, plat3, PROVO), null);
});

test('6: connect_token never stores company_id null because the company lookup failed', async () => {
  const broken = fakeDb({ locations: [] }, { selectError: () => ({ message: 'upstream timeout' }) });
  const r = await venueCompanyStrict(broken, PROVO);
  assert.equal(r.ok, false);
  const none = await venueCompanyStrict(fakeDb({ locations: [] }), PROVO);
  assert.deepEqual(none, { ok: true, companyId: null });
  assert.equal((await venueCompanyStrict(null, PROVO)).ok, false);
  const s = read('../../supabase/functions/ezcater-connect/index.ts');
  const at = s.indexOf("case 'connect_token': {");
  const block = s.slice(at, s.indexOf(".from('ezcater_connections').insert(row)", at));
  assert.ok(block.includes('const co = await venueCompanyStrict(platform, opsLocationId);'));
  assert.ok(block.indexOf('if (!co.ok) {') < block.indexOf('company_id: co.companyId,'), 'refused before the insert');
});

test('6: the pre fire answer carries no customer contact details, and the till keeps its own', () => {
  const row = { ...heldRow(), customer: { ...heldRow().customer, name: 'Peter Test', phone: '5555550100', email: 'p@x', address: { line1: '1 Test St' }, buyerName: 'Peter Test' } };
  const out = prefireRowForTill(row);
  for (const k of PREFIRE_CONTACT_KEYS) assert.equal(k in out.customer, false, k);
  assert.equal(out.customer.ezcater_order_number, 'HKX77V', 'what the kitchen needs stays');
  assert.equal(out.items.length, 1);
  const s = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.ok(s.includes('row: prefireRowForTill(r.row)'));
  assert.equal(/customer: r\.row\.customer/.test(s), false);
  // The till merges it over its own copy: the ticket keeps the name.
  const merged = mergePrefireRow({ ref: REF, customer: { name: 'Peter Test', phone: '5555550100' }, items: [] }, out);
  assert.equal(merged.customer.name, 'Peter Test');
  assert.equal(merged.customer.ezcater_order_number, 'HKX77V');
  const store = read('../store/index.js');
  assert.equal((store.match(/if \(pf\.row\) row = mergePrefireRow\(row, pf\.row\);/g) || []).length, 2);
});

test('6: staff can "Send anyway" a held order in an ezCater outage, recorded, and a cancel still wins', async () => {
  const links = { ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 0 }] };
  const sb = fakeDb(baseTables([heldRow({}, lifecycle('submitted'))], links));
  assert.equal(cateringHoldReason(sb.db.order_queue[0]), 'awaiting_ezcater_acceptance');
  const r = await sendAnyway(sb, { locationId: PROVO, ref: REF, by: 'staff:s1', byName: 'Jane', nowIso: '2026-09-23T17:10:00.000Z' });
  assert.equal(r.ok, true);
  const row = sb.db.order_queue[0];
  assert.deepEqual(row.customer.sendAnyway, { at: '2026-09-23T17:10:00.000Z', by: 'staff:s1', byName: 'Jane', lifecycle: 'submitted' });
  assert.equal(isSentAnyway(row), true);
  assert.equal(cateringHoldReason(row), null, 'released');
  assert.match(releasableOrFilter(), /customer->sendAnyway\.not\.is\.null/, 'the release and claim queries read it too');
  assert.match(ezcaterOrderWarnings(row).join(' '), /Sent anyway by staff \(Jane\)/);
  // ezCater still says submitted when it comes back: it stays released.
  await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:15:00.000Z', fetchFor: answers(lifecycle('submitted')) });
  assert.equal(cateringHoldReason(sb.db.order_queue[0]), null);
  // ezCater says cancelled: the cancel wins.
  await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:20:00.000Z', fetchFor: answers(lifecycle('cancelled')) });
  assert.equal(cateringHoldReason(sb.db.order_queue[0]), 'cancelled');
  // A cancelled, or an already released, order cannot be "sent anyway".
  assert.equal((await sendAnyway(sb, { locationId: PROVO, ref: REF, by: 'staff:s1' })).ok, false);
  const accepted = fakeDb(baseTables([heldRow()]));
  const a = await sendAnyway(accepted, { locationId: PROVO, ref: REF, by: 'staff:s1' });
  assert.equal(a.ok, false);
  assert.match(a.error, /not held/);
  // Wired: staff fence (PIN on a till), Orders Hub button, then the normal release.
  const s = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.ok(s.includes("action === 'send_anyway'"));
  assert.ok(s.indexOf("await staffActor(sb, platform, user, opsLocationId, body?.pin)") < s.indexOf("if (action === 'send_anyway') {"));
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.ok(hub.includes('await ezcaterSendAnyway(locId, o.ref, staff.pin)'));
  assert.ok(hub.includes('releaseCateringOrderNow?.(released)'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. THE DEPLOY LIST
// ═════════════════════════════════════════════════════════════════════════════

test('7: every function that imports a changed _shared file is on the deploy list', () => {
  const changedShared = ['ezcaterIngest.ts', 'ezcaterCatering.js', 'cateringRules.js', 'staffAuthority.ts', 'ezcaterConnections.ts', 'budget.js', 'ezcater-map.ts', 'ezcater.ts', 'delivery-dispatch.ts'];
  const deployList = ['catering-release', 'ezcater-connect', 'ezcater-webhook', 'order-notify', 'review-request', 'uber-direct'];
  const root = new URL('../../supabase/functions/', import.meta.url);
  // The shared files each shared file pulls in, so an indirect import counts too.
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
    const direct = [...src.matchAll(/from '\.\.\/_shared\/([^']+)'/g)].map((m) => m[1]);
    const all = new Set();
    for (const d of direct) for (const x of sharedDeps(d)) all.add(x);
    if ([...all].some((f) => changedShared.includes(f))) needs.push(dir);
  }
  assert.deepEqual(needs.sort(), deployList.sort());
});
