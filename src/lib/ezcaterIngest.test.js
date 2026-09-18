/**
 * ezcaterIngest.test.js: the second review round on "ezCater orders follow the catering rules".
 * Run: `npm test`, or `node --test src/lib/ezcaterIngest.test.js`.
 *
 * Peter, 18 Sep 2026: "we need to ensure they follow the same rules as the rest of our catering
 * system where they hit the POS at the right times and parameters set to fire into the kitchen
 * as our own catering orders". The reviewers found seven ways that could still go wrong. Each
 * has its test here, against the real shared code and an in memory stand in for Supabase:
 *
 *   1. UNCANCEL: cancelled, then uncancelled and accepted on ezCater, restores the held order
 *      with a fresh fire time (fire now if due); after firing, staff are told plainly.
 *   2. REPLACEMENT: a new order that replaces a held one stops the original; the pre fire
 *      re-check fires anyway when ezCater does not answer in time.
 *   3. NO CATERING PREP SET: the 60 minute fallback, a warning on the Connect screen and on the
 *      order, never 0.
 *   4. RE-SYNC: repairs the live HKX77V row and never moves a fired order.
 *   5. LEFTOVERS: the cron never reads held rows and has a floor, a cancelled unfired order stays
 *      out of the live queue, the read then write race cannot silently change a fired order, a
 *      time change is judged against the order's own last ezCater time, capacity never converts.
 *   6. Staff only means staff: the Back Office rule, or a till plus a staff PIN.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  readCateringVenue, writeEzcaterOrder, prefireCheck, resyncOrder, checkReplacements,
  fetchOrderWithin, carryMatchedItems, EZ_PREFIRE_TIMEOUT_MS,
} from '../../supabase/functions/_shared/ezcaterIngest.ts';
import { orderToQueueRow, queuePayload } from '../../supabase/functions/_shared/ezcater-map.ts';
import {
  ezcaterWritePlan, prefireOutcome, likelyReplacement, ezcaterOrderWarnings, changedAfterFireText,
} from '../../supabase/functions/_shared/ezcaterCatering.js';
import {
  cateringHoldReason, cateringMayFire, releasableOrFilter, CATERING_STALE_FLOOR_MS,
  EZ_PREP_FALLBACK_MINUTES, cateringPrepSetting, ezcaterPrepFor, keptOutOfLiveQueue,
  liveQueueOrFilter, cateringDayLoad, advanceListStatus,
} from './cateringRules.js';
import { staffForLocation, staffActor } from '../../supabase/functions/_shared/staffAuthority.ts';
import { cateringPrepWarning } from './ezcaterSettings.js';
import { cateringChangeAlert } from './cateringAlerts.js';
import { STALE_ORDER_FLOOR_MS } from '../sync/staleness.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

// ── An in memory Supabase, just the query shapes the shared code uses ────────

function fakeDb(tables, hooks = {}) {
  const db = JSON.parse(JSON.stringify(tables));
  const log = [];
  const from = (table) => {
    const st = { table, op: 'select', filters: [], payload: null, single: false, lim: null, returning: false, opts: null, isNullOn: [] };
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
        else rows.push({ ...st.payload });
      } else if (st.op === 'update') {
        if (hooks.beforeUpdate) hooks.beforeUpdate(st, db);
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(st.payload)));
        data = st.returning ? hit.map((r) => ({ ref: r.ref })) : null;
      } else if (st.op === 'upsert') {
        const keys = String(st.opts?.onConflict || 'id').split(',');
        const found = rows.find((r) => keys.every((k) => r[k] === st.payload[k]));
        if (found) Object.assign(found, st.payload); else rows.push({ ...st.payload });
      }
      log.push({ table, op: st.op, payload: st.payload, isNullOn: st.isNullOn });
      return { data, error };
    };
    const api = {
      select() { if (st.op === 'select') return api; st.returning = true; return api; },
      insert(p) { st.op = 'insert'; st.payload = p; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return api; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
      neq(c, v) { st.filters.push((r) => r[c] !== v); return api; },
      is(c, v) { if (v === null) st.isNullOn.push(c); st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, vs) { st.filters.push((r) => vs.includes(r[c])); return api; },
      not(c, op, v) {
        if (op === 'in') { const vs = String(v).replace(/[()]/g, '').split(','); st.filters.push((r) => !vs.includes(r[c])); }
        if (op === 'is') st.filters.push((r) => r[c] != null);
        return api;
      },
      gte(c, v) { st.filters.push((r) => r[c] >= v); return api; },
      lte(c, v) { st.filters.push((r) => r[c] <= v); return api; },
      or() { return api; }, order() { return api; },
      limit(n) { st.lim = n; return api; },
      maybeSingle() { st.single = true; return run(); },
      single() { st.single = true; return run(); },
      then(ok, bad) { return run().then(ok, bad); },
    };
    return api;
  };
  return { from, db, log };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROVO = '7218c716-eeb4-4f96-b284-f3500823595c';
const LONDON = { timeZone: 'Europe/London', prepMinutes: 90, prepFallback: false };
const money = (subunits) => ({ subunitsV2: String(subunits), currency: 'USD' });
const UUID = 'eff5588f-1013-40f7-ae24-77febe448deb';
const REF = `EZ-${UUID}`;

// HKX77V, the live test order: a DELIVERY at 2026-09-23T18:30:00Z (19:30 in London).
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

const baseTables = (queueRows = [], extra = {}) => ({
  order_queue: queueRows,
  ezcater_order_links: [{ location_id: PROVO, ref: REF, ez_order_id: UUID, caterer_uuid: 'cat-pos-testing', accepted_count: 1, event_at: '2026-09-18T16:00:00Z' }],
  ezcater_caterers: [{ caterer_uuid: 'cat-pos-testing', location_id: PROVO, connection_id: 'conn-1', active: true }],
  ezcater_connections: [{ id: 'conn-1', api_token: 'tok', api_url: null, status: 'connected', connected_at: '2026-09-17T00:00:00Z' }],
  catering_site_settings: [{ location_id: PROVO, prep_time_minutes: 90 }],
  locations: [{ id: PROVO, timezone: 'Europe/London' }],
  ...extra,
});

/** A row as the webhook writes a held order today. */
const heldRow = (over = {}) => {
  const { row } = orderToQueueRow(ezOrder(), PROVO, { venue: LONDON, priorAcceptedCount: 0 });
  const p = queuePayload(row, true, '2026-09-18T16:00:00.000Z');
  return { ...p, kitchen_routed_at: null, ...over };
};

const answers = (order) => () => async () => order;

// ── 1. UNCANCEL ──────────────────────────────────────────────────────────────

test('uncancel: a cancelled, unfired order that ezCater accepts again is RESTORED with a fresh fire time', () => {
  const cancelled = heldRow({ status: 'cancelled' });
  const { row } = orderToQueueRow(ezOrder({ event: { ...ezOrder().event, timestamp: '2026-09-23T20:00:00Z' } }), PROVO, { venue: LONDON, priorAcceptedCount: 1 });
  const plan = ezcaterWritePlan({ row, existing: cancelled, terminal: false, nowIso: '2026-09-20T09:00:00.000Z' });
  assert.equal(plan.restored, true);
  assert.equal(plan.row.status, 'received');
  assert.equal(plan.reschedule, true);
  const p = queuePayload(plan.row, false, '2026-09-20T09:00:00.000Z', { reschedule: plan.reschedule });
  assert.equal(p.sent_at, '2026-09-23T18:30:00.000Z', '20:00Z ready minus 90 minutes');
  assert.equal(p.collection_time, '21:00');
  // The release and the advance list take it again.
  assert.equal(cateringMayFire(plan.row), true);
  assert.equal(advanceListStatus({ ...p, kitchen_routed_at: null }), 'Scheduled');
});

test('uncancel: restored when already due fires NOW, never left behind', async () => {
  const sb = fakeDb(baseTables([heldRow({ status: 'cancelled' })]));
  const nowIso = '2026-09-23T17:30:00.000Z';   // the fire time (17:00Z) has passed
  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue: LONDON, priorLink: { accepted_count: 1 }, nowIso, match: false });
  assert.equal(w.ok, true);
  const stored = sb.db.order_queue[0];
  assert.equal(stored.status, 'received');
  assert.equal(stored.sent_at, nowIso, 'fire now if due');
  assert.equal(stored.customer.restoredAt, nowIso);
  assert.equal(cateringHoldReason(stored), null);
});

test('uncancel AFTER the kitchen had it: nothing moves, and staff are told plainly', () => {
  const firedCancelled = heldRow({ status: 'cancelled', kitchen_routed_at: '2026-09-23T17:00:05Z' });
  const { row } = orderToQueueRow(ezOrder(), PROVO, { venue: LONDON, priorAcceptedCount: 1 });
  const plan = ezcaterWritePlan({ row, existing: firedCancelled, terminal: false, nowIso: '2026-09-23T17:10:00.000Z' });
  assert.equal(plan.reschedule, false);
  assert.equal(plan.row.status, 'prep');
  assert.ok(plan.changedAfterFire.kinds.includes('uncancelled'));
  assert.match(changedAfterFireText(plan.changedAfterFire), /uncancelled \(it was cancelled, it is back on\)/);
  assert.equal('sent_at' in queuePayload(plan.row, false, '2026-09-23T17:10:00.000Z', { reschedule: plan.reschedule }), false);
});

// ── 2. CANCELLED FOR REPLACEMENT, and the pre fire re-check ─────────────────

const REPL_UUID = '11111111-2222-3333-4444-555555555555';
const replacement = () => ezOrder({ uuid: REPL_UUID, orderNumber: 'NEW01' });

test('replacement: likelyReplacement needs the same contact, place, type and time, never just the same day', () => {
  const orig = heldRow();
  const newRow = orderToQueueRow(replacement(), PROVO, { venue: LONDON }).row;
  assert.equal(likelyReplacement(newRow, orig), true);
  // Breakfast and lunch for one office are two real orders.
  const lunch = orderToQueueRow(ezOrder({ uuid: REPL_UUID, event: { ...ezOrder().event, timestamp: '2026-09-23T23:30:00Z' } }), PROVO, { venue: LONDON }).row;
  assert.equal(likelyReplacement(lunch, orig), false);
  const otherPhone = orderToQueueRow(ezOrder({ uuid: REPL_UUID, event: { ...ezOrder().event, contact: { name: 'Peter Test', phone: '5555550199' } } }), PROVO, { venue: LONDON }).row;
  assert.equal(likelyReplacement(otherPhone, orig), false);
  assert.equal(likelyReplacement(newRow, { ...orig, status: 'cancelled' }), false);
});

test('replacement: a new order that replaces a held one STOPS the original (ezCater says the original is cancelled)', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const nowIso = '2026-09-20T09:00:00.000Z';
  const w = await writeEzcaterOrder(sb, { order: replacement(), locationId: PROVO, venue: LONDON, nowIso, match: false });
  assert.equal(w.ok, true);
  const asked = [];
  const found = await checkReplacements(sb, {
    locationId: PROVO, newRow: w.plan.row, venue: LONDON, nowIso,
    fetchFor: (a) => async () => { asked.push(a.ezOrderId); return ezOrder({ lifecycle: { orderIsCurrently: 'cancelled' } }); },
  });
  assert.deepEqual(asked, [UUID], 'the ORIGINAL is re-asked, by its own id');
  assert.deepEqual(found.map((f) => f.outcome), ['replaced']);
  const orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.status, 'cancelled');
  assert.equal(orig.customer.replacedBy.ref, `EZ-${REPL_UUID}`);
  assert.equal(orig.customer.replacedBy.orderNumber, 'NEW01');
  assert.equal(cateringMayFire(orig), false, 'the release never fires it');
  assert.match(ezcaterOrderWarnings(orig)[0], /Replaced on ezCater by order NEW01\. Not sent to the kitchen\./);
  // It stays stopped: a stray later answer for the original cannot bring it back.
  const late = ezcaterWritePlan({ row: orderToQueueRow(ezOrder(), PROVO, { venue: LONDON, priorAcceptedCount: 1 }).row, existing: orig, terminal: false, nowIso });
  assert.equal(late.row.status, 'cancelled');
  assert.equal(late.reschedule, false);
});

test('replacement AFTER the kitchen had the original: nothing moves, staff told to make the new one, not both', () => {
  const fired = heldRow({ kitchen_routed_at: '2026-09-23T17:00:05Z' });
  const { row } = orderToQueueRow(ezOrder({ lifecycle: { orderIsCurrently: 'cancelled_for_replacement' } }), PROVO, { venue: LONDON });
  const plan = ezcaterWritePlan({ row: { ...row, customer: { ...row.customer, replacedBy: { ref: 'EZ-new', orderNumber: 'NEW01' } } }, existing: fired, terminal: true, nowIso: '2026-09-23T17:10:00.000Z' });
  assert.deepEqual(plan.changedAfterFire.kinds, ['replaced']);
  assert.match(changedAfterFireText(plan.changedAfterFire), /Replaced on ezCater by order NEW01 after it went to the kitchen: make the new order, not both/);
  assert.equal(cateringChangeAlert({ ...fired, customer: plan.row.customer, status: 'cancelled' }, fired).alert.kind, 'cancel');
});

test('replacement: ezCater still lists the original as live, so both are FLAGGED and neither is stopped', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const nowIso = '2026-09-20T09:00:00.000Z';
  const w = await writeEzcaterOrder(sb, { order: replacement(), locationId: PROVO, venue: LONDON, nowIso, match: false });
  const found = await checkReplacements(sb, { locationId: PROVO, newRow: w.plan.row, venue: LONDON, nowIso, fetchFor: answers(ezOrder()) });
  assert.deepEqual(found.map((f) => f.outcome), ['flagged']);
  const orig = sb.db.order_queue.find((r) => r.ref === REF);
  assert.equal(orig.status, 'received');
  assert.equal(orig.customer.possibleReplacement.orderNumber, 'NEW01');
  assert.match(ezcaterOrderWarnings(orig)[0], /ezCater still lists this one as accepted: check it is not a replacement/);
  // The flag survives the next write of the original (the customer jsonb is rewritten whole).
  const again = ezcaterWritePlan({ row: orderToQueueRow(ezOrder(), PROVO, { venue: LONDON, priorAcceptedCount: 1 }).row, existing: orig, terminal: false, nowIso });
  assert.equal(again.row.customer.possibleReplacement.orderNumber, 'NEW01');
});

test('pre fire re-check: ezCater cancelled it since the last notification, so it is NOT fired', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor: answers(ezOrder({ lifecycle: { orderIsCurrently: 'cancelled' } })) });
  assert.equal(r.fire, false);
  assert.equal(r.outcome, 'cancelled');
  assert.equal(sb.db.order_queue[0].status, 'cancelled');
  assert.equal(sb.db.order_queue[0].kitchen_routed_at, null, 'the check never claims: the release does');
});

test('pre fire re-check: a moved Dispatch pickup (catererHandoffFoodTime) reschedules instead of firing early', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const later = ezOrder({ event: { ...ezOrder().event, orderType: 'THIRD_PARTY_DELIVERY', catererHandoffFoodTime: '2026-09-23T19:15:00Z' } });
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor: answers(later) });
  assert.equal(r.fire, false);
  assert.equal(r.outcome, 'rescheduled');
  assert.equal(sb.db.order_queue[0].sent_at, '2026-09-23T17:45:00.000Z', '19:15Z pickup minus 90 minutes');
  assert.ok(sb.db.ezcater_order_links[0].requeried_at, 'requeried_at is stamped');
});

test('pre fire re-check: ezCater unchanged, so it fires with the fresh row and says it checked', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.fire, true);
  assert.equal(r.checked, true);
  assert.equal(r.row.items[0].name, 'Sandwich Tray');
  assert.equal(sb.db.order_queue[0].customer.ezcaterCheck.ok, true);
  assert.equal(sb.db.ezcater_order_links[0].accepted_count, 1, 'a re-ask is not a new accepted');
});

test('pre fire re-check NEVER blocks the kitchen: ezCater times out, the order fires as planned and is flagged', async () => {
  const sb = fakeDb(baseTables([heldRow()]));
  const started = Date.now();
  const r = await prefireCheck(sb, null, {
    locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', timeoutMs: 40,
    fetchFor: () => () => new Promise(() => {}),   // ezCater never answers
  });
  assert.ok(Date.now() - started < 2000, 'bounded by the timeout');
  assert.equal(r.fire, true);
  assert.equal(r.checked, false);
  assert.match(r.why, /did not answer in time/);
  const stored = sb.db.order_queue[0];
  assert.equal(stored.customer.ezcaterCheck.ok, false);
  assert.match(ezcaterOrderWarnings(stored).join(' '), /could not be reached to re-check this order/);
  assert.equal(stored.status, 'received', 'nothing else about the order changed');
  assert.ok(EZ_PREFIRE_TIMEOUT_MS <= 5000, 'the real timeout is short');
});

test('pre fire re-check fires as planned on an ezCater error, on no token, and on a thrown fetch', async () => {
  for (const [label, tables, fetchFor] of [
    ['error', baseTables([heldRow()]), () => async () => { throw new Error('502 Bad Gateway'); }],
    ['no token', baseTables([heldRow()], { ezcater_connections: [{ id: 'conn-1', api_token: null, status: 'connected' }] }), answers(ezOrder())],
  ]) {
    const sb = fakeDb(tables);
    const r = await prefireCheck(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T17:00:30.000Z', fetchFor });
    assert.equal(r.fire, true, label);
    assert.equal(r.checked, false, label);
  }
  const t = await fetchOrderWithin(() => new Promise(() => {}), 20);
  assert.equal(t.timedOut, true);
});

test('prefireOutcome: the release rules decide, and a held acceptance stays held', () => {
  const now = Date.parse('2026-09-23T17:00:30Z');
  assert.equal(prefireOutcome({ status: 'cancelled' }, now, cateringHoldReason), 'cancelled');
  assert.equal(prefireOutcome({ status: 'received', source: 'ezcater', customer: { ezcater_order_id: 'x', ezcater_lifecycle: 'submitted' } }, now, cateringHoldReason), 'awaiting_ezcater_acceptance');
  assert.equal(prefireOutcome({ status: 'received', fire_at: '2026-09-23T18:00:00Z' }, now, cateringHoldReason), 'rescheduled');
  assert.equal(prefireOutcome({ status: 'received', fire_at: '2026-09-23T17:00:00Z' }, now, cateringHoldReason), 'fire');
});

test('the till release and the cron both re-check ezCater before firing, and keep the one claim', () => {
  const store = read('../store/index.js');
  const body = store.slice(store.indexOf('releaseDueCateringOrders: async'), store.indexOf('fireCourse: (courseNum)'));
  assert.ok(body.includes('const pf = await ezcaterPrefire(locId, row.ref);'));
  assert.ok(body.indexOf('ezcaterPrefire(') < body.indexOf('routeKioskOrderPrints?.('), 'checked before it is routed');
  const lib = read('./ezcater.js');
  assert.ok(lib.includes("action: 'prefire'"));
  assert.ok(lib.includes("PREFIRE_AS_PLANNED('the ServOS check did not answer in time')"), 'the till fires as planned if the server is slow');
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.ok(cron.includes('const pf = await prefireCheck(sb, platform, {'));
  assert.ok(cron.indexOf('prefireCheck(') < cron.indexOf(".update({ kitchen_routed_at: new Date().toISOString() })"), 'checked before the claim');
  assert.ok(cron.includes(".is('kitchen_routed_at', null)"));
  // The check itself never writes kitchen_routed_at.
  const ing = read('../../supabase/functions/_shared/ezcaterIngest.ts');
  assert.equal(/kitchen_routed_at:\s*new Date/.test(ing), false);
});

// ── 3. NO CATERING PREP SET ─────────────────────────────────────────────────

test('no catering prep time set: the 60 minute fallback, never 0, and the order says so', async () => {
  assert.equal(EZ_PREP_FALLBACK_MINUTES, 60);
  assert.deepEqual(cateringPrepSetting(null), { minutes: 0, isSet: false });
  assert.deepEqual(cateringPrepSetting({ prep_time_minutes: '' }), { minutes: 0, isSet: false });
  assert.deepEqual(cateringPrepSetting({ prep_time_minutes: 0 }), { minutes: 0, isSet: true }, 'a saved 0 is a real choice');
  assert.deepEqual(ezcaterPrepFor(null), { prepMinutes: 60, prepFallback: true, prepSource: 'fallback' });
  assert.deepEqual(ezcaterPrepFor({ prep_time_minutes: 45 }), { prepMinutes: 45, prepFallback: false, prepSource: 'catering_settings' });

  const sb = fakeDb(baseTables([], { catering_site_settings: [] }));
  const venue = await readCateringVenue(sb, null, PROVO);
  assert.equal(venue.prepMinutes, 60);
  assert.equal(venue.prepFallback, true);
  assert.equal(venue.timeZone, 'Europe/London');

  const w = await writeEzcaterOrder(sb, { order: ezOrder(), locationId: PROVO, venue, nowIso: '2026-09-20T09:00:00.000Z', match: false });
  const stored = sb.db.order_queue[0];
  assert.equal(stored.sent_at, '2026-09-23T17:30:00.000Z', '18:30Z minus the 60 minute fallback, not 18:30Z');
  assert.equal(stored.customer.prepFallback, true);
  assert.match(ezcaterOrderWarnings(stored)[0], /No catering prep time is set for this venue, so the kitchen was timed with 60 minutes/);
  assert.ok(w.ok);

  // The Connect screen warns until the venue sets one.
  assert.match(cateringPrepWarning({ catering_prep: { set: false, minutes: null, fallback_minutes: 60 } }), /No catering prep time is set/);
  assert.equal(cateringPrepWarning({ catering_prep: { set: true, minutes: 45 } }), null);
  assert.equal(cateringPrepWarning({}), null);
  const connect = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.ok(connect.includes('catering_prep: cateringPrep,'));
  assert.ok(read('../backoffice/sections/EzcaterSettings.jsx').includes('cateringPrepWarning(answer)'));
  const webhook = read('../../supabase/functions/ezcater-webhook/index.ts');
  assert.ok(webhook.includes('NO CATERING PREP TIME SET'));
});

// ── 4. RE-SYNC FROM EZCATER ─────────────────────────────────────────────────

// The live HKX77V row as the old webhook wrote it: 'prep', sent_at at the delivery time, the time
// on the caterer's clock (14:30 New York), never fired.
const hkx77vAsWritten = () => ({
  ref: REF, location_id: PROVO, source: 'ezcater', type: 'delivery', status: 'prep',
  sent_at: '2026-09-23T18:30:00.000Z', kitchen_routed_at: null,
  event_date: '2026-09-23', collection_time: '14:30', total: 41.31, paid: true,
  items: [{ name: 'Sandwich Tray', qty: 1, itemId: null, mods: [] }],
  customer: { name: 'Peter Test', event_date: '2026-09-23', event_time: '14:30', ezcater_order_id: UUID, ezcater_order_number: 'HKX77V', ezcater_caterer_id: 'cat-pos-testing', ezcater_lifecycle: 'accepted' },
});

test('re-sync repairs HKX77V: held, the venue clock, the catering fire time, requeried_at stamped', async () => {
  const sb = fakeDb(baseTables([hkx77vAsWritten()]));
  const r = await resyncOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-18T20:00:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.ok, true);
  assert.equal(r.fired, false);
  assert.equal(r.changed, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.status, 'received', 'the old prep was never cooking: nobody had it');
  assert.equal(row.sent_at, '2026-09-23T17:00:00.000Z', '19:30 London minus 90 minutes');
  assert.equal(row.collection_time, '19:30');
  assert.equal(row.event_date, '2026-09-23');
  assert.equal(row.customer.resyncedAt, '2026-09-18T20:00:00.000Z');
  assert.equal(row.kitchen_routed_at, null);
  const link = sb.db.ezcater_order_links[0];
  assert.equal(link.requeried_at, '2026-09-18T20:00:00.000Z');
  assert.equal(link.accepted_count, 1, 'a re-sync is not a modification');
  assert.equal(link.event_at, '2026-09-18T16:00:00Z', 'the notification history is untouched');
  assert.match(r.message, /goes to the kitchen at 18:00/);
});

test('re-sync NEVER moves an order that already fired', async () => {
  const fired = { ...hkx77vAsWritten(), kitchen_routed_at: '2026-09-23T18:30:05Z', customer: { ...hkx77vAsWritten().customer } };
  const sb = fakeDb(baseTables([fired]));
  const r = await resyncOrder(sb, null, { locationId: PROVO, ref: REF, nowIso: '2026-09-23T18:40:00.000Z', fetchFor: answers(ezOrder()) });
  assert.equal(r.ok, true);
  assert.equal(r.fired, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.sent_at, '2026-09-23T18:30:00.000Z');
  assert.equal(row.collection_time, '14:30');
  assert.equal(row.status, 'prep');
  assert.match(r.message, /The kitchen already has this order/);
});

test('re-sync refuses another venue, and changes nothing when ezCater cannot be reached', async () => {
  const sb = fakeDb(baseTables([hkx77vAsWritten()], { ezcater_caterers: [{ caterer_uuid: 'cat-pos-testing', location_id: 'other-venue', connection_id: 'conn-1' }] }));
  const r = await resyncOrder(sb, null, { locationId: PROVO, ref: REF, fetchFor: answers(ezOrder()) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not mapped to this venue/);
  const sb2 = fakeDb(baseTables([hkx77vAsWritten()]));
  const r2 = await resyncOrder(sb2, null, { locationId: PROVO, ref: REF, timeoutMs: 20, fetchFor: () => () => new Promise(() => {}) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Nothing was changed/);
  assert.equal(sb2.db.order_queue[0].sent_at, '2026-09-23T18:30:00.000Z');
});

test('re-sync is on the Orders Hub order and the Back Office advance list, staff only', () => {
  const hub = read('../surfaces/OrdersHub.jsx');
  assert.ok(hub.includes('ezcaterResyncOrder(locId, o.ref, staff.pin)'));
  assert.ok(hub.includes('Re-sync from ezCater'));
  const bo = read('../backoffice/sections/CateringOrders.jsx');
  assert.ok(bo.includes('ezcaterResyncOrder(locId, o.ref)'));
  const connect = read('../../supabase/functions/ezcater-connect/index.ts');
  assert.ok(connect.includes('await staffActor(sb, platform, user, opsLocationId, body?.pin)'));
});

// ── 5. LEFTOVERS ─────────────────────────────────────────────────────────────

/** Evaluate releasableOrFilter() on a row, the way PostgREST reads it. */
function passesReleasable(row) {
  const f = releasableOrFilter();
  const inList = f.match(/ezcater_lifecycle\.in\.\(([^)]+)\)/)[1].split(',');
  const life = row.customer?.ezcater_lifecycle ?? null;
  return row.source !== 'ezcater' || life === null || inList.includes(life);
}

test('the cron query never reads held rows, so they cannot clog its oldest first batch, and has a floor', () => {
  const rows = [
    { source: 'ezcater', status: 'received', customer: { ezcater_order_id: 'a', ezcater_lifecycle: 'submitted' } },
    { source: 'ezcater', status: 'received', customer: { ezcater_order_id: 'b', ezcater_lifecycle: 'accepted' } },
    { source: 'ezcater', status: 'received', customer: { ezcater_order_id: 'c', ezcater_lifecycle: 'relish_finalized' } },
    { source: 'ezcater', status: 'received', customer: { ezcater_order_id: 'd', ezcater_lifecycle: null } },
    { source: 'catering', status: 'received', customer: {} },
  ];
  // The query filter and the release rule agree on every row.
  for (const r of rows) assert.equal(passesReleasable(r), cateringMayFire(r), JSON.stringify(r.customer));
  const cron = read('../../supabase/functions/catering-release/index.ts');
  assert.ok(cron.includes('.or(releasableOrFilter())'));
  assert.ok(cron.includes(".gte('sent_at', floor)"));
  assert.ok(cron.includes('const floor = new Date(Date.now() - CATERING_STALE_FLOOR_MS).toISOString();'));
  assert.equal(CATERING_STALE_FLOOR_MS, STALE_ORDER_FLOOR_MS, 'the cron floor is the tills\' floor');
  assert.ok(read('../store/index.js').includes('.or(releasableOrFilter())'), 'the till release reads the same way');
});

test('a cancelled future ezCater order never loads into every till at its old fire time', () => {
  const now = Date.parse('2026-09-23T18:00:00Z');
  const cancelledPast = { source: 'ezcater', status: 'cancelled', sent_at: '2026-09-23T17:00:00Z', kitchen_routed_at: null };
  assert.equal(keptOutOfLiveQueue(cancelledPast, now), true);
  // Cancelled AFTER firing stays, so staff see the kitchen must stop.
  assert.equal(keptOutOfLiveQueue({ ...cancelledPast, kitchen_routed_at: '2026-09-23T17:00:05Z' }, now), false);
  assert.equal(keptOutOfLiveQueue({ source: 'online', status: 'cancelled', sent_at: '2026-09-23T17:00:00Z' }, now), false);
  assert.ok(liveQueueOrFilter('X').includes('or(status.neq.cancelled,kitchen_routed_at.not.is.null)'));
  assert.ok(read('../sync/QueueSync.js').includes('keptOutOfLiveQueue(row, Date.now())'));
});

test('the read then write race cannot change a fired order without flagging it', async () => {
  // The release claims the row between the webhook's read and its write.
  let claimed = false;
  const sb = fakeDb(baseTables([heldRow()]), {
    beforeUpdate(st, db) {
      if (!claimed && st.table === 'order_queue' && st.isNullOn.includes('kitchen_routed_at')) {
        db.order_queue[0].kitchen_routed_at = '2026-09-23T17:00:02Z';
        claimed = true;
      }
    },
  });
  const moved = ezOrder({ event: { ...ezOrder().event, timestamp: '2026-09-23T19:30:00Z' } });
  const w = await writeEzcaterOrder(sb, { order: moved, locationId: PROVO, venue: LONDON, priorLink: { accepted_count: 1 }, nowIso: '2026-09-23T17:00:03.000Z', match: false });
  assert.equal(w.ok, true);
  assert.equal(w.attempts, 2, 'planned again once the claim was seen');
  assert.equal(w.plan.fired, true);
  const row = sb.db.order_queue[0];
  assert.equal(row.sent_at, heldRow().sent_at, 'the fired order kept its time');
  assert.equal(row.collection_time, '19:30', 'and the time the kitchen was given');
  assert.deepEqual(row.customer.changedAfterFire.kinds, ['time']);
  // The first write asked for kitchen_routed_at is null: the condition is what caught the race.
  assert.ok(sb.log.some((l) => l.table === 'order_queue' && l.op === 'update' && l.isNullOn.includes('kitchen_routed_at')));
});

test('a time change after firing is judged against the order\'s own last ezCater time, never sent_at', () => {
  const firstSeen = orderToQueueRow(ezOrder(), PROVO, { venue: LONDON }).row;
  const fired = heldRow({ kitchen_routed_at: '2026-09-23T17:00:05Z', customer: firstSeen.customer });
  // Same ezCater time, but the venue changed its prep setting: our fire time differs, ezCater's does not.
  const samePrep60 = orderToQueueRow(ezOrder(), PROVO, { venue: { ...LONDON, prepMinutes: 60 }, priorAcceptedCount: 1 }).row;
  const a = ezcaterWritePlan({ row: { ...samePrep60, customer: { ...samePrep60.customer, modified: false } }, existing: fired, terminal: false, nowIso: '2026-09-23T17:10:00.000Z' });
  assert.equal(a.changedAfterFire, null, 'a prep setting change is not an ezCater change');
  // A real move is flagged once; the next notification with the same time is not flagged again.
  const moved = orderToQueueRow(ezOrder({ event: { ...ezOrder().event, timestamp: '2026-09-23T19:30:00Z' } }), PROVO, { venue: LONDON }).row;
  const b = ezcaterWritePlan({ row: moved, existing: fired, terminal: false, nowIso: '2026-09-23T17:10:00.000Z' });
  assert.deepEqual(b.changedAfterFire.kinds, ['time']);
  const c = ezcaterWritePlan({ row: moved, existing: { ...fired, customer: b.row.customer }, terminal: false, nowIso: '2026-09-23T17:20:00.000Z' });
  assert.equal(c.changedAfterFire, null, 'not repeated');
  assert.equal(c.row.customer.changedAfterFire.at, '2026-09-23T17:10:00.000Z', 'the first change stays visible');
});

test('capacity counts ezCater orders by count, and by value only in the venue currency, never converted', () => {
  const load = cateringDayLoad([
    { source: 'catering', status: 'received', total: 100, currency: null },
    { source: 'ezcater', status: 'received', total: 41.31, currency: 'USD' },
    { source: 'ezcater', status: 'cancelled', total: 50, currency: 'USD' },
    { source: 'ezcater', status: 'received', total: 20, currency: 'GBP' },
  ], 'gbp');
  assert.deepEqual(load, { count: 3, value: 120, otherCurrency: 1 });
  const surface = read('../surfaces/catering/CateringSurface.jsx');
  assert.ok(surface.includes("currency:customer->totals->>currency"));
  assert.equal((surface.match(/cateringDayLoad\(data, cur\)/g) || []).length, 2);
  const draft = read('../../supabase/migrations/20260907b_ops_rls_1_fences_and_rpcs.sql');
  const fn = draft.slice(draft.indexOf('create or replace function public.catering_day_load'), draft.indexOf('$fn$;', draft.indexOf('create or replace function public.catering_day_load')));
  assert.ok(fn.includes("q.source in ('catering', 'ezcater')"));
  assert.ok(fn.includes("filter (where r.cur = r.venue_cur)"));
  assert.ok(fn.includes('other_currency_count'));
  assert.equal(fn.includes("q.source = 'catering'"), false);
});

test('a re-ask keeps the item matches it already had for the same lines', () => {
  const old = [{ name: 'Sandwich Tray', sizeName: null, itemId: 'm-1', match: { matched: true, source: 'manual' }, mods: [{ label: 'Extra', itemId: 'm-9' }] }];
  const fresh = [{ name: 'Sandwich Tray', sizeName: null, itemId: null, mods: [{ label: 'Extra', itemId: null }] }];
  const out = carryMatchedItems(fresh, old);
  assert.equal(out[0].itemId, 'm-1');
  assert.equal(out[0].mods[0].itemId, 'm-9');
  assert.equal(carryMatchedItems([{ name: 'Salad Bowl', itemId: null }], old)[0].itemId, null, 'a changed line is never guessed');
});

// ── 6. STAFF ONLY ────────────────────────────────────────────────────────────

test('staff only means the Back Office staff rule, or a till of the venue plus a staff PIN', async () => {
  const sb = fakeDb({
    user_profiles: [{ id: 'bo-1', role: 'manager', location_id: PROVO }, { id: 'anon-1', role: null }],
    user_locations: [{ user_id: 'bo-2', location_id: PROVO }],
    devices: [{ id: 'd1', device_uid: 'till-1', location_id: PROVO, status: 'active' }],
    staff_members: [{ id: 's1', location_id: PROVO, pin: '1234', active: true, name: 'Jane' }, { id: 's2', location_id: PROVO, pin: '9999', active: false }],
  });
  assert.equal(await staffForLocation(sb, null, { id: 'bo-1' }, PROVO), true, 'user_profiles.location_id');
  assert.equal(await staffForLocation(sb, null, { id: 'bo-2' }, PROVO), true, 'user_locations');
  assert.equal(await staffForLocation(sb, null, { id: 'bo-2', is_anonymous: true }, PROVO), false, 'never an anonymous session');
  assert.equal(await staffForLocation(sb, null, { id: 'anon-1' }, PROVO), false, 'signed in is not staff');
  assert.equal((await staffActor(sb, null, { id: 'till-1', is_anonymous: true }, PROVO, null)).ok, false, 'a till alone is not staff');
  assert.equal((await staffActor(sb, null, { id: 'till-1', is_anonymous: true }, PROVO, '9999')).ok, false, 'an inactive PIN');
  assert.deepEqual(await staffActor(sb, null, { id: 'till-1', is_anonymous: true }, PROVO, '1234'), { ok: true, by: 'staff:s1' });
  assert.equal((await staffActor(sb, null, { id: 'stranger', is_anonymous: true }, PROVO, '1234')).ok, false, 'a PIN from a device that is not the venue\'s');
  assert.equal((await staffActor(sb, null, null, PROVO, '1234')).status, 401);
});

test('deploy notes: the migration runs first, and every file is free of dashes', () => {
  const sql = read('../../supabase/migrations/20260918_OPS_ezcater_catering_order_screens.sql');
  assert.ok(sql.includes('RUN THIS FIRST, BEFORE THE EDGE FUNCTIONS ARE DEPLOYED'));
  for (const rel of [
    '../../supabase/functions/_shared/ezcaterIngest.ts', '../../supabase/functions/_shared/ezcaterCatering.js',
    '../../supabase/functions/_shared/staffAuthority.ts', '../../supabase/functions/_shared/cateringRules.js',
    '../../supabase/functions/ezcater-connect/index.ts', '../../supabase/functions/catering-release/index.ts',
    '../../supabase/functions/ezcater-webhook/index.ts', './ezcaterIngest.test.js',
  ]) {
    const s = read(rel);
    assert.equal(s.includes(String.fromCharCode(0x2013)) || s.includes(String.fromCharCode(0x2014)), false, `${rel} has a dash`);
  }
});
