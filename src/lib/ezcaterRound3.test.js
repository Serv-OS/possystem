/**
 * ezcaterRound3.test.js: the third review round on "ezCater orders follow the catering rules".
 * Run: `npm test`, or `node --test src/lib/ezcaterRound3.test.js`.
 *
 * Peter, 18 Sep 2026: "we need to ensure they follow the same rules as the rest of our catering
 * system where they hit the POS at the right times and parameters set to fire into the kitchen
 * as our own catering orders". Both round two reviewers said do not ship for seven things. Each
 * has its tests here, against the real shared code and an in memory stand in for Supabase that
 * stamps updated_at on every update, exactly as trg_order_queue_updated_at does:
 *
 *   A. REJECTED IS NOT CANCELLED. Only a cancel stops an order; a rejected modification leaves
 *      the accepted order standing; replacedBy is not sticky forever; a fired replaced order
 *      stays cancelled and is never flagged uncancelled.
 *   B. NO STALE OVERWRITES. Every write is guarded on the row as read (updated_at), and a flag
 *      touches only its own keys.
 *   C. EARLIER PICKUP AND LONGER PREP ARE SEEN IN TIME. Scheduled re-asks, prep re-time, late.
 *   D. HELD ORDERS ARE RE-ASKED, and one still not accepted is shown to staff.
 *   E. THE CLAIM CHECKS STATUS, in the same UPDATE, on the till and in the cron.
 *   F. AUTHORITY: no user_profiles.location_id, a granting company role, no cross company token.
 *   G. THE CRON SCALES (parallel, one budget, unchecked fires flagged); no review SMS to ezCater.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  writeEzcaterOrder, prefireCheck, resyncOrder, checkReplacements, undoReplacement, guardedUpdate,
  patchCustomer, recheckOrder, recheckUpcoming, recomputePrepForVenue, needsRecheck, unacceptedAlertFor,
  ezcaterAccessFor, flagUnchecked, EZ_RECHECK_NEAR_EVERY_MS,
} from '../../supabase/functions/_shared/ezcaterIngest.ts';
import { orderToQueueRow, queuePayload, EZ_TERMINAL, ezStatusToQueueStatus } from '../../supabase/functions/_shared/ezcater-map.ts';
import {
  ezcaterWritePlan, likelyReplacement, ezcaterOrderWarnings, lateFirePlan, lateFireText,
} from '../../supabase/functions/_shared/ezcaterCatering.js';
import {
  cateringHoldReason, cateringMayFire, EZ_COMMITTED, EZ_DEAD, ezEffectiveLifecycle, UNCLAIMABLE_STATUSES_PG,
  releasableOrFilter, mayMessageCustomer,
} from './cateringRules.js';
import { staffForLocation, staffActor, GRANTING_COMPANY_ROLES } from '../../supabase/functions/_shared/staffAuthority.ts';
import { runWithBudget } from '../../supabase/functions/_shared/budget.js';
import { cateringChangeAlert } from './cateringAlerts.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── An in memory Supabase that behaves like order_queue's trigger ────────────

function fakeDb(tables, hooks = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const log = [];
  let clock = 0;
  const stamp = () => `2026-09-18T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;
  for (const r of db.order_queue || []) if (!r.updated_at) r.updated_at = stamp();
  const from = (table) => {
    const st = { table, op: 'select', filters: [], eqs: {}, payload: null, single: false, lim: null, returning: false, opts: null, isNullOn: [], nots: [], ors: [] };
    const run = async () => {
      const rows = (db[table] = db[table] || []);
      const match = (r) => st.filters.every((f) => f(r));
      let data = null; let error = null;
      if (st.op === 'select') {
        const hit = rows.filter(match);
        data = st.single ? (hit[0] ? { ...hit[0] } : null) : hit.slice(0, st.lim ?? hit.length).map((r) => ({ ...r }));
      } else if (st.op === 'insert') {
        const dup = table === 'order_queue' && rows.some((r) => r.ref === st.payload.ref && r.location_id === st.payload.location_id);
        if (dup) error = { code: '23505', message: 'duplicate key value' };
        else rows.push({ ...st.payload, ...(table === 'order_queue' ? { updated_at: stamp() } : {}) });
      } else if (st.op === 'update') {
        if (hooks.beforeUpdate) hooks.beforeUpdate(st, db, stamp);
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
      log.push({ table, op: st.op, payload: st.payload, isNullOn: st.isNullOn, eqs: { ...st.eqs }, nots: st.nots, ors: st.ors });
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
        st.nots.push([c, op, v]);
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
const REPL_UUID = '11111111-2222-3333-4444-555555555555';
const REPL_REF = `EZ-${REPL_UUID}`;

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

/** A row as the webhook writes an ACCEPTED order today (fires 2026-09-23T17:00Z). */
const heldRow = (over = {}, order = ezOrder()) => {
  const { row } = orderToQueueRow(order, PROVO, { venue: LONDON, priorAcceptedCount: 0 });
  const p = queuePayload(row, true, '2026-09-18T16:00:00.000Z');
  return { ...p, kitchen_routed_at: null, ...over };
};
const answers = (order) => () => async () => order;

// ═════════════════════════════════════════════════════════════════════════════
// A. REJECTED IS NOT CANCELLED
// ═════════════════════════════════════════════════════════════════════════════

test('A: only a cancel is terminal; rejected is not, and maps to held', () => {
  assert.deepEqual([...EZ_TERMINAL].sort(), ['canceled', 'cancelled', 'cancelled_for_replacement']);
  assert.equal(EZ_TERMINAL, EZ_DEAD, 'one list, in cateringRules.js');
  assert.equal(EZ_TERMINAL.has('rejected'), false);
  assert.equal(ezStatusToQueueStatus('rejected'), 'received');
  assert.deepEqual(ezEffectiveLifecycle('rejected', { priorAccepted: 1 }), { lifecycle: 'accepted', modificationRejected: true });
  assert.deepEqual(ezEffectiveLifecycle('rejected', { prevLifecycle: 'relish_finalized' }), { lifecycle: 'relish_finalized', modificationRejected: true });
  assert.deepEqual(ezEffectiveLifecycle('rejected', {}), { lifecycle: 'rejected', modificationRejected: false });
  assert.deepEqual(ezEffectiveLifecycle('cancelled', { priorAccepted: 3 }), { lifecycle: 'cancelled', modificationRejected: false });
});

test('A: an accepted order whose MODIFICATION was rejected is not cancelled, stays on the advance list and still fires', () => {
  // The write plan catches it from the row itself, even with no accepted count to go on.
  const accepted = heldRow();
  const { row } = orderToQueueRow(lifecycle('rejected'), PROVO, { venue: LONDON, priorAcceptedCount: 0 });
  const plan = ezcaterWritePlan({ row, existing: accepted, terminal: false, nowIso: '2026-09-20T09:00:00.000Z' });
  assert.equal(plan.row.status, 'received');
  assert.equal(plan.row.customer.ezcater_lifecycle, 'accepted');
  assert.equal(plan.row.customer.modificationRejected, true);
  assert.equal(cateringMayFire(plan.row), true, 'the release still fires it');
  assert.match(ezcaterOrderWarnings(plan.row).join(' '), /change to this order was REJECTED on ezCater/);
});

test('A: the pre fire check never downgrades an accepted order on a rejected answer', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor: answers(lifecycle('rejected')) });
  assert.equal(r.fire, true);
  assert.equal(r.outcome, 'fire');
  const stored = sb.db.order_queue[0];
  assert.notEqual(stored.status, 'cancelled');
  assert.equal(stored.customer.ezcater_lifecycle, 'accepted');
  assert.equal(stored.customer.modificationRejected, true);
});

test('A: a never accepted order that is rejected is HELD (visible), not cancelled: the cancelled that follows kills it', async () => {
  const submitted = heldRow({}, lifecycle('submitted'));
  const sb = fakeDb(baseTables([submitted], { ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 0 }] }));
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor: answers(lifecycle('rejected')) });
  assert.equal(r.fire, false);
  assert.equal(r.outcome, 'awaiting_ezcater_acceptance');
  assert.equal(sb.db.order_queue[0].status, 'received');
  const w = await writeEzcaterOrder(sb, { order: lifecycle('cancelled'), locationId: PROVO, venue: LONDON, priorLink: { accepted_count: 0 }, nowIso: '2026-09-23T17:01:00.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(sb.db.order_queue[0].status, 'cancelled');
});

test('A: checkReplacements treats ONLY a cancel as proof; a rejected original is flagged, never stopped', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const nowIso = '2026-09-20T09:00:00.000Z';
  const w = await writeEzcaterOrder(sb, { order: ezOrder({ uuid: REPL_UUID, orderNumber: 'NEW01' }), locationId: PROVO, venue: LONDON, nowIso, match: false });
  const found = await checkReplacements(sb, { locationId: PROVO, newRow: w.plan.row, venue: LONDON, nowIso, fetchFor: answers(lifecycle('rejected')) });
  assert.deepEqual(found.map((f) => f.outcome), ['flagged']);
  const orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.status, 'received');
  assert.equal(orig.customer.replacedBy, undefined);
  assert.equal(orig.customer.possibleReplacement.orderNumber, 'NEW01');
  assert.equal(sb.db.order_queue.find((r) => r.ref === REPL_REF).customer.possibleReplacement.ref, REF);
});

test('A: replacedBy is not sticky: a later accepted from ezCater revives an unfired original', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const nowIso = '2026-09-20T09:00:00.000Z';
  const w = await writeEzcaterOrder(sb, { order: ezOrder({ uuid: REPL_UUID, orderNumber: 'NEW01' }), locationId: PROVO, venue: LONDON, nowIso, match: false });
  await checkReplacements(sb, { locationId: PROVO, newRow: w.plan.row, venue: LONDON, nowIso, fetchFor: answers(lifecycle('cancelled_for_replacement')) });
  let orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.status, 'cancelled');
  assert.equal(orig.customer.replacedBy.orderNumber, 'NEW01');
  // ezCater says the original is live again (uncancelled and accepted): it comes back.
  const back = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, priorLink: { accepted_count: 1 }, nowIso: '2026-09-21T09:00:00.000Z', match: false });
  assert.equal(back.plan.restored, true);
  orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.status, 'received');
  assert.equal(orig.customer.replacedBy, undefined);
  assert.equal(orig.customer.replacedByCleared.orderNumber, 'NEW01');
  assert.equal(cateringMayFire(orig), true);
  assert.equal(orig.sent_at, '2026-09-23T17:00:00.000Z', 'a fresh fire time');
});

test('A: staff Undo clears both marks, never re-flags the pair, and lets ezCater decide an unfired order', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const nowIso = '2026-09-20T09:00:00.000Z';
  const w = await writeEzcaterOrder(sb, { order: ezOrder({ uuid: REPL_UUID, orderNumber: 'NEW01' }), locationId: PROVO, venue: LONDON, nowIso, match: false });
  await checkReplacements(sb, { locationId: PROVO, newRow: w.plan.row, venue: LONDON, nowIso, fetchFor: answers(lifecycle('cancelled')) });
  assert.equal(sb.db.order_queue.find((r) => r.ref === REF).status, 'cancelled');
  // Staff know better, and ezCater now lists the original as accepted again.
  const u = await undoReplacement(sb, null, { locationId: PROVO, ref: REF, by: 'staff:s1', nowIso: '2026-09-20T10:00:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(u.ok, true);
  assert.equal(u.resynced, true);
  const orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.status, 'received');
  assert.equal(orig.customer.replacedBy, undefined);
  assert.deepEqual(orig.customer.replacementDismissed.refs, [REPL_REF]);
  const repl = sb.db.order_queue.find((r) => r.ref === REPL_REF);
  assert.equal(repl.customer.possibleReplacement, undefined);
  assert.deepEqual(repl.customer.replacementDismissed.refs, [REF]);
  // The pair is never flagged against each other again.
  assert.equal(likelyReplacement(repl, orig), false);
  assert.equal(likelyReplacement(orig, repl), false);
  const again = await checkReplacements(sb, { locationId: PROVO, newRow: repl, venue: LONDON, nowIso, fetchFor: answers(lifecycle('cancelled')) });
  assert.deepEqual(again, []);
  // And the fence is the staff rule, on the connect function.
  const connect = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.ok(connect.includes("action === 'undo_replacement'"));
  assert.ok(connect.includes('await undoReplacement(sb, platform, {'));
  assert.ok(read('../surfaces/OrdersHub.jsx').includes('ezcaterUndoReplacement(locId, o.ref, staff.pin)'));
  assert.ok(read('../backoffice/sections/CateringOrders.jsx').includes('ezcaterUndoReplacement(locId, o.ref)'));
});

test('A: a FIRED order marked replaced stays cancelled and is never pushed an uncancelled flag', () => {
  const firedReplaced = heldRow({
    status: 'cancelled', kitchen_routed_at: '2026-09-23T17:00:05Z',
    customer: { ...heldRow().customer, replacedBy: { ref: REPL_REF, orderNumber: 'NEW01' } },
  });
  const { row } = orderToQueueRow(ezOrder(), PROVO, { venue: LONDON, priorAcceptedCount: 1 });
  const plan = ezcaterWritePlan({ row, existing: firedReplaced, terminal: false, nowIso: '2026-09-23T17:10:00.000Z' });
  assert.equal(plan.row.status, 'cancelled');
  assert.equal(plan.fired, true);
  assert.equal(plan.reschedule, false);
  assert.equal((plan.changedAfterFire?.kinds || []).includes('uncancelled'), false);
  // An ordinary cancelled fired order (not replaced) still gets the uncancelled flag.
  const plain = heldRow({ status: 'cancelled', kitchen_routed_at: '2026-09-23T17:00:05Z' });
  assert.ok(ezcaterWritePlan({ row, existing: plain, terminal: false, nowIso: '2026-09-23T17:10:00.000Z' }).changedAfterFire.kinds.includes('uncancelled'));
});

// ═════════════════════════════════════════════════════════════════════════════
// B. NO STALE OVERWRITES
// ═════════════════════════════════════════════════════════════════════════════

test('B: an accepted notification landing DURING the replacement re-ask is never undone', async () => {
  // The original was held as submitted when the new order arrived.
  const submitted = heldRow({}, lifecycle('submitted'));
  const sb = fakeDb(baseTables([submitted], { ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 0 }] }));
  const nowIso = '2026-09-20T09:00:00.000Z';
  const w = await writeEzcaterOrder(sb, { order: ezOrder({ uuid: REPL_UUID, orderNumber: 'NEW01' }), locationId: PROVO, venue: LONDON, nowIso, match: false });
  const found = await checkReplacements(sb, {
    locationId: PROVO, newRow: w.plan.row, venue: LONDON, nowIso,
    // While we wait on ezCater (up to 4 seconds), the accepted notification for the ORIGINAL lands.
    fetchFor: () => async () => {
      await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, priorLink: { accepted_count: 0 }, nowIso: '2026-09-20T09:00:01.000Z', match: false });
      return ezOrder();
    },
  });
  assert.deepEqual(found.map((f) => f.outcome), ['flagged']);
  const orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.customer.ezcater_lifecycle, 'accepted', 'the accepted notification survived the flag write');
  assert.equal(cateringHoldReason(orig), null, 'so the order is not held for good');
  assert.equal(orig.customer.possibleReplacement.orderNumber, 'NEW01', 'and the flag is there too');
});

test('B: every write to an existing row is guarded on updated_at, and replans when anything wrote in between', async () => {
  let interfered = false;
  const sb = fakeDb(baseTables([heldRow()]), {
    beforeUpdate(st, db, stamp) {
      // Someone else (a till, a staff Undo) writes between our read and our write, once.
      if (!interfered && st.table === 'order_queue' && st.eqs.updated_at) {
        interfered = true;
        db.order_queue[0].customer = { ...db.order_queue[0].customer, staffNote: 'kept' };
        db.order_queue[0].updated_at = stamp();
      }
    },
  });
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, priorLink: { accepted_count: 1 }, nowIso: '2026-09-20T09:00:00.000Z', match: false, extraCustomer: { resyncedAt: 'x' } });
  assert.equal(w.ok, true);
  assert.equal(w.attempts, 2, 'the first guarded write matched nothing, so it was planned again');
  const updates = sb.log.filter((l) => l.table === 'order_queue' && l.op === 'update');
  assert.ok(updates.every((u) => 'updated_at' in u.eqs), 'no unguarded update');
  // A flag write touches only its own key, on the row as it is now.
  const p = await patchCustomer(sb, PROVO, REF, (c) => ({ ...c, possibleReplacement: { ref: 'x' } }));
  assert.equal(p.written, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.customer.possibleReplacement.ref, 'x');
  assert.equal(row.customer.ezcater_lifecycle, 'accepted');
  // guardedUpdate on a stale read matches nothing.
  const g = await guardedUpdate(sb, PROVO, REF, { updated_at: 'stale' }, { status: 'cancelled' });
  assert.equal(g.matched, false);
  assert.notEqual(sb.db.order_queue[0].status, 'cancelled');
  // No write in the shared ingest replaces a customer jsonb read before a slow call.
  const ing = read('../../supabase/functions/_shared/ezcaterIngest.ts');
  assert.equal(/customer:\s*\{\s*\.\.\.\(cand\.customer/.test(ing), false);
  assert.equal(/customer:\s*\{\s*\.\.\.\(fresh\.customer/.test(ing), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// C. EARLIER PICKUP AND LONGER PREP ARE SEEN IN TIME
// ═════════════════════════════════════════════════════════════════════════════

test('C: a Dispatch pickup moved EARLIER is caught by the scheduled re-ask: fire now, flagged late', async () => {
  // Fires at 17:00Z. At 16:40Z the re-ask finds the pickup moved to 17:30Z: 17:30 minus 90 = 16:00.
  const sb = fakeDb(baseTables([heldRow()]));
  const earlier = ezOrder({ event: { ...ezOrder().event, orderType: 'THIRD_PARTY_DELIVERY', catererHandoffFoodTime: '2026-09-23T17:30:00Z' } });
  const nowIso = '2026-09-23T16:40:00.000Z';
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso, fetchFor: answers(earlier) });
  assert.equal(r.outcome, 'checked');
  assert.equal(r.late, true);
  assert.equal('dueNow' in r, false, 'round 4: a re-ask never tells the cron to fire (the till fires it)');
  const row = sb.db.order_queue[0];
  assert.equal(row.sent_at, nowIso, 'sent_at moves to now, so the till release fires it');
  assert.equal(row.kitchen_routed_at, null, 'the re-ask never fires itself');
  assert.equal(row.customer.lateFire.minutesLate, 40);
  assert.equal(row.customer.ezcaterRecheck.ok, true);
  assert.match(ezcaterOrderWarnings(row).join(' '), /Sent to the kitchen LATE: it should have started 40 minutes earlier/);
  const alert = cateringChangeAlert(row, heldRow());
  assert.match(alert.alert.message, /LATE/);
  // Reported once: the same late moment again is not a new alert.
  const again = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T16:42:00.000Z', fetchFor: answers(earlier) });
  assert.equal(again.late, false, 'round 4: nothing moved this time, so it is not a new late');
  assert.equal(sb.db.order_queue[0].customer.lateFire.at, nowIso, 'the first flag stays on the order');
});

test('C: a pickup moved LATER is re-timed ahead of the old fire time, not fired early', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const later = ezOrder({ event: { ...ezOrder().event, catererHandoffFoodTime: '2026-09-23T20:00:00Z' } });
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T12:00:00.000Z', fetchFor: answers(later) });
  assert.equal(r.late, false);
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T18:30:00.000Z');
  assert.equal(sb.db.order_queue[0].customer.lateFire, undefined);
});

test('C: the schedule re-asks due soon orders every 15 minutes and the week ahead once a day, bounded', async () => {
  const now = Date.parse('2026-09-23T12:00:00Z');
  const at = (ms) => new Date(ms).toISOString();
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 3600e3), customer: {} }, now), true, 'never re-asked');
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 3600e3), customer: { ezcaterRecheck: { at: at(now - 5 * 60e3) } } }, now), false, 'asked 5 minutes ago');
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 3600e3), customer: { ezcaterRecheck: { at: at(now - EZ_RECHECK_NEAR_EVERY_MS) } } }, now), true);
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 3 * 86400e3), customer: { ezcaterRecheck: { at: at(now - 3600e3) } } }, now), false, 'the week ahead: once a day');
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 3 * 86400e3), customer: { ezcaterRecheck: { at: at(now - 25 * 3600e3) } } }, now), true);
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 9 * 86400e3), customer: {} }, now), false, 'beyond a week: not yet');
  assert.equal(needsRecheck({ status: 'cancelled', sent_at: at(now + 3600e3), customer: {} }, now), false);
  assert.equal(needsRecheck({ status: 'received', sent_at: at(now + 3600e3), kitchen_routed_at: 'x', customer: {} }, now), false);

  // The batch runs in PARALLEL: five slow answers take about one answer's time, not five.
  const rows = [0, 1, 2, 3, 4].map((i) => ({ ...heldRow(), ref: `EZ-${i}`, sent_at: at(now + (i + 1) * 600e3), customer: { ...heldRow().customer, ezcater_order_id: `${i}` } }));
  const sb = fakeDb(baseTables(rows, {
    ezcater_order_links: rows.map((r, i) => ({ location_id: PROVO, ref: r.ref, ez_order_id: `${i}`, caterer_uuid: 'cat-pos-testing', accepted_count: 1 })),
  }));
  const started = Date.now();
  const out = await recheckUpcoming(sb, null, {
    nowIso: at(now), concurrency: 6, budgetMs: 5000,
    fetchFor: (a) => async () => { await new Promise((r) => setTimeout(r, 150)); return ezOrder({ uuid: a.ezOrderId }); },
  });
  assert.equal(out.length, 5);
  assert.ok(Date.now() - started < 600, 'parallel');
  assert.ok(out.every((r) => r.outcome === 'checked'));
  const q = sb.log.filter((l) => l.table === 'order_queue' && l.op === 'select' && l.ors.length);
  assert.ok(q.length >= 2, 'two windows');
  assert.ok(q.every((l) => /customer->ezcaterRecheck->>at\.is\.null/.test(l.ors[0])));
});

test('C: a longer prep time set later re-times held orders; one already past fires now, flagged late', async () => {
  const soon = heldRow();                                    // ready 18:30Z, fires 17:00Z on 90 min
  const later = { ...heldRow(), ref: 'EZ-later', customer: { ...heldRow().customer, readyAt: '2026-09-23T22:00:00.000Z', ezcater_order_id: 'later' } };
  const fired = { ...heldRow(), ref: 'EZ-fired', kitchen_routed_at: '2026-09-23T15:00:00Z' };
  const sb = fakeDb(baseTables([soon, later, fired], { catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 180 }] }));
  const nowIso = '2026-09-23T16:00:00.000Z';
  const r = await recomputePrepForVenue(sb, null, { locationId: PROVO, nowIso });
  assert.equal(r.retimed, 2);
  assert.equal(r.late, 1);
  const a = sb.db.order_queue.find((x) => x.ref === REF);
  assert.equal(a.sent_at, nowIso, '18:30 minus 180 = 15:30, already past: fire now');
  assert.equal(a.customer.prepMinutes, 180);
  assert.equal(a.customer.lateFire.fireAt, '2026-09-23T15:30:00.000Z');
  const b = sb.db.order_queue.find((x) => x.ref === 'EZ-later');
  assert.equal(b.sent_at, '2026-09-23T19:00:00.000Z', '22:00 minus 180');
  assert.equal(b.customer.fire_time, '20:00', 'on the venue clock');
  assert.equal(b.customer.lateFire, undefined);
  assert.equal(sb.db.order_queue.find((x) => x.ref === 'EZ-fired').customer.prepMinutes, 90, 'a fired order never moves');
  // Run again: nothing left to re-time.
  assert.equal((await recomputePrepForVenue(sb, null, { locationId: PROVO, nowIso })).retimed, 0);
  // Wired: Back Office after a save ONLY (round 4: the cron's automatic sweep is gone).
  assert.ok(read('../backoffice/sections/CateringSettings.jsx').includes('await ezcaterRecomputePrep(locId)'));
  assert.ok(read('../../supabase/functions/ezcater-connect/index.ts').includes("case 'recompute_prep': {"));
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.equal(cron.includes('recomputePrep'), false, 'no prep sweep in the cron');
  assert.ok(cron.indexOf('recheckUpcoming(sb, platform') < cron.indexOf(".from('order_queue')"));
});

test('C: the late plan and its words', () => {
  const was = '2026-09-23T17:00:00.000Z';
  assert.equal(lateFirePlan({ fireAt: '2026-09-23T17:00:00Z', prevFireAt: was, nowIso: '2026-09-23T17:00:30.000Z' }), null, 'under a minute is on time');
  const l = lateFirePlan({ fireAt: '2026-09-23T16:00:00.000Z', prevFireAt: was, nowIso: '2026-09-23T16:25:00.000Z' });
  assert.equal(l.minutesLate, 25);
  assert.equal(lateFirePlan({ fireAt: '2026-09-23T16:00:00.000Z', prevFireAt: was, nowIso: '2026-09-23T16:30:00.000Z', prevLate: l }), l, 'the same late moment is reported once');
  assert.match(lateFireText(l), /25 minutes earlier/);
  // A held (not accepted) order is not "late": it is held, and D says so instead.
  const { row } = orderToQueueRow(lifecycle('submitted'), PROVO, { venue: LONDON });
  const plan = ezcaterWritePlan({ row, existing: null, terminal: false, nowIso: '2026-09-23T17:30:00.000Z' });
  assert.equal(plan.row.customer.lateFire, undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// D. HELD ORDERS ARE RE-ASKED
// ═════════════════════════════════════════════════════════════════════════════

const submittedTables = (row) => baseTables([row], { ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 0 }] });

test('D: a held order whose accepted notification was missed is re-asked and released', async () => {
  const sb = fakeDb(submittedTables(heldRow({}, lifecycle('submitted'))));
  // The release never reads held rows, so without the schedule it would never be asked again.
  assert.equal(cateringHoldReason(sb.db.order_queue[0]), 'awaiting_ezcater_acceptance');
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:05:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.lifecycle, 'accepted');
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:05:00.000Z', 'released and due: sent_at is now, the till fires it');
  assert.equal(sb.db.order_queue[0].kitchen_routed_at, null, 'the re-ask never fires');
  assert.equal(cateringHoldReason(sb.db.order_queue[0]), null);
});

test('D: a held order still NOT accepted as it nears its fire time is shown to staff, once', async () => {
  const sb = fakeDb(submittedTables(heldRow({}, lifecycle('submitted'))));
  const nowIso = '2026-09-23T16:45:00.000Z';                // 15 minutes before 17:00Z
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso, fetchFor: answers(lifecycle('submitted')) });
  assert.equal(r.unaccepted, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.customer.unacceptedAlert.fireAt, '2026-09-23T17:00:00.000Z');
  assert.match(ezcaterOrderWarnings(row).join(' '), /Still NOT accepted on ezCater/);
  const alert = cateringChangeAlert(row, heldRow({}, lifecycle('submitted')));
  assert.match(alert.alert.message, /Not accepted on ezCater yet/);
  // Asked again 15 minutes later: the same fire moment, no new stamp, no new alert.
  await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:01:00.000Z', fetchFor: answers(lifecycle('submitted')) });
  assert.equal(sb.db.order_queue[0].customer.unacceptedAlert.at, nowIso);
  // Far from its fire time: nothing to say yet.
  assert.equal(unacceptedAlertFor(heldRow({}, lifecycle('submitted')), Date.parse('2026-09-22T12:00:00Z'), 'x'), null);
});

test('D: ezCater unreachable for a held order near its fire time: still shown to staff, and the attempt recorded', async () => {
  const sb = fakeDb(submittedTables(heldRow({}, lifecycle('submitted'))));
  const r = await recheckOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T16:50:00.000Z', timeoutMs: 20, fetchFor: () => () => new Promise(() => {}) });
  assert.equal(r.outcome, 'unreachable');
  assert.equal(r.unaccepted, true);
  const c = sb.db.order_queue[0].customer;
  assert.equal(c.ezcaterRecheck.ok, false);
  assert.ok(c.unacceptedAlert);
});

// ═════════════════════════════════════════════════════════════════════════════
// E. THE CLAIM CHECKS STATUS
// ═════════════════════════════════════════════════════════════════════════════

/** Evaluate the claim's conditions on a row, the way PostgREST reads them. */
function claimMatches(row) {
  const blocked = UNCLAIMABLE_STATUSES_PG.replace(/[()]/g, '').split(',');
  const inList = releasableOrFilter().match(/ezcater_lifecycle\.in\.\(([^)]+)\)/)[1].split(',');
  const life = row.customer?.ezcater_lifecycle ?? null;
  const releasable = row.source !== 'ezcater' || life === null || inList.includes(life);
  return row.kitchen_routed_at == null && !blocked.includes(row.status) && releasable;
}

test('E: the claim matches only a releasable, unfired row, and agrees with the release rule', () => {
  const base = heldRow();
  assert.equal(claimMatches(base), true);
  assert.equal(claimMatches({ ...base, status: 'cancelled' }), false, 'a cancel that landed after the decision');
  assert.equal(claimMatches({ ...base, status: 'collected' }), false);
  assert.equal(claimMatches({ ...base, customer: { ...base.customer, ezcater_lifecycle: 'submitted' } }), false, 'held');
  assert.equal(claimMatches({ ...base, kitchen_routed_at: 'x' }), false);
  for (const r of [base, { ...base, status: 'cancelled' }, { ...base, customer: { ...base.customer, ezcater_lifecycle: 'submitted' } }, { source: 'kiosk', status: 'received', customer: {} }]) {
    assert.equal(claimMatches(r), cateringMayFire(r) && r.kitchen_routed_at == null, JSON.stringify(r.status));
  }
});

test('E: both kitchen_routed_at claims carry the status conditions in the SAME update', () => {
  const store = read('../store/index.js');
  const claim = store.slice(store.indexOf(".update({ kitchen_routed_at: new Date().toISOString() })"), store.indexOf(".select('ref, type');"));
  assert.ok(claim.includes(".is('kitchen_routed_at', null)"));
  assert.ok(claim.includes(".not('status', 'in', UNCLAIMABLE_STATUSES_PG)"));
  assert.ok(claim.includes('.or(releasableOrFilter())'));
  const cron = read('../../supabase/functions/catering-release/index.ts');
  const c = cron.slice(cron.indexOf(".update({ kitchen_routed_at: new Date().toISOString() })"), cron.indexOf(".select('ref, type, items, customer');"));
  assert.ok(c.includes(".is('kitchen_routed_at', null)"));
  assert.ok(c.includes(".not('status', 'in', UNCLAIMABLE_STATUSES_PG)"));
  assert.ok(c.includes('.or(releasableOrFilter())'));
  assert.equal(UNCLAIMABLE_STATUSES_PG, '(cancelled,canceled,collected)');
});

test('E: a forced re-send and the Orders Hub never fire a cancelled or held order', () => {
  const store = read('../store/index.js');
  assert.ok(store.includes("if (hold === 'cancelled' || hold === 'awaiting_ezcater_acceptance') {"), 'Send to kitchen again refuses them');
  const now = store.slice(store.indexOf('releaseCateringOrderNow: async (o) => {'), store.indexOf('releaseCateringOrderNow: async (o) => {') + 2500);
  assert.ok(now.includes('const hold = cateringHoldReason(o);'));
  assert.ok(now.indexOf('ezcaterPrefire(locId, o.ref)') < now.indexOf('routeKioskOrderPrints?.('), 'ezCater re-asked first');
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.ok(hub.includes('releaseCateringOrderNow?.(o)'));
  const hubFire = hub.slice(hub.indexOf('A pay-later CATERING order opened for payment'), hub.indexOf('Walk-in / takeaway / delivery / counter order'));
  assert.equal(hubFire.includes('routeKioskOrderPrints?.('), false, 'no direct fire left there');
});

// ═════════════════════════════════════════════════════════════════════════════
// F. AUTHORITY
// ═════════════════════════════════════════════════════════════════════════════

test('F: staff means super_admin, a user_locations row, or a company role that grants it; never user_profiles.location_id', async () => {
  const PLATFORM_LOC = 'plat-loc-1';
  const sb = fakeDb({
    user_profiles: [{ id: 'forged', role: 'manager', location_id: PROVO, org_id: 'co-1' }, { id: 'sa', role: 'super_admin' }],
    user_locations: [{ user_id: 'ul', location_id: PROVO }],
  });
  const platform = fakeDb({
    locations: [{ id: PLATFORM_LOC, ops_location_id: PROVO, company_id: 'co-1' }],
    user_company_roles: [{ user_id: 'owner', company_id: 'co-1', role: 'admin' }, { user_id: 'viewer', company_id: 'co-1', role: 'viewer' }],
  });
  assert.equal(await staffForLocation(sb, platform, { id: 'forged' }, PROVO), false, 'a profile anyone can write proves nothing');
  assert.equal(await staffForLocation(sb, platform, { id: 'sa' }, PROVO), true);
  assert.equal(await staffForLocation(sb, platform, { id: 'ul' }, PROVO), true);
  assert.equal(await staffForLocation(sb, platform, { id: 'owner' }, PROVO), true);
  assert.equal(await staffForLocation(sb, platform, { id: 'viewer' }, PROVO), false, 'a role that does not grant it');
  assert.equal(await staffForLocation(sb, platform, { id: 'sa', is_anonymous: true }, PROVO), false);
  assert.ok(GRANTING_COMPANY_ROLES.includes('admin'));
  // The till arm (resync, undo) is a paired device plus an active staff PIN: no user_profiles.
  const till = fakeDb({ devices: [{ id: 'd1', device_uid: 'till-1', location_id: PROVO, status: 'active' }], staff_members: [{ id: 's1', location_id: PROVO, pin: '1234', active: true }] });
  assert.deepEqual(await staffActor(till, null, { id: 'till-1', is_anonymous: true }, PROVO, '1234'), { ok: true, by: 'staff:s1', name: null });
  const src = read('../../supabase/functions/_shared/staffAuthority.ts');
  assert.equal(/select\('role, location_id'\)/.test(src), false, 'location_id is not even read');
});

test('F: the ezCater token is only ever the caterer\'s own connection, never another company\'s', async () => {
  const sb = fakeDb(baseTables([heldRow()], {
    ezcater_caterers: [{ caterer_uuid: 'cat-pos-testing', location_id: PROVO, connection_id: null, active: true }],
    ezcater_connections: [{ id: 'other-co', api_token: 'THEIR-TOKEN', status: 'connected', connected_at: '2026-01-01T00:00:00Z' }],
  }));
  const a = await ezcaterAccessFor(sb, PROVO, REF, sb.db.order_queue[0]);
  assert.equal(a.ok, false);
  assert.match(a.why, /not connected for this caterer/);
  // The pre fire check then fires as planned, flagged: it never borrowed THEIR-TOKEN.
  let asked = false;
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor: () => async () => { asked = true; return ezOrder(); } });
  assert.equal(asked, false);
  assert.equal(r.fire, true);
  assert.equal(r.checked, false);
});

test('F: ezcater-connect config actions are fenced to the venue\'s own company', () => {
  const s = read('../../supabase/functions/ezcater-connect/index.ts');
  // Round 4: the lookup lives in _shared/ezcaterConnections.ts, filtered by company in the query
  // (tested for behaviour in ezcaterRound4.test.js).
  const fn = read('../../supabase/functions/_shared/ezcaterConnections.ts');
  assert.ok(fn.includes("if (!company) return null;"));
  assert.ok(s.includes('connectionForLocationOf(sb, platform, opsLocationId)'));
  assert.ok(s.includes('company_id: co.companyId,'), 'connect_token records the company');
  assert.ok(s.includes("That ezCater caterer is mapped to another venue. Unmap it there first."));
  assert.ok(s.includes("That ezCater caterer belongs to another ezCater connection."));
  assert.ok(s.includes(".is('location_id', null).eq('connection_id', conn.id)"), 'unmapped caterers of this company only');
  assert.ok(s.includes('if (!(await staffForLocation(sb, platform, user, opsLocationId)))'));
  const ing = read('../../supabase/functions/_shared/ezcaterIngest.ts');
  assert.equal(ing.includes(".eq('status', 'connected').order('connected_at'"), false, 'no token fallback in the shared ingest');
});

// ═════════════════════════════════════════════════════════════════════════════
// G. THE CRON SCALES, AND NO REVIEW SMS TO AN ezCater CUSTOMER
// ═════════════════════════════════════════════════════════════════════════════

test('G: runWithBudget runs jobs side by side and hands back the slow ones as skipped when the budget ends', async () => {
  const started = Date.now();
  const out = await runWithBudget([10, 10, 10, 10, 5000, 5000], (ms, i) => new Promise((r) => setTimeout(() => r(i), ms)), { concurrency: 6, budgetMs: 120 });
  assert.ok(Date.now() - started < 1000, 'bounded by the budget');
  assert.deepEqual(out.slice(0, 4).map((x) => x.value), [0, 1, 2, 3]);
  assert.equal(out[4].skipped, true);
  assert.equal(out[5].skipped, true);
  // Jobs never started because the budget ended are skipped too, in order.
  const few = await runWithBudget([200, 200, 200], (ms) => new Promise((r) => setTimeout(r, ms)), { concurrency: 1, budgetMs: 100 });
  assert.deepEqual(few.map((x) => !!x.skipped), [true, true, true]);
  const err = await runWithBudget([1], async () => { throw new Error('boom'); }, { budgetMs: 100 });
  assert.equal(err[0].ok, false);
  assert.equal(err[0].error, 'boom');
  assert.deepEqual(await runWithBudget([], async () => 1), []);
});

test('G: the cron re-asks in parallel inside one budget and fires every unreached order unchecked, flagged', async () => {
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.ok(cron.includes('await runWithBudget(needCheck, (r: any) => prefireCheck(sb, platform, { locationId: r.location_id, ref: r.ref, log }),'));
  assert.ok(cron.includes('{ concurrency: PREFIRE_CONCURRENCY, budgetMs: PREFIRE_BUDGET_MS }'));
  // Round 4: the flag is written in fireOne, inside the fire budget and in parallel.
  assert.ok(cron.includes('const f = await flagUnchecked(sb, row.location_id, row.ref, row._uncheckedWhy, nowIso);'));
  assert.equal(/for \(let row of \(data \|\| \[\]\)\) \{[\s\S]*await prefireCheck/.test(cron), false, 'no serial re-ask loop');
  // The flag itself: only ezcaterCheck, only while unfired.
  const sb = fakeDb(baseTables([heldRow()]));
  const f = await flagUnchecked(sb, PROVO, REF, 'the ServOS check ran out of time before ezCater answered', '2026-09-23T17:03:00.000Z');
  assert.equal(f.written, true);
  assert.equal(sb.db.order_queue[0].customer.ezcaterCheck.ok, false);
  assert.match(ezcaterOrderWarnings(sb.db.order_queue[0]).join(' '), /ran out of time/);
  const fired = fakeDb(baseTables([heldRow({ kitchen_routed_at: '2026-09-23T17:00:05Z' })]));
  assert.equal((await flagUnchecked(fired, PROVO, REF, 'x', 'y')).written, false);
});

test('G: no review ask to an ezCater customer, by source or by the ezCater id on a till check', () => {
  assert.equal(mayMessageCustomer({ source: 'ezcater', customer: {} }), false);
  assert.equal(mayMessageCustomer({ source: 'pos', customer: { ezcater_order_id: UUID, phone: '5555550100' } }), false);
  assert.equal(mayMessageCustomer({ source: 'pos', customer: { phone: '07700900000' } }), true);
  const s = read('../../supabase/functions/review-request/index.ts');
  assert.ok(s.includes("import { mayMessageCustomer } from '../_shared/cateringRules.js';"));
  assert.ok(s.includes(".select('id, source, customer, customer_phone, total, closed_at')"));
  assert.ok(s.indexOf('if (!mayMessageCustomer({ source: c.source, customer: c.customer })) continue;') < s.indexOf('const phone = c.customer_phone'));
  // Closing an ezCater order today writes NO closed_checks row with its phone: ezCater is prepaid,
  // so the Orders Hub opens it read only (PREPAID_CHANNELS), and the only channel booking is HubRise.
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.ok(hub.includes("const PREPAID_CHANNELS = ['online', 'kiosk', 'ezcater'];"));
  assert.ok(hub.includes('else if (isOrderPaid(o)) { setViewOrder(o); }'));
  assert.ok(read('../store/index.js').includes("if (!o || o.source !== 'hubrise' || !supabase || isTrainingMode()) return;"));
});

test('round 3 files are free of dashes and the committed list matches', () => {
  const plan = read('../../supabase/functions/_shared/ezcaterCatering.js');
  const m = plan.match(/const COMMITTED = \[([^\]]+)\]/)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(m.sort(), [...EZ_COMMITTED].sort(), 'the write plan and the release agree on committed');
  for (const rel of [
    '../../supabase/functions/_shared/ezcaterIngest.ts', '../../supabase/functions/_shared/ezcaterCatering.js',
    '../../supabase/functions/_shared/staffAuthority.ts', '../../supabase/functions/_shared/cateringRules.js',
    '../../supabase/functions/_shared/budget.js', '../../supabase/functions/ezcater-connect/index.ts',
    '../../supabase/functions/catering-release/index.ts', '../../supabase/functions/review-request/index.ts',
    '../../supabase/functions/_shared/ezcater-map.ts', './cateringAlerts.js', './ezcaterRound3.test.js',
  ]) {
    const s = read(rel);
    const newLines = s.split('\n').filter((l) => /round 3|Round 3|review round 3/.test(l));
    for (const l of newLines) assert.equal(l.includes(String.fromCharCode(0x2013)) || l.includes(String.fromCharCode(0x2014)), false, `${rel}: ${l}`);
  }
  for (const rel of ['../../supabase/functions/_shared/ezcaterIngest.ts', '../../supabase/functions/_shared/ezcaterCatering.js', '../../supabase/functions/_shared/budget.js', '../../supabase/functions/catering-release/index.ts', './ezcaterRound3.test.js']) {
    const s = read(rel);
    assert.equal(s.includes(String.fromCharCode(0x2013)) || s.includes(String.fromCharCode(0x2014)), false, `${rel} has a dash`);
  }
});
